-- Track API key pool status for rate limit awareness and automatic rotation
CREATE TABLE IF NOT EXISTS api_key_status (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  -- Which credential type: 'CLAUDE_CODE_OAUTH_TOKEN' or 'ANTHROPIC_API_KEY'
  keyType TEXT NOT NULL,
  -- Last 5 characters of the key (for identification without storing secrets)
  keySuffix TEXT NOT NULL,
  -- Position in the comma-separated credential pool (0-based)
  keyIndex INTEGER NOT NULL,
  -- Scope mirrors swarm_config (global, agent, repo)
  scope TEXT NOT NULL DEFAULT 'global',
  scopeId TEXT NOT NULL DEFAULT '',
  -- Current status
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'rate_limited')),
  -- When the rate limit expires (ISO timestamp from retry-after)
  rateLimitedUntil TEXT,
  -- Tracking timestamps
  lastUsedAt TEXT,
  lastRateLimitAt TEXT,
  -- Counters
  totalUsageCount INTEGER NOT NULL DEFAULT 0,
  rateLimitCount INTEGER NOT NULL DEFAULT 0,
  -- Metadata
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Unique constraint: one entry per key type + suffix + scope.
  -- Known limitation: two different keys sharing the same last 5 chars will collide,
  -- causing the ON CONFLICT upsert to overwrite keyIndex. In practice this is rare
  -- (1 in ~60M for random alphanumeric suffixes) and the impact is minor (wrong index
  -- logged, but rate-limit tracking still works since suffix is the real identifier).
  UNIQUE(keyType, keySuffix, scope, scopeId)
);

CREATE INDEX IF NOT EXISTS idx_api_key_status_lookup
  ON api_key_status(keyType, scope, scopeId, status);

-- Track which key was used per task (last 5 chars only)
ALTER TABLE agent_tasks ADD COLUMN credentialKeySuffix TEXT;
