-- Persist the lifecycle of every bot acceptance reaction on an exact Slack
-- message. Groups are opened before the reaction is added and sealed only
-- after every attributable task/steering message is linked, preventing an
-- outcome watcher from finalizing a partially-populated fan-out.
CREATE TABLE slack_reaction_groups (
  channel_id          TEXT NOT NULL,
  message_ts          TEXT NOT NULL,
  acceptance_reaction TEXT NOT NULL
                       CHECK (acceptance_reaction IN ('eyes','heavy_plus_sign','zap')),
  sealed_at           TEXT,
  abandon_after       TEXT NOT NULL,
  forced_failure      INTEGER NOT NULL DEFAULT 0 CHECK (forced_failure IN (0, 1)),
  finalized_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel_id, message_ts)
);

-- SET NULL preserves a tombstone when a task is deleted so the Slack message
-- can still be resolved to a failure instead of retaining its acceptance emoji.
CREATE TABLE slack_reaction_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  task_id    TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (channel_id, message_ts)
    REFERENCES slack_reaction_groups(channel_id, message_ts) ON DELETE CASCADE,
  UNIQUE (channel_id, message_ts, task_id)
);

-- Steering is resolved dynamically: handled/delivered messages follow their
-- original task, while promoted messages follow promoted_task_id. This covers
-- both immediate provider fallback and promotion during a terminal sweep.
CREATE TABLE slack_reaction_steering (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id          TEXT NOT NULL,
  message_ts          TEXT NOT NULL,
  steering_message_id TEXT REFERENCES task_steering_messages(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (channel_id, message_ts)
    REFERENCES slack_reaction_groups(channel_id, message_ts) ON DELETE CASCADE,
  UNIQUE (channel_id, message_ts, steering_message_id)
);

CREATE INDEX idx_slack_reaction_groups_pending
  ON slack_reaction_groups(finalized_at, sealed_at, abandon_after);
CREATE INDEX idx_slack_reaction_tasks_group
  ON slack_reaction_tasks(channel_id, message_ts);
CREATE INDEX idx_slack_reaction_tasks_task
  ON slack_reaction_tasks(task_id);
CREATE INDEX idx_slack_reaction_steering_group
  ON slack_reaction_steering(channel_id, message_ts);
CREATE INDEX idx_slack_reaction_steering_message
  ON slack_reaction_steering(steering_message_id);
