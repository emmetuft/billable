import { join } from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { MonitorStatus } from '../shared/types';
import type { CaptureService } from './capture/service';
import type { Repository } from './db/repository';

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function icon(state: MonitorStatus['state']) {
  const dir = join(app.getAppPath(), 'resources');
  const recording = state === 'running';
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(
      join(dir, recording ? 'trayRecordingTemplate.png' : 'trayPausedTemplate.png'),
    );
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(
    join(dir, recording ? 'tray-recording.png' : 'tray-paused.png'),
  );
}

/** Menu-bar / system-tray control. Monitoring state is always visible here. */
export function createTray(
  capture: CaptureService,
  repo: Repository,
  actions: { openWindow: () => void; quit: () => void },
): Tray {
  const tray = new Tray(icon('stopped'));

  const render = (status: MonitorStatus) => {
    const label = {
      running: 'Monitoring ON',
      paused: 'Monitoring PAUSED',
      stopped: 'Monitoring OFF',
    }[status.state];
    const matters = repo.listMatters();
    const activeMatter = matters.find((m) => m.id === status.activeMatterId);
    const current = status.current
      ? status.current.kind === 'active'
        ? `${status.current.application}${status.current.windowTitle ? ` — ${status.current.windowTitle}` : ''}`
        : status.current.application
      : '—';

    tray.setImage(icon(status.state));
    tray.setToolTip(`Billable — ${label}`);
    if (process.platform === 'darwin')
      tray.setTitle(status.state === 'running' ? ' REC' : ' Paused');

    const template: MenuItemConstructorOptions[] = [
      { label: `${label}`, enabled: false },
      { label: `Now: ${truncate(current, 60)}`, enabled: false },
      {
        label: `Matter: ${activeMatter ? truncate(activeMatter.displayName, 50) : 'None selected'}`,
        enabled: false,
      },
      ...(status.warning ? [{ label: `⚠ ${truncate(status.warning, 70)}`, enabled: false }] : []),
      { type: 'separator' },
      status.state === 'running'
        ? { label: 'Pause monitoring', click: () => void capture.pause() }
        : { label: 'Resume monitoring', click: () => void capture.resume() },
      {
        label: 'Active matter',
        submenu: [
          {
            label: 'None',
            type: 'radio',
            checked: !activeMatter,
            click: () => void capture.setActiveMatter(null),
          },
          { type: 'separator' },
          ...matters.map((m): MenuItemConstructorOptions => ({
            label: truncate(m.displayName, 60),
            type: 'radio',
            checked: m.id === activeMatter?.id,
            click: () => void capture.setActiveMatter(m.id),
          })),
        ],
      },
      { type: 'separator' },
      { label: 'Open daily review…', click: actions.openWindow },
      { label: 'Quit Billable', click: actions.quit },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  capture.on('status', render);
  render(capture.status());
  return tray;
}
