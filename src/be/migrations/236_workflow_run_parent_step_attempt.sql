-- Key a child workflow run by its parent step AND that step's attempt.
--
-- The retry poller re-executes a failed step under the same step id, with
-- `retryCount` bumped. Keyed by step id alone, the retried `sub-workflow`
-- step reconnected to the failed child of the previous attempt and failed
-- again without starting a new one. Rows from before this migration are
-- attempt 0, the only attempt that could start a child.

ALTER TABLE workflow_runs ADD COLUMN parentStepAttempt INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_workflow_runs_parentStepId;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_parentStep_attempt
  ON workflow_runs(parentStepId, parentStepAttempt) WHERE parentStepId IS NOT NULL;
