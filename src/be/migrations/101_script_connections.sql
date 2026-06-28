-- Promote scripts-runtime credential bindings and typed API connections into
-- relational state so registration, scoping, and generation metadata can be
-- controlled independently of generic swarm_config values.

CREATE TABLE IF NOT EXISTS script_credential_bindings (
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
  CHECK(scope = 'global' OR scope_id IS NOT NULL),
  CHECK(header_template IS NOT NULL OR query_template IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_script_credential_bindings_identity
  ON script_credential_bindings(
    config_key,
    scope,
    COALESCE(scope_id, ''),
    COALESCE(header_template, ''),
    COALESCE(query_template, '')
  );

CREATE TABLE IF NOT EXISTS script_connections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('raw', 'openapi', 'mcp')),
  scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'agent', 'repo')),
  scope_id TEXT,
  base_url TEXT,
  allowed_hosts_json TEXT NOT NULL DEFAULT '[]',
  credential_binding_id TEXT REFERENCES script_credential_bindings(id) ON DELETE SET NULL,
  openapi_spec_source_kind TEXT CHECK(openapi_spec_source_kind IN ('url', 'inline', 'agent_fs')),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_script_connections_slug_scope
  ON script_connections(slug, scope, COALESCE(scope_id, ''));

CREATE INDEX IF NOT EXISTS idx_script_connections_kind_enabled
  ON script_connections(kind, enabled);
