-- Resource history survives task, agent, profile, and provider destruction.
-- Identity columns deliberately have no cascading foreign keys.
CREATE TABLE browser_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('browser-use', 'fake')),
  ownerScope TEXT NOT NULL CHECK(ownerScope IN ('user', 'swarm')),
  ownerUserId TEXT,
  privateConfig TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  leaseOwner TEXT,
  leaseExpiresAt TEXT,
  deletedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  CHECK ((ownerScope = 'user' AND ownerUserId IS NOT NULL) OR (ownerScope = 'swarm' AND ownerUserId IS NULL))
);
CREATE UNIQUE INDEX idx_browser_profiles_name ON browser_profiles(ownerScope, COALESCE(ownerUserId, ''), name) WHERE deletedAt IS NULL;

CREATE TABLE sandbox_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK(version > 0),
  provider TEXT NOT NULL CHECK(provider IN ('e2b', 'fake')),
  privateConfig TEXT NOT NULL,
  deletedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('sandbox', 'browser')),
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('provisioning', 'running', 'pausing', 'paused', 'stopping', 'stopped', 'resuming', 'destroying', 'destroyed', 'error')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  creatorAgentId TEXT NOT NULL,
  requestedByUserId TEXT,
  sourceTaskId TEXT NOT NULL,
  createRequestKey TEXT NOT NULL CHECK(length(createRequestKey) > 0),
  rootTaskId TEXT NOT NULL,
  profileId TEXT REFERENCES browser_profiles(id),
  templateId TEXT REFERENCES sandbox_templates(id),
  templateVersion INTEGER,
  privateConfig TEXT NOT NULL,
  providerHandle TEXT,
  lastActivityAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  leaseOwner TEXT,
  leaseExpiresAt TEXT,
  runningLeaseExpiresAt TEXT,
  liveReservation INTEGER NOT NULL DEFAULT 1 CHECK(liveReservation IN (0, 1)),
  lastError TEXT,
  destroyedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  CHECK ((kind = 'sandbox' AND provider IN ('e2b', 'fake') AND profileId IS NULL) OR (kind = 'browser' AND provider IN ('browser-use', 'fake') AND templateId IS NULL))
);
CREATE INDEX idx_resources_tree ON resources(rootTaskId, state);
CREATE UNIQUE INDEX idx_resources_create_request ON resources(creatorAgentId, sourceTaskId, createRequestKey);
CREATE INDEX idx_resources_requester ON resources(requestedByUserId, createdAt);
CREATE INDEX idx_resources_reap ON resources(state, expiresAt, lastActivityAt);
CREATE INDEX idx_resources_leases ON resources(leaseExpiresAt, runningLeaseExpiresAt);
CREATE UNIQUE INDEX idx_resources_active_profile ON resources(profileId) WHERE profileId IS NOT NULL AND liveReservation = 1;

-- History attribution remains canonical even when the source task changes or disappears.
CREATE TRIGGER resources_requester_immutable
BEFORE UPDATE OF requestedByUserId ON resources
WHEN OLD.requestedByUserId IS NOT NEW.requestedByUserId
BEGIN
  SELECT RAISE(ABORT, 'Resource requester attribution is immutable.');
END;

CREATE TABLE resource_links (
  id TEXT PRIMARY KEY,
  resourceId TEXT NOT NULL REFERENCES resources(id),
  kind TEXT NOT NULL CHECK(kind IN ('task', 'github-pr', 'slack-thread', 'workflow-run')),
  targetId TEXT NOT NULL,
  isPrimary INTEGER NOT NULL DEFAULT 0 CHECK(isPrimary IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(resourceId, kind, targetId)
);
CREATE INDEX idx_resource_links_target ON resource_links(kind, targetId, resourceId);
CREATE UNIQUE INDEX idx_resource_links_primary_pr ON resource_links(resourceId) WHERE kind = 'github-pr' AND isPrimary = 1;

CREATE TABLE resource_operations (
  id TEXT PRIMARY KEY,
  resourceId TEXT NOT NULL REFERENCES resources(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  kind TEXT NOT NULL CHECK(kind IN ('create', 'pause', 'resume', 'stop', 'destroy', 'setup', 'refresh', 'exec')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'uncertain')),
  idempotencyKey TEXT NOT NULL,
  privateConfig TEXT NOT NULL,
  leaseOwner TEXT,
  leaseExpiresAt TEXT,
  startedAt TEXT,
  finishedAt TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(resourceId, idempotencyKey)
);
CREATE INDEX idx_resource_operations_reconcile ON resource_operations(status, leaseExpiresAt);

CREATE TABLE resource_costs (
  id TEXT PRIMARY KEY,
  resourceId TEXT NOT NULL REFERENCES resources(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  dimension TEXT NOT NULL,
  agentId TEXT NOT NULL,
  requestedByUserId TEXT,
  sourceTaskId TEXT NOT NULL,
  intervalStart TEXT NOT NULL,
  intervalEnd TEXT NOT NULL,
  amountUsd REAL NOT NULL CHECK(amountUsd >= 0),
  costSource TEXT NOT NULL CHECK(costSource IN ('estimated', 'provider')),
  checkpointKey TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  CHECK(intervalEnd > intervalStart),
  UNIQUE(resourceId, generation, dimension, intervalStart, intervalEnd)
);
CREATE INDEX idx_resource_costs_agent ON resource_costs(agentId, intervalStart);
CREATE INDEX idx_resource_costs_user ON resource_costs(requestedByUserId, intervalStart);

-- Provenance does not change the worker-token binding discriminator.
ALTER TABLE session_tokens ADD COLUMN sourceTaskId TEXT;
CREATE INDEX idx_session_tokens_source_task ON session_tokens(sourceTaskId) WHERE sourceTaskId IS NOT NULL;
