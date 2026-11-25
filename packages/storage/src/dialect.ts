import { type DialectFragment, dialectFragment, type SqlQuery, sql } from "./sql";

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
  /** A timestamp column as integer epoch milliseconds. */
  epochMs(column: SqlQuery): SqlQuery;
  /**
   * `column LIKE pattern` that folds ASCII case only, like SQLite's built-in
   * LIKE. `escapeChar` names the escape character when the pattern escapes `%`/`_`.
   */
  likeAsciiCi(column: SqlQuery, pattern: SqlQuery, escapeChar?: LikeEscape): SqlQuery;
  /** Scalar maximum of two values that is NULL when either value is NULL (SQLite `max(a, b)`). */
  greatestStrict(a: SqlQuery, b: SqlQuery): SqlQuery;
  /** Scalar minimum of two values that is NULL when either value is NULL (SQLite `min(a, b)`). */
  leastStrict(a: SqlQuery, b: SqlQuery): SqlQuery;
  /**
   * A JSON document given as JSON text, for a write to a JSON column. SQLite
   * stores the text; Postgres must parse it into jsonb (a plain text bind into
   * a jsonb column stores a JSON string instead of the document).
   */
  jsonText(text: SqlQuery): SqlQuery;
  /**
   * A timestamp column as the ISO text the app writes (`2026-11-20T10:00:00.000Z`),
   * for an expression that mixes it with text (a UNION arm, a text comparison).
   * SQLite stores that text already; Postgres formats its timestamptz.
   */
  isoTimestampText(column: SqlQuery): SqlQuery;
  /**
   * Row-lock clause appended to a SELECT (decision D7). Postgres: `FOR UPDATE`,
   * or `FOR UPDATE SKIP LOCKED` with `skipLocked`. SQLite: empty, because a
   * write transaction there already holds the database write lock.
   */
  forUpdate(skipLocked: boolean): SqlQuery;
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

/** `${epochMs(sql\`col\`)}` inside a `sql` template. */
export function epochMs(column: SqlQuery): DialectFragment {
  return dialectFragment((d) => d.epochMs(column));
}

/** `${isoTimestampText(sql\`col\`)}` inside a `sql` template. */
export function isoTimestampText(column: SqlQuery): DialectFragment {
  return dialectFragment((d) => d.isoTimestampText(column));
}

/** `${forUpdate}` at the end of a SELECT: lock the selected rows (Postgres). */
export const forUpdate: DialectFragment = dialectFragment((d) => d.forUpdate(false));
/** `${forUpdateSkipLocked}` at the end of a SELECT: lock the rows no other transaction holds. */
export const forUpdateSkipLocked: DialectFragment = dialectFragment((d) => d.forUpdate(true));

/** `${jsonText(value)}` inside a `sql` template: the bound JSON text, parsed on Postgres. */
export function jsonText(text: string | null): DialectFragment {
  return dialectFragment((d) => d.jsonText(sql`${text}`));
}
