-- Operator-only agent soft delete (src/be/db/agent-lifecycle.ts). A deleted
-- agent keeps its row so restore is lossless; `deleted_at` hides it from every
-- listing, routing and dispatch path (NOT_DELETED_AGENT_SQL).
ALTER TABLE agents ADD COLUMN deleted_at TEXT;
-- The canonical user who deleted it; NULL for the shared operator key.
ALTER TABLE agents ADD COLUMN deleted_by TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_agents_deleted_at ON agents(deleted_at) WHERE deleted_at IS NOT NULL;
-- deleteUser rewrites user references; keep that an index search.
CREATE INDEX IF NOT EXISTS idx_agents_deleted_by ON agents(deleted_by) WHERE deleted_by IS NOT NULL;

-- Append-only audit of deletes and restores. No FK on agent_id so the trail
-- outlives a future purge. Never swept by db-retention.
CREATE TABLE IF NOT EXISTS agent_lifecycle_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('deleted', 'restored')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'operator')),
  -- `user:<id>` or the operator key fingerprint `op:<hex>`; survives user deletion.
  actor_ref TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_agent
  ON agent_lifecycle_events(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_events_created_by
  ON agent_lifecycle_events(created_by) WHERE created_by IS NOT NULL;
