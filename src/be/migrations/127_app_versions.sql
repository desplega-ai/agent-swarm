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
