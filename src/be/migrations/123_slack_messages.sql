-- Durable provenance for every Slack message owned by the swarm.
--
-- The v2 renderer needs the timestamp of the one editable thread tree and of
-- each immutable streamed outcome card. Explicit agent-authored messages are
-- recorded too, so the source of every bot message can be distinguished.
CREATE TABLE slack_messages (
  id            TEXT PRIMARY KEY,
  context_key   TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  thread_ts     TEXT NOT NULL,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('tree', 'outcome', 'agent')),
  task_id       TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  permalink     TEXT,
  finalized_at  TEXT,
  stream_chunks_appended INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by    TEXT,
  updated_by    TEXT
);

CREATE UNIQUE INDEX idx_slack_messages_channel_ts
  ON slack_messages(channel_id, ts);
CREATE UNIQUE INDEX idx_slack_messages_tree_context
  ON slack_messages(context_key) WHERE kind = 'tree';
CREATE UNIQUE INDEX idx_slack_messages_tree_thread
  ON slack_messages(channel_id, thread_ts) WHERE kind = 'tree';
CREATE UNIQUE INDEX idx_slack_messages_outcome_task
  ON slack_messages(task_id) WHERE kind = 'outcome';
CREATE INDEX idx_slack_messages_thread
  ON slack_messages(channel_id, thread_ts, created_at);
