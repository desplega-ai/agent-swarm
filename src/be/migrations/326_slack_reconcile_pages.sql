-- Independent keyset cursors keep each recovery tick bounded without losing old work.
ALTER TABLE slack_render_v2_state ADD COLUMN reconcile_cursors TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_slack_reconcile_active ON agent_tasks(id)
WHERE slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL
  AND status IN ('offered', 'reviewing', 'pending', 'in_progress', 'paused');
CREATE INDEX idx_slack_reconcile_terminal ON agent_tasks(id)
WHERE slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL
  AND status IN ('completed', 'failed', 'cancelled');
CREATE INDEX idx_slack_reconcile_outcome ON slack_messages(id)
WHERE kind = 'outcome' AND finalized_at IS NULL AND delivery_abandoned_at IS NULL;
CREATE INDEX idx_slack_reconcile_tree ON slack_messages(id)
WHERE kind = 'tree' AND closed_at IS NULL;
