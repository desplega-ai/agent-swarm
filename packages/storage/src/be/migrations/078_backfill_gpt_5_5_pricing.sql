-- 078_backfill_gpt_5_5_pricing.sql
-- Backfill Codex GPT-5.5 pricing into existing databases.
--
-- The vendored models.dev cache already contains gpt-5.5, and fresh server
-- boots seed it from src/be/seed-pricing.ts. Existing long-lived DBs can still
-- be missing those rows, which makes real gpt-5.5 Codex runs land as
-- costSource='unpriced'. Keep this migration idempotent so every environment
-- gets the baseline Standard-tier rates.

INSERT OR IGNORE INTO pricing
  (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
VALUES
  ('codex', 'gpt-5.5', 'input',        0, 5.0,  0, 0),
  ('codex', 'gpt-5.5', 'cached_input', 0, 0.5,  0, 0),
  ('codex', 'gpt-5.5', 'output',       0, 30.0, 0, 0);
