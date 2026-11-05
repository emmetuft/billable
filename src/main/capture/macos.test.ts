import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isExcluded } from '../../core/capture/exclusions';
import { FRONT_WINDOW_JXA, parseFrontWindow, toSnapshot, type FrontWindowInfo } from './macos';

const ctx = {
  timestamp: '2026-11-05T12:00:00.000Z',
  idleSeconds: 3,
  selfPid: 100,
  selfName: 'Billable',
};
const vscode: FrontWindowInfo = {
  appName: 'Code',
  processName: 'Electron',
  pid: 7980,
  title: 'App.tsx — billable',
  titleStatus: 'ok',
};

describe('macOS front-window parsing', () => {
  it('records the displayed app name, not the Electron executable name', () => {
    expect(toSnapshot(vscode, ctx)).toMatchObject({
      application: 'Code',
      processName: 'Electron',
      processId: 7980,
      windowTitle: 'App.tsx — billable',
    });
  });

  it("labels this app's own windows by name instead of 'Electron'", () => {
    const self = { ...vscode, appName: 'Electron', pid: 100, title: 'Billable' };
    expect(toSnapshot(self, ctx).application).toBe('Billable');
  });

  it('falls back to the process name when no display name is available', () => {
    expect(toSnapshot({ ...vscode, appName: '' }, ctx).application).toBe('Electron');
  });

  it('rejects malformed script output', () => {
    expect(() => parseFrontWindow('{"appName": "x"}')).toThrow();
    expect(() => parseFrontWindow('not json')).toThrow();
    expect(parseFrontWindow(` ${JSON.stringify(vscode)}\n`)).toEqual(vscode);
  });

  it('matches exclusions on either the display name or the process name', () => {
    const rules = {
      excludedApplications: ['electron'],
      excludedDomains: [],
      excludedTitleKeywords: [],
    };
    expect(isExcluded(toSnapshot(vscode, ctx), rules)).toBe(true);
    expect(isExcluded(toSnapshot(vscode, ctx), { ...rules, excludedApplications: ['code'] })).toBe(
      true,
    );
    expect(isExcluded(toSnapshot(vscode, ctx), { ...rules, excludedApplications: ['Slack'] })).toBe(
      false,
    );
  });
});

// Real System Events call. Opt-in because it needs macOS, a GUI session and Automation permission:
//   MACOS_INTEGRATION=1 npx vitest run src/main/capture/macos.test.ts
describe.runIf(process.platform === 'darwin' && process.env.MACOS_INTEGRATION === '1')(
  'macOS front-window script (integration)',
  () => {
    it('returns a well-formed description of the frontmost app', () => {
      const out = execFileSync('osascript', ['-l', 'JavaScript', '-e', FRONT_WINDOW_JXA], {
        encoding: 'utf8',
      });
      const info = parseFrontWindow(out);
      expect(info.pid).toBeGreaterThan(0);
      expect(info.appName.length + info.processName.length).toBeGreaterThan(0);
      console.log('frontmost:', info);
    });
  },
);
