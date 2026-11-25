import type { Capabilities } from "./capabilities";
import type { DbClient, TransactionOptions } from "./client";
import type { Dialect } from "./dialect";
import type { SqlExecutor } from "./executor";
import type { MemorySearchIndexes } from "./memory-indexes";
import type { QueryReader } from "./query-reader";
import type { AgentFsWebhooksRepository } from "./repositories/agent-fs-webhooks";
import type { AgentsRepository } from "./repositories/agents";
import type { AssetsRepository } from "./repositories/assets";
import type { ChatRepository } from "./repositories/chat";
import type { ConfigRepository } from "./repositories/config";
import type { EventsRepository } from "./repositories/events";
import type { ExtensionsRepository } from "./repositories/extensions";
import type { ImprovementsRepository } from "./repositories/improvements";
import type { KvRepository } from "./repositories/kv";
import type { MaintenanceRepository } from "./repositories/maintenance";
import type { McpServersRepository } from "./repositories/mcp-servers";
import type { MemoryRepository } from "./repositories/memory";
import type { MessagingRepository } from "./repositories/messaging";
import type { ModelsRepository } from "./repositories/models";
import type { OAuthRepository } from "./repositories/oauth";
import type { PagesRepository } from "./repositories/pages";
import type { PromptTemplatesRepository } from "./repositories/prompt-templates";
import type { RbacRepository } from "./repositories/rbac";
import type { RetentionRepository } from "./repositories/retention";
import type { RuntimePoolsRepository } from "./repositories/runtime-pools";
import type { SavingsRepository } from "./repositories/savings";
import type { SchedulesRepository } from "./repositories/schedules";
import type { ScriptRunnersRepository } from "./repositories/script-runners";
import type { ScriptsRepository } from "./repositories/scripts";
import type { SessionsRepository } from "./repositories/sessions";
import type { SkillsRepository } from "./repositories/skills";
import type { SlackRepository } from "./repositories/slack";
import type { TasksRepository } from "./repositories/tasks";
import type { TrackersRepository } from "./repositories/trackers";
import type { UsersRepository } from "./repositories/users";
import type { WorkflowsRepository } from "./repositories/workflows";

/** Every domain repository, by domain name. */
export type Repositories = {
  scriptRunners: ScriptRunnersRepository;
  extensions: ExtensionsRepository;
  models: ModelsRepository;
  runtimePools: RuntimePoolsRepository;
  config: ConfigRepository;
  agents: AgentsRepository;
  maintenance: MaintenanceRepository;
  assets: AssetsRepository;
  users: UsersRepository;
  rbac: RbacRepository;
  mcpServers: McpServersRepository;
  trackers: TrackersRepository;
  events: EventsRepository;
  chat: ChatRepository;
  oauth: OAuthRepository;
  slack: SlackRepository;
  workflows: WorkflowsRepository;
  scripts: ScriptsRepository;
  pages: PagesRepository;
  skills: SkillsRepository;
  kv: KvRepository;
  tasks: TasksRepository;
  memory: MemoryRepository;
  schedules: SchedulesRepository;
  agentFsWebhooks: AgentFsWebhooksRepository;
  improvements: ImprovementsRepository;
  sessions: SessionsRepository;
  savings: SavingsRepository;
  retention: RetentionRepository;
  messaging: MessagingRepository;
  promptTemplates: PromptTemplatesRepository;
};

/**
 * One engine, assembled: its repositories, its capabilities and the
 * transaction entry point. The API server holds exactly one.
 */
export interface Storage {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  readonly repos: Repositories;
  /** The executor the repositories share. */
  readonly executor: SqlExecutor;
  /**
   * The engine client. Exposed only for the transition while call sites move
   * into repositories; check:storage-boundary rejects new uses outside the
   * storage packages.
   */
  readonly client: DbClient;
  /**
   * The read-only connection of `db-query` (decision D10), when the engine has
   * one apart from its own handle. Set exactly when the Postgres engine has the
   * `dbQuery` capability. SQLite opens its read-only handle itself.
   */
  readonly queryReader?: QueryReader;
  /** The memory full-text and vector indexes, and the engine's off-loop memory search reader. */
  readonly memoryIndexes: MemorySearchIndexes;
  /**
   * Run `fn` atomically. Repository calls inside it join the transaction. The
   * callback may run more than once (decision D6): side effects go in
   * `afterCommit`.
   */
  transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T>;
  afterCommit(fn: () => void | Promise<void>): void;
  afterRollback(fn: () => void): void;
  onAttemptRollback(fn: () => void): void;
  inTransaction(): boolean;
}
