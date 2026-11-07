-- Covering index for the Slack render-v2 watcher sweep (getSlackTreeMessages
-- in src/be/db.ts), which runs on every watcher tick, even when idle. For
-- each stored tree it tests the thread's tasks by createdAt, status, source
-- and lastUpdatedAt. Those columns sit after the large `task` text, in the
-- overflow pages, so each test read whole task rows. This index holds them,
-- so the tests stay in the index. Partial: only Slack tasks carry a channel.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_slack_thread_cover
  ON agent_tasks(slackChannelId, slackThreadTs, createdAt, status, source, lastUpdatedAt, id)
  WHERE slackChannelId IS NOT NULL;
