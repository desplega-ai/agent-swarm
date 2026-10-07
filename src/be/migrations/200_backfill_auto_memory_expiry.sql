-- Backfill a TTL on legacy auto-generated memories.
--
-- task_completion and session_summary rows written before TTL_DEFAULTS existed
-- (or by paths that skipped computeExpiresAt) carry expiresAt = NULL, so
-- purgeExpired() never removes them and they keep competing for pre-task
-- recall slots indefinitely. Give each one a 7-day grace window from the
-- moment this migration runs; the regular purge then removes them.
--
-- Excluded:
--   * swarm-scope rows: promoted to shared knowledge, not per-agent residue.
--   * /longterm keys: tierSource() treats them as manual (no TTL).
--
-- Data-only. ISO-8601 with milliseconds, matching Date#toISOString() used by
-- computeExpiresAt() for new rows.
UPDATE agent_memory
SET expiresAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')
WHERE source IN ('task_completion', 'session_summary')
  AND expiresAt IS NULL
  AND scope <> 'swarm'
  AND (key IS NULL OR (key <> '/longterm' AND key NOT LIKE '/longterm/%'));
