import { formatEntriesTsv, decimalHours } from '../core/entries/clipboard';
import {
  buildDraftUnits,
  canApprove,
  entryBilling,
  reviewFlags,
  syncState,
  uncoveredUnits,
  type DraftUnit,
} from '../core/entries/entries';
import { localDayRange } from '../core/time';
import type { EntryPatch, ManualEntryInput } from '../shared/schemas';
import type { EntriesDay, EntryView, TimeEntry } from '../shared/types';
import type { Repository } from './db/repository';
import { computeDay } from './dayView';

/**
 * Time-entry workflow. Drafts are generated from the timeline; the attorney edits and approves
 * them; approved entries are frozen and copied to the clipboard. Nothing is ever submitted.
 */

function context(repo: Repository, date: string) {
  const { startMs, endMs } = localDayRange(date);
  const { view, activeIntervalsBySession } = computeDay(repo, startMs, endMs);
  const policy = repo.getSettings().billingPolicy;
  const units = buildDraftUnits(view.sessions, activeIntervalsBySession, policy);
  return { view, policy, units, entries: repo.entriesForDate(date) };
}

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function toView(repo: Repository, e: TimeEntry, ctx: ReturnType<typeof context>): EntryView {
  const { sync, unit } = syncState(e, ctx.units);
  const names = new Map(repo.listMatters(true).map((m) => [m.id, m.displayName]));
  const describe = (o: TimeEntry) =>
    `${o.matterId ? (names.get(o.matterId) ?? 'another matter') : 'an entry'}` +
    (o.startAt !== null ? ` (${fmtTime(o.startAt)})` : '');
  const ids = new Set(e.evidenceEventIds);
  return {
    ...e,
    calculation: entryBilling(e, ctx.policy),
    sync,
    flags: reviewFlags(e, sync, ctx.entries, ctx.policy, describe),
    evidence: ctx.view.events
      .filter((ev) => ids.has(ev.id))
      .map(({ id, startedAt, endedAt, application, windowTitle }) => ({
        id,
        startedAt,
        endedAt,
        application,
        windowTitle,
      })),
    sessionNotes: unit?.notes ?? [],
  };
}

export function listEntries(repo: Repository, date: string): EntriesDay {
  const ctx = context(repo, date);
  return {
    date,
    entries: ctx.entries.map((e) => toView(repo, e, ctx)),
    uncoveredActiveMs: uncoveredUnits(ctx.units, ctx.entries).reduce((n, u) => n + u.actualMs, 0),
    unassignedActiveMs: ctx.view.totals.unassignedActiveMs,
  };
}

function fromUnit(unit: DraftUnit) {
  return {
    matterId: unit.matterId,
    startAt: unit.startAt,
    endAt: unit.endAt,
    intervals: unit.intervals,
    evidenceEventIds: unit.evidenceEventIds,
    actualMs: unit.actualMs,
  };
}

/**
 * Creates a draft for each unit of assigned timeline work not yet covered by any entry.
 * The narrative starts from the attorney's own timeline notes, or empty — never invented.
 */
export function generateDrafts(repo: Repository, date: string, now = Date.now()): number {
  const ctx = context(repo, date);
  const todo = uncoveredUnits(ctx.units, ctx.entries);
  repo.db.transaction(() => {
    for (const unit of todo) {
      repo.insertEntry(
        {
          id: repo.newEntryId(),
          entryDate: date,
          source: 'captured',
          ...fromUnit(unit),
          description: unit.notes.join('; '),
          billable: true,
          billedOverrideMinutes: null,
          overrideReason: null,
          status: 'draft',
          frozenBilling: null,
          approvedAt: null,
          copiedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        { events: unit.evidenceEventIds.length },
      );
    }
  })();
  return todo.length;
}

function mustGet(repo: Repository, id: string): TimeEntry {
  const e = repo.getEntry(id);
  if (!e) throw new Error('Entry not found');
  return e;
}

function requireDraft(e: TimeEntry, verb: string) {
  if (e.status !== 'draft') throw new Error(`Only draft entries can be ${verb}. Reopen it first.`);
}

/** Re-snapshots a stale captured draft from the current timeline, keeping the narrative. */
export function refreshEntry(repo: Repository, id: string, now = Date.now()): TimeEntry {
  const e = mustGet(repo, id);
  requireDraft(e, 'refreshed');
  if (e.source !== 'captured') throw new Error('Manual entries have no timeline evidence');
  const { unit } = syncState(e, context(repo, e.entryDate).units);
  if (!unit) {
    throw new Error('The activity behind this draft is gone or unassigned. Reject or discard it.');
  }
  return repo.saveEntry({ ...e, ...fromUnit(unit), updatedAt: now }, 'entry_refresh');
}

export function updateEntry(
  repo: Repository,
  id: string,
  patch: EntryPatch,
  now = Date.now(),
): TimeEntry {
  const e = mustGet(repo, id);
  requireDraft(e, 'edited');
  const manualOnly = (['matterId', 'actualMinutes', 'startAt'] as const).filter((k) => k in patch);
  if (e.source === 'captured' && manualOnly.length) {
    throw new Error(
      'Matter and time of captured entries come from the timeline. Correct them there, then refresh.',
    );
  }

  const next: TimeEntry = { ...e, updatedAt: now };
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.billable !== undefined) next.billable = patch.billable;
  if (patch.billedOverrideMinutes !== undefined)
    next.billedOverrideMinutes = patch.billedOverrideMinutes;
  if (patch.overrideReason !== undefined)
    next.overrideReason = patch.overrideReason?.trim() || null;
  if (next.billedOverrideMinutes === null) next.overrideReason = null;

  if (patch.matterId !== undefined) {
    if (patch.matterId !== null) {
      const m = repo.getMatter(patch.matterId);
      if (!m) throw new Error('Unknown matter');
      if (m.archivedAt) throw new Error('That matter is archived');
    }
    next.matterId = patch.matterId;
  }
  if (patch.actualMinutes !== undefined) next.actualMs = patch.actualMinutes * 60_000;
  if (patch.startAt !== undefined) next.startAt = patch.startAt;
  if (next.source === 'manual')
    next.endAt = next.startAt === null ? null : next.startAt + next.actualMs;

  if (next.billedOverrideMinutes !== null) {
    const inc = repo.getSettings().billingPolicy.incrementMinutes;
    if (next.billedOverrideMinutes % inc !== 0) {
      throw new Error(`Billed time must be a multiple of the ${inc}-minute increment`);
    }
    if (!next.overrideReason) throw new Error('Give a reason for adjusting billed time');
  }
  return repo.saveEntry(next, 'entry_edit');
}

/** Freezes the billing calculation. Refuses while any blocking issue remains. */
export function approveEntry(repo: Repository, id: string, now = Date.now()): TimeEntry {
  const e = mustGet(repo, id);
  requireDraft(e, 'approved');
  const view = toView(repo, e, context(repo, e.entryDate));
  if (!canApprove(view.flags)) {
    const reasons = view.flags.filter((f) => f.severity === 'block').map((f) => f.message);
    throw new Error(`Cannot approve: ${reasons.join('; ')}`);
  }
  return repo.saveEntry(
    { ...e, status: 'approved', frozenBilling: view.calculation, approvedAt: now, updatedAt: now },
    'entry_approve',
    { billedMinutes: view.calculation.billedMinutes, trace: view.calculation.trace },
  );
}

/** Returns an approved, copied or rejected entry to draft. Its history is kept. */
export function reopenEntry(repo: Repository, id: string, now = Date.now()): TimeEntry {
  const e = mustGet(repo, id);
  if (e.status === 'draft') return e;
  if (e.status === 'exported') throw new Error('Exported entries cannot be reopened');
  return repo.saveEntry(
    { ...e, status: 'draft', frozenBilling: null, approvedAt: null, updatedAt: now },
    'entry_reopen',
    { wasCopied: e.copiedAt !== null },
  );
}

/** Marks timeline work as "not a time entry"; it won't be drafted again. */
export function rejectEntry(repo: Repository, id: string, now = Date.now()): TimeEntry {
  const e = mustGet(repo, id);
  requireDraft(e, 'rejected');
  return repo.saveEntry({ ...e, status: 'rejected', updatedAt: now }, 'entry_reject');
}

/** Deletes a draft outright. Captured work becomes eligible for a fresh draft. */
export function discardEntry(repo: Repository, id: string): void {
  requireDraft(mustGet(repo, id), 'discarded');
  repo.deleteEntry(id);
}

export function createManualEntry(
  repo: Repository,
  input: ManualEntryInput,
  now = Date.now(),
): TimeEntry {
  const m = repo.getMatter(input.matterId);
  if (!m) throw new Error('Unknown matter');
  if (m.archivedAt) throw new Error('That matter is archived');
  const { startMs, endMs } = localDayRange(input.entryDate);
  if (input.startAt !== null && (input.startAt < startMs || input.startAt >= endMs)) {
    throw new Error('Start time must fall on the entry date');
  }
  const actualMs = input.actualMinutes * 60_000;
  const entry: TimeEntry = {
    id: repo.newEntryId(),
    entryDate: input.entryDate,
    source: 'manual',
    matterId: input.matterId,
    description: input.description,
    startAt: input.startAt,
    endAt: input.startAt === null ? null : input.startAt + actualMs,
    intervals: [],
    evidenceEventIds: [],
    actualMs,
    billable: input.billable,
    billedOverrideMinutes: null,
    overrideReason: null,
    status: 'draft',
    frozenBilling: null,
    approvedAt: null,
    copiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertEntry(entry);
  return entry;
}

/**
 * Writes approved entries to the clipboard in the documented TSV format and marks them copied.
 * Returns exactly what was copied so the UI can show it.
 */
export function copyEntries(
  repo: Repository,
  ids: string[],
  writeClipboard: (text: string) => void,
  now = Date.now(),
): { text: string; count: number; billedMinutes: number } {
  const entries = ids.map((id) => mustGet(repo, id));
  const notReady = entries.filter((e) => e.status !== 'approved' && e.status !== 'copied');
  if (notReady.length) throw new Error('Only approved entries can be copied');
  const sorted = [...entries].sort(
    (a, b) =>
      a.entryDate.localeCompare(b.entryDate) ||
      (a.startAt ?? a.createdAt) - (b.startAt ?? b.createdAt),
  );
  const policy = repo.getSettings().billingPolicy;
  const withCalc = sorted.map((e) => ({ ...e, calculation: entryBilling(e, policy) }));
  const text = formatEntriesTsv(withCalc, repo.listMatters(true));

  writeClipboard(text);
  repo.db.transaction(() => {
    for (const e of sorted) {
      repo.saveEntry({ ...e, status: 'copied', copiedAt: now, updatedAt: now }, 'entry_copied', {
        hours: decimalHours(entryBilling(e, policy).billedMinutes),
      });
    }
  })();
  return {
    text,
    count: sorted.length,
    billedMinutes: withCalc.reduce((n, e) => n + (e.billable ? e.calculation.billedMinutes : 0), 0),
  };
}
