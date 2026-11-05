import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/schemas';
import type { ActivityEvent } from '../../shared/types';
import Database from 'better-sqlite3';
import { migrate, MIGRATIONS } from './migrations';
import { openDatabase, Repository } from './repository';

const T0 = Date.UTC(2026, 10, 5, 14, 0, 0);
const event = (p: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'e1',
  startedAt: T0,
  endedAt: T0 + 1000,
  kind: 'active',
  application: 'Word',
  processId: 1,
  windowTitle: 'Doc',
  browserUrl: null,
  browserTabTitle: null,
  idleSeconds: 0,
  source: 'mock',
  ...p,
});

function repo() {
  let n = 0;
  return new Repository(openDatabase(':memory:'), () => `id${++n}`);
}

describe('migrations', () => {
  it('are idempotent', () => {
    const r = repo();
    expect(migrate(r.db)).toEqual([]);
  });

  it('upgrade an existing v1 database without losing data', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    db.exec(MIGRATIONS[0]!.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (1, 'initial', 0)").run();
    const v1 = new Repository(db);
    v1.upsertEvents([event()]);

    expect(migrate(db)).toEqual([2, 3]);
    const r = new Repository(db);
    expect(r.eventsInRange(T0 - 1, T0 + 10_000)).toHaveLength(1);
    expect(r.correctionsInRange(T0 - 1, T0 + 10_000)).toEqual([]);
  });
});

describe('Repository events', () => {
  it('extends open events without rewriting captured evidence', () => {
    const r = repo();
    r.upsertEvents([event()]);
    r.upsertEvents([event({ endedAt: T0 + 5000, windowTitle: 'TAMPERED', application: 'X' })]);
    const [e] = r.eventsInRange(T0 - 1, T0 + 10_000);
    expect(e).toMatchObject({ endedAt: T0 + 5000, windowTitle: 'Doc', application: 'Word' });
  });

  it('returns events overlapping a range, including those spanning its edges', () => {
    const r = repo();
    r.upsertEvents([
      event({ id: 'a', startedAt: T0 - 5000, endedAt: T0 + 5000 }),
      event({ id: 'b', startedAt: T0 + 20_000, endedAt: T0 + 30_000 }),
    ]);
    expect(r.eventsInRange(T0, T0 + 10_000).map((e) => e.id)).toEqual(['a']);
  });

  it('deletes and audits', () => {
    const r = repo();
    r.upsertEvents([event()]);
    expect(r.deleteAllEvents()).toBe(1);
    const audit = r.db
      .prepare("SELECT action FROM audit_log WHERE action = 'delete_all_activity'")
      .all();
    expect(audit).toHaveLength(1);
  });
});

describe('Repository matters', () => {
  it('opens and closes manual matter periods', () => {
    const r = repo();
    const m1 = r.createMatter({ clientName: 'Contoso', matterName: 'Dispute' });
    const m2 = r.createMatter({ clientName: 'Fabrikam', matterName: 'Financing' });
    expect(m1.displayName).toBe('Contoso — Dispute');
    r.setActiveMatter(m1.id, T0);
    r.setActiveMatter(m2.id, T0 + 1000);
    r.setActiveMatter(null, T0 + 2000);
    expect(r.periodsInRange(T0 - 1, T0 + 5000)).toEqual([
      { id: expect.any(String), matterId: m1.id, startedAt: T0, endedAt: T0 + 1000 },
      { id: expect.any(String), matterId: m2.id, startedAt: T0 + 1000, endedAt: T0 + 2000 },
    ]);
    expect(r.openMatterPeriod()).toBeNull();
  });

  it('rejects unknown matters', () => {
    expect(() => repo().setActiveMatter('nope')).toThrow();
  });
});

describe('Repository settings', () => {
  it('round-trips and falls back to defaults on corrupt data', () => {
    const r = repo();
    expect(r.getSettings()).toEqual(DEFAULT_SETTINGS);
    const next = mergeSettings(DEFAULT_SETTINGS, {
      idleThresholdMinutes: 10,
      billingPolicy: { roundingMode: 'nearest' },
    });
    r.saveSettings(next);
    expect(r.getSettings().billingPolicy.roundingMode).toBe('nearest');
    expect(r.getSettings().billingPolicy.incrementMinutes).toBe(6);
    r.db
      .prepare("UPDATE settings SET value = ? WHERE key = 'app'")
      .run('{"pollIntervalSeconds": -4}');
    expect(r.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects invalid settings', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { pollIntervalSeconds: 1 })).toThrow();
  });
});
