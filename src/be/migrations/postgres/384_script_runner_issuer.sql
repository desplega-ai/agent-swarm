-- Empty identifies an older writer without an immutable issuer. NULL identifies an operator.
ALTER TABLE script_runner_credentials ADD COLUMN issuer_user_id TEXT DEFAULT '';
-- Pre-release credentials can have reassigned audit attribution. Require a new credential.
UPDATE script_runner_credentials SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, updated_by = NULL
WHERE revoked_at IS NULL;
CREATE INDEX idx_script_runner_credentials_created_by ON script_runner_credentials (created_by);
CREATE INDEX idx_script_runner_credentials_updated_by ON script_runner_credentials (updated_by);
