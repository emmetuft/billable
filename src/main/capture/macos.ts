import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ActivityCapture, ActivitySnapshot } from '../../core/capture/types';
import type { CaptureSource } from '../../shared/types';

const run = promisify(execFile);

/**
 * Reads the frontmost app and its focused window title via System Events (JXA). Metadata only:
 * app name, pid and window title. No content, no keystrokes.
 *
 * Two macOS details matter here:
 *  - Use `displayedName` (e.g. "Code"), not the process `name`: many apps (VS Code, Slack,
 *    Teams, this app in dev) are Electron apps whose executable is literally named "Electron".
 *  - Ask for the *focused* window (AXFocusedWindow), falling back to the main window. Do not
 *    use `windows[0]`: apps like VS Code keep invisible helper windows (subrole AXUnknown,
 *    empty title) ahead of the real one.
 *
 * titleStatus: 'ok' (title read, possibly legitimately empty), 'none' (app has no window,
 * e.g. Finder on the desktop), 'denied' (windows unreadable: Accessibility not granted).
 */
export const FRONT_WINDOW_JXA = `
const se = Application('System Events');
const p = se.processes.whose({ frontmost: true })[0];
const out = { appName: '', processName: p.name(), pid: p.unixId(), title: '', titleStatus: 'ok' };
try { out.appName = p.displayedName() || ''; } catch (e) {}
try {
  let w = null;
  try { w = p.attributes.byName('AXFocusedWindow').value(); } catch (e) {}
  if (!w) {
    w = p.windows().find((x) => {
      try { return x.attributes.byName('AXMain').value() === true; } catch (e) { return false; }
    }) || null;
  }
  if (w) out.title = w.name() || ''; else out.titleStatus = 'none';
} catch (e) {
  out.titleStatus = 'denied';
}
JSON.stringify(out);
`;

const FrontWindowSchema = z.object({
  appName: z.string(),
  processName: z.string(),
  pid: z.number().int(),
  title: z.string(),
  titleStatus: z.enum(['ok', 'none', 'denied']),
});
export type FrontWindowInfo = z.infer<typeof FrontWindowSchema>;

export const ACCESSIBILITY_WARNING =
  'Window titles unavailable. Grant Accessibility permission in System Settings → Privacy & Security → Accessibility.';

export function parseFrontWindow(stdout: string): FrontWindowInfo {
  return FrontWindowSchema.parse(JSON.parse(stdout.trim()));
}

/** Converts System Events output to a snapshot, naming this app's own windows clearly. */
export function toSnapshot(
  info: FrontWindowInfo,
  ctx: { timestamp: string; idleSeconds: number; selfPid: number; selfName: string },
): ActivitySnapshot {
  const isSelf = info.pid === ctx.selfPid;
  return {
    timestamp: ctx.timestamp,
    application: isSelf ? ctx.selfName : info.appName || info.processName,
    processName: info.processName,
    processId: info.pid,
    windowTitle: info.title,
    idleSeconds: ctx.idleSeconds,
  };
}

export interface MacOSCaptureDeps {
  getIdleSeconds: () => number;
  isLocked: () => boolean;
  /** This app's main-process pid and display name, so its own windows aren't labelled "Electron". */
  selfPid: number;
  selfName: string;
}

/**
 * macOS adapter.
 * - App and window: System Events (needs Automation → System Events; titles need Accessibility).
 *   Falls back to `lsappinfo` (no permission) for the app name if System Events is unavailable.
 * - Idle/lock: Electron powerMonitor (no permission required).
 * Browser URLs are intentionally not scraped; see docs/architecture.md.
 */
export class MacOSActivityCapture implements ActivityCapture {
  readonly source: CaptureSource = 'macos';
  private warning: string | null = null;

  constructor(private readonly deps: MacOSCaptureDeps) {}

  async start(): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('macOS capture is only available on macOS');
  }

  async stop(): Promise<void> {}

  getWarning(): string | null {
    return this.warning;
  }

  async getCurrentActivity(): Promise<ActivitySnapshot | null> {
    const timestamp = new Date().toISOString();
    const idleSeconds = this.deps.getIdleSeconds();
    if (this.deps.isLocked()) {
      return { timestamp, application: '', windowTitle: '', idleSeconds, locked: true };
    }
    try {
      const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', FRONT_WINDOW_JXA], {
        timeout: 3000,
      });
      const info = parseFrontWindow(stdout);
      this.warning = info.titleStatus === 'denied' ? ACCESSIBILITY_WARNING : null;
      return toSnapshot(info, { timestamp, idleSeconds, ...this.deps });
    } catch {
      const app = await this.frontAppNameWithoutPermissions();
      this.warning =
        'Cannot read the active window. Allow Billable to control System Events (System Settings → Privacy & Security → Automation) and grant Accessibility.';
      return app ? { timestamp, application: app, windowTitle: '', idleSeconds } : null;
    }
  }

  private async frontAppNameWithoutPermissions(): Promise<string | null> {
    try {
      const { stdout: asn } = await run('lsappinfo', ['front'], { timeout: 2000 });
      const { stdout } = await run('lsappinfo', ['info', '-only', 'name', asn.trim()], {
        timeout: 2000,
      });
      return /"(?:LSDisplayName|name)"="([^"]*)"/.exec(stdout)?.[1] ?? null;
    } catch {
      return null;
    }
  }
}
