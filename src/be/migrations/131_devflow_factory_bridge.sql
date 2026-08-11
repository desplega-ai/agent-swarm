-- Durable bridge from approved DevFlow product intent to repository-specific
-- implementation factories. Product authority and observed factory receipts
-- remain separate records.

CREATE TABLE devflow_repository_targets (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repositoryFullName TEXT NOT NULL,
  defaultBranch TEXT NOT NULL DEFAULT 'main',
  executionProfile TEXT NOT NULL DEFAULT 'command_center_factory'
    CHECK (executionProfile IN ('command_center_factory')),
  checkoutPath TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId),
  UNIQUE (organizationId, repositoryFullName)
);
CREATE INDEX idx_devflow_repository_targets_active
  ON devflow_repository_targets(organizationId, isActive, name);

CREATE TABLE devflow_implementation_intents (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  specId TEXT NOT NULL,
  specVersion INTEGER NOT NULL CHECK (specVersion > 0),
  specDigest TEXT NOT NULL,
  repositoryTargetId TEXT NOT NULL,
  desiredOutcome TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('p1','p2','p3')),
  riskSummary TEXT NOT NULL,
  intentSnapshotJson TEXT NOT NULL,
  createdByUserId TEXT NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId),
  UNIQUE (organizationId, workItemId, specId, repositoryTargetId, specDigest),
  FOREIGN KEY (workItemId, organizationId)
    REFERENCES devflow_work_items(id, organizationId) ON DELETE RESTRICT,
  FOREIGN KEY (specId, organizationId)
    REFERENCES devflow_specs(id, organizationId) ON DELETE RESTRICT,
  FOREIGN KEY (repositoryTargetId, organizationId)
    REFERENCES devflow_repository_targets(id, organizationId) ON DELETE RESTRICT
);
CREATE INDEX idx_devflow_implementation_intents_item
  ON devflow_implementation_intents(organizationId, workItemId, createdAt DESC);

CREATE TABLE devflow_factory_executions (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  implementationIntentId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','factory_intake','signoff_pending','ready','implementing','pr_open',
    'finalizer_admitted','merged','failed','cancelled'
  )),
  swarmTaskId TEXT REFERENCES agent_tasks(id),
  headSha TEXT,
  queueItemId TEXT,
  queueItemRevision INTEGER,
  contractId TEXT,
  canonicalContractPath TEXT,
  factoryStatus TEXT,
  surfacesJson TEXT NOT NULL DEFAULT '[]',
  impactedSurfacesJson TEXT NOT NULL DEFAULT '[]',
  architectureUnitsJson TEXT NOT NULL DEFAULT '{}',
  signoffsJson TEXT NOT NULL DEFAULT '[]',
  artifactsJson TEXT NOT NULL DEFAULT '[]',
  pullRequestJson TEXT,
  finalizerReceiptJson TEXT,
  mergedCommitSha TEXT,
  lastObservedAt TEXT,
  failureCode TEXT,
  failureDetail TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId),
  UNIQUE (implementationIntentId),
  FOREIGN KEY (implementationIntentId, organizationId)
    REFERENCES devflow_implementation_intents(id, organizationId) ON DELETE RESTRICT
);
CREATE INDEX idx_devflow_factory_executions_item
  ON devflow_factory_executions(organizationId, implementationIntentId, createdAt DESC);
