import { EventEmitter } from 'node:events';
import { isExcluded } from '../../core/capture/exclusions';
import { ActivityRecorder } from '../../core/capture/recorder';
import type { ActivityCapture } from '../../core/capture/types';
import type { ActivityEvent, MonitorState, MonitorStatus, Settings } from '../../shared/types';
import type { Repository } from '../db/repository';

/**
 * Owns the polling loop: adapter snapshot -> recorder -> SQLite.
 * Emits 'status' whenever anything user-visible changes.
 */
export class CaptureService extends EventEmitter {
  private state: MonitorState = 'stopped';
  private adapter: ActivityCapture | null = null;
  private recorder: ActivityRecorder | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private current: ActivityEvent | null = null;
  private error: string | null = null;
  private settings: Settings;

  constructor(
    private readonly repo: Repository,
    private readonly createAdapter: (settings: Settings) => ActivityCapture,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.settings = repo.getSettings();
  }

  status(): MonitorStatus {
    return {
      state: this.state,
      source: this.settings.captureSource,
      current: this.current
        ? {
            kind: this.current.kind,
            application: this.current.application,
            windowTitle: this.current.windowTitle,
            startedAt: this.current.startedAt,
          }
        : null,
      activeMatterId: this.repo.openMatterPeriod()?.matterId ?? null,
      warning: this.error ?? this.adapter?.getWarning?.() ?? null,
    };
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.settings = this.repo.getSettings();
    this.error = null;
    try {
      this.adapter = this.createAdapter(this.settings);
      await this.adapter.start();
    } catch (err) {
      this.adapter = null;
      this.state = 'stopped';
      this.error = err instanceof Error ? err.message : String(err);
      this.emitStatus();
      return;
    }
    const s = this.settings;
    this.recorder = new ActivityRecorder({
      source: this.adapter.source,
      idleThresholdSeconds: s.idleThresholdMinutes * 60,
      maxGapSeconds: Math.max(s.pollIntervalSeconds * 3, 60),
      isExcluded: (snap) => isExcluded(snap, s),
    });
    this.state = 'running';
    this.repo.audit('monitoring_started', 'monitor', null, { source: this.adapter.source });
    this.timer = setInterval(() => void this.tick(), s.pollIntervalSeconds * 1000);
    await this.tick();
  }

  async pause(): Promise<void> {
    if (this.state !== 'running') return;
    await this.tick(); // capture right up to the moment of pausing
    this.halt('paused');
    this.repo.audit('monitoring_paused', 'monitor', null, {});
    this.emitStatus();
  }

  async resume(): Promise<void> {
    if (this.state === 'running') return;
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.state === 'running') await this.tick();
    this.halt('stopped');
    await this.adapter?.stop();
    this.adapter = null;
  }

  /** Apply new settings by restarting the loop if it was running. */
  async reload(): Promise<void> {
    const wasRunning = this.state === 'running';
    await this.stop();
    this.settings = this.repo.getSettings();
    if (wasRunning) await this.start();
    else this.emitStatus();
  }

  /** System sleep / lock: end the open interval so the gap is never bridged. */
  interrupt(): void {
    this.recorder?.close();
    this.current = null;
    this.emitStatus();
  }

  async setActiveMatter(matterId: string | null): Promise<void> {
    if (this.state === 'running') await this.tick();
    this.recorder?.close(); // events never span a matter change
    this.repo.setActiveMatter(matterId, this.now());
    await this.tick(); // start the next event at the switch, not at the next poll
  }

  private halt(state: MonitorState): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.recorder?.close();
    this.recorder = null;
    this.current = null;
    this.state = state;
  }

  private tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        if (this.state !== 'running' || !this.adapter) return;
        const snapshot = await this.adapter.getCurrentActivity();
        if (this.state !== 'running' || !this.recorder) return;
        const changed = this.recorder.ingest(snapshot, this.now());
        this.repo.upsertEvents(changed);
        this.current = this.recorder.currentEvent;
        this.error = null;
      } catch (err) {
        this.error = `Capture error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        this.ticking = null;
        this.emitStatus();
      }
    })();
    return this.ticking;
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }
}
