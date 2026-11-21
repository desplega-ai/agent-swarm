import {
  type Capabilities,
  type DbClient,
  SqlExecutor,
  type Storage,
  type TransactionOptions,
} from "@desplega/storage";
import { sqliteDialect } from "./dialect";
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
import { SqliteModelsRepository } from "./repositories/models";
import { SqliteOAuthRepository } from "./repositories/oauth";
import { SqlitePagesRepository } from "./repositories/pages";
import { SqliteRbacRepository } from "./repositories/rbac";
import { SqliteRuntimePoolsRepository } from "./repositories/runtime-pools";
import { SqliteSchedulesRepository } from "./repositories/schedules";
import { SqliteScriptsRepository } from "./repositories/scripts";
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
};

/** Assemble the SQLite engine over an existing bun:sqlite client. */
export function createSqliteStorage(client: DbClient, options: SqliteStorageOptions): Storage {
  const executor = new SqlExecutor(client, sqliteDialect);
  const capabilities: Capabilities = {
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
    repos: {
      extensions: new SqliteExtensionsRepository(executor),
      models: new SqliteModelsRepository(executor),
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
  type CredentialBindingBlobRow,
  findDefaultOAuthAuthorization,
  type LegacyCredentialBinding,
  listCredentialBindingBlobs,
  listPlaintextOAuthSecrets,
  type PlaintextOAuthApp,
  type PlaintextOAuthAuthorization,
  replaceCredentialBindingBlob,
  storeEncryptedOAuthSecrets,
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
export { assertScriptRunSourceSchema, backfillScriptRunSources } from "./boot/script-run-sources";
export { hasEncryptedSecretRows, type SealedColumn } from "./boot/secrets-probe";
export { existingUserIdsSync, readAssetKeyAuditDataSync } from "./repositories/assets";
export { FTS_SCAN_BATCH_SQL, MEMORY_ID_BATCH_SQL } from "./repositories/memory";
