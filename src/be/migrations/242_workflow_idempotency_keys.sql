-- Idempotency-Key records for POST /api/workflows and POST /api/workflows/{id}/trigger.
--
-- One row is one operation the server accepted under a client key. It commits
-- in the same transaction as the workflow (create) or the run and its initial
-- state (trigger), so a retry after a lost response, a restart or a concurrent
-- duplicate finds it and gets the original result instead of a second
-- workflow or run.
--
-- The scope is (principal, operation, targetId, keyHash): the caller's stable
-- identity (never the bearer value), the operation, the triggered workflow id
-- ('' for create) and a SHA-256 of the client key. requestFingerprint is a
-- SHA-256 of the canonical request; a different request under the same key is
-- a conflict. responseBody is the original response, sealed (sealJson). When
-- the workflow is deleted, responseBody is cleared and resourceDeletedAt set:
-- the key stays taken and is never accepted again.
--
-- No FK to workflows: a row outlives the workflow as that tombstone.

CREATE TABLE IF NOT EXISTS workflow_idempotency_keys (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('workflow.create', 'workflow.trigger')),
  targetId TEXT NOT NULL DEFAULT '',
  keyHash TEXT NOT NULL,
  requestFingerprint TEXT NOT NULL,
  workflowId TEXT NOT NULL,
  runId TEXT,
  responseStatus INTEGER NOT NULL,
  responseBody TEXT,
  resourceDeletedAt TEXT,
  createdAt TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_idempotency_keys_scope
  ON workflow_idempotency_keys(principal, operation, targetId, keyHash);

CREATE INDEX IF NOT EXISTS idx_workflow_idempotency_keys_workflowId
  ON workflow_idempotency_keys(workflowId);
