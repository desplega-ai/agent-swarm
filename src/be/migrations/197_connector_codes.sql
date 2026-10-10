-- Single-use connect codes for the agent-swarm.dev ChatGPT connector.
--
-- `POST /api/users/:id/connector-codes` stores a code here. The connector
-- trades it once at `POST /api/connector/exchange` for a freshly minted
-- `aswt_` token (src/be/connector-codes.ts). The plaintext code is never
-- stored. The heartbeat cleanup sweep deletes rows 1h after they expire.

CREATE TABLE IF NOT EXISTS connector_codes (
  -- sha256 hex of the plaintext code.
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  -- IdentityActor that created the code. The token minted at exchange time
  -- is attributed to this actor in user_identity_events.
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_codes_expires_at
  ON connector_codes(expires_at);
