-- Workflow definitions
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,
  webhookSecret TEXT,
  createdByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workflow execution runs
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'waiting', 'completed', 'failed')),
  triggerData TEXT,
  context TEXT,
  error TEXT,
  startedAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflowId ON workflow_runs(workflowId);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

-- Per-node step history within a run
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
  finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_runId ON workflow_run_steps(runId);

-- Link tasks back to workflow runs for async resumption
ALTER TABLE agent_tasks ADD COLUMN workflowRunId TEXT REFERENCES workflow_runs(id);
ALTER TABLE agent_tasks ADD COLUMN workflowRunStepId TEXT REFERENCES workflow_run_steps(id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow_run ON agent_tasks(workflowRunId);
