CREATE TABLE runtime_controllers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  placement TEXT NOT NULL CHECK (placement IN ('builtin', 'remote')),
  config TEXT NOT NULL DEFAULT '{}',
  secret_config TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'unknown')),
  last_seen_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE runtime_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  placements TEXT NOT NULL DEFAULT '[]',
  image TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('idle', 'per-task')),
  idle_minutes INTEGER,
  slots_per_runtime INTEGER NOT NULL DEFAULT 1,
  max_runtimes INTEGER,
  min_runtimes INTEGER NOT NULL DEFAULT 0,
  delivery TEXT CHECK (delivery IN ('poll', 'push')),
  env TEXT NOT NULL DEFAULT '{}',
  resources TEXT,
  ttl_sec INTEGER,
  resolved_image TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE agents ADD COLUMN runtime_pool_id TEXT REFERENCES runtime_pools(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN runtime_provision_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN runtime_provision_retry_at TEXT;
CREATE INDEX idx_agents_runtime_pool_id ON agents(runtime_pool_id);

ALTER TABLE agent_tasks ADD COLUMN pool_wake_at TEXT;

ALTER TABLE runtime_instances ADD COLUMN pool_id TEXT;
ALTER TABLE runtime_instances ADD COLUMN controller_id TEXT;
ALTER TABLE runtime_instances ADD COLUMN external_handle TEXT;
ALTER TABLE runtime_instances ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_instances ADD COLUMN provision_error TEXT;
ALTER TABLE runtime_instances ADD COLUMN provision_requested_at TEXT;
ALTER TABLE runtime_instances ADD COLUMN draining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_instances ADD COLUMN idle_since TEXT;
ALTER TABLE runtime_instances ADD COLUMN lease_expires_at TEXT;
ALTER TABLE runtime_instances ADD COLUMN task_id TEXT;
CREATE INDEX idx_runtime_instances_pool_id ON runtime_instances(pool_id);
