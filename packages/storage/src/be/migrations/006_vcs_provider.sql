-- Add VCS provider abstraction: rename github* columns to vcs*, add vcsProvider,
-- and update source CHECK constraint to include 'gitlab'.
-- Uses the 12-step table recreation approach since SQLite doesn't support ALTER CHECK.

PRAGMA defer_foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════════════
-- agent_tasks: recreate with vcs* columns + updated CHECK constraint
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE agent_tasks_new (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    creatorAgentId TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'gitlab', 'agentmail', 'system', 'schedule', 'workflow')),
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
    notifiedAt TEXT
);

-- Copy data, renaming github* → vcs* and adding vcsProvider backfill
INSERT INTO agent_tasks_new SELECT
    id, agentId, creatorAgentId, task, status, source,
    taskType, tags, priority, dependsOn, offeredTo, offeredAt,
    acceptedAt, rejectionReason, slackChannelId, slackThreadTs, slackUserId,
    mentionMessageId, mentionChannelId,
    CASE WHEN githubRepo IS NOT NULL THEN 'github' ELSE NULL END,
    githubRepo, githubEventType, githubNumber, githubCommentId, githubAuthor, githubUrl,
    epicId, parentTaskId, claudeSessionId,
    agentmailInboxId, agentmailMessageId, agentmailThreadId,
    model, scheduleId, workflowRunId, workflowRunStepId,
    createdAt, lastUpdatedAt, finishedAt, failureReason, output, progress, notifiedAt
FROM agent_tasks;

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

-- ═══════════════════════════════════════════════════════════════════
-- epics: rename github* → vcs* and add vcsProvider
-- (No CHECK constraint to update, so ALTER TABLE is fine)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE epics RENAME COLUMN githubRepo TO vcsRepo;
ALTER TABLE epics RENAME COLUMN githubMilestone TO vcsMilestone;
ALTER TABLE epics ADD COLUMN vcsProvider TEXT DEFAULT NULL;

-- Backfill vcsProvider for epics
UPDATE epics SET vcsProvider = 'github' WHERE vcsRepo IS NOT NULL;
