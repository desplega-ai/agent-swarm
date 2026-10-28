-- Adds a JSON-in-TEXT `slack_icon` column to `agents`, next to `avatar`.
-- Holds `{ type: 'emoji', emoji }` or `{ type: 'url', url }` for the agent's
-- Slack persona posts. NULL keeps the default (:crown: for the lead, a
-- name-hashed emoji for workers).
ALTER TABLE agents ADD COLUMN slack_icon TEXT;
