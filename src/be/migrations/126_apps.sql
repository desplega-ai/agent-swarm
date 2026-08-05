-- Swarm Apps: app definitions + version history + per-user config.
-- Runtime model rows live in the existing KV store; the complete app schema
-- and json-render page tree are embedded as JSON on the apps row.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- App definition history. Snapshots preserve the pre-write state.
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  appId TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changedByAgentId TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(appId, version)
);

-- Per-user app configuration values live outside versioned app definitions.
CREATE TABLE IF NOT EXISTS app_user_config (
  id TEXT PRIMARY KEY,
  appId TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  "values" TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(appId, scope)
);
