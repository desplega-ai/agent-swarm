-- Pin each workflow run to the definition it started with (#2720).
-- One immutable row per distinct definition content, keyed by its sha256.
-- Runs created before this migration keep a NULL definitionHash and read the
-- live workflows row, as before.
CREATE TABLE IF NOT EXISTS workflow_run_definitions (
  hash TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

ALTER TABLE workflow_runs ADD COLUMN definitionHash TEXT REFERENCES workflow_run_definitions(hash);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_definitionHash
  ON workflow_runs(definitionHash) WHERE definitionHash IS NOT NULL;
