-- The task whose session launched a durable script run (the caller's
-- X-Source-Task-Id, kept only when that task belongs to the launching agent).
-- The follow-up re-delegation guard reads it when the run's ctx.step.agentTask
-- dispatches, the same way send-task reads the caller's source task.
ALTER TABLE script_runs ADD COLUMN sourceTaskId TEXT;
