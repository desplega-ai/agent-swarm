ALTER TABLE agent_tasks ADD COLUMN slackReplySent INTEGER DEFAULT 0;

-- Index on parentTaskId for getChildTasks() query (Phase 4)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parentTaskId ON agent_tasks(parentTaskId);
