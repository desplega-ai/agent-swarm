-- Link a one-off schedule back to the task it continues.
-- `defer-task` completes the current task and creates a wake-up schedule for
-- the same agent; the task that schedule creates carries this column as its
-- `parentTaskId`, so the wake-up run receives the deferred task's context
-- preamble (src/commands/context-preamble.ts).
-- Nullable: every schedule created by any other path leaves it NULL.
ALTER TABLE scheduled_tasks ADD COLUMN parentTaskId TEXT;
