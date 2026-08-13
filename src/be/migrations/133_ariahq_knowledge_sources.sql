CREATE TABLE ariahq_knowledge_sources (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id),
  "key" TEXT NOT NULL,
  name TEXT NOT NULL,
  sourceKind TEXT NOT NULL CHECK (sourceKind IN ('slack', 'google_drive', 'call_recording', 'crm', 'github', 'manual', 'ariahq')),
  audience TEXT NOT NULL CHECK (audience IN ('internal', 'client')),
  clientKey TEXT,
  adapter TEXT NOT NULL CHECK (adapter IN ('openapi', 'webhook')),
  connectionSlug TEXT,
  runAsAgentId TEXT NOT NULL REFERENCES agents(id),
  syncConfigJson TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  scheduleId TEXT REFERENCES scheduled_tasks(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  lastSyncStatus TEXT CHECK (lastSyncStatus IS NULL OR lastSyncStatus IN ('running', 'completed', 'failed')),
  lastSyncAt TEXT,
  lastErrorMessage TEXT,
  createdByUserId TEXT NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE (organizationId, "key"),
  CHECK (
    (audience = 'client' AND clientKey IS NOT NULL AND length(clientKey) > 0)
    OR (audience = 'internal' AND clientKey IS NULL)
  ),
  CHECK (adapter != 'openapi' OR (connectionSlug IS NOT NULL AND length(connectionSlug) > 0))
);

CREATE INDEX idx_ariahq_knowledge_sources_org
  ON ariahq_knowledge_sources(organizationId, enabled, sourceKind);
CREATE INDEX idx_ariahq_knowledge_sources_schedule
  ON ariahq_knowledge_sources(scheduleId);

CREATE TABLE ariahq_knowledge_sync_runs (
  id TEXT PRIMARY KEY,
  sourceId TEXT NOT NULL REFERENCES ariahq_knowledge_sources(id),
  agentId TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  cursorBefore TEXT,
  cursorAfter TEXT,
  recordsSeen INTEGER NOT NULL DEFAULT 0,
  recordsCreated INTEGER NOT NULL DEFAULT 0,
  recordsReused INTEGER NOT NULL DEFAULT 0,
  errorMessage TEXT,
  startedAt TEXT NOT NULL,
  finishedAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_ariahq_knowledge_sync_runs_source
  ON ariahq_knowledge_sync_runs(sourceId, startedAt DESC);
CREATE UNIQUE INDEX idx_ariahq_knowledge_sync_runs_one_active
  ON ariahq_knowledge_sync_runs(sourceId) WHERE status = 'running';
