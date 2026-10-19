-- Session sharing. A session is a root task (parentTaskId IS NULL) plus its
-- descendants. A root with no active row stays private to its owner
-- (agent_tasks.requestedByUserId); a root with no owner stays open to all.
--
-- Rows are never deleted: revoking sets revokedAt/revokedBy, and an access
-- change revokes the active row and inserts a new one in one transaction, so
-- every row for a root is its share history. userId NULL means everyone.
CREATE TABLE session_shares (
  id TEXT PRIMARY KEY,
  rootTaskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  userId TEXT REFERENCES users(id),
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  createdAt TEXT NOT NULL,
  revokedAt TEXT,
  revokedBy TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

-- At most one active row per (root, target); revoked rows pile up beside it.
CREATE UNIQUE INDEX session_shares_active
  ON session_shares(rootTaskId, COALESCE(userId, '*')) WHERE revokedAt IS NULL;
CREATE INDEX session_shares_user ON session_shares(userId) WHERE revokedAt IS NULL;
