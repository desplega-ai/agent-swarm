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
