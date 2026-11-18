ALTER TABLE session_tokens ADD COLUMN objectChain TEXT;
ALTER TABLE session_tokens ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;

ALTER TABLE script_runs ADD COLUMN objectScriptId TEXT;
ALTER TABLE script_runs ADD COLUMN objectId TEXT;
ALTER TABLE script_runs ADD COLUMN objectMethod TEXT;

CREATE INDEX IF NOT EXISTS idx_script_runs_object
  ON script_runs(objectScriptId, objectId) WHERE objectId IS NOT NULL;
