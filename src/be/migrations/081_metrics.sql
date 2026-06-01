-- Config-driven metrics. Mirrors Pages: parent table holds the current
-- definition, metric_versions stores pre-update snapshots.

CREATE TABLE IF NOT EXISTS metrics (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agentId      TEXT NOT NULL,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  definition   TEXT NOT NULL,
  createdAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agentId, slug)
);

CREATE INDEX IF NOT EXISTS idx_metrics_agentId ON metrics(agentId);
CREATE INDEX IF NOT EXISTS idx_metrics_updatedAt ON metrics(updatedAt DESC);

CREATE TABLE IF NOT EXISTS metric_versions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  metricId            TEXT NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  snapshot            TEXT NOT NULL,
  changedByAgentId    TEXT,
  createdAt           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (metricId, version)
);

CREATE INDEX IF NOT EXISTS idx_metric_versions_metricId ON metric_versions(metricId);

INSERT OR IGNORE INTO metrics (agentId, slug, title, description, definition)
VALUES
  (
    'system',
    'tasks-created-per-day',
    'Tasks created per day',
    'Daily task volume over the last 30 days.',
    '{"version":1,"viz":"timeseries","query":{"sql":"SELECT date(createdAt) AS day, COUNT(*) AS tasks FROM agent_tasks WHERE createdAt >= datetime(''now'', ''-30 days'') GROUP BY day ORDER BY day","maxRows":100},"columns":{"x":"day","y":"tasks","table":[{"key":"day","label":"Day"},{"key":"tasks","label":"Tasks","format":"integer"}]},"format":"integer","refreshSeconds":60}'
  ),
  (
    'system',
    'usage-by-user',
    'Usage by user',
    'Tasks requested and session cost by user over the last 30 days.',
    '{"version":1,"viz":"bar","query":{"sql":"SELECT COALESCE(u.name, ''Unassigned'') AS user, COUNT(DISTINCT t.id) AS tasks, ROUND(COALESCE(SUM(sc.totalCostUsd), 0), 4) AS cost_usd FROM agent_tasks t LEFT JOIN users u ON u.id = t.requestedByUserId LEFT JOIN session_costs sc ON sc.taskId = t.id WHERE t.createdAt >= datetime(''now'', ''-30 days'') GROUP BY COALESCE(u.name, ''Unassigned'') ORDER BY cost_usd DESC, tasks DESC","maxRows":100},"columns":{"x":"user","y":"cost_usd","table":[{"key":"user","label":"User"},{"key":"tasks","label":"Tasks","format":"integer"},{"key":"cost_usd","label":"Cost","format":"currency"}]},"format":"currency","refreshSeconds":60}'
  ),
  (
    'system',
    'recent-task-outcomes',
    'Recent task outcomes',
    'Task status breakdown for tasks created in the last 30 days.',
    '{"version":1,"viz":"bar","query":{"sql":"SELECT status, COUNT(*) AS tasks FROM agent_tasks WHERE createdAt >= datetime(''now'', ''-30 days'') GROUP BY status ORDER BY tasks DESC","maxRows":100},"columns":{"x":"status","y":"tasks","table":[{"key":"status","label":"Status"},{"key":"tasks","label":"Tasks","format":"integer"}]},"format":"integer","refreshSeconds":60}'
  ),
  (
    'system',
    'average-task-duration',
    'Average task duration',
    'Average finished task duration by status over the last 30 days.',
    '{"version":1,"viz":"table","query":{"sql":"SELECT status, ROUND(AVG((julianday(finishedAt) - julianday(createdAt)) * 24 * 60), 1) AS avg_minutes, COUNT(*) AS tasks FROM agent_tasks WHERE finishedAt IS NOT NULL AND createdAt >= datetime(''now'', ''-30 days'') GROUP BY status ORDER BY avg_minutes DESC","maxRows":100},"columns":{"table":[{"key":"status","label":"Status"},{"key":"avg_minutes","label":"Avg minutes","format":"duration"},{"key":"tasks","label":"Tasks","format":"integer"}]},"refreshSeconds":120}'
  );
