CREATE TABLE scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'agent')),
  scopeId TEXT,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  intent TEXT NOT NULL,
  signatureJson TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  isScratch INTEGER NOT NULL DEFAULT 0,
  typeChecked INTEGER NOT NULL DEFAULT 0,
  fsMode TEXT NOT NULL DEFAULT 'none' CHECK(fsMode IN ('none', 'workspace-rw')),
  createdByAgentId TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_scripts_name_scope ON scripts(name, scope, COALESCE(scopeId, ''));
CREATE INDEX idx_scripts_scope ON scripts(scope, scopeId);
CREATE INDEX idx_scripts_scratch ON scripts(isScratch, createdAt);

CREATE TABLE script_versions (
  id TEXT PRIMARY KEY,
  scriptId TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  intent TEXT NOT NULL,
  signatureJson TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  changedByAgentId TEXT,
  changedAt TEXT NOT NULL DEFAULT (datetime('now')),
  changeReason TEXT,
  UNIQUE(scriptId, version)
);

CREATE INDEX idx_script_versions_hash ON script_versions(contentHash);
