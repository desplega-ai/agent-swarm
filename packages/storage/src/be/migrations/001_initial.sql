-- 001_initial.sql
-- Baseline migration: Collapsed schema of all 18 tables, all indexes, and default data.
-- This represents the complete schema as of the migration system introduction.
-- For existing databases, this migration is marked as applied without execution (bootstrap).

-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    isLead INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'offline')),
    description TEXT,
    role TEXT,
    capabilities TEXT DEFAULT '[]',
    maxTasks INTEGER DEFAULT 1,
    emptyPollCount INTEGER DEFAULT 0,
    claudeMd TEXT,
    soulMd TEXT,
    identityMd TEXT,
    setupScript TEXT,
    toolsMd TEXT,
    lastActivityAt TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'public' CHECK(type IN ('public', 'dm')),
    createdBy TEXT,
    participants TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (createdBy) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS epics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    goal TEXT NOT NULL,
    prd TEXT,
    plan TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 50,
    tags TEXT DEFAULT '[]',
    createdByAgentId TEXT,
    leadAgentId TEXT,
    channelId TEXT,
    researchDocPath TEXT,
    planDocPath TEXT,
    slackChannelId TEXT,
    slackThreadTs TEXT,
    githubRepo TEXT,
    githubMilestone TEXT,
    progressNotifiedAt TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    FOREIGN KEY (createdByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (leadAgentId) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    creatorAgentId TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'agentmail', 'system', 'schedule')),
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
    githubRepo TEXT,
    githubEventType TEXT,
    githubNumber INTEGER,
    githubCommentId INTEGER,
    githubAuthor TEXT,
    githubUrl TEXT,
    epicId TEXT REFERENCES epics(id) ON DELETE SET NULL,
    parentTaskId TEXT,
    claudeSessionId TEXT,
    agentmailInboxId TEXT,
    agentmailMessageId TEXT,
    agentmailThreadId TEXT,
    model TEXT,
    scheduleId TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    finishedAt TEXT,
    failureReason TEXT,
    output TEXT,
    progress TEXT,
    notifiedAt TEXT
);

CREATE TABLE IF NOT EXISTS agent_log (
    id TEXT PRIMARY KEY,
    eventType TEXT NOT NULL,
    agentId TEXT,
    taskId TEXT,
    oldValue TEXT,
    newValue TEXT,
    metadata TEXT,
    createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    agentId TEXT,
    content TEXT NOT NULL,
    replyToId TEXT,
    mentions TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (replyToId) REFERENCES channel_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS channel_read_state (
    agentId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    lastReadAt TEXT NOT NULL,
    processing_since TEXT,
    PRIMARY KEY (agentId, channelId),
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (channelId) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    name TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 3000,
    description TEXT,
    url TEXT,
    healthCheckPath TEXT DEFAULT '/health',
    status TEXT NOT NULL DEFAULT 'starting' CHECK(status IN ('starting', 'healthy', 'unhealthy', 'stopped')),
    script TEXT NOT NULL DEFAULT '',
    cwd TEXT,
    interpreter TEXT,
    args TEXT,
    env TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    UNIQUE(agentId, name)
);

CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    taskId TEXT,
    sessionId TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    cli TEXT NOT NULL DEFAULT 'claude',
    content TEXT NOT NULL,
    lineNumber INTEGER NOT NULL,
    createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_costs (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    taskId TEXT,
    agentId TEXT NOT NULL,
    totalCostUsd REAL NOT NULL,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER NOT NULL,
    numTurns INTEGER NOT NULL,
    model TEXT NOT NULL,
    isError INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'slack',
    status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'processing', 'read', 'responded', 'delegated')),
    slackChannelId TEXT,
    slackThreadTs TEXT,
    slackUserId TEXT,
    matchedText TEXT,
    delegatedToTaskId TEXT,
    responseText TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (delegatedToTaskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    cronExpression TEXT,
    intervalMs INTEGER,
    taskTemplate TEXT NOT NULL,
    taskType TEXT,
    tags TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50,
    targetAgentId TEXT,
    enabled INTEGER DEFAULT 1,
    lastRunAt TEXT,
    nextRunAt TEXT,
    createdByAgentId TEXT,
    timezone TEXT DEFAULT 'UTC',
    consecutiveErrors INTEGER DEFAULT 0,
    lastErrorAt TEXT,
    lastErrorMessage TEXT,
    model TEXT,
    scheduleType TEXT NOT NULL DEFAULT 'recurring' CHECK(scheduleType IN ('recurring', 'one_time')),
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    CHECK (
        (scheduleType = 'recurring' AND (cronExpression IS NOT NULL OR intervalMs IS NOT NULL))
        OR
        (scheduleType = 'one_time')
    )
);

CREATE TABLE IF NOT EXISTS swarm_config (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    isSecret INTEGER NOT NULL DEFAULT 0,
    envPath TEXT,
    description TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(scope, scopeId, key)
);

CREATE TABLE IF NOT EXISTS swarm_repos (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    clonePath TEXT NOT NULL UNIQUE,
    defaultBranch TEXT NOT NULL DEFAULT 'main',
    autoClone INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('agent', 'swarm')),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('manual', 'file_index', 'session_summary', 'task_completion')),
    sourceTaskId TEXT,
    sourcePath TEXT,
    chunkIndex INTEGER DEFAULT 0,
    totalChunks INTEGER DEFAULT 1,
    tags TEXT DEFAULT '[]',
    createdAt TEXT NOT NULL,
    accessedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_sessions (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    taskId TEXT UNIQUE,
    triggerType TEXT NOT NULL,
    inboxMessageId TEXT,
    taskDescription TEXT,
    startedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    lastHeartbeatAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agentmail_inbox_mappings (
    id TEXT PRIMARY KEY,
    inboxId TEXT NOT NULL UNIQUE,
    agentId TEXT NOT NULL,
    inboxEmail TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS context_versions (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    field TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    changeSource TEXT NOT NULL,
    changedByAgentId TEXT,
    changeReason TEXT,
    contentHash TEXT NOT NULL,
    previousVersionId TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (changedByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (previousVersionId) REFERENCES context_versions(id) ON DELETE SET NULL
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- agent_tasks indexes
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);

-- agent_log indexes
CREATE INDEX IF NOT EXISTS idx_agent_log_agentId ON agent_log(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_log_taskId ON agent_log(taskId);
CREATE INDEX IF NOT EXISTS idx_agent_log_eventType ON agent_log(eventType);
CREATE INDEX IF NOT EXISTS idx_agent_log_createdAt ON agent_log(createdAt);

-- channel_messages indexes
CREATE INDEX IF NOT EXISTS idx_channel_messages_channelId ON channel_messages(channelId);
CREATE INDEX IF NOT EXISTS idx_channel_messages_agentId ON channel_messages(agentId);
CREATE INDEX IF NOT EXISTS idx_channel_messages_createdAt ON channel_messages(createdAt);

-- services indexes
CREATE INDEX IF NOT EXISTS idx_services_agentId ON services(agentId);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

-- session_logs indexes
CREATE INDEX IF NOT EXISTS idx_session_logs_taskId ON session_logs(taskId);
CREATE INDEX IF NOT EXISTS idx_session_logs_sessionId ON session_logs(sessionId);

-- session_costs indexes
CREATE INDEX IF NOT EXISTS idx_session_costs_createdAt ON session_costs(createdAt);
CREATE INDEX IF NOT EXISTS idx_session_costs_taskId ON session_costs(taskId);
CREATE INDEX IF NOT EXISTS idx_session_costs_agentId ON session_costs(agentId);
CREATE INDEX IF NOT EXISTS idx_session_costs_agent_createdAt ON session_costs(agentId, createdAt);

-- inbox_messages indexes
CREATE INDEX IF NOT EXISTS idx_inbox_messages_agentId ON inbox_messages(agentId);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_status ON inbox_messages(status);

-- scheduled_tasks indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(scheduleType);

-- epics indexes
CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
CREATE INDEX IF NOT EXISTS idx_epics_createdByAgentId ON epics(createdByAgentId);
CREATE INDEX IF NOT EXISTS idx_epics_leadAgentId ON epics(leadAgentId);

-- swarm_config indexes
CREATE INDEX IF NOT EXISTS idx_swarm_config_scope ON swarm_config(scope);
CREATE INDEX IF NOT EXISTS idx_swarm_config_scope_id ON swarm_config(scope, scopeId);
CREATE INDEX IF NOT EXISTS idx_swarm_config_key ON swarm_config(key);

-- swarm_repos indexes
CREATE INDEX IF NOT EXISTS idx_swarm_repos_name ON swarm_repos(name);

-- agent_memory indexes
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source ON agent_memory(source);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(createdAt);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_path ON agent_memory(sourcePath);

-- active_sessions indexes
CREATE INDEX IF NOT EXISTS idx_active_sessions_agent ON active_sessions(agentId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_sessions_taskId ON active_sessions(taskId);

-- context_versions indexes
CREATE INDEX IF NOT EXISTS idx_cv_agent_field ON context_versions(agentId, field, version DESC);
CREATE INDEX IF NOT EXISTS idx_cv_agent_created ON context_versions(agentId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_cv_hash ON context_versions(agentId, field, contentHash);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Default general channel
INSERT OR IGNORE INTO channels (id, name, description, type, createdAt)
VALUES ('00000000-0000-4000-8000-000000000001', 'general', 'Default channel for all agents', 'public', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
