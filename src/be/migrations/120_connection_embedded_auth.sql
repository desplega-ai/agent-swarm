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
  -- Adopt a binding as managed only when a single connection references it, so
  -- the 1:1 managed relationship (and its CASCADE delete) is unambiguous.
  (
    SELECT c.id
    FROM script_connections c
    WHERE c.credential_binding_id = b.id
      AND (SELECT COUNT(*) FROM script_connections c2 WHERE c2.credential_binding_id = b.id) = 1
  )
FROM script_credential_bindings b;

DROP TABLE script_credential_bindings;
ALTER TABLE script_credential_bindings_new RENAME TO script_credential_bindings;

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
