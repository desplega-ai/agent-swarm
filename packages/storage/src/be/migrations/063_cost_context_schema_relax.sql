-- 063_cost_context_schema_relax.sql
-- Phase 1 of the context & cost tracking fixes plan (2026-05-15).
--
-- This migration unblocks every downstream phase by:
--   * Dropping the brittle CHECK constraints on `pricing.provider` and
--     `pricing.token_class` so we can seed rows for all 7 providers
--     (claude, claude-managed, codex, pi, opencode, devin, gemini) and the
--     extra token classes (`cache_write`, `runtime_hour`, `acu`). Zod
--     validation at the application boundary (`PricingProviderSchema`,
--     `PricingTokenClassSchema` in `src/types.ts`) keeps the actual safety
--     guarantee — the CHECKs added drift risk for no real benefit.
--   * Renaming the misleading `agent_tasks.totalContextTokensUsed` column
--     to `peakContextTokens` to match its new monotonic-max semantic
--     (mirrors Claude Code's status-line "peak context" idea).
--   * Recording the `contextFormula` used by the adapter that emitted a
--     given snapshot so we can tell apples from oranges across providers.
--   * Adding `reasoningOutputTokens` (codex reasoning models) and
--     `thinkingTokens` (claude extended thinking) columns to `session_costs`
--     so we stop dropping those numbers on the floor.
--
-- SQLite CHECK constraints can't be modified in place, so the `pricing` and
-- `task_context_snapshots` shape changes use the standard
-- create-new / copy / drop / rename dance. Existing rows are preserved.
--
-- Forward-only — no down migration. If you need to revert, write a new
-- migration that walks the schema forward to the desired state.

-- ---------------------------------------------------------------------------
-- 1. Relax `pricing` CHECK constraints (drop them entirely; Zod validates).
-- ---------------------------------------------------------------------------

CREATE TABLE pricing_new (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  token_class TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  price_per_million_usd REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUpdatedAt INTEGER NOT NULL,
  PRIMARY KEY (provider, model, token_class, effective_from)
);

INSERT INTO pricing_new (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
SELECT provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt
FROM pricing;

DROP TABLE pricing;
ALTER TABLE pricing_new RENAME TO pricing;

-- Re-create the index the original `pricing` table had (matches 046:54-55).
CREATE INDEX IF NOT EXISTS idx_pricing_lookup
  ON pricing (provider, model, token_class, effective_from DESC);

-- ---------------------------------------------------------------------------
-- 2. Rename agent_tasks.totalContextTokensUsed -> peakContextTokens.
--    SQLite >= 3.25 supports RENAME COLUMN; bun:sqlite is well past that.
-- ---------------------------------------------------------------------------

ALTER TABLE agent_tasks RENAME COLUMN totalContextTokensUsed TO peakContextTokens;

-- ---------------------------------------------------------------------------
-- 3. Add contextFormula column to task_context_snapshots.
--    Using a plain TEXT column (no CHECK) so the adapter side can add new
--    formulas without an accompanying migration; Zod enum validates writes.
--    Values today:
--      'input-cache-output'    — unified formula (post-Phase 9)
--      'input-cache-no-output' — pre-unification claude formula
--      'input-output-no-cache' — pre-unification claude-managed formula
--      'peak-proxy'            — pre-unification codex formula
--      'pi-delegated'          — context numbers come from the pi-ai SDK
--      'harness-reported'      — context numbers come from a harness API (devin)
--      'unknown'               — pre-migration backfill or adapter didn't tag
-- ---------------------------------------------------------------------------

ALTER TABLE task_context_snapshots ADD COLUMN contextFormula TEXT;
UPDATE task_context_snapshots SET contextFormula = 'unknown' WHERE contextFormula IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Rewrite session_costs to:
--    a) drop the costSource CHECK (we need 'unpriced' as a third value);
--    b) add reasoningOutputTokens + thinkingTokens columns we previously
--       dropped on the floor.
--    SQLite can't relax a CHECK in-place — table-rewrite dance, same pattern
--    as the pricing table above. FKs and indexes are restored after rename.
-- ---------------------------------------------------------------------------

CREATE TABLE session_costs_new (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    taskId TEXT,
    agentId TEXT NOT NULL,
    totalCostUsd REAL NOT NULL,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    -- Migration 063: nullable. Codex SDK can't surface cache writes, so we
    -- store null instead of faking a 0 that mixes with real zeros.
    cacheWriteTokens INTEGER DEFAULT 0,
    durationMs INTEGER NOT NULL,
    -- Migration 063: nullable. Claude when `num_turns` is absent can't honestly
    -- report a turn count; null is preferred over a faked 1.
    numTurns INTEGER,
    model TEXT NOT NULL,
    isError INTEGER NOT NULL DEFAULT 0,
    costSource TEXT NOT NULL DEFAULT 'harness',
    reasoningOutputTokens INTEGER NOT NULL DEFAULT 0,
    thinkingTokens INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
);

INSERT INTO session_costs_new (
    id, sessionId, taskId, agentId, totalCostUsd,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    durationMs, numTurns, model, isError, costSource,
    reasoningOutputTokens, thinkingTokens, createdAt
)
SELECT
    id, sessionId, taskId, agentId, totalCostUsd,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    durationMs, numTurns, model, isError, costSource,
    0, 0, createdAt
FROM session_costs;

DROP TABLE session_costs;
ALTER TABLE session_costs_new RENAME TO session_costs;

-- Recreate indexes (mirrors 001_initial.sql:360-363).
CREATE INDEX IF NOT EXISTS idx_session_costs_createdAt ON session_costs(createdAt);
CREATE INDEX IF NOT EXISTS idx_session_costs_taskId ON session_costs(taskId);
CREATE INDEX IF NOT EXISTS idx_session_costs_agentId ON session_costs(agentId);
CREATE INDEX IF NOT EXISTS idx_session_costs_agent_createdAt ON session_costs(agentId, createdAt);
