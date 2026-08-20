-- Persist workflow trigger provenance outside caller-controlled triggerData.
-- `created_by` already snapshots the human requester; together these columns
-- distinguish a creatorless scheduled run from a requester-less manual run.
ALTER TABLE workflow_runs
  ADD COLUMN triggerType TEXT NOT NULL DEFAULT 'manual'
  CHECK(triggerType IN ('schedule', 'manual', 'event', 'api'));

-- Historical triggerData is caller-controlled for manual/API runs, so it
-- cannot be promoted into trusted provenance. Existing rows keep the safe
-- `manual` default; all future engine writes populate the server-owned value.

CREATE INDEX idx_workflow_runs_trigger_type ON workflow_runs(triggerType);
