import type {
  ActivityEvent,
  Interval,
  MatterPeriod,
  SessionCorrection,
  SessionStartReason,
  WorkSession,
} from '../../shared/types';
import { unionDurationMs } from '../billing/engine';

export interface GroupingOptions {
  /** Split when there is no active work for longer than this. */
  sessionGapMinutes: number;
}

/** The manually selected matter at a moment in time, or null. */
export function matterAt(periods: MatterPeriod[], at: number): string | null {
  let found: MatterPeriod | null = null;
  for (const p of periods) {
    if (p.startedAt <= at && (p.endedAt === null || at < p.endedAt)) {
      if (!found || p.startedAt > found.startedAt) found = p;
    }
  }
  return found?.matterId ?? null;
}

/**
 * Matter for an instant: the most recent review correction covering it wins, then the matter
 * selected while working, otherwise none.
 */
export function effectiveMatter(
  at: number,
  periods: MatterPeriod[],
  assignments: SessionCorrection[],
): { matterId: string | null; source: WorkSession['matterSource']; correctionId?: string } {
  let best: SessionCorrection | null = null;
  for (const c of assignments) {
    if (c.startedAt <= at && c.endedAt !== null && at < c.endedAt) {
      if (
        !best ||
        c.createdAt > best.createdAt ||
        (c.createdAt === best.createdAt && c.id > best.id)
      )
        best = c;
    }
  }
  if (best) return { matterId: best.matterId, source: 'corrected', correctionId: best.id };
  const selected = matterAt(periods, at);
  return { matterId: selected, source: selected ? 'selected' : 'none' };
}

/** Clips events to [startMs, endMs) so days are reported independently (e.g. across midnight). */
export function clipEvents(
  events: ActivityEvent[],
  startMs: number,
  endMs: number,
): ActivityEvent[] {
  return events
    .map((e) => ({
      ...e,
      startedAt: Math.max(e.startedAt, startMs),
      endedAt: Math.min(e.endedAt, endMs),
    }))
    .filter((e) => e.endedAt > e.startedAt);
}

/**
 * Groups active events into work sessions using transparent rules, in priority order:
 *  1. A session never spans two different matters (corrected, else selected while working).
 *  2. A manual split always starts a new session.
 *  3. More than `sessionGapMinutes` without active work starts a new session, unless the
 *     attorney merged across that gap.
 *  4. Switching applications alone never splits a session.
 * Idle/excluded time inside a session is reported as `untrackedMs`, never as work.
 */
export function groupSessions(
  events: ActivityEvent[],
  periods: MatterPeriod[],
  opts: GroupingOptions,
  corrections: SessionCorrection[] = [],
): { sessions: WorkSession[]; activeIntervalsBySession: Map<string, Interval[]> } {
  const gapMs = opts.sessionGapMinutes * 60_000;
  const active = events
    .filter((e) => e.kind === 'active')
    .sort((a, b) => a.startedAt - b.startedAt);
  const byKind = (k: SessionCorrection['kind']) => corrections.filter((c) => c.kind === k);
  const assignments = byKind('assign_matter');
  const splits = byKind('split');
  const joins = byKind('join');
  const notes = byKind('note').sort(
    (a, b) => a.startedAt - b.startedAt || a.createdAt - b.createdAt,
  );

  type Draft = {
    matterId: string | null;
    source: WorkSession['matterSource'];
    reason: SessionStartReason;
    gapBeforeMs: number | null;
    events: ActivityEvent[];
    endedAt: number;
    lastStart: number;
    correctionIds: Set<string>;
  };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;

  for (const e of active) {
    const m = effectiveMatter(e.startedAt, periods, assignments);
    let reason: SessionStartReason | null = null;
    let splitId: string | undefined;
    if (!cur) {
      reason = 'first';
    } else if (cur.matterId !== m.matterId) {
      reason = 'matter_change';
    } else {
      const last = cur.lastStart;
      splitId = splits.find((s) => last < s.startedAt && s.startedAt <= e.startedAt)?.id;
      if (splitId) reason = 'manual_split';
      else if (e.startedAt - cur.endedAt > gapMs) {
        const end = cur.endedAt;
        const join = joins.find((j) => j.startedAt <= end && (j.endedAt ?? -1) >= e.startedAt);
        if (join) cur.correctionIds.add(join.id);
        else reason = 'gap';
      }
    }
    if (reason) {
      cur = {
        matterId: m.matterId,
        source: m.source,
        reason,
        gapBeforeMs: cur ? e.startedAt - cur.endedAt : null,
        events: [],
        endedAt: e.endedAt,
        lastStart: e.startedAt,
        correctionIds: new Set(splitId ? [splitId] : []),
      };
      drafts.push(cur);
    }
    const d: Draft = cur!;
    d.events.push(e);
    d.endedAt = Math.max(d.endedAt, e.endedAt);
    d.lastStart = e.startedAt;
    if (m.correctionId) {
      d.source = 'corrected';
      d.correctionIds.add(m.correctionId);
    }
  }

  const activeIntervalsBySession = new Map<string, Interval[]>();
  const sessions = drafts.map((d): WorkSession => {
    const startedAt = d.events[0]!.startedAt;
    const intervals = d.events.map((e) => ({ startedAt: e.startedAt, endedAt: e.endedAt }));
    const activeMs = unionDurationMs(intervals);
    const apps = new Map<string, number>();
    for (const e of d.events)
      apps.set(e.application, (apps.get(e.application) ?? 0) + (e.endedAt - e.startedAt));
    const id = `session_${d.events[0]!.id}`;
    activeIntervalsBySession.set(id, intervals);

    const ownNotes = notes.filter(
      (n) => n.startedAt >= startedAt && n.startedAt < Math.max(d.endedAt, startedAt + 1),
    );
    for (const n of ownNotes) d.correctionIds.add(n.id);

    return {
      id,
      startedAt,
      endedAt: d.endedAt,
      matterId: d.matterId,
      matterSource: d.matterId ? d.source : 'none',
      status: d.matterId ? 'classified' : 'needs_review',
      startReason: d.reason,
      gapBeforeMs: d.gapBeforeMs,
      note: ownNotes.length ? ownNotes.map((n) => n.note ?? '').join('\n') : null,
      correctionIds: [...d.correctionIds],
      eventIds: d.events.map((e) => e.id),
      activeMs,
      untrackedMs: d.endedAt - startedAt - activeMs,
      applications: [...apps].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms),
    };
  });
  return { sessions, activeIntervalsBySession };
}
