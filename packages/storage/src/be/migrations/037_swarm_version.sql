-- Stamp agent-swarm version on each task at creation time.
-- Enables benchmarking performance (cost, duration, tokens, etc.) across releases.
-- Existing rows stay NULL; benchmark queries should filter WHERE swarmVersion IS NOT NULL.
ALTER TABLE agent_tasks ADD COLUMN swarmVersion TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_swarmVersion
  ON agent_tasks(swarmVersion);
