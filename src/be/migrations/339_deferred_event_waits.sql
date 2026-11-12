-- Deferrals can wake on a GitHub PR event as well as a task outcome. This table
-- is a sibling of deferred_task_waits (150): that table's kind CHECK would need
-- a rebuild to take a new event, so PR waits live here and the old one stays
-- untouched. Same shape otherwise: one wait per one-time schedule, the
-- schedule's ceiling stays the deadline, and a claim flips pending to fired.
-- Both kinds are listed now so the checks-done wake needs no rebuild.
CREATE TABLE IF NOT EXISTS deferred_event_waits (
  scheduleId TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pr.merged', 'pr.checks_done')),
  repo TEXT NOT NULL,
  prNumber INTEGER NOT NULL,
  headSha TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired')),
  firedBy TEXT,
  childTaskId TEXT,
  resolvedAt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_deferred_event_waits_pending
  ON deferred_event_waits(repo, prNumber) WHERE status = 'pending';
