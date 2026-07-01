-- 104_task_attachments_provider_agnostic.sql
-- Generalize task attachment metadata from agent-fs-specific pointers to
-- provider-agnostic storage references. Existing `kind` values remain stable
-- for API compatibility; provider_id/provider_key become the lookup surface
-- for /api/fs delete/replace/download routes.

ALTER TABLE task_attachments ADD COLUMN provider_id TEXT;
ALTER TABLE task_attachments ADD COLUMN provider_key TEXT;
ALTER TABLE task_attachments ADD COLUMN capabilities TEXT;

UPDATE task_attachments
SET
  provider_id = CASE
    WHEN kind = 'agent-fs' THEN 'agent-fs'
    WHEN kind = 'shared-fs' THEN 'agent-fs'
    WHEN kind = 'url' THEN 'url'
    WHEN kind = 'page' THEN 'page'
    ELSE kind
  END,
  provider_key = CASE
    WHEN kind IN ('agent-fs', 'shared-fs') THEN path
    WHEN kind = 'url' THEN url
    WHEN kind = 'page' THEN page_id
    ELSE NULL
  END
WHERE provider_id IS NULL OR provider_key IS NULL;

CREATE INDEX idx_task_attachments_provider_key
  ON task_attachments(task_id, provider_id, provider_key);
