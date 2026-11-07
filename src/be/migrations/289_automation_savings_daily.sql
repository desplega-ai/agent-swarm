-- Daily rollup of the automation savings model (src/be/savings/).
-- One row per job per UTC day with tier-independent counts and costs; the API
-- applies the tier curve, the schedule cap, the enabled-only rule and the
-- error band at read time. Schedule counts stay uncapped here, so the window
-- cap stays exact when buckets are summed. jobKind 'script' and subKind are
-- reserved for the script rollup; workflows use subKind ''.
CREATE TABLE IF NOT EXISTS automation_savings_daily (
  day TEXT NOT NULL,
  jobKind TEXT NOT NULL CHECK (jobKind IN ('workflow', 'script')),
  jobId TEXT NOT NULL,
  jobKey TEXT NOT NULL,
  jobName TEXT NOT NULL,
  subKind TEXT NOT NULL DEFAULT '',
  runs INTEGER NOT NULL DEFAULT 0,
  countedRuns INTEGER NOT NULL DEFAULT 0,
  schedRuns INTEGER NOT NULL DEFAULT 0,
  schedEffectRuns INTEGER NOT NULL DEFAULT 0,
  eventRuns INTEGER NOT NULL DEFAULT 0,
  effectRuns INTEGER NOT NULL DEFAULT 0,
  effectOpsSum REAL NOT NULL DEFAULT 0,
  opsSum REAL NOT NULL DEFAULT 0,
  agentTasks INTEGER NOT NULL DEFAULT 0,
  agentUsd REAL NOT NULL DEFAULT 0,
  agentMs REAL NOT NULL DEFAULT 0,
  followupUsd REAL NOT NULL DEFAULT 0,
  recordedLlmUsd REAL NOT NULL DEFAULT 0,
  estimatedLlmUsd REAL NOT NULL DEFAULT 0,
  computeSecs REAL NOT NULL DEFAULT 0,
  modelVersion INTEGER NOT NULL,
  computedAt TEXT NOT NULL,
  PRIMARY KEY (day, jobKind, jobId, subKind)
);

CREATE INDEX IF NOT EXISTS idx_automation_savings_daily_job
  ON automation_savings_daily(jobKind, jobId, day);
CREATE INDEX IF NOT EXISTS idx_automation_savings_daily_key
  ON automation_savings_daily(jobKind, jobKey, day);

-- Which days the rollup has computed, per job kind: a day with no runs has no
-- bucket rows, and this row tells it apart from a day not computed yet.
CREATE TABLE IF NOT EXISTS automation_savings_days (
  day TEXT NOT NULL,
  jobKind TEXT NOT NULL CHECK (jobKind IN ('workflow', 'script')),
  modelVersion INTEGER NOT NULL,
  computedAt TEXT NOT NULL,
  PRIMARY KEY (day, jobKind)
);
