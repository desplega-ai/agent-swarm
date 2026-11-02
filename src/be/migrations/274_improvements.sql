-- Product improvements an install sends to desplega. An agent may only draft
-- one (pending_approval); a person approves it, and approved_by records that
-- person from the credential (a user id or 'operator'). Only text, email and
-- the install id ever leave the install.
CREATE TABLE improvements (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending_approval', 'sending', 'sent', 'failed', 'discarded')),
  source TEXT NOT NULL CHECK (source IN ('mcp', 'api', 'ui')),
  -- Local only, never sent.
  requested_by_agent_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  proxy_status INTEGER,
  proxy_id TEXT,
  proxy_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (status NOT IN ('sending', 'sent') OR approved_by IS NOT NULL)
);

CREATE INDEX idx_improvements_status_created ON improvements(status, created_at);
