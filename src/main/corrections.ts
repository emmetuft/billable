import type { SessionSpan } from '../shared/schemas';
import type { Repository } from './db/repository';

/**
 * Review-time session corrections. Each writes time-anchored records into
 * session_corrections; captured events are never modified.
 */

function assertAssignable(repo: Repository, matterId: string | null): void {
  if (matterId === null) return;
  const m = repo.getMatter(matterId);
  if (!m) throw new Error('Unknown matter');
  if (m.archivedAt) throw new Error('That matter is archived. Restore it before assigning work.');
}

/** Assign every event in the session span to a matter (null = explicitly unassigned). */
export function reassignSession(repo: Repository, span: SessionSpan, matterId: string | null) {
  assertAssignable(repo, matterId);
  return repo.addCorrection({
    kind: 'assign_matter',
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    matterId,
    note: null,
  });
}

/** Start a new session at the event beginning at `at`. */
export function splitSessionAt(repo: Repository, at: number) {
  return repo.addCorrection({
    kind: 'split',
    startedAt: at,
    endedAt: null,
    matterId: null,
    note: null,
  });
}

/**
 * Merge two consecutive sessions into one:
 *  - removes manual splits between them,
 *  - bridges any inactivity gap with a join,
 *  - if their matters differ, assigns the combined span to `matterId`.
 */
export function mergeSessions(
  repo: Repository,
  first: SessionSpan & { matterId: string | null },
  second: SessionSpan & { matterId: string | null },
  matterId: string | null,
): void {
  if (first.endedAt > second.startedAt) throw new Error('Sessions must be consecutive');
  if (matterId !== first.matterId && matterId !== second.matterId) {
    throw new Error('Merged session must keep one of the two sessions’ matters');
  }
  assertAssignable(repo, matterId);
  repo.db.transaction(() => {
    repo.removeCorrectionsAnchoredIn('split', first.startedAt + 1, second.startedAt);
    if (second.startedAt > first.endedAt) {
      repo.addCorrection({
        kind: 'join',
        startedAt: first.endedAt,
        endedAt: second.startedAt,
        matterId: null,
        note: null,
      });
    }
    if (first.matterId !== matterId || second.matterId !== matterId) {
      repo.addCorrection({
        kind: 'assign_matter',
        startedAt: first.startedAt,
        endedAt: second.endedAt,
        matterId,
        note: null,
      });
    }
  })();
}

/** Replace the attorney's note for a session ('' clears it). */
export function setSessionNote(repo: Repository, span: SessionSpan, note: string): void {
  repo.db.transaction(() => {
    repo.removeCorrectionsAnchoredIn(
      'note',
      span.startedAt,
      Math.max(span.endedAt - 1, span.startedAt),
    );
    const text = note.trim();
    if (text) {
      repo.addCorrection({
        kind: 'note',
        startedAt: span.startedAt,
        endedAt: null,
        matterId: null,
        note: text,
      });
    }
  })();
}
