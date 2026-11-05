import { useEffect, useState } from 'react';
import type { BillingPolicy, Settings } from '../../../shared/types';
import { errorMessage } from '../format';

const api = window.timekeeper;
const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api.getSettings().then(setS);
  }, []);
  if (!s) return null;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const setPolicy = <K extends keyof BillingPolicy>(k: K, v: BillingPolicy[K]) =>
    setS({ ...s, billingPolicy: { ...s.billingPolicy, [k]: v } });

  const save = async () => {
    try {
      setS(await api.updateSettings(s));
      setMsg({ ok: true, text: 'Settings saved. Monitoring restarted with the new settings.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  const deleteAll = async () => {
    if (
      !confirm(
        'Permanently delete ALL captured activity and matter selections? Matters themselves are kept.',
      )
    )
      return;
    const { deleted } = await api.deleteAllActivity();
    setMsg({ ok: true, text: `Deleted ${deleted} activity events.` });
  };

  const num = (v: string) => Number.parseInt(v, 10) || 0;

  return (
    <div className="page narrow settings">
      <h2>Settings</h2>

      <fieldset>
        <legend>Capture</legend>
        <label>
          Capture source
          <select
            value={s.captureSource}
            onChange={(e) => set('captureSource', e.target.value as Settings['captureSource'])}
          >
            <option value="mock">Mock (simulated activity, for development)</option>
            <option value="macos">
              macOS (real metadata; needs Accessibility permission for window titles)
            </option>
            <option value="windows">Windows (not yet implemented)</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.startMonitoringOnLaunch}
            onChange={(e) => set('startMonitoringOnLaunch', e.target.checked)}
          />
          Start monitoring when the app launches
        </label>
        <label>
          Poll interval (seconds, 5–60)
          <input
            type="number"
            min={5}
            max={60}
            value={s.pollIntervalSeconds}
            onChange={(e) => set('pollIntervalSeconds', num(e.target.value))}
          />
        </label>
        <label>
          Idle after (minutes without input)
          <input
            type="number"
            min={1}
            max={60}
            value={s.idleThresholdMinutes}
            onChange={(e) => set('idleThresholdMinutes', num(e.target.value))}
          />
        </label>
        <label>
          Split sessions after (minutes without active work)
          <input
            type="number"
            min={1}
            max={240}
            value={s.sessionGapMinutes}
            onChange={(e) => set('sessionGapMinutes', num(e.target.value))}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Privacy exclusions</legend>
        <p className="muted small">
          Excluded activity is stored only as “Excluded” with a time range — no app name, title, or
          URL.
        </p>
        <label>
          Applications (one per line, exact name)
          <textarea
            rows={5}
            value={s.excludedApplications.join('\n')}
            onChange={(e) => set('excludedApplications', lines(e.target.value))}
          />
        </label>
        <label>
          Window-title keywords (one per line)
          <textarea
            rows={3}
            value={s.excludedTitleKeywords.join('\n')}
            onChange={(e) => set('excludedTitleKeywords', lines(e.target.value))}
          />
        </label>
        <label>
          Domains (one per line; subdomains included)
          <textarea
            rows={3}
            value={s.excludedDomains.join('\n')}
            onChange={(e) => set('excludedDomains', lines(e.target.value))}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Billing policy</legend>
        <p className="banner warn small">
          Placeholder defaults. Confirm the firm’s actual rounding, minimum and aggregation rules.
        </p>
        <label>
          Increment (minutes)
          <input
            type="number"
            min={1}
            max={60}
            value={s.billingPolicy.incrementMinutes}
            onChange={(e) => setPolicy('incrementMinutes', num(e.target.value))}
          />
        </label>
        <label>
          Rounding
          <select
            value={s.billingPolicy.roundingMode}
            onChange={(e) =>
              setPolicy('roundingMode', e.target.value as BillingPolicy['roundingMode'])
            }
          >
            <option value="up">Up</option>
            <option value="nearest">Nearest (halves up)</option>
            <option value="down">Down</option>
          </select>
        </label>
        <label>
          Minimum charge (minutes, blank = none)
          <input
            type="number"
            min={1}
            value={s.billingPolicy.minimumMinutes ?? ''}
            onChange={(e) =>
              setPolicy('minimumMinutes', e.target.value ? num(e.target.value) : null)
            }
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.billingPolicy.allowTaskAggregation}
            onChange={(e) => setPolicy('allowTaskAggregation', e.target.checked)}
          />
          Aggregate a matter’s sessions per day before rounding
        </label>
      </fieldset>

      <fieldset>
        <legend>Data retention</legend>
        <label>
          Delete activity older than (days, 0 = keep)
          <input
            type="number"
            min={0}
            value={s.retentionDays}
            onChange={(e) => set('retentionDays', num(e.target.value))}
          />
        </label>
        <button className="danger" onClick={deleteAll}>
          Delete all captured activity…
        </button>
      </fieldset>

      <div className="save-row">
        <button className="primary" onClick={save}>
          Save settings
        </button>
        {msg && <span className={msg.ok ? 'ok-text' : 'error-text'}>{msg.text}</span>}
      </div>
    </div>
  );
}
