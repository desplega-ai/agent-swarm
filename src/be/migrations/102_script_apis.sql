-- Expose individual scripts as externally-callable HTTP APIs under
-- `POST /api/x/script/<endpointId>`. Each row binds a public, non-secret
-- endpoint id to a script, with optional auto-generated bearer auth.
--
-- The bearer token is stored AES-256-GCM-encrypted using the same key + cipher
-- as `swarm_config` secrets (src/be/crypto/secrets-cipher.ts), decrypted
-- server-side per request to validate `Authorization: Bearer` and to reveal it
-- in the dashboard. The endpoint `id` itself is NOT a secret — it's 12 random
-- letters used only to address the endpoint in the URL.

CREATE TABLE IF NOT EXISTS script_apis (
  id TEXT PRIMARY KEY,                 -- public endpoint id (URL path): 12 random letters [a-zA-Z]; NOT a secret
  scriptId TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  agentId TEXT NOT NULL,               -- run-as identity (script owner at create time)
  authMode TEXT NOT NULL CHECK(authMode IN ('none', 'bearer')),
  bearerTokenEncrypted TEXT,           -- base64(iv||ct||tag) AES-256-GCM when authMode='bearer', else NULL
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  callCount INTEGER NOT NULL DEFAULT 0,
  lastUsedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_script_apis_scriptId ON script_apis(scriptId);

-- Mark script_runs that originated from an external API endpoint. This both
-- tracks usage/source and lets the Script Runs dashboard distinguish external
-- invocations from agent/inline runs.
ALTER TABLE script_runs ADD COLUMN apiEndpointId TEXT;
