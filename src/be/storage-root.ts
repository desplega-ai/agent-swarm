/**
 * Storage composition root: the only `src/` file that imports an engine
 * package (check:dep-graph). Everything else in `src/` imports the contracts
 * package `@desplega/storage` and asks `getStorage()` for repositories.
 */
import type { DbClient, StatementObserver, Storage } from "@desplega/storage";
import {
  type BusyRetryOptions,
  createBunSqliteClient,
  createSqliteStorage,
  isInTransaction as sqliteIsInTransaction,
} from "@desplega/storage-sqlite";
import { scrubSecrets } from "../utils/secret-scrubber";
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

// SQLite boot (the synchronous start path of the SQLite engine).
export {
  applySqliteFilePragmas,
  applySqliteTemplatePragmas,
  assertNotEmptySqliteDatabase,
  assertScriptRunSourceSchema,
  backfillScriptRunSources,
  ensureAgentProfileColumns,
  existingUserIdsSync,
  findDefaultOAuthAuthorization,
  hasEncryptedSecretRows,
  isEmptySqliteDatabase,
  type LegacyCredentialBinding,
  listCredentialBindingBlobs,
  listPlaintextOAuthSecrets,
  readAssetKeyAuditDataSync,
  removeLegacyTaskStatusCheck,
  replaceCredentialBindingBlob,
  runSqliteMigrations,
  storeEncryptedOAuthSecrets,
} from "@desplega/storage-sqlite";
