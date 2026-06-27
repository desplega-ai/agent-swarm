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
    'swarm-operations-overview',
    'Swarm operations overview',
    'A starter dashboard mixing raw SQL widgets with chart and table visualizations.',
    '{"version":1,"refreshSeconds":60,"layout":{"columns":2},"variables":[{"key":"rangeModifier","label":"Time range","type":"select","defaultValue":"-30 days","options":[{"label":"Last 7 days","value":"-7 days"},{"label":"Last 30 days","value":"-30 days"},{"label":"Last 90 days","value":"-90 days"}]},{"key":"userFilter","label":"Requester user ID or name","type":"text","defaultValue":""},{"key":"agentFilter","label":"Agent ID","type":"text","defaultValue":""}],"widgets":[{"id":"open-tasks","title":"Open tasks","description":"Tasks that are not terminal.","query":{"sql":"SELECT COUNT(*) AS open_tasks FROM agent_tasks WHERE status NOT IN (''completed'', ''failed'', ''cancelled'', ''superseded'')","maxRows":10},"viz":{"type":"stat","value":"open_tasks","format":"integer"}},{"id":"tasks-created-per-day","title":"Tasks created per day","description":"Daily task volume for the selected time range.","query":{"sql":"SELECT date(createdAt) AS day, COUNT(*) AS tasks FROM agent_tasks WHERE createdAt >= datetime(''now'', ?) GROUP BY day ORDER BY day","params":["{{rangeModifier}}"],"maxRows":100},"viz":{"type":"line","x":"day","y":"tasks","format":"integer","columns":[{"key":"day","label":"Day"},{"key":"tasks","label":"Tasks","format":"integer"}]}},{"id":"usage-by-user","title":"Usage by user","description":"Tasks requested and session cost by user for the selected time range, requester filter, and agent filter.","query":{"sql":"SELECT COALESCE(u.name, ''Unassigned'') AS user, COUNT(DISTINCT t.id) AS tasks, ROUND(COALESCE(SUM(sc.totalCostUsd), 0), 4) AS cost_usd FROM agent_tasks t LEFT JOIN users u ON u.id = t.requestedByUserId LEFT JOIN session_costs sc ON sc.taskId = t.id WHERE t.createdAt >= datetime(''now'', ?) AND (? = '''' OR COALESCE(u.id, '''') = ? OR COALESCE(u.name, '''') LIKE ''%'' || ? || ''%'') AND (? = '''' OR COALESCE(t.agentId, '''') = ?) GROUP BY COALESCE(u.name, ''Unassigned'') ORDER BY cost_usd DESC, tasks DESC","params":["{{rangeModifier}}","{{userFilter}}","{{userFilter}}","{{userFilter}}","{{agentFilter}}","{{agentFilter}}"],"maxRows":100},"viz":{"type":"bar","x":"user","y":"tasks","format":"integer","columns":[{"key":"user","label":"User"},{"key":"tasks","label":"Tasks","format":"integer"},{"key":"cost_usd","label":"Cost","format":"currency"}]}},{"id":"task-outcomes-by-day","title":"Task outcomes by day","description":"Completed and failed tasks for the selected time range.","query":{"sql":"SELECT date(finishedAt) AS day, SUM(CASE WHEN status = ''completed'' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = ''failed'' THEN 1 ELSE 0 END) AS failed FROM agent_tasks WHERE finishedAt IS NOT NULL AND finishedAt >= datetime(''now'', ?) GROUP BY day ORDER BY day","params":["{{rangeModifier}}"],"maxRows":100},"viz":{"type":"multi-line","x":"day","series":["completed","failed"],"format":"integer","columns":[{"key":"day","label":"Day"},{"key":"completed","label":"Completed","format":"integer"},{"key":"failed","label":"Failed","format":"integer"}]}},{"id":"recent-task-outcomes","title":"Recent task outcomes","description":"Task status breakdown for tasks created in the selected time range.","query":{"sql":"SELECT status, COUNT(*) AS tasks FROM agent_tasks WHERE createdAt >= datetime(''now'', ?) GROUP BY status ORDER BY tasks DESC","params":["{{rangeModifier}}"],"maxRows":100},"viz":{"type":"table","columns":[{"key":"status","label":"Status"},{"key":"tasks","label":"Tasks","format":"integer"}]}}]}'
  );
