-- Key a child workflow run by its parent step AND that step's attempt.
--
-- The retry poller re-executes a failed step under the same step id, with
-- `retryCount` bumped. Keyed by step id alone, the retried `sub-workflow`
-- step reconnected to the failed child of the previous attempt and failed
-- again without starting a new one.

ALTER TABLE workflow_runs ADD COLUMN parentStepAttempt INTEGER NOT NULL DEFAULT 0;

-- Before this migration a step had at most one child, created on whichever
-- attempt first got that far (a retry after a synchronous failure, such as a
-- disabled child workflow, creates it on attempt 1 or later), and every later
-- attempt reconnected to it. Hand that child to the attempt that settles or
-- re-executes it now, or recovery would look up the step's current attempt,
-- find no child and fail the parent as "deleted":
-- - a step queued for a retry (`failed` with `nextRetryAt`) starts its next
--   attempt at `retryCount`, which must start a new child, so the existing
--   child belongs to the previous attempt;
-- - any other step (running, waiting, terminal) owns it at `retryCount`.
-- A child whose step is gone keeps attempt 0.
UPDATE workflow_runs
   SET parentStepAttempt = (
     SELECT CASE
              WHEN s.status = 'failed' AND s.nextRetryAt IS NOT NULL
                THEN MAX(s.retryCount - 1, 0)
              ELSE s.retryCount
            END
       FROM workflow_run_steps s
      WHERE s.id = workflow_runs.parentStepId
   )
 WHERE parentStepId IS NOT NULL
   AND EXISTS (SELECT 1 FROM workflow_run_steps s WHERE s.id = workflow_runs.parentStepId);

DROP INDEX IF EXISTS idx_workflow_runs_parentStepId;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_parentStep_attempt
  ON workflow_runs(parentStepId, parentStepAttempt) WHERE parentStepId IS NOT NULL;
