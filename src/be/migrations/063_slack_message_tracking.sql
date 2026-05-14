-- 063_slack_message_tracking.sql
--
-- Persist the Slack message timestamps used by the watcher to update progress
-- in place. Previously these lived only in process-local maps in
-- `src/slack/watcher.ts` (`treeMessages`, `taskToTree`, `taskMessages`), so a
-- redeploy mid-flight would orphan the original Slack message and the next
-- tick would post a new one — producing duplicate progress trees in the same
-- thread (see RCA 2026-05-13).
--
-- Two nullable columns — null is fine for historical tasks (no backfill).
-- The watcher hydrates these on boot for tasks still `in_progress` so the
-- next progress tick calls `chat.update` against the original message instead
-- of `chat.postMessage`.
--
-- Forward-only.

ALTER TABLE agent_tasks ADD COLUMN slackProgressMessageTs TEXT;
ALTER TABLE agent_tasks ADD COLUMN slackTreeRootMessageTs TEXT;
