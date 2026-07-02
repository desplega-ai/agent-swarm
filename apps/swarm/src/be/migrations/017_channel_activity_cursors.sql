-- Track last-seen Slack message per channel for channel_activity poll trigger
CREATE TABLE IF NOT EXISTS channel_activity_cursors (
  channelId TEXT PRIMARY KEY,
  lastSeenTs TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
