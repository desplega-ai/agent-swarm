-- Persist what `defer-task` was actually ASKED for, alongside the derived
-- `nextRunAt`. The scheduler nulls `nextRunAt` once a one_time schedule fires,
-- so without these columns the requested-delay distribution is unrecoverable
-- after the wake-up runs.
--
-- Exactly one of the two is ever set (defer-task rejects both/neither), and
-- neither is read by the scheduler — they are write-once provenance.
ALTER TABLE scheduled_tasks ADD COLUMN requestedDelayMs INTEGER;
ALTER TABLE scheduled_tasks ADD COLUMN requestedRunAt TEXT;

-- Marks a task that ENDED in a deferral, so renderers can tell "parked" from
-- "done" on a row whose status is `completed` either way.
--
-- The `deferred` tag cannot answer this: `defer-task` adds it to the deferring
-- task, and the wake-up task it schedules inherits the same tag — so a wake-up
-- child that simply finished is tag-identical to one that deferred again.
ALTER TABLE agent_tasks ADD COLUMN deferredAt TEXT;

-- Set once a deferral's ⏳ outcome card has been rewritten into its resolved
-- state, so the resolution pass rewrites each card exactly once instead of on
-- every render tick.
ALTER TABLE slack_messages ADD COLUMN deferral_resolved_at TEXT;
