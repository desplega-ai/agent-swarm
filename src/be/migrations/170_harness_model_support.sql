-- Harness CLI model support (model-catalog phase 4).
--
-- harness_model_support: whether a catalog model runs on a given harness CLI
--   version. Workers write it after a model's first run on their CLI: `ok` on
--   success, `unsupported` when the CLI rejects the model id. No row means
--   `unknown`, which is allowed at claim. System written.
-- agents.harnessCliVersion: the worker's `claude --version` / `codex --version`,
--   reported on register. Keys claim-time support lookups.

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
