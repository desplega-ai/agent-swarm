-- Model catalog, claim-time model resolution and harness CLI model support.
--
-- One migration for the whole model-catalog stack (persistent catalog, tier
-- resolution, harness support). Three parts, in dependency order.

-- ---------------------------------------------------------------------------
-- Part 1: persistent model catalog (models.dev projection) + operator overlay.
--
-- model_catalog: one row per (provider, modelId) for the picker-reachable
--   providers (CATALOG_PROVIDER_IDS). Rewritten by the catalog refresh; system
--   written, so it carries no user-attribution columns (.non-audit-tables).
-- model_catalog_overlay: hand-verified facts for models models.dev does not
--   list yet (or lists wrong). Overlay wins per non-null field. Rows with
--   expiresWhenUpstreamMatches=1 are deleted once upstream agrees.
-- model_catalog_meta: single-row fetch state (ETag / Last-Modified / times).
--
-- JSON columns: reasoningOptions = [{type, values?}], pricing =
-- {input?, output?, cache_read?, cache_write?} (USD per million tokens).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_catalog (
  provider TEXT NOT NULL,
  modelId TEXT NOT NULL,
  name TEXT,
  family TEXT,
  releaseDate TEXT,
  contextWindow INTEGER,
  maxOutput INTEGER,
  reasoning INTEGER,
  reasoningOptions TEXT,
  pricing TEXT,
  status TEXT,
  providerName TEXT,
  checkedAt INTEGER NOT NULL,
  PRIMARY KEY (provider, modelId)
);

CREATE TABLE IF NOT EXISTS model_catalog_overlay (
  provider TEXT NOT NULL,
  modelId TEXT NOT NULL,
  name TEXT,
  family TEXT,
  releaseDate TEXT,
  contextWindow INTEGER,
  maxOutput INTEGER,
  reasoning INTEGER,
  reasoningOptions TEXT,
  pricing TEXT,
  status TEXT,
  reason TEXT NOT NULL,
  verifiedBy TEXT,
  expiresWhenUpstreamMatches INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updatedAt INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (provider, modelId)
);

CREATE TABLE IF NOT EXISTS model_catalog_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  etag TEXT,
  lastModified TEXT,
  lastFetchAt INTEGER,
  lastCheckedAt INTEGER
);

-- ---------------------------------------------------------------------------
-- Part 2: claim-time model resolution.
--
-- agent_tasks.resolvedModel / modelSource / modelAlias: what the server
--   resolved when the task was claimed. modelSource is one of
--   model | worker-env | tier-config | tier-default | fallback:cli-unsupported.
--   modelAlias is the `latest:` alias, when any.
-- agents.modelTierOverrides: the worker's parsed MODEL_TIER_* env overrides,
--   JSON {provider: {tier: value}}. Values only, never secrets. Sent on
--   register and on every poll.
-- model_alias_resolutions: one row each time a `latest:` alias resolves to a
--   different concrete model than its previous resolution. System written.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Part 3: harness CLI model support.
--
-- harness_model_support: whether a catalog model runs on a given harness CLI
--   version. Workers write it after a model's first run on their CLI: `ok` on
--   success, `unsupported` when the CLI rejects the model id. No row means
--   `unknown`, which is allowed at claim. System written.
-- agents.harnessCliVersion: the worker's `claude --version` / `codex --version`,
--   reported on register. Keys claim-time support lookups.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS harness_model_support (
  harness TEXT NOT NULL,
  cliVersion TEXT NOT NULL,
  modelId TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'unsupported', 'unknown')),
  checkedAt INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (harness, cliVersion, modelId)
);

ALTER TABLE agents ADD COLUMN harnessCliVersion TEXT;
