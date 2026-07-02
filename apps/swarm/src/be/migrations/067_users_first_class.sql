-- 064_users_first_class.sql
-- "Humans as first-class users" — foundation migration.
--
-- Normalizes platform identities into a join table and lands the supporting
-- tables/columns the rest of the refactor (plan: 2026-05-18-users-first-class-refactor)
-- needs. The four previously-denormalized identity columns on `users`
-- (slackUserId / linearUserId / githubUsername / gitlabUsername — added in
-- migration 031) are backfilled into `user_external_ids` and then dropped.
--
-- Q-research refs (brainstorm 2026-05-18-humans-as-first-class-users):
--   * Q8  — `user_external_ids` schema (PK = (kind, externalId))
--   * Q15 — no-soak, same-PR DROP COLUMNs
--   * Q17.D — `unmapped` integration kv shape lives in kv_entries (no schema needed)
--   * Q19 — full event-type CHECK enum (10 types)
--   * Q20 — `user_tokens.tokenPreview` (last 4 chars of plaintext)
--
-- ORDER MATTERS:
--   1) DDL: new tables + new user columns (no FKs from drop targets)
--   2) Backfill: copy the four identity columns into user_external_ids
--   3) DROP COLUMN: remove the four identity columns from users
--
-- SQLite drops dependent UNIQUE indexes automatically when their parent
-- column is dropped (verified in CI by Automated Verification §1 in step-1).

-- ---------------------------------------------------------------------------
-- 1. user_external_ids — canonical join table for platform identities.
-- ---------------------------------------------------------------------------
--
-- PK is (kind, externalId): one external account maps to at most one swarm
-- user. Multiple identities of the same kind (e.g. two Slack workspaces) are
-- handled by the externalId prefix being workspace-scoped at the caller.
--
-- userId FK has ON DELETE CASCADE so removing a user cleans up their identity
-- mappings without manual fan-out. Mirrors `user_tokens.userId` behaviour.

CREATE TABLE IF NOT EXISTS user_external_ids (
  kind TEXT NOT NULL,
  externalId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, externalId)
);

CREATE INDEX IF NOT EXISTS idx_user_external_ids_userId
  ON user_external_ids(userId);

-- ---------------------------------------------------------------------------
-- 2. users — new columns.
-- ---------------------------------------------------------------------------
-- metadata    : free-form JSON (operator notes, integration hints, …)
-- dailyBudgetUsd : NULL = unlimited, REAL value = soft cap in USD/day
-- status      : invited → active → suspended (operator lifecycle)

ALTER TABLE users ADD COLUMN metadata TEXT;
ALTER TABLE users ADD COLUMN dailyBudgetUsd REAL;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('invited', 'active', 'suspended'));

-- ---------------------------------------------------------------------------
-- 3. user_tokens — schema lands here (Q20). Mint/revoke endpoints + UI dialog
-- ship with a separate MCP-token plan; this table is created so the scrubber
-- rule + future endpoints have a place to write.
-- ---------------------------------------------------------------------------
-- tokenHash    : sha256 of the plaintext (only thing we can search by).
-- tokenPreview : last 4 chars of the plaintext for UI display ("…ax7b").

CREATE TABLE IF NOT EXISTS user_tokens (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  tokenHash TEXT NOT NULL UNIQUE,
  tokenPreview TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUsedAt TEXT,
  revokedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_tokens_userId
  ON user_tokens(userId);

-- ---------------------------------------------------------------------------
-- 4. user_identity_events — append-only audit log of identity mutations.
-- ---------------------------------------------------------------------------
-- CHECK enum mirrors `IdentityEventTypeSchema` in src/types.ts (Q19).
-- Keep these in lockstep — drift breaks helper INSERTs at runtime.
--
-- actor : free-form identifier of the caller, e.g.
--           'system:slack-webhook'  — automatic webhook path
--           'op:<sha256-16>'        — operator (fingerprintApiKey output)
--           'user:<userId>'         — end-user action (future MCP token)

CREATE TABLE IF NOT EXISTS user_identity_events (
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
    'status_changed'
  )),
  actor TEXT NOT NULL,
  beforeJson TEXT,
  afterJson TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_identity_events_userId_createdAt
  ON user_identity_events(userId, createdAt DESC);

-- ---------------------------------------------------------------------------
-- 5. Backfill: copy the four existing identity columns into user_external_ids.
-- Must run BEFORE the DROP COLUMNs below.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO user_external_ids (userId, kind, externalId)
SELECT id, 'slack', slackUserId FROM users WHERE slackUserId IS NOT NULL
UNION ALL
SELECT id, 'linear', linearUserId FROM users WHERE linearUserId IS NOT NULL
UNION ALL
SELECT id, 'github', githubUsername FROM users WHERE githubUsername IS NOT NULL
UNION ALL
SELECT id, 'gitlab', gitlabUsername FROM users WHERE gitlabUsername IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Drop the four deprecated identity columns.
--
-- Migration 031 declared each of these with inline `UNIQUE` on the column
-- itself (separate from the partial unique indexes). SQLite refuses to
-- `DROP COLUMN` when an inline UNIQUE constraint is attached, so we do the
-- standard create-new / copy / drop / rename dance — same pattern as
-- migration 063's `pricing` and `session_costs` rewrites.
--
-- We also explicitly drop the four partial unique indexes (`idx_users_*`)
-- first; SQLite would auto-drop them with the table swap, but listing them
-- here keeps the intent obvious.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_users_slack;
DROP INDEX IF EXISTS idx_users_linear;
DROP INDEX IF EXISTS idx_users_github;
DROP INDEX IF EXISTS idx_users_gitlab;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  email TEXT,
  role TEXT,
  notes TEXT,
  emailAliases TEXT DEFAULT '[]',
  preferredChannel TEXT DEFAULT 'slack',
  timezone TEXT,
  metadata TEXT,
  dailyBudgetUsd REAL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'suspended')),
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (
  id, name, email, role, notes,
  emailAliases, preferredChannel, timezone,
  metadata, dailyBudgetUsd, status,
  createdAt, lastUpdatedAt
)
SELECT
  id, name, email, role, notes,
  emailAliases, preferredChannel, timezone,
  metadata, dailyBudgetUsd, status,
  createdAt, lastUpdatedAt
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Recreate the email index that migration 031 set up (still relevant —
-- aliases-lookup goes through the JSON path).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email IS NOT NULL;
