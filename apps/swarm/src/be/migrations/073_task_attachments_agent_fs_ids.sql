-- 073_task_attachments_agent_fs_ids.sql
-- Phase 2a follow-up: agent-fs `<org_id>/<drive_id>` columns on task_attachments.
--
-- The Phase 1 schema stores only the agent-fs `path`, so the Slack/UI renderers
-- have no way to build a public live-host URL like
--   ${AGENT_FS_LIVE_URL}/file/~/<org_id>/<drive_id>/<path>
-- and fall back to the opaque `agent-fs:<path>` string instead. This adds the
-- two missing columns so the renderers can emit clickable links.
--
-- Both columns are NULLABLE so existing rows stay valid and so non-agent-fs
-- kinds (`url`, `shared-fs`, `page`) are unaffected. No index — these columns
-- are always paired with a `task_id` filter (the resolver runs after the row
-- has already been located).
ALTER TABLE task_attachments ADD COLUMN agent_fs_org_id   TEXT;
ALTER TABLE task_attachments ADD COLUMN agent_fs_drive_id TEXT;
