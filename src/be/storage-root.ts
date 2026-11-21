/**
 * Storage composition root: the only `src/` file that imports an engine
 * package (check:dep-graph). Everything else in `src/` imports the contracts
 * package `@desplega/storage` and asks `getStorage()` for repositories.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DB_QUERY_DENIED_TABLES,
  type DbClient,
  type PromptTemplateFilters,
  type PromptTemplateHistoryRow,
  type PromptTemplateRecordUpdate,
  type PromptTemplateRow,
  type QueryReader,
  type StatementObserver,
  type Storage,
} from "@desplega/storage";
import {
  acquireProcessLock,
  type ColumnClassification,
  createPostgresClient,
  createPostgresStorage,
  hasEncryptedSecretRowsPostgres,
  hasPgvector,
  isEmptyPostgresDatabase,
  isInPostgresTransaction,
  loadTimestampFormats,
  openPostgresQueryReader,
  PostgresClient,
  type PostgresSealedColumn,
  runPostgresMigrations,
} from "@desplega/storage-postgres";
import {
  type BusyRetryOptions,
  createBunSqliteClient,
  createSqliteStorage,
  insertPromptTemplateHistorySync,
  insertPromptTemplateSync,
  listPromptTemplatesSync,
  isInTransaction as sqliteIsInTransaction,
  updatePromptTemplateRecordSync,
} from "@desplega/storage-sqlite";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDb, getDbClient, isPostgresEngine } from "./db/runtime";
import { currentLoopPath, recordStatement } from "./event-loop-lag";

export type { BusyRetryOptions };

const SLOW_STATEMENT_SQL_MAX_CHARS = 200;

/** Printed at client creation under --tx-replay; the e2e runner refuses a run without it. */
export const TX_REPLAY_BANNER =
  "[storage] tx-replay on: every transaction callback runs twice, the first run rolled back";

/** Params are never logged: they can carry secrets and user content. */
const serverObserver: StatementObserver = {
  onStatement: (sql, durationMs) => recordStatement(sql, durationMs),
  onSlowStatement: (sql, durationMs) => {
    // Scrub the complete SQL before truncation, so a secret that straddles the
    // cut cannot leave a partial token, then scrub the complete line at egress.
    const flat = scrubSecrets(sql.replace(/\s+/g, " ").trim());
    const shown =
      flat.length > SLOW_STATEMENT_SQL_MAX_CHARS
        ? `${flat.slice(0, SLOW_STATEMENT_SQL_MAX_CHARS)}…`
        : flat;
    console.warn(
      scrubSecrets(
        `[db-client] slow sync statement blocked the event loop for ${Math.round(durationMs)}ms path=${currentLoopPath()}: ${shown}`,
      ),
    );
  },
};

/**
 * Wrap a lazily-resolved bun:sqlite handle in the async DbClient seam, with the
 * server's statement accounting. `busyRetry` overrides the cross-process
 * SQLITE_BUSY retry posture (tests use tiny values).
 */
export function createSqliteClient(
  getDatabase: Parameters<typeof createBunSqliteClient>[0],
  busyRetry?: BusyRetryOptions,
): DbClient {
  // Test-only switch set by `bun run e2e --tx-replay` (Postgres brief D6).
  const txReplay = process.env.STORAGE_TX_REPLAY === "1";
  if (txReplay) console.log(TX_REPLAY_BANNER);
  return createBunSqliteClient(getDatabase, busyRetry, serverObserver, { txReplay });
}

export function isInTransaction(): boolean {
  return sqliteIsInTransaction() || isInPostgresTransaction();
}

export function createStorage(
  client: DbClient,
  options: { vectorSearch: boolean; queryReader?: QueryReader | null },
): Storage {
  if (client instanceof PostgresClient) {
    return createPostgresStorage(client, {
      vectorSearch: options.vectorSearch,
      queryReader: options.queryReader ?? null,
    });
  }
  return createSqliteStorage(client, options);
}

// ---- Engine selection (Postgres brief D1) ----

export type StorageEngine = "sqlite" | "postgres";

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * `DATABASE_URL` with a `postgres://` or `postgresql://` scheme selects
 * Postgres. No `DATABASE_URL` (or another scheme) selects SQLite at
 * `DATABASE_PATH`. `DATABASE_URL` is a reserved key: only the deployment env sets it.
 */
export function selectStorageEngine(env: NodeJS.ProcessEnv = process.env): StorageEngine {
  const url = env.DATABASE_URL?.trim();
  return url && POSTGRES_URL.test(url) ? "postgres" : "sqlite";
}

/** A `DATABASE_URL` that is set but selects no engine (logged by the SQLite start). */
export function ignoredDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DATABASE_URL?.trim();
  return url && !POSTGRES_URL.test(url) ? scrubSecrets(url) : null;
}

// ---- Postgres start (the engine-specific part; src/be/db/runtime.ts runs the seeds) ----

/** How long a second API process waits for the one-process lock (decision D16). */
const PROCESS_LOCK_WAIT_MS = 10_000;
const POSTGRES_POOL_MAX = 10;

/** Directory of the Postgres migration chain. */
function postgresMigrationsDir(): string {
  if (import.meta.dir.startsWith("/$bunfs/")) {
    throw new Error(
      "[db] the Postgres engine cannot run from a compiled binary yet: the Postgres migration chain is not shipped with it",
    );
  }
  return join(import.meta.dir, "migrations", "postgres");
}

export type PostgresEngine = {
  client: DbClient;
  /** pgvector is installed. */
  vectorSearch: boolean;
  /** The database held no table before this start. */
  createdThisBoot: boolean;
  /** The `db-query` reader of `DATABASE_QUERY_URL` (decision D10), or null: no `dbQuery` capability. */
  queryReader: QueryReader | null;
  hasEncryptedSecretRows(
    sealedColumns: readonly PostgresSealedColumn[],
    sealedPrefix: string,
  ): Promise<boolean>;
  close(): Promise<void>;
};

/**
 * Open the `db-query` reader (decision D10). No `DATABASE_QUERY_URL`, or a role
 * that fails the probe, leaves the `dbQuery` capability off. Runs after the
 * migrations, so the probe sees the denied tables.
 */
async function openQueryReader(queryUrl: string | undefined): Promise<QueryReader | null> {
  const url = queryUrl?.trim();
  if (!url) {
    console.log("[db] db-query is off: DATABASE_QUERY_URL is not set (decision D10)");
    return null;
  }
  const result = await openPostgresQueryReader(url, [...DB_QUERY_DENIED_TABLES]);
  if (!result.ok) {
    console.warn(
      scrubSecrets(
        `[db] db-query is off: the DATABASE_QUERY_URL role failed its probe: ${result.reason} (DATABASE_QUERY_URL=${url})`,
      ),
    );
    return null;
  }
  console.log(scrubSecrets(`[db] db-query reader ready (role ${result.role})`));
  return result.reader;
}

/**
 * Open the Postgres engine: take the one-process lock (D16), run the Postgres
 * migration chain (D12), bind the timestamp formats of the read codec to this
 * database (D8), then open the pool (SERIALIZABLE with retry, D6).
 */
export async function openPostgresEngine(
  url: string,
  queryUrl: string | undefined = undefined,
): Promise<PostgresEngine> {
  console.log(`[db] Postgres engine selected (DATABASE_URL=${scrubSecrets(url)})`);
  const migrationsDir = postgresMigrationsDir();
  const lock = await acquireProcessLock(url, { waitMs: PROCESS_LOCK_WAIT_MS });
  try {
    const setup = createPostgresClient(url, { max: 1 });
    let createdThisBoot: boolean;
    let vectorSearch: boolean;
    let timestampFormats: Awaited<ReturnType<typeof loadTimestampFormats>>;
    try {
      createdThisBoot = await isEmptyPostgresDatabase(setup);
      await runPostgresMigrations(setup, { migrationsDir });
      const classification = JSON.parse(
        readFileSync(join(migrationsDir, "column-types.json"), "utf8"),
      ) as ColumnClassification;
      timestampFormats = await loadTimestampFormats(setup, classification);
      vectorSearch = await hasPgvector(setup);
    } finally {
      await setup.close();
    }
    // Test-only switch set by `bun run e2e --tx-replay` (Postgres brief D6).
    const txReplay = process.env.STORAGE_TX_REPLAY === "1";
    if (txReplay) console.log(TX_REPLAY_BANNER);
    const client = createPostgresClient(url, {
      max: POSTGRES_POOL_MAX,
      timestampFormats,
      txReplay,
    });
    const queryReader = await openQueryReader(queryUrl);
    console.log(
      `[db] Postgres engine ready (pgvector ${vectorSearch ? "present" : "absent"}${createdThisBoot ? ", new database" : ""})`,
    );
    return {
      client,
      vectorSearch,
      createdThisBoot,
      queryReader,
      hasEncryptedSecretRows: (sealedColumns, sealedPrefix) =>
        hasEncryptedSecretRowsPostgres(client, sealedColumns, sealedPrefix),
      async close() {
        try {
          await queryReader?.close().catch(() => undefined);
          await client.close();
        } finally {
          await lock.release();
        }
      },
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
}

/**
 * The live engine handle. Its identity changes when the database is closed
 * and opened again, so once-per-database guards key on it (src/be/boot-seeds.ts).
 * SQLite: the current bun:sqlite Database. Postgres: the engine client.
 */
export function currentEngineHandle(): object {
  return isPostgresEngine() ? getDbClient() : getDb();
}

/**
 * The default prompt-template seed's statements on the synchronous SQLite
 * start path (it runs inside initDb, over the handle being opened).
 */
export const promptTemplateSqliteStart = {
  list: (filters: PromptTemplateFilters): PromptTemplateRow[] =>
    listPromptTemplatesSync(getDb(), filters),
  insert: (row: PromptTemplateRow): PromptTemplateRow | null =>
    insertPromptTemplateSync(getDb(), row),
  updateRecord: (id: string, c: PromptTemplateRecordUpdate): PromptTemplateRow | null =>
    updatePromptTemplateRecordSync(getDb(), id, c),
  insertHistory: (row: PromptTemplateHistoryRow): void =>
    insertPromptTemplateHistorySync(getDb(), row),
};

// SQLite boot (the synchronous start path of the SQLite engine).
// The memory full-text backfill statements, for the query-plan test.
// Retention statement texts, for the query-plan tests (src/be/db-retention.ts,
// src/be/db/workflow-run-retention.ts re-export them under their old names).
// The credential window usage statement text, for its query-plan test
// (src/be/key-window-usage.ts re-exports it under the same name).
// User-reference statement texts, for the user-delete query-plan test
// (src/be/db/user-references.ts re-exports them under their old names).
export {
  applySqliteFilePragmas,
  applySqliteTemplatePragmas,
  assertNotEmptySqliteDatabase,
  assertScriptRunSourceSchema,
  backfillScriptRunSources,
  ensureAgentProfileColumns,
  existingUserIdsSync,
  FTS_SCAN_BATCH_SQL,
  findDefaultOAuthAuthorization,
  hasEncryptedSecretRows,
  isEmptySqliteDatabase,
  KEY_WINDOW_USAGE_SQL,
  type LegacyCredentialBinding,
  listCredentialBindingBlobs,
  listPlaintextOAuthSecrets,
  MEMORY_ID_BATCH_SQL,
  quoteSqlIdentifier,
  type RetentionSweepStatements,
  readAssetKeyAuditDataSync,
  removeLegacyTaskStatusCheck,
  replaceCredentialBindingBlob,
  retentionSweepStatements,
  runSqliteMigrations,
  storeEncryptedOAuthSecrets,
  USER_REFERENCE_COLUMNS_SQL,
  userReferenceRewriteSql,
  WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL,
  WORKFLOW_CONTEXT_REQUESTER_SQL,
  WORKFLOW_CONTEXT_SET_REQUESTER_SQL,
  WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL,
  workflowRetentionCandidatesSql,
  workflowRunRetentionStatements as sqliteWorkflowRunRetentionStatements,
} from "@desplega/storage-sqlite";
