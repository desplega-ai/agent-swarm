-- Persist the first instant at which the v2 Slack renderer became active.
--
-- The singleton is intentionally created lazily by the renderer. An empty row
-- means v2 has never been enabled, so discovery must fail closed rather than
-- treating every historical Slack task as new work.
CREATE TABLE slack_render_v2_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  activated_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by   TEXT,
  updated_by   TEXT
);
