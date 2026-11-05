import { describe, expect, it } from 'vitest';
import type { BillingPolicy, WorkSession } from '../../shared/types';
import { billSessions, findOverlaps, roundDuration, unionDurationMs } from './engine';

const MIN = 60_000;
const policy = (p: Partial<BillingPolicy> = {}): BillingPolicy => ({
  incrementMinutes: 6,
  minimumMinutes: null,
  roundingMode: 'up',
  allowTaskAggregation: false,
  minimumConfidence: 0.7,
  ...p,
});

describe('roundDuration (six-minute increments)', () => {
  it.each([
    [1, 6, 1],
    [6, 6, 1],
    [6.01, 12, 2],
    [12, 12, 2],
    [37, 42, 7],
    [60, 60, 10],
  ])('rounds %s min up to %s min (%s units)', (actualMin, billed, units) => {
    const r = roundDuration(actualMin * MIN, policy());
    expect(r.billedMinutes).toBe(billed);
    expect(r.units).toBe(units);
  });

  it('never bills zero or negative time', () => {
    expect(roundDuration(0, policy()).billedMinutes).toBe(0);
    expect(roundDuration(-5 * MIN, policy()).billedMinutes).toBe(0);
  });

  it('rounds to nearest with exact halves going up', () => {
    const p = policy({ roundingMode: 'nearest' });
    expect(roundDuration(2.99 * MIN, p).billedMinutes).toBe(0);
    expect(roundDuration(3 * MIN, p).billedMinutes).toBe(6);
    expect(roundDuration(8.99 * MIN, p).billedMinutes).toBe(6);
    expect(roundDuration(9 * MIN, p).billedMinutes).toBe(12);
  });

  it('rounds down', () => {
    expect(roundDuration(11.9 * MIN, policy({ roundingMode: 'down' })).billedMinutes).toBe(6);
  });

  it('applies a minimum charge rounded up to the increment', () => {
    const p = policy({ roundingMode: 'down', minimumMinutes: 10 });
    const r = roundDuration(2 * MIN, p);
    expect(r.billedMinutes).toBe(12);
    expect(r.trace.join(' ')).toMatch(/Minimum charge/);
  });

  it('is exact at increment boundaries (no floating-point drift)', () => {
    for (let units = 1; units <= 200; units++) {
      expect(roundDuration(units * 6 * MIN, policy()).units).toBe(units);
      expect(roundDuration(units * 6 * MIN + 1, policy()).units).toBe(units + 1);
    }
  });

  it('records a traceable explanation', () => {
    expect(roundDuration(37 * MIN, policy()).trace).toEqual([
      'Observed active time: 37m',
      'Rounded up to 6-minute increments: 7 unit(s) = 42 min',
    ]);
  });
});

describe('overlap handling', () => {
  it('unions overlapping intervals without double counting', () => {
    expect(
      unionDurationMs([
        { startedAt: 0, endedAt: 10 * MIN },
        { startedAt: 5 * MIN, endedAt: 15 * MIN },
        { startedAt: 20 * MIN, endedAt: 25 * MIN },
        { startedAt: 21 * MIN, endedAt: 22 * MIN },
      ]),
    ).toBe(20 * MIN);
  });

  it('ignores empty and inverted intervals', () => {
    expect(
      unionDurationMs([
        { startedAt: 5, endedAt: 5 },
        { startedAt: 9, endedAt: 3 },
      ]),
    ).toBe(0);
  });

  it('finds overlapping pairs; touching intervals do not overlap', () => {
    expect(
      findOverlaps([
        { id: 'a', startedAt: 0, endedAt: 10 },
        { id: 'b', startedAt: 10, endedAt: 20 },
        { id: 'c', startedAt: 15, endedAt: 30 },
      ]),
    ).toEqual([['b', 'c']]);
  });
});

describe('billSessions', () => {
  const session = (
    id: string,
    matterId: string | null,
    startMin: number,
    mins: number,
  ): WorkSession => ({
    id,
    matterId,
    startedAt: startMin * MIN,
    endedAt: (startMin + mins) * MIN,
    matterSource: matterId ? 'selected' : 'none',
    status: matterId ? 'classified' : 'needs_review',
    startReason: 'first',
    gapBeforeMs: null,
    note: null,
    correctionIds: [],
    eventIds: [],
    activeMs: mins * MIN,
    untrackedMs: 0,
    applications: [],
  });
  const sessions = [
    session('s1', 'm1', 0, 4),
    session('s2', 'm1', 60, 4),
    session('s3', null, 120, 30),
  ];
  const intervals = new Map(
    sessions.map((s) => [s.id, [{ startedAt: s.startedAt, endedAt: s.endedAt }]]),
  );

  it('rounds each session independently when aggregation is off', () => {
    const r = billSessions(sessions, intervals, policy());
    expect(r.matterBilling).toHaveLength(1);
    expect(r.matterBilling[0]!.calculation.billedMinutes).toBe(12); // 6 + 6
  });

  it('aggregates per matter before rounding when allowed', () => {
    const r = billSessions(sessions, intervals, policy({ allowTaskAggregation: true }));
    expect(r.matterBilling[0]!.calculation.billedMinutes).toBe(12); // ceil(8/6)=2 units
    const r2 = billSessions(
      [session('a', 'm1', 0, 2), session('b', 'm1', 30, 2)],
      new Map([
        ['a', [{ startedAt: 0, endedAt: 2 * MIN }]],
        ['b', [{ startedAt: 30 * MIN, endedAt: 32 * MIN }]],
      ]),
      policy({ allowTaskAggregation: true }),
    );
    expect(r2.matterBilling[0]!.calculation.billedMinutes).toBe(6); // 4 min total -> 1 unit
  });

  it('never bills unassigned sessions', () => {
    const r = billSessions(sessions, intervals, policy());
    expect(r.sessionBilling.find((b) => b.sessionId === 's3')!.calculation).toBeNull();
  });
});
