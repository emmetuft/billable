import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, SettingsSchema, type MatterInput } from '../../shared/schemas';
import type {
  ActivityEvent,
  Matter,
  MatterPeriod,
  EntryHistoryItem,
  SessionCorrection,
  Settings,
  TimeEntry,
} from '../../shared/types';
import { migrate } from './migrations';

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  if (file !== ':memory:') {
    try {
      chmodSync(file, 0o600); // owner read/write only
    } catch {
      /* best effort; documented in docs/privacy-and-security.md */
    }
  }
  return db;
}

type Row = Record<string, unknown>;

const toEvent = (r: Row): ActivityEvent => ({
  id: r.id as string,
  startedAt: r.started_at as number,
  endedAt: r.ended_at as number,
  kind: r.kind as ActivityEvent['kind'],
  application: r.application as string,
  processId: (r.process_id as number | null) ?? null,
  windowTitle: r.window_title as string,
  browserUrl: (r.browser_url as string | null) ?? null,
  browserTabTitle: (r.browser_tab_title as string | null) ?? null,
  idleSeconds: r.idle_seconds as number,
  source: r.source as ActivityEvent['source'],
});

const toMatter = (r: Row): Matter => ({
  id: r.id as string,
  clientName: r.client_name as string,
  matterName: r.matter_name as string,
  displayName: r.display_name as string,
  aliases: JSON.parse(r.aliases as string) as string[],
  keywords: JSON.parse(r.keywords as string) as string[],
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
  archivedAt: (r.archived_at as number | null) ?? null,
});

const toPeriod = (r: Row): MatterPeriod => ({
  id: r.id as string,
  matterId: r.matter_id as string,
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? null,
});

const toCorrection = (r: Row): SessionCorrection => ({
  id: r.id as string,
  kind: r.kind as SessionCorrection['kind'],
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? null,
  matterId: (r.matter_id as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  createdAt: r.created_at as number,
});

const toEntry = (r: Row): TimeEntry => ({
  id: r.id as string,
  entryDate: r.entry_date as string,
  source: r.source as TimeEntry['source'],
  matterId: (r.matter_id as string | null) ?? null,
  description: r.description as string,
  startAt: (r.start_at as number | null) ?? null,
  endAt: (r.end_at as number | null) ?? null,
  intervals: JSON.parse(r.intervals as string) as TimeEntry['intervals'],
  evidenceEventIds: JSON.parse(r.evidence_event_ids as string) as string[],
  actualMs: r.actual_ms as number,
  billable: r.billable === 1,
  billedOverrideMinutes: (r.billed_override_minutes as number | null) ?? null,
  overrideReason: (r.override_reason as string | null) ?? null,
  status: r.status as TimeEntry['status'],
  frozenBilling: r.frozen_billing ? JSON.parse(r.frozen_billing as string) : null,
  approvedAt: (r.approved_at as number | null) ?? null,
  copiedAt: (r.copied_at as number | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

const entryToRow = (e: TimeEntry) => ({
  id: e.id,
  entry_date: e.entryDate,
  source: e.source,
  matter_id: e.matterId,
  description: e.description,
  start_at: e.startAt,
  end_at: e.endAt,
  intervals: JSON.stringify(e.intervals),
  evidence_event_ids: JSON.stringify(e.evidenceEventIds),
  actual_ms: e.actualMs,
  billable: e.billable ? 1 : 0,
  billed_override_minutes: e.billedOverrideMinutes,
  override_reason: e.overrideReason,
  status: e.status,
  frozen_billing: e.frozenBilling ? JSON.stringify(e.frozenBilling) : null,
  approved_at: e.approvedAt,
  copied_at: e.copiedAt,
  created_at: e.createdAt,
  updated_at: e.updatedAt,
});

const ENTRY_COLUMNS = Object.keys(entryToRow({} as TimeEntry));

export class Repository {
  constructor(
    readonly db: Database.Database,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // ---- activity events (observed evidence) ----

  /**
   * Inserts new events or extends open ones. Only `ended_at`/`idle_seconds` can change after
   * insert, so captured evidence (app, title, URL, start) is never rewritten.
   */
  upsertEvents(events: ActivityEvent[], now = Date.now()): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO activity_events (id, started_at, ended_at, kind, application, process_id,
        window_title, browser_url, browser_tab_title, idle_seconds, source, created_at)
      VALUES (@id, @startedAt, @endedAt, @kind, @application, @processId,
        @windowTitle, @browserUrl, @browserTabTitle, @idleSeconds, @source, @now)
      ON CONFLICT (id) DO UPDATE SET ended_at = excluded.ended_at, idle_seconds = excluded.idle_seconds`);
    this.db.transaction(() => {
      for (const e of events) stmt.run({ ...e, idleSeconds: Math.round(e.idleSeconds), now });
    })();
  }

  /** Events overlapping [startMs, endMs). */
  eventsInRange(startMs: number, endMs: number): ActivityEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM activity_events WHERE started_at < ? AND ended_at > ? ORDER BY started_at, id',
      )
      .all(endMs, startMs)
      .map((r) => toEvent(r as Row));
  }

  /** Deletes events that start within [startMs, endMs). */
  deleteEventsInRange(startMs: number, endMs: number): number {
    const n = this.db
      .prepare('DELETE FROM activity_events WHERE started_at >= ? AND started_at < ?')
      .run(startMs, endMs).changes;
    this.db
      .prepare('DELETE FROM session_corrections WHERE started_at >= ? AND started_at < ?')
      .run(startMs, endMs);
    this.audit('delete_activity', 'activity_events', null, { startMs, endMs, deleted: n });
    return n;
  }

  deleteAllEvents(): number {
    const n = this.db.prepare('DELETE FROM activity_events').run().changes;
    this.db.prepare('DELETE FROM matter_periods').run();
    this.db.prepare('DELETE FROM session_corrections').run();
    this.audit('delete_all_activity', 'activity_events', null, { deleted: n });
    return n;
  }

  purgeOlderThan(cutoffMs: number): number {
    const n = this.db
      .prepare('DELETE FROM activity_events WHERE ended_at < ?')
      .run(cutoffMs).changes;
    this.db
      .prepare('DELETE FROM matter_periods WHERE ended_at IS NOT NULL AND ended_at < ?')
      .run(cutoffMs);
    this.db
      .prepare('DELETE FROM session_corrections WHERE COALESCE(ended_at, started_at) < ?')
      .run(cutoffMs);
    if (n > 0) this.audit('retention_purge', 'activity_events', null, { cutoffMs, deleted: n });
    return n;
  }

  // ---- matters ----

  listMatters(includeArchived = false): Matter[] {
    const sql = includeArchived
      ? 'SELECT * FROM matters ORDER BY display_name COLLATE NOCASE'
      : 'SELECT * FROM matters WHERE archived_at IS NULL ORDER BY display_name COLLATE NOCASE';
    return this.db
      .prepare(sql)
      .all()
      .map((r) => toMatter(r as Row));
  }

  getMatter(id: string): Matter | null {
    const r = this.db.prepare('SELECT * FROM matters WHERE id = ?').get(id);
    return r ? toMatter(r as Row) : null;
  }

  createMatter(input: MatterInput, now = Date.now()): Matter {
    const m: Matter = {
      id: this.newId(),
      clientName: input.clientName,
      matterName: input.matterName,
      displayName: input.displayName || `${input.clientName} — ${input.matterName}`,
      aliases: input.aliases ?? [],
      keywords: input.keywords ?? [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO matters (id, client_name, matter_name, display_name, aliases, keywords, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.clientName,
        m.matterName,
        m.displayName,
        JSON.stringify(m.aliases),
        JSON.stringify(m.keywords),
        now,
        now,
      );
    this.audit('create', 'matter', m.id, {});
    return m;
  }

  updateMatter(id: string, input: MatterInput, now = Date.now()): Matter {
    const existing = this.getMatter(id);
    if (!existing) throw new Error('Unknown matter');
    const displayName = input.displayName || `${input.clientName} — ${input.matterName}`;
    this.db
      .prepare(
        `UPDATE matters SET client_name = ?, matter_name = ?, display_name = ?, aliases = ?,
         keywords = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.clientName,
        input.matterName,
        displayName,
        JSON.stringify(input.aliases ?? existing.aliases),
        JSON.stringify(input.keywords ?? existing.keywords),
        now,
        id,
      );
    this.audit('update', 'matter', id, {});
    return this.getMatter(id)!;
  }

  archiveMatter(id: string, now = Date.now()): void {
    this.db
      .prepare('UPDATE matters SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    this.audit('archive', 'matter', id, {});
  }

  // ---- manual matter selection ----

  openMatterPeriod(): MatterPeriod | null {
    const r = this.db
      .prepare(
        'SELECT * FROM matter_periods WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get();
    return r ? toPeriod(r as Row) : null;
  }

  /** Closes any open selection and, if matterId is given, opens a new one at `now`. */
  setActiveMatter(matterId: string | null, now = Date.now()): void {
    if (matterId !== null && !this.getMatter(matterId)) throw new Error('Unknown matter');
    this.db.transaction(() => {
      this.db.prepare('UPDATE matter_periods SET ended_at = ? WHERE ended_at IS NULL').run(now);
      if (matterId) {
        this.db
          .prepare(
            'INSERT INTO matter_periods (id, matter_id, started_at, ended_at, created_at) VALUES (?, ?, ?, NULL, ?)',
          )
          .run(this.newId(), matterId, now, now);
      }
      this.audit('select_matter', 'matter', matterId, { at: now });
    })();
  }

  insertMatterPeriods(periods: MatterPeriod[], now = Date.now()): void {
    const stmt = this.db.prepare(
      'INSERT INTO matter_periods (id, matter_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const p of periods) stmt.run(p.id, p.matterId, p.startedAt, p.endedAt, now);
    })();
  }

  periodsInRange(startMs: number, endMs: number): MatterPeriod[] {
    return this.db
      .prepare(
        'SELECT * FROM matter_periods WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at',
      )
      .all(endMs, startMs)
      .map((r) => toPeriod(r as Row));
  }

  // ---- session corrections (review-time overrides; evidence is never edited) ----

  addCorrection(
    c: Omit<SessionCorrection, 'id' | 'createdAt'>,
    now = Date.now(),
  ): SessionCorrection {
    const full: SessionCorrection = { ...c, id: this.newId(), createdAt: now };
    this.db
      .prepare(
        `INSERT INTO session_corrections (id, kind, started_at, ended_at, matter_id, note, created_at)
         VALUES (@id, @kind, @startedAt, @endedAt, @matterId, @note, @createdAt)`,
      )
      .run(full);
    this.audit(`correction_${c.kind}`, 'session_correction', full.id, {
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      matterId: c.matterId,
    });
    return full;
  }

  /** Active corrections touching [startMs, endMs]. */
  correctionsInRange(startMs: number, endMs: number): SessionCorrection[] {
    return this.db
      .prepare(
        `SELECT * FROM session_corrections
         WHERE deleted_at IS NULL AND started_at < ? AND COALESCE(ended_at, started_at) >= ?
         ORDER BY created_at, id`,
      )
      .all(endMs, startMs)
      .map((r) => toCorrection(r as Row));
  }

  /** Soft-deletes (undoes) a correction; the audit log keeps the history. */
  undoCorrection(id: string, now = Date.now()): void {
    const n = this.db
      .prepare('UPDATE session_corrections SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, id).changes;
    if (n === 0) throw new Error('Correction not found');
    this.audit('correction_undo', 'session_correction', id, {});
  }

  /** Soft-deletes corrections of one kind anchored within [startMs, endMs]. */
  removeCorrectionsAnchoredIn(
    kind: SessionCorrection['kind'],
    startMs: number,
    endMs: number,
    now = Date.now(),
  ): number {
    return this.db
      .prepare(
        `UPDATE session_corrections SET deleted_at = ?
         WHERE kind = ? AND deleted_at IS NULL AND started_at >= ? AND started_at <= ?`,
      )
      .run(now, kind, startMs, endMs).changes;
  }

  // ---- time entries ----

  newEntryId(): string {
    return this.newId();
  }

  insertEntry(e: TimeEntry, auditDetail: object = {}): void {
    this.db
      .prepare(
        `INSERT INTO time_entries (${ENTRY_COLUMNS.join(', ')})
         VALUES (${ENTRY_COLUMNS.map((c) => `@${c}`).join(', ')})`,
      )
      .run(entryToRow(e));
    this.audit('entry_create', 'time_entry', e.id, { source: e.source, ...auditDetail });
  }

  getEntry(id: string): TimeEntry | null {
    const r = this.db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id);
    return r ? toEntry(r as Row) : null;
  }

  entriesForDate(entryDate: string): TimeEntry[] {
    return this.db
      .prepare(
        'SELECT * FROM time_entries WHERE entry_date = ? ORDER BY COALESCE(start_at, created_at), id',
      )
      .all(entryDate)
      .map((r) => toEntry(r as Row));
  }

  /**
   * Writes a changed entry and audits exactly which fields changed (old → new), so the history
   * of every approved entry can be reconstructed.
   */
  saveEntry(next: TimeEntry, action: string, extra: object = {}): TimeEntry {
    const prev = this.getEntry(next.id);
    if (!prev) throw new Error('Entry not found');
    const before = entryToRow(prev) as Record<string, unknown>;
    const after = entryToRow(next) as Record<string, unknown>;
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of ENTRY_COLUMNS) {
      if (k !== 'updated_at' && before[k] !== after[k]) changes[k] = [before[k], after[k]];
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE time_entries SET ${ENTRY_COLUMNS.filter((c) => c !== 'id')
            .map((c) => `${c} = @${c}`)
            .join(', ')} WHERE id = @id`,
        )
        .run(after);
      this.audit(action, 'time_entry', next.id, { changes, ...extra });
    })();
    return next;
  }

  deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);
    this.audit('entry_discard', 'time_entry', id, {});
  }

  entryHistory(id: string): EntryHistoryItem[] {
    return this.db
      .prepare(
        "SELECT at, action, detail FROM audit_log WHERE entity_type = 'time_entry' AND entity_id = ? ORDER BY id",
      )
      .all(id)
      .map((r) => {
        const row = r as { at: number; action: string; detail: string };
        return { at: row.at, action: row.action, detail: JSON.parse(row.detail) };
      });
  }

  // ---- settings ----

  getSettings(): Settings {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
      { value: string } | undefined;
    if (!r) return DEFAULT_SETTINGS;
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...JSON.parse(r.value) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  saveSettings(settings: Settings, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(SettingsSchema.parse(settings)), now);
    this.audit('update', 'settings', 'app', {});
  }

  // ---- audit ----

  audit(action: string, entityType: string, entityId: string | null, detail: object): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (at, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(Date.now(), action, entityType, entityId, JSON.stringify(detail));
  }
}
