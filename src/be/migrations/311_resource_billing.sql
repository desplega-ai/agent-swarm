-- Rate and attribution snapshots survive task deletion and provider configuration changes.
CREATE TABLE resource_billing (
  resourceId TEXT NOT NULL REFERENCES resources(id),
  generation INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  rateUsdPerMs REAL NOT NULL CHECK(rateUsdPerMs >= 0),
  rateEffectiveAt TEXT NOT NULL,
  agentId TEXT NOT NULL,
  requestedByUserId TEXT,
  sourceTaskId TEXT NOT NULL,
  checkpointAt TEXT NOT NULL,
  leaseEndsAt TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0, 1)),
  -- Admission reserves future cost. Only dispatched provider work becomes billable.
  reserved INTEGER NOT NULL DEFAULT 1 CHECK(reserved IN (0, 1)),
  reservationStartsAt TEXT,
  billableEndsAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY(resourceId, generation, dimension)
);
CREATE INDEX idx_resource_billing_active ON resource_billing(active, leaseEndsAt);
CREATE INDEX idx_resource_costs_day ON resource_costs(intervalStart);
ALTER TABLE resource_costs ADD COLUMN rateUsdPerMs REAL;
ALTER TABLE resource_costs ADD COLUMN rateEffectiveAt TEXT;
CREATE TRIGGER resources_attribution_immutable
BEFORE UPDATE OF creatorAgentId, sourceTaskId, rootTaskId ON resources
WHEN OLD.creatorAgentId IS NOT NEW.creatorAgentId OR OLD.sourceTaskId IS NOT NEW.sourceTaskId OR OLD.rootTaskId IS NOT NEW.rootTaskId
BEGIN
  SELECT RAISE(ABORT, 'Resource attribution is immutable.');
END;

ALTER TABLE resources ADD COLUMN continuousStartedAt TEXT;
-- Definitive pre-dispatch reaper failures must back off across API restarts.
ALTER TABLE resources ADD COLUMN cleanupNextAttemptAt TEXT;
ALTER TABLE resources ADD COLUMN cleanupRetryCount INTEGER NOT NULL DEFAULT 0 CHECK(cleanupRetryCount >= 0);

CREATE TRIGGER resource_billing_snapshot_immutable
BEFORE UPDATE OF rateUsdPerMs, rateEffectiveAt, agentId, requestedByUserId, sourceTaskId ON resource_billing
WHEN OLD.rateUsdPerMs IS NOT NEW.rateUsdPerMs OR OLD.rateEffectiveAt IS NOT NEW.rateEffectiveAt
  OR OLD.agentId IS NOT NEW.agentId OR OLD.requestedByUserId IS NOT NEW.requestedByUserId OR OLD.sourceTaskId IS NOT NEW.sourceTaskId
BEGIN
  SELECT RAISE(ABORT, 'Resource billing attribution and rates are immutable.');
END;
CREATE TRIGGER resource_costs_attribution_immutable
BEFORE UPDATE OF resourceId, generation, dimension, agentId, requestedByUserId, sourceTaskId ON resource_costs
WHEN OLD.resourceId IS NOT NEW.resourceId OR OLD.generation IS NOT NEW.generation OR OLD.dimension IS NOT NEW.dimension
  OR OLD.agentId IS NOT NEW.agentId OR OLD.requestedByUserId IS NOT NEW.requestedByUserId OR OLD.sourceTaskId IS NOT NEW.sourceTaskId
BEGIN
  SELECT RAISE(ABORT, 'Resource cost attribution is immutable.');
END;

-- Recovery must distinguish a queued operation from a possibly applied mutation.
ALTER TABLE resource_operations ADD COLUMN mutationStartedAt TEXT;
ALTER TABLE resource_operations ADD COLUMN providerDeadlineAt TEXT;
ALTER TABLE resource_operations ADD COLUMN nextAttemptAt TEXT;
ALTER TABLE resource_operations ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_resource_operations_retry ON resource_operations(status,nextAttemptAt);
