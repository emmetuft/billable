import type { BillingCalculation, Matter, TimeEntry } from '../../shared/types';

/**
 * Clipboard format (stable; documented in docs/billing-policy.md):
 *   one line per entry, CRLF line endings, tab-separated, no header row:
 *   Date (YYYY-MM-DD) · Client · Matter · Hours (decimal) · Billable (Y/N) · Narrative
 */
export const CLIPBOARD_COLUMNS = ['Date', 'Client', 'Matter', 'Hours', 'Billable', 'Narrative'];

/** Decimal hours with no trailing zeros: 42 min → "0.7", 15 min → "0.25", 60 min → "1". */
export function decimalHours(minutes: number): string {
  return String(Number((minutes / 60).toFixed(2)));
}

/** Tabs and line breaks would corrupt the columns; collapse all whitespace to single spaces. */
export function sanitizeField(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function formatEntriesTsv(
  entries: (TimeEntry & { calculation: BillingCalculation })[],
  matters: Matter[],
): string {
  const byId = new Map(matters.map((m) => [m.id, m]));
  return entries
    .map((e) => {
      const m = e.matterId ? byId.get(e.matterId) : undefined;
      return [
        e.entryDate,
        m?.clientName ?? '',
        m?.matterName ?? '',
        decimalHours(e.calculation.billedMinutes),
        e.billable ? 'Y' : 'N',
        e.description,
      ]
        .map(sanitizeField)
        .join('\t');
    })
    .join('\r\n');
}
