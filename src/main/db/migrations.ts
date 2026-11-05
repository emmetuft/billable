import type Database from 'better-sqlite3';

/**
 * Schema migrations. Timestamps are INTEGER UTC epoch milliseconds.
 *
 * No database has been deployed yet, so the schema is a single initial migration that may be
 * edited freely during development (delete your local database after changing it).
 * Once the app is installed on a real user's machine, this list becomes append-only:
 * never edit a shipped migration; add a new one.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE matters (
        id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        matter_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        keywords TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );

      -- Observed evidence. Only ended_at/idle_seconds of the open event ever change.
      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('active', 'idle', 'excluded')),
        application TEXT NOT NULL,
        process_id INTEGER,
        window_title TEXT NOT NULL,
        browser_url TEXT,
        browser_tab_title TEXT,
        idle_seconds INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK (source IN ('macos', 'windows')),
        created_at INTEGER NOT NULL,
        CHECK (ended_at >= started_at)
      );
      CREATE INDEX idx_activity_events_range ON activity_events (started_at, ended_at);

      -- Matter selected while working.
      CREATE TABLE matter_periods (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters (id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_matter_periods_range ON matter_periods (started_at, ended_at);

      -- Review-time overlays on derived sessions (soft-deleted on undo).
      CREATE TABLE session_corrections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('assign_matter', 'split', 'join', 'note')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        matter_id TEXT REFERENCES matters (id),
        note TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      );
      CREATE INDEX idx_session_corrections_range ON session_corrections (started_at, ended_at);

      -- Billing records. Billing is frozen into frozen_billing at approval.
      CREATE TABLE time_entries (
        id TEXT PRIMARY KEY,
        entry_date TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('captured', 'manual')),
        matter_id TEXT REFERENCES matters (id),
        description TEXT NOT NULL DEFAULT '',
        start_at INTEGER,
        end_at INTEGER,
        intervals TEXT NOT NULL DEFAULT '[]',
        evidence_event_ids TEXT NOT NULL DEFAULT '[]',
        actual_ms INTEGER NOT NULL CHECK (actual_ms >= 0),
        billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
        billed_override_minutes INTEGER CHECK (billed_override_minutes >= 0),
        override_reason TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'copied', 'exported', 'rejected')),
        frozen_billing TEXT,
        approved_at INTEGER,
        copied_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_time_entries_date ON time_entries (entry_date);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
    `,
  },
];

export function migrate(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = db.prepare('SELECT version, name FROM schema_migrations').all() as {
    version: number;
    name: string;
  }[];

  // Refuse databases whose recorded history doesn't match this build (e.g. created by a
  // pre-release schema): running on a mismatched schema could silently corrupt data.
  const known = new Map(MIGRATIONS.map((m) => [m.version, m.name]));
  const mismatched = applied.filter((a) => known.get(a.version) !== a.name);
  if (mismatched.length > 0) {
    throw new Error(
      `This database was created by an incompatible development build (unknown migrations: ${mismatched
        .map((m) => `${m.version} ${m.name}`)
        .join(', ')}). Quit the app and delete the database file to start fresh.`,
    );
  }

  const done = new Set(applied.map((a) => a.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
    ran.push(m.version);
  }
  return ran;
}
