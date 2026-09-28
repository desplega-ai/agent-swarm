-- Approval request auto-cancellation. The heartbeat sweep cancels pending
-- requests with no expiresAt whose createdAt is older than
-- APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS. Requests with an expiresAt use
-- the existing partial index on expiresAt and become 'timeout' instead.
-- The status 'cancelled' and the resolutionReason column exist since
-- migration 140. This migration adds the index for the auto-cancel predicate.
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_created
  ON approval_requests(createdAt)
  WHERE status = 'pending' AND expiresAt IS NULL;
