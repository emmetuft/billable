import { describe, expect, it } from 'vitest';
import type { ActivityEvent, MatterPeriod, SessionCorrection } from '../../shared/types';
import { effectiveMatter, groupSessions } from './sessions';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 14, 0, 0);
const at = (min: number) => T0 + min * MIN;
let n = 0;
const ev = (startMin: number, mins: number, p: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++n}`,
  startedAt: at(startMin),
  endedAt: at(startMin + mins),
  kind: 'active',
  application: 'Word',
  processId: null,
  windowTitle: 'Doc',
  browserUrl: null,
  browserTabTitle: null,
  idleSeconds: 0,
  source: 'macos',
  ...p,
});
const period = (matterId: string, s: number, e: number | null): MatterPeriod => ({
  id: `p${++n}`,
  matterId,
  startedAt: at(s),
  endedAt: e === null ? null : at(e),
});
const corr = (
  kind: SessionCorrection['kind'],
  s: number,
  e: number | null,
  p: Partial<SessionCorrection> = {},
): SessionCorrection => ({
  id: `c${++n}`,
  kind,
  startedAt: at(s),
  endedAt: e === null ? null : at(e),
  matterId: null,
  note: null,
  createdAt: n,
  ...p,
});
const opts = { sessionGapMinutes: 15 };

describe('effectiveMatter', () => {
  it('prefers the newest correction over the working selection', () => {
    const periods = [period('selected', 0, null)];
    const older = corr('assign_matter', 0, 60, { matterId: 'a', createdAt: 1 });
    const newer = corr('assign_matter', 0, 60, { matterId: 'b', createdAt: 2 });
    expect(effectiveMatter(at(10), periods, [newer, older])).toMatchObject({
      matterId: 'b',
      source: 'corrected',
    });
    expect(effectiveMatter(at(70), periods, [newer, older])).toMatchObject({
      matterId: 'selected',
      source: 'selected',
    });
  });

  it('can explicitly un-assign a selected matter', () => {
    const r = effectiveMatter(
      at(5),
      [period('m', 0, null)],
      [corr('assign_matter', 0, 10, { matterId: null })],
    );
    expect(r.matterId).toBeNull();
    expect(r.source).toBe('corrected');
  });
});

describe('groupSessions with corrections', () => {
  it('explains why each session starts', () => {
    const { sessions } = groupSessions(
      [ev(0, 10), ev(10, 10), ev(50, 10)],
      [period('m1', 0, 10), period('m2', 10, null)],
      opts,
    );
    expect(sessions.map((s) => [s.startReason, s.gapBeforeMs])).toEqual([
      ['first', null],
      ['matter_change', 0],
      ['gap', 30 * MIN],
    ]);
  });

  it('reassigns a session after capture and marks it corrected', () => {
    const fix = corr('assign_matter', 0, 20, { matterId: 'm9' });
    const { sessions } = groupSessions([ev(0, 10), ev(10, 10)], [], opts, [fix]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      matterId: 'm9',
      matterSource: 'corrected',
      status: 'classified',
      correctionIds: [fix.id],
    });
  });

  it('marks unassigned sessions as needing review', () => {
    const { sessions } = groupSessions([ev(0, 10)], [], opts);
    expect(sessions[0]).toMatchObject({ status: 'needs_review', matterSource: 'none' });
  });

  it('splits at a manual split point, even within one application', () => {
    const split = corr('split', 10, null);
    const { sessions } = groupSessions([ev(0, 10), ev(10, 10), ev(20, 10)], [], opts, [split]);
    expect(sessions.map((s) => s.eventIds.length)).toEqual([1, 2]);
    expect(sessions[1]).toMatchObject({ startReason: 'manual_split', correctionIds: [split.id] });
  });

  it('a split point between events applies to the next event', () => {
    const { sessions } = groupSessions([ev(0, 10), ev(10, 10)], [], opts, [corr('split', 5, null)]);
    expect(sessions).toHaveLength(2);
  });

  it('a join bridges an inactivity gap; without it the gap splits', () => {
    const events = [ev(0, 10), ev(40, 10)];
    expect(groupSessions(events, [], opts).sessions).toHaveLength(2);
    const join = corr('join', 10, 40);
    const { sessions } = groupSessions(events, [], opts, [join]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeMs).toBe(20 * MIN); // the bridged gap is still not counted as work
    expect(sessions[0]!.untrackedMs).toBe(30 * MIN);
    expect(sessions[0]!.correctionIds).toContain(join.id);
  });

  it('a join never overrides a matter boundary', () => {
    const { sessions } = groupSessions(
      [ev(0, 10), ev(40, 10)],
      [period('a', 0, 20), period('b', 20, null)],
      opts,
      [corr('join', 10, 40)],
    );
    expect(sessions).toHaveLength(2);
  });

  it('attaches notes to the session containing them and keeps both notes after a merge', () => {
    const events = [ev(0, 10), ev(40, 10)];
    const notes = [
      corr('note', 0, null, { note: 'Reviewed redline' }),
      corr('note', 40, null, { note: 'Call prep' }),
    ];
    const split = groupSessions(events, [], opts, notes).sessions;
    expect(split.map((s) => s.note)).toEqual(['Reviewed redline', 'Call prep']);
    const merged = groupSessions(events, [], opts, [...notes, corr('join', 10, 40)]).sessions;
    expect(merged[0]!.note).toBe('Reviewed redline\nCall prep');
  });
});
