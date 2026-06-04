-- Script Workflows v1: durable background TypeScript scripts.

CREATE TABLE IF NOT EXISTS script_runs (
  id                TEXT PRIMARY KEY,
  agentId           TEXT NOT NULL,
  scriptName        TEXT,
  source            TEXT NOT NULL,
  args              TEXT NOT NULL DEFAULT 'null',
  status            TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN (
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
      'aborted_limit'
    )),
  pid               INTEGER,
  startedAt         TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt        TEXT,
  output            TEXT,
  error             TEXT,
  last_heartbeat_at TEXT,
  idempotencyKey    TEXT UNIQUE,
  requestedByUserId TEXT REFERENCES users(id),
  created_by        TEXT REFERENCES users(id),
  updated_by        TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_script_runs_status ON script_runs(status);
CREATE INDEX IF NOT EXISTS idx_script_runs_agentId ON script_runs(agentId);
CREATE INDEX IF NOT EXISTS idx_script_runs_idempotencyKey ON script_runs(idempotencyKey)
  WHERE idempotencyKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS script_run_journal (
  id          TEXT PRIMARY KEY,
  runId       TEXT NOT NULL REFERENCES script_runs(id) ON DELETE CASCADE,
  stepKey     TEXT NOT NULL,
  stepType    TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK(status IN ('completed','failed')),
  result      TEXT,
  error       TEXT,
  startedAt   TEXT NOT NULL DEFAULT (datetime('now')),
  completedAt TEXT,
  created_by  TEXT REFERENCES users(id),
  updated_by  TEXT REFERENCES users(id),
  UNIQUE(runId, stepKey)
);

CREATE INDEX IF NOT EXISTS idx_srj_runId ON script_run_journal(runId);
