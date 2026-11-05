import type { ActivityEvent, CaptureSource, EventKind } from '../../shared/types';
import type { ActivitySnapshot } from './types';

export interface RecorderOptions {
  source: CaptureSource;
  idleThresholdSeconds: number;
  /**
   * If more than this elapses between observations (sleep, stalled capture, clock jump),
   * the recorder does NOT bridge the gap: the open event ends at the last observation.
   */
  maxGapSeconds: number;
  isExcluded?: (snapshot: ActivitySnapshot) => boolean;
  newId?: () => string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Converts a stream of polled snapshots into non-overlapping activity intervals.
 *
 * Pure and clock-free: callers pass `now`, so behaviour is deterministic and testable.
 * `ingest` returns the events created or extended by this observation; persist them by id.
 *
 * Rules:
 *  - Same app/window/URL as the open event -> extend it (no duplicate rows).
 *  - Different app/window -> close the open event at `now`, open a new one.
 *  - Idle >= threshold (or screen locked) -> the active event is truncated back to when
 *    input stopped, and an explicit idle event covers the idle period.
 *  - Gap > maxGapSeconds, clock moving backwards, or a null snapshot -> discontinuity.
 */
export class ActivityRecorder {
  private current: ActivityEvent | null = null;
  private lastObservedAt: number | null = null;
  private readonly newId: () => string;

  constructor(private readonly opts: RecorderOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  get currentEvent(): ActivityEvent | null {
    return this.current ? { ...this.current } : null;
  }

  ingest(snapshot: ActivitySnapshot | null, now: number): ActivityEvent[] {
    const changed = new Map<string, ActivityEvent>();
    const touch = (e: ActivityEvent) => changed.set(e.id, { ...e });

    if (
      this.lastObservedAt !== null &&
      (now < this.lastObservedAt || now - this.lastObservedAt > this.opts.maxGapSeconds * 1000)
    ) {
      this.current = null;
    }

    if (!snapshot) {
      this.close();
      return [];
    }

    const idleMs = Math.max(0, snapshot.idleSeconds) * 1000;
    const isIdle = snapshot.locked === true || idleMs >= this.opts.idleThresholdSeconds * 1000;
    const kind: EventKind = isIdle
      ? 'idle'
      : this.opts.isExcluded?.(snapshot)
        ? 'excluded'
        : 'active';
    const cur = this.current;

    if (kind === 'idle') {
      if (cur?.kind === 'idle') {
        cur.endedAt = now;
        cur.idleSeconds = Math.max(cur.idleSeconds, snapshot.idleSeconds);
        touch(cur);
      } else {
        let idleStart = now;
        if (cur) {
          // Input actually stopped `idleSeconds` ago; don't credit the idle lead-in as work.
          idleStart = clamp(now - idleMs, cur.startedAt, now);
          cur.endedAt = idleStart;
          touch(cur);
        }
        this.current = this.newEvent('idle', snapshot, idleStart, now);
        touch(this.current);
      }
    } else if (cur && cur.kind !== 'idle' && keyOf(cur) === keyOf(this.toFields(kind, snapshot))) {
      cur.endedAt = now;
      cur.idleSeconds = Math.max(cur.idleSeconds, snapshot.idleSeconds);
      touch(cur);
    } else {
      let start = now;
      if (cur?.kind === 'idle') {
        start = clamp(now - idleMs, cur.startedAt, now);
        cur.endedAt = start;
        touch(cur);
      } else if (cur) {
        cur.endedAt = now;
        touch(cur);
      }
      this.current = this.newEvent(kind, snapshot, start, now);
      touch(this.current);
    }

    this.lastObservedAt = now;
    return [...changed.values()];
  }

  /** End continuity (pause, sleep, matter change). The open event keeps its last observed end. */
  close(): void {
    this.current = null;
    this.lastObservedAt = null;
  }

  private toFields(kind: EventKind, s: ActivitySnapshot) {
    // Idle and excluded events deliberately drop app/window/URL metadata.
    if (kind === 'idle') {
      return {
        kind,
        application: s.locked ? 'Screen locked' : 'Idle',
        processId: null,
        windowTitle: '',
        browserUrl: null,
        browserTabTitle: null,
      };
    }
    if (kind === 'excluded') {
      return {
        kind,
        application: 'Excluded',
        processId: null,
        windowTitle: '',
        browserUrl: null,
        browserTabTitle: null,
      };
    }
    return {
      kind,
      application: s.application,
      processId: s.processId ?? null,
      windowTitle: s.windowTitle,
      browserUrl: s.browserUrl ?? null,
      browserTabTitle: s.browserTabTitle ?? null,
    };
  }

  private newEvent(
    kind: EventKind,
    s: ActivitySnapshot,
    startedAt: number,
    endedAt: number,
  ): ActivityEvent {
    return {
      id: this.newId(),
      startedAt,
      endedAt,
      idleSeconds: Math.max(0, s.idleSeconds),
      source: this.opts.source,
      ...this.toFields(kind, s),
    };
  }
}

function keyOf(e: Pick<ActivityEvent, 'kind' | 'application' | 'windowTitle' | 'browserUrl'>) {
  return JSON.stringify([e.kind, e.application, e.windowTitle, e.browserUrl]);
}
