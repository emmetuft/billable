import type Database from 'better-sqlite3';

/**
 * Append-only list of schema migrations. Never edit a shipped migration; add a new one.
 * Timestamps are INTEGER UTC epoch milliseconds.
 * Later milestones add work_sessions, activity_interpretations and time_entries.
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
        source TEXT NOT NULL CHECK (source IN ('mock', 'macos', 'windows')),
        created_at INTEGER NOT NULL,
        CHECK (ended_at >= started_at)
      );
      CREATE INDEX idx_activity_events_range ON activity_events (started_at, ended_at);

      CREATE TABLE matter_periods (
        id TEXT PRIMARY KEY,
        matter_id TEXT NOT NULL REFERENCES matters (id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_matter_periods_range ON matter_periods (started_at, ended_at);

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
    `,
  },
  {
    version: 2,
    name: 'session_corrections',
    sql: `
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
    `,
  },
  {
    version: 3,
    name: 'time_entries',
    sql: `
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
      CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
    `,
  },
];

export function migrate(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
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
