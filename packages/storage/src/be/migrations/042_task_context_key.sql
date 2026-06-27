-- Add a uniform context_key column on tasks for cross-ingress sibling awareness.
-- See src/tasks/context-key.ts for the key schema.
-- Nullable: historical rows stay NULL, new ingress paths populate it going forward.
ALTER TABLE agent_tasks ADD COLUMN contextKey TEXT;

-- Plain btree index for generic lookups by context key.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_context_key
  ON agent_tasks(contextKey);

-- Composite index supporting the "in-progress sibling" lookup pattern:
-- WHERE contextKey = ? AND status IN (...).
CREATE INDEX IF NOT EXISTS idx_agent_tasks_context_key_status
  ON agent_tasks(contextKey, status);
