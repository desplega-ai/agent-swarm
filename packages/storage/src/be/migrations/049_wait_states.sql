-- 049_wait_states.sql
-- Wait Node side table for the workflow engine
--
-- Mirrors the approval_requests precedent (020_approval_requests.sql) for the
-- async-pause-and-resume pattern. A `wait` workflow node pauses execution
-- either for a fixed duration (mode='time', wakeUpAt) or until an external
-- event arrives (mode='event', eventName + eventFilter, optional expiresAt).

CREATE TABLE IF NOT EXISTS wait_states (
  id TEXT PRIMARY KEY,
  workflowRunId TEXT NOT NULL,
  workflowRunStepId TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('time', 'event')),
  wakeUpAt DATETIME,                       -- mode='time'; NULL for event mode
  eventName TEXT,                          -- mode='event'
  eventFilter JSONB,                       -- mode='event'; flat key/val match or arrow-fn body
  expiresAt DATETIME,                      -- mode='event' optional timeout
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'timeout')),
  firedPayload JSONB,                      -- payload that satisfied an event wait
  resolvedAt DATETIME,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wait_states_step ON wait_states(workflowRunStepId);
CREATE INDEX IF NOT EXISTS idx_wait_states_run ON wait_states(workflowRunId);
CREATE INDEX IF NOT EXISTS idx_wait_states_wake ON wait_states(wakeUpAt) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wait_states_expire ON wait_states(expiresAt) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wait_states_event ON wait_states(eventName) WHERE status = 'pending';
