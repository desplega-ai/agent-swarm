-- Indexes for hot lookups that scan agent_tasks or script_runs today.
--
-- agent_tasks rows carry large `task` text, so every scan of the table reads
-- its overflow pages and costs hundreds of milliseconds, whatever column it
-- filters. Production has no sqlite_stat1, so each index below is shaped so
-- the planner picks it without statistics.

-- getTaskByWorkflowRunStepId and getStuckWorkflowRuns look tasks up by step.
-- Partial: only workflow-step tasks carry the column.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflowRunStepId
  ON agent_tasks(workflowRunStepId) WHERE workflowRunStepId IS NOT NULL;

-- getRecentCompletedCount: `status = ? AND finishedAt > ?` becomes a covering
-- range instead of reading finishedAt from every completed row.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_finishedAt
  ON agent_tasks(status, finishedAt);

-- Session root counts: `parentTaskId IS NULL AND source IN (...)` becomes a
-- covering range instead of reading source from every root.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parentTaskId_source
  ON agent_tasks(parentTaskId, source);

-- countScriptRuns / listScriptRuns filtered by script name.
CREATE INDEX IF NOT EXISTS idx_script_runs_scriptName_startedAt
  ON script_runs(scriptName, startedAt DESC);
