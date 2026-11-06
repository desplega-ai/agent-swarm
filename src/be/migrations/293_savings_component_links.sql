-- Provenance for the savings "with components" view (src/be/savings/).
--
-- A script run's per-run api token (session_tokens.scriptRun = 1) now records
-- where the run came from: the swarm-script workflow step that started it, and
-- the script_runs row of the run itself. Rows created through that token carry
-- it, so a workflow's components (child runs, tasks and nested script runs its
-- script steps made) join exactly instead of by output text.
--
-- parentStepId and workflowRunId are not reused: parentStepId carries
-- sub-workflow attempt semantics, and a workflowRunId on a script-made task
-- would switch off its lead follow-up.
ALTER TABLE session_tokens ADD COLUMN sourceStepId TEXT;
ALTER TABLE session_tokens ADD COLUMN sourceScriptRunId TEXT;

ALTER TABLE agent_tasks ADD COLUMN sourceStepId TEXT;
ALTER TABLE agent_tasks ADD COLUMN sourceScriptRunId TEXT;
ALTER TABLE workflow_runs ADD COLUMN sourceStepId TEXT;
ALTER TABLE script_runs ADD COLUMN sourceStepId TEXT;
ALTER TABLE script_runs ADD COLUMN parentScriptRunId TEXT;

-- The rollup reads stamped rows one day at a time, from the child side.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_sourceStep_created
  ON agent_tasks(createdAt) WHERE sourceStepId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_sourceScriptRun_created
  ON agent_tasks(createdAt) WHERE sourceScriptRunId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_sourceStep_started
  ON workflow_runs(startedAt) WHERE sourceStepId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_runs_sourceStep_started
  ON script_runs(startedAt) WHERE sourceStepId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_runs_parentScriptRunId
  ON script_runs(parentScriptRunId) WHERE parentScriptRunId IS NOT NULL;

-- Spend of the agent tasks a workflow's runs caused without owning them:
-- descendants of its agent-task nodes' tasks, and tasks its script steps
-- created (with their descendants). Kept on both sides of the saving.
ALTER TABLE automation_savings_daily ADD COLUMN childTaskUsd REAL NOT NULL DEFAULT 0;
ALTER TABLE automation_savings_daily ADD COLUMN childTaskMs REAL NOT NULL DEFAULT 0;

-- Per UTC day (of the child), how many runs, tasks and script runs each
-- workflow caused. Read-time only: the "with components" view walks these
-- links; no list or fleet total adds them, since every child is already
-- priced on its own row.
CREATE TABLE IF NOT EXISTS automation_savings_links (
  day TEXT NOT NULL,
  parentJobId TEXT NOT NULL,
  childKind TEXT NOT NULL CHECK (childKind IN ('workflow', 'script', 'task')),
  childJobId TEXT NOT NULL,
  linkKind TEXT NOT NULL CHECK (linkKind IN ('sub-workflow', 'step-workflow', 'step-script', 'step-task', 'descendant-task')),
  n INTEGER NOT NULL DEFAULT 0,
  actualUsd REAL NOT NULL DEFAULT 0,
  keptUsd REAL NOT NULL DEFAULT 0,
  modelVersion INTEGER NOT NULL,
  computedAt TEXT NOT NULL,
  PRIMARY KEY (day, parentJobId, childKind, childJobId, linkKind)
);

CREATE INDEX IF NOT EXISTS idx_automation_savings_links_parent
  ON automation_savings_links(parentJobId, day);
