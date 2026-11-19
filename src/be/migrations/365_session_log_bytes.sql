-- Durable per-session byte accounting for session_logs.
--
-- The budget that stops a runaway session has to survive an API restart: the
-- stored rows do, so an in-process counter would hand the same session a fresh
-- budget on every boot. Updated inside the insert transaction, which is also
-- what makes concurrent batches reserve their bytes atomically.
CREATE TABLE IF NOT EXISTS session_log_bytes (
    sessionId TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL DEFAULT 0,
    exhaustedAt TEXT
);

-- No backfill from session_logs: summing octet_length over an existing table
-- would read every stored row at boot, and an upgrade's live sessions are
-- already near the end of their budget anyway. Sessions start their accounting
-- at the first batch written after this migration.
