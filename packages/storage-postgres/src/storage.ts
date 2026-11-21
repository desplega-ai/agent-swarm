import {
  type Capabilities,
  type DbClient,
  SqlExecutor,
  type Storage,
  type TransactionOptions,
} from "@desplega/storage";
import { postgresDialect } from "./dialect";
import { PostgresAgentFsWebhooksRepository } from "./repositories/agent-fs-webhooks";
import { PostgresAgentsRepository } from "./repositories/agents";
import { PostgresAssetsRepository } from "./repositories/assets";
import { PostgresChatRepository } from "./repositories/chat";
import { PostgresConfigRepository } from "./repositories/config";
import { PostgresEventsRepository } from "./repositories/events";
import { PostgresExtensionsRepository } from "./repositories/extensions";
import { PostgresImprovementsRepository } from "./repositories/improvements";
import { PostgresKvRepository } from "./repositories/kv";
import { PostgresMaintenanceRepository } from "./repositories/maintenance";
import { PostgresMcpServersRepository } from "./repositories/mcp-servers";
import { PostgresMemoryRepository } from "./repositories/memory";
import { PostgresModelsRepository } from "./repositories/models";
import { PostgresOAuthRepository } from "./repositories/oauth";
import { PostgresPagesRepository } from "./repositories/pages";
import { PostgresRbacRepository } from "./repositories/rbac";
import { PostgresRuntimePoolsRepository } from "./repositories/runtime-pools";
import { PostgresSavingsRepository } from "./repositories/savings";
import { PostgresSchedulesRepository } from "./repositories/schedules";
import { PostgresScriptsRepository } from "./repositories/scripts";
import { PostgresSessionsRepository } from "./repositories/sessions";
import { PostgresSkillsRepository } from "./repositories/skills";
import { PostgresSlackRepository } from "./repositories/slack";
import { PostgresTasksRepository } from "./repositories/tasks";
import { PostgresTrackersRepository } from "./repositories/trackers";
import { PostgresUsersRepository } from "./repositories/users";
import { PostgresWorkflowsRepository } from "./repositories/workflows";

export type PostgresStorageOptions = {
  /** pgvector is installed in the database. */
  vectorSearch: boolean;
  /** `DATABASE_QUERY_URL` passed its restricted-role probe (decision D10). */
  dbQuery: boolean;
};

/** Assemble the Postgres engine over an open Postgres client. */
export function createPostgresStorage(client: DbClient, options: PostgresStorageOptions): Storage {
  const executor = new SqlExecutor(client, postgresDialect);
  const capabilities: Capabilities = {
    fullTextSearch: true,
    vectorSearch: options.vectorSearch,
    dbQuery: options.dbQuery,
    dbQueryDialect: "postgres",
  };
  return {
    dialect: postgresDialect,
    capabilities,
    executor,
    client,
    repos: {
      extensions: new PostgresExtensionsRepository(executor),
      models: new PostgresModelsRepository(executor),
      runtimePools: new PostgresRuntimePoolsRepository(executor),
      config: new PostgresConfigRepository(executor),
      agents: new PostgresAgentsRepository(executor),
      maintenance: new PostgresMaintenanceRepository(executor),
      assets: new PostgresAssetsRepository(executor),
      users: new PostgresUsersRepository(executor),
      rbac: new PostgresRbacRepository(executor),
      mcpServers: new PostgresMcpServersRepository(executor),
      trackers: new PostgresTrackersRepository(executor),
      events: new PostgresEventsRepository(executor),
      chat: new PostgresChatRepository(executor),
      oauth: new PostgresOAuthRepository(executor),
      slack: new PostgresSlackRepository(executor),
      workflows: new PostgresWorkflowsRepository(executor),
      scripts: new PostgresScriptsRepository(executor),
      pages: new PostgresPagesRepository(executor),
      skills: new PostgresSkillsRepository(executor),
      kv: new PostgresKvRepository(executor),
      tasks: new PostgresTasksRepository(executor),
      memory: new PostgresMemoryRepository(executor),
      schedules: new PostgresSchedulesRepository(executor),
      agentFsWebhooks: new PostgresAgentFsWebhooksRepository(executor),
      improvements: new PostgresImprovementsRepository(executor),
      sessions: new PostgresSessionsRepository(executor),
      savings: new PostgresSavingsRepository(executor),
    },
    transaction: <T>(fn: () => Promise<T>, opts?: TransactionOptions) =>
      client.transaction(() => fn(), opts),
    afterCommit: (fn) => client.afterCommit(fn),
    afterRollback: (fn) => client.afterRollback(fn),
    onAttemptRollback: (fn) => client.onAttemptRollback(fn),
    inTransaction: () => client.inTransaction(),
  };
}
