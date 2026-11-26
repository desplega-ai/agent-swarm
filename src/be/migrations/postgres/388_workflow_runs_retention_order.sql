-- Workflow-run retention reads its candidates ORDER BY "finishedAt", id with a
-- LIMIT. idx_workflow_runs_retention leads with status, and with four status
-- values Postgres 16 cannot return its rows in that order: each batch checked
-- every expired run against the tree guards, then sorted them. This index
-- has the order of the read, so the read stops at the LIMIT.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_retention_order"
  ON "workflow_runs" ("finishedAt", id)
  WHERE status IN ('completed', 'failed', 'skipped', 'cancelled');
