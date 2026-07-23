DROP TABLE IF EXISTS script_connections_new;

CREATE TABLE script_connections_new (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('raw', 'openapi', 'mcp', 'graphql')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'agent', 'repo')),
  scope_id TEXT,
  base_url TEXT,
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
  id, slug, display_name, kind, scope, scope_id, base_url, allowed_hosts_json,
  credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
  openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
  generated_runtime_json, generated_at, generation_error, enabled, version, created_at,
  updated_at, created_by, updated_by
)
SELECT
  id, slug, display_name, kind, scope, scope_id, base_url, allowed_hosts_json,
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
