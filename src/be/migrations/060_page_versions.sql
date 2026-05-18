-- DB-backed Pages (history table). Mirrors workflow_versions
-- (008_workflow_redesign.sql:74-82) — parent table holds CURRENT state, this
-- table holds the pre-update snapshot taken by snapshotPage() before each
-- updatePage(). Head pointer is derived from MAX(version); no head_version
-- column on the parent.
--
-- ON DELETE CASCADE: deleting a page removes its version history.

CREATE TABLE IF NOT EXISTS page_versions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pageId              TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  snapshot            TEXT NOT NULL,  -- JSON: PageSnapshot
  changedByAgentId    TEXT,
  createdAt           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pageId, version)
);

CREATE INDEX IF NOT EXISTS idx_page_versions_pageId ON page_versions(pageId);
