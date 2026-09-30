-- Consecutive auth failures per key, for the Codex pool auth bench.
ALTER TABLE api_key_status ADD COLUMN consecutiveAuthFailures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_key_status ADD COLUMN lastAuthFailureAt TEXT;
-- Server-assigned order of the last auth failure. MAX over the table is the
-- auth-failure fence a success or re-login clear must not predate.
ALTER TABLE api_key_status ADD COLUMN authFailureSeq INTEGER NOT NULL DEFAULT 0;
