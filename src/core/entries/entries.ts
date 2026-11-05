import type {
  BillingCalculation,
  BillingPolicy,
  EntryFlag,
  EntrySync,
  Interval,
  TimeEntry,
  WorkSession,
} from '../../shared/types';
import { formatDuration, roundDuration, unionDurationMs } from '../billing/engine';

/**
 * Pure time-entry logic: which timeline work becomes a draft, whether an entry still matches the
 * timeline, what blocks approval, and how billed time is derived. No I/O, no clock.
 */

/** A billable unit of timeline work that one entry should cover. */
export interface DraftUnit {
  matterId: string;
  startAt: number;
  endAt: number;
  intervals: Interval[];
  evidenceEventIds: string[];
  actualMs: number;
  notes: string[];
}

/**
 * One unit per assigned session; or, when the policy aggregates tasks, one unit per matter-day.
 * Sessions without a matter never become units: they must be assigned on the timeline first.
 */
export function buildDraftUnits(
  sessions: WorkSession[],
  intervalsBySession: Map<string, Interval[]>,
  policy: Pick<BillingPolicy, 'allowTaskAggregation'>,
): DraftUnit[] {
  const assigned = sessions.filter((s) => s.matterId !== null);
  let groups: WorkSession[][];
  if (policy.allowTaskAggregation) {
    const byMatter = new Map<string, WorkSession[]>();
    for (const s of assigned) byMatter.set(s.matterId!, [...(byMatter.get(s.matterId!) ?? []), s]);
    groups = [...byMatter.values()];
  } else {
    groups = assigned.map((s) => [s]);
  }

  return groups.map((group) => {
    const intervals = group.flatMap((s) => intervalsBySession.get(s.id) ?? []);
    return {
      matterId: group[0]!.matterId!,
      startAt: Math.min(...group.map((s) => s.startedAt)),
      endAt: Math.max(...group.map((s) => s.endedAt)),
      intervals,
      evidenceEventIds: group.flatMap((s) => s.eventIds),
      actualMs: unionDurationMs(intervals),
      notes: group.flatMap((s) => (s.note ? [s.note] : [])),
    };
  });
}

const sameSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

/** Compares a captured entry with the current timeline. Returns the best-matching unit, if any. */
export function syncState(
  entry: Pick<TimeEntry, 'source' | 'evidenceEventIds' | 'matterId'>,
  units: DraftUnit[],
): { sync: EntrySync; unit: DraftUnit | null } {
  if (entry.source === 'manual') return { sync: 'manual', unit: null };
  const mine = new Set(entry.evidenceEventIds);
  const touching = units
    .map((u) => ({ u, shared: u.evidenceEventIds.filter((id) => mine.has(id)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared);
  const best = touching[0]?.u ?? null;
  if (!best) return { sync: 'missing', unit: null };
  const exact =
    touching.length === 1 &&
    best.matterId === entry.matterId &&
    sameSet(best.evidenceEventIds, entry.evidenceEventIds);
  return { sync: exact ? 'in_sync' : 'changed', unit: best };
}

/** Units none of whose events appear in any existing entry (of any status, incl. rejected). */
export function uncoveredUnits(units: DraftUnit[], entries: Pick<TimeEntry, 'evidenceEventIds'>[]) {
  const covered = new Set(entries.flatMap((e) => e.evidenceEventIds));
  return units.filter((u) => !u.evidenceEventIds.some((id) => covered.has(id)));
}

export function entryIntervals(
  e: Pick<TimeEntry, 'source' | 'intervals' | 'startAt' | 'actualMs'>,
): Interval[] {
  if (e.source === 'captured') return e.intervals;
  return e.startAt === null ? [] : [{ startedAt: e.startAt, endedAt: e.startAt + e.actualMs }];
}

export function intervalsOverlap(a: Interval[], b: Interval[]): boolean {
  return a.some((x) => b.some((y) => x.startedAt < y.endedAt && y.startedAt < x.endedAt));
}

const FROZEN: TimeEntry['status'][] = ['approved', 'copied', 'exported'];

/**
 * Billed time for an entry. Approved entries return their frozen calculation; drafts are
 * calculated from observed (or manually entered) time under the current policy, then any
 * attorney adjustment is applied and recorded in the trace.
 */
export function entryBilling(entry: TimeEntry, policy: BillingPolicy): BillingCalculation {
  if (entry.frozenBilling && FROZEN.includes(entry.status)) return entry.frozenBilling;
  const calc = roundDuration(entry.actualMs, policy);
  if (entry.source === 'manual') {
    calc.trace[0] = `Entered manually: ${formatDuration(entry.actualMs)} (not observed)`;
  }
  if (entry.billedOverrideMinutes !== null) {
    calc.trace.push(
      `Adjusted by attorney from ${calc.billedMinutes} to ${entry.billedOverrideMinutes} min` +
        (entry.overrideReason ? `: ${entry.overrideReason}` : ''),
    );
    calc.billedMinutes = entry.billedOverrideMinutes;
    calc.units = entry.billedOverrideMinutes / policy.incrementMinutes;
  }
  if (!entry.billable) calc.trace.push('Marked nonbillable');
  return calc;
}

/** The policy result before any attorney adjustment (used to detect write-ups). */
function policyMinutes(entry: TimeEntry, policy: BillingPolicy) {
  return roundDuration(entry.actualMs, policy).billedMinutes;
}

/** Everything the attorney must resolve (block) or should notice (warn) before approving. */
export function reviewFlags(
  entry: TimeEntry,
  sync: EntrySync,
  others: TimeEntry[],
  policy: BillingPolicy,
  describeOther: (e: TimeEntry) => string = () => 'another entry',
): EntryFlag[] {
  if (entry.status === 'rejected') return [];
  const isDraft = entry.status === 'draft';
  const flags: EntryFlag[] = [];
  const block = (code: EntryFlag['code'], message: string) =>
    flags.push({ code, severity: isDraft ? 'block' : 'warn', message });
  const warn = (code: EntryFlag['code'], message: string) =>
    flags.push({ code, severity: 'warn', message });

  if (!entry.matterId) block('no_matter', 'No matter assigned');
  if (!entry.description.trim()) block('no_description', 'Narrative is empty');
  if (sync === 'changed') {
    block(
      'stale',
      isDraft
        ? 'Timeline changed since this draft was created. Refresh it to pick up the current activity.'
        : 'Timeline changed after approval. Reopen to update, or leave as approved.',
    );
  }
  if (sync === 'missing') {
    block('stale', 'The underlying activity was deleted or is no longer assigned to a matter.');
  }
  if (entry.billable && entry.actualMs <= 0) block('zero_time', 'No time recorded');

  if (entry.billable) {
    const mine = entryIntervals(entry);
    for (const o of others) {
      if (o.id === entry.id || o.status === 'rejected' || !o.billable) continue;
      if (intervalsOverlap(mine, entryIntervals(o))) {
        block('overlap', `Overlaps ${describeOther(o)} — the same time cannot be billed twice`);
      }
    }
  }

  if (entry.source === 'manual')
    warn('manual', 'Manual entry: this time was not observed by the app');
  if (entry.billable && entry.actualMs > 0 && entry.actualMs < 60_000) {
    warn(
      'very_short',
      `Under 1 minute observed; policy bills ${policyMinutes(entry, policy)} min. Confirm this is intended.`,
    );
  }
  if (
    entry.billedOverrideMinutes !== null &&
    entry.billedOverrideMinutes > policyMinutes(entry, policy)
  ) {
    warn('adjusted_up', 'Billed time adjusted above the policy calculation');
  }
  return flags;
}

export const canApprove = (flags: EntryFlag[]) => !flags.some((f) => f.severity === 'block');
