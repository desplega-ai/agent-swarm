-- Resumable background user merges.
--
-- Incident 2026-11-09: POST /api/users/{id}/merge ran deleteUser(source,
-- target) in one transaction and froze the API for 278 s on an 85 GB
-- production database (every statement is synchronous bun:sqlite on the event
-- loop). Migration 319 added the indexes; this migration moves the attribution
-- rewrite out of the request.
--
-- The route now does the short part in one transaction (identities, email
-- aliases, guards, the manual_merge event) and queues a user_merge_jobs row.
-- A runner (src/be/user-merge-jobs.ts) rewrites the user FK columns in small
-- batches, each in its own transaction, yielding between batches, then deletes
-- the source row. A failed batch is retried with a bounded backoff (attempts,
-- nextAttemptAt); after the attempt cap the job is marked failed and a repeat
-- POST of the same merge re-queues it. On boot the runner re-queues jobs the
-- previous process left running, so an API restart mid-merge continues where
-- the last committed batch stopped.
--
-- users.mergedIntoUserId marks the source while the job runs: such a user can
-- no longer authenticate and identity lookups resolve to the target instead.
-- No FK: the column is cleared with the row when the job deletes the source,
-- and the discovery query in deleteUser must not rewrite it.
--
-- sourceUserId / targetUserId carry no FK either: the job outlives the source
-- row by design, and the status index is what the runner and the UI poll.

CREATE TABLE IF NOT EXISTS user_merge_jobs (
  id TEXT PRIMARY KEY,
  sourceUserId TEXT NOT NULL,
  targetUserId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- Current step: 'workflow-context', '<table>.<column>' or 'delete-user'.
  phase TEXT,
  -- JSON object: rows rewritten per step, keyed like phase.
  progress TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  -- Times the runner claimed the job; capped by USER_MERGE_MAX_ATTEMPTS.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Set after a failed attempt: the runner skips the job until this time.
  nextAttemptAt TEXT,
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_merge_jobs_status ON user_merge_jobs(status);
CREATE INDEX IF NOT EXISTS idx_user_merge_jobs_created_by ON user_merge_jobs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_merge_jobs_updated_by ON user_merge_jobs(updated_by) WHERE updated_by IS NOT NULL;

ALTER TABLE users ADD COLUMN mergedIntoUserId TEXT;
