-- Webhook subscriptions for MCP Events on the user MCP (/mcp-user).
--
-- MCP Events (SEP-3415 draft, extension `io.modelcontextprotocol/events`) lets
-- a client call `events/subscribe` with a callback URL and a client-supplied
-- `whsec_` signing secret. The server then POSTs a signed Standard Webhooks
-- delivery to that URL when a matching event happens. v1 offers
-- `task.completed` and `task.failed` for tasks the subscribing user requested.
--
-- The subscription key is (userId, url, eventName, argumentsJson). `id` is a
-- deterministic hash of that key (`sub_<hex>`), so the primary key also makes
-- subscribe an idempotent upsert. argumentsJson is canonical JSON (sorted
-- keys), so key order never creates a second row.
--
-- secretSealed holds the signing secret sealed with the swarm encryption key
-- (src/be/crypto). previousSecretSealed / previousSecretUntil keep the old
-- secret for a short dual-signing window after a client rotates it.
--
-- verifiedAt records the endpoint verification challenge that let this row be
-- written. A row exists only after verification succeeded, and a subscribe to
-- the same (userId, url) inside the verification window skips the challenge.
--
-- tokenId is the aswt_ token whose session subscribed. Delivery checks it is
-- still unrevoked, so revoking a connection stops its events at once.
--
-- expiresAt is the granted lease (refreshBefore). Expired rows are never
-- delivered to and are deleted lazily.

CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokenId TEXT NOT NULL REFERENCES user_tokens(id) ON DELETE CASCADE,
  eventName TEXT NOT NULL,
  argumentsJson TEXT NOT NULL,
  url TEXT NOT NULL,
  secretSealed TEXT NOT NULL,
  previousSecretSealed TEXT,
  previousSecretUntil TEXT,
  verifiedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  lastDeliveryAt TEXT,
  -- One of the SEP-3415 lastError categories, never a raw endpoint response.
  lastError TEXT,
  failedSince TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_user_event
  ON mcp_event_subscriptions(userId, eventName, expiresAt);
CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_expires
  ON mcp_event_subscriptions(expiresAt);
CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_created_by
  ON mcp_event_subscriptions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_updated_by
  ON mcp_event_subscriptions(updated_by) WHERE updated_by IS NOT NULL;
