-- The SQLite migration runner normalizes nextRunAt in this transaction.
-- It uses the same parser as schedule writes to preserve the represented instant.
SELECT 1;
