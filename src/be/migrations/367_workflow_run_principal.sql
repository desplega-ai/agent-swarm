-- The agent a run's swarm-script and sub-workflow nodes act as, decided once
-- from the definition the run pins (JSON of `WorkflowRunPrincipal`). An edit
-- or re-save of the live workflow after the run started cannot change it.
-- Runs created before this migration keep NULL and decide from the live row.
ALTER TABLE workflow_runs ADD COLUMN principal TEXT;
