-- Discriminate durable script-workflow runs from inline/one-off `/api/scripts/run`
-- executions so both can be persisted in the same script_runs table.
-- Existing rows are all durable workflow runs, hence the 'workflow' default.

ALTER TABLE script_runs
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow'
  CHECK(kind IN ('workflow', 'inline'));

CREATE INDEX IF NOT EXISTS idx_script_runs_kind ON script_runs(kind);
