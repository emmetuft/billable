import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../shared/schemas';
import { reassignSession, splitSessionAt } from './corrections';
import { openDatabase, Repository } from './db/repository';
import { seedFixtureDay } from '../test/fixtures/workday';
import { buildDayView } from './dayView';
import {
  approveEntry,
  copyEntries,
  createManualEntry,
  discardEntry,
  generateDrafts,
  listEntries,
  refreshEntry,
  rejectEntry,
  reopenEntry,
  updateEntry,
} from './entries';

const DATE = '2026-11-04';
const DAY = new Date(2026, 10, 4).getTime();
const START = DAY + (8 * 60 + 52) * 60_000;

function setup() {
  const repo = new Repository(openDatabase(':memory:'));
  seedFixtureDay(repo, START);
  generateDrafts(repo, DATE);
  const list = () => listEntries(repo, DATE);
  const matter = (c: string) => repo.listMatters().find((m) => m.clientName.startsWith(c))!.id;
  return { repo, list, matter };
}

describe('drafting from the timeline', () => {
  it('creates one draft per assigned session, matching the timeline billing preview', () => {
    const { repo, list } = setup();
    const day = list();
    expect(day.entries).toHaveLength(3); // Contoso AM, Fabrikam, Contoso PM; unassigned work excluded
    expect(day.entries.every((e) => e.status === 'draft' && e.sync === 'in_sync')).toBe(true);
    expect(day.uncoveredActiveMs).toBe(0);
    expect(day.unassignedActiveMs).toBeGreaterThan(0);

    const preview = buildDayView(repo, DAY, DAY + 86_400_000).matterBilling;
    const previewTotal = preview.reduce((n, b) => n + b.calculation.billedMinutes, 0);
    expect(day.entries.reduce((n, e) => n + e.calculation.billedMinutes, 0)).toBe(previewTotal);
  });

  it('is idempotent and never re-drafts rejected work', () => {
    const { repo, list } = setup();
    expect(generateDrafts(repo, DATE)).toBe(0);
    rejectEntry(repo, list().entries[0]!.id);
    expect(generateDrafts(repo, DATE)).toBe(0);
  });

  it('starts the narrative from the attorney’s timeline note, never invented text', () => {
    const repo = new Repository(openDatabase(':memory:'));
    seedFixtureDay(repo, START);
    expect(listEntries(repo, DATE).entries).toHaveLength(0);
    generateDrafts(repo, DATE);
    expect(listEntries(repo, DATE).entries.every((e) => e.description === '')).toBe(true);
  });

  it('aggregates per matter-day when the policy allows', () => {
    const repo = new Repository(openDatabase(':memory:'));
    repo.saveSettings(
      mergeSettings(repo.getSettings(), { billingPolicy: { allowTaskAggregation: true } }),
    );
    seedFixtureDay(repo, START);
    generateDrafts(repo, DATE);
    expect(listEntries(repo, DATE).entries).toHaveLength(2);
  });
});

describe('review → approve → copy', () => {
  it('blocks approval until the narrative is written, then freezes billing', () => {
    const { repo, list } = setup();
    const draft = list().entries[0]!;
    expect(() => approveEntry(repo, draft.id)).toThrow(/Narrative is empty/);

    updateEntry(repo, draft.id, { description: 'Revised supply agreement redline' });
    const approved = approveEntry(repo, draft.id);
    expect(approved.status).toBe('approved');
    expect(approved.frozenBilling!.billedMinutes).toBe(draft.calculation.billedMinutes);

    // Policy change later: approved entry is unaffected, drafts are recalculated.
    repo.saveSettings(
      mergeSettings(repo.getSettings(), { billingPolicy: { roundingMode: 'down' } }),
    );
    const after = list().entries;
    expect(after[0]!.calculation.billedMinutes).toBe(draft.calculation.billedMinutes);
    expect(list().entries[1]!.actualMs).toBe(75 * 60_000);
    expect(after[1]!.calculation.billedMinutes).toBe(72); // draft recalculated: 75 min rounded down
    expect(() => updateEntry(repo, draft.id, { description: 'x' })).toThrow(/Reopen/);
  });

  it('copies approved entries as TSV, marks them copied, and refuses drafts', () => {
    const { repo, list } = setup();
    const [a, b] = list().entries;
    updateEntry(repo, a!.id, { description: 'Revised redline' });
    updateEntry(repo, b!.id, { description: 'Term sheet call\twith client' });
    approveEntry(repo, a!.id);
    approveEntry(repo, b!.id);

    let clip = '';
    const r = copyEntries(repo, [b!.id, a!.id], (t) => (clip = t));
    expect(r.count).toBe(2);
    expect(clip).toBe(r.text);
    const lines = clip.split('\r\n');
    expect(lines[0]).toBe(
      `${DATE}\tContoso Ltd.\tSupply Agreement Dispute\t1.5\tY\tRevised redline`,
    );
    expect(lines[1]).toBe(
      `${DATE}\tFabrikam, Inc.\tSeries B Financing\t1.3\tY\tTerm sheet call with client`,
    );
    expect(list().entries.filter((e) => e.status === 'copied')).toHaveLength(2);
    expect(() => copyEntries(repo, [list().entries[2]!.id], () => {})).toThrow(/approved/);
  });

  it('records a complete audit history, including field-level edits', () => {
    const { repo, list } = setup();
    const id = list().entries[0]!.id;
    updateEntry(repo, id, { description: 'First' });
    updateEntry(repo, id, { description: 'Second' });
    approveEntry(repo, id);
    reopenEntry(repo, id);
    const h = repo.entryHistory(id);
    expect(h.map((x) => x.action)).toEqual([
      'entry_create',
      'entry_edit',
      'entry_edit',
      'entry_approve',
      'entry_reopen',
    ]);
    expect(h[2]!.detail.changes).toEqual({ description: ['First', 'Second'] });
  });
});

describe('adjustments and nonbillable time', () => {
  it('requires adjusted time to be a whole increment with a reason', () => {
    const { repo, list } = setup();
    const id = list().entries[0]!.id;
    expect(() => updateEntry(repo, id, { billedOverrideMinutes: 50, overrideReason: 'x' })).toThrow(
      /multiple/,
    );
    expect(() => updateEntry(repo, id, { billedOverrideMinutes: 48 })).toThrow(/reason/);
    updateEntry(repo, id, {
      billedOverrideMinutes: 48,
      overrideReason: 'Write-down for efficiency',
    });
    expect(list().entries[0]!.calculation.billedMinutes).toBe(48);
    updateEntry(repo, id, { billedOverrideMinutes: null });
    expect(list().entries[0]).toMatchObject({ overrideReason: null, billedOverrideMinutes: null });
  });
});

describe('timeline changes after drafting', () => {
  it('flags a draft as stale when its session is split, and refresh re-snapshots it', () => {
    const { repo, list } = setup();
    const first = list().entries[0]!;
    splitSessionAt(repo, first.evidence[2]!.startedAt);

    const stale = list().entries[0]!;
    expect(stale.sync).toBe('changed');
    expect(stale.flags.find((f) => f.code === 'stale')!.severity).toBe('block');
    expect(list().uncoveredActiveMs).toBe(0); // second half still touches the old draft

    updateEntry(repo, first.id, { description: 'Kept narrative' });
    const refreshed = refreshEntry(repo, first.id);
    expect(refreshed.description).toBe('Kept narrative');
    expect(list().entries[0]!.sync).toBe('in_sync');
    expect(list().uncoveredActiveMs).toBeGreaterThan(0);
    expect(generateDrafts(repo, DATE)).toBe(1); // the split-off half gets its own draft
  });

  it('flags missing evidence when work is unassigned, and refuses captured matter edits', () => {
    const { repo, list } = setup();
    const e = list().entries[0]!;
    reassignSession(repo, { startedAt: e.startAt!, endedAt: e.endAt! }, null);
    expect(list().entries[0]!.sync).toBe('missing');
    expect(() => refreshEntry(repo, e.id)).toThrow(/Reject or discard/);
    expect(() => updateEntry(repo, e.id, { matterId: null })).toThrow(/timeline/);
  });
});

describe('manual entries and double billing', () => {
  it('blocks approving a manual entry that overlaps captured billable time', () => {
    const { repo, list, matter } = setup();
    const captured = list().entries[0]!;
    const manual = createManualEntry(repo, {
      entryDate: DATE,
      matterId: matter('Fabrikam'),
      description: 'Call with opposing counsel',
      actualMinutes: 20,
      startAt: captured.startAt! + 10 * 60_000,
      billable: true,
    });
    const v = list().entries.find((e) => e.id === manual.id)!;
    expect(v.flags.map((f) => `${f.code}:${f.severity}`)).toEqual(['overlap:block', 'manual:warn']);
    expect(() => approveEntry(repo, manual.id)).toThrow(/Overlaps Contoso/);

    updateEntry(repo, manual.id, { startAt: null }); // untimed: can't overlap
    expect(approveEntry(repo, manual.id).status).toBe('approved');
  });

  it('validates the manual entry date and allows discarding drafts', () => {
    const { repo, matter } = setup();
    expect(() =>
      createManualEntry(repo, {
        entryDate: DATE,
        matterId: matter('Contoso'),
        description: 'x',
        actualMinutes: 6,
        startAt: DAY - 1,
        billable: true,
      }),
    ).toThrow(/entry date/);
    const m = createManualEntry(repo, {
      entryDate: DATE,
      matterId: matter('Contoso'),
      description: 'x',
      actualMinutes: 6,
      startAt: null,
      billable: false,
    });
    discardEntry(repo, m.id);
    expect(repo.getEntry(m.id)).toBeNull();
  });
});
