-- Keep presentation transitions independent of outcome delivery and V2 activation.
ALTER TABLE slack_render_v2_state ADD COLUMN task_tree_enabled INTEGER
  CHECK (task_tree_enabled IN (0, 1));
ALTER TABLE slack_render_v2_state ADD COLUMN task_tree_enabled_at TEXT;

-- Recovery includes old active tasks, without scanning non-Slack history.
CREATE INDEX idx_slack_render_active_tasks ON agent_tasks(slackChannelId, slackThreadTs)
WHERE slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL
  AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped');
