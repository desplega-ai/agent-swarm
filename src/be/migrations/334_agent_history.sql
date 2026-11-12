-- Append-only history of agent deletes and restores (src/be/db/agent-history.ts).
-- A delete writes the full `agents` row here, then hard-deletes it; a restore
-- reinserts the latest `deleted` snapshot. No FK on agent_id: the row outlives
-- the agent. The triggers make the table append-only.
CREATE TABLE IF NOT EXISTS agent_history (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('deleted', 'restored')),
  -- `user:<id>` or the operator key fingerprint `op:<hex>`.
  actor_ref TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  -- SELECT * of the agents row at the event, as JSON.
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_history_agent ON agent_history(agent_id, created_at);

CREATE TRIGGER IF NOT EXISTS agent_history_no_update BEFORE UPDATE ON agent_history
BEGIN SELECT RAISE(ABORT, 'agent_history is append-only'); END;

CREATE TRIGGER IF NOT EXISTS agent_history_no_delete BEFORE DELETE ON agent_history
BEGIN SELECT RAISE(ABORT, 'agent_history is append-only'); END;
