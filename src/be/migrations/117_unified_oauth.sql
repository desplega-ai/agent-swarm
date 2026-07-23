-- Unify tracker/generic OAuth and MCP-DCR OAuth storage.
--
-- The migration runner disables foreign-key enforcement for the migration
-- pass, which lets these table-copy rebuilds keep their stable public names.

-- ---------------------------------------------------------------------------
-- OAuth applications
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_apps_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  provider TEXT NOT NULL,
  displayName TEXT,
  clientId TEXT NOT NULL,
  clientSecret TEXT,
  clientSecretEncrypted INTEGER NOT NULL DEFAULT 1 CHECK(clientSecretEncrypted IN (0, 1)),
  authorizeUrl TEXT NOT NULL,
  tokenUrl TEXT NOT NULL,
  revocationUrl TEXT,
  userinfoUrl TEXT,
  redirectUri TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  scopeSeparator TEXT NOT NULL DEFAULT ' ',
  tokenAuthStyle TEXT NOT NULL DEFAULT 'body' CHECK(tokenAuthStyle IN ('body', 'basic')),
  tokenBodyFormat TEXT NOT NULL DEFAULT 'form' CHECK(tokenBodyFormat IN ('form', 'json')),
  requiresRefreshTokenRotation INTEGER NOT NULL DEFAULT 0
    CHECK(requiresRefreshTokenRotation IN (0, 1)),
  extraParamsJson TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'dcr', 'curated-prefill')),
  mcpServerId TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
  metadata TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO oauth_apps_new (
  id, provider, clientId, clientSecret, clientSecretEncrypted,
  authorizeUrl, tokenUrl, revocationUrl, redirectUri, scopes,
  scopeSeparator, tokenAuthStyle, tokenBodyFormat,
  requiresRefreshTokenRotation, extraParamsJson, source, metadata,
  createdAt, updatedAt
)
SELECT
  id,
  provider,
  clientId,
  clientSecret,
  0,
  authorizeUrl,
  tokenUrl,
  CASE
    WHEN json_valid(metadata) AND json_type(metadata, '$.revocationUrl') = 'text'
      THEN json_extract(metadata, '$.revocationUrl')
    ELSE NULL
  END,
  redirectUri,
  CASE
    WHEN json_valid(scopes) AND json_type(scopes) = 'array' THEN scopes
    WHEN trim(scopes) = '' THEN '[]'
    ELSE '["' || replace(replace(trim(scopes), '\\', '\\\\'), ',', '","') || '"]'
  END,
  CASE WHEN provider = 'linear' THEN ',' ELSE ' ' END,
  CASE
    WHEN json_valid(metadata) AND json_extract(metadata, '$.tokenAuthStyle') = 'basic'
      THEN 'basic'
    ELSE 'body'
  END,
  CASE
    WHEN json_valid(metadata) AND json_extract(metadata, '$.tokenBodyFormat') = 'json'
      THEN 'json'
    ELSE 'form'
  END,
  CASE WHEN provider = 'jira' THEN 1 ELSE 0 END,
  CASE
    WHEN json_valid(metadata) AND json_type(metadata, '$.extraParams') = 'object'
      THEN json_extract(metadata, '$.extraParams')
    ELSE NULL
  END,
  'manual',
  CASE
    WHEN json_valid(metadata)
      THEN json_remove(metadata, '$.extraParams', '$.tokenAuthStyle', '$.tokenBodyFormat', '$.revocationUrl')
    ELSE '{}'
  END,
  createdAt,
  updatedAt
FROM oauth_apps;

-- Each legacy MCP token row owns one application row. `clientSource` has one
-- value (`preregistered`) that the unified source enum intentionally does not;
-- keep the exact legacy value in metadata so the adapter can round-trip it.
INSERT INTO oauth_apps_new (
  id, provider, displayName, clientId, clientSecret, clientSecretEncrypted,
  authorizeUrl, tokenUrl, revocationUrl, redirectUri, scopes,
  scopeSeparator, tokenAuthStyle, tokenBodyFormat,
  requiresRefreshTokenRotation, source, mcpServerId, metadata,
  createdAt, updatedAt
)
SELECT
  'mcp-app-' || id,
  'mcp-' || mcpServerId,
  NULL,
  COALESCE(dcrClientId, ''),
  dcrClientSecret,
  1,
  authorizeUrl,
  tokenUrl,
  revocationUrl,
  '',
  CASE
    WHEN scope IS NULL OR trim(scope) = '' THEN '[]'
    ELSE '["' || replace(replace(trim(scope), '\\', '\\\\'), ' ', '","') || '"]'
  END,
  ' ',
  'body',
  'form',
  0,
  'dcr',
  mcpServerId,
  json_object(
    'resourceUrl', resourceUrl,
    'authorizationServerIssuer', authorizationServerIssuer,
    'clientSource', clientSource
  ),
  createdAt,
  updatedAt
FROM mcp_oauth_tokens;

-- ---------------------------------------------------------------------------
-- OAuth authorizations
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_authorizations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  appId TEXT NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'default',
  userId TEXT REFERENCES users(id) ON DELETE SET NULL,
  accountEmail TEXT,
  identityJson TEXT,
  accessToken TEXT NOT NULL,
  refreshToken TEXT,
  tokenType TEXT NOT NULL DEFAULT 'Bearer',
  expiresAt TEXT,
  scope TEXT,
  tokensEncrypted INTEGER NOT NULL DEFAULT 1 CHECK(tokensEncrypted IN (0, 1)),
  tokenVersion INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'refresh-failed', 'expired', 'revoked')),
  lastErrorMessage TEXT,
  lastRefreshedAt TEXT,
  connectedByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(appId, label)
);

INSERT INTO oauth_authorizations (
  id, appId, label, accessToken, refreshToken, tokenType, expiresAt, scope,
  tokensEncrypted, tokenVersion, status, createdAt, updatedAt
)
SELECT
  t.id,
  a.id,
  'default',
  t.accessToken,
  t.refreshToken,
  'Bearer',
  t.expiresAt,
  t.scope,
  0,
  1,
  'active',
  t.createdAt,
  t.updatedAt
FROM oauth_tokens t
JOIN oauth_apps_new a ON a.provider = t.provider AND a.mcpServerId IS NULL;

INSERT INTO oauth_authorizations (
  id, appId, label, userId, accessToken, refreshToken, tokenType, expiresAt, scope,
  tokensEncrypted, tokenVersion, status, lastErrorMessage, lastRefreshedAt,
  connectedByUserId, createdAt, updatedAt
)
SELECT
  t.id,
  'mcp-app-' || t.id,
  'default',
  t.userId,
  t.accessToken,
  t.refreshToken,
  t.tokenType,
  t.expiresAt,
  t.scope,
  1,
  1,
  CASE t.status
    WHEN 'connected' THEN 'active'
    WHEN 'error' THEN 'refresh-failed'
    WHEN 'expired' THEN 'expired'
    WHEN 'revoked' THEN 'revoked'
  END,
  t.lastErrorMessage,
  t.lastRefreshedAt,
  t.connectedByUserId,
  t.createdAt,
  t.updatedAt
FROM mcp_oauth_tokens t;

CREATE INDEX idx_oauth_authorizations_app ON oauth_authorizations(appId);
CREATE INDEX idx_oauth_authorizations_user ON oauth_authorizations(userId);
CREATE INDEX idx_oauth_authorizations_expires ON oauth_authorizations(expiresAt);

-- ---------------------------------------------------------------------------
-- Persisted OAuth pending state
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_pending (
  state TEXT PRIMARY KEY,
  appId TEXT NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'default',
  flow TEXT NOT NULL CHECK(flow IN ('generic', 'tracker', 'mcp')),
  codeVerifier TEXT NOT NULL,
  nonce TEXT,
  redirectUri TEXT NOT NULL,
  finalRedirect TEXT,
  userId TEXT REFERENCES users(id) ON DELETE SET NULL,
  contextJson TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO oauth_pending (
  state, appId, label, flow, codeVerifier, nonce,
  redirectUri, finalRedirect, userId, contextJson, createdAt
)
SELECT
  p.state,
  (
    SELECT a.id
    FROM oauth_apps_new a
    WHERE a.id = 'mcp-app-' || (
      SELECT t.id
      FROM mcp_oauth_tokens t
      WHERE t.mcpServerId = p.mcpServerId AND t.userId IS p.userId
      ORDER BY t.createdAt ASC, t.id ASC
      LIMIT 1
    )
    ORDER BY a.createdAt ASC, a.id ASC
    LIMIT 1
  ),
  'default',
  'mcp',
  p.codeVerifier,
  p.nonce,
  p.redirectUri,
  p.finalRedirect,
  p.userId,
  json_object(
    'resourceUrl', p.resourceUrl,
    'authorizationServerIssuer', p.authorizationServerIssuer,
    'authorizeUrl', p.authorizeUrl,
    'tokenUrl', p.tokenUrl,
    'revocationUrl', p.revocationUrl,
    'scopes', p.scopes,
    'dcrClientId', p.dcrClientId,
    'dcrClientSecret', p.dcrClientSecret,
    'clientSource', CASE
      WHEN EXISTS (
        SELECT 1 FROM mcp_oauth_tokens t
        WHERE t.mcpServerId = p.mcpServerId AND t.clientSource = 'manual'
      ) THEN 'manual'
      WHEN p.dcrClientId IS NOT NULL THEN 'dcr'
      ELSE 'preregistered'
    END
  ),
  p.createdAt
FROM mcp_oauth_pending p
WHERE EXISTS (
  SELECT 1
  FROM mcp_oauth_tokens t
  WHERE t.mcpServerId = p.mcpServerId AND t.userId IS p.userId
);

CREATE INDEX idx_oauth_pending_createdAt ON oauth_pending(createdAt);

-- ---------------------------------------------------------------------------
-- Generic refresh locks
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_refresh_locks_new (
  lockKey TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO oauth_refresh_locks_new (lockKey, owner, expiresAt, createdAt, updatedAt)
SELECT provider, owner, expiresAt, createdAt, updatedAt FROM oauth_refresh_locks;

DROP TABLE oauth_refresh_locks;
ALTER TABLE oauth_refresh_locks_new RENAME TO oauth_refresh_locks;

-- ---------------------------------------------------------------------------
-- Credential bindings now target an authorization, not a provider string.
-- ---------------------------------------------------------------------------

CREATE TABLE script_credential_bindings_new (
  id TEXT PRIMARY KEY,
  config_key TEXT NOT NULL,
  allowed_hosts_json TEXT NOT NULL DEFAULT '[]',
  header_template TEXT,
  query_template TEXT,
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'agent', 'repo')),
  scope_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default', 'user', 'migration')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  auth_kind TEXT NOT NULL DEFAULT 'config' CHECK(auth_kind IN ('config', 'oauth')),
  oauth_authorization_id TEXT REFERENCES oauth_authorizations(id) ON DELETE SET NULL,
  CHECK(scope = 'global' OR scope_id IS NOT NULL),
  CHECK(header_template IS NOT NULL OR query_template IS NOT NULL)
);

INSERT INTO script_credential_bindings_new (
  id, config_key, allowed_hosts_json, header_template, query_template,
  scope, scope_id, active, source, created_at, updated_at,
  created_by, updated_by, auth_kind, oauth_authorization_id
)
SELECT
  b.id,
  b.config_key,
  b.allowed_hosts_json,
  b.header_template,
  b.query_template,
  b.scope,
  b.scope_id,
  b.active,
  b.source,
  b.created_at,
  b.updated_at,
  b.created_by,
  b.updated_by,
  b.auth_kind,
  CASE
    WHEN b.auth_kind = 'oauth' THEN (
      SELECT z.id
      FROM oauth_authorizations z
      JOIN oauth_apps_new a ON a.id = z.appId
      WHERE a.provider = b.oauth_provider
        AND a.mcpServerId IS NULL
        AND z.label = 'default'
      ORDER BY a.createdAt ASC, a.id ASC
      LIMIT 1
    )
    ELSE NULL
  END
FROM script_credential_bindings b;

DROP TABLE script_credential_bindings;
ALTER TABLE script_credential_bindings_new RENAME TO script_credential_bindings;

CREATE UNIQUE INDEX idx_script_credential_bindings_identity
  ON script_credential_bindings(
    config_key,
    scope,
    COALESCE(scope_id, ''),
    COALESCE(header_template, ''),
    COALESCE(query_template, '')
  );
CREATE INDEX idx_script_credential_bindings_oauth_authorization
  ON script_credential_bindings(oauth_authorization_id);

-- ---------------------------------------------------------------------------
-- Retire legacy tables and make the rebuilt app table canonical.
-- ---------------------------------------------------------------------------

DROP TABLE oauth_tokens;
DROP TABLE mcp_oauth_pending;
DROP TABLE mcp_oauth_tokens;
DROP TABLE oauth_apps;
ALTER TABLE oauth_apps_new RENAME TO oauth_apps;

CREATE INDEX idx_oauth_apps_provider ON oauth_apps(provider);
CREATE INDEX idx_oauth_apps_mcp_server ON oauth_apps(mcpServerId);
