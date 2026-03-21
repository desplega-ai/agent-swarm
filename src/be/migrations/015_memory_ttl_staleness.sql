-- Memory TTL, access tracking, and staleness management
-- See: thoughts/plans/memory-ttl-implementation-plan.md

-- Access count for reranking signal
ALTER TABLE agent_memory ADD COLUMN accessCount INTEGER DEFAULT 0;

-- Soft expiry timestamp (memories excluded from search after this date)
ALTER TABLE agent_memory ADD COLUMN expiresAt TEXT;

-- Content hash for file_index drift detection
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;

-- Stale flag (excluded from search when set)
ALTER TABLE agent_memory ADD COLUMN stale INTEGER DEFAULT 0;

-- Partial index: only index rows that have an expiry set (file_index has no TTL)
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires
  ON agent_memory(expiresAt) WHERE expiresAt IS NOT NULL;

-- Partial index: only index stale rows (expected to be rare)
CREATE INDEX IF NOT EXISTS idx_agent_memory_stale
  ON agent_memory(stale) WHERE stale = 1;
