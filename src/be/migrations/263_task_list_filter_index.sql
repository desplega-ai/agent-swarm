-- Covering index for the default task list count (getTasksCount in
-- src/be/db/tasks/read.ts). The task list hides heartbeat tasks by default:
--
--   IFNULL(taskType, '') NOT IN (...) AND tags NOT LIKE '%"heartbeat"%'
--
-- A NOT IN and a NOT LIKE cannot seek, so the count scans. taskType and tags
-- sit after the large `task` text, in the overflow pages, so the scan read
-- every task body. This index holds the two filter columns and `id` (the
-- session visibility filter), so the count scans the index only.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_list_filter
  ON agent_tasks(taskType, tags, id);
