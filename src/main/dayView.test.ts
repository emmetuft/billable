import { describe, expect, it } from 'vitest';
import { seedFixtureDay } from '../test/fixtures/workday';
import { openDatabase, Repository } from './db/repository';
import { buildDayView } from './dayView';

const DAY = new Date(2026, 10, 4).getTime();
const START = DAY + (8 * 60 + 52) * 60_000;

describe('fixture workday → day view', () => {
  it('rolls a matter selected twice into one billing row', () => {
    const repo = new Repository(openDatabase(':memory:'));
    seedFixtureDay(repo, START);
    expect(
      repo
        .listMatters()
        .map((m) => m.clientName)
        .sort(),
    ).toEqual(['Contoso Ltd.', 'Fabrikam, Inc.']);
    const view = buildDayView(repo, DAY, DAY + 86_400_000);
    expect(view.matterBilling).toHaveLength(2);
  });

  it('leaves no gap at a manual matter switch', () => {
    const repo = new Repository(openDatabase(':memory:'));
    seedFixtureDay(repo, START);
    const { sessions } = buildDayView(repo, DAY, DAY + 86_400_000);
    expect(sessions[1]!.startedAt).toBe(sessions[0]!.endedAt);
  });
});
