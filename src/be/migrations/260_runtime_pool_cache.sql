-- NULL preserves the ephemeral-only behavior of existing pools.
ALTER TABLE runtime_pools ADD COLUMN cache TEXT
  CHECK (cache IS NULL OR json_valid(cache));

-- Retain release intent across API restarts and pool deletion.
CREATE TABLE runtime_cache_releases (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  controller_id TEXT NOT NULL REFERENCES runtime_controllers(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  runtime_ids TEXT NOT NULL CHECK (json_valid(runtime_ids) AND json_type(runtime_ids) = 'array'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(controller_id, owner_id, cache_key)
);
