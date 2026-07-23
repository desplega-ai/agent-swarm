-- Consolidate the full connections-redesign schema: unified OAuth, base URL
-- provenance, vendored spec source, embedded connection auth, and the OAuth
-- keepalive flag.
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

-- Legacy `mcp_oauth_pending` rows are intentionally NOT carried over: pending
-- PKCE state has a 10-minute TTL, so anything mid-flight at upgrade time is
-- effectively expired by the time the server is back up — the user simply
-- re-runs the consent. Dropping the carryover avoids fragile app-id
-- correlation against half-migrated tables for zero practical benefit.

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

-- ---------------------------------------------------------------------------
-- Base URL provenance
-- ---------------------------------------------------------------------------

ALTER TABLE script_connections
  ADD COLUMN base_url_source TEXT NOT NULL DEFAULT 'user'
  CHECK(base_url_source IN ('user', 'spec'));

-- ---------------------------------------------------------------------------
-- Vendored OpenAPI spec source
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS script_connections_new;

CREATE TABLE script_connections_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('raw', 'openapi', 'mcp', 'graphql')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'agent', 'repo')),
  scope_id TEXT,
  base_url TEXT,
  base_url_source TEXT NOT NULL DEFAULT 'user' CHECK(base_url_source IN ('user', 'spec')),
  allowed_hosts_json TEXT NOT NULL DEFAULT '[]',
  credential_binding_id TEXT REFERENCES script_credential_bindings(id) ON DELETE SET NULL,
  openapi_spec_source_kind TEXT CHECK(openapi_spec_source_kind IN ('url', 'inline', 'agent_fs', 'vendored')),
  openapi_spec_source TEXT,
  openapi_spec_json TEXT,
  openapi_spec_etag TEXT,
  openapi_spec_fetched_at TEXT,
  mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE SET NULL,
  generated_types TEXT,
  generated_runtime_json TEXT,
  generated_at TEXT,
  generation_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  CHECK(scope = 'global' OR scope_id IS NOT NULL),
  CHECK(kind != 'openapi' OR openapi_spec_json IS NOT NULL),
  CHECK(kind != 'mcp' OR mcp_server_id IS NOT NULL)
);

INSERT INTO script_connections_new (
  id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
  credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
  openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
  generated_runtime_json, generated_at, generation_error, enabled, version, created_at,
  updated_at, created_by, updated_by
)
SELECT
  id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
  credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
  openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
  generated_runtime_json, generated_at, generation_error, enabled, version, created_at,
  updated_at, created_by, updated_by
FROM script_connections;

DROP TABLE script_connections;
ALTER TABLE script_connections_new RENAME TO script_connections;

CREATE UNIQUE INDEX IF NOT EXISTS idx_script_connections_slug_scope
  ON script_connections(slug, scope, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_script_connections_kind_enabled
  ON script_connections(kind, enabled);

-- Embedded connection auth + managed credential bindings.
--
-- Connections now carry their auth intent inline (auth_type + derived key /
-- authorization / param name / overrides). The credential binding that backs a
-- connection is auto-managed: it is tagged with managed_by_connection_id, hidden
-- from the standalone binding surface, and re-derived on every connection
-- upsert. The standalone binding surface survives only for spec-less raw
-- fetch() egress.
--
-- The migration runner disables foreign-key enforcement for the migration pass,
-- which lets the table-copy rebuild keep its stable public name even though it
-- participates in a reference cycle with script_connections.

-- ---------------------------------------------------------------------------
-- script_connections: embedded auth columns
-- ---------------------------------------------------------------------------

ALTER TABLE script_connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'
  CHECK(auth_type IN ('none', 'bearer', 'header', 'query', 'oauth'));
ALTER TABLE script_connections ADD COLUMN auth_config_key TEXT;
ALTER TABLE script_connections ADD COLUMN auth_authorization_id TEXT
  REFERENCES oauth_authorizations(id) ON DELETE SET NULL;
ALTER TABLE script_connections ADD COLUMN auth_param_name TEXT;
ALTER TABLE script_connections ADD COLUMN auth_template_override TEXT;
ALTER TABLE script_connections ADD COLUMN auth_hosts_override_json TEXT;

-- ---------------------------------------------------------------------------
-- script_credential_bindings: add managed_by_connection_id + 'connection' source
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
  source TEXT NOT NULL DEFAULT 'user'
    CHECK(source IN ('default', 'user', 'migration', 'connection')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  auth_kind TEXT NOT NULL DEFAULT 'config' CHECK(auth_kind IN ('config', 'oauth')),
  oauth_authorization_id TEXT REFERENCES oauth_authorizations(id) ON DELETE SET NULL,
  managed_by_connection_id TEXT REFERENCES script_connections(id) ON DELETE CASCADE,
  CHECK(scope = 'global' OR scope_id IS NOT NULL),
  CHECK(header_template IS NOT NULL OR query_template IS NOT NULL)
);

INSERT INTO script_credential_bindings_new (
  id, config_key, allowed_hosts_json, header_template, query_template,
  scope, scope_id, active, source, created_at, updated_at,
  created_by, updated_by, auth_kind, oauth_authorization_id, managed_by_connection_id
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
  b.oauth_authorization_id,
  -- Adopt a binding as managed only when a SINGLE connection references it AND
  -- its config_key matches that connection's auto-derived pattern
  -- (`connection.<slug>.secret` / `.oauth`). Pre-migration inline bindings and
  -- user-attached standalone bindings are indistinguishable by source (both
  -- default to 'user') and both can end up referenced by exactly one connection,
  -- so the COUNT=1 test alone would wrongly reclassify an explicitly-attached
  -- (possibly shared) binding as managed — hiding it and arming its CASCADE
  -- delete. Restricting to the derived key pattern is the only signal that
  -- reliably marks an auto-created binding; anything else stays standalone
  -- (visible + never CASCADE-deleted). It stays fully functional either way.
  (
    SELECT c.id
    FROM script_connections c
    WHERE c.credential_binding_id = b.id
      AND (SELECT COUNT(*) FROM script_connections c2 WHERE c2.credential_binding_id = b.id) = 1
      AND b.config_key IN (
        'connection.' || c.slug || '.secret',
        'connection.' || c.slug || '.oauth'
      )
  )
FROM script_credential_bindings b;

DROP TABLE script_credential_bindings;
ALTER TABLE script_credential_bindings_new RENAME TO script_credential_bindings;

-- Adopted (managed) rows carry a 'connection' source for consistency with the
-- bindings minted by upsertScriptConnection. Behavior keys off
-- managed_by_connection_id, not source, so this is a pure correctness fix.
UPDATE script_credential_bindings
SET source = 'connection'
WHERE managed_by_connection_id IS NOT NULL;

-- Standalone bindings keep identity-based idempotent upsert; managed bindings
-- are keyed by their owning connection, so exempt them from the identity index.
CREATE UNIQUE INDEX idx_script_credential_bindings_identity
  ON script_credential_bindings(
    config_key,
    scope,
    COALESCE(scope_id, ''),
    COALESCE(header_template, ''),
    COALESCE(query_template, '')
  )
  WHERE managed_by_connection_id IS NULL;
CREATE INDEX idx_script_credential_bindings_oauth_authorization
  ON script_credential_bindings(oauth_authorization_id);
CREATE INDEX idx_script_credential_bindings_managed
  ON script_credential_bindings(managed_by_connection_id);

-- ---------------------------------------------------------------------------
-- Backfill embedded auth on connections from their (now managed) binding.
-- ---------------------------------------------------------------------------

UPDATE script_connections
SET
  auth_type = COALESCE(
    (
      SELECT CASE
        WHEN b.auth_kind = 'oauth' THEN 'oauth'
        WHEN b.header_template LIKE 'Authorization: Bearer %' THEN 'bearer'
        WHEN b.header_template IS NOT NULL THEN 'header'
        WHEN b.query_template IS NOT NULL THEN 'query'
        ELSE 'none'
      END
      FROM script_credential_bindings b
      WHERE b.managed_by_connection_id = script_connections.id
    ),
    'none'
  ),
  auth_config_key = (
    SELECT b.config_key
    FROM script_credential_bindings b
    WHERE b.managed_by_connection_id = script_connections.id
  ),
  auth_authorization_id = (
    SELECT b.oauth_authorization_id
    FROM script_credential_bindings b
    WHERE b.managed_by_connection_id = script_connections.id
  ),
  auth_param_name = (
    SELECT CASE
      WHEN b.auth_kind != 'oauth'
           AND b.header_template IS NOT NULL
           AND b.header_template NOT LIKE 'Authorization: Bearer %'
           AND instr(b.header_template, ':') > 0
        THEN substr(b.header_template, 1, instr(b.header_template, ':') - 1)
      WHEN b.auth_kind != 'oauth'
           AND b.header_template IS NULL
           AND b.query_template IS NOT NULL
           AND instr(b.query_template, '=') > 0
        THEN substr(b.query_template, 1, instr(b.query_template, '=') - 1)
      ELSE NULL
    END
    FROM script_credential_bindings b
    WHERE b.managed_by_connection_id = script_connections.id
  ),
  auth_template_override = (
    SELECT CASE
      -- Preserve exact non-standard templates so a later re-derivation is
      -- byte-identical. Standard bearer templates re-derive on their own.
      WHEN b.header_template IS NOT NULL AND b.header_template NOT LIKE 'Authorization: Bearer %'
        THEN b.header_template
      WHEN b.header_template IS NULL AND b.query_template IS NOT NULL
        THEN b.query_template
      ELSE NULL
    END
    FROM script_credential_bindings b
    WHERE b.managed_by_connection_id = script_connections.id
  ),
  auth_hosts_override_json = (
    -- Pin the migrated allowlist so refreshes never widen it implicitly.
    SELECT b.allowed_hosts_json
    FROM script_credential_bindings b
    WHERE b.managed_by_connection_id = script_connections.id
  )
WHERE EXISTS (
  SELECT 1
  FROM script_credential_bindings b
  WHERE b.managed_by_connection_id = script_connections.id
);

-- Keep-alive opt-in for the generalized OAuth keepalive job.
--
-- The keepalive job (src/oauth/keepalive.ts) no longer hardcodes
-- ["linear","jira"]; it selects active authorizations whose app either rotates
-- refresh tokens (requiresRefreshTokenRotation=1) or opts in via a `keepAlive`
-- metadata flag. Jira already qualifies via rotation; backfill the flag on the
-- migrated tracker rows so Linear (and any future keep-warm provider) qualifies
-- automatically without reintroducing a provider allowlist.
--
-- Data-only: no schema change. json('true') stores a JSON boolean so
-- json_extract(metadata, '$.keepAlive') reads back as 1.

UPDATE oauth_apps
SET metadata = CASE
  WHEN json_valid(metadata) = 1 THEN json_set(metadata, '$.keepAlive', json('true'))
  ELSE json_object('keepAlive', json('true'))
END
WHERE provider IN ('linear', 'jira') AND mcpServerId IS NULL;
