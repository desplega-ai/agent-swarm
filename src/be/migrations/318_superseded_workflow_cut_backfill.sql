-- A workflow step task cut by a supersede fails with reason
-- 'superseded_workflow_task'. When the workflow carries on without it, the cut
-- is not a real failure and moves to 'superseded' (reason kept). The engine does
-- this live; this backfills rows written before it did. Two shapes match:
--   1. Detached from its step (workflowRunStepId cleared, workflowRunId kept):
--      the step was re-run in a fresh task.
--   2. Still bound to a step that ended 'completed': the workflow absorbed the
--      failure (onNodeFailure "continue" or a collect-outcomes fan-out).
-- A cut whose step ended 'failed' (or is still waiting on the engine) keeps
-- 'failed'. Idempotent: matched rows leave the 'failed' filter.
UPDATE agent_tasks
SET status = 'superseded',
    lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'failed'
  AND failureReason = 'superseded_workflow_task'
  AND (
    (workflowRunStepId IS NULL AND workflowRunId IS NOT NULL)
    OR EXISTS (
      SELECT 1 FROM workflow_run_steps s
      WHERE s.id = agent_tasks.workflowRunStepId AND s.status = 'completed'
    )
  );
