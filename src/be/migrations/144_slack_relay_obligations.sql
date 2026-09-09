-- Persist the obligation to publish a terminal result for every Slack-rooted task.
--
-- Existing terminal tasks are intentionally not backfilled: the legacy watcher did
-- not record successful delivery, so replaying them would duplicate old replies.
-- Delivery is at-least-once for tasks that have no persisted Slack message to update:
-- Slack does not offer an atomic send-and-local-ack operation, so a crash in that
-- narrow gap can duplicate a post. Tracked progress messages retry via chat.update.
CREATE TABLE slack_relay_obligations (
  task_id       TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  delivered_at  TEXT,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by    TEXT,
  updated_by    TEXT
);

CREATE INDEX idx_slack_relay_obligations_pending
  ON slack_relay_obligations(last_attempt_at, created_at)
  WHERE delivered_at IS NULL;

CREATE TRIGGER enqueue_slack_relay_after_terminal_update
AFTER UPDATE OF status ON agent_tasks
WHEN OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.source = 'slack'
  AND NEW.slackChannelId IS NOT NULL
  AND NEW.slackThreadTs IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO slack_relay_obligations (task_id)
  VALUES (NEW.id);
END;

CREATE TRIGGER enqueue_slack_relay_after_terminal_insert
AFTER INSERT ON agent_tasks
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.source = 'slack'
  AND NEW.slackChannelId IS NOT NULL
  AND NEW.slackThreadTs IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO slack_relay_obligations (task_id)
  VALUES (NEW.id);
END;
