import type { Database } from "bun:sqlite";
import {
  type Capabilities,
  type DbClient,
  type MemoryReadExecutor,
  SqlExecutor,
  type Storage,
  type TransactionOptions,
} from "@desplega/storage";
import { sqliteDialect } from "./dialect";
import { SqliteMemoryIndexes } from "./memory/indexes";
import { SqliteAgentFsWebhooksRepository } from "./repositories/agent-fs-webhooks";
import { SqliteAgentsRepository } from "./repositories/agents";
import { SqliteAssetsRepository } from "./repositories/assets";
import { SqliteChatRepository } from "./repositories/chat";
import { SqliteConfigRepository } from "./repositories/config";
import { SqliteEventsRepository } from "./repositories/events";
import { SqliteExtensionsRepository } from "./repositories/extensions";
import { SqliteImprovementsRepository } from "./repositories/improvements";
import { SqliteKvRepository } from "./repositories/kv";
import { SqliteMaintenanceRepository } from "./repositories/maintenance";
import { SqliteMcpServersRepository } from "./repositories/mcp-servers";
import { SqliteMemoryRepository } from "./repositories/memory";
import { SqliteMessagingRepository } from "./repositories/messaging";
import { SqliteModelsRepository } from "./repositories/models";
import { SqliteOAuthRepository } from "./repositories/oauth";
import { SqlitePagesRepository } from "./repositories/pages";
import { SqlitePromptTemplatesRepository } from "./repositories/prompt-templates";
import { SqliteRbacRepository } from "./repositories/rbac";
import { SqliteRetentionRepository } from "./repositories/retention";
import { SqliteRuntimePoolsRepository } from "./repositories/runtime-pools";
import { SqliteSavingsRepository } from "./repositories/savings";
import { SqliteSchedulesRepository } from "./repositories/schedules";
import { SqliteScriptRunnersRepository } from "./repositories/script-runners";
import { SqliteScriptsRepository } from "./repositories/scripts";
import { SqliteSessionsRepository } from "./repositories/sessions";
import { SqliteSkillsRepository } from "./repositories/skills";
import { SqliteSlackRepository } from "./repositories/slack";
import { SqliteTasksRepository } from "./repositories/tasks";
import { SqliteTrackersRepository } from "./repositories/trackers";
import { SqliteUsersRepository } from "./repositories/users";
import { SqliteWorkflowsRepository } from "./repositories/workflows";

export {
  type BusyRetryOptions,
  createBunSqliteClient,
  isInTransaction,
  SLOW_STATEMENT_WARN_MS,
  type SqliteClientOptions,
} from "./client";
export { sqliteDialect } from "./dialect";

export type SqliteStorageOptions = {
  /** sqlite-vec loaded into the connection. */
  vectorSearch: boolean;
  /**
   * The raw handle behind `client`, for the run-time memory indexes
   * (`memory_fts`, `memory_vec`). Without it those indexes throw when used.
   */
  database?: () => Database;
  /** The off-loop memory search reader (createSqliteMemorySearchReader). */
  memorySearchReader?: MemoryReadExecutor;
};

function noRawHandle(): Database {
  throw new Error(
    "[storage-sqlite] the memory indexes need the raw handle: pass `database` to createSqliteStorage",
  );
}

/** Assemble the SQLite engine over an existing bun:sqlite client. */
export function createSqliteStorage(client: DbClient, options: SqliteStorageOptions): Storage {
  const executor = new SqlExecutor(client, sqliteDialect);
  const capabilities: Capabilities = {
    scriptRunners: false,
    fullTextSearch: true,
    vectorSearch: options.vectorSearch,
    dbQuery: true,
    dbQueryDialect: "sqlite",
  };
  return {
    dialect: sqliteDialect,
    capabilities,
    executor,
    client,
    memoryIndexes: new SqliteMemoryIndexes({
      database: options.database ?? noRawHandle,
      vectorSearch: options.vectorSearch,
      searchReader: options.memorySearchReader,
    }),
    repos: {
      extensions: new SqliteExtensionsRepository(executor),
      models: new SqliteModelsRepository(executor),
      scriptRunners: new SqliteScriptRunnersRepository(executor),
      runtimePools: new SqliteRuntimePoolsRepository(executor),
      config: new SqliteConfigRepository(executor),
      agents: new SqliteAgentsRepository(executor),
      maintenance: new SqliteMaintenanceRepository(executor),
      assets: new SqliteAssetsRepository(executor),
      users: new SqliteUsersRepository(executor),
      rbac: new SqliteRbacRepository(executor),
      mcpServers: new SqliteMcpServersRepository(executor),
      trackers: new SqliteTrackersRepository(executor),
      events: new SqliteEventsRepository(executor),
      chat: new SqliteChatRepository(executor),
      oauth: new SqliteOAuthRepository(executor),
      slack: new SqliteSlackRepository(executor),
      workflows: new SqliteWorkflowsRepository(executor),
      scripts: new SqliteScriptsRepository(executor),
      pages: new SqlitePagesRepository(executor),
      skills: new SqliteSkillsRepository(executor),
      kv: new SqliteKvRepository(executor),
      tasks: new SqliteTasksRepository(executor),
      memory: new SqliteMemoryRepository(executor),
      schedules: new SqliteSchedulesRepository(executor),
      agentFsWebhooks: new SqliteAgentFsWebhooksRepository(executor),
      improvements: new SqliteImprovementsRepository(executor),
      sessions: new SqliteSessionsRepository(executor),
      savings: new SqliteSavingsRepository(executor),
      retention: new SqliteRetentionRepository(executor),
      messaging: new SqliteMessagingRepository(executor),
      promptTemplates: new SqlitePromptTemplatesRepository(executor),
    },
    transaction: <T>(fn: () => Promise<T>, opts?: TransactionOptions) =>
      client.transaction(() => fn(), opts),
    afterCommit: (fn) => client.afterCommit(fn),
    afterRollback: (fn) => client.afterRollback(fn),
    onAttemptRollback: (fn) => client.onAttemptRollback(fn),
    inTransaction: () => client.inTransaction(),
  };
}
export { ensureAgentProfileColumns, removeLegacyTaskStatusCheck } from "./boot/legacy";
export {
  type AgentProfileFields,
  type CredentialBindingBlobRow,
  findDefaultOAuthAuthorization,
  hasContextVersion,
  insertFirstContextVersion,
  type LegacyCredentialBinding,
  listAgentProfileFields,
  listCredentialBindingBlobs,
  listPlaintextOAuthSecrets,
  listPlaintextSecretConfigs,
  type PlaintextOAuthApp,
  type PlaintextOAuthAuthorization,
  type PlaintextSecretConfig,
  replaceCredentialBindingBlob,
  storeEncryptedOAuthSecrets,
  storeEncryptedSecretConfigs,
} from "./boot/legacy-data";
export {
  assertNotEmptySqliteDatabase,
  runSqliteMigrations,
  type SqliteMigrationOptions,
} from "./boot/migrations";
export {
  applySqliteFilePragmas,
  applySqliteTemplatePragmas,
  isEmptySqliteDatabase,
} from "./boot/open";
export { normalizeScheduleNextRunTimes } from "./boot/schedule-next-run-at";
export { assertScriptRunSourceSchema, backfillScriptRunSources } from "./boot/script-run-sources";
export { hasEncryptedSecretRows, type SealedColumn } from "./boot/secrets-probe";
export { openSqliteCopySource } from "./copy-source";
export {
  assertNoDeniedTablesSqlite,
  executeSqliteReadOnlyQuery,
  getDbQueryWorkerPidsForTests,
  isReportableTimeout,
  openSqliteQueryReader,
  resetDbQueryWorkerPoolForTests,
  runSqliteBoundedQuery,
  type SqliteBoundedQuery,
  SqliteQuerySpawnUnavailableError,
} from "./db-query";
export {
  createSqliteMemorySearchReader,
  SEARCH_READ_WORKERS,
  type SqliteMemorySearchReader,
  type SqliteMemorySearchReaderDeps,
} from "./memory/search-reader";
export { existingUserIdsSync, readAssetKeyAuditDataSync } from "./repositories/assets";
export { KEY_WINDOW_USAGE_SQL } from "./repositories/key-window-usage";
export { FTS_SCAN_BATCH_SQL, MEMORY_ID_BATCH_SQL } from "./repositories/memory";
export {
  insertPromptTemplateHistorySync,
  insertPromptTemplateSync,
  listPromptTemplatesSync,
  updatePromptTemplateRecordSync,
} from "./repositories/prompt-templates";
export {
  type RetentionSweepStatements,
  retentionSweepStatements,
  workflowRetentionCandidatesSql,
  workflowRunRetentionStatements,
} from "./repositories/retention";
export {
  quoteSqlIdentifier,
  USER_REFERENCE_COLUMNS_SQL,
  userReferenceRewriteSql,
  WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL,
  WORKFLOW_CONTEXT_REQUESTER_SQL,
  WORKFLOW_CONTEXT_SET_REQUESTER_SQL,
  WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL,
} from "./repositories/user-references";
