-- Keep primitive_objects in sync with agent-fs through its signed
-- `file.changed` webhook (src/be/primitives/object-webhooks.ts).

-- Set when agent-fs reports the file deleted. The row is kept: a revert or a
-- move can bring the file back, and object-list hides tombstoned rows.
ALTER TABLE primitive_objects ADD COLUMN deletedAt TEXT;

-- One agent-fs webhook subscription per drive that holds objects. The row id is
-- the receiver URL's last segment, so a delivery finds its secret by URL.
CREATE TABLE IF NOT EXISTS agent_fs_object_webhooks (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  driveId TEXT NOT NULL,
  -- agent-fs subscription id; NULL until registration succeeds.
  subscriptionId TEXT,
  -- Receiver URL registered with agent-fs.
  url TEXT,
  -- whsec_ signing secret, encrypted with the swarm secrets key.
  secretCiphertext TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  lastError TEXT,
  -- Lease for the replica that is registering; NULL when none is.
  claimedAt TEXT,
  attemptedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (orgId, driveId)
);

-- deleteUser rewrites the audit columns; keep that an index search.
CREATE INDEX IF NOT EXISTS idx_agent_fs_object_webhooks_created_by
  ON agent_fs_object_webhooks(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_fs_object_webhooks_updated_by
  ON agent_fs_object_webhooks(updated_by) WHERE updated_by IS NOT NULL;
