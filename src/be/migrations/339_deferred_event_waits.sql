-- Deferrals can wake on an external event (a VCS or tracker webhook) as well as
-- a task outcome. This table is a sibling of deferred_task_waits (150): that
-- table's eventName CHECK would need a rebuild to take a new event, so external
-- waits live here and the old one stays untouched. Same shape otherwise: one
-- wait per one-time schedule, the schedule's ceiling stays the deadline, and a
-- claim flips pending to fired.
-- Provider-neutral on purpose: `source` and `event` are plain text (no CHECK) and
-- the target is a canonical `matchKey` plus its `matchJson`, both produced by the
-- source's adapter in src/event-waits/. A new provider adds an adapter, not a migration.
CREATE TABLE IF NOT EXISTS deferred_event_waits (
  scheduleId TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event TEXT NOT NULL,
  matchKey TEXT NOT NULL,
  matchJson TEXT NOT NULL,
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
  ON deferred_event_waits(source, event, matchKey) WHERE status = 'pending';
