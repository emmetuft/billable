/** Local-calendar helpers. Storage is UTC epoch ms; days are defined by the user's local zone. */

/** [start, end) of a local calendar day given as YYYY-MM-DD. Handles 23/25-hour DST days. */
export function localDayRange(isoDate: string): { startMs: number; endMs: number } {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return {
    startMs: new Date(y, m - 1, d).getTime(),
    endMs: new Date(y, m - 1, d + 1).getTime(),
  };
}

export function toLocalIsoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
