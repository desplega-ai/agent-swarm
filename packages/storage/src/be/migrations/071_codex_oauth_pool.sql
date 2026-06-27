-- Migration 069: Rename legacy codex_oauth config key to codex_oauth_0
-- This is idempotent: only renames if the legacy key exists and the new key doesn't.
-- After this migration, all Codex OAuth credentials use the slot-keyed naming
-- convention (codex_oauth_0, codex_oauth_1, etc.) introduced in CAI-1280.
UPDATE swarm_config
SET key = 'codex_oauth_0'
WHERE key = 'codex_oauth'
  AND NOT EXISTS (SELECT 1 FROM swarm_config WHERE key = 'codex_oauth_0');
