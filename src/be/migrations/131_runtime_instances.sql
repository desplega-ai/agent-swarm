-- Runtime instances: one row per worker process currently serving a logical
-- agent. The `agents` row remains the durable logical identity (role, config,
-- task eligibility, maxTasks policy); a runtime instance is one execution
-- environment attached to it, carrying only process-scoped state.
--
-- Rows are written exclusively by multi-runtime registrations
-- (MULTI_RUNTIME_ENABLED=true). In the default configuration nothing writes
-- this table, so existing single-runtime deployments are unaffected.
--
-- `status` values live in Zod (RuntimeInstanceStatusSchema, src/types.ts) —
-- no SQL CHECK, so future lifecycle states don't require a table rebuild
-- (same convention as agent_tasks.source, see migration 056).
--
-- No FK from agent_tasks to this table: task history must survive the
-- disappearance of whatever ran it. The agents FK follows the
-- active_sessions precedent (CASCADE on agent delete).
CREATE TABLE runtime_instances (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active',
  -- Runtime-local concurrent task capacity, self-reported at registration.
  -- Distinct from agents.maxTasks (the logical concurrency policy): the two
  -- compose but are never aliases in multi-runtime mode.
  reported_slots INTEGER NOT NULL DEFAULT 1,
  metadata       TEXT,
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by     TEXT,
  updated_by     TEXT
);

CREATE INDEX idx_runtime_instances_agent ON runtime_instances(agent_id);
