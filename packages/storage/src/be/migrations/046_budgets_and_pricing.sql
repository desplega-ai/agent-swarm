-- 046_budgets_and_pricing.sql
-- Per-agent daily cost budget (V1) — schema + price-book DB-ification.
--
-- Tables added:
--   * budgets                          — daily USD budgets per scope (global/agent).
--   * pricing                          — append-only price book per (provider, model, token_class, effective_from).
--   * budget_refusal_notifications     — per (task_id, day) dedup of refusal notifications.
--
-- Index added:
--   * idx_pricing_lookup               — supports "latest active price" queries.
--
-- Seed:
--   * pricing rows derived from `CODEX_MODEL_PRICING` (src/providers/codex-models.ts:97-119),
--     12 rows total (4 models × 3 token_classes), all with effective_from = 0 (epoch).
--     INSERT OR IGNORE keeps the migration idempotent on re-apply.
--
-- Timestamp convention (deliberate divergence from existing tables):
--   The columns `createdAt`, `lastUpdatedAt`, and `effective_from` in this migration are
--   INTEGER epoch milliseconds — NOT TEXT ISO 8601 like the rest of the schema. This is
--   intentional: integer math keeps the price-book "largest effective_from <= now" lookup
--   simple and lets the three timestamp fields share the same numeric domain. Seed rows
--   use literal 0 so re-runs of the seed are idempotent under INSERT OR IGNORE.
--
-- Index that was deliberately NOT added here:
--   `(agentId, createdAt)` on session_costs already exists as `idx_session_costs_agent_createdAt`
--   in `001_initial.sql:363`. Adding it again under a new name (e.g. idx_session_costs_agent_created)
--   would be a redundant duplicate. Phase 2 query plans should reference the canonical
--   index name from 001.

CREATE TABLE IF NOT EXISTS budgets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  daily_budget_usd REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUpdatedAt INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id),
  CHECK (scope IN ('global', 'agent')),
  CHECK (daily_budget_usd >= 0)
);

CREATE TABLE IF NOT EXISTS pricing (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  token_class TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  price_per_million_usd REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUpdatedAt INTEGER NOT NULL,
  PRIMARY KEY (provider, model, token_class, effective_from),
  CHECK (provider IN ('claude', 'codex', 'pi')),
  CHECK (token_class IN ('input', 'cached_input', 'output'))
);

CREATE INDEX IF NOT EXISTS idx_pricing_lookup
  ON pricing (provider, model, token_class, effective_from DESC);

CREATE TABLE IF NOT EXISTS budget_refusal_notifications (
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  agent_spend_usd REAL,
  agent_budget_usd REAL,
  global_spend_usd REAL,
  global_budget_usd REAL,
  follow_up_task_id TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (task_id, date),
  CHECK (cause IN ('agent', 'global'))
);

-- Seed Codex price book. Mirrors CODEX_MODEL_PRICING (src/providers/codex-models.ts).
-- Use literal 0 for effective_from / createdAt / lastUpdatedAt so re-applying the
-- seed under INSERT OR IGNORE is a true no-op (no clock drift between runs).
INSERT OR IGNORE INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt) VALUES
  ('codex', 'gpt-5.4',         'input',        0, 2.5,    0, 0),
  ('codex', 'gpt-5.4',         'cached_input', 0, 0.25,   0, 0),
  ('codex', 'gpt-5.4',         'output',       0, 15.0,   0, 0),
  ('codex', 'gpt-5.4-mini',    'input',        0, 0.75,   0, 0),
  ('codex', 'gpt-5.4-mini',    'cached_input', 0, 0.075,  0, 0),
  ('codex', 'gpt-5.4-mini',    'output',       0, 4.5,    0, 0),
  ('codex', 'gpt-5.3-codex',   'input',        0, 1.75,   0, 0),
  ('codex', 'gpt-5.3-codex',   'cached_input', 0, 0.175,  0, 0),
  ('codex', 'gpt-5.3-codex',   'output',       0, 14.0,   0, 0),
  ('codex', 'gpt-5.2-codex',   'input',        0, 1.75,   0, 0),
  ('codex', 'gpt-5.2-codex',   'cached_input', 0, 0.175,  0, 0),
  ('codex', 'gpt-5.2-codex',   'output',       0, 14.0,   0, 0);
