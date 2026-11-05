import { billSessions } from '../core/billing/engine';
import { clipEvents, groupSessions } from '../core/grouping/sessions';
import type { DayView, Interval } from '../shared/types';
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
  };
  return { view, activeIntervalsBySession };
}
