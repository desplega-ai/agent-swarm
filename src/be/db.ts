import { Database } from "bun:sqlite";
import { parseProviderMeta } from "@/utils/provider-metadata.ts";
import pkg from "../../package.json";
import { addEyesReactionOnTaskStart } from "../github/task-reactions";
import { configureDbResolver } from "../prompts/resolver";
import type {
  ActiveSession,
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentMcpServer,
  AgentSkill,
  AgentStatus,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentWithTasks,
  ChangeSource,
  Channel,
  ChannelMessage,
  ChannelType,
  ContextSnapshot,
  ContextSnapshotEventType,
  ContextVersion,
  CooldownConfig,
  DevinProviderMeta,
  InboxMessage,
  InboxMessageStatus,
  InputValue,
  McpServer,
  McpServerScope,
  McpServerTransport,
  McpServerWithInstallInfo,
  PromptTemplate,
  PromptTemplateHistory,
  ProviderName,
  RepoGuidelines,
  ScheduledTask,
  Service,
  ServiceStatus,
  SessionCost,
  SessionLog,
  Skill,
  SkillScope,
  SkillType,
  SkillWithInstallInfo,
  SwarmConfig,
  SwarmRepo,
  TriggerConfig,
  User,
  VersionableField,
  VersionMeta,
  Workflow,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunStep,
  WorkflowRunStepStatus,
  WorkflowSnapshot,
  WorkflowVersion,
} from "../types";
import { deriveProviderFromKeyType } from "../utils/credentials";
import { scrubSecrets } from "../utils/secret-scrubber";
import { decryptSecret, encryptSecret, getEncryptionKey, resolveEncryptionKey } from "./crypto";
import { normalizeDate, normalizeDateRequired } from "./date-utils";
import { runMigrations } from "./migrations/runner";
import { seedDefaultTemplates } from "./seed";
import { isReservedConfigKey, reservedKeyError } from "./swarm-config-guard";

let db: Database | null = null;
let sqliteVecAvailable = false;

export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
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

  // Load sqlite-vec extension for vector search.
  // In compiled binaries (`bun build --compile`) the JS lives in /$bunfs/ and
  // `require.resolve("sqlite-vec-<platform>/vec0.so")` can't find the native
  // asset — so we prefer an explicit filesystem path when set, and only fall
  // back to the npm resolver for normal dev runs.
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

function computeContentHash(content: string): string {
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
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    isLead: row.isLead === 1,
    status: row.status,
    description: row.description ?? undefined,
    role: row.role ?? undefined,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    maxTasks: row.maxTasks ?? 1,
    emptyPollCount: row.emptyPollCount ?? 0,
    claudeMd: row.claudeMd ?? undefined,
    soulMd: row.soulMd ?? undefined,
    identityMd: row.identityMd ?? undefined,
    setupScript: row.setupScript ?? undefined,
    toolsMd: row.toolsMd ?? undefined,
    heartbeatMd: row.heartbeatMd ?? undefined,
    lastActivityAt: row.lastActivityAt ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export const agentQueries = {
  insert: () =>
    getDb().prepare<AgentRow, [string, string, number, AgentStatus, number]>(
      "INSERT INTO agents (id, name, isLead, status, maxTasks, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
    ),

  getById: () => getDb().prepare<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?"),

  getAll: () => getDb().prepare<AgentRow, []>("SELECT * FROM agents ORDER BY name"),

  updateStatus: () =>
    getDb().prepare<AgentRow, [AgentStatus, string]>(
      "UPDATE agents SET status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    ),

  delete: () => getDb().prepare<null, [string]>("DELETE FROM agents WHERE id = ?"),
};

export function createAgent(
  agent: Omit<Agent, "id" | "createdAt" | "lastUpdatedAt"> & { id?: string },
): Agent {
  const id = agent.id ?? crypto.randomUUID();
  const maxTasks = agent.maxTasks ?? 1;
  const row = agentQueries
    .insert()
    .get(id, agent.name, agent.isLead ? 1 : 0, agent.status, maxTasks);
  if (!row) throw new Error("Failed to create agent");
  try {
    createLogEntry({ eventType: "agent_joined", agentId: id, newValue: agent.status });
  } catch {}
  return rowToAgent(row);
}

export function getAgentById(id: string): Agent | null {
  const row = agentQueries.getById().get(id);
  return row ? rowToAgent(row) : null;
}

export function getAllAgents(): Agent[] {
  return agentQueries.getAll().all().map(rowToAgent);
}

export function getLeadAgent(): Agent | null {
  const agents = getAllAgents();
  return agents.find((a) => a.isLead) ?? null;
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
  scheduleId: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  outputSchema: string | null;
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
  totalContextTokensUsed: number | null;
  contextWindowSize: number | null;
  was_paused: number;
  credentialKeySuffix: string | null;
  credentialKeyType: string | null;
  requestedByUserId: string | null;
  swarmVersion: string | null;
  provider: string | null;
  providerMeta: string | null;
};

function rowToAgentTask(row: AgentTaskRow): AgentTask {
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
    model: (row.model as "haiku" | "sonnet" | "opus" | null) ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    workflowRunId: row.workflowRunId ?? undefined,
    workflowRunStepId: row.workflowRunStepId ?? undefined,
    outputSchema: row.outputSchema ? JSON.parse(row.outputSchema) : undefined,
    contextKey: row.contextKey ?? undefined,
    compactionCount: row.compactionCount ?? undefined,
    peakContextPercent: row.peakContextPercent ?? undefined,
    totalContextTokensUsed: row.totalContextTokensUsed ?? undefined,
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
       status = CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN status ELSE 'in_progress' END,
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

export function startTask(taskId: string): AgentTask | null {
  const oldTask = getTaskById(taskId);
  if (!oldTask) return null;

  // Guard: never revive tasks that are already in a terminal state
  if (["completed", "failed", "cancelled"].includes(oldTask.status)) {
    return null;
  }

  const row = getDb()
    .prepare<AgentTaskRow, [string]>(
      `UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled') RETURNING *`,
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
  // Fire-and-forget: add eyes reaction for GitHub-sourced tasks
  if (result && oldTask.status !== "in_progress") {
    addEyesReactionOnTaskStart(result).catch(() => {});
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

export function getChildTasks(parentTaskId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks WHERE parentTaskId = ? ORDER BY createdAt ASC`,
    )
    .all(parentTaskId)
    .map(rowToAgentTask);
}

export function updateTaskClaudeSessionId(
  taskId: string,
  claudeSessionId: string,
  provider?: ProviderName,
  providerMeta?: Record<string, unknown>,
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
 * Returns the most recent non-completed/failed task for this VCS entity.
 */
export function findTaskByVcs(vcsRepo: string, vcsNumber: number): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, number]>(
      `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ?
       AND status NOT IN ('completed', 'failed')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(vcsRepo, vcsNumber);
  return row ? rowToAgentTask(row) : null;
}

/** @deprecated Use findTaskByVcs instead */
export const findTaskByGitHub = findTaskByVcs;

export interface TaskFilters {
  status?: AgentTaskStatus;
  agentId?: string;
  search?: string;
  // New filters
  unassigned?: boolean;
  offeredTo?: string;
  readyOnly?: boolean;
  taskType?: string;
  tags?: string[];
  scheduleId?: string;
  limit?: number;
  offset?: number;
  includeHeartbeat?: boolean;
}

export function getAllTasks(filters?: TaskFilters): AgentTask[] {
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("task LIKE ?");
    params.push(`%${filters.search}%`);
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

  // Exclude heartbeat tasks by default
  if (!filters?.includeHeartbeat) {
    conditions.push("(IFNULL(taskType, '') != 'heartbeat' AND tags NOT LIKE '%\"heartbeat\"%')");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 25;
  const offset = filters?.offset ?? 0;
  const query = `SELECT * FROM agent_tasks ${whereClause} ORDER BY lastUpdatedAt DESC, priority DESC LIMIT ${limit} OFFSET ${offset}`;

  let tasks = getDb()
    .prepare<AgentTaskRow, (string | AgentTaskStatus)[]>(query)
    .all(...params)
    .map(rowToAgentTask);

  // Filter for ready tasks (dependencies met) if requested
  if (filters?.readyOnly) {
    tasks = tasks.filter((task) => {
      if (!task.dependsOn || task.dependsOn.length === 0) return true;
      return checkDependencies(task.id).ready;
    });
  }

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
    conditions.push("status = ?");
    params.push(filters.status);
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("task LIKE ?");
    params.push(`%${filters.search}%`);
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

  // Exclude heartbeat tasks by default
  if (!filters?.includeHeartbeat) {
    conditions.push("(IFNULL(taskType, '') != 'heartbeat' AND tags NOT LIKE '%\"heartbeat\"%')");
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

export function completeTask(id: string, output?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  const finishedAt = new Date().toISOString();
  let row = taskQueries.updateStatus().get("completed", finishedAt, id);
  if (!row) return null;

  if (output) {
    row = taskQueries.setOutput().get(output, id);
  }

  if (row && oldTask) {
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
  const finishedAt = new Date().toISOString();
  const row = taskQueries.setFailure().get(reason, finishedAt, id);
  if (row && oldTask) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "failed",
        metadata: { reason },
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
  }
  return row ? rowToAgentTask(row) : null;
}

export function cancelTask(id: string, reason?: string): AgentTask | null {
  const oldTask = getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are not already in a terminal state
  const terminalStatuses = ["completed", "failed", "cancelled"];
  if (terminalStatuses.includes(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  const row = taskQueries.setCancelled().get(cancelReason, finishedAt, id);

  if (row && oldTask) {
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
  }

  return row ? rowToAgentTask(row) : null;
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
       ORDER BY createdAt ASC`,
    )
    .all(agentId);
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
  const row = taskQueries.setProgress().get(progress, id);
  if (row) {
    try {
      createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: progress,
      });
    } catch {}
    try {
      import("../workflows/event-bus").then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.progress", {
          taskId: id,
          progress,
          agentId: row.agentId,
        });
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
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

export function getAllAgentsWithTasks(): AgentWithTasks[] {
  const txn = getDb().transaction(() => {
    const agents = getAllAgents();
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
  const row = logQueries
    .insert()
    .get(
      id,
      entry.eventType,
      entry.agentId ?? null,
      entry.taskId ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  if (!row) throw new Error("Failed to create log entry");
  return rowToAgentLog(row);
}

export function getLogsByAgentId(agentId: string): AgentLog[] {
  return logQueries.getByAgentId().all(agentId).map(rowToAgentLog);
}

export function getLogsByTaskId(taskId: string): AgentLog[] {
  return logQueries.getByTaskId().all(taskId).map(rowToAgentLog);
}

export function getLogsByTaskIdChronological(taskId: string): AgentLog[] {
  return getDb()
    .prepare<AgentLogRow, [string]>(
      "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt ASC",
    )
    .all(taskId)
    .map(rowToAgentLog);
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
  scheduleId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  outputSchema?: Record<string, unknown>;
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

  // Exclude completed/failed/cancelled tasks — only active or recently created
  conditions.push("status NOT IN ('completed', 'failed', 'cancelled')");

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
      if (parent.slackChannelId && !options.slackChannelId) {
        options.slackChannelId = parent.slackChannelId;
      }
      if (parent.slackThreadTs && !options.slackThreadTs) {
        options.slackThreadTs = parent.slackThreadTs;
      }
      if (parent.slackUserId && !options.slackUserId) {
        options.slackUserId = parent.slackUserId;
      }
      if (parent.agentmailInboxId && !options.agentmailInboxId) {
        options.agentmailInboxId = parent.agentmailInboxId;
      }
      if (parent.agentmailThreadId && !options.agentmailThreadId) {
        options.agentmailThreadId = parent.agentmailThreadId;
      }
      if (parent.requestedByUserId && !options.requestedByUserId) {
        options.requestedByUserId = parent.requestedByUserId;
      }
      if (parent.contextKey && !options.contextKey) {
        options.contextKey = parent.contextKey;
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

  const row = getDb()
    .prepare<AgentTaskRow, (string | number | null)[]>(
      `INSERT INTO agent_tasks (
        id, agentId, creatorAgentId, task, status, source,
        taskType, tags, priority, dependsOn, offeredTo, offeredAt,
        slackChannelId, slackThreadTs, slackUserId,
        vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl,
        vcsInstallationId, vcsNodeId,
        agentmailInboxId, agentmailMessageId, agentmailThreadId,
        mentionMessageId, mentionChannelId, dir, parentTaskId, model, scheduleId,
        workflowRunId, workflowRunStepId, outputSchema, requestedByUserId, contextKey, swarmVersion, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      options?.scheduleId ?? null,
      options?.workflowRunId ?? null,
      options?.workflowRunStepId ?? null,
      options?.outputSchema ? JSON.stringify(options.outputSchema) : null,
      options?.requestedByUserId ?? null,
      options?.contextKey ?? null,
      pkg.version,
      now,
      now,
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
  // Fire-and-forget: add eyes reaction for GitHub-sourced tasks
  if (result) {
    addEyesReactionOnTaskStart(result).catch(() => {});
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
      "SELECT * FROM agent_tasks WHERE offeredTo = ? AND status = 'offered' ORDER BY createdAt ASC",
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
      "SELECT id FROM agent_tasks WHERE status = 'unassigned' ORDER BY priority DESC, createdAt ASC LIMIT ?",
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

export function getSessionLogsByTaskId(taskId: string): SessionLog[] {
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
  durationMs: number;
  numTurns: number;
  model: string;
  isError: number;
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
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    model: row.model,
    isError: row.isError === 1,
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
        number,
        number,
        string,
        number,
      ]
    >(
      `INSERT INTO session_costs (id, sessionId, taskId, agentId, totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, numTurns, model, isError, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
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
  durationMs: number;
  numTurns: number;
  model: string;
  isError?: boolean;
}

export function createSessionCost(input: CreateSessionCostInput): SessionCost {
  const id = crypto.randomUUID();
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
      input.durationMs,
      input.numTurns,
      input.model,
      input.isError ? 1 : 0,
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
    durationMs: input.durationMs,
    numTurns: input.numTurns,
    model: input.model,
    isError: input.isError ?? false,
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
  type CostRow = { costToday: number; costMtd: number };
  const row = getDb()
    .prepare<CostRow, []>(
      `SELECT
        COALESCE(SUM(CASE WHEN createdAt >= date('now') THEN totalCostUsd ELSE 0 END), 0) as costToday,
        COALESCE(SUM(totalCostUsd), 0) as costMtd
      FROM session_costs
      WHERE createdAt >= date('now', 'start of month')`,
    )
    .get();

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
  scheduleType: string;
  createdAt: string;
  lastUpdatedAt: string;
};

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
    model: (row.model as "haiku" | "sonnet" | "opus" | null) ?? undefined,
    scheduleType: row.scheduleType as "recurring" | "one_time",
    createdAt: normalizeDateRequired(row.createdAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
  };
}

export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
  scheduleType?: "recurring" | "one_time";
  hideCompleted?: boolean;
}

export function getScheduledTasks(filters?: ScheduledTaskFilters): ScheduledTask[] {
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

  return getDb()
    .prepare<ScheduledTaskRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToScheduledTask);
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
  scheduleType?: "recurring" | "one_time";
}

export function createScheduledTask(data: CreateScheduledTaskData): ScheduledTask {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<ScheduledTaskRow, (string | number | null)[]>(
      `INSERT INTO scheduled_tasks (
        id, name, description, cronExpression, intervalMs, taskTemplate,
        taskType, tags, priority, targetAgentId, enabled, nextRunAt,
        createdByAgentId, timezone, model, scheduleType, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      data.scheduleType ?? "recurring",
      now,
      now,
    );

  if (!row) throw new Error("Failed to create scheduled task");
  return rowToScheduledTask(row);
}

export interface UpdateScheduledTaskData {
  name?: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
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
  scheduleType?: "recurring" | "one_time";
  lastUpdatedAt?: string;
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
  if (data.scheduleType !== undefined) {
    updates.push("scheduleType = ?");
    params.push(data.scheduleType);
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
  guidelines?: RepoGuidelines | null;
}): SwarmRepo {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clonePath = data.clonePath || `/workspace/repos/${data.name}`;
  const guidelinesJson = data.guidelines ? JSON.stringify(data.guidelines) : null;

  const row = getDb()
    .prepare<
      SwarmRepoRow,
      [string, string, string, string, string, number, string | null, string, string]
    >(
      `INSERT INTO swarm_repos (id, url, name, clonePath, defaultBranch, autoClone, guidelines, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.url,
      data.name,
      clonePath,
      data.defaultBranch ?? "main",
      data.autoClone !== false ? 1 : 0,
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
    .map(rowToAgent);

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
      ]
    >(
      `INSERT INTO workflows (id, name, description, definition, triggers, cooldown, input, triggerSchema, dir, vcs_repo, createdByAgentId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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

export function listWorkflows(filters?: { enabled?: boolean }): Workflow[] {
  let query = "SELECT * FROM workflows WHERE 1=1";
  const params: (string | number)[] = [];
  if (filters?.enabled !== undefined) {
    query += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }
  query += " ORDER BY name ASC";
  return getDb()
    .prepare<WorkflowRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToWorkflow);
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
  return row ? rowToWorkflowRun(row) : null;
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

type SkillWithInstallRow = SkillRow & { isActive: number; installedAt: string };

function rowToSkillWithInstall(row: SkillWithInstallRow): SkillWithInstallInfo {
  return {
    ...rowToSkill(row),
    isActive: row.isActive === 1,
    installedAt: row.installedAt,
  };
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
        version, isEnabled, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?) RETURNING *`,
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

export function listSkills(filters?: SkillFilters): Skill[] {
  const columns =
    filters?.includeContent === false
      ? "id, name, description, type, scope, ownerAgentId, sourceUrl, sourceRepo, sourcePath, sourceBranch, sourceHash, isComplex, allowedTools, model, effort, context, agent, disableModelInvocation, userInvocable, version, isEnabled, createdAt, lastUpdatedAt, lastFetchedAt, '' as content"
      : "*";
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

export function searchSkills(query: string, limit = 20): Skill[] {
  const term = `%${query}%`;
  return getDb()
    .prepare<SkillRow, [string, string, number]>(
      "SELECT * FROM skills WHERE (name LIKE ? OR description LIKE ?) AND isEnabled = 1 ORDER BY name ASC LIMIT ?",
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

export function uninstallSkill(agentId: string, skillId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM agent_skills WHERE agentId = ? AND skillId = ?")
    .run(agentId, skillId);
  return result.changes > 0;
}

export function getAgentSkills(agentId: string, activeOnly = true): SkillWithInstallInfo[] {
  const query = `
    SELECT s.*, as2.isActive, as2.installedAt
    FROM skills s
    JOIN agent_skills as2 ON s.id = as2.skillId
    WHERE as2.agentId = ?
      ${activeOnly ? "AND as2.isActive = 1" : ""}
      AND s.isEnabled = 1
    ORDER BY
      CASE WHEN s.type = 'personal' THEN 0 ELSE 1 END,
      s.name
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
}

export function createMcpServer(data: McpServerInsert): McpServer {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<McpServerRow, (string | number | null)[]>(
      `INSERT INTO mcp_servers (
        id, name, description, scope, ownerAgentId, transport,
        command, args, url, headers,
        envConfigKeys, headerConfigKeys,
        isEnabled, version, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?) RETURNING *`,
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
    compactTrigger: (row.compactTrigger as "auto" | "manual" | null) ?? undefined,
    preCompactTokens: row.preCompactTokens ?? undefined,
    cumulativeInputTokens: row.cumulativeInputTokens,
    cumulativeOutputTokens: row.cumulativeOutputTokens,
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
        string,
      ]
    >(
      `INSERT INTO task_context_snapshots (id, taskId, agentId, sessionId, contextUsedTokens, contextTotalTokens, contextPercent, eventType, compactTrigger, preCompactTokens, cumulativeInputTokens, cumulativeOutputTokens, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  compactTrigger?: "auto" | "manual";
  preCompactTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
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

  // Keep totalContextTokensUsed up to date with the latest known value
  if (input.contextUsedTokens != null) {
    getDb()
      .prepare("UPDATE agent_tasks SET totalContextTokensUsed = ? WHERE id = ?")
      .run(input.contextUsedTokens, input.taskId);
  }

  if (input.eventType === "compaction") {
    getDb()
      .prepare(
        "UPDATE agent_tasks SET compactionCount = COALESCE(compactionCount, 0) + 1 WHERE id = ?",
      )
      .run(input.taskId);
  }

  if (input.eventType === "completion" && input.contextTotalTokens != null) {
    getDb()
      .prepare("UPDATE agent_tasks SET contextWindowSize = ? WHERE id = ?")
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
  totalContextTokensUsed: number | null;
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
    totalContextTokensUsed: task?.totalContextTokensUsed ?? null,
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
  createdAt: string;
  updatedAt: string;
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
    .prepare<ApiKeyStatus, string[]>(`SELECT * FROM api_key_status ${where} ORDER BY keyIndex`)
    .all(...params);
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
      JOIN agent_tasks t ON sc.taskId = t.id
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
  slackUserId: string | null;
  linearUserId: string | null;
  githubUsername: string | null;
  gitlabUsername: string | null;
  emailAliases: string | null;
  preferredChannel: string | null;
  timezone: string | null;
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
    slackUserId: row.slackUserId ?? undefined,
    linearUserId: row.linearUserId ?? undefined,
    githubUsername: row.githubUsername ?? undefined,
    gitlabUsername: row.gitlabUsername ?? undefined,
    emailAliases: row.emailAliases ? JSON.parse(row.emailAliases) : [],
    preferredChannel: row.preferredChannel ?? "slack",
    timezone: row.timezone ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

/**
 * Resolve a user by any platform-specific identifier.
 * Priority: exact match on platform ID, then email (including aliases), then name substring.
 */
export function resolveUser(opts: {
  slackUserId?: string;
  linearUserId?: string;
  githubUsername?: string;
  gitlabUsername?: string;
  email?: string;
  name?: string;
}): User | null {
  const db = getDb();

  // Try exact platform ID matches first
  if (opts.slackUserId) {
    const row = db
      .prepare<UserRow, string>("SELECT * FROM users WHERE slackUserId = ?")
      .get(opts.slackUserId);
    if (row) return rowToUser(row);
  }
  if (opts.linearUserId) {
    const row = db
      .prepare<UserRow, string>("SELECT * FROM users WHERE linearUserId = ?")
      .get(opts.linearUserId);
    if (row) return rowToUser(row);
  }
  if (opts.githubUsername) {
    const row = db
      .prepare<UserRow, string>("SELECT * FROM users WHERE githubUsername = ?")
      .get(opts.githubUsername);
    if (row) return rowToUser(row);
  }
  if (opts.gitlabUsername) {
    const row = db
      .prepare<UserRow, string>("SELECT * FROM users WHERE gitlabUsername = ?")
      .get(opts.gitlabUsername);
    if (row) return rowToUser(row);
  }

  // Try email match (primary email)
  if (opts.email) {
    const row = db.prepare<UserRow, string>("SELECT * FROM users WHERE email = ?").get(opts.email);
    if (row) return rowToUser(row);

    // Check emailAliases (JSON array search)
    const aliasRows = db
      .prepare<UserRow, []>("SELECT * FROM users WHERE emailAliases != '[]'")
      .all();
    for (const r of aliasRows) {
      const aliases: string[] = r.emailAliases ? JSON.parse(r.emailAliases) : [];
      if (aliases.some((a) => a.toLowerCase() === opts.email!.toLowerCase())) {
        return rowToUser(r);
      }
    }
  }

  // Try name substring match (case-insensitive)
  if (opts.name) {
    const row = db
      .prepare<UserRow, string>("SELECT * FROM users WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'")
      .get(opts.name);
    if (row) return rowToUser(row);
  }

  return null;
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
  slackUserId?: string;
  linearUserId?: string;
  githubUsername?: string;
  gitlabUsername?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
}): User {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<UserRow, (string | null)[]>(
      `INSERT INTO users (id, name, email, role, notes, slackUserId, linearUserId, githubUsername, gitlabUsername, emailAliases, preferredChannel, timezone, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.name,
      data.email ?? null,
      data.role ?? null,
      data.notes ?? null,
      data.slackUserId ?? null,
      data.linearUserId ?? null,
      data.githubUsername ?? null,
      data.gitlabUsername ?? null,
      JSON.stringify(data.emailAliases ?? []),
      data.preferredChannel ?? "slack",
      data.timezone ?? null,
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
    slackUserId: string;
    linearUserId: string;
    githubUsername: string;
    gitlabUsername: string;
    emailAliases: string[];
    preferredChannel: string;
    timezone: string;
  }>,
): User | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];

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
  if (data.slackUserId !== undefined) {
    sets.push("slackUserId = ?");
    params.push(data.slackUserId);
  }
  if (data.linearUserId !== undefined) {
    sets.push("linearUserId = ?");
    params.push(data.linearUserId);
  }
  if (data.githubUsername !== undefined) {
    sets.push("githubUsername = ?");
    params.push(data.githubUsername);
  }
  if (data.gitlabUsername !== undefined) {
    sets.push("gitlabUsername = ?");
    params.push(data.gitlabUsername);
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

  if (sets.length === 0) return getUserById(id);

  sets.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const row = getDb()
    .prepare<UserRow, (string | null)[]>(
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
