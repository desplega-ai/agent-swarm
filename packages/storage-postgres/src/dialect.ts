import { type Dialect, type LikeEscape, SqlQuery, sql } from "@desplega/storage";

/**
 * The Postgres dialect. The database is created with the C collation and C
 * character classes: text then orders by bytes, as on SQLite, and ILIKE,
 * lower() and upper() fold ASCII letters only, as SQLite's built-in LIKE,
 * lower() and upper() do.
 *
 * Time: SQLite's 'now' is fixed for one statement; `statement_timestamp()` is
 * the same on Postgres. Timestamp columns are `timestamptz` (D8); the codec
 * renders each one in the text format its SQLite column stores.
 */
export const postgresDialect: Dialect = {
  name: "postgres",
  placeholder: (index: number) => "$" + String(index),
  nowIso: () => sql`statement_timestamp()`,
  nowText: () => sql`statement_timestamp()`,
  nowEpochMs: () => sql`(floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint`,
  // ILIKE folds ASCII only under LC_CTYPE C. Postgres LIKE escapes with a
  // backslash by default and SQLite has no default escape: ESCAPE '' turns
  // escaping off when the caller names no escape character.
  likeAsciiCi: (column: SqlQuery, pattern: SqlQuery, escapeChar?: LikeEscape) =>
    sql`${column} ILIKE ${pattern} ESCAPE ${new SqlQuery([`'${escapeChar ?? ""}'`], [])}`,
  isoTimestampText: (column: SqlQuery) =>
    sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  greatestStrict: (a: SqlQuery, b: SqlQuery) =>
    sql`(CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL ELSE GREATEST(${a}, ${b}) END)`,
  leastStrict: (a: SqlQuery, b: SqlQuery) =>
    sql`(CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL ELSE LEAST(${a}, ${b}) END)`,
  jsonText: (text: SqlQuery) => sql`CAST(${text} AS text)::jsonb`,
  forUpdate: (skipLocked: boolean) =>
    skipLocked ? sql` FOR UPDATE SKIP LOCKED` : sql` FOR UPDATE`,
};
