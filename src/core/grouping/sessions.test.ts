import { describe, expect, it } from 'vitest';
import type { ActivityEvent, MatterPeriod } from '../../shared/types';
import { localDayRange, toLocalIsoDate } from '../time';
import { clipEvents, groupSessions, matterAt } from './sessions';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 14, 0, 0);
let n = 0;
const ev = (startMin: number, mins: number, p: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++n}`,
  startedAt: T0 + startMin * MIN,
  endedAt: T0 + (startMin + mins) * MIN,
  kind: 'active',
  application: 'Word',
  processId: null,
  windowTitle: 'Doc',
  browserUrl: null,
  browserTabTitle: null,
  idleSeconds: 0,
  source: 'mock',
  ...p,
});
const period = (matterId: string, startMin: number, endMin: number | null): MatterPeriod => ({
  id: `p_${matterId}_${startMin}`,
  matterId,
  startedAt: T0 + startMin * MIN,
  endedAt: endMin === null ? null : T0 + endMin * MIN,
});
const opts = { sessionGapMinutes: 15 };

describe('groupSessions', () => {
  it('keeps short app switches in one session', () => {
    const { sessions } = groupSessions(
      [ev(0, 10), ev(10, 1, { application: 'Outlook' }), ev(11, 10)],
      [],
      opts,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(21 * MIN);
    expect(sessions[0]!.applications[0]).toEqual({ name: 'Word', ms: 20 * MIN });
  });

  it('absorbs short idle as untracked time but splits on long idle', () => {
    const short = groupSessions([ev(0, 10), ev(10, 5, { kind: 'idle' }), ev(15, 10)], [], opts);
    expect(short.sessions).toHaveLength(1);
    expect(short.sessions[0]!.activeMs).toBe(20 * MIN);
    expect(short.sessions[0]!.untrackedMs).toBe(5 * MIN);

    const long = groupSessions([ev(0, 10), ev(10, 30, { kind: 'idle' }), ev(40, 10)], [], opts);
    expect(long.sessions).toHaveLength(2);
  });

  it('splits when the selected matter changes, even mid-application', () => {
    const { sessions } = groupSessions(
      [ev(0, 10), ev(10, 10)],
      [period('m1', 0, 10), period('m2', 10, null)],
      opts,
    );
    expect(sessions.map((s) => s.matterId)).toEqual(['m1', 'm2']);
  });

  it('leaves the matter unassigned when none was selected', () => {
    const { sessions } = groupSessions([ev(0, 10)], [period('m1', 30, null)], opts);
    expect(sessions[0]!.matterId).toBeNull();
  });

  it('does not double-count overlapping events', () => {
    const { sessions } = groupSessions([ev(0, 10), ev(5, 10)], [], opts);
    expect(sessions[0]!.activeMs).toBe(15 * MIN);
  });

  it('never counts idle or excluded events as active', () => {
    const { sessions } = groupSessions(
      [ev(0, 30, { kind: 'idle' }), ev(30, 5, { kind: 'excluded' })],
      [],
      opts,
    );
    expect(sessions).toHaveLength(0);
  });
});

describe('matterAt', () => {
  it('prefers the most recently started open period', () => {
    expect(matterAt([period('a', 0, null), period('b', 10, null)], T0 + 20 * MIN)).toBe('b');
    expect(matterAt([period('a', 0, 10)], T0 + 10 * MIN)).toBeNull();
  });
});

describe('day boundaries (TZ=America/New_York)', () => {
  it('clips activity that spans midnight into each day', () => {
    const { startMs, endMs } = localDayRange('2026-11-05');
    const spanning = ev(0, 0, { startedAt: endMs - 30 * MIN, endedAt: endMs + 20 * MIN });
    expect(clipEvents([spanning], startMs, endMs)[0]!.endedAt - (endMs - 30 * MIN)).toBe(30 * MIN);
    const next = localDayRange('2026-11-06');
    expect(clipEvents([spanning], next.startMs, next.endMs)[0]!.startedAt).toBe(endMs);
  });

  it('handles 25-hour and 23-hour DST days', () => {
    const fallBack = localDayRange('2026-11-01');
    expect(fallBack.endMs - fallBack.startMs).toBe(25 * 60 * MIN);
    const springForward = localDayRange('2026-03-08');
    expect(springForward.endMs - springForward.startMs).toBe(23 * 60 * MIN);
    expect(toLocalIsoDate(fallBack.startMs)).toBe('2026-11-01');
  });
});
