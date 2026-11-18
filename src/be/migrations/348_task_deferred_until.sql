-- The wake-up ceiling `defer-task` booked (its schedule's nextRunAt, which the
-- scheduler clears once it fires), kept on the task so renderers can show
-- "resumes 04:00" in their own timezone. NULL on rows deferred before this.
ALTER TABLE agent_tasks ADD COLUMN deferredUntil TEXT;
