-- Workflow-run retention reads its candidates ORDER BY finishedAt, id with a
-- LIMIT. idx_workflow_runs_retention leads with status, so for four status
-- values the read sorts every expired run (SQLite: a temp B-tree; Postgres 16
-- also checks each of them against the tree guards first). This index has the
-- order of the read, so the read stops at the LIMIT. Same index on Postgres.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_retention_order
  ON workflow_runs(finishedAt, id)
  WHERE status IN ('completed', 'failed', 'skipped', 'cancelled');
