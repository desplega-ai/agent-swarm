import { type Dialect, type LikeEscape, SqlQuery, sql } from "@desplega/storage";

export const sqliteDialect: Dialect = {
  name: "sqlite",
  placeholder: () => "?",
  nowIso: () => sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  nowText: () => sql`datetime('now')`,
  nowEpochMs: () => sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
  epochMs: (column: SqlQuery) => sql`CAST(ROUND(unixepoch(${column}, 'subsec') * 1000) AS INTEGER)`,
  // SQLite's built-in LIKE already folds ASCII case only.
  likeAsciiCi: (column: SqlQuery, pattern: SqlQuery, escapeChar?: LikeEscape) =>
    escapeChar === undefined
      ? sql`${column} LIKE ${pattern}`
      : sql`${column} LIKE ${pattern} ESCAPE ${new SqlQuery([`'${escapeChar}'`], [])}`,
  greatestStrict: (a: SqlQuery, b: SqlQuery) => sql`max(${a}, ${b})`,
  isoTimestampText: (column: SqlQuery) => column,
  leastStrict: (a: SqlQuery, b: SqlQuery) => sql`min(${a}, ${b})`,
  jsonText: (text: SqlQuery) => text,
  // A SQLite write transaction holds the database write lock: no row locks.
  forUpdate: () => sql``,
};
