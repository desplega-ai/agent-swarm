-- 019_approval_requests.sql
-- Human-in-the-Loop approval request system for workflow nodes and agent tools

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,                    -- UUID
  title TEXT NOT NULL,                    -- Display title for the request
  questions JSONB NOT NULL,              -- Array of Question objects

  -- Source context (one of these pairs will be set)
  workflowRunId TEXT,                    -- FK → workflow_runs.id (if from workflow)
  workflowRunStepId TEXT,               -- FK → workflow_run_steps.id (if from workflow)
  sourceTaskId TEXT,                     -- FK → agent_tasks.id (if from agent tool)

  -- Approver policy
  approvers JSONB NOT NULL,             -- { users: [...], roles: [...], policy: "any"|"all"|{min:N} }

  -- State
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timeout')),
  responses JSONB,                      -- Keyed by question ID
  resolvedBy TEXT,                      -- user ID of who responded
  resolvedAt DATETIME,                  -- when resolved

  -- Timeout
  timeoutSeconds INTEGER,              -- NULL = no timeout
  expiresAt DATETIME,                  -- computed: createdAt + timeoutSeconds

  -- Notifications sent
  notificationChannels JSONB,          -- [{ channel: "slack", target: "...", messageTs: "..." }]

  -- Metadata
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- For the history UI
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_created ON approval_requests(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow ON approval_requests(workflowRunId);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(sourceTaskId);
-- For recovery: find pending requests that may have expired during downtime
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires ON approval_requests(expiresAt) WHERE status = 'pending';
