CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('swarm', 'user')),
  userId TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'tool', 'use_case', 'custom')),
  label TEXT NOT NULL,
  href TEXT,
  meta TEXT,
  sortOrder INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'removed')),
  statusChangedAt TEXT,
  statusChangedBy TEXT,
  statusReason TEXT,
  nudgedAt TEXT,
  nudgedTaskId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  CHECK ((scope = 'swarm' AND userId IS NULL) OR (scope = 'user' AND userId IS NOT NULL))
);

CREATE INDEX idx_checklist_scope_user_status ON checklist_items(scope, userId, status);
