-- Repair requester attribution using only durable origin evidence, then carry it
-- through task trees. Existing attribution always wins, and autonomous
-- heartbeat/boot-triage work deliberately remains unattributed.

-- Slack origins: the external identity mapping is authoritative.
UPDATE agent_tasks AS task
SET requestedByUserId = (
  SELECT external.userId
  FROM user_external_ids AS external
  WHERE external.kind = 'slack'
    AND external.externalId = task.slackUserId
)
WHERE task.requestedByUserId IS NULL
  AND task.parentTaskId IS NULL
  AND task.slackUserId IS NOT NULL
  AND IFNULL(task.taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
  AND IFNULL(task.tags, '[]') NOT LIKE '%"heartbeat"%'
  AND EXISTS (
    SELECT 1
    FROM user_external_ids AS external
    WHERE external.kind = 'slack'
      AND external.externalId = task.slackUserId
  );

-- Schedule origins: only schedules with a recorded human creator are eligible.
UPDATE agent_tasks AS task
SET requestedByUserId = (
  SELECT schedule.created_by
  FROM scheduled_tasks AS schedule
  WHERE schedule.id = task.scheduleId
    AND schedule.created_by IS NOT NULL
)
WHERE task.requestedByUserId IS NULL
  AND task.parentTaskId IS NULL
  AND task.scheduleId IS NOT NULL
  AND IFNULL(task.taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
  AND IFNULL(task.tags, '[]') NOT LIKE '%"heartbeat"%'
  AND EXISTS (
    SELECT 1
    FROM scheduled_tasks AS schedule
    WHERE schedule.id = task.scheduleId
      AND schedule.created_by IS NOT NULL
  );

-- Workflow origins: the workflow author is the only durable historic owner.
UPDATE agent_tasks AS task
SET requestedByUserId = (
  SELECT workflow.created_by
  FROM workflow_runs AS run
  JOIN workflows AS workflow ON workflow.id = run.workflowId
  WHERE run.id = task.workflowRunId
    AND workflow.created_by IS NOT NULL
)
WHERE task.requestedByUserId IS NULL
  AND task.parentTaskId IS NULL
  AND task.workflowRunId IS NOT NULL
  AND IFNULL(task.taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
  AND IFNULL(task.tags, '[]') NOT LIKE '%"heartbeat"%'
  AND EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN workflows AS workflow ON workflow.id = run.workflowId
    WHERE run.id = task.workflowRunId
      AND workflow.created_by IS NOT NULL
  );

-- Descendants: recursively carry each nearest attributed ancestor through NULL
-- rows. Pre-attributed children are independent anchors, preserving hand-offs.
WITH RECURSIVE attribution(taskId, userId) AS (
  SELECT id, requestedByUserId
  FROM agent_tasks
  WHERE requestedByUserId IS NOT NULL

  UNION ALL

  SELECT child.id, attribution.userId
  FROM agent_tasks AS child
  JOIN attribution ON child.parentTaskId = attribution.taskId
  WHERE child.requestedByUserId IS NULL
    AND IFNULL(child.taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
    AND IFNULL(child.tags, '[]') NOT LIKE '%"heartbeat"%'
)
UPDATE agent_tasks AS task
SET requestedByUserId = (
  SELECT attribution.userId
  FROM attribution
  WHERE attribution.taskId = task.id
)
WHERE task.requestedByUserId IS NULL
  AND EXISTS (
    SELECT 1
    FROM attribution
    WHERE attribution.taskId = task.id
  );
