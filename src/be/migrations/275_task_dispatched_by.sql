-- The task whose session called send-task to create this one. parentTaskId
-- means context continuity (a continuation can point at an earlier worker
-- task), so it cannot say which lead turn dispatched the work. Nullable, no
-- backfill: older rows fall back to parentTaskId in the dashboard.
ALTER TABLE agent_tasks ADD COLUMN dispatchedByTaskId TEXT;

-- GET /api/sessions/{id} looks up the tasks a chain dispatched.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_dispatchedByTaskId ON agent_tasks(dispatchedByTaskId);
