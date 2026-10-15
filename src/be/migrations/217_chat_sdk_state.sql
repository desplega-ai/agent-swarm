-- Chat SDK (chat-sdk.dev) channel: StateAdapter tables + durable outbound relay.
--
-- The five chat_* state tables back `SqliteChatState` (src/integrations/chat-sdk/state.ts).
-- Keys and thread ids written by the SDK already carry the adapter prefix
-- (`telegram:...`, `slack:...`), so no adapter column is needed.
-- Expiry columns are epoch milliseconds; NULL means no expiry.

CREATE TABLE chat_state_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);

CREATE TABLE chat_subscriptions (
  thread_id  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE chat_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_lists (
  key        TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, seq)
);

CREATE TABLE chat_queue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  entry     TEXT NOT NULL
);

CREATE INDEX idx_chat_queue_thread ON chat_queue(thread_id, id);

-- Persist the obligation to publish a terminal result for every Chat SDK-rooted
-- task. Mirrors 144_slack_relay_obligations.sql, plus an attempt cap: a poison
-- row is marked given up (with the reason) instead of retrying forever.
CREATE TABLE chat_relay_obligations (
  task_id         TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  delivered_at    TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  given_up_at     TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by      TEXT,
  updated_by      TEXT
);

CREATE INDEX idx_chat_relay_obligations_pending
  ON chat_relay_obligations(last_attempt_at, created_at)
  WHERE delivered_at IS NULL AND given_up_at IS NULL;

-- Lead follow-ups (`source='system'`, `taskType='follow-up'`) inherit the chat
-- contextKey and carry the lead's final answer, so they relay too. A resume
-- (`source='system'`, `taskType='resume'`, from `createResumeFollowUp` after a
-- graceful shutdown or crash recovery) inherits the contextKey too. It relays
-- only when a lead owns it: a worker task (resumed or not) reports back through
-- a lead follow-up, and the lead never gets one for its own tasks. Other system
-- tasks that inherit the key stay silent. GLOB, not LIKE: LIKE is
-- case-insensitive in SQLite.
CREATE TRIGGER enqueue_chat_relay_after_terminal_update
AFTER UPDATE OF status ON agent_tasks
WHEN OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.contextKey GLOB 'task:chat-sdk:*'
  AND (
    NEW.source = 'chat'
    OR (NEW.source = 'system' AND NEW.taskType = 'follow-up')
    OR (
      NEW.source = 'system'
      AND NEW.taskType = 'resume'
      AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW.agentId AND agents.isLead = 1)
    )
  )
BEGIN
  INSERT OR IGNORE INTO chat_relay_obligations (task_id)
  VALUES (NEW.id);
END;

CREATE TRIGGER enqueue_chat_relay_after_terminal_insert
AFTER INSERT ON agent_tasks
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.contextKey GLOB 'task:chat-sdk:*'
  AND (
    NEW.source = 'chat'
    OR (NEW.source = 'system' AND NEW.taskType = 'follow-up')
    OR (
      NEW.source = 'system'
      AND NEW.taskType = 'resume'
      AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW.agentId AND agents.isLead = 1)
    )
  )
BEGIN
  INSERT OR IGNORE INTO chat_relay_obligations (task_id)
  VALUES (NEW.id);
END;
