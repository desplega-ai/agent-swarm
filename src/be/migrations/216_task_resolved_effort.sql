-- The reasoning effort a task's session actually ran at. `effort` stays the
-- requested value (a task-level pin); the effective one usually comes from the
-- agent's REASONING_EFFORT_OVERRIDE and was never recorded. NULL means the
-- harness default applied, or the row predates this column.
ALTER TABLE agent_tasks ADD COLUMN resolvedEffort TEXT;
