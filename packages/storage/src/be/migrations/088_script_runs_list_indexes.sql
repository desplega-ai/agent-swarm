-- Keep script run list pages fast as historical rows accumulate.

CREATE INDEX IF NOT EXISTS idx_script_runs_startedAt
  ON script_runs(startedAt DESC);

CREATE INDEX IF NOT EXISTS idx_script_runs_status_startedAt
  ON script_runs(status, startedAt DESC);

CREATE INDEX IF NOT EXISTS idx_script_runs_agentId_startedAt
  ON script_runs(agentId, startedAt DESC);
