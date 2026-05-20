-- 065_profile_changed_event_type.sql
-- Widen the CHECK constraint on `user_identity_events.eventType` to include
-- `profile_changed` — emitted by PATCH /api/users/:id for non-budget,
-- non-status, non-identity, non-email-alias field edits (name, email, role,
-- emailAliases-as-a-whole already covered by email_added/removed, timezone,
-- preferredChannel, notes, metadata).
--
-- SQLite cannot ALTER a CHECK constraint in place — we follow the table-rebuild
-- recipe from migration 056_drop_agent_tasks_source_check.sql verbatim:
--   1) PRAGMA foreign_keys=off
--   2) CREATE TABLE user_identity_events_new (… new CHECK …)
--   3) INSERT … SELECT (explicit column list)
--   4) DROP old, RENAME new
--   5) Recreate the (userId, createdAt DESC) index from migration 064
--   6) PRAGMA foreign_keys=on
--
-- Keep `IdentityEventTypeSchema` in src/types.ts in lockstep with this CHECK.

PRAGMA foreign_keys=off;

CREATE TABLE user_identity_events_new (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eventType TEXT NOT NULL CHECK (eventType IN (
    'auto_merge',
    'manual_merge',
    'identity_added',
    'identity_removed',
    'email_added',
    'email_removed',
    'token_minted',
    'token_revoked',
    'budget_changed',
    'status_changed',
    'profile_changed'
  )),
  actor TEXT NOT NULL,
  beforeJson TEXT,
  afterJson TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO user_identity_events_new (
  id, userId, eventType, actor, beforeJson, afterJson, createdAt
)
SELECT
  id, userId, eventType, actor, beforeJson, afterJson, createdAt
FROM user_identity_events;

DROP TABLE user_identity_events;
ALTER TABLE user_identity_events_new RENAME TO user_identity_events;

CREATE INDEX IF NOT EXISTS idx_user_identity_events_userId_createdAt
  ON user_identity_events(userId, createdAt DESC);

PRAGMA foreign_keys=on;
