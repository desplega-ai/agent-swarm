-- 114_backfill_gpt_5_6_pricing.sql
-- Add GPT-5.6 Codex Sol/Terra/Luna pricing rows for existing deployments.
-- Fresh installs also run this after 046, so CODEX_MODEL_PRICING remains fully
-- represented at effective_from=0 without mutating already-applied migrations.

INSERT OR IGNORE INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt) VALUES
  ('codex', 'gpt-5.6-sol',     'input',        0, 5.0,    0, 0),
  ('codex', 'gpt-5.6-sol',     'cached_input', 0, 0.5,    0, 0),
  ('codex', 'gpt-5.6-sol',     'output',       0, 30.0,   0, 0),
  ('codex', 'gpt-5.6-terra',   'input',        0, 2.5,    0, 0),
  ('codex', 'gpt-5.6-terra',   'cached_input', 0, 0.25,   0, 0),
  ('codex', 'gpt-5.6-terra',   'output',       0, 15.0,   0, 0),
  ('codex', 'gpt-5.6-luna',    'input',        0, 1.0,    0, 0),
  ('codex', 'gpt-5.6-luna',    'cached_input', 0, 0.1,    0, 0),
  ('codex', 'gpt-5.6-luna',    'output',       0, 6.0,    0, 0);
