-- Persist Slack message timestamps used by the watcher to update progress in place.
-- Without this, a server restart drops process-local maps and the next watcher
-- tick posts a duplicate progress/tree message in the same Slack thread.

ALTER TABLE agent_tasks ADD COLUMN slackProgressMessageTs TEXT;
ALTER TABLE agent_tasks ADD COLUMN slackTreeRootMessageTs TEXT;
