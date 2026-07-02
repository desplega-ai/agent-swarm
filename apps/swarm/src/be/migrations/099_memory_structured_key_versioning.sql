-- Memory editing/versioning substrate.

ALTER TABLE agent_memory ADD COLUMN key TEXT;
ALTER TABLE agent_memory ADD COLUMN contentHash TEXT;
ALTER TABLE agent_memory ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_memory ADD COLUMN updatedAt TEXT;

UPDATE agent_memory
SET updatedAt = createdAt
WHERE updatedAt IS NULL;

UPDATE agent_memory
SET key = CASE
    WHEN sourcePath IS NOT NULL AND length(sourcePath) > 0 THEN sourcePath
    ELSE scope || '/' || source || '/' || id
END
WHERE key IS NULL;

CREATE TABLE IF NOT EXISTS agent_memory_version (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    contentHash TEXT,
    intent TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('create', 'edit', 'replace')),
    changedByAgentId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    UNIQUE(memory_id, version),
    FOREIGN KEY(memory_id) REFERENCES agent_memory(id) ON DELETE CASCADE
);

CREATE INDEX idx_amv_memory ON agent_memory_version(memory_id, version DESC);
CREATE INDEX idx_amv_hash ON agent_memory_version(contentHash);

CREATE UNIQUE INDEX idx_agent_memory_key
ON agent_memory(scope, COALESCE(agentId, ''), key, chunkIndex)
WHERE key IS NOT NULL;
