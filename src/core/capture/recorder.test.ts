import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../shared/types';
import { isExcluded } from './exclusions';
import { buildMockDay, MOCK_SCENARIO, MockActivityCapture } from './mock';
import { ActivityRecorder } from './recorder';
import type { ActivitySnapshot } from './types';

const S = 1000;
const T0 = Date.UTC(2026, 10, 5, 14, 0, 0);

function setup(isExcludedFn?: (s: ActivitySnapshot) => boolean) {
  let n = 0;
  const recorder = new ActivityRecorder({
    source: 'mock',
    idleThresholdSeconds: 300,
    maxGapSeconds: 60,
    isExcluded: isExcludedFn,
    newId: () => `e${++n}`,
  });
  const store = new Map<string, ActivityEvent>();
  const feed = (t: number, snap: Partial<ActivitySnapshot> | null) => {
    const s = snap && {
      timestamp: new Date(t).toISOString(),
      application: 'Word',
      windowTitle: 'Doc A',
      idleSeconds: 0,
      ...snap,
    };
    for (const e of recorder.ingest(s, t)) store.set(e.id, e);
  };
  const events = () => [...store.values()].sort((a, b) => a.startedAt - b.startedAt);
  return { recorder, feed, events };
}

describe('ActivityRecorder', () => {
  it('extends the open event instead of inserting duplicates', () => {
    const { feed, events } = setup();
    for (let i = 0; i <= 4; i++) feed(T0 + i * 15 * S, {});
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ startedAt: T0, endedAt: T0 + 60 * S, kind: 'active' });
  });

  it('starts a new event when the window changes', () => {
    const { feed, events } = setup();
    feed(T0, {});
    feed(T0 + 15 * S, {});
    feed(T0 + 30 * S, { windowTitle: 'Doc B' });
    const [a, b] = events();
    expect(a).toMatchObject({ windowTitle: 'Doc A', endedAt: T0 + 30 * S });
    expect(b).toMatchObject({ windowTitle: 'Doc B', startedAt: T0 + 30 * S });
  });

  it('truncates active time back to when input stopped, and records idle explicitly', () => {
    const { feed, events } = setup();
    feed(T0, {});
    // Input stops at T0+60s; idle crosses the 300s threshold at T0+360s.
    for (let t = 15; t <= 420; t += 15) feed(T0 + t * S, { idleSeconds: Math.max(0, t - 60) });
    const [active, idle] = events();
    expect(active).toMatchObject({ kind: 'active', endedAt: T0 + 60 * S });
    expect(idle).toMatchObject({ kind: 'idle', startedAt: T0 + 60 * S, endedAt: T0 + 420 * S });
    expect(idle!.windowTitle).toBe(''); // idle events carry no window metadata
  });

  it('ends idle when input resumes', () => {
    const { feed, events } = setup();
    feed(T0, { idleSeconds: 600 });
    feed(T0 + 15 * S, { idleSeconds: 615 });
    feed(T0 + 30 * S, { idleSeconds: 5 });
    const [idle, active] = events();
    expect(idle).toMatchObject({ kind: 'idle', endedAt: T0 + 25 * S });
    expect(active).toMatchObject({ kind: 'active', startedAt: T0 + 25 * S });
  });

  it('treats a locked screen as idle immediately', () => {
    const { feed, events } = setup();
    feed(T0, {});
    feed(T0 + 15 * S, { locked: true, idleSeconds: 2 });
    expect(events()[1]).toMatchObject({ kind: 'idle', application: 'Screen locked' });
  });

  it('does not bridge sleep gaps or backwards clock changes', () => {
    const { feed, events } = setup();
    feed(T0, {});
    feed(T0 + 15 * S, {});
    feed(T0 + 3600 * S, {}); // woke from sleep
    feed(T0 + 3590 * S, {}); // clock moved backwards
    const ev = events();
    expect(ev).toHaveLength(3);
    expect(ev[0]!.endedAt).toBe(T0 + 15 * S);
    expect(ev[1]!.startedAt).toBe(T0 + 3590 * S);
    expect(ev[2]!.startedAt).toBe(T0 + 3600 * S);
  });

  it('closes continuity on a null snapshot', () => {
    const { feed, events } = setup();
    feed(T0, {});
    feed(T0 + 15 * S, null);
    feed(T0 + 30 * S, {});
    expect(events()).toHaveLength(2);
    expect(events()[0]!.endedAt).toBe(T0);
  });

  it('records excluded apps without any identifying metadata', () => {
    const rules = {
      excludedApplications: ['1Password'],
      excludedDomains: ['bank.example'],
      excludedTitleKeywords: ['Incognito'],
    };
    const { feed, events } = setup((s) => isExcluded(s, rules));
    feed(T0, { application: '1Password', windowTitle: 'Secrets', processId: 42 });
    feed(T0 + 15 * S, {
      application: 'Chrome',
      windowTitle: 'x',
      browserUrl: 'https://login.bank.example/a',
    });
    const ev = events();
    expect(ev).toHaveLength(1); // consecutive excluded activity merges
    expect(ev[0]).toMatchObject({
      kind: 'excluded',
      application: 'Excluded',
      windowTitle: '',
      processId: null,
      browserUrl: null,
    });
  });
});

describe('isExcluded', () => {
  const rules = {
    excludedApplications: ['1password'],
    excludedDomains: ['*.bank.example'],
    excludedTitleKeywords: ['incognito'],
  };
  const snap = (p: Partial<ActivitySnapshot>): ActivitySnapshot => ({
    timestamp: '',
    application: 'Chrome',
    windowTitle: '',
    idleSeconds: 0,
    ...p,
  });
  it('matches apps, title keywords and domain suffixes case-insensitively', () => {
    expect(isExcluded(snap({ application: '1Password' }), rules)).toBe(true);
    expect(isExcluded(snap({ windowTitle: 'New Incognito Tab' }), rules)).toBe(true);
    expect(isExcluded(snap({ browserUrl: 'https://bank.example/' }), rules)).toBe(true);
    expect(isExcluded(snap({ browserUrl: 'https://notbank.example/' }), rules)).toBe(false);
    expect(isExcluded(snap({ browserUrl: 'not a url' }), rules)).toBe(false);
  });
});

describe('mock capture', () => {
  it('builds the same day deterministically', () => {
    const mk = () => {
      let n = 0;
      return buildMockDay(T0, { idleThresholdSeconds: 300, newId: () => `m${++n}` });
    };
    expect(mk()).toEqual(mk());
  });

  it('produces non-overlapping, ordered events with explicit idle and no work during "away"', () => {
    const { events, matterSelections } = buildMockDay(T0, { idleThresholdSeconds: 300 });
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.startedAt).toBeGreaterThanOrEqual(events[i - 1]!.endedAt);
    }
    expect(events.some((e) => e.kind === 'idle')).toBe(true);
    expect(matterSelections.map((m) => m.matter)).toEqual(['contoso', 'fabrikam', null, 'contoso']);
    const awayStart = T0 + MOCK_SCENARIO.slice(0, 9).reduce((n, s) => n + s.minutes, 0) * 60 * S;
    const awayEnd = awayStart + 50 * 60 * S;
    expect(events.some((e) => e.startedAt < awayEnd && e.endedAt > awayStart + 60 * S)).toBe(false);
  });

  it('live mock replays the scenario against the clock', async () => {
    let now = T0;
    const cap = new MockActivityCapture(MOCK_SCENARIO, () => now);
    await cap.start();
    expect((await cap.getCurrentActivity())!.application).toBe('Microsoft Outlook');
    now += 13 * 60 * S;
    expect((await cap.getCurrentActivity())!.application).toBe('Microsoft Word');
  });
});
