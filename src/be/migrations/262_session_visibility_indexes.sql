-- Covering indexes for the session visibility walk (readableSessionCondition
-- in src/be/db/tasks/read.ts). Every task list and count a dashboard user
-- loads computes the set of tasks in sessions the user cannot read: roots
-- owned by someone else, plus all their descendants.
--
-- agent_tasks rows carry large `task` text, and parentTaskId, scheduleId and
-- requestedByUserId sit after it, in the overflow pages. Without these
-- indexes the root step read every unscheduled task row and the recursive
-- step read the row of every descendant. With them, both steps stay in the
-- index. Production has no sqlite_stat1; the planner picks both without it.

-- Root step: `scheduleId IS NULL` plus the root, owner and id columns.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session_owner
  ON agent_tasks(scheduleId, parentTaskId, requestedByUserId, id);

-- Recursive step: the children of a hidden task, by id.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parentTaskId_id
  ON agent_tasks(parentTaskId, id);
