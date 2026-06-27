-- 047_session_costs_cost_source.sql
-- Phase 6: track WHERE the recorded `totalCostUsd` came from for each session_costs row.
--
-- Adds a single column `costSource` to the `session_costs` table:
--   * 'harness'        — value reported as-is by the harness (Claude / pi self-report,
--                        or Codex worker fallback when no DB pricing rows exist).
--   * 'pricing-table'  — value recomputed by the API from `pricing` rows
--                        (Codex when DB pricing rows exist for all three token classes).
--
-- The `DEFAULT 'harness'` clause backfills every existing row to 'harness' — which
-- is the correct historical truth: prior to Phase 6 the API recorded whatever the
-- harness sent without recomputation. New writes from Phase 6 forward set the
-- column explicitly via `createSessionCost(...)`.

ALTER TABLE session_costs ADD COLUMN costSource TEXT NOT NULL DEFAULT 'harness'
  CHECK (costSource IN ('harness', 'pricing-table'));
