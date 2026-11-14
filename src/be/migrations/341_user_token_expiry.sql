-- Expiry for short-lived user tokens: a user MCP script run presents one so its
-- `ctx.swarm` calls act as the requesting user. NULL for the long-lived MCP
-- tokens people mint, which never expire.
ALTER TABLE user_tokens ADD COLUMN expiresAt TEXT;
