import { Database } from "bun:sqlite";
import { configureDbResolver } from "../../prompts/resolver";
import { VersionableFieldSchema } from "../../types";
import { enforceAssetKeyStartupAudit } from "../asset-key-audit";
import { migrateLegacyCredentialBindingBlob } from "../connection-bindings-blob-migration";
import { resolveEncryptionKey } from "../crypto";
import { createBunSqliteClient, type DbClient } from "../db-client";
import { runMigrations } from "../migrations/runner";
import { autoEncryptLegacyOAuthSecrets } from "../oauth-encryption-backfill";

let db: Database | null = null;
let sqliteVecAvailable = false;

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

  // Load facade callbacks only after module evaluation. Boot stays synchronous,
  // while the runtime has no static dependency back through the facade.
  const { resolvePromptTemplate, autoEncryptLegacyPlaintextSecrets } =
    require("../db") as typeof import("../db");

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
  // The seeder imports the facade; loading it here avoids an initialization cycle.
  const { seedDefaultTemplates } =
    require("../seed-prompt-templates") as typeof import("../seed-prompt-templates");
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

const VERSIONABLE_FIELDS = VersionableFieldSchema.options;

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

/**
 * Seed v1 context versions for existing agents that don't have any versions yet.
 * Called during migration.
 */
function seedContextVersions(): void {
  const { computeContentHash } = require("../db") as typeof import("../db");
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
