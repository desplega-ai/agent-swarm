-- Add 'workflow' to the source CHECK constraint on agent_tasks.
-- SQLite does not support ALTER COLUMN, so we use the recommended
-- 12-step table recreation approach (https://www.sqlite.org/lang_altertable.html).

PRAGMA defer_foreign_keys = ON;

-- Step 1: Create the replacement table with the updated CHECK constraint.
-- This includes the workflowRunId/workflowRunStepId columns added in 003.
CREATE TABLE agent_tasks_new (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    creatorAgentId TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'mcp' CHECK(source IN ('mcp', 'slack', 'api', 'github', 'agentmail', 'system', 'schedule', 'workflow')),
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

-- Step 2: Copy all data from the old table.
INSERT INTO agent_tasks_new SELECT
    id, agentId, creatorAgentId, task, status, source,
    taskType, tags, priority, dependsOn, offeredTo, offeredAt,
    acceptedAt, rejectionReason, slackChannelId, slackThreadTs, slackUserId,
    mentionMessageId, mentionChannelId, githubRepo, githubEventType,
    githubNumber, githubCommentId, githubAuthor, githubUrl,
    epicId, parentTaskId, claudeSessionId,
    agentmailInboxId, agentmailMessageId, agentmailThreadId,
    model, scheduleId, workflowRunId, workflowRunStepId,
    createdAt, lastUpdatedAt, finishedAt, failureReason, output, progress, notifiedAt
FROM agent_tasks;

-- Step 3: Drop the old table.
DROP TABLE agent_tasks;

-- Step 4: Rename the new table.
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Step 5: Recreate indexes that existed on agent_tasks.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow_run ON agent_tasks(workflowRunId);
