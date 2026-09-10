-- Session-scoped ephemeral bearer tokens (prefix: aseph_) minted per ACP
-- provider session. The ACP adapter hands this token to the target process
-- in the swarm MCP server's Authorization header instead of the full operator
-- key. The token is revoked when the session ends (finish / abort) and also
-- carries an expiresAt ceiling so a leaked bearer cannot be used indefinitely.
--
-- Schema mirrors user_tokens but is separate so the two lifecycles cannot
-- interfere: user tokens are long-lived and manually revoked; session tokens
-- are programmatically minted and revoked, and always carry expiresAt.

CREATE TABLE IF NOT EXISTS session_tokens (
  id           TEXT PRIMARY KEY,
  tokenHash    TEXT NOT NULL UNIQUE,
  tokenPreview TEXT NOT NULL,
  agentId      TEXT NOT NULL,
  taskId       TEXT NOT NULL,
  expiresAt    TEXT NOT NULL,
  revokedAt    TEXT,
  createdAt    TEXT NOT NULL DEFAULT (datetime('now')),
  lastUsedAt   TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_tokens_agentId
  ON session_tokens(agentId);
