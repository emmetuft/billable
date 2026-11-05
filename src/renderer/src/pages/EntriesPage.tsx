import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { decimalHours } from '../../../core/entries/clipboard';
import { localDayRange } from '../../../core/time';
import type {
  EntriesDay,
  EntryHistoryItem,
  EntryView,
  Matter,
  Settings,
} from '../../../shared/types';
import { errorMessage, formatDuration, formatTime } from '../format';
import { DayNav } from './TimelinePage';

const api = window.timekeeper;
type Act = (fn: () => Promise<unknown>) => Promise<boolean>;

const STATUS_LABEL: Record<EntryView['status'], string> = {
  draft: 'Draft',
  approved: 'Approved',
  copied: 'Copied',
  exported: 'Exported',
  rejected: 'Rejected',
};

export function EntriesPage({
  date,
  setDate,
  matters,
}: {
  date: string;
  setDate: (d: string) => void;
  matters: Matter[];
}) {
  const [day, setDay] = useState<EntriesDay | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<{
    text: string;
    count: number;
    billedMinutes: number;
  } | null>(null);
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async () => {
    setDay(await api.listEntries(date));
  }, [date]);

  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((s) => !cancelled && setSettings(s));
    api.listEntries(date).then(
      (d) => !cancelled && (setDay(d), setError(null), setCopied(null)),
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [date]);

  const act: Act = useCallback(
    async (fn) => {
      try {
        await fn();
        await load();
        setError(null);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        await load().catch(() => {});
        return false;
      }
    },
    [load],
  );

  const copy = async (ids: string[]) => {
    try {
      setCopied(await api.copyEntries(ids));
      setError(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!day || !settings) return error ? <div className="banner error">{error}</div> : null;

  const live = day.entries.filter((e) => e.status !== 'rejected');
  const toCopy = day.entries.filter((e) => e.status === 'approved');
  const sumBilled = (list: EntryView[]) =>
    list.filter((e) => e.billable).reduce((n, e) => n + e.calculation.billedMinutes, 0);
  const finalized = live.filter((e) => e.status !== 'draft');
  const drafts = live.filter((e) => e.status === 'draft');
  const overlapping = drafts.filter((e) => e.flags.some((f) => f.code === 'overlap')).length;
  const nameOf = (id: string | null) => matters.find((m) => m.id === id)?.displayName ?? null;

  return (
    <div className="page entries-page">
      <div className="toolbar">
        <DayNav date={date} setDate={setDate} />
        <span className="spacer" />
        <button onClick={() => setShowManual(!showManual)}>Add manual entry</button>
        <button
          className="primary"
          disabled={toCopy.length === 0}
          onClick={() => copy(toCopy.map((e) => e.id))}
          title="Copies approved entries that have not been copied yet"
        >
          Copy approved ({toCopy.length})
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {copied && (
        <div className="banner copied">
          <div className="copied-head">
            <strong>
              Copied {copied.count} {copied.count === 1 ? 'entry' : 'entries'} (
              {decimalHours(copied.billedMinutes)} billable h) to the clipboard.
            </strong>{' '}
            Paste into your billing system. Columns: Date · Client · Matter · Hours · Billable ·
            Narrative.
            <button className="link" onClick={() => setCopied(null)}>
              Dismiss
            </button>
          </div>
          <pre>{copied.text.replaceAll('\t', '  →  ')}</pre>
        </div>
      )}

      {day.uncoveredActiveMs > 0 && (
        <div className="banner info">
          {formatDuration(day.uncoveredActiveMs)} of assigned work on the timeline has no entry yet.{' '}
          <button className="primary" onClick={() => act(() => api.generateDrafts(date))}>
            Create drafts
          </button>
        </div>
      )}
      {day.unassignedActiveMs > 0 && (
        <div className="banner warn-banner">
          {formatDuration(day.unassignedActiveMs)} of activity has no matter. Assign it on the Daily
          timeline before it can become an entry.
        </div>
      )}

      <div className="cards">
        <Stat
          label="Drafts"
          value={`${drafts.length}`}
          sub={`${decimalHours(sumBilled(drafts))} h`}
        />
        <Stat
          label="Approved / copied"
          value={`${finalized.length}`}
          sub={`${decimalHours(sumBilled(finalized))} h`}
        />
        <Stat
          label="Blocked drafts"
          value={`${drafts.filter((e) => e.flags.some((f) => f.severity === 'block')).length}`}
          sub="need attention"
        />
        <Stat
          label="Day total (billable)"
          value={`${decimalHours(sumBilled(live))} h`}
          sub={
            overlapping > 0
              ? `includes ${overlapping} overlapping ${overlapping === 1 ? 'entry' : 'entries'} — resolve before relying on this`
              : `${formatDuration(live.reduce((n, e) => n + e.actualMs, 0))} actual`
          }
          tone={overlapping > 0 ? 'warn' : undefined}
        />
      </div>

      {showManual && (
        <ManualEntryForm
          date={date}
          matters={matters.filter((m) => !m.archivedAt)}
          onDone={async (ok) => {
            if (ok) setShowManual(false);
          }}
          act={act}
        />
      )}

      {day.entries.length === 0 && day.uncoveredActiveMs === 0 && (
        <div className="empty">
          <p>No entries for this day.</p>
          <p className="muted">
            Drafts are created from timeline sessions that have a matter. Add a manual entry for
            work done away from the computer.
          </p>
        </div>
      )}

      <div className="entries">
        {day.entries.map((e) => (
          <EntryCard
            key={e.id}
            entry={e}
            matterName={nameOf(e.matterId)}
            matters={matters}
            settings={settings}
            act={act}
            copy={copy}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn';
}) {
  return (
    <div className={`card ${tone ?? ''}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

function EntryCard({
  entry: e,
  matterName,
  matters,
  settings,
  act,
  copy,
}: {
  entry: EntryView;
  matterName: string | null;
  matters: Matter[];
  settings: Settings;
  act: Act;
  copy: (ids: string[]) => Promise<void>;
}) {
  const isDraft = e.status === 'draft';
  const [text, setText] = useState(e.description);
  const [saved, setSaved] = useState(e.description);
  const [adjusting, setAdjusting] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [history, setHistory] = useState<EntryHistoryItem[] | null>(null);
  const dirty = text !== saved;
  const blocks = e.flags.filter((f) => f.severity === 'block');
  const inc = settings.billingPolicy.incrementMinutes;

  // Keep the editor in sync when the server copy changes (refresh, reopen) and nothing is pending.
  if (!dirty && saved !== e.description) {
    setText(e.description);
    setSaved(e.description);
  }

  const saveText = async () => {
    if (!dirty) return true;
    const ok = await act(() => api.updateEntry(e.id, { description: text }));
    if (ok) setSaved(text);
    return ok;
  };

  const approve = async () => {
    if (await saveText()) await act(() => api.approveEntry(e.id));
  };

  const toggleHistory = async () => {
    setHistory(history ? null : await api.entryHistory(e.id));
  };

  const when =
    e.startAt !== null
      ? `${formatTime(e.startAt)} – ${formatTime(e.endAt ?? e.startAt)}`
      : 'No start time';

  return (
    <article className={`entry status-${e.status} ${blocks.length && isDraft ? 'blocked' : ''}`}>
      <header>
        <span className={`badge st-${e.status}`}>{STATUS_LABEL[e.status]}</span>
        <div className="entry-matter">
          {e.source === 'manual' && isDraft ? (
            <select
              value={e.matterId ?? ''}
              aria-label="Matter"
              onChange={(ev) =>
                act(() => api.updateEntry(e.id, { matterId: ev.target.value || null }))
              }
            >
              {matters
                .filter((m) => !m.archivedAt || m.id === e.matterId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
            </select>
          ) : (
            <strong>{matterName ?? 'No matter'}</strong>
          )}
          <span className="muted small">
            {e.source === 'manual' ? 'Manual · ' : ''}
            {when}
          </span>
        </div>
        <div className="entry-time">
          <span className="muted small">Actual</span> {formatDuration(e.actualMs)}
          <span className="arrow">→</span>
          <span className="muted small">Billed</span>{' '}
          <strong className={e.billable ? '' : 'nb'}>
            {decimalHours(e.calculation.billedMinutes)} h
          </strong>
          {!e.billable && <span className="badge">Nonbillable</span>}
        </div>
      </header>

      {e.flags.length > 0 && (
        <ul className="flags">
          {e.flags.map((f, i) => (
            <li key={i} className={f.severity}>
              {f.severity === 'block' ? '⛔' : '⚠'} {f.message}
            </li>
          ))}
        </ul>
      )}

      <div className="narrative">
        {isDraft ? (
          <textarea
            rows={2}
            value={text}
            maxLength={4000}
            placeholder="Billing narrative. Describe the work actually performed; the evidence below shows only which windows were open."
            onChange={(ev) => setText(ev.target.value)}
            onBlur={() => void saveText()}
          />
        ) : (
          <p>{e.description}</p>
        )}
        {isDraft && <span className="muted small save-state">{dirty ? 'Unsaved' : ''}</span>}
      </div>

      {e.sessionNotes.length > 0 && isDraft && text.trim() === '' && (
        <p className="muted small">Your timeline notes: “{e.sessionNotes.join('; ')}”</p>
      )}

      <p className="trace muted small">{e.calculation.trace.join(' · ')}</p>

      {adjusting && isDraft && (
        <AdjustForm entry={e} inc={inc} act={act} onDone={() => setAdjusting(false)} />
      )}

      <footer>
        {isDraft && (
          <>
            <button
              className="primary"
              disabled={blocks.length > 0 && !dirty}
              title={blocks.map((b) => b.message).join('\n')}
              onClick={approve}
            >
              Approve
            </button>
            {e.sync === 'changed' && (
              <button onClick={() => act(() => api.refreshEntry(e.id))}>
                Refresh from timeline
              </button>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={!e.billable}
                onChange={(ev) =>
                  act(() => api.updateEntry(e.id, { billable: !ev.target.checked }))
                }
              />
              Nonbillable
            </label>
            {!adjusting && (
              <button className="link" onClick={() => setAdjusting(true)}>
                {e.billedOverrideMinutes !== null ? 'Change adjustment' : 'Adjust billed time'}
              </button>
            )}
            <span className="spacer" />
            {e.source === 'captured' ? (
              <button
                className="link danger"
                title="Not a time entry. This work will not be drafted again."
                onClick={() => act(() => api.rejectEntry(e.id))}
              >
                Reject
              </button>
            ) : (
              <button
                className="link danger"
                onClick={() =>
                  confirm('Discard this manual entry?') && act(() => api.discardEntry(e.id))
                }
              >
                Discard
              </button>
            )}
          </>
        )}
        {(e.status === 'approved' || e.status === 'copied') && (
          <>
            <button
              className={e.status === 'approved' ? 'primary' : ''}
              onClick={() => copy([e.id])}
            >
              {e.status === 'copied' ? 'Copy again' : 'Copy'}
            </button>
            {e.copiedAt && (
              <span className="muted small">Copied {new Date(e.copiedAt).toLocaleString()}</span>
            )}
            <span className="spacer" />
            <button
              className="link"
              onClick={() =>
                (e.status !== 'copied' ||
                  confirm(
                    'This entry was already copied to your billing system. Reopening will not change it there. Continue?',
                  )) &&
                act(() => api.reopenEntry(e.id))
              }
            >
              Reopen
            </button>
          </>
        )}
        {e.status === 'rejected' && (
          <>
            <span className="muted small">Not a time entry. This work won’t be drafted again.</span>
            <span className="spacer" />
            <button className="link" onClick={() => act(() => api.reopenEntry(e.id))}>
              Restore as draft
            </button>
          </>
        )}
        {e.evidence.length > 0 && (
          <button className="link" onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? 'Hide' : 'Show'} evidence ({e.evidence.length})
          </button>
        )}
        <button className="link" onClick={toggleHistory}>
          {history ? 'Hide history' : 'History'}
        </button>
      </footer>

      {showEvidence && (
        <table className="events">
          <tbody>
            {e.evidence.map((ev) => (
              <tr key={ev.id}>
                <td>{formatTime(ev.startedAt)}</td>
                <td>{formatDuration(ev.endedAt - ev.startedAt)}</td>
                <td>{ev.application}</td>
                <td className="title-cell">
                  {ev.windowTitle || <span className="muted">(no title)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {history && (
        <ol className="history">
          {history.map((h, i) => (
            <li key={i}>
              <span className="muted">{new Date(h.at).toLocaleString()}</span> ·{' '}
              {h.action.replace(/^entry_/, '').replace('_', ' ')}
              {describeChanges(h.detail)}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function describeChanges(detail: Record<string, unknown>): string {
  if (typeof detail.billedMinutes === 'number')
    return ` — ${decimalHours(detail.billedMinutes)} h frozen`;
  if (typeof detail.hours === 'string') return ` — ${detail.hours} h`;
  const changes = detail.changes as Record<string, [unknown, unknown]> | undefined;
  if (!changes) return '';
  const shown = Object.entries(changes)
    .filter(([k]) => !['status', 'frozen_billing', 'approved_at', 'copied_at'].includes(k))
    .map(([k, [a, b]]) => {
      const fmt = (v: unknown) =>
        typeof v === 'string' ? `“${v.length > 60 ? `${v.slice(0, 60)}…` : v}”` : String(v);
      return `${k.replaceAll('_', ' ')}: ${fmt(a)} → ${fmt(b)}`;
    });
  return shown.length ? ` — ${shown.join('; ')}` : '';
}

function AdjustForm({
  entry: e,
  inc,
  act,
  onDone,
}: {
  entry: EntryView;
  inc: number;
  act: Act;
  onDone: () => void;
}) {
  const [hours, setHours] = useState(decimalHours(e.calculation.billedMinutes));
  const [reason, setReason] = useState(e.overrideReason ?? '');
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const minutes = Math.round(Number(hours) * 60);
    if (
      await act(() =>
        api.updateEntry(e.id, { billedOverrideMinutes: minutes, overrideReason: reason }),
      )
    )
      onDone();
  };
  return (
    <form className="adjust" onSubmit={submit}>
      <label>
        Billed hours
        <input
          type="number"
          min={0}
          step={inc / 60}
          value={hours}
          onChange={(ev) => setHours(ev.target.value)}
          required
        />
      </label>
      <label className="grow">
        Reason (kept in the audit history)
        <input
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          required
          maxLength={500}
        />
      </label>
      <button className="primary" type="submit">
        Save
      </button>
      {e.billedOverrideMinutes !== null && (
        <button
          type="button"
          onClick={async () =>
            (await act(() => api.updateEntry(e.id, { billedOverrideMinutes: null }))) && onDone()
          }
        >
          Remove adjustment
        </button>
      )}
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

function ManualEntryForm({
  date,
  matters,
  act,
  onDone,
}: {
  date: string;
  matters: Matter[];
  act: Act;
  onDone: (ok: boolean) => void;
}) {
  const [matterId, setMatterId] = useState(matters[0]?.id ?? '');
  const [minutes, setMinutes] = useState('');
  const [start, setStart] = useState('');
  const [billable, setBillable] = useState(true);
  const [description, setDescription] = useState('');

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    let startAt: number | null = null;
    if (start) {
      const [h, m] = start.split(':').map(Number) as [number, number];
      const d = new Date(localDayRange(date).startMs);
      d.setHours(h, m, 0, 0);
      startAt = d.getTime();
    }
    const ok = await act(() =>
      api.createManualEntry({
        entryDate: date,
        matterId,
        description,
        actualMinutes: Number.parseInt(minutes, 10),
        startAt,
        billable,
      }),
    );
    onDone(ok);
  };

  if (matters.length === 0) {
    return <div className="banner warn-banner">Create a matter first (Matters tab).</div>;
  }
  return (
    <form className="manual-form" onSubmit={submit}>
      <strong>Manual entry for {date}</strong>
      <p className="muted small">
        For work the computer couldn’t observe, like calls or meetings away from your desk. It is
        labelled as manual everywhere.
      </p>
      <div className="row">
        <select
          value={matterId}
          onChange={(ev) => setMatterId(ev.target.value)}
          aria-label="Matter"
        >
          {matters.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={1440}
          placeholder="Minutes"
          value={minutes}
          onChange={(ev) => setMinutes(ev.target.value)}
          required
        />
        <input
          type="time"
          value={start}
          onChange={(ev) => setStart(ev.target.value)}
          title="Optional. Lets the app check for overlaps with captured work."
          aria-label="Start time (optional)"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={billable}
            onChange={(ev) => setBillable(ev.target.checked)}
          />
          Billable
        </label>
      </div>
      <textarea
        rows={2}
        placeholder="Narrative"
        value={description}
        onChange={(ev) => setDescription(ev.target.value)}
      />
      <div className="row">
        <button className="primary" type="submit">
          Add entry
        </button>
        <button type="button" onClick={() => onDone(true)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
