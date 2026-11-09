-- One json-render chat-catalog spec per task, joined at read time.
-- agent_tasks stays untouched (see 072_task_attachments.sql).
CREATE TABLE task_ui_specs (
  task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  spec_version INTEGER NOT NULL DEFAULT 1 CHECK (spec_version = 1),
  catalog TEXT NOT NULL DEFAULT 'chat' CHECK (catalog IN ('chat')),
  spec TEXT NOT NULL,
  actions TEXT,
  fallback_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

-- One run per (task, action). The row is reserved before the side effect.
CREATE TABLE task_ui_action_runs (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('slack', 'web')),
  slack_user_id TEXT,
  result_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (task_id, action_id)
);
