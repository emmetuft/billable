import type {
  BillingCalculation,
  BillingPolicy,
  Interval,
  MatterBilling,
  SessionBilling,
  WorkSession,
} from '../../shared/types';

/**
 * Deterministic billing math. No LLM is ever involved in computing billed time.
 * All arithmetic is done on integer milliseconds to avoid floating-point drift.
 */

const MINUTE = 60_000;

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Total covered time of possibly-overlapping intervals (never double-counts). */
export function unionDurationMs(intervals: Interval[]): number {
  const sorted = intervals
    .filter((i) => i.endedAt > i.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const i of sorted) {
    if (i.startedAt > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.startedAt;
      curEnd = i.endedAt;
    } else {
      curEnd = Math.max(curEnd, i.endedAt);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Pairs of intervals (by id) that overlap in time. */
export function findOverlaps<T extends Interval & { id: string }>(items: T[]): [string, string][] {
  const sorted = [...items].sort((a, b) => a.startedAt - b.startedAt);
  const out: [string, string][] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (b.startedAt >= a.endedAt) break;
      out.push([a.id, b.id]);
    }
  }
  return out;
}

/** Applies the increment, rounding mode and minimum charge to an observed duration. */
export function roundDuration(actualMs: number, policy: BillingPolicy): BillingCalculation {
  const inc = policy.incrementMinutes;
  const incMs = inc * MINUTE;
  const trace = [`Observed active time: ${formatDuration(actualMs)}`];

  if (actualMs <= 0) {
    return { actualMs: 0, billedMinutes: 0, units: 0, trace: [...trace, 'No time to bill'] };
  }

  let units: number;
  switch (policy.roundingMode) {
    case 'up':
      units = Math.ceil(actualMs / incMs);
      break;
    case 'down':
      units = Math.floor(actualMs / incMs);
      break;
    case 'nearest':
      units = Math.floor((2 * actualMs + incMs) / (2 * incMs)); // exact halves round up
      break;
  }
  trace.push(
    `Rounded ${policy.roundingMode} to ${inc}-minute increments: ${units} unit(s) = ${units * inc} min`,
  );

  if (policy.minimumMinutes !== null) {
    const minUnits = Math.ceil(policy.minimumMinutes / inc);
    if (units < minUnits) {
      units = minUnits;
      trace.push(`Minimum charge of ${policy.minimumMinutes} min applied: ${units * inc} min`);
    }
  }

  return { actualMs, billedMinutes: units * inc, units, trace };
}

/**
 * Billing preview for a day's sessions.
 * - Unassigned sessions are never billed (they need a matter first).
 * - With aggregation, each matter's active intervals are unioned and rounded once;
 *   otherwise each session is rounded independently and summed.
 */
export function billSessions(
  sessions: WorkSession[],
  activeIntervalsBySession: Map<string, Interval[]>,
  policy: BillingPolicy,
): { sessionBilling: SessionBilling[]; matterBilling: MatterBilling[] } {
  const sessionBilling: SessionBilling[] = sessions.map((s) => ({
    sessionId: s.id,
    calculation: s.matterId ? roundDuration(s.activeMs, policy) : null,
  }));

  const byMatter = new Map<string, WorkSession[]>();
  for (const s of sessions) {
    if (!s.matterId) continue;
    byMatter.set(s.matterId, [...(byMatter.get(s.matterId) ?? []), s]);
  }

  const matterBilling: MatterBilling[] = [];
  for (const [matterId, list] of byMatter) {
    if (policy.allowTaskAggregation) {
      const intervals = list.flatMap((s) => activeIntervalsBySession.get(s.id) ?? []);
      const calc = roundDuration(unionDurationMs(intervals), policy);
      calc.trace.unshift(`Aggregated ${list.length} session(s) before rounding`);
      matterBilling.push({ matterId, calculation: calc });
    } else {
      const parts = list.map((s) => roundDuration(s.activeMs, policy));
      matterBilling.push({
        matterId,
        calculation: {
          actualMs: parts.reduce((n, p) => n + p.actualMs, 0),
          billedMinutes: parts.reduce((n, p) => n + p.billedMinutes, 0),
          units: parts.reduce((n, p) => n + p.units, 0),
          trace: [`Sum of ${list.length} independently rounded session(s)`],
        },
      });
    }
  }
  return { sessionBilling, matterBilling };
}
