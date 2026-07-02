-- 050_wait_states_scope.sql
-- Add `scope` column to wait_states (Phase 3 of the wait-node plan).
--
-- The bus listener needs to know whether to enforce a run-id match between
-- the incoming payload (`_runId` or `workflowRunId`) and the wait_state's
-- `workflowRunId`. Storing it in a dedicated column keeps the matcher
-- O(1)-fast (no JSON.parse on every event) and surfaces it in DB queries.
--
-- - 'run'    (default): listener enforces payload._runId === waitState.workflowRunId
--                       (or payload.workflowRunId for built-in events from src/be/db.ts)
-- - 'global':           listener skips the run-id check; any payload satisfying
--                       the filter resolves the wait
--
-- Existing rows (all from Phase 2 — time mode only) get the default 'run'
-- which is harmless because time-mode rows never go through the bus listener.

ALTER TABLE wait_states
  ADD COLUMN eventScope TEXT NOT NULL DEFAULT 'run'
    CHECK (eventScope IN ('run', 'global'));
