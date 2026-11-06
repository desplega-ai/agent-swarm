-- The savings read path filters buckets by kind, model version and a day
-- range (src/be/savings/read.ts). The existing indexes lead with jobId or
-- jobKey, so every read scanned all buckets of a kind; this one serves the
-- per-day row count and each day-range slice as a range scan.
CREATE INDEX IF NOT EXISTS idx_automation_savings_daily_read
  ON automation_savings_daily(jobKind, modelVersion, day, subKind);
