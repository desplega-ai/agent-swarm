import { type DialectFragment, dialectFragment, type SqlQuery } from "./sql";

/**
 * The SQL language of an engine. A dialect is independent of the driver: a
 * future libsql engine reuses the SQLite dialect with another driver.
 *
 * Each method returns SQL that the dialect author wrote for that engine. No
 * method rewrites text it receives.
 */
/** The escape characters a LIKE pattern may use. A closed set: the text is inlined. */
export type LikeEscape = "\\" | "!";

export interface Dialect {
  readonly name: "sqlite" | "postgres";
  /** Placeholder for the 1-based parameter `index`. */
  placeholder(index: number): string;
  /** Current time as ISO-8601 text with milliseconds and `Z` (the app's own format). */
  nowIso(): SqlQuery;
  /** Current time as `YYYY-MM-DD HH:MM:SS` text (SQLite `datetime('now')`). */
  nowText(): SqlQuery;
  /** Current time as integer epoch milliseconds. */
  nowEpochMs(): SqlQuery;
  /**
   * `column LIKE pattern` that folds ASCII case only, like SQLite's built-in
   * LIKE. `escapeChar` names the escape character when the pattern escapes `%`/`_`.
   */
  likeAsciiCi(column: SqlQuery, pattern: SqlQuery, escapeChar?: LikeEscape): SqlQuery;
  /** Scalar maximum of two values that is NULL when either value is NULL (SQLite `max(a, b)`). */
  greatestStrict(a: SqlQuery, b: SqlQuery): SqlQuery;
  /** Scalar minimum of two values that is NULL when either value is NULL (SQLite `min(a, b)`). */
  leastStrict(a: SqlQuery, b: SqlQuery): SqlQuery;
}

/** `${nowIso}` inside a `sql` template. */
export const nowIso: DialectFragment = dialectFragment((d) => d.nowIso());
/** `${nowText}` inside a `sql` template. */
export const nowText: DialectFragment = dialectFragment((d) => d.nowText());
/** `${nowEpochMs}` inside a `sql` template. */
export const nowEpochMs: DialectFragment = dialectFragment((d) => d.nowEpochMs());

export function likeAsciiCi(
  column: SqlQuery,
  pattern: SqlQuery,
  escapeChar?: LikeEscape,
): DialectFragment {
  return dialectFragment((d) => d.likeAsciiCi(column, pattern, escapeChar));
}

export function greatestStrict(a: SqlQuery, b: SqlQuery): DialectFragment {
  return dialectFragment((d) => d.greatestStrict(a, b));
}

export function leastStrict(a: SqlQuery, b: SqlQuery): DialectFragment {
  return dialectFragment((d) => d.leastStrict(a, b));
}
