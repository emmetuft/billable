import { isExcluded } from '../../core/capture/exclusions';
import type { Repository } from '../../main/db/repository';
import type { ActivityEvent, MatterPeriod } from '../../shared/types';
import { ActivityRecorder } from '../../core/capture/recorder';
import type { ActivitySnapshot } from '../../core/capture/types';

/**
 * TEST FIXTURE ONLY — never imported by the application, never bundled, never written to a real
 * database. A deterministic, entirely fictional workday (placeholder companies Contoso/Fabrikam)
 * replayed through the real ActivityRecorder so capture, grouping, billing and entry tests run
 * against realistic data: idle truncation, a sleep gap, exclusions, matter switches, rapid switching.
 */

export type FixtureMatterKey = 'contoso' | 'fabrikam' | 'doe';

export const FIXTURE_MATTERS: Record<FixtureMatterKey, { clientName: string; matterName: string }> =
  {
    contoso: { clientName: 'Contoso Ltd.', matterName: 'Supply Agreement Dispute' },
    fabrikam: { clientName: 'Fabrikam, Inc.', matterName: 'Series B Financing' },
    doe: { clientName: 'Estate of J. Doe', matterName: 'Probate Administration' },
  };

export interface FixtureStep {
  minutes: number;
  /** 'active' = foreground app; 'idle' = no input, previous app stays frontmost; 'away' = asleep/no capture. */
  mode: 'active' | 'idle' | 'away';
  application?: string;
  windowTitle?: string;
  browserUrl?: string;
  /** Attorney selects this matter at the start of the step (null clears). Undefined = unchanged. */
  selectMatter?: FixtureMatterKey | null;
}

const word = (doc: string) => ({ application: 'Microsoft Word', windowTitle: `${doc} - Word` });
const outlook = (title: string) => ({ application: 'Microsoft Outlook', windowTitle: title });

export const FIXTURE_SCENARIO: FixtureStep[] = [
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

export interface FixtureMatterSelection {
  at: number;
  matter: FixtureMatterKey | null;
}

export interface FixtureDay {
  events: ActivityEvent[];
  matterSelections: FixtureMatterSelection[];
}

/**
 * Replays the scenario through the real ActivityRecorder with a simulated clock.
 * Exercises idle truncation, sleep gaps, exclusions and dedup exactly like live capture.
 */
export function buildFixtureDay(
  startMs: number,
  opts: {
    idleThresholdSeconds: number;
    tickSeconds?: number;
    isExcluded?: (s: ActivitySnapshot) => boolean;
    newId?: () => string;
    scenario?: FixtureStep[];
  },
): FixtureDay {
  const tickMs = (opts.tickSeconds ?? 15) * 1000;
  const recorder = new ActivityRecorder({
    source: 'macos',
    idleThresholdSeconds: opts.idleThresholdSeconds,
    maxGapSeconds: (tickMs / 1000) * 4,
    isExcluded: opts.isExcluded,
    newId: opts.newId,
  });
  const events = new Map<string, ActivityEvent>();
  const matterSelections: FixtureMatterSelection[] = [];
  let lastActive: FixtureStep | undefined;
  let lastSnapshot: ActivitySnapshot | null = null;
  let t = startMs;

  for (const step of opts.scenario ?? FIXTURE_SCENARIO) {
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

/** Seeds a test repository with the fixture workday plus its fictional matters and selections. */
export function seedFixtureDay(repo: Repository, startMs: number): number {
  const settings = repo.getSettings();
  const day = buildFixtureDay(startMs, {
    idleThresholdSeconds: settings.idleThresholdMinutes * 60,
    isExcluded: (s) => isExcluded(s, settings),
  });
  const last = day.events.at(-1);
  if (!last) return 0;
  if (repo.eventsInRange(startMs, last.endedAt).length > 0) {
    throw new Error(
      'Activity already exists in that time window. Delete it first or pick another day.',
    );
  }

  const ids = new Map<FixtureMatterKey, string>();
  const idFor = (key: FixtureMatterKey) => {
    const spec = FIXTURE_MATTERS[key];
    const id =
      ids.get(key) ??
      (
        repo
          .listMatters(true)
          .find((m) => m.clientName === spec.clientName && m.matterName === spec.matterName) ??
        repo.createMatter({ ...spec, keywords: [key] })
      ).id;
    ids.set(key, id);
    return id;
  };

  const periods: MatterPeriod[] = [];
  day.matterSelections.forEach((sel, i) => {
    if (!sel.matter) return;
    const next = day.matterSelections[i + 1];
    periods.push({
      id: crypto.randomUUID(),
      matterId: idFor(sel.matter),
      startedAt: sel.at,
      endedAt: next ? next.at : last.endedAt,
    });
  });

  repo.db.transaction(() => {
    repo.upsertEvents(day.events);
    repo.insertMatterPeriods(periods);
  })();
  return day.events.length;
}
