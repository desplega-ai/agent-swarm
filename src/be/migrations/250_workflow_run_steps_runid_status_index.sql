-- Composite index for step lookups filtered by run and status.
--
-- With only the single-column idx_wrs_runId and idx_wrs_status, and no
-- sqlite_stat1, the planner picks idx_wrs_status for `runId = ? AND
-- status = 'completed'`. Almost every row is 'completed', so each lookup
-- walks nearly the whole table and blocks the event loop. A (runId, status)
-- index covers both equalities, so the planner takes it instead.
CREATE INDEX IF NOT EXISTS idx_wrs_runId_status ON workflow_run_steps(runId, status);
