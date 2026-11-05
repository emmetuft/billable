import type { ActivityEvent, CaptureSource } from '../../shared/types';
import { ActivityRecorder } from './recorder';
import type { ActivityCapture, ActivitySnapshot } from './types';

/**
 * Deterministic, entirely fictional workday used for development on any OS.
 * Names use well-known placeholder companies (Contoso, Fabrikam) and do not refer to real matters.
 */

export type MockMatterKey = 'contoso' | 'fabrikam' | 'doe';

export const MOCK_MATTERS: Record<MockMatterKey, { clientName: string; matterName: string }> = {
  contoso: { clientName: 'Contoso Ltd.', matterName: 'Supply Agreement Dispute' },
  fabrikam: { clientName: 'Fabrikam, Inc.', matterName: 'Series B Financing' },
  doe: { clientName: 'Estate of J. Doe', matterName: 'Probate Administration' },
};

export interface MockStep {
  minutes: number;
  /** 'active' = foreground app; 'idle' = no input, previous app stays frontmost; 'away' = asleep/no capture. */
  mode: 'active' | 'idle' | 'away';
  application?: string;
  windowTitle?: string;
  browserUrl?: string;
  /** Attorney selects this matter at the start of the step (null clears). Undefined = unchanged. */
  selectMatter?: MockMatterKey | null;
}

const word = (doc: string) => ({ application: 'Microsoft Word', windowTitle: `${doc} - Word` });
const outlook = (title: string) => ({ application: 'Microsoft Outlook', windowTitle: title });

export const MOCK_SCENARIO: MockStep[] = [
  { minutes: 12, mode: 'active', ...outlook('Inbox - attorney@lawfirm.example') },
  {
    minutes: 38,
    mode: 'active',
    selectMatter: 'contoso',
    ...word('Contoso_Supply_Agreement_Redline_v3.docx'),
  },
  { minutes: 4, mode: 'active', ...outlook('RE: Contoso - indemnification cap - Message') },
  { minutes: 22, mode: 'active', ...word('Contoso_Supply_Agreement_Redline_v3.docx') },
  {
    minutes: 25,
    mode: 'active',
    application: 'Google Chrome',
    windowTitle: 'Legal research - limitation of consequential damages - Google Chrome',
  },
  { minutes: 1, mode: 'active', application: '1Password', windowTitle: 'Vault' },
  { minutes: 9, mode: 'idle' },
  {
    minutes: 30,
    mode: 'active',
    selectMatter: 'fabrikam',
    ...word('Fabrikam_Series_B_Term_Sheet.docx'),
  },
  { minutes: 45, mode: 'active', application: 'zoom.us', windowTitle: 'Zoom Meeting' },
  { minutes: 50, mode: 'away', selectMatter: null },
  { minutes: 6, mode: 'active', application: 'Microsoft Teams', windowTitle: 'Chat | Doe Estate' },
  {
    minutes: 28,
    mode: 'active',
    application: 'Adobe Acrobat',
    windowTitle: 'Doe_Estate_Inventory.pdf',
  },
  {
    minutes: 17,
    mode: 'active',
    application: 'Microsoft Excel',
    windowTitle: 'Doe_Estate_Asset_Schedule.xlsx',
  },
  {
    minutes: 3,
    mode: 'active',
    application: 'Google Chrome',
    windowTitle: 'New Incognito Tab - Google Chrome',
  },
  { minutes: 8, mode: 'active', ...outlook('Inbox - attorney@lawfirm.example') },
  {
    minutes: 41,
    mode: 'active',
    selectMatter: 'contoso',
    ...word('Contoso_Supply_Agreement_Redline_v3.docx'),
  },
  // Rapid switching between related windows should not fragment the session.
  { minutes: 1, mode: 'active', ...outlook('RE: Contoso - revised redline - Message') },
  { minutes: 1, mode: 'active', ...word('Contoso_Supply_Agreement_Redline_v3.docx') },
  { minutes: 1, mode: 'active', ...outlook('RE: Contoso - revised redline - Message') },
  { minutes: 2, mode: 'active', ...word('Contoso_Supply_Agreement_Redline_v3.docx') },
  { minutes: 20, mode: 'idle' },
];

export interface MockMatterSelection {
  at: number;
  matter: MockMatterKey | null;
}

export interface MockDay {
  events: ActivityEvent[];
  matterSelections: MockMatterSelection[];
}

/**
 * Replays the scenario through the real ActivityRecorder with a simulated clock.
 * Exercises idle truncation, sleep gaps, exclusions and dedup exactly like live capture.
 */
export function buildMockDay(
  startMs: number,
  opts: {
    idleThresholdSeconds: number;
    tickSeconds?: number;
    isExcluded?: (s: ActivitySnapshot) => boolean;
    newId?: () => string;
    scenario?: MockStep[];
  },
): MockDay {
  const tickMs = (opts.tickSeconds ?? 15) * 1000;
  const recorder = new ActivityRecorder({
    source: 'mock',
    idleThresholdSeconds: opts.idleThresholdSeconds,
    maxGapSeconds: (tickMs / 1000) * 4,
    isExcluded: opts.isExcluded,
    newId: opts.newId,
  });
  const events = new Map<string, ActivityEvent>();
  const matterSelections: MockMatterSelection[] = [];
  let lastActive: MockStep | undefined;
  let lastSnapshot: ActivitySnapshot | null = null;
  let t = startMs;

  for (const step of opts.scenario ?? MOCK_SCENARIO) {
    const stepStart = t;
    const stepEnd = t + step.minutes * 60_000;
    if (step.selectMatter !== undefined) {
      // Observe once more at the switch (as the live service does), then start a new event.
      if (lastSnapshot)
        for (const e of recorder.ingest(
          { ...lastSnapshot, timestamp: new Date(t).toISOString() },
          t,
        ))
          events.set(e.id, e);
      recorder.close();
      matterSelections.push({ at: stepStart, matter: step.selectMatter });
    }
    for (; t < stepEnd; t += tickMs) {
      if (step.mode === 'away') continue;
      const src = step.mode === 'idle' ? lastActive : step;
      const snapshot: ActivitySnapshot = {
        timestamp: new Date(t).toISOString(),
        application: src?.application ?? 'Finder',
        windowTitle: src?.windowTitle ?? '',
        browserUrl: src?.browserUrl,
        idleSeconds: step.mode === 'idle' ? (t - stepStart) / 1000 : 1,
      };
      for (const e of recorder.ingest(snapshot, t)) events.set(e.id, e);
      lastSnapshot = snapshot;
    }
    if (step.mode === 'away') lastSnapshot = null;
    if (step.mode === 'active') lastActive = step;
  }
  return {
    events: [...events.values()].sort((a, b) => a.startedAt - b.startedAt),
    matterSelections,
  };
}

/**
 * Live mock adapter: plays the scenario back in real time (looping), so the full
 * capture -> persistence -> timeline pipeline can run on any machine without OS permissions.
 * 'away' steps are reported as a locked screen.
 */
export class MockActivityCapture implements ActivityCapture {
  readonly source: CaptureSource = 'mock';
  private startedAt = 0;
  private readonly totalMs: number;

  constructor(
    private readonly scenario: MockStep[] = MOCK_SCENARIO,
    private readonly now: () => number = Date.now,
  ) {
    this.totalMs = scenario.reduce((sum, s) => sum + s.minutes * 60_000, 0);
  }

  async start(): Promise<void> {
    this.startedAt = this.now();
  }

  async stop(): Promise<void> {}

  async getCurrentActivity(): Promise<ActivitySnapshot | null> {
    const now = this.now();
    let offset = (now - this.startedAt) % this.totalMs;
    let lastActive: MockStep | undefined;
    for (const step of this.scenario) {
      const len = step.minutes * 60_000;
      if (offset < len) {
        const src = step.mode === 'active' ? step : lastActive;
        return {
          timestamp: new Date(now).toISOString(),
          application: src?.application ?? 'Finder',
          windowTitle: src?.windowTitle ?? '',
          browserUrl: src?.browserUrl,
          idleSeconds: step.mode === 'active' ? 1 : offset / 1000,
          locked: step.mode === 'away',
        };
      }
      offset -= len;
      if (step.mode === 'active') lastActive = step;
    }
    return null;
  }

  getWarning(): string | null {
    return 'Mock capture: showing simulated activity, not your real computer use.';
  }
}
