-- Historical session attribution cannot be recovered from mutable task credentials.
ALTER TABLE session_costs ADD COLUMN credentialKeyType TEXT;
ALTER TABLE session_costs ADD COLUMN credentialKeySuffix TEXT;
ALTER TABLE session_costs ADD COLUMN harness TEXT;
CREATE INDEX idx_session_costs_credential_createdAt
  ON session_costs(credentialKeyType, credentialKeySuffix, createdAt);
CREATE INDEX idx_session_costs_sessionId ON session_costs(sessionId);

-- Preserve absent cache measurements as null. Replacing the column removes
-- NOT NULL while retaining rows, indexes, and foreign keys.
ALTER TABLE session_costs RENAME COLUMN cacheReadTokens TO legacyCacheReadTokens;
ALTER TABLE session_costs ADD COLUMN cacheReadTokens INTEGER;
UPDATE session_costs SET cacheReadTokens = legacyCacheReadTokens;
ALTER TABLE session_costs DROP COLUMN legacyCacheReadTokens;

-- Old workers mapped the ambiguous raw Pro claim only to chatgpt_pro.
-- Manual selections retain their stable IDs and prices.
ALTER TABLE api_key_status ADD COLUMN detectedPlanRaw TEXT;
UPDATE api_key_status
SET detectedPlanRaw = 'pro',
    plan = NULL
WHERE keyType = 'CODEX_OAUTH' AND planSource = 'detected'
  AND plan = 'chatgpt_pro';
