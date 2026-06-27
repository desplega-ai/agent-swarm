-- Cross-process mutex for OAuth refresh-token rotation.
CREATE TABLE IF NOT EXISTS oauth_refresh_locks (
  provider  TEXT PRIMARY KEY,
  owner     TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
