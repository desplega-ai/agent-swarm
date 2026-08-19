-- Multi-runtime support: one logical agent may be served by several worker
-- processes at once.
--
-- `runtime_instances` holds one row per worker process serving an agent. The
-- `agents` row stays the durable identity; these rows carry only
-- process-scoped state (self-reported capacity and liveness) and are written
-- exclusively while MULTI_RUNTIME_ENABLED is set, so the table stays empty in
-- the default configuration. Rows are retired and pruned through the runtime
-- lifecycle rather than kept as history.
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
  -- Credential readiness is process-local: one runtime waiting on credentials
  -- must not disable a ready sibling. NULL means "never reported" (e.g.
  -- CRED_CHECK_DISABLE), which counts as ready so those workers stay usable.
  credential_ready INTEGER,
  metadata       TEXT,
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by     TEXT,
  updated_by     TEXT
);

CREATE INDEX idx_runtime_instances_agent ON runtime_instances(agent_id);

-- Record which runtime owns each session so a starting worker clears only its
-- own leftovers instead of deleting a sibling's live session (which would
-- requeue a task another process is still executing). Nullable: pre-existing
-- rows and single-runtime deployments keep the agent-wide semantics.
ALTER TABLE active_sessions ADD COLUMN runtimeInstanceId TEXT;

CREATE INDEX idx_active_sessions_runtime ON active_sessions(runtimeInstanceId);
