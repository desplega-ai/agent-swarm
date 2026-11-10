-- Opt-in terminal-run retention seeks the expiry frontier by completion time.
-- Keep the predicate identical to workflow-run-retention.ts for the partial index.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_retention
  ON workflow_runs(status, finishedAt, id)
  WHERE status IN ('completed', 'failed', 'skipped', 'cancelled');

-- Approval links are logical references rather than SQLite foreign keys.
CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow_step
  ON approval_requests(workflowRunStepId);
