-- Link a child workflow run to the `sub-workflow` step that started it.
--
-- The parent step waits until this run is terminal. The unique index makes a
-- step own at most one child run, so a restart reconnects to the existing
-- child instead of starting a second one.

ALTER TABLE workflow_runs ADD COLUMN parentStepId TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_parentStepId
  ON workflow_runs(parentStepId) WHERE parentStepId IS NOT NULL;
