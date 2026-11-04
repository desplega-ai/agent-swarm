-- Backfill the 30-day TTL on store-progress learnings.
--
-- Rows under /learnings/ were written before computeExpiresAt() gave the key a
-- LEARNING_TTL_DAYS expiry, so they carry expiresAt = NULL and never age out.
-- Give each one createdAt + 30 days, the expiry a new learning gets at write
-- time; purgeExpired() then removes it once that date passes. A learning worth
-- keeping is moved under /longterm first, which clears the expiry.
--
-- Data-only. Touches no row outside /learnings/ and no row that already has an
-- expiry. ISO-8601 with milliseconds, matching Date#toISOString() used by
-- computeExpiresAt() for new rows.
UPDATE agent_memory
SET expiresAt = strftime('%Y-%m-%dT%H:%M:%fZ', createdAt, '+30 days')
WHERE key GLOB '/learnings/*'
  AND expiresAt IS NULL;
