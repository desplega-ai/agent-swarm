import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";

/**
 * Local embedded-replica file — always `evals/evals-replica.db` regardless of
 * cwd (gitignored). The old `evals/evals.db` is a FROZEN BACKUP of pre-Turso
 * data: new code must never open it, which is why there is no implicit
 * `file:evals.db` default below.
 */
export const REPLICA_PATH = join(import.meta.dir, "../../evals-replica.db");

let client: Client | null = null;
let isReplica = false;

/**
 * libsql client (module-cached). Env resolution, in precedence order:
 *
 * 1. `EVALS_DB_SYNC_URL` set → Turso **embedded replica**: local WAL file at
 *    {@link REPLICA_PATH} + background pull every 60 s; every write is
 *    forwarded synchronously to the Turso primary (read-your-writes locally).
 *    Requires `EVALS_DB_AUTH_TOKEN`.
 * 2. else `EVALS_DB_PATH` set → plain local file client, no sync (explicit
 *    offline/dev escape hatch; `:memory:` and `file:` URLs pass through).
 * 3. else → throw. Never silently create an empty default DB.
 */
export function getDb(): Client {
  if (client) return client;

  const syncUrl = process.env.EVALS_DB_SYNC_URL;
  if (syncUrl) {
    const authToken = process.env.EVALS_DB_AUTH_TOKEN;
    if (!authToken) {
      throw new Error("EVALS_DB_SYNC_URL is set but EVALS_DB_AUTH_TOKEN is missing");
    }
    client = createClient({
      url: `file:${REPLICA_PATH}`,
      syncUrl,
      authToken,
      syncInterval: 60,
    });
    isReplica = true;
    return client;
  }

  const localPath = process.env.EVALS_DB_PATH;
  if (localPath) {
    const url =
      localPath === ":memory:" || localPath.startsWith("file:") ? localPath : `file:${localPath}`;
    client = createClient({ url });
    isReplica = false;
    return client;
  }

  throw new Error(
    "evals DB is not configured: set EVALS_DB_SYNC_URL + EVALS_DB_AUTH_TOKEN " +
      "(Turso embedded replica — see evals/.env) or EVALS_DB_PATH " +
      "(plain local file, offline/dev escape hatch)",
  );
}

/**
 * Test-only: drop the module-cached client so changed env vars take effect on
 * the next getDb() call.
 */
export function resetDbForTests(): void {
  if (client) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  client = null;
  isReplica = false;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','cancelled')),
  scenario_ids TEXT NOT NULL,
  config_ids TEXT NOT NULL,
  attempts_per_cell INTEGER NOT NULL DEFAULT 1,
  concurrency INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(id),
  scenario_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','judging','passed','failed','error')),
  retries INTEGER NOT NULL DEFAULT 0,
  sandbox_id TEXT,
  api_url TEXT,
  task_ids TEXT NOT NULL DEFAULT '[]',
  score REAL,
  passed INTEGER,
  error TEXT,
  cost_usd REAL,
  duration_ms INTEGER,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (run_id, scenario_id, config_id, attempt_index)
);

CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL CHECK (kind IN ('llm','deterministic')),
  name TEXT NOT NULL,
  pass INTEGER NOT NULL,
  score REAL,
  reasoning TEXT,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  name TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_judgments_attempt ON judgments(attempt_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts(attempt_id);
`;

export async function initDb(): Promise<Client> {
  const db = getDb();
  // Replica: pull remote state BEFORE any DDL so CREATE-IF-NOT-EXISTS runs
  // against the synced schema (idempotent DDL then forwards to the primary
  // each boot — harmless).
  if (isReplica) await db.sync();
  for (const stmt of SCHEMA.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.execute(stmt);
  }
  for (const stmt of COLUMN_MIGRATIONS) {
    try {
      await db.execute(stmt);
    } catch {
      // column already exists
    }
  }
  if (isReplica) {
    // Embedded replicas must run WAL locally; anything else means the native
    // binding fell back to a non-replica build. Fail loudly.
    const res = await db.execute("PRAGMA journal_mode");
    const mode = String(res.rows[0]?.journal_mode ?? "");
    if (mode !== "wal") {
      throw new Error(`evals replica is not in WAL mode (journal_mode=${mode || "unknown"})`);
    }
    // Boot visibility: which local file backs the Turso replica (path only —
    // never the sync URL or auth token).
    console.log(`evals DB: Turso embedded replica at ${REPLICA_PATH} (wal, sync every 60s)`);
  }
  return db;
}

/** Additive columns for DBs created before the column existed. */
const COLUMN_MIGRATIONS = [
  "ALTER TABLE eval_runs ADD COLUMN judge_model TEXT",
  "ALTER TABLE attempts ADD COLUMN cost_source TEXT",
  "ALTER TABLE attempts ADD COLUMN tokens_json TEXT",
  "ALTER TABLE attempts ADD COLUMN sandbox_json TEXT",
  "ALTER TABLE attempts ADD COLUMN timings_json TEXT",
  "ALTER TABLE attempts ADD COLUMN judge_cost_usd REAL",
  // v7 §10.1: per-member roster + cost snapshot (WorkerRosterEntry[]).
  "ALTER TABLE attempts ADD COLUMN workers_json TEXT",
  "ALTER TABLE judgments ADD COLUMN duration_ms INTEGER",
  "ALTER TABLE judgments ADD COLUMN cost_usd REAL",
  "ALTER TABLE judgments ADD COLUMN tokens_json TEXT",
  "ALTER TABLE judgments ADD COLUMN steps_json TEXT",
  // v8.0 OutcomeSpec v2: per-dimension judgment rows. Nullable, no default —
  // gate rows and all pre-v2 rows read back NULL on both.
  "ALTER TABLE judgments ADD COLUMN dimension TEXT",
  "ALTER TABLE judgments ADD COLUMN weight REAL",
];
