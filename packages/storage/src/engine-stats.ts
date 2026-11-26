/**
 * Server statistics the Postgres engine reads from its `pg_stat_*` views for
 * the API's OTel gauges. SQLite has no such server and reports none.
 *
 * Cumulative fields count since the server's last statistics reset.
 */
export type PostgresStats = {
  /** The server's `max_connections` setting. */
  maxConnections: number;
  /** Client connections on the whole server, by `pg_stat_activity.state` ("unknown" when hidden). */
  connectionsByState: { state: string; count: number }[];
  /** Age of the oldest running statement on another connection, in seconds (0 when none). */
  longestQuerySeconds: number;
  /** Age of the oldest open transaction on another connection, in seconds (0 when none). */
  longestTransactionSeconds: number;
  /** `pg_database_size` of the current database. */
  databaseSizeBytes: number;
  /** Cumulative `pg_stat_database` counters of the current database. */
  commits: number;
  rollbacks: number;
  blocksHit: number;
  blocksRead: number;
  deadlocks: number;
  tempBytes: number;
  /** The tables with the most sequential scans and the most dead tuples (bounded). */
  tables: { table: string; seqScans: number; liveTuples: number; deadTuples: number }[];
  /** Current-database totals from `pg_stat_statements`, or null when it is not installed or not loaded. */
  statements: { calls: number; totalExecMs: number; rows: number } | null;
};
