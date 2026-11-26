import type { DbClient, DbExecutor, PostgresStats } from "@desplega/storage";

/**
 * The `pg_stat_*` read behind the API's Postgres gauges: one read-only
 * transaction on the engine's pool (one connection), each statement capped by
 * a short `statement_timeout`. Every value is cast to float8 or int so the
 * driver returns a JS number.
 */

export type PostgresStatsOptions = {
  /** Tables kept per ranking (most seq scans, most dead tuples). The union bounds the `table` attribute. */
  topTables?: number;
  /** Per-statement timeout, in ms. */
  statementTimeoutMs?: number;
};

const DEFAULT_TOP_TABLES = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 2_000;

type DatabaseRow = Omit<
  PostgresStats,
  "connectionsByState" | "longestQuerySeconds" | "longestTransactionSeconds" | "tables" | "statements"
>;
type ActivityRow = {
  state: string;
  count: number;
  longestQuerySeconds: number;
  longestTransactionSeconds: number;
};

export async function readPostgresStats(
  client: DbClient,
  options: PostgresStatsOptions = {},
): Promise<PostgresStats> {
  const topTables = Math.max(1, Math.floor(options.topTables ?? DEFAULT_TOP_TABLES));
  const timeoutMs = Math.max(1, Math.floor(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  return client.transaction(
    async (tx) => {
      await tx.run(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const database = await tx.get<DatabaseRow>(
        `SELECT current_setting('max_connections')::int AS "maxConnections",
           pg_database_size(d.datid)::float8 AS "databaseSizeBytes",
           d.xact_commit::float8 AS commits,
           d.xact_rollback::float8 AS rollbacks,
           d.blks_hit::float8 AS "blocksHit",
           d.blks_read::float8 AS "blocksRead",
           d.deadlocks::float8 AS deadlocks,
           d.temp_bytes::float8 AS "tempBytes"
         FROM pg_stat_database d WHERE d.datname = current_database()`,
      );
      if (!database) throw new Error("pg_stat_database has no row for the current database");
      // Server-wide: max_connections is a server budget. Our own connection
      // counts as a connection, never as the oldest query or transaction.
      const activity = await tx.query<ActivityRow>(
        `SELECT COALESCE(state, 'unknown') AS state, COUNT(*)::int AS count,
           COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)))
             FILTER (WHERE state = 'active' AND pid <> pg_backend_pid()), 0)::float8 AS "longestQuerySeconds",
           COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)))
             FILTER (WHERE pid <> pg_backend_pid()), 0)::float8 AS "longestTransactionSeconds"
         FROM pg_stat_activity WHERE backend_type = 'client backend'
         GROUP BY 1 ORDER BY 1`,
      );
      const tables = await tx.query<PostgresStats["tables"][number]>(
        `SELECT CASE WHEN schemaname = 'public' THEN relname ELSE schemaname || '.' || relname END AS "table",
           COALESCE(seq_scan, 0)::float8 AS "seqScans",
           n_live_tup::float8 AS "liveTuples",
           n_dead_tup::float8 AS "deadTuples"
         FROM pg_stat_user_tables
         WHERE relid IN (
           (SELECT relid FROM pg_stat_user_tables ORDER BY seq_scan DESC NULLS LAST, relid LIMIT $1)
           UNION
           (SELECT relid FROM pg_stat_user_tables ORDER BY n_dead_tup DESC, relid LIMIT $1))
         ORDER BY 1`,
        [topTables],
      );
      return {
        ...database,
        connectionsByState: activity.map(({ state, count }) => ({ state, count })),
        longestQuerySeconds: Math.max(0, ...activity.map((r) => r.longestQuerySeconds)),
        longestTransactionSeconds: Math.max(0, ...activity.map((r) => r.longestTransactionSeconds)),
        tables,
        statements: await readStatementTotals(client, tx),
      };
    },
    { readOnly: true },
  );
}

/**
 * `pg_stat_statements` totals for the current database, or null. The view
 * exists only with the extension created, and it errors unless the library is
 * also in `shared_preload_libraries`: the read runs in a savepoint so that
 * error never aborts the rest of the poll.
 */
async function readStatementTotals(
  client: DbClient,
  tx: DbExecutor,
): Promise<PostgresStats["statements"]> {
  const extension = await tx.get<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_extension e
     JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_stat_statements'`,
  );
  if (!extension) return null;
  const view = `"${extension.schema.replaceAll('"', '""')}".pg_stat_statements`;
  try {
    // Called inside the open transaction, so the client makes it a SAVEPOINT.
    return await client.transaction(async (sp) => {
      const row = await sp.get<NonNullable<PostgresStats["statements"]>>(
        `SELECT COALESCE(SUM(calls), 0)::float8 AS calls,
           COALESCE(SUM(total_exec_time), 0)::float8 AS "totalExecMs",
           COALESCE(SUM(rows), 0)::float8 AS rows
         FROM ${view}
         WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      return row ?? { calls: 0, totalExecMs: 0, rows: 0 };
    });
  } catch {
    return null;
  }
}
