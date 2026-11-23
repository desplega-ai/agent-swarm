import { Database } from "bun:sqlite";
import type { QueryReader } from "@desplega/storage";
import { configureDbResolver } from "../../prompts/resolver";
import { VersionableFieldSchema } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { enforceAssetKeyStartupAudit, enforceAssetKeyStartupAuditAsync } from "../asset-key-audit";
import { migrateLegacyCredentialBindingBlob } from "../connection-bindings-blob-migration";
import { resolveEncryptionKey } from "../crypto";
import { createBunSqliteClient, type DbClient } from "../db-client";
import { runMigrations } from "../migrations/runner";
import { assertScriptRunSourceSchema } from "../migrations/script-run-sources";
import { autoEncryptLegacyOAuthSecrets } from "../oauth-encryption-backfill";
import { SEALED_PREFIX, SEALED_REPLAY_COLUMNS } from "../sealed-json";
import {
  applySqliteFilePragmas,
  applySqliteTemplatePragmas,
  ensureAgentProfileColumns,
  hasContextVersion,
  hasEncryptedSecretRows,
  ignoredDatabaseUrl,
  insertFirstContextVersion,
  isEmptySqliteDatabase,
  listAgentProfileFields,
  openPostgresEngine,
  type PostgresEngine,
  postgresUrlFromEnv,
  removeLegacyTaskStatusCheck,
  selectStorageEngine,
} from "../storage-root";

let db: Database | null = null;
let sqliteVecAvailable = false;
let dbCreatedThisBoot = false;

// The Postgres engine of this process (DATABASE_URL, Postgres brief D1), once started.
let postgres: PostgresEngine | null = null;
let postgresStarting: Promise<PostgresEngine> | null = null;

/** True when DATABASE_URL selects the Postgres engine. */
export function isPostgresEngine(): boolean {
  return selectStorageEngine() === "postgres";
}

function postgresNotStarted(): Error {
  return new Error(
    "[db] the Postgres engine is selected (DATABASE_URL) but not started: await startPostgres() first",
  );
}

/**
 * True when this process opened a database file that held no schema object
 * at all, so this boot is the one that created it. Seeds meant for new
 * installs only read it (src/be/db-retention-defaults.ts). An upgraded
 * install, a restored backup and the test template all report false.
 */
export function wasDbCreatedThisBoot(): boolean {
  if (isPostgresEngine()) {
    if (!postgres) throw postgresNotStarted();
    return postgres.createdThisBoot;
  }
  getDb();
  return dbCreatedThisBoot;
}

export function isSqliteVecAvailable(): boolean {
  return sqliteVecAvailable;
}

/** The `db-query` reader of the Postgres engine (decision D10), or null. */
export function getPostgresQueryReader(): QueryReader | null {
  return postgres?.queryReader ?? null;
}

/** Vector search capability of the active engine: sqlite-vec loaded, or pgvector present. */
export function isVectorSearchAvailable(): boolean {
  return postgres ? postgres.vectorSearch : sqliteVecAvailable;
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
  if (isPostgresEngine()) throw rawHandleUnavailable();

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
    applySqliteTemplatePragmas(db);
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
  const ignoredUrl = ignoredDatabaseUrl();
  if (ignoredUrl) {
    console.warn(
      `[db] DATABASE_URL is set but has no postgres:// or postgresql:// scheme; it is ignored and SQLite runs at ${dbPath} (DATABASE_URL=${ignoredUrl})`,
    );
  }

  // Boot must finish before getDb() hands this handle out. A step below can
  // throw SQLITE_BUSY while another connection holds the file, and the
  // db-client retries BUSY by calling getDb() again. With `db` still assigned,
  // that retry got a connection whose encryption key was never resolved, and
  // the server died on "Encryption key not resolved yet". Drop the handle so
  // the retry runs boot again.
  const opened = db;
  try {
    return bootOpenedDb(opened, dbPath, resolvePromptTemplate, autoEncryptLegacyPlaintextSecrets);
  } catch (error) {
    if (db === opened) {
      db = null;
      try {
        opened.close();
      } catch {
        // Already closed by the step that failed.
      }
    }
    throw error;
  }
}

function bootOpenedDb(
  database: Database,
  dbPath: string,
  resolvePromptTemplate: typeof import("../db").resolvePromptTemplate,
  autoEncryptLegacyPlaintextSecrets: typeof import("../db").autoEncryptLegacyPlaintextSecrets,
): Database {
  // Read before anything below can create a table.
  dbCreatedThisBoot = isEmptySqliteDatabase(database);
  applySqliteFilePragmas(database, { fresh: dbCreatedThisBoot });

  // Load sqlite-vec extension for vector search.
  // In compiled binaries (`bun build --compile`) the JS lives in /$bunfs/ and
  // `require.resolve("sqlite-vec-<platform>/vec0.so")` can't find the native
  // asset — so we prefer an explicit filesystem path when set, and only fall
  // back to the npm resolver for normal dev runs.
  loadSqliteVec(database);

  // Run database migrations (schema creation + incremental changes)
  try {
    runMigrations(database);
    assertScriptRunSourceSchema(database);
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
  ensureAgentProfileColumns(database, VERSIONABLE_FIELDS);

  // Migration: remove the restrictive CHECK constraint on agent_tasks.status
  // that old databases carry (it blocks 'cancelled', 'paused', 'offered', ...).
  removeLegacyTaskStatusCheck(database);

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

  const hasExistingEncryptedSecrets = hasEncryptedSecretRows(
    database,
    SEALED_REPLAY_COLUMNS,
    SEALED_PREFIX,
  );

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

  return database;
}

function rawHandleUnavailable(): Error {
  return new Error(
    "[db] the raw bun:sqlite handle does not exist on the Postgres engine (DATABASE_URL): use getStorage() repositories or getDbClient()",
  );
}

export function getDb(path?: string): Database {
  if (!db) {
    if (isPostgresEngine()) throw rawHandleUnavailable();
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
  dbCreatedThisBoot = false;
  retirePostgres().catch((err) => console.error("[db] Postgres close failed:", errorText(err)));
}

/**
 * Detach the Postgres engine and close it. A start still in flight is retired
 * too: the close waits for it to settle and then closes the engine it opened,
 * so no pool or lock outlives the close.
 */
function retirePostgres(): Promise<void> {
  const starting = postgresStarting;
  const current = postgres;
  postgresStarting = null;
  postgres = null;
  if (!starting) return current ? current.close() : Promise.resolve();
  return starting.then(
    (engine) => {
      if (postgres === engine) postgres = null;
      return engine.close();
    },
    // A failed start closed its own engine.
    () => undefined,
  );
}

/**
 * Close the database and wait for it: the Postgres pool drains and the
 * one-process lock is released, also for a start still in flight. On SQLite
 * the same as `closeDb()`.
 */
export async function closeDatabase(): Promise<void> {
  const retired = retirePostgres();
  closeDb();
  await retired;
}

function errorText(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * The Postgres start (decision D1): open the engine (one-process lock,
 * migration chain, read codec, pool), then run the engine-neutral steps of the
 * SQLite start through the repositories. The legacy repairs of the SQLite
 * start are not run: they exist only for upgraded SQLite files, and a Postgres
 * database starts from the baseline or from a copy of a file that ran them.
 * Idempotent: later calls wait for the same start.
 */
export function startPostgres(): Promise<void> {
  // The engine is assigned before the seed and key checks end (they read
  // through it), so readiness is the start promise, not the engine variable.
  if (!postgresStarting) {
    const url = postgresUrlFromEnv();
    const starting = bootPostgres(url).catch((err) => {
      if (postgresStarting === starting) postgresStarting = null;
      throw err;
    });
    postgresStarting = starting;
  }
  return postgresStarting.then(() => undefined);
}

async function bootPostgres(url: string): Promise<PostgresEngine> {
  const engine = await openPostgresEngine(url, process.env.DATABASE_QUERY_URL);
  postgres = engine;
  try {
    const { resolvePromptTemplate } = require("../db") as typeof import("../db");

    // Mandatory namespace invariant, as on SQLite: fatal before the API listens.
    await enforceAssetKeyStartupAuditAsync();

    // Seed v1 for existing agents that don't have any context versions yet.
    await seedContextVersionsAsync();

    configureDbResolver(resolvePromptTemplate);

    const { seedDefaultTemplatesAsync } =
      require("../seed-prompt-templates") as typeof import("../seed-prompt-templates");
    await seedDefaultTemplatesAsync();

    const hasExistingEncryptedSecrets = await engine.hasEncryptedSecretRows(
      SEALED_REPLAY_COLUMNS,
      SEALED_PREFIX,
    );
    // The key file lives in the data directory (SWARM_DATA_DIR, decision D2),
    // which defaults to the directory of DATABASE_PATH on both engines.
    resolveEncryptionKey(process.env.DATABASE_PATH || "./agent-swarm-db.sqlite", {
      allowGenerate: !hasExistingEncryptedSecrets,
    });
    return engine;
  } catch (err) {
    if (postgres === engine) postgres = null;
    await engine.close().catch(() => {});
    console.error(`[db] Postgres start failed: ${errorText(err)}`);
    throw err;
  }
}

// Async seam over the shared connection. The client resolves the underlying
// handle per operation via getDb(), so close/reopen cycles need no reset.
let dbClientInstance: DbClient | null = null;

export function getDbClient(): DbClient {
  if (postgres) return postgres.client;
  if (isPostgresEngine()) throw postgresNotStarted();
  if (!dbClientInstance) {
    dbClientInstance = createBunSqliteClient(() => getDb());
  }
  return dbClientInstance;
}

const VERSIONABLE_FIELDS = VersionableFieldSchema.options;

/** `seedContextVersions` through the repositories (the Postgres start). */
async function seedContextVersionsAsync(): Promise<void> {
  const { computeContentHash } = require("../db") as typeof import("../db");
  const { getStorage } = require("../storage") as typeof import("../storage");
  const agentsRepo = getStorage().repos.agents;
  const agents = await agentsRepo.listAgents({ includeExtensions: true });
  for (const agent of agents) {
    for (const field of VERSIONABLE_FIELDS) {
      const content = agent[field];
      if (!content) continue;
      if (await agentsRepo.latestContextVersion(agent.id, field)) continue;
      await agentsRepo.insertContextVersion({
        id: crypto.randomUUID(),
        agentId: agent.id,
        field,
        content,
        version: 1,
        changeSource: "system",
        changedByAgentId: null,
        changeReason: null,
        contentHash: computeContentHash(content),
        previousVersionId: null,
        createdAt: new Date().toISOString(),
      });
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
  const agents = listAgentProfileFields(database);

  for (const agent of agents) {
    for (const field of VERSIONABLE_FIELDS) {
      const content = agent[field];
      if (!content) continue;

      // Check if a version already exists for this agent+field
      if (hasContextVersion(database, agent.id, field)) continue;

      const id = crypto.randomUUID();
      const hash = computeContentHash(content);
      const now = new Date().toISOString();

      insertFirstContextVersion(database, { id, agentId: agent.id, field, content, hash, now });
    }
  }
}
