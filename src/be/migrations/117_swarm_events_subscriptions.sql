-- 117_swarm_events_subscriptions.sql
-- SPIKE (extension system, Layer 1): durable event journal + subscriptions +
-- delivery outbox. Events emitted on the workflow event bus are persisted to
-- swarm_events; enabled subscriptions matching the event name (glob) and
-- optional filter enqueue a subscription_deliveries row; a poller executes
-- the subscription target (catalog script or workflow) at-least-once.

CREATE TABLE IF NOT EXISTS swarm_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT,
    emittedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swarm_events_name_emitted
    ON swarm_events(name, emittedAt);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    eventPattern TEXT NOT NULL,
    filter TEXT,
    targetType TEXT NOT NULL CHECK (targetType IN ('script', 'workflow')),
    scriptName TEXT,
    scriptArgs TEXT,
    workflowId TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdByAgentId TEXT,
    created_by TEXT,
    updated_by TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    CHECK (targetType != 'script' OR scriptName IS NOT NULL),
    CHECK (targetType != 'workflow' OR workflowId IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled
    ON subscriptions(enabled);

CREATE TABLE IF NOT EXISTS subscription_deliveries (
    id TEXT PRIMARY KEY,
    subscriptionId TEXT NOT NULL,
    eventId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    claimedAt TEXT,
    finishedAt TEXT,
    error TEXT,
    result TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE (subscriptionId, eventId)
);

CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_status
    ON subscription_deliveries(status, createdAt);
