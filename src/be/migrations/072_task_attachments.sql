-- 072_task_attachments.sql
-- Phase 1: pointer-based task attachments.
--
-- Agents attach artifacts to a task via `store-progress`. Attachments are
-- POINTERS only — no inline blobs:
--   - kind='agent-fs'   : `path` points at an agent-fs file
--   - kind='url'        : `url` is an external URL
--   - kind='shared-fs'  : `path` points at a shared filesystem location
--   - kind='page'       : `page_id` references a swarm Page
--
-- `agent_tasks` is intentionally UNTOUCHED — attachments are joined in at read
-- time. Append-only in Phase 1 (no update / delete tool surface). `intent`
-- captures *why* the attachment exists (distinct from `description` = what it
-- is). `ON DELETE CASCADE` is the only delete path and ties cleanup to task
-- deletion, not an attachment-edit API.
CREATE TABLE task_attachments (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agent_id     TEXT,                          -- agent that added it (nullable)
  name         TEXT NOT NULL,                 -- display name
  kind         TEXT NOT NULL CHECK (kind IN ('agent-fs','url','shared-fs','page')),
  url          TEXT,                          -- kind='url'
  path         TEXT,                          -- kind='agent-fs' or 'shared-fs'
  page_id      TEXT,                          -- kind='page'
  mime_type    TEXT,
  size_bytes   INTEGER,                       -- optional metadata only (no enforcement)
  sha256       TEXT,
  intent       TEXT,                          -- WHY this attachment exists
  description  TEXT,                          -- optional: what it is
  is_primary   INTEGER NOT NULL DEFAULT 0,
  -- ISO-8601 UTC (T separator, trailing Z) so rows satisfy the
  -- `z.iso.datetime()` shape on `TaskAttachmentSchema.createdAt`. Plain
  -- `datetime('now')` yields a space-separated, Z-less string that fails
  -- that validator. Matches the `session_costs` insert convention.
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_task_attachments_task ON task_attachments(task_id);
CREATE INDEX idx_task_attachments_sha  ON task_attachments(sha256) WHERE sha256 IS NOT NULL;
