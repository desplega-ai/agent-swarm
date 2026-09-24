-- Provenance for the assets an extension ships (scripts, schedules, and later
-- workflows and skills). One row per asset the extension created.
--
-- `seededHash` is the hash of what install wrote, excluding the enabled flag,
-- so pausing and resuming never makes a row look user-edited. A live row whose
-- hash no longer matches was edited by a user: upgrades keep it, uninstall
-- detaches it instead of deleting it.
--
-- `enabledBefore` is the state to restore when the extension is next enabled.
-- Install writes 1 (turn on at first enable); disable records the live state;
-- enable restores it and clears the column to NULL, meaning "the live row is
-- authoritative". Scripts have no enabled state and keep it NULL.
CREATE TABLE extension_assets (
  id TEXT PRIMARY KEY,
  extensionId TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('script', 'schedule', 'workflow', 'skill')),
  assetId TEXT NOT NULL,
  name TEXT NOT NULL,
  seededHash TEXT NOT NULL,
  enabledBefore INTEGER,
  created_by TEXT,
  updated_by TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extensionId, kind, name)
);

CREATE INDEX idx_extension_assets_kind_asset ON extension_assets(kind, assetId);
