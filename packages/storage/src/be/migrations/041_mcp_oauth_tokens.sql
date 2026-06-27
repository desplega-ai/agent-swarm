-- OAuth tokens scoped per MCP server installation.
--
-- Distinct from oauth_tokens (009_tracker_integration.sql) which is keyed by a
-- single global `provider` string (one Linear per swarm, etc.). MCP tokens need
-- one row per mcp_servers.id.
--
-- Encryption: accessToken, refreshToken, dcrClientSecret are stored as
-- base64(iv || ciphertext || authTag) AES-256-GCM using SECRETS_ENCRYPTION_KEY
-- (same helper as swarm_config, migration 038). Never written plaintext.
--
-- v1 is per-swarm (userId IS NULL). The UNIQUE(mcpServerId, userId) constraint
-- already admits a future per-user extension without a schema change.

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,

    -- Token material (AES-256-GCM, base64-encoded; never plaintext)
    accessToken TEXT NOT NULL,
    refreshToken TEXT,
    tokenType TEXT NOT NULL DEFAULT 'Bearer',
    expiresAt TEXT,
    scope TEXT,

    -- Authorization server context (discovered via PRMD/AS metadata at connect time)
    resourceUrl TEXT NOT NULL,
    authorizationServerIssuer TEXT NOT NULL,
    authorizeUrl TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    revocationUrl TEXT,

    -- Client credentials (either RFC 7591 DCR result or user-supplied)
    dcrClientId TEXT,
    dcrClientSecret TEXT,
    clientSource TEXT NOT NULL CHECK(clientSource IN ('dcr','manual','preregistered')),

    -- Connection state surfaced to the UI
    status TEXT NOT NULL CHECK(status IN ('connected','expired','error','revoked')) DEFAULT 'connected',
    lastErrorMessage TEXT,
    lastRefreshedAt TEXT,

    -- Audit
    connectedByUserId TEXT REFERENCES users(id),
    createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    UNIQUE(mcpServerId, userId)
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_mcp ON mcp_oauth_tokens(mcpServerId);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user ON mcp_oauth_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires ON mcp_oauth_tokens(expiresAt);

-- Pending OAuth sessions (state -> PKCE verifier + mcpServerId) for the short
-- window between /authorize and /callback. Rows older than 10 minutes are GC'd
-- by a timer in the HTTP boot path.
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
    state TEXT PRIMARY KEY,
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id),
    codeVerifier TEXT NOT NULL,
    nonce TEXT,
    resourceUrl TEXT NOT NULL,
    authorizationServerIssuer TEXT NOT NULL,
    authorizeUrl TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    revocationUrl TEXT,
    scopes TEXT,
    dcrClientId TEXT,
    dcrClientSecret TEXT,
    redirectUri TEXT NOT NULL,
    finalRedirect TEXT,
    createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_createdAt ON mcp_oauth_pending(createdAt);

-- Extend mcp_servers with an authMethod discriminator. Pre-existing rows default
-- to 'static' (today's behaviour). 'oauth' tells resolveSecrets to inject a
-- Bearer token from mcp_oauth_tokens instead of swarm_config headers. 'auto'
-- lets the API probe the MCP on save and flip to 'oauth' if required.
ALTER TABLE mcp_servers ADD COLUMN authMethod TEXT NOT NULL DEFAULT 'static'
    CHECK(authMethod IN ('static','oauth','auto'));
