import { describe, expect, it } from 'vitest';
import { mergeSessions, reassignSession, setSessionNote, splitSessionAt } from './corrections';
import { openDatabase, Repository } from './db/repository';
import { buildDayView, writeSampleDay } from './dayView';

const DAY = new Date(2026, 10, 4).getTime();
const DAY_END = DAY + 86_400_000;
const START = DAY + (8 * 60 + 52) * 60_000;

function setup() {
  const repo = new Repository(openDatabase(':memory:'));
  writeSampleDay(repo, START);
  const view = () => buildDayView(repo, DAY, DAY_END);
  const matter = (client: string) =>
    repo.listMatters().find((m) => m.clientName.startsWith(client))!.id;
  return { repo, view, matter };
}

describe('session corrections against the sample day', () => {
  it('reassigns an unassigned session, bills it, and can be undone', () => {
    const { repo, view, matter } = setup();
    const before = view();
    const target = before.sessions[0]!; // morning Outlook, no matter
    expect(target.matterId).toBeNull();

    const c = reassignSession(repo, target, matter('Contoso'));
    const after = view();
    // Now contiguous with the following Contoso session, so they combine.
    expect(after.sessions[0]).toMatchObject({
      matterId: matter('Contoso'),
      matterSource: 'corrected',
    });
    expect(after.totals.unassignedActiveMs).toBe(
      before.totals.unassignedActiveMs - target.activeMs,
    );
    expect(
      after.sessionBilling.find((b) => b.sessionId === after.sessions[0]!.id)!.calculation,
    ).not.toBeNull();

    repo.undoCorrection(c.id);
    expect(view().sessions.map((s) => s.matterId)).toEqual(before.sessions.map((s) => s.matterId));
  });

  it('splits at an event and merging puts it back', () => {
    const { repo, view } = setup();
    const before = view();
    const s = before.sessions[1]!; // Contoso morning session
    const third = before.events.filter((e) => s.eventIds.includes(e.id))[2]!;

    splitSessionAt(repo, third.startedAt);
    const split = view();
    expect(split.sessions).toHaveLength(before.sessions.length + 1);
    const [a, b] = [split.sessions[1]!, split.sessions[2]!];
    expect(b.startReason).toBe('manual_split');
    expect(a.activeMs + b.activeMs).toBe(s.activeMs); // no time lost or invented

    mergeSessions(repo, a, b, a.matterId);
    expect(view().sessions.map((x) => x.activeMs)).toEqual(before.sessions.map((x) => x.activeMs));
  });

  it('merges across an idle gap and a matter change, keeping the chosen matter', () => {
    const { repo, view, matter } = setup();
    const before = view();
    const [a, b] = [before.sessions[1]!, before.sessions[2]!]; // Contoso, then Fabrikam after idle
    expect(b.startReason).toBe('matter_change');

    mergeSessions(repo, a, b, matter('Fabrikam'));
    const after = view();
    expect(after.sessions).toHaveLength(before.sessions.length - 1);
    expect(after.sessions[1]).toMatchObject({
      matterId: matter('Fabrikam'),
      activeMs: a.activeMs + b.activeMs,
    });
  });

  it('rejects merging into an unrelated matter or out of order', () => {
    const { repo, view, matter } = setup();
    const [, a, b] = view().sessions;
    const other = repo.createMatter({ clientName: 'Other', matterName: 'X' }).id;
    expect(() => mergeSessions(repo, a!, b!, other)).toThrow(/one of the two/);
    expect(() => mergeSessions(repo, b!, a!, matter('Contoso'))).toThrow(/consecutive/);
  });

  it('refuses to assign work to an archived matter', () => {
    const { repo, view } = setup();
    const m = repo.createMatter({ clientName: 'Old', matterName: 'Closed' });
    repo.archiveMatter(m.id);
    expect(() => reassignSession(repo, view().sessions[0]!, m.id)).toThrow(/archived/);
  });

  it('sets, replaces and clears a session note', () => {
    const { repo, view } = setup();
    const s = view().sessions[0]!;
    setSessionNote(repo, s, 'Triage of incoming client email');
    setSessionNote(repo, s, 'Email triage');
    expect(view().sessions[0]!.note).toBe('Email triage');
    setSessionNote(repo, s, '   ');
    expect(view().sessions[0]!.note).toBeNull();
  });

  it('never modifies captured evidence', () => {
    const { repo, view, matter } = setup();
    const evidence = JSON.stringify(view().events);
    const [s0, s1] = view().sessions;
    reassignSession(repo, s0!, matter('Fabrikam'));
    splitSessionAt(repo, s1!.startedAt + 1);
    setSessionNote(repo, s1!, 'note');
    expect(JSON.stringify(view().events)).toBe(evidence);
  });

  it('deleting a day also deletes its corrections', () => {
    const { repo, view, matter } = setup();
    reassignSession(repo, view().sessions[0]!, matter('Contoso'));
    repo.deleteEventsInRange(DAY, DAY_END);
    expect(repo.correctionsInRange(DAY, DAY_END)).toEqual([]);
  });
});

describe('matter editing', () => {
  it('updates names and recomputes the display name', () => {
    const repo = new Repository(openDatabase(':memory:'));
    const m = repo.createMatter({ clientName: 'Acme', matterName: 'Lease', keywords: ['lease'] });
    const u = repo.updateMatter(m.id, { clientName: 'Acme Corp', matterName: 'Lease Renewal' });
    expect(u).toMatchObject({ displayName: 'Acme Corp — Lease Renewal', keywords: ['lease'] });
  });
});
