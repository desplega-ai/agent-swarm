-- Workflow Engine Redesign: drop and recreate workflow tables with new schema.
-- This is a clean-slate migration — no existing workflow data is preserved.

-- Disable FK enforcement so we can drop referenced tables
PRAGMA foreign_keys = OFF;

-- NULL out FK columns on agent_tasks that reference workflow tables
UPDATE agent_tasks SET workflowRunId = NULL, workflowRunStepId = NULL
  WHERE workflowRunId IS NOT NULL OR workflowRunStepId IS NOT NULL;

-- Drop old tables in FK-safe order
DROP TABLE IF EXISTS workflow_run_steps;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflows;

-- Recreate workflows with new columns (triggers, cooldown, input; no webhookSecret)
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  cooldown TEXT,
  input TEXT,
  createdByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recreate workflow_runs with 'skipped' status
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'waiting', 'completed', 'failed', 'skipped')),
  triggerData TEXT,
  context TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflowId ON workflow_runs(workflowId);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

-- Recreate workflow_run_steps with retry columns
CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES workflow_runs(id),
  nodeId TEXT NOT NULL,
  nodeType TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped')),
  input TEXT,
  output TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT,
  retryCount INTEGER NOT NULL DEFAULT 0,
  maxRetries INTEGER NOT NULL DEFAULT 3,
  nextRetryAt TEXT,
  idempotencyKey TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_runId ON workflow_run_steps(runId);
CREATE INDEX IF NOT EXISTS idx_wrs_retry
  ON workflow_run_steps(status, nextRetryAt)
  WHERE status = 'failed' AND nextRetryAt IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wrs_idempotency ON workflow_run_steps(idempotencyKey);

-- New: workflow version history
CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changedByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workflowId, version)
);

-- Re-enable FK enforcement
PRAGMA foreign_keys = ON;
