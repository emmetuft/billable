import { join } from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, shell, type IpcMainInvokeEvent } from 'electron';
import type { ActivityCapture } from '../core/capture/types';
import { IPC } from '../shared/ipc';
import type { Settings } from '../shared/types';
import { MacOSActivityCapture } from './capture/macos';
import { CaptureService } from './capture/service';
import { WindowsActivityCapture } from './capture/windows';
import { openDatabase, Repository } from './db/repository';
import { registerIpc } from './ipc';
import { createTray } from './tray';

// Everything the app writes (database, caches, logs) is private to the current user.
process.umask(0o077);

// Optional isolated data directory (development, testing, demos).
if (process.env.BILLABLE_DATA_DIR) app.setPath('userData', process.env.BILLABLE_DATA_DIR);

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function createAdapter(settings: Settings): ActivityCapture {
  switch (settings.captureSource) {
    case 'macos':
      return new MacOSActivityCapture({
        getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
        isLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
        selfPid: process.pid,
        selfName: 'Billable',
      });
    case 'windows':
      return new WindowsActivityCapture();
  }
}

function rendererUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : null;
}

function openWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: 'Billable',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // No in-app navigation or popups; external links open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = rendererUrl();
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  const devUrl = rendererUrl();
  return url.startsWith('file://') || (devUrl !== null && url.startsWith(devUrl));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openWindow);

  void app.whenReady().then(async () => {
    const dbPath = join(app.getPath('userData'), 'billable.sqlite3');
    let repo: Repository;
    try {
      repo = new Repository(openDatabase(dbPath));
    } catch (err) {
      // Without a database the app can't do anything useful; say why instead of idling invisibly.
      dialog.showErrorBox(
        'Billable could not open its database',
        `${err instanceof Error ? err.message : String(err)}\n\nDatabase: ${dbPath}`,
      );
      app.exit(1);
      return;
    }

    // Never carry a matter selection across restarts: avoids silent misattribution.
    if (repo.openMatterPeriod()) repo.setActiveMatter(null);
    const { retentionDays } = repo.getSettings();
    if (retentionDays > 0) repo.purgeOlderThan(Date.now() - retentionDays * 86_400_000);

    const capture = new CaptureService(repo, createAdapter);
    capture.on('status', (status) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send(IPC.statusChanged, status);
    });

    registerIpc(repo, capture, isTrustedSender);
    createTray(capture, repo, { openWindow, quit: () => app.quit() });

    for (const evt of ['suspend', 'lock-screen', 'shutdown'] as const) {
      powerMonitor.on(evt as 'suspend', () => capture.interrupt());
    }

    let finalized = false;
    const finalize = (reason: string) => {
      if (finalized) return;
      finalized = true;
      capture.interrupt();
      repo.setActiveMatter(null);
      repo.audit('app_quit', 'app', null, { reason });
      repo.db.close();
    };

    // Normal quit (tray menu, Cmd+Q, OS logout): record a final observation first.
    app.on('before-quit', (e) => {
      if (quitting) return;
      e.preventDefault();
      quitting = true;
      void capture.stop().finally(() => {
        finalize('quit');
        app.quit();
      });
    });

    // Termination signals (IT tooling, `kill`, Ctrl+C in dev). Chromium also reacts to SIGTERM by
    // closing windows, which races an async quit and left the app alive in the tray. So: clean up
    // synchronously and exit. At most one poll interval of the current activity is lost.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        quitting = true;
        finalize(signal);
        app.exit(0);
      });
    }

    openWindow();
    if (repo.getSettings().startMonitoringOnLaunch) await capture.start();
  });

  // Keep running in the tray when the window is closed; quit only from the tray menu.
  app.on('window-all-closed', () => {});

  app.on('activate', openWindow);
}
