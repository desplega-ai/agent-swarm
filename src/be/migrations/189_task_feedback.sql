-- Human ratings of task outcomes (👍 / 👎 plus an optional note).
--
-- Provider-agnostic on purpose: Slack's outcome card writes `source = 'slack'`
-- today; the dashboard and API can write 'ui' / 'api' later without a schema
-- change. `sourceRef` is opaque JSON for the originating surface (for Slack:
-- channel and message ts). Self-improvement loops read it via `feedback-list`.
--
-- One row per rating event, never updated: a person who rates twice leaves
-- two rows, and readers take the latest per (taskId, requestedByUserId).
CREATE TABLE IF NOT EXISTS task_feedback (
  id                TEXT PRIMARY KEY,
  taskId            TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agentId           TEXT,
  rating            INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  note              TEXT,
  source            TEXT NOT NULL CHECK (source IN ('slack', 'ui', 'api')),
  sourceRef         TEXT CHECK (sourceRef IS NULL OR json_valid(sourceRef)),
  requestedByUserId TEXT,
  createdAt         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by        TEXT,
  updated_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_feedback_created ON task_feedback (createdAt);
CREATE INDEX IF NOT EXISTS idx_task_feedback_task ON task_feedback (taskId);
