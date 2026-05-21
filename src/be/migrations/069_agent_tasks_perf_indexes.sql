-- Performance indexes for agent_tasks (Q2 from Linear-fast-UI research).
--
-- Without these, every tasks-list query does a full-table sort (SCAN + USE TEMP B-TREE
-- FOR ORDER BY) and the /status createdAt filter is a full-table scan. With 10k+ rows
-- these are the dominant per-poll costs.

-- Covers: getAllTasks ORDER BY lastUpdatedAt DESC
CREATE INDEX IF NOT EXISTS idx_agent_tasks_last_updated
  ON agent_tasks(lastUpdatedAt DESC);

-- Covers: getInstanceActivity WHERE createdAt >= ... (the /status activity strip)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created
  ON agent_tasks(createdAt);

-- Covers: status-filtered list views ORDER BY lastUpdatedAt DESC (avoids B-TREE sort on top of idx_agent_tasks_status)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_last_updated
  ON agent_tasks(status, lastUpdatedAt DESC);
