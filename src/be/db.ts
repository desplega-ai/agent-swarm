import { Database } from "bun:sqlite";
import { parseProviderMeta } from "@/utils/provider-metadata.ts";
import pkg from "../../package.json";
import { configureDbResolver } from "../prompts/resolver";
import { telemetry } from "../telemetry";
import type {
  ActiveSession,
  Agent,
  AgentCredStatus,
  AgentLog,
  AgentLogEventType,
  AgentMcpServer,
  AgentSkill,
  AgentStatus,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentWithTasks,
  Budget,
  BudgetRefusalCause,
  BudgetRefusalNotification,
  BudgetScope,
  ChangeSource,
  Channel,
  ChannelMessage,
  ChannelType,
  ContextSnapshot,
  ContextSnapshotEventType,
  ContextVersion,
  CooldownConfig,
  FollowUpConfig,
  InboxItemState,
  InboxItemStatus,
  InboxItemType,
  InboxMessage,
  InboxMessageStatus,
  InputValue,
  KvEntry,
  KvValueType,
  McpServer,
  McpServerScope,
  McpServerTransport,
  McpServerWithInstallInfo,
  Metric,
  MetricDefinition,
  MetricSnapshot,
  MetricSummary,
  MetricVersion,
  Page,
  PageAuthMode,
  PageContentType,
  PageSnapshot,
  PageSummary,
  PageVersion,
  PricingProvider,
  PricingRow,
  PricingTokenClass,
  PromptTemplate,
  PromptTemplateHistory,
  ProviderName,
  RepoGuidelines,
  ScheduledTask,
  ScheduledTaskSummary,
  ScriptRun,
  ScriptRunJournalEntry,
  ScriptRunKind,
  ScriptRunListItem,
  ScriptRunStatus,
  Service,
  ServiceStatus,
  SessionCost,
  SessionCostSource,
  SessionLog,
  Skill,
  SkillFile,
  SkillScope,
  SkillType,
  SkillWithInstallInfo,
  SwarmConfig,
  SwarmRepo,
  TaskAttachment,
  TaskTemplate,
  TaskTemplateKind,
  TriggerConfig,
  User,
  VersionableField,
  VersionMeta,
  WaitMode,
  WaitStateRow,
  WaitStateStatus,
  Workflow,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunStepStatus,
  WorkflowSnapshot,
  WorkflowSummary,
  WorkflowVersion,
} from "../types";
import {
  FollowUpConfigSchema,
  isTerminalTaskStatus,
  type ModelTier,
  parseModelTier,
} from "../types";
import { deriveProviderFromKeyType } from "../utils/credentials";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";
import { getCurrentRequestUserId } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { decryptSecret, encryptSecret, getEncryptionKey, resolveEncryptionKey } from "./crypto";
import { normalizeDate, normalizeDateRequired } from "./date-utils";
import { runMigrations } from "./migrations/runner";
import { seedDefaultTemplates } from "./seed-prompt-templates";
import { isReservedConfigKey, reservedKeyError } from "./swarm-config-guard";
import { emitTaskStarted } from "./task-lifecycle-events";

let db: Database | null = null;
let sqliteVecAvailable = false;

type TaskTelemetryProps = Parameters<typeof telemetry.taskEvent>[1];
type TaskTelemetryContext = {
  provider?: ProviderName;
  harnessVariant?: string;
  harnessVersion?: string;
};

function emitTaskLifecycleTelemetryAfterCommit(
  event: string,
  props: TaskTelemetryProps,
  verify?: (task: AgentTask | null) => boolean,
): void {
  queueMicrotask(() => {
    if (verify && !verify(getTaskById(props.taskId))) return;
    telemetry.taskEvent(event, props);
  });
}

function taskContextForTelemetry(task: AgentTask): TaskTelemetryContext {
  const harnessVersion = task.harnessVariantMeta?.version;
  const context: TaskTelemetryContext = {};
  if (task.provider) context.provider = task.provider;
  if (task.harnessVariant) context.harnessVariant = task.harnessVariant;
  if (typeof harnessVersion === "string" || typeof harnessVersion === "number") {
    context.harnessVersion = String(harnessVersion);
  }
  return context;
}

export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
}

function loadSqliteVec(database: Database): void {
  sqliteVecAvailable = false;
  try {
    const extensionPath = process.env.SQLITE_VEC_EXTENSION_PATH;
    if (extensionPath) {
      database.loadExtension(extensionPath);
    } else {
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(database);
    }
    sqliteVecAvailable = true;
    console.log(`[db] sqlite-vec loaded${extensionPath ? ` from ${extensionPath}` : ""}`);
  } catch (err) {
    console.warn(
      "[db] sqlite-vec not available, falling back to in-memory cosine:",
      (err as Error).message,
    );
  }
}

export function initDb(dbPath = "./agent-swarm-db.sqlite"): Database {
  if (db) {
    return db;
  }

  // Fast path for tests: restore from pre-built template that already has
  // migrations, seeds, and all post-init work baked in. Only the per-connection
  // PRAGMA and the in-memory resolver function need to be set.
  const templateGlobals = globalThis as typeof globalThis & {
    __testMigrationTemplate?: Uint8Array;
  };
  const templateBytes = templateGlobals.__testMigrationTemplate;
  if (templateBytes) {
    db = Database.deserialize(templateBytes);
    db.run("PRAGMA busy_timeout = 5000;");
    db.run("PRAGMA foreign_keys = ON;");
    loadSqliteVec(db);
    configureDbResolver(resolvePromptTemplate);
    // Ensure the encryption key is resolved even when restoring from the test
    // template. The cache may have been cleared via __resetEncryptionKeyForTests
    // between test suites; this call is a no-op if the cache is already warm.
    resolveEncryptionKey(dbPath);
    return db;
  }

  db = new Database(dbPath, { create: true });
  console.log(`Database initialized at ${dbPath}`);

  const database = db;
  database.run("PRAGMA journal_mode = WAL;");
  database.run("PRAGMA busy_timeout = 5000;");
  database.run("PRAGMA foreign_keys = ON;");
  database.run("PRAGMA synchronous = NORMAL;");
  database.run("PRAGMA cache_size = -64000;");
  database.run("PRAGMA mmap_size = 268435456;");
  database.run("PRAGMA temp_store = MEMORY;");

  // Load sqlite-vec extension for vector search.
  // In compiled binaries (`bun build --compile`) the JS lives in /$bunfs/ and
  // `require.resolve("sqlite-vec-<platform>/vec0.so")` can't find the native
  // asset — so we prefer an explicit filesystem path when set, and only fall
  // back to the npm resolver for normal dev runs.
  loadSqliteVec(database);

  // Run database migrations (schema creation + incremental changes)
  runMigrations(database);

  // Compatibility migration for legacy databases that predate profile fields
  ensureAgentProfileColumns(database);

  // Migration: Remove restrictive CHECK constraint on agent_tasks.status
  // Old databases have CHECK(status IN ('pending','in_progress','completed','failed'))
  // which blocks 'cancelled', 'paused', 'offered', 'unassigned' statuses
  try {
    const taskSchemaInfo = db
      .prepare<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'",
      )
      .get();

    const schemaSql = taskSchemaInfo?.sql ?? "";
    const hasStatusCheck = /status\s+TEXT\b[^,]*\bCHECK\s*\(\s*status\s+IN\s*\(/i.test(schemaSql);
    const statusAllowsCancelled = /status\s+IN\s*\([^)]*'cancelled'/i.test(schemaSql);
    const needsStatusMigration = hasStatusCheck && !statusAllowsCancelled;

    if (needsStatusMigration) {
      console.log("[Migration] Removing restrictive CHECK constraint on agent_tasks.status");
      db.run("PRAGMA foreign_keys=off");

      db.run(`
        CREATE TABLE agent_tasks_new (
          id TEXT PRIMARY KEY,
          agentId TEXT,
          creatorAgentId TEXT,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'agentmail', 'system', 'schedule')),
          taskType TEXT,
          tags TEXT DEFAULT '[]',
          priority INTEGER DEFAULT 50,
          dependsOn TEXT DEFAULT '[]',
          offeredTo TEXT,
          offeredAt TEXT,
          acceptedAt TEXT,
          rejectionReason TEXT,
          slackChannelId TEXT,
          slackThreadTs TEXT,
          slackUserId TEXT,
          createdAt TEXT NOT NULL,
          lastUpdatedAt TEXT NOT NULL,
          finishedAt TEXT,
          failureReason TEXT,
          output TEXT,
          progress TEXT,
          notifiedAt TEXT,
          mentionMessageId TEXT,
          mentionChannelId TEXT,
          githubRepo TEXT,
          githubEventType TEXT,
          githubNumber INTEGER,
          githubCommentId INTEGER,
          githubAuthor TEXT,
          githubUrl TEXT,
          parentTaskId TEXT,
          claudeSessionId TEXT,
          agentmailInboxId TEXT,
          agentmailMessageId TEXT,
          agentmailThreadId TEXT,
          model TEXT,
          scheduleId TEXT
        )
      `);

      // Copy all data — use column list to handle any column ordering differences
      db.run(`
        INSERT INTO agent_tasks_new (
          id, agentId, creatorAgentId, task, status, source, taskType, tags,
          priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
          slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt,
          finishedAt, failureReason, output, progress, notifiedAt,
          mentionMessageId, mentionChannelId, githubRepo, githubEventType,
          githubNumber, githubCommentId, githubAuthor, githubUrl,
          parentTaskId, claudeSessionId,
          agentmailInboxId, agentmailMessageId, agentmailThreadId,
          model, scheduleId
        )
        SELECT
          id, agentId, creatorAgentId, task, status, source, taskType, tags,
          priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
          slackChannelId, slackThreadTs, slackUserId, createdAt, lastUpdatedAt,
          finishedAt, failureReason, output, progress, notifiedAt,
          mentionMessageId, mentionChannelId, githubRepo, githubEventType,
          githubNumber, githubCommentId, githubAuthor, githubUrl,
          parentTaskId, claudeSessionId,
          agentmailInboxId, agentmailMessageId, agentmailThreadId,
          model, scheduleId
        FROM agent_tasks
      `);

      db.run("DROP TABLE agent_tasks");
      db.run("ALTER TABLE agent_tasks_new RENAME TO agent_tasks");

      // Recreate all indexes
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType)");
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId)",
      );
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId)");

      db.run("PRAGMA foreign_keys=on");
      console.log("[Migration] Successfully removed CHECK constraint on agent_tasks.status");
    }
  } catch (e) {
    console.error("[Migration] Failed to update agent_tasks CHECK constraint:", e);
    try {
      db.run("PRAGMA foreign_keys=on");
    } catch (cleanupError) {
      console.error("[Migration] Failed to re-enable SQLite foreign_keys pragma:", cleanupError);
    }
    throw e;
  }

  // Backfill: Seed v1 for existing agents that don't have any context versions yet
  seedContextVersions();

  // Inject DB resolver into the prompt template resolver (DI to avoid worker/API boundary violation)
  configureDbResolver(resolvePromptTemplate);

  // Seed default prompt templates from the in-memory code registry
  seedDefaultTemplates();

  const hasExistingEncryptedSecrets =
    (database
      .prepare<{ present: number }, []>(
        "SELECT EXISTS(SELECT 1 FROM swarm_config WHERE isSecret = 1 AND encrypted = 1) as present",
      )
      .get()?.present ?? 0) === 1;

  // Track whether user provided the key (for backup decision)
  const userProvidedKey = !!(
    process.env.SECRETS_ENCRYPTION_KEY?.length || process.env.SECRETS_ENCRYPTION_KEY_FILE?.length
  );

  // Resolve the secrets encryption key after migrations so we can tell whether
  // this DB already contains encrypted secret rows (must reuse an explicit or
  // on-disk key) or is still plaintext-only (safe to generate a new key before
  // auto-migrating legacy plaintext rows).
  resolveEncryptionKey(dbPath, { allowGenerate: !hasExistingEncryptedSecrets });

  // Auto-encrypt any legacy plaintext secrets that predate the encryption
  // feature. Runs after all compatibility guards; failures are fatal because
  // continuing would leave secrets at rest in plaintext — the opposite of the
  // guarantee this feature provides.
  try {
    autoEncryptLegacyPlaintextSecrets(database, dbPath, { createBackup: !userProvidedKey });
  } catch (err) {
    console.error(
      `[secrets] FATAL: failed to auto-encrypt legacy secrets: ${(err as Error).message}`,
    );
    throw err;
  }

  return db;
}

export function getDb(path?: string): Database {
  if (!db) {
    return initDb(path ?? process.env.DATABASE_PATH);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  sqliteVecAvailable = false;
}

// ============================================================================
// Context Versioning
// ============================================================================

const VERSIONABLE_FIELDS: VersionableField[] = [
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "setupScript",
  "heartbeatMd",
];

function ensureAgentProfileColumns(database: Database): void {
  const existingColumns = new Set(
    database
      .prepare<{ name: string }, []>("PRAGMA table_info(agents)")
      .all()
      .map((row) => row.name),
  );

  for (const column of VERSIONABLE_FIELDS) {
    if (!existingColumns.has(column)) {
      try {
        database.run(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
      } catch (error) {
        console.error(`[Migration] Failed to add missing agents.${column} column`, error);
        throw error;
      }
    }
  }
}

export function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

type ContextVersionRow = {
  id: string;
  agentId: string;
  field: string;
  content: string;
  version: number;
  changeSource: string;
  changedByAgentId: string | null;
  changeReason: string | null;
  contentHash: string;
  previousVersionId: string | null;
  createdAt: string;
};

function rowToContextVersion(row: ContextVersionRow): ContextVersion {
  return {
    id: row.id,
    agentId: row.agentId,
    field: row.field as VersionableField,
    content: row.content,
    version: row.version,
    changeSource: row.changeSource as ChangeSource,
    changedByAgentId: row.changedByAgentId,
    changeReason: row.changeReason,
    contentHash: row.contentHash,
    previousVersionId: row.previousVersionId,
    createdAt: row.createdAt,
  };
}

export function createContextVersion(params: {
  agentId: string;
  field: VersionableField;
  content: string;
  version: number;
  changeSource: ChangeSource;
  changedByAgentId?: string | null;
  changeReason?: string | null;
  contentHash: string;
  previousVersionId?: string | null;
}): ContextVersion {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ContextVersionRow,
      [
        string,
        string,
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
      ]
    >(
      `INSERT INTO context_versions (id, agentId, field, content, version, changeSource, changedByAgentId, changeReason, contentHash, previousVersionId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      params.agentId,
      params.field,
      params.content,
      params.version,
      params.changeSource,
      params.changedByAgentId ?? null,
      params.changeReason ?? null,
      params.contentHash,
      params.previousVersionId ?? null,
      now,
    );

  if (!row) throw new Error("Failed to create context version");
  return rowToContextVersion(row);
}

export function getLatestContextVersion(
  agentId: string,
  field: VersionableField,
): ContextVersion | null {
  const row = getDb()
    .prepare<ContextVersionRow, [string, string]>(
      `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(agentId, field);

  return row ? rowToContextVersion(row) : null;
}

export function getContextVersion(id: string): ContextVersion | null {
  const row = getDb()
    .prepare<ContextVersionRow, [string]>(`SELECT * FROM context_versions WHERE id = ?`)
    .get(id);

  return row ? rowToContextVersion(row) : null;
}

export function getContextVersionHistory(params: {
  agentId: string;
  field?: VersionableField;
  limit?: number;
}): ContextVersion[] {
  const limit = params.limit ?? 10;

  if (params.field) {
    const rows = getDb()
      .prepare<ContextVersionRow, [string, string, number]>(
        `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT ?`,
      )
      .all(params.agentId, params.field, limit);
    return rows.map(rowToContextVersion);
  }

  const rows = getDb()
    .prepare<ContextVersionRow, [string, number]>(
      `SELECT * FROM context_versions WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?`,
    )
    .all(params.agentId, limit);
  return rows.map(rowToContextVersion);
}

/**
 * Seed v1 context versions for existing agents that don't have any versions yet.
 * Called during migration.
 */
function seedContextVersions(): void {
  const database = getDb();
  const agents = database
    .prepare<
      {
        id: string;
        soulMd: string | null;
        identityMd: string | null;
        toolsMd: string | null;
        claudeMd: string | null;
        setupScript: string | null;
        heartbeatMd: string | null;
      },
      []
    >(`SELECT id, soulMd, identityMd, toolsMd, claudeMd, setupScript, heartbeatMd FROM agents`)
    .all();

  for (const agent of agents) {
    for (const field of VERSIONABLE_FIELDS) {
      const content = agent[field];
      if (!content) continue;

      // Check if a version already exists for this agent+field
      const existing = database
        .prepare<{ id: string }, [string, string]>(
          `SELECT id FROM context_versions WHERE agentId = ? AND field = ? LIMIT 1`,
        )
        .get(agent.id, field);
      if (existing) continue;

      const id = crypto.randomUUID();
      const hash = computeContentHash(content);
      const now = new Date().toISOString();

      database
        .prepare(
          `INSERT INTO context_versions (id, agentId, field, content, version, changeSource, contentHash, createdAt)
           VALUES (?, ?, ?, ?, 1, 'system', ?, ?)`,
        )
        .run(id, agent.id, field, content, hash, now);
    }
  }
}

// ============================================================================
// Agent Queries
// ============================================================================

type AgentRow = {
  id: string;
  name: string;
  isLead: number;
  status: AgentStatus;
  description: string | null;
  role: string | null;
  capabilities: string | null;
  maxTasks: number | null;
  emptyPollCount: number | null;
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  setupScript: string | null;
  toolsMd: string | null;
  heartbeatMd: string | null;
  lastActivityAt: string | null;
  provider: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  /** JSON array of env-var names; populated only when status is `waiting_for_credentials`. */
  credentialMissing: string | null;
  /** Phase 1.5: per-agent harness provider pushed on worker registration. */
  harness_provider: string | null;
  /** Migration 055: worker-self-reported credential snapshot (JSON of AgentCredStatus). NULL = unreported. */
  cred_status: string | null;
};

/**
 * Map an agent row to the `Agent` shape. When `slim` is true the six identity
 * markdown blobs (`claudeMd`/`soulMd`/`identityMd`/`toolsMd`/`heartbeatMd`/
 * `setupScript`) are omitted — they bloat list responses by ~16 KB/agent and
 * are never needed at the swarm-overview level. Fetch them via
 * `GET /api/agents/{id}` when required.
 */
function rowToAgent(row: AgentRow, slim = false): Agent {
  const base: Agent = {
    id: row.id,
    name: row.name,
    isLead: row.isLead === 1,
    status: row.status,
    description: row.description ?? undefined,
    role: row.role ?? undefined,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    maxTasks: row.maxTasks ?? 1,
    emptyPollCount: row.emptyPollCount ?? 0,
    lastActivityAt: row.lastActivityAt ?? undefined,
    provider: (row.provider as ProviderName | null) ?? undefined,
    harnessProvider: (row.harness_provider as ProviderName | null) ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    credentialMissing: row.credentialMissing
      ? (JSON.parse(row.credentialMissing) as string[])
      : null,
    credStatus: row.cred_status ? (JSON.parse(row.cred_status) as AgentCredStatus) : null,
  };
  if (slim) return base;
  return {
    ...base,
    claudeMd: row.claudeMd ?? undefined,
    soulMd: row.soulMd ?? undefined,
    identityMd: row.identityMd ?? undefined,
    setupScript: row.setupScript ?? undefined,
    toolsMd: row.toolsMd ?? undefined,
    heartbeatMd: row.heartbeatMd ?? undefined,
  };
}

export const agentQueries = {
  insert: () =>
    getDb().prepare<
      AgentRow,
      [string, string, number, AgentStatus, number, string | null, string | null]
    >(
      "INSERT INTO agents (id, name, isLead, status, maxTasks, provider, harness_provider, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
    ),

  getById: () => getDb().prepare<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?"),

  getAll: () => getDb().prepare<AgentRow, []>("SELECT * FROM agents ORDER BY name"),

  updateStatus: () =>
    getDb().prepare<AgentRow, [AgentStatus, string]>(
      "UPDATE agents SET status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  updateCredentialState: () =>
    getDb().prepare<AgentRow, [AgentStatus, string | null, string]>(
      "UPDATE agents SET status = ?, credentialMissing = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  delete: () => getDb().prepare<null, [string]>("DELETE FROM agents WHERE id = ?"),
};

/**
 * Phase 3 of the worker credential safe-loop plan.
 *
 * `ready=true` clears the waiting state — the agent transitions to `idle`
 * and the dispatcher will start handing it tasks again.
 *
 * `ready=false` parks the agent on `waiting_for_credentials` with the env-var
 * names it's blocked on. The capacity dispatch query already filters
 * `status === 'idle'` so the new value is implicitly excluded with no other
 * code change.
 */
export function updateAgentCredentialState(
  agentId: string,
  ready: boolean,
  missing: string[] | null,
): Agent | null {
  const status: AgentStatus = ready ? "idle" : "waiting_for_credentials";
  const missingJson = ready ? null : missing && missing.length > 0 ? JSON.stringify(missing) : null;
  const row = agentQueries.updateCredentialState().get(status, missingJson, agentId);
  return row ? rowToAgent(row) : null;
}

export function createAgent(
  agent: Omit<Agent, "id" | "createdAt" | "lastUpdatedAt"> & { id?: string },
): Agent {
  const id = agent.id ?? crypto.randomUUID();
  const maxTasks = agent.maxTasks ?? 1;
  const row = agentQueries
    .insert()
    .get(
      id,
      agent.name,
      agent.isLead ? 1 : 0,
      agent.status,
      maxTasks,
      agent.provider ?? null,
      agent.harnessProvider ?? null,
    );
  if (!row) throw new Error("Failed to create agent");
  try {
    installSystemDefaultSkillsForAgent(id);
  } catch (err) {
    console.warn(
      "[db] Failed to install system-default skills for new agent:",
      (err as Error).message,
    );
  }
  try {
    createLogEntry({ eventType: "agent_joined", agentId: id, newValue: agent.status });
  } catch {}
  return rowToAgent(row);
}

export function getAgentById(id: string): Agent | null {
  const row = agentQueries.getById().get(id);
  return row ? rowToAgent(row) : null;
}

export function getAllAgents(opts?: { slim?: boolean }): Agent[] {
  return agentQueries
    .getAll()
    .all()
    .map((row) => rowToAgent(row, opts?.slim ?? false));
}

export function getLeadAgent(): Agent | null {
  const leads = getAllAgents().filter((a) => a.isLead);
  // Prefer a usable (non-offline) lead so callers route to one that can actually
  // poll — e.g. an old offline lead must not shadow a live replacement. Falls
  // back to any lead (incl. offline) so existing "is there a lead at all?"
  // semantics are preserved; callers that require a live lead must check
  // `status` themselves (see escalateUnreclaimedResumes).
  return leads.find((a) => a.status !== "offline") ?? leads[0] ?? null;
}

export function updateAgentStatus(id: string, status: AgentStatus): Agent | null {
  const oldAgent = getAgentById(id);
  const row = agentQueries.updateStatus().get(status, id);
  if (row && oldAgent) {
    try {
      createLogEntry({
        eventType: "agent_status_change",
        agentId: id,
        oldValue: oldAgent.status,
        newValue: status,
      });
    } catch {}
  }
  return row ? rowToAgent(row) : null;
}

export function updateAgentMaxTasks(id: string, maxTasks: number): Agent | null {
  const row = getDb()
    .prepare<AgentRow, [number, string]>(
      `UPDATE agents SET maxTasks = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(maxTasks, id);
  return row ? rowToAgent(row) : null;
}

export function updateAgentProvider(id: string, provider: ProviderName): Agent | null {
  const row = getDb()
    .prepare<AgentRow, [string, string]>(
      `UPDATE agents SET provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(provider, id);
  return row ? rowToAgent(row) : null;
}

/**
 * Phase 1.5 (cloud-personalization): set the per-agent `harness_provider`
 * column. Pass `null` to clear. Validation against the canonical provider
 * list happens at the API layer via `ProviderNameSchema`.
 *
 * Returns the updated row, or null if the agent does not exist.
 */
export function setAgentHarnessProvider(id: string, provider: ProviderName | null): Agent | null {
  const row = getDb()
    .prepare<AgentRow, [string | null, string]>(
      `UPDATE agents SET harness_provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(provider, id);
  return row ? rowToAgent(row) : null;
}

/**
 * Migration 055 — write the worker-self-reported credential snapshot.
 * Pass `null` to clear (e.g. on agent re-registration). Validation against
 * the JSON shape happens at the API layer via `AgentCredStatusSchema`.
 *
 * Worker reports this alongside the existing `updateAgentCredentialState`
 * call; we keep the writes in two functions so the dispatch pattern stays
 * one-row-one-fact, and the PATCH handler can choose which to call based
 * on which fields the request body carried.
 */
export function updateAgentCredStatus(
  id: string,
  credStatus: AgentCredStatus | null,
): Agent | null {
  const json = credStatus ? JSON.stringify(credStatus) : null;
  const row = getDb()
    .prepare<AgentRow, [string | null, string]>(
      `UPDATE agents SET cred_status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    )
    .get(json, id);
  return row ? rowToAgent(row) : null;
}

/**
 * Migration 055 — read all agents whose `harness_provider` matches a given
 * provider, with their reported `cred_status`. Used by the credential-status
 * API endpoint to roll up "is this provider working across the fleet?".
 *
 * Agents with NULL `cred_status` (never reported, or CRED_CHECK_DISABLE=1)
 * are still returned — the caller surfaces them as "unreported".
 */
export function listAgentsWithCredStatusByProvider(provider: string): Agent[] {
  const rows = getDb()
    .prepare<AgentRow, [string]>(`SELECT * FROM agents WHERE harness_provider = ? ORDER BY name`)
    .all(provider);
  return rows.map((row) => rowToAgent(row));
}

/**
 * Phase 1.5 (cloud-personalization): aggregate count of registered agents
 * by `harness_provider`. NULL rows (agents that registered before the
 * migration or never pushed a value) are excluded — they show up in the
 * total agent count but not here.
 *
 * Used by future fleet displays. Not consumed in this phase.
 */
export function getAgentHarnessProviders(): Array<{ provider: string; count: number }> {
  const rows = getDb()
    .prepare<{ provider: string; count: number }, []>(
      `SELECT harness_provider AS provider, COUNT(*) AS count
       FROM agents
       WHERE harness_provider IS NOT NULL
       GROUP BY harness_provider
       ORDER BY harness_provider`,
    )
    .all();
  return rows.map((r) => ({ provider: r.provider, count: r.count }));
}

export function updateAgentActivity(id: string): void {
  getDb()
    .prepare<null, [string]>(
      `UPDATE agents SET lastActivityAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    )
    .run(id);
}

// ============================================================================
// Agent Poll Tracking Functions
// ============================================================================

/** Maximum consecutive empty polls before agent should stop polling */
export const MAX_EMPTY_POLLS = 2;

/**
 * Increment the empty poll count for an agent.
 * Returns the new count after incrementing.
 */
export function incrementEmptyPollCount(agentId: string): number {
  const row = getDb()
    .prepare<{ emptyPollCount: number }, [string]>(
      `UPDATE agents
       SET emptyPollCount = emptyPollCount + 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING emptyPollCount`,
    )
    .get(agentId);
  return row?.emptyPollCount ?? 0;
}

/**
 * Reset the empty poll count for an agent to zero.
 * Called when a task is assigned or agent re-registers.
 */
export function resetEmptyPollCount(agentId: string): void {
  getDb().run(
    `UPDATE agents
     SET emptyPollCount = 0,
         lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [agentId],
  );
}

/**
 * Check if an agent has exceeded the maximum empty poll count.
 */
export function shouldBlockPolling(agentId: string): boolean {
  const agent = getAgentById(agentId);
  return (agent?.emptyPollCount ?? 0) >= MAX_EMPTY_POLLS;
}

export function deleteAgent(id: string): boolean {
  const agent = getAgentById(id);
  if (agent) {
    try {
      createLogEntry({ eventType: "agent_left", agentId: id, oldValue: agent.status });
    } catch {}
  }
  const result = getDb().run("DELETE FROM agents WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// Agent Capacity Functions
// ============================================================================

/**
 * Get the count of active (in_progress) tasks for an agent.
 * Used to determine current capacity usage.
 */
export function getActiveTaskCount(agentId: string): number {
  const result = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'",
    )
    .get(agentId);
  return result?.count ?? 0;
}

/**
 * Check if an agent has capacity to accept more tasks.
 */
export function hasCapacity(agentId: string): boolean {
  const agent = getAgentById(agentId);
  if (!agent) return false;
  const activeCount = getActiveTaskCount(agentId);
  return activeCount < (agent.maxTasks ?? 1);
}

/**
 * Get remaining capacity (available task slots) for an agent.
 */
export function getRemainingCapacity(agentId: string): number {
  const agent = getAgentById(agentId);
  if (!agent) return 0;
  const activeCount = getActiveTaskCount(agentId);
  return Math.max(0, (agent.maxTasks ?? 1) - activeCount);
}

/**
 * Update agent status based on current capacity.
 * Agent is 'busy' when any tasks are in progress, 'idle' when none.
 * Does not modify 'offline' status.
 */
export function updateAgentStatusFromCapacity(agentId: string): void {
  const agent = getAgentById(agentId);
  if (!agent || agent.status === "offline") return;
  // `waiting_for_credentials` is owned by the worker's credential-wait
  // tick — task-completion shouldn't accidentally promote a blocked agent
  // back to idle.
  if (agent.status === "waiting_for_credentials") return;

  const activeCount = getActiveTaskCount(agentId);
  const newStatus = activeCount > 0 ? "busy" : "idle";

  if (agent.status !== newStatus) {
    updateAgentStatus(agentId, newStatus);
  }
}

// ============================================================================
// AgentTask Queries
// ============================================================================

type AgentTaskRow = {
  id: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  status: AgentTaskStatus;
  source: AgentTaskSource;
  taskType: string | null;
  tags: string | null;
  priority: number;
  dependsOn: string | null;
  offeredTo: string | null;
  offeredAt: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  slackReplySent: number;
  slackProgressMessageTs: string | null;
  slackTreeRootMessageTs: string | null;
  vcsProvider: string | null;
  vcsRepo: string | null;
  vcsEventType: string | null;
  vcsNumber: number | null;
  vcsCommentId: number | null;
  vcsAuthor: string | null;
  vcsUrl: string | null;
  vcsInstallationId: number | null;
  vcsNodeId: string | null;
  agentmailInboxId: string | null;
  agentmailMessageId: string | null;
  agentmailThreadId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  dir: string | null;
  parentTaskId: string | null;
  claudeSessionId: string | null;
  model: string | null;
  modelTier: string | null;
  scheduleId: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  outputSchema: string | null;
  followUpConfig: string | null;
  contextKey: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  notifiedAt: string | null;
  failureReason: string | null;
  output: string | null;
  progress: string | null;
  compactionCount: number | null;
  peakContextPercent: number | null;
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  was_paused: number;
  credentialKeySuffix: string | null;
  credentialKeyType: string | null;
  requestedByUserId: string | null;
  swarmVersion: string | null;
  provider: string | null;
  providerMeta: string | null;
  harnessVariant: string | null;
  harnessVariantMeta: string | null;
  totalCostUsd?: number | null;
};

function rowToAgentTask(row: AgentTaskRow): AgentTask {
  let followUpConfig: FollowUpConfig | undefined;
  if (row.followUpConfig) {
    try {
      const parsed = FollowUpConfigSchema.safeParse(JSON.parse(row.followUpConfig));
      if (parsed.success) {
        followUpConfig = parsed.data;
      } else {
        console.warn(
          `[db] Ignoring invalid agent_tasks.followUpConfig for task ${row.id}:`,
          parsed.error.message,
        );
      }
    } catch (error) {
      console.warn(
        `[db] Ignoring malformed agent_tasks.followUpConfig for task ${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
      followUpConfig = undefined;
    }
  }

  return {
    id: row.id,
    agentId: row.agentId,
    creatorAgentId: row.creatorAgentId ?? undefined,
    task: row.task,
    status: row.status,
    source: row.source,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority ?? 50,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) : [],
    offeredTo: row.offeredTo ?? undefined,
    offeredAt: row.offeredAt ?? undefined,
    acceptedAt: row.acceptedAt ?? undefined,
    rejectionReason: row.rejectionReason ?? undefined,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    slackReplySent: !!row.slackReplySent,
    slackProgressMessageTs: row.slackProgressMessageTs ?? undefined,
    slackTreeRootMessageTs: row.slackTreeRootMessageTs ?? undefined,
    vcsProvider: (row.vcsProvider as "github" | "gitlab" | null) ?? undefined,
    vcsRepo: row.vcsRepo ?? undefined,
    vcsEventType: row.vcsEventType ?? undefined,
    vcsNumber: row.vcsNumber ?? undefined,
    vcsCommentId: row.vcsCommentId ?? undefined,
    vcsAuthor: row.vcsAuthor ?? undefined,
    vcsUrl: row.vcsUrl ?? undefined,
    vcsInstallationId: row.vcsInstallationId ?? undefined,
    vcsNodeId: row.vcsNodeId ?? undefined,
    agentmailInboxId: row.agentmailInboxId ?? undefined,
    agentmailMessageId: row.agentmailMessageId ?? undefined,
    agentmailThreadId: row.agentmailThreadId ?? undefined,
    mentionMessageId: row.mentionMessageId ?? undefined,
    mentionChannelId: row.mentionChannelId ?? undefined,
    dir: row.dir ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    claudeSessionId: row.claudeSessionId ?? undefined,
    model: row.model ?? undefined,
    modelTier: parseModelTier(row.modelTier) ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    workflowRunId: row.workflowRunId ?? undefined,
    workflowRunStepId: row.workflowRunStepId ?? undefined,
    outputSchema: row.outputSchema ? JSON.parse(row.outputSchema) : undefined,
    followUpConfig,
    contextKey: row.contextKey ?? undefined,
    compactionCount: row.compactionCount ?? undefined,
    peakContextPercent: row.peakContextPercent ?? undefined,
    peakContextTokens: row.peakContextTokens ?? undefined,
    contextWindowSize: row.contextWindowSize ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    notifiedAt: row.notifiedAt ?? undefined,
    failureReason: row.failureReason ?? undefined,
    output: row.output ?? undefined,
    progress: row.progress ?? undefined,
    wasPaused: !!row.was_paused,
    credentialKeySuffix: row.credentialKeySuffix ?? undefined,
    credentialKeyType: row.credentialKeyType ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
    swarmVersion: row.swarmVersion ?? undefined,
    provider: (row.provider as ProviderName | null) ?? undefined,
    providerMeta: parseProviderMeta(row.provider as ProviderName | null, row.providerMeta),
    harnessVariant: row.harnessVariant ?? undefined,
    harnessVariantMeta: row.harnessVariantMeta ? JSON.parse(row.harnessVariantMeta) : undefined,
    totalCostUsd: row.totalCostUsd ?? undefined,
  };
}

/**
 * Slim list-row mapper — truncates the `task` text to a bounded preview and
 * drops completion/integration/context blobs (`output`, `failureReason`,
 * `providerMeta`, all `vcs*`/`slack*`/`agentmail*`/`credential*`/`mention*` and
 * context-window fields). The preview is long enough for pool-triage; the full
 * brief is on `get-task-details` / `GET /api/tasks/{id}`.
 */
function rowToAgentTaskSummary(row: AgentTaskRow): AgentTaskSummary {
  const t = rowToAgentTask(row);
  return {
    id: t.id,
    agentId: t.agentId,
    creatorAgentId: t.creatorAgentId,
    task: previewText(t.task, TASK_PREVIEW_LENGTH),
    status: t.status,
    source: t.source,
    taskType: t.taskType,
    tags: t.tags,
    priority: t.priority,
    dependsOn: t.dependsOn,
    offeredTo: t.offeredTo,
    acceptedAt: t.acceptedAt,
    parentTaskId: t.parentTaskId,
    scheduleId: t.scheduleId,
    model: t.model,
    modelTier: t.modelTier,
    provider: t.provider,
    requestedByUserId: t.requestedByUserId,
    progress: t.progress,
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    finishedAt: t.finishedAt,
    peakContextPercent: t.peakContextPercent,
    totalCostUsd: t.totalCostUsd,
  };
}

export const taskQueries = {
  insert: () =>
    getDb().prepare<
      AgentTaskRow,
      [
        string,
        string,
        string,
        AgentTaskStatus,
        AgentTaskSource,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, slackChannelId, slackThreadTs, slackUserId, swarmVersion, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  getById: () => getDb().prepare<AgentTaskRow, [string]>("SELECT * FROM agent_tasks WHERE id = ?"),

  getByAgentId: () =>
    getDb().prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? ORDER BY createdAt DESC",
    ),

  getByStatus: () =>
    getDb().prepare<AgentTaskRow, [AgentTaskStatus]>(
      "SELECT * FROM agent_tasks WHERE status = ? ORDER BY createdAt DESC",
    ),

  updateStatus: () =>
    getDb().prepare<AgentTaskRow, [AgentTaskStatus, string | null, string]>(
      `UPDATE agent_tasks SET status = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`,
    ),

  setOutput: () =>
    getDb().prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET output = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  setFailure: () =>
    getDb().prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    ),

  setCancelled: () =>
    getDb().prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET status = 'cancelled', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    ),

  setProgress: () =>
    getDb().prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET progress = ?,
       status = CASE WHEN status IN ('completed', 'failed', 'cancelled', 'superseded') THEN status ELSE 'in_progress' END,
       lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    ),

  delete: () => getDb().prepare<null, [string]>("DELETE FROM agent_tasks WHERE id = ?"),
};

export function createTask(
  agentId: string,
  task: string,
  options?: {
    source?: AgentTaskSource;
    slackChannelId?: string;
    slackThreadTs?: string;
    slackUserId?: string;
  },
): AgentTask {
  const id = crypto.randomUUID();
  const source = options?.source ?? "mcp";
  const row = taskQueries
    .insert()
    .get(
      id,
      agentId,
      task,
      "pending",
      source,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      pkg.version,
    );
  if (!row) throw new Error("Failed to create task");
  try {
    createLogEntry({
      eventType: "task_created",
      agentId,
      taskId: id,
      newValue: "pending",
      metadata: { source },
    });
  } catch {}
  return rowToAgentTask(row);
}

export function getPendingTaskForAgent(agentId: string): AgentTask | null {
  // Get all pending tasks for this agent, ordered by priority (desc) then creation time (asc)
  const rows = getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY priority DESC, createdAt ASC",
    )
    .all(agentId);

  // Find the first task whose dependencies are met
  for (const row of rows) {
    const task = rowToAgentTask(row);
    const { ready } = checkDependencies(task.id);
    if (ready) {
      return task;
    }
  }

  return null;
}

export function assignUnassignedTaskPending(taskId: string, agentId: string): AgentTask | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    )
    .get(agentId, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        agentId,
        taskId,
        oldValue: "unassigned",
        newValue: "pending",
        metadata: { pendingDispatch: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function startTask(taskId: string): AgentTask | null {
  const oldTask = getTaskById(taskId);
  if (!oldTask) return null;

  // Guard: never revive tasks that are already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    )
    .get(taskId);
  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "in_progress",
      });
    } catch {}
  }
  const result = row ? rowToAgentTask(row) : null;
  // Fire-and-forget: notify lifecycle subscribers (e.g. GitHub eyes reaction)
  if (result && oldTask.status !== "in_progress") {
    emitTaskStarted(result);
  }
  return result;
}

export function getTaskById(id: string): AgentTask | null {
  const row = taskQueries.getById().get(id);
  return row ? rowToAgentTask(row) : null;
}

export function markTaskSlackReplySent(taskId: string): void {
  getDb().run(`UPDATE agent_tasks SET slackReplySent = 1 WHERE id = ?`, [taskId]);
}

export function setSlackMessageTracking(
  taskId: string,
  fields: {
    slackProgressMessageTs?: string | null;
    slackTreeRootMessageTs?: string | null;
  },
): void {
  const sets: string[] = [];
  const args: (string | null)[] = [];

  if (Object.hasOwn(fields, "slackProgressMessageTs")) {
    sets.push("slackProgressMessageTs = ?");
    args.push(fields.slackProgressMessageTs ?? null);
  }
  if (Object.hasOwn(fields, "slackTreeRootMessageTs")) {
    sets.push("slackTreeRootMessageTs = ?");
    args.push(fields.slackTreeRootMessageTs ?? null);
  }
  if (sets.length === 0) return;

  args.push(taskId);
  getDb().run(`UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = ?`, args);
}

export function getChildTasks(parentTaskId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks WHERE parentTaskId = ? ORDER BY createdAt ASC, rowid ASC`,
    )
    .all(parentTaskId)
    .map(rowToAgentTask);
}

/**
 * Returns true if `parentId` has at least one non-terminal child task with
 * `taskType = 'resume'`. Used by the heartbeat sweep as an idempotency guard:
 * if a prior sweep tick already created a resume follow-up for this parent,
 * don't create a duplicate.
 *
 * **Filters by taskType = 'resume'** specifically. A parent task can also
 * have ordinary non-terminal delegation children (`send-task` auto-defaults
 * `parentTaskId` to the caller's current task — see src/tools/send-task.ts).
 * Treating those as "already resumed" would incorrectly skip the resume
 * path for a crashed worker that had delegated subtasks (PR #594 review).
 */
export function hasNonTerminalResumeChild(parentId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'resume'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    )
    .get(parentId);
  return row !== undefined && row !== null;
}

/**
 * True when a non-terminal `reroute-decision` child exists for `parentId`.
 *
 * Mirrors {@link hasNonTerminalResumeChild} but filters on
 * `taskType = 'reroute-decision'` — the Lead-owned re-delegation decision
 * created when a pinned crash-recovery resume is never reclaimed (DES-523).
 * Makes escalation idempotent: a later heartbeat sweep must not create a second
 * decision for the same original task. We filter on the taskType marker
 * specifically (not any child) so ordinary delegation / completion follow-up
 * children of the original cannot suppress a needed decision, and nothing else
 * is mistaken for one.
 */
export function hasNonTerminalRerouteDecisionChild(parentId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'reroute-decision'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    )
    .get(parentId);
  return row !== undefined && row !== null;
}

export function updateTaskClaudeSessionId(
  taskId: string,
  claudeSessionId: string,
  provider?: ProviderName,
  providerMeta?: Record<string, unknown>,
  model?: string,
  harnessVariant?: string,
  harnessVariantMeta?: Record<string, unknown>,
): AgentTask | null {
  const setClauses = ["claudeSessionId = ?", "lastUpdatedAt = ?"];
  const params: (string | null)[] = [claudeSessionId, new Date().toISOString()];

  if (provider !== undefined) {
    setClauses.push("provider = ?");
    params.push(provider);
  }
  if (providerMeta !== undefined) {
    setClauses.push("providerMeta = ?");
    params.push(JSON.stringify(providerMeta));
  }
  if (model !== undefined) {
    setClauses.push("model = ?");
    params.push(model);
  }
  if (harnessVariant !== undefined) {
    setClauses.push("harnessVariant = ?");
    params.push(harnessVariant);
  }
  if (harnessVariantMeta !== undefined) {
    setClauses.push("harnessVariantMeta = ?");
    params.push(JSON.stringify(harnessVariantMeta));
  }

  params.push(taskId);

  const row = getDb()
    .prepare<AgentTaskRow, (string | null)[]>(
      `UPDATE agent_tasks SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToAgentTask(row) : null;
}

export function updateTaskVcs(
  taskId: string,
  vcs: {
    vcsProvider: "github" | "gitlab";
    vcsRepo: string;
    vcsNumber: number;
    vcsUrl: string;
  },
): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, number, string, string, string]>(
      `UPDATE agent_tasks
       SET vcsProvider = ?, vcsRepo = ?, vcsNumber = ?, vcsUrl = ?, lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(vcs.vcsProvider, vcs.vcsRepo, vcs.vcsNumber, vcs.vcsUrl, new Date().toISOString(), taskId);
  return row ? rowToAgentTask(row) : null;
}

export function getTasksByAgentId(agentId: string): AgentTask[] {
  return taskQueries.getByAgentId().all(agentId).map(rowToAgentTask);
}

/**
 * Get the most recently updated in-progress task for an agent.
 * Used as a fallback when X-Source-Task-Id header is missing (e.g. lead agent HITL requests).
 *
 * Note: if agent has multiple in-progress tasks, returns the most recently
 * updated one. This is a best-effort fallback — the X-Source-Task-Id header
 * is the authoritative source when available.
 */
export function getAgentCurrentTask(agentId: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'in_progress' ORDER BY lastUpdatedAt DESC LIMIT 1",
    )
    .get(agentId);
  return row ? rowToAgentTask(row) : null;
}

export function getTasksByStatus(status: AgentTaskStatus): AgentTask[] {
  return taskQueries.getByStatus().all(status).map(rowToAgentTask);
}

/**
 * Find a task by VCS repo and issue/PR/MR number.
 * Returns the most recent non-terminal task for this VCS entity.
 *
 * Terminal exclusion MUST stay in lock-step with `TERMINAL_TASK_STATUSES`
 * in `src/types.ts`. SQL strings can't import a TS const — if you add a
 * new terminal status, grep for `NOT IN ('completed'` across this file.
 */
export function findTaskByVcs(vcsRepo: string, vcsNumber: number): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, number]>(
      `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ?
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(vcsRepo, vcsNumber);
  return row ? rowToAgentTask(row) : null;
}

/** @deprecated Use findTaskByVcs instead */
export const findTaskByGitHub = findTaskByVcs;

export interface TaskFilters {
  /** Single status (back-compat) OR array of statuses (multi-status filter). */
  status?: AgentTaskStatus | AgentTaskStatus[];
  agentId?: string;
  search?: string;
  // New filters
  unassigned?: boolean;
  offeredTo?: string;
  readyOnly?: boolean;
  taskType?: string;
  tags?: string[];
  scheduleId?: string;
  /** Filter to tasks whose `source` is in this list. Empty/undefined → no filter. */
  source?: AgentTaskSource[];
  /** ISO 8601 timestamp; only return tasks where createdAt >= this. */
  createdAfter?: string;
  /** Only return tasks requested by this canonical user. NULL rows are excluded. */
  requestedByUserId?: string;
  limit?: number;
  offset?: number;
  includeHeartbeat?: boolean;
}

export function getAllTasks(filters?: TaskFilters): AgentTask[];
export function getAllTasks(
  filters: TaskFilters | undefined,
  opts: { slim: true },
): AgentTaskSummary[];
export function getAllTasks(
  filters?: TaskFilters,
  opts?: { slim?: boolean },
): AgentTask[] | AgentTaskSummary[] {
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length === 1) {
        conditions.push("status = ?");
        params.push(filters.status[0]!);
      } else if (filters.status.length > 1) {
        const placeholders = filters.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        for (const s of filters.status) params.push(s);
      }
    } else {
      conditions.push("status = ?");
      params.push(filters.status);
    }
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("(task LIKE ? OR id LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  // New filters
  if (filters?.unassigned) {
    conditions.push("(agentId IS NULL OR status = 'unassigned')");
  }

  if (filters?.offeredTo) {
    conditions.push("offeredTo = ?");
    params.push(filters.offeredTo);
  }

  if (filters?.taskType) {
    conditions.push("taskType = ?");
    params.push(filters.taskType);
  }

  if (filters?.tags && filters.tags.length > 0) {
    // Match any of the tags
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  if (filters?.scheduleId) {
    conditions.push("scheduleId = ?");
    params.push(filters.scheduleId);
  }

  if (filters?.source && filters.source.length > 0) {
    const placeholders = filters.source.map(() => "?").join(", ");
    conditions.push(`source IN (${placeholders})`);
    for (const s of filters.source) params.push(s);
  }

  if (filters?.createdAfter) {
    conditions.push("createdAt >= ?");
    params.push(filters.createdAfter);
  }

  if (filters?.requestedByUserId) {
    conditions.push("requestedByUserId = ?");
    params.push(filters.requestedByUserId);
  }

  // Exclude system/heartbeat tasks by default. The flag is still called
  // `includeHeartbeat` for backward compat with existing API callers, but we
  // also gate boot-triage + heartbeat-checklist behind it since those are
  // equally noisy in the dashboard task list.
  if (!filters?.includeHeartbeat) {
    conditions.push(
      "(IFNULL(taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage') AND tags NOT LIKE '%\"heartbeat\"%')",
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 25;
  const offset = filters?.offset ?? 0;
  const query = `SELECT agent_tasks.*,
    (SELECT SUM(totalCostUsd) FROM session_costs WHERE session_costs.taskId = agent_tasks.id) AS totalCostUsd
    FROM agent_tasks ${whereClause}
    ORDER BY lastUpdatedAt DESC, priority DESC LIMIT ${limit} OFFSET ${offset}`;

  const rows = getDb()
    .prepare<AgentTaskRow, (string | AgentTaskStatus)[]>(query)
    .all(...params);

  // Filter for ready tasks (dependencies met) if requested. Both the full and
  // the slim row shapes carry `id` + `dependsOn`, so the same predicate works.
  const isReady = (task: { id: string; dependsOn: string[] }): boolean => {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    return checkDependencies(task.id).ready;
  };

  if (opts?.slim) {
    let tasks = rows.map(rowToAgentTaskSummary);
    if (filters?.readyOnly) tasks = tasks.filter(isReady);
    return tasks;
  }

  let tasks = rows.map(rowToAgentTask);
  if (filters?.readyOnly) tasks = tasks.filter(isReady);
  return tasks;
}

/**
 * Get total count of tasks matching the given filters (ignoring limit).
 * Used alongside getAllTasks to display accurate total counts in UI.
 */
export function getTasksCount(filters?: Omit<TaskFilters, "limit" | "readyOnly">): number {
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length === 1) {
        conditions.push("status = ?");
        params.push(filters.status[0]!);
      } else if (filters.status.length > 1) {
        const placeholders = filters.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        for (const s of filters.status) params.push(s);
      }
    } else {
      conditions.push("status = ?");
      params.push(filters.status);
    }
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("(task LIKE ? OR id LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  if (filters?.unassigned) {
    conditions.push("(agentId IS NULL OR status = 'unassigned')");
  }

  if (filters?.offeredTo) {
    conditions.push("offeredTo = ?");
    params.push(filters.offeredTo);
  }

  if (filters?.taskType) {
    conditions.push("taskType = ?");
    params.push(filters.taskType);
  }

  if (filters?.tags && filters.tags.length > 0) {
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  if (filters?.scheduleId) {
    conditions.push("scheduleId = ?");
    params.push(filters.scheduleId);
  }

  if (filters?.source && filters.source.length > 0) {
    const placeholders = filters.source.map(() => "?").join(", ");
    conditions.push(`source IN (${placeholders})`);
    for (const s of filters.source) params.push(s);
  }

  if (filters?.createdAfter) {
    conditions.push("createdAt >= ?");
    params.push(filters.createdAfter);
  }

  // Exclude system/heartbeat tasks by default. The flag is still called
  // `includeHeartbeat` for backward compat with existing API callers, but we
  // also gate boot-triage + heartbeat-checklist behind it since those are
  // equally noisy in the dashboard task list.
  if (!filters?.includeHeartbeat) {
    conditions.push(
      "(IFNULL(taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage') AND tags NOT LIKE '%\"heartbeat\"%')",
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT COUNT(*) as count FROM agent_tasks ${whereClause}`;

  const result = getDb()
    .prepare<{ count: number }, (string | AgentTaskStatus)[]>(query)
    .get(...params);

  return result?.count ?? 0;
}

/**
 * Get task statistics (counts by status) without any limit.
 * This is more efficient than fetching all tasks for stats purposes.
 */
export function getTaskStats(): {
  total: number;
  unassigned: number;
  offered: number;
  reviewing: number;
  pending: number;
  in_progress: number;
  paused: number;
  completed: number;
  failed: number;
} {
  const row = getDb()
    .prepare<
      {
        total: number;
        unassigned: number;
        offered: number;
        reviewing: number;
        pending: number;
        in_progress: number;
        paused: number;
        completed: number;
        failed: number;
      },
      []
    >(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned,
        SUM(CASE WHEN status = 'offered' THEN 1 ELSE 0 END) as offered,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks`,
    )
    .get();

  return (
    row ?? {
      total: 0,
      unassigned: 0,
      offered: 0,
      reviewing: 0,
      pending: 0,
      in_progress: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    }
  );
}

export function getCompletedSlackTasks(): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status IN ('completed', 'failed')
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
    )
    .all()
    .map(rowToAgentTask);
}

/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export function getRecentlyFinishedWorkerTasks(): AgentTask[] {
  // Query for finished tasks that haven't been notified yet
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND t.notifiedAt IS NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC LIMIT 50`,
    )
    .all()
    .map(rowToAgentTask);
}

/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export function markTasksNotified(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = taskIds.map(() => "?").join(",");

  const result = getDb().run(
    `UPDATE agent_tasks SET notifiedAt = ?
     WHERE id IN (${placeholders}) AND notifiedAt IS NULL`,
    [now, ...taskIds],
  );

  return result.changes;
}

/**
 * Reset notifiedAt for tasks, allowing them to be re-delivered on next poll.
 * Used when a trigger was consumed but the session that should process it failed.
 * This prevents permanent notification loss from the mark-before-process race.
 */
export function resetTasksNotified(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;

  const placeholders = taskIds.map(() => "?").join(",");

  const result = getDb().run(
    `UPDATE agent_tasks SET notifiedAt = NULL
     WHERE id IN (${placeholders}) AND notifiedAt IS NOT NULL`,
    taskIds,
  );

  return result.changes;
}

export function getInProgressSlackTasks(): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status = 'in_progress'
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
    )
    .all()
    .map(rowToAgentTask);
}

/**
 * Return sibling tasks for a given cross-ingress context key, optionally
 * filtered by status. The returned shape mirrors getInProgressSlackTasks for
 * consistency; callers can narrow further in TypeScript.
 *
 * See src/tasks/context-key.ts for the key schema.
 */
export function getInProgressTasksByContextKey(
  contextKey: string,
  statuses: AgentTaskStatus[] = ["pending", "in_progress", "offered", "paused"],
): AgentTask[] {
  if (!contextKey || statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(",");
  return getDb()
    .prepare<AgentTaskRow, (string | AgentTaskStatus)[]>(
      `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status IN (${placeholders})
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
    )
    .all(contextKey, ...statuses)
    .map(rowToAgentTask);
}

export function getLatestTaskByContextKey(contextKey: string): AgentTask | null {
  if (!contextKey) return null;
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(contextKey);
  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent agent associated with a specific Slack thread.
 * No status filter — returns the last agent that touched this thread regardless of task state.
 * This is intentional: follow-up messages should route to the same agent even after task completion.
 * Callers (e.g. assistant.ts) apply their own status checks (e.g. agent.status !== "offline").
 */
export function getAgentWorkingOnThread(channelId: string, threadTs: string): Agent | null {
  const taskRow = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);

  if (taskRow?.agentId) return getAgentById(taskRow.agentId);

  return null;
}

/**
 * Find the latest active (in_progress or pending) task in a specific Slack thread.
 * Used for dependency chaining in additive Slack buffer.
 */
export function getLatestActiveTaskInThread(channelId: string, threadTs: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       AND status IN ('in_progress', 'pending')
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);

  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent task in a Slack thread, regardless of source or status.
 * Unlike getAgentWorkingOnThread (which filters source='slack'), this finds ALL tasks
 * including worker tasks that inherited Slack metadata via parentTaskId.
 */
export function getMostRecentTaskInThread(channelId: string, threadTs: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);
  return row ? rowToAgentTask(row) : null;
}

export function findCompletedTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): AgentTask | null {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       AND status = 'completed'
       AND lastUpdatedAt > ?
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs, since);
  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent CANCELLED task in a Slack thread. Used by the
 * follow-up re-delegation guard so a cancellation (worker SIGTERM,
 * runner-side abort, swarm-events tool-loop abort) doesn't permanently
 * jam re-dispatch when an earlier sibling task in the same thread also
 * completed.
 *
 * Matches both:
 *   - `status = 'cancelled'` (the canonical terminal state from cancelTask)
 *   - `status = 'failed'` with a failureReason that starts with "cancelled"
 *     or "exit 130" or contains "cancelled" (the codex-adapter abort path
 *     emits `failureReason: "cancelled"` and exits 130).
 */
export function findRecentCancelledTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): AgentTask | null {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       AND lastUpdatedAt > ?
       AND (
         status = 'cancelled'
         OR (
           status = 'failed'
           AND failureReason IS NOT NULL
           AND (
             failureReason LIKE 'cancelled%'
             OR failureReason LIKE 'exit 130%'
             OR failureReason LIKE '%cancelled%'
           )
         )
       )
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs, since);
  return row ? rowToAgentTask(row) : null;
}

export function completeTask(id: string, output?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-complete a task already in a terminal state.
  // Mirrors cancelTask. Prevents duplicate task.completed events, duplicate
  // log entries, and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  let row = taskQueries.updateStatus().get("completed", finishedAt, id);
  if (!row) return null;

  if (output) {
    row = taskQueries.setOutput().get(scrubSecrets(output), id);
  }

  if (row && oldTask) {
    emitTaskLifecycleTelemetryAfterCommit(
      "completed",
      {
        taskId: id,
        source: oldTask.source,
        ...taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        durationMs: row.createdAt ? Date.now() - new Date(row.createdAt).getTime() : undefined,
      },
      (task) => task?.status === "completed",
    );

    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "completed",
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.completed", {
          taskId: id,
          output,
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function failTask(id: string, reason: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-fail a task already in a terminal state.
  // Mirrors cancelTask / completeTask. Prevents duplicate task.failed events
  // and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const scrubbedReason = scrubSecrets(reason);
  const row = taskQueries.setFailure().get(scrubbedReason, finishedAt, id);
  if (row && oldTask) {
    emitTaskLifecycleTelemetryAfterCommit(
      "failed",
      {
        taskId: id,
        source: oldTask.source,
        ...taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        durationMs: row.createdAt ? Date.now() - new Date(row.createdAt).getTime() : undefined,
      },
      (task) => task?.status === "failed",
    );

    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "failed",
        metadata: { reason: scrubbedReason },
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.failed", {
          taskId: id,
          failureReason: reason,
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      });
    } catch {}

    // Cascade-fail any non-terminal tasks that depend on this one.
    // The cascade is recursive (transitive closure) and cycle-safe.
    try {
      cascadeFailDependents(id, "failed");
    } catch (err) {
      console.error("[failTask] cascade-fail dependents error:", err);
    }
  }
  return row ? rowToAgentTask(row) : null;
}

export function cancelTask(id: string, reason?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are not already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  const row = taskQueries.setCancelled().get(cancelReason, finishedAt, id);

  if (row && oldTask) {
    emitTaskLifecycleTelemetryAfterCommit(
      "cancelled",
      {
        taskId: id,
        source: oldTask.source,
        agentId: oldTask.agentId ?? undefined,
        previousStatus: oldTask.status,
        durationMs: oldTask.createdAt
          ? Date.now() - new Date(oldTask.createdAt).getTime()
          : undefined,
      },
      (task) => task?.status === "cancelled",
    );

    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "cancelled",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.cancelled", {
          taskId: id,
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      });
    } catch {}

    try {
      cascadeFailDependents(id, "cancelled");
    } catch (err) {
      console.error("[cancelTask] cascade-fail dependents error:", err);
    }
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Supersede a task: mark it as `superseded` (terminal) so a fresh "resume"
 * follow-up task can pick up where it left off. Used by the graceful-shutdown
 * path and the `POST /api/tasks/:id/supersede` route. Returns null if the task
 * is already terminal (mirrors `completeTask` / `cancelTask` idempotency).
 *
 * Writes a `task_superseded` agent_log with `{ reason, resumeTaskId }` payload
 * and emits a `task.superseded` workflow event. The caller is responsible for
 * creating the resume follow-up (via `createResumeFollowUp`) and passing the
 * resulting id as `resumeTaskId`.
 */
export function supersedeTask(
  id: string,
  args: { reason: string; resumeTaskId: string | null },
): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-supersede a task already in a terminal state.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks
       SET status = 'superseded',
           finishedAt = ?,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       RETURNING *`,
    )
    .get(finishedAt, id);

  if (row && oldTask) {
    emitTaskLifecycleTelemetryAfterCommit(
      "superseded",
      {
        taskId: id,
        source: oldTask.source,
        ...taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        reason: args.reason,
        durationMs: oldTask.createdAt
          ? Date.now() - new Date(oldTask.createdAt).getTime()
          : undefined,
      },
      (task) => task?.status === "superseded",
    );

    try {
      createLogEntry({
        eventType: "task_superseded",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "superseded",
        metadata: { reason: args.reason, resumeTaskId: args.resumeTaskId },
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.superseded", {
          taskId: id,
          reason: args.reason,
          resumeTaskId: args.resumeTaskId,
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      });
    } catch {}

    try {
      cascadeFailDependents(id, "superseded");
    } catch (err) {
      console.error("[supersedeTask] cascade-fail dependents error:", err);
    }
  }

  return row ? rowToAgentTask(row) : null;
}

export function backfillSupersedeTaskResumeTaskId(taskId: string, resumeTaskId: string): boolean {
  const row = getDb()
    .prepare<{ id: string; metadata: string | null }, [string]>(
      `SELECT id, metadata
       FROM agent_log
       WHERE taskId = ? AND eventType = 'task_superseded'
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(taskId);
  if (!row) return false;

  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  metadata.resumeTaskId = resumeTaskId;

  const result = getDb()
    .prepare("UPDATE agent_log SET metadata = ? WHERE id = ?")
    .run(JSON.stringify(metadata), row.id);
  return result.changes > 0;
}

/**
 * Pause a task that is currently in progress.
 * Used during graceful shutdown to allow tasks to resume after container restart.
 * Unlike failTask, paused tasks retain their agent assignment and can be resumed.
 */
export function pauseTask(id: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Only pause tasks that are in progress
  if (oldTask.status !== "in_progress") {
    return null;
  }

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks
       SET status = 'paused',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`,
    )
    .get(id);

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "paused",
        metadata: { pausedForShutdown: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Resume a paused task - transitions it back to in_progress.
 * Called when worker restarts and picks up paused work.
 */
export function resumeTask(taskId: string): AgentTask | null {
  const oldTask = getTaskById(taskId);
  if (!oldTask || oldTask.status !== "paused") return null;

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks
       SET status = 'in_progress',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'paused'
       RETURNING *`,
    )
    .get(taskId);

  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "paused",
        newValue: "in_progress",
        metadata: { resumed: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Get paused tasks for a specific agent.
 * Used on startup to resume tasks that were interrupted by deployment.
 * Returns tasks ordered by creation time (oldest first for FIFO).
 */
export function getPausedTasksForAgent(agentId: string): AgentTask[] {
  const rows = getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE agentId = ? AND status = 'paused'
       ORDER BY createdAt ASC, rowid ASC`,
    )
    .all(agentId);
  return rows.map(rowToAgentTask);
}

export function getOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): AgentTask[] {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT t.* FROM agent_tasks t
       LEFT JOIN active_sessions s ON s.taskId = t.id
       WHERE t.agentId = ?
         AND t.status = 'in_progress'
         AND t.claudeSessionId IS NULL
         AND t.lastUpdatedAt < ?
         AND s.id IS NULL
         AND t.finishedAt IS NULL
       ORDER BY t.createdAt ASC, t.rowid ASC`,
    )
    .all(agentId, cutoff);
  return rows.map(rowToAgentTask);
}

export function resetOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): AgentTask[] {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks
       SET status = 'pending',
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id IN (
         SELECT t.id FROM agent_tasks t
         LEFT JOIN active_sessions s ON s.taskId = t.id
         WHERE t.agentId = ?
           AND t.status = 'in_progress'
           AND t.claudeSessionId IS NULL
           AND t.lastUpdatedAt < ?
           AND s.id IS NULL
           AND t.finishedAt IS NULL
       )
       RETURNING *`,
    )
    .all(agentId, cutoff);

  for (const row of rows) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: row.id,
        agentId,
        oldValue: "in_progress",
        newValue: "pending",
        metadata: { orphanedInProgressRecovery: true },
      });
    } catch {}
  }

  return rows.map(rowToAgentTask);
}

/**
 * Get recently cancelled tasks for an agent.
 * Used by hooks to detect task cancellation and stop the worker loop.
 * Returns tasks cancelled within the last 5 minutes.
 */
export function getRecentlyCancelledTasksForAgent(agentId: string): AgentTask[] {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE agentId = ?
       AND status = 'cancelled'
       AND finishedAt > ?
       ORDER BY finishedAt DESC`,
    )
    .all(agentId, fiveMinutesAgo);
  return rows.map(rowToAgentTask);
}

export function deleteTask(id: string): boolean {
  const result = getDb().run("DELETE FROM agent_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export function updateTaskProgress(id: string, progress: string): AgentTask | null {
  const scrubbedProgress = scrubSecrets(progress);
  const row = taskQueries.setProgress().get(scrubbedProgress, id);
  if (row) {
    try {
      createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: scrubbedProgress,
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.progress", {
          taskId: id,
          progress: scrubbedProgress,
          agentId: row.agentId,
        });
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Task Attachments (Phase 1 — pointer-based artifacts)
// ============================================================================
//
// Pointer-only attachments live in their own table; `agent_tasks` is
// untouched. Append-only in Phase 1 — `insertTaskAttachment` silently no-ops
// on a duplicate (sha256 match, or kind+pointer+name tuple match) so
// idempotent re-calls don't fan out duplicate rows. The `kind` enum here
// MUST stay in sync with the SQL CHECK constraint (migration 072) and the
// `TaskAttachmentKindSchema` zod enum.

type TaskAttachmentRow = {
  id: string;
  task_id: string;
  agent_id: string | null;
  name: string;
  kind: string;
  url: string | null;
  path: string | null;
  page_id: string | null;
  agent_fs_org_id: string | null;
  agent_fs_drive_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  intent: string | null;
  description: string | null;
  is_primary: number;
  created_at: string;
};

function rowToTaskAttachment(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    name: row.name,
    kind: row.kind as TaskAttachment["kind"],
    url: row.url ?? undefined,
    path: row.path ?? undefined,
    pageId: row.page_id ?? undefined,
    orgId: row.agent_fs_org_id ?? undefined,
    driveId: row.agent_fs_drive_id ?? undefined,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    sha256: row.sha256 ?? undefined,
    intent: row.intent ?? undefined,
    description: row.description ?? undefined,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
  };
}

export interface InsertTaskAttachmentInput {
  taskId: string;
  agentId: string | null;
  name: string;
  kind: TaskAttachment["kind"];
  url?: string;
  path?: string;
  pageId?: string;
  /** agent-fs only — paired with `driveId` to build a public live-host URL. */
  orgId?: string;
  /** agent-fs only — paired with `orgId` to build a public live-host URL. */
  driveId?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  intent?: string;
  description?: string;
  isPrimary?: boolean;
}

/**
 * Insert a task attachment. Append-only + dedup:
 *   - if sha256 is present and a row for this task already has that sha256,
 *     skip (return existing row);
 *   - otherwise skip if a row exists for the same task with the same
 *     (kind, path|url|page_id, name) tuple.
 * Returns the stored attachment (newly inserted or pre-existing duplicate).
 */
export function insertTaskAttachment(input: InsertTaskAttachmentInput): TaskAttachment {
  const db = getDb();

  if (input.sha256) {
    const existing = db
      .prepare<TaskAttachmentRow, [string, string]>(
        "SELECT * FROM task_attachments WHERE task_id = ? AND sha256 = ? LIMIT 1",
      )
      .get(input.taskId, input.sha256);
    if (existing) return rowToTaskAttachment(existing);
  }

  const tupleExisting = db
    .prepare<TaskAttachmentRow, [string, string, string, string, string, string]>(
      `SELECT * FROM task_attachments
       WHERE task_id = ?
         AND kind = ?
         AND IFNULL(path, '')    = ?
         AND IFNULL(url, '')     = ?
         AND IFNULL(page_id, '') = ?
         AND name = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(
      input.taskId,
      input.kind,
      input.path ?? "",
      input.url ?? "",
      input.pageId ?? "",
      input.name,
    );
  if (tupleExisting) return rowToTaskAttachment(tupleExisting);

  const id = crypto.randomUUID();
  const row = db
    .prepare<
      TaskAttachmentRow,
      [
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number,
      ]
    >(
      `INSERT INTO task_attachments
         (id, task_id, agent_id, name, kind, url, path, page_id,
          agent_fs_org_id, agent_fs_drive_id,
          mime_type, size_bytes, sha256, intent, description, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      input.taskId,
      input.agentId ?? null,
      input.name,
      input.kind,
      input.url ?? null,
      input.path ?? null,
      input.pageId ?? null,
      input.orgId ?? null,
      input.driveId ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      input.intent ?? null,
      input.description ?? null,
      input.isPrimary ? 1 : 0,
    );

  if (!row) {
    throw new Error("Failed to insert task attachment");
  }
  return rowToTaskAttachment(row);
}

export function getTaskAttachments(taskId: string): TaskAttachment[] {
  return getDb()
    .prepare<TaskAttachmentRow, [string]>(
      "SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(taskId)
    .map(rowToTaskAttachment);
}

// ============================================================================
// Combined Queries (Agent with Tasks)
// ============================================================================

export function getAgentWithTasks(id: string): AgentWithTasks | null {
  const txn = getDb().transaction(() => {
    const agent = getAgentById(id);
    if (!agent) return null;

    const tasks = getTasksByAgentId(id);
    return { ...agent, tasks };
  });

  return txn();
}

export function getAllAgentsWithTasks(opts?: { slim?: boolean }): AgentWithTasks[] {
  const txn = getDb().transaction(() => {
    const agents = getAllAgents({ slim: opts?.slim ?? false });
    return agents.map((agent) => ({
      ...agent,
      tasks: getTasksByAgentId(agent.id),
    }));
  });

  return txn();
}

// ============================================================================
// Agent Log Queries
// ============================================================================

type AgentLogRow = {
  id: string;
  eventType: AgentLogEventType;
  agentId: string | null;
  taskId: string | null;
  oldValue: string | null;
  newValue: string | null;
  metadata: string | null;
  createdAt: string;
};

function rowToAgentLog(row: AgentLogRow): AgentLog {
  return {
    id: row.id,
    eventType: row.eventType,
    agentId: row.agentId ?? undefined,
    taskId: row.taskId ?? undefined,
    oldValue: row.oldValue ?? undefined,
    newValue: row.newValue ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

export const logQueries = {
  insert: () =>
    getDb().prepare<
      AgentLogRow,
      [string, string, string | null, string | null, string | null, string | null, string | null]
    >(
      `INSERT INTO agent_log (id, eventType, agentId, taskId, oldValue, newValue, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  getByAgentId: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE agentId = ? ORDER BY createdAt DESC",
    ),

  getByTaskId: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC",
    ),

  getByEventType: () =>
    getDb().prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE eventType = ? ORDER BY createdAt DESC",
    ),

  getAll: () => getDb().prepare<AgentLogRow, []>("SELECT * FROM agent_log ORDER BY createdAt DESC"),
};

export function createLogEntry(entry: {
  eventType: AgentLogEventType;
  agentId?: string;
  taskId?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: Record<string, unknown>;
}): AgentLog {
  const id = crypto.randomUUID();
  const metaJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
  const row = logQueries
    .insert()
    .get(
      id,
      entry.eventType,
      entry.agentId ?? null,
      entry.taskId ?? null,
      entry.oldValue ?? null,
      entry.newValue ? scrubSecrets(entry.newValue) : null,
      metaJson ? scrubSecrets(metaJson) : null,
    );
  if (!row) throw new Error("Failed to create log entry");
  return rowToAgentLog(row);
}

export function getLogsByAgentId(agentId: string): AgentLog[] {
  return logQueries.getByAgentId().all(agentId).map(rowToAgentLog);
}

export function getLogsByTaskId(taskId: string, limit = 200): AgentLog[] {
  return getDb()
    .prepare<AgentLogRow, [string, number]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    )
    .all(taskId, limit)
    .map(rowToAgentLog);
}

export function getLogsByTaskIdChronological(taskId: string): AgentLog[] {
  return getDb()
    .prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt ASC",
    )
    .all(taskId)
    .map(rowToAgentLog);
}

/**
 * Phase 6: list all log rows of a given eventType, newest first. Used by the
 * REST audit-log tests to assert mutation rows landed.
 */
export function getLogsByEventType(eventType: AgentLogEventType): AgentLog[] {
  return logQueries.getByEventType().all(eventType).map(rowToAgentLog);
}

export function getAllLogs(limit?: number): AgentLog[] {
  if (limit) {
    return getDb()
      .prepare<AgentLogRow, [number]>(
        "SELECT * FROM agent_log WHERE eventType != 'agent_status_change' ORDER BY createdAt DESC LIMIT ?",
      )
      .all(limit)
      .map(rowToAgentLog);
  }
  return logQueries.getAll().all().map(rowToAgentLog);
}

// ============================================================================
// Task Pool Operations
// ============================================================================

export interface CreateTaskOptions {
  agentId?: string | null;
  creatorAgentId?: string;
  source?: AgentTaskSource;
  taskType?: string;
  tags?: string[];
  priority?: number;
  dependsOn?: string[];
  offeredTo?: string;
  status?: "backlog" | "unassigned"; // Explicitly set initial status
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  vcsProvider?: "github" | "gitlab";
  vcsRepo?: string;
  vcsEventType?: string;
  vcsNumber?: number;
  vcsCommentId?: number;
  vcsAuthor?: string;
  vcsUrl?: string;
  vcsInstallationId?: number;
  vcsNodeId?: string;
  agentmailInboxId?: string;
  agentmailMessageId?: string;
  agentmailThreadId?: string;
  mentionMessageId?: string;
  mentionChannelId?: string;
  dir?: string;
  parentTaskId?: string;
  model?: string;
  modelTier?: ModelTier;
  scheduleId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  /**
   * Optional JSON Schema the agent's final output must conform to.
   *
   * Enforced via the MCP `store-progress` tool (validated in
   * `src/tools/store-progress.ts`). NOT enforced when the task runs on
   * default-mode Devin (no MCP) — see runbooks/harness-providers.md
   * ("Per-task outputSchema support"). Callers reading `task.output` for
   * a schema'd task should be defensive about JSON parsing.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * When a `parentTaskId` is set, the child inherits the parent's `outputSchema`
   * by default. Set this to `false` to opt out — used by control-plane children
   * (e.g. the Lead `reroute-decision` task) that must inherit Slack/VCS context
   * from the parent but must NOT be forced to satisfy the original work's output
   * contract on completion (which would block the control task — DES-523).
   */
  inheritParentOutputSchema?: boolean;
  followUpConfig?: FollowUpConfig;
  requestedByUserId?: string;
  contextKey?: string;
}

/**
 * Find recent tasks within a time window for deduplication checks.
 * Returns tasks created in the last N minutes, optionally filtered by creator or target agent.
 */
export function findRecentSimilarTasks(opts: {
  windowMinutes?: number;
  creatorAgentId?: string;
  agentId?: string;
  limit?: number;
}): AgentTask[] {
  const since = new Date(Date.now() - (opts.windowMinutes ?? 10) * 60 * 1000).toISOString();
  const conditions: string[] = ["createdAt > ?"];
  const params: (string | number)[] = [since];

  // Exclude all terminal statuses — only active or recently created.
  // Keep in lock-step with `TERMINAL_TASK_STATUSES` in src/types.ts.
  conditions.push("status NOT IN ('completed', 'failed', 'cancelled', 'superseded')");

  if (opts.creatorAgentId) {
    conditions.push("creatorAgentId = ?");
    params.push(opts.creatorAgentId);
  }
  if (opts.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }

  const limit = opts.limit ?? 50;
  const query = `SELECT * FROM agent_tasks WHERE ${conditions.join(" AND ")} ORDER BY createdAt DESC LIMIT ${limit}`;

  return getDb()
    .prepare<AgentTaskRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToAgentTask);
}

export function createTaskExtended(task: string, options?: CreateTaskOptions): AgentTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status: AgentTaskStatus = options?.offeredTo
    ? "offered"
    : options?.agentId
      ? "pending"
      : options?.status === "backlog"
        ? "backlog"
        : "unassigned";

  // Inherit Slack/AgentMail metadata from parent task (unless explicitly overridden)
  if (options?.parentTaskId) {
    const parent = getTaskById(options.parentTaskId);
    if (parent) {
      // Identity & routing — anything that says "what work is this, who asked
      // for it, where does it run" carries forward to every child (follow-ups,
      // reboot retries, resume tasks). Explicit options always win.
      //
      // When adding a new identity-shaped column to `agent_tasks`, ADD IT HERE
      // unless you have a specific reason a child should NOT inherit it. This
      // is the single source of truth — `createResumeFollowUp` and the other
      // follow-up creators rely on this block instead of re-listing fields.

      // Slack context
      if (parent.slackChannelId && !options.slackChannelId) {
        options.slackChannelId = parent.slackChannelId;
      }
      if (parent.slackThreadTs && !options.slackThreadTs) {
        options.slackThreadTs = parent.slackThreadTs;
      }
      if (parent.slackUserId && !options.slackUserId) {
        options.slackUserId = parent.slackUserId;
      }

      // AgentMail context
      if (parent.agentmailInboxId && !options.agentmailInboxId) {
        options.agentmailInboxId = parent.agentmailInboxId;
      }
      if (parent.agentmailMessageId && !options.agentmailMessageId) {
        options.agentmailMessageId = parent.agentmailMessageId;
      }
      if (parent.agentmailThreadId && !options.agentmailThreadId) {
        options.agentmailThreadId = parent.agentmailThreadId;
      }

      // Mention context (Slack @-mentions)
      if (parent.mentionMessageId && !options.mentionMessageId) {
        options.mentionMessageId = parent.mentionMessageId;
      }
      if (parent.mentionChannelId && !options.mentionChannelId) {
        options.mentionChannelId = parent.mentionChannelId;
      }

      // VCS identity (GitHub / GitLab issue / PR / MR + webhook routing)
      // Webhook handlers locate active work via `findTaskByVcs(repo, number)`,
      // so a resume / follow-up child MUST carry the full VCS identity or
      // subsequent review/update events get dropped.
      if (parent.vcsProvider && !options.vcsProvider) {
        options.vcsProvider = parent.vcsProvider;
      }
      if (parent.vcsRepo && !options.vcsRepo) {
        options.vcsRepo = parent.vcsRepo;
      }
      if (parent.vcsNumber != null && options.vcsNumber == null) {
        options.vcsNumber = parent.vcsNumber;
      }
      if (parent.vcsEventType && !options.vcsEventType) {
        options.vcsEventType = parent.vcsEventType;
      }
      if (parent.vcsCommentId != null && options.vcsCommentId == null) {
        options.vcsCommentId = parent.vcsCommentId;
      }
      if (parent.vcsAuthor && !options.vcsAuthor) {
        options.vcsAuthor = parent.vcsAuthor;
      }
      if (parent.vcsUrl && !options.vcsUrl) {
        options.vcsUrl = parent.vcsUrl;
      }
      if (parent.vcsInstallationId != null && options.vcsInstallationId == null) {
        options.vcsInstallationId = parent.vcsInstallationId;
      }
      if (parent.vcsNodeId && !options.vcsNodeId) {
        options.vcsNodeId = parent.vcsNodeId;
      }

      // Execution context (per-task overrides)
      //
      // `model` is DELIBERATELY NOT inherited. A parent task's `model` is a
      // concrete, provider-specific resolved string (e.g. `claude-opus-4-8`,
      // `openrouter/moonshotai/kimi-k2.6`). Derived tasks (resume follow-ups,
      // completion/review follow-ups, re-dispatches) routinely land on a
      // DIFFERENT agent — and therefore a different harness/provider — than the
      // parent. Carrying the parent's concrete model across that boundary makes
      // the child die at session-init with a model-incompatibility error before
      // any worker code runs (e.g. a `claude-opus-4-8` resume claimed by a Codex
      // worker → `400 model is not supported when using Codex`, or a
      // `kimi-k2.6` review follow-up routed to a Claude-harness Lead → session
      // exit 1). Per Taras's directive (2026-05-29): derived tasks must never
      // set the model — it resolves from the ASSIGNEE agent's own provider /
      // `MODEL_OVERRIDE` config at session-init (see
      // `src/commands/runner.ts` — `opts.model || configModel`). A null `model`
      // here is the correct, intended state. Do NOT re-add inheritance here; if
      // a same-provider child genuinely needs a specific model, the creator must
      // pass it explicitly.
      if (parent.dir && !options.dir) {
        options.dir = parent.dir;
      }

      // Contract (schema validation) — `store-progress` validates completion
      // output against `outputSchema`, runner injects structured-output
      // instructions only when it's present. Opt-out via
      // `inheritParentOutputSchema: false` for control-plane children (e.g. the
      // Lead reroute-decision) that must not be held to the original work's
      // output contract.
      if (
        parent.outputSchema &&
        !options.outputSchema &&
        options.inheritParentOutputSchema !== false
      ) {
        options.outputSchema = parent.outputSchema;
      }

      // Attribution
      if (parent.requestedByUserId && !options.requestedByUserId) {
        options.requestedByUserId = parent.requestedByUserId;
      }
      if (parent.contextKey && !options.contextKey) {
        options.contextKey = parent.contextKey;
      }
      if (parent.followUpConfig && !options.followUpConfig) {
        options.followUpConfig = parent.followUpConfig;
      }
    }
  }

  // Auto-inherit Slack metadata from the creator's source task (deterministic via sourceTaskId)
  // Priority: explicit params > parentTaskId inheritance > sourceTaskId lookup
  // sourceTaskId is set by the adapter's X-Source-Task-Id header — each adapter carries its taskId natively
  if (options?.creatorAgentId && !options.slackChannelId && options.sourceTaskId) {
    const sourceTask = getTaskById(options.sourceTaskId);
    if (sourceTask?.slackChannelId) {
      options.slackChannelId = sourceTask.slackChannelId;
      options.slackThreadTs = sourceTask.slackThreadTs;
      options.slackUserId = sourceTask.slackUserId;
    }
  }

  const auditUserId = getCurrentRequestUserId() ?? null;
  const row = getDb()
    .prepare<AgentTaskRow, (string | number | null)[]>(
      `INSERT INTO agent_tasks (
        id, agentId, creatorAgentId, task, status, source,
        taskType, tags, priority, dependsOn, offeredTo, offeredAt,
        slackChannelId, slackThreadTs, slackUserId,
        vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl,
        vcsInstallationId, vcsNodeId,
        agentmailInboxId, agentmailMessageId, agentmailThreadId,
        mentionMessageId, mentionChannelId, dir, parentTaskId, model, modelTier, scheduleId,
        workflowRunId, workflowRunStepId, outputSchema, followUpConfig, requestedByUserId, contextKey, swarmVersion, createdAt, lastUpdatedAt, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      options?.agentId ?? null,
      options?.creatorAgentId ?? null,
      task,
      status,
      options?.source ?? "mcp",
      options?.taskType ?? null,
      JSON.stringify(options?.tags ?? []),
      options?.priority ?? 50,
      JSON.stringify(options?.dependsOn ?? []),
      options?.offeredTo ?? null,
      options?.offeredTo ? now : null,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      options?.vcsProvider ?? null,
      options?.vcsRepo ?? null,
      options?.vcsEventType ?? null,
      options?.vcsNumber ?? null,
      options?.vcsCommentId ?? null,
      options?.vcsAuthor ?? null,
      options?.vcsUrl ?? null,
      options?.vcsInstallationId ?? null,
      options?.vcsNodeId ?? null,
      options?.agentmailInboxId ?? null,
      options?.agentmailMessageId ?? null,
      options?.agentmailThreadId ?? null,
      options?.mentionMessageId ?? null,
      options?.mentionChannelId ?? null,
      options?.dir ?? null,
      options?.parentTaskId ?? null,
      options?.model ?? null,
      options?.modelTier ?? null,
      options?.scheduleId ?? null,
      options?.workflowRunId ?? null,
      options?.workflowRunStepId ?? null,
      options?.outputSchema ? JSON.stringify(options.outputSchema) : null,
      options?.followUpConfig ? JSON.stringify(options.followUpConfig) : null,
      options?.requestedByUserId ?? null,
      options?.contextKey ?? null,
      pkg.version,
      now,
      now,
      auditUserId,
      auditUserId,
    );

  if (!row) throw new Error("Failed to create task");

  try {
    createLogEntry({
      eventType: status === "offered" ? "task_offered" : "task_created",
      agentId: options?.creatorAgentId,
      taskId: id,
      newValue: status,
      metadata: { source: options?.source ?? "mcp" },
    });
  } catch {}

  emitTaskLifecycleTelemetryAfterCommit(
    "created",
    {
      taskId: row.id,
      source: row.source,
      ...taskContextForTelemetry(rowToAgentTask(row)),
      hasParent: !!row.parentTaskId,
      priority: row.priority,
    },
    (task) => task !== null,
  );

  try {
    import("../workflows/event-bus").then(({ workflowEventBus }) => {
      workflowEventBus.emit("task.created", {
        taskId: row.id,
        task: row.task,
        source: row.source,
        tags: options?.tags ?? [],
        agentId: row.agentId,
        workflowRunId: row.workflowRunId,
        workflowRunStepId: row.workflowRunStepId,
      });
    });
  } catch {}

  return rowToAgentTask(row);
}

export function claimTask(taskId: string, agentId: string): AgentTask | null {
  // Atomic claim: single UPDATE with WHERE guard ensures exactly-once claiming.
  // No pre-read needed — the WHERE clause handles the race condition.
  // Status goes directly to 'in_progress' because the claiming session is
  // already working on the task (prevents duplicate task_assigned triggers).
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'in_progress', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    )
    .get(agentId, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_claimed",
        agentId,
        taskId,
        oldValue: "unassigned",
        newValue: "in_progress",
      });
    } catch {}
  }

  const result = row ? rowToAgentTask(row) : null;
  // Fire-and-forget: notify lifecycle subscribers (e.g. GitHub eyes reaction)
  if (result) {
    emitTaskStarted(result);
  }
  return result;
}

export function releaseTask(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Allow releasing both 'pending' (directly assigned) and 'in_progress' (pool-claimed) tasks
  if (task.status !== "pending" && task.status !== "in_progress") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET agentId = NULL, status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status IN ('pending', 'in_progress') RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_released",
        agentId: task.agentId ?? undefined,
        taskId,
        oldValue: task.status,
        newValue: "unassigned",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function acceptTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Accept both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', acceptedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    )
    .get(agentId, now, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_accepted",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "pending",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export function rejectTask(taskId: string, agentId: string, reason?: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Reject both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string | null, string, string]>(
      `UPDATE agent_tasks SET
        status = 'unassigned', offeredTo = NULL, offeredAt = NULL,
        rejectionReason = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    )
    .get(reason ?? null, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_rejected",
        agentId,
        taskId,
        oldValue: task.status,
        newValue: "unassigned",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Move a task to backlog status. Task must be unassigned (in pool).
 * Backlog tasks are not returned by pool queries.
 */
export function moveTaskToBacklog(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "unassigned") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'backlog', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "unassigned",
        newValue: "backlog",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Move a task from backlog to unassigned (pool). Task must be in backlog status.
 */
export function moveTaskFromBacklog(taskId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "backlog") return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status = 'backlog' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        oldValue: "backlog",
        newValue: "unassigned",
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Release tasks that have been in 'reviewing' status for too long.
 * Returns them to 'offered' status for retry.
 */
export function releaseStaleReviewingTasks(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE agent_tasks SET status = 'offered', lastUpdatedAt = ?
     WHERE status = 'reviewing' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

export function getOfferedTasksForAgent(agentId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE offeredTo = ? AND status = 'offered' ORDER BY createdAt ASC, rowid ASC",
    )
    .all(agentId)
    .map(rowToAgentTask);
}

/**
 * Atomically claim an offered task for review.
 * Marks it as 'reviewing' to prevent duplicate polling.
 * Returns null if task is not offered to this agent or already claimed.
 */
export function claimOfferedTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'reviewing', lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId,
        oldValue: "offered",
        newValue: "reviewing",
      });
    } catch {
      // Log creation is best-effort
    }
  }
  return row ? rowToAgentTask(row) : null;
}

export function getUnassignedTasksCount(): number {
  const result = getDb()
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
    )
    .get();
  return result?.count ?? 0;
}

/** Get unassigned task IDs, ordered by priority (highest first) then creation time */
export function getUnassignedTaskIds(limit = 10): string[] {
  const rows = getDb()
    .prepare<{ id: string }, [number]>(
      "SELECT id FROM agent_tasks WHERE status = 'unassigned' ORDER BY priority DESC, createdAt ASC, rowid ASC LIMIT ?",
    )
    .all(limit);
  return rows.map((r) => r.id);
}

// ============================================================================
// Dependency Checking
// ============================================================================

export function checkDependencies(taskId: string): {
  ready: boolean;
  blockedBy: string[];
} {
  const task = getTaskById(taskId);
  if (!task || !task.dependsOn || task.dependsOn.length === 0) {
    return { ready: true, blockedBy: [] };
  }

  const blockedBy: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = getTaskById(depId);
    if (!depTask || depTask.status !== "completed") {
      blockedBy.push(depId);
    }
  }

  return { ready: blockedBy.length === 0, blockedBy };
}

/**
 * Reverse-lookup: find all tasks whose `dependsOn` JSON array contains `parentId`.
 * Uses SQLite `json_each` to scan the dependsOn column efficiently.
 * Returns only non-terminal tasks by default (the callers want to cascade-fail
 * live dependents, not re-process already-finished ones).
 */
export function getDependentTasks(
  parentId: string,
  opts?: { includeTerminal?: boolean },
): AgentTask[] {
  const database = getDb();
  const rows = database
    .prepare<AgentTaskRow, [string]>(
      `SELECT t.*
       FROM agent_tasks t, json_each(t.dependsOn) AS dep
       WHERE dep.value = ?`,
    )
    .all(parentId);

  const tasks = rows.map(rowToAgentTask);
  if (opts?.includeTerminal) return tasks;
  return tasks.filter((t) => !isTerminalTaskStatus(t.status));
}

export interface CascadeFailResult {
  taskId: string;
  taskSubject: string;
}

/**
 * Recursively cascade-fail all transitive dependents of a parent task.
 * Walks the full dependency graph: if A fails, and B depends on A, and C
 * depends on B, then both B and C are failed.
 *
 * Guards against cycles with a visited set. Skips already-terminal tasks.
 * Returns the list of tasks that were actually cascade-failed (for follow-up
 * enrichment).
 */
export function cascadeFailDependents(
  parentId: string,
  parentStatus: string,
  visited?: Set<string>,
): CascadeFailResult[] {
  const seen = visited ?? new Set<string>();
  if (seen.has(parentId)) return [];
  seen.add(parentId);

  const dependents = getDependentTasks(parentId);
  const results: CascadeFailResult[] = [];

  for (const dep of dependents) {
    if (seen.has(dep.id)) continue;

    const reason = `Blocked dependency ${parentId.slice(0, 8)} was ${parentStatus}`;
    const failed = failTask(dep.id, reason);
    if (failed) {
      results.push({
        taskId: failed.id,
        taskSubject: failed.task.slice(0, 120),
      });
      // Recurse: this dependent may itself have dependents
      const transitive = cascadeFailDependents(dep.id, "failed (cascade)", seen);
      results.push(...transitive);
    }
  }

  return results;
}

// ============================================================================
// Agent Profile Operations
// ============================================================================

// Default markdown template generators moved to src/prompts/defaults.ts
// Re-export for backwards compatibility with any external consumers
export {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
  generateDefaultToolsMd,
} from "../prompts/defaults.ts";

export function updateAgentProfile(
  id: string,
  updates: {
    description?: string;
    role?: string;
    capabilities?: string[];
    claudeMd?: string;
    soulMd?: string;
    identityMd?: string;
    setupScript?: string;
    toolsMd?: string;
    heartbeatMd?: string;
  },
  meta?: VersionMeta,
): Agent | null {
  const database = getDb();

  return database.transaction(() => {
    // Get current agent state for version comparison
    const current = database
      .prepare<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?")
      .get(id);
    if (!current) return null;

    // Create context versions for changed fields
    for (const field of VERSIONABLE_FIELDS) {
      const newValue = updates[field];
      if (newValue === undefined || newValue === null) continue;

      const currentValue = current[field] ?? "";
      const newHash = computeContentHash(newValue);
      const currentHash = computeContentHash(currentValue);

      if (newHash === currentHash) continue; // No actual change

      const latestVersion = getLatestContextVersion(id, field);
      const version = (latestVersion?.version ?? 0) + 1;

      createContextVersion({
        agentId: id,
        field,
        content: newValue,
        version,
        changeSource: meta?.changeSource ?? "api",
        changedByAgentId: meta?.changedByAgentId ?? null,
        changeReason: meta?.changeReason ?? null,
        contentHash: newHash,
        previousVersionId: latestVersion?.id ?? null,
      });
    }

    // Proceed with existing UPDATE logic
    const now = new Date().toISOString();
    const row = database
      .prepare<
        AgentRow,
        [
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
          string,
        ]
      >(
        `UPDATE agents SET
          description = COALESCE(?, description),
          role = COALESCE(?, role),
          capabilities = COALESCE(?, capabilities),
          claudeMd = COALESCE(?, claudeMd),
          soulMd = COALESCE(?, soulMd),
          identityMd = COALESCE(?, identityMd),
          setupScript = COALESCE(?, setupScript),
          toolsMd = COALESCE(?, toolsMd),
          heartbeatMd = COALESCE(?, heartbeatMd),
          lastUpdatedAt = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        updates.description ?? null,
        updates.role ?? null,
        updates.capabilities ? JSON.stringify(updates.capabilities) : null,
        updates.claudeMd ?? null,
        updates.soulMd ?? null,
        updates.identityMd ?? null,
        updates.setupScript ?? null,
        updates.toolsMd ?? null,
        updates.heartbeatMd ?? null,
        now,
        id,
      );

    return row ? rowToAgent(row) : null;
  })();
}

export function updateAgentName(id: string, newName: string): Agent | null {
  // Check if another agent already has this name
  const existingAgent = getDb()
    .prepare<AgentRow, [string, string]>("SELECT * FROM agents WHERE name = ? AND id != ?")
    .get(newName, id);

  if (existingAgent) {
    throw new Error("Agent name already exists");
  }

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentRow, [string, string, string]>(
      "UPDATE agents SET name = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(newName, now, id);

  return row ? rowToAgent(row) : null;
}

// ============================================================================
// Channel Operations
// ============================================================================

type ChannelRow = {
  id: string;
  name: string;
  description: string | null;
  type: ChannelType;
  createdBy: string | null;
  participants: string | null;
  createdAt: string;
};

function rowToChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    type: row.type,
    createdBy: row.createdBy ?? undefined,
    participants: row.participants ? JSON.parse(row.participants) : [],
    createdAt: row.createdAt,
  };
}

type ChannelMessageRow = {
  id: string;
  channelId: string;
  agentId: string | null;
  content: string;
  replyToId: string | null;
  mentions: string | null;
  createdAt: string;
};

function rowToChannelMessage(row: ChannelMessageRow, agentName?: string): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channelId,
    agentId: row.agentId,
    agentName: agentName ?? (row.agentId ? undefined : "Human"),
    content: row.content,
    replyToId: row.replyToId ?? undefined,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    createdAt: row.createdAt,
  };
}

export function createChannel(
  name: string,
  options?: {
    description?: string;
    type?: ChannelType;
    createdBy?: string;
    participants?: string[];
  },
): Channel {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ChannelRow,
      [string, string, string | null, ChannelType, string | null, string, string]
    >(
      `INSERT INTO channels (id, name, description, type, createdBy, participants, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      name,
      options?.description ?? null,
      options?.type ?? "public",
      options?.createdBy ?? null,
      JSON.stringify(options?.participants ?? []),
      now,
    );

  if (!row) throw new Error("Failed to create channel");
  return rowToChannel(row);
}

export function getMessageById(id: string): ChannelMessage | null {
  const row = getDb()
    .prepare<ChannelMessageRow, [string]>("SELECT * FROM channel_messages WHERE id = ?")
    .get(id);
  if (!row) return null;
  const agent = row.agentId ? getAgentById(row.agentId) : null;
  return rowToChannelMessage(row, agent?.name);
}

export function getChannelById(id: string): Channel | null {
  const row = getDb().prepare<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?").get(id);
  return row ? rowToChannel(row) : null;
}

export function getChannelByName(name: string): Channel | null {
  const row = getDb()
    .prepare<ChannelRow, [string]>("SELECT * FROM channels WHERE name = ?")
    .get(name);
  return row ? rowToChannel(row) : null;
}

export function getAllChannels(): Channel[] {
  return getDb()
    .prepare<ChannelRow, []>("SELECT * FROM channels ORDER BY name")
    .all()
    .map(rowToChannel);
}

export function deleteChannel(id: string): boolean {
  const result = getDb().prepare("DELETE FROM channels WHERE id = ?").run(id);
  return result.changes > 0;
}

export function postMessage(
  channelId: string,
  agentId: string | null,
  content: string,
  options?: {
    replyToId?: string;
    mentions?: string[];
  },
): ChannelMessage {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Detect /task prefix - only create tasks when explicitly requested
  const isTaskMessage = content.trimStart().startsWith("/task ");
  const messageContent = isTaskMessage ? content.replace(/^\s*\/task\s+/, "") : content;

  const row = getDb()
    .prepare<
      ChannelMessageRow,
      [string, string, string | null, string, string | null, string, string]
    >(
      `INSERT INTO channel_messages (id, channelId, agentId, content, replyToId, mentions, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      channelId,
      agentId,
      messageContent,
      options?.replyToId ?? null,
      JSON.stringify(options?.mentions ?? []),
      now,
    );

  if (!row) throw new Error("Failed to post message");

  try {
    createLogEntry({
      eventType: "channel_message",
      agentId: agentId ?? undefined,
      metadata: { channelId, messageId: id },
    });
  } catch {}

  // Determine which agents should receive task notifications
  let targetMentions = options?.mentions ?? [];

  // Thread follow-up: If no explicit mentions and this is a reply, inherit from parent message
  // Note: Only for notifications, not for task creation (requires explicit /task)
  if (targetMentions.length === 0 && options?.replyToId) {
    const parentMessage = getMessageById(options.replyToId);
    if (parentMessage?.mentions && parentMessage.mentions.length > 0) {
      targetMentions = parentMessage.mentions;
    }
  }

  // Only create tasks when /task prefix is used
  if (isTaskMessage && targetMentions.length > 0) {
    const sender = agentId ? getAgentById(agentId) : null;
    const channel = getChannelById(channelId);
    const senderName = sender?.name ?? "Human";
    const channelName = channel?.name ?? "unknown";
    const truncated =
      messageContent.length > 80 ? `${messageContent.slice(0, 80)}...` : messageContent;

    // Dedupe mentions (self-mentions allowed - agents can create tasks for themselves)
    const uniqueMentions = [...new Set(targetMentions)];
    const createdTaskIds: string[] = [];

    for (const mentionedAgentId of uniqueMentions) {
      // Skip if agent doesn't exist
      const mentionedAgent = getAgentById(mentionedAgentId);
      if (!mentionedAgent) continue;

      const taskDescription = `Task from ${senderName} in #${channelName}: "${truncated}"`;

      const task = createTaskExtended(taskDescription, {
        agentId: mentionedAgentId, // Direct assignment
        creatorAgentId: agentId ?? undefined,
        source: "mcp",
        taskType: "task",
        priority: 50,
        mentionMessageId: id,
        mentionChannelId: channelId,
      });
      createdTaskIds.push(task.id);
    }

    // Append task links to message content (markdown format for frontend)
    if (createdTaskIds.length > 0) {
      const taskLinks = createdTaskIds
        .map((taskId) => `[#${taskId.slice(0, 8)}](task:${taskId})`)
        .join(" ");
      const updatedContent = `${messageContent}\n\n→ Created: ${taskLinks}`;
      getDb()
        .prepare(`UPDATE channel_messages SET content = ? WHERE id = ?`)
        .run(updatedContent, id);
    }
  }

  // Get agent name for the response - re-fetch to get updated content
  const agent = agentId ? getAgentById(agentId) : null;
  const updatedRow = getDb()
    .prepare<ChannelMessageRow, [string]>(
      `SELECT m.*, a.name as agentName FROM channel_messages m
       LEFT JOIN agents a ON m.agentId = a.id WHERE m.id = ?`,
    )
    .get(id);
  return rowToChannelMessage(updatedRow ?? row, agent?.name);
}

export function getChannelMessages(
  channelId: string,
  options?: {
    limit?: number;
    since?: string;
    before?: string;
  },
): ChannelMessage[] {
  let query =
    "SELECT m.*, a.name as agentName FROM channel_messages m LEFT JOIN agents a ON m.agentId = a.id WHERE m.channelId = ?";
  const params: (string | number)[] = [channelId];

  if (options?.since) {
    query += " AND m.createdAt > ?";
    params.push(options.since);
  }

  if (options?.before) {
    query += " AND m.createdAt < ?";
    params.push(options.before);
  }

  query += " ORDER BY m.createdAt DESC";

  if (options?.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, (string | number)[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined))
    .reverse(); // Return in chronological order
}

export function updateReadState(agentId: string, channelId: string): void {
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO channel_read_state (agentId, channelId, lastReadAt)
     VALUES (?, ?, ?)
     ON CONFLICT(agentId, channelId) DO UPDATE SET lastReadAt = ?`,
    [agentId, channelId, now, now],
  );
}

export function getLastReadAt(agentId: string, channelId: string): string | null {
  const result = getDb()
    .prepare<{ lastReadAt: string }, [string, string]>(
      "SELECT lastReadAt FROM channel_read_state WHERE agentId = ? AND channelId = ?",
    )
    .get(agentId, channelId);
  return result?.lastReadAt ?? null;
}

export function getUnreadMessages(agentId: string, channelId: string): ChannelMessage[] {
  const lastReadAt = getLastReadAt(agentId, channelId);

  let query = `SELECT m.*, a.name as agentName FROM channel_messages m
               LEFT JOIN agents a ON m.agentId = a.id
               WHERE m.channelId = ?`;
  const params: string[] = [channelId];

  if (lastReadAt) {
    query += " AND m.createdAt > ?";
    params.push(lastReadAt);
  }

  query += " ORDER BY m.createdAt ASC";

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, string[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

export function getMentionsForAgent(
  agentId: string,
  options?: { unreadOnly?: boolean; channelId?: string },
): ChannelMessage[] {
  let query = `SELECT m.*, a.name as agentName FROM channel_messages m
               LEFT JOIN agents a ON m.agentId = a.id
               WHERE m.mentions LIKE ?`;
  const params: string[] = [`%"${agentId}"%`];

  if (options?.channelId) {
    query += " AND m.channelId = ?";
    params.push(options.channelId);

    if (options?.unreadOnly) {
      const lastReadAt = getLastReadAt(agentId, options.channelId);
      if (lastReadAt) {
        query += " AND m.createdAt > ?";
        params.push(lastReadAt);
      }
    }
  }

  query += " ORDER BY m.createdAt DESC LIMIT 50";

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  return getDb()
    .prepare<MessageWithAgentRow, string[]>(query)
    .all(...params)
    .map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

// ============================================================================
// Inbox Summary (for system tray)
// ============================================================================

export interface MentionPreview {
  channelName: string;
  agentName: string;
  content: string;
  createdAt: string;
}

export interface InboxSummary {
  unreadCount: number;
  mentionsCount: number;
  offeredTasksCount: number;
  poolTasksCount: number;
  inProgressCount: number;
  recentMentions: MentionPreview[]; // Up to 3 recent @mentions
}

export function getInboxSummary(agentId: string): InboxSummary {
  const db = getDb();
  const channels = getAllChannels();
  let unreadCount = 0;
  let mentionsCount = 0;

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = db
      .prepare<{ lastReadAt: string; processing_since: string | null }, [string, string]>(
        "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      )
      .get(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Count unread (excluding own messages)
    const channelUnread = db
      .prepare<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND (m.agentId != '${agentId}' OR m.agentId IS NULL) ${baseCondition}`,
      )
      .get(channel.id);
    unreadCount += channelUnread?.count ?? 0;

    // Count mentions in unread
    const channelMentions = db
      .prepare<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      )
      .get(channel.id, `%"${agentId}"%`);
    mentionsCount += channelMentions?.count ?? 0;
  }

  // Count offered tasks for this agent
  const offeredResult = db
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE offeredTo = ? AND status = 'offered'",
    )
    .get(agentId);

  // Count unassigned tasks in pool
  const poolResult = db
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
    )
    .get();

  // Count my in-progress tasks
  const inProgressResult = db
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'",
    )
    .get(agentId);

  // Get recent unread @mentions (up to 3)
  const recentMentions: MentionPreview[] = [];
  const mentionMessages = getMentionsForAgent(agentId, { unreadOnly: false });

  // Filter to only unread mentions and limit to 3
  for (const msg of mentionMessages) {
    if (recentMentions.length >= 3) break;

    // Check if message is unread (by checking against read state per channel)
    const lastReadAt = getLastReadAt(agentId, msg.channelId);
    if (lastReadAt && new Date(msg.createdAt) <= new Date(lastReadAt)) {
      continue; // Already read
    }

    // Get channel name
    const channel = getChannelById(msg.channelId);

    recentMentions.push({
      channelName: channel?.name ?? "unknown",
      agentName: msg.agentName ?? "Unknown",
      content: msg.content.length > 100 ? `${msg.content.slice(0, 100)}...` : msg.content,
      createdAt: msg.createdAt,
    });
  }

  return {
    unreadCount,
    mentionsCount,
    offeredTasksCount: offeredResult?.count ?? 0,
    poolTasksCount: poolResult?.count ?? 0,
    inProgressCount: inProgressResult?.count ?? 0,
    recentMentions,
  };
}

/**
 * Atomically claim unread mentions for an agent.
 * Sets processing_since to prevent duplicate polling.
 * Returns channels with unread mentions, or empty array if none/already claimed.
 */
export function claimMentions(agentId: string): { channelId: string; lastReadAt: string | null }[] {
  const now = new Date().toISOString();
  const channels = getAllChannels();
  const claimedChannels: { channelId: string; lastReadAt: string | null }[] = [];

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = getDb()
      .prepare<{ lastReadAt: string | null; processing_since: string | null }, [string, string]>(
        "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      )
      .get(agentId, channel.id);

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Check if there are unread mentions
    const mentionCountRow = getDb()
      .prepare<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      )
      .get(channel.id, `%"${agentId}"%`);

    if (mentionCountRow && mentionCountRow.count > 0) {
      // Atomically claim mentions for this channel
      const result = getDb().run(
        `INSERT INTO channel_read_state (agentId, channelId, lastReadAt, processing_since)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agentId, channelId) DO UPDATE SET
           processing_since = CASE
             WHEN processing_since IS NULL THEN ?
             ELSE processing_since
           END
         WHERE processing_since IS NULL`,
        [agentId, channel.id, lastReadAt || new Date(0).toISOString(), now, now],
      );

      // Only add to claimed list if we actually claimed it (not already processing)
      if (result.changes > 0) {
        claimedChannels.push({ channelId: channel.id, lastReadAt });
      }
    }
  }

  return claimedChannels;
}

/**
 * Release mention processing for specific channels.
 * Clears processing_since to allow future polling.
 */
export function releaseMentionProcessing(agentId: string, channelIds: string[]): void {
  if (channelIds.length === 0) return;

  const placeholders = channelIds.map(() => "?").join(",");
  getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE agentId = ? AND channelId IN (${placeholders})`,
    [agentId, ...channelIds],
  );
}

/**
 * Auto-release stale mention processing (for crashed Claude processes).
 */
export function releaseStaleMentionProcessing(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE processing_since IS NOT NULL AND processing_since < ?`,
    [cutoffTime],
  );

  return result.changes;
}

// ============================================================================
// Service Operations (PM2/background services)
// ============================================================================

type ServiceRow = {
  id: string;
  agentId: string;
  name: string;
  port: number;
  description: string | null;
  url: string | null;
  healthCheckPath: string | null;
  status: ServiceStatus;
  // PM2 configuration
  script: string;
  cwd: string | null;
  interpreter: string | null;
  args: string | null; // JSON array
  env: string | null; // JSON object
  metadata: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    port: row.port,
    description: row.description ?? undefined,
    url: row.url ?? undefined,
    healthCheckPath: row.healthCheckPath ?? "/health",
    status: row.status,
    // PM2 configuration
    script: row.script,
    cwd: row.cwd ?? undefined,
    interpreter: row.interpreter ?? undefined,
    args: row.args ? JSON.parse(row.args) : undefined,
    env: row.env ? JSON.parse(row.env) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateServiceOptions {
  port?: number;
  description?: string;
  url?: string;
  healthCheckPath?: string;
  // PM2 configuration
  script: string; // Required
  cwd?: string;
  interpreter?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export function createService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Service {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<ServiceRow, (string | number | null)[]>(
      `INSERT INTO services (id, agentId, name, port, description, url, healthCheckPath, status, script, cwd, interpreter, args, env, metadata, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      agentId,
      name,
      options.port ?? 3000,
      options.description ?? null,
      options.url ?? null,
      options.healthCheckPath ?? "/health",
      options.script,
      options.cwd ?? null,
      options.interpreter ?? null,
      options.args ? JSON.stringify(options.args) : null,
      options.env ? JSON.stringify(options.env) : null,
      JSON.stringify(options.metadata ?? {}),
      now,
      now,
    );

  if (!row) throw new Error("Failed to create service");

  try {
    createLogEntry({
      eventType: "service_registered",
      agentId,
      newValue: name,
      metadata: { serviceId: id, port: options?.port ?? 3000 },
    });
  } catch {}

  return rowToService(row);
}

export function getServiceById(id: string): Service | null {
  const row = getDb().prepare<ServiceRow, [string]>("SELECT * FROM services WHERE id = ?").get(id);
  return row ? rowToService(row) : null;
}

export function getServiceByAgentAndName(agentId: string, name: string): Service | null {
  const row = getDb()
    .prepare<ServiceRow, [string, string]>("SELECT * FROM services WHERE agentId = ? AND name = ?")
    .get(agentId, name);
  return row ? rowToService(row) : null;
}

export function getServicesByAgentId(agentId: string): Service[] {
  return getDb()
    .prepare<ServiceRow, [string]>("SELECT * FROM services WHERE agentId = ? ORDER BY name")
    .all(agentId)
    .map(rowToService);
}

export interface ServiceFilters {
  agentId?: string;
  name?: string;
  status?: ServiceStatus;
}

export function getAllServices(filters?: ServiceFilters): Service[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.name) {
    conditions.push("name LIKE ?");
    params.push(`%${filters.name}%`);
  }

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM services ${whereClause} ORDER BY
    CASE status
      WHEN 'healthy' THEN 1
      WHEN 'starting' THEN 2
      WHEN 'unhealthy' THEN 3
      WHEN 'stopped' THEN 4
    END, name`;

  return getDb()
    .prepare<ServiceRow, string[]>(query)
    .all(...params)
    .map(rowToService);
}

export function updateServiceStatus(id: string, status: ServiceStatus): Service | null {
  const oldService = getServiceById(id);
  if (!oldService) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<ServiceRow, [ServiceStatus, string, string]>(
      `UPDATE services SET status = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *`,
    )
    .get(status, now, id);

  if (row && oldService.status !== status) {
    try {
      createLogEntry({
        eventType: "service_status_change",
        agentId: oldService.agentId,
        oldValue: oldService.status,
        newValue: status,
        metadata: { serviceId: id, serviceName: oldService.name },
      });
    } catch {}
  }

  return row ? rowToService(row) : null;
}

export function deleteService(id: string): boolean {
  const service = getServiceById(id);
  if (service) {
    try {
      createLogEntry({
        eventType: "service_unregistered",
        agentId: service.agentId,
        oldValue: service.name,
        metadata: { serviceId: id },
      });
    } catch {}
  }

  const result = getDb().run("DELETE FROM services WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Upsert a service - update if exists (by agentId + name), create if not */
export function upsertService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Service {
  const existing = getServiceByAgentAndName(agentId, name);

  if (existing) {
    // Update existing service
    const now = new Date().toISOString();
    const row = getDb()
      .prepare<ServiceRow, (string | number | null)[]>(
        `UPDATE services SET
          port = ?, description = ?, url = ?, healthCheckPath = ?,
          script = ?, cwd = ?, interpreter = ?, args = ?, env = ?,
          metadata = ?, lastUpdatedAt = ?
        WHERE id = ? RETURNING *`,
      )
      .get(
        options.port ?? existing.port,
        options.description ?? existing.description ?? null,
        options.url ?? existing.url ?? null,
        options.healthCheckPath ?? existing.healthCheckPath ?? "/health",
        options.script,
        options.cwd ?? null,
        options.interpreter ?? null,
        options.args ? JSON.stringify(options.args) : null,
        options.env ? JSON.stringify(options.env) : null,
        JSON.stringify(options.metadata ?? existing.metadata ?? {}),
        now,
        existing.id,
      );

    if (!row) throw new Error("Failed to update service");
    return rowToService(row);
  }

  // Create new service
  return createService(agentId, name, options);
}

export function deleteServicesByAgentId(agentId: string): number {
  const services = getServicesByAgentId(agentId);
  for (const service of services) {
    try {
      createLogEntry({
        eventType: "service_unregistered",
        agentId,
        oldValue: service.name,
        metadata: { serviceId: service.id },
      });
    } catch {}
  }

  const result = getDb().run("DELETE FROM services WHERE agentId = ?", [agentId]);
  return result.changes;
}

// ============================================================================
// Session Log Operations (raw CLI output)
// ============================================================================

type SessionLogRow = {
  id: string;
  taskId: string | null;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

function rowToSessionLog(row: SessionLogRow): SessionLog {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId,
    iteration: row.iteration,
    cli: row.cli,
    content: row.content,
    lineNumber: row.lineNumber,
    createdAt: row.createdAt,
  };
}

export const sessionLogQueries = {
  insert: () =>
    getDb().prepare<SessionLogRow, [string, string | null, string, number, string, string, number]>(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  insertBatch: () =>
    getDb().prepare<null, [string, string | null, string, number, string, string, number]>(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByTaskId: () =>
    getDb().prepare<SessionLogRow, [string]>(
      "SELECT * FROM session_logs WHERE taskId = ? ORDER BY iteration ASC, lineNumber ASC",
    ),

  getRecentByTaskId: () =>
    getDb().prepare<SessionLogRow, [string, number]>(
      `SELECT * FROM (
         SELECT * FROM session_logs WHERE taskId = ?
         ORDER BY iteration DESC, lineNumber DESC
         LIMIT ?
       ) ORDER BY iteration ASC, lineNumber ASC`,
    ),

  getBySessionId: () =>
    getDb().prepare<SessionLogRow, [string, number]>(
      "SELECT * FROM session_logs WHERE sessionId = ? AND iteration = ? ORDER BY lineNumber ASC",
    ),
};

export function createSessionLogs(logs: {
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  lines: string[];
}): void {
  const stmt = sessionLogQueries.insertBatch();
  getDb().transaction(() => {
    for (let i = 0; i < logs.lines.length; i++) {
      const line = logs.lines[i];
      if (line === undefined) continue;
      stmt.run(
        crypto.randomUUID(),
        logs.taskId ?? null,
        logs.sessionId,
        logs.iteration,
        logs.cli,
        // Defense-in-depth: callers (runner.ts → POST /api/session-logs) send
        // content that is already scrubbed at the adapter emit site. We scrub
        // again here so any future write path that bypasses the adapter still
        // lands clean text in the persistent session_logs table.
        scrubSecrets(line),
        i,
      );
    }
  })();
}

export function getSessionLogsByTaskId(taskId: string, limit?: number): SessionLog[] {
  if (typeof limit === "number" && limit > 0) {
    return sessionLogQueries.getRecentByTaskId().all(taskId, limit).map(rowToSessionLog);
  }
  return sessionLogQueries.getByTaskId().all(taskId).map(rowToSessionLog);
}

export function getSessionLogsBySession(sessionId: string, iteration: number): SessionLog[] {
  return sessionLogQueries.getBySessionId().all(sessionId, iteration).map(rowToSessionLog);
}

// ============================================================================
// Session Costs (aggregated cost data per session)
// ============================================================================

type SessionCostRow = {
  id: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Migration 063 additions:
  reasoningOutputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  numTurns: number | null;
  model: string;
  isError: number;
  costSource: string;
  createdAt: string;
};

function rowToSessionCost(row: SessionCostRow): SessionCost {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: row.taskId ?? undefined,
    agentId: row.agentId,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningOutputTokens: row.reasoningOutputTokens ?? 0,
    thinkingTokens: row.thinkingTokens ?? 0,
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    model: row.model,
    isError: row.isError === 1,
    costSource: (row.costSource as SessionCostSource) ?? "harness",
    createdAt: row.createdAt,
  };
}

const sessionCostQueries = {
  insert: () =>
    getDb().prepare<
      null,
      [
        string,
        string,
        string | null,
        string,
        number,
        number,
        number,
        number,
        number,
        number, // reasoningOutputTokens
        number, // thinkingTokens
        number, // durationMs
        number | null, // numTurns
        string, // model
        number, // isError
        string, // costSource
      ]
    >(
      `INSERT INTO session_costs (
         id, sessionId, taskId, agentId,
         totalCostUsd, inputTokens, outputTokens,
         cacheReadTokens, cacheWriteTokens,
         reasoningOutputTokens, thinkingTokens,
         durationMs, numTurns, model, isError,
         costSource, createdAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByTaskId: () =>
    getDb().prepare<SessionCostRow, [string, number]>(
      "SELECT * FROM session_costs WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByAgentId: () =>
    getDb().prepare<SessionCostRow, [string, number]>(
      "SELECT * FROM session_costs WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getAll: () =>
    getDb().prepare<SessionCostRow, [number]>(
      "SELECT * FROM session_costs ORDER BY createdAt DESC LIMIT ?",
    ),
};

export interface CreateSessionCostInput {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  // Migration 063 additions — adapters that have these numbers should pass
  // them; defaulting to 0 preserves the old write shape for callers that don't.
  reasoningOutputTokens?: number;
  thinkingTokens?: number;
  durationMs: number;
  // Nullable: some adapters (claude when num_turns is absent) can't honestly
  // report a turn count; we prefer null over a faked 1.
  numTurns: number | null;
  model: string;
  isError?: boolean;
  /**
   * Phase 6 (migration 063 added 'unpriced'): where `totalCostUsd` came from.
   *  - 'harness'        — value reported by the harness as-is (default).
   *  - 'pricing-table'  — value recomputed by the API from `pricing` rows.
   *  - 'unpriced'       — recompute attempted but no matching pricing rows;
   *                       `totalCostUsd` is whatever the worker submitted.
   */
  costSource?: SessionCostSource;
}

export function createSessionCost(input: CreateSessionCostInput): SessionCost {
  const id = crypto.randomUUID();
  const costSource: SessionCostSource = input.costSource ?? "harness";
  const reasoningOutputTokens = input.reasoningOutputTokens ?? 0;
  const thinkingTokens = input.thinkingTokens ?? 0;
  sessionCostQueries
    .insert()
    .run(
      id,
      input.sessionId,
      input.taskId ?? null,
      input.agentId,
      input.totalCostUsd,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.cacheReadTokens ?? 0,
      input.cacheWriteTokens ?? 0,
      reasoningOutputTokens,
      thinkingTokens,
      input.durationMs,
      input.numTurns,
      input.model,
      input.isError ? 1 : 0,
      costSource,
    );

  return {
    id,
    sessionId: input.sessionId,
    taskId: input.taskId,
    agentId: input.agentId,
    totalCostUsd: input.totalCostUsd,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    reasoningOutputTokens,
    thinkingTokens,
    durationMs: input.durationMs,
    numTurns: input.numTurns,
    model: input.model,
    isError: input.isError ?? false,
    costSource,
    createdAt: new Date().toISOString(),
  };
}

export function getSessionCostsByTaskId(taskId: string, limit = 500): SessionCost[] {
  return sessionCostQueries.getByTaskId().all(taskId, limit).map(rowToSessionCost);
}

export function getSessionCostsByAgentId(agentId: string, limit = 100): SessionCost[] {
  return sessionCostQueries.getByAgentId().all(agentId, limit).map(rowToSessionCost);
}

export function getAllSessionCosts(limit = 100): SessionCost[] {
  return sessionCostQueries.getAll().all(limit).map(rowToSessionCost);
}

// --- Date-filtered session costs (P1) ---

export function getSessionCostsFiltered(opts: {
  agentId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): SessionCost[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }
  if (opts.startDate) {
    conditions.push("createdAt >= ?");
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push("createdAt <= ?");
    params.push(opts.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;
  params.push(limit);

  return getDb()
    .prepare<SessionCostRow, (string | number)[]>(
      `SELECT * FROM session_costs ${where} ORDER BY createdAt DESC LIMIT ?`,
    )
    .all(...params)
    .map(rowToSessionCost);
}

// --- Aggregation queries (P0) ---

export interface SessionCostSummaryTotals {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalDurationMs: number;
  totalSessions: number;
  avgCostPerSession: number;
}

export interface SessionCostDailyRow {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
}

export interface SessionCostByAgentRow {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  durationMs: number;
}

export function getSessionCostSummary(opts: {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  groupBy?: "day" | "agent" | "both";
}): {
  totals: SessionCostSummaryTotals;
  daily: SessionCostDailyRow[];
  byAgent: SessionCostByAgentRow[];
} {
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts.startDate) {
    conditions.push("createdAt >= ?");
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push("createdAt <= ?");
    params.push(opts.endDate);
  }
  if (opts.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Totals
  type TotalsRow = {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalDurationMs: number;
    totalSessions: number;
  };

  const totalsRow = getDb()
    .prepare<TotalsRow, string[]>(
      `SELECT
        COALESCE(SUM(totalCostUsd), 0) as totalCostUsd,
        COALESCE(SUM(inputTokens), 0) as totalInputTokens,
        COALESCE(SUM(outputTokens), 0) as totalOutputTokens,
        COALESCE(SUM(cacheReadTokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cacheWriteTokens), 0) as totalCacheWriteTokens,
        COALESCE(SUM(durationMs), 0) as totalDurationMs,
        COUNT(*) as totalSessions
      FROM session_costs ${where}`,
    )
    .get(...params);

  const totals: SessionCostSummaryTotals = totalsRow
    ? {
        ...totalsRow,
        avgCostPerSession:
          totalsRow.totalSessions > 0 ? totalsRow.totalCostUsd / totalsRow.totalSessions : 0,
      }
    : {
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalDurationMs: 0,
        totalSessions: 0,
        avgCostPerSession: 0,
      };

  // Daily breakdown
  const groupBy = opts.groupBy ?? "both";
  let daily: SessionCostDailyRow[] = [];
  if (groupBy === "day" || groupBy === "both") {
    daily = getDb()
      .prepare<
        {
          date: string;
          costUsd: number;
          inputTokens: number;
          outputTokens: number;
          sessions: number;
        },
        string[]
      >(
        `SELECT
          DATE(createdAt) as date,
          COALESCE(SUM(totalCostUsd), 0) as costUsd,
          COALESCE(SUM(inputTokens), 0) as inputTokens,
          COALESCE(SUM(outputTokens), 0) as outputTokens,
          COUNT(*) as sessions
        FROM session_costs ${where}
        GROUP BY DATE(createdAt)
        ORDER BY date ASC`,
      )
      .all(...params);
  }

  // Per-agent breakdown
  let byAgent: SessionCostByAgentRow[] = [];
  if (groupBy === "agent" || groupBy === "both") {
    byAgent = getDb()
      .prepare<
        {
          agentId: string;
          costUsd: number;
          inputTokens: number;
          outputTokens: number;
          sessions: number;
          durationMs: number;
        },
        string[]
      >(
        `SELECT
          agentId,
          COALESCE(SUM(totalCostUsd), 0) as costUsd,
          COALESCE(SUM(inputTokens), 0) as inputTokens,
          COALESCE(SUM(outputTokens), 0) as outputTokens,
          COUNT(*) as sessions,
          COALESCE(SUM(durationMs), 0) as durationMs
        FROM session_costs ${where}
        GROUP BY agentId
        ORDER BY costUsd DESC`,
      )
      .all(...params);
  }

  return { totals, daily, byAgent };
}

// --- Dashboard cost summary (P4) ---

export interface DashboardCostSummary {
  costToday: number;
  costMtd: number;
}

export function getDashboardCostSummary(): DashboardCostSummary {
  // Phase 13: compute the date boundaries in TS and pass them as ISO 8601
  // strings. `session_costs.createdAt` is a TEXT ISO 8601 column; lexicographic
  // comparison on ISO 8601 sorts correctly, so the comparison works as long
  // as both sides are the same shape. The old code compared an ISO string
  // (`2026-05-15T03:45:12.123Z`) against `date('now')` (which returns the
  // string `2026-05-15`) — lexicographically `2026-05-15T...` > `2026-05-15`,
  // so post-midnight rows correctly counted, BUT rows whose ISO began with
  // the EXACT bare-date string would fail the `>=` check inconsistently
  // depending on millisecond precision. Use a proper ISO-millisecond boundary
  // for both halves so the comparison is unambiguous.
  const now = new Date();
  const startOfDayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const startOfMonthUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  type CostRow = { costToday: number; costMtd: number };
  const row = getDb()
    .prepare<CostRow, [string, string]>(
      `SELECT
        COALESCE(SUM(CASE WHEN createdAt >= ? THEN totalCostUsd ELSE 0 END), 0) as costToday,
        COALESCE(SUM(totalCostUsd), 0) as costMtd
      FROM session_costs
      WHERE createdAt >= ?`,
    )
    .get(startOfDayUtc, startOfMonthUtc);

  return row ?? { costToday: 0, costMtd: 0 };
}

// ============================================================================
// Inbox Message Operations
// ============================================================================

type InboxMessageRow = {
  id: string;
  agentId: string;
  content: string;
  source: string;
  status: InboxMessageStatus;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  matchedText: string | null;
  delegatedToTaskId: string | null;
  responseText: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToInboxMessage(row: InboxMessageRow): InboxMessage {
  return {
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    source: row.source as "slack",
    status: row.status,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    matchedText: row.matchedText ?? undefined,
    delegatedToTaskId: row.delegatedToTaskId ?? undefined,
    responseText: row.responseText ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export interface CreateInboxMessageOptions {
  source?: "slack" | "agentmail";
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  matchedText?: string;
}

export function createInboxMessage(
  agentId: string,
  content: string,
  options?: CreateInboxMessageOptions,
): InboxMessage {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<InboxMessageRow, (string | null)[]>(
      `INSERT INTO inbox_messages (id, agentId, content, source, status, slackChannelId, slackThreadTs, slackUserId, matchedText, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      agentId,
      content,
      options?.source ?? "slack",
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      options?.matchedText ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create inbox message");
  return rowToInboxMessage(row);
}

export function getInboxMessageById(id: string): InboxMessage | null {
  const row = getDb()
    .prepare<InboxMessageRow, [string]>("SELECT * FROM inbox_messages WHERE id = ?")
    .get(id);
  return row ? rowToInboxMessage(row) : null;
}

export function getUnreadInboxMessages(agentId: string): InboxMessage[] {
  return getDb()
    .prepare<InboxMessageRow, [string]>(
      "SELECT * FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC",
    )
    .all(agentId)
    .map(rowToInboxMessage);
}

/**
 * Atomically claim up to N unread inbox messages for processing.
 * Marks them as 'processing' to prevent duplicate polling.
 * Returns empty array if no unread messages available.
 */
export function claimInboxMessages(agentId: string, limit: number = 5): InboxMessage[] {
  const now = new Date().toISOString();

  // Get IDs of unread messages to claim
  const unreadIds = getDb()
    .prepare<{ id: string }, [string, number]>(
      "SELECT id FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC LIMIT ?",
    )
    .all(agentId, limit)
    .map((row) => row.id);

  if (unreadIds.length === 0) {
    return [];
  }

  // Atomically update status to 'processing' for these specific IDs
  const placeholders = unreadIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare<InboxMessageRow, (string | number)[]>(
      `UPDATE inbox_messages SET status = 'processing', lastUpdatedAt = ?
       WHERE id IN (${placeholders}) AND status = 'unread' RETURNING *`,
    )
    .all(now, ...unreadIds);

  return rows.map(rowToInboxMessage);
}

export function markInboxMessageRead(id: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string]>(
      "UPDATE inbox_messages SET status = 'read', lastUpdatedAt = ? WHERE id = ? RETURNING *",
    )
    .get(now, id);
  return row ? rowToInboxMessage(row) : null;
}

export function markInboxMessageResponded(id: string, responseText: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      "UPDATE inbox_messages SET status = 'responded', responseText = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    )
    .get(responseText, now, id);
  return row ? rowToInboxMessage(row) : null;
}

export function markInboxMessageDelegated(id: string, taskId: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      "UPDATE inbox_messages SET status = 'delegated', delegatedToTaskId = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    )
    .get(taskId, now, id);
  return row ? rowToInboxMessage(row) : null;
}

/**
 * Release inbox messages that have been in 'processing' status for too long.
 * This handles cases where Claude process crashes or fails to respond/delegate.
 * Call this periodically from the runner or add a database trigger.
 */
export function releaseStaleProcessingInbox(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE inbox_messages SET status = 'unread', lastUpdatedAt = ?
     WHERE status = 'processing' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

// ============================================================================
// Concurrent Context (for lead session awareness)
// ============================================================================

export interface ConcurrentContext {
  processingInboxMessages: Array<{
    id: string;
    content: string;
    source: string;
    slackChannelId: string | null;
    slackThreadTs: string | null;
    createdAt: string;
  }>;
  recentTaskDelegations: Array<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    creatorAgentId: string | null;
    status: string;
    createdAt: string;
  }>;
  activeSwarmTasks: Array<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    status: string;
    createdAt: string;
    progress: string | null;
  }>;
}

/**
 * Get concurrent context for lead session awareness.
 * Returns processing inbox messages, recent task delegations by leads,
 * and currently active (in-progress) tasks across the swarm.
 */
export function getConcurrentContext(): ConcurrentContext {
  // 1. Inbox messages currently being processed (status = 'processing')
  const processingInboxMessages = getDb()
    .prepare<
      {
        id: string;
        content: string;
        source: string;
        slackChannelId: string | null;
        slackThreadTs: string | null;
        createdAt: string;
      },
      []
    >(
      "SELECT id, content, source, slackChannelId, slackThreadTs, createdAt FROM inbox_messages WHERE status = 'processing' ORDER BY createdAt DESC",
    )
    .all();

  // 2. Tasks created in the last 5 minutes by lead agents
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recentTaskDelegations = getDb()
    .prepare<
      {
        id: string;
        task: string;
        agentId: string | null;
        agentName: string | null;
        creatorAgentId: string | null;
        status: string;
        createdAt: string;
      },
      [string]
    >(
      `SELECT t.id, t.task, t.agentId, a.name as agentName, t.creatorAgentId, t.status, t.createdAt
       FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.createdAt > ?
         AND t.creatorAgentId IN (SELECT id FROM agents WHERE isLead = 1)
       ORDER BY t.createdAt DESC`,
    )
    .all(fiveMinutesAgo);

  // 3. Currently in-progress tasks across the swarm
  const activeSwarmTasks = getDb()
    .prepare<
      {
        id: string;
        task: string;
        agentId: string | null;
        agentName: string | null;
        status: string;
        createdAt: string;
        progress: string | null;
      },
      []
    >(
      `SELECT t.id, t.task, t.agentId, a.name as agentName, t.status, t.createdAt, t.progress
       FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status = 'in_progress'
       ORDER BY t.createdAt DESC`,
    )
    .all();

  return {
    processingInboxMessages,
    recentTaskDelegations,
    activeSwarmTasks,
  };
}

// ============================================================================
// Scheduled Task Queries
// ============================================================================

type ScheduledTaskRow = {
  id: string;
  name: string;
  description: string | null;
  cronExpression: string | null;
  intervalMs: number | null;
  taskTemplate: string;
  taskType: string | null;
  tags: string | null;
  priority: number;
  targetAgentId: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdByAgentId: string | null;
  timezone: string;
  consecutiveErrors: number | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  model: string | null;
  modelTier: string | null;
  scheduleType: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

// ── List-endpoint slimming helpers ──────────────────────────────────────────
// List endpoints ship slim rows by default; heavy text fields are replaced
// with bounded previews. Lengths are generous enough for triage/recognition
// while keeping list payloads small.
/** Preview length for a schedule's `taskTemplate`. */
const SCHEDULE_TEMPLATE_PREVIEW_LENGTH = 280;
/** Preview length for a task's `task` text (pool-triage needs to read it). */
const TASK_PREVIEW_LENGTH = 300;

/** Truncate text for a list-row preview. Appends an ellipsis when clipped. */
function previewText(text: string | null | undefined, maxChars: number): string {
  const s = text ?? "";
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

function rowToScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    cronExpression: row.cronExpression ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    taskTemplate: row.taskTemplate,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority,
    targetAgentId: row.targetAgentId ?? undefined,
    enabled: row.enabled === 1,
    lastRunAt: normalizeDate(row.lastRunAt) ?? undefined,
    nextRunAt: normalizeDate(row.nextRunAt) ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    timezone: row.timezone,
    consecutiveErrors: row.consecutiveErrors ?? 0,
    lastErrorAt: normalizeDate(row.lastErrorAt) ?? undefined,
    lastErrorMessage: row.lastErrorMessage ?? undefined,
    model: row.model ?? undefined,
    modelTier: parseModelTier(row.modelTier) ?? undefined,
    scheduleType: row.scheduleType as "recurring" | "one_time",
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
  scheduleType?: "recurring" | "one_time";
  hideCompleted?: boolean;
}

/**
 * Slim list-row mapper — replaces the full `taskTemplate` (the per-run prompt,
 * avg ~3.6 KB) with a bounded `taskTemplatePreview`. Fetch the full template
 * via `getScheduledTaskById(id)`.
 */
function rowToScheduledTaskSummary(row: ScheduledTaskRow): ScheduledTaskSummary {
  const { taskTemplate, ...rest } = rowToScheduledTask(row);
  return {
    ...rest,
    taskTemplatePreview: previewText(taskTemplate, SCHEDULE_TEMPLATE_PREVIEW_LENGTH),
  };
}

export function getScheduledTasks(filters?: ScheduledTaskFilters): ScheduledTask[];
export function getScheduledTasks(
  filters: ScheduledTaskFilters | undefined,
  opts: { slim: true },
): ScheduledTaskSummary[];
export function getScheduledTasks(
  filters?: ScheduledTaskFilters,
  opts?: { slim?: boolean },
): ScheduledTask[] | ScheduledTaskSummary[] {
  let query = "SELECT * FROM scheduled_tasks WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters?.enabled !== undefined) {
    query += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }

  if (filters?.name) {
    query += " AND name LIKE ?";
    params.push(`%${filters.name}%`);
  }

  if (filters?.scheduleType) {
    query += " AND scheduleType = ?";
    params.push(filters.scheduleType);
  }

  if (filters?.hideCompleted !== false) {
    query += " AND NOT (scheduleType = 'one_time' AND enabled = 0)";
  }

  query += " ORDER BY name ASC";

  const rows = getDb()
    .prepare<ScheduledTaskRow, (string | number)[]>(query)
    .all(...params);
  return opts?.slim ? rows.map(rowToScheduledTaskSummary) : rows.map(rowToScheduledTask);
}

export function getScheduledTaskById(id: string): ScheduledTask | null {
  const row = getDb()
    .prepare<ScheduledTaskRow, [string]>("SELECT * FROM scheduled_tasks WHERE id = ?")
    .get(id);
  return row ? rowToScheduledTask(row) : null;
}

export function getScheduledTaskByName(name: string): ScheduledTask | null {
  const row = getDb()
    .prepare<ScheduledTaskRow, [string]>("SELECT * FROM scheduled_tasks WHERE name = ?")
    .get(name);
  return row ? rowToScheduledTask(row) : null;
}

export interface CreateScheduledTaskData {
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string;
  enabled?: boolean;
  nextRunAt?: string;
  createdByAgentId?: string;
  timezone?: string;
  model?: string;
  modelTier?: ModelTier;
  scheduleType?: "recurring" | "one_time";
  createdBy?: string;
}

export function createScheduledTask(data: CreateScheduledTaskData): ScheduledTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<ScheduledTaskRow, (string | number | null)[]>(
      `INSERT INTO scheduled_tasks (
        id, name, description, cronExpression, intervalMs, taskTemplate,
        taskType, tags, priority, targetAgentId, enabled, nextRunAt,
        createdByAgentId, timezone, model, modelTier, scheduleType, createdAt, lastUpdatedAt,
        created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      data.cronExpression ?? null,
      data.intervalMs ?? null,
      data.taskTemplate,
      data.taskType ?? null,
      JSON.stringify(data.tags ?? []),
      data.priority ?? 50,
      data.targetAgentId ?? null,
      data.enabled !== false ? 1 : 0,
      data.nextRunAt ?? null,
      data.createdByAgentId ?? null,
      data.timezone ?? "UTC",
      data.model ?? null,
      data.modelTier ?? null,
      data.scheduleType ?? "recurring",
      now,
      now,
      data.createdBy ?? null,
      data.createdBy ?? null,
    );

  if (!row) throw new Error("Failed to create scheduled task");
  return rowToScheduledTask(row);
}

export interface UpdateScheduledTaskData {
  name?: string;
  description?: string;
  cronExpression?: string | null;
  intervalMs?: number | null;
  taskTemplate?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  targetAgentId?: string | null;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string | null;
  timezone?: string;
  consecutiveErrors?: number;
  lastErrorAt?: string | null;
  lastErrorMessage?: string | null;
  model?: string | null;
  modelTier?: ModelTier | null;
  scheduleType?: "recurring" | "one_time";
  lastUpdatedAt?: string;
  updatedBy?: string;
}

export function updateScheduledTask(
  id: string,
  data: UpdateScheduledTaskData,
): ScheduledTask | null {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (data.name !== undefined) {
    updates.push("name = ?");
    params.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description);
  }
  if (data.cronExpression !== undefined) {
    updates.push("cronExpression = ?");
    params.push(data.cronExpression);
  }
  if (data.intervalMs !== undefined) {
    updates.push("intervalMs = ?");
    params.push(data.intervalMs);
  }
  if (data.taskTemplate !== undefined) {
    updates.push("taskTemplate = ?");
    params.push(data.taskTemplate);
  }
  if (data.taskType !== undefined) {
    updates.push("taskType = ?");
    params.push(data.taskType);
  }
  if (data.tags !== undefined) {
    updates.push("tags = ?");
    params.push(JSON.stringify(data.tags));
  }
  if (data.priority !== undefined) {
    updates.push("priority = ?");
    params.push(data.priority);
  }
  if (data.targetAgentId !== undefined) {
    updates.push("targetAgentId = ?");
    params.push(data.targetAgentId);
  }
  if (data.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(data.enabled ? 1 : 0);
  }
  if (data.lastRunAt !== undefined) {
    updates.push("lastRunAt = ?");
    params.push(data.lastRunAt);
  }
  if (data.nextRunAt !== undefined) {
    updates.push("nextRunAt = ?");
    params.push(data.nextRunAt);
  }
  if (data.timezone !== undefined) {
    updates.push("timezone = ?");
    params.push(data.timezone);
  }
  if (data.consecutiveErrors !== undefined) {
    updates.push("consecutiveErrors = ?");
    params.push(data.consecutiveErrors);
  }
  if (data.lastErrorAt !== undefined) {
    updates.push("lastErrorAt = ?");
    params.push(data.lastErrorAt);
  }
  if (data.lastErrorMessage !== undefined) {
    updates.push("lastErrorMessage = ?");
    params.push(data.lastErrorMessage);
  }
  if (data.model !== undefined) {
    updates.push("model = ?");
    params.push(data.model);
  }
  if (data.modelTier !== undefined) {
    updates.push("modelTier = ?");
    params.push(data.modelTier);
  }
  if (data.scheduleType !== undefined) {
    updates.push("scheduleType = ?");
    params.push(data.scheduleType);
  }
  if (data.updatedBy !== undefined) {
    updates.push("updated_by = ?");
    params.push(data.updatedBy);
  }

  if (updates.length === 0) {
    return getScheduledTaskById(id);
  }

  updates.push("lastUpdatedAt = ?");
  params.push(data.lastUpdatedAt ?? new Date().toISOString());

  params.push(id);

  const row = getDb()
    .prepare<ScheduledTaskRow, (string | number | null)[]>(
      `UPDATE scheduled_tasks SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToScheduledTask(row) : null;
}

export function deleteScheduledTask(id: string): boolean {
  const result = getDb().run("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Get all enabled scheduled tasks that are due for execution.
 * A task is due when its nextRunAt time is <= now.
 */
export function getDueScheduledTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare<ScheduledTaskRow, [string]>(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?
       ORDER BY nextRunAt ASC`,
    )
    .all(now)
    .map(rowToScheduledTask);
}

// ============================================================================
// Swarm Config Operations (Centralized Environment/Config Management)
// ============================================================================

type SwarmConfigRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: number; // SQLite boolean
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  encrypted: number; // SQLite boolean: 0 = plaintext, 1 = AES-256-GCM ciphertext
};

type SwarmConfigLookupRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  isSecret: number;
  encrypted: number;
};

const RESERVED_CONFIG_PLACEHOLDER = "[reserved key stored in swarm_config; delete this row]";

function rowToSwarmConfig(row: SwarmConfigRow): SwarmConfig {
  const isEncrypted = row.encrypted === 1;
  if (isReservedConfigKey(row.key)) {
    return {
      id: row.id,
      scope: row.scope as "global" | "agent" | "repo",
      scopeId: row.scopeId ?? null,
      key: row.key,
      value: RESERVED_CONFIG_PLACEHOLDER,
      isSecret: row.isSecret === 1,
      envPath: row.envPath ?? null,
      description: row.description ?? null,
      createdAt: row.createdAt,
      lastUpdatedAt: row.lastUpdatedAt,
      encrypted: isEncrypted,
    };
  }

  let value = row.value;
  if (isEncrypted) {
    try {
      value = decryptSecret(row.value, getEncryptionKey());
    } catch (err) {
      throw new Error(
        `Failed to decrypt config '${row.key}' (id=${row.id}): check SECRETS_ENCRYPTION_KEY matches the key used at encryption time`,
        { cause: err },
      );
    }
  }
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    value,
    isSecret: row.isSecret === 1,
    envPath: row.envPath ?? null,
    description: row.description ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    encrypted: isEncrypted,
  };
}

/**
 * Scan swarm_config for any rows flagged `isSecret = 1` whose `encrypted`
 * column is still 0 (plaintext), encrypt them in a single transaction, and
 * flip the flag. Called exactly once during `initDb` on the main path — never
 * on the test template fast-path.
 *
 * Exported for tests so they can simulate a pre-existing legacy row without
 * needing to replay a full boot.
 */
export function autoEncryptLegacyPlaintextSecrets(
  database: Database,
  dbPath: string,
  options: { createBackup?: boolean } = {},
): void {
  const rows = database
    .prepare<{ id: string; key: string; value: string }, []>(
      "SELECT id, key, value FROM swarm_config WHERE isSecret = 1 AND encrypted = 0",
    )
    .all();
  if (rows.length === 0) return;

  const key = getEncryptionKey();

  // Create plaintext backup if key was auto-generated (not user-provided)
  if (options.createBackup) {
    const { writeFileSync } = require("node:fs");
    const backupPath = `${dbPath}.backup.secrets-${new Date().toISOString().split("T")[0]}.env`;
    const backupLines = [
      "# PLAINTEXT SECRET BACKUP - CREATED DURING AUTO-ENCRYPTION MIGRATION",
      "# This file was created because you did not provide SECRETS_ENCRYPTION_KEY",
      "# DELETE THIS FILE after verifying your encryption key is safely backed up",
      "#",
      "# Encryption key location:",
      "#   - Check: <data-dir>/.encryption-key",
      "#   - Or set: SECRETS_ENCRYPTION_KEY=<base64-key>",
      "",
      ...rows.map((r) => `${r.key}=${r.value}`),
      "",
    ].join("\n");

    try {
      writeFileSync(backupPath, backupLines, { mode: 0o600 });
      console.warn(`[secrets] Created plaintext backup: ${backupPath}`);
      console.warn(`[secrets] DELETE THIS FILE after verifying your encryption key is backed up!`);
    } catch (err) {
      console.error(`[secrets] Failed to create backup file: ${(err as Error).message}`);
      // Continue with encryption even if backup fails - the secrets are still in DB
    }
  }

  console.log(`[secrets] Encrypting ${rows.length} legacy plaintext secret(s)...`);

  const txn = database.transaction((items: { id: string; value: string }[]) => {
    const stmt = database.prepare<unknown, [string, string]>(
      "UPDATE swarm_config SET value = ?, encrypted = 1 WHERE id = ?",
    );
    for (const r of items) {
      stmt.run(encryptSecret(r.value, key), r.id);
    }
  });
  txn(rows);
  console.log(`[secrets] Auto-migrated ${rows.length} secret(s) to encrypted storage.`);
}

/**
 * Mask secret values in config entries for API responses.
 */
export function maskSecrets(configs: SwarmConfig[]): SwarmConfig[] {
  return configs.map((c) => (c.isSecret ? { ...c, value: "********" } : c));
}

/**
 * Write config values to .env files on disk when `envPath` is set.
 * Groups configs by envPath, reads existing file, updates/adds matching keys, writes back.
 */
function writeEnvFile(configs: SwarmConfig[]): void {
  const { readFileSync, writeFileSync } = require("node:fs");

  const byPath = new Map<string, SwarmConfig[]>();
  for (const config of configs) {
    if (!config.envPath) continue;
    const existing = byPath.get(config.envPath) ?? [];
    existing.push(config);
    byPath.set(config.envPath, existing);
  }

  for (const [envPath, entries] of byPath) {
    let lines: string[] = [];
    try {
      const content = readFileSync(envPath, "utf-8") as string;
      lines = content.split("\n");
    } catch {
      // File doesn't exist yet, start empty
    }

    for (const entry of entries) {
      const prefix = `${entry.key}=`;
      const lineIndex = lines.findIndex((l) => l.startsWith(prefix));
      const newLine = `${entry.key}=${entry.value}`;
      if (lineIndex >= 0) {
        lines[lineIndex] = newLine;
      } else {
        lines.push(newLine);
      }
    }

    const output = `${lines.filter((l) => l !== "").join("\n")}\n`;
    writeFileSync(envPath, output, "utf-8");
  }
}

/**
 * List config entries with optional filters.
 */
export function getSwarmConfigs(filters?: {
  scope?: string;
  scopeId?: string;
  key?: string;
}): SwarmConfig[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scopeId) {
    conditions.push("scopeId = ?");
    params.push(filters.scopeId);
  }
  if (filters?.key) {
    conditions.push("key = ?");
    params.push(filters.key);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM swarm_config ${whereClause} ORDER BY key ASC`;

  return getDb()
    .prepare<SwarmConfigRow, string[]>(query)
    .all(...params)
    .map(rowToSwarmConfig);
}

/**
 * Global configs that are allowed to flow into process.env.
 * Reserved env-only keys are filtered in SQL before decryption so a corrupted
 * legacy reserved row cannot block startup or reload.
 */
export function getInjectableGlobalConfigs(): SwarmConfig[] {
  return getDb()
    .prepare<SwarmConfigRow, []>(
      `SELECT * FROM swarm_config
       WHERE scope = 'global'
         AND UPPER(key) NOT IN ('API_KEY', 'SECRETS_ENCRYPTION_KEY')
       ORDER BY key ASC`,
    )
    .all()
    .map(rowToSwarmConfig);
}

/**
 * Get a single config entry by ID.
 */
export function getSwarmConfigById(id: string): SwarmConfig | null {
  const row = getDb()
    .prepare<SwarmConfigRow, [string]>("SELECT * FROM swarm_config WHERE id = ?")
    .get(id);
  return row ? rowToSwarmConfig(row) : null;
}

/**
 * Get config metadata by ID without decrypting the value. Used by cleanup
 * paths so unreadable secret rows can still be inspected and removed.
 */
export function getSwarmConfigLookupById(id: string): {
  id: string;
  scope: "global" | "agent" | "repo";
  scopeId: string | null;
  key: string;
  isSecret: boolean;
  encrypted: boolean;
} | null {
  const row = getDb()
    .prepare<SwarmConfigLookupRow, [string]>(
      "SELECT id, scope, scopeId, key, isSecret, encrypted FROM swarm_config WHERE id = ?",
    )
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    key: row.key,
    isSecret: row.isSecret === 1,
    encrypted: row.encrypted === 1,
  };
}

/**
 * Upsert a config entry. Inserts or updates by (scope, scopeId, key) unique constraint.
 */
export function upsertSwarmConfig(data: {
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
  envPath?: string | null;
  description?: string | null;
}): SwarmConfig {
  if (isReservedConfigKey(data.key)) {
    throw reservedKeyError(data.key);
  }

  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const isSecret = data.isSecret ? 1 : 0;
  const envPath = data.envPath ?? null;
  const description = data.description ?? null;

  // Encrypt secret values at rest. Non-secret values are stored verbatim so
  // they remain queryable and diffable. rowToSwarmConfig reverses this on read.
  const storedValue = data.isSecret ? encryptSecret(data.value, getEncryptionKey()) : data.value;
  const encryptedFlag: number = data.isSecret ? 1 : 0;

  // Manual check for existing entry because SQLite's UNIQUE constraint
  // treats NULL != NULL, so ON CONFLICT never fires when scopeId is NULL (global scope).
  const existing =
    scopeId === null
      ? getDb()
          .prepare<{ id: string }, [string, string]>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId IS NULL AND key = ?",
          )
          .get(data.scope, data.key)
      : getDb()
          .prepare<{ id: string }, [string, string, string]>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId = ? AND key = ?",
          )
          .get(data.scope, scopeId, data.key);

  let row: SwarmConfigRow | null;

  if (existing) {
    row = getDb()
      .prepare<
        SwarmConfigRow,
        [string, number, string | null, string | null, number, string, string]
      >(
        `UPDATE swarm_config SET value = ?, isSecret = ?, envPath = ?, description = ?, encrypted = ?, lastUpdatedAt = ?
         WHERE id = ? RETURNING *`,
      )
      .get(storedValue, isSecret, envPath, description, encryptedFlag, now, existing.id);
  } else {
    const id = crypto.randomUUID();
    row = getDb()
      .prepare<
        SwarmConfigRow,
        [
          string,
          string,
          string | null,
          string,
          string,
          number,
          string | null,
          string | null,
          string,
          string,
          number,
        ]
      >(
        `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        id,
        data.scope,
        scopeId,
        data.key,
        storedValue,
        isSecret,
        envPath,
        description,
        now,
        now,
        encryptedFlag,
      );
  }

  if (!row) throw new Error("Failed to upsert swarm config");

  // rowToSwarmConfig transparently decrypts `storedValue` back to plaintext so
  // the returned object (and downstream writeEnvFile) sees the original value.
  const config = rowToSwarmConfig(row);

  // Write to envPath if set
  if (config.envPath) {
    try {
      writeEnvFile([config]);
    } catch (e) {
      console.error(`Failed to write env file ${config.envPath}:`, e);
    }
  }

  return config;
}

/**
 * Delete a config entry by ID.
 *
 * Intentionally does not decrypt or block reserved keys. Legacy rows that
 * predate hardening must remain removable through remediation paths.
 */
export function deleteSwarmConfig(id: string): boolean {
  const result = getDb().run("DELETE FROM swarm_config WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Get resolved (merged) config for a given agent and/or repo.
 * Scope resolution: repo > agent > global (most-specific wins).
 * Returns one entry per unique key with the most-specific scope winning.
 */
export function getResolvedConfig(agentId?: string, repoId?: string): SwarmConfig[] {
  // Start with global configs
  const configMap = new Map<string, SwarmConfig>();

  const globalConfigs = getSwarmConfigs({ scope: "global" });
  for (const config of globalConfigs) {
    configMap.set(config.key, config);
  }

  // Overlay agent configs (agent wins over global)
  if (agentId) {
    const agentConfigs = getSwarmConfigs({ scope: "agent", scopeId: agentId });
    for (const config of agentConfigs) {
      configMap.set(config.key, config);
    }
  }

  // Overlay repo configs (repo wins over agent and global)
  if (repoId) {
    const repoConfigs = getSwarmConfigs({ scope: "repo", scopeId: repoId });
    for (const config of repoConfigs) {
      configMap.set(config.key, config);
    }
  }

  return Array.from(configMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

// ============================================================================
// Swarm Repos Functions (Centralized Repository Management)
// ============================================================================

type SwarmRepoRow = {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: number; // SQLite boolean
  hooks: string | null;
  guidelines: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSwarmRepo(row: SwarmRepoRow): SwarmRepo {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    autoClone: row.autoClone === 1,
    hooks: row.hooks ? JSON.parse(row.hooks) : { enabled: false },
    guidelines: row.guidelines ? JSON.parse(row.guidelines) : null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function getSwarmRepos(filters?: { autoClone?: boolean; name?: string }): SwarmRepo[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.autoClone !== undefined) {
    conditions.push("autoClone = ?");
    params.push(filters.autoClone ? 1 : 0);
  }
  if (filters?.name) {
    conditions.push("name = ?");
    params.push(filters.name);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM swarm_repos ${whereClause} ORDER BY name ASC`;

  return getDb()
    .prepare<SwarmRepoRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToSwarmRepo);
}

export function getSwarmRepoById(id: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE id = ?")
    .get(id);
  return row ? rowToSwarmRepo(row) : null;
}

export function getSwarmRepoByName(name: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE name = ?")
    .get(name);
  return row ? rowToSwarmRepo(row) : null;
}

export function getSwarmRepoByUrl(url: string): SwarmRepo | null {
  const row = getDb()
    .prepare<SwarmRepoRow, [string]>("SELECT * FROM swarm_repos WHERE url = ?")
    .get(url);
  return row ? rowToSwarmRepo(row) : null;
}

export function createSwarmRepo(data: {
  url: string;
  name: string;
  clonePath?: string;
  defaultBranch?: string;
  autoClone?: boolean;
  hooks?: { enabled: boolean };
  guidelines?: RepoGuidelines | null;
}): SwarmRepo {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clonePath = data.clonePath || `/workspace/personal/repos/${data.name}`;
  const hooksJson = JSON.stringify(data.hooks ?? { enabled: true });
  const guidelinesJson = data.guidelines ? JSON.stringify(data.guidelines) : null;

  const row = getDb()
    .prepare<
      SwarmRepoRow,
      [string, string, string, string, string, number, string | null, string | null, string, string]
    >(
      `INSERT INTO swarm_repos (id, url, name, clonePath, defaultBranch, autoClone, hooks, guidelines, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.url,
      data.name,
      clonePath,
      data.defaultBranch ?? "main",
      data.autoClone !== false ? 1 : 0,
      hooksJson,
      guidelinesJson,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create repo");
  return rowToSwarmRepo(row);
}

export function updateSwarmRepo(
  id: string,
  updates: Partial<{
    url: string;
    name: string;
    clonePath: string;
    defaultBranch: string;
    autoClone: boolean;
    hooks: { enabled: boolean } | null;
    guidelines: RepoGuidelines | null;
  }>,
): SwarmRepo | null {
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  const stringFields = ["url", "name", "clonePath", "defaultBranch"] as const;
  for (const field of stringFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }
  }
  if (updates.autoClone !== undefined) {
    setClauses.push("autoClone = ?");
    params.push(updates.autoClone ? 1 : 0);
  }
  if (updates.hooks !== undefined) {
    setClauses.push("hooks = ?");
    params.push(updates.hooks ? JSON.stringify(updates.hooks) : null);
  }
  if (updates.guidelines !== undefined) {
    setClauses.push("guidelines = ?");
    params.push(updates.guidelines ? JSON.stringify(updates.guidelines) : null);
  }

  if (setClauses.length === 0) return getSwarmRepoById(id);

  setClauses.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const row = getDb()
    .prepare<SwarmRepoRow, (string | number | null)[]>(
      `UPDATE swarm_repos SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToSwarmRepo(row) : null;
}

export function deleteSwarmRepo(id: string): boolean {
  const result = getDb().run("DELETE FROM swarm_repos WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// AgentMail Inbox Mapping Queries
// ============================================================================

export interface AgentMailInboxMapping {
  id: string;
  inboxId: string;
  agentId: string;
  inboxEmail: string | null;
  createdAt: string;
}

export function getAgentMailInboxMapping(inboxId: string): AgentMailInboxMapping | null {
  return (
    getDb()
      .prepare<AgentMailInboxMapping, [string]>(
        "SELECT * FROM agentmail_inbox_mappings WHERE inboxId = ?",
      )
      .get(inboxId) ?? null
  );
}

export function getAgentMailInboxMappingsByAgent(agentId: string): AgentMailInboxMapping[] {
  return getDb()
    .prepare<AgentMailInboxMapping, [string]>(
      "SELECT * FROM agentmail_inbox_mappings WHERE agentId = ? ORDER BY createdAt DESC",
    )
    .all(agentId);
}

export function getAllAgentMailInboxMappings(): AgentMailInboxMapping[] {
  return getDb()
    .prepare<AgentMailInboxMapping, []>(
      "SELECT * FROM agentmail_inbox_mappings ORDER BY createdAt DESC",
    )
    .all();
}

export function createAgentMailInboxMapping(
  inboxId: string,
  agentId: string,
  inboxEmail?: string,
): AgentMailInboxMapping {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<AgentMailInboxMapping, [string, string, string, string | null, string]>(
      `INSERT INTO agentmail_inbox_mappings (id, inboxId, agentId, inboxEmail, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(inboxId) DO UPDATE SET agentId = excluded.agentId, inboxEmail = excluded.inboxEmail
       RETURNING *`,
    )
    .get(id, inboxId, agentId, inboxEmail ?? null, now);

  if (!row) throw new Error("Failed to create AgentMail inbox mapping");
  return row;
}

export function deleteAgentMailInboxMapping(inboxId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM agentmail_inbox_mappings WHERE inboxId = ?")
    .run(inboxId);
  return result.changes > 0;
}

/**
 * Find the most recent task by AgentMail thread ID
 * Includes completed/failed tasks to maintain thread continuity via parentTaskId
 */
export function findTaskByAgentMailThread(agentmailThreadId: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE agentmailThreadId = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(agentmailThreadId);
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Active Sessions (runner session tracking for concurrency awareness)
// ============================================================================

export function insertActiveSession(session: {
  agentId: string;
  taskId?: string;
  triggerType: string;
  inboxMessageId?: string;
  taskDescription?: string;
  runnerSessionId?: string;
}): ActiveSession {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<
      ActiveSession,
      [
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO active_sessions (id, agentId, taskId, triggerType, inboxMessageId, taskDescription, runnerSessionId, startedAt, lastHeartbeatAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      session.agentId,
      session.taskId ?? null,
      session.triggerType,
      session.inboxMessageId ?? null,
      session.taskDescription ?? null,
      session.runnerSessionId ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to insert active session");
  return row;
}

export function deleteActiveSession(taskId: string): boolean {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE taskId = ?").run(taskId);
  return result.changes > 0;
}

export function deleteActiveSessionById(id: string): boolean {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getActiveSessions(agentId?: string): ActiveSession[] {
  if (agentId) {
    return getDb()
      .prepare<ActiveSession, [string]>(
        "SELECT * FROM active_sessions WHERE agentId = ? ORDER BY startedAt DESC",
      )
      .all(agentId);
  }
  return getDb()
    .prepare<ActiveSession, []>("SELECT * FROM active_sessions ORDER BY startedAt DESC")
    .all();
}

export function heartbeatActiveSession(taskId: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?")
    .run(now, taskId);
  return result.changes > 0;
}

export function cleanupStaleSessions(maxAgeMinutes = 30): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const result = getDb()
    .prepare("DELETE FROM active_sessions WHERE lastHeartbeatAt < ?")
    .run(cutoff);
  return result.changes;
}

export function cleanupAgentSessions(agentId: string): number {
  const result = getDb().prepare("DELETE FROM active_sessions WHERE agentId = ?").run(agentId);
  return result.changes;
}

/** Update providerSessionId on an active session identified by taskId */
export function updateActiveSessionProviderSessionId(
  taskId: string,
  providerSessionId: string,
): boolean {
  const result = getDb()
    .prepare("UPDATE active_sessions SET providerSessionId = ? WHERE taskId = ?")
    .run(providerSessionId, taskId);
  return result.changes > 0;
}

/**
 * Get the active session for a specific task.
 * Used by the heartbeat to cross-reference stalled tasks with worker sessions.
 */
export function getActiveSessionForTask(taskId: string): ActiveSession | null {
  return (
    getDb()
      .prepare<ActiveSession, [string]>("SELECT * FROM active_sessions WHERE taskId = ? LIMIT 1")
      .get(taskId) ?? null
  );
}

/**
 * Reassociate session logs from a runner session to a real task ID.
 * Used when a pool task is claimed — logs were stored under a random UUID,
 * this updates them to use the real task ID.
 * Idempotent — safe to call multiple times.
 */
export function reassociateSessionLogs(runnerSessionId: string, realTaskId: string): number {
  const result = getDb()
    .prepare("UPDATE session_logs SET taskId = ? WHERE sessionId = ? AND taskId != ?")
    .run(realTaskId, runnerSessionId, realTaskId);
  return result.changes;
}

// ============================================================================
// Heartbeat / Triage Query Functions
// ============================================================================

/**
 * Get in_progress tasks that haven't been updated within the given threshold.
 * Used by the heartbeat to detect potentially stalled tasks.
 */
export function getStalledInProgressTasks(thresholdMinutes: number = 30): AgentTask[] {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE status = 'in_progress' AND lastUpdatedAt < ?
       ORDER BY lastUpdatedAt ASC`,
    )
    .all(cutoff)
    .map(rowToAgentTask);
}

/**
 * Genuine same-agent crash-recovery PINS (tagged `crash-recovery-pin`, DES-523
 * Phase 1) that are still `pending` `graceMin` minutes after creation — the
 * heartbeat reaper escalates these to a Lead reroute-decision.
 *
 * Three scoping clauses, each load-bearing:
 *  - `tags LIKE '%"crash-recovery-pin"%'` — restricts to resumes actually pinned
 *    to their original agent on the crash path. Without it, a *pooled* resume
 *    that `autoAssignPoolTasks` flips to `pending` earlier in the SAME sweep
 *    (keeping its old `createdAt`) would be reaped and cancelled before the
 *    assigned worker polls; it also keeps `context_limits` / `manual_supersede`
 *    pins from being escalated under a `crash_recovery` label. (Literal must
 *    match `CRASH_RECOVERY_PIN_TAG` in src/tasks/worker-follow-up.ts.)
 *  - `status = 'pending'` — the "currently unreclaimed" discriminator: when the
 *    agent reclaims via the normal poll path, `startTask` flips the row to
 *    `in_progress` and it drops out of this set. (A reclaimed resume whose
 *    session later orphans can be flipped back to `pending` by
 *    `resetOrphanedInProgressTasksForAgent`, re-entering this set on a later
 *    sweep — re-escalating genuinely re-stalled work, which is fine.) We do NOT
 *    gate on `lastActivityAt` — it is stale for a returned-but-idle agent.
 *  - `createdAt < cutoff` — `createdAt` is the resume's creation = crash-DETECTION
 *    time, so the grace window is measured from detection.
 *
 * Keys only on reboot-durable columns, so a pending pin survives a server reboot
 * and is caught on the first post-reboot sweep.
 */
export function getStalePinnedResumes(graceMin: number): AgentTask[] {
  const cutoff = new Date(Date.now() - graceMin * 60 * 1000).toISOString();
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE taskType = 'resume' AND status = 'pending'
         AND tags LIKE '%"crash-recovery-pin"%'
         AND createdAt < ?
       ORDER BY createdAt ASC`,
    )
    .all(cutoff)
    .map(rowToAgentTask);
}

/**
 * Atomically terminalize a pinned resume ONLY if it is still `pending`, in one
 * `UPDATE … RETURNING`. Returns the row when the transition fired, or `null`
 * when it did not (the agent reclaimed it in the gap → `startTask` already
 * flipped it to `in_progress`). The heartbeat reaper escalates to the Lead ONLY
 * when this returns a row, closing the TOCTOU window between reading the resume
 * as `pending` and writing.
 *
 * Deliberately NOT `failTask`: `failTask`'s backing SQL is keyed on `id` with no
 * status precondition, so it would terminalize an `in_progress` resume the
 * worker just started. The `AND status = 'pending'` here is the guard.
 */
export function failPendingResumeIfUnclaimed(
  taskId: string,
  status: "cancelled" | "failed",
  failureReason: string,
): AgentTask | null {
  const now = new Date().toISOString();
  const scrubbedReason = scrubSecrets(failureReason);
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, string, string]>(
      `UPDATE agent_tasks SET status = ?, failureReason = ?, finishedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status = 'pending' RETURNING *`,
    )
    .get(status, scrubbedReason, now, now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "pending",
        newValue: status,
        metadata: { reason: scrubbedReason, reaper: "pin_unreclaimed" },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Get idle, non-lead, non-offline agents that have capacity for more tasks.
 * Used by the heartbeat for auto-assignment of pool tasks.
 */
export function getIdleWorkersWithCapacity(): Agent[] {
  const agents = getDb()
    .prepare<AgentRow, []>(
      `SELECT * FROM agents
       WHERE status = 'idle' AND isLead = 0`,
    )
    .all()
    .map((row) => rowToAgent(row));

  return agents.filter((agent) => {
    const activeCount = getActiveTaskCount(agent.id);
    return activeCount < (agent.maxTasks ?? 1);
  });
}

/**
 * Get unassigned pool tasks ordered by priority (DESC) then creation time (ASC).
 * Used by the heartbeat for auto-assignment.
 */
export function getUnassignedPoolTasks(limit: number = 10): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [number]>(
      `SELECT * FROM agent_tasks
       WHERE status = 'unassigned'
       ORDER BY priority DESC, createdAt ASC
       LIMIT ?`,
    )
    .all(limit)
    .map(rowToAgentTask);
}

export function getRecentFailedTasks(hours: number = 6): AgentTask[] {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks
       WHERE status = 'failed'
         AND finishedAt > ?
       ORDER BY finishedAt DESC
       LIMIT 20`,
    )
    .all(since)
    .map(rowToAgentTask);
}

export function getRecentCompletedCount(hours: number = 24): number {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM agent_tasks
       WHERE status = 'completed' AND finishedAt > ?`,
    )
    .get(since);
  return row?.count ?? 0;
}

export function getRecentFailedCount(hours: number = 24): number {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const row = getDb()
    .prepare<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM agent_tasks
       WHERE status = 'failed' AND finishedAt > ?`,
    )
    .get(since);
  return row?.count ?? 0;
}

// ============================================================================
// Workflow CRUD
// ============================================================================

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  definition: string;
  triggers: string;
  cooldown: string | null;
  input: string | null;
  triggerSchema: string | null;
  dir: string | null;
  vcs_repo: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    definition: JSON.parse(row.definition) as WorkflowDefinition,
    triggers: JSON.parse(row.triggers) as TriggerConfig[],
    cooldown: row.cooldown ? (JSON.parse(row.cooldown) as CooldownConfig) : undefined,
    input: row.input ? (JSON.parse(row.input) as Record<string, InputValue>) : undefined,
    triggerSchema: row.triggerSchema
      ? (JSON.parse(row.triggerSchema) as Record<string, unknown>)
      : undefined,
    dir: row.dir ?? undefined,
    vcsRepo: row.vcs_repo ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export function createWorkflow(data: {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
  triggers?: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, InputValue>;
  triggerSchema?: Record<string, unknown>;
  dir?: string;
  vcsRepo?: string;
  createdByAgentId?: string;
  createdBy?: string;
}): Workflow {
  const id = crypto.randomUUID();
  const row = getDb()
    .prepare<
      WorkflowRow,
      [
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO workflows (id, name, description, definition, triggers, cooldown, input, triggerSchema, dir, vcs_repo, createdByAgentId, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      JSON.stringify(data.definition),
      JSON.stringify(data.triggers ?? []),
      data.cooldown ? JSON.stringify(data.cooldown) : null,
      data.input ? JSON.stringify(data.input) : null,
      data.triggerSchema ? JSON.stringify(data.triggerSchema) : null,
      data.dir ?? null,
      data.vcsRepo ?? null,
      data.createdByAgentId ?? null,
      data.createdBy ?? null,
      data.createdBy ?? null,
    );
  if (!row) throw new Error("Failed to create workflow");
  return rowToWorkflow(row);
}

export function getWorkflow(id: string): Workflow | null {
  const row = getDb()
    .prepare<WorkflowRow, [string]>("SELECT * FROM workflows WHERE id = ?")
    .get(id);
  return row ? rowToWorkflow(row) : null;
}

/**
 * Slim list-row mapper — drops the heavy `definition` (avg ~18 KB/row) and the
 * trigger config, keeping a derived `nodeCount` so the list view can still
 * answer "how big is this workflow" without the full DAG. Fetch the full shape
 * via `getWorkflow(id)`.
 */
function rowToWorkflowSummary(row: WorkflowRow): WorkflowSummary {
  let nodeCount = 0;
  try {
    const def = JSON.parse(row.definition) as WorkflowDefinition;
    nodeCount = Array.isArray(def?.nodes) ? def.nodes.length : 0;
  } catch {
    nodeCount = 0;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    dir: row.dir ?? undefined,
    vcsRepo: row.vcs_repo ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    nodeCount,
  };
}

export function listWorkflows(filters?: { enabled?: boolean }): Workflow[];
export function listWorkflows(
  filters: { enabled?: boolean } | undefined,
  opts: { slim: true },
): WorkflowSummary[];
export function listWorkflows(
  filters?: { enabled?: boolean },
  opts?: { slim?: boolean },
): Workflow[] | WorkflowSummary[] {
  let query = "SELECT * FROM workflows WHERE 1=1";
  const params: (string | number)[] = [];
  if (filters?.enabled !== undefined) {
    query += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }
  query += " ORDER BY name ASC";
  const rows = getDb()
    .prepare<WorkflowRow, (string | number)[]>(query)
    .all(...params);
  return opts?.slim ? rows.map(rowToWorkflowSummary) : rows.map(rowToWorkflow);
}

export function updateWorkflow(
  id: string,
  data: {
    name?: string;
    description?: string;
    enabled?: boolean;
    definition?: WorkflowDefinition;
    triggers?: TriggerConfig[];
    cooldown?: CooldownConfig | null;
    input?: Record<string, InputValue> | null;
    triggerSchema?: Record<string, unknown> | null;
    dir?: string | null;
    vcsRepo?: string | null;
    updatedBy?: string;
  },
): Workflow | null {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (data.name !== undefined) {
    updates.push("name = ?");
    params.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description);
  }
  if (data.enabled !== undefined) {
    updates.push("enabled = ?");
    params.push(data.enabled ? 1 : 0);
  }
  if (data.definition !== undefined) {
    updates.push("definition = ?");
    params.push(JSON.stringify(data.definition));
  }
  if (data.triggers !== undefined) {
    updates.push("triggers = ?");
    params.push(JSON.stringify(data.triggers));
  }
  if (data.cooldown !== undefined) {
    updates.push("cooldown = ?");
    params.push(data.cooldown ? JSON.stringify(data.cooldown) : null);
  }
  if (data.input !== undefined) {
    updates.push("input = ?");
    params.push(data.input ? JSON.stringify(data.input) : null);
  }
  if (data.triggerSchema !== undefined) {
    updates.push("triggerSchema = ?");
    params.push(data.triggerSchema ? JSON.stringify(data.triggerSchema) : null);
  }
  if (data.dir !== undefined) {
    updates.push("dir = ?");
    params.push(data.dir ?? null);
  }
  if (data.vcsRepo !== undefined) {
    updates.push("vcs_repo = ?");
    params.push(data.vcsRepo ?? null);
  }
  if (data.updatedBy !== undefined) {
    updates.push("updated_by = ?");
    params.push(data.updatedBy);
  }
  if (updates.length === 0) return getWorkflow(id);
  updates.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = getDb()
    .prepare<WorkflowRow, (string | number | null)[]>(
      `UPDATE workflows SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToWorkflow(row) : null;
}

export function deleteWorkflow(id: string): boolean {
  const db = getDb();
  // Cascade delete in FK-safe order:
  // 1. Unlink agent_tasks (they reference steps and runs)
  db.run(
    `UPDATE agent_tasks SET workflowRunId = NULL, workflowRunStepId = NULL WHERE workflowRunId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    [id],
  );
  // 2. Delete steps (they reference runs)
  db.run(
    `DELETE FROM workflow_run_steps WHERE runId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    [id],
  );
  // 3. Delete runs (they reference workflow)
  db.run("DELETE FROM workflow_runs WHERE workflowId = ?", [id]);
  // 4. Delete workflow
  const result = db.run("DELETE FROM workflows WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Find enabled workflows that have a schedule trigger matching the given scheduleId.
 * Uses SQLite JSON functions to query into the triggers JSON array.
 */
export function getWorkflowsByScheduleId(scheduleId: string): Workflow[] {
  const rows = getDb()
    .prepare<WorkflowRow, [string]>(
      `SELECT w.* FROM workflows w, json_each(w.triggers) AS t
       WHERE w.enabled = 1
         AND json_extract(t.value, '$.type') = 'schedule'
         AND json_extract(t.value, '$.scheduleId') = ?`,
    )
    .all(scheduleId);
  return rows.map(rowToWorkflow);
}

// ============================================================================
// Workflow Run CRUD
// ============================================================================

type WorkflowRunRow = {
  id: string;
  workflowId: string;
  status: string;
  triggerData: string | null;
  context: string | null;
  error: string | null;
  startedAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
};

function rowToWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status as WorkflowRunStatus,
    triggerData: row.triggerData ? JSON.parse(row.triggerData) : undefined,
    context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : undefined,
    error: row.error ?? undefined,
    startedAt: normalizeDateRequired(row.startedAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    finishedAt: normalizeDate(row.finishedAt) ?? undefined,
  };
}

export function createWorkflowRun(data: {
  id: string;
  workflowId: string;
  triggerData?: unknown;
}): WorkflowRun {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<WorkflowRunRow, [string, string, string, string | null]>(
      `INSERT INTO workflow_runs (id, workflowId, startedAt, triggerData) VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(data.id, data.workflowId, now, data.triggerData ? JSON.stringify(data.triggerData) : null);
  if (!row) throw new Error("Failed to create workflow run");
  return rowToWorkflowRun(row);
}

export function getWorkflowRun(id: string): WorkflowRun | null {
  const row = getDb()
    .prepare<WorkflowRunRow, [string]>("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id);
  return row ? rowToWorkflowRun(row) : null;
}

function emitWorkflowTerminalTelemetry(run: WorkflowRun): void {
  if (run.status !== "completed" && run.status !== "failed") return;

  queueMicrotask(() => {
    const latest = getWorkflowRun(run.id);
    if (!latest || latest.status !== run.status) return;
    const steps = getWorkflowRunStepsByRunId(run.id);
    telemetry.workflow(run.status, {
      workflowId: run.workflowId,
      durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : undefined,
      stepsCompleted: steps.filter((step) => step.status === "completed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
    });
  });
}

export function updateWorkflowRun(
  id: string,
  data: {
    status?: WorkflowRunStatus;
    context?: Record<string, unknown>;
    error?: string;
    finishedAt?: string;
  },
): WorkflowRun | null {
  const updates: string[] = [];
  const params: (string | null)[] = [];
  if (data.status !== undefined) {
    updates.push("status = ?");
    params.push(data.status);
  }
  if (data.context !== undefined) {
    updates.push("context = ?");
    params.push(JSON.stringify(data.context));
  }
  if (data.error !== undefined) {
    updates.push("error = ?");
    params.push(data.error);
  }
  if (data.finishedAt !== undefined) {
    updates.push("finishedAt = ?");
    params.push(data.finishedAt);
  }
  if (updates.length === 0) return getWorkflowRun(id);
  updates.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = getDb()
    .prepare<WorkflowRunRow, (string | null)[]>(
      `UPDATE workflow_runs SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  if (!row) return null;
  const run = rowToWorkflowRun(row);
  if (data.status === "completed" || data.status === "failed") {
    emitWorkflowTerminalTelemetry(run);
  }
  return run;
}

export function listWorkflowRuns(workflowId: string): WorkflowRun[] {
  return getDb()
    .prepare<WorkflowRunRow, [string]>(
      "SELECT * FROM workflow_runs WHERE workflowId = ? ORDER BY startedAt DESC",
    )
    .all(workflowId)
    .map(rowToWorkflowRun);
}

// ============================================================================
// Workflow Run Step CRUD
// ============================================================================

type WorkflowRunStepRow = {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  idempotencyKey: string | null;
  diagnostics: string | null;
  nextPort: string | null;
};

function rowToWorkflowRunStep(row: WorkflowRunStepRow): WorkflowRunStep {
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    status: row.status as WorkflowRunStepStatus,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: row.output ? JSON.parse(row.output) : undefined,
    error: row.error ?? undefined,
    startedAt: normalizeDateRequired(row.startedAt),
    finishedAt: normalizeDate(row.finishedAt) ?? undefined,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    nextRetryAt: normalizeDate(row.nextRetryAt) ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    diagnostics: row.diagnostics ?? undefined,
    nextPort: row.nextPort ?? undefined,
  };
}

export function createWorkflowRunStep(data: {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  input?: unknown;
}): WorkflowRunStep {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<WorkflowRunStepRow, [string, string, string, string, string, string | null]>(
      `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, input)
       VALUES (?, ?, ?, ?, 'running', ?, ?) RETURNING *`,
    )
    .get(
      data.id,
      data.runId,
      data.nodeId,
      data.nodeType,
      now,
      data.input ? JSON.stringify(data.input) : null,
    );
  if (!row) throw new Error("Failed to create workflow run step");
  return rowToWorkflowRunStep(row);
}

export function getWorkflowRunStep(id: string): WorkflowRunStep | null {
  const row = getDb()
    .prepare<WorkflowRunStepRow, [string]>("SELECT * FROM workflow_run_steps WHERE id = ?")
    .get(id);
  return row ? rowToWorkflowRunStep(row) : null;
}

export function updateWorkflowRunStep(
  id: string,
  data: {
    status?: WorkflowRunStepStatus;
    output?: unknown;
    error?: string;
    finishedAt?: string;
    retryCount?: number;
    maxRetries?: number;
    nextRetryAt?: string | null;
    idempotencyKey?: string;
    diagnostics?: string;
    nextPort?: string;
  },
): WorkflowRunStep | null {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (data.status !== undefined) {
    updates.push("status = ?");
    params.push(data.status);
  }
  if (data.output !== undefined) {
    updates.push("output = ?");
    params.push(JSON.stringify(data.output));
  }
  if (data.error !== undefined) {
    updates.push("error = ?");
    params.push(data.error);
  }
  if (data.finishedAt !== undefined) {
    updates.push("finishedAt = ?");
    params.push(data.finishedAt);
  }
  if (data.retryCount !== undefined) {
    updates.push("retryCount = ?");
    params.push(data.retryCount);
  }
  if (data.maxRetries !== undefined) {
    updates.push("maxRetries = ?");
    params.push(data.maxRetries);
  }
  if (data.nextRetryAt !== undefined) {
    updates.push("nextRetryAt = ?");
    params.push(data.nextRetryAt);
  }
  if (data.idempotencyKey !== undefined) {
    updates.push("idempotencyKey = ?");
    params.push(data.idempotencyKey);
  }
  if (data.diagnostics !== undefined) {
    updates.push("diagnostics = ?");
    params.push(data.diagnostics);
  }
  if (data.nextPort !== undefined) {
    updates.push("nextPort = ?");
    params.push(data.nextPort);
  }
  if (updates.length === 0) return getWorkflowRunStep(id);
  params.push(id);
  const row = getDb()
    .prepare<WorkflowRunStepRow, (string | number | null)[]>(
      `UPDATE workflow_run_steps SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToWorkflowRunStep(row) : null;
}

export function getWorkflowRunStepsByRunId(runId: string): WorkflowRunStep[] {
  return getDb()
    .prepare<WorkflowRunStepRow, [string]>(
      "SELECT * FROM workflow_run_steps WHERE runId = ? ORDER BY startedAt ASC",
    )
    .all(runId)
    .map(rowToWorkflowRunStep);
}

// --- Stuck Workflow Run Recovery ---

export interface StuckWorkflowRun {
  runId: string;
  stepId: string;
  nodeId: string;
  taskStatus: string;
  taskOutput: string | null;
  workflowId: string;
}

export function getStuckWorkflowRuns(): StuckWorkflowRun[] {
  return getDb()
    .prepare<StuckWorkflowRun, []>(
      `SELECT
        wr.id as runId,
        wrs.id as stepId,
        wrs.nodeId,
        at.status as taskStatus,
        at.output as taskOutput,
        wr.workflowId
      FROM workflow_runs wr
      JOIN workflow_run_steps wrs ON wrs.runId = wr.id AND wrs.status = 'waiting'
      JOIN agent_tasks at ON at.workflowRunStepId = wrs.id
      WHERE wr.status = 'waiting'
        AND at.status IN ('completed', 'failed', 'cancelled')`,
    )
    .all();
}

// --- New Workflow Query Functions ---

export function getLastSuccessfulRun(workflowId: string): WorkflowRun | null {
  const row = getDb()
    .prepare<WorkflowRunRow, [string]>(
      `SELECT * FROM workflow_runs
       WHERE workflowId = ? AND status = 'completed'
       ORDER BY finishedAt DESC LIMIT 1`,
    )
    .get(workflowId);
  return row ? rowToWorkflowRun(row) : null;
}

export function getLastRunStart(workflowId: string): WorkflowRun | null {
  const row = getDb()
    .prepare<WorkflowRunRow, [string]>(
      `SELECT * FROM workflow_runs
       WHERE workflowId = ? AND status NOT IN ('skipped')
       ORDER BY startedAt DESC LIMIT 1`,
    )
    .get(workflowId);
  return row ? rowToWorkflowRun(row) : null;
}

export function getRetryableSteps(): WorkflowRunStep[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare<WorkflowRunStepRow, [string]>(
      `SELECT * FROM workflow_run_steps
       WHERE status = 'failed'
         AND nextRetryAt IS NOT NULL
         AND nextRetryAt <= ?
       ORDER BY nextRetryAt ASC`,
    )
    .all(now)
    .map(rowToWorkflowRunStep);
}

export function getCompletedStepNodeIds(runId: string): string[] {
  const rows = getDb()
    .prepare<{ nodeId: string }, [string]>(
      `SELECT nodeId FROM workflow_run_steps
       WHERE runId = ? AND status = 'completed'`,
    )
    .all(runId);
  return rows.map((r) => r.nodeId);
}

export function getTaskByWorkflowRunStepId(stepId: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE workflowRunStepId = ? LIMIT 1",
    )
    .get(stepId);
  return row ? rowToAgentTask(row) : null;
}

export function getStepByIdempotencyKey(key: string): WorkflowRunStep | null {
  const row = getDb()
    .prepare<WorkflowRunStepRow, [string]>(
      "SELECT * FROM workflow_run_steps WHERE idempotencyKey = ?",
    )
    .get(key);
  return row ? rowToWorkflowRunStep(row) : null;
}

export function getStepCountForNode(runId: string, nodeId: string): number {
  const row = getDb()
    .prepare<{ cnt: number }, [string, string]>(
      "SELECT COUNT(*) as cnt FROM workflow_run_steps WHERE runId = ? AND nodeId = ?",
    )
    .get(runId, nodeId);
  return row?.cnt ?? 0;
}

export function getLatestStepForNode(runId: string, nodeId: string): WorkflowRunStep | null {
  const row = getDb()
    .prepare<WorkflowRunStepRow, [string, string]>(
      "SELECT * FROM workflow_run_steps WHERE runId = ? AND nodeId = ? ORDER BY startedAt DESC LIMIT 1",
    )
    .get(runId, nodeId);
  return row ? rowToWorkflowRunStep(row) : null;
}

// --- Workflow Version History ---

type WorkflowVersionRow = {
  id: string;
  workflowId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
};

function rowToWorkflowVersion(row: WorkflowVersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as WorkflowSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export function createWorkflowVersion(data: {
  workflowId: string;
  version: number;
  snapshot: WorkflowSnapshot;
  changedByAgentId?: string;
}): WorkflowVersion {
  const id = crypto.randomUUID();
  const row = getDb()
    .prepare<WorkflowVersionRow, [string, string, number, string, string | null]>(
      `INSERT INTO workflow_versions (id, workflowId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.workflowId,
      data.version,
      JSON.stringify(data.snapshot),
      data.changedByAgentId ?? null,
    );
  if (!row) throw new Error("Failed to create workflow version");
  return rowToWorkflowVersion(row);
}

export function getWorkflowVersions(workflowId: string): WorkflowVersion[] {
  return getDb()
    .prepare<WorkflowVersionRow, [string]>(
      "SELECT * FROM workflow_versions WHERE workflowId = ? ORDER BY version DESC",
    )
    .all(workflowId)
    .map(rowToWorkflowVersion);
}

export function getWorkflowVersion(workflowId: string, version: number): WorkflowVersion | null {
  const row = getDb()
    .prepare<WorkflowVersionRow, [string, number]>(
      "SELECT * FROM workflow_versions WHERE workflowId = ? AND version = ?",
    )
    .get(workflowId, version);
  return row ? rowToWorkflowVersion(row) : null;
}

// ============================================================================
// Pages CRUD + version history
// ----------------------------------------------------------------------------
// DB-backed lightweight artifacts. Mirrors the workflow versioning pattern:
// parent table `pages` holds the CURRENT state, history table `page_versions`
// holds pre-update snapshots. snapshotPage() (src/pages/version.ts) MUST be
// called BEFORE updatePage() so the snapshot freezes pre-update content.
// ============================================================================

type PageRow = {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  description: string | null;
  contentType: string;
  authMode: string;
  passwordHash: string | null;
  body: string;
  needsCredentials: string | null;
  createdAt: string;
  updatedAt: string;
  view_count: number;
};

function rowToPage(row: PageRow): Page {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    contentType: row.contentType as PageContentType,
    authMode: row.authMode as PageAuthMode,
    passwordHash: row.passwordHash ?? undefined,
    body: row.body,
    needsCredentials: row.needsCredentials
      ? (JSON.parse(row.needsCredentials) as string[])
      : undefined,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function createPage(data: {
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  contentType: PageContentType;
  authMode?: PageAuthMode;
  passwordHash?: string;
  body: string;
  needsCredentials?: string[];
}): Page {
  const row = getDb()
    .prepare<
      PageRow,
      [string, string, string, string | null, string, string, string | null, string, string | null]
    >(
      `INSERT INTO pages (agentId, slug, title, description, contentType, authMode, passwordHash, body, needsCredentials)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      data.agentId,
      data.slug,
      data.title,
      data.description ?? null,
      data.contentType,
      data.authMode ?? "authed",
      data.passwordHash ?? null,
      data.body,
      data.needsCredentials ? JSON.stringify(data.needsCredentials) : null,
    );
  if (!row) throw new Error("Failed to create page");
  return rowToPage(row);
}

export function getPage(id: string): Page | null {
  const row = getDb().prepare<PageRow, [string]>("SELECT * FROM pages WHERE id = ?").get(id);
  return row ? rowToPage(row) : null;
}

export function getPageBySlug(agentId: string, slug: string): Page | null {
  const row = getDb()
    .prepare<PageRow, [string, string]>("SELECT * FROM pages WHERE agentId = ? AND slug = ?")
    .get(agentId, slug);
  return row ? rowToPage(row) : null;
}

/**
 * Slim list-row mapper — drops the page `body` (the full HTML/JSON document,
 * up to ~290 KB and ~95% of a list payload) and `passwordHash`. Fetch the
 * full page via `getPage(id)`.
 */
function rowToPageSummary(row: PageRow): PageSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    contentType: row.contentType as PageContentType,
    authMode: row.authMode as PageAuthMode,
    needsCredentials: row.needsCredentials
      ? (JSON.parse(row.needsCredentials) as string[])
      : undefined,
    viewCount: typeof row.view_count === "number" ? row.view_count : 0,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function listPagesByAgent(agentId: string, limit?: number, offset?: number): Page[];
export function listPagesByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): PageSummary[];
export function listPagesByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Page[] | PageSummary[] {
  const rows = getDb()
    .prepare<PageRow, [string, number, number]>(
      "SELECT * FROM pages WHERE agentId = ? ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    )
    .all(agentId, limit, offset);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

export function listAllPages(limit?: number, offset?: number): Page[];
export function listAllPages(
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): PageSummary[];
export function listAllPages(
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Page[] | PageSummary[] {
  const rows = getDb()
    .prepare<PageRow, [number, number]>(
      "SELECT * FROM pages ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

/**
 * Total page count — used to back a filter-aware `total` in the `/api/pages`
 * pager so the UI shows the real count, not just the current page's length.
 */
export function countAllPages(): number {
  const row = getDb().prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM pages").get();
  return row?.count ?? 0;
}

/** Page count scoped to a single agent — companion to `listPagesByAgent`. */
export function countPagesByAgent(agentId: string): number {
  const row = getDb()
    .prepare<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM pages WHERE agentId = ?")
    .get(agentId);
  return row?.count ?? 0;
}

/**
 * Apply a patch to a page. Does NOT snapshot — caller must invoke
 * `snapshotPage(id, agentId)` BEFORE calling this to preserve pre-update
 * state (mirrors the workflow update pattern at src/http/workflows.ts:483).
 *
 * Always bumps `updatedAt` even if no other field changed (keeps the index
 * useful for list ordering).
 */
export function updatePage(
  id: string,
  data: {
    title?: string;
    description?: string | null;
    contentType?: PageContentType;
    authMode?: PageAuthMode;
    passwordHash?: string | null;
    body?: string;
    needsCredentials?: string[] | null;
    slug?: string;
  },
): Page | null {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (data.title !== undefined) {
    updates.push("title = ?");
    params.push(data.title);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description ?? null);
  }
  if (data.contentType !== undefined) {
    updates.push("contentType = ?");
    params.push(data.contentType);
  }
  if (data.authMode !== undefined) {
    updates.push("authMode = ?");
    params.push(data.authMode);
  }
  if (data.passwordHash !== undefined) {
    updates.push("passwordHash = ?");
    params.push(data.passwordHash ?? null);
  }
  if (data.body !== undefined) {
    updates.push("body = ?");
    params.push(data.body);
  }
  if (data.needsCredentials !== undefined) {
    updates.push("needsCredentials = ?");
    params.push(data.needsCredentials ? JSON.stringify(data.needsCredentials) : null);
  }
  if (data.slug !== undefined) {
    updates.push("slug = ?");
    params.push(data.slug);
  }
  if (updates.length === 0) return getPage(id);
  updates.push("updatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = getDb()
    .prepare<PageRow, (string | number | null)[]>(
      `UPDATE pages SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToPage(row) : null;
}

export function deletePage(id: string): boolean {
  // ON DELETE CASCADE on page_versions.pageId handles history cleanup.
  const result = getDb().run("DELETE FROM pages WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Bump the `view_count` counter on a page by 1. Called from `pages-public.ts`
 * on every successful 200 from `GET /p/:id` (HTML inline serve) and
 * `GET /p/:id.json` (JSON metadata fetch). No-op when the page doesn't
 * exist — caller already guards on `getPage(id)` before reaching the bump
 * path, so this only fires for valid ids. Wrapped in try/catch by the
 * caller so an unexpected DB error never breaks page serving.
 */
export function incrementPageViewCount(id: string): boolean {
  const result = getDb().run("UPDATE pages SET view_count = view_count + 1 WHERE id = ?", [id]);
  return result.changes > 0;
}

type PageVersionRow = {
  id: string;
  pageId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
};

function rowToPageVersion(row: PageVersionRow): PageVersion {
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as PageSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export function createPageVersion(data: {
  pageId: string;
  version: number;
  snapshot: PageSnapshot;
  changedByAgentId?: string;
}): PageVersion {
  const row = getDb()
    .prepare<PageVersionRow, [string, number, string, string | null]>(
      `INSERT INTO page_versions (pageId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(data.pageId, data.version, JSON.stringify(data.snapshot), data.changedByAgentId ?? null);
  if (!row) throw new Error("Failed to create page version");
  return rowToPageVersion(row);
}

export function getPageVersions(pageId: string): PageVersion[] {
  return getDb()
    .prepare<PageVersionRow, [string]>(
      "SELECT * FROM page_versions WHERE pageId = ? ORDER BY version DESC",
    )
    .all(pageId)
    .map(rowToPageVersion);
}

export function getPageVersion(pageId: string, version: number): PageVersion | null {
  const row = getDb()
    .prepare<PageVersionRow, [string, number]>(
      "SELECT * FROM page_versions WHERE pageId = ? AND version = ?",
    )
    .get(pageId, version);
  return row ? rowToPageVersion(row) : null;
}

// ============================================================================
// Metrics CRUD + version history
// ----------------------------------------------------------------------------
// Config-driven metrics mirror Pages: parent table `metrics` holds the current
// JSON definition, and `metric_versions` holds pre-update snapshots.
// ============================================================================

type MetricRow = {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  description: string | null;
  definition: string;
  createdAt: string;
  updatedAt: string;
};

function rowToMetric(row: MetricRow): Metric {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    definition: JSON.parse(row.definition) as MetricDefinition,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

function rowToMetricSummary(row: MetricRow): MetricSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function createMetric(data: {
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  definition: MetricDefinition;
}): Metric {
  const row = getDb()
    .prepare<MetricRow, [string, string, string, string | null, string]>(
      `INSERT INTO metrics (agentId, slug, title, description, definition)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      data.agentId,
      data.slug,
      data.title,
      data.description ?? null,
      JSON.stringify(data.definition),
    );
  if (!row) throw new Error("Failed to create metric");
  return rowToMetric(row);
}

export function getMetric(id: string): Metric | null {
  const row = getDb().prepare<MetricRow, [string]>("SELECT * FROM metrics WHERE id = ?").get(id);
  return row ? rowToMetric(row) : null;
}

export function getMetricBySlug(agentId: string, slug: string): Metric | null {
  const row = getDb()
    .prepare<MetricRow, [string, string]>("SELECT * FROM metrics WHERE agentId = ? AND slug = ?")
    .get(agentId, slug);
  return row ? rowToMetric(row) : null;
}

export function listMetricsByAgent(agentId: string, limit?: number, offset?: number): Metric[];
export function listMetricsByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): MetricSummary[];
export function listMetricsByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Metric[] | MetricSummary[] {
  const rows = getDb()
    .prepare<MetricRow, [string, number, number]>(
      "SELECT * FROM metrics WHERE agentId = ? ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    )
    .all(agentId, limit, offset);
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export function listAllMetrics(limit?: number, offset?: number): Metric[];
export function listAllMetrics(
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): MetricSummary[];
export function listAllMetrics(
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Metric[] | MetricSummary[] {
  const rows = getDb()
    .prepare<MetricRow, [number, number]>(
      "SELECT * FROM metrics ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export function countAllMetrics(): number {
  const row = getDb().prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM metrics").get();
  return row?.count ?? 0;
}

export function countMetricsByAgent(agentId: string): number {
  const row = getDb()
    .prepare<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM metrics WHERE agentId = ?")
    .get(agentId);
  return row?.count ?? 0;
}

export function updateMetric(
  id: string,
  data: {
    title?: string;
    description?: string | null;
    definition?: MetricDefinition;
    slug?: string;
  },
): Metric | null {
  const updates: string[] = [];
  const params: (string | null)[] = [];
  if (data.title !== undefined) {
    updates.push("title = ?");
    params.push(data.title);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description ?? null);
  }
  if (data.definition !== undefined) {
    updates.push("definition = ?");
    params.push(JSON.stringify(data.definition));
  }
  if (data.slug !== undefined) {
    updates.push("slug = ?");
    params.push(data.slug);
  }
  if (updates.length === 0) return getMetric(id);
  updates.push("updatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = getDb()
    .prepare<MetricRow, (string | null)[]>(
      `UPDATE metrics SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToMetric(row) : null;
}

export function deleteMetric(id: string): boolean {
  const result = getDb().run("DELETE FROM metrics WHERE id = ?", [id]);
  return result.changes > 0;
}

type MetricVersionRow = {
  id: string;
  metricId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
};

function rowToMetricVersion(row: MetricVersionRow): MetricVersion {
  return {
    id: row.id,
    metricId: row.metricId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot) as MetricSnapshot,
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export function createMetricVersion(data: {
  metricId: string;
  version: number;
  snapshot: MetricSnapshot;
  changedByAgentId?: string;
}): MetricVersion {
  const row = getDb()
    .prepare<MetricVersionRow, [string, number, string, string | null]>(
      `INSERT INTO metric_versions (metricId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(data.metricId, data.version, JSON.stringify(data.snapshot), data.changedByAgentId ?? null);
  if (!row) throw new Error("Failed to create metric version");
  return rowToMetricVersion(row);
}

export function getMetricVersions(metricId: string): MetricVersion[] {
  return getDb()
    .prepare<MetricVersionRow, [string]>(
      "SELECT * FROM metric_versions WHERE metricId = ? ORDER BY version DESC",
    )
    .all(metricId)
    .map(rowToMetricVersion);
}

export function getMetricVersion(metricId: string, version: number): MetricVersion | null {
  const row = getDb()
    .prepare<MetricVersionRow, [string, number]>(
      "SELECT * FROM metric_versions WHERE metricId = ? AND version = ?",
    )
    .get(metricId, version);
  return row ? rowToMetricVersion(row) : null;
}

// ============================================================================
// Prompt Template Operations
// ============================================================================

type PromptTemplateRow = {
  id: string;
  eventType: string;
  scope: string;
  scopeId: string | null;
  state: string;
  body: string;
  isDefault: number; // SQLite boolean
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type PromptTemplateHistoryRow = {
  id: string;
  templateId: string;
  version: number;
  body: string;
  state: string;
  changedBy: string | null;
  changedAt: string;
  changeReason: string | null;
};

function rowToPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    eventType: row.eventType,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    state: row.state as "enabled" | "default_prompt_fallback" | "skip_event",
    body: row.body,
    isDefault: row.isDefault === 1,
    version: row.version,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToPromptTemplateHistory(row: PromptTemplateHistoryRow): PromptTemplateHistory {
  return {
    id: row.id,
    templateId: row.templateId,
    version: row.version,
    body: row.body,
    state: row.state,
    changedBy: row.changedBy ?? null,
    changedAt: row.changedAt,
    changeReason: row.changeReason ?? null,
  };
}

/**
 * List prompt templates with optional filters.
 */
export function getPromptTemplates(filters?: {
  eventType?: string;
  scope?: string;
  scopeId?: string;
  isDefault?: boolean;
}): PromptTemplate[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.eventType) {
    conditions.push("eventType = ?");
    params.push(filters.eventType);
  }
  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scopeId) {
    conditions.push("scopeId = ?");
    params.push(filters.scopeId);
  }
  if (filters?.isDefault !== undefined) {
    conditions.push("isDefault = ?");
    params.push(filters.isDefault ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM prompt_templates ${whereClause} ORDER BY eventType ASC`;

  return getDb()
    .prepare<PromptTemplateRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToPromptTemplate);
}

/**
 * Get a single prompt template by ID.
 */
export function getPromptTemplateById(id: string): PromptTemplate | null {
  const row = getDb()
    .prepare<PromptTemplateRow, [string]>("SELECT * FROM prompt_templates WHERE id = ?")
    .get(id);
  return row ? rowToPromptTemplate(row) : null;
}

/**
 * Upsert a prompt template. Inserts or updates by (eventType, scope, scopeId) unique constraint.
 * Creates a history entry on both insert and update.
 */
export function upsertPromptTemplate(data: {
  eventType: string;
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  state?: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  createdBy?: string | null;
  changedBy?: string | null;
  changeReason?: string | null;
  isDefault?: boolean;
}): PromptTemplate {
  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const state = data.state ?? "enabled";
  const createdBy = data.createdBy ?? data.changedBy ?? null;
  const changedBy = data.changedBy ?? data.createdBy ?? null;
  const changeReason = data.changeReason ?? null;

  // Manual check for existing entry because SQLite's UNIQUE constraint
  // treats NULL != NULL, so ON CONFLICT never fires when scopeId is NULL (global scope).
  const existing =
    scopeId === null
      ? getDb()
          .prepare<PromptTemplateRow, [string, string]>(
            "SELECT * FROM prompt_templates WHERE eventType = ? AND scope = ? AND scopeId IS NULL",
          )
          .get(data.eventType, data.scope)
      : getDb()
          .prepare<PromptTemplateRow, [string, string, string]>(
            "SELECT * FROM prompt_templates WHERE eventType = ? AND scope = ? AND scopeId = ?",
          )
          .get(data.eventType, data.scope, scopeId);

  let row: PromptTemplateRow | null;

  if (existing) {
    // If upserting at global scope and existing record has isDefault=true, flip it to false
    const newIsDefault =
      data.scope === "global" && existing.isDefault === 1 ? 0 : existing.isDefault;
    const newVersion = existing.version + 1;

    row = getDb()
      .prepare<PromptTemplateRow, [string, string, number, number, string, string]>(
        `UPDATE prompt_templates SET body = ?, state = ?, isDefault = ?, version = ?, updatedAt = ?
         WHERE id = ? RETURNING *`,
      )
      .get(data.body, state, newIsDefault, newVersion, now, existing.id);

    // Create history entry for the update
    getDb()
      .prepare(
        `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        existing.id,
        newVersion,
        data.body,
        state,
        changedBy,
        now,
        changeReason,
      );
  } else {
    const id = crypto.randomUUID();
    row = getDb()
      .prepare<
        PromptTemplateRow,
        [
          string,
          string,
          string,
          string | null,
          string,
          string,
          number,
          number,
          string | null,
          string,
          string,
        ]
      >(
        `INSERT INTO prompt_templates (id, eventType, scope, scopeId, state, body, isDefault, version, createdBy, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        id,
        data.eventType,
        data.scope,
        scopeId,
        state,
        data.body,
        data.isDefault ? 1 : 0,
        1,
        createdBy,
        now,
        now,
      );

    // Create history entry for the insert
    getDb()
      .prepare(
        `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        id,
        1,
        data.body,
        state,
        changedBy,
        now,
        changeReason ?? "Initial creation",
      );
  }

  if (!row) throw new Error("Failed to upsert prompt template");
  return rowToPromptTemplate(row);
}

/**
 * Delete a prompt template by ID. Guards against deleting default templates.
 * Does NOT delete history rows (intentional for audit trail).
 */
export function deletePromptTemplate(id: string): boolean {
  const existing = getDb()
    .prepare<PromptTemplateRow, [string]>("SELECT * FROM prompt_templates WHERE id = ?")
    .get(id);

  if (!existing) return false;
  if (existing.isDefault === 1) {
    throw new Error(
      "Cannot delete a default prompt template. Use resetPromptTemplateToDefault instead.",
    );
  }

  const result = getDb().run("DELETE FROM prompt_templates WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Reset a prompt template to its default state.
 * Sets body to defaultBody, isDefault=true, state='enabled', bumps version.
 */
export function resetPromptTemplateToDefault(id: string, defaultBody: string): PromptTemplate {
  const now = new Date().toISOString();
  const existing = getDb()
    .prepare<PromptTemplateRow, [string]>("SELECT * FROM prompt_templates WHERE id = ?")
    .get(id);

  if (!existing) throw new Error(`Prompt template ${id} not found`);

  const newVersion = existing.version + 1;

  const row = getDb()
    .prepare<PromptTemplateRow, [string, number, string, string]>(
      `UPDATE prompt_templates SET body = ?, state = 'enabled', isDefault = 1, version = ?, updatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(defaultBody, newVersion, now, id);

  if (!row) throw new Error("Failed to reset prompt template to default");

  // Create history entry
  getDb()
    .prepare(
      `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      id,
      newVersion,
      defaultBody,
      "enabled",
      null,
      now,
      "Reset to default",
    );

  return rowToPromptTemplate(row);
}

/**
 * Get version history for a prompt template, ordered by version DESC.
 */
export function getPromptTemplateHistory(templateId: string): PromptTemplateHistory[] {
  return getDb()
    .prepare<PromptTemplateHistoryRow, [string]>(
      "SELECT * FROM prompt_template_history WHERE templateId = ? ORDER BY version DESC",
    )
    .all(templateId)
    .map(rowToPromptTemplateHistory);
}

/**
 * Resolve the best prompt template for a given eventType using scope precedence.
 *
 * Two-pass resolution:
 *   Pass 1 (exact match): Try exact eventType at agent → repo → global scope.
 *   Pass 2 (wildcard): Generate wildcards from eventType (e.g. "github.pull_request.*", "github.*")
 *     and try each at agent → repo → global scope.
 *
 * Exact match at ANY scope always beats wildcard at ANY scope.
 *
 * State behavior:
 *   - 'enabled': return the template
 *   - 'skip_event': return { skip: true }
 *   - 'default_prompt_fallback': continue to next scope level
 */
export function resolvePromptTemplate(
  eventType: string,
  agentId?: string,
  repoId?: string,
): { template: PromptTemplate } | { skip: true } | null {
  // Helper to look up a template at a specific scope
  const lookupAtScope = (
    et: string,
    scope: "global" | "agent" | "repo",
    scopeId: string | null,
  ): PromptTemplateRow | undefined => {
    if (scopeId === null) {
      return (
        getDb()
          .prepare<PromptTemplateRow, [string, string]>(
            "SELECT * FROM prompt_templates WHERE eventType = ? AND scope = ? AND scopeId IS NULL",
          )
          .get(et, scope) ?? undefined
      );
    }
    return (
      getDb()
        .prepare<PromptTemplateRow, [string, string, string]>(
          "SELECT * FROM prompt_templates WHERE eventType = ? AND scope = ? AND scopeId = ?",
        )
        .get(et, scope, scopeId) ?? undefined
    );
  };

  // Try resolution at the scope chain for a given eventType string
  const tryResolve = (et: string): { template: PromptTemplate } | { skip: true } | "continue" => {
    // Build scope chain: agent → repo → global
    const scopeChain: Array<{ scope: "global" | "agent" | "repo"; scopeId: string | null }> = [];
    if (agentId) scopeChain.push({ scope: "agent", scopeId: agentId });
    if (repoId) scopeChain.push({ scope: "repo", scopeId: repoId });
    scopeChain.push({ scope: "global", scopeId: null });

    for (const { scope, scopeId } of scopeChain) {
      const row = lookupAtScope(et, scope, scopeId);
      if (!row) continue;

      if (row.state === "enabled") {
        return { template: rowToPromptTemplate(row) };
      }
      if (row.state === "skip_event") {
        return { skip: true };
      }
      // default_prompt_fallback: continue to next scope
    }

    return "continue";
  };

  // Pass 1: exact match
  const exactResult = tryResolve(eventType);
  if (exactResult !== "continue") return exactResult;

  // Pass 2: wildcard matching
  // e.g. "github.pull_request.review_submitted" → ["github.pull_request.*", "github.*"]
  const parts = eventType.split(".");
  const wildcards: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    wildcards.push(`${parts.slice(0, i).join(".")}.*`);
  }

  for (const wildcard of wildcards) {
    const wildcardResult = tryResolve(wildcard);
    if (wildcardResult !== "continue") return wildcardResult;
  }

  return null;
}

/**
 * Checkout a prompt template to a specific version from history.
 * Copies body and state from the history entry into the live record, bumps version.
 */
export function checkoutPromptTemplate(id: string, targetVersion: number): PromptTemplate {
  const now = new Date().toISOString();

  const existing = getDb()
    .prepare<PromptTemplateRow, [string]>("SELECT * FROM prompt_templates WHERE id = ?")
    .get(id);
  if (!existing) throw new Error(`Prompt template ${id} not found`);

  const historyEntry = getDb()
    .prepare<PromptTemplateHistoryRow, [string, number]>(
      "SELECT * FROM prompt_template_history WHERE templateId = ? AND version = ?",
    )
    .get(id, targetVersion);
  if (!historyEntry)
    throw new Error(`No history entry at version ${targetVersion} for template ${id}`);

  const newVersion = existing.version + 1;

  const row = getDb()
    .prepare<PromptTemplateRow, [string, string, number, string, string]>(
      `UPDATE prompt_templates SET body = ?, state = ?, version = ?, updatedAt = ?
       WHERE id = ? RETURNING *`,
    )
    .get(historyEntry.body, historyEntry.state, newVersion, now, id);

  if (!row) throw new Error("Failed to checkout prompt template");

  // Create history entry for the checkout
  getDb()
    .prepare(
      `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      id,
      newVersion,
      historyEntry.body,
      historyEntry.state,
      null,
      now,
      `Checked out from version ${targetVersion}`,
    );

  return rowToPromptTemplate(row);
}

// ─── Channel Activity Cursors ─────────────────────────────────────────────────

type ChannelActivityCursorRow = {
  channelId: string;
  lastSeenTs: string;
  updatedAt: string;
};

export interface ChannelActivityCursor {
  channelId: string;
  lastSeenTs: string;
  updatedAt: string;
}

function rowToChannelActivityCursor(row: ChannelActivityCursorRow): ChannelActivityCursor {
  return {
    channelId: row.channelId,
    lastSeenTs: row.lastSeenTs,
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function getAllChannelActivityCursors(): ChannelActivityCursor[] {
  return getDb()
    .prepare<ChannelActivityCursorRow, []>("SELECT * FROM channel_activity_cursors")
    .all()
    .map(rowToChannelActivityCursor);
}

export function getChannelActivityCursor(channelId: string): ChannelActivityCursor | null {
  const row = getDb()
    .prepare<ChannelActivityCursorRow, [string]>(
      "SELECT * FROM channel_activity_cursors WHERE channelId = ?",
    )
    .get(channelId);
  return row ? rowToChannelActivityCursor(row) : null;
}

export function upsertChannelActivityCursor(channelId: string, lastSeenTs: string): void {
  getDb()
    .prepare(
      `INSERT INTO channel_activity_cursors (channelId, lastSeenTs, updatedAt)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(channelId) DO UPDATE SET lastSeenTs = excluded.lastSeenTs, updatedAt = excluded.updatedAt`,
    )
    .run(channelId, lastSeenTs);
}

// ============================================================================
// Approval Requests
// ============================================================================

export interface ApprovalRequest {
  id: string;
  title: string;
  questions: unknown[];
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  approvers: unknown;
  status: "pending" | "approved" | "rejected" | "timeout";
  responses: unknown | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: unknown[] | null;
  createdAt: string;
  updatedAt: string;
}

interface ApprovalRequestRow {
  id: string;
  title: string;
  questions: string;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  approvers: string;
  status: string;
  responses: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    title: row.title,
    questions: JSON.parse(row.questions),
    workflowRunId: row.workflowRunId,
    workflowRunStepId: row.workflowRunStepId,
    sourceTaskId: row.sourceTaskId,
    approvers: JSON.parse(row.approvers),
    status: row.status as ApprovalRequest["status"],
    responses: row.responses ? JSON.parse(row.responses) : null,
    resolvedBy: row.resolvedBy,
    resolvedAt: normalizeDate(row.resolvedAt),
    timeoutSeconds: row.timeoutSeconds,
    expiresAt: normalizeDate(row.expiresAt),
    notificationChannels: row.notificationChannels ? JSON.parse(row.notificationChannels) : null,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export function createApprovalRequest(data: {
  id: string;
  title: string;
  questions: unknown[];
  approvers: unknown;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  timeoutSeconds?: number;
  notificationChannels?: unknown[];
}): ApprovalRequest {
  const now = new Date().toISOString();
  const expiresAt = data.timeoutSeconds
    ? new Date(Date.now() + data.timeoutSeconds * 1000).toISOString()
    : null;

  const row = getDb()
    .prepare<
      ApprovalRequestRow,
      [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        number | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO approval_requests (id, title, questions, workflowRunId, workflowRunStepId, sourceTaskId, approvers, timeoutSeconds, expiresAt, notificationChannels, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      data.id,
      data.title,
      JSON.stringify(data.questions),
      data.workflowRunId ?? null,
      data.workflowRunStepId ?? null,
      data.sourceTaskId ?? null,
      JSON.stringify(data.approvers),
      data.timeoutSeconds ?? null,
      expiresAt,
      data.notificationChannels ? JSON.stringify(data.notificationChannels) : null,
      now,
      now,
    );

  return rowToApprovalRequest(row!);
}

export function getApprovalRequestById(id: string): ApprovalRequest | null {
  const row = getDb()
    .prepare<ApprovalRequestRow, [string]>("SELECT * FROM approval_requests WHERE id = ?")
    .get(id);
  return row ? rowToApprovalRequest(row) : null;
}

export function resolveApprovalRequest(
  id: string,
  data: {
    status: "approved" | "rejected" | "timeout";
    responses?: unknown;
    resolvedBy?: string;
  },
): ApprovalRequest | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<ApprovalRequestRow, [string, string | null, string | null, string, string, string]>(
      `UPDATE approval_requests
       SET status = ?, responses = ?, resolvedBy = ?, resolvedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
    )
    .get(
      data.status,
      data.responses ? JSON.stringify(data.responses) : null,
      data.resolvedBy ?? null,
      now,
      now,
      id,
    );
  return row ? rowToApprovalRequest(row) : null;
}

export function updateApprovalRequestNotifications(
  id: string,
  notificationChannels: Array<{ channel: string; target: string; messageTs?: string }>,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE approval_requests SET notificationChannels = ?, updatedAt = ? WHERE id = ?")
    .run(JSON.stringify(notificationChannels), now, id);
}

export function listApprovalRequests(filters?: {
  status?: string;
  workflowRunId?: string;
  limit?: number;
}): ApprovalRequest[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.workflowRunId) {
    conditions.push("workflowRunId = ?");
    params.push(filters.workflowRunId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 100;
  params.push(limit);

  const stmt = getDb().prepare(
    `SELECT * FROM approval_requests ${where} ORDER BY createdAt DESC LIMIT ?`,
  );
  const rows = stmt.all(...params) as ApprovalRequestRow[];

  return rows.map(rowToApprovalRequest);
}

export interface StuckApprovalRun {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  approvalId: string;
  approvalStatus: string;
  approvalResponses: string | null;
  expiresAt: string | null;
}

export function getStuckApprovalRuns(): StuckApprovalRun[] {
  return getDb()
    .prepare<StuckApprovalRun, []>(
      `SELECT
        wr.id as runId,
        wrs.id as stepId,
        wrs.nodeId,
        wr.workflowId,
        ar.id as approvalId,
        ar.status as approvalStatus,
        ar.responses as approvalResponses,
        ar.expiresAt
      FROM workflow_runs wr
      JOIN workflow_run_steps wrs ON wrs.runId = wr.id AND wrs.status = 'waiting'
      JOIN approval_requests ar ON ar.workflowRunStepId = wrs.id
      WHERE wr.status = 'waiting'
        AND (ar.status IN ('approved', 'rejected', 'timeout')
             OR (ar.status = 'pending' AND ar.expiresAt IS NOT NULL AND ar.expiresAt < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    )
    .all();
}

export function getApprovalRequestByStepId(stepId: string): ApprovalRequest | null {
  const row = getDb()
    .prepare<ApprovalRequestRow, [string]>(
      "SELECT * FROM approval_requests WHERE workflowRunStepId = ?",
    )
    .get(stepId);
  return row ? rowToApprovalRequest(row) : null;
}

// TODO: Wire into a periodic cron/sweep to auto-timeout expired approval requests (Phase 2)
export function getExpiredPendingApprovals(): ApprovalRequest[] {
  const rows = getDb()
    .prepare<ApprovalRequestRow, []>(
      `SELECT * FROM approval_requests
       WHERE status = 'pending'
         AND expiresAt IS NOT NULL
         AND expiresAt < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .all();
  return rows.map(rowToApprovalRequest);
}

// ============================================================================
// Wait States (workflow `wait` node side table)
// ============================================================================
//
// Mirrors approval-request helpers above. Time-mode rows carry `wakeUpAt`;
// event-mode rows carry `eventName` + optional `eventFilter` (object or
// arrow-fn body string) and optional `expiresAt`. `resolveWaitState` is the
// race-safe transition gate — concurrent callers (poller + bus listener)
// rely on `WHERE status='pending'` so only the first one wins.

interface WaitStateRowDb {
  id: string;
  workflowRunId: string;
  workflowRunStepId: string;
  mode: string;
  wakeUpAt: string | null;
  eventName: string | null;
  eventFilter: string | null;
  expiresAt: string | null;
  status: string;
  firedPayload: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  eventScope: string;
}

function rowToWaitState(row: WaitStateRowDb): WaitStateRow {
  let parsedFilter: WaitStateRow["eventFilter"] = null;
  if (row.eventFilter !== null) {
    // eventFilter is stored as JSON: either an object or a JSON-encoded string.
    try {
      const decoded = JSON.parse(row.eventFilter);
      // Accept both shapes — string filter (arrow-fn body) or object filter.
      if (typeof decoded === "string" || (typeof decoded === "object" && decoded !== null)) {
        parsedFilter = decoded as WaitStateRow["eventFilter"];
      }
    } catch {
      parsedFilter = null;
    }
  }
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    workflowRunStepId: row.workflowRunStepId,
    mode: row.mode as WaitMode,
    wakeUpAt: normalizeDate(row.wakeUpAt),
    eventName: row.eventName,
    eventFilter: parsedFilter,
    expiresAt: normalizeDate(row.expiresAt),
    status: row.status as WaitStateStatus,
    firedPayload: row.firedPayload ? JSON.parse(row.firedPayload) : null,
    resolvedAt: normalizeDate(row.resolvedAt),
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
    eventScope: (row.eventScope as "run" | "global") ?? "run",
  };
}

export interface CreateWaitStateInput {
  id: string;
  workflowRunId: string;
  workflowRunStepId: string;
  mode: WaitMode;
  wakeUpAt?: string | null;
  eventName?: string | null;
  eventFilter?: Record<string, unknown> | string | null;
  expiresAt?: string | null;
  scope?: "run" | "global";
}

export function createWaitState(input: CreateWaitStateInput): WaitStateRow {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<
      WaitStateRowDb,
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
      ]
    >(
      `INSERT INTO wait_states
         (id, workflowRunId, workflowRunStepId, mode, wakeUpAt, eventName, eventFilter, expiresAt, eventScope, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.id,
      input.workflowRunId,
      input.workflowRunStepId,
      input.mode,
      input.wakeUpAt ?? null,
      input.eventName ?? null,
      input.eventFilter !== undefined && input.eventFilter !== null
        ? JSON.stringify(input.eventFilter)
        : null,
      input.expiresAt ?? null,
      input.scope ?? "run",
      now,
      now,
    );
  return rowToWaitState(row!);
}

export function getWaitStateById(id: string): WaitStateRow | null {
  const row = getDb()
    .prepare<WaitStateRowDb, [string]>("SELECT * FROM wait_states WHERE id = ?")
    .get(id);
  return row ? rowToWaitState(row) : null;
}

/**
 * Idempotency lookup — mirrors `getApprovalRequestByStepId`. A re-execution of
 * the same wait node finds its existing row instead of inserting a duplicate.
 */
export function getWaitStateByStepId(stepId: string): WaitStateRow | null {
  const row = getDb()
    .prepare<WaitStateRowDb, [string]>("SELECT * FROM wait_states WHERE workflowRunStepId = ?")
    .get(stepId);
  return row ? rowToWaitState(row) : null;
}

/**
 * Scan for waits the poller should resume now:
 *   - mode='time' with `wakeUpAt <= now`, OR
 *   - mode='event' with non-null `expiresAt <= now` (timeout branch).
 */
export function getDueWaitStates(): WaitStateRow[] {
  const rows = getDb()
    .prepare<WaitStateRowDb, []>(
      `SELECT * FROM wait_states
       WHERE status = 'pending'
         AND (
           (mode = 'time' AND wakeUpAt IS NOT NULL
              AND wakeUpAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           OR
           (mode = 'event' AND expiresAt IS NOT NULL
              AND expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         )`,
    )
    .all();
  return rows.map(rowToWaitState);
}

/**
 * Distinct `eventName` values across pending event-mode waits. Used at boot
 * by the wait-bus subscription system to register one listener per event name.
 */
export function getPendingEventWaitNames(): string[] {
  const rows = getDb()
    .prepare<{ eventName: string }, []>(
      `SELECT DISTINCT eventName FROM wait_states
       WHERE status = 'pending' AND eventName IS NOT NULL`,
    )
    .all();
  return rows.map((r) => r.eventName);
}

/**
 * Find pending event-mode waits matching `eventName`. Optional `runId` narrows
 * to a single run for run-scoped signals. The Phase 3 listener applies the
 * declarative/JS filter on top of this; the DB query is the cheap pre-filter.
 */
export function getPendingWaitsByEvent(eventName: string, runId?: string): WaitStateRow[] {
  if (runId !== undefined) {
    const rows = getDb()
      .prepare<WaitStateRowDb, [string, string]>(
        `SELECT * FROM wait_states
         WHERE status = 'pending' AND mode = 'event' AND eventName = ? AND workflowRunId = ?`,
      )
      .all(eventName, runId);
    return rows.map(rowToWaitState);
  }
  const rows = getDb()
    .prepare<WaitStateRowDb, [string]>(
      `SELECT * FROM wait_states
       WHERE status = 'pending' AND mode = 'event' AND eventName = ?`,
    )
    .all(eventName);
  return rows.map(rowToWaitState);
}

/**
 * Atomic state transition: pending → fired|timeout. Returns `{updated: true}`
 * iff the caller won the race (UPDATE matched a pending row). Concurrent
 * callers see `{updated: false}` and should bail without further side effects.
 */
export function resolveWaitState(
  id: string,
  data: { status: Exclude<WaitStateStatus, "pending">; firedPayload?: unknown },
): { updated: boolean; row: WaitStateRow | null } {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<WaitStateRowDb, [string, string | null, string, string, string]>(
      `UPDATE wait_states
       SET status = ?, firedPayload = ?, resolvedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
    )
    .get(
      data.status,
      data.firedPayload !== undefined ? JSON.stringify(data.firedPayload) : null,
      now,
      now,
      id,
    );
  return { updated: row !== null, row: row ? rowToWaitState(row) : null };
}

export interface StuckWaitRun {
  runId: string;
  stepId: string;
  nodeId: string;
  workflowId: string;
  waitId: string;
  waitMode: string;
  waitStatus: string;
  wakeUpAt: string | null;
  expiresAt: string | null;
  firedPayload: string | null;
}

/**
 * Recovery scan: workflow runs in `waiting` whose wait_state is either
 *   (a) already non-pending — signal arrived / timeout fired while down and
 *       the in-memory bus event was lost, OR
 *   (b) still pending but overdue (`wakeUpAt`/`expiresAt` already past).
 *
 * Case (b) overlaps with the wait-poller's first tick after boot, but explicit
 * recovery avoids the up-to-5s startup latency window for stuck runs.
 */
export function getStuckWaitRuns(): StuckWaitRun[] {
  return getDb()
    .prepare<StuckWaitRun, []>(
      `SELECT
        wr.id as runId,
        wrs.id as stepId,
        wrs.nodeId,
        wr.workflowId,
        ws.id as waitId,
        ws.mode as waitMode,
        ws.status as waitStatus,
        ws.wakeUpAt as wakeUpAt,
        ws.expiresAt as expiresAt,
        ws.firedPayload as firedPayload
      FROM workflow_runs wr
      JOIN workflow_run_steps wrs ON wrs.runId = wr.id AND wrs.status = 'waiting' AND wrs.nodeType = 'wait'
      JOIN wait_states ws ON ws.workflowRunStepId = wrs.id
      WHERE wr.status = 'waiting'
        AND (
          ws.status IN ('fired', 'timeout')
          OR (
            ws.status = 'pending'
            AND (
              (ws.wakeUpAt IS NOT NULL
                AND ws.wakeUpAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              OR
              (ws.expiresAt IS NOT NULL
                AND ws.expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )
          )
        )`,
    )
    .all();
}

// ============================================================================
// Skills
// ============================================================================

type SkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  type: string;
  scope: string;
  ownerAgentId: string | null;
  sourceUrl: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceBranch: string;
  sourceHash: string | null;
  isComplex: number;
  allowedTools: string | null;
  model: string | null;
  effort: string | null;
  context: string | null;
  agent: string | null;
  disableModelInvocation: number;
  userInvocable: number;
  version: number;
  isEnabled: number;
  systemDefault: number;
  createdAt: string;
  lastUpdatedAt: string;
  lastFetchedAt: string | null;
};

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    type: row.type as SkillType,
    scope: row.scope as SkillScope,
    ownerAgentId: row.ownerAgentId,
    sourceUrl: row.sourceUrl,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    sourceBranch: row.sourceBranch,
    sourceHash: row.sourceHash,
    isComplex: row.isComplex === 1,
    allowedTools: row.allowedTools,
    model: row.model,
    effort: row.effort,
    context: row.context,
    agent: row.agent,
    disableModelInvocation: row.disableModelInvocation === 1,
    userInvocable: row.userInvocable === 1,
    version: row.version,
    isEnabled: row.isEnabled === 1,
    systemDefault: row.systemDefault === 1,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    lastFetchedAt: row.lastFetchedAt,
  };
}

type AgentSkillRow = {
  id: string;
  agentId: string;
  skillId: string;
  isActive: number;
  installedAt: string;
};

function rowToAgentSkill(row: AgentSkillRow): AgentSkill {
  return {
    id: row.id,
    agentId: row.agentId,
    skillId: row.skillId,
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

type SkillWithInstallRow = SkillRow & {
  isActive: number;
  installedAt: string;
  sourceRank?: number;
  typeRank?: number;
};

function rowToSkillWithInstall(row: SkillWithInstallRow): SkillWithInstallInfo {
  return {
    ...rowToSkill(row),
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

type SkillFileRow = {
  id: string;
  skillId: string;
  path: string;
  content: string;
  mimeType: string;
  isBinary: number;
  size: number | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToSkillFile(row: SkillFileRow): SkillFile {
  return {
    id: row.id,
    skillId: row.skillId,
    path: row.path,
    content: row.content,
    mimeType: row.mimeType,
    isBinary: row.isBinary === 1,
    size: row.size,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export type SkillFileInput = {
  path: string;
  content: string;
  mimeType?: string;
  isBinary?: boolean;
  size?: number | null;
};

export type SkillFileManifestEntry = Omit<SkillFile, "content">;
type NormalizedSkillFileInput = {
  path: string;
  content: string;
  mimeType: string;
  isBinary: boolean;
  size: number;
};

export const SKILL_FILE_LIMITS = {
  maxCount: Number(process.env.SKILL_FILES_MAX_COUNT ?? 100),
  maxTotalBytes: Number(process.env.SKILL_FILES_MAX_TOTAL_BYTES ?? 10 * 1024 * 1024),
  maxFileBytes: Number(process.env.SKILL_FILES_MAX_FILE_BYTES ?? 500 * 1024),
};

const BINARY_SKILL_FILE_PLACEHOLDER = "[binary file - not synced]";

export function normalizeSkillFilePath(path: string): string {
  const raw = path.trim().replace(/\\/g, "/");
  if (!raw) throw new Error("File path is required");
  if (raw.startsWith("/")) throw new Error("File path must be relative");

  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("File path is required");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("File path cannot contain traversal segments");
  }

  const normalized = parts.join("/");
  if (normalized === "SKILL.md") {
    throw new Error("SKILL.md is stored on the skill record, not in skill_files");
  }
  return normalized;
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function normalizeSkillFileInput(input: SkillFileInput): NormalizedSkillFileInput {
  const path = normalizeSkillFilePath(input.path);
  const isBinary = input.isBinary === true;
  const content = isBinary ? input.content || BINARY_SKILL_FILE_PLACEHOLDER : input.content;
  const size = input.size ?? byteSize(content);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error("File size must be a non-negative number");
  }
  if (size > SKILL_FILE_LIMITS.maxFileBytes) {
    throw new Error(`File ${path} exceeds max size ${SKILL_FILE_LIMITS.maxFileBytes}`);
  }

  return {
    path,
    content,
    mimeType: input.mimeType ?? "text/plain",
    isBinary,
    size,
  };
}

function assertSkillFileLimits(skillId: string, incoming: SkillFileInput[], replaceAll: boolean) {
  const existing = replaceAll ? [] : listSkillFileManifest(skillId);
  const byPath = new Map(existing.map((file) => [file.path, file.size ?? 0]));

  for (const input of incoming) {
    const normalized = normalizeSkillFileInput(input);
    byPath.set(normalized.path, normalized.size);
  }

  if (byPath.size > SKILL_FILE_LIMITS.maxCount) {
    throw new Error(`Skill file count exceeds max ${SKILL_FILE_LIMITS.maxCount}`);
  }

  const total = [...byPath.values()].reduce((sum, size) => sum + size, 0);
  if (total > SKILL_FILE_LIMITS.maxTotalBytes) {
    throw new Error(`Skill files exceed max total size ${SKILL_FILE_LIMITS.maxTotalBytes}`);
  }
}

export interface SkillInsert {
  name: string;
  description: string;
  content: string;
  type?: SkillType;
  scope?: SkillScope;
  ownerAgentId?: string;
  sourceUrl?: string;
  sourceRepo?: string;
  sourcePath?: string;
  sourceBranch?: string;
  sourceHash?: string;
  isComplex?: boolean;
  allowedTools?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  systemDefault?: boolean;
}

export function createSkill(data: SkillInsert): Skill {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<SkillRow, (string | number | null)[]>(
      `INSERT INTO skills (
        id, name, description, content, type, scope, ownerAgentId,
        sourceUrl, sourceRepo, sourcePath, sourceBranch, sourceHash, isComplex,
        allowedTools, model, effort, context, agent, disableModelInvocation, userInvocable,
        version, isEnabled, systemDefault, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description,
      data.content,
      data.type ?? "personal",
      data.scope ?? "agent",
      data.ownerAgentId ?? null,
      data.sourceUrl ?? null,
      data.sourceRepo ?? null,
      data.sourcePath ?? null,
      data.sourceBranch ?? "main",
      data.sourceHash ?? null,
      data.isComplex ? 1 : 0,
      data.allowedTools ?? null,
      data.model ?? null,
      data.effort ?? null,
      data.context ?? null,
      data.agent ?? null,
      data.disableModelInvocation ? 1 : 0,
      data.userInvocable === false ? 0 : 1,
      data.systemDefault ? 1 : 0,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create skill");
  return rowToSkill(row);
}

export function updateSkill(
  id: string,
  updates: Partial<SkillInsert> & { isEnabled?: boolean; lastFetchedAt?: string },
): Skill | null {
  const existing = getSkillById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["lastUpdatedAt = ?"];
  const params: (string | number | null)[] = [now];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.content !== undefined) {
    sets.push("content = ?");
    params.push(updates.content);
  }
  if (updates.scope !== undefined) {
    sets.push("scope = ?");
    params.push(updates.scope);
  }
  if (updates.isEnabled !== undefined) {
    sets.push("isEnabled = ?");
    params.push(updates.isEnabled ? 1 : 0);
  }
  if (updates.systemDefault !== undefined) {
    sets.push("systemDefault = ?");
    params.push(updates.systemDefault ? 1 : 0);
  }
  if (updates.allowedTools !== undefined) {
    sets.push("allowedTools = ?");
    params.push(updates.allowedTools ?? null);
  }
  if (updates.model !== undefined) {
    sets.push("model = ?");
    params.push(updates.model ?? null);
  }
  if (updates.effort !== undefined) {
    sets.push("effort = ?");
    params.push(updates.effort ?? null);
  }
  if (updates.context !== undefined) {
    sets.push("context = ?");
    params.push(updates.context ?? null);
  }
  if (updates.agent !== undefined) {
    sets.push("agent = ?");
    params.push(updates.agent ?? null);
  }
  if (updates.disableModelInvocation !== undefined) {
    sets.push("disableModelInvocation = ?");
    params.push(updates.disableModelInvocation ? 1 : 0);
  }
  if (updates.userInvocable !== undefined) {
    sets.push("userInvocable = ?");
    params.push(updates.userInvocable ? 1 : 0);
  }
  if (updates.sourceUrl !== undefined) {
    sets.push("sourceUrl = ?");
    params.push(updates.sourceUrl ?? null);
  }
  if (updates.sourceRepo !== undefined) {
    sets.push("sourceRepo = ?");
    params.push(updates.sourceRepo ?? null);
  }
  if (updates.sourcePath !== undefined) {
    sets.push("sourcePath = ?");
    params.push(updates.sourcePath ?? null);
  }
  if (updates.sourceBranch !== undefined) {
    sets.push("sourceBranch = ?");
    params.push(updates.sourceBranch ?? "main");
  }
  if (updates.sourceHash !== undefined) {
    sets.push("sourceHash = ?");
    params.push(updates.sourceHash ?? null);
  }
  if (updates.isComplex !== undefined) {
    sets.push("isComplex = ?");
    params.push(updates.isComplex ? 1 : 0);
  }
  if (updates.lastFetchedAt !== undefined) {
    sets.push("lastFetchedAt = ?");
    params.push(updates.lastFetchedAt);
  }

  // Bump version when content changes
  if (updates.content !== undefined) {
    sets.push("version = version + 1");
  }

  params.push(id);
  const row = getDb()
    .prepare<SkillRow, (string | number | null)[]>(
      `UPDATE skills SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToSkill(row) : null;
}

function bumpSkillVersion(skillId: string, now = new Date().toISOString()) {
  getDb()
    .prepare("UPDATE skills SET version = version + 1, lastUpdatedAt = ? WHERE id = ?")
    .run(now, skillId);
}

export function listSkillFileManifest(skillId: string): SkillFileManifestEntry[] {
  return getDb()
    .prepare<SkillFileRow, [string]>(
      `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ?
       ORDER BY path ASC`,
    )
    .all(skillId)
    .map((row) => {
      const { content: _content, ...manifest } = rowToSkillFile(row);
      return manifest;
    });
}

export function getSkillFiles(skillId: string): SkillFile[] {
  return getDb()
    .prepare<SkillFileRow, [string]>(
      `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ?
       ORDER BY path ASC`,
    )
    .all(skillId)
    .map(rowToSkillFile);
}

export function getSkillFile(skillId: string, path: string): SkillFile | null {
  const normalizedPath = normalizeSkillFilePath(path);
  const row = getDb()
    .prepare<SkillFileRow, [string, string]>(
      `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ? AND path = ?`,
    )
    .get(skillId, normalizedPath);
  return row ? rowToSkillFile(row) : null;
}

export function upsertSkillFile(skillId: string, input: SkillFileInput): SkillFile {
  const payload = normalizeSkillFileInput(input);
  assertSkillFileLimits(skillId, [payload], false);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return upsertSkillFileUnchecked(skillId, payload, id, now, true);
}

function upsertSkillFileUnchecked(
  skillId: string,
  payload: NormalizedSkillFileInput,
  id: string,
  now: string,
  bumpVersion: boolean,
): SkillFile {
  const row = getDb()
    .prepare<SkillFileRow, (string | number | null)[]>(
      `INSERT INTO skill_files (
        id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skillId, path) DO UPDATE SET
        content = excluded.content,
        mimeType = excluded.mimeType,
        isBinary = excluded.isBinary,
        size = excluded.size,
        lastUpdatedAt = excluded.lastUpdatedAt
      RETURNING *`,
    )
    .get(
      id,
      skillId,
      payload.path,
      payload.content,
      payload.mimeType,
      payload.isBinary ? 1 : 0,
      payload.size,
      now,
      now,
    );

  if (!row) throw new Error("Failed to upsert skill file");
  if (bumpVersion) bumpSkillVersion(skillId, now);
  return rowToSkillFile(row);
}

export function upsertSkillFiles(skillId: string, files: SkillFileInput[]): SkillFile[] {
  if (files.length === 0) return [];
  const normalized = files.map(normalizeSkillFileInput);
  assertSkillFileLimits(skillId, normalized, false);

  const now = new Date().toISOString();
  return getDb().transaction(() => {
    const rows = normalized.map((file) =>
      upsertSkillFileUnchecked(skillId, file, crypto.randomUUID(), now, false),
    );
    bumpSkillVersion(skillId, now);
    return rows;
  })();
}

export function deleteSkillFile(skillId: string, path: string): boolean {
  const normalizedPath = normalizeSkillFilePath(path);
  const result = getDb()
    .prepare("DELETE FROM skill_files WHERE skillId = ? AND path = ?")
    .run(skillId, normalizedPath);
  if (result.changes > 0) {
    bumpSkillVersion(skillId);
    return true;
  }
  return false;
}

export function deleteSkill(id: string): boolean {
  const result = getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getSkillById(id: string): Skill | null {
  const row = getDb().prepare<SkillRow, [string]>("SELECT * FROM skills WHERE id = ?").get(id);
  return row ? rowToSkill(row) : null;
}

export function getSkillByName(
  name: string,
  scope: SkillScope,
  ownerAgentId?: string,
): Skill | null {
  const row = getDb()
    .prepare<SkillRow, [string, string, string]>(
      "SELECT * FROM skills WHERE name = ? AND scope = ? AND COALESCE(ownerAgentId, '') = ?",
    )
    .get(name, scope, ownerAgentId ?? "");
  return row ? rowToSkill(row) : null;
}

export interface SkillFilters {
  type?: SkillType;
  scope?: SkillScope;
  ownerAgentId?: string;
  isEnabled?: boolean;
  search?: string;
  limit?: number;
  includeContent?: boolean;
}

/**
 * Explicit column list used when `includeContent: false` — selects every
 * skill column except the heavy `content` (the full SKILL.md, avg ~10 KB),
 * which is replaced with an empty string so the row still satisfies `Skill`.
 */
const SKILL_SLIM_COLUMNS =
  "id, name, description, type, scope, ownerAgentId, sourceUrl, sourceRepo, sourcePath, sourceBranch, sourceHash, isComplex, allowedTools, model, effort, context, agent, disableModelInvocation, userInvocable, version, isEnabled, systemDefault, createdAt, lastUpdatedAt, lastFetchedAt, '' as content";

export function listSkills(filters?: SkillFilters): Skill[] {
  const columns = filters?.includeContent === false ? SKILL_SLIM_COLUMNS : "*";
  let query = `SELECT ${columns} FROM skills WHERE 1=1`;
  const params: (string | number)[] = [];

  if (filters?.type) {
    query += " AND type = ?";
    params.push(filters.type);
  }
  if (filters?.scope) {
    query += " AND scope = ?";
    params.push(filters.scope);
  }
  if (filters?.ownerAgentId) {
    query += " AND ownerAgentId = ?";
    params.push(filters.ownerAgentId);
  }
  if (filters?.isEnabled !== undefined) {
    query += " AND isEnabled = ?";
    params.push(filters.isEnabled ? 1 : 0);
  }
  if (filters?.search) {
    query += " AND (name LIKE ? OR description LIKE ?)";
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  query += " ORDER BY name ASC";

  if (filters?.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  return getDb()
    .prepare<SkillRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToSkill);
}

export function searchSkills(query: string, limit = 20, includeContent = true): Skill[] {
  const term = `%${query}%`;
  const columns = includeContent === false ? SKILL_SLIM_COLUMNS : "*";
  return getDb()
    .prepare<SkillRow, [string, string, number]>(
      `SELECT ${columns} FROM skills WHERE (name LIKE ? OR description LIKE ?) AND isEnabled = 1 ORDER BY name ASC LIMIT ?`,
    )
    .all(term, term, limit)
    .map(rowToSkill);
}

export function installSkill(agentId: string, skillId: string): AgentSkill {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<AgentSkillRow, [string, string, string, string]>(
      `INSERT INTO agent_skills (id, agentId, skillId, isActive, installedAt)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(agentId, skillId) DO UPDATE SET isActive = 1
       RETURNING *`,
    )
    .get(id, agentId, skillId, now);

  if (!row) throw new Error("Failed to install skill");
  return rowToAgentSkill(row);
}

export function getSystemDefaultSkills(): Skill[] {
  return getDb()
    .prepare<SkillRow, []>(
      "SELECT * FROM skills WHERE systemDefault = 1 AND isEnabled = 1 ORDER BY name ASC",
    )
    .all()
    .map(rowToSkill);
}

export function installSystemDefaultSkillsForAgent(agentId: string): AgentSkill[] {
  return getSystemDefaultSkills().map((skill) => installSkill(agentId, skill.id));
}

export function uninstallSkill(agentId: string, skillId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM agent_skills WHERE agentId = ? AND skillId = ?")
    .run(agentId, skillId);
  return result.changes > 0;
}

export function getAgentSkills(agentId: string, activeOnly = true): SkillWithInstallInfo[] {
  const query = `
    SELECT s.*, as2.isActive, as2.installedAt, 0 as sourceRank,
      CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END as typeRank
    FROM skills s
    JOIN agent_skills as2 ON s.id = as2.skillId
    WHERE as2.agentId = ?
      ${activeOnly ? "AND as2.isActive = 1" : ""}
      AND s.isEnabled = 1
    UNION ALL
    SELECT s.*, 1 as isActive, s.createdAt as installedAt, 1 as sourceRank,
      CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END as typeRank
    FROM skills s
    WHERE (s.systemDefault = 1 OR s.scope = 'swarm')
      AND s.isEnabled = 1
    ORDER BY
      sourceRank,
      typeRank,
      name
  `;

  const rows = getDb().prepare<SkillWithInstallRow, [string]>(query).all(agentId);

  // Deduplicate by name — personal skills take precedence (already sorted first)
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    })
    .map(rowToSkillWithInstall);
}

export function toggleAgentSkill(agentId: string, skillId: string, isActive: boolean): boolean {
  const result = getDb()
    .prepare("UPDATE agent_skills SET isActive = ? WHERE agentId = ? AND skillId = ?")
    .run(isActive ? 1 : 0, agentId, skillId);
  return result.changes > 0;
}

// ── MCP Servers ──────────────────────────────────────────────────────────

type McpServerRow = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  ownerAgentId: string | null;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envConfigKeys: string | null;
  headerConfigKeys: string | null;
  extraAuthorizeParams: string | null;
  authMethod: string | null;
  isEnabled: number;
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
};

type AgentMcpServerRow = {
  id: string;
  agentId: string;
  mcpServerId: string;
  isActive: number;
  installedAt: string;
};

type McpServerWithInstallRow = McpServerRow & { isActive: number; installedAt: string };

function rowToMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as McpServerScope,
    ownerAgentId: row.ownerAgentId,
    transport: row.transport as McpServerTransport,
    command: row.command,
    args: row.args,
    url: row.url,
    headers: row.headers,
    envConfigKeys: row.envConfigKeys,
    headerConfigKeys: row.headerConfigKeys,
    extraAuthorizeParams: row.extraAuthorizeParams,
    authMethod: (row.authMethod as McpServer["authMethod"]) ?? "static",
    isEnabled: row.isEnabled === 1,
    version: row.version,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

function rowToAgentMcpServer(row: AgentMcpServerRow): AgentMcpServer {
  return {
    id: row.id,
    agentId: row.agentId,
    mcpServerId: row.mcpServerId,
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

function rowToMcpServerWithInstall(row: McpServerWithInstallRow): McpServerWithInstallInfo {
  return {
    ...rowToMcpServer(row),
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
}

export interface McpServerInsert {
  name: string;
  transport: McpServerTransport;
  description?: string;
  scope?: McpServerScope;
  ownerAgentId?: string;
  command?: string;
  args?: string;
  url?: string;
  headers?: string;
  envConfigKeys?: string;
  headerConfigKeys?: string;
  extraAuthorizeParams?: string;
}

export function createMcpServer(data: McpServerInsert): McpServer {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<McpServerRow, (string | number | null)[]>(
      `INSERT INTO mcp_servers (
        id, name, description, scope, ownerAgentId, transport,
        command, args, url, headers,
        envConfigKeys, headerConfigKeys, extraAuthorizeParams,
        isEnabled, version, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      data.scope ?? "agent",
      data.ownerAgentId ?? null,
      data.transport,
      data.command ?? null,
      data.args ?? null,
      data.url ?? null,
      data.headers ?? null,
      data.envConfigKeys ?? null,
      data.headerConfigKeys ?? null,
      data.extraAuthorizeParams ?? null,
      now,
      now,
    );

  if (!row) throw new Error("Failed to create MCP server");
  return rowToMcpServer(row);
}

export function updateMcpServer(
  id: string,
  updates: Partial<McpServerInsert> & {
    isEnabled?: boolean;
    authMethod?: McpServer["authMethod"];
  },
): McpServer | null {
  const existing = getMcpServerById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["lastUpdatedAt = ?"];
  const params: (string | number | null)[] = [now];

  if (updates.name !== undefined) {
    sets.push("name = ?");
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description ?? null);
  }
  if (updates.scope !== undefined) {
    sets.push("scope = ?");
    params.push(updates.scope);
  }
  if (updates.transport !== undefined) {
    sets.push("transport = ?");
    params.push(updates.transport);
  }
  if (updates.command !== undefined) {
    sets.push("command = ?");
    params.push(updates.command ?? null);
  }
  if (updates.args !== undefined) {
    sets.push("args = ?");
    params.push(updates.args ?? null);
  }
  if (updates.url !== undefined) {
    sets.push("url = ?");
    params.push(updates.url ?? null);
  }
  if (updates.headers !== undefined) {
    sets.push("headers = ?");
    params.push(updates.headers ?? null);
  }
  if (updates.envConfigKeys !== undefined) {
    sets.push("envConfigKeys = ?");
    params.push(updates.envConfigKeys ?? null);
  }
  if (updates.headerConfigKeys !== undefined) {
    sets.push("headerConfigKeys = ?");
    params.push(updates.headerConfigKeys ?? null);
  }
  if (updates.extraAuthorizeParams !== undefined) {
    sets.push("extraAuthorizeParams = ?");
    params.push(updates.extraAuthorizeParams ?? null);
  }
  if (updates.isEnabled !== undefined) {
    sets.push("isEnabled = ?");
    params.push(updates.isEnabled ? 1 : 0);
  }
  if (updates.ownerAgentId !== undefined) {
    sets.push("ownerAgentId = ?");
    params.push(updates.ownerAgentId ?? null);
  }
  if (updates.authMethod !== undefined) {
    sets.push("authMethod = ?");
    params.push(updates.authMethod);
  }

  // Bump version on config changes
  const configFields = [
    "command",
    "args",
    "url",
    "headers",
    "envConfigKeys",
    "headerConfigKeys",
    "extraAuthorizeParams",
    "transport",
  ];
  if (configFields.some((f) => (updates as Record<string, unknown>)[f] !== undefined)) {
    sets.push("version = version + 1");
  }

  params.push(id);
  const row = getDb()
    .prepare<McpServerRow, (string | number | null)[]>(
      `UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);

  return row ? rowToMcpServer(row) : null;
}

export function deleteMcpServer(id: string): boolean {
  const result = getDb().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getMcpServerById(id: string): McpServer | null {
  const row = getDb()
    .prepare<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?")
    .get(id);
  return row ? rowToMcpServer(row) : null;
}

export function getMcpServerByName(
  name: string,
  scope: McpServerScope,
  ownerAgentId: string | null,
): McpServer | null {
  const row = getDb()
    .prepare<McpServerRow, [string, string, string]>(
      "SELECT * FROM mcp_servers WHERE name = ? AND scope = ? AND COALESCE(ownerAgentId, '') = ?",
    )
    .get(name, scope, ownerAgentId ?? "");
  return row ? rowToMcpServer(row) : null;
}

export interface McpServerFilters {
  scope?: McpServerScope;
  ownerAgentId?: string;
  transport?: McpServerTransport;
  isEnabled?: boolean;
  search?: string;
}

export function listMcpServers(filters?: McpServerFilters): McpServer[] {
  let query = "SELECT * FROM mcp_servers WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters?.scope) {
    query += " AND scope = ?";
    params.push(filters.scope);
  }
  if (filters?.ownerAgentId) {
    query += " AND ownerAgentId = ?";
    params.push(filters.ownerAgentId);
  }
  if (filters?.transport) {
    query += " AND transport = ?";
    params.push(filters.transport);
  }
  if (filters?.isEnabled !== undefined) {
    query += " AND isEnabled = ?";
    params.push(filters.isEnabled ? 1 : 0);
  }
  if (filters?.search) {
    query += " AND (name LIKE ? OR description LIKE ?)";
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  query += " ORDER BY name ASC";

  return getDb()
    .prepare<McpServerRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToMcpServer);
}

export function installMcpServer(agentId: string, mcpServerId: string): AgentMcpServer {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<AgentMcpServerRow, [string, string, string, string]>(
      `INSERT INTO agent_mcp_servers (id, agentId, mcpServerId, isActive, installedAt)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(agentId, mcpServerId) DO UPDATE SET isActive = 1
       RETURNING *`,
    )
    .get(id, agentId, mcpServerId, now);

  if (!row) throw new Error("Failed to install MCP server");
  return rowToAgentMcpServer(row);
}

export function uninstallMcpServer(agentId: string, mcpServerId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?")
    .run(agentId, mcpServerId);
  return result.changes > 0;
}

export function getAgentMcpServers(agentId: string, activeOnly = true): McpServerWithInstallInfo[] {
  const query = `
    SELECT ms.*, ams.isActive, ams.installedAt
    FROM mcp_servers ms
    JOIN agent_mcp_servers ams ON ms.id = ams.mcpServerId
    WHERE ams.agentId = ?
      ${activeOnly ? "AND ams.isActive = 1" : ""}
      AND ms.isEnabled = 1
    ORDER BY ms.name ASC
  `;

  return getDb()
    .prepare<McpServerWithInstallRow, [string]>(query)
    .all(agentId)
    .map(rowToMcpServerWithInstall);
}

// ============================================================================
// Context Usage Snapshots
// ============================================================================

type ContextSnapshotRow = {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens: number | null;
  contextTotalTokens: number | null;
  contextPercent: number | null;
  eventType: ContextSnapshotEventType;
  compactTrigger: string | null;
  preCompactTokens: number | null;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  // Migration 063 — see ContextFormulaSchema in src/types.ts for the value set.
  contextFormula: string | null;
  createdAt: string;
};

function rowToContextSnapshot(row: ContextSnapshotRow): ContextSnapshot {
  return {
    id: row.id,
    taskId: row.taskId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    contextUsedTokens: row.contextUsedTokens ?? undefined,
    contextTotalTokens: row.contextTotalTokens ?? undefined,
    contextPercent: row.contextPercent ?? undefined,
    eventType: row.eventType,
    compactTrigger: (row.compactTrigger as "auto" | "manual" | "auto-inferred" | null) ?? undefined,
    preCompactTokens: row.preCompactTokens ?? undefined,
    cumulativeInputTokens: row.cumulativeInputTokens,
    cumulativeOutputTokens: row.cumulativeOutputTokens,
    contextFormula: (row.contextFormula as ContextSnapshot["contextFormula"]) ?? undefined,
    createdAt: row.createdAt,
  };
}

const contextSnapshotQueries = {
  insert: () =>
    getDb().prepare<
      ContextSnapshotRow,
      [
        string,
        string,
        string,
        string,
        number | null,
        number | null,
        number | null,
        string,
        string | null,
        number | null,
        number,
        number,
        string | null, // contextFormula (migration 063)
        string,
      ]
    >(
      `INSERT INTO task_context_snapshots (id, taskId, agentId, sessionId, contextUsedTokens, contextTotalTokens, contextPercent, eventType, compactTrigger, preCompactTokens, cumulativeInputTokens, cumulativeOutputTokens, contextFormula, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),

  getByTaskId: () =>
    getDb().prepare<ContextSnapshotRow, [string, number]>(
      "SELECT * FROM task_context_snapshots WHERE taskId = ? ORDER BY createdAt ASC LIMIT ?",
    ),

  getBySessionId: () =>
    getDb().prepare<ContextSnapshotRow, [string, number]>(
      "SELECT * FROM task_context_snapshots WHERE sessionId = ? ORDER BY createdAt ASC LIMIT ?",
    ),
};

export interface CreateContextSnapshotInput {
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  contextPercent?: number;
  eventType: ContextSnapshotEventType;
  compactTrigger?: "auto" | "manual" | "auto-inferred";
  preCompactTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  // Migration 063 — adapter-supplied formula tag.
  contextFormula?: ContextSnapshot["contextFormula"];
}

export function createContextSnapshot(input: CreateContextSnapshotInput): ContextSnapshot {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  contextSnapshotQueries
    .insert()
    .run(
      id,
      input.taskId,
      input.agentId,
      input.sessionId,
      input.contextUsedTokens ?? null,
      input.contextTotalTokens ?? null,
      input.contextPercent ?? null,
      input.eventType,
      input.compactTrigger ?? null,
      input.preCompactTokens ?? null,
      input.cumulativeInputTokens ?? 0,
      input.cumulativeOutputTokens ?? 0,
      input.contextFormula ?? null,
      now,
    );

  // Update aggregate columns on agent_tasks
  if (input.contextPercent != null) {
    getDb()
      .prepare(
        `UPDATE agent_tasks SET peakContextPercent = MAX(COALESCE(peakContextPercent, 0), ?)
         WHERE id = ?`,
      )
      .run(input.contextPercent, input.taskId);
  }

  // Migration 063: peakContextTokens is monotonic-max across snapshots, not a
  // rolling latest. Mirrors Claude Code's status-line "peak context" semantic.
  if (input.contextUsedTokens != null) {
    getDb()
      .prepare(
        `UPDATE agent_tasks
         SET peakContextTokens = MAX(COALESCE(peakContextTokens, 0), ?)
         WHERE id = ?`,
      )
      .run(input.contextUsedTokens, input.taskId);
  }

  if (input.eventType === "compaction") {
    getDb()
      .prepare(
        "UPDATE agent_tasks SET compactionCount = COALESCE(compactionCount, 0) + 1 WHERE id = ?",
      )
      .run(input.taskId);
  }

  // Phase 10: set contextWindowSize on the FIRST snapshot that carries one
  // (was previously gated on eventType === 'completion', meaning the UI saw
  // NULL throughout running tasks). Subsequent snapshots leave it alone — the
  // window doesn't change mid-session.
  if (input.contextTotalTokens != null) {
    getDb()
      .prepare(
        `UPDATE agent_tasks
         SET contextWindowSize = ?
         WHERE id = ? AND contextWindowSize IS NULL`,
      )
      .run(input.contextTotalTokens, input.taskId);
  }

  return {
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    contextUsedTokens: input.contextUsedTokens,
    contextTotalTokens: input.contextTotalTokens,
    contextPercent: input.contextPercent,
    eventType: input.eventType,
    compactTrigger: input.compactTrigger,
    preCompactTokens: input.preCompactTokens,
    cumulativeInputTokens: input.cumulativeInputTokens ?? 0,
    cumulativeOutputTokens: input.cumulativeOutputTokens ?? 0,
    contextFormula: input.contextFormula,
    createdAt: now,
  };
}

export function getContextSnapshotsByTaskId(taskId: string, limit = 500): ContextSnapshot[] {
  return contextSnapshotQueries.getByTaskId().all(taskId, limit).map(rowToContextSnapshot);
}

export function getContextSnapshotsBySessionId(sessionId: string, limit = 500): ContextSnapshot[] {
  return contextSnapshotQueries.getBySessionId().all(sessionId, limit).map(rowToContextSnapshot);
}

export interface ContextSummary {
  compactionCount: number;
  peakContextPercent: number | null;
  // Migration 063: renamed from totalContextTokensUsed.
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  snapshotCount: number;
}

export function getContextSummaryByTaskId(taskId: string): ContextSummary {
  const task = getTaskById(taskId);
  const countRow = getDb()
    .prepare<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM task_context_snapshots WHERE taskId = ?",
    )
    .get(taskId);

  return {
    compactionCount: task?.compactionCount ?? 0,
    peakContextPercent: task?.peakContextPercent ?? null,
    peakContextTokens: task?.peakContextTokens ?? null,
    contextWindowSize: task?.contextWindowSize ?? null,
    snapshotCount: countRow?.cnt ?? 0,
  };
}

// ─── API Key Pool Tracking ───────────────────────────────────────────────────

export interface ApiKeyStatus {
  id: string;
  keyType: string;
  keySuffix: string;
  keyIndex: number;
  scope: string;
  scopeId: string | null;
  status: string;
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
  lastRateLimitAt: string | null;
  totalUsageCount: number;
  rateLimitCount: number;
  /** Optional human-friendly label set from the dashboard. */
  name: string | null;
  /** Auto-derived harness provider (claude/pi/codex) — see deriveProviderFromKeyType. */
  provider: string;
  /** Latest provider-emitted rate-limit window snapshots, keyed by window type. */
  rateLimitWindows: RateLimitWindowTelemetry;
  createdAt: string;
  updatedAt: string;
}

type ApiKeyStatusRow = Omit<ApiKeyStatus, "rateLimitWindows"> & { rateLimitWindows: string | null };

function parseRateLimitWindowsJson(value: string | null | undefined): RateLimitWindowTelemetry {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RateLimitWindowTelemetry;
    }
  } catch {
    // Ignore malformed historical values; telemetry is best-effort.
  }
  return {};
}

function rowToApiKeyStatus(row: ApiKeyStatusRow): ApiKeyStatus {
  return { ...row, rateLimitWindows: parseRateLimitWindowsJson(row.rateLimitWindows) };
}

/**
 * Get available (non-rate-limited) key indices for a credential type.
 * Automatically clears expired rate limits before returning.
 */
export function getAvailableKeyIndices(
  keyType: string,
  totalKeys: number,
  scope = "global",
  scopeId: string | null = null,
): number[] {
  const now = new Date().toISOString();
  const db = getDb();
  const effectiveScopeId = scopeId ?? "";

  // Auto-clear expired rate limits
  db.prepare(
    `UPDATE api_key_status
     SET status = 'available', rateLimitedUntil = NULL, updatedAt = ?
     WHERE keyType = ? AND scope = ? AND scopeId = ?
       AND status = 'rate_limited' AND rateLimitedUntil IS NOT NULL AND rateLimitedUntil <= ?`,
  ).run(now, keyType, scope, effectiveScopeId, now);

  // Get currently rate-limited key indices
  const rateLimited = db
    .prepare<{ keyIndex: number }, [string, string, string]>(
      `SELECT keyIndex FROM api_key_status
       WHERE keyType = ? AND scope = ? AND scopeId = ?
         AND status = 'rate_limited'`,
    )
    .all(keyType, scope, effectiveScopeId);

  const blockedIndices = new Set(rateLimited.map((r) => r.keyIndex));
  const available: number[] = [];
  for (let i = 0; i < totalKeys; i++) {
    if (!blockedIndices.has(i)) available.push(i);
  }
  return available;
}

/**
 * Record that a key was used for a task (upsert key status + update task).
 */
export function recordKeyUsage(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  taskId: string | null,
  scope = "global",
  scopeId: string | null = null,
): void {
  const now = new Date().toISOString();
  const db = getDb();
  const effectiveScopeId = scopeId ?? "";

  // Upsert key status record. Sets `provider` on insert (auto-derived from
  // keyType — see deriveProviderFromKeyType in src/utils/credentials.ts).
  // The `name` column is left null on insert and only set via the
  // setApiKeyName API endpoint when the user manually labels the key.
  const provider = deriveProviderFromKeyType(keyType);
  db.prepare(
    `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, lastUsedAt, totalUsageCount, provider, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(keyType, keySuffix, scope, scopeId)
     DO UPDATE SET
       lastUsedAt = excluded.lastUsedAt,
       totalUsageCount = totalUsageCount + 1,
       keyIndex = excluded.keyIndex,
       updatedAt = excluded.updatedAt`,
  ).run(keyType, keySuffix, keyIndex, scope, effectiveScopeId, now, provider, now);

  // Record which key was used on the task
  if (taskId) {
    db.prepare(
      "UPDATE agent_tasks SET credentialKeySuffix = ?, credentialKeyType = ? WHERE id = ?",
    ).run(keySuffix, keyType, taskId);
  }
}

/**
 * Mark a key as rate-limited with a retry-after timestamp.
 */
export function markKeyRateLimited(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
  scope = "global",
  scopeId: string | null = null,
): void {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  getDb()
    .prepare(
      `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, status, rateLimitedUntil, lastRateLimitAt, rateLimitCount, provider, updatedAt)
       VALUES (?, ?, ?, ?, ?, 'rate_limited', ?, ?, 1, ?, ?)
       ON CONFLICT(keyType, keySuffix, scope, scopeId)
       DO UPDATE SET
         status = 'rate_limited',
         rateLimitedUntil = excluded.rateLimitedUntil,
         lastRateLimitAt = excluded.lastRateLimitAt,
         rateLimitCount = rateLimitCount + 1,
         keyIndex = excluded.keyIndex,
         updatedAt = excluded.updatedAt`,
    )
    .run(
      keyType,
      keySuffix,
      keyIndex,
      scope,
      effectiveScopeId,
      rateLimitedUntil,
      now,
      provider,
      now,
    );
}

export function recordKeyRateLimitWindows(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  windows: RateLimitWindowTelemetry,
  scope = "global",
  scopeId: string | null = null,
): void {
  if (Object.keys(windows).length === 0) return;

  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  const db = getDb();
  const existing = db
    .prepare<{ rateLimitWindows: string | null }, [string, string, string, string]>(
      `SELECT rateLimitWindows FROM api_key_status
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?`,
    )
    .get(keyType, keySuffix, scope, effectiveScopeId);
  const serialized = JSON.stringify({
    ...parseRateLimitWindowsJson(existing?.rateLimitWindows),
    ...windows,
  });

  db.prepare(
    `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, rateLimitWindows, provider, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(keyType, keySuffix, scope, scopeId)
       DO UPDATE SET
         rateLimitWindows = excluded.rateLimitWindows,
         keyIndex = excluded.keyIndex,
         provider = excluded.provider,
         updatedAt = excluded.updatedAt`,
  ).run(keyType, keySuffix, keyIndex, scope, effectiveScopeId, serialized, provider, now);
}

/**
 * Set or clear the human-friendly `name` label on a pooled credential.
 * Identified by the natural key (keyType + keySuffix + scope + scopeId).
 * Returns true if a row was updated, false if no matching key exists.
 */
export function setApiKeyName(
  keyType: string,
  keySuffix: string,
  name: string | null,
  scope = "global",
  scopeId: string | null = null,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE api_key_status
       SET name = ?, updatedAt = ?
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?`,
    )
    .run(name, new Date().toISOString(), keyType, keySuffix, scope, scopeId ?? "");
  return result.changes > 0;
}

/**
 * Clear a stale rate-limit record after a successful use proves the key is healthy.
 */
export function clearKeyRateLimit(
  keyType: string,
  keySuffix: string,
  scope = "global",
  scopeId: string | null = null,
): boolean {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const result = getDb()
    .prepare(
      `UPDATE api_key_status
       SET status = 'available', rateLimitedUntil = NULL, updatedAt = ?
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?
         AND status = 'rate_limited'`,
    )
    .run(now, keyType, keySuffix, scope, effectiveScopeId);
  return result.changes > 0;
}

/**
 * Get all key status records for a credential type.
 */
export function getKeyStatuses(
  keyType?: string,
  scope?: string,
  scopeId?: string | null,
): ApiKeyStatus[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: string[] = [];

  if (keyType) {
    conditions.push("keyType = ?");
    params.push(keyType);
  }
  if (scope) {
    conditions.push("scope = ?");
    params.push(scope);
    if (scopeId !== undefined) {
      conditions.push("scopeId = ?");
      params.push(scopeId ?? "");
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare<ApiKeyStatusRow, string[]>(`SELECT * FROM api_key_status ${where} ORDER BY keyIndex`)
    .all(...params)
    .map(rowToApiKeyStatus);
}

export interface KeyCostSummary {
  keyType: string;
  keySuffix: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
}

/**
 * Aggregate cost data per API key by joining session_costs through agent_tasks.
 */
export function getKeyCostSummary(keyType?: string): KeyCostSummary[] {
  const db = getDb();
  const conditions = ["t.credentialKeySuffix IS NOT NULL"];
  const params: string[] = [];

  if (keyType) {
    conditions.push("t.credentialKeyType = ?");
    params.push(keyType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // Phase 13: INNER JOIN -> LEFT JOIN. The `WHERE t.credentialKeySuffix IS NOT NULL`
  // still filters out rows whose taskId doesn't link to a task with credentials,
  // but switching to LEFT JOIN means a future change that drops the WHERE
  // (or a debugging query that wants orphan rows visible) doesn't silently
  // disappear them. Equivalent for the current `WHERE … IS NOT NULL` filter;
  // makes the query's intent (cost rows owned by a credential) explicit.
  return db
    .prepare<KeyCostSummary, string[]>(
      `SELECT
        t.credentialKeyType as keyType,
        t.credentialKeySuffix as keySuffix,
        COALESCE(SUM(sc.totalCostUsd), 0) as totalCost,
        COALESCE(SUM(sc.inputTokens), 0) as totalInputTokens,
        COALESCE(SUM(sc.outputTokens), 0) as totalOutputTokens,
        COUNT(DISTINCT sc.taskId) as taskCount
      FROM session_costs sc
      LEFT JOIN agent_tasks t ON sc.taskId = t.id
      ${where}
      GROUP BY t.credentialKeyType, t.credentialKeySuffix`,
    )
    .all(...params);
}

// ============================================================================
// User Identity Operations
// ============================================================================

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  notes: string | null;
  emailAliases: string | null;
  preferredChannel: string | null;
  timezone: string | null;
  // Phase 064 columns
  metadata: string | null;
  dailyBudgetUsd: number | null;
  status: string;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    role: row.role ?? undefined,
    notes: row.notes ?? undefined,
    emailAliases: row.emailAliases ? JSON.parse(row.emailAliases) : [],
    preferredChannel: row.preferredChannel ?? "slack",
    timezone: row.timezone ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    dailyBudgetUsd: row.dailyBudgetUsd ?? null,
    status: (row.status as "invited" | "active" | "suspended") ?? "active",
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function getUserById(id: string): User | null {
  const row = getDb().prepare<UserRow, string>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row) : null;
}

export function getAllUsers(): User[] {
  return getDb().prepare<UserRow, []>("SELECT * FROM users ORDER BY name").all().map(rowToUser);
}

export function createUser(data: {
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
  dailyBudgetUsd?: number | null;
  status?: "invited" | "active" | "suspended";
}): User {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<UserRow, (string | number | null)[]>(
      `INSERT INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone, metadata, dailyBudgetUsd, status, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.email ?? null,
      data.role ?? null,
      data.notes ?? null,
      JSON.stringify(data.emailAliases ?? []),
      data.preferredChannel ?? "slack",
      data.timezone ?? null,
      data.metadata !== undefined ? JSON.stringify(data.metadata) : null,
      data.dailyBudgetUsd ?? null,
      data.status ?? "active",
      now,
      now,
    );
  if (!row) throw new Error("Failed to create user");
  return rowToUser(row);
}

export function updateUser(
  id: string,
  data: Partial<{
    name: string;
    email: string;
    role: string;
    notes: string;
    emailAliases: string[];
    preferredChannel: string;
    timezone: string;
    metadata: Record<string, unknown> | null;
    dailyBudgetUsd: number | null;
    status: "invited" | "active" | "suspended";
  }>,
): User | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (data.name !== undefined) {
    sets.push("name = ?");
    params.push(data.name);
  }
  if (data.email !== undefined) {
    sets.push("email = ?");
    params.push(data.email);
  }
  if (data.role !== undefined) {
    sets.push("role = ?");
    params.push(data.role);
  }
  if (data.notes !== undefined) {
    sets.push("notes = ?");
    params.push(data.notes);
  }
  if (data.emailAliases !== undefined) {
    sets.push("emailAliases = ?");
    params.push(JSON.stringify(data.emailAliases));
  }
  if (data.preferredChannel !== undefined) {
    sets.push("preferredChannel = ?");
    params.push(data.preferredChannel);
  }
  if (data.timezone !== undefined) {
    sets.push("timezone = ?");
    params.push(data.timezone);
  }
  if (data.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(data.metadata === null ? null : JSON.stringify(data.metadata));
  }
  if (data.dailyBudgetUsd !== undefined) {
    sets.push("dailyBudgetUsd = ?");
    params.push(data.dailyBudgetUsd);
  }
  if (data.status !== undefined) {
    sets.push("status = ?");
    params.push(data.status);
  }

  if (sets.length === 0) return getUserById(id);

  sets.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const row = getDb()
    .prepare<UserRow, (string | number | null)[]>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    )
    .get(...params);
  return row ? rowToUser(row) : null;
}

export function deleteUser(id: string): boolean {
  // Clear any task references before deleting
  getDb()
    .prepare("UPDATE agent_tasks SET requestedByUserId = NULL WHERE requestedByUserId = ?")
    .run(id);
  const result = getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
  return result.changes > 0;
}

// ============================================================================
// Inbox Item State (per-user dismiss/snooze/done for action-items inbox)
// ============================================================================

interface InboxItemStateRow {
  id: string;
  userId: string;
  itemType: string;
  itemId: string;
  status: string;
  snoozeUntil: string | null;
  dismissedAt: string | null;
  doneAt: string | null;
  createdAt: string;
  lastUpdatedAt: string;
}

function rowToInboxItemState(row: InboxItemStateRow): InboxItemState {
  return {
    id: row.id,
    userId: row.userId,
    itemType: row.itemType as InboxItemType,
    itemId: row.itemId,
    status: row.status as InboxItemStatus,
    snoozeUntil: row.snoozeUntil ?? undefined,
    dismissedAt: row.dismissedAt ?? undefined,
    doneAt: row.doneAt ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function listInboxState(opts: {
  userId: string;
  status?: InboxItemStatus;
  itemType?: InboxItemType;
}): InboxItemState[] {
  const conditions: string[] = ["userId = ?"];
  const params: string[] = [opts.userId];

  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.itemType) {
    conditions.push("itemType = ?");
    params.push(opts.itemType);
  }

  const where = conditions.join(" AND ");
  return getDb()
    .prepare<InboxItemStateRow, string[]>(
      `SELECT * FROM inbox_item_state WHERE ${where} ORDER BY lastUpdatedAt DESC`,
    )
    .all(...params)
    .map(rowToInboxItemState);
}

export function upsertInboxState(opts: {
  userId: string;
  itemType: InboxItemType;
  itemId: string;
  status: InboxItemStatus;
  snoozeUntil?: string;
  dismissedAt?: string;
  doneAt?: string;
}): InboxItemState {
  const now = new Date().toISOString();
  // Auto-derive timestamps from status when not explicitly provided.
  const dismissedAt = opts.dismissedAt ?? (opts.status === "dismissed" ? now : null);
  const doneAt = opts.doneAt ?? (opts.status === "done" ? now : null);
  const snoozeUntil = opts.snoozeUntil ?? null;

  // SQLite upsert via UNIQUE(userId, itemType, itemId).
  const row = getDb()
    .prepare<InboxItemStateRow, (string | null)[]>(
      `INSERT INTO inbox_item_state (userId, itemType, itemId, status, snoozeUntil, dismissedAt, doneAt, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(userId, itemType, itemId) DO UPDATE SET
         status = excluded.status,
         snoozeUntil = excluded.snoozeUntil,
         dismissedAt = excluded.dismissedAt,
         doneAt = excluded.doneAt,
         lastUpdatedAt = excluded.lastUpdatedAt
       RETURNING *`,
    )
    .get(
      opts.userId,
      opts.itemType,
      opts.itemId,
      opts.status,
      snoozeUntil,
      dismissedAt,
      doneAt,
      now,
      now,
    );
  if (!row) throw new Error("Failed to upsert inbox state");
  return rowToInboxItemState(row);
}

// ============================================================================
// Task Templates ("To start" bucket — polymorphic starters registry)
// ============================================================================

interface TaskTemplateRow {
  id: string;
  title: string;
  description: string;
  prompt: string;
  kind: string;
  payload: string;
  category: string | null;
  tags: string;
  createdAt: string;
}

function rowToTaskTemplate(row: TaskTemplateRow): TaskTemplate {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {}
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {}
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    prompt: row.prompt,
    kind: row.kind as TaskTemplateKind,
    payload,
    category: row.category ?? undefined,
    tags,
    createdAt: row.createdAt,
  };
}

export function listTaskTemplates(opts?: {
  category?: string;
  kind?: TaskTemplateKind;
  query?: string;
}): TaskTemplate[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }
  if (opts?.kind) {
    conditions.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts?.query && opts.query.trim().length > 0) {
    // Case-insensitive LIKE match against title OR description, single
    // parameter-bound WHERE clause to prevent injection.
    conditions.push("(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)");
    const needle = `%${opts.query.toLowerCase()}%`;
    params.push(needle, needle);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return getDb()
    .prepare<TaskTemplateRow, string[]>(`SELECT * FROM task_templates ${where} ORDER BY createdAt`)
    .all(...params)
    .map(rowToTaskTemplate);
}

// ============================================================================
// Sessions — root task chain + recent-sessions list
// ============================================================================

/**
 * Walk the parent→child chain rooted at `rootTaskId` via recursive CTE.
 * Returns the chain ordered by `createdAt` (so the root is first; siblings
 * appear in creation order; grand-children after their parents).
 */
export function getRootTaskChain(rootTaskId: string): AgentTask[] {
  const rows = getDb()
    .prepare<AgentTaskRow, string>(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM agent_tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM agent_tasks t
         JOIN chain c ON t.parentTaskId = c.id
       )
       SELECT t.* FROM agent_tasks t
       JOIN chain ON chain.id = t.id
       ORDER BY t.createdAt`,
    )
    .all(rootTaskId);
  return rows.map(rowToAgentTask);
}

export interface SessionListItem {
  root: AgentTask;
  chainTaskCount: number;
  lastActivityAt: string;
  latestStatus: AgentTaskStatus;
}

/**
 * Slim variant of {@link SessionListItem} — the `root` task is an
 * `AgentTaskSummary` (full `task` text + completion/integration blobs dropped).
 * The session list only renders a brief of the root; the full root + chain are
 * on `GET /api/sessions/{rootTaskId}`.
 */
export interface SessionListItemSummary {
  root: AgentTaskSummary;
  chainTaskCount: number;
  lastActivityAt: string;
  latestStatus: AgentTaskStatus;
}

/**
 * List the most recent sessions ordered by chain-wide latest activity.
 * A "session" here is any task with `parentTaskId IS NULL` — its descendants
 * (children, grand-children, …) are summarized via the recursive CTE.
 *
 * Single-pass CTE: seeds with root tasks matching the filter, walks the full
 * descendant tree once, then aggregates chainCount / lastActivityAt /
 * latestStatus in two lightweight non-recursive CTEs — replacing the original
 * pattern of 3 correlated subqueries each re-running the recursion per row.
 */
interface ListRecentSessionsOpts {
  limit?: number;
  offset?: number;
  /** Filter to root tasks whose `source` is in this list. Empty/undefined → no source filter. */
  source?: string[];
  /** Case-insensitive substring match against `r.task`. */
  q?: string;
  /** When set, restrict to root tasks where `requestedByUserId` equals this value. NULL rows are excluded. */
  requestedByUserId?: string;
  /** When true, return slim `SessionListItemSummary` rows (default: full). */
  slim?: boolean;
}

export function listRecentSessions(
  opts?: ListRecentSessionsOpts & { slim?: false },
): SessionListItem[];
export function listRecentSessions(
  opts: ListRecentSessionsOpts & { slim: true },
): SessionListItemSummary[];
export function listRecentSessions(
  opts?: ListRecentSessionsOpts,
): SessionListItem[] | SessionListItemSummary[] {
  const limit = opts?.limit ?? 25;
  const offset = opts?.offset ?? 0;
  const sources = opts?.source?.filter((s) => s.length > 0) ?? [];
  const q = opts?.q?.trim();
  const requestedByUserId = opts?.requestedByUserId?.trim() || undefined;

  const conditions: string[] = ["r.parentTaskId IS NULL"];
  const params: (string | number)[] = [];

  if (sources.length > 0) {
    conditions.push(`r.source IN (${sources.map(() => "?").join(", ")})`);
    params.push(...sources);
  }
  if (q && q.length > 0) {
    conditions.push("lower(r.task) LIKE ?");
    params.push(`%${q.toLowerCase()}%`);
  }
  if (requestedByUserId) {
    conditions.push("r.requestedByUserId = ?");
    params.push(requestedByUserId);
  }
  params.push(limit, offset);

  const rootRows = getDb()
    .prepare<
      AgentTaskRow & { __chainCount: number; __lastActivityAt: string; __latestStatus: string },
      typeof params
    >(
      `WITH RECURSIVE chain(root_id, id, lastUpdatedAt, status) AS (
         SELECT r.id, r.id, r.lastUpdatedAt, r.status
         FROM agent_tasks r
         WHERE ${conditions.join(" AND ")}
         UNION ALL
         SELECT c.root_id, t.id, t.lastUpdatedAt, t.status
         FROM agent_tasks t
         JOIN chain c ON t.parentTaskId = c.id
       ),
       agg AS (
         SELECT
           root_id,
           COUNT(*) AS chainCount,
           MAX(lastUpdatedAt) AS lastActivityAt
         FROM chain
         GROUP BY root_id
       ),
       latest_status AS (
         SELECT c.root_id, c.status AS latestStatus
         FROM chain c
         JOIN agg a ON c.root_id = a.root_id AND c.lastUpdatedAt = a.lastActivityAt
         GROUP BY c.root_id
       )
       SELECT
         r.*,
         a.chainCount AS __chainCount,
         a.lastActivityAt AS __lastActivityAt,
         COALESCE(ls.latestStatus, r.status) AS __latestStatus
       FROM agent_tasks r
       JOIN agg a ON a.root_id = r.id
       LEFT JOIN latest_status ls ON ls.root_id = r.id
       ORDER BY a.lastActivityAt DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params);

  if (opts?.slim) {
    return rootRows.map((row): SessionListItemSummary => {
      const { __chainCount, __lastActivityAt, __latestStatus, ...taskRow } = row;
      return {
        root: rowToAgentTaskSummary(taskRow as AgentTaskRow),
        chainTaskCount: __chainCount,
        lastActivityAt: __lastActivityAt ?? row.lastUpdatedAt,
        latestStatus: (__latestStatus as AgentTaskStatus) ?? row.status,
      };
    });
  }

  return rootRows.map((row): SessionListItem => {
    const { __chainCount, __lastActivityAt, __latestStatus, ...taskRow } = row;
    return {
      root: rowToAgentTask(taskRow as AgentTaskRow),
      chainTaskCount: __chainCount,
      lastActivityAt: __lastActivityAt ?? row.lastUpdatedAt,
      latestStatus: (__latestStatus as AgentTaskStatus) ?? row.status,
    };
  });
}

/**
 * Filter-aware count of sessions (root tasks) matching the same `source` / `q`
 * / `requestedByUserId` filters as `listRecentSessions`. Powers a correct
 * `total` in the `/api/sessions` pager — a session is a root task, so this is
 * a plain count, no recursive chain walk needed.
 */
export function countSessions(
  opts?: Pick<ListRecentSessionsOpts, "source" | "q" | "requestedByUserId">,
): number {
  const sources = opts?.source?.filter((s) => s.length > 0) ?? [];
  const q = opts?.q?.trim();
  const requestedByUserId = opts?.requestedByUserId?.trim() || undefined;

  const conditions: string[] = ["parentTaskId IS NULL"];
  const params: string[] = [];

  if (sources.length > 0) {
    conditions.push(`source IN (${sources.map(() => "?").join(", ")})`);
    params.push(...sources);
  }
  if (q && q.length > 0) {
    conditions.push("lower(task) LIKE ?");
    params.push(`%${q.toLowerCase()}%`);
  }
  if (requestedByUserId) {
    conditions.push("requestedByUserId = ?");
    params.push(requestedByUserId);
  }

  const row = getDb()
    .prepare<{ count: number }, string[]>(
      `SELECT COUNT(*) AS count FROM agent_tasks WHERE ${conditions.join(" AND ")}`,
    )
    .get(...params);
  return row?.count ?? 0;
}

// ============================================================================
// Budgets, daily-spend aggregation, and budget-refusal notifications (Phase 2)
// ----------------------------------------------------------------------------
// `budgets` and `budget_refusal_notifications` use INTEGER epoch-ms for their
// `createdAt` / `lastUpdatedAt` columns (deliberate divergence — see migration
// 044). All inserts here use `Date.now()` accordingly.
// ============================================================================

interface BudgetRow {
  scope: string;
  scope_id: string;
  daily_budget_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
}

interface BudgetRefusalNotificationRow {
  task_id: string;
  date: string;
  agent_id: string;
  cause: string;
  agent_spend_usd: number | null;
  agent_budget_usd: number | null;
  global_spend_usd: number | null;
  global_budget_usd: number | null;
  user_spend_usd: number | null;
  user_budget_usd: number | null;
  follow_up_task_id: string | null;
  createdAt: number;
}

interface CoalesceSumRow {
  total: number;
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    scope: row.scope as BudgetScope,
    scopeId: row.scope_id,
    dailyBudgetUsd: row.daily_budget_usd,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

function rowToBudgetRefusalNotification(
  row: BudgetRefusalNotificationRow,
): BudgetRefusalNotification {
  return {
    taskId: row.task_id,
    date: row.date,
    agentId: row.agent_id,
    cause: row.cause as BudgetRefusalCause,
    agentSpendUsd: row.agent_spend_usd ?? undefined,
    agentBudgetUsd: row.agent_budget_usd ?? undefined,
    globalSpendUsd: row.global_spend_usd ?? undefined,
    globalBudgetUsd: row.global_budget_usd ?? undefined,
    userSpendUsd: row.user_spend_usd ?? undefined,
    userBudgetUsd: row.user_budget_usd ?? undefined,
    followUpTaskId: row.follow_up_task_id ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Look up a single budget row by (scope, scopeId). Returns `null` when no row
 * exists — callers treat that as "unlimited / no budget configured".
 */
export function getBudget(scope: BudgetScope, scopeId: string): Budget | null {
  const row = getDb()
    .prepare<BudgetRow, [string, string]>(
      "SELECT scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt FROM budgets WHERE scope = ? AND scope_id = ?",
    )
    .get(scope, scopeId);
  return row ? rowToBudget(row) : null;
}

/**
 * Phase 6: list every budget row in the system. Used by `GET /api/budgets`.
 * Order is `(scope, scope_id)` for stable output across calls.
 */
export function getBudgets(): Budget[] {
  return getDb()
    .prepare<BudgetRow, []>(
      "SELECT scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt FROM budgets ORDER BY scope, scope_id",
    )
    .all()
    .map(rowToBudget);
}

/**
 * Phase 6: upsert a budget row. Creates the row if `(scope, scopeId)` does not
 * exist, otherwise updates `daily_budget_usd` and `lastUpdatedAt`. Returns the
 * resulting row in both cases.
 */
export function upsertBudget(scope: BudgetScope, scopeId: string, dailyBudgetUsd: number): Budget {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET
         daily_budget_usd = excluded.daily_budget_usd,
         lastUpdatedAt = excluded.lastUpdatedAt`,
    )
    .run(scope, scopeId, dailyBudgetUsd, now, now);

  const updated = getBudget(scope, scopeId);
  if (!updated) {
    throw new Error(
      `upsertBudget: row missing after insert for (scope=${scope}, scopeId=${scopeId})`,
    );
  }
  return updated;
}

/**
 * Phase 6: delete a budget row. Returns `true` if a row was deleted, `false`
 * if `(scope, scopeId)` did not exist.
 */
export function deleteBudget(scope: BudgetScope, scopeId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM budgets WHERE scope = ? AND scope_id = ?")
    .run(scope, scopeId);
  return result.changes > 0;
}

// ============================================================================
// Pricing rows (Phase 6 — append-only price book)
// ----------------------------------------------------------------------------
// `pricing` uses INTEGER epoch-ms for `effective_from`, `createdAt`,
// `lastUpdatedAt` (see migration 044). Append-only by design: operators add a
// new row with a later `effective_from` rather than mutating an existing row.
// `getActivePricingRow` resolves the row with the largest
// `effective_from <= atEpochMs`, which is the correct "what price was in
// effect at time T" semantics regardless of insertion order.
// ============================================================================

interface PricingRowDb {
  provider: string;
  model: string;
  token_class: string;
  effective_from: number;
  price_per_million_usd: number;
  createdAt: number;
  lastUpdatedAt: number;
}

function rowToPricingRow(row: PricingRowDb): PricingRow {
  return {
    provider: row.provider as PricingProvider,
    model: row.model,
    tokenClass: row.token_class as PricingTokenClass,
    effectiveFrom: row.effective_from,
    pricePerMillionUsd: row.price_per_million_usd,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

/** Phase 6: list every pricing row, latest-effective first. */
export function getAllPricingRows(): PricingRow[] {
  return getDb()
    .prepare<PricingRowDb, []>(
      "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing ORDER BY provider, model, token_class, effective_from DESC",
    )
    .all()
    .map(rowToPricingRow);
}

/**
 * Phase 6: list every pricing row for a given (provider, model, tokenClass)
 * triple. Order is `effective_from DESC` so newest is first.
 */
export function getPricingRows(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
): PricingRow[] {
  return getDb()
    .prepare<PricingRowDb, [string, string, string]>(
      "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing WHERE provider = ? AND model = ? AND token_class = ? ORDER BY effective_from DESC",
    )
    .all(provider, model, tokenClass)
    .map(rowToPricingRow);
}

/**
 * Phase 6: resolve "what price was in effect at time `atEpochMs`" — the row
 * with the largest `effective_from <= atEpochMs`. Returns null when no row
 * matches (model unseeded for that triple at that time). Backed by the
 * `idx_pricing_lookup` index from migration 044.
 */
export function getActivePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  atEpochMs: number,
): PricingRow | null {
  const row = getDb()
    .prepare<PricingRowDb, [string, string, string, number]>(
      "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing WHERE provider = ? AND model = ? AND token_class = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
    )
    .get(provider, model, tokenClass, atEpochMs);
  return row ? rowToPricingRow(row) : null;
}

export interface InsertPricingRowInput {
  provider: PricingProvider;
  model: string;
  tokenClass: PricingTokenClass;
  effectiveFrom: number;
  pricePerMillionUsd: number;
}

/**
 * Phase 6: insert a new pricing row. Throws on PK collision
 * `(provider, model, token_class, effective_from)` — caller (the HTTP route)
 * translates that into a 409.
 */
export function insertPricingRow(input: InsertPricingRowInput): PricingRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.provider,
      input.model,
      input.tokenClass,
      input.effectiveFrom,
      input.pricePerMillionUsd,
      now,
      now,
    );
  return {
    provider: input.provider,
    model: input.model,
    tokenClass: input.tokenClass,
    effectiveFrom: input.effectiveFrom,
    pricePerMillionUsd: input.pricePerMillionUsd,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

/**
 * Phase 6: delete a pricing row. Returns true if a row was deleted, false if
 * the row did not exist. Discouraged operationally — historical session_costs
 * are not retroactively recomputed — but allowed for typo correction.
 */
export function deletePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  effectiveFrom: number,
): boolean {
  const result = getDb()
    .prepare(
      "DELETE FROM pricing WHERE provider = ? AND model = ? AND token_class = ? AND effective_from = ?",
    )
    .run(provider, model, tokenClass, effectiveFrom);
  return result.changes > 0;
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows for a given agent on a
 * given UTC calendar day. `dateUtc` MUST be `'YYYY-MM-DD'` (UTC). Returns 0
 * when no rows exist.
 *
 * Implementation note: we filter on `substr(createdAt, 1, 10) = ?` rather than
 * `date(createdAt / 1000, 'unixepoch') = ?` because `session_costs.createdAt`
 * is TEXT in ISO 8601 format (`'YYYY-MM-DDTHH:MM:SS.SSSZ'`), populated via
 * `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. The left-anchored `substr` prefix
 * also lets the SQLite optimizer use the existing
 * `idx_session_costs_agent_createdAt` index (verified via EXPLAIN QUERY PLAN
 * in the test suite).
 */
export function getDailySpendForAgent(agentId: string, dateUtc: string): number {
  const row = getDb()
    .prepare<CoalesceSumRow, [string, string]>(
      "SELECT COALESCE(SUM(totalCostUsd), 0) as total FROM session_costs WHERE agentId = ? AND substr(createdAt, 1, 10) = ?",
    )
    .get(agentId, dateUtc);
  return row?.total ?? 0;
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows for a given UTC
 * calendar day, regardless of agent. `dateUtc` MUST be `'YYYY-MM-DD'` (UTC).
 *
 * NOTE: this query has no `agentId` prefix and therefore does not naturally
 * match the `(agentId, createdAt)` composite index. SQLite's optimizer may
 * pick `idx_session_costs_createdAt` (single-column on `createdAt`) — but
 * because the predicate is `substr(createdAt, 1, 10) = ?` rather than a range
 * scan, the planner often falls back to a full table scan. That is acceptable
 * for V1 daily-spend volumes; if it ever becomes a hotspot, a covering
 * functional index on `substr(createdAt, 1, 10)` would be the fix.
 */
export function getDailySpendGlobal(dateUtc: string): number {
  const row = getDb()
    .prepare<CoalesceSumRow, [string]>(
      "SELECT COALESCE(SUM(totalCostUsd), 0) as total FROM session_costs WHERE substr(createdAt, 1, 10) = ?",
    )
    .get(dateUtc);
  return row?.total ?? 0;
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows whose task was
 * requested by a given user on a given UTC calendar day. `dateUtc` MUST be
 * `'YYYY-MM-DD'` (UTC). Costs are joined through `agent_tasks` deliberately;
 * `session_costs` stays task/session-scoped and does not grow a userId column.
 */
export function getDailySpendForUser(userId: string, dateUtc: string): number {
  const row = getDb()
    .prepare<CoalesceSumRow, [string, string]>(
      `SELECT COALESCE(SUM(sc.totalCostUsd), 0) AS total
       FROM session_costs sc
       JOIN agent_tasks t ON sc.taskId = t.id
       WHERE t.requestedByUserId = ? AND substr(sc.createdAt, 1, 10) = ?`,
    )
    .get(userId, dateUtc);
  return row?.total ?? 0;
}

export interface RecordBudgetRefusalNotificationInput {
  taskId: string;
  date: string;
  agentId: string;
  cause: BudgetRefusalCause;
  agentSpendUsd?: number;
  agentBudgetUsd?: number;
  globalSpendUsd?: number;
  globalBudgetUsd?: number;
  userSpendUsd?: number;
  userBudgetUsd?: number;
}

/**
 * Idempotent insert of a budget-refusal notification keyed by
 * `(task_id, date)`. Returns `{ inserted: true, row }` on first call for that
 * key, or `{ inserted: false, row }` (with the original row) on subsequent
 * calls — used by the notification path to dedup "the agent told me about
 * this task already" across retries within the same UTC day.
 */
export function recordBudgetRefusalNotification(input: RecordBudgetRefusalNotificationInput): {
  inserted: boolean;
  row: BudgetRefusalNotification;
} {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO budget_refusal_notifications
       (task_id, date, agent_id, cause, agent_spend_usd, agent_budget_usd, global_spend_usd, global_budget_usd, user_spend_usd, user_budget_usd, follow_up_task_id, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      input.taskId,
      input.date,
      input.agentId,
      input.cause,
      input.agentSpendUsd ?? null,
      input.agentBudgetUsd ?? null,
      input.globalSpendUsd ?? null,
      input.globalBudgetUsd ?? null,
      input.userSpendUsd ?? null,
      input.userBudgetUsd ?? null,
      now,
    );

  const existing = db
    .prepare<BudgetRefusalNotificationRow, [string, string]>(
      "SELECT * FROM budget_refusal_notifications WHERE task_id = ? AND date = ?",
    )
    .get(input.taskId, input.date);

  if (!existing) {
    // Should be unreachable: INSERT OR IGNORE either inserts or leaves an
    // existing row. If we hit this it's a hard schema/runtime invariant break.
    throw new Error(
      `recordBudgetRefusalNotification: row missing after insert for (taskId=${input.taskId}, date=${input.date})`,
    );
  }

  return {
    inserted: result.changes > 0,
    row: rowToBudgetRefusalNotification(existing),
  };
}

/**
 * Lookup helper used by tests and by the Phase 5 follow-up-task write-back.
 */
export function getBudgetRefusalNotification(
  taskId: string,
  date: string,
): BudgetRefusalNotification | null {
  const row = getDb()
    .prepare<BudgetRefusalNotificationRow, [string, string]>(
      "SELECT * FROM budget_refusal_notifications WHERE task_id = ? AND date = ?",
    )
    .get(taskId, date);
  return row ? rowToBudgetRefusalNotification(row) : null;
}

/**
 * List recent budget refusal notifications across all tasks/dates, newest
 * first. Used by the operator dashboard to surface refusals as an
 * actionable feed (parent task → follow-up task link).
 */
export function getRecentBudgetRefusalNotifications(limit = 50): BudgetRefusalNotification[] {
  const rows = getDb()
    .prepare<BudgetRefusalNotificationRow, [number]>(
      "SELECT * FROM budget_refusal_notifications ORDER BY createdAt DESC LIMIT ?",
    )
    .all(limit);
  return rows.map(rowToBudgetRefusalNotification);
}

/**
 * Boolean observability helper — returns true iff a refusal notification has
 * already been recorded for `(taskId, date)`.
 */
export function hasBudgetRefusalNotificationToday(taskId: string, date: string): boolean {
  const row = getDb()
    .prepare<{ one: number }, [string, string]>(
      "SELECT 1 as one FROM budget_refusal_notifications WHERE task_id = ? AND date = ? LIMIT 1",
    )
    .get(taskId, date);
  return row !== null;
}

/**
 * Phase 5 write-back: link the freshly-created lead-facing follow-up task
 * back to its dedup row so operators can audit "find the lead-facing
 * follow-up that was created when this task was first refused".
 *
 * Idempotent — safe to call multiple times with the same `(taskId, date)`,
 * but only the first refusal per day creates a follow-up task in the first
 * place (see `recordBudgetRefusalNotification` for the dedup invariant).
 */
export function setBudgetRefusalFollowUpTaskId(
  taskId: string,
  date: string,
  followUpTaskId: string,
): void {
  getDb()
    .prepare(
      "UPDATE budget_refusal_notifications SET follow_up_task_id = ? WHERE task_id = ? AND date = ?",
    )
    .run(followUpTaskId, taskId, date);
}

// ============================================================================
// /status helpers — instance activity + first-task milestone
// ============================================================================

/**
 * Count agents that have heartbeated within the last `minutes` minutes,
 * grouped by lead/worker. Used by the `workers` setup milestone on
 * `GET /status` to flip from `configured` → `verified` only when both a lead
 * and at least one worker are alive.
 *
 * "Recent" defaults to 5 minutes — a multiple of `ACTIVITY_THROTTLE_MS = 5_000`
 * (`src/providers/swarm-events-shared.ts:48-49`) plus margin for missed
 * heartbeats. Agents with `status = 'offline'` are excluded.
 */
export function getLiveAgentCounts(minutes: number = 5): {
  leads_alive: number;
  workers_alive: number;
} {
  const row = getDb()
    .prepare<{ leads_alive: number | null; workers_alive: number | null }, [number]>(
      `SELECT
         SUM(CASE WHEN isLead = 1 THEN 1 ELSE 0 END) AS leads_alive,
         SUM(CASE WHEN isLead = 0 THEN 1 ELSE 0 END) AS workers_alive
       FROM agents
       WHERE lastActivityAt IS NOT NULL
         AND lastActivityAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' minutes')
         AND status != 'offline'`,
    )
    .get(minutes);
  return {
    leads_alive: row?.leads_alive ?? 0,
    workers_alive: row?.workers_alive ?? 0,
  };
}

/**
 * Aggregate activity numbers for `GET /status`'s `activity` block.
 * - `agents_online` / `leads_online`: heartbeated within the last 5 minutes.
 * - `recent_tasks_count`: agent_tasks rows created in the last 24 hours.
 *
 * `agents_online` reports total alive agents (leads + workers) so the home
 * page can show a single "online" stat without summing on the client.
 */
export function getInstanceActivity(): {
  agents_online: number;
  leads_online: number;
  recent_tasks_count: number;
} {
  const { leads_alive, workers_alive } = getLiveAgentCounts(5);
  const tasksRow = getDb()
    .prepare<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM agent_tasks
       WHERE createdAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`,
    )
    .get();
  return {
    agents_online: leads_alive + workers_alive,
    leads_online: leads_alive,
    recent_tasks_count: tasksRow?.count ?? 0,
  };
}

export interface SwarmMetrics {
  tasks: { total: number; by_status: Record<string, number> };
  agents: { total: number; by_status: Record<string, number> };
  workflows: { total: number; enabled: number };
  pages: { total: number };
  sessions: { active: number };
  skills: { total: number };
}

/**
 * Lightweight swarm-wide counts for UI footers/sidebars and MCP context —
 * a single object so callers never have to fetch full list payloads just to
 * count. Pure `COUNT(*)` / `GROUP BY` queries; the `agent_tasks` status
 * grouping rides the indexes added in migration 069.
 */
export function getSwarmMetrics(): SwarmMetrics {
  const db = getDb();

  const groupCounts = (table: string): { total: number; by_status: Record<string, number> } => {
    const rows = db
      .prepare<{ status: string; count: number }, []>(
        `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`,
      )
      .all();
    const by_status: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      by_status[r.status] = r.count;
      total += r.count;
    }
    return { total, by_status };
  };

  const workflowRow = db
    .prepare<{ total: number; enabled: number }, []>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM workflows",
    )
    .get();
  const pagesRow = db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM pages").get();
  const sessionsRow = db
    .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM active_sessions")
    .get();
  const skillsRow = db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM skills").get();

  return {
    tasks: groupCounts("agent_tasks"),
    agents: groupCounts("agents"),
    workflows: { total: workflowRow?.total ?? 0, enabled: workflowRow?.enabled ?? 0 },
    pages: { total: pagesRow?.count ?? 0 },
    sessions: { active: sessionsRow?.count ?? 0 },
    skills: { total: skillsRow?.count ?? 0 },
  };
}

/**
 * `first_task` milestone: true once any task has reached `status = 'completed'`.
 * Cheap LIMIT 1 probe; the row's contents don't matter, only existence.
 */
export function hasFirstCompletedTask(): boolean {
  const row = getDb()
    .prepare<{ one: number }, []>(
      `SELECT 1 AS one FROM agent_tasks WHERE status = 'completed' LIMIT 1`,
    )
    .get();
  return row !== null;
}

// ============================================================================
// KV store (kv_entries)
// ============================================================================
//
// Namespaced key/value with lazy expire-on-read TTL. See:
//   - src/be/migrations/061_kv_store.sql (schema)
//   - src/http/kv.ts                     (REST surface + namespace resolution)
//   - src/tools/kv/*                     (MCP surface)
//
// Conventions:
//   - All sizing / regex validation happens at the HTTP / MCP boundary so the
//     helpers below can assume well-formed inputs.
//   - `value` is stored verbatim in TEXT; helpers decode based on value_type.
//   - "now" is `unixepoch('subsec') * 1000` (unix-ms), consistent with the
//     migration's DEFAULTs — using JS `Date.now()` for the few helpers that
//     need to mention an explicit timestamp keeps the math identical at ms
//     resolution.

interface KvRow {
  namespace: string;
  key: string;
  value: string;
  value_type: KvValueType;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function decodeKvRow(row: KvRow): KvEntry {
  let value: unknown;
  if (row.value_type === "json") {
    try {
      value = JSON.parse(row.value);
    } catch {
      // Stored JSON is corrupt — surface as raw string rather than throwing
      // on read; the row is still recoverable by the caller.
      value = row.value;
    }
  } else if (row.value_type === "integer") {
    value = Number(row.value);
  } else {
    value = row.value;
  }
  return {
    namespace: row.namespace,
    key: row.key,
    value,
    valueType: row.value_type,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeKvValue(value: unknown, valueType: KvValueType): string {
  if (valueType === "json") {
    return JSON.stringify(value);
  }
  if (valueType === "integer") {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
        throw new Error("integer value must be a JS-safe integer");
      }
      return String(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return value;
    }
    throw new Error("integer value must be a JS-safe integer");
  }
  // 'string'
  if (typeof value !== "string") {
    throw new Error("string value must be a string");
  }
  return value;
}

/**
 * Get a single KV entry. Returns null if missing OR expired; expired rows are
 * deleted inline (single-row DELETE WHERE) so the row count stays bounded over
 * time without a background sweeper.
 */
export function getKv(namespace: string, key: string): KvEntry | null {
  const row = getDb()
    .prepare<KvRow, [string, string]>(
      `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
         FROM kv_entries WHERE namespace = ? AND key = ?`,
    )
    .get(namespace, key);
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    getDb()
      .prepare<unknown, [string, string]>(`DELETE FROM kv_entries WHERE namespace = ? AND key = ?`)
      .run(namespace, key);
    return null;
  }
  return decodeKvRow(row);
}

/**
 * Upsert a KV entry. Caller passes the decoded value + valueType; we encode
 * before storing. `expiresAt` is unix-ms (NULL means no expiry).
 *
 * If the key already exists with a different `valueType` we still overwrite —
 * INCR is the only collision-sensitive op and it does its own check.
 */
export function upsertKv(input: {
  namespace: string;
  key: string;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): KvEntry {
  const encoded = encodeKvValue(input.value, input.valueType);
  const expiresAt = input.expiresAt ?? null;
  const now = Date.now();
  const row = getDb()
    .prepare<KvRow, [string, string, string, KvValueType, number | null, number, number]>(
      `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         value_type = excluded.value_type,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
    )
    .get(input.namespace, input.key, encoded, input.valueType, expiresAt, now, now);
  if (!row) throw new Error("Failed to upsert kv entry");
  return decodeKvRow(row);
}

/**
 * Delete a KV entry. Returns true if a row was removed, false if nothing
 * existed. Does not differentiate expired-but-not-yet-swept from never-existed.
 */
export function deleteKv(namespace: string, key: string): boolean {
  const result = getDb()
    .prepare<unknown, [string, string]>(`DELETE FROM kv_entries WHERE namespace = ? AND key = ?`)
    .run(namespace, key);
  return result.changes > 0;
}

export class KvTypeCollisionError extends Error {
  readonly existingType: KvValueType;
  constructor(existingType: KvValueType) {
    super(`Cannot INCR a key with value_type '${existingType}'`);
    this.name = "KvTypeCollisionError";
    this.existingType = existingType;
  }
}

/**
 * Atomically increment an integer KV entry. Creates the entry (set to `by`)
 * if it doesn't exist or has expired. Throws `KvTypeCollisionError` if the
 * existing row's `value_type` is not 'integer' — the HTTP layer maps that to
 * 409.
 */
export function incrKv(namespace: string, key: string, by: number): KvEntry {
  if (!Number.isInteger(by) || !Number.isSafeInteger(by)) {
    throw new Error("INCR `by` must be a JS-safe integer");
  }
  const database = getDb();
  return database.transaction((): KvEntry => {
    const existing = database
      .prepare<KvRow, [string, string]>(
        `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
           FROM kv_entries WHERE namespace = ? AND key = ?`,
      )
      .get(namespace, key);

    const now = Date.now();
    const expired =
      existing?.expires_at !== null &&
      existing !== null &&
      existing.expires_at !== null &&
      existing.expires_at <= now;

    if (!existing || expired) {
      // Insert (or replace if expired). `upsertKv` re-enters the prepared
      // statement cache cheaply; inlining keeps this in one transaction.
      const row = database
        .prepare<KvRow, [string, string, string, number | null, number, number]>(
          `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, 'integer', ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             value_type = excluded.value_type,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at
           RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
        )
        .get(namespace, key, String(by), null, now, now);
      if (!row) throw new Error("Failed to insert kv entry on INCR");
      return decodeKvRow(row);
    }

    if (existing.value_type !== "integer") {
      throw new KvTypeCollisionError(existing.value_type);
    }

    const current = Number(existing.value);
    if (!Number.isSafeInteger(current)) {
      throw new Error("Stored integer KV value is not a JS-safe integer");
    }
    const next = current + by;
    if (!Number.isSafeInteger(next)) {
      throw new Error("INCR would overflow JS-safe integer range");
    }

    const row = database
      .prepare<KvRow, [string, number, string, string]>(
        `UPDATE kv_entries SET value = ?, updated_at = ?
           WHERE namespace = ? AND key = ?
         RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
      )
      .get(String(next), now, namespace, key);
    if (!row) throw new Error("Failed to update kv entry on INCR");
    return decodeKvRow(row);
  })();
}

/**
 * List entries in a namespace, optionally filtered by prefix. Expired rows
 * are filtered out by the SELECT (no inline DELETE — listing should be a
 * stable cursor; sweeping happens on point-reads instead).
 *
 * `limit` is capped by the caller (HTTP enforces ≤1000); helper does no extra
 * bounds-check beyond what SQL accepts.
 */
export function listKv(
  namespace: string,
  opts: { prefix?: string; limit: number; offset: number },
): KvEntry[] {
  const now = Date.now();
  if (opts.prefix !== undefined && opts.prefix.length > 0) {
    // LIKE-escape `\` `%` `_` so a user-supplied prefix can't run wildcards.
    const escaped = opts.prefix.replace(/[\\%_]/g, "\\$&");
    const rows = getDb()
      .prepare<KvRow, [string, number, string, number, number]>(
        `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
           FROM kv_entries
          WHERE namespace = ?
            AND (expires_at IS NULL OR expires_at > ?)
            AND key LIKE ? ESCAPE '\\'
          ORDER BY key
          LIMIT ? OFFSET ?`,
      )
      .all(namespace, now, `${escaped}%`, opts.limit, opts.offset);
    return rows.map(decodeKvRow);
  }
  const rows = getDb()
    .prepare<KvRow, [string, number, number, number]>(
      `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
         FROM kv_entries
        WHERE namespace = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY key
        LIMIT ? OFFSET ?`,
    )
    .all(namespace, now, opts.limit, opts.offset);
  return rows.map(decodeKvRow);
}

/**
 * Count entries in a namespace (optionally with a prefix filter). Expired
 * rows are excluded — same predicate as `listKv`.
 */
export function countKv(namespace: string, opts: { prefix?: string }): number {
  const now = Date.now();
  if (opts.prefix !== undefined && opts.prefix.length > 0) {
    const escaped = opts.prefix.replace(/[\\%_]/g, "\\$&");
    const row = getDb()
      .prepare<{ n: number }, [string, number, string]>(
        `SELECT COUNT(*) AS n FROM kv_entries
          WHERE namespace = ?
            AND (expires_at IS NULL OR expires_at > ?)
            AND key LIKE ? ESCAPE '\\'`,
      )
      .get(namespace, now, `${escaped}%`);
    return row?.n ?? 0;
  }
  const row = getDb()
    .prepare<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM kv_entries
        WHERE namespace = ?
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(namespace, now);
  return row?.n ?? 0;
}

// ─── Script Runs ────────────────────────────────────────────────────────────

type ScriptRunRow = {
  id: string;
  agentId: string;
  scriptName: string | null;
  source: string;
  args: string;
  kind: string;
  status: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  error: string | null;
  last_heartbeat_at: string | null;
  idempotencyKey: string | null;
  requestedByUserId: string | null;
  created_by: string | null;
  updated_by: string | null;
};

type ScriptRunListRow = Pick<
  ScriptRunRow,
  | "id"
  | "agentId"
  | "scriptName"
  | "kind"
  | "status"
  | "pid"
  | "startedAt"
  | "finishedAt"
  | "error"
  | "last_heartbeat_at"
  | "idempotencyKey"
  | "requestedByUserId"
>;

function parseJsonColumn(value: string | null): unknown | undefined {
  if (value === null) return undefined;
  return JSON.parse(value);
}

function rowToScriptRun(row: ScriptRunRow): ScriptRun {
  return {
    id: row.id,
    agentId: row.agentId,
    scriptName: row.scriptName ?? undefined,
    source: row.source,
    args: JSON.parse(row.args),
    kind: row.kind as ScriptRunKind,
    status: row.status as ScriptRunStatus,
    pid: row.pid ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    output: parseJsonColumn(row.output),
    error: row.error ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
  };
}

function rowToScriptRunListItem(row: ScriptRunListRow): ScriptRunListItem {
  return {
    id: row.id,
    agentId: row.agentId,
    scriptName: row.scriptName ?? undefined,
    kind: row.kind as ScriptRunKind,
    status: row.status as ScriptRunStatus,
    pid: row.pid ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    error: row.error ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
  };
}

export function createScriptRun(data: {
  id: string;
  agentId: string;
  source: string;
  args: unknown;
  scriptName?: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
  createdBy?: string;
  updatedBy?: string;
}): { run: ScriptRun; existing: boolean } {
  const db = getDb();
  if (data.idempotencyKey) {
    const existing = db
      .prepare<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE idempotencyKey = ?")
      .get(data.idempotencyKey);
    if (existing) return { run: rowToScriptRun(existing), existing: true };
  }

  const row = db
    .prepare<
      ScriptRunRow,
      [
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO script_runs
        (id, agentId, scriptName, source, args, idempotencyKey, requestedByUserId, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      data.id,
      data.agentId,
      data.scriptName ?? null,
      data.source,
      JSON.stringify(data.args ?? null),
      data.idempotencyKey ?? null,
      data.requestedByUserId ?? null,
      data.createdBy ?? null,
      data.updatedBy ?? data.createdBy ?? null,
    );
  if (!row) throw new Error("Failed to create script run");
  return { run: rowToScriptRun(row), existing: false };
}

// Persist a synchronous inline run (POST /api/scripts/run) as an already-terminal
// row. Unlike createScriptRun these never get a journal and never use the
// idempotencyKey column (inline idempotency lives in the kv table).
export function recordInlineScriptRun(data: {
  id: string;
  agentId: string;
  source: string;
  args: unknown;
  scriptName?: string;
  status: "completed" | "failed";
  output?: unknown;
  error?: string;
  startedAt: string;
  finishedAt: string;
  requestedByUserId?: string;
  createdBy?: string;
  /** Set when this run originated from an external API endpoint (POST /api/x/script/<id>). */
  apiEndpointId?: string | null;
}): ScriptRun {
  const row = getDb()
    .prepare<
      ScriptRunRow,
      [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO script_runs
        (id, agentId, scriptName, source, args, kind, status, output, error,
         startedAt, finishedAt, requestedByUserId, created_by, updated_by, apiEndpointId)
       VALUES (?, ?, ?, ?, ?, 'inline', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      data.id,
      data.agentId,
      data.scriptName ?? null,
      data.source,
      JSON.stringify(data.args ?? null),
      data.status,
      data.output === undefined ? null : JSON.stringify(data.output),
      data.error ?? null,
      data.startedAt,
      data.finishedAt,
      data.requestedByUserId ?? null,
      data.createdBy ?? null,
      data.createdBy ?? null,
      data.apiEndpointId ?? null,
    );
  if (!row) throw new Error("Failed to record inline script run");
  return rowToScriptRun(row);
}

export function getScriptRun(id: string): ScriptRun | null {
  const row = getDb()
    .prepare<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?")
    .get(id);
  return row ? rowToScriptRun(row) : null;
}

export function getScriptRunByIdempotencyKey(idempotencyKey: string): ScriptRun | null {
  const row = getDb()
    .prepare<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE idempotencyKey = ?")
    .get(idempotencyKey);
  return row ? rowToScriptRun(row) : null;
}

export function listScriptRuns(opts?: {
  status?: ScriptRunStatus;
  agentId?: string;
  scriptName?: string;
  limit?: number;
  offset?: number;
}): ScriptRunListItem[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }
  if (opts?.scriptName) {
    conditions.push("scriptName = ?");
    params.push(opts.scriptName);
  }

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  params.push(limit, offset);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare<ScriptRunListRow, Array<string | number>>(
      `SELECT
        id,
        agentId,
        scriptName,
        kind,
        status,
        pid,
        startedAt,
        finishedAt,
        error,
        last_heartbeat_at,
        idempotencyKey,
        requestedByUserId
       FROM script_runs ${where}
       ORDER BY startedAt DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params);
  return rows.map(rowToScriptRunListItem);
}

export function countScriptRuns(opts?: {
  status?: ScriptRunStatus;
  agentId?: string;
  scriptName?: string;
}): number {
  const conditions: string[] = [];
  const params: string[] = [];
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.agentId) {
    conditions.push("agentId = ?");
    params.push(opts.agentId);
  }
  if (opts?.scriptName) {
    conditions.push("scriptName = ?");
    params.push(opts.scriptName);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = getDb()
    .prepare<{ count: number }, string[]>(`SELECT COUNT(*) AS count FROM script_runs ${where}`)
    .get(...params);
  return row?.count ?? 0;
}

export function countActiveScriptRuns(): number {
  const row = getDb()
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM script_runs WHERE status IN ('running', 'paused')",
    )
    .get();
  return row?.count ?? 0;
}

export function updateScriptRun(
  id: string,
  patch: Partial<{
    status: ScriptRunStatus;
    pid: number | null;
    finishedAt: string | null;
    output: unknown;
    error: string | null;
    lastHeartbeatAt: string | null;
    updatedBy: string | null;
  }>,
): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.pid !== undefined) {
    sets.push("pid = ?");
    vals.push(patch.pid);
  }
  if (patch.finishedAt !== undefined) {
    sets.push("finishedAt = ?");
    vals.push(patch.finishedAt);
  }
  if ("output" in patch) {
    sets.push("output = ?");
    vals.push(patch.output === undefined ? null : JSON.stringify(patch.output));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  if (patch.lastHeartbeatAt !== undefined) {
    sets.push("last_heartbeat_at = ?");
    vals.push(patch.lastHeartbeatAt);
  }
  if (patch.updatedBy !== undefined) {
    sets.push("updated_by = ?");
    vals.push(patch.updatedBy);
  }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().run(`UPDATE script_runs SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export function getRunningScriptRuns(): ScriptRun[] {
  const rows = getDb()
    .prepare<ScriptRunRow, []>("SELECT * FROM script_runs WHERE status IN ('running', 'paused')")
    .all();
  return rows.map(rowToScriptRun);
}

// ─── Script Run Journal ─────────────────────────────────────────────────────

type ScriptRunJournalRow = {
  id: string;
  runId: string;
  stepKey: string;
  stepType: string;
  config: string;
  status: string;
  result: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  created_by: string | null;
  updated_by: string | null;
};

function rowToScriptRunJournalEntry(row: ScriptRunJournalRow): ScriptRunJournalEntry {
  return {
    id: row.id,
    runId: row.runId,
    stepKey: row.stepKey,
    stepType: row.stepType,
    config: JSON.parse(row.config),
    status: row.status as "completed" | "failed",
    result: parseJsonColumn(row.result),
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
  };
}

export function getScriptRunJournalStep(
  runId: string,
  stepKey: string,
): ScriptRunJournalEntry | null {
  const row = getDb()
    .prepare<ScriptRunJournalRow, [string, string]>(
      "SELECT * FROM script_run_journal WHERE runId = ? AND stepKey = ?",
    )
    .get(runId, stepKey);
  return row ? rowToScriptRunJournalEntry(row) : null;
}

export function upsertScriptRunJournalStep(data: {
  runId: string;
  stepKey: string;
  stepType: string;
  config: unknown;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  durationMs?: number;
}): void {
  getDb().run(
    `INSERT OR IGNORE INTO script_run_journal
      (id, runId, stepKey, stepType, config, status, result, error, durationMs, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      crypto.randomUUID(),
      data.runId,
      data.stepKey,
      data.stepType,
      JSON.stringify(data.config ?? {}),
      data.status,
      data.result !== undefined ? JSON.stringify(data.result) : null,
      data.error ?? null,
      data.durationMs ?? null,
    ],
  );
}

export function listScriptRunJournalSteps(runId: string): ScriptRunJournalEntry[] {
  const rows = getDb()
    .prepare<ScriptRunJournalRow, [string]>(
      "SELECT * FROM script_run_journal WHERE runId = ? ORDER BY startedAt ASC",
    )
    .all(runId);
  return rows.map(rowToScriptRunJournalEntry);
}

export function countScriptRunJournalSteps(runId: string): number {
  const row = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM script_run_journal WHERE runId = ?",
    )
    .get(runId);
  return row?.count ?? 0;
}

export function countScriptRunJournalAgentTaskSteps(runId: string): number {
  const row = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM script_run_journal WHERE runId = ? AND stepType = 'agent-task'",
    )
    .get(runId);
  return row?.count ?? 0;
}
