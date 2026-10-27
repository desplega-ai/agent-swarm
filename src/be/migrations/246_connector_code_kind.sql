-- Kind of single-use code in connector_codes.
--
-- `connector`: the agent-swarm.dev ChatGPT connector code (10 minute TTL).
-- `invite`: a teammate invite from `POST /api/invites` (7 day TTL). Its
-- exchange at `POST /api/invites/exchange` also flips the user from
-- `invited` to `active`.
--
-- Each exchange route redeems only its own kind. Existing rows are connector
-- codes, so they keep today's behavior.
ALTER TABLE connector_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'connector'
  CHECK (kind IN ('connector', 'invite'));
