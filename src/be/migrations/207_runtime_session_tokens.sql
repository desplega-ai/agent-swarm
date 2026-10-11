-- Keep ACP tokens and add runtime and controller bindings.
CREATE TABLE session_tokens_new (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  tokenPreview TEXT NOT NULL,
  agentId TEXT NOT NULL,
  taskId TEXT,
  runtimeId TEXT,
  parentRuntimeId TEXT,
  controllerId TEXT,
  expiresAt TEXT NOT NULL,
  revokedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUsedAt TEXT,
  CHECK (
    (taskId IS NOT NULL AND runtimeId IS NULL AND controllerId IS NULL)
    OR (taskId IS NULL AND runtimeId IS NOT NULL AND parentRuntimeId IS NULL AND controllerId IS NULL)
    OR (controllerId IS NOT NULL AND taskId IS NULL AND runtimeId IS NULL AND parentRuntimeId IS NULL)
  )
);

INSERT INTO session_tokens_new
  (id, tokenHash, tokenPreview, agentId, taskId, expiresAt, revokedAt, createdAt, lastUsedAt)
SELECT id, tokenHash, tokenPreview, agentId, taskId, expiresAt, revokedAt, createdAt, lastUsedAt
FROM session_tokens;

DROP TABLE session_tokens;
ALTER TABLE session_tokens_new RENAME TO session_tokens;
CREATE INDEX idx_session_tokens_agentId ON session_tokens(agentId);
CREATE INDEX idx_session_tokens_runtimeId ON session_tokens(runtimeId);
CREATE INDEX idx_session_tokens_parentRuntimeId ON session_tokens(parentRuntimeId);
