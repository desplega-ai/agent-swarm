-- Task steering messages move through pending -> delivered -> handled, or are
-- promoted to a follow-up task / cancelled before delivery.
-- mode, status, and created_by_kind keep SQL CHECK constraints in sync with
-- their Zod enums; source is intentionally Zod-only (see migration 056).
CREATE TABLE task_steering_messages (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  body                TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('steer','queue')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','delivered','handled','promoted','cancelled')),
  delivered_mode      TEXT CHECK (delivered_mode IN ('steer','queue')),
  source              TEXT NOT NULL,
  created_by_kind     TEXT NOT NULL CHECK (created_by_kind IN ('user','agent','system')),
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent_id TEXT,
  promoted_task_id    TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at        TEXT,
  handled_at          TEXT
);
CREATE INDEX idx_task_steering_messages_task ON task_steering_messages(task_id);
CREATE INDEX idx_task_steering_messages_pending
  ON task_steering_messages(task_id, status) WHERE status = 'pending';
