-- Heartbeat Reclaim (specs/tla/heartbeat/HeartbeatSimple.tla). A stalled task
-- goes back to `pending` on the same row instead of being superseded by a new
-- resume row. `attempt` counts those reclaims: it is the retry budget and the
-- compare-and-swap token of the reclaim write (`WHERE attempt = ?`).
-- 0 = never reclaimed. Rows superseded by the old heartbeat keep 0.
ALTER TABLE agent_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;

-- Unpin scans reclaimed rows waiting for their pinned agent.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_reclaimed_pending
  ON agent_tasks(lastUpdatedAt)
  WHERE status = 'pending' AND attempt > 0;
