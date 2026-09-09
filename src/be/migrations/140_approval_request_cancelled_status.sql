-- Approval requests attached to cancelled workflow runs must become terminal too.
-- SQLite cannot alter a CHECK constraint in place, so recreate the table.

CREATE TABLE approval_requests_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  questions JSONB NOT NULL,
  workflowRunId TEXT,
  workflowRunStepId TEXT,
  sourceTaskId TEXT,
  approvers JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'timeout', 'cancelled')),
  responses JSONB,
  resolvedBy TEXT,
  resolvedAt DATETIME,
  resolutionReason TEXT,
  cancellationNotificationClaims JSONB,
  timeoutSeconds INTEGER,
  expiresAt DATETIME,
  notificationChannels JSONB,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

INSERT INTO approval_requests_new (
  id, title, questions, workflowRunId, workflowRunStepId, sourceTaskId,
  approvers, status, responses, resolvedBy, resolvedAt, resolutionReason,
  cancellationNotificationClaims,
  timeoutSeconds, expiresAt, notificationChannels, createdAt, updatedAt,
  created_by, updated_by
)
SELECT
  id, title, questions, workflowRunId, workflowRunStepId, sourceTaskId,
  approvers, status, responses, resolvedBy, resolvedAt, NULL, NULL,
  timeoutSeconds, expiresAt, notificationChannels, createdAt, updatedAt,
  created_by, updated_by
FROM approval_requests;

DROP TABLE approval_requests;
ALTER TABLE approval_requests_new RENAME TO approval_requests;

CREATE INDEX idx_approval_requests_status ON approval_requests(status);
CREATE INDEX idx_approval_requests_created ON approval_requests(createdAt DESC);
CREATE INDEX idx_approval_requests_workflow ON approval_requests(workflowRunId);
CREATE INDEX idx_approval_requests_task ON approval_requests(sourceTaskId);
CREATE INDEX idx_approval_requests_expires ON approval_requests(expiresAt)
  WHERE status = 'pending';

-- Keep the approval lifecycle coupled even if a caller cancels a HITL step
-- directly instead of cancelling the whole run through the workflow service.
CREATE TRIGGER cancel_approval_request_after_workflow_step_cancel
AFTER UPDATE OF status ON workflow_run_steps
WHEN NEW.status = 'cancelled' AND OLD.status IS NOT 'cancelled'
BEGIN
  UPDATE approval_requests
  SET status = 'cancelled',
      resolutionReason = COALESCE(NEW.error, 'Human-in-the-loop step cancelled'),
      resolvedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE workflowRunStepId = NEW.id AND status = 'pending';
END;
