-- SQL script connections (kind = 'sql').
--
-- A sql connection stores no HTTP auth (auth_type stays 'none'); its
-- auth_config_key holds the swarm_config key of the encrypted Postgres DSN,
-- resolved only on the API server. SQLite cannot alter a CHECK constraint, so
-- the table is rebuilt with the full current column set (117 rebuild + the
-- embedded auth columns). No new columns.
--
-- The migration runner disables foreign-key enforcement for the pass, so the
-- DROP does not cascade into script_credential_bindings.managed_by_connection_id
-- and the RENAME keeps the stable name that FK points to (same as 117).

DROP TABLE IF EXISTS script_connections_new;

CREATE TABLE script_connections_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('raw', 'openapi', 'mcp', 'graphql', 'sql')),
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
  auth_type TEXT NOT NULL DEFAULT 'none'
    CHECK(auth_type IN ('none', 'bearer', 'header', 'query', 'oauth')),
  auth_config_key TEXT,
  auth_authorization_id TEXT REFERENCES oauth_authorizations(id) ON DELETE SET NULL,
  auth_param_name TEXT,
  auth_template_override TEXT,
  auth_hosts_override_json TEXT,
  CHECK(scope = 'global' OR scope_id IS NOT NULL),
  CHECK(kind != 'openapi' OR openapi_spec_json IS NOT NULL),
  CHECK(kind != 'mcp' OR mcp_server_id IS NOT NULL),
  CHECK(kind != 'sql' OR auth_config_key IS NOT NULL)
);

INSERT INTO script_connections_new (
  id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
  credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
  openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
  generated_runtime_json, generated_at, generation_error, enabled, version, created_at,
  updated_at, created_by, updated_by, auth_type, auth_config_key, auth_authorization_id,
  auth_param_name, auth_template_override, auth_hosts_override_json
)
SELECT
  id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
  credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
  openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
  generated_runtime_json, generated_at, generation_error, enabled, version, created_at,
  updated_at, created_by, updated_by, auth_type, auth_config_key, auth_authorization_id,
  auth_param_name, auth_template_override, auth_hosts_override_json
FROM script_connections;

DROP TABLE script_connections;
ALTER TABLE script_connections_new RENAME TO script_connections;

CREATE UNIQUE INDEX IF NOT EXISTS idx_script_connections_slug_scope
  ON script_connections(slug, scope, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_script_connections_kind_enabled
  ON script_connections(kind, enabled);
