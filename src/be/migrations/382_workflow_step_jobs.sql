CREATE TABLE workflow_step_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_run_steps(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  owner_id TEXT,
  lease_expires_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE(step_id, attempt)
);
CREATE INDEX workflow_step_jobs_claim ON workflow_step_jobs(status, lease_expires_at, created_at);
CREATE INDEX workflow_step_jobs_run ON workflow_step_jobs(run_id);
