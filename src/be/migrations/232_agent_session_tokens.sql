PRAGMA defer_foreign_keys = ON;

-- Add agent-bound worker tokens: a fourth binding that names only the agent.
-- parentTokenId links a child task token to the agent token that minted it,
-- so revoking the agent token revokes its children.
CREATE TABLE session_tokens_new (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  tokenPreview TEXT NOT NULL,
  agentId TEXT NOT NULL,
  taskId TEXT,
  runtimeId TEXT,
  parentRuntimeId TEXT,
  controllerId TEXT,
  parentTokenId TEXT,
  expiresAt TEXT NOT NULL,
  revokedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUsedAt TEXT,
  CHECK (
    (taskId IS NOT NULL AND runtimeId IS NULL AND controllerId IS NULL
      AND (parentRuntimeId IS NULL OR parentTokenId IS NULL))
    OR (taskId IS NULL AND runtimeId IS NOT NULL AND parentRuntimeId IS NULL AND controllerId IS NULL AND parentTokenId IS NULL)
    OR (controllerId IS NOT NULL AND taskId IS NULL AND runtimeId IS NULL AND parentRuntimeId IS NULL AND parentTokenId IS NULL)
    OR (taskId IS NULL AND runtimeId IS NULL AND controllerId IS NULL AND parentRuntimeId IS NULL AND parentTokenId IS NULL)
  )
);

INSERT INTO session_tokens_new
  (id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId,
   expiresAt, revokedAt, createdAt, lastUsedAt)
SELECT id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId,
  expiresAt, revokedAt, createdAt, lastUsedAt
FROM session_tokens;

DROP TABLE session_tokens;
ALTER TABLE session_tokens_new RENAME TO session_tokens;
CREATE INDEX idx_session_tokens_agentId ON session_tokens(agentId);
CREATE INDEX idx_session_tokens_runtimeId ON session_tokens(runtimeId);
CREATE INDEX idx_session_tokens_parentRuntimeId ON session_tokens(parentRuntimeId);
CREATE INDEX idx_session_tokens_parentTokenId ON session_tokens(parentTokenId);
