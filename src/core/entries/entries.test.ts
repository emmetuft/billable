import { describe, expect, it } from 'vitest';
import type { BillingPolicy, Interval, Matter, TimeEntry, WorkSession } from '../../shared/types';
import { decimalHours, formatEntriesTsv, sanitizeField } from './clipboard';
import {
  buildDraftUnits,
  canApprove,
  entryBilling,
  reviewFlags,
  syncState,
  uncoveredUnits,
} from './entries';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 14, 0, 0);
const at = (m: number) => T0 + m * MIN;
const policy = (p: Partial<BillingPolicy> = {}): BillingPolicy => ({
  incrementMinutes: 6,
  minimumMinutes: null,
  roundingMode: 'up',
  allowTaskAggregation: false,
  minimumConfidence: 0.7,
  ...p,
});

const session = (
  id: string,
  matterId: string | null,
  s: number,
  e: number,
  note: string | null = null,
): WorkSession => ({
  id,
  startedAt: at(s),
  endedAt: at(e),
  matterId,
  matterSource: matterId ? 'selected' : 'none',
  status: matterId ? 'classified' : 'needs_review',
  startReason: 'first',
  gapBeforeMs: null,
  note,
  correctionIds: [],
  eventIds: [`${id}-a`, `${id}-b`],
  activeMs: (e - s) * MIN,
  untrackedMs: 0,
  applications: [],
});
const intervalsOf = (sessions: WorkSession[]) =>
  new Map<string, Interval[]>(
    sessions.map((s) => [s.id, [{ startedAt: s.startedAt, endedAt: s.endedAt }]]),
  );

const entry = (p: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'x',
  entryDate: '2026-11-04',
  source: 'captured',
  matterId: 'm1',
  description: 'Reviewed and revised supply agreement redline',
  startAt: at(0),
  endAt: at(37),
  intervals: [{ startedAt: at(0), endedAt: at(37) }],
  evidenceEventIds: ['s1-a', 's1-b'],
  actualMs: 37 * MIN,
  billable: true,
  billedOverrideMinutes: null,
  overrideReason: null,
  status: 'draft',
  frozenBilling: null,
  approvedAt: null,
  copiedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

describe('buildDraftUnits', () => {
  const sessions = [
    session('s1', 'm1', 0, 30, 'Redline'),
    session('s2', null, 30, 40),
    session('s3', 'm1', 60, 64),
  ];

  it('creates one unit per assigned session and skips unassigned work', () => {
    const units = buildDraftUnits(sessions, intervalsOf(sessions), policy());
    expect(units.map((u) => [u.matterId, u.actualMs / MIN])).toEqual([
      ['m1', 30],
      ['m1', 4],
    ]);
    expect(units[0]!.notes).toEqual(['Redline']);
  });

  it('aggregates a matter-day into one unit when the policy allows', () => {
    const units = buildDraftUnits(
      sessions,
      intervalsOf(sessions),
      policy({ allowTaskAggregation: true }),
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ actualMs: 34 * MIN, startAt: at(0), endAt: at(64) });
    expect(units[0]!.evidenceEventIds).toEqual(['s1-a', 's1-b', 's3-a', 's3-b']);
  });
});

describe('syncState / uncoveredUnits', () => {
  const s1 = session('s1', 'm1', 0, 37);
  const units = buildDraftUnits([s1], intervalsOf([s1]), policy());

  it('is in sync when evidence and matter match exactly', () => {
    expect(syncState(entry(), units).sync).toBe('in_sync');
  });
  it('detects growth, reassignment and deletion', () => {
    expect(syncState(entry({ evidenceEventIds: ['s1-a'] }), units).sync).toBe('changed');
    expect(syncState(entry({ matterId: 'm2' }), units).sync).toBe('changed');
    expect(syncState(entry({ evidenceEventIds: ['gone'] }), units).sync).toBe('missing');
    expect(syncState(entry({ source: 'manual' }), units).sync).toBe('manual');
  });
  it('treats any entry (even rejected) as covering its events', () => {
    expect(uncoveredUnits(units, [entry({ status: 'rejected' })])).toEqual([]);
    expect(uncoveredUnits(units, [])).toHaveLength(1);
  });
});

describe('entryBilling', () => {
  it('rounds observed time under the policy', () => {
    expect(entryBilling(entry(), policy()).billedMinutes).toBe(42);
  });
  it('applies and explains an attorney adjustment', () => {
    const c = entryBilling(
      entry({ billedOverrideMinutes: 30, overrideReason: 'Write-down' }),
      policy(),
    );
    expect(c).toMatchObject({ billedMinutes: 30, units: 5 });
    expect(c.trace.at(-1)).toBe('Adjusted by attorney from 42 to 30 min: Write-down');
  });
  it('returns the frozen calculation once approved, ignoring later policy changes', () => {
    const frozen = { actualMs: 37 * MIN, billedMinutes: 42, units: 7, trace: ['frozen'] };
    const e = entry({ status: 'approved', frozenBilling: frozen });
    expect(entryBilling(e, policy({ roundingMode: 'down' }))).toBe(frozen);
    expect(
      entryBilling(entry({ frozenBilling: frozen }), policy({ roundingMode: 'down' }))
        .billedMinutes,
    ).toBe(36);
  });
  it('labels manual time as not observed', () => {
    expect(entryBilling(entry({ source: 'manual' }), policy()).trace[0]).toMatch(/not observed/);
  });
});

describe('reviewFlags', () => {
  const codes = (
    e: TimeEntry,
    others: TimeEntry[] = [],
    sync: 'in_sync' | 'changed' | 'missing' | 'manual' = 'in_sync',
  ) => reviewFlags(e, sync, others, policy()).map((f) => `${f.code}:${f.severity}`);

  it('passes a complete, in-sync entry', () => {
    const flags = reviewFlags(entry(), 'in_sync', [], policy());
    expect(flags).toEqual([]);
    expect(canApprove(flags)).toBe(true);
  });

  it('blocks a draft with no matter, no narrative, or stale evidence', () => {
    expect(codes(entry({ matterId: null, description: ' ' }), [], 'changed')).toEqual([
      'no_matter:block',
      'no_description:block',
      'stale:block',
    ]);
  });

  it('blocks double billing of the same time, unless either entry is nonbillable or rejected', () => {
    const manual = entry({
      id: 'y',
      source: 'manual',
      startAt: at(30),
      actualMs: 15 * MIN,
      intervals: [],
    });
    expect(codes(entry(), [manual])).toContain('overlap:block');
    expect(codes(entry(), [{ ...manual, billable: false }])).not.toContain('overlap:block');
    expect(codes(entry(), [{ ...manual, status: 'rejected' }])).not.toContain('overlap:block');
    expect(codes(entry(), [{ ...manual, startAt: at(37) }])).not.toContain('overlap:block'); // touching
    expect(codes(entry(), [{ ...manual, startAt: null }])).not.toContain('overlap:block'); // untimed
  });

  it('downgrades problems on approved entries to warnings', () => {
    expect(codes(entry({ status: 'approved' }), [], 'changed')).toEqual(['stale:warn']);
  });

  it('warns about manual time, sub-minute rounding and upward adjustments', () => {
    expect(codes(entry({ source: 'manual' }), [], 'manual')).toEqual(['manual:warn']);
    expect(codes(entry({ actualMs: 20_000 }))).toEqual(['very_short:warn']);
    expect(codes(entry({ billedOverrideMinutes: 60 }))).toEqual(['adjusted_up:warn']);
    expect(codes(entry({ billedOverrideMinutes: 30 }))).toEqual([]); // write-down: no flag
  });

  it('does not require time on nonbillable entries', () => {
    expect(codes(entry({ billable: false, actualMs: 0 }))).toEqual([]);
  });
});

describe('clipboard format', () => {
  const matters: Matter[] = [
    {
      id: 'm1',
      clientName: 'Contoso Ltd.',
      matterName: 'Supply\tAgreement Dispute',
      displayName: '',
      aliases: [],
      keywords: [],
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
    },
  ];
  const calc = (min: number) => ({ actualMs: 0, billedMinutes: min, units: 0, trace: [] });

  it('formats decimal hours without trailing zeros', () => {
    expect([6, 42, 60, 90, 15, 0].map(decimalHours)).toEqual([
      '0.1',
      '0.7',
      '1',
      '1.5',
      '0.25',
      '0',
    ]);
  });

  it('produces stable TSV rows with CRLF line endings and sanitized fields', () => {
    const tsv = formatEntriesTsv(
      [
        { ...entry({ description: 'Revised redline;\n\temailed\tclient' }), calculation: calc(42) },
        { ...entry({ billable: false, description: 'Admin' }), calculation: calc(6) },
      ],
      matters,
    );
    expect(tsv).toBe(
      '2026-11-04\tContoso Ltd.\tSupply Agreement Dispute\t0.7\tY\tRevised redline; emailed client\r\n' +
        '2026-11-04\tContoso Ltd.\tSupply Agreement Dispute\t0.1\tN\tAdmin',
    );
    expect(sanitizeField('  a \t b\r\n c ')).toBe('a b c');
  });
});
