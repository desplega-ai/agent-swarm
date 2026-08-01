-- Record the exact Slack message that directly created a task.
--
-- This is intentionally task-local creation metadata. Child/worker tasks keep
-- their inherited Slack delivery context, but do not inherit this timestamp.
ALTER TABLE agent_tasks ADD COLUMN slackTriggerMessageTs TEXT;
