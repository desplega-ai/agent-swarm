-- Task deferrals retain their one-time schedule as the deadline. This sibling
-- to workflow wait_states arbitrates event/deadline dispatch without inventing
-- a workflow run or step for an ordinary task.
CREATE TABLE IF NOT EXISTS deferred_task_waits (
  scheduleId TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  taskId TEXT NOT NULL,
  eventName TEXT NOT NULL CHECK (eventName IN ('task.completed', 'task.failed', 'settled')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired')),
  firedBy TEXT,
  childTaskId TEXT,
  resolvedAt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_deferred_task_waits_pending
  ON deferred_task_waits(taskId) WHERE status = 'pending';
