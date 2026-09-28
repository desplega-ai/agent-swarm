-- Persistent model catalog (models.dev projection) + operator/agent overlay.
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
