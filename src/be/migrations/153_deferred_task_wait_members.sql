-- One claim and deadline per wait; each member independently follows deferrals.
ALTER TABLE deferred_task_waits ADD COLUMN mode TEXT NOT NULL DEFAULT 'all'
  CHECK (mode IN ('all', 'any'));

CREATE TABLE deferred_task_wait_members (
  scheduleId TEXT NOT NULL REFERENCES deferred_task_waits(scheduleId) ON DELETE CASCADE,
  taskId TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY (scheduleId, taskId)
);
CREATE INDEX idx_deferred_task_wait_members_task ON deferred_task_wait_members(taskId);

-- Preserve pending and fired legacy waits, including already-retargeted IDs.
INSERT INTO deferred_task_wait_members
  (scheduleId, taskId, created_at, updated_at, created_by, updated_by)
SELECT scheduleId, taskId, created_at, updated_at, created_by, updated_by
FROM deferred_task_waits;

DROP INDEX idx_deferred_task_waits_pending;
ALTER TABLE deferred_task_waits DROP COLUMN taskId;
CREATE INDEX idx_deferred_task_waits_pending
  ON deferred_task_waits(scheduleId) WHERE status = 'pending';
