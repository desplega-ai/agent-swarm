-- Support chronological session log scans without walking the full table.
CREATE INDEX IF NOT EXISTS idx_session_logs_createdAt ON session_logs(createdAt);
