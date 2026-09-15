CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL DEFAULT 'api' CHECK(runtime IN ('api', 'worker')),
  manifestJson TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  activeVersion INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  configJson TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK(status IN ('disabled', 'enabled', 'error', 'auto-disabled')),
  consecutiveFailures INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  agentId TEXT,
  createdByAgentId TEXT,
  created_by TEXT,
  updated_by TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE extension_files (
  id TEXT PRIMARY KEY,
  extensionId TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(extensionId, path)
);

CREATE TABLE extension_versions (
  id TEXT PRIMARY KEY,
  extensionId TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  manifestJson TEXT NOT NULL,
  filesJson TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  changedByAgentId TEXT,
  changedAt TEXT NOT NULL DEFAULT (datetime('now')),
  changeReason TEXT,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(extensionId, version)
);

CREATE TABLE extension_runs (
  id TEXT PRIMARY KEY,
  extensionId TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  event TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK(action IN ('continue', 'modify', 'block', 'error', 'timeout', 'load-error')),
  durationMs INTEGER,
  message TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_extension_runs_extension_created
  ON extension_runs(extensionId, createdAt);
