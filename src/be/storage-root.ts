/**
 * Storage composition root: the only `src/` file that imports an engine
 * package (check:dep-graph). Everything else in `src/` imports the contracts
 * package `@desplega/storage` and asks `getStorage()` for repositories.
 */
import type {
  DbClient,
  PromptTemplateFilters,
  PromptTemplateHistoryRow,
  PromptTemplateRecordUpdate,
  PromptTemplateRow,
  StatementObserver,
  Storage,
} from "@desplega/storage";
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
import { getDb } from "./db/runtime";
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
  return sqliteIsInTransaction();
}

export function createStorage(client: DbClient, options: { vectorSearch: boolean }): Storage {
  return createSqliteStorage(client, options);
}

/**
 * The live engine handle. Its identity changes when the database is closed
 * and opened again, so once-per-database guards key on it (src/be/boot-seeds.ts).
 * SQLite: the current bun:sqlite Database.
 */
export function currentEngineHandle(): object {
  return getDb();
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
