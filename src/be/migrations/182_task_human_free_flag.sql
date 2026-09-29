-- Persist the structurally-human-free classification on agent_tasks.
--
-- The usage reports (GET /api/session-costs/summary, /api/attribution/by-person)
-- rebuilt a recursive CTE over EVERY task on each call to decide which sessions
-- belong to the swarm maintaining itself. That CTE is seeded from all tasks and
-- date filters do not prune it, so a 30-day summary paid for the whole history.
-- The classification is fixed when a task is created, so it is stored once
-- (src/be/db/tasks/human-free.ts owns the rule) and the reports read a column.
--
-- Rule (mirrors HUMAN_FREE_BASE_SQL): heartbeat / boot-triage tasks, scheduled
-- runs with no human creator (including workflow roots launched by one), and
-- `source='system'` follow-ups whose parent has no requester. It propagates to
-- children that stay unattributed (no requester, or one copied from the parent).
ALTER TABLE agent_tasks
ADD COLUMN isHumanFree INTEGER NOT NULL DEFAULT 0
CHECK (isHumanFree IN (0, 1));

WITH RECURSIVE human_free_tasks(id) AS (
  SELECT task.id
  FROM agent_tasks task
  LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
  WHERE COALESCE(task.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
    OR COALESCE(task.tags, '[]') LIKE '%"heartbeat"%'
    OR (COALESCE(task.source, '') = 'schedule' AND task.requestedByUserId IS NULL)
    OR (
      task.parentTaskId IS NULL
      AND COALESCE(task.source, '') = 'workflow'
      AND task.requestedByUserId IS NULL
      AND EXISTS (
        SELECT 1
        FROM workflow_runs run
        WHERE run.id = task.workflowRunId
          AND run.triggerType = 'schedule'
          AND run.created_by IS NULL
      )
    )
    OR (
      COALESCE(task.source, '') = 'system'
      AND parent.id IS NOT NULL
      AND parent.requestedByUserId IS NULL
    )

  UNION

  SELECT child.id
  FROM agent_tasks child
  JOIN human_free_tasks parent ON child.parentTaskId = parent.id
  WHERE child.requestedByUserId IS NULL
    OR child.requestedByUserIdInherited = 1
)
UPDATE agent_tasks
SET isHumanFree = 1
WHERE id IN (SELECT id FROM human_free_tasks);

-- Migration 164's covering index carried the columns the recursive CTE read
-- (parentTaskId, taskType, source, tags, workflowRunId). Nothing reads them
-- through it now. The session join needs only the requester, the flag and the
-- credential, so keep the index to those and let it stay index-only.
DROP INDEX IF EXISTS idx_agent_tasks_usage_cover;
CREATE INDEX idx_agent_tasks_usage_cover
  ON agent_tasks(
    id, requestedByUserId, isHumanFree, credentialKeyType, credentialKeySuffix
  );
