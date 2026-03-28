-- Remove epic feature entirely

-- 1. Null out epicId on tasks before table recreation
UPDATE agent_tasks SET epicId = NULL WHERE epicId IS NOT NULL;

-- 2. Recreate agent_tasks without epicId (12-step pattern per codebase convention)
PRAGMA foreign_keys=off;

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
  dir TEXT,
  outputSchema TEXT,
  compactionCount INTEGER DEFAULT 0,
  peakContextPercent REAL,
  totalContextTokensUsed INTEGER,
  contextWindowSize INTEGER,
  was_paused INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agent_tasks_new (
  id, agentId, creatorAgentId, task, status, source, taskType, tags,
  priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
  slackChannelId, slackThreadTs, slackUserId,
  mentionMessageId, mentionChannelId,
  vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl,
  parentTaskId, claudeSessionId,
  agentmailInboxId, agentmailMessageId, agentmailThreadId,
  model, scheduleId, workflowRunId, workflowRunStepId,
  createdAt, lastUpdatedAt, finishedAt, failureReason, output, progress, notifiedAt,
  dir, outputSchema, compactionCount, peakContextPercent,
  totalContextTokensUsed, contextWindowSize, was_paused
)
SELECT
  id, agentId, creatorAgentId, task, status, source, taskType, tags,
  priority, dependsOn, offeredTo, offeredAt, acceptedAt, rejectionReason,
  slackChannelId, slackThreadTs, slackUserId,
  mentionMessageId, mentionChannelId,
  vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl,
  parentTaskId, claudeSessionId,
  agentmailInboxId, agentmailMessageId, agentmailThreadId,
  model, scheduleId, workflowRunId, workflowRunStepId,
  createdAt, lastUpdatedAt, finishedAt, failureReason, output, progress, notifiedAt,
  dir, outputSchema, compactionCount, peakContextPercent,
  totalContextTokensUsed, contextWindowSize, was_paused
FROM agent_tasks;

DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Recreate indexes (without epicId index)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow_run ON agent_tasks(workflowRunId);

PRAGMA foreign_keys=on;

-- 3. Remove tracker_sync entries for epics
DELETE FROM tracker_sync WHERE entityType = 'epic';

-- 4. Drop the epics table
DROP TABLE IF EXISTS epics;
