-- Drop the SQL CHECK constraint on agent_tasks.source.
-- The Zod layer (`AgentTaskSourceSchema` in src/types.ts) is now the single
-- source of truth for the allowed enum, so adding a new source no longer
-- requires a forward-only migration. This makes future source additions
-- (Phase 1 of the UI chat/session experience plan) cheap.
--
-- SQLite cannot ALTER a CHECK constraint in place; we follow the table-rebuild
-- pattern from migration 043_jira_source.sql verbatim, minus the CHECK clause
-- on `source`. All other columns, defaults, indexes, and FKs are preserved
-- exactly. No data migration — existing rows remain valid.
--
-- INSERT uses an explicit column list (no `SELECT *`) to be robust against
-- column-order drift between SQLite versions and against post-043 ALTERs
-- (migration 044 added `provider` and `providerMeta`).
PRAGMA foreign_keys=off;

CREATE TABLE agent_tasks_new (
  id TEXT PRIMARY KEY,
  agentId TEXT,
  creatorAgentId TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'mcp',
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
  was_paused INTEGER NOT NULL DEFAULT 0,
  credentialKeySuffix TEXT,
  credentialKeyType TEXT,
  requestedByUserId TEXT REFERENCES users(id),
  vcsInstallationId INTEGER,
  vcsNodeId TEXT,
  slackReplySent INTEGER DEFAULT 0,
  swarmVersion TEXT,
  contextKey TEXT,
  provider TEXT,
  providerMeta TEXT
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
  totalContextTokensUsed, contextWindowSize, was_paused,
  credentialKeySuffix, credentialKeyType, requestedByUserId,
  vcsInstallationId, vcsNodeId, slackReplySent, swarmVersion, contextKey,
  provider, providerMeta
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
  totalContextTokensUsed, contextWindowSize, was_paused,
  credentialKeySuffix, credentialKeyType, requestedByUserId,
  vcsInstallationId, vcsNodeId, slackReplySent, swarmVersion, contextKey,
  provider, providerMeta
FROM agent_tasks;

DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Recreate every index that existed on agent_tasks (mirrors 043 + later additions):
--   001/004/006/009/026: agentId, status, offeredTo, taskType, agentmailThreadId, scheduleId, workflowRunId
--   031: requestedByUserId (partial)
--   034: parentTaskId
--   037: swarmVersion
--   040: composite (slackChannelId, slackThreadTs, status)
--   042: contextKey + (contextKey, status) composite
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_taskType ON agent_tasks(taskType);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agentmailThreadId ON agent_tasks(agentmailThreadId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_schedule_id ON agent_tasks(scheduleId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow_run ON agent_tasks(workflowRunId);
CREATE INDEX IF NOT EXISTS idx_tasks_requested_by ON agent_tasks(requestedByUserId) WHERE requestedByUserId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parentTaskId ON agent_tasks(parentTaskId);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_swarmVersion ON agent_tasks(swarmVersion);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_slack_thread
  ON agent_tasks(slackChannelId, slackThreadTs, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_context_key
  ON agent_tasks(contextKey);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_context_key_status
  ON agent_tasks(contextKey, status);

PRAGMA foreign_keys=on;
