-- New columns for TTL, access tracking, and embedding model
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN embeddingModel TEXT;

-- Index for TTL queries (filtering expired memories)
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires
  ON agent_memory(expiresAt);
