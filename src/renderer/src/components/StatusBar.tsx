import type { Matter, MonitorStatus } from '../../../shared/types';
import { formatTime } from '../format';

const api = window.timekeeper;
const LABEL = { running: 'Monitoring on', paused: 'Paused', stopped: 'Stopped' } as const;

/** Always-visible monitoring indicator and controls. */
export function StatusBar({ status, matters }: { status: MonitorStatus; matters: Matter[] }) {
  const cur = status.current;
  return (
    <section className={`statusbar state-${status.state}`} aria-live="polite">
      <span className="dot" aria-hidden />
      <strong>{LABEL[status.state]}</strong>
      <span className="pill">{status.source === 'mock' ? 'Mock capture' : status.source}</span>
      <span className="current" title={cur ? `${cur.application} ${cur.windowTitle}` : ''}>
        {cur
          ? `${cur.application}${cur.kind === 'active' && cur.windowTitle ? ` — ${cur.windowTitle}` : ''} · since ${formatTime(cur.startedAt)}`
          : status.state === 'running'
            ? 'Waiting for first observation…'
            : 'Not recording'}
      </span>
      <label className="matter-select">
        Active matter
        <select
          value={status.activeMatterId ?? ''}
          onChange={(e) => void api.setActiveMatter(e.target.value || null)}
        >
          <option value="">None (needs review later)</option>
          {matters.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      {status.state === 'running' ? (
        <button onClick={() => void api.pause()}>Pause</button>
      ) : (
        <button className="primary" onClick={() => void api.resume()}>
          {status.state === 'paused' ? 'Resume' : 'Start'}
        </button>
      )}
      {status.warning && <div className="warning">⚠ {status.warning}</div>}
    </section>
  );
}
