-- One row per worker process serving a logical agent. The `agents` row stays
-- the durable identity; these rows hold only process-scoped state and are
-- written exclusively by multi-runtime registrations, so the table stays
-- empty in the default configuration.
--
-- `status` values live in Zod (RuntimeInstanceStatusSchema, src/types.ts)
-- rather than a SQL CHECK, so adding a lifecycle state later needs no table
-- rebuild — the convention agent_tasks.source adopted in migration 056.
--
-- No FK from agent_tasks: task history must survive the disappearance of
-- whatever ran it.
CREATE TABLE runtime_instances (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active',
  -- This runtime's own concurrent task capacity, self-reported at
  -- registration. Composes with, but is never an alias for, agents.maxTasks.
  reported_slots INTEGER NOT NULL DEFAULT 1,
  metadata       TEXT,
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by     TEXT,
  updated_by     TEXT
);

CREATE INDEX idx_runtime_instances_agent ON runtime_instances(agent_id);
