import { useCallback, useEffect, useState } from 'react';
import type { Matter, MonitorStatus } from '../../shared/types';
import { StatusBar } from './components/StatusBar';
import { toLocalIsoDate } from '../../core/time';
import { EntriesPage } from './pages/EntriesPage';
import { MattersPage } from './pages/MattersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TimelinePage } from './pages/TimelinePage';

type Page = 'timeline' | 'entries' | 'matters' | 'settings';
const LABELS: Record<Page, string> = {
  timeline: 'Daily timeline',
  entries: 'Review entries',
  matters: 'Matters',
  settings: 'Settings',
};
const api = window.timekeeper;

export function App() {
  const [page, setPage] = useState<Page>('timeline');
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [matters, setMatters] = useState<Matter[]>([]);
  const [date, setDate] = useState(() => toLocalIsoDate(Date.now()));

  const refreshMatters = useCallback(async () => setMatters(await api.listMatters(true)), []);

  useEffect(() => {
    void api.getStatus().then(setStatus);
    void api.listMatters(true).then(setMatters);
    return api.onStatus(setStatus);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">AI Timekeeper</div>
        <nav>
          {(Object.keys(LABELS) as Page[]).map((p) => (
            <button
              key={p}
              className={page === p ? 'tab active' : 'tab'}
              onClick={() => setPage(p)}
            >
              {LABELS[p]}
            </button>
          ))}
        </nav>
      </header>
      {status && <StatusBar status={status} matters={matters.filter((m) => !m.archivedAt)} />}
      <main>
        {page === 'timeline' && (
          <TimelinePage date={date} setDate={setDate} matters={matters} status={status} />
        )}
        {page === 'entries' && <EntriesPage date={date} setDate={setDate} matters={matters} />}
        {page === 'matters' && (
          <MattersPage matters={matters} status={status} onChanged={refreshMatters} />
        )}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
