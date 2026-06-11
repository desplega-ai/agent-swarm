import { type Client, createClient } from "@libsql/client";

let client: Client | null = null;

/**
 * libsql client. Local file by default; set TURSO_DATABASE_URL (+
 * TURSO_AUTH_TOKEN) to point at a Turso database instead.
 */
export function getDb(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL ?? `file:${process.env.EVALS_DB_PATH ?? "evals.db"}`;
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return client;
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
  return db;
}

/** Additive columns for DBs created before the column existed. */
const COLUMN_MIGRATIONS = [
  "ALTER TABLE eval_runs ADD COLUMN judge_model TEXT",
  "ALTER TABLE attempts ADD COLUMN cost_source TEXT",
  "ALTER TABLE attempts ADD COLUMN tokens_json TEXT",
  "ALTER TABLE attempts ADD COLUMN sandbox_json TEXT",
  "ALTER TABLE attempts ADD COLUMN timings_json TEXT",
];
