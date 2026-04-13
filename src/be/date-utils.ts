/**
 * Normalizes date strings from SQLite to ISO 8601 UTC format.
 *
 * SQLite's `datetime('now')` and `CURRENT_TIMESTAMP` produce bare format
 * `YYYY-MM-DD HH:MM:SS` which browsers parse as local time. This utility
 * converts them to `YYYY-MM-DDTHH:MM:SS.000Z` so they're unambiguously UTC.
 */

const BARE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function normalizeDate(date: string | null | undefined): string | null {
  if (date == null) return null;
  if (BARE_DATETIME_RE.test(date)) {
    return `${date.replace(" ", "T")}.000Z`;
  }
  return date;
}

/**
 * Non-null variant for required date fields.
 * Returns the input unchanged if already ISO 8601, or converts bare format.
 */
export function normalizeDateRequired(date: string): string {
  if (BARE_DATETIME_RE.test(date)) {
    return `${date.replace(" ", "T")}.000Z`;
  }
  return date;
}
