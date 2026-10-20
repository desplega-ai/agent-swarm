-- getSlackTasksMissingTree runs on every Slack watcher tick. Without this index it walks
-- idx_agent_tasks_last_updated across every task to find the few Slack ones.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_slack_last_updated
  ON agent_tasks(lastUpdatedAt DESC)
  WHERE source = 'slack' AND slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL;
