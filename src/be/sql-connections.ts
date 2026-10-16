import { getResolvedConfig } from "@/be/db";
import { registerVolatileSecret, scrubSecrets } from "@/utils/secret-scrubber";
import type { ScriptConnectionRecord } from "./script-connections";

export const SQL_MAX_ROWS = 1000;
/** Serialized JSON budget for one response; rows past it are dropped and `truncated` is set. */
export const SQL_MAX_BYTES = 5 * 1024 * 1024;
const SQL_FETCH_BATCH = 100;

export type SqlQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};
type SqlRow = Record<string, unknown>;
/** Feeds fetched batches to `take` until it returns false or the cursor is drained. */
type SqlExecutor = (
  dsn: string,
  query: string,
  params: unknown[],
  take: (batch: SqlRow[]) => boolean,
) => Promise<void>;

/** Only Postgres: Bun `SQL` would open a `sqlite://` URL as a file on the API host. Never echo the DSN. */
export function assertPostgresDsn(dsn: string): void {
  if (!URL.canParse(dsn) || !["postgres:", "postgresql:"].includes(new URL(dsn).protocol)) {
    throw new Error("SQL connection DSN must be a postgres:// or postgresql:// URL.");
  }
}

/** Resolve the encrypted DSN server-side. No process.env fallback: a lead must not point it at API env vars. */
export async function resolveSqlDsn(
  connection: ScriptConnectionRecord,
  agentId: string,
): Promise<string> {
  const key = connection.authConfigKey;
  if (!key) throw new Error("SQL connection has no DSN config key.");
  const repoId = connection.scope === "repo" ? (connection.scopeId ?? undefined) : undefined;
  const dsn = (await getResolvedConfig(agentId, repoId)).find((c) => c.key === key)?.value;
  if (!dsn) throw new Error(`SQL connection DSN '${key}' is not set.`);
  registerVolatileSecret(dsn, key);
  if (URL.canParse(dsn)) registerVolatileSecret(decodeURIComponent(new URL(dsn).password), key);
  assertPostgresDsn(dsn);
  return dsn;
}

// Read-only enforcement point. Every layer is enforced by Postgres, never by inspecting the SQL:
// 1. default_transaction_read_only=on for the whole session, 2. an explicit READ ONLY transaction,
// 3. one statement per call over the extended protocol, 4. a fresh connection closed after each call.
// Bun runs a parameterless `unsafe()` over the simple protocol, which accepts `commit; ...; insert`,
// so the parameterless case goes through the tagged-template path instead. Never use `.simple()`.
// The statement runs as a server-side cursor fetched in batches, so the API never holds more than
// one batch past the caps. DECLARE only accepts SELECT, VALUES, TABLE and WITH ... SELECT.
const asTemplate = (text: string): TemplateStringsArray => Object.assign([text], { raw: [text] });

const defaultExecutor: SqlExecutor = async (dsn, query, params, take) => {
  // Bun.SQL global, not `import { SQL } from "bun"`: the node-target CLI bundle cannot import "bun".
  const sql = new Bun.SQL({
    adapter: "postgres",
    url: dsn,
    max: 1,
    connectionTimeout: 10,
    connection: { default_transaction_read_only: "on", statement_timeout: 30_000 },
  });
  try {
    await sql.begin("read only", async (tx) => {
      const declare = `declare swarm_sql_cursor no scroll cursor for ${query}`;
      await (params.length > 0 ? tx.unsafe(declare, params) : tx(asTemplate(declare)));
      const fetchNext = asTemplate(`fetch ${SQL_FETCH_BATCH} from swarm_sql_cursor`);
      for (;;) {
        const batch = [...((await tx(fetchNext)) as SqlRow[])];
        if (!take(batch) || batch.length < SQL_FETCH_BATCH) return;
      }
    });
  } finally {
    await sql.close();
  }
};

let sqlExecutorForTesting: SqlExecutor | null = null;

export function setSqlExecutorForTesting(executor: SqlExecutor | null): void {
  sqlExecutorForTesting = executor;
}

export async function runReadOnlyQuery(
  dsn: string,
  query: string,
  params: unknown[] = [],
): Promise<SqlQueryResult> {
  const rows: SqlRow[] = [];
  let bytes = 0;
  let truncated = false;
  const take = (batch: SqlRow[]): boolean => {
    for (const row of batch) {
      const size = Buffer.byteLength(
        JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
      if (rows.length >= SQL_MAX_ROWS || bytes + size > SQL_MAX_BYTES) {
        truncated = true;
        return false;
      }
      bytes += size;
      rows.push(row);
    }
    return true;
  };
  try {
    await (sqlExecutorForTesting ?? defaultExecutor)(dsn, query, params, take);
    return { rows, rowCount: rows.length, truncated };
  } catch (err) {
    const code = (err as { errno?: unknown }).errno;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      scrubSecrets(typeof code === "string" ? `${message} (SQLSTATE ${code})` : message),
    );
  }
}
