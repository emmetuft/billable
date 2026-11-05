import { billSessions } from '../core/billing/engine';
import { isExcluded } from '../core/capture/exclusions';
import { buildMockDay, MOCK_MATTERS, type MockMatterKey } from '../core/capture/mock';
import { clipEvents, groupSessions } from '../core/grouping/sessions';
import type { DayView, Interval, MatterPeriod } from '../shared/types';
import type { Repository } from './db/repository';

export function buildDayView(repo: Repository, startMs: number, endMs: number): DayView {
  return computeDay(repo, startMs, endMs).view;
}

/** The day view plus each session's active intervals (needed to build time entries). */
export function computeDay(
  repo: Repository,
  startMs: number,
  endMs: number,
): { view: DayView; activeIntervalsBySession: Map<string, Interval[]> } {
  const settings = repo.getSettings();
  const events = clipEvents(repo.eventsInRange(startMs, endMs), startMs, endMs);
  const matterPeriods = repo.periodsInRange(startMs, endMs);
  const corrections = repo.correctionsInRange(startMs, endMs);
  const { sessions, activeIntervalsBySession } = groupSessions(
    events,
    matterPeriods,
    settings,
    corrections,
  );
  const { sessionBilling, matterBilling } = billSessions(
    sessions,
    activeIntervalsBySession,
    settings.billingPolicy,
  );

  const sum = (kind: string) =>
    events.filter((e) => e.kind === kind).reduce((n, e) => n + (e.endedAt - e.startedAt), 0);
  const view: DayView = {
    startMs,
    endMs,
    events,
    matterPeriods,
    corrections,
    sessions,
    sessionBilling,
    matterBilling,
    totals: {
      activeMs: sessions.reduce((n, s) => n + s.activeMs, 0),
      idleMs: sum('idle'),
      excludedMs: sum('excluded'),
      unassignedActiveMs: sessions.filter((s) => !s.matterId).reduce((n, s) => n + s.activeMs, 0),
    },
    containsMockData: events.some((e) => e.source === 'mock'),
  };
  return { view, activeIntervalsBySession };
}

/**
 * Writes the deterministic mock workday. Refuses to write over existing activity in the
 * same window so sample data can never be interleaved with real captured events.
 */
export function writeSampleDay(repo: Repository, startMs: number): number {
  const settings = repo.getSettings();
  const day = buildMockDay(startMs, {
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

  const ids = new Map<MockMatterKey, string>();
  const idFor = (key: MockMatterKey) => {
    const spec = MOCK_MATTERS[key];
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
  repo.audit('generate_sample_day', 'activity_events', null, {
    startMs,
    events: day.events.length,
  });
  return day.events.length;
}
