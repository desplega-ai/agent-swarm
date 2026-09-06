-- 143_backfill_gpt_6_astra_pricing.sql
-- Add GPT-6 Astra pricing rows for existing deployments.
-- Fresh installs also run this after 046, keeping CODEX_MODEL_PRICING fully
-- represented at effective_from=0 without mutating an applied migration.

INSERT OR IGNORE INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt) VALUES
  ('codex', 'gpt-6-astra', 'input',        0, 10.0, 0, 0),
  ('codex', 'gpt-6-astra', 'cached_input', 0, 1.0,  0, 0),
  ('codex', 'gpt-6-astra', 'output',       0, 50.0, 0, 0);
