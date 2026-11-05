import { describe, expect, it } from 'vitest';
import { openDatabase, Repository } from './db/repository';
import { buildDayView, writeSampleDay } from './dayView';

const DAY = new Date(2026, 10, 4).getTime();
const START = DAY + (8 * 60 + 52) * 60_000;

describe('sample day → day view', () => {
  it('creates each mock matter once, even when selected repeatedly', () => {
    const repo = new Repository(openDatabase(':memory:'));
    writeSampleDay(repo, START);
    expect(
      repo
        .listMatters()
        .map((m) => m.clientName)
        .sort(),
    ).toEqual(['Contoso Ltd.', 'Fabrikam, Inc.']);
    const view = buildDayView(repo, DAY, DAY + 86_400_000);
    expect(view.matterBilling).toHaveLength(2); // Contoso's two sessions roll up to one row
    expect(view.containsMockData).toBe(true);
  });

  it('leaves no gap at a manual matter switch', () => {
    const repo = new Repository(openDatabase(':memory:'));
    writeSampleDay(repo, START);
    const { sessions } = buildDayView(repo, DAY, DAY + 86_400_000);
    expect(sessions[1]!.startedAt).toBe(sessions[0]!.endedAt);
  });

  it('refuses to write sample data over existing activity', () => {
    const repo = new Repository(openDatabase(':memory:'));
    writeSampleDay(repo, START);
    expect(() => writeSampleDay(repo, START)).toThrow(/already exists/);
  });
});
