export { formatDuration } from '../../core/billing/engine';

export const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Billing units shown as decimal hours (e.g. 7 × 6 min = 0.7). */
export const formatHours = (minutes: number) => (minutes / 60).toFixed(minutes % 6 === 0 ? 1 : 2);

export const errorMessage = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
