-- GET /api/workflows/{id}/runs and the list-workflow-runs tool list one
-- workflow's runs newest first, optionally for one status, and count them for
-- page metadata. idx_workflow_runs_workflowId finds the rows but leaves SQLite
-- to sort every run of the workflow first (7k rows for the largest one), and
-- idx_workflow_runs_status makes a status-filtered page or count walk that
-- status across every workflow. These two return a page already in order and
-- count from the index alone.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started
  ON workflow_runs(workflowId, startedAt DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_status_started
  ON workflow_runs(workflowId, status, startedAt DESC, id DESC);
