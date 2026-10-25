-- Last provider rejection of a pooled key by a worker live test (HTTP 401).
-- A key with lastValidationFailedAt set is left out of /api/keys/available.
ALTER TABLE api_key_status ADD COLUMN lastValidationError TEXT;
ALTER TABLE api_key_status ADD COLUMN lastValidationFailedAt TEXT;
