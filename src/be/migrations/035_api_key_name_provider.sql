-- Add user-facing `name` (manually settable from the dashboard) and
-- automatic `provider` (claude/pi/codex, derived from keyType) columns to
-- api_key_status. This lets users label their pooled credentials and lets
-- the dashboard / runner group keys by harness without re-deriving the
-- mapping at every read site.

ALTER TABLE api_key_status ADD COLUMN name TEXT;
ALTER TABLE api_key_status ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';

-- Backfill provider for existing rows based on the keyType, mirroring the
-- PROVIDER_CREDENTIAL_VARS mapping in src/utils/credentials.ts. ANTHROPIC_API_KEY
-- is shared between claude and pi-mono — we default it to claude (the primary
-- consumer) since the runner sets the provider on every subsequent usage.
UPDATE api_key_status SET provider = 'claude'
  WHERE keyType IN ('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY');
UPDATE api_key_status SET provider = 'pi'
  WHERE keyType = 'OPENROUTER_API_KEY';
UPDATE api_key_status SET provider = 'codex'
  WHERE keyType = 'OPENAI_API_KEY';

CREATE INDEX IF NOT EXISTS idx_api_key_status_provider
  ON api_key_status(provider);
