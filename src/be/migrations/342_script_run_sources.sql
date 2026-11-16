-- Keep the legacy NOT NULL source column so this is an additive migration.
-- Boot moves existing source text into the content store in bounded batches.
CREATE TABLE script_run_sources (
  hash TEXT PRIMARY KEY,
  source TEXT NOT NULL
);

ALTER TABLE script_runs ADD COLUMN sourceHash TEXT REFERENCES script_run_sources(hash);

-- Includes NULLs for the resumable backfill, as well as FK and GC lookups.
CREATE INDEX idx_script_runs_sourceHash ON script_runs(sourceHash);

CREATE TRIGGER script_runs_delete_source
AFTER DELETE ON script_runs
WHEN OLD.sourceHash IS NOT NULL
BEGIN
  DELETE FROM script_run_sources
  WHERE hash = OLD.sourceHash
    AND NOT EXISTS (SELECT 1 FROM script_runs WHERE sourceHash = OLD.sourceHash);
END;
