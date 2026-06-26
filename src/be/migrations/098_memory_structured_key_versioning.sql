-- Phase 2: In-place editing + versioning + structured key
-- Adds key, contentHash, version, updatedAt to agent_memory
-- Creates agent_memory_version audit ledger

ALTER TABLE agent_memory ADD COLUMN key TEXT;
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;
ALTER TABLE agent_memory ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_memory ADD COLUMN updatedAt TEXT;

-- Backfill updatedAt from createdAt
UPDATE agent_memory SET updatedAt = createdAt WHERE updatedAt IS NULL;

-- Backfill key from sourcePath where available, else scope/source/id
UPDATE agent_memory SET key = sourcePath WHERE key IS NULL AND sourcePath IS NOT NULL;
UPDATE agent_memory SET key = scope || '/' || source || '/' || id WHERE key IS NULL;

-- Version audit ledger
CREATE TABLE agent_memory_version (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  contentHash TEXT,
  intent TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'edit', 'replace')),
  changedByAgentId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(memory_id, version),
  FOREIGN KEY (memory_id) REFERENCES agent_memory(id) ON DELETE CASCADE
);

CREATE INDEX idx_amv_memory ON agent_memory_version(memory_id, version DESC);
CREATE INDEX idx_amv_hash ON agent_memory_version(contentHash);

-- Unique index on key (per scope/agent/chunk) — applied after backfill
CREATE UNIQUE INDEX idx_agent_memory_key ON agent_memory(scope, COALESCE(agentId, ''), key, chunkIndex) WHERE key IS NOT NULL;
