-- Linear integration: OAuth tokens, entity sync mapping, agent mapping tables.
-- Also adds 'linear' to the agent_tasks source CHECK constraint.

PRAGMA defer_foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════════════
-- New tables for Linear integration
-- ═══════════════════════════════════════════════════════════════════

-- OAuth token storage (single-row for workspace-level auth)
CREATE TABLE IF NOT EXISTS linear_oauth_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    accessToken TEXT NOT NULL,
    refreshToken TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    scope TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Swarm ↔ Linear entity mapping
CREATE TABLE IF NOT EXISTS linear_sync (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    entityType TEXT NOT NULL CHECK (entityType IN ('task', 'epic')),
    swarmId TEXT NOT NULL,
    linearId TEXT NOT NULL,
    linearIdentifier TEXT,
    linearUrl TEXT,
    lastSyncedAt TEXT NOT NULL DEFAULT (datetime('now')),
    syncDirection TEXT NOT NULL DEFAULT 'outbound' CHECK (syncDirection IN ('outbound', 'inbound', 'bidirectional')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entityType, swarmId),
    UNIQUE(entityType, linearId)
);

-- Agent ↔ Linear user mapping
CREATE TABLE IF NOT EXISTS linear_agent_mapping (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    agentId TEXT NOT NULL UNIQUE,
    linearUserId TEXT NOT NULL UNIQUE,
    agentName TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for linear_sync
CREATE INDEX IF NOT EXISTS idx_linear_sync_swarmId ON linear_sync(entityType, swarmId);
CREATE INDEX IF NOT EXISTS idx_linear_sync_linearId ON linear_sync(entityType, linearId);
CREATE INDEX IF NOT EXISTS idx_linear_agent_mapping_agentId ON linear_agent_mapping(agentId);

-- ═══════════════════════════════════════════════════════════════════
-- agent_tasks: recreate with 'linear' added to source CHECK constraint
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
    dir TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    finishedAt TEXT,
    failureReason TEXT,
    output TEXT,
    progress TEXT,
    notifiedAt TEXT
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
