import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { localDayRange, toLocalIsoDate } from '../../../core/time';
import type {
  ActivityEvent,
  DayView,
  Matter,
  MonitorStatus,
  SessionCorrection,
  WorkSession,
} from '../../../shared/types';
import { errorMessage, formatDuration, formatHours, formatTime } from '../format';

const api = window.timekeeper;

export function shiftDate(iso: string, days: number) {
  const { startMs } = localDayRange(iso);
  const d = new Date(startMs);
  d.setDate(d.getDate() + days);
  return toLocalIsoDate(d.getTime());
}

/** Shared day navigation for the timeline and review pages. */
export function DayNav({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  return (
    <>
      <button onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
        ←
      </button>
      <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      <button onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
        →
      </button>
      <button onClick={() => setDate(toLocalIsoDate(Date.now()))}>Today</button>
    </>
  );
}

export function TimelinePage({
  date,
  setDate,
  matters,
  status,
  onMattersChanged,
}: {
  date: string;
  setDate: (d: string) => void;
  matters: Matter[];
  status: MonitorStatus | null;
  onMattersChanged: () => void;
}) {
  const [day, setDay] = useState<DayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => localDayRange(date), [date]);
  const matterName = useCallback(
    (id: string | null) =>
      id ? (matters.find((m) => m.id === id)?.displayName ?? 'Unknown matter') : null,
    [matters],
  );

  const load = useCallback(async () => {
    try {
      setDay(await api.getDay(range));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [range]);

  // Reload on navigation and whenever capture reports progress.
  useEffect(() => {
    let cancelled = false;
    api.getDay(range).then(
      (d) => !cancelled && (setDay(d), setError(null)),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [range, status]);

  const generateSample = async () => {
    try {
      await api.generateSampleDay(range.startMs + (8 * 60 + 52) * 60_000);
      onMattersChanged();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  /** Runs a correction, then reloads the day; errors surface in the banner. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await load();
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [load],
  );

  const deleteDay = async () => {
    if (!confirm(`Delete all captured activity that started on ${date}? This cannot be undone.`))
      return;
    await api.deleteActivity(range);
    await load();
  };

  return (
    <div className="page">
      <div className="toolbar">
        <DayNav date={date} setDate={setDate} />
        <span className="spacer" />
        <button
          onClick={generateSample}
          title="Writes a fictional, clearly-labelled sample workday"
        >
          Generate sample day
        </button>
        {day && day.events.length > 0 && (
          <button className="danger" onClick={deleteDay}>
            Delete day
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {day?.containsMockData && (
        <div className="banner mock">
          This day contains <strong>mock activity</strong> generated for development. It does not
          reflect real work.
        </div>
      )}

      {day && day.events.length === 0 && (
        <div className="empty">
          <p>No activity recorded for this day.</p>
          <p className="muted">
            Start monitoring from the bar above, or use <em>Generate sample day</em> to explore the
            workflow with fictional data.
          </p>
        </div>
      )}

      {day && day.events.length > 0 && (
        <>
          <Summary day={day} matterName={matterName} />
          <DayStrip day={day} />
          <SessionList day={day} matters={matters} matterName={matterName} act={act} />
        </>
      )}
    </div>
  );
}

function Summary({
  day,
  matterName,
}: {
  day: DayView;
  matterName: (id: string | null) => string | null;
}) {
  const t = day.totals;
  return (
    <>
      <div className="cards">
        <Card label="Observed active time" value={formatDuration(t.activeMs)} />
        <Card label="Idle" value={formatDuration(t.idleMs)} />
        <Card label="Excluded (private)" value={formatDuration(t.excludedMs)} />
        <Card
          label="Active, no matter"
          value={formatDuration(t.unassignedActiveMs)}
          tone={t.unassignedActiveMs > 0 ? 'warn' : undefined}
        />
      </div>
      {day.matterBilling.length > 0 && (
        <table className="billing">
          <thead>
            <tr>
              <th>Matter</th>
              <th className="num">Actual</th>
              <th className="num">Billed (preview)</th>
              <th>How it was calculated</th>
            </tr>
          </thead>
          <tbody>
            {day.matterBilling.map((b) => (
              <tr key={b.matterId}>
                <td>{matterName(b.matterId)}</td>
                <td className="num">{formatDuration(b.calculation.actualMs)}</td>
                <td className="num">
                  <strong>{formatHours(b.calculation.billedMinutes)} h</strong>{' '}
                  <span className="muted">({b.calculation.billedMinutes} min)</span>
                </td>
                <td className="muted small">{b.calculation.trace.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Billed figures are a deterministic preview under the configured policy. Nothing is final
        until reviewed and approved; unassigned time is never billed.
      </p>
    </>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`card ${tone ?? ''}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}

/** Proportional strip of the day's events: active (by matter), idle, excluded, and gaps. */
function DayStrip({ day }: { day: DayView }) {
  const first = day.events[0]!.startedAt;
  const last = Math.max(...day.events.map((e) => e.endedAt));
  const span = Math.max(last - first, 1);
  const sessionOf = new Map(day.sessions.flatMap((s) => s.eventIds.map((id) => [id, s] as const)));
  return (
    <div className="strip-wrap">
      <div className="strip" role="img" aria-label="Day overview">
        {day.events.map((e) => {
          const s = sessionOf.get(e.id);
          const cls = e.kind !== 'active' ? e.kind : s?.matterId ? 'assigned' : 'unassigned';
          return (
            <span
              key={e.id}
              className={`seg ${cls}`}
              style={{
                left: `${((e.startedAt - first) / span) * 100}%`,
                width: `${((e.endedAt - e.startedAt) / span) * 100}%`,
              }}
              title={`${formatTime(e.startedAt)}–${formatTime(e.endedAt)} ${e.application}`}
            />
          );
        })}
      </div>
      <div className="strip-legend muted small">
        <span>{formatTime(first)}</span>
        <span>
          <i className="seg assigned" /> matter assigned <i className="seg unassigned" /> no matter{' '}
          <i className="seg idle" /> idle <i className="seg excluded" /> excluded · blank = not
          recorded
        </span>
        <span>{formatTime(last)}</span>
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;
type MatterName = (id: string | null) => string | null;

function SessionList({
  day,
  matters,
  matterName,
  act,
}: {
  day: DayView;
  matters: Matter[];
  matterName: MatterName;
  act: Act;
}) {
  const billing = new Map(day.sessionBilling.map((b) => [b.sessionId, b.calculation]));
  const corrections = new Map(day.corrections.map((c) => [c.id, c]));
  const rows: ReactNode[] = [];
  day.sessions.forEach((s, i) => {
    const prev = day.sessions[i - 1];
    if (prev) {
      rows.push(
        <BoundaryRow
          key={`b-${s.id}`}
          prev={prev}
          next={s}
          events={day.events.filter((e) => e.startedAt >= prev.endedAt && e.endedAt <= s.startedAt)}
          matterName={matterName}
          act={act}
        />,
      );
    }
    rows.push(
      <SessionCard
        key={s.id}
        session={s}
        matters={matters}
        matterName={matterName}
        billedMinutes={billing.get(s.id)?.billedMinutes ?? null}
        events={day.events.filter((e) => e.startedAt >= s.startedAt && e.endedAt <= s.endedAt)}
        corrections={s.correctionIds.flatMap((id) => corrections.get(id) ?? [])}
        act={act}
      />,
    );
  });
  return <div className="sessions">{rows}</div>;
}

const REASON: Record<WorkSession['startReason'], string> = {
  first: '',
  matter_change: 'Matter changed',
  gap: 'No active work',
  manual_split: 'Split manually',
};

/** The boundary between two sessions: why the split happened, what filled the gap, and merge. */
function BoundaryRow({
  prev,
  next,
  events,
  matterName,
  act,
}: {
  prev: WorkSession;
  next: WorkSession;
  events: ActivityEvent[];
  matterName: MatterName;
  act: Act;
}) {
  const from = prev.endedAt;
  const to = next.startedAt;
  const sum = (k: string) =>
    events.filter((e) => e.kind === k).reduce((n, e) => n + e.endedAt - e.startedAt, 0);
  const idle = sum('idle');
  const excluded = sum('excluded');
  const unrecorded = to - from - idle - excluded;
  const parts = [
    idle > 0 && `idle ${formatDuration(idle)}`,
    excluded > 0 && `excluded ${formatDuration(excluded)}`,
    unrecorded > 30_000 && `not recorded ${formatDuration(unrecorded)}`,
  ].filter(Boolean);

  // Merged sessions must keep one matter. Offer the choices that make sense.
  const choices: (string | null)[] =
    prev.matterId === next.matterId
      ? [prev.matterId]
      : prev.matterId && next.matterId
        ? [prev.matterId, next.matterId]
        : [prev.matterId ?? next.matterId];
  const merge = (matterId: string | null) => act(() => api.mergeSessions(prev, next, matterId));

  return (
    <div className="boundary">
      <span className="why">
        {REASON[next.startReason]}
        {to - from >= 60_000 && (
          <>
            {' · '}
            {formatTime(from)}–{formatTime(to)}
            {parts.length > 0 && ` · ${parts.join(' · ')}`}
          </>
        )}
      </span>
      {choices.length === 1 ? (
        <button className="link" onClick={() => merge(choices[0]!)}>
          Merge
          {prev.matterId !== next.matterId && ` into ${matterName(choices[0]!) ?? 'no matter'}`}
        </button>
      ) : (
        <span className="merge-choice">
          Merge into:
          {choices.map((m) => (
            <button key={m} className="link" onClick={() => merge(m)}>
              {matterName(m)}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

function describeCorrection(c: SessionCorrection, matterName: MatterName): string {
  switch (c.kind) {
    case 'assign_matter':
      return `Matter set to ${matterName(c.matterId) ?? 'none'} in review`;
    case 'split':
      return `Split at ${formatTime(c.startedAt)}`;
    case 'join':
      return `Merged across ${formatTime(c.startedAt)}–${formatTime(c.endedAt ?? c.startedAt)}`;
    case 'note':
      return 'Note added';
  }
}

function SessionCard({
  session: s,
  matters,
  matterName,
  billedMinutes,
  events,
  corrections,
  act,
}: {
  session: WorkSession;
  matters: Matter[];
  matterName: MatterName;
  billedMinutes: number | null;
  events: ActivityEvent[];
  corrections: SessionCorrection[];
  act: Act;
}) {
  const [open, setOpen] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const span = { startedAt: s.startedAt, endedAt: s.endedAt };
  const firstActiveId = s.eventIds[0];
  const assignable = matters.filter((m) => !m.archivedAt || m.id === s.matterId);

  return (
    <article className={`session ${s.status === 'needs_review' ? 'needs-review' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <div className="time">
          {formatTime(s.startedAt)} – {formatTime(s.endedAt)}
        </div>
        <div className="matter" onClick={(e) => e.stopPropagation()}>
          <select
            className={s.matterId ? '' : 'unassigned'}
            value={s.matterId ?? ''}
            aria-label="Matter for this session"
            onChange={(e) => act(() => api.reassignSession(span, e.target.value || null))}
          >
            <option value="">Needs matter</option>
            {assignable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          {s.matterSource !== 'none' && (
            <span className="source muted small">
              {s.matterSource === 'corrected' ? 'set in review' : 'selected while working'}
            </span>
          )}
        </div>
        <div className="durations">
          <span title="Observed active time">{formatDuration(s.activeMs)} active</span>
          {s.untrackedMs > 30_000 && (
            <span
              className="muted"
              title="Idle, excluded or unrecorded time inside this session (not counted)"
            >
              {' '}
              + {formatDuration(s.untrackedMs)} not counted
            </span>
          )}
        </div>
        <div className="billed">
          {billedMinutes !== null ? `${formatHours(billedMinutes)} h` : '—'}
        </div>
        <div className="chev">{open ? '▾' : '▸'}</div>
      </header>
      <div className="apps">
        {s.applications.slice(0, 5).map((a) => (
          <span key={a.name} className="chip">
            {a.name} · {formatDuration(a.ms)}
          </span>
        ))}
      </div>
      {s.note && draftNote === null && (
        <p className="note" onClick={() => setDraftNote(s.note ?? '')}>
          “{s.note}”
        </p>
      )}

      {open && (
        <div className="session-detail">
          <table className="events">
            <thead>
              <tr>
                <th>Time</th>
                <th>Duration</th>
                <th>Application</th>
                <th>Window title (evidence)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className={`kind-${e.kind}`}>
                  <td>{formatTime(e.startedAt)}</td>
                  <td>{formatDuration(e.endedAt - e.startedAt)}</td>
                  <td>{e.application}</td>
                  <td className="title-cell">
                    {e.kind === 'active' ? (
                      e.windowTitle || <span className="muted">(no title)</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="row-action">
                    {e.kind === 'active' && e.id !== firstActiveId && (
                      <button
                        className="link"
                        title="Start a new session at this activity"
                        onClick={() => act(() => api.splitSession(e.startedAt))}
                      >
                        Split here
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="detail-footer">
            {draftNote === null ? (
              <button onClick={() => setDraftNote(s.note ?? '')}>
                {s.note ? 'Edit note' : 'Add note'}
              </button>
            ) : null}
            {corrections.length > 0 && (
              <ul className="corrections">
                {corrections.map((c) => (
                  <li key={c.id}>
                    {describeCorrection(c, matterName)}{' '}
                    <button className="link" onClick={() => act(() => api.undoCorrection(c.id))}>
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {draftNote !== null && (
        <form
          className="note-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.setSessionNote(span, draftNote)).then(() => setDraftNote(null));
          }}
        >
          <textarea
            autoFocus
            rows={2}
            maxLength={2000}
            value={draftNote}
            placeholder="What was this work? Your words are kept locally and take priority over any AI draft."
            onChange={(e) => setDraftNote(e.target.value)}
          />
          <div>
            <button className="primary" type="submit">
              Save note
            </button>
            <button type="button" onClick={() => setDraftNote(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
