---
date: 2026-05-15T00:00:00Z
topic: "Context & Cost Tracking Fixes"
author: Taras
status: draft
tags: [plan, providers, cost, context-window, pricing]
based_on: thoughts/taras/research/2026-05-15-context-cost-tracking-gaps.md
---

# Context & Cost Tracking Fixes Implementation Plan

## Overview

Comprehensive remediation of the context-window and cost-tracking surface across all six harness providers (claude, claude-managed, codex, pi, opencode, devin). The research at `thoughts/taras/research/2026-05-15-context-cost-tracking-gaps.md` cataloged ~30 discrete gaps spanning provider adapters, the DB pricing table, the server-side recompute path, schema/convention drift, and UI cost display. This plan addresses all of them in dependency order: schema → server contract → adapters → utilities → UI.

- **Motivation**: Same cost/context numbers render differently per page; the same provider can yield different USD figures depending on which call path wrote the row; cross-provider context-percent comparisons are apples-to-oranges; some real work is silently unbilled.
- **Related**:
  - Research: `thoughts/taras/research/2026-05-15-context-cost-tracking-gaps.md`
  - Schema: `src/be/migrations/046_budgets_and_pricing.sql`, `047_session_costs_cost_source.sql`
  - Server: `src/http/session-data.ts`, `src/http/context.ts`
  - Adapters: `src/providers/{claude,claude-managed,codex,pi-mono,opencode,devin}-adapter.ts`
  - Utilities: `src/utils/context-window.ts`
  - UI: `ui/src/{lib/utils.ts, components/shared/stats-bar.tsx, pages/budgets/page.tsx, pages/api-keys/page.tsx, components/dashboard/agent-{node,table}.tsx}`

## Current State Analysis

The research doc cataloged the surface; sub-agent verification confirmed ~85% of file:line refs (today, 2026-05-15). Highlights from verification:

**Confirmed**:
- 6 providers in `src/providers/index.ts:27-45` (no gemini); `src/claude.ts` is debug-only.
- `pricing.provider` CHECK at `src/be/migrations/046_budgets_and_pricing.sql:50` is `IN ('claude','codex','pi')` — no `claude-managed`/`opencode`/`devin`/`gemini`.
- `pricing.token_class` CHECK at `046:51` is `IN ('input','cached_input','output')` — no `cache_write` / `runtime_hour`.
- Seed at `046:75-87` is 12 rows, codex-only.
- `costSource` column added in `047:15-16`, defaults `'harness'`.
- Server-side recompute gated on `provider === "codex"` at `src/http/session-data.ts:200`.
- Claude formula at `src/utils/context-window.ts:32-42` = `input + cache_create + cache_read` (excludes output); shortname map at `:7-16` falls to 200k for dated full ids.
- claude-managed hardcodes 1M window at `src/providers/claude-managed-adapter.ts:122`; uses `input + output` (no cache) at `:529`; $0.08/hr runtime fee inline at `:389`.
- codex peak-proxy `max(0, input-cached) + output` at `src/providers/codex-adapter.ts:761-794`; `cacheWriteTokens` hardcoded `0` at `:545`; `reasoning_output_tokens` is read into `lastUsage` but never reaches `CostData` (CostData has no reasoning field per `src/providers/types.ts:1-22`).
- pi `durationMs:0` at `src/providers/pi-mono-adapter.ts:504`; `outputTokens:0` in context_usage at `:368`.
- opencode percent NOT clamped at `src/providers/opencode-adapter.ts:263`; `provider: "opencode"` at `:383` (research said :387, drifted ~4 lines).
- devin all tokens `0`, no `provider` tag, no `context_usage` emission at `src/providers/devin-adapter.ts:779-792`; ACU $2.25 at `:57`, env override at `:142`.
- MCP `store-progress` writes parallel `session_costs` rows keyed `mcp-<taskId>-<ts>` at `src/tools/store-progress.ts:257-285`.
- `PricingProviderSchema` is `z.enum(["claude","codex","pi"])` at `src/types.ts:1433`.
- Migration ceiling is **062** (`062_pages_view_count.sql`) — next migration is `063`.
- Existing tests: `src/tests/{session-costs,context-window,context-snapshot,store-progress-cost,session-costs-codex-recompute,migration-046-budgets,pricing-routes,budget-{admission,claim-gate,refusal-notification}-routes}.test.ts`. **Gap**: no provider-adapter cost-emission tests, no context-endpoint tests.

**Refuted / drifted**:
- Claude stale-session retry at `src/providers/claude-adapter.ts:582-628` — verifier reports first attempt's cost is NOT actually emitted before retry, so nothing is discarded. Research-doc claim of unbilled work is wrong; drop this from the fix list.
- `agent-node.tsx:37-42` formatCost is 2dp consistently (not 0/2 buckets). Still distinct from the other formatters; consolidation still applies.
- Research listed 6 distinct UI cost formatters; verification found **3 more** not in research: `ui/src/components/agent-runtime-settings.tsx:262-264`, `ui/src/components/shared/usage-summary.tsx:158` (toFixed(3)), `ui/src/pages/usage/page.tsx:150` (toFixed(3)). True count: **9 distinct cost-rendering sites** + 7 inline `toFixed` calls.
- Several server-side handler line ranges drifted ±10-40 lines; routes/logic intact.

## Desired End State

After this plan ships:

1. **One pricing source of truth**: every provider that bills (`claude`, `claude-managed`, `codex`, `pi`, `opencode`, `devin`, plus `gemini` for internal-ai paths) has seeded rows in the DB `pricing` table. Schema accepts `cache_write` and `runtime_hour` token classes. The server-side recompute path runs for **every** provider that submits a `session_costs` row, with `costSource='pricing-table'` on hit, `'harness'` on miss.
2. **One context formula**: every adapter emits `contextUsedTokens = input + cache_read + cache_create + output`, divided by the **actual** per-model window, clamped 0-100. The window comes from a unified `getContextWindowSize(model)` that resolves shortnames AND dated/full ids for every provider.
3. **Honest aggregate columns**: `agent_tasks.peakContextTokens` (renamed from `totalContextTokensUsed`) grows monotonically across the session — mirroring the Claude Code status-line semantic. `contextWindowSize` is populated on the first snapshot, not just on completion.
4. **No silently-free models**: unknown OpenAI / OpenRouter / Anthropic model ids that flow through `MODEL_OVERRIDE` paths log a warning AND mark `costSource='unpriced'` so they're visible in the UI.
5. **Token-field completeness**: codex emits `reasoningOutputTokens`; claude emits `thinkingTokens` when the CLI provides them; both fields are added to `CostData` and `session_costs`. pi emits real `durationMs` and `outputTokens`; devin emits a synthetic `context_usage` event with the harness-reported peak context use (or marks the field explicitly null instead of writing 0).
6. **MCP store-progress can't double-bill**: the `cost` field is removed from the tool input schema; adapters are the sole writers of `session_costs`.
7. **One UI cost formatter**: `formatCost` from a single shared module replaces all 9 cost-display sites. `costSource` is propagated through `ui/src/api/types.ts` `SessionCost` and rendered as a badge.
8. **Dashboard date filter is numeric**: `getDashboardCostSummary` uses epoch-ms boundaries, no lexicographic ISO-vs-date comparison. The api-keys INNER JOIN switches to LEFT JOIN so orphan-taskId rows aren't dropped from totals.
9. **Coverage**: new tests per `src/tests/providers/<provider>-cost.test.ts` exercise each adapter's CostData emission; new tests under `src/tests/http/context-routes.test.ts` exercise the `/api/tasks/:id/context` ingestion path.

## What We're NOT Doing

- **Building a `gemini` harness provider**. The research noted this; out of scope. Gemini only flows in via OpenRouter through `internal-ai`. We add `gemini` to the pricing-table provider enum and seed rows so those internal-ai calls can be priced — no new adapter.
- **Reworking pi-mono's internal pricing**. pi-ai reports `stats.cost` directly and we trust it; we just seed equivalent rows in the pricing table for cross-check (`costSource='pricing-table'` when match, `'harness'` otherwise).
- **Migrating timestamp conventions to a single type**. The TEXT ISO 8601 (session_costs/task_context_snapshots) vs INTEGER epoch-ms (budgets/pricing) split is documented at `src/be/migrations/046_budgets_and_pricing.sql:17-22`. Touching this risks breaking the entire reporting surface; we fix the lex-comparison bug instead.
- **Backfilling historical `session_costs` rows** with the new costSource / contextFormula values. The new semantics apply from the migration date forward.
- **Rewriting the Devin ACU cost model**. We move `$2.25/ACU` into a pricing-table row with `token_class='acu'` (added in the schema relax), but the value, source, and last-verified date stay in code comments for now.

## Implementation Approach

Dependency order: schema → server contract → per-adapter fixes (parallelizable) → utilities → DB write paths → MCP & runner → UI consolidation.

- **Schema-first**. Migration 063 relaxes both CHECKs and adds a `contextFormula` enum column on `task_context_snapshots`. Required before anything else can pricing-table or recompute non-codex rows.
- **Server contract is the API to the adapters**. The `POST /api/session-costs` recompute branch widens from `codex-only` to "any provider with rows in pricing". Adapter changes after this point can land in any order.
- **Per-adapter phases are independent** and can land in parallel PRs (we sequence linearly here for one-session implementation but plan them as standalone phases).
- **Utilities phase** centralizes `getContextWindowSize` (full-id resolution) and `computeContextUsed` (single formula). Touches every adapter — sequenced after individual adapter cleanups so the utility consolidation is the last step rather than the first.
- **DB write paths** fix the column-rename and monotonic-max semantics; `agent_tasks.peakContextTokens` migration is in 063 alongside other schema work, but the write-path code change is sequenced after the utility unification so the new column reflects unified numbers.
- **MCP & runner** strip the `cost` field from store-progress and populate cumulative tokens on every progress snapshot (not just completion).
- **UI consolidation** is last because it depends on the API response shape (`costSource`, the new `contextFormula` field) being stable.

## Quick Verification Reference

- Type check: `bun run tsc:check`
- Lint: `bun run lint`
- Unit tests: `bun test`
- DB boundary: `bash scripts/check-db-boundary.sh`
- Per-adapter tests: `bun test src/tests/providers/<adapter>.test.ts`
- Fresh DB smoke: `rm agent-swarm-db.sqlite && bun run start:http`

---

## Phase 1: Schema relax + new columns (migration 063)

### Overview

One forward-only migration that unblocks every downstream phase: relaxes the `pricing` CHECKs, adds missing token classes, renames the misleading `agent_tasks.totalContextTokensUsed`, and adds new columns for context formula + reasoning/thinking tokens.

### Changes Required:

#### 1. Migration file
**File**: `src/be/migrations/063_cost_context_schema_relax.sql` (new)
**Changes**:
- Drop the CHECK constraints on `pricing.provider` and `pricing.token_class` entirely. The Zod schemas at `src/types.ts` already validate provider/token_class values at the application boundary; a SQLite CHECK adds drift risk (every new provider needs a schema migration) for no real safety benefit. Existing rows are preserved via `CREATE TABLE pricing_new (... no CHECK ...)`, `INSERT INTO pricing_new SELECT * FROM pricing`, `DROP pricing`, `ALTER TABLE pricing_new RENAME TO pricing`. SQLite doesn't support modifying a CHECK in-place; the rename approach is the standard SQLite pattern and is non-destructive.
- Recreate the indexes that existed on the original `pricing` table after the rename.
- `ALTER TABLE agent_tasks RENAME COLUMN totalContextTokensUsed TO peakContextTokens` (SQLite ≥ 3.25 supports this; bundled bun-sqlite is well past that).
- `ALTER TABLE task_context_snapshots ADD COLUMN contextFormula TEXT` — values: `'input-cache-output'` (post-unification), `'input-cache-no-output'`, `'input-output-no-cache'`, `'peak-proxy'`, `'pi-delegated'`, `'unknown'`.
- `ALTER TABLE session_costs ADD COLUMN reasoningOutputTokens INTEGER NOT NULL DEFAULT 0`.
- `ALTER TABLE session_costs ADD COLUMN thinkingTokens INTEGER NOT NULL DEFAULT 0`.
- Backfill `contextFormula = 'unknown'` for existing rows.

#### 2. Sync TS types
**File**: `src/types.ts`
**Changes**:
- `PricingProviderSchema` (~line 1433): expand enum to match new CHECK.
- `PricingTokenClassSchema`: expand enum to match new CHECK.
- `SessionCostSchema`: add `reasoningOutputTokens: z.number().int().nonnegative().default(0)`, `thinkingTokens: z.number().int().nonnegative().default(0)`.
- `TaskContextSnapshotSchema`: add `contextFormula: z.enum([...]).optional()`.

#### 3. DB layer helpers
**File**: `src/be/db.ts`
**Changes**:
- `createSessionCost` (~`:3856`): accept and persist `reasoningOutputTokens`, `thinkingTokens`.
- Update column references from `totalContextTokensUsed` to `peakContextTokens` (search `src/` + `ui/` for callers; the rename touches `src/be/db.ts:8351-8355` aggregate write, `src/http/context.ts` snapshot writes, dashboard queries).
- `agent_tasks` write path for context: change overwrite to monotonic-max — `UPDATE agent_tasks SET peakContextTokens = MAX(COALESCE(peakContextTokens, 0), ?) WHERE id = ?`.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Migration applies on fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` (server starts without error)
- [ ] Migration applies on existing DB (use a copy of a real-prod-ish DB if available, else seed via prior migrations then apply): `cp agent-swarm-db.sqlite /tmp/test-db.sqlite && DATABASE_URL=/tmp/test-db.sqlite bun run start:http`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`
- [ ] New schema-shape test passes: `bun test src/tests/migration-063-schema-relax.test.ts` (new)
- [ ] Existing tests pass: `bun test src/tests/{session-costs,migration-046-budgets,pricing-routes,context-snapshot}.test.ts`

#### Automated QA:
- [ ] Script verifies (via `bun run scripts/verify-migration-063.ts`, new): pricing table accepts INSERT for each of the 7 providers × representative token_class; rejects unknown provider; `agent_tasks` has column `peakContextTokens` (not `totalContextTokensUsed`); existing `session_costs` rows have `reasoningOutputTokens=0`/`thinkingTokens=0`.

#### Manual Verification:
- [ ] Spot-check pricing table on a fresh DB via `sqlite3 agent-swarm-db.sqlite "PRAGMA table_info(pricing);"` — confirms expanded CHECK list.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit `[phase 1] migration 063: schema relax + new cost/context columns`.

---

## Phase 2: Server-side recompute extension + non-codex pricing seeds

### Overview

Widens `POST /api/session-costs` server-side recompute beyond the codex-only branch so every provider's cost rows can be cross-checked against the seeded pricing table; seeds pricing rows for claude, claude-managed, pi, opencode, devin, gemini.

### Changes Required:

#### 1. Recompute branch
**File**: `src/http/session-data.ts`
**Changes**:
- Around line 200: drop the `if (parsed.body.provider === "codex")` gate. Replace with: for any provider, look up pricing rows for `(provider, model, token_class)` at `createdAt`. If all required rows exist, recompute USD and tag `costSource='pricing-table'`; otherwise tag `costSource='harness'` (default). If `provider` is set but a passthrough/unknown model produced zero matches, tag `costSource='unpriced'`.
- Fix the `model || "opus"` default at `:189` — don't default; if missing, write the row but skip recompute entirely.

#### 2. Pricing-row seeds from models.dev (primary) + manual overrides (fallback)
**File**: `src/be/seed-pricing.ts` (new)
**Changes**:
- Drive seed rows primarily from a vendored `models.dev` snapshot — the same approach pi/opencode already use per `thoughts/taras/brainstorms/2026-05-11-agent-model-control.md`. The snapshot is the single source of truth for token rates; we just project it into `(provider, model, token_class)` rows on startup.
- New helper module: `src/providers/pricing-from-modelsdev.ts` reads `apps/web/lib/onboarding/modelsdev-cache.json` (or wherever the canonical snapshot lives — verify path during implementation) and projects `input_cost_per_token` / `output_cost_per_token` / `cache_read_input_token_cost` / `cache_creation_input_token_cost` into the pricing schema's token classes.
- Manual overrides for items models.dev doesn't cover: `claude-managed` `runtime_hour=$0.08` (Anthropic-specific fee), `devin` `acu=$2.25` (Cognition-specific unit). Keep these as a small constant table in `seed-pricing.ts`.
- Called from server startup AFTER migrations run; uses `INSERT OR IGNORE` so re-runs are no-ops.
- Seed runs cover the model-id mappings each adapter actually uses (see `pi-mono-adapter.ts:157-159` shortname → `anthropic/claude-opus-4`; `claude-managed-models.ts:55-74`; `codex-models.ts:105-127`). Where adapter shortnames don't match models.dev keys, document the mapping inline.

#### 3. Pricing-source provenance
**File**: `src/providers/pricing-sources.md` (new — markdown, not docs-site)
**Changes**:
- Single-page index naming the models.dev snapshot version (commit/date), the path to the vendored cache, and the manual-override constants with their source URLs (Anthropic Managed Agents docs for the runtime fee, Cognition/Devin pricing page for ACU). Phase 14 docs page links to this.

#### 4. Snapshot refresh tooling
**File**: `scripts/refresh-modelsdev-pricing.ts` (new)
**Changes**:
- One-shot refresh script: fetches the latest models.dev snapshot, diffs against the vendored cache, prints a summary (added/removed/changed rates), writes the new snapshot. Run by humans periodically; not a CI job. Document in `pricing-sources.md`.

### Success Criteria:

#### Automated Verification:
- [ ] Type check + lint pass.
- [ ] `bun test src/tests/session-costs-codex-recompute.test.ts` still passes (verifies codex path didn't regress).
- [ ] New test passes: `bun test src/tests/session-costs-recompute-all-providers.test.ts` — for each provider, POSTs a fake session-cost row with known tokens, asserts `costSource='pricing-table'` and that the recomputed USD matches the seeded rate to within 1 cent.
- [ ] Unknown-model test: `bun test src/tests/session-costs-unpriced.test.ts` — POSTs a codex row with `model='gpt-future-2027'`, asserts `costSource='unpriced'`.

#### Automated QA:
- [ ] Smoke script `bun run scripts/verify-recompute.ts` (new): hits `POST /api/session-costs` 7 times (one per provider) with representative tokens; reads back rows; asserts `costSource` distribution: 6×`pricing-table` + 1×`unpriced` (the deliberately-malformed one).

#### Manual Verification:
- [ ] Inspect `pricing-sources.md` and confirm every seed row has a URL + date.

**Implementation Note**: Pause; commit `[phase 2] extend session-costs recompute to all providers + seed pricing`.

---

## Phase 3: Provider tag completeness (claude-managed + devin)

### Overview

Wire the `provider` field on `CostData` for the two adapters that omit it; without this, Phase 2's widened recompute can never engage for those providers.

### Changes Required:

#### 1. claude-managed
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- `emptyCost()` (lines 176-191): set `provider: "claude-managed"`.
- Confirm every snapshot path (`snapshotCost`, `buildCostData`) preserves the tag.

#### 2. devin
**File**: `src/providers/devin-adapter.ts`
**Changes**:
- CostData construction (lines 779-792): set `provider: "devin"`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` passes.
- [ ] New test: `bun test src/tests/providers/claude-managed-cost.test.ts` — instantiate the adapter, fire a synthetic `span.model_request_end`, call `snapshotCost`, assert `result.provider === 'claude-managed'`.
- [ ] New test: `bun test src/tests/providers/devin-cost.test.ts` — assert `provider === 'devin'`.

#### Automated QA:
- [ ] None separate from unit tests — provider tag is a one-line change.

#### Manual Verification:
- [ ] Skim diff: only the two adapters touched; no behavior change beyond the tag.

**Implementation Note**: Pause; commit `[phase 3] set provider tag on claude-managed + devin CostData`.

---

## Phase 4: Claude adapter fixes

### Overview

Address the 4 high-impact claude-adapter gaps: thinking-token extraction, dynamic model field, `numTurns` truthful default, and full-id context-window resolution.

### Changes Required:

#### 1. Thinking-token extraction
**File**: `src/providers/claude-adapter.ts`
**Changes**:
- Around lines 483-501: also read `usage.thinking_input_tokens` (if present) and any thinking-related fields the CLI emits. Inspect Claude Code's stream-json `result.usage` shape — see research note at `thoughts/taras/research/2026-03-28-claude-code-input-format-stream-json.md`. Populate `costData.thinkingTokens`.

#### 2. Dynamic model field
**File**: `src/providers/claude-adapter.ts`
**Changes**:
- At `init` event handler (~lines 467-469): when `json.model` is present and differs from `this.model`, update `this.model = json.model`. The CLI's selection (post-backoff/fallback) is the truth.

#### 3. numTurns honest null
**File**: `src/providers/claude-adapter.ts`
**Changes**:
- Line 503: change `numTurns: json.num_turns || 1` → `numTurns: json.num_turns ?? null` (requires CostData/session_costs to accept null — already nullable in schema; verify).

#### 4. Full-id context-window resolution
**File**: `src/utils/context-window.ts`
**Changes**:
- Extend shortname map to also handle dated ids: `claude-sonnet-4-5-20250929`, `claude-sonnet-4-6-20251004`, `claude-haiku-4-5-20251001`, `claude-opus-4-7-...`. Strategy: regex-match `claude-(opus|sonnet|haiku)-N-M(-\d{8})?` and look up by `${family}-${major}-${minor}`. Fallback to `default = 200k` only if neither shortname nor stripped-id matches.

_Note: percent clamp is deferred to Phase 9 (unified utility); not in this phase._

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` + `bun run lint` pass.
- [ ] New test: `bun test src/tests/providers/claude-cost.test.ts` — feeds in synthetic stream-json, asserts: `thinkingTokens` extracted, `this.model` updated from init, `numTurns` is null when CLI omits, full-id `claude-sonnet-4-6-20251004` resolves to its real window (not 200k).
- [ ] Regression test: same adapter, feed an existing fixture (capture one from a real run), assert unchanged USD / token totals for non-thinking flow.

#### Automated QA:
- [ ] `bun run scripts/run-claude-against-fixture.ts` (new): runs a recorded stream-json against the adapter and prints emitted `CostData`+`context_usage` events; agent-driven assertion that thinking-token field is non-zero on the fixture that includes thinking.

#### Manual Verification:
- [ ] Manual smoke: start a claude session with `HARNESS_PROVIDER=claude` + a model id that uses extended thinking, run a thinking-heavy prompt, verify `session_costs.thinkingTokens > 0` in DB.

**Implementation Note**: Pause; commit `[phase 4] claude-adapter: thinking tokens, dynamic model, full-id context resolution`.

---

## Phase 5: Claude-managed adapter fixes

### Overview

Drop the hardcoded 1M context window; switch contextUsed to include cache; replace the inline `$0.08/hr` literal with a pricing-table lookup.

### Changes Required:

#### 1. Per-model context window
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- Remove `DEFAULT_CONTEXT_TOTAL_TOKENS = 1_000_000` at line 122.
- Call shared `getContextWindowSize(this.model)` from `src/utils/context-window.ts` (the Phase-4-extended version).

#### 2. Context-used includes cache
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- Line 529: change `const used = (inputTokens) + (outputTokens)` → `const used = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` (matches the unified formula from Phase 9).
- Set `contextFormula: 'input-cache-output'` on the emitted `context_usage` event.

#### 3. Runtime fee via pricing-table
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- Line 389 in `snapshotCost`: replace the inline `(durationMs / 3_600_000) * 0.08` with a lookup against the pricing table for `(provider='claude-managed', model='*', token_class='runtime_hour')`. The seed in Phase 2 inserts the row; adapter reads it at construction time (cached). If lookup fails, fall back to the constant + log a warning.
- Export `RUNTIME_FEE_USD_PER_HOUR` from a small new module `src/providers/claude-managed-pricing.ts` (loaded once) so we don't re-query per snapshot.

#### 4. Real preCompactTokens when possible
**File**: `src/providers/claude-managed-adapter.ts`
**Changes**:
- Lines 504-517: inspect the actual span payload — does the Anthropic Managed Agents SDK include a pre-compact token count? If yes, use it. If no, keep the current `inputTokens` proxy but explicitly comment why and set `compactTrigger: 'auto-inferred'` instead of `'auto'`.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `bun run tsc:check`, `bun run lint`.
- [ ] New test: `bun test src/tests/providers/claude-managed-cost.test.ts` — assert context_total matches per-model window (e.g. 1M for opus-4-7, 200k for haiku-4-5); assert contextUsed includes cache; assert runtime fee accrues at the rate from the (mocked) pricing-table row.

#### Automated QA:
- [ ] `bun run scripts/run-claude-managed-fixture.ts`: run a recorded managed-agents transcript fixture and assert percent stays sane (haiku-4-5 ≤ 100% even after long sessions).

#### Manual Verification:
- [ ] Manual smoke with `HARNESS_PROVIDER=claude-managed`: trigger a real run; inspect `task_context_snapshots` for the run; confirm `contextTotalTokens` matches the model's window.

**Implementation Note**: Pause; commit `[phase 5] claude-managed-adapter: per-model window, cache in context, runtime fee via pricing`.

---

## Phase 6: Codex adapter fixes

### Overview

Extract `reasoning_output_tokens` (currently dropped on the floor for reasoning models); cleanly handle unknown-model passthrough.

### Changes Required:

#### 1. Reasoning-token extraction
**File**: `src/providers/codex-adapter.ts`
**Changes**:
- At the `turn.completed` handler (~lines 521-552): populate `costData.reasoningOutputTokens = event.usage.reasoning_output_tokens ?? 0`.

#### 2. Unknown-model warning + tag
**File**: `src/providers/codex-models.ts`
**Changes**:
- `computeCodexCostUsd` (`:136-149`): when `pricing` lookup misses, return `{ usd: 0, costSource: 'unpriced' }` (changing return shape — also update call site). Worker still emits the row; server-side recompute (Phase 2) double-stamps `costSource='unpriced'`.
- Log a one-time warning per process per unknown model id: `logger.warn('codex: unpriced model', { model })`.

#### 3. cacheWriteTokens — drop the hardcoded 0
**File**: `src/providers/codex-adapter.ts`
**Changes**:
- Line 545: change `cacheWriteTokens: 0` to `cacheWriteTokens: undefined`. Codex SDK doesn't surface cache writes. `undefined` propagates as NULL in DB which is honest (vs zero, which mixes with real zeros).
- Sync `CostData` and `SessionCostSchema` so the field is nullable. Confirm DB column is nullable (it currently defaults to 0 — likely nullable per the type, check `001_initial.sql:179-196`).

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] `bun test src/tests/providers/codex-cost.test.ts` (new): synthetic `turn.completed` event with `reasoning_output_tokens=500` produces `costData.reasoningOutputTokens=500`.
- [ ] `bun test src/tests/session-costs-codex-recompute.test.ts`: still passes after the codex-models return-shape change.
- [ ] Unknown-model test: configure codex with `MODEL_OVERRIDE=gpt-future`, assert worker emits cost row with `costSource='unpriced'` and warning logged.

#### Automated QA:
- [ ] `bun run scripts/codex-fixture.ts`: replay a recorded reasoning-model fixture (e.g. `gpt-5.3-codex` with thinking enabled), confirm reasoning tokens are persisted to DB.

#### Manual Verification:
- [ ] Manual smoke with `HARNESS_PROVIDER=codex` + a reasoning model; verify `session_costs.reasoningOutputTokens > 0` in DB.

**Implementation Note**: Pause; commit `[phase 6] codex-adapter: reasoning tokens + unpriced-model warning`.

---

## Phase 7: Pi adapter fixes

### Overview

Stop reporting `durationMs: 0` and `outputTokens: 0` for context_usage. Both fields are derivable from pi-ai's `SessionStats`.

### Changes Required:

#### 1. durationMs
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**:
- Track session start wallclock in adapter state (similar to other adapters).
- Line 504: replace hardcoded `0` with `Date.now() - this.sessionStartedAt`.

#### 2. Context output-tokens
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**:
- Line 368: derive `outputTokens` from `agentSession.getContextUsage()` (verify pi-ai exposes it — see `src/providers/pi-mono-adapter.ts:330-510`). If pi-ai's API doesn't expose per-turn output, accumulate from `stats.tokens.output` deltas in the adapter.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` + `bun run lint` pass.
- [ ] `bun test src/tests/providers/pi-cost.test.ts` (new): durationMs is non-zero after a synthetic 100ms `wait`; outputTokens emitted into context_usage matches stats.

#### Automated QA:
- [ ] `bun run scripts/pi-fixture.ts`: recorded pi session, assert durationMs > 0 and outputTokens > 0 in emitted snapshots.

#### Manual Verification:
- [ ] Manual smoke with `HARNESS_PROVIDER=pi`; tail server logs; inspect a `session_costs` row to confirm `durationMs > 0`.

**Implementation Note**: Pause; commit `[phase 7] pi-mono-adapter: real durationMs + real outputTokens`.

---

## Phase 8: Opencode + Devin adapter fixes

### Overview

Opencode percent clamping; Devin emits a synthetic context_usage event so `agent_tasks.peakContextTokens` updates for Devin tasks; Devin pricing-table row (`token_class='acu'`).

### Changes Required:

#### 1. Opencode percent clamp
**File**: `src/providers/opencode-adapter.ts`
**Changes**:
- Line 263: `contextPercent: Math.min(100, (contextUsed / contextTotal) * 100)`.

#### 2. Devin synthetic context emission
**File**: `src/providers/devin-adapter.ts`
**Changes**:
- After each poll that returns context-window info from Devin's API, emit a `context_usage` event with `contextUsedTokens: <devin-reported>`, `contextTotalTokens: <devin-reported>`, `contextPercent: clamped`, `outputTokens: undefined` (honest null vs the prior 0). If Devin's API doesn't report context use, skip — but still update `agent_tasks.contextWindowSize` from the model id's window on session start.
- Set `provider: "devin"` on CostData (already addressed in Phase 3 — double-check still set).

#### 3. Devin pricing-table read
**File**: `src/providers/devin-adapter.ts`
**Changes**:
- The constant at `:57` stays for now (per "Not Doing"). Phase 2 seeded a `provider='devin', token_class='acu'` row; recompute-on-ingest uses it. No adapter change required beyond the provider tag.

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] `bun test src/tests/providers/opencode-cost.test.ts` (new): contextPercent never > 100 even when contextUsed exceeds contextTotal (synthetic case).
- [ ] `bun test src/tests/providers/devin-cost.test.ts` (extended from Phase 3): assert `context_usage` event is emitted when poll returns context info; `outputTokens` is undefined/null, not 0.

#### Automated QA:
- [ ] `bun run scripts/devin-fixture.ts`: replay a recorded Devin run, assert `agent_tasks.peakContextTokens` is non-NULL after.

#### Manual Verification:
- [ ] Manual smoke with `HARNESS_PROVIDER=devin` on a small session; inspect `task_context_snapshots` rows — should have at least one.

**Implementation Note**: Pause; commit `[phase 8] opencode percent clamp + devin context emission`.

---

## Phase 9: Context-window utility unification

### Overview

After per-adapter cleanups, centralize the formula and the window-resolution. After this phase every provider that emits `context_usage` agrees on what the numbers mean.

### Changes Required:

#### 1. Unified utility
**File**: `src/utils/context-window.ts`
**Changes**:
- Add `computeContextUsedUnified({ inputTokens, cacheReadTokens, cacheCreateTokens, outputTokens })` = `input + cache_read + cache_create + output`.
- Existing `computeContextUsed` stays for backward-compat reads; mark deprecated.
- `getContextWindowSize` already extended in Phase 4; verify each provider's model-id maps land in this single function.
- Export a `CONTEXT_FORMULA: 'input-cache-output'` constant for adapters to stamp on `context_usage` events.

#### 2. Update each adapter to call the unified util
**File**: `src/providers/claude-adapter.ts`, `src/providers/claude-managed-adapter.ts`, `src/providers/codex-adapter.ts`, `src/providers/pi-mono-adapter.ts`, `src/providers/opencode-adapter.ts`, `src/providers/devin-adapter.ts`
**Changes**:
- Replace per-adapter context_used computation with `computeContextUsedUnified(...)`. Each context_usage event sets `contextFormula: CONTEXT_FORMULA`.
- For pi, output tokens come from Phase 7 fix. For devin, the synthetic emission from Phase 8 uses unified inputs when available, otherwise `contextFormula: 'harness-reported'`.
- Codex's `peak-proxy` (`max(0, input-cached) + output`) is replaced by the unified formula. Update comments around `codex-adapter.ts:761-794` explaining the switch.

#### 3. Percent clamp + sanity guard
**File**: `src/providers/claude-adapter.ts`, `src/providers/claude-managed-adapter.ts`, `src/providers/codex-adapter.ts`, `src/providers/pi-mono-adapter.ts`, `src/providers/opencode-adapter.ts`, `src/providers/devin-adapter.ts`
**Changes**:
- Wrap every `contextPercent` emission in `Math.min(100, Math.max(0, raw))`.
- If `contextTotalTokens` is missing (provider couldn't resolve a window), emit `contextPercent: null` rather than divide-by-zero.

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] `bun test src/tests/context-window.test.ts` — extended: every `(provider, model)` combination from the seed table resolves to a known non-default window; the unified formula matches expected for synthetic inputs.
- [ ] `bun test src/tests/providers/*.test.ts` — each adapter test verifies `contextFormula` field is set to `'input-cache-output'` (or `'harness-reported'` for devin without context API).

#### Automated QA:
- [ ] `bun run scripts/cross-provider-context-check.ts` (new): synthetic 50k-token prompt fed through each adapter (where mockable); asserts all 6 adapters emit the same `contextUsedTokens` within ±5% (small variation OK from cache accounting).

#### Manual Verification:
- [ ] Manual smoke: run a quick session against each provider on the same prompt, compare `peakContextPercent` in UI — should be in the same ballpark.

**Implementation Note**: Pause; commit `[phase 9] unified context-window utility + per-adapter switch`.

---

## Phase 10: DB write-path fixes

### Overview

After Phase 9, the adapter side emits coherent numbers. This phase fixes the DB writer so it stores them faithfully: `peakContextTokens` is monotonic-max, `contextWindowSize` is set on first snapshot (not just completion), and `progress` snapshots carry real cumulative token counts.

### Changes Required:

#### 1. peakContextTokens monotonic-max (already in Phase 1)
**File**: `src/be/db.ts`
**Changes**:
- Verify the Phase-1 `UPDATE agent_tasks SET peakContextTokens = MAX(...)` is wired everywhere that previously overwrote `totalContextTokensUsed`.

#### 2. contextWindowSize set on first snapshot
**File**: `src/be/db.ts` (~`:8365-8368`)
**Changes**:
- Change condition: set `contextWindowSize` if currently NULL AND incoming `contextTotalTokens` is non-null. Don't gate on `eventType === 'completion'`.

#### 3. Progress snapshots carry cumulative tokens
**File**: `src/commands/runner.ts` (~`:2015-2034`)
**Changes**:
- Read `latestCostData` (the running cost the adapter has been emitting) at the time of each progress snapshot POST; include `cumulativeInputTokens`/`cumulativeOutputTokens` in the body. Currently these are 0 for progress snapshots and only populated at completion (`:2154-2169`). The completion path stays as-is.

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] New test: `bun test src/tests/http/context-routes.test.ts` (new) — POST a series of progress snapshots with increasing token counts, assert `agent_tasks.peakContextTokens` increases monotonically and never decreases on dips.
- [ ] Same test: POST snapshots with `cumulativeInputTokens=1000`, assert DB row has 1000 (not 0).
- [ ] Same test: first POST sets `contextWindowSize`; subsequent dips don't unset it.

#### Automated QA:
- [ ] `bun run scripts/snapshot-walk.ts`: simulates a 5-turn session; reads `task_context_snapshots`; asserts cumulative tokens grow on every progress row, not just completion.

#### Manual Verification:
- [ ] Manual smoke: run a multi-turn session; inspect the task-detail UI — `current context %` and `peak context tokens` should display reasonable values throughout the session, not just at the end.

**Implementation Note**: Pause; commit `[phase 10] db write-path: peak max, contextWindowSize on first snapshot, cumulative on progress`.

---

## Phase 11: MCP store-progress drop cost + remove parallel path

### Overview

Remove the `cost` field from the `store-progress` tool input schema; remove the parallel `createSessionCost` call. Adapters become the sole writers of `session_costs`.

### Changes Required:

#### 1. Strip cost from tool schema
**File**: `src/tools/store-progress.ts`
**Changes**:
- Lines 27-49: drop the `cost` property from the Zod input schema.
- Lines 257-285: remove the `createSessionCost(...)` call entirely. Keep the rest of the tool (progress text, snapshots) intact.

#### 2. Migration note (optional)
**File**: `src/be/migrations/063_cost_context_schema_relax.sql` (extend Phase 1's migration)
**Changes**:
- Optional cleanup: `DELETE FROM session_costs WHERE sessionId LIKE 'mcp-%';` — purges historical double-count rows. Discuss with Taras; might want to preserve audit trail. Default: skip the DELETE, just stop writing new ones.

#### 3. Docs
**File**: `MCP.md`, `plugin/commands/store-progress.md`
**Changes**:
- Remove the `cost` parameter from the documented schema.

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] `bun test src/tests/store-progress-cost.test.ts` — UPDATE the test to assert that calling the tool with a `cost` field produces a Zod validation error (or simply: the field is no longer accepted).
- [ ] No `session_costs` rows with `sessionId LIKE 'mcp-%'` are produced by the test suite.

#### Automated QA:
- [ ] `bun run scripts/store-progress-smoke.ts`: calls the MCP tool with a sample payload; queries `session_costs`; asserts zero new rows; queries `task_progress` (or wherever progress lands), asserts row created.

#### Manual Verification:
- [ ] Skim diff: no leftover references to `mcp-` sessionId prefixes in writes anywhere.

**Implementation Note**: Pause; commit `[phase 11] store-progress: drop cost field, adapters are sole cost writers`.

---

## Phase 12a: UI cost-formatter consolidation

### Overview

Replace all 9 cost-rendering sites + 7 inline `toFixed` calls with one shared `formatCost` utility. Single rendering everywhere.

### Changes Required:

#### 1. Shared utility
**File**: `ui/src/lib/cost-format.ts` (new)
**Changes**:
- Export `formatCost(usd: number | null | undefined, opts?: { precision?: 'auto' | 'compact' | 'precise' | number; placeholder?: string }): string`.
- `auto` (default): `<$0.01` for tiny, 4dp for `<$1`, 2dp otherwise.
- `compact`: K/M bucketed, 1dp.
- `precise`: 6dp (for pricing-table cells).
- Returns `placeholder || '—'` for null/undefined; returns `'$0'` for 0.

#### 2. Replace all call sites
**File**: `ui/src/lib/utils.ts`, `ui/src/components/shared/stats-bar.tsx`, `ui/src/pages/budgets/page.tsx`, `ui/src/components/dashboard/agent-node.tsx`, `ui/src/components/dashboard/agent-table.tsx`, `ui/src/pages/sessions/[rootTaskId]/page.tsx`, `ui/src/components/sessions/task-detail-sheet.tsx`, `ui/src/pages/tasks/[id]/page.tsx`, `ui/src/pages/api-keys/page.tsx`, `ui/src/components/agent-runtime-settings.tsx`, `ui/src/components/shared/usage-summary.tsx`, `ui/src/pages/usage/page.tsx`
**Changes**:
- `ui/src/lib/utils.ts:138-145` — re-export `formatCurrency = formatCost(..., {precision:'compact'})` or delete and migrate callers.
- `ui/src/components/shared/stats-bar.tsx:73-76` — use `formatCost(..., {precision:'compact'})`.
- `ui/src/pages/budgets/page.tsx:62-64` — use `formatCost(..., {precision:'auto'})`.
- `ui/src/components/dashboard/agent-node.tsx:37-42` — use `formatCost(..., {precision:'auto'})`.
- `ui/src/components/dashboard/agent-table.tsx:31-34` — use `formatCost(..., {precision:'auto'})`.
- `ui/src/pages/sessions/[rootTaskId]/page.tsx:29-33` — use `formatCost(..., {precision:'precise'})`.
- `ui/src/components/sessions/task-detail-sheet.tsx:41-45` — same.
- `ui/src/pages/tasks/[id]/page.tsx:299` — replace `toFixed(4)`.
- `ui/src/pages/api-keys/page.tsx:298, :340` — replace both `toFixed` calls.
- `ui/src/pages/budgets/page.tsx:684` — replace pricing `toFixed(6)` with `formatCost(..., {precision:'precise'})`.
- `ui/src/components/agent-runtime-settings.tsx:262-264` — bucket logic → shared util.
- `ui/src/components/shared/usage-summary.tsx:158` — chart label inline `toFixed(3)` → shared util.
- `ui/src/pages/usage/page.tsx:150` — same.

### Success Criteria:

#### Automated Verification:
- [ ] `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b` passes.
- [ ] `cd ui && pnpm test ui/src/lib/cost-format.test.ts` (new): exhaustive table of `(input, opts, expected)` cases.
- [ ] `grep -r "toFixed\(.*\)" ui/src/ --include='*.tsx' --include='*.ts'` shows no remaining cost-related `toFixed` calls (token counts and percentages can keep theirs).

#### Automated QA:
- [ ] qa-use session — per CLAUDE.md, frontend PRs require qa-use with screenshots. Spec: navigate to /dashboard, /tasks/<id>, /sessions/<rootId>, /budgets, /api-keys, /usage; screenshot each page's cost columns; verify rendering matches expected precision per page.

#### Manual Verification:
- [ ] Eye-check the 9 pages. Same cost ($0.0125 USD) should render: compact in dashboard, 4dp in tasks, 6dp in pricing cell.

**Implementation Note**: Pause; commit `[phase 12a] UI: single formatCost utility, all sites migrated`.

### QA Spec (optional):
**QA Doc**: `thoughts/taras/qa/2026-05-15-cost-format-consolidation.md` — multi-page screenshot evidence per Frontend Merge Gate rule.

---

## Phase 12b: UI surfaces costSource + contextFormula

### Overview

Propagate `costSource` (from `session_costs`) and `contextFormula` (from `task_context_snapshots`) through the UI types and render them as badges, so users can tell whether a cost was harness-reported or pricing-recomputed, and which context formula was in play.

### Changes Required:

#### 1. Type propagation
**File**: `ui/src/api/types.ts`
**Changes**:
- `SessionCost` interface (~lines 429-444): add `costSource: 'harness' | 'pricing-table' | 'unpriced'`.
- `ContextSnapshot` interface (~lines 969-983): add `contextFormula: string | null`.

#### 2. Fetcher untouched
**File**: `ui/src/api/client.ts:496-539`
**Changes**: Server already returns the fields after Phase 1+2; the fetcher just deserializes. Verify the response shape lines up.

#### 3. Render badges
**File**: `ui/src/pages/tasks/[id]/page.tsx`, `ui/src/components/sessions/task-detail-sheet.tsx`
**Changes**:
- `ui/src/pages/tasks/[id]/page.tsx` in `TaskCostSection` (~`:241-450`): badge next to each cost row — `harness` (gray), `pricing-table` (green), `unpriced` (yellow).
- `ui/src/components/sessions/task-detail-sheet.tsx`: same.
- `ui/src/pages/tasks/[id]/page.tsx` in `TaskContextSection` (~`:412`): show `contextFormula` next to context-percent number.

### Success Criteria:

#### Automated Verification:
- [ ] `cd ui && pnpm exec tsc -b` passes.
- [ ] Visual snapshot test (or component test) for the cost-row badge — assert badge text matches `costSource`.

#### Automated QA:
- [ ] qa-use: navigate to a task with a known `costSource='pricing-table'` row; screenshot the badge.

#### Manual Verification:
- [ ] Cross-provider eye check: open three tasks (claude, codex, pi); all three render cost with a badge and the formula label.

**Implementation Note**: Pause; commit `[phase 12b] UI: surface costSource and contextFormula in task views`.

### QA Spec (optional):
Folded into Phase 12a's QA doc.

---

## Phase 13: Dashboard date filter + INNER JOIN fixes

### Overview

Fix the two well-known query bugs from §9.5-9.6 of the research: `getDashboardCostSummary`'s ISO-string lexicographic comparison and `getKeyCostSummary`'s INNER JOIN drop.

### Changes Required:

#### 1. Numeric date filter
**File**: `src/be/db.ts` (~`:4112-4125`)
**Changes**:
- Replace `createdAt >= date('now')` with an explicit epoch-ms boundary computed in TS and passed as a `?` parameter. SQL becomes `WHERE createdAt >= ?` where `?` is the ISO 8601 string for "today at 00:00:00 UTC" (or local — pick one consistently and document it). String comparison on ISO 8601 then sorts correctly even for cross-day edges.
- Apply same fix to `monthStart` comparison.

#### 2. LEFT JOIN for api-keys cost summary
**File**: `src/be/db.ts` (~`:8627-8653`)
**Changes**:
- `JOIN agent_tasks t ON sc.taskId = t.id` → `LEFT JOIN agent_tasks t ON sc.taskId = t.id`. Cost rows with NULL `taskId` are no longer dropped from per-key totals.
- Verify no downstream code assumes `t.*` is always non-null in this query.

#### 3. UI gotcha comment
**File**: `ui/src/pages/budgets/page.tsx:346-349`
**Changes**:
- Remove the lex-comparison warning comment since the underlying bug is fixed.

### Success Criteria:

#### Automated Verification:
- [ ] Type/lint pass.
- [ ] `bun test src/tests/db/dashboard-date-filter.test.ts` (new): seed `session_costs` rows for "yesterday", "today early am UTC", "today late pm UTC"; assert `getDashboardCostSummary().costToday` includes only the today rows regardless of TZ.
- [ ] `bun test src/tests/db/api-keys-cost-orphan-task.test.ts` (new): insert a `session_costs` row with `taskId=NULL`; assert `getKeyCostSummary` includes it.

#### Automated QA:
- [ ] qa-use: visit `/dashboard`; assert "Today" and "MTD" cost totals are non-NaN and match a hand-computed value against seeded data.

#### Manual Verification:
- [ ] None beyond automated.

**Implementation Note**: Pause; commit `[phase 13] dashboard date filter numeric + api-keys LEFT JOIN`.

---

## Phase 14: Docs — cost & context computation page + harness-providers update

### Overview

Add a canonical docs page explaining how cost and context-window numbers are computed per harness — the "single source of truth" the team and contributors can point to. Update the existing harness-providers guide with cross-references.

### Changes Required:

#### 1. New docs page
**File**: `docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx` (new)
**Changes**:
- Section: "How cost is computed" — the three call paths (harness-trusted, worker-local table, server recompute via `pricing` table); the unified `costSource` enum and what each value means; how to read it in the UI.
- Section: "How the pricing table is seeded" — models.dev snapshot is the source of truth; vendored cache path; refresh script (`scripts/refresh-modelsdev-pricing.ts`); manual-override constants for runtime-fee/ACU; link to `pricing-sources.md`.
- Section: "How context-window usage is computed" — the unified `input + cache_read + cache_create + output` formula; per-model window resolution (shortname + dated-id matching); `contextFormula` field on snapshots; clamp/null semantics; the Claude-Code-status-line analogy for `peakContextTokens`.
- Section: "Per-provider notes" — anything still provider-specific after this plan (e.g. Devin context is harness-reported when available, otherwise null; opencode pricing is passthrough from upstream SDK).
- Section: "Gotchas & known limitations" — internal-ai Gemini calls aren't yet costed (derail note); model-id key convention drift between internal-ai and pricing-table.

#### 2. Cross-reference from harness-providers guide
**File**: `docs-site/content/docs/(documentation)/guides/harness-providers.mdx`
**Changes**:
- Add a "Cost & context tracking" subsection per provider, ~2 sentences each, pointing at the new page for the full story.

#### 3. Cross-reference from CLAUDE.md
**File**: `CLAUDE.md`
**Changes**:
- Add an `<important if="you are modifying cost or context tracking code (src/providers/*, src/utils/context-window.ts, src/be/seed-pricing.ts, src/http/session-data.ts, src/http/context.ts)">` block referencing both `docs-site/.../cost-and-context-computation.mdx` and `src/providers/pricing-sources.md`. Same-PR doc-update rule mirrors the harness-providers convention at `runbooks/harness-providers.md`.

### Success Criteria:

#### Automated Verification:
- [ ] Docs site builds: `cd docs-site && pnpm install --frozen-lockfile && pnpm build`.
- [ ] No broken internal links: `grep -r "cost-and-context-computation" docs-site/content/` resolves to the new file.
- [ ] No drift: `bash scripts/check-db-boundary.sh` still passes (sanity).

#### Automated QA:
- [ ] `bun run scripts/verify-docs-coverage.ts` (new, optional): asserts the new page mentions every value of the `costSource` enum and every `contextFormula` enum value at least once.

#### Manual Verification:
- [ ] Eye-check the new page against the implemented behavior — every claim corresponds to code that landed in phases 1-13.
- [ ] Confirm harness-providers.mdx links resolve.

**Implementation Note**: Pause; commit `[phase 14] docs: cost & context computation guide + harness-providers cross-refs`.

---

## Appendix

- **Follow-up plans**: none; this plan is the full roadmap. Phases 4-8 are independent and could be parallelized into separate PRs if multiple agents pick this up.
- **Derail notes**:
  - **Internal-ai uncosted Gemini calls**: `src/utils/internal-ai/models.ts:19-25` uses `openrouter/google/gemini-3-flash-preview` for summarization/rating. After Phase 1+2 the pricing-table accepts `gemini` rows but the internal-ai path doesn't currently emit `session_costs`. Worth a follow-up: instrument internal-ai's OpenRouter client to write rows.
  - **Model-id key mismatch** between internal-ai (`openai-codex/gpt-5.4-mini`) and pricing-table seeds (`codex/gpt-5.4-mini`). Pick one convention (likely strip the harness prefix) and migrate seed + internal-ai together.
  - **Timestamp convention split** (TEXT ISO 8601 vs INTEGER epoch-ms) stays in place — out of scope but a future cleanup.
  - **session_costs has no flow / per-run aggregate**. Per-task SUM aggregation works because adapters write one row per CLI invocation, but adding a `task_runs` table would be cleaner. Out of scope.
- **References**:
  - Research: `thoughts/taras/research/2026-05-15-context-cost-tracking-gaps.md`
  - Claude Code stream-json format research: `thoughts/taras/research/2026-03-28-claude-code-input-format-stream-json.md`
  - Local testing recipes: `LOCAL_TESTING.md`
  - Business-use events: `BUSINESS_USE.md`
  - MCP tools reference: `MCP.md`
