-- Claim-time model resolution (model-catalog phase 3).
--
-- agent_tasks.resolvedModel / modelSource / modelAlias: what the server
--   resolved when the task was claimed. modelSource is one of
--   model | worker-env | tier-config | tier-default (fallback:cli-unsupported
--   is reserved for phase 4). modelAlias is the `latest:` alias, when any.
-- agents.modelTierOverrides: the worker's parsed MODEL_TIER_* env overrides,
--   JSON {provider: {tier: value}}. Values only, never secrets. Sent on
--   register and on every poll.
-- model_alias_resolutions: one row each time a `latest:` alias resolves to a
--   different concrete model than its previous resolution. System written.

ALTER TABLE agent_tasks ADD COLUMN resolvedModel TEXT;
ALTER TABLE agent_tasks ADD COLUMN modelSource TEXT;
ALTER TABLE agent_tasks ADD COLUMN modelAlias TEXT;

ALTER TABLE agents ADD COLUMN modelTierOverrides TEXT;

CREATE TABLE IF NOT EXISTS model_alias_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  previousModel TEXT,
  newModel TEXT NOT NULL,
  changedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_alias_resolutions_alias
  ON model_alias_resolutions (alias, id);
