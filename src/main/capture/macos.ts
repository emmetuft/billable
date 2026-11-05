import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActivityCapture, ActivitySnapshot } from '../../core/capture/types';
import type { CaptureSource } from '../../shared/types';

const run = promisify(execFile);

/**
 * Reads the frontmost window title via System Events (JXA). Requires the user to grant
 * Accessibility permission (and Automation -> System Events on first use).
 * Reads metadata only: process name, pid, and front window title. No content, no keystrokes.
 */
const FRONT_WINDOW_JXA = `
const se = Application('System Events');
const p = se.processes.whose({ frontmost: true })[0];
let title = '';
try { title = p.windows[0].name() || ''; } catch (e) {}
JSON.stringify({ name: p.name(), pid: p.unixId(), title: title });
`;

export interface MacOSCaptureDeps {
  getIdleSeconds: () => number;
  isLocked: () => boolean;
}

/**
 * macOS adapter for local development.
 * - App name: `lsappinfo` (no permission required).
 * - Window title: System Events (Accessibility permission); degrades to app-name-only if denied.
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
      const info = JSON.parse(stdout.trim()) as { name: string; pid: number; title: string };
      this.warning = null;
      return {
        timestamp,
        application: info.name,
        processId: info.pid,
        windowTitle: info.title,
        idleSeconds,
      };
    } catch {
      const app = await this.frontAppNameWithoutPermissions();
      this.warning =
        'Window titles unavailable. Grant Accessibility permission in System Settings → Privacy & Security → Accessibility.';
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
