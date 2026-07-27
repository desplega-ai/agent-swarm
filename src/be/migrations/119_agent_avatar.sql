-- Adds a JSON-in-TEXT `avatar` column to `agents`, following the existing
-- `capabilities` / `credentialMissing` / `cred_status` precedent. Holds a
-- discriminated union (v1: `{ type: 'lucide', icon, color? }`) so future
-- avatar types (emoji, image) need zero further migrations. NULL means "no
-- custom avatar" — the UI falls back to its deterministic hash-based icon
-- and color derivation.
ALTER TABLE agents ADD COLUMN avatar TEXT;
