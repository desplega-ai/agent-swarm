-- Idempotency-Key records for POST /api/tasks.
--
-- One row is one task the server created under a client key. It commits in the
-- same transaction as the task, so a retry after a lost response finds it and
-- gets that task back instead of creating a second one (the Sessions composer
-- retries a failed follow-up with the key it first sent).
--
-- The scope is (principal, keyHash): the caller's stable identity (never the
-- bearer value) and a SHA-256 of the client key. requestFingerprint is a
-- SHA-256 of the canonical request; a different request under the same key is
-- a conflict. A replay answers with the task as it is now, read by taskId.
--
-- No FK to agent_tasks: a row outlives a deleted task, and the key stays taken.

CREATE TABLE IF NOT EXISTS task_idempotency_keys (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  keyHash TEXT NOT NULL,
  requestFingerprint TEXT NOT NULL,
  taskId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_idempotency_keys_scope
  ON task_idempotency_keys(principal, keyHash);
