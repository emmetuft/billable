import { useState, type FormEvent } from 'react';
import type { Matter, MonitorStatus } from '../../../shared/types';
import { errorMessage } from '../format';

const api = window.billable;

export function MattersPage({
  matters,
  status,
  onChanged,
}: {
  matters: Matter[];
  status: MonitorStatus | null;
  onChanged: () => void;
}) {
  const [clientName, setClient] = useState('');
  const [matterName, setMatter] = useState('');
  const [keywords, setKeywords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createMatter({
        clientName,
        matterName,
        keywords: keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      });
      setClient('');
      setMatter('');
      setKeywords('');
      setError(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const active = matters.filter((m) => !m.archivedAt);
  const archived = matters.filter((m) => m.archivedAt);

  return (
    <div className="page narrow">
      <h2>Matters</h2>
      <p className="muted">
        Store only what helps identify activity: names and a few keywords (e.g. document-name
        fragments). Do not paste client files or confidential details here.
      </p>
      <form className="matter-form" onSubmit={create}>
        <input
          placeholder="Client"
          value={clientName}
          onChange={(e) => setClient(e.target.value)}
          required
        />
        <input
          placeholder="Matter"
          value={matterName}
          onChange={(e) => setMatter(e.target.value)}
          required
        />
        <input
          placeholder="Keywords (comma-separated, optional)"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />
        <button className="primary" type="submit">
          Add matter
        </button>
      </form>
      {error && <div className="banner error">{error}</div>}

      <table className="list">
        <tbody>
          {active.map((m) =>
            editing === m.id ? (
              <tr key={m.id}>
                <td colSpan={2}>
                  <MatterEditor
                    matter={m}
                    onDone={() => {
                      setEditing(null);
                      onChanged();
                    }}
                  />
                </td>
              </tr>
            ) : (
              <tr key={m.id}>
                <td>
                  <strong>{m.displayName}</strong>
                  {m.keywords.length > 0 && (
                    <div className="muted small">Keywords: {m.keywords.join(', ')}</div>
                  )}
                </td>
                <td className="actions">
                  <button onClick={() => setEditing(m.id)}>Edit</button>
                  {status?.activeMatterId === m.id ? (
                    <span className="badge ok">Active</span>
                  ) : (
                    <button onClick={() => void api.setActiveMatter(m.id)}>Set active</button>
                  )}
                  <button
                    onClick={async () => {
                      if (confirm(`Archive "${m.displayName}"? Past activity is kept.`)) {
                        await api.archiveMatter(m.id);
                        onChanged();
                      }
                    }}
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ),
          )}
          {active.length === 0 && (
            <tr>
              <td className="muted">No matters yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {archived.length > 0 && (
        <details>
          <summary className="muted">{archived.length} archived</summary>
          <ul>
            {archived.map((m) => (
              <li key={m.id} className="muted">
                {m.displayName}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function MatterEditor({ matter, onDone }: { matter: Matter; onDone: () => void }) {
  const [clientName, setClient] = useState(matter.clientName);
  const [matterName, setMatter] = useState(matter.matterName);
  const [keywords, setKeywords] = useState(matter.keywords.join(', '));
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.updateMatter(matter.id, {
        clientName,
        matterName,
        aliases: matter.aliases,
        keywords: keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="matter-form" onSubmit={save}>
      <input
        aria-label="Client"
        value={clientName}
        onChange={(e) => setClient(e.target.value)}
        required
      />
      <input
        aria-label="Matter"
        value={matterName}
        onChange={(e) => setMatter(e.target.value)}
        required
      />
      <input aria-label="Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      <span>
        <button className="primary" type="submit">
          Save
        </button>{' '}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </span>
      {error && <div className="banner error">{error}</div>}
    </form>
  );
}
