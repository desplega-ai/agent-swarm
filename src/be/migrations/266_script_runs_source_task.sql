-- The task whose session launched a durable script run (the caller's
-- X-Source-Task-Id, kept only when that task belongs to the launching agent).
-- The follow-up re-delegation guard reads it when the run's ctx.step.agentTask
-- dispatches, the same way send-task reads the caller's source task.
ALTER TABLE script_runs ADD COLUMN sourceTaskId TEXT;

-- The run's follow-up re-delegation guard decision, taken once for the whole
-- run at its first new step: NULL (not decided yet), 'passed', or the rule that
-- blocked it ('same-work' or 'loop-cap'). Every later step follows it, so
-- parallel steps of one run are dispatched all or none.
ALTER TABLE script_runs ADD COLUMN followUpGuard TEXT;
