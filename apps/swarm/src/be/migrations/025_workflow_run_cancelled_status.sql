-- Add 'cancelled' as a valid status for workflow runs.
-- SQLite does not support ALTER CHECK constraints, so we recreate the table.

-- 1. Create the new table with updated CHECK constraint
CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled')),
  triggerData TEXT,
  context TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT
);

-- 2. Copy existing data
INSERT INTO workflow_runs_new SELECT * FROM workflow_runs;

-- 3. Drop old table and rename
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflowId ON workflow_runs(workflowId);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

-- Also add 'cancelled' to workflow_run_steps status
CREATE TABLE workflow_run_steps_new (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  nodeId TEXT NOT NULL,
  nodeType TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled')),
  input TEXT,
  output TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT,
  retryCount INTEGER NOT NULL DEFAULT 0,
  maxRetries INTEGER NOT NULL DEFAULT 0,
  nextRetryAt TEXT,
  idempotencyKey TEXT UNIQUE,
  diagnostics TEXT,
  nextPort TEXT
);

INSERT INTO workflow_run_steps_new SELECT * FROM workflow_run_steps;
DROP TABLE workflow_run_steps;
ALTER TABLE workflow_run_steps_new RENAME TO workflow_run_steps;

CREATE INDEX IF NOT EXISTS idx_wrs_runId ON workflow_run_steps(runId);
CREATE INDEX IF NOT EXISTS idx_wrs_status ON workflow_run_steps(status);
CREATE INDEX IF NOT EXISTS idx_wrs_idempotencyKey ON workflow_run_steps(idempotencyKey);
