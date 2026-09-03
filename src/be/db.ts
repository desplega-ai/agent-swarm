import { Database } from "bun:sqlite";
import { parseProviderMeta } from "@/utils/provider-metadata.ts";
import pkg from "../../package.json";
import { defaultAssetKey, normalizeAssetKey } from "../assets/key";
import { configureDbResolver } from "../prompts/resolver";
import { slackChannelFromContextKey } from "../tasks/slack-routing";
import { telemetry } from "../telemetry";
import type {
  ActiveSession,
  Agent,
  AgentAvatar,
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
  AssetEntityType,
  AssetKeyMapping,
  AssetSummary,
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
  FavoriteItemType,
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
  ReasoningEffort,
  RepoGuidelines,
  RoutingAffinity,
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
  SessionCostModelBreakdown,
  SessionCostSource,
  SessionLog,
  Skill,
  SkillFile,
  SkillScope,
  SkillType,
  SkillWithInstallInfo,
  SteeringMessage,
  SteeringSource,
  SteeringStatus,
  SteerMode,
  SwarmConfig,
  SwarmRepo,
  TaskAttachment,
  TaskTemplate,
  TaskTemplateKind,
  TriggerConfig,
  User,
  UserFavorite,
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
  AgentAvatarSchema,
  type CreateTaskOptions,
  CreateTaskOptionsSchema,
  FollowUpConfigSchema,
  isTerminalTaskStatus,
  type ModelTier,
  parseModelTier,
  ReasoningEffortSchema,
  RoutingAffinitySchema,
  SERVER_GENERATED_ATTACHMENT_CAPABILITY,
  SessionCostModelBreakdownSchema,
} from "../types";
import { deriveProviderFromKeyType } from "../utils/credentials";
import { isEnvFlagEnabled } from "../utils/env-flag";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";
import { extractGitHubPullRequestUrls } from "../utils/github-pull-request";
import {
  type BudgetedIdentityField,
  checkIdentityFieldBudget,
  IdentityFieldBudgetError,
} from "../utils/identity-field-budget";
import { getCurrentRequestUserId } from "../utils/request-auth-context";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { auditAssetKeys, enforceAssetKeyStartupAudit } from "./asset-key-audit";
import { migrateLegacyCredentialBindingBlob } from "./connection-bindings-blob-migration";
import { decryptSecret, encryptSecret, getEncryptionKey, resolveEncryptionKey } from "./crypto";
import { normalizeDate, normalizeDateRequired } from "./date-utils";
import { createBunSqliteClient, type DbClient } from "./db-client";
import { runMigrations } from "./migrations/runner";
import { autoEncryptLegacyOAuthSecrets } from "./oauth-encryption-backfill";
import { seedDefaultTemplates } from "./seed-prompt-templates";
import { promotePendingSteeringForTask } from "./steering";
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

function assetKeyPrefixPattern(input: string): string {
  const canonical = normalizeAssetKey(input);
  return `${canonical.replace(/[\\%_]/g, "\\$&")}%`;
}

function emitTaskLifecycleTelemetryAfterCommit(
  event: string,
  props: TaskTelemetryProps,
  verify?: (task: AgentTask | null) => boolean,
): void {
  // afterCommit (not queueMicrotask): under an async client transaction,
  // microtasks drain before COMMIT, so the verify read could observe
  // uncommitted state. afterCommit runs strictly post-COMMIT/ROLLBACK.
  getDbClient().afterCommit(() => {
    if (!verify) {
      telemetry.taskEvent(event, props);
      return;
    }
    getTaskById(props.taskId)
      .then((task) => {
        if (!verify(task)) return;
        telemetry.taskEvent(event, props);
      })
      .catch((err) =>
        console.error(
          "[db] emitTaskLifecycleTelemetryAfterCommit verify read failed:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
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

/**
 * Resolve the sqlite-vec loadable extension path without opening a Database.
 * Mirrors loadSqliteVec's env-var-first, npm-fallback resolution, but returns
 * the path instead of loading it: the bounded db-query child process (see
 * src/http/db-query-bounded.ts) opens its own read-only connection and must
 * load the extension itself, so the parent resolves the path once and passes
 * it along. The result is memoized — `undefined` is a valid resolved answer
 * (extension genuinely unavailable) and is cached too, so a failing
 * `require` doesn't retry on every query.
 */
let cachedSqliteVecExtensionPath: string | undefined | null = null;

export function resolveSqliteVecExtensionPath(): string | undefined {
  if (cachedSqliteVecExtensionPath !== null) return cachedSqliteVecExtensionPath;
  const extensionPath = process.env.SQLITE_VEC_EXTENSION_PATH;
  if (extensionPath) {
    cachedSqliteVecExtensionPath = extensionPath;
    return cachedSqliteVecExtensionPath;
  }
  try {
    cachedSqliteVecExtensionPath = (
      require("sqlite-vec") as { getLoadablePath(): string }
    ).getLoadablePath();
  } catch {
    cachedSqliteVecExtensionPath = undefined;
  }
  return cachedSqliteVecExtensionPath;
}

/** Test-only: clear the memoized sqlite-vec extension path cache. */
export function __resetSqliteVecExtensionPathCacheForTests(): void {
  cachedSqliteVecExtensionPath = null;
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
    enforceAssetKeyStartupAudit(db);
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
  try {
    runMigrations(database);
  } catch (error) {
    db = null;
    try {
      database.close();
    } catch (closeError) {
      console.error("[migrations] Failed to close database after migration failure:", closeError);
    }
    throw error;
  }

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

      // Migrations run before this compatibility guard, so a legacy table now
      // carries every current column. Rebuilding from an old hard-coded column
      // list would silently discard later fields. Derive the replacement
      // schema, copy list, indexes, and triggers from the live table instead;
      // remove only the obsolete status CHECK.
      const rebuiltSchemaSql = schemaSql
        .replace(
          /^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)(?:"agent_tasks"|agent_tasks)/i,
          "$1agent_tasks_new",
        )
        .replace(/\s+CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i, "");
      if (rebuiltSchemaSql === schemaSql || !/agent_tasks_new/i.test(rebuiltSchemaSql)) {
        throw new Error("Could not derive agent_tasks schema without legacy status CHECK");
      }
      const columns = db
        .prepare<{ name: string }, []>('PRAGMA table_info("agent_tasks")')
        .all()
        .map((column) => `"${column.name.replaceAll('"', '""')}"`)
        .join(", ");
      const schemaObjects = db
        .prepare<{ sql: string }, []>(
          `SELECT sql FROM sqlite_master
           WHERE tbl_name = 'agent_tasks'
             AND type IN ('index', 'trigger')
             AND sql IS NOT NULL
           ORDER BY type, name`,
        )
        .all()
        .map((row) => row.sql);

      database.transaction(() => {
        database.run("DROP TABLE IF EXISTS agent_tasks_new");
        database.run(rebuiltSchemaSql);
        database.run(`INSERT INTO agent_tasks_new (${columns}) SELECT ${columns} FROM agent_tasks`);
        database.run("DROP TABLE agent_tasks");
        database.run("ALTER TABLE agent_tasks_new RENAME TO agent_tasks");
        for (const sql of schemaObjects) database.run(sql);
      })();

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

  // Mandatory namespace invariant: structural corruption is fatal before the
  // API starts listening. Unknown personal users/provider drift remain
  // readable warnings so operators can repair them through the audit surface.
  enforceAssetKeyStartupAudit(database);

  // Backfill: Seed v1 for existing agents that don't have any context versions yet
  seedContextVersions();

  // Inject DB resolver into the prompt template resolver (DI to avoid worker/API boundary violation)
  configureDbResolver(resolvePromptTemplate);

  // Seed default prompt templates from the in-memory code registry
  seedDefaultTemplates();

  const hasExistingEncryptedSecrets =
    (database
      .prepare<{ present: number }, []>(
        `SELECT EXISTS(
           SELECT 1 FROM swarm_config WHERE isSecret = 1 AND encrypted = 1
           UNION ALL
           SELECT 1 FROM oauth_apps
             WHERE clientSecretEncrypted = 1 AND clientSecret IS NOT NULL
           UNION ALL
           SELECT 1 FROM oauth_authorizations WHERE tokensEncrypted = 1
         ) AS present`,
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

  // Migration 117 carries plaintext tracker OAuth rows with explicit flags;
  // encrypt them only after the shared key has been resolved. This pass is
  // idempotent and intentionally fatal on failure so boot never continues
  // with OAuth credentials left in plaintext.
  try {
    autoEncryptLegacyOAuthSecrets(database);
  } catch (err) {
    console.error(
      `[oauth-encryption] FATAL: failed to auto-encrypt legacy OAuth secrets: ${(err as Error).message}`,
    );
    throw err;
  }

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

  // Retire the legacy SCRIPT_CREDENTIAL_BINDINGS swarm-config blob: promote any
  // remaining entries to relational rows so the credential broker is
  // relational-only. Idempotent; failures are fatal because a silently-dropped
  // binding would leave scripts unable to authenticate.
  try {
    migrateLegacyCredentialBindingBlob(database);
  } catch (err) {
    console.error(
      `[credential-bindings] FATAL: failed to migrate legacy credential binding blob: ${(err as Error).message}`,
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

// Async seam over the shared connection. The client resolves the underlying
// handle per operation via getDb(), so close/reopen cycles need no reset.
let dbClientInstance: DbClient | null = null;

export function getDbClient(): DbClient {
  if (!dbClientInstance) {
    dbClientInstance = createBunSqliteClient(() => getDb());
  }
  return dbClientInstance;
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

const BUDGETED_IDENTITY_FIELDS: BudgetedIdentityField[] = [
  "soulMd",
  "identityMd",
  "claudeMd",
  "toolsMd",
];

function ensureAgentProfileColumns(database: Database): void {
  // `PRAGMA table_info` on a nonexistent table returns an empty result set
  // rather than erroring, which used to make every column below look
  // "missing" on a table that was never created and throw `no such table:
  // agents` from the ALTER below. This is a legacy-compat shim for
  // pre-migration-system databases; runMigrations() (and its own
  // assertNotEmptyDatabase guard) is what's responsible for the `agents`
  // table existing at all, and already fails loudly if it doesn't. This
  // function must never be the thing that crashes startup instead.
  const agentsTableExists = database
    .prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'",
    )
    .get();
  if (!agentsTableExists) {
    console.warn("[Migration] agents table does not exist yet — skipping profile column backfill");
    return;
  }

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

export async function createContextVersion(params: {
  agentId: string;
  field: VersionableField;
  content: string;
  version: number;
  changeSource: ChangeSource;
  changedByAgentId?: string | null;
  changeReason?: string | null;
  contentHash: string;
  previousVersionId?: string | null;
}): Promise<ContextVersion> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ContextVersionRow>(
    `INSERT INTO context_versions (id, agentId, field, content, version, changeSource, changedByAgentId, changeReason, contentHash, previousVersionId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create context version");
  return rowToContextVersion(row);
}

export async function getLatestContextVersion(
  agentId: string,
  field: VersionableField,
): Promise<ContextVersion | null> {
  const row = await getDbClient().get<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT 1`,
    [agentId, field],
  );

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersion(id: string): Promise<ContextVersion | null> {
  const row = await getDbClient().get<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE id = ?`,
    [id],
  );

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersionHistory(params: {
  agentId: string;
  field?: VersionableField;
  limit?: number;
}): Promise<ContextVersion[]> {
  const limit = params.limit ?? 10;

  if (params.field) {
    const rows = await getDbClient().query<ContextVersionRow>(
      `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT ?`,
      [params.agentId, params.field, limit],
    );
    return rows.map(rowToContextVersion);
  }

  const rows = await getDbClient().query<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?`,
    [params.agentId, limit],
  );
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
  /** Migration 119: custom avatar (JSON of AgentAvatar). NULL = deterministic hash-derived fallback. */
  avatar: string | null;
};

/** Safe-parse the `avatar` JSON column. Malformed/invalid content (e.g. a
 * hand-edited row, or a future downgrade) falls back to `null` so rendering
 * always has a deterministic path — never throws. */
function parseAgentAvatar(raw: string | null): AgentAvatar | null {
  if (!raw) return null;
  try {
    const parsed = AgentAvatarSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
    avatar: parseAgentAvatar(row.avatar),
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
export async function updateAgentCredentialState(
  agentId: string,
  ready: boolean,
  missing: string[] | null,
): Promise<Agent | null> {
  const prev = await getAgentById(agentId);
  const status: AgentStatus = ready ? "idle" : "waiting_for_credentials";
  const missingJson = ready ? null : missing && missing.length > 0 ? JSON.stringify(missing) : null;
  const row = await getDbClient().get<AgentRow>(
    "UPDATE agents SET status = ?, credentialMissing = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    [status, missingJson, agentId],
  );
  // Only clear the accumulated empty-poll count on a genuine recovery
  // (waiting_for_credentials -> ready), so routine post-task `ready:true`
  // reports don't clobber a legitimately accumulated count and defeat the
  // MAX_EMPTY_POLLS polling gate.
  if (ready && prev?.status === "waiting_for_credentials") await resetEmptyPollCount(agentId);
  return row ? rowToAgent(row) : null;
}

/**
 * Record which env vars a worker is missing without touching status — the
 * logical status is derived from runtime readiness in multi-runtime mode.
 */
export async function updateAgentCredentialMissing(
  agentId: string,
  missing: string[] | null,
): Promise<void> {
  const json = missing && missing.length > 0 ? JSON.stringify(missing) : null;
  await getDbClient().run(
    "UPDATE agents SET credentialMissing = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [json, agentId],
  );
}

export async function createAgent(
  agent: Omit<Agent, "id" | "createdAt" | "lastUpdatedAt"> & { id?: string },
): Promise<Agent> {
  const id = agent.id ?? crypto.randomUUID();
  const maxTasks = agent.maxTasks ?? 1;
  const row = await getDbClient().get<AgentRow>(
    "INSERT INTO agents (id, name, isLead, status, maxTasks, provider, harness_provider, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
    [
      id,
      agent.name,
      agent.isLead ? 1 : 0,
      agent.status,
      maxTasks,
      agent.provider ?? null,
      agent.harnessProvider ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create agent");
  try {
    await installSystemDefaultSkillsForAgent(id);
  } catch (err) {
    console.warn(
      "[db] Failed to install system-default skills for new agent:",
      (err as Error).message,
    );
  }
  try {
    await createLogEntry({ eventType: "agent_joined", agentId: id, newValue: agent.status });
  } catch {}
  return rowToAgent(row);
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
  return row ? rowToAgent(row) : null;
}

export async function getAllAgents(opts?: { slim?: boolean }): Promise<Agent[]> {
  const rows = await getDbClient().query<AgentRow>("SELECT * FROM agents ORDER BY name");
  return rows.map((row) => rowToAgent(row, opts?.slim ?? false));
}

export async function getLeadAgent(): Promise<Agent | null> {
  const leads = (await getAllAgents()).filter((a) => a.isLead);
  // Prefer a usable (non-offline) lead so callers route to one that can actually
  // poll — e.g. an old offline lead must not shadow a live replacement. Falls
  // back to any lead (incl. offline) so existing "is there a lead at all?"
  // semantics are preserved; callers that require a live lead must check
  // `status` themselves (see escalateUnreclaimedResumes).
  return leads.find((a) => a.status !== "offline") ?? leads[0] ?? null;
}

export async function updateAgentStatus(id: string, status: AgentStatus): Promise<Agent | null> {
  const oldAgent = await getAgentById(id);
  const row = await getDbClient().get<AgentRow>(
    "UPDATE agents SET status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    [status, id],
  );
  if (row && oldAgent) {
    try {
      await createLogEntry({
        eventType: "agent_status_change",
        agentId: id,
        oldValue: oldAgent.status,
        newValue: status,
      });
    } catch {}
  }
  return row ? rowToAgent(row) : null;
}

export async function updateAgentMaxTasks(id: string, maxTasks: number): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET maxTasks = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [maxTasks, id],
  );
  return row ? rowToAgent(row) : null;
}

export async function updateAgentProvider(
  id: string,
  provider: ProviderName,
): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [provider, id],
  );
  return row ? rowToAgent(row) : null;
}

/**
 * Phase 1.5 (cloud-personalization): set the per-agent `harness_provider`
 * column. Pass `null` to clear. Validation against the canonical provider
 * list happens at the API layer via `ProviderNameSchema`.
 *
 * Returns the updated row, or null if the agent does not exist.
 */
export async function setAgentHarnessProvider(
  id: string,
  provider: ProviderName | null,
): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET harness_provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [provider, id],
  );
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
export async function updateAgentCredStatus(
  id: string,
  credStatus: AgentCredStatus | null,
): Promise<Agent | null> {
  const json = credStatus ? JSON.stringify(credStatus) : null;
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET cred_status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [json, id],
  );
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
export async function listAgentsWithCredStatusByProvider(provider: string): Promise<Agent[]> {
  const rows = await getDbClient().query<AgentRow>(
    `SELECT * FROM agents WHERE harness_provider = ? ORDER BY name`,
    [provider],
  );
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
export async function getAgentHarnessProviders(): Promise<
  Array<{ provider: string; count: number }>
> {
  const rows = await getDbClient().query<{ provider: string; count: number }>(
    `SELECT harness_provider AS provider, COUNT(*) AS count
       FROM agents
       WHERE harness_provider IS NOT NULL
       GROUP BY harness_provider
       ORDER BY harness_provider`,
  );
  return rows.map((r) => ({ provider: r.provider, count: r.count }));
}

export async function updateAgentActivity(id: string): Promise<void> {
  await getDbClient().run(
    `UPDATE agents SET lastActivityAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    [id],
  );
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
export async function incrementEmptyPollCount(agentId: string): Promise<number> {
  const row = await getDbClient().get<{ emptyPollCount: number }>(
    `UPDATE agents
       SET emptyPollCount = emptyPollCount + 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING emptyPollCount`,
    [agentId],
  );
  return row?.emptyPollCount ?? 0;
}

/**
 * Reset the empty poll count for an agent to zero.
 * Called when a task is assigned or agent re-registers.
 */
export async function resetEmptyPollCount(agentId: string): Promise<void> {
  await getDbClient().run(
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
export async function shouldBlockPolling(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  return (agent?.emptyPollCount ?? 0) >= MAX_EMPTY_POLLS;
}

export async function deleteAgent(id: string): Promise<boolean> {
  const agent = await getAgentById(id);
  if (agent) {
    try {
      await createLogEntry({ eventType: "agent_left", agentId: id, oldValue: agent.status });
    } catch {}
  }
  const result = await getDbClient().run("DELETE FROM agents WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// Agent Capacity Functions
// ============================================================================

/**
 * Get the count of active (in_progress) tasks for an agent.
 * Used to determine current capacity usage.
 */
/**
 * Tasks occupying one of the agent's concurrency slots.
 *
 * A claimed offer counts too — omitting it let a second concurrent poll take
 * another task past the limit. It is counted only through `offeredTo`, the
 * agent actually reviewing it: `agentId` on an offer may still be the lead
 * that created it, which would otherwise consume the lead's own capacity.
 */
export async function getActiveTaskCount(agentId: string): Promise<number> {
  const result = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_tasks
     WHERE (agentId = ? AND status = 'in_progress')
        OR (offeredTo = ? AND status = 'reviewing')`,
    [agentId, agentId],
  );
  return result?.count ?? 0;
}

/**
 * Check if an agent has capacity to accept more tasks.
 */
export async function hasCapacity(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent) return false;
  const activeCount = await getActiveTaskCount(agentId);
  return activeCount < (agent.maxTasks ?? 1);
}

/**
 * Get remaining capacity (available task slots) for an agent.
 */
export async function getRemainingCapacity(agentId: string): Promise<number> {
  const agent = await getAgentById(agentId);
  if (!agent) return 0;
  const activeCount = await getActiveTaskCount(agentId);
  return Math.max(0, (agent.maxTasks ?? 1) - activeCount);
}

/**
 * Update agent status based on current capacity.
 * Agent is 'busy' when any tasks are in progress, 'idle' when none.
 * Does not modify 'offline' status.
 */
export async function updateAgentStatusFromCapacity(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent || agent.status === "offline") return;
  // `waiting_for_credentials` is owned by the worker's credential-wait
  // tick — task-completion shouldn't accidentally promote a blocked agent
  // back to idle.
  if (agent.status === "waiting_for_credentials") return;

  const activeCount = await getActiveTaskCount(agentId);
  const newStatus = activeCount > 0 ? "busy" : "idle";

  if (agent.status !== newStatus) {
    await updateAgentStatus(agentId, newStatus);
  }
}

// ============================================================================
// Routing Affinity (interrupted/pooled task role & capability gating)
// ============================================================================

/**
 * Kill-switch for the pool eligibility gate (`isAgentEligibleForTask` and its
 * callers: `claimTask`, `assignUnassignedTaskPending`,
 * `getUnassignedTaskIdsForAgent`). ON by default. Set to `0` to restore
 * pre-affinity behavior verbatim — mirrors the `HEARTBEAT_PIN_*_RESUME`
 * rollback convention. A function (read dynamically), not a module-load-time
 * const, so it can be toggled mid-test (see `isGracefulResumePinEnabled` in
 * src/tasks/worker-follow-up.ts for the same pattern).
 */
export function isPoolAffinityEnforcementEnabled(): boolean {
  return isEnvFlagEnabled("POOL_AFFINITY_ENFORCEMENT", true);
}

/**
 * Snapshot an agent's role/harness/capabilities into a `RoutingAffinity`
 * blob, for stamping onto a continuation task (resume, retry) at the moment
 * of interruption. Returns `null` when the agent row is already gone —
 * callers fall back to the parent's own (inherited) `routingAffinity` via
 * `createTaskExtended`'s parentTaskId inheritance block.
 */
export async function buildRoutingAffinityFromAgent(
  agentId: string,
): Promise<RoutingAffinity | null> {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  return {
    sourceAgentId: agent.id,
    role: agent.role,
    harnessProvider: agent.harnessProvider ?? agent.provider ?? undefined,
    capabilities: agent.capabilities ?? [],
  };
}

/**
 * The single eligibility gate every pool consumer (poll auto-claim,
 * `task-action claim`, `autoAssignPoolTasks`) MUST use before handing a task
 * to an agent. Exact-match on the snapshotted role string (no keyword
 * taxonomy in v1); `harnessProvider` is informational only and never
 * enforced (native session resume is deprecated). Missing role data on
 * either side is treated as INELIGIBLE — never fail-open to "anyone" — so a
 * capability-only requirement (no `role` set) can only ever be claimed by
 * its `sourceAgentId`, and otherwise queues until the starvation escalation
 * hands it to the Lead. Lead-only work is different: any Lead may claim it
 * (subject to explicitly required capabilities), because its source/role is
 * only recovery provenance and must not turn a worker's old role into a
 * constraint on the Lead pool.
 */
export function isAgentEligibleForTask(
  agent: Pick<Agent, "id" | "isLead" | "role" | "capabilities">,
  task: Pick<AgentTask, "routingAffinity" | "routingAffinityInvalid">,
): boolean {
  const affinity = task.routingAffinity;
  // A malformed persisted blob is a security boundary failure, not an
  // untagged task. Quarantine it from every assignment/claim path.
  if (task.routingAffinityInvalid) return false;
  if (!affinity) return true; // Untagged task — unchanged behavior.

  const requiredCapabilities = affinity.capabilities ?? [];
  const hasRequiredCapabilities = () => {
    const agentCapabilities = new Set(agent.capabilities ?? []);
    return requiredCapabilities.every((cap) => agentCapabilities.has(cap));
  };
  // Lead-only is an authorization boundary, never a best-effort pool hint or
  // a source-agent exception. Its explicit capability requirements remain
  // enforced even if the role/capability affinity kill-switch is enabled.
  // Do not require an unrelated worker role/source to match a Lead-only task.
  if (affinity.leadOnly) return agent.isLead && hasRequiredCapabilities();
  if (!isPoolAffinityEnforcementEnabled()) return true;

  if (affinity.sourceAgentId && affinity.sourceAgentId === agent.id) return true; // Own work.

  if (!agent.role || !affinity.role) return false; // Missing role data — no fail-open.
  if (agent.role !== affinity.role) return false;

  return hasRequiredCapabilities();
}

// ============================================================================
// AgentTask Queries
// ============================================================================

type AgentTaskRow = {
  id: string;
  key: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  title: string | null;
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
  slackTriggerMessageTs: string | null;
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
  effort: string | null;
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
  requestedByUserIdInherited: number;
  swarmVersion: string | null;
  provider: string | null;
  providerMeta: string | null;
  harnessVariant: string | null;
  harnessVariantMeta: string | null;
  totalCostUsd?: number | null;
  routingAffinity: string | null;
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

  let routingAffinity: RoutingAffinity | undefined;
  let routingAffinityInvalid = false;
  if (row.routingAffinity) {
    try {
      const parsed = RoutingAffinitySchema.safeParse(JSON.parse(row.routingAffinity));
      if (parsed.success) {
        routingAffinity = parsed.data;
      } else {
        routingAffinityInvalid = true;
        console.warn(
          `[db] Quarantining invalid agent_tasks.routingAffinity for task ${row.id}:`,
          parsed.error.message,
        );
      }
    } catch (error) {
      routingAffinityInvalid = true;
      console.warn(
        `[db] Quarantining malformed agent_tasks.routingAffinity for task ${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    id: row.id,
    key: row.key,
    agentId: row.agentId,
    creatorAgentId: row.creatorAgentId ?? undefined,
    task: row.task,
    title: row.title ?? undefined,
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
    slackTriggerMessageTs: row.slackTriggerMessageTs ?? undefined,
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
    effort: ReasoningEffortSchema.safeParse(row.effort).success
      ? (row.effort as ReasoningEffort)
      : undefined,
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
    routingAffinity,
    routingAffinityInvalid: routingAffinityInvalid || undefined,
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
    key: t.key,
    agentId: t.agentId,
    creatorAgentId: t.creatorAgentId,
    task: previewText(t.task, TASK_PREVIEW_LENGTH),
    title: t.title,
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
    effort: t.effort,
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

export async function createTask(
  agentId: string,
  task: string,
  options?: {
    source?: AgentTaskSource;
    slackChannelId?: string;
    slackThreadTs?: string;
    slackUserId?: string;
  },
): Promise<AgentTask> {
  const id = crypto.randomUUID();
  const source = options?.source ?? "mcp";
  const row = await getDbClient().get<AgentTaskRow>(
    `INSERT INTO agent_tasks (id, "key", agentId, task, status, source, slackChannelId, slackThreadTs, slackUserId, swarmVersion, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    [
      id,
      defaultAssetKey("task", id),
      agentId,
      task,
      "pending",
      source,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      pkg.version,
    ],
  );
  if (!row) throw new Error("Failed to create task");
  try {
    await createLogEntry({
      eventType: "task_created",
      agentId,
      taskId: id,
      newValue: "pending",
      metadata: { source },
    });
  } catch {}
  return rowToAgentTask(row);
}

export async function getPendingTaskForAgent(agentId: string): Promise<AgentTask | null> {
  // Get all pending tasks for this agent, ordered by priority (desc) then creation time (asc)
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY priority DESC, createdAt ASC",
    [agentId],
  );

  const agent = await getAgentById(agentId);
  if (!agent) return null;

  // A persisted legacy task may already be pending on an unauthorized agent.
  // Do not dispatch it merely because it bypassed creation-time checks.
  for (const row of rows) {
    const task = rowToAgentTask(row);
    if (!isAgentEligibleForTask(agent, task)) continue;
    const { ready } = await checkDependencies(task.id);
    if (ready) return task;
  }

  return null;
}

export async function assignUnassignedTaskPending(
  taskId: string,
  agentId: string,
): Promise<AgentTask | null> {
  // This guard is always needed for lead-only tasks; the predicate itself
  // handles the optional role/capability kill-switch.
  {
    const task = await getTaskById(taskId);
    const agent = await getAgentById(agentId);
    if (task && (!agent || !isAgentEligibleForTask(agent, task))) {
      try {
        await createLogEntry({
          eventType: "task_claim_rejected_affinity",
          agentId,
          taskId,
          metadata: {
            agentRole: agent?.role ?? null,
            requiredRole: task.routingAffinity?.role ?? null,
            leadOnly: task.routingAffinity?.leadOnly === true,
            agentIsLead: agent?.isLead ?? false,
          },
        });
      } catch {}
      return null;
    }
  }

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET agentId = ?, status = 'pending', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    [agentId, now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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

export async function startTask(taskId: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(taskId);
  if (!oldTask) return null;

  // Guard: never revive tasks that are already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [taskId],
  );
  if (row && oldTask) {
    try {
      await createLogEntry({
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

export async function getTaskById(id: string): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>("SELECT * FROM agent_tasks WHERE id = ?", [id]);
  return row ? rowToAgentTask(row) : null;
}

export async function getSlackRenderV2ActivatedAt(): Promise<string | null> {
  const row = await getDbClient().get<{ activated_at: string }>(
    `SELECT activated_at FROM slack_render_v2_state WHERE id = 1`,
  );
  return row?.activated_at ?? null;
}

export async function ensureSlackRenderV2Activation(): Promise<string> {
  const activatedAt = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO slack_render_v2_state (id, activated_at)
     VALUES (1, ?)
     ON CONFLICT(id) DO NOTHING`,
    [activatedAt],
  );
  const persisted = await getSlackRenderV2ActivatedAt();
  if (!persisted) throw new Error("Failed to persist Slack render v2 activation");
  return persisted;
}

export type SlackMessageKind = "tree" | "outcome" | "agent";

export interface SlackMessageRecord {
  id: string;
  contextKey: string;
  channelId: string;
  threadTs: string;
  ts: string;
  kind: SlackMessageKind;
  taskId?: string;
  permalink?: string;
  finalizedAt?: string;
  streamChunksAppended: number;
  createdAt: string;
  updatedAt: string;
}

const PENDING_SLACK_MESSAGE_TS_PREFIX = "pending:";

export function isPendingSlackMessage(record: SlackMessageRecord): boolean {
  return record.ts.startsWith(PENDING_SLACK_MESSAGE_TS_PREFIX);
}

type SlackMessageRow = {
  id: string;
  context_key: string;
  channel_id: string;
  thread_ts: string;
  ts: string;
  kind: SlackMessageKind;
  task_id: string | null;
  permalink: string | null;
  finalized_at: string | null;
  stream_chunks_appended: number;
  created_at: string;
  updated_at: string;
};

function rowToSlackMessage(row: SlackMessageRow): SlackMessageRecord {
  return {
    id: row.id,
    contextKey: row.context_key,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    ts: row.ts,
    kind: row.kind,
    taskId: row.task_id ?? undefined,
    permalink: row.permalink ?? undefined,
    finalizedAt: row.finalized_at ?? undefined,
    streamChunksAppended: row.stream_chunks_appended,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function recordSlackMessage(input: {
  contextKey: string;
  channelId: string;
  threadTs: string;
  ts: string;
  kind: SlackMessageKind;
  taskId?: string;
  permalink?: string;
  finalized?: boolean;
  streamChunksAppended?: number;
  actorId?: string;
}): Promise<SlackMessageRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await getDbClient().get<SlackMessageRow>(
    `INSERT INTO slack_messages (
         id, context_key, channel_id, thread_ts, ts, kind, task_id, permalink,
         finalized_at, stream_chunks_appended, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, ts) DO UPDATE SET
         context_key = excluded.context_key,
         kind = excluded.kind,
         task_id = COALESCE(excluded.task_id, slack_messages.task_id),
         permalink = COALESCE(excluded.permalink, slack_messages.permalink),
         finalized_at = COALESCE(excluded.finalized_at, slack_messages.finalized_at),
         stream_chunks_appended = MAX(
           excluded.stream_chunks_appended,
           slack_messages.stream_chunks_appended
         ),
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by
       RETURNING *`,
    [
      id,
      input.contextKey,
      input.channelId,
      input.threadTs,
      input.ts,
      input.kind,
      input.taskId ?? null,
      input.permalink ?? null,
      input.finalized ? now : null,
      input.streamChunksAppended ?? 0,
      now,
      now,
      input.actorId ?? null,
      input.actorId ?? null,
    ],
  );
  if (!row) throw new Error("Failed to record Slack message");
  return rowToSlackMessage(row);
}

export async function reserveSlackMessage(input: {
  contextKey: string;
  channelId: string;
  threadTs: string;
  kind: "tree" | "outcome";
  taskId?: string;
  actorId?: string;
}): Promise<{ record: SlackMessageRecord; created: boolean }> {
  if (input.kind === "outcome" && !input.taskId) {
    throw new Error("Outcome Slack message reservations require a task ID");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const pendingTs = `${PENDING_SLACK_MESSAGE_TS_PREFIX}${id}`;
  const inserted = await getDbClient().get<SlackMessageRow>(
    `INSERT INTO slack_messages (
         id, context_key, channel_id, thread_ts, ts, kind, task_id,
         stream_chunks_appended, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    [
      id,
      input.contextKey,
      input.channelId,
      input.threadTs,
      pendingTs,
      input.kind,
      input.taskId ?? null,
      now,
      now,
      input.actorId ?? null,
      input.actorId ?? null,
    ],
  );
  if (inserted) return { record: rowToSlackMessage(inserted), created: true };

  const existing =
    input.kind === "tree"
      ? await getSlackTreeMessageByThread(input.channelId, input.threadTs)
      : await getSlackOutcomeMessage(input.taskId!);
  if (!existing) throw new Error("Failed to reserve Slack message");
  return { record: existing, created: false };
}

export async function bindSlackMessageTimestamp(
  id: string,
  ts: string,
  options: { streamChunksAppended?: number; renderedThrough?: string } = {},
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<SlackMessageRow>(
    `UPDATE slack_messages SET
         ts = ?,
         stream_chunks_appended = MAX(stream_chunks_appended, ?),
         updated_at = COALESCE(?, ?)
       WHERE id = ? AND ts LIKE 'pending:%'
       RETURNING *`,
    [ts, options.streamChunksAppended ?? 0, options.renderedThrough ?? null, now, id],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function updateSlackMessageRecord(
  id: string,
  updates: {
    permalink?: string;
    finalized?: boolean;
    streamChunksAppended?: number;
    actorId?: string;
    touchUpdatedAt?: boolean;
  },
): Promise<SlackMessageRecord | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<SlackMessageRow>(
    `UPDATE slack_messages SET
         permalink = COALESCE(?, permalink),
         finalized_at = CASE WHEN ? = 1 THEN COALESCE(finalized_at, ?) ELSE finalized_at END,
         stream_chunks_appended = COALESCE(?, stream_chunks_appended),
         updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END,
         updated_by = COALESCE(?, updated_by)
       WHERE id = ?
       RETURNING *`,
    [
      updates.permalink ?? null,
      updates.finalized ? 1 : 0,
      now,
      updates.streamChunksAppended ?? null,
      updates.touchUpdatedAt === false ? 0 : 1,
      now,
      updates.actorId ?? null,
      id,
    ],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function markSlackTreeRendered(
  id: string,
  renderedThrough: string,
): Promise<SlackMessageRecord | null> {
  const row = await getDbClient().get<SlackMessageRow>(
    `UPDATE slack_messages SET updated_at = ?
       WHERE id = ? AND kind = 'tree'
       RETURNING *`,
    [renderedThrough, id],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function deleteSlackMessageRecord(id: string): Promise<boolean> {
  const result = await getDbClient().run(`DELETE FROM slack_messages WHERE id = ?`, [id]);
  return result.changes > 0;
}

export async function getSlackTreeMessage(contextKey: string): Promise<SlackMessageRecord | null> {
  const row = await getDbClient().get<SlackMessageRow>(
    `SELECT * FROM slack_messages WHERE context_key = ? AND kind = 'tree' LIMIT 1`,
    [contextKey],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackTreeMessageByThread(
  channelId: string,
  threadTs: string,
): Promise<SlackMessageRecord | null> {
  const row = await getDbClient().get<SlackMessageRow>(
    `SELECT * FROM slack_messages
       WHERE channel_id = ? AND thread_ts = ? AND kind = 'tree'
       LIMIT 1`,
    [channelId, threadTs],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackOutcomeMessage(taskId: string): Promise<SlackMessageRecord | null> {
  const row = await getDbClient().get<SlackMessageRow>(
    `SELECT * FROM slack_messages WHERE task_id = ? AND kind = 'outcome' LIMIT 1`,
    [taskId],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackTreeMessages(): Promise<SlackMessageRecord[]> {
  const rows = await getDbClient().query<SlackMessageRow>(
    `SELECT tree.*
       FROM slack_messages tree
       JOIN slack_render_v2_state state ON state.id = 1
       WHERE tree.kind = 'tree'
       AND (
         (tree.ts LIKE 'pending:%' AND tree.created_at >= state.activated_at)
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.source = 'slack'
           AND task.createdAt >= state.activated_at
           AND task.status IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM slack_messages outcome
             WHERE outcome.kind = 'outcome'
             AND outcome.task_id = task.id
             AND outcome.finalized_at IS NOT NULL
           )
         )
         OR
         EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
         )
         OR EXISTS (
           SELECT 1 FROM agent_tasks task
           WHERE task.slackChannelId = tree.channel_id
           AND task.slackThreadTs = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND task.lastUpdatedAt > tree.updated_at
         )
         OR EXISTS (
           SELECT 1 FROM slack_messages outcome
           JOIN agent_tasks task ON task.id = outcome.task_id
           WHERE outcome.kind = 'outcome'
           AND outcome.channel_id = tree.channel_id
           AND outcome.thread_ts = tree.thread_ts
           AND task.createdAt >= state.activated_at
           AND (
             outcome.finalized_at IS NULL
             OR outcome.updated_at > tree.updated_at
           )
         )
       )
       ORDER BY tree.created_at ASC`,
  );
  return rows.map(rowToSlackMessage);
}

export async function getSlackMessageByChannelTs(
  channelId: string,
  ts: string,
): Promise<SlackMessageRecord | null> {
  const row = await getDbClient().get<SlackMessageRow>(
    `SELECT * FROM slack_messages WHERE channel_id = ? AND ts = ? LIMIT 1`,
    [channelId, ts],
  );
  return row ? rowToSlackMessage(row) : null;
}

export async function getSlackTasksInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ? AND slackThreadTs = ?
       ORDER BY createdAt ASC, rowid ASC`,
    [channelId, threadTs],
  );
  return rows.map(rowToAgentTask);
}

export async function markTaskSlackReplySent(taskId: string): Promise<void> {
  await getDbClient().run(`UPDATE agent_tasks SET slackReplySent = 1 WHERE id = ?`, [taskId]);
}

export async function setSlackMessageTracking(
  taskId: string,
  fields: {
    slackProgressMessageTs?: string | null;
    slackTreeRootMessageTs?: string | null;
  },
): Promise<void> {
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
  await getDbClient().run(`UPDATE agent_tasks SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function getChildTasks(parentTaskId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks WHERE parentTaskId = ? ORDER BY createdAt ASC, rowid ASC`,
    [parentTaskId],
  );
  return rows.map(rowToAgentTask);
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
export async function hasNonTerminalResumeChild(parentId: string): Promise<boolean> {
  const row = await getDbClient().get(
    `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'resume'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    [parentId],
  );
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
export async function hasNonTerminalRerouteDecisionChild(parentId: string): Promise<boolean> {
  const row = await getDbClient().get<Record<string, number>>(
    `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'reroute-decision'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    [parentId],
  );
  return row !== undefined && row !== null;
}

export async function updateTaskClaudeSessionId(
  taskId: string,
  claudeSessionId: string,
  provider?: ProviderName,
  providerMeta?: Record<string, unknown>,
  model?: string,
  harnessVariant?: string,
  harnessVariantMeta?: Record<string, unknown>,
): Promise<AgentTask | null> {
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

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToAgentTask(row) : null;
}

/**
 * Sets or clears a task's display title (session rename). Trims the input and
 * normalizes an empty string to NULL (clear). Deliberately does NOT touch
 * `lastUpdatedAt` — a rename is not activity, and the sessions sidebar sorts
 * on chain-wide max `lastUpdatedAt`, so bumping it here would reorder the list.
 */
export async function updateTaskTitle(
  taskId: string,
  title: string | null,
): Promise<AgentTask | null> {
  const normalized = title === null ? null : title.trim() || null;
  const row = await getDbClient().get<AgentTaskRow>(
    "UPDATE agent_tasks SET title = ? WHERE id = ? RETURNING *",
    [normalized, taskId],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function updateTaskVcs(
  taskId: string,
  vcs: {
    vcsProvider: "github" | "gitlab";
    vcsRepo: string;
    vcsNumber: number;
    vcsUrl: string;
  },
): Promise<AgentTask | null> {
  const row = await getDbClient().transaction(async () => {
    const updated = await getDbClient().get<AgentTaskRow>(
      `UPDATE agent_tasks
       SET vcsProvider = ?, vcsRepo = ?, vcsNumber = ?, vcsUrl = ?, lastUpdatedAt = ?
       WHERE id = ? RETURNING *`,
      [vcs.vcsProvider, vcs.vcsRepo, vcs.vcsNumber, vcs.vcsUrl, new Date().toISOString(), taskId],
    );
    if (updated) {
      await reconcileTaskPullRequestAttachments(taskId, updated.agentId, [
        updated.output,
        vcs.vcsProvider === "github" ? vcs.vcsUrl : null,
      ]);
    }
    return updated;
  });
  return row ? rowToAgentTask(row) : null;
}

export async function getTasksByAgentId(agentId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? ORDER BY createdAt DESC",
    [agentId],
  );
  return rows.map(rowToAgentTask);
}

/**
 * Get the most recently updated in-progress task for an agent.
 * Used as a fallback when X-Source-Task-Id header is missing (e.g. lead agent HITL requests).
 *
 * Note: if agent has multiple in-progress tasks, returns the most recently
 * updated one. This is a best-effort fallback — the X-Source-Task-Id header
 * is the authoritative source when available.
 */
export async function getAgentCurrentTask(agentId: string): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'in_progress' ORDER BY lastUpdatedAt DESC LIMIT 1",
    [agentId],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function getTasksByStatus(status: AgentTaskStatus): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE status = ? ORDER BY createdAt DESC",
    [status],
  );
  return rows.map(rowToAgentTask);
}

/**
 * Find a task by VCS repo and issue/PR/MR number.
 * Returns the most recent non-terminal task for this VCS entity.
 *
 * Terminal exclusion MUST stay in lock-step with `TERMINAL_TASK_STATUSES`
 * in `src/types.ts`. SQL strings can't import a TS const — if you add a
 * new terminal status, grep for `NOT IN ('completed'` across this file.
 */
export async function findTaskByVcs(vcsRepo: string, vcsNumber: number): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ?
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY createdAt DESC
       LIMIT 1`,
    [vcsRepo, vcsNumber],
  );
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
  /** Exact canonical asset namespace. */
  key?: string;
  /** Canonical namespace subtree prefix. */
  keyPrefix?: string;
  /** Filter to tasks whose `source` is in this list. Empty/undefined → no filter. */
  source?: AgentTaskSource[];
  /** ISO 8601 timestamp; only return tasks where createdAt >= this. */
  createdAfter?: string;
  /** ISO 8601 timestamp; only return tasks where createdAt < this. */
  createdBefore?: string;
  /** Only return tasks requested by this canonical user. NULL rows are excluded. */
  requestedByUserId?: string;
  /** When set, restrict to rows where `requestedByUserId` IS NULL. Takes priority over `requestedByUserId`. */
  requestedByUserIdIsNull?: boolean;
  /** Sort list rows for either table freshness or timeline paging. */
  orderBy?: "lastUpdatedAt" | "createdAt";
  limit?: number;
  offset?: number;
  includeHeartbeat?: boolean;
}

export function getAllTasks(filters?: TaskFilters): Promise<AgentTask[]>;
export function getAllTasks(
  filters: TaskFilters | undefined,
  opts: { slim: true },
): Promise<AgentTaskSummary[]>;
export async function getAllTasks(
  filters?: TaskFilters,
  opts?: { slim?: boolean },
): Promise<AgentTask[] | AgentTaskSummary[]> {
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

  if (filters?.key) {
    conditions.push('"key" = ?');
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    conditions.push(`"key" LIKE ? ESCAPE '\\'`);
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
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

  if (filters?.createdBefore) {
    conditions.push("createdAt < ?");
    params.push(filters.createdBefore);
  }

  if (filters?.requestedByUserIdIsNull) {
    conditions.push("requestedByUserId IS NULL");
  } else if (filters?.requestedByUserId) {
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
  const orderBy =
    filters?.orderBy === "createdAt"
      ? "createdAt DESC, rowid DESC"
      : "lastUpdatedAt DESC, priority DESC";
  const query = `SELECT agent_tasks.*,
    (SELECT SUM(totalCostUsd) FROM session_costs WHERE session_costs.taskId = agent_tasks.id) AS totalCostUsd
    FROM agent_tasks ${whereClause}
    ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  const rows = await getDbClient().query<AgentTaskRow>(query, params);

  // Filter for ready tasks (dependencies met) if requested. Both the full and
  // the slim row shapes carry `id` + `dependsOn`, so the same predicate works.
  const filterReady = async <T extends { id: string; dependsOn: string[] }>(
    items: T[],
  ): Promise<T[]> => {
    const readyFlags = await Promise.all(
      items.map(async (task) => {
        if (!task.dependsOn || task.dependsOn.length === 0) return true;
        return (await checkDependencies(task.id)).ready;
      }),
    );
    return items.filter((_, i) => readyFlags[i]);
  };

  if (opts?.slim) {
    let tasks = rows.map(rowToAgentTaskSummary);
    if (filters?.readyOnly) tasks = await filterReady(tasks);
    return tasks;
  }

  let tasks = rows.map(rowToAgentTask);
  if (filters?.readyOnly) tasks = await filterReady(tasks);
  return tasks;
}

/**
 * Get total count of tasks matching the given filters (ignoring limit).
 * Used alongside getAllTasks to display accurate total counts in UI.
 */
export async function getTasksCount(
  filters?: Omit<TaskFilters, "limit" | "readyOnly">,
): Promise<number> {
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

  if (filters?.key) {
    conditions.push('"key" = ?');
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    conditions.push(`"key" LIKE ? ESCAPE '\\'`);
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
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

  if (filters?.createdBefore) {
    conditions.push("createdAt < ?");
    params.push(filters.createdBefore);
  }

  if (filters?.requestedByUserIdIsNull) {
    conditions.push("requestedByUserId IS NULL");
  } else if (filters?.requestedByUserId) {
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
  const query = `SELECT COUNT(*) as count FROM agent_tasks ${whereClause}`;

  const result = await getDbClient().get<{ count: number }>(query, params);

  return result?.count ?? 0;
}

/**
 * Get task statistics (counts by status) without any limit.
 * This is more efficient than fetching all tasks for stats purposes.
 */
export async function getTaskStats(): Promise<{
  total: number;
  unassigned: number;
  offered: number;
  reviewing: number;
  pending: number;
  in_progress: number;
  paused: number;
  completed: number;
  failed: number;
}> {
  const row = await getDbClient().get<{
    total: number;
    unassigned: number;
    offered: number;
    reviewing: number;
    pending: number;
    in_progress: number;
    paused: number;
    completed: number;
    failed: number;
  }>(
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
  );

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

export async function getCompletedSlackTasks(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status IN ('completed', 'failed')
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export async function getRecentlyFinishedWorkerTasks(): Promise<AgentTask[]> {
  // Query for finished tasks that haven't been notified yet
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND t.notifiedAt IS NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC LIMIT 50`,
  );
  return rows.map(rowToAgentTask);
}

/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export async function markTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = taskIds.map(() => "?").join(",");

  const result = await getDbClient().run(
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
export async function resetTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;

  const placeholders = taskIds.map(() => "?").join(",");

  const result = await getDbClient().run(
    `UPDATE agent_tasks SET notifiedAt = NULL
     WHERE id IN (${placeholders}) AND notifiedAt IS NOT NULL`,
    taskIds,
  );

  return result.changes;
}

export async function getInProgressSlackTasks(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status = 'in_progress'
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

export async function getSlackTasksMissingTree(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT task.* FROM agent_tasks task
       JOIN slack_render_v2_state state ON state.id = 1
       WHERE task.source = 'slack'
       AND task.slackChannelId IS NOT NULL
       AND task.slackThreadTs IS NOT NULL
       AND task.createdAt >= state.activated_at
       AND task.status NOT IN ('backlog', 'unassigned', 'superseded')
       AND NOT EXISTS (
         SELECT 1 FROM agent_tasks earlier
         WHERE earlier.source = 'slack'
         AND earlier.slackChannelId = task.slackChannelId
         AND earlier.slackThreadTs = task.slackThreadTs
         AND earlier.createdAt < state.activated_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM slack_messages tree
         WHERE tree.kind = 'tree'
         AND tree.channel_id = task.slackChannelId
         AND tree.thread_ts = task.slackThreadTs
       )
       ORDER BY task.lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

/**
 * Return sibling tasks for a given cross-ingress context key, optionally
 * filtered by status. The returned shape mirrors getInProgressSlackTasks for
 * consistency; callers can narrow further in TypeScript.
 *
 * See src/tasks/context-key.ts for the key schema.
 */
export async function getInProgressTasksByContextKey(
  contextKey: string,
  statuses: AgentTaskStatus[] = ["pending", "in_progress", "offered", "paused"],
): Promise<AgentTask[]> {
  if (!contextKey || statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status IN (${placeholders})
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
    [contextKey, ...statuses],
  );
  return rows.map(rowToAgentTask);
}

export type ExistingTrackerContextWorkReason = "active_task" | "linked_open_pr";

export type ExistingTrackerContextWork = {
  task: AgentTask;
  reason: ExistingTrackerContextWorkReason;
};

const LINEAR_TRACKER_CONTEXT_KEY_PREFIX = "task:trackers:linear:";

function isLinearTrackerContextKey(contextKey: string | null | undefined): contextKey is string {
  return !!contextKey && contextKey.startsWith(LINEAR_TRACKER_CONTEXT_KEY_PREFIX);
}

/**
 * Return existing work for a Linear tracker key before creating another task.
 *
 * Active means any non-terminal task. A completed task with persisted VCS PR/MR
 * metadata is also treated as existing work because the task can be complete
 * while the PR is still awaiting review/merge.
 */
export async function findExistingLinearTrackerContextWork(
  contextKey: string | null | undefined,
): Promise<ExistingTrackerContextWork | null> {
  if (!isLinearTrackerContextKey(contextKey)) return null;

  const activeRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [contextKey],
  );
  if (activeRow) {
    return { task: rowToAgentTask(activeRow), reason: "active_task" };
  }

  const linkedPrRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status = 'completed'
       AND vcsProvider IS NOT NULL
       AND vcsRepo IS NOT NULL
       AND vcsNumber IS NOT NULL
       AND vcsUrl IS NOT NULL
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [contextKey],
  );
  if (linkedPrRow) {
    return { task: rowToAgentTask(linkedPrRow), reason: "linked_open_pr" };
  }

  return null;
}

export async function getLatestTaskByContextKey(contextKey: string): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [contextKey],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function getLatestScriptRunStepTaskByContextKey(
  contextKey: string,
): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND taskType = 'script-run-step'
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [contextKey],
  );
  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent agent associated with a specific Slack thread.
 * No status filter — returns the last agent that touched this thread regardless of task state.
 * This is intentional: follow-up messages should route to the same agent even after task completion.
 * Callers (e.g. assistant.ts) apply their own status checks (e.g. agent.status !== "offline").
 */
export async function getAgentWorkingOnThread(
  channelId: string,
  threadTs: string,
): Promise<Agent | null> {
  const taskRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

  if (taskRow?.agentId) return getAgentById(taskRow.agentId);

  return null;
}

/**
 * Find the latest active (in_progress or pending) task in a specific Slack thread.
 * Used for dependency chaining in additive Slack buffer.
 */
export async function getLatestActiveTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       AND status IN ('in_progress', 'pending')
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the latest task assigned to a lead agent in a specific Slack thread.
 * Source is deliberately restricted to Slack ingress so inherited worker-task
 * metadata cannot become the thread's steering target.
 */
export async function getLatestLeadTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT t.*
       FROM agent_tasks t
       JOIN agents a ON a.id = t.agentId
       WHERE t.source = 'slack'
         AND t.slackChannelId = ?
         AND t.slackThreadTs = ?
         AND a.isLead = 1
       ORDER BY t.createdAt DESC, t.rowid DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent task in a Slack thread, regardless of source or status.
 * Unlike getAgentWorkingOnThread (which filters source='slack'), this finds ALL tasks
 * including worker tasks that inherited Slack metadata via parentTaskId.
 */
export async function getMostRecentTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [channelId, threadTs],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function findCompletedTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): Promise<AgentTask | null> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       AND status = 'completed'
       AND lastUpdatedAt > ?
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [channelId, threadTs, since],
  );
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
export async function findRecentCancelledTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): Promise<AgentTask | null> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
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
    [channelId, threadTs, since],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function completeTask(id: string, output?: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-complete a task already in a terminal state.
  // Mirrors cancelTask. Prevents duplicate task.completed events, duplicate
  // log entries, and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const row = await getDbClient().transaction(async () => {
    const finishedAt = new Date().toISOString();
    // The status predicate re-checks the idempotency guard atomically: the
    // await between the guard read above and this write lets a racing
    // terminal transition (e.g. heartbeat failTask) land first.
    let completed = await getDbClient().get<AgentTaskRow>(
      `UPDATE agent_tasks SET status = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
      ["completed", finishedAt, id],
    );
    if (!completed) return null;

    if (output) {
      completed = await getDbClient().get<AgentTaskRow>(
        "UPDATE agent_tasks SET output = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
        [scrubSecrets(output), id],
      );
    }
    if (completed) {
      await reconcileTaskPullRequestAttachments(id, completed.agentId, [
        completed.output,
        completed.vcsProvider === "github" ? completed.vcsUrl : null,
      ]);
    }
    return completed;
  });
  if (!row) return null;

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
      await createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "completed",
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.completed", {
            taskId: id,
            output,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.completed event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await promotePendingSteeringForTask(id, "Task completed before steering was delivered");
    } catch (error) {
      console.error(
        "[completeTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return row ? rowToAgentTask(row) : null;
}

export async function failTask(id: string, reason: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-fail a task already in a terminal state.
  // Mirrors cancelTask / completeTask. Prevents duplicate task.failed events
  // and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const scrubbedReason = scrubSecrets(reason);
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [scrubbedReason, finishedAt, id],
  );
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
      await createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "failed",
        metadata: { reason: scrubbedReason },
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.failed", {
            taskId: id,
            failureReason: reason,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.failed event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await promotePendingSteeringForTask(id, "Task failed before steering was delivered");
    } catch (error) {
      console.error(
        "[failTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    // Cascade-fail any non-terminal tasks that depend on this one.
    // The cascade is recursive (transitive closure) and cycle-safe.
    try {
      await cascadeFailDependents(id, "failed");
    } catch (err) {
      console.error("[failTask] cascade-fail dependents error:", err);
    }
  }
  return row ? rowToAgentTask(row) : null;
}

/**
 * Replace result text on an already-terminal task without replaying terminal
 * side effects or moving any lifecycle timestamps. Callers must opt in to
 * this narrow escape hatch; ordinary completion remains first-call-wins.
 */
export async function overwriteTerminalTaskResultText(
  id: string,
  patch: { output?: string; failureReason?: string },
): Promise<AgentTask | null> {
  const task = await getTaskById(id);
  if (!task || !isTerminalTaskStatus(task.status)) return null;

  const output = patch.output !== undefined ? scrubSecrets(patch.output) : (task.output ?? null);
  const failureReason =
    patch.failureReason !== undefined
      ? scrubSecrets(patch.failureReason)
      : (task.failureReason ?? null);
  const row = await getDbClient().transaction(async () => {
    const updated =
      (await getDbClient().get<AgentTaskRow>(
        `UPDATE agent_tasks SET output = ?, failureReason = ?
         WHERE id = ? AND status IN ('completed', 'failed', 'cancelled', 'superseded')
         RETURNING *`,
        [output, failureReason, id],
      )) ?? null;
    if (updated && patch.output !== undefined) {
      await reconcileTaskPullRequestAttachments(id, updated.agentId, [
        updated.output,
        updated.vcsProvider === "github" ? updated.vcsUrl : null,
      ]);
    }
    return updated;
  });

  return row ? rowToAgentTask(row) : task;
}

export async function cancelTask(id: string, reason?: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are not already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'cancelled', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [cancelReason, finishedAt, id],
  );

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
      await createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "cancelled",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.cancelled", {
            taskId: id,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.cancelled event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await promotePendingSteeringForTask(id, "Task was cancelled before steering was delivered");
    } catch (error) {
      console.error(
        "[cancelTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      await cascadeFailDependents(id, "cancelled");
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
export async function supersedeTask(
  id: string,
  args: { reason: string; resumeTaskId: string | null },
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-supersede a task already in a terminal state.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'superseded',
           finishedAt = ?,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       RETURNING *`,
    [finishedAt, id],
  );

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
      await createLogEntry({
        eventType: "task_superseded",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "superseded",
        metadata: { reason: args.reason, resumeTaskId: args.resumeTaskId },
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.superseded", {
            taskId: id,
            reason: args.reason,
            resumeTaskId: args.resumeTaskId,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.superseded event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });

    try {
      await cascadeFailDependents(id, "superseded");
    } catch (err) {
      console.error("[supersedeTask] cascade-fail dependents error:", err);
    }
  }

  return row ? rowToAgentTask(row) : null;
}

export async function backfillSupersedeTaskResumeTaskId(
  taskId: string,
  resumeTaskId: string,
): Promise<boolean> {
  const row = await getDbClient().get<{ id: string; metadata: string | null }>(
    `SELECT id, metadata
       FROM agent_log
       WHERE taskId = ? AND eventType = 'task_superseded'
       ORDER BY createdAt DESC
       LIMIT 1`,
    [taskId],
  );
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

  const result = await getDbClient().run("UPDATE agent_log SET metadata = ? WHERE id = ?", [
    JSON.stringify(metadata),
    row.id,
  ]);
  return result.changes > 0;
}

/**
 * Pause a task that is currently in progress.
 * Used during graceful shutdown to allow tasks to resume after container restart.
 * Unlike failTask, paused tasks retain their agent assignment and can be resumed.
 */
export async function pauseTask(id: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Only pause tasks that are in progress
  if (oldTask.status !== "in_progress") {
    return null;
  }

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'paused',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`,
    [id],
  );

  if (row && oldTask) {
    try {
      await createLogEntry({
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
export async function resumeTask(taskId: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(taskId);
  if (!oldTask || oldTask.status !== "paused") return null;

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'in_progress',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'paused'
       RETURNING *`,
    [taskId],
  );

  if (row && oldTask) {
    try {
      await createLogEntry({
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
export async function getPausedTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE agentId = ? AND status = 'paused'
       ORDER BY createdAt ASC, rowid ASC`,
    [agentId],
  );
  return rows.map(rowToAgentTask);
}

export async function getOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT t.* FROM agent_tasks t
       LEFT JOIN active_sessions s ON s.taskId = t.id
       WHERE t.agentId = ?
         AND t.status = 'in_progress'
         AND t.claudeSessionId IS NULL
         AND t.lastUpdatedAt < ?
         AND s.id IS NULL
         AND t.finishedAt IS NULL
       ORDER BY t.createdAt ASC, t.rowid ASC`,
    [agentId, cutoff],
  );
  return rows.map(rowToAgentTask);
}

export async function resetOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
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
    [agentId, cutoff],
  );

  for (const row of rows) {
    try {
      await createLogEntry({
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
export async function getRecentlyCancelledTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE agentId = ?
       AND status = 'cancelled'
       AND finishedAt > ?
       ORDER BY finishedAt DESC`,
    [agentId, fiveMinutesAgo],
  );
  return rows.map(rowToAgentTask);
}

export async function deleteTask(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function updateTaskProgress(id: string, progress: string): Promise<AgentTask | null> {
  const scrubbedProgress = scrubSecrets(progress);
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET progress = ?,
       status = CASE WHEN status IN ('completed', 'failed', 'cancelled', 'superseded') THEN status ELSE 'in_progress' END,
       lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [scrubbedProgress, id],
  );
  if (row) {
    try {
      await createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: scrubbedProgress,
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.progress", {
            taskId: id,
            progress: scrubbedProgress,
            agentId: row.agentId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.progress event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
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
  provider_id: string | null;
  provider_key: string | null;
  capabilities: string | null;
  agent_fs_org_id: string | null;
  agent_fs_drive_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  intent: string | null;
  description: string | null;
  is_primary: number;
  created_at: string;
  created_by: string | null;
  updated_by: string | null;
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
    providerId: row.provider_id ?? undefined,
    providerKey: row.provider_key ?? undefined,
    capabilities: parseAttachmentCapabilities(row.capabilities),
    orgId: row.agent_fs_org_id ?? undefined,
    driveId: row.agent_fs_drive_id ?? undefined,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    sha256: row.sha256 ?? undefined,
    intent: row.intent ?? undefined,
    description: row.description ?? undefined,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

function parseAttachmentCapabilities(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringifyAttachmentCapabilities(
  value: Record<string, unknown> | undefined,
): string | null {
  return value ? JSON.stringify(value) : null;
}

export interface InsertTaskAttachmentInput {
  taskId: string;
  agentId: string | null;
  name: string;
  kind: TaskAttachment["kind"];
  url?: string;
  path?: string;
  pageId?: string;
  providerId?: string;
  providerKey?: string;
  capabilities?: Record<string, unknown>;
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
  createdBy?: string;
  updatedBy?: string;
}

/**
 * Insert a task attachment. Append-only + dedup:
 *   - if sha256 is present and a row for this task already has that sha256,
 *     skip (return existing row);
 *   - otherwise skip if a row exists for the same task with the same
 *     (kind, path|url|page_id, name) tuple.
 * Returns the stored attachment (newly inserted or pre-existing duplicate).
 */
export async function insertTaskAttachment(
  input: InsertTaskAttachmentInput,
): Promise<TaskAttachment> {
  return await getDbClient().transaction(async () => {
    const attachment = await insertTaskAttachmentRow(input);
    if (attachment.kind === "agent-fs" && attachment.providerId && attachment.providerKey) {
      const task = await getTaskById(input.taskId);
      if (!task) throw new Error(`Task not found while mapping attachment: ${input.taskId}`);
      await upsertAssetKeyMapping({
        providerId: attachment.providerId,
        providerOrgId: attachment.orgId,
        providerDriveId: attachment.driveId,
        providerKey: attachment.providerKey,
        key: task.key,
        sourceEntityType: "task-attachment",
        sourceEntityId: attachment.id,
        createdBy: input.createdBy,
        updatedBy: input.updatedBy,
      });
    }
    return attachment;
  });
}

const GENERATED_PULL_REQUEST_PROVIDER_ID = "github";
const GENERATED_PULL_REQUEST_INTENT = "task-deliverable";
const GENERATED_PULL_REQUEST_DESCRIPTION = "Pull request shipped by this task";
const GENERATED_PULL_REQUEST_SOURCE = "task-pull-request-recorder";

function pullRequestKey(pullRequest: { owner: string; repo: string; number: number }): string {
  return `${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${pullRequest.number}`;
}

/**
 * Persist PRs detected by server-owned task lifecycle paths. Existing URL
 * attachments win regardless of display name, so an agent-authored row and an
 * automatic row never duplicate the same task deliverable. A capability key
 * rejected by AttachmentInputSchema marks server-generated rows so
 * reconciliation cannot mistake caller-authored metadata for provenance.
 */
export async function recordTaskPullRequestAttachments(
  taskId: string,
  agentId: string | null,
  text: string | null | undefined,
): Promise<TaskAttachment[]> {
  const pullRequests = extractGitHubPullRequestUrls(text);
  if (pullRequests.length === 0) return [];

  const existingRows = await getDbClient().query<{ url: string }>(
    "SELECT url FROM task_attachments WHERE task_id = ? AND kind = 'url' AND url IS NOT NULL",
    [taskId],
  );
  const existingPullRequests = new Set(
    existingRows.flatMap((row) => extractGitHubPullRequestUrls(row.url)).map(pullRequestKey),
  );
  const stored: TaskAttachment[] = [];
  for (const pullRequest of pullRequests) {
    const dedupeKey = pullRequestKey(pullRequest);
    if (existingPullRequests.has(dedupeKey)) continue;
    stored.push(
      await insertTaskAttachment({
        taskId,
        agentId,
        name: `GitHub pull request #${pullRequest.number}`,
        kind: "url",
        url: pullRequest.url,
        providerId: GENERATED_PULL_REQUEST_PROVIDER_ID,
        capabilities: {
          [SERVER_GENERATED_ATTACHMENT_CAPABILITY]: GENERATED_PULL_REQUEST_SOURCE,
        },
        intent: GENERATED_PULL_REQUEST_INTENT,
        description: GENERATED_PULL_REQUEST_DESCRIPTION,
      }),
    );
    existingPullRequests.add(dedupeKey);
  }
  return stored;
}

/** Reconcile only lifecycle-generated PR rows against their current source text. */
async function reconcileTaskPullRequestAttachments(
  taskId: string,
  agentId: string | null,
  sourceTexts: Array<string | null | undefined>,
): Promise<TaskAttachment[]> {
  const desiredPullRequests = sourceTexts.flatMap(extractGitHubPullRequestUrls);
  const desiredKeys = new Set(desiredPullRequests.map(pullRequestKey));
  const generatedRows = await getDbClient().query<{ id: string; name: string; url: string }>(
    `SELECT id, name, url
     FROM task_attachments
     WHERE task_id = ?
       AND kind = 'url'
       AND url IS NOT NULL
       AND json_extract(capabilities, '$.${SERVER_GENERATED_ATTACHMENT_CAPABILITY}') = ?`,
    [taskId, GENERATED_PULL_REQUEST_SOURCE],
  );

  for (const row of generatedRows) {
    const pullRequest = extractGitHubPullRequestUrls(row.url)[0];
    const expectedName = pullRequest ? `GitHub pull request #${pullRequest.number}` : null;
    if (
      !pullRequest ||
      row.name !== expectedName ||
      !desiredKeys.has(pullRequestKey(pullRequest))
    ) {
      await getDbClient().run("DELETE FROM task_attachments WHERE id = ?", [row.id]);
    }
  }

  return await recordTaskPullRequestAttachments(
    taskId,
    agentId,
    desiredPullRequests.map((pullRequest) => pullRequest.url).join("\n"),
  );
}

async function insertTaskAttachmentRow(input: InsertTaskAttachmentInput): Promise<TaskAttachment> {
  if (input.sha256) {
    const existing = await getDbClient().get<TaskAttachmentRow>(
      "SELECT * FROM task_attachments WHERE task_id = ? AND sha256 = ? LIMIT 1",
      [input.taskId, input.sha256],
    );
    if (existing) return rowToTaskAttachment(existing);
  }

  const tupleExisting = await getDbClient().get<TaskAttachmentRow>(
    `SELECT * FROM task_attachments
       WHERE task_id = ?
         AND kind = ?
         AND IFNULL(path, '')    = ?
         AND IFNULL(url, '')     = ?
         AND IFNULL(page_id, '') = ?
         AND name = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    [input.taskId, input.kind, input.path ?? "", input.url ?? "", input.pageId ?? "", input.name],
  );
  if (tupleExisting) return rowToTaskAttachment(tupleExisting);

  const id = crypto.randomUUID();
  const row = await getDbClient().get<TaskAttachmentRow>(
    `INSERT INTO task_attachments
         (id, task_id, agent_id, name, kind, url, path, page_id,
          provider_id, provider_key, capabilities,
          agent_fs_org_id, agent_fs_drive_id,
          mime_type, size_bytes, sha256, intent, description, is_primary,
          created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
      id,
      input.taskId,
      input.agentId ?? null,
      input.name,
      input.kind,
      input.url ?? null,
      input.path ?? null,
      input.pageId ?? null,
      input.providerId ?? defaultProviderId(input.kind),
      input.providerKey ?? defaultProviderKey(input),
      stringifyAttachmentCapabilities(input.capabilities),
      input.orgId ?? null,
      input.driveId ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      input.intent ?? null,
      input.description ?? null,
      input.isPrimary ? 1 : 0,
      input.createdBy ?? null,
      input.updatedBy ?? input.createdBy ?? null,
    ],
  );

  if (!row) {
    throw new Error("Failed to insert task attachment");
  }
  return rowToTaskAttachment(row);
}

function defaultProviderId(kind: TaskAttachment["kind"]): string {
  if (kind === "agent-fs" || kind === "shared-fs") return "agent-fs";
  return kind;
}

function defaultProviderKey(
  input: Pick<InsertTaskAttachmentInput, "kind" | "path" | "url" | "pageId">,
): string | null {
  if (input.kind === "agent-fs" || input.kind === "shared-fs") return input.path ?? null;
  if (input.kind === "url") return input.url ?? null;
  if (input.kind === "page") return input.pageId ?? null;
  return null;
}

// ============================================================================
// Cross-entity asset namespaces + logical provider mappings
// ============================================================================

type AssetKeyMappingRow = {
  id: string;
  provider_id: string;
  provider_org_id: string;
  provider_drive_id: string;
  provider_key: string;
  key: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

function rowToAssetKeyMapping(row: AssetKeyMappingRow): AssetKeyMapping {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerOrgId: row.provider_org_id || undefined,
    providerDriveId: row.provider_drive_id || undefined,
    providerKey: row.provider_key,
    key: row.key,
    sourceEntityType:
      (row.source_entity_type as "task-attachment" | "external" | null) ?? undefined,
    sourceEntityId: row.source_entity_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export interface UpsertAssetKeyMappingInput {
  providerId: string;
  providerOrgId?: string;
  providerDriveId?: string;
  providerKey: string;
  key?: string;
  sourceEntityType?: "task-attachment" | "external";
  sourceEntityId?: string;
  createdBy?: string;
  updatedBy?: string;
}

async function insertAssetKeyHistory(input: {
  entityType: AssetEntityType;
  entityId: string;
  previousKey?: string | null;
  newKey: string;
  changedBy?: string;
}): Promise<void> {
  await getDbClient().run(
    `INSERT INTO asset_key_history
       (id, entity_type, entity_id, previous_key, new_key, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      input.entityType,
      input.entityId,
      input.previousKey ?? null,
      input.newKey,
      input.changedBy ?? null,
    ],
  );
}

export async function getAssetKeyMappingByProvider(input: {
  providerId: string;
  providerOrgId?: string;
  providerDriveId?: string;
  providerKey: string;
}): Promise<AssetKeyMapping | null> {
  const row = await getDbClient().get<AssetKeyMappingRow>(
    `SELECT * FROM asset_key_mappings
       WHERE provider_id = ? AND provider_org_id = ?
         AND provider_drive_id = ? AND provider_key = ?`,
    [input.providerId, input.providerOrgId ?? "", input.providerDriveId ?? "", input.providerKey],
  );
  return row ? rowToAssetKeyMapping(row) : null;
}

/**
 * Idempotently project a provider tuple into a logical namespace. Updating the
 * namespace never calls the provider and never renames remote content.
 */
export async function upsertAssetKeyMapping(
  input: UpsertAssetKeyMappingInput,
): Promise<AssetKeyMapping> {
  if (!input.providerId.trim()) throw new Error("providerId is required");
  if (!input.providerKey.trim()) throw new Error("providerKey is required");
  const now = new Date().toISOString();

  return await getDbClient().transaction(async (tx) => {
    const existing = await getAssetKeyMappingByProvider(input);
    if (existing) {
      const key = normalizeAssetKey(input.key ?? existing.key);
      const row = await tx.get<AssetKeyMappingRow>(
        `UPDATE asset_key_mappings
           SET "key" = ?, source_entity_type = ?, source_entity_id = ?,
               updated_at = ?, updated_by = ?
           WHERE id = ? RETURNING *`,
        [
          key,
          input.sourceEntityType ?? existing.sourceEntityType ?? null,
          input.sourceEntityId ?? existing.sourceEntityId ?? null,
          now,
          input.updatedBy ?? input.createdBy ?? existing.updatedBy ?? null,
          existing.id,
        ],
      );
      if (!row) throw new Error("Failed to update asset key mapping");
      if (existing.key !== key) {
        await insertAssetKeyHistory({
          entityType: "file",
          entityId: existing.id,
          previousKey: existing.key,
          newKey: key,
          changedBy: input.updatedBy ?? input.createdBy,
        });
      }
      return rowToAssetKeyMapping(row);
    }

    const id = crypto.randomUUID();
    const key = normalizeAssetKey(
      input.key ?? defaultAssetKey(`fs:${input.providerId.trim()}`, id),
    );
    const row = await tx.get<AssetKeyMappingRow>(
      `INSERT INTO asset_key_mappings (
           id, provider_id, provider_org_id, provider_drive_id, provider_key,
           "key", source_entity_type, source_entity_id,
           created_at, updated_at, created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [
        id,
        input.providerId.trim(),
        input.providerOrgId ?? "",
        input.providerDriveId ?? "",
        input.providerKey,
        key,
        input.sourceEntityType ?? "external",
        input.sourceEntityId ?? null,
        now,
        now,
        input.createdBy ?? null,
        input.updatedBy ?? input.createdBy ?? null,
      ],
    );
    if (!row) throw new Error("Failed to create asset key mapping");
    await insertAssetKeyHistory({
      entityType: "file",
      entityId: id,
      newKey: key,
      changedBy: input.createdBy,
    });
    return rowToAssetKeyMapping(row);
  });
}

export async function getAssetKeyMapping(id: string): Promise<AssetKeyMapping | null> {
  const row = await getDbClient().get<AssetKeyMappingRow>(
    "SELECT * FROM asset_key_mappings WHERE id = ?",
    [id],
  );
  return row ? rowToAssetKeyMapping(row) : null;
}

export interface AssetSummaryFilters {
  keyPrefix?: string;
  types?: AssetEntityType[];
  limit?: number;
}

type AssetSummaryRow = {
  entityType: AssetEntityType;
  id: string;
  key: string;
  label: string;
  updatedAt: string;
  providerId: string | null;
  providerOrgId: string | null;
  providerDriveId: string | null;
  providerKey: string | null;
};

function assetSummaryQueries(types: Set<AssetEntityType>): string[] {
  const queries: string[] = [];
  if (types.has("task")) {
    queries.push(
      `SELECT 'task' AS entityType, id, "key", 'Task ' || substr(id, 1, 8) AS label,
              lastUpdatedAt AS updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM agent_tasks`,
    );
  }
  if (types.has("workflow")) {
    queries.push(
      `SELECT 'workflow' AS entityType, id, "key", name AS label,
              lastUpdatedAt AS updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM workflows`,
    );
  }
  if (types.has("schedule")) {
    queries.push(
      `SELECT 'schedule' AS entityType, id, "key", name AS label,
              lastUpdatedAt AS updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM scheduled_tasks`,
    );
  }
  if (types.has("page")) {
    queries.push(
      `SELECT 'page' AS entityType, id, "key", title AS label,
              updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM pages`,
    );
  }
  if (types.has("app")) {
    queries.push(
      `SELECT 'app' AS entityType, id, "key", name AS label,
              updated_at AS updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM apps`,
    );
  }
  if (types.has("script")) {
    queries.push(
      `SELECT 'script' AS entityType, id, "key", name AS label,
              updatedAt, NULL AS providerId, NULL AS providerOrgId,
              NULL AS providerDriveId, NULL AS providerKey
       FROM scripts`,
    );
  }
  if (types.has("file")) {
    queries.push(
      `SELECT 'file' AS entityType, id, "key", provider_key AS label,
              updated_at AS updatedAt, provider_id AS providerId,
              NULLIF(provider_org_id, '') AS providerOrgId,
              NULLIF(provider_drive_id, '') AS providerDriveId,
              provider_key AS providerKey
       FROM asset_key_mappings`,
    );
  }
  return queries;
}

export async function listAssetSummaries(filters?: AssetSummaryFilters): Promise<AssetSummary[]> {
  const requestedTypes = new Set<AssetEntityType>(
    filters?.types?.length
      ? filters.types
      : ["task", "workflow", "schedule", "page", "app", "script", "file"],
  );
  const queries = assetSummaryQueries(requestedTypes);
  if (queries.length === 0) return [];
  const limit = Math.min(Math.max(filters?.limit ?? 500, 1), 1000);
  const params: (string | number)[] = [];
  let query = `SELECT * FROM (${queries.join(" UNION ALL ")})`;
  if (filters?.keyPrefix) {
    query += ` WHERE "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
  }
  query += ' ORDER BY "key" ASC, updatedAt DESC LIMIT ?';
  params.push(limit);
  const rows = await getDbClient().query<AssetSummaryRow>(query, params);

  return rows.map((row) => ({
    entityType: row.entityType,
    id: row.id,
    key: row.key,
    label: row.label,
    updatedAt: row.updatedAt,
    providerRef:
      row.providerId && row.providerKey
        ? {
            providerId: row.providerId,
            orgId: row.providerOrgId ?? undefined,
            driveId: row.providerDriveId ?? undefined,
            providerKey: row.providerKey,
          }
        : undefined,
  }));
}

async function currentAssetKey(entityType: AssetEntityType, id: string): Promise<string | null> {
  switch (entityType) {
    case "task": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM agent_tasks WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "workflow": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM workflows WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "schedule": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM scheduled_tasks WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "page": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM pages WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "app": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM apps WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "script": {
      const row = await getDbClient().get<{ key: string }>(
        'SELECT "key" AS key FROM scripts WHERE id = ?',
        [id],
      );
      return row?.key ?? null;
    }
    case "file": {
      const mapping = await getAssetKeyMapping(id);
      return mapping?.key ?? null;
    }
  }
}

export async function moveAssetKey(input: {
  entityType: AssetEntityType;
  id: string;
  key: string;
  changedBy?: string;
}): Promise<boolean> {
  const key = normalizeAssetKey(input.key);
  // auditAssetKeys stays sync (shared with the boot audit); run it inside a
  // client transaction so this request-path read cannot observe another
  // request's uncommitted writes on the shared connection.
  const audit = await getDbClient().transaction(async () => auditAssetKeys(getDb()), {
    readOnly: true,
  });
  if (!audit.ok) {
    throw new Error(
      "Asset namespace moves are blocked until structural errors, unknown personal users, or provider mapping drift are repaired.",
    );
  }
  const previousKey = await currentAssetKey(input.entityType, input.id);
  if (!previousKey) return false;
  if (previousKey === key) return true;
  if (input.entityType === "file") {
    const mapping = await getAssetKeyMapping(input.id);
    if (mapping?.sourceEntityType === "task-attachment") {
      throw new Error(
        "Task attachment namespaces move with their parent task; move the task instead.",
      );
    }
  }
  const now = new Date().toISOString();

  await getDbClient().transaction(async (tx) => {
    switch (input.entityType) {
      case "task": {
        const mappedFiles = await tx.query<{ id: string; key: string }>(
          `SELECT DISTINCT m.id, m."key" AS key
             FROM asset_key_mappings m
             JOIN task_attachments a
               ON m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
              AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
              AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
              AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
             WHERE a.task_id = ?`,
          [input.id],
        );
        await tx.run(
          'UPDATE agent_tasks SET "key" = ?, lastUpdatedAt = ?, updated_by = ? WHERE id = ?',
          [key, now, input.changedBy ?? null, input.id],
        );
        await tx.run(
          `UPDATE asset_key_mappings
           SET "key" = ?, updated_at = ?, updated_by = ?
           WHERE EXISTS (
             SELECT 1 FROM task_attachments a
             WHERE a.task_id = ?
               AND asset_key_mappings.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
               AND asset_key_mappings.provider_org_id = COALESCE(a.agent_fs_org_id, '')
               AND asset_key_mappings.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
               AND asset_key_mappings.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
           )`,
          [key, now, input.changedBy ?? null, input.id],
        );
        for (const mapping of mappedFiles) {
          if (mapping.key === key) continue;
          await insertAssetKeyHistory({
            entityType: "file",
            entityId: mapping.id,
            previousKey: mapping.key,
            newKey: key,
            changedBy: input.changedBy,
          });
        }
        break;
      }
      case "workflow":
        await tx.run(
          'UPDATE workflows SET "key" = ?, lastUpdatedAt = ?, updated_by = ? WHERE id = ?',
          [key, now, input.changedBy ?? null, input.id],
        );
        break;
      case "schedule":
        await tx.run(
          'UPDATE scheduled_tasks SET "key" = ?, lastUpdatedAt = ?, updated_by = ? WHERE id = ?',
          [key, now, input.changedBy ?? null, input.id],
        );
        break;
      case "page":
        await tx.run('UPDATE pages SET "key" = ?, updatedAt = ?, updated_by = ? WHERE id = ?', [
          key,
          now,
          input.changedBy ?? null,
          input.id,
        ]);
        break;
      case "app":
        await tx.run('UPDATE apps SET "key" = ?, updated_at = ? WHERE id = ?', [
          key,
          now,
          input.id,
        ]);
        break;
      case "script":
        await tx.run('UPDATE scripts SET "key" = ?, updatedAt = ?, updated_by = ? WHERE id = ?', [
          key,
          now,
          input.changedBy ?? null,
          input.id,
        ]);
        break;
      case "file":
        await tx.run(
          'UPDATE asset_key_mappings SET "key" = ?, updated_at = ?, updated_by = ? WHERE id = ?',
          [key, now, input.changedBy ?? null, input.id],
        );
        break;
    }
    await insertAssetKeyHistory({
      entityType: input.entityType,
      entityId: input.id,
      previousKey,
      newKey: key,
      changedBy: input.changedBy,
    });
  });
  return true;
}

export async function deleteTaskAttachment(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM task_attachments WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function replaceTaskAttachment(
  id: string,
  input: Omit<InsertTaskAttachmentInput, "taskId">,
): Promise<TaskAttachment | null> {
  const row = await getDbClient().get<TaskAttachmentRow>(
    `UPDATE task_attachments
       SET agent_id = ?,
           name = ?,
           kind = ?,
           url = ?,
           path = ?,
           page_id = ?,
           provider_id = ?,
           provider_key = ?,
           capabilities = ?,
           agent_fs_org_id = ?,
           agent_fs_drive_id = ?,
           mime_type = ?,
           size_bytes = ?,
           sha256 = ?,
           intent = ?,
           description = ?,
           is_primary = ?,
           updated_by = ?
       WHERE id = ?
       RETURNING *`,
    [
      input.agentId ?? null,
      input.name,
      input.kind,
      input.url ?? null,
      input.path ?? null,
      input.pageId ?? null,
      input.providerId ?? defaultProviderId(input.kind),
      input.providerKey ?? defaultProviderKey(input),
      stringifyAttachmentCapabilities(input.capabilities),
      input.orgId ?? null,
      input.driveId ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      input.intent ?? null,
      input.description ?? null,
      input.isPrimary ? 1 : 0,
      input.updatedBy ?? null,
      id,
    ],
  );

  return row ? rowToTaskAttachment(row) : null;
}

export async function getTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const rows = await getDbClient().query<TaskAttachmentRow>(
    "SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC",
    [taskId],
  );
  return rows.map(rowToTaskAttachment);
}

// ============================================================================
// Task Steering Messages
// ============================================================================

type TaskSteeringMessageRow = {
  id: string;
  task_id: string;
  body: string;
  mode: string;
  status: string;
  delivered_mode: string | null;
  source: string;
  created_by_kind: string;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  promoted_task_id: string | null;
  created_at: string;
  delivered_at: string | null;
  handled_at: string | null;
  handled_note: string | null;
};

function rowToSteeringMessage(row: TaskSteeringMessageRow): SteeringMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    mode: row.mode as SteerMode,
    status: row.status as SteeringStatus,
    deliveredMode: (row.delivered_mode as SteerMode | null) ?? undefined,
    source: row.source as SteeringSource,
    createdByKind: row.created_by_kind as SteeringMessage["createdByKind"],
    createdByUserId: row.created_by_user_id ?? undefined,
    createdByAgentId: row.created_by_agent_id ?? undefined,
    promotedTaskId: row.promoted_task_id ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    handledAt: row.handled_at ?? undefined,
    handledNote: row.handled_note ?? undefined,
  };
}

export interface CreateSteeringMessageArgs {
  taskId: string;
  body: string;
  mode: SteerMode;
  source: SteeringSource;
  createdByKind: SteeringMessage["createdByKind"];
  createdByUserId?: string;
  createdByAgentId?: string;
}

export async function createSteeringMessage(
  args: CreateSteeringMessageArgs,
): Promise<SteeringMessage> {
  const id = crypto.randomUUID();
  const row = await getDbClient().get<TaskSteeringMessageRow>(
    `INSERT INTO task_steering_messages
         (id, task_id, body, mode, source, created_by_kind,
          created_by_user_id, created_by_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
      id,
      args.taskId,
      args.body,
      args.mode,
      args.source,
      args.createdByKind,
      args.createdByUserId ?? null,
      args.createdByAgentId ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create steering message");

  try {
    await createLogEntry({
      eventType: "task_steering",
      taskId: args.taskId,
      agentId: args.createdByAgentId,
      newValue: "pending",
      metadata: {
        steeringMessageId: id,
        mode: args.mode,
        source: args.source,
      },
    });
  } catch {}

  return rowToSteeringMessage(row);
}

export async function getSteeringMessagesForTask(
  taskId: string,
  opts?: { status?: SteeringStatus },
): Promise<SteeringMessage[]> {
  const rows = opts?.status
    ? await getDbClient().query<TaskSteeringMessageRow>(
        `SELECT * FROM task_steering_messages
           WHERE task_id = ? AND status = ?
           ORDER BY created_at ASC, rowid ASC`,
        [taskId, opts.status],
      )
    : await getDbClient().query<TaskSteeringMessageRow>(
        `SELECT * FROM task_steering_messages
           WHERE task_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        [taskId],
      );
  return rows.map(rowToSteeringMessage);
}

export async function getSteeringMessageById(id: string): Promise<SteeringMessage | null> {
  const row = await getDbClient().get<TaskSteeringMessageRow>(
    `SELECT * FROM task_steering_messages
       WHERE id = ?`,
    [id],
  );
  return row ? rowToSteeringMessage(row) : null;
}

export async function getPendingSteeringForTask(taskId: string): Promise<SteeringMessage[]> {
  return await getSteeringMessagesForTask(taskId, { status: "pending" });
}

export async function getPendingSteeringForAgent(agentId: string): Promise<SteeringMessage[]> {
  const rows = await getDbClient().query<TaskSteeringMessageRow>(
    `SELECT m.*
       FROM task_steering_messages m
       JOIN agent_tasks t ON t.id = m.task_id
       WHERE t.agentId = ? AND m.status = 'pending'
       ORDER BY m.created_at ASC, m.rowid ASC`,
    [agentId],
  );
  return rows.map(rowToSteeringMessage);
}

export async function markSteeringDelivered(
  id: string,
  deliveredMode: SteerMode,
): Promise<SteeringMessage | null> {
  const row = await getDbClient().get<TaskSteeringMessageRow>(
    `UPDATE task_steering_messages
       SET status = 'delivered',
           delivered_mode = ?,
           delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
    [deliveredMode, id],
  );

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_steering",
        taskId: row.task_id,
        newValue: "delivered",
        metadata: {
          steeringMessageId: id,
          requestedMode: row.mode,
          deliveredMode,
        },
      });
    } catch {}
  }

  return row ? rowToSteeringMessage(row) : null;
}

export async function markSteeringHandled(
  id: string,
  note?: string,
): Promise<SteeringMessage | null> {
  const row = await getDbClient().get<TaskSteeringMessageRow>(
    `UPDATE task_steering_messages
       SET status = 'handled',
           handled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           handled_note = ?
       WHERE id = ? AND status = 'delivered'
       RETURNING *`,
    [note ?? null, id],
  );
  return row ? rowToSteeringMessage(row) : null;
}

export async function markSteeringPromoted(
  id: string,
  promotedTaskId: string,
): Promise<SteeringMessage | null> {
  const row = await getDbClient().get<TaskSteeringMessageRow>(
    `UPDATE task_steering_messages
       SET status = 'promoted',
           promoted_task_id = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
    [promotedTaskId, id],
  );
  return row ? rowToSteeringMessage(row) : null;
}

export async function cancelPendingSteeringForTask(taskId: string): Promise<number> {
  const result = await getDbClient().run(
    `UPDATE task_steering_messages
       SET status = 'cancelled'
       WHERE task_id = ? AND status = 'pending'`,
    [taskId],
  );
  return result.changes;
}

export async function hasPendingSteering(taskId: string): Promise<boolean> {
  const row = await getDbClient().get<{ present: number }>(
    `SELECT 1 AS present
         FROM task_steering_messages
         WHERE task_id = ? AND status = 'pending'
         LIMIT 1`,
    [taskId],
  );
  return row !== null;
}

// ============================================================================
// Combined Queries (Agent with Tasks)
// ============================================================================

export async function getAgentWithTasks(id: string): Promise<AgentWithTasks | null> {
  return await getDbClient().transaction(
    async () => {
      const agent = await getAgentById(id);
      if (!agent) return null;

      const tasks = await getTasksByAgentId(id);
      return { ...agent, tasks };
    },
    { readOnly: true },
  );
}

export async function getAllAgentsWithTasks(opts?: { slim?: boolean }): Promise<AgentWithTasks[]> {
  return await getDbClient().transaction(
    async () => {
      const agents = await getAllAgents({ slim: opts?.slim ?? false });
      return await Promise.all(
        agents.map(async (agent) => ({
          ...agent,
          tasks: await getTasksByAgentId(agent.id),
        })),
      );
    },
    { readOnly: true },
  );
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

export async function createLogEntry(entry: {
  eventType: AgentLogEventType;
  agentId?: string;
  taskId?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentLog> {
  const id = crypto.randomUUID();
  const metaJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
  const row = await getDbClient().get<AgentLogRow>(
    `INSERT INTO agent_log (id, eventType, agentId, taskId, oldValue, newValue, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    [
      id,
      entry.eventType,
      entry.agentId ?? null,
      entry.taskId ?? null,
      entry.oldValue ?? null,
      entry.newValue ? scrubSecrets(entry.newValue) : null,
      metaJson ? scrubSecrets(metaJson) : null,
    ],
  );
  if (!row) throw new Error("Failed to create log entry");
  return rowToAgentLog(row);
}

export async function getLogsByAgentId(agentId: string): Promise<AgentLog[]> {
  const rows = await getDbClient().query<AgentLogRow>(
    "SELECT * FROM agent_log WHERE agentId = ? ORDER BY createdAt DESC",
    [agentId],
  );
  return rows.map(rowToAgentLog);
}

export async function getLogsByTaskId(taskId: string, limit = 200): Promise<AgentLog[]> {
  const rows = await getDbClient().query<AgentLogRow>(
    "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    [taskId, limit],
  );
  return rows.map(rowToAgentLog);
}

export async function getLogsByTaskIdChronological(taskId: string): Promise<AgentLog[]> {
  const rows = await getDbClient().query<AgentLogRow>(
    "SELECT * FROM agent_log WHERE taskId = ? ORDER BY createdAt ASC",
    [taskId],
  );
  return rows.map(rowToAgentLog);
}

/**
 * Phase 6: list all log rows of a given eventType, newest first. Used by the
 * REST audit-log tests to assert mutation rows landed.
 */
export async function getLogsByEventType(eventType: AgentLogEventType): Promise<AgentLog[]> {
  const rows = await getDbClient().query<AgentLogRow>(
    "SELECT * FROM agent_log WHERE eventType = ? ORDER BY createdAt DESC",
    [eventType],
  );
  return rows.map(rowToAgentLog);
}

export async function getAllLogs(limit?: number): Promise<AgentLog[]> {
  if (limit) {
    const rows = await getDbClient().query<AgentLogRow>(
      "SELECT * FROM agent_log WHERE eventType != 'agent_status_change' ORDER BY createdAt DESC LIMIT ?",
      [limit],
    );
    return rows.map(rowToAgentLog);
  }
  const rows = await getDbClient().query<AgentLogRow>(
    "SELECT * FROM agent_log ORDER BY createdAt DESC",
  );
  return rows.map(rowToAgentLog);
}

// ============================================================================
// Task Pool Operations
// ============================================================================

// The runtime contract for task creation lives in src/types.ts
// (`CreateTaskOptionsSchema`); `createTaskExtended` parses options against it.
// The type is re-exported so existing importers (src/tasks/sibling-awareness.ts)
// keep resolving it from this module.
export type { CreateTaskOptions } from "../types";

/**
 * Find recent tasks within a time window for deduplication checks.
 * Returns tasks created in the last N minutes, optionally filtered by creator or target agent.
 */
export async function findRecentSimilarTasks(opts: {
  windowMinutes?: number;
  creatorAgentId?: string;
  agentId?: string;
  limit?: number;
}): Promise<AgentTask[]> {
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

  const rows = await getDbClient().query<AgentTaskRow>(query, params);
  return rows.map(rowToAgentTask);
}

export async function createTaskExtended(
  task: string,
  options?: CreateTaskOptions,
): Promise<AgentTask> {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new Error("createTaskExtended: 'task' must be a non-empty string");
  }
  // Single runtime enforcement point for every task write (REST, MCP,
  // scripts bridge, webhooks, scheduler, internal callers). Reject, never
  // coerce: a bad shape throws before anything reaches the INSERT; absent
  // fields keep the `??` defaults at the bind site below.
  options = CreateTaskOptionsSchema.parse(options ?? {});
  let requestedByUserIdInherited = false;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // `status: "draft"` wins over offeredTo/agentId — a draft task keeps its
  // intended owner/offer for when it's promoted (#1240), but must not be
  // dispatch-eligible while attachments are still uploading.
  const status: AgentTaskStatus =
    options?.status === "draft"
      ? "draft"
      : options?.offeredTo
        ? "offered"
        : options?.agentId
          ? "pending"
          : options?.status === "backlog"
            ? "backlog"
            : "unassigned";

  // Inherit Slack/AgentMail metadata from parent task (unless explicitly overridden)
  if (options?.parentTaskId) {
    const parent = await getTaskById(options.parentTaskId);
    if (parent) {
      // Identity & routing — anything that says "what work is this, who asked
      // for it, where does it run" carries forward to every child (follow-ups,
      // reboot retries, resume tasks). Explicit options always win.
      //
      // When adding a new identity-shaped column to `agent_tasks`, ADD IT HERE
      // unless you have a specific reason a child should NOT inherit it. This
      // is the single source of truth — `createResumeFollowUp` and the other
      // follow-up creators rely on this block instead of re-listing fields.

      // Slack context — inherited as an atomic unit. A foreign channelId's
      // thread ts is meaningless to Slack's API, so an explicit slackChannelId
      // that DIFFERS from the parent's must not pull in the parent's
      // slackThreadTs/slackUserId (that combination misroutes/fails to thread —
      // see swarm memory dispatch-slack-channel-must-match-parent-context-2026-07-10).
      // When the explicit channel matches the parent's (or is unset), per-field
      // fill-in proceeds as before.
      const explicitForeignChannel =
        !!options.slackChannelId &&
        !!parent.slackChannelId &&
        options.slackChannelId !== parent.slackChannelId;
      if (parent.slackChannelId && !options.slackChannelId) {
        options.slackChannelId = parent.slackChannelId;
      }
      if (parent.slackThreadTs && !options.slackThreadTs && !explicitForeignChannel) {
        options.slackThreadTs = parent.slackThreadTs;
      }
      if (parent.slackUserId && !options.slackUserId && !explicitForeignChannel) {
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
        requestedByUserIdInherited = true;
      }
      if (parent.key && !options.key) {
        options.key = parent.key;
      }
      if (parent.contextKey && !options.contextKey) {
        options.contextKey = parent.contextKey;
      }
      if (parent.followUpConfig && !options.followUpConfig) {
        options.followUpConfig = parent.followUpConfig;
      }
      if (parent.routingAffinityInvalid) {
        // Never let a corrupt parent affinity create an apparently untagged
        // continuation. This is a fail-closed quarantine, including recovery.
        throw new Error(`Cannot continue task ${parent.id}: routing affinity is invalid.`);
      }
      if (parent.routingAffinity) {
        // Privilege cannot be shed by a continuation. A child can narrow or
        // replace ordinary routing provenance, but a Lead-only parent always
        // stamps Lead-only onto the child (including callers that supplied
        // requiredCapabilities and therefore built a fresh affinity object).
        if (!options.routingAffinity) {
          options.routingAffinity = parent.routingAffinity;
        } else if (parent.routingAffinity.leadOnly) {
          // Child-supplied affinity may add requirements, but never remove an
          // authorization-affecting requirement inherited from a Lead-only
          // parent. This includes public continuations that default their
          // requiredCapabilities to an empty array.
          options.routingAffinity = {
            ...options.routingAffinity,
            capabilities: [
              ...new Set([
                ...(parent.routingAffinity.capabilities ?? []),
                ...(options.routingAffinity.capabilities ?? []),
              ]),
            ],
            leadOnly: true,
          };
        }
      }
    }
  }

  // Auto-inherit Slack metadata from the creator's source task (deterministic via sourceTaskId)
  // Priority: explicit params > parentTaskId inheritance > sourceTaskId lookup
  // sourceTaskId is set by the adapter's X-Source-Task-Id header — each adapter carries its taskId natively
  if (options?.creatorAgentId && !options.slackChannelId && options.sourceTaskId) {
    const sourceTask = await getTaskById(options.sourceTaskId);
    if (sourceTask?.slackChannelId) {
      options.slackChannelId = sourceTask.slackChannelId;
      options.slackThreadTs = sourceTask.slackThreadTs;
      options.slackUserId = sourceTask.slackUserId;
    }
  }

  // contextKey → Slack-fields backfill: a slack-family contextKey is the
  // durable record of where this task belongs, but delivery code
  // (src/slack/responses.ts, src/slack/watcher.ts, src/tools/slack-reply.ts)
  // reads slackChannelId/slackThreadTs exclusively. Without this, a task that
  // inherited only a slack contextKey (no Slack fields) would silently never
  // deliver. Deliberately does NOT backfill slackUserId — the key doesn't
  // encode it.
  if (!options?.slackChannelId) {
    const backfill = slackChannelFromContextKey(options?.contextKey);
    if (backfill && options) {
      options.slackChannelId = backfill.channelId;
      options.slackThreadTs = backfill.threadTs;
    }
  } else if (!options.slackThreadTs) {
    // Channel present but no thread: a trusted caller supplied slackChannelId
    // without slackThreadTs. If it matches the slack-family contextKey's
    // channel, fill the thread from there too — otherwise delivery (which
    // reads slackThreadTs directly) silently fails to thread.
    const backfill = slackChannelFromContextKey(options.contextKey);
    if (backfill && backfill.channelId === options.slackChannelId) {
      options.slackThreadTs = backfill.threadTs;
    }
  }

  // Residual-mismatch guard: after all inheritance/backfill above, a final
  // slackChannelId/slackThreadTs that still disagrees with a slack-family
  // contextKey would misroute delivery — src/slack/responses.ts,
  // src/slack/watcher.ts, and src/tools/slack-reply.ts all read these fields
  // directly, so logging a warning and inserting the mismatch unchanged does
  // NOT prevent misdelivery. This boundary is reachable by untrusted-ish
  // callers too (e.g. POST /api/tasks accepts client-supplied parentTaskId +
  // contextKey), so a non-override caller must not be able to persist a
  // mismatch: the durable contextKey wins and the Slack fields are
  // normalized to match it. `overrideSlackContext` (set by `send-task` when
  // the caller passed `overrideSlackContext: true`) opts out, preserving the
  // deliberately divergent lineage. Never throw here — this also runs on
  // trusted ingress hot paths that must not fail task creation.
  const finalSlackContext = slackChannelFromContextKey(options?.contextKey);
  if (finalSlackContext && options?.slackChannelId) {
    if (options.slackChannelId !== finalSlackContext.channelId) {
      if (options.overrideSlackContext) {
        console.log(
          `[slack-routing] override: keeping slackChannelId="${options.slackChannelId}" despite disagreeing with contextKey channel "${finalSlackContext.channelId}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
      } else {
        console.warn(
          `[slack-routing] MISMATCH task creation: normalizing slackChannelId="${options.slackChannelId}" to contextKey channel "${finalSlackContext.channelId}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
        options.slackChannelId = finalSlackContext.channelId;
        options.slackThreadTs = finalSlackContext.threadTs;
      }
    } else if (options.slackThreadTs && options.slackThreadTs !== finalSlackContext.threadTs) {
      if (options.overrideSlackContext) {
        console.log(
          `[slack-routing] override: keeping slackThreadTs="${options.slackThreadTs}" despite disagreeing with contextKey thread "${finalSlackContext.threadTs}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
      } else {
        console.warn(
          `[slack-routing] MISMATCH task creation: normalizing slackThreadTs="${options.slackThreadTs}" to contextKey thread "${finalSlackContext.threadTs}" (contextKey=${options.contextKey}, sourceTaskId=${options.sourceTaskId ?? "n/a"}, parentTaskId=${options.parentTaskId ?? "n/a"})`,
        );
        options.slackThreadTs = finalSlackContext.threadTs;
      }
    }
  }

  // Direct assignment and offers bypass the pool claim gate, so enforce the
  // complete structured affinity here. This is after parent inheritance so
  // continuations cannot shed a Lead-only boundary or its capabilities.
  const targetAgentId = options.agentId ?? options.offeredTo;
  if (options.routingAffinity && targetAgentId) {
    const target = await getAgentById(targetAgentId);
    if (!target || !isAgentEligibleForTask(target, { routingAffinity: options.routingAffinity })) {
      try {
        await createLogEntry({
          eventType: "task_authorization_rejected",
          agentId: options.creatorAgentId,
          metadata: {
            leadOnly: options.routingAffinity.leadOnly === true,
            targetAgentId,
            decision: "reject_ineligible_assignment",
          },
        });
      } catch {}
      throw new Error(
        options.routingAffinity.leadOnly
          ? `Lead-only task routing affinity does not authorize assignment or offer to agent "${targetAgentId}".`
          : `Task routing affinity does not authorize assignment or offer to agent "${targetAgentId}".`,
      );
    }
  }

  const auditUserId = getCurrentRequestUserId() ?? null;
  const assetKey = normalizeAssetKey(options?.key ?? defaultAssetKey("task", id));
  // The Linear tracker dedup guard and the INSERT commit as one unit. Two
  // distinct webhook deliveries for the same issue are dispatched
  // fire-and-forget (src/linear/webhook.ts), nothing serializes them, and
  // `agent_tasks` has no UNIQUE index on contextKey, so a guard read separated
  // from the INSERT by any await lets both deliveries create a task for one
  // issue. The FIFO lock serializes whole transactions, so the loser's re-read
  // observes the winner's committed row. Pre-checks at the call sites
  // (src/tools/send-task.ts, src/linear/sync.ts) stay a fast path only.
  const claim = await getDbClient().transaction<
    { existing: ExistingTrackerContextWork } | { row: AgentTaskRow }
  >(async () => {
    const existingTrackerWork = options?.bypassTrackerContextDedup
      ? null
      : await findExistingLinearTrackerContextWork(options?.contextKey);
    if (existingTrackerWork) return { existing: existingTrackerWork };

    const inserted = await getDbClient().get<AgentTaskRow>(
      `INSERT INTO agent_tasks (
        id, "key", agentId, creatorAgentId, task, status, source,
        taskType, tags, priority, dependsOn, offeredTo, offeredAt,
        slackChannelId, slackThreadTs, slackTriggerMessageTs, slackUserId,
        vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl,
        vcsInstallationId, vcsNodeId,
        agentmailInboxId, agentmailMessageId, agentmailThreadId,
        mentionMessageId, mentionChannelId, dir, parentTaskId, model, modelTier, effort, scheduleId,
        workflowRunId, workflowRunStepId, outputSchema, followUpConfig, requestedByUserId, requestedByUserIdInherited, contextKey, routingAffinity, swarmVersion, createdAt, lastUpdatedAt, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [
        id,
        assetKey,
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
        options?.slackTriggerMessageTs ?? null,
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
        options?.effort ?? null,
        options?.scheduleId ?? null,
        options?.workflowRunId ?? null,
        options?.workflowRunStepId ?? null,
        options?.outputSchema ? JSON.stringify(options.outputSchema) : null,
        options?.followUpConfig ? JSON.stringify(options.followUpConfig) : null,
        options?.requestedByUserId ?? null,
        requestedByUserIdInherited ? 1 : 0,
        options?.contextKey ?? null,
        options?.routingAffinity ? JSON.stringify(options.routingAffinity) : null,
        pkg.version,
        now,
        now,
        auditUserId,
        auditUserId,
      ],
    );
    if (!inserted) throw new Error("Failed to create task");
    return { row: inserted };
  });

  if ("existing" in claim) {
    console.log(
      `[task-dedup] Skipping Linear tracker task creation for ${options?.contextKey}: ${claim.existing.reason} ${claim.existing.task.id.slice(0, 8)} already exists`,
    );
    return claim.existing.task;
  }
  const row = claim.row;

  try {
    await createLogEntry({
      eventType: status === "offered" ? "task_offered" : "task_created",
      agentId: options?.creatorAgentId,
      taskId: id,
      newValue: status,
      metadata: {
        source: options?.source ?? "mcp",
        leadOnly: options?.routingAffinity?.leadOnly === true,
        authorization: options?.routingAffinity?.leadOnly
          ? { decision: "authorized", targetAgentId: options.agentId ?? options.offeredTo ?? null }
          : undefined,
      },
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

  getDbClient().afterCommit(() => {
    import("../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.created", {
          taskId: row.id,
          task: row.task,
          source: row.source,
          tags: options?.tags ?? [],
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      })
      .catch((err) =>
        console.error(
          "[db] task.created event not emitted:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });

  return rowToAgentTask(row);
}

export async function claimTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  // Static per (agent, task), so this pre-check does not reopen the atomic
  // claim race. It always applies to lead-only authorization.
  {
    const task = await getTaskById(taskId);
    const agent = await getAgentById(agentId);
    if (task && (!agent || !isAgentEligibleForTask(agent, task))) {
      try {
        await createLogEntry({
          eventType: "task_claim_rejected_affinity",
          agentId,
          taskId,
          metadata: {
            agentRole: agent?.role ?? null,
            requiredRole: task.routingAffinity?.role ?? null,
            leadOnly: task.routingAffinity?.leadOnly === true,
            agentIsLead: agent?.isLead ?? false,
          },
        });
      } catch {}
      return null;
    }
  }

  // Atomic claim: single UPDATE with WHERE guard ensures exactly-once claiming.
  // No pre-read needed — the WHERE clause handles the race condition.
  // Status goes directly to 'in_progress' because the claiming session is
  // already working on the task (prevents duplicate task_assigned triggers).
  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET agentId = ?, status = 'in_progress', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    [agentId, now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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

export async function releaseTask(taskId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  // Allow releasing both 'pending' (directly assigned) and 'in_progress' (pool-claimed) tasks
  if (task.status !== "pending" && task.status !== "in_progress") return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET agentId = NULL, status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status IN ('pending', 'in_progress') RETURNING *`,
    [now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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

export async function acceptTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  const agent = await getAgentById(agentId);
  if (
    (task.routingAffinity?.leadOnly || task.routingAffinityInvalid) &&
    (!agent || !isAgentEligibleForTask(agent, task))
  ) {
    try {
      await createLogEntry({
        eventType: "task_claim_rejected_affinity",
        agentId,
        taskId,
        metadata: {
          leadOnly: true,
          agentIsLead: agent?.isLead ?? false,
          decision: "reject_offer_accept",
        },
      });
    } catch {}
    return null;
  }
  // Accept both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET agentId = ?, status = 'pending', acceptedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    [agentId, now, now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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

export async function rejectTask(
  taskId: string,
  agentId: string,
  reason?: string,
): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  // Reject both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId)
    return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET
        status = 'unassigned', offeredTo = NULL, offeredAt = NULL,
        rejectionReason = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,
    [reason ?? null, now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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
export async function moveTaskToBacklog(taskId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "unassigned") return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'backlog', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    [now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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
export async function moveTaskFromBacklog(taskId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "backlog") return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'unassigned', lastUpdatedAt = ?
       WHERE id = ? AND status = 'backlog' RETURNING *`,
    [now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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
 * Promote a task out of `draft` status into whichever status it should have
 * had at creation time — `offered` if it was offered to an agent, `pending`
 * if it has an owning agent (the common UI-composer case, which defaults to
 * Lead), otherwise `unassigned`. `draft` exists solely to keep a task
 * dispatch-ineligible while its UI-uploaded attachments are still in flight
 * (#1240); this is the promote half of that window. Called once the upload
 * batch settles — success, partial failure, or total failure all promote, a
 * draft is never left stranded by upload errors — or by
 * `promoteAbandonedDraftTasks` for drafts nobody ever promoted.
 */
export async function promoteDraftTask(taskId: string): Promise<AgentTask | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = CASE
           WHEN offeredTo IS NOT NULL THEN 'offered'
           WHEN agentId IS NOT NULL THEN 'pending'
           ELSE 'unassigned'
         END,
         lastUpdatedAt = ?
       WHERE id = ? AND status = 'draft'
       RETURNING *`,
    [now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "draft",
        newValue: row.status,
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Heartbeat sweep: promote drafts abandoned mid-upload (tab closed, network
 * dropped) instead of leaving them permanently dispatch-ineligible — the
 * composer's UI-driven promote (`promoteDraftTask`) never fires if the user
 * never comes back. Same target-status logic, applied in bulk by elapsed
 * time. Default 5 minutes is well above the tens-of-seconds worst-case
 * upload-batch duration seen against slow storage (#1226) while still
 * surfacing an abandoned session to its owner promptly.
 */
export async function promoteAbandonedDraftTasks(timeoutMinutes: number = 5): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = await getDbClient().run(
    `UPDATE agent_tasks
       SET status = CASE
           WHEN offeredTo IS NOT NULL THEN 'offered'
           WHEN agentId IS NOT NULL THEN 'pending'
           ELSE 'unassigned'
         END,
         lastUpdatedAt = ?
       WHERE status = 'draft' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

/**
 * Release tasks that have been in 'reviewing' status for too long.
 * Returns them to 'offered' status for retry.
 */
export async function releaseStaleReviewingTasks(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = await getDbClient().run(
    `UPDATE agent_tasks SET status = 'offered', lastUpdatedAt = ?
     WHERE status = 'reviewing' AND lastUpdatedAt < ?`,
    [now, cutoffTime],
  );

  return result.changes;
}

/**
 * Release 'offered' tasks whose offeree can no longer possibly poll for them
 * — the agent was deleted, or is `offline` (multi-runtime expiry once its
 * last runtime instance ages out, or an explicit graceful close). Returns
 * them to `unassigned` rather than back to `offered`: a stuck offer is
 * invisible to `autoAssignPoolTasks` (which only scans `unassigned`) and to
 * the poll-based accept/reject path (which only the original offeree can
 * reach), so `offered` is a dead end once the offeree is gone (#1190).
 *
 * Deliberately gated on liveness, not elapsed time: a fixed timeout would
 * either yank a live offer out from under an offeree that is simply slow to
 * poll, or (set generously) leave a genuinely dead offeree's task stranded
 * for the full window regardless of how obviously offline it already is.
 * `agents.status = 'offline'` already encodes the staleness threshold that
 * matters — `runtimeStaleThresholdMinutes()` / `RUNTIME_STALE_THRESHOLD_MIN`
 * for multi-runtime expiry, or immediate for an explicit close — so no
 * separate timeout knob is introduced here.
 */
export async function releaseStaleOfferedTasksForOfflineAgents(): Promise<number> {
  const now = new Date().toISOString();

  const result = await getDbClient().run(
    `UPDATE agent_tasks
     SET status = 'unassigned', offeredTo = NULL, offeredAt = NULL, lastUpdatedAt = ?
     WHERE status = 'offered'
       AND offeredTo IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM agents WHERE agents.id = agent_tasks.offeredTo AND agents.status != 'offline'
       )`,
    [now],
  );

  return result.changes;
}

export async function getOfferedTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE offeredTo = ? AND status = 'offered' ORDER BY createdAt ASC, rowid ASC",
    [agentId],
  );
  return rows.map(rowToAgentTask);
}

/**
 * Atomically claim an offered task for review.
 * Marks it as 'reviewing' to prevent duplicate polling.
 * Returns null if task is not offered to this agent or already claimed.
 */
export async function claimOfferedTask(taskId: string, agentId: string): Promise<AgentTask | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;
  const agent = await getAgentById(agentId);
  if (
    (task.routingAffinity?.leadOnly || task.routingAffinityInvalid) &&
    (!agent || !isAgentEligibleForTask(agent, task))
  ) {
    try {
      await createLogEntry({
        eventType: "task_claim_rejected_affinity",
        agentId,
        taskId,
        metadata: {
          leadOnly: true,
          agentIsLead: agent?.isLead ?? false,
          decision: "reject_offer_claim",
        },
      });
    } catch {}
    return null;
  }

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'reviewing', lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    [now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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

export async function getUnassignedTasksCount(): Promise<number> {
  const result = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
  );
  return result?.count ?? 0;
}

/** Get unassigned task IDs, ordered by priority (highest first) then creation time */
export async function getUnassignedTaskIds(limit = 10): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE status = 'unassigned' ORDER BY priority DESC, createdAt ASC, rowid ASC LIMIT ?",
    [limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Batch size and hard cap for the paginated eligibility scans in
 * `getUnassignedTaskIdsForAgent` (and `autoAssignPoolTasks` in
 * src/heartbeat/heartbeat.ts, which mirrors this pattern). A fixed single
 * window used to mean N ineligible affinity-tagged tasks at the head of the
 * priority order could hide all eligible work behind them forever — see
 * PR #954 review. Scanning continues page-by-page until `limit` eligible
 * candidates are found or the pool is exhausted; the cap bounds worst-case
 * DB load when eligible work is buried deep or genuinely absent.
 */
const ELIGIBILITY_SCAN_BATCH_SIZE = Number(process.env.ELIGIBILITY_SCAN_BATCH_SIZE) || 25;
const ELIGIBILITY_SCAN_CAP = Number(process.env.ELIGIBILITY_SCAN_CAP) || 500;

/**
 * Same ordering as `getUnassignedTaskIds`, filtered through
 * `isAgentEligibleForTask` for the requesting agent. Used by the poll
 * auto-claim path so an ineligible candidate is never even offered to the
 * budget gate / claim loop. Paginates through the unassigned pool in
 * `ELIGIBILITY_SCAN_BATCH_SIZE`-row windows (filtering in JS to avoid
 * JSON-parsing `routingAffinity` in SQL) until `limit` eligible tasks are
 * found or the pool is exhausted, capped at `ELIGIBILITY_SCAN_CAP` rows
 * scanned so a pool full of ineligible tasks can't turn every poll into an
 * unbounded scan.
 */
export async function getUnassignedTaskIdsForAgent(agentId: string, limit = 10): Promise<string[]> {
  const agent = await getAgentById(agentId);
  if (!agent) return [];

  const batchSize = Math.max(limit * 5, ELIGIBILITY_SCAN_BATCH_SIZE);
  const eligible: string[] = [];
  let offset = 0;

  while (eligible.length < limit && offset < ELIGIBILITY_SCAN_CAP) {
    const rows = await getDbClient().query<AgentTaskRow>(
      "SELECT * FROM agent_tasks WHERE status = 'unassigned' ORDER BY priority DESC, createdAt ASC, rowid ASC LIMIT ? OFFSET ?",
      [batchSize, offset],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const task = rowToAgentTask(row);
      if (isAgentEligibleForTask(agent, task)) {
        eligible.push(task.id);
        if (eligible.length >= limit) break;
      }
    }

    offset += rows.length;
    if (rows.length < batchSize) break; // Exhausted the pool.
  }

  return eligible;
}

// ============================================================================
// Dependency Checking
// ============================================================================

export async function checkDependencies(taskId: string): Promise<{
  ready: boolean;
  blockedBy: string[];
}> {
  const task = await getTaskById(taskId);
  if (!task || !task.dependsOn || task.dependsOn.length === 0) {
    return { ready: true, blockedBy: [] };
  }

  const blockedBy: string[] = [];
  for (const depId of task.dependsOn) {
    const depTask = await getTaskById(depId);
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
export async function getDependentTasks(
  parentId: string,
  opts?: { includeTerminal?: boolean },
): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT t.*
       FROM agent_tasks t, json_each(t.dependsOn) AS dep
       WHERE dep.value = ?`,
    [parentId],
  );

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
export async function cascadeFailDependents(
  parentId: string,
  parentStatus: string,
  visited?: Set<string>,
): Promise<CascadeFailResult[]> {
  const seen = visited ?? new Set<string>();
  if (seen.has(parentId)) return [];
  seen.add(parentId);

  const dependents = await getDependentTasks(parentId);
  const results: CascadeFailResult[] = [];

  for (const dep of dependents) {
    if (seen.has(dep.id)) continue;

    const reason = `Blocked dependency ${parentId.slice(0, 8)} was ${parentStatus}`;
    const failed = await failTask(dep.id, reason);
    if (failed) {
      results.push({
        taskId: failed.id,
        taskSubject: failed.task.slice(0, 120),
      });
      // Recurse: this dependent may itself have dependents
      const transitive = await cascadeFailDependents(dep.id, "failed (cascade)", seen);
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

export async function updateAgentProfile(
  id: string,
  updates: {
    name?: string;
    description?: string;
    role?: string;
    capabilities?: string[];
    claudeMd?: string;
    soulMd?: string;
    identityMd?: string;
    setupScript?: string;
    toolsMd?: string;
    heartbeatMd?: string;
    /** `null` resets to the deterministic fallback; omit the key to leave untouched. */
    avatar?: AgentAvatar | null;
  },
  meta?: VersionMeta,
): Promise<Agent | null> {
  return await getDbClient().transaction(async (tx) => {
    // Get current agent state for version comparison
    const current = await tx.get<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
    if (!current) return null;

    for (const field of BUDGETED_IDENTITY_FIELDS) {
      const nextValue = updates[field];
      if (nextValue === undefined) continue;

      const result = checkIdentityFieldBudget({
        field,
        currentValue: current[field] ?? "",
        nextValue,
      });
      if (!result.ok) {
        throw new IdentityFieldBudgetError(
          result,
          computeContentHash(current[field] ?? ""),
          computeContentHash(nextValue),
        );
      }
    }

    if (updates.name !== undefined) {
      const existingAgent = await tx.get<AgentRow>(
        "SELECT * FROM agents WHERE name = ? AND id != ?",
        [updates.name, id],
      );
      if (existingAgent) throw new Error("Agent name already exists");
    }

    // Create context versions for changed fields
    for (const field of VERSIONABLE_FIELDS) {
      const newValue = updates[field];
      if (newValue === undefined || newValue === null) continue;

      const currentValue = current[field] ?? "";
      const newHash = computeContentHash(newValue);
      const currentHash = computeContentHash(currentValue);

      if (newHash === currentHash) continue; // No actual change

      const latestVersion = await getLatestContextVersion(id, field);
      const version = (latestVersion?.version ?? 0) + 1;

      await createContextVersion({
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

    // Proceed with existing UPDATE logic.
    //
    // `avatar` can't use the COALESCE(?, col) pattern the other fields use:
    // COALESCE can never write NULL back (a bound NULL just falls through to
    // the existing value), which would make "reset to default avatar"
    // unimplementable. So it gets its own explicit-set CASE, gated by an
    // `avatarProvided` flag distinguishing "key absent from updates" (leave
    // untouched) from "key present with value null" (reset).
    const avatarProvided = Object.hasOwn(updates, "avatar");
    const avatarJson = updates.avatar ? JSON.stringify(updates.avatar) : null;

    const now = new Date().toISOString();
    const row = await tx.get<AgentRow>(
      `UPDATE agents SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          role = COALESCE(?, role),
          capabilities = COALESCE(?, capabilities),
          claudeMd = COALESCE(?, claudeMd),
          soulMd = COALESCE(?, soulMd),
          identityMd = COALESCE(?, identityMd),
          setupScript = COALESCE(?, setupScript),
          toolsMd = COALESCE(?, toolsMd),
          heartbeatMd = COALESCE(?, heartbeatMd),
          avatar = CASE WHEN ? = 1 THEN ? ELSE avatar END,
          lastUpdatedAt = ?
         WHERE id = ? RETURNING *`,
      [
        updates.name ?? null,
        updates.description ?? null,
        updates.role ?? null,
        updates.capabilities ? JSON.stringify(updates.capabilities) : null,
        updates.claudeMd ?? null,
        updates.soulMd ?? null,
        updates.identityMd ?? null,
        updates.setupScript ?? null,
        updates.toolsMd ?? null,
        updates.heartbeatMd ?? null,
        avatarProvided ? 1 : 0,
        avatarJson,
        now,
        id,
      ],
    );

    return row ? rowToAgent(row) : null;
  });
}

export async function updateAgentName(id: string, newName: string): Promise<Agent | null> {
  return await updateAgentProfile(id, { name: newName });
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

export async function createChannel(
  name: string,
  options?: {
    description?: string;
    type?: ChannelType;
    createdBy?: string;
    participants?: string[];
  },
): Promise<Channel> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ChannelRow>(
    `INSERT INTO channels (id, name, description, type, createdBy, participants, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      name,
      options?.description ?? null,
      options?.type ?? "public",
      options?.createdBy ?? null,
      JSON.stringify(options?.participants ?? []),
      now,
    ],
  );

  if (!row) throw new Error("Failed to create channel");
  return rowToChannel(row);
}

export async function getMessageById(id: string): Promise<ChannelMessage | null> {
  const row = await getDbClient().get<ChannelMessageRow>(
    "SELECT * FROM channel_messages WHERE id = ?",
    [id],
  );
  if (!row) return null;
  const agent = row.agentId ? await getAgentById(row.agentId) : null;
  return rowToChannelMessage(row, agent?.name);
}

export async function getChannelById(id: string): Promise<Channel | null> {
  const row = await getDbClient().get<ChannelRow>("SELECT * FROM channels WHERE id = ?", [id]);
  return row ? rowToChannel(row) : null;
}

export async function getChannelByName(name: string): Promise<Channel | null> {
  const row = await getDbClient().get<ChannelRow>("SELECT * FROM channels WHERE name = ?", [name]);
  return row ? rowToChannel(row) : null;
}

export async function getAllChannels(): Promise<Channel[]> {
  const rows = await getDbClient().query<ChannelRow>("SELECT * FROM channels ORDER BY name");
  return rows.map(rowToChannel);
}

export async function deleteChannel(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM channels WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function postMessage(
  channelId: string,
  agentId: string | null,
  content: string,
  options?: {
    replyToId?: string;
    mentions?: string[];
  },
): Promise<ChannelMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Detect /task prefix - only create tasks when explicitly requested
  const isTaskMessage = content.trimStart().startsWith("/task ");
  const messageContent = isTaskMessage ? content.replace(/^\s*\/task\s+/, "") : content;

  const row = await getDbClient().get<ChannelMessageRow>(
    `INSERT INTO channel_messages (id, channelId, agentId, content, replyToId, mentions, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      channelId,
      agentId,
      messageContent,
      options?.replyToId ?? null,
      JSON.stringify(options?.mentions ?? []),
      now,
    ],
  );

  if (!row) throw new Error("Failed to post message");

  try {
    await createLogEntry({
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
    const parentMessage = await getMessageById(options.replyToId);
    if (parentMessage?.mentions && parentMessage.mentions.length > 0) {
      targetMentions = parentMessage.mentions;
    }
  }

  // Only create tasks when /task prefix is used
  if (isTaskMessage && targetMentions.length > 0) {
    const sender = agentId ? await getAgentById(agentId) : null;
    const channel = await getChannelById(channelId);
    const senderName = sender?.name ?? "Human";
    const channelName = channel?.name ?? "unknown";
    const truncated =
      messageContent.length > 80 ? `${messageContent.slice(0, 80)}...` : messageContent;

    // Dedupe mentions (self-mentions allowed - agents can create tasks for themselves)
    const uniqueMentions = [...new Set(targetMentions)];
    const createdTaskIds: string[] = [];

    for (const mentionedAgentId of uniqueMentions) {
      // Skip if agent doesn't exist
      const mentionedAgent = await getAgentById(mentionedAgentId);
      if (!mentionedAgent) continue;

      const taskDescription = `Task from ${senderName} in #${channelName}: "${truncated}"`;

      const task = await createTaskExtended(taskDescription, {
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
      await getDbClient().run(`UPDATE channel_messages SET content = ? WHERE id = ?`, [
        updatedContent,
        id,
      ]);
    }
  }

  // Get agent name for the response - re-fetch to get updated content
  const agent = agentId ? await getAgentById(agentId) : null;
  const updatedRow = await getDbClient().get<ChannelMessageRow>(
    `SELECT m.*, a.name as agentName FROM channel_messages m
       LEFT JOIN agents a ON m.agentId = a.id WHERE m.id = ?`,
    [id],
  );
  return rowToChannelMessage(updatedRow ?? row, agent?.name);
}

export async function getChannelMessages(
  channelId: string,
  options?: {
    limit?: number;
    since?: string;
    before?: string;
  },
): Promise<ChannelMessage[]> {
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

  const rows = await getDbClient().query<MessageWithAgentRow>(query, params);
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined)).reverse(); // Return in chronological order
}

export async function updateReadState(agentId: string, channelId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO channel_read_state (agentId, channelId, lastReadAt)
     VALUES (?, ?, ?)
     ON CONFLICT(agentId, channelId) DO UPDATE SET lastReadAt = ?`,
    [agentId, channelId, now, now],
  );
}

export async function getLastReadAt(agentId: string, channelId: string): Promise<string | null> {
  const result = await getDbClient().get<{ lastReadAt: string }>(
    "SELECT lastReadAt FROM channel_read_state WHERE agentId = ? AND channelId = ?",
    [agentId, channelId],
  );
  return result?.lastReadAt ?? null;
}

export async function getUnreadMessages(
  agentId: string,
  channelId: string,
): Promise<ChannelMessage[]> {
  const lastReadAt = await getLastReadAt(agentId, channelId);

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

  const rows = await getDbClient().query<MessageWithAgentRow>(query, params);
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
}

export async function getMentionsForAgent(
  agentId: string,
  options?: { unreadOnly?: boolean; channelId?: string },
): Promise<ChannelMessage[]> {
  let query = `SELECT m.*, a.name as agentName FROM channel_messages m
               LEFT JOIN agents a ON m.agentId = a.id
               WHERE m.mentions LIKE ?`;
  const params: string[] = [`%"${agentId}"%`];

  if (options?.channelId) {
    query += " AND m.channelId = ?";
    params.push(options.channelId);

    if (options?.unreadOnly) {
      const lastReadAt = await getLastReadAt(agentId, options.channelId);
      if (lastReadAt) {
        query += " AND m.createdAt > ?";
        params.push(lastReadAt);
      }
    }
  }

  query += " ORDER BY m.createdAt DESC LIMIT 50";

  type MessageWithAgentRow = ChannelMessageRow & { agentName: string | null };

  const rows = await getDbClient().query<MessageWithAgentRow>(query, params);
  return rows.map((row) => rowToChannelMessage(row, row.agentName ?? undefined));
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

export async function getInboxSummary(agentId: string): Promise<InboxSummary> {
  const client = getDbClient();
  const channels = await getAllChannels();
  let unreadCount = 0;
  let mentionsCount = 0;

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = await client.get<{ lastReadAt: string; processing_since: string | null }>(
      "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      [agentId, channel.id],
    );

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Count unread (excluding own messages)
    const channelUnread = await client.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND (m.agentId != '${agentId}' OR m.agentId IS NULL) ${baseCondition}`,
      [channel.id],
    );
    unreadCount += channelUnread?.count ?? 0;

    // Count mentions in unread
    const channelMentions = await client.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      [channel.id, `%"${agentId}"%`],
    );
    mentionsCount += channelMentions?.count ?? 0;
  }

  // Count offered tasks for this agent
  const offeredResult = await client.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agent_tasks WHERE offeredTo = ? AND status = 'offered'",
    [agentId],
  );

  // Count unassigned tasks in pool
  const poolResult = await client.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'unassigned'",
  );

  // Count my in-progress tasks
  const inProgressResult = await client.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'",
    [agentId],
  );

  // Get recent unread @mentions (up to 3)
  const recentMentions: MentionPreview[] = [];
  const mentionMessages = await getMentionsForAgent(agentId, { unreadOnly: false });

  // Filter to only unread mentions and limit to 3
  for (const msg of mentionMessages) {
    if (recentMentions.length >= 3) break;

    // Check if message is unread (by checking against read state per channel)
    const lastReadAt = await getLastReadAt(agentId, msg.channelId);
    if (lastReadAt && new Date(msg.createdAt) <= new Date(lastReadAt)) {
      continue; // Already read
    }

    // Get channel name
    const channel = await getChannelById(msg.channelId);

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
export async function claimMentions(
  agentId: string,
): Promise<{ channelId: string; lastReadAt: string | null }[]> {
  const now = new Date().toISOString();
  const client = getDbClient();
  const channels = await getAllChannels();
  const claimedChannels: { channelId: string; lastReadAt: string | null }[] = [];

  for (const channel of channels) {
    // Check if this channel is already being processed
    const readState = await client.get<{
      lastReadAt: string | null;
      processing_since: string | null;
    }>(
      "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      [agentId, channel.id],
    );

    const lastReadAt = readState?.lastReadAt ?? null;
    const isProcessing =
      readState?.processing_since !== null && readState?.processing_since !== undefined;

    // Skip channels that are already being processed
    if (isProcessing) continue;

    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Check if there are unread mentions
    const mentionCountRow = await client.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      [channel.id, `%"${agentId}"%`],
    );

    if (mentionCountRow && mentionCountRow.count > 0) {
      // Atomically claim mentions for this channel
      const result = await client.run(
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
export async function releaseMentionProcessing(
  agentId: string,
  channelIds: string[],
): Promise<void> {
  if (channelIds.length === 0) return;

  const placeholders = channelIds.map(() => "?").join(",");
  await getDbClient().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE agentId = ? AND channelId IN (${placeholders})`,
    [agentId, ...channelIds],
  );
}

/**
 * Auto-release stale mention processing (for crashed Claude processes).
 */
export async function releaseStaleMentionProcessing(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = await getDbClient().run(
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

export async function createService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Promise<Service> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ServiceRow>(
    `INSERT INTO services (id, agentId, name, port, description, url, healthCheckPath, status, script, cwd, interpreter, args, env, metadata, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create service");

  try {
    await createLogEntry({
      eventType: "service_registered",
      agentId,
      newValue: name,
      metadata: { serviceId: id, port: options?.port ?? 3000 },
    });
  } catch {}

  return rowToService(row);
}

export async function getServiceById(id: string): Promise<Service | null> {
  const row = await getDbClient().get<ServiceRow>("SELECT * FROM services WHERE id = ?", [id]);
  return row ? rowToService(row) : null;
}

export async function getServiceByAgentAndName(
  agentId: string,
  name: string,
): Promise<Service | null> {
  const row = await getDbClient().get<ServiceRow>(
    "SELECT * FROM services WHERE agentId = ? AND name = ?",
    [agentId, name],
  );
  return row ? rowToService(row) : null;
}

export async function getServicesByAgentId(agentId: string): Promise<Service[]> {
  const rows = await getDbClient().query<ServiceRow>(
    "SELECT * FROM services WHERE agentId = ? ORDER BY name",
    [agentId],
  );
  return rows.map(rowToService);
}

export interface ServiceFilters {
  agentId?: string;
  name?: string;
  status?: ServiceStatus;
}

export async function getAllServices(filters?: ServiceFilters): Promise<Service[]> {
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

  const rows = await getDbClient().query<ServiceRow>(query, params);
  return rows.map(rowToService);
}

export async function updateServiceStatus(
  id: string,
  status: ServiceStatus,
): Promise<Service | null> {
  const oldService = await getServiceById(id);
  if (!oldService) return null;

  const now = new Date().toISOString();
  const row = await getDbClient().get<ServiceRow>(
    `UPDATE services SET status = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *`,
    [status, now, id],
  );

  if (row && oldService.status !== status) {
    try {
      await createLogEntry({
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

export async function deleteService(id: string): Promise<boolean> {
  const service = await getServiceById(id);
  if (service) {
    try {
      await createLogEntry({
        eventType: "service_unregistered",
        agentId: service.agentId,
        oldValue: service.name,
        metadata: { serviceId: id },
      });
    } catch {}
  }

  const result = await getDbClient().run("DELETE FROM services WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Upsert a service - update if exists (by agentId + name), create if not */
export async function upsertService(
  agentId: string,
  name: string,
  options: CreateServiceOptions,
): Promise<Service> {
  const existing = await getServiceByAgentAndName(agentId, name);

  if (existing) {
    // Update existing service
    const now = new Date().toISOString();
    const row = await getDbClient().get<ServiceRow>(
      `UPDATE services SET
          port = ?, description = ?, url = ?, healthCheckPath = ?,
          script = ?, cwd = ?, interpreter = ?, args = ?, env = ?,
          metadata = ?, lastUpdatedAt = ?
        WHERE id = ? RETURNING *`,
      [
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
      ],
    );

    if (!row) throw new Error("Failed to update service");
    return rowToService(row);
  }

  // Create new service
  return createService(agentId, name, options);
}

export async function deleteServicesByAgentId(agentId: string): Promise<number> {
  const services = await getServicesByAgentId(agentId);
  for (const service of services) {
    try {
      await createLogEntry({
        eventType: "service_unregistered",
        agentId,
        oldValue: service.name,
        metadata: { serviceId: service.id },
      });
    } catch {}
  }

  const result = await getDbClient().run("DELETE FROM services WHERE agentId = ?", [agentId]);
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

export async function createSessionLogs(logs: {
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  lines: string[];
}): Promise<void> {
  // Bounded batches, one short transaction each (reference shape:
  // src/be/boot-scrub-logs.ts): worker log batches have unbounded line
  // counts, and a single transaction across thousands of scrub+INSERT
  // iterations would hold the global write lock — and the event loop — for
  // the whole sweep. The regex scrub runs outside the transaction so only
  // the inserts hold the lock.
  const BATCH_SIZE = 200;
  for (let start = 0; start < logs.lines.length; start += BATCH_SIZE) {
    // Yield to the event loop between batches.
    if (start > 0) await new Promise<void>((r) => setTimeout(r, 5));
    const batch: { content: string; lineNumber: number }[] = [];
    const end = Math.min(start + BATCH_SIZE, logs.lines.length);
    for (let i = start; i < end; i++) {
      const line = logs.lines[i];
      if (line === undefined) continue;
      // Defense-in-depth: callers (runner.ts → POST /api/session-logs) send
      // content that is already scrubbed at the adapter emit site. We scrub
      // again here so any future write path that bypasses the adapter still
      // lands clean text in the persistent session_logs table.
      batch.push({ content: scrubSecrets(line), lineNumber: i });
    }
    await getDbClient().transaction(async (tx) => {
      for (const { content, lineNumber } of batch) {
        await tx.run(
          `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          [
            crypto.randomUUID(),
            logs.taskId ?? null,
            logs.sessionId,
            logs.iteration,
            logs.cli,
            content,
            lineNumber,
          ],
        );
      }
    });
  }
}

export async function getSessionLogsByTaskId(
  taskId: string,
  limit?: number,
): Promise<SessionLog[]> {
  if (typeof limit === "number" && limit > 0) {
    const rows = await getDbClient().query<SessionLogRow>(
      `SELECT * FROM (
         SELECT * FROM session_logs WHERE taskId = ?
         ORDER BY iteration DESC, lineNumber DESC
         LIMIT ?
       ) ORDER BY iteration ASC, lineNumber ASC`,
      [taskId, limit],
    );
    return rows.map(rowToSessionLog);
  }
  const rows = await getDbClient().query<SessionLogRow>(
    "SELECT * FROM session_logs WHERE taskId = ? ORDER BY iteration ASC, lineNumber ASC",
    [taskId],
  );
  return rows.map(rowToSessionLog);
}

export async function getSessionLogsBySession(
  sessionId: string,
  iteration: number,
): Promise<SessionLog[]> {
  const rows = await getDbClient().query<SessionLogRow>(
    "SELECT * FROM session_logs WHERE sessionId = ? AND iteration = ? ORDER BY lineNumber ASC",
    [sessionId, iteration],
  );
  return rows.map(rowToSessionLog);
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
  harnessCostUsd: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  modelBreakdown: string | null;
  createdAt: string;
};

function rowToSessionCost(row: SessionCostRow): SessionCost {
  let modelBreakdown: SessionCostModelBreakdown[] | null = null;
  if (row.modelBreakdown) {
    try {
      const parsed = SessionCostModelBreakdownSchema.array().safeParse(
        JSON.parse(row.modelBreakdown),
      );
      if (parsed.success) modelBreakdown = parsed.data;
    } catch {
      // Corrupt JSON (manual edits, partial writes) must not fail the listing.
    }
  }

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
    harnessCostUsd: row.harnessCostUsd,
    cacheWrite5mTokens: row.cacheWrite5mTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    modelBreakdown,
    createdAt: row.createdAt,
  };
}

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
  harnessCostUsd?: number | null;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  modelBreakdown?: SessionCostModelBreakdown[] | null;
}

export async function createSessionCost(input: CreateSessionCostInput): Promise<SessionCost> {
  const id = crypto.randomUUID();
  const costSource: SessionCostSource = input.costSource ?? "harness";
  const reasoningOutputTokens = input.reasoningOutputTokens ?? 0;
  const thinkingTokens = input.thinkingTokens ?? 0;
  await getDbClient().run(
    `INSERT INTO session_costs (
         id, sessionId, taskId, agentId,
         totalCostUsd, inputTokens, outputTokens,
         cacheReadTokens, cacheWriteTokens,
         reasoningOutputTokens, thinkingTokens,
         durationMs, numTurns, model, isError,
         costSource, harnessCostUsd, cacheWrite5mTokens, cacheWrite1hTokens,
         modelBreakdown, createdAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [
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
      input.harnessCostUsd ?? null,
      input.cacheWrite5mTokens ?? null,
      input.cacheWrite1hTokens ?? null,
      input.modelBreakdown ? JSON.stringify(input.modelBreakdown) : null,
    ],
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
    harnessCostUsd: input.harnessCostUsd ?? null,
    cacheWrite5mTokens: input.cacheWrite5mTokens ?? null,
    cacheWrite1hTokens: input.cacheWrite1hTokens ?? null,
    modelBreakdown: input.modelBreakdown ?? null,
    createdAt: new Date().toISOString(),
  };
}

export async function getSessionCostsByTaskId(taskId: string, limit = 500): Promise<SessionCost[]> {
  const rows = await getDbClient().query<SessionCostRow>(
    "SELECT * FROM session_costs WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    [taskId, limit],
  );
  return rows.map(rowToSessionCost);
}

export async function getSessionCostsByAgentId(
  agentId: string,
  limit = 100,
): Promise<SessionCost[]> {
  const rows = await getDbClient().query<SessionCostRow>(
    "SELECT * FROM session_costs WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    [agentId, limit],
  );
  return rows.map(rowToSessionCost);
}

export async function getAllSessionCosts(limit = 100): Promise<SessionCost[]> {
  const rows = await getDbClient().query<SessionCostRow>(
    "SELECT * FROM session_costs ORDER BY createdAt DESC LIMIT ?",
    [limit],
  );
  return rows.map(rowToSessionCost);
}

// --- Date-filtered session costs (P1) ---

export async function getSessionCostsFiltered(opts: {
  agentId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<SessionCost[]> {
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

  const rows = await getDbClient().query<SessionCostRow>(
    `SELECT * FROM session_costs ${where} ORDER BY createdAt DESC LIMIT ?`,
    params,
  );
  return rows.map(rowToSessionCost);
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
  /**
   * Cost of tasks with a human requester, over `attributableCostUsd` (not
   * `totalCostUsd`) — see `attributableCostUsd` for why. Also excludes cost on
   * a structurally-human-free task that happens to carry a stale/inherited
   * `requestedByUserId` (measured 2026-08-19: ~5% of the naive-attributed
   * population), so the two totals stay a consistent partition.
   */
  attributedCostUsd: number;
  /**
   * The corrected coverage denominator: `totalCostUsd` minus the cost of
   * structurally-human-free tasks (heartbeat/boot-triage, scheduled runs, and
   * `source='system'` follow-ups whose parent itself had no human requester —
   * i.e. follow-ups of the swarm's own self-maintenance, not of human work).
   * These tasks have no human requester *by construction*; stamping one on
   * them would be a lie, not coverage, so they don't belong in the
   * denominator at all. `attributedCostUsd / attributableCostUsd` is the
   * number to show as "coverage" — dividing by `totalCostUsd` instead
   * silently deflates it with a population that could never have scored.
   */
  attributableCostUsd: number;
  /** Cost of the structurally-human-free population excluded from `attributableCostUsd`. */
  excludedCostUsd: number;
  /** Distinct tasks behind `excludedCostUsd` — surfaced so the UI can name the exclusion count, not just wave at a percentage. */
  excludedTaskCount: number;
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

export interface SessionCostByUserRow {
  /** `null` = no human requester (heartbeat, boot triage, other autonomous work). */
  userId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
  durationMs: number;
}

/** `opts.userId` sentinel selecting spend with no human requester. */
export const UNATTRIBUTED_USER_ID = "unattributed";

// Structurally-human-free tasks and their descendants. An explicitly supplied
// requester is a human handoff and stops propagation; a requester copied from
// the parent does not.
const HUMAN_FREE_TASKS_CTE = `human_free_tasks(id) AS (
        SELECT task.id
        FROM agent_tasks task
        LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
        WHERE COALESCE(task.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
          OR COALESCE(task.tags, '[]') LIKE '%"heartbeat"%'
          OR (COALESCE(task.source, '') = 'schedule' AND task.requestedByUserId IS NULL)
          OR (
            task.parentTaskId IS NULL
            AND COALESCE(task.source, '') = 'workflow'
            AND task.requestedByUserId IS NULL
            AND EXISTS (
              SELECT 1
              FROM workflow_runs run
              WHERE run.id = task.workflowRunId
                AND run.triggerType = 'schedule'
                AND run.created_by IS NULL
            )
          )
          OR (
            COALESCE(task.source, '') = 'system'
            AND parent.id IS NOT NULL
            AND parent.requestedByUserId IS NULL
          )

        UNION

        SELECT child.id
        FROM agent_tasks child
        JOIN human_free_tasks parent ON child.parentTaskId = parent.id
        WHERE child.requestedByUserId IS NULL
          OR child.requestedByUserIdInherited = 1
      )`;
const HUMAN_FREE_SQL = "EXISTS (SELECT 1 FROM human_free_tasks WHERE id = t.id)";
const ROOT_HUMAN_FREE_SQL = `(
        COALESCE(t.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
        OR COALESCE(t.tags, '[]') LIKE '%"heartbeat"%'
        OR (COALESCE(t.source, '') = 'schedule' AND t.requestedByUserId IS NULL)
        OR (
          COALESCE(t.source, '') = 'workflow'
          AND t.requestedByUserId IS NULL
          AND EXISTS (
            SELECT 1
            FROM workflow_runs run
            WHERE run.id = t.workflowRunId
              AND run.triggerType = 'schedule'
              AND run.created_by IS NULL
          )
        )
      )`;

export async function getSessionCostSummary(opts: {
  startDate?: string;
  endDate?: string;
  agentId?: string;
  /** A user id, or `UNATTRIBUTED_USER_ID` for spend with no human requester. */
  userId?: string;
  groupBy?: "day" | "agent" | "both" | "user";
}): Promise<{
  totals: SessionCostSummaryTotals;
  daily: SessionCostDailyRow[];
  byAgent: SessionCostByAgentRow[];
  byUser: SessionCostByUserRow[];
}> {
  // `session_costs` deliberately carries no `userId` column — a task can be
  // re-attributed after the fact, so the human requester is resolved by joining
  // through the task (same shape as `getDailySpendForUser`). Every column is
  // `sc.`-qualified because `createdAt`/`agentId` exist on both sides.
  const from = "FROM session_costs sc LEFT JOIN agent_tasks t ON t.id = sc.taskId";

  // Structurally-human-free: the swarm maintaining itself, with no human
  // requester by construction — heartbeat/boot-triage tasks, scheduled runs
  // without a human creator (including workflow roots launched by such a
  // schedule), and `source='system'` follow-ups whose parent itself has no
  // human requester. That classification propagates through descendants while
  // they remain unattributed, so autonomous fan-out cannot leak back into the
  // denominator. An explicitly attributed child is an independent handoff and
  // stops propagation down that branch.
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts.startDate) {
    conditions.push("sc.createdAt >= ?");
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push("sc.createdAt <= ?");
    params.push(opts.endDate);
  }
  if (opts.agentId) {
    conditions.push("sc.agentId = ?");
    params.push(opts.agentId);
  }
  if (opts.userId === UNATTRIBUTED_USER_ID) {
    conditions.push(`(t.requestedByUserId IS NULL OR ${HUMAN_FREE_SQL})`);
  } else if (opts.userId) {
    conditions.push(`(t.requestedByUserId = ? AND NOT ${HUMAN_FREE_SQL})`);
    params.push(opts.userId);
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
    attributedCostUsd: number;
    attributableCostUsd: number;
    excludedCostUsd: number;
    excludedTaskCount: number;
  };

  const totalsRow = await getDbClient().get<TotalsRow>(
    `WITH RECURSIVE ${HUMAN_FREE_TASKS_CTE}
      SELECT
        COALESCE(SUM(sc.totalCostUsd), 0) as totalCostUsd,
        COALESCE(SUM(sc.inputTokens), 0) as totalInputTokens,
        COALESCE(SUM(sc.outputTokens), 0) as totalOutputTokens,
        COALESCE(SUM(sc.cacheReadTokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(sc.cacheWriteTokens), 0) as totalCacheWriteTokens,
        COALESCE(SUM(sc.durationMs), 0) as totalDurationMs,
        COUNT(*) as totalSessions,
        COALESCE(SUM(CASE WHEN t.requestedByUserId IS NOT NULL AND NOT ${HUMAN_FREE_SQL}
          THEN sc.totalCostUsd ELSE 0 END), 0) as attributedCostUsd,
        COALESCE(SUM(CASE WHEN NOT ${HUMAN_FREE_SQL}
          THEN sc.totalCostUsd ELSE 0 END), 0) as attributableCostUsd,
        COALESCE(SUM(CASE WHEN ${HUMAN_FREE_SQL}
          THEN sc.totalCostUsd ELSE 0 END), 0) as excludedCostUsd,
        COUNT(DISTINCT CASE WHEN ${HUMAN_FREE_SQL} THEN t.id END) as excludedTaskCount
      ${from} ${where}`,
    params,
  );

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
        attributedCostUsd: 0,
        attributableCostUsd: 0,
        excludedCostUsd: 0,
        excludedTaskCount: 0,
      };

  // Daily breakdown
  const groupBy = opts.groupBy ?? "both";
  let daily: SessionCostDailyRow[] = [];
  if (groupBy === "day" || groupBy === "both") {
    daily = await getDbClient().query<{
      date: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      sessions: number;
    }>(
      `WITH RECURSIVE ${HUMAN_FREE_TASKS_CTE}
        SELECT
          DATE(sc.createdAt) as date,
          COALESCE(SUM(sc.totalCostUsd), 0) as costUsd,
          COALESCE(SUM(sc.inputTokens), 0) as inputTokens,
          COALESCE(SUM(sc.outputTokens), 0) as outputTokens,
          COUNT(*) as sessions
        ${from} ${where}
        GROUP BY DATE(sc.createdAt)
        ORDER BY date ASC`,
      params,
    );
  }

  // Per-agent breakdown
  let byAgent: SessionCostByAgentRow[] = [];
  if (groupBy === "agent" || groupBy === "both") {
    byAgent = await getDbClient().query<{
      agentId: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      sessions: number;
      durationMs: number;
    }>(
      `WITH RECURSIVE ${HUMAN_FREE_TASKS_CTE}
        SELECT
          sc.agentId as agentId,
          COALESCE(SUM(sc.totalCostUsd), 0) as costUsd,
          COALESCE(SUM(sc.inputTokens), 0) as inputTokens,
          COALESCE(SUM(sc.outputTokens), 0) as outputTokens,
          COUNT(*) as sessions,
          COALESCE(SUM(sc.durationMs), 0) as durationMs
        ${from} ${where}
        GROUP BY sc.agentId
        ORDER BY costUsd DESC`,
      params,
    );
  }

  // Per-requester breakdown. Structurally-human-free work is assigned to the
  // autonomous bucket even if a stale requester id survives on the task.
  let byUser: SessionCostByUserRow[] = [];
  if (groupBy === "user" || groupBy === "both") {
    byUser = await getDbClient().query<SessionCostByUserRow>(
      `WITH RECURSIVE ${HUMAN_FREE_TASKS_CTE}
        SELECT
          CASE WHEN ${HUMAN_FREE_SQL} THEN NULL ELSE t.requestedByUserId END as userId,
          COALESCE(SUM(sc.totalCostUsd), 0) as costUsd,
          COALESCE(SUM(sc.inputTokens), 0) as inputTokens,
          COALESCE(SUM(sc.outputTokens), 0) as outputTokens,
          COUNT(DISTINCT sc.taskId) as tasks,
          COALESCE(SUM(sc.durationMs), 0) as durationMs
        ${from} ${where}
        GROUP BY CASE WHEN ${HUMAN_FREE_SQL} THEN NULL ELSE t.requestedByUserId END
        ORDER BY costUsd DESC`,
      params,
    );
  }

  return { totals, daily, byAgent, byUser };
}

// --- Per-person attribution (four-metric view) ---

export interface AttributionByPersonRow {
  userId: string;
  /** Root tasks (`parentTaskId IS NULL`) only — counting fan-out children would let
   *  whoever triggers the biggest decomposition win by accident. */
  problemsInitiated: number;
  /** Roots that completed AND show shippable evidence — see `getAttributionByPerson` doc. */
  problemsShipped: number;
  /** Distinct agents engaged across the person's entire task tree (not root-scoped —
   *  a root that fans out to nine agents is nine agents of reach). */
  agentsReached: number;
  reposReached: number;
  surfacesReached: number;
  /**
   * Share of root tasks completed without a re-dispatch or a human correction.
   * Deliberately `null`: distinguishing a legitimate multi-agent fan-out from a
   * correction-driven re-dispatch isn't computable from a single query pass
   * (would need to inspect *why* a child task was created, which isn't a stored
   * fact), and a task-count-based proxy would misclassify normal delegation as
   * rework. Render as "not yet computed" — do not invent a stand-in.
   */
  firstPassYield: null;
}

/**
 * Four metrics per human requester, reported side by side — never summed into
 * a composite score. Scope is root tasks (`problemsInitiated`/`problemsShipped`)
 * or the person's entire task tree (`*Reached`); `requestedByUserId IS NULL`
 * (autonomous work) and structurally-human-free rows with a stale/inherited
 * requester (see `HUMAN_FREE_SQL` in `getSessionCostSummary`) are excluded —
 * neither belongs to a person.
 *
 * "Problems shipped" detection walks each root's full task tree, preferring a
 * `task_attachments` row (`kind='url'` matching a GitHub PR or GitLab MR URL,
 * or `kind='page'` for a published artifact) and falling back to the same
 * provider-specific URL match on any task output. GitLab matching is host
 * agnostic so self-hosted instances are covered. This does NOT detect a closed ticket (no
 * Linear/Jira issue-state table exists locally) — "shipped" undercounts
 * ticket-only outcomes until the real artifacts join lands.
 */
export async function getAttributionByPerson(opts: {
  startDate?: string;
  endDate?: string;
}): Promise<AttributionByPersonRow[]> {
  const conditions: string[] = ["t.requestedByUserId IS NOT NULL"];
  const params: string[] = [];
  if (opts.startDate) {
    conditions.push("t.createdAt >= ?");
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    // A date-only value represents the whole UTC day. Preserve inclusive
    // timestamp semantics for callers that provide an exact instant.
    const dateOnlyEnd = /^\d{4}-\d{2}-\d{2}$/.test(opts.endDate)
      ? new Date(`${opts.endDate}T00:00:00.000Z`)
      : null;
    if (
      dateOnlyEnd &&
      !Number.isNaN(dateOnlyEnd.getTime()) &&
      dateOnlyEnd.toISOString().slice(0, 10) === opts.endDate
    ) {
      dateOnlyEnd.setUTCDate(dateOnlyEnd.getUTCDate() + 1);
      conditions.push("t.createdAt < ?");
      params.push(dateOnlyEnd.toISOString());
    } else {
      conditions.push("t.createdAt <= ?");
      params.push(opts.endDate);
    }
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  type RootRow = { userId: string; initiated: number; shipped: number };
  const rootRows = await getDbClient().query<RootRow>(
    `WITH RECURSIVE selected_roots(id, requestedByUserId, status, output) AS (
        SELECT t.id, t.requestedByUserId, t.status, t.output
        FROM agent_tasks t
        ${where} AND t.parentTaskId IS NULL AND NOT ${ROOT_HUMAN_FREE_SQL}
      ),
      task_tree(rootId, taskId, output) AS (
        SELECT id, id, output
        FROM selected_roots

        UNION ALL

        SELECT tree.rootId, child.id, child.output
        FROM agent_tasks child
        JOIN task_tree tree ON child.parentTaskId = tree.taskId
      ),
      -- Every root with shippable evidence anywhere in its tree, computed ONCE for
      -- the whole window. The old form asked the same question with 3 CORRELATED
      -- EXISTS subqueries, which SQLite re-entered once per root: 2 of them scanned
      -- task_attachments whole and the third scanned the whole tree with two
      -- leading-wildcard LIKEs. That is the O(R x T) shape that took 60 s.
      --
      -- Two rules keep this fast and correct, and both are load-bearing:
      --   1. UNION, never UNION ALL. It makes rootId unique, so the LEFT JOIN below
      --      cannot duplicate a root and COUNT(*) stays exact.
      --   2. LEFT JOIN, never a correlated EXISTS against this CTE. The EXISTS form
      --      returns the same answer but SQLite re-enters the CTE per root:
      --      measured 4,189 ms for a 2-day window against 460 ms for 30 days.
      shipped_roots(rootId) AS (
        SELECT tree.rootId
        FROM task_tree tree
        JOIN task_attachments ta ON ta.task_id = tree.taskId
        WHERE ta.kind = 'page'
           OR (
             ta.kind = 'url'
             AND (
               ta.url LIKE '%github.com/%/pull/%'
               OR ta.url LIKE '%/-/merge_requests/%'
             )
           )

        UNION

        SELECT tree.rootId
        FROM task_tree tree
        WHERE tree.output LIKE '%github.com/%/pull/%'
           OR tree.output LIKE '%/-/merge_requests/%'
      )
      SELECT
        t.requestedByUserId as userId,
        COUNT(*) as initiated,
        SUM(CASE WHEN t.status = 'completed' AND s.rootId IS NOT NULL THEN 1 ELSE 0 END) as shipped
      FROM selected_roots t
      LEFT JOIN shipped_roots s ON s.rootId = t.id
      GROUP BY t.requestedByUserId`,
    params,
  );

  type ReachRow = {
    userId: string;
    agentsReached: number;
    reposReached: number;
    surfacesReached: number;
  };
  const reachRows = await getDbClient().query<ReachRow>(
    `WITH RECURSIVE report_tasks AS (
        SELECT t.*
        FROM agent_tasks t
        ${where}
      ),
      task_ancestry(
        taskId, id, parentTaskId, requestedByUserId, requestedByUserIdInherited,
        taskType, tags, source, workflowRunId
      ) AS (
        SELECT
          id, id, parentTaskId, requestedByUserId, requestedByUserIdInherited,
          taskType, tags, source, workflowRunId
        FROM report_tasks

        UNION ALL

        SELECT
          child.taskId, parent.id, parent.parentTaskId, parent.requestedByUserId,
          parent.requestedByUserIdInherited, parent.taskType, parent.tags,
          parent.source, parent.workflowRunId
        FROM agent_tasks parent
        JOIN task_ancestry child ON parent.id = child.parentTaskId
        WHERE child.requestedByUserId IS NULL
          OR child.requestedByUserIdInherited = 1
      ),
      human_free_report_tasks(id) AS (
        SELECT DISTINCT ancestor.taskId
        FROM task_ancestry ancestor
        LEFT JOIN agent_tasks parent ON parent.id = ancestor.parentTaskId
        WHERE COALESCE(ancestor.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
          OR COALESCE(ancestor.tags, '[]') LIKE '%"heartbeat"%'
          OR (COALESCE(ancestor.source, '') = 'schedule' AND ancestor.requestedByUserId IS NULL)
          OR (
            ancestor.parentTaskId IS NULL
            AND COALESCE(ancestor.source, '') = 'workflow'
            AND ancestor.requestedByUserId IS NULL
            AND EXISTS (
              SELECT 1
              FROM workflow_runs run
              WHERE run.id = ancestor.workflowRunId
                AND run.triggerType = 'schedule'
                AND run.created_by IS NULL
            )
          )
          OR (
            COALESCE(ancestor.source, '') = 'system'
            AND parent.id IS NOT NULL
            AND parent.requestedByUserId IS NULL
          )
      )
      SELECT
        t.requestedByUserId as userId,
        COUNT(DISTINCT t.agentId) as agentsReached,
        COUNT(DISTINCT t.vcsRepo) as reposReached,
        COUNT(DISTINCT t.source) as surfacesReached
      FROM report_tasks t
      WHERE NOT EXISTS (SELECT 1 FROM human_free_report_tasks WHERE id = t.id)
      GROUP BY t.requestedByUserId`,
    params,
  );

  const byUser = new Map<string, AttributionByPersonRow>();
  for (const r of rootRows) {
    byUser.set(r.userId, {
      userId: r.userId,
      problemsInitiated: r.initiated,
      problemsShipped: r.shipped,
      agentsReached: 0,
      reposReached: 0,
      surfacesReached: 0,
      firstPassYield: null,
    });
  }
  for (const r of reachRows) {
    const existing = byUser.get(r.userId);
    if (existing) {
      existing.agentsReached = r.agentsReached;
      existing.reposReached = r.reposReached;
      existing.surfacesReached = r.surfacesReached;
    } else {
      // Reach with no root task in-window (e.g. only fan-out children whose
      // root predates the window) — still a real person row.
      byUser.set(r.userId, {
        userId: r.userId,
        problemsInitiated: 0,
        problemsShipped: 0,
        agentsReached: r.agentsReached,
        reposReached: r.reposReached,
        surfacesReached: r.surfacesReached,
        firstPassYield: null,
      });
    }
  }

  return Array.from(byUser.values());
}

// --- Dashboard cost summary (P4) ---

export interface DashboardCostSummary {
  costToday: number;
  costMtd: number;
}

export async function getDashboardCostSummary(): Promise<DashboardCostSummary> {
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
  const row = await getDbClient().get<CostRow>(
    `SELECT
        COALESCE(SUM(CASE WHEN createdAt >= ? THEN totalCostUsd ELSE 0 END), 0) as costToday,
        COALESCE(SUM(totalCostUsd), 0) as costMtd
      FROM session_costs
      WHERE createdAt >= ?`,
    [startOfDayUtc, startOfMonthUtc],
  );

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

export async function createInboxMessage(
  agentId: string,
  content: string,
  options?: CreateInboxMessageOptions,
): Promise<InboxMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<InboxMessageRow>(
    `INSERT INTO inbox_messages (id, agentId, content, source, status, slackChannelId, slackThreadTs, slackUserId, matchedText, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create inbox message");
  return rowToInboxMessage(row);
}

export async function getInboxMessageById(id: string): Promise<InboxMessage | null> {
  const row = await getDbClient().get<InboxMessageRow>(
    "SELECT * FROM inbox_messages WHERE id = ?",
    [id],
  );
  return row ? rowToInboxMessage(row) : null;
}

export async function getUnreadInboxMessages(agentId: string): Promise<InboxMessage[]> {
  const rows = await getDbClient().query<InboxMessageRow>(
    "SELECT * FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC",
    [agentId],
  );
  return rows.map(rowToInboxMessage);
}

/**
 * Atomically claim up to N unread inbox messages for processing.
 * Marks them as 'processing' to prevent duplicate polling.
 * Returns empty array if no unread messages available.
 */
export async function claimInboxMessages(
  agentId: string,
  limit: number = 5,
): Promise<InboxMessage[]> {
  const now = new Date().toISOString();
  const client = getDbClient();

  // Get IDs of unread messages to claim
  const unreadRows = await client.query<{ id: string }>(
    "SELECT id FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC LIMIT ?",
    [agentId, limit],
  );
  const unreadIds = unreadRows.map((row) => row.id);

  if (unreadIds.length === 0) {
    return [];
  }

  // Atomically update status to 'processing' for these specific IDs
  const placeholders = unreadIds.map(() => "?").join(",");
  const rows = await client.query<InboxMessageRow>(
    `UPDATE inbox_messages SET status = 'processing', lastUpdatedAt = ?
       WHERE id IN (${placeholders}) AND status = 'unread' RETURNING *`,
    [now, ...unreadIds],
  );

  return rows.map(rowToInboxMessage);
}

export async function markInboxMessageRead(id: string): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<InboxMessageRow>(
    "UPDATE inbox_messages SET status = 'read', lastUpdatedAt = ? WHERE id = ? RETURNING *",
    [now, id],
  );
  return row ? rowToInboxMessage(row) : null;
}

export async function markInboxMessageResponded(
  id: string,
  responseText: string,
): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<InboxMessageRow>(
    "UPDATE inbox_messages SET status = 'responded', responseText = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    [responseText, now, id],
  );
  return row ? rowToInboxMessage(row) : null;
}

export async function markInboxMessageDelegated(
  id: string,
  taskId: string,
): Promise<InboxMessage | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<InboxMessageRow>(
    "UPDATE inbox_messages SET status = 'delegated', delegatedToTaskId = ?, lastUpdatedAt = ? WHERE id = ? AND status IN ('unread', 'processing') RETURNING *",
    [taskId, now, id],
  );
  return row ? rowToInboxMessage(row) : null;
}

/**
 * Release inbox messages that have been in 'processing' status for too long.
 * This handles cases where Claude process crashes or fails to respond/delegate.
 * Call this periodically from the runner or add a database trigger.
 */
export async function releaseStaleProcessingInbox(timeoutMinutes: number = 30): Promise<number> {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = await getDbClient().run(
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
export async function getConcurrentContext(): Promise<ConcurrentContext> {
  const client = getDbClient();

  // 1. Inbox messages currently being processed (status = 'processing')
  const processingInboxMessages = await client.query<{
    id: string;
    content: string;
    source: string;
    slackChannelId: string | null;
    slackThreadTs: string | null;
    createdAt: string;
  }>(
    "SELECT id, content, source, slackChannelId, slackThreadTs, createdAt FROM inbox_messages WHERE status = 'processing' ORDER BY createdAt DESC",
  );

  // 2. Tasks created in the last 5 minutes by lead agents
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recentTaskDelegations = await client.query<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    creatorAgentId: string | null;
    status: string;
    createdAt: string;
  }>(
    `SELECT t.id, t.task, t.agentId, a.name as agentName, t.creatorAgentId, t.status, t.createdAt
       FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.createdAt > ?
         AND t.creatorAgentId IN (SELECT id FROM agents WHERE isLead = 1)
       ORDER BY t.createdAt DESC`,
    [fiveMinutesAgo],
  );

  // 3. Currently in-progress tasks across the swarm
  const activeSwarmTasks = await client.query<{
    id: string;
    task: string;
    agentId: string | null;
    agentName: string | null;
    status: string;
    createdAt: string;
    progress: string | null;
  }>(
    `SELECT t.id, t.task, t.agentId, a.name as agentName, t.status, t.createdAt, t.progress
       FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status = 'in_progress'
       ORDER BY t.createdAt DESC`,
  );

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
  key: string;
  name: string;
  description: string | null;
  cronExpression: string | null;
  intervalMs: number | null;
  taskTemplate: string | null;
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
  targetType: string;
  workflowId: string | null;
  scriptName: string | null;
  scriptArgs: string | null;
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
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    cronExpression: row.cronExpression ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    taskTemplate: row.taskTemplate ?? undefined,
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
    targetType: row.targetType as "agent-task" | "workflow" | "script",
    workflowId: row.workflowId ?? undefined,
    scriptName: row.scriptName ?? undefined,
    scriptArgs: row.scriptArgs ? JSON.parse(row.scriptArgs) : undefined,
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
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string;
  scriptName?: string;
  consecutiveErrorsMin?: number;
  lastRunStatus?: "failed" | "succeeded";
  key?: string;
  keyPrefix?: string;
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

export function getScheduledTasks(filters?: ScheduledTaskFilters): Promise<ScheduledTask[]>;
export function getScheduledTasks(
  filters: ScheduledTaskFilters | undefined,
  opts: { slim: true },
): Promise<ScheduledTaskSummary[]>;
export async function getScheduledTasks(
  filters?: ScheduledTaskFilters,
  opts?: { slim?: boolean },
): Promise<ScheduledTask[] | ScheduledTaskSummary[]> {
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

  if (filters?.targetType) {
    query += " AND targetType = ?";
    params.push(filters.targetType);
  }

  if (filters?.workflowId) {
    query += " AND workflowId = ?";
    params.push(filters.workflowId);
  }

  if (filters?.scriptName) {
    query += " AND scriptName = ?";
    params.push(filters.scriptName);
  }

  if (filters?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
  }

  if (filters?.consecutiveErrorsMin !== undefined) {
    query += " AND consecutiveErrors >= ?";
    params.push(filters.consecutiveErrorsMin);
  }

  if (filters?.lastRunStatus === "failed") {
    query += " AND consecutiveErrors > 0";
  } else if (filters?.lastRunStatus === "succeeded") {
    query += " AND lastRunAt IS NOT NULL AND consecutiveErrors = 0";
  }

  if (filters?.hideCompleted !== false) {
    query += " AND NOT (scheduleType = 'one_time' AND enabled = 0)";
  }

  query += " ORDER BY lastRunAt IS NULL ASC, lastRunAt DESC, lastUpdatedAt DESC";

  const rows = await getDbClient().query<ScheduledTaskRow>(query, params);
  return opts?.slim ? rows.map(rowToScheduledTaskSummary) : rows.map(rowToScheduledTask);
}

export async function getScheduledTaskById(id: string): Promise<ScheduledTask | null> {
  const row = await getDbClient().get<ScheduledTaskRow>(
    "SELECT * FROM scheduled_tasks WHERE id = ?",
    [id],
  );
  return row ? rowToScheduledTask(row) : null;
}

export async function getScheduledTaskByName(name: string): Promise<ScheduledTask | null> {
  const row = await getDbClient().get<ScheduledTaskRow>(
    "SELECT * FROM scheduled_tasks WHERE name = ?",
    [name],
  );
  return row ? rowToScheduledTask(row) : null;
}

export interface CreateScheduledTaskData {
  key?: string;
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate?: string;
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
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string;
  scriptName?: string;
  scriptArgs?: Record<string, unknown>;
  createdBy?: string;
}

export async function createScheduledTask(data: CreateScheduledTaskData): Promise<ScheduledTask> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ScheduledTaskRow>(
    `INSERT INTO scheduled_tasks (
        id, "key", name, description, cronExpression, intervalMs, taskTemplate,
        taskType, tags, priority, targetAgentId, enabled, nextRunAt,
        createdByAgentId, timezone, model, modelTier, scheduleType, targetType,
        workflowId, scriptName, scriptArgs, createdAt, lastUpdatedAt,
        created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      normalizeAssetKey(data.key ?? defaultAssetKey("schedule", id)),
      data.name,
      data.description ?? null,
      data.cronExpression ?? null,
      data.intervalMs ?? null,
      data.taskTemplate ?? null,
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
      data.targetType ?? "agent-task",
      data.workflowId ?? null,
      data.scriptName ?? null,
      data.scriptArgs !== undefined ? JSON.stringify(data.scriptArgs) : "{}",
      now,
      now,
      data.createdBy ?? null,
      data.createdBy ?? null,
    ],
  );

  if (!row) throw new Error("Failed to create scheduled task");
  return rowToScheduledTask(row);
}

export interface UpdateScheduledTaskData {
  key?: string;
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
  targetType?: "agent-task" | "workflow" | "script";
  workflowId?: string | null;
  scriptName?: string | null;
  scriptArgs?: Record<string, unknown> | null;
  lastUpdatedAt?: string;
  updatedBy?: string;
}

export async function updateScheduledTask(
  id: string,
  data: UpdateScheduledTaskData,
): Promise<ScheduledTask | null> {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (data.key !== undefined) {
    updates.push('"key" = ?');
    params.push(normalizeAssetKey(data.key));
  }

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
  if (data.targetType !== undefined) {
    updates.push("targetType = ?");
    params.push(data.targetType);
  }
  if (data.workflowId !== undefined) {
    updates.push("workflowId = ?");
    params.push(data.workflowId);
  }
  if (data.scriptName !== undefined) {
    updates.push("scriptName = ?");
    params.push(data.scriptName);
  }
  if (data.scriptArgs !== undefined) {
    updates.push("scriptArgs = ?");
    params.push(data.scriptArgs === null ? null : JSON.stringify(data.scriptArgs));
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

  const row = await getDbClient().get<ScheduledTaskRow>(
    `UPDATE scheduled_tasks SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );

  return row ? rowToScheduledTask(row) : null;
}

export async function deleteScheduledTask(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Get all enabled scheduled tasks that are due for execution.
 * A task is due when its nextRunAt time is <= now.
 */
export async function getDueScheduledTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const rows = await getDbClient().query<ScheduledTaskRow>(
    `SELECT * FROM scheduled_tasks
       WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?
       ORDER BY nextRunAt ASC`,
    [now],
  );
  return rows.map(rowToScheduledTask);
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
export async function getSwarmConfigs(filters?: {
  scope?: string;
  scopeId?: string;
  key?: string;
}): Promise<SwarmConfig[]> {
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

  const rows = await getDbClient().query<SwarmConfigRow>(query, params);
  return rows.map(rowToSwarmConfig);
}

/**
 * Global configs that are allowed to flow into process.env.
 * Reserved env-only keys are filtered in SQL before decryption so a corrupted
 * legacy reserved row cannot block startup or reload.
 */
export async function getInjectableGlobalConfigs(): Promise<SwarmConfig[]> {
  const rows = await getDbClient().query<SwarmConfigRow>(
    `SELECT * FROM swarm_config
       WHERE scope = 'global'
         AND UPPER(key) NOT IN ('API_KEY', 'SECRETS_ENCRYPTION_KEY')
       ORDER BY key ASC`,
  );
  return rows.map(rowToSwarmConfig);
}

/**
 * Get a single config entry by ID.
 */
export async function getSwarmConfigById(id: string): Promise<SwarmConfig | null> {
  const row = await getDbClient().get<SwarmConfigRow>("SELECT * FROM swarm_config WHERE id = ?", [
    id,
  ]);
  return row ? rowToSwarmConfig(row) : null;
}

/**
 * Get config metadata by ID without decrypting the value. Used by cleanup
 * paths so unreadable secret rows can still be inspected and removed.
 */
export async function getSwarmConfigLookupById(id: string): Promise<{
  id: string;
  scope: "global" | "agent" | "repo";
  scopeId: string | null;
  key: string;
  isSecret: boolean;
  encrypted: boolean;
} | null> {
  const row = await getDbClient().get<SwarmConfigLookupRow>(
    "SELECT id, scope, scopeId, key, isSecret, encrypted FROM swarm_config WHERE id = ?",
    [id],
  );
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
export async function upsertSwarmConfig(data: {
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
  envPath?: string | null;
  description?: string | null;
}): Promise<SwarmConfig> {
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
  //
  // Lookup and write share one transaction: without it two concurrent saves of
  // the same global key both read `existing = null` and both INSERT (the
  // UNIQUE constraint cannot arbitrate a NULL scopeId), leaving a duplicate
  // pair where env injection reads the last row and every later save updates
  // the first one, i.e. a permanent silent no-op.
  const row = await getDbClient().transaction(async () => {
    const existing =
      scopeId === null
        ? await getDbClient().get<{ id: string }>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId IS NULL AND key = ?",
            [data.scope, data.key],
          )
        : await getDbClient().get<{ id: string }>(
            "SELECT id FROM swarm_config WHERE scope = ? AND scopeId = ? AND key = ?",
            [data.scope, scopeId, data.key],
          );

    if (existing) {
      return await getDbClient().get<SwarmConfigRow>(
        `UPDATE swarm_config SET value = ?, isSecret = ?, envPath = ?, description = ?, encrypted = ?, lastUpdatedAt = ?
         WHERE id = ? RETURNING *`,
        [storedValue, isSecret, envPath, description, encryptedFlag, now, existing.id],
      );
    }

    const id = crypto.randomUUID();
    return await getDbClient().get<SwarmConfigRow>(
      `INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [
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
      ],
    );
  });

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

  if (config.isSecret) {
    registerVolatileSecret(config.value, `config:${config.key}`);
  }

  return config;
}

/**
 * Delete a config entry by ID.
 *
 * Intentionally does not decrypt or block reserved keys. Legacy rows that
 * predate hardening must remain removable through remediation paths.
 */
export async function deleteSwarmConfig(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM swarm_config WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Delete a config entry looked up by (scope, scopeId, key) rather than row
 * id. Callers like the runtime PATCH route (`PATCH /api/agents/{id}/runtime`)
 * know the logical key (e.g. `MODEL_OVERRIDE`, `REASONING_EFFORT_OVERRIDE`)
 * but not the row id — `deleteSwarmConfig(id)` alone can't serve them. No-ops
 * (returns `false`) when no matching row exists, mirroring `upsertSwarmConfig`'s
 * NULL-safe existing-row lookup (SQLite's UNIQUE constraint treats NULL !=
 * NULL, so a plain `scopeId = ?` comparison never matches global scope).
 */
export async function deleteSwarmConfigByKey(
  scope: "global" | "agent" | "repo",
  scopeId: string | null,
  key: string,
): Promise<boolean> {
  const resolvedScopeId = scope === "global" ? null : scopeId;
  const existing =
    resolvedScopeId === null
      ? await getDbClient().get<{ id: string }>(
          "SELECT id FROM swarm_config WHERE scope = ? AND scopeId IS NULL AND key = ?",
          [scope, key],
        )
      : await getDbClient().get<{ id: string }>(
          "SELECT id FROM swarm_config WHERE scope = ? AND scopeId = ? AND key = ?",
          [scope, resolvedScopeId, key],
        );
  if (!existing) return false;
  return await deleteSwarmConfig(existing.id);
}

/**
 * Get resolved (merged) config for a given agent and/or repo.
 * Scope resolution: repo > agent > global (most-specific wins).
 * Returns one entry per unique key with the most-specific scope winning.
 */
export async function getResolvedConfig(agentId?: string, repoId?: string): Promise<SwarmConfig[]> {
  // Start with global configs
  const configMap = new Map<string, SwarmConfig>();

  const globalConfigs = await getSwarmConfigs({ scope: "global" });
  for (const config of globalConfigs) {
    configMap.set(config.key, config);
  }

  // Overlay agent configs (agent wins over global)
  if (agentId) {
    const agentConfigs = await getSwarmConfigs({ scope: "agent", scopeId: agentId });
    for (const config of agentConfigs) {
      configMap.set(config.key, config);
    }
  }

  // Overlay repo configs (repo wins over agent and global)
  if (repoId) {
    const repoConfigs = await getSwarmConfigs({ scope: "repo", scopeId: repoId });
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

export async function getSwarmRepos(filters?: {
  autoClone?: boolean;
  name?: string;
}): Promise<SwarmRepo[]> {
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

  const rows = await getDbClient().query<SwarmRepoRow>(query, params);
  return rows.map(rowToSwarmRepo);
}

export async function getSwarmRepoById(id: string): Promise<SwarmRepo | null> {
  const row = await getDbClient().get<SwarmRepoRow>("SELECT * FROM swarm_repos WHERE id = ?", [id]);
  return row ? rowToSwarmRepo(row) : null;
}

export async function getSwarmRepoByName(name: string): Promise<SwarmRepo | null> {
  const row = await getDbClient().get<SwarmRepoRow>("SELECT * FROM swarm_repos WHERE name = ?", [
    name,
  ]);
  return row ? rowToSwarmRepo(row) : null;
}

export async function getSwarmRepoByUrl(url: string): Promise<SwarmRepo | null> {
  const row = await getDbClient().get<SwarmRepoRow>("SELECT * FROM swarm_repos WHERE url = ?", [
    url,
  ]);
  return row ? rowToSwarmRepo(row) : null;
}

export async function createSwarmRepo(data: {
  url: string;
  name: string;
  clonePath?: string;
  defaultBranch?: string;
  autoClone?: boolean;
  hooks?: { enabled: boolean };
  guidelines?: RepoGuidelines | null;
}): Promise<SwarmRepo> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clonePath = data.clonePath || `/workspace/personal/repos/${data.name}`;
  const hooksJson = JSON.stringify(data.hooks ?? { enabled: true });
  const guidelinesJson = data.guidelines ? JSON.stringify(data.guidelines) : null;

  const row = await getDbClient().get<SwarmRepoRow>(
    `INSERT INTO swarm_repos (id, url, name, clonePath, defaultBranch, autoClone, hooks, guidelines, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create repo");
  return rowToSwarmRepo(row);
}

export async function updateSwarmRepo(
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
): Promise<SwarmRepo | null> {
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

  if (setClauses.length === 0) return await getSwarmRepoById(id);

  setClauses.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);

  const row = await getDbClient().get<SwarmRepoRow>(
    `UPDATE swarm_repos SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );

  return row ? rowToSwarmRepo(row) : null;
}

export async function deleteSwarmRepo(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM swarm_repos WHERE id = ?", [id]);
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

export async function getAgentMailInboxMapping(
  inboxId: string,
): Promise<AgentMailInboxMapping | null> {
  return (
    (await getDbClient().get<AgentMailInboxMapping>(
      "SELECT * FROM agentmail_inbox_mappings WHERE inboxId = ?",
      [inboxId],
    )) ?? null
  );
}

export async function getAgentMailInboxMappingsByAgent(
  agentId: string,
): Promise<AgentMailInboxMapping[]> {
  return await getDbClient().query<AgentMailInboxMapping>(
    "SELECT * FROM agentmail_inbox_mappings WHERE agentId = ? ORDER BY createdAt DESC",
    [agentId],
  );
}

export async function getAllAgentMailInboxMappings(): Promise<AgentMailInboxMapping[]> {
  return await getDbClient().query<AgentMailInboxMapping>(
    "SELECT * FROM agentmail_inbox_mappings ORDER BY createdAt DESC",
  );
}

export async function createAgentMailInboxMapping(
  inboxId: string,
  agentId: string,
  inboxEmail?: string,
): Promise<AgentMailInboxMapping> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<AgentMailInboxMapping>(
    `INSERT INTO agentmail_inbox_mappings (id, inboxId, agentId, inboxEmail, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(inboxId) DO UPDATE SET agentId = excluded.agentId, inboxEmail = excluded.inboxEmail
       RETURNING *`,
    [id, inboxId, agentId, inboxEmail ?? null, now],
  );

  if (!row) throw new Error("Failed to create AgentMail inbox mapping");
  return row;
}

export async function deleteAgentMailInboxMapping(inboxId: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM agentmail_inbox_mappings WHERE inboxId = ?", [
    inboxId,
  ]);
  return result.changes > 0;
}

/**
 * Find the most recent task by AgentMail thread ID
 * Includes completed/failed tasks to maintain thread continuity via parentTaskId
 */
export async function findTaskByAgentMailThread(
  agentmailThreadId: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE agentmailThreadId = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [agentmailThreadId],
  );
  return row ? rowToAgentTask(row) : null;
}

// ============================================================================
// Active Sessions (runner session tracking for concurrency awareness)
// ============================================================================

export async function insertActiveSession(session: {
  agentId: string;
  taskId?: string;
  triggerType: string;
  inboxMessageId?: string;
  taskDescription?: string;
  runnerSessionId?: string;
  runtimeInstanceId?: string;
}): Promise<ActiveSession> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ActiveSession>(
    `INSERT INTO active_sessions (id, agentId, taskId, triggerType, inboxMessageId, taskDescription, runnerSessionId, runtimeInstanceId, startedAt, lastHeartbeatAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
      id,
      session.agentId,
      session.taskId ?? null,
      session.triggerType,
      session.inboxMessageId ?? null,
      session.taskDescription ?? null,
      session.runnerSessionId ?? null,
      session.runtimeInstanceId ?? null,
      now,
      now,
    ],
  );

  if (!row) throw new Error("Failed to insert active session");
  return row;
}

export async function deleteActiveSession(taskId: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [taskId]);
  return result.changes > 0;
}

export async function deleteActiveSessionById(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM active_sessions WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function getActiveSessions(agentId?: string): Promise<ActiveSession[]> {
  if (agentId) {
    return await getDbClient().query<ActiveSession>(
      "SELECT * FROM active_sessions WHERE agentId = ? ORDER BY startedAt DESC",
      [agentId],
    );
  }
  return await getDbClient().query<ActiveSession>(
    "SELECT * FROM active_sessions ORDER BY startedAt DESC",
  );
}

export async function heartbeatActiveSession(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await getDbClient().run(
    "UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?",
    [now, taskId],
  );
  return result.changes > 0;
}

export async function cleanupStaleSessions(maxAgeMinutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const result = await getDbClient().run("DELETE FROM active_sessions WHERE lastHeartbeatAt < ?", [
    cutoff,
  ]);
  return result.changes;
}

export async function cleanupAgentSessions(agentId: string): Promise<number> {
  const result = await getDbClient().run("DELETE FROM active_sessions WHERE agentId = ?", [
    agentId,
  ]);
  return result.changes;
}

/** Update providerSessionId on an active session identified by taskId */
export async function updateActiveSessionProviderSessionId(
  taskId: string,
  providerSessionId: string,
): Promise<boolean> {
  const result = await getDbClient().run(
    "UPDATE active_sessions SET providerSessionId = ? WHERE taskId = ?",
    [providerSessionId, taskId],
  );
  return result.changes > 0;
}

/**
 * Get the active session for a specific task.
 * Used by the heartbeat to cross-reference stalled tasks with worker sessions.
 */
export async function getActiveSessionForTask(taskId: string): Promise<ActiveSession | null> {
  return (
    (await getDbClient().get<ActiveSession>(
      "SELECT * FROM active_sessions WHERE taskId = ? LIMIT 1",
      [taskId],
    )) ?? null
  );
}

/**
 * Reassociate session logs from a runner session to a real task ID.
 * Used when a pool task is claimed — logs were stored under a random UUID,
 * this updates them to use the real task ID.
 * Idempotent — safe to call multiple times.
 */
export async function reassociateSessionLogs(
  runnerSessionId: string,
  realTaskId: string,
): Promise<number> {
  const result = await getDbClient().run(
    "UPDATE session_logs SET taskId = ? WHERE sessionId = ? AND taskId != ?",
    [realTaskId, runnerSessionId, realTaskId],
  );
  return result.changes;
}

// ============================================================================
// Heartbeat / Triage Query Functions
// ============================================================================

/**
 * Get in_progress tasks that haven't been updated within the given threshold.
 * Used by the heartbeat to detect potentially stalled tasks.
 */
export async function getStalledInProgressTasks(
  thresholdMinutes: number = 30,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE status = 'in_progress' AND lastUpdatedAt < ?
       ORDER BY lastUpdatedAt ASC`,
    [cutoff],
  );
  return rows.map(rowToAgentTask);
}

/**
 * Genuine same-agent protected pins — resumes tagged `crash-recovery-pin` /
 * `graceful-shutdown-pin`, OR a reboot-retry child tagged `reboot-retry-pin`
 * (routing-affinity Phase 3) — that are still `pending` `graceMin` minutes
 * after creation. The heartbeat reaper escalates these to a Lead
 * reroute-decision.
 *
 * Scoping clauses, each load-bearing:
 *  - `taskType = 'resume' AND (crash/graceful pin tags)` OR `reboot-retry-pin`
 *    tag alone — restricts to work actually pinned to its original agent on a
 *    protected path. A reboot-retry-pin task is a FRESH task (`taskType`
 *    mirrors the original work, not `'resume'`), so it needs its own
 *    disjunct rather than reusing the `taskType = 'resume'` gate. Without
 *    this, a *pooled* resume that `autoAssignPoolTasks` flips to `pending`
 *    earlier in the SAME sweep (keeping its old `createdAt`) would be reaped
 *    and cancelled before the assigned worker polls; it also keeps
 *    `context_limits` / `manual_supersede` pins from being escalated under
 *    the protected-pin label. (Literals must match the pin tag constants in
 *    src/tasks/worker-follow-up.ts.)
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
export async function getStalePinnedResumes(graceMin: number): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - graceMin * 60 * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE status = 'pending'
         AND (
           (taskType = 'resume' AND (tags LIKE '%"crash-recovery-pin"%' OR tags LIKE '%"graceful-shutdown-pin"%'))
           OR tags LIKE '%"reboot-retry-pin"%'
         )
         AND createdAt < ?
       ORDER BY createdAt ASC`,
    [cutoff],
  );
  return rows.map(rowToAgentTask);
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
export async function failPendingResumeIfUnclaimed(
  taskId: string,
  status: "cancelled" | "failed",
  failureReason: string,
): Promise<AgentTask | null> {
  const now = new Date().toISOString();
  const scrubbedReason = scrubSecrets(failureReason);
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = ?, failureReason = ?, finishedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status = 'pending' RETURNING *`,
    [status, scrubbedReason, now, now, taskId],
  );

  if (row) {
    try {
      await createLogEntry({
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
export async function getIdleWorkersWithCapacity(): Promise<Agent[]> {
  const rows = await getDbClient().query<AgentRow>(
    `SELECT * FROM agents
       WHERE status = 'idle' AND isLead = 0`,
  );
  const agents = rows.map((row) => rowToAgent(row));

  const withCapacity = await Promise.all(
    agents.map(async (agent) => {
      const activeCount = await getActiveTaskCount(agent.id);
      return activeCount < (agent.maxTasks ?? 1) ? agent : null;
    }),
  );
  return withCapacity.filter((agent): agent is Agent => agent !== null);
}

/**
 * Get unassigned pool tasks ordered by priority (DESC), creation time (ASC),
 * then `rowid` (ASC) as a stable tiebreaker. The `rowid` tiebreaker matters
 * once `offset` is used for pagination (`autoAssignPoolTasks` in
 * src/heartbeat/heartbeat.ts) — without it, rows sharing a `createdAt` could
 * be skipped or repeated across pages. Used by the heartbeat for
 * auto-assignment and status reporting.
 */
export async function getUnassignedPoolTasks(
  limit: number = 10,
  offset: number = 0,
): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE status = 'unassigned'
       ORDER BY priority DESC, createdAt ASC, rowid ASC
       LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map(rowToAgentTask);
}

/**
 * Affinity-tagged pool tasks that have sat `unassigned` past `cutoffIso` —
 * the starvation-escalation candidate set (routing-affinity Phase 3). Callers
 * MUST separately confirm zero registered agents satisfy
 * `isAgentEligibleForTask` before escalating; this only narrows by tag age.
 */
export async function getStaleUnassignedAffinityTasks(cutoffIso: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE status = 'unassigned' AND routingAffinity IS NOT NULL AND createdAt < ?
       ORDER BY createdAt ASC`,
    [cutoffIso],
  );
  return rows.map(rowToAgentTask);
}

export async function getRecentFailedTasks(hours: number = 6): Promise<AgentTask[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE status = 'failed'
         AND finishedAt > ?
       ORDER BY finishedAt DESC
       LIMIT 20`,
    [since],
  );
  return rows.map(rowToAgentTask);
}

export async function getRecentCompletedCount(hours: number = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_tasks
       WHERE status = 'completed' AND finishedAt > ?`,
    [since],
  );
  return row?.count ?? 0;
}

export async function getRecentFailedCount(hours: number = 24): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_tasks
       WHERE status = 'failed' AND finishedAt > ?`,
    [since],
  );
  return row?.count ?? 0;
}

// ============================================================================
// Workflow CRUD
// ============================================================================

type WorkflowRow = {
  id: string;
  key: string;
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
    key: row.key,
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

export async function createWorkflow(
  data: {
    key?: string;
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
  },
  source?: "api" | "mcp",
): Promise<Workflow> {
  const id = crypto.randomUUID();
  const row = await getDbClient().get<WorkflowRow>(
    `INSERT INTO workflows (id, "key", name, description, definition, triggers, cooldown, input, triggerSchema, dir, vcs_repo, createdByAgentId, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      normalizeAssetKey(data.key ?? defaultAssetKey("workflow", id)),
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
    ],
  );
  if (!row) throw new Error("Failed to create workflow");
  const workflow = rowToWorkflow(row);
  telemetry.workflow("created", {
    workflowId: workflow.id,
    nodeCount: workflow.definition.nodes.length,
    ...(source ? { source } : {}),
  });
  return workflow;
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  const row = await getDbClient().get<WorkflowRow>("SELECT * FROM workflows WHERE id = ?", [id]);
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
    key: row.key,
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

export interface WorkflowFilters {
  enabled?: boolean;
  lastRunStatus?: WorkflowRunStatus;
  consecutiveErrorsMin?: number;
  key?: string;
  keyPrefix?: string;
}

export function listWorkflows(filters?: WorkflowFilters): Promise<Workflow[]>;
export function listWorkflows(
  filters: WorkflowFilters | undefined,
  opts: { slim: true },
): Promise<WorkflowSummary[]>;
export async function listWorkflows(
  filters?: WorkflowFilters,
  opts?: { slim?: boolean },
): Promise<Workflow[] | WorkflowSummary[]> {
  let query = "SELECT * FROM workflows WHERE 1=1";
  const params: (string | number)[] = [];
  if (filters?.enabled !== undefined) {
    query += " AND enabled = ?";
    params.push(filters.enabled ? 1 : 0);
  }
  if (filters?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
  }
  if (filters?.lastRunStatus !== undefined) {
    query +=
      " AND (SELECT status FROM workflow_runs WHERE workflowId = workflows.id ORDER BY startedAt DESC LIMIT 1) = ?";
    params.push(filters.lastRunStatus);
  }
  if (filters?.consecutiveErrorsMin !== undefined) {
    query += ` AND (
      SELECT COUNT(*)
      FROM workflow_runs wr
      WHERE wr.workflowId = workflows.id
        AND wr.status = 'failed'
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_runs newer_non_failed
          WHERE newer_non_failed.workflowId = wr.workflowId
            AND newer_non_failed.status != 'failed'
            AND newer_non_failed.startedAt > wr.startedAt
        )
    ) >= ?`;
    params.push(filters.consecutiveErrorsMin);
  }
  query += " ORDER BY lastUpdatedAt DESC";
  const rows = await getDbClient().query<WorkflowRow>(query, params);
  return opts?.slim ? rows.map(rowToWorkflowSummary) : rows.map(rowToWorkflow);
}

export async function updateWorkflow(
  id: string,
  data: {
    key?: string;
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
): Promise<Workflow | null> {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (data.key !== undefined) {
    updates.push('"key" = ?');
    params.push(normalizeAssetKey(data.key));
  }
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
  if (updates.length === 0) return await getWorkflow(id);
  updates.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = await getDbClient().get<WorkflowRow>(
    `UPDATE workflows SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToWorkflow(row) : null;
}

export async function deleteWorkflow(id: string, source?: "api" | "mcp"): Promise<boolean> {
  const client = getDbClient();
  // Cascade delete in FK-safe order:
  // 1. Unlink agent_tasks (they reference steps and runs)
  await client.run(
    `UPDATE agent_tasks SET workflowRunId = NULL, workflowRunStepId = NULL WHERE workflowRunId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    [id],
  );
  // 2. Delete steps (they reference runs)
  await client.run(
    `DELETE FROM workflow_run_steps WHERE runId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    [id],
  );
  // 3. Delete runs (they reference workflow)
  await client.run("DELETE FROM workflow_runs WHERE workflowId = ?", [id]);
  // 4. Delete workflow
  const result = await client.run("DELETE FROM workflows WHERE id = ?", [id]);
  const deleted = result.changes > 0;
  if (deleted) {
    telemetry.workflow("deleted", {
      workflowId: id,
      ...(source ? { source } : {}),
    });
  }
  return deleted;
}

/**
 * Find enabled workflows that have a schedule trigger matching the given scheduleId.
 * Uses SQLite JSON functions to query into the triggers JSON array.
 */
export async function getWorkflowsByScheduleId(scheduleId: string): Promise<Workflow[]> {
  const rows = await getDbClient().query<WorkflowRow>(
    `SELECT w.* FROM workflows w, json_each(w.triggers) AS t
       WHERE w.enabled = 1
         AND json_extract(t.value, '$.type') = 'schedule'
         AND json_extract(t.value, '$.scheduleId') = ?`,
    [scheduleId],
  );
  return rows.map(rowToWorkflow);
}

// ============================================================================
// Workflow Run CRUD
// ============================================================================

type WorkflowRunRow = {
  id: string;
  workflowId: string;
  status: string;
  triggerType: string;
  triggerData: string | null;
  context: string | null;
  error: string | null;
  created_by: string | null;
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
    createdBy: row.created_by ?? undefined,
    startedAt: normalizeDateRequired(row.startedAt),
    lastUpdatedAt: normalizeDateRequired(row.lastUpdatedAt),
    finishedAt: normalizeDate(row.finishedAt) ?? undefined,
  };
}

export async function createWorkflowRun(data: {
  id: string;
  workflowId: string;
  triggerType?: "schedule" | "manual" | "event" | "api";
  triggerData?: unknown;
  createdBy?: string;
}): Promise<WorkflowRun> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<WorkflowRunRow>(
    `INSERT INTO workflow_runs (id, workflowId, triggerType, startedAt, triggerData, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      data.id,
      data.workflowId,
      data.triggerType ?? "manual",
      now,
      data.triggerData ? JSON.stringify(data.triggerData) : null,
      data.createdBy ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create workflow run");
  return rowToWorkflowRun(row);
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const row = await getDbClient().get<WorkflowRunRow>("SELECT * FROM workflow_runs WHERE id = ?", [
    id,
  ]);
  return row ? rowToWorkflowRun(row) : null;
}

function emitWorkflowTerminalTelemetry(run: WorkflowRun): void {
  if (run.status !== "completed" && run.status !== "failed") return;

  // afterCommit (not queueMicrotask): under an async client transaction,
  // microtasks drain before COMMIT, so the verify read below could observe
  // uncommitted state. afterCommit runs strictly post-COMMIT/ROLLBACK. The
  // async hook is passed directly (no detached void-IIFE) so a rejected read
  // (e.g. DB closed mid-shutdown) is contained by the scheduler instead of
  // crashing the process as an unhandled rejection.
  getDbClient().afterCommit(async () => {
    const latest = await getWorkflowRun(run.id);
    if (!latest || latest.status !== run.status) return;
    const steps = await getWorkflowRunStepsByRunId(run.id);
    telemetry.workflow(run.status, {
      workflowId: run.workflowId,
      durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : undefined,
      stepsCompleted: steps.filter((step) => step.status === "completed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
    });
  });
}

export async function updateWorkflowRun(
  id: string,
  data: {
    status?: WorkflowRunStatus;
    context?: Record<string, unknown>;
    error?: string | null;
    finishedAt?: string;
  },
): Promise<WorkflowRun | null> {
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
  if (updates.length === 0) {
    const row = await getDbClient().get<WorkflowRunRow>(
      "SELECT * FROM workflow_runs WHERE id = ?",
      [id],
    );
    return row ? rowToWorkflowRun(row) : null;
  }
  updates.push("lastUpdatedAt = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const row = await getDbClient().get<WorkflowRunRow>(
    `UPDATE workflow_runs SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  if (!row) return null;
  const run = rowToWorkflowRun(row);
  if (data.status === "completed" || data.status === "failed") {
    emitWorkflowTerminalTelemetry(run);
  }
  return run;
}

export type WorkflowRunListOptions = {
  status?: WorkflowRunStatus;
  limit?: number;
  offset?: number;
};

export type WorkflowRunPage = {
  runs: WorkflowRun[];
  page: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
    nextOffset?: number;
  };
};

export async function listWorkflowRuns(
  workflowId: string,
  options: WorkflowRunListOptions = {},
): Promise<WorkflowRun[]> {
  const conditions = ["workflowId = ?"];
  const params: Array<string | number> = [workflowId];
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }

  let pagination = "";
  if (options.limit !== undefined) {
    pagination = " LIMIT ? OFFSET ?";
    params.push(options.limit, options.offset ?? 0);
  } else if (options.offset !== undefined) {
    pagination = " LIMIT -1 OFFSET ?";
    params.push(options.offset);
  }

  const rows = await getDbClient().query<WorkflowRunRow>(
    `SELECT * FROM workflow_runs
       WHERE ${conditions.join(" AND ")}
       ORDER BY startedAt DESC, id DESC${pagination}`,
    params,
  );
  return rows.map(rowToWorkflowRun);
}

export async function countWorkflowRuns(
  workflowId: string,
  options: Pick<WorkflowRunListOptions, "status"> = {},
): Promise<number> {
  const conditions = ["workflowId = ?"];
  const params: string[] = [workflowId];
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workflow_runs WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return row?.count ?? 0;
}

export async function listWorkflowRunsPage(
  workflowId: string,
  options: Required<Pick<WorkflowRunListOptions, "limit" | "offset">> &
    Pick<WorkflowRunListOptions, "status">,
): Promise<WorkflowRunPage> {
  const runs = await listWorkflowRuns(workflowId, options);
  const total = await countWorkflowRuns(workflowId, { status: options.status });
  const nextOffset = options.offset + runs.length;
  const hasMore = nextOffset < total;
  return {
    runs,
    page: {
      limit: options.limit,
      offset: options.offset,
      total,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
    },
  };
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

export async function createWorkflowRunStep(data: {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  input?: unknown;
  idempotencyKey?: string;
}): Promise<WorkflowRunStep> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<WorkflowRunStepRow>(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, input, idempotencyKey)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?) RETURNING *`,
    [
      data.id,
      data.runId,
      data.nodeId,
      data.nodeType,
      now,
      data.input ? JSON.stringify(data.input) : null,
      data.idempotencyKey ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create workflow run step");
  return rowToWorkflowRunStep(row);
}

export async function getWorkflowRunStep(id: string): Promise<WorkflowRunStep | null> {
  const row = await getDbClient().get<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE id = ?",
    [id],
  );
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function updateWorkflowRunStep(
  id: string,
  data: {
    status?: WorkflowRunStepStatus;
    output?: unknown;
    error?: string | null;
    finishedAt?: string;
    retryCount?: number;
    maxRetries?: number;
    nextRetryAt?: string | null;
    idempotencyKey?: string;
    diagnostics?: string;
    nextPort?: string;
  },
): Promise<WorkflowRunStep | null> {
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
  if (updates.length === 0) {
    const row = await getDbClient().get<WorkflowRunStepRow>(
      "SELECT * FROM workflow_run_steps WHERE id = ?",
      [id],
    );
    return row ? rowToWorkflowRunStep(row) : null;
  }
  params.push(id);
  const row = await getDbClient().get<WorkflowRunStepRow>(
    `UPDATE workflow_run_steps SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function getWorkflowRunStepsByRunId(runId: string): Promise<WorkflowRunStep[]> {
  const rows = await getDbClient().query<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE runId = ? ORDER BY startedAt ASC",
    [runId],
  );
  return rows.map(rowToWorkflowRunStep);
}

// --- Stuck Workflow Run Recovery ---

export interface StuckWorkflowRun {
  runId: string;
  stepId: string;
  nodeId: string;
  taskId: string;
  taskStatus: string;
  taskOutput: string | null;
  workflowId: string;
}

export async function getStuckWorkflowRuns(): Promise<StuckWorkflowRun[]> {
  return getDbClient().query<StuckWorkflowRun>(
    `SELECT
        wr.id as runId,
        wrs.id as stepId,
        wrs.nodeId,
        at.id as taskId,
        at.status as taskStatus,
        at.output as taskOutput,
        wr.workflowId
      FROM workflow_runs wr
      JOIN workflow_run_steps wrs ON wrs.runId = wr.id AND wrs.status = 'waiting'
      JOIN agent_tasks at ON at.workflowRunStepId = wrs.id
      WHERE wr.status = 'waiting'
        AND at.status IN ('completed', 'failed', 'cancelled')
      ORDER BY at.createdAt ASC, at.rowid ASC`,
  );
}

// --- New Workflow Query Functions ---

export async function getLastSuccessfulRun(workflowId: string): Promise<WorkflowRun | null> {
  const row = await getDbClient().get<WorkflowRunRow>(
    `SELECT * FROM workflow_runs
       WHERE workflowId = ? AND status = 'completed'
       ORDER BY finishedAt DESC LIMIT 1`,
    [workflowId],
  );
  return row ? rowToWorkflowRun(row) : null;
}

export async function getLastRunStart(workflowId: string): Promise<WorkflowRun | null> {
  const row = await getDbClient().get<WorkflowRunRow>(
    `SELECT * FROM workflow_runs
       WHERE workflowId = ? AND status NOT IN ('skipped')
       ORDER BY startedAt DESC LIMIT 1`,
    [workflowId],
  );
  return row ? rowToWorkflowRun(row) : null;
}

export async function getRetryableSteps(): Promise<WorkflowRunStep[]> {
  const now = new Date().toISOString();
  const rows = await getDbClient().query<WorkflowRunStepRow>(
    `SELECT * FROM workflow_run_steps
       WHERE status = 'failed'
         AND nextRetryAt IS NOT NULL
         AND nextRetryAt <= ?
       ORDER BY nextRetryAt ASC`,
    [now],
  );
  return rows.map(rowToWorkflowRunStep);
}

export async function getCompletedStepNodeIds(runId: string): Promise<string[]> {
  const rows = await getDbClient().query<{ nodeId: string }>(
    `SELECT nodeId FROM workflow_run_steps
       WHERE runId = ? AND status = 'completed'`,
    [runId],
  );
  return rows.map((r) => r.nodeId);
}

export async function getTaskByWorkflowRunStepId(stepId: string): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE workflowRunStepId = ? LIMIT 1",
    [stepId],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function detachTaskFromWorkflowRunStep(taskId: string): Promise<void> {
  await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = NULL WHERE id = ?", [taskId]);
}

export async function getStepByIdempotencyKey(key: string): Promise<WorkflowRunStep | null> {
  const row = await getDbClient().get<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE idempotencyKey = ?",
    [key],
  );
  return row ? rowToWorkflowRunStep(row) : null;
}

export async function getStepCountForNode(runId: string, nodeId: string): Promise<number> {
  const row = await getDbClient().get<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM workflow_run_steps WHERE runId = ? AND nodeId = ?",
    [runId, nodeId],
  );
  return row?.cnt ?? 0;
}

export async function getLatestStepForNode(
  runId: string,
  nodeId: string,
): Promise<WorkflowRunStep | null> {
  const row = await getDbClient().get<WorkflowRunStepRow>(
    "SELECT * FROM workflow_run_steps WHERE runId = ? AND nodeId = ? ORDER BY startedAt DESC LIMIT 1",
    [runId, nodeId],
  );
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

export async function createWorkflowVersion(data: {
  workflowId: string;
  version: number;
  snapshot: WorkflowSnapshot;
  changedByAgentId?: string;
}): Promise<WorkflowVersion> {
  const id = crypto.randomUUID();
  const row = await getDbClient().get<WorkflowVersionRow>(
    `INSERT INTO workflow_versions (id, workflowId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      data.workflowId,
      data.version,
      JSON.stringify(data.snapshot),
      data.changedByAgentId ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create workflow version");
  return rowToWorkflowVersion(row);
}

export async function getWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
  const rows = await getDbClient().query<WorkflowVersionRow>(
    "SELECT * FROM workflow_versions WHERE workflowId = ? ORDER BY version DESC",
    [workflowId],
  );
  return rows.map(rowToWorkflowVersion);
}

export async function getWorkflowVersion(
  workflowId: string,
  version: number,
): Promise<WorkflowVersion | null> {
  const row = await getDbClient().get<WorkflowVersionRow>(
    "SELECT * FROM workflow_versions WHERE workflowId = ? AND version = ?",
    [workflowId, version],
  );
  return row ? rowToWorkflowVersion(row) : null;
}

// --- App Version History ---

export type AppVersion = {
  id: string;
  appId: string;
  version: number;
  snapshot: unknown;
  changedByAgentId?: string;
  createdAt: string;
};

type AppVersionRow = {
  id: string;
  appId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
};

function rowToAppVersion(row: AppVersionRow): AppVersion {
  return {
    id: row.id,
    appId: row.appId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot),
    changedByAgentId: row.changedByAgentId ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

export async function createAppVersion(data: {
  appId: string;
  version: number;
  snapshot: unknown;
  changedByAgentId?: string;
}): Promise<AppVersion> {
  const id = crypto.randomUUID();
  const row = await getDbClient().get<AppVersionRow>(
    `INSERT INTO app_versions (id, appId, version, snapshot, changedByAgentId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      data.appId,
      data.version,
      JSON.stringify(data.snapshot),
      data.changedByAgentId ?? null,
      new Date().toISOString(),
    ],
  );
  if (!row) throw new Error("Failed to create app version");
  return rowToAppVersion(row);
}

export async function getAppVersions(appId: string): Promise<AppVersion[]> {
  const rows = await getDbClient().query<AppVersionRow>(
    "SELECT * FROM app_versions WHERE appId = ? ORDER BY version DESC",
    [appId],
  );
  return rows.map(rowToAppVersion);
}

export async function getAppVersion(appId: string, version: number): Promise<AppVersion | null> {
  const row = await getDbClient().get<AppVersionRow>(
    "SELECT * FROM app_versions WHERE appId = ? AND version = ?",
    [appId, version],
  );
  return row ? rowToAppVersion(row) : null;
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
  key: string;
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
    key: row.key,
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

export async function createPage(data: {
  key?: string;
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  contentType: PageContentType;
  authMode?: PageAuthMode;
  passwordHash?: string;
  body: string;
  needsCredentials?: string[];
}): Promise<Page> {
  // Match the historical SQL default ID shape while making the value
  // available before insert so the default namespace can include it.
  const id = crypto.randomUUID().replace(/-/g, "");
  const row = await getDbClient().get<PageRow>(
    `INSERT INTO pages (id, "key", agentId, slug, title, description, contentType, authMode, passwordHash, body, needsCredentials)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      normalizeAssetKey(data.key ?? defaultAssetKey("page", id)),
      data.agentId,
      data.slug,
      data.title,
      data.description ?? null,
      data.contentType,
      data.authMode ?? "authed",
      data.passwordHash ?? null,
      data.body,
      data.needsCredentials ? JSON.stringify(data.needsCredentials) : null,
    ],
  );
  if (!row) throw new Error("Failed to create page");
  return rowToPage(row);
}

export async function getPage(id: string): Promise<Page | null> {
  const row = await getDbClient().get<PageRow>("SELECT * FROM pages WHERE id = ?", [id]);
  return row ? rowToPage(row) : null;
}

export async function getPageBySlug(agentId: string, slug: string): Promise<Page | null> {
  const row = await getDbClient().get<PageRow>(
    "SELECT * FROM pages WHERE agentId = ? AND slug = ?",
    [agentId, slug],
  );
  return row ? rowToPage(row) : null;
}

export async function getLatestPageBySlug(slug: string): Promise<Page | null> {
  const row = await getDbClient().get<PageRow>(
    "SELECT * FROM pages WHERE slug = ? ORDER BY updatedAt DESC LIMIT 1",
    [slug],
  );
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
    key: row.key,
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

export interface PageListOptions {
  slim?: boolean;
  key?: string;
  keyPrefix?: string;
}

export function listPagesByAgent(agentId: string, limit?: number, offset?: number): Promise<Page[]>;
export function listPagesByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim?: false },
): Promise<Page[]>;
export function listPagesByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim: true },
): Promise<PageSummary[]>;
export async function listPagesByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: PageListOptions,
): Promise<Page[] | PageSummary[]> {
  let query = "SELECT * FROM pages WHERE agentId = ?";
  const params: (string | number)[] = [agentId];
  if (opts?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(opts.key));
  } else if (opts?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(opts.keyPrefix));
  }
  query += " ORDER BY updatedAt DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await getDbClient().query<PageRow>(query, params);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

export function listAllPages(limit?: number, offset?: number): Promise<Page[]>;
export function listAllPages(
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim?: false },
): Promise<Page[]>;
export function listAllPages(
  limit: number | undefined,
  offset: number | undefined,
  opts: PageListOptions & { slim: true },
): Promise<PageSummary[]>;
export async function listAllPages(
  limit = 100,
  offset = 0,
  opts?: PageListOptions,
): Promise<Page[] | PageSummary[]> {
  let query = "SELECT * FROM pages WHERE 1=1";
  const params: (string | number)[] = [];
  if (opts?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(opts.key));
  } else if (opts?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(opts.keyPrefix));
  }
  query += " ORDER BY updatedAt DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await getDbClient().query<PageRow>(query, params);
  return opts?.slim ? rows.map(rowToPageSummary) : rows.map(rowToPage);
}

/**
 * Total page count — used to back a filter-aware `total` in the `/api/pages`
 * pager so the UI shows the real count, not just the current page's length.
 */
export async function countAllPages(
  filters?: Pick<PageListOptions, "key" | "keyPrefix">,
): Promise<number> {
  let query = "SELECT COUNT(*) AS count FROM pages WHERE 1=1";
  const params: string[] = [];
  if (filters?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
  }
  const row = await getDbClient().get<{ count: number }>(query, params);
  return row?.count ?? 0;
}

/** Page count scoped to a single agent — companion to `listPagesByAgent`. */
export async function countPagesByAgent(
  agentId: string,
  filters?: Pick<PageListOptions, "key" | "keyPrefix">,
): Promise<number> {
  let query = "SELECT COUNT(*) AS count FROM pages WHERE agentId = ?";
  const params: string[] = [agentId];
  if (filters?.key) {
    query += ' AND "key" = ?';
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    query += ` AND "key" LIKE ? ESCAPE '\\'`;
    params.push(assetKeyPrefixPattern(filters.keyPrefix));
  }
  const row = await getDbClient().get<{ count: number }>(query, params);
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
export async function updatePage(
  id: string,
  data: {
    key?: string;
    title?: string;
    description?: string | null;
    contentType?: PageContentType;
    authMode?: PageAuthMode;
    passwordHash?: string | null;
    body?: string;
    needsCredentials?: string[] | null;
    slug?: string;
  },
): Promise<Page | null> {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];
  if (data.key !== undefined) {
    updates.push('"key" = ?');
    params.push(normalizeAssetKey(data.key));
  }
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
  const row = await getDbClient().get<PageRow>(
    `UPDATE pages SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToPage(row) : null;
}

export async function deletePage(id: string): Promise<boolean> {
  const result = await getDbClient().transaction(async (tx) => {
    await tx.run("DELETE FROM user_favorites WHERE itemType = 'page' AND itemId = ?", [id]);
    await tx.run("DELETE FROM kv_entries WHERE namespace = ?", [`task:page:${id}`]);
    // ON DELETE CASCADE on page_versions.pageId handles history cleanup.
    return await tx.run("DELETE FROM pages WHERE id = ?", [id]);
  });
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
export async function incrementPageViewCount(id: string): Promise<boolean> {
  const result = await getDbClient().run(
    "UPDATE pages SET view_count = view_count + 1 WHERE id = ?",
    [id],
  );
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

export async function createPageVersion(data: {
  pageId: string;
  version: number;
  snapshot: PageSnapshot;
  changedByAgentId?: string;
}): Promise<PageVersion> {
  const row = await getDbClient().get<PageVersionRow>(
    `INSERT INTO page_versions (pageId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?) RETURNING *`,
    [data.pageId, data.version, JSON.stringify(data.snapshot), data.changedByAgentId ?? null],
  );
  if (!row) throw new Error("Failed to create page version");
  return rowToPageVersion(row);
}

export async function getPageVersions(pageId: string): Promise<PageVersion[]> {
  const rows = await getDbClient().query<PageVersionRow>(
    "SELECT * FROM page_versions WHERE pageId = ? ORDER BY version DESC",
    [pageId],
  );
  return rows.map(rowToPageVersion);
}

export async function getPageVersion(pageId: string, version: number): Promise<PageVersion | null> {
  const row = await getDbClient().get<PageVersionRow>(
    "SELECT * FROM page_versions WHERE pageId = ? AND version = ?",
    [pageId, version],
  );
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

export async function createMetric(data: {
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  definition: MetricDefinition;
}): Promise<Metric> {
  const row = await getDbClient().get<MetricRow>(
    `INSERT INTO metrics (agentId, slug, title, description, definition)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    [
      data.agentId,
      data.slug,
      data.title,
      data.description ?? null,
      JSON.stringify(data.definition),
    ],
  );
  if (!row) throw new Error("Failed to create metric");
  return rowToMetric(row);
}

export async function getMetric(id: string): Promise<Metric | null> {
  const row = await getDbClient().get<MetricRow>("SELECT * FROM metrics WHERE id = ?", [id]);
  return row ? rowToMetric(row) : null;
}

export async function getMetricBySlug(agentId: string, slug: string): Promise<Metric | null> {
  const row = await getDbClient().get<MetricRow>(
    "SELECT * FROM metrics WHERE agentId = ? AND slug = ?",
    [agentId, slug],
  );
  return row ? rowToMetric(row) : null;
}

export async function listMetricsByAgent(
  agentId: string,
  limit?: number,
  offset?: number,
): Promise<Metric[]>;
export async function listMetricsByAgent(
  agentId: string,
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): Promise<MetricSummary[]>;
export async function listMetricsByAgent(
  agentId: string,
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Promise<Metric[] | MetricSummary[]> {
  const rows = await getDbClient().query<MetricRow>(
    "SELECT * FROM metrics WHERE agentId = ? ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    [agentId, limit, offset],
  );
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export async function listAllMetrics(limit?: number, offset?: number): Promise<Metric[]>;
export async function listAllMetrics(
  limit: number | undefined,
  offset: number | undefined,
  opts: { slim: true },
): Promise<MetricSummary[]>;
export async function listAllMetrics(
  limit = 100,
  offset = 0,
  opts?: { slim?: boolean },
): Promise<Metric[] | MetricSummary[]> {
  const rows = await getDbClient().query<MetricRow>(
    "SELECT * FROM metrics ORDER BY updatedAt DESC LIMIT ? OFFSET ?",
    [limit, offset],
  );
  return opts?.slim ? rows.map(rowToMetricSummary) : rows.map(rowToMetric);
}

export async function countAllMetrics(): Promise<number> {
  const row = await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM metrics");
  return row?.count ?? 0;
}

export async function countMetricsByAgent(agentId: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM metrics WHERE agentId = ?",
    [agentId],
  );
  return row?.count ?? 0;
}

export async function updateMetric(
  id: string,
  data: {
    title?: string;
    description?: string | null;
    definition?: MetricDefinition;
    slug?: string;
  },
): Promise<Metric | null> {
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
  const row = await getDbClient().get<MetricRow>(
    `UPDATE metrics SET ${updates.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToMetric(row) : null;
}

export async function deleteMetric(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM metrics WHERE id = ?", [id]);
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

export async function createMetricVersion(data: {
  metricId: string;
  version: number;
  snapshot: MetricSnapshot;
  changedByAgentId?: string;
}): Promise<MetricVersion> {
  const row = await getDbClient().get<MetricVersionRow>(
    `INSERT INTO metric_versions (metricId, version, snapshot, changedByAgentId)
       VALUES (?, ?, ?, ?) RETURNING *`,
    [data.metricId, data.version, JSON.stringify(data.snapshot), data.changedByAgentId ?? null],
  );
  if (!row) throw new Error("Failed to create metric version");
  return rowToMetricVersion(row);
}

export async function getMetricVersions(metricId: string): Promise<MetricVersion[]> {
  const rows = await getDbClient().query<MetricVersionRow>(
    "SELECT * FROM metric_versions WHERE metricId = ? ORDER BY version DESC",
    [metricId],
  );
  return rows.map(rowToMetricVersion);
}

export async function getMetricVersion(
  metricId: string,
  version: number,
): Promise<MetricVersion | null> {
  const row = await getDbClient().get<MetricVersionRow>(
    "SELECT * FROM metric_versions WHERE metricId = ? AND version = ?",
    [metricId, version],
  );
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
 *
 * DEFERRED (boot-path rule): called synchronously from `seedDefaultTemplates`
 * (src/be/seed-prompt-templates.ts), itself invoked synchronously from
 * `initDb`'s body — stays on the raw sync handle.
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
export async function getPromptTemplateById(id: string): Promise<PromptTemplate | null> {
  const row = await getDbClient().get<PromptTemplateRow>(
    "SELECT * FROM prompt_templates WHERE id = ?",
    [id],
  );
  return row ? rowToPromptTemplate(row) : null;
}

/**
 * Upsert a prompt template. Inserts or updates by (eventType, scope, scopeId) unique constraint.
 * Creates a history entry on both insert and update.
 *
 * DEFERRED (boot-path rule): called synchronously from `seedDefaultTemplates`
 * (src/be/seed-prompt-templates.ts), itself invoked synchronously from
 * `initDb`'s body — stays on the raw sync handle.
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
export async function deletePromptTemplate(id: string): Promise<boolean> {
  const existing = await getDbClient().get<PromptTemplateRow>(
    "SELECT * FROM prompt_templates WHERE id = ?",
    [id],
  );

  if (!existing) return false;
  if (existing.isDefault === 1) {
    throw new Error(
      "Cannot delete a default prompt template. Use resetPromptTemplateToDefault instead.",
    );
  }

  const result = await getDbClient().run("DELETE FROM prompt_templates WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Reset a prompt template to its default state.
 * Sets body to defaultBody, isDefault=true, state='enabled', bumps version.
 *
 * DEFERRED (boot-path rule): called synchronously from `seedDefaultTemplates`
 * (src/be/seed-prompt-templates.ts), itself invoked synchronously from
 * `initDb`'s body — stays on the raw sync handle.
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
export async function getPromptTemplateHistory(
  templateId: string,
): Promise<PromptTemplateHistory[]> {
  const rows = await getDbClient().query<PromptTemplateHistoryRow>(
    "SELECT * FROM prompt_template_history WHERE templateId = ? ORDER BY version DESC",
    [templateId],
  );
  return rows.map(rowToPromptTemplateHistory);
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
 *
 * DEFERRED (boot-path rule): injected as `src/prompts/resolver.ts`'s
 * `dbResolverFn` via `configureDbResolver` (called from `initDb`'s body) and
 * invoked synchronously, on every render, by that module's still-sync
 * `resolveTemplate()` / `resolveTemplateViaDb()` / `expandTemplateRefs()` —
 * a public API used pervasively across GitHub/GitLab/Linear/Jira/Slack/
 * agentmail handlers, heartbeat, and workflows. Converting this function
 * would force `resolveTemplate()` itself async, cascading into dozens of
 * unrelated call sites outside this batch's blast radius. Stays on the raw
 * sync handle; `resolveTemplateAsync()` already exists as the async path for
 * callers that need one.
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
export async function checkoutPromptTemplate(
  id: string,
  targetVersion: number,
): Promise<PromptTemplate> {
  const now = new Date().toISOString();

  // One transaction around read, version computation and both writes. A
  // concurrent upsert (or a second checkout) between the read and the UPDATE
  // would otherwise reuse the same `existing.version + 1`, leaving two
  // prompt_template_history rows at one version (no UNIQUE on
  // (templateId, version)) so a later checkout restores whichever body the
  // index scan reaches first.
  const row = await getDbClient().transaction(async () => {
    const existing = await getDbClient().get<PromptTemplateRow>(
      "SELECT * FROM prompt_templates WHERE id = ?",
      [id],
    );
    if (!existing) throw new Error(`Prompt template ${id} not found`);

    const historyEntry = await getDbClient().get<PromptTemplateHistoryRow>(
      "SELECT * FROM prompt_template_history WHERE templateId = ? AND version = ?",
      [id, targetVersion],
    );
    if (!historyEntry)
      throw new Error(`No history entry at version ${targetVersion} for template ${id}`);

    const newVersion = existing.version + 1;

    const updated = await getDbClient().get<PromptTemplateRow>(
      `UPDATE prompt_templates SET body = ?, state = ?, version = ?, updatedAt = ?
       WHERE id = ? RETURNING *`,
      [historyEntry.body, historyEntry.state, newVersion, now, id],
    );

    if (!updated) throw new Error("Failed to checkout prompt template");

    // Create history entry for the checkout
    await getDbClient().run(
      `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        id,
        newVersion,
        historyEntry.body,
        historyEntry.state,
        null,
        now,
        `Checked out from version ${targetVersion}`,
      ],
    );

    return updated;
  });

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

export async function getAllChannelActivityCursors(): Promise<ChannelActivityCursor[]> {
  const rows = await getDbClient().query<ChannelActivityCursorRow>(
    "SELECT * FROM channel_activity_cursors",
  );
  return rows.map(rowToChannelActivityCursor);
}

export async function getChannelActivityCursor(
  channelId: string,
): Promise<ChannelActivityCursor | null> {
  const row = await getDbClient().get<ChannelActivityCursorRow>(
    "SELECT * FROM channel_activity_cursors WHERE channelId = ?",
    [channelId],
  );
  return row ? rowToChannelActivityCursor(row) : null;
}

export async function upsertChannelActivityCursor(
  channelId: string,
  lastSeenTs: string,
): Promise<void> {
  await getDbClient().run(
    `INSERT INTO channel_activity_cursors (channelId, lastSeenTs, updatedAt)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(channelId) DO UPDATE SET lastSeenTs = excluded.lastSeenTs, updatedAt = excluded.updatedAt`,
    [channelId, lastSeenTs],
  );
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
  status: "pending" | "approved" | "rejected" | "timeout" | "cancelled";
  responses: unknown | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: unknown[] | null;
  createdBy?: string;
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
  resolutionReason: string | null;
  cancellationNotificationClaims: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: string | null;
  created_by: string | null;
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
    resolutionReason: row.resolutionReason,
    timeoutSeconds: row.timeoutSeconds,
    expiresAt: normalizeDate(row.expiresAt),
    notificationChannels: row.notificationChannels ? JSON.parse(row.notificationChannels) : null,
    createdBy: row.created_by ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  };
}

export async function createApprovalRequest(data: {
  id: string;
  title: string;
  questions: unknown[];
  approvers: unknown;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  timeoutSeconds?: number;
  notificationChannels?: unknown[];
  createdBy?: string;
  requireActionableWorkflow?: boolean;
}): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const expiresAt = data.timeoutSeconds
    ? new Date(Date.now() + data.timeoutSeconds * 1000).toISOString()
    : null;

  const row = await getDbClient().transaction(async () => {
    let status: ApprovalRequest["status"] = "pending";
    let resolutionReason: string | null = null;
    if (data.requireActionableWorkflow && data.workflowRunId && data.workflowRunStepId) {
      const run = await getWorkflowRun(data.workflowRunId);
      const step = await getWorkflowRunStep(data.workflowRunStepId);
      if (!run || (run.status !== "running" && run.status !== "waiting")) {
        status = "cancelled";
        resolutionReason = run?.error ?? `Workflow run is ${run?.status ?? "missing"}`;
      } else if (!step || step.runId !== run.id || step.status !== "running") {
        status = "cancelled";
        resolutionReason = `Human-in-the-loop step is ${step?.status ?? "missing"}`;
      }
    }

    return getDbClient().get<ApprovalRequestRow>(
      `INSERT INTO approval_requests
         (id, title, questions, workflowRunId, workflowRunStepId, sourceTaskId,
          approvers, status, resolutionReason, resolvedAt, timeoutSeconds, expiresAt,
          notificationChannels, created_by, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [
        data.id,
        data.title,
        JSON.stringify(data.questions),
        data.workflowRunId ?? null,
        data.workflowRunStepId ?? null,
        data.sourceTaskId ?? null,
        JSON.stringify(data.approvers),
        status,
        resolutionReason,
        status === "cancelled" ? now : null,
        data.timeoutSeconds ?? null,
        expiresAt,
        data.notificationChannels ? JSON.stringify(data.notificationChannels) : null,
        data.createdBy ?? null,
        now,
        now,
      ],
    );
  });

  return rowToApprovalRequest(row!);
}

export async function getApprovalRequestById(id: string): Promise<ApprovalRequest | null> {
  const row = await getDbClient().get<ApprovalRequestRow>(
    "SELECT * FROM approval_requests WHERE id = ?",
    [id],
  );
  return row ? rowToApprovalRequest(row) : null;
}

export async function resolveApprovalRequest(
  id: string,
  data: {
    status: "approved" | "rejected" | "timeout";
    responses?: unknown;
    resolvedBy?: string;
  },
  options?: { requireActionableWorkflow?: boolean },
): Promise<ApprovalRequest | null> {
  const now = new Date().toISOString();
  const actionableWorkflowClause = options?.requireActionableWorkflow
    ? `AND (
         workflowRunId IS NULL
         OR (
           EXISTS (
             SELECT 1 FROM workflow_runs
             WHERE id = approval_requests.workflowRunId
               AND status IN ('running', 'waiting')
           )
           AND EXISTS (
           SELECT 1 FROM workflow_run_steps
             WHERE id = approval_requests.workflowRunStepId
               AND runId = approval_requests.workflowRunId
               AND status = 'waiting'
           )
         )
       )`
    : "";
  const row = await getDbClient().get<ApprovalRequestRow>(
    `UPDATE approval_requests
       SET status = ?, responses = ?, resolvedBy = ?, resolvedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'
         ${actionableWorkflowClause}
       RETURNING *`,
    [
      data.status,
      data.responses ? JSON.stringify(data.responses) : null,
      data.resolvedBy ?? null,
      now,
      now,
      id,
    ],
  );
  return row ? rowToApprovalRequest(row) : null;
}

export async function cancelPendingApprovalRequestsForRun(
  workflowRunId: string,
  reason: string,
): Promise<ApprovalRequest[]> {
  const now = new Date().toISOString();
  const rows = await getDbClient().query<ApprovalRequestRow>(
    `UPDATE approval_requests
       SET status = 'cancelled', resolutionReason = ?, resolvedAt = ?, updatedAt = ?
       WHERE workflowRunId = ? AND status = 'pending'
       RETURNING *`,
    [reason, now, now, workflowRunId],
  );
  return rows.map(rowToApprovalRequest);
}

export async function listCancelledApprovalRequestsForRun(
  workflowRunId: string,
): Promise<ApprovalRequest[]> {
  const rows = await getDbClient().query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests
       WHERE workflowRunId = ? AND status = 'cancelled'`,
    [workflowRunId],
  );
  return rows.map(rowToApprovalRequest);
}

export async function listCancelledApprovalRequestsForStep(
  workflowRunStepId: string,
): Promise<ApprovalRequest[]> {
  const rows = await getDbClient().query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests
       WHERE workflowRunStepId = ? AND status = 'cancelled'`,
    [workflowRunStepId],
  );
  return rows.map(rowToApprovalRequest);
}

export async function claimApprovalCancellationNotification(
  id: string,
  notificationKey: string,
): Promise<{ approval: ApprovalRequest; leaseToken: string } | null> {
  return getDbClient().transaction(async () => {
    const row = await getDbClient().get<ApprovalRequestRow>(
      "SELECT * FROM approval_requests WHERE id = ? AND status = 'cancelled'",
      [id],
    );
    if (!row) return null;
    const claims = row.cancellationNotificationClaims
      ? (JSON.parse(row.cancellationNotificationClaims) as Record<
          string,
          "delivered" | { claimedAt: string; leaseToken: string }
        >)
      : {};
    const existing = claims[notificationKey];
    if (existing === "delivered") return null;
    if (
      existing &&
      typeof existing !== "string" &&
      Date.now() - new Date(existing.claimedAt).getTime() < 60_000
    ) {
      return null;
    }

    const now = new Date().toISOString();
    const leaseToken = crypto.randomUUID();
    claims[notificationKey] = { claimedAt: now, leaseToken };
    await getDbClient().run(
      `UPDATE approval_requests
         SET cancellationNotificationClaims = ?, updatedAt = ?
         WHERE id = ? AND status = 'cancelled'`,
      [JSON.stringify(claims), now, id],
    );
    return { approval: rowToApprovalRequest(row), leaseToken };
  });
}

export async function completeApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
): Promise<void> {
  await updateApprovalCancellationNotificationClaim(id, notificationKey, leaseToken, "delivered");
}

export async function releaseApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
): Promise<void> {
  await updateApprovalCancellationNotificationClaim(id, notificationKey, leaseToken, null);
}

async function updateApprovalCancellationNotificationClaim(
  id: string,
  notificationKey: string,
  leaseToken: string,
  value: "delivered" | null,
): Promise<void> {
  await getDbClient().transaction(async () => {
    const row = await getDbClient().get<{ claims: string | null }>(
      "SELECT cancellationNotificationClaims AS claims FROM approval_requests WHERE id = ?",
      [id],
    );
    const claims = row?.claims
      ? (JSON.parse(row.claims) as Record<
          string,
          "delivered" | { claimedAt: string; leaseToken: string }
        >)
      : {};
    const current = claims[notificationKey];
    if (!current || typeof current === "string" || current.leaseToken !== leaseToken) {
      return;
    }
    if (value === null) delete claims[notificationKey];
    else claims[notificationKey] = value;
    await getDbClient().run(
      `UPDATE approval_requests
         SET cancellationNotificationClaims = ?, updatedAt = ?
         WHERE id = ? AND status = 'cancelled'`,
      [JSON.stringify(claims), new Date().toISOString(), id],
    );
  });
}

export async function updateApprovalRequestNotifications(
  id: string,
  notificationChannels: Array<{ channel: string; target: string; messageTs?: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    "UPDATE approval_requests SET notificationChannels = ?, updatedAt = ? WHERE id = ?",
    [JSON.stringify(notificationChannels), now, id],
  );
}

export async function listApprovalRequests(filters?: {
  status?: string;
  workflowRunId?: string;
  limit?: number;
}): Promise<ApprovalRequest[]> {
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

  const rows = await getDbClient().query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests ${where} ORDER BY createdAt DESC LIMIT ?`,
    params,
  );

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

export async function getStuckApprovalRuns(): Promise<StuckApprovalRun[]> {
  return getDbClient().query<StuckApprovalRun>(
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
  );
}

export async function getApprovalRequestByStepId(stepId: string): Promise<ApprovalRequest | null> {
  const row = await getDbClient().get<ApprovalRequestRow>(
    "SELECT * FROM approval_requests WHERE workflowRunStepId = ?",
    [stepId],
  );
  return row ? rowToApprovalRequest(row) : null;
}

// TODO: Wire into a periodic cron/sweep to auto-timeout expired approval requests (Phase 2)
export async function getExpiredPendingApprovals(): Promise<ApprovalRequest[]> {
  const rows = await getDbClient().query<ApprovalRequestRow>(
    `SELECT * FROM approval_requests
       WHERE status = 'pending'
         AND expiresAt IS NOT NULL
         AND expiresAt < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
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

export async function createWaitState(input: CreateWaitStateInput): Promise<WaitStateRow> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<WaitStateRowDb>(
    `INSERT INTO wait_states
         (id, workflowRunId, workflowRunStepId, mode, wakeUpAt, eventName, eventFilter, expiresAt, eventScope, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
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
    ],
  );
  return rowToWaitState(row!);
}

export async function getWaitStateById(id: string): Promise<WaitStateRow | null> {
  const row = await getDbClient().get<WaitStateRowDb>("SELECT * FROM wait_states WHERE id = ?", [
    id,
  ]);
  return row ? rowToWaitState(row) : null;
}

/**
 * Idempotency lookup — mirrors `getApprovalRequestByStepId`. A re-execution of
 * the same wait node finds its existing row instead of inserting a duplicate.
 */
export async function getWaitStateByStepId(stepId: string): Promise<WaitStateRow | null> {
  const row = await getDbClient().get<WaitStateRowDb>(
    "SELECT * FROM wait_states WHERE workflowRunStepId = ?",
    [stepId],
  );
  return row ? rowToWaitState(row) : null;
}

/**
 * Scan for waits the poller should resume now:
 *   - mode='time' with `wakeUpAt <= now`, OR
 *   - mode='event' with non-null `expiresAt <= now` (timeout branch).
 */
export async function getDueWaitStates(): Promise<WaitStateRow[]> {
  const rows = await getDbClient().query<WaitStateRowDb>(
    `SELECT * FROM wait_states
       WHERE status = 'pending'
         AND (
           (mode = 'time' AND wakeUpAt IS NOT NULL
              AND wakeUpAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           OR
           (mode = 'event' AND expiresAt IS NOT NULL
              AND expiresAt <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         )`,
  );
  return rows.map(rowToWaitState);
}

/**
 * Distinct `eventName` values across pending event-mode waits. Used at boot
 * by the wait-bus subscription system to register one listener per event name.
 */
export async function getPendingEventWaitNames(): Promise<string[]> {
  const rows = await getDbClient().query<{ eventName: string }>(
    `SELECT DISTINCT eventName FROM wait_states
       WHERE status = 'pending' AND eventName IS NOT NULL`,
  );
  return rows.map((r) => r.eventName);
}

/**
 * Find pending event-mode waits matching `eventName`. Optional `runId` narrows
 * to a single run for run-scoped signals. The Phase 3 listener applies the
 * declarative/JS filter on top of this; the DB query is the cheap pre-filter.
 */
export async function getPendingWaitsByEvent(
  eventName: string,
  runId?: string,
): Promise<WaitStateRow[]> {
  if (runId !== undefined) {
    const rows = await getDbClient().query<WaitStateRowDb>(
      `SELECT * FROM wait_states
         WHERE status = 'pending' AND mode = 'event' AND eventName = ? AND workflowRunId = ?`,
      [eventName, runId],
    );
    return rows.map(rowToWaitState);
  }
  const rows = await getDbClient().query<WaitStateRowDb>(
    `SELECT * FROM wait_states
       WHERE status = 'pending' AND mode = 'event' AND eventName = ?`,
    [eventName],
  );
  return rows.map(rowToWaitState);
}

/**
 * Atomic state transition: pending → fired|timeout. Returns `{updated: true}`
 * iff the caller won the race (UPDATE matched a pending row). Concurrent
 * callers see `{updated: false}` and should bail without further side effects.
 */
export async function resolveWaitState(
  id: string,
  data: { status: Exclude<WaitStateStatus, "pending">; firedPayload?: unknown },
): Promise<{ updated: boolean; row: WaitStateRow | null }> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<WaitStateRowDb>(
    `UPDATE wait_states
       SET status = ?, firedPayload = ?, resolvedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
    [
      data.status,
      data.firedPayload !== undefined ? JSON.stringify(data.firedPayload) : null,
      now,
      now,
      id,
    ],
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
export async function getStuckWaitRuns(): Promise<StuckWaitRun[]> {
  return getDbClient().query<StuckWaitRun>(
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
  );
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

async function assertSkillFileLimits(
  skillId: string,
  incoming: SkillFileInput[],
  replaceAll: boolean,
): Promise<void> {
  const existing = replaceAll ? [] : await listSkillFileManifest(skillId);
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

/**
 * DEFERRED (transaction rule): called from `skillsSeeder.apply()`
 * (src/be/seed-skills/index.ts), inside its synchronous
 * `getDb().transaction()` callback — stays on the raw sync handle.
 */
export async function createSkill(data: SkillInsert): Promise<Skill> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<SkillRow>(
    `INSERT INTO skills (
        id, name, description, content, type, scope, ownerAgentId,
        sourceUrl, sourceRepo, sourcePath, sourceBranch, sourceHash, isComplex,
        allowedTools, model, effort, context, agent, disableModelInvocation, userInvocable,
        version, isEnabled, systemDefault, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create skill");
  return rowToSkill(row);
}

export async function updateSkill(
  id: string,
  updates: Partial<SkillInsert> & { isEnabled?: boolean; lastFetchedAt?: string },
): Promise<Skill | null> {
  const existing = await getSkillById(id);
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
  const row = await getDbClient().get<SkillRow>(
    `UPDATE skills SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );

  return row ? rowToSkill(row) : null;
}

async function bumpSkillVersion(skillId: string, now = new Date().toISOString()) {
  await getDbClient().run(
    "UPDATE skills SET version = version + 1, lastUpdatedAt = ? WHERE id = ?",
    [now, skillId],
  );
}

export async function listSkillFileManifest(skillId: string): Promise<SkillFileManifestEntry[]> {
  const rows = await getDbClient().query<SkillFileRow>(
    `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ?
       ORDER BY path ASC`,
    [skillId],
  );
  return rows.map((row) => {
    const { content: _content, ...manifest } = rowToSkillFile(row);
    return manifest;
  });
}

export async function getSkillFiles(skillId: string): Promise<SkillFile[]> {
  const rows = await getDbClient().query<SkillFileRow>(
    `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ?
       ORDER BY path ASC`,
    [skillId],
  );
  return rows.map(rowToSkillFile);
}

export async function getSkillFile(skillId: string, path: string): Promise<SkillFile | null> {
  const normalizedPath = normalizeSkillFilePath(path);
  const row = await getDbClient().get<SkillFileRow>(
    `SELECT id, skillId, path, content, mimeType, isBinary, size, createdAt, lastUpdatedAt
       FROM skill_files
       WHERE skillId = ? AND path = ?`,
    [skillId, normalizedPath],
  );
  return row ? rowToSkillFile(row) : null;
}

/** Single-file upsert. */
export async function upsertSkillFile(skillId: string, input: SkillFileInput): Promise<SkillFile> {
  const payload = normalizeSkillFileInput(input);
  await assertSkillFileLimits(skillId, [payload], false);
  return await upsertSkillFileUnchecked(
    skillId,
    payload,
    crypto.randomUUID(),
    new Date().toISOString(),
    true,
  );
}

async function upsertSkillFileUnchecked(
  skillId: string,
  payload: NormalizedSkillFileInput,
  id: string,
  now: string,
  bumpVersion: boolean,
): Promise<SkillFile> {
  const row = await getDbClient().get<SkillFileRow>(
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
    [
      id,
      skillId,
      payload.path,
      payload.content,
      payload.mimeType,
      payload.isBinary ? 1 : 0,
      payload.size,
      now,
      now,
    ],
  );

  if (!row) throw new Error("Failed to upsert skill file");
  if (bumpVersion) await bumpSkillVersion(skillId, now);
  return rowToSkillFile(row);
}

export async function upsertSkillFiles(
  skillId: string,
  files: SkillFileInput[],
): Promise<SkillFile[]> {
  if (files.length === 0) return [];
  const normalized = files.map(normalizeSkillFileInput);
  await assertSkillFileLimits(skillId, normalized, false);

  const now = new Date().toISOString();
  return await getDbClient().transaction(async () => {
    const rows: SkillFile[] = [];
    for (const file of normalized) {
      rows.push(await upsertSkillFileUnchecked(skillId, file, crypto.randomUUID(), now, false));
    }
    await bumpSkillVersion(skillId, now);
    return rows;
  });
}

export async function deleteSkillFile(skillId: string, path: string): Promise<boolean> {
  const normalizedPath = normalizeSkillFilePath(path);
  const result = await getDbClient().run("DELETE FROM skill_files WHERE skillId = ? AND path = ?", [
    skillId,
    normalizedPath,
  ]);
  if (result.changes > 0) {
    await bumpSkillVersion(skillId);
    return true;
  }
  return false;
}

export async function deleteSkill(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM skills WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function getSkillById(id: string): Promise<Skill | null> {
  const row = await getDbClient().get<SkillRow>("SELECT * FROM skills WHERE id = ?", [id]);
  return row ? rowToSkill(row) : null;
}

export async function getSkillByName(
  name: string,
  scope: SkillScope,
  ownerAgentId?: string,
): Promise<Skill | null> {
  const row = await getDbClient().get<SkillRow>(
    "SELECT * FROM skills WHERE name = ? AND scope = ? AND COALESCE(ownerAgentId, '') = ?",
    [name, scope, ownerAgentId ?? ""],
  );
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

export async function listSkills(filters?: SkillFilters): Promise<Skill[]> {
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

  const rows = await getDbClient().query<SkillRow>(query, params);
  return rows.map(rowToSkill);
}

export async function searchSkills(
  query: string,
  limit = 20,
  includeContent = true,
): Promise<Skill[]> {
  const term = `%${query}%`;
  const columns = includeContent === false ? SKILL_SLIM_COLUMNS : "*";
  const rows = await getDbClient().query<SkillRow>(
    `SELECT ${columns} FROM skills WHERE (name LIKE ? OR description LIKE ?) AND isEnabled = 1 ORDER BY name ASC LIMIT ?`,
    [term, term, limit],
  );
  return rows.map(rowToSkill);
}

export async function installSkill(agentId: string, skillId: string): Promise<AgentSkill> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<AgentSkillRow>(
    `INSERT INTO agent_skills (id, agentId, skillId, isActive, installedAt)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(agentId, skillId) DO UPDATE SET isActive = 1
       RETURNING *`,
    [id, agentId, skillId, now],
  );

  if (!row) throw new Error("Failed to install skill");
  return rowToAgentSkill(row);
}

export async function getSystemDefaultSkills(): Promise<Skill[]> {
  const rows = await getDbClient().query<SkillRow>(
    "SELECT * FROM skills WHERE systemDefault = 1 AND isEnabled = 1 ORDER BY name ASC",
  );
  return rows.map(rowToSkill);
}

export async function installSystemDefaultSkillsForAgent(agentId: string): Promise<AgentSkill[]> {
  const skills = await getSystemDefaultSkills();
  const installed: AgentSkill[] = [];
  for (const skill of skills) {
    installed.push(await installSkill(agentId, skill.id));
  }
  return installed;
}

export async function uninstallSkill(agentId: string, skillId: string): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM agent_skills WHERE agentId = ? AND skillId = ?",
    [agentId, skillId],
  );
  return result.changes > 0;
}

export async function getAgentSkills(
  agentId: string,
  activeOnly = true,
): Promise<SkillWithInstallInfo[]> {
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

  const rows = await getDbClient().query<SkillWithInstallRow>(query, [agentId]);

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

export async function toggleAgentSkill(
  agentId: string,
  skillId: string,
  isActive: boolean,
): Promise<boolean> {
  const result = await getDbClient().run(
    "UPDATE agent_skills SET isActive = ? WHERE agentId = ? AND skillId = ?",
    [isActive ? 1 : 0, agentId, skillId],
  );
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

export async function createMcpServer(data: McpServerInsert): Promise<McpServer> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<McpServerRow>(
    `INSERT INTO mcp_servers (
        id, name, description, scope, ownerAgentId, transport,
        command, args, url, headers,
        envConfigKeys, headerConfigKeys, extraAuthorizeParams,
        isEnabled, version, createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?) RETURNING *`,
    [
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
    ],
  );

  if (!row) throw new Error("Failed to create MCP server");
  return rowToMcpServer(row);
}

export async function updateMcpServer(
  id: string,
  updates: Partial<McpServerInsert> & {
    isEnabled?: boolean;
    authMethod?: McpServer["authMethod"];
  },
): Promise<McpServer | null> {
  const existing = await getMcpServerById(id);
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
  const row = await getDbClient().get<McpServerRow>(
    `UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );

  return row ? rowToMcpServer(row) : null;
}

export type DeleteMcpServerResult = {
  deleted: boolean;
  deletedScriptConnectionCount: number;
};

export async function deleteMcpServer(id: string): Promise<DeleteMcpServerResult> {
  const existing = await getDbClient().get<{ id: string }>(
    "SELECT id FROM mcp_servers WHERE id = ?",
    [id],
  );
  if (!existing) return { deleted: false, deletedScriptConnectionCount: 0 };

  return await getDbClient().transaction(async (tx) => {
    const deletedConnections = await tx.run(
      "DELETE FROM script_connections WHERE mcp_server_id = ?",
      [id],
    );
    const deletedServer = await tx.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
    return {
      deleted: deletedServer.changes > 0,
      deletedScriptConnectionCount: deletedConnections.changes,
    };
  });
}

export async function getMcpServerById(id: string): Promise<McpServer | null> {
  const row = await getDbClient().get<McpServerRow>("SELECT * FROM mcp_servers WHERE id = ?", [id]);
  return row ? rowToMcpServer(row) : null;
}

export async function getMcpServerByName(
  name: string,
  scope: McpServerScope,
  ownerAgentId: string | null,
): Promise<McpServer | null> {
  const row = await getDbClient().get<McpServerRow>(
    "SELECT * FROM mcp_servers WHERE name = ? AND scope = ? AND COALESCE(ownerAgentId, '') = ?",
    [name, scope, ownerAgentId ?? ""],
  );
  return row ? rowToMcpServer(row) : null;
}

export interface McpServerFilters {
  scope?: McpServerScope;
  ownerAgentId?: string;
  transport?: McpServerTransport;
  isEnabled?: boolean;
  search?: string;
}

export async function listMcpServers(filters?: McpServerFilters): Promise<McpServer[]> {
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

  const rows = await getDbClient().query<McpServerRow>(query, params);
  return rows.map(rowToMcpServer);
}

export async function installMcpServer(
  agentId: string,
  mcpServerId: string,
): Promise<AgentMcpServer> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<AgentMcpServerRow>(
    `INSERT INTO agent_mcp_servers (id, agentId, mcpServerId, isActive, installedAt)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(agentId, mcpServerId) DO UPDATE SET isActive = 1
       RETURNING *`,
    [id, agentId, mcpServerId, now],
  );

  if (!row) throw new Error("Failed to install MCP server");
  return rowToAgentMcpServer(row);
}

export async function uninstallMcpServer(agentId: string, mcpServerId: string): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?",
    [agentId, mcpServerId],
  );
  return result.changes > 0;
}

export async function getAgentMcpServers(
  agentId: string,
  activeOnly = true,
): Promise<McpServerWithInstallInfo[]> {
  const query = `
    SELECT ms.*, ams.isActive, ams.installedAt
    FROM mcp_servers ms
    JOIN agent_mcp_servers ams ON ms.id = ams.mcpServerId
    WHERE ams.agentId = ?
      ${activeOnly ? "AND ams.isActive = 1" : ""}
      AND ms.isEnabled = 1
    ORDER BY ms.name ASC
  `;

  const rows = await getDbClient().query<McpServerWithInstallRow>(query, [agentId]);
  return rows.map(rowToMcpServerWithInstall);
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

export async function createContextSnapshot(
  input: CreateContextSnapshotInput,
): Promise<ContextSnapshot> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const client = getDbClient();

  await client.run(
    `INSERT INTO task_context_snapshots (id, taskId, agentId, sessionId, contextUsedTokens, contextTotalTokens, contextPercent, eventType, compactTrigger, preCompactTokens, cumulativeInputTokens, cumulativeOutputTokens, contextFormula, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );

  // Update aggregate columns on agent_tasks
  if (input.contextPercent != null) {
    await client.run(
      `UPDATE agent_tasks SET peakContextPercent = MAX(COALESCE(peakContextPercent, 0), ?)
         WHERE id = ?`,
      [input.contextPercent, input.taskId],
    );
  }

  // Migration 063: peakContextTokens is monotonic-max across snapshots, not a
  // rolling latest. Mirrors Claude Code's status-line "peak context" semantic.
  if (input.contextUsedTokens != null) {
    await client.run(
      `UPDATE agent_tasks
         SET peakContextTokens = MAX(COALESCE(peakContextTokens, 0), ?)
         WHERE id = ?`,
      [input.contextUsedTokens, input.taskId],
    );
  }

  if (input.eventType === "compaction") {
    await client.run(
      "UPDATE agent_tasks SET compactionCount = COALESCE(compactionCount, 0) + 1 WHERE id = ?",
      [input.taskId],
    );
  }

  // Phase 10: set contextWindowSize on the FIRST snapshot that carries one
  // (was previously gated on eventType === 'completion', meaning the UI saw
  // NULL throughout running tasks). Subsequent snapshots leave it alone — the
  // window doesn't change mid-session.
  if (input.contextTotalTokens != null) {
    await client.run(
      `UPDATE agent_tasks
         SET contextWindowSize = ?
         WHERE id = ? AND contextWindowSize IS NULL`,
      [input.contextTotalTokens, input.taskId],
    );
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

export async function getContextSnapshotsByTaskId(
  taskId: string,
  limit = 500,
): Promise<ContextSnapshot[]> {
  const rows = await getDbClient().query<ContextSnapshotRow>(
    "SELECT * FROM task_context_snapshots WHERE taskId = ? ORDER BY createdAt ASC LIMIT ?",
    [taskId, limit],
  );
  return rows.map(rowToContextSnapshot);
}

export async function getContextSnapshotsBySessionId(
  sessionId: string,
  limit = 500,
): Promise<ContextSnapshot[]> {
  const rows = await getDbClient().query<ContextSnapshotRow>(
    "SELECT * FROM task_context_snapshots WHERE sessionId = ? ORDER BY createdAt ASC LIMIT ?",
    [sessionId, limit],
  );
  return rows.map(rowToContextSnapshot);
}

export interface ContextSummary {
  compactionCount: number;
  peakContextPercent: number | null;
  // Migration 063: renamed from totalContextTokensUsed.
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  snapshotCount: number;
}

export async function getContextSummaryByTaskId(taskId: string): Promise<ContextSummary> {
  const task = await getTaskById(taskId);
  const countRow = await getDbClient().get<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM task_context_snapshots WHERE taskId = ?",
    [taskId],
  );

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
export async function getAvailableKeyIndices(
  keyType: string,
  totalKeys: number,
  scope = "global",
  scopeId: string | null = null,
): Promise<number[]> {
  const now = new Date().toISOString();
  const client = getDbClient();
  const effectiveScopeId = scopeId ?? "";

  // Auto-clear expired rate limits
  await client.run(
    `UPDATE api_key_status
     SET status = 'available', rateLimitedUntil = NULL, updatedAt = ?
     WHERE keyType = ? AND scope = ? AND scopeId = ?
       AND status = 'rate_limited' AND rateLimitedUntil IS NOT NULL AND rateLimitedUntil <= ?`,
    [now, keyType, scope, effectiveScopeId, now],
  );

  // Get currently rate-limited key indices
  const rateLimited = await client.query<{ keyIndex: number }>(
    `SELECT keyIndex FROM api_key_status
       WHERE keyType = ? AND scope = ? AND scopeId = ?
         AND status = 'rate_limited'`,
    [keyType, scope, effectiveScopeId],
  );

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
export async function recordKeyUsage(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  taskId: string | null,
  scope = "global",
  scopeId: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const client = getDbClient();
  const effectiveScopeId = scopeId ?? "";

  // Upsert key status record. Sets `provider` on insert (auto-derived from
  // keyType — see deriveProviderFromKeyType in src/utils/credentials.ts).
  // The `name` column is left null on insert and only set via the
  // setApiKeyName API endpoint when the user manually labels the key.
  const provider = deriveProviderFromKeyType(keyType);
  await client.run(
    `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, lastUsedAt, totalUsageCount, provider, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(keyType, keySuffix, scope, scopeId)
     DO UPDATE SET
       lastUsedAt = excluded.lastUsedAt,
       totalUsageCount = totalUsageCount + 1,
       keyIndex = excluded.keyIndex,
       updatedAt = excluded.updatedAt`,
    [keyType, keySuffix, keyIndex, scope, effectiveScopeId, now, provider, now],
  );

  // Record which key was used on the task
  if (taskId) {
    await client.run(
      "UPDATE agent_tasks SET credentialKeySuffix = ?, credentialKeyType = ? WHERE id = ?",
      [keySuffix, keyType, taskId],
    );
  }
}

/**
 * Mark a key as rate-limited with a retry-after timestamp.
 */
export async function markKeyRateLimited(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
  scope = "global",
  scopeId: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  await getDbClient().run(
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
    [keyType, keySuffix, keyIndex, scope, effectiveScopeId, rateLimitedUntil, now, provider, now],
  );
}

export async function recordKeyRateLimitWindows(
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  windows: RateLimitWindowTelemetry,
  scope = "global",
  scopeId: string | null = null,
): Promise<void> {
  if (Object.keys(windows).length === 0) return;

  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const provider = deriveProviderFromKeyType(keyType);
  const client = getDbClient();
  const existing = await client.get<{ rateLimitWindows: string | null }>(
    `SELECT rateLimitWindows FROM api_key_status
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?`,
    [keyType, keySuffix, scope, effectiveScopeId],
  );
  const serialized = JSON.stringify({
    ...parseRateLimitWindowsJson(existing?.rateLimitWindows),
    ...windows,
  });

  await client.run(
    `INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId, rateLimitWindows, provider, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(keyType, keySuffix, scope, scopeId)
       DO UPDATE SET
         rateLimitWindows = excluded.rateLimitWindows,
         keyIndex = excluded.keyIndex,
         provider = excluded.provider,
         updatedAt = excluded.updatedAt`,
    [keyType, keySuffix, keyIndex, scope, effectiveScopeId, serialized, provider, now],
  );
}

/**
 * Set or clear the human-friendly `name` label on a pooled credential.
 * Identified by the natural key (keyType + keySuffix + scope + scopeId).
 * Returns true if a row was updated, false if no matching key exists.
 */
export async function setApiKeyName(
  keyType: string,
  keySuffix: string,
  name: string | null,
  scope = "global",
  scopeId: string | null = null,
): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE api_key_status
       SET name = ?, updatedAt = ?
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?`,
    [name, new Date().toISOString(), keyType, keySuffix, scope, scopeId ?? ""],
  );
  return result.changes > 0;
}

/**
 * Clear a stale rate-limit record after a successful use proves the key is healthy.
 */
export async function clearKeyRateLimit(
  keyType: string,
  keySuffix: string,
  scope = "global",
  scopeId: string | null = null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const effectiveScopeId = scopeId ?? "";
  const result = await getDbClient().run(
    `UPDATE api_key_status
       SET status = 'available', rateLimitedUntil = NULL, updatedAt = ?
       WHERE keyType = ? AND keySuffix = ? AND scope = ? AND scopeId = ?
         AND status = 'rate_limited'`,
    [now, keyType, keySuffix, scope, effectiveScopeId],
  );
  return result.changes > 0;
}

/**
 * Get all key status records for a credential type.
 */
export async function getKeyStatuses(
  keyType?: string,
  scope?: string,
  scopeId?: string | null,
): Promise<ApiKeyStatus[]> {
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
  const rows = await getDbClient().query<ApiKeyStatusRow>(
    `SELECT * FROM api_key_status ${where} ORDER BY keyIndex`,
    params,
  );
  return rows.map(rowToApiKeyStatus);
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
export async function getKeyCostSummary(keyType?: string): Promise<KeyCostSummary[]> {
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
  return getDbClient().query<KeyCostSummary>(
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
    params,
  );
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

export async function getUserById(id: string): Promise<User | null> {
  const row = await getDbClient().get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? rowToUser(row) : null;
}

export async function getAllUsers(): Promise<User[]> {
  const rows = await getDbClient().query<UserRow>("SELECT * FROM users ORDER BY name");
  return rows.map(rowToUser);
}

export async function createUser(data: {
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
}): Promise<User> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const row = await getDbClient().get<UserRow>(
    `INSERT INTO users (id, name, email, role, notes, emailAliases, preferredChannel, timezone, metadata, dailyBudgetUsd, status, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
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
    ],
  );
  if (!row) throw new Error("Failed to create user");
  return rowToUser(row);
}

export async function updateUser(
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
): Promise<User | null> {
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

  const row = await getDbClient().get<UserRow>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToUser(row) : null;
}

type UserReferenceRow = {
  tableName: string;
  columnName: string;
};

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function deleteUser(id: string, replacementUserId?: string): Promise<boolean> {
  if (replacementUserId === id) {
    throw new Error("Replacement user must differ from deleted user");
  }

  return await getDbClient().transaction(async (tx) => {
    const userExists = (
      await tx.get<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = ?) AS present",
        [id],
      )
    )?.present;
    if (!userExists) return false;

    if (replacementUserId) {
      const replacementExists = (
        await tx.get<{ present: number }>(
          "SELECT EXISTS(SELECT 1 FROM users WHERE id = ?) AS present",
          [replacementUserId],
        )
      )?.present;
      if (!replacementExists) throw new Error("Replacement user not found");
    }

    // Preserve rows that carry user attribution but lack ON DELETE semantics.
    // Schema discovery keeps this correct as new nullable user audit columns are added.
    // Migration 103 accidentally dropped the scheduled_tasks audit FKs while
    // recreating that table, so discover those two known logical references as
    // well until the table is next rebuilt with its original constraints.
    const references = await tx.query<UserReferenceRow>(
      `SELECT tables.name AS tableName, foreign_keys."from" AS columnName
       FROM sqlite_schema AS tables
       JOIN pragma_foreign_key_list(tables.name) AS foreign_keys
       JOIN pragma_table_info(tables.name) AS columns
         ON columns.name = foreign_keys."from"
       WHERE tables.type = 'table'
         AND foreign_keys."table" = 'users'
         AND foreign_keys.on_delete IN ('NO ACTION', 'RESTRICT')
         AND columns."notnull" = 0
       UNION ALL
       SELECT 'scheduled_tasks' AS tableName, columns.name AS columnName
       FROM pragma_table_info('scheduled_tasks') AS columns
       WHERE columns.name IN ('created_by', 'updated_by')
         AND columns."notnull" = 0
         AND NOT EXISTS (
           SELECT 1
           FROM pragma_foreign_key_list('scheduled_tasks') AS foreign_keys
           WHERE foreign_keys."from" = columns.name
             AND foreign_keys."table" = 'users'
         )`,
    );
    const replacement = replacementUserId ?? null;
    for (const reference of references) {
      const table = quoteSqlIdentifier(reference.tableName);
      const column = quoteSqlIdentifier(reference.columnName);
      await tx.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [replacement, id]);
    }

    // Workflow context is persisted JSON rather than a relational column, but
    // it exposes the same requester identity to downstream interpolation. Keep
    // it consistent with workflow_runs.created_by inside this transaction.
    if (replacementUserId) {
      await tx.run(
        `UPDATE workflow_runs
         SET context = json_set(context, '$.swarm.requestedByUserId', ?)
         WHERE json_valid(context)
           AND json_extract(context, '$.swarm.requestedByUserId') = ?`,
        [replacementUserId, id],
      );
    } else {
      await tx.run(
        `UPDATE workflow_runs
         SET context = json_remove(context, '$.swarm.requestedByUserId')
         WHERE json_valid(context)
           AND json_extract(context, '$.swarm.requestedByUserId') = ?`,
        [id],
      );
    }

    const result = await tx.run("DELETE FROM users WHERE id = ?", [id]);
    return result.changes > 0;
  });
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

export async function listInboxState(opts: {
  userId: string;
  status?: InboxItemStatus;
  itemType?: InboxItemType;
}): Promise<InboxItemState[]> {
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
  const rows = await getDbClient().query<InboxItemStateRow>(
    `SELECT * FROM inbox_item_state WHERE ${where} ORDER BY lastUpdatedAt DESC`,
    params,
  );
  return rows.map(rowToInboxItemState);
}

export async function upsertInboxState(opts: {
  userId: string;
  itemType: InboxItemType;
  itemId: string;
  status: InboxItemStatus;
  snoozeUntil?: string;
  dismissedAt?: string;
  doneAt?: string;
}): Promise<InboxItemState> {
  const now = new Date().toISOString();
  // Auto-derive timestamps from status when not explicitly provided.
  const dismissedAt = opts.dismissedAt ?? (opts.status === "dismissed" ? now : null);
  const doneAt = opts.doneAt ?? (opts.status === "done" ? now : null);
  const snoozeUntil = opts.snoozeUntil ?? null;

  // SQLite upsert via UNIQUE(userId, itemType, itemId).
  const row = await getDbClient().get<InboxItemStateRow>(
    `INSERT INTO inbox_item_state (userId, itemType, itemId, status, snoozeUntil, dismissedAt, doneAt, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(userId, itemType, itemId) DO UPDATE SET
         status = excluded.status,
         snoozeUntil = excluded.snoozeUntil,
         dismissedAt = excluded.dismissedAt,
         doneAt = excluded.doneAt,
         lastUpdatedAt = excluded.lastUpdatedAt
       RETURNING *`,
    [
      opts.userId,
      opts.itemType,
      opts.itemId,
      opts.status,
      snoozeUntil,
      dismissedAt,
      doneAt,
      now,
      now,
    ],
  );
  if (!row) throw new Error("Failed to upsert inbox state");
  return rowToInboxItemState(row);
}

// ============================================================================
// User Favorites (principal-scoped stars for pages, workflows, and schedules)
// ============================================================================

interface UserFavoriteRow {
  id: string;
  favoriteScope: string;
  userId: string | null;
  itemType: string;
  itemId: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
}

function rowToUserFavorite(row: UserFavoriteRow): UserFavorite {
  return {
    id: row.id,
    userId: row.userId ?? undefined,
    itemType: row.itemType as FavoriteItemType,
    itemId: row.itemId,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  };
}

export async function listFavorites(opts: {
  favoriteScope: string;
  itemType?: FavoriteItemType;
  itemIds?: string[];
}): Promise<UserFavorite[]> {
  const conditions = ["favoriteScope = ?"];
  const params: string[] = [opts.favoriteScope];

  if (opts.itemType) {
    conditions.push("itemType = ?");
    params.push(opts.itemType);
  }

  if (opts.itemIds && opts.itemIds.length > 0) {
    conditions.push(`itemId IN (${opts.itemIds.map(() => "?").join(",")})`);
    params.push(...opts.itemIds);
  }

  const rows = await getDbClient().query<UserFavoriteRow>(
    `SELECT * FROM user_favorites WHERE ${conditions.join(" AND ")} ORDER BY lastUpdatedAt DESC`,
    params,
  );
  return rows.map(rowToUserFavorite);
}

export async function listUserFavorites(opts: {
  userId: string;
  itemType?: FavoriteItemType;
  itemIds?: string[];
}): Promise<UserFavorite[]> {
  return listFavorites({ ...opts, favoriteScope: `user:${opts.userId}` });
}

export async function getFavoriteItemIdSet(opts: {
  favoriteScope: string;
  itemType: FavoriteItemType;
  itemIds?: string[];
}): Promise<Set<string>> {
  const favorites = await listFavorites(opts);
  return new Set(favorites.map((favorite) => favorite.itemId));
}

export async function setFavorite(opts: {
  favoriteScope: string;
  userId?: string | null;
  itemType: FavoriteItemType;
  itemId: string;
  favorite: boolean;
  actorId?: string | null;
}): Promise<UserFavorite | null> {
  if (!opts.favorite) {
    await getDbClient().run(
      "DELETE FROM user_favorites WHERE favoriteScope = ? AND itemType = ? AND itemId = ?",
      [opts.favoriteScope, opts.itemType, opts.itemId],
    );
    return null;
  }

  const now = new Date().toISOString();
  const actor = opts.actorId ?? opts.userId ?? opts.favoriteScope;
  const row = await getDbClient().get<UserFavoriteRow>(
    `INSERT INTO user_favorites (
         favoriteScope, userId, itemType, itemId, createdAt, lastUpdatedAt, created_by, updated_by
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(favoriteScope, itemType, itemId) DO UPDATE SET
         lastUpdatedAt = excluded.lastUpdatedAt,
         updated_by = excluded.updated_by
       RETURNING *`,
    [opts.favoriteScope, opts.userId ?? null, opts.itemType, opts.itemId, now, now, actor, actor],
  );
  if (!row) throw new Error("Failed to set favorite");
  return rowToUserFavorite(row);
}

export async function setUserFavorite(opts: {
  userId: string;
  itemType: FavoriteItemType;
  itemId: string;
  favorite: boolean;
  actorUserId?: string | null;
}): Promise<UserFavorite | null> {
  return setFavorite({
    ...opts,
    favoriteScope: `user:${opts.userId}`,
    actorId: opts.actorUserId,
  });
}

export async function withFavoriteFlags<T extends { id: string }>(
  rows: T[],
  opts: { favoriteScope?: string | null; itemType: FavoriteItemType },
): Promise<Array<T & { favorite: boolean }>> {
  if (!opts.favoriteScope || rows.length === 0) {
    return rows.map((row) => ({ ...row, favorite: false }));
  }
  const favoriteIds = await getFavoriteItemIdSet({
    favoriteScope: opts.favoriteScope,
    itemType: opts.itemType,
    itemIds: rows.map((row) => row.id),
  });
  return rows.map((row) => ({ ...row, favorite: favoriteIds.has(row.id) }));
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

export async function listTaskTemplates(opts?: {
  category?: string;
  kind?: TaskTemplateKind;
  query?: string;
}): Promise<TaskTemplate[]> {
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
  const rows = await getDbClient().query<TaskTemplateRow>(
    `SELECT * FROM task_templates ${where} ORDER BY createdAt`,
    params,
  );
  return rows.map(rowToTaskTemplate);
}

// ============================================================================
// Sessions — root task chain + recent-sessions list
// ============================================================================

/**
 * Walk the parent→child chain rooted at `rootTaskId` via recursive CTE.
 * Returns the chain ordered by `createdAt` (so the root is first; siblings
 * appear in creation order; grand-children after their parents).
 */
export async function getRootTaskChain(rootTaskId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `WITH RECURSIVE chain(id) AS (
         SELECT id FROM agent_tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM agent_tasks t
         JOIN chain c ON t.parentTaskId = c.id
       )
       SELECT t.* FROM agent_tasks t
       JOIN chain ON chain.id = t.id
       ORDER BY t.createdAt`,
    [rootTaskId],
  );
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

export async function listRecentSessions(
  opts?: ListRecentSessionsOpts & { slim?: false },
): Promise<SessionListItem[]>;
export async function listRecentSessions(
  opts: ListRecentSessionsOpts & { slim: true },
): Promise<SessionListItemSummary[]>;
export async function listRecentSessions(
  opts?: ListRecentSessionsOpts,
): Promise<SessionListItem[] | SessionListItemSummary[]> {
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
    conditions.push("(lower(r.task) LIKE ? OR lower(COALESCE(r.title, '')) LIKE ?)");
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (requestedByUserId) {
    conditions.push("r.requestedByUserId = ?");
    params.push(requestedByUserId);
  }
  params.push(limit, offset);

  const rootRows = await getDbClient().query<
    AgentTaskRow & { __chainCount: number; __lastActivityAt: string; __latestStatus: string }
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
    params,
  );

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
export async function countSessions(
  opts?: Pick<ListRecentSessionsOpts, "source" | "q" | "requestedByUserId">,
): Promise<number> {
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
    conditions.push("(lower(task) LIKE ? OR lower(COALESCE(title, '')) LIKE ?)");
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (requestedByUserId) {
    conditions.push("requestedByUserId = ?");
    params.push(requestedByUserId);
  }

  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_tasks WHERE ${conditions.join(" AND ")}`,
    params,
  );
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
export async function getBudget(scope: BudgetScope, scopeId: string): Promise<Budget | null> {
  const row = await getDbClient().get<BudgetRow>(
    "SELECT scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt FROM budgets WHERE scope = ? AND scope_id = ?",
    [scope, scopeId],
  );
  return row ? rowToBudget(row) : null;
}

/**
 * Phase 6: list every budget row in the system. Used by `GET /api/budgets`.
 * Order is `(scope, scope_id)` for stable output across calls.
 */
export async function getBudgets(): Promise<Budget[]> {
  const rows = await getDbClient().query<BudgetRow>(
    "SELECT scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt FROM budgets ORDER BY scope, scope_id",
  );
  return rows.map(rowToBudget);
}

/**
 * Phase 6: upsert a budget row. Creates the row if `(scope, scopeId)` does not
 * exist, otherwise updates `daily_budget_usd` and `lastUpdatedAt`. Returns the
 * resulting row in both cases.
 */
export async function upsertBudget(
  scope: BudgetScope,
  scopeId: string,
  dailyBudgetUsd: number,
): Promise<Budget> {
  const now = Date.now();
  await getDbClient().run(
    `INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, scope_id) DO UPDATE SET
         daily_budget_usd = excluded.daily_budget_usd,
         lastUpdatedAt = excluded.lastUpdatedAt`,
    [scope, scopeId, dailyBudgetUsd, now, now],
  );

  const updated = await getBudget(scope, scopeId);
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
export async function deleteBudget(scope: BudgetScope, scopeId: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM budgets WHERE scope = ? AND scope_id = ?", [
    scope,
    scopeId,
  ]);
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
export async function getAllPricingRows(): Promise<PricingRow[]> {
  const rows = await getDbClient().query<PricingRowDb>(
    "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing ORDER BY provider, model, token_class, effective_from DESC",
  );
  return rows.map(rowToPricingRow);
}

/**
 * Phase 6: list every pricing row for a given (provider, model, tokenClass)
 * triple. Order is `effective_from DESC` so newest is first.
 */
export async function getPricingRows(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
): Promise<PricingRow[]> {
  const rows = await getDbClient().query<PricingRowDb>(
    "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing WHERE provider = ? AND model = ? AND token_class = ? ORDER BY effective_from DESC",
    [provider, model, tokenClass],
  );
  return rows.map(rowToPricingRow);
}

/**
 * Phase 6: resolve "what price was in effect at time `atEpochMs`" — the row
 * with the largest `effective_from <= atEpochMs`. Returns null when no row
 * matches (model unseeded for that triple at that time). Backed by the
 * `idx_pricing_lookup` index from migration 044.
 */
export async function getActivePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  atEpochMs: number,
): Promise<PricingRow | null> {
  const row = await getDbClient().get<PricingRowDb>(
    "SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt FROM pricing WHERE provider = ? AND model = ? AND token_class = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
    [provider, model, tokenClass, atEpochMs],
  );
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
export async function insertPricingRow(input: InsertPricingRowInput): Promise<PricingRow> {
  const now = Date.now();
  await getDbClient().run(
    `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.provider,
      input.model,
      input.tokenClass,
      input.effectiveFrom,
      input.pricePerMillionUsd,
      now,
      now,
    ],
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
export async function deletePricingRow(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  effectiveFrom: number,
): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM pricing WHERE provider = ? AND model = ? AND token_class = ? AND effective_from = ?",
    [provider, model, tokenClass, effectiveFrom],
  );
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
export async function getDailySpendForAgent(agentId: string, dateUtc: string): Promise<number> {
  const row = await getDbClient().get<CoalesceSumRow>(
    "SELECT COALESCE(SUM(totalCostUsd), 0) as total FROM session_costs WHERE agentId = ? AND substr(createdAt, 1, 10) = ?",
    [agentId, dateUtc],
  );
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
export async function getDailySpendGlobal(dateUtc: string): Promise<number> {
  const row = await getDbClient().get<CoalesceSumRow>(
    "SELECT COALESCE(SUM(totalCostUsd), 0) as total FROM session_costs WHERE substr(createdAt, 1, 10) = ?",
    [dateUtc],
  );
  return row?.total ?? 0;
}

/**
 * Sum of `totalCostUsd` across all `session_costs` rows whose task was
 * requested by a given user on a given UTC calendar day. `dateUtc` MUST be
 * `'YYYY-MM-DD'` (UTC). Costs are joined through `agent_tasks` deliberately;
 * `session_costs` stays task/session-scoped and does not grow a userId column.
 */
export async function getDailySpendForUser(userId: string, dateUtc: string): Promise<number> {
  const row = await getDbClient().get<CoalesceSumRow>(
    `SELECT COALESCE(SUM(sc.totalCostUsd), 0) AS total
       FROM session_costs sc
       JOIN agent_tasks t ON sc.taskId = t.id
       WHERE t.requestedByUserId = ? AND substr(sc.createdAt, 1, 10) = ?`,
    [userId, dateUtc],
  );
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
export async function recordBudgetRefusalNotification(
  input: RecordBudgetRefusalNotificationInput,
): Promise<{
  inserted: boolean;
  row: BudgetRefusalNotification;
}> {
  const client = getDbClient();
  const now = Date.now();
  const result = await client.run(
    `INSERT OR IGNORE INTO budget_refusal_notifications
       (task_id, date, agent_id, cause, agent_spend_usd, agent_budget_usd, global_spend_usd, global_budget_usd, user_spend_usd, user_budget_usd, follow_up_task_id, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
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
    ],
  );

  const existing = await client.get<BudgetRefusalNotificationRow>(
    "SELECT * FROM budget_refusal_notifications WHERE task_id = ? AND date = ?",
    [input.taskId, input.date],
  );

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
export async function getBudgetRefusalNotification(
  taskId: string,
  date: string,
): Promise<BudgetRefusalNotification | null> {
  const row = await getDbClient().get<BudgetRefusalNotificationRow>(
    "SELECT * FROM budget_refusal_notifications WHERE task_id = ? AND date = ?",
    [taskId, date],
  );
  return row ? rowToBudgetRefusalNotification(row) : null;
}

/**
 * List recent budget refusal notifications across all tasks/dates, newest
 * first. Used by the operator dashboard to surface refusals as an
 * actionable feed (parent task → follow-up task link).
 */
export async function getRecentBudgetRefusalNotifications(
  limit = 50,
): Promise<BudgetRefusalNotification[]> {
  const rows = await getDbClient().query<BudgetRefusalNotificationRow>(
    "SELECT * FROM budget_refusal_notifications ORDER BY createdAt DESC LIMIT ?",
    [limit],
  );
  return rows.map(rowToBudgetRefusalNotification);
}

/**
 * Boolean observability helper — returns true iff a refusal notification has
 * already been recorded for `(taskId, date)`.
 */
export async function hasBudgetRefusalNotificationToday(
  taskId: string,
  date: string,
): Promise<boolean> {
  const row = await getDbClient().get<{ one: number }>(
    "SELECT 1 as one FROM budget_refusal_notifications WHERE task_id = ? AND date = ? LIMIT 1",
    [taskId, date],
  );
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
export async function setBudgetRefusalFollowUpTaskId(
  taskId: string,
  date: string,
  followUpTaskId: string,
): Promise<void> {
  await getDbClient().run(
    "UPDATE budget_refusal_notifications SET follow_up_task_id = ? WHERE task_id = ? AND date = ?",
    [followUpTaskId, taskId, date],
  );
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
export async function getLiveAgentCounts(minutes: number = 5): Promise<{
  leads_alive: number;
  workers_alive: number;
}> {
  const row = await getDbClient().get<{ leads_alive: number | null; workers_alive: number | null }>(
    `SELECT
         SUM(CASE WHEN isLead = 1 THEN 1 ELSE 0 END) AS leads_alive,
         SUM(CASE WHEN isLead = 0 THEN 1 ELSE 0 END) AS workers_alive
       FROM agents
       WHERE lastActivityAt IS NOT NULL
         AND lastActivityAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' minutes')
         AND status != 'offline'`,
    [minutes],
  );
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
export async function getInstanceActivity(): Promise<{
  agents_online: number;
  leads_online: number;
  recent_tasks_count: number;
}> {
  const { leads_alive, workers_alive } = await getLiveAgentCounts(5);
  const tasksRow = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agent_tasks
       WHERE createdAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`,
  );
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
export async function getSwarmMetrics(): Promise<SwarmMetrics> {
  const client = getDbClient();

  const groupCounts = async (
    table: string,
  ): Promise<{ total: number; by_status: Record<string, number> }> => {
    const rows = await client.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`,
    );
    const by_status: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      by_status[r.status] = r.count;
      total += r.count;
    }
    return { total, by_status };
  };

  const workflowRow = await client.get<{ total: number; enabled: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM workflows",
  );
  const pagesRow = await client.get<{ count: number }>("SELECT COUNT(*) AS count FROM pages");
  const sessionsRow = await client.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM active_sessions",
  );
  const skillsRow = await client.get<{ count: number }>("SELECT COUNT(*) AS count FROM skills");

  return {
    tasks: await groupCounts("agent_tasks"),
    agents: await groupCounts("agents"),
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
export async function hasFirstCompletedTask(): Promise<boolean> {
  const row = await getDbClient().get<{ one: number }>(
    `SELECT 1 AS one FROM agent_tasks WHERE status = 'completed' LIMIT 1`,
  );
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
export async function getKv(namespace: string, key: string): Promise<KvEntry | null> {
  const row = await getDbClient().get<KvRow>(
    `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
         FROM kv_entries WHERE namespace = ? AND key = ?`,
    [namespace, key],
  );
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    await getDbClient().run(`DELETE FROM kv_entries WHERE namespace = ? AND key = ?`, [
      namespace,
      key,
    ]);
    return null;
  }
  return decodeKvRow(row);
}

/** Delete expired entries in one namespace. Used by internal TTL-backed stores
 * that need proactive cleanup rather than waiting for a point read. */
export async function sweepExpiredKv(namespace: string, now = Date.now()): Promise<number> {
  const result = await getDbClient().run(
    `DELETE FROM kv_entries
        WHERE namespace = ?
          AND expires_at IS NOT NULL
          AND expires_at <= ?`,
    [namespace, now],
  );
  return result.changes;
}

/** Delete expired entries across a namespace family (`prefix` and
 * `prefix:*`). Used by per-agent internal stores whose inactive owners may
 * never return to trigger a namespace-local sweep. */
export async function sweepExpiredKvPrefix(prefix: string, now = Date.now()): Promise<number> {
  const escaped = prefix.replace(/[\\%_]/g, "\\$&");
  const result = await getDbClient().run(
    `DELETE FROM kv_entries
        WHERE (namespace = ? OR namespace LIKE ? ESCAPE '\\')
          AND expires_at IS NOT NULL
          AND expires_at <= ?`,
    [prefix, `${escaped}:%`, now],
  );
  return result.changes;
}

/**
 * Upsert a KV entry. Caller passes the decoded value + valueType; we encode
 * before storing. `expiresAt` is unix-ms (NULL means no expiry).
 *
 * If the key already exists with a different `valueType` we still overwrite —
 * INCR is the only collision-sensitive op and it does its own check.
 */
export async function upsertKv(input: {
  namespace: string;
  key: string;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): Promise<KvEntry> {
  const encoded = encodeKvValue(input.value, input.valueType);
  const expiresAt = input.expiresAt ?? null;
  const now = Date.now();
  const row = await getDbClient().get<KvRow>(
    `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         value_type = excluded.value_type,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
    [input.namespace, input.key, encoded, input.valueType, expiresAt, now, now],
  );
  if (!row) throw new Error("Failed to upsert kv entry");
  return decodeKvRow(row);
}

/**
 * Insert a KV entry only when the key is absent or expired (mirrors `getKv`'s
 * lazy-expiry semantics). Returns true when this caller created or refreshed
 * the entry, false when a live entry already existed. A single conditional
 * write, so it is safe as a concurrency claim (e.g. webhook dedup) where a
 * get-then-upsert pair would let two concurrent callers both win.
 */
export async function claimKv(input: {
  namespace: string;
  key: string;
  value: unknown;
  valueType: KvValueType;
  expiresAt?: number | null;
}): Promise<boolean> {
  const encoded = encodeKvValue(input.value, input.valueType);
  const expiresAt = input.expiresAt ?? null;
  const now = Date.now();
  const result = await getDbClient().run(
    `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         value_type = excluded.value_type,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at <= ?`,
    [input.namespace, input.key, encoded, input.valueType, expiresAt, now, now, now],
  );
  return result.changes > 0;
}

/**
 * Delete a KV entry. Returns true if a row was removed, false if nothing
 * existed. Does not differentiate expired-but-not-yet-swept from never-existed.
 */
export async function deleteKv(namespace: string, key: string): Promise<boolean> {
  const result = await getDbClient().run(`DELETE FROM kv_entries WHERE namespace = ? AND key = ?`, [
    namespace,
    key,
  ]);
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
export async function incrKv(namespace: string, key: string, by: number): Promise<KvEntry> {
  if (!Number.isInteger(by) || !Number.isSafeInteger(by)) {
    throw new Error("INCR `by` must be a JS-safe integer");
  }
  return await getDbClient().transaction(async (tx): Promise<KvEntry> => {
    const existing = await tx.get<KvRow>(
      `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
           FROM kv_entries WHERE namespace = ? AND key = ?`,
      [namespace, key],
    );

    const now = Date.now();
    const expired =
      existing?.expires_at !== null &&
      existing !== null &&
      existing.expires_at !== null &&
      existing.expires_at <= now;

    if (!existing || expired) {
      // Insert (or replace if expired). `upsertKv` re-enters the prepared
      // statement cache cheaply; inlining keeps this in one transaction.
      const row = await tx.get<KvRow>(
        `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, 'integer', ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             value_type = excluded.value_type,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at
           RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
        [namespace, key, String(by), null, now, now],
      );
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

    const row = await tx.get<KvRow>(
      `UPDATE kv_entries SET value = ?, updated_at = ?
           WHERE namespace = ? AND key = ?
         RETURNING namespace, key, value, value_type, expires_at, created_at, updated_at`,
      [String(next), now, namespace, key],
    );
    if (!row) throw new Error("Failed to update kv entry on INCR");
    return decodeKvRow(row);
  });
}

/**
 * List entries in a namespace, optionally filtered by prefix. Expired rows
 * are filtered out by the SELECT (no inline DELETE — listing should be a
 * stable cursor; sweeping happens on point-reads instead).
 *
 * `limit` is capped by the caller (HTTP enforces ≤1000); helper does no extra
 * bounds-check beyond what SQL accepts.
 */
export async function listKv(
  namespace: string,
  opts: { prefix?: string; limit: number; offset: number },
): Promise<KvEntry[]> {
  const now = Date.now();
  if (opts.prefix !== undefined && opts.prefix.length > 0) {
    // LIKE-escape `\` `%` `_` so a user-supplied prefix can't run wildcards.
    const escaped = opts.prefix.replace(/[\\%_]/g, "\\$&");
    const rows = await getDbClient().query<KvRow>(
      `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
           FROM kv_entries
          WHERE namespace = ?
            AND (expires_at IS NULL OR expires_at > ?)
            AND key LIKE ? ESCAPE '\\'
          ORDER BY key
          LIMIT ? OFFSET ?`,
      [namespace, now, `${escaped}%`, opts.limit, opts.offset],
    );
    return rows.map(decodeKvRow);
  }
  const rows = await getDbClient().query<KvRow>(
    `SELECT namespace, key, value, value_type, expires_at, created_at, updated_at
         FROM kv_entries
        WHERE namespace = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY key
        LIMIT ? OFFSET ?`,
    [namespace, now, opts.limit, opts.offset],
  );
  return rows.map(decodeKvRow);
}

/**
 * Count entries in a namespace (optionally with a prefix filter). Expired
 * rows are excluded — same predicate as `listKv`.
 */
export async function countKv(namespace: string, opts: { prefix?: string }): Promise<number> {
  const now = Date.now();
  if (opts.prefix !== undefined && opts.prefix.length > 0) {
    const escaped = opts.prefix.replace(/[\\%_]/g, "\\$&");
    const row = await getDbClient().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM kv_entries
          WHERE namespace = ?
            AND (expires_at IS NULL OR expires_at > ?)
            AND key LIKE ? ESCAPE '\\'`,
      [namespace, now, `${escaped}%`],
    );
    return row?.n ?? 0;
  }
  const row = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM kv_entries
        WHERE namespace = ?
          AND (expires_at IS NULL OR expires_at > ?)`,
    [namespace, now],
  );
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

export async function createScriptRun(data: {
  id: string;
  agentId: string;
  source: string;
  args: unknown;
  scriptName?: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
  createdBy?: string;
  updatedBy?: string;
}): Promise<{ run: ScriptRun; existing: boolean }> {
  const client = getDbClient();
  if (data.idempotencyKey) {
    const existing = await client.get<ScriptRunRow>(
      "SELECT * FROM script_runs WHERE idempotencyKey = ?",
      [data.idempotencyKey],
    );
    if (existing) return { run: rowToScriptRun(existing), existing: true };
  }

  const row = await client.get<ScriptRunRow>(
    `INSERT INTO script_runs
        (id, agentId, scriptName, source, args, idempotencyKey, requestedByUserId, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
      data.id,
      data.agentId,
      data.scriptName ?? null,
      data.source,
      JSON.stringify(data.args ?? null),
      data.idempotencyKey ?? null,
      data.requestedByUserId ?? null,
      data.createdBy ?? null,
      data.updatedBy ?? data.createdBy ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create script run");
  return { run: rowToScriptRun(row), existing: false };
}

// Persist a synchronous inline run (POST /api/scripts/run) as an already-terminal
// row. Unlike createScriptRun these never get a journal and never use the
// idempotencyKey column (inline idempotency lives in the kv table).
export async function recordInlineScriptRun(data: {
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
}): Promise<ScriptRun> {
  const row = await getDbClient().get<ScriptRunRow>(
    `INSERT INTO script_runs
        (id, agentId, scriptName, source, args, kind, status, output, error,
         startedAt, finishedAt, requestedByUserId, created_by, updated_by, apiEndpointId)
       VALUES (?, ?, ?, ?, ?, 'inline', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
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
    ],
  );
  if (!row) throw new Error("Failed to record inline script run");
  return rowToScriptRun(row);
}

export async function getScriptRun(id: string): Promise<ScriptRun | null> {
  const row = await getDbClient().get<ScriptRunRow>("SELECT * FROM script_runs WHERE id = ?", [id]);
  return row ? rowToScriptRun(row) : null;
}

export async function getScriptRunByIdempotencyKey(
  idempotencyKey: string,
): Promise<ScriptRun | null> {
  const row = await getDbClient().get<ScriptRunRow>(
    "SELECT * FROM script_runs WHERE idempotencyKey = ?",
    [idempotencyKey],
  );
  return row ? rowToScriptRun(row) : null;
}

export async function listScriptRuns(opts?: {
  status?: ScriptRunStatus;
  agentId?: string;
  scriptName?: string;
  limit?: number;
  offset?: number;
}): Promise<ScriptRunListItem[]> {
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
  const rows = await getDbClient().query<ScriptRunListRow>(
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
    params,
  );
  return rows.map(rowToScriptRunListItem);
}

export async function countScriptRuns(opts?: {
  status?: ScriptRunStatus;
  agentId?: string;
  scriptName?: string;
}): Promise<number> {
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
  const row = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM script_runs ${where}`,
    params,
  );
  return row?.count ?? 0;
}

export async function countActiveScriptRuns(): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_runs WHERE status IN ('running', 'paused')",
  );
  return row?.count ?? 0;
}

export type ScriptRunPatch = Partial<{
  status: ScriptRunStatus;
  pid: number | null;
  finishedAt: string | null;
  output: unknown;
  error: string | null;
  lastHeartbeatAt: string | null;
  updatedBy: string | null;
}>;

function scriptRunUpdateSets(patch: ScriptRunPatch): {
  sets: string[];
  vals: Array<string | number | null>;
} {
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
  return { sets, vals };
}

export async function updateScriptRun(id: string, patch: ScriptRunPatch): Promise<void> {
  const { sets, vals } = scriptRunUpdateSets(patch);
  if (sets.length === 0) return;
  vals.push(id);
  await getDbClient().run(`UPDATE script_runs SET ${sets.join(", ")} WHERE id = ?`, vals);
}

/**
 * Terminal-guarded variant of `updateScriptRun`: the UPDATE re-checks the
 * status its caller read, so a run that reached a terminal state in between
 * is not rewritten. Callers read the run, then await (process termination,
 * request parsing), so their own guard is advisory only: an operator cancel
 * and the harness's own final status POST can otherwise both pass it and the
 * loser overwrites the winner ("completed" stored as "cancelled" or the
 * reverse). Returns false when nothing was claimed, which callers map to
 * their already-terminal no-op branch. Heartbeat and pid writes keep using
 * plain `updateScriptRun`.
 */
export async function updateScriptRunIfNotTerminal(
  id: string,
  patch: ScriptRunPatch,
): Promise<boolean> {
  return await updateScriptRunGuarded(
    id,
    patch,
    "status NOT IN ('completed', 'failed', 'cancelled', 'aborted_limit')",
  );
}

/**
 * Same claim, narrower guard: only a run still `running` is written. The
 * supervisor's exit handler reads the run and then awaits, so a final status
 * posted by the harness (or a pause) in that window must win over the
 * exit-code-derived status.
 */
export async function updateScriptRunIfRunning(
  id: string,
  patch: ScriptRunPatch,
): Promise<boolean> {
  return await updateScriptRunGuarded(id, patch, "status = 'running'");
}

async function updateScriptRunGuarded(
  id: string,
  patch: ScriptRunPatch,
  predicate: string,
): Promise<boolean> {
  const { sets, vals } = scriptRunUpdateSets(patch);
  if (sets.length === 0) return false;
  vals.push(id);
  const result = await getDbClient().run(
    `UPDATE script_runs SET ${sets.join(", ")} WHERE id = ? AND ${predicate}`,
    vals,
  );
  return result.changes > 0;
}

export async function getRunningScriptRuns(): Promise<ScriptRun[]> {
  const rows = await getDbClient().query<ScriptRunRow>(
    "SELECT * FROM script_runs WHERE status IN ('running', 'paused')",
  );
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

export async function getScriptRunJournalStep(
  runId: string,
  stepKey: string,
): Promise<ScriptRunJournalEntry | null> {
  const row = await getDbClient().get<ScriptRunJournalRow>(
    "SELECT * FROM script_run_journal WHERE runId = ? AND stepKey = ?",
    [runId, stepKey],
  );
  return row ? rowToScriptRunJournalEntry(row) : null;
}

export async function upsertScriptRunJournalStep(data: {
  runId: string;
  stepKey: string;
  stepType: string;
  config: unknown;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  durationMs?: number;
}): Promise<void> {
  await getDbClient().run(
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

export async function listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalEntry[]> {
  const rows = await getDbClient().query<ScriptRunJournalRow>(
    "SELECT * FROM script_run_journal WHERE runId = ? ORDER BY startedAt ASC",
    [runId],
  );
  return rows.map(rowToScriptRunJournalEntry);
}

export async function countScriptRunJournalSteps(runId: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_run_journal WHERE runId = ?",
    [runId],
  );
  return row?.count ?? 0;
}

export async function countScriptRunJournalAgentTaskSteps(runId: string): Promise<number> {
  const row = await getDbClient().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_run_journal WHERE runId = ? AND stepType = 'agent-task'",
    [runId],
  );
  return row?.count ?? 0;
}
