-- Adds a JSON-in-TEXT `avatar` column to `users`, the same shape as
-- `agents.avatar` (migration 119): a lucide glyph, an https image link, or an
-- agent-fs image. NULL means "no custom avatar"; the UI falls back to initials.
ALTER TABLE users ADD COLUMN avatar TEXT;
