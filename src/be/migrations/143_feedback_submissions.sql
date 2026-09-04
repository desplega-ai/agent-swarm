CREATE TABLE feedback_submissions (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  newsletter_consent INTEGER NOT NULL DEFAULT 0
    CHECK (newsletter_consent IN (0, 1)),
  nps INTEGER CHECK (nps BETWEEN 1 AND 5),
  message TEXT,
  user_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  swarm_version TEXT NOT NULL,
  org_name TEXT,
  installed_at TEXT,
  submitted_at TEXT NOT NULL,
  relayed_at TEXT,
  relay_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE INDEX idx_feedback_submissions_retry
  ON feedback_submissions(next_retry_at)
  WHERE relayed_at IS NULL;
