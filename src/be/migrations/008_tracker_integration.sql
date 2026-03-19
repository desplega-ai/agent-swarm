-- Tracker integration: generic OAuth, entity sync mapping, agent mapping tables.
-- Also adds 'linear' to the agent_tasks source CHECK constraint.

PRAGMA defer_foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════════════
-- Generic OAuth tables (reusable across any OAuth provider in the swarm)
-- ═══════════════════════════════════════════════════════════════════

-- Generic OAuth application configuration (one row per provider)
CREATE TABLE IF NOT EXISTS oauth_apps (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL UNIQUE,
    clientId TEXT NOT NULL,
    clientSecret TEXT NOT NULL,
    authorizeUrl TEXT NOT NULL,
    tokenUrl TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic OAuth token storage (one active token set per provider)
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL UNIQUE,
    accessToken TEXT NOT NULL,
    refreshToken TEXT,
    expiresAt TEXT NOT NULL,
    scope TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (provider) REFERENCES oauth_apps(provider)
);

-- ═══════════════════════════════════════════════════════════════════
-- Generic tracker tables (reusable across any ticket tracker)
-- ═══════════════════════════════════════════════════════════════════

-- Generic tracker entity mapping
CREATE TABLE IF NOT EXISTS tracker_sync (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL,
    entityType TEXT NOT NULL CHECK (entityType IN ('task', 'epic')),
    providerEntityType TEXT,
    swarmId TEXT NOT NULL,
    externalId TEXT NOT NULL,
    externalIdentifier TEXT,
    externalUrl TEXT,
    lastSyncedAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSyncOrigin TEXT CHECK (lastSyncOrigin IN ('swarm', 'external')),
    lastDeliveryId TEXT,
    syncDirection TEXT NOT NULL DEFAULT 'inbound' CHECK (syncDirection IN ('inbound', 'outbound', 'bidirectional')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, entityType, swarmId),
    UNIQUE(provider, entityType, externalId)
);

-- Generic agent-to-external-user mapping
CREATE TABLE IF NOT EXISTS tracker_agent_mapping (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    provider TEXT NOT NULL,
    agentId TEXT NOT NULL,
    externalUserId TEXT NOT NULL,
    agentName TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, agentId),
    UNIQUE(provider, externalUserId)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_swarm ON tracker_sync(provider, entityType, swarmId);
CREATE INDEX IF NOT EXISTS idx_tracker_sync_external ON tracker_sync(provider, entityType, externalId);
CREATE INDEX IF NOT EXISTS idx_tracker_agent_agentId ON tracker_agent_mapping(provider, agentId);

-- ═══════════════════════════════════════════════════════════════════
-- agent_tasks: recreate with 'linear' added to source CHECK constraint
-- (copied from previous 008_linear_integration.sql lines 54-114)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE agent_tasks_new (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    creatorAgentId TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'gitlab', 'agentmail', 'system', 'schedule', 'workflow', 'linear')),
    taskType TEXT,
    tags TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50,
    dependsOn TEXT DEFAULT '[]',
    offeredTo TEXT,
    offeredAt TEXT,
    acceptedAt TEXT,
    rejectionReason TEXT,
    slackChannelId TEXT,
    slackThreadTs TEXT,
    slackUserId TEXT,
    mentionMessageId TEXT,
    mentionChannelId TEXT,
    vcsProvider TEXT,
    vcsRepo TEXT,
    vcsEventType TEXT,
    vcsNumber INTEGER,
    vcsCommentId INTEGER,
    vcsAuthor TEXT,
    vcsUrl TEXT,
    epicId TEXT REFERENCES epics(id) ON DELETE SET NULL,
    parentTaskId TEXT,
    claudeSessionId TEXT,
    agentmailInboxId TEXT,
    agentmailMessageId TEXT,
    agentmailThreadId TEXT,
    model TEXT,
    scheduleId TEXT,
    workflowRunId TEXT REFERENCES workflow_runs(id),
    workflowRunStepId TEXT REFERENCES workflow_run_steps(id),
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    finishedAt TEXT,
    failureReason TEXT,
    output TEXT,
    progress TEXT,
    notifiedAt TEXT,
    dir TEXT
);

INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;

DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow_run ON agent_tasks(workflowRunId);
