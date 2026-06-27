-- Composite index for Slack thread queries (findCompletedTaskInThread, getMostRecentTaskInThread)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_slack_thread
  ON agent_tasks(slackChannelId, slackThreadTs, status);
