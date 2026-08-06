---
date: 2026-08-06T15:00:00Z
topic: "Cost accuracy: fix task/session cost vs harness cost mismatch"
status: completed
autonomy: autopilot
tags: [cost-tracking, pricing, session-costs, providers]
---

# Cost Accuracy (100% pricing) Implementation Plan

## Overview

Make the stored session/task cost match what the provider actually bills, across all harnesses — and make any future divergence visible instead of silent.

- **Motivation**: Prod audit found stored claude costs run 19.3% below harness-reported costs ($4,246 on an 8,996-task sample); five independent root causes identified and verified to the cent.
- **Related**: `thoughts/taras/research/2026-08-06-task-vs-session-cost-mismatch-audit.md`

## Current State Analysis

(Full evidence: research doc. Summary of what's load-bearing for this plan.)

- `POST /api/session-costs` (`src/http/session-data.ts:200-319`) discards the harness `totalCostUsd` and recomputes `tokens × pricing` whenever provider+model pricing rows exist (`costSource='pricing-table'`). The harness number survives only in raw `session_logs`.
- Recompute formula (`session-data.ts:262-270`): `max(0, input − cacheRead) × in + cacheRead × cached + cacheWrite × cache_write + output × out`. Four defects:
  1. Single `cache_write` class at the 5m rate (1.25× input); Anthropic bills 1h writes at 2× and **98.9% of prod claude cache-write tokens are 1h TTL**. Dominant error (~$5.1k under on the audit sample).
  2. `max(0, input − cacheRead)` zeroes claude/pi uncached input (Anthropic semantics: input excludes cache reads).
  3. Tokens come from the claude result event's `usage`, which covers the **main thread only** — subagent/sidechain tokens (in `modelUsage`) never reach the server. Verified: a task with usage=34.5k output actually consumed 165k.
  4. All tokens priced at one model's rate even for multi-model sessions.
- **Verified on prod**: per-message reconstruction from assistant stream events is NOT viable (output_tokens are message_start snapshots — 795 vs 160,898 actual; haiku sidechain usage absent entirely). `result.modelUsage` is the only complete per-model token source, and `Σ modelUsage[*].costUSD == total_cost_usd` exactly. `modelUsage` has **no TTL split**; only top-level `usage.cache_creation` (main thread) has it.
- Opencode adapter (`opencode-adapter.ts:433-460`) accumulates every finalized `message.updated` with no message-id dedup → ~2× inflation (37/42 prod tasks show duplicate finalized events; unpriced rows store exactly 2× truth).
- Codex adapter prices from build-time vendored snapshot + hardcoded fallback (`codex-models.ts:141-205`); server prices from runtime-refreshed table → drift (luna currently 5×). GPT-5.6 family bills 2× above 272k context; nobody is tier-aware.
- Rate truth is per-model: sonnet-5 has intro pricing $2/$10 until 2026-08-31 (models.dev/server correct, Claude Code's bundled table stale-high ~50%); opus-5 5/25 agrees everywhere.

## Desired End State

- Every `session_costs` row stores **both** numbers: `totalCostUsd` (canonical server recompute) and `harnessCostUsd` (adapter-reported, advisory).
- Claude recompute reproduces Anthropic billing math to the cent on golden fixtures taken from prod (task `aef117fe` → $9.4629795; multi-model task `f9769315` priced per model from modelUsage).
- Cache writes priced per TTL (`cache_write` 5m + `cache_write_1h` 2× classes); per-model breakdown priced at each model's own rate; anthropic-style input not zeroed; opencode not double-counted.
- Drift (stored vs harness) is observable per provider/model — otel metric + API summary + UI hint — so future rate divergence is detected, not silent.

## What We're NOT Doing

- **No tier-aware codex pricing** (>272k context 2× tier): aggregate token counts can't attribute per-request tiers. Documented as a known bound in `pricing-sources.md`; would need per-turn accumulation later.
- **No per-model TTL exactness for sidechains**: `modelUsage` lacks the 5m/1h split, so sidechain cache writes inherit the session's TTL mode (exact for the main thread via `usage.cache_creation`; 98.9% of prod write tokens are 1h anyway). Documented approximation.
- **No historical backfill by default** — optional gated script phase at the end; prod run is Taras's call.
- **No child table for per-model rows** — JSON `modelBreakdown` column instead (keeps 1 row/session; `durationMs`/`numTurns` stay unduplicated; dashboards unchanged).
- Not touching devin (ACU-based, unaffected) or the claude-managed runtime-hour fee logic.

## Implementation Approach

- **Measure first, then fix**: land dual-write (`harnessCostUsd`) + drift metric before the correctness fixes, so drift visibly collapses as fixes land.
- **Tokens are the source of truth, never harness dollars**: harness cost tables go stale (sonnet-5). Server recomputes from tokens × refreshed rates; harness number is kept for reconciliation only.
- **Semantics normalized server-side** (per-provider input-token semantics map) — no wire-format version dance with older worker images; old rows/POSTs keep working.
- **Golden tests from prod-verified numbers** — the audit reconciled three tasks to the cent; those become fixtures.

## Quick Verification Reference

- `bun run tsc:check && bun run lint`
- `bun run test:root -- src/tests/<file>.test.ts`
- Migration: `rm -f agent-swarm-db.sqlite && bun run start:http` (fresh) + boot against an existing dev DB
- Route changes: `bun run docs:openapi` and commit `openapi.json`

---

## Phase Outline

1. **Schema + dual-write + drift visibility** — migration adds `harnessCostUsd`, `cacheWrite5mTokens`, `cacheWrite1hTokens`, `modelBreakdown` (JSON) to `session_costs`; POST stores the harness number instead of discarding it; otel drift metric; drift in summary API + UI hint.
2. **Claude adapter: emit the whole truth** — parse `usage.cache_creation` TTL split; build per-model token breakdown from `result.modelUsage`; extend `CostData` + runner POST.
3. **Server pricing correctness** — `cache_write_1h` token class (seed + refresh derive 2× input); per-model pricing loop over the breakdown; provider-aware input semantics; golden tests reproducing prod-verified numbers to the cent.
4. **Opencode dedup** — message-id keyed accumulation (keep last finalized snapshot per id); unit test with duplicated-event fixture.
5. **Codex turn accumulation + rate unification + docs** — fix `lastUsage` overwrite (multi-turn under-count); fallback map refreshed and demoted to advisory; >272k tier bound + the whole contract documented (`cost-and-context-computation.mdx`, `pricing-sources.md`).
6. **Optional: historical backfill script** — recompute claude rows from `session_logs` result lines (gated; prod run is a separate decision).

---

## Phase 1: Schema + dual-write + drift visibility

### Overview

Every new `session_costs` row stores the harness-reported cost alongside the recomputed one, and drift between them is observable (otel + task page). No pricing behavior changes yet — this phase is pure measurement.

### Changes Required:

#### 1. Migration `src/be/migrations/127_session_costs_accuracy.sql`
**Changes**: `ALTER TABLE session_costs ADD COLUMN` × 4, all nullable (NULL = "predates this feature / not reported"):
- `harnessCostUsd REAL` — adapter-reported cost, advisory
- `cacheWrite5mTokens INTEGER`, `cacheWrite1hTokens INTEGER` — TTL split (used by Phase 3)
- `modelBreakdown TEXT` — JSON array of per-model token/cost entries (used by Phases 2–3)
`session_costs` is exempt in `.non-audit-tables:30`, so no `created_by`/`updated_by` needed. Forward-only, additive — safe for existing DBs.

#### 2. Types
**File**: `src/types.ts` (SessionCostSchema ~:1165-1193)
**Changes**: add `harnessCostUsd: z.number().nullable().optional()`, `cacheWrite5mTokens`/`cacheWrite1hTokens` (int, nullable, optional), `modelBreakdown` (typed object array, nullable). New `SessionCostModelBreakdownSchema`: `{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchRequests?, costUsd? }`.

#### 3. POST handler + DB write
**File**: `src/http/session-data.ts` (`createSessionCostRoute` body ~:70-102, handler ~:200-319)
**Changes**: accept new optional body fields (`cacheWrite5mTokens`, `cacheWrite1hTokens`, `models[]`). In the recompute branch, keep `parsed.body.totalCostUsd` as `harnessCostUsd` instead of discarding it (also set it when costSource stays `harness`/`unpriced` — then the two are equal by definition).
**File**: `src/be/db.ts` (`CreateSessionCostInput` :6661-6688, insert :6612-6643, `createSessionCost` :6690-6735)
**Changes**: add the 4 columns to input type + INSERT + returned object.

#### 4. Otel drift metric
**File**: `src/otel.ts` :141-144 / `src/otel-impl.ts` (`SessionCostMetric` :247-261, impl :276-295)
**Changes**: add `harnessCostUsd?: number` to `SessionCostMetric`; in impl, when both values are finite and harness > 0, record `agentswarm.cost.drift.usd` counter (stored − harness, can be negative → record absolute + a `drift_sign` attribute or two counters) with `harness`/`model`/`cost_source` attributes. Thread from `session-data.ts:297`.

#### 5. UI: surface both numbers
**File**: `apps/ui/src/api/types.ts` (SessionCost :768-790) — add the new optional fields.
**File**: `apps/ui/src/pages/tasks/[id]/page.tsx` (`TaskCostSection` :266-346) — sum `harnessCostUsd` too; when it differs from `totalCostUsd` by >2%, render a drift hint next to `CostSourceBadge` (:329-333).
**File**: `apps/ui/src/components/shared/cost-source-badge.tsx` — accept optional `harnessCostUsd`/`totalCostUsd` props; reuse the `Tooltip`+breakdown pattern from `harness-cell.tsx:69-205` to show "harness $X · recomputed $Y · Δ Z%".

#### 6. OpenAPI
Route body changed → `bun run docs:openapi`, commit `openapi.json` + regenerated api-reference docs.

### Success Criteria:

#### Automated Verification:
- [x] `bun run tsc:check` and `bun run lint` pass
- [x] New/updated unit test: POST with provider+model+pricing rows stores BOTH `totalCostUsd` (recomputed) and `harnessCostUsd` (body value): `bun run test:root -- src/tests/session-costs-recompute-all-providers.test.ts`
- [x] Existing suite green: `bun run test:root -- src/tests/session-costs.test.ts src/tests/session-costs-codex-recompute.test.ts src/tests/otel-session-cost-metrics.test.ts`
- [x] Fresh-DB migration boots: `rm -f agent-swarm-db.sqlite* && timeout 15 bun run start:http` (then Ctrl-C); existing-DB boot also verified (second boot on same DB — migration 127 applied once)
- [x] `bash scripts/check-audit-columns.sh` passes (session_costs already exempt)
- [x] `bun run docs:openapi` produces a committed diff
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] Agent-driven: POST a synthetic session-cost via curl (harness $10, tokens that recompute to a different value), then GET `/api/session-costs?taskId=...` and assert both fields present and different — PASS: recompute $7.500625 vs harness $10 both stored; TTL split + modelBreakdown round-trip intact (note: agentId has an FK to agents — QA registered a real agent first)

#### Manual Verification:
- [ ] Task detail page shows the drift tooltip on a task with differing values (screenshot)

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 2: Claude adapter — emit the whole truth

### Overview

Claude's `CostData` carries the cache-TTL split and the complete per-model token breakdown from `result.modelUsage` (the only complete source — per-message reconstruction verified broken on prod).

### Changes Required:

#### 1. `CostData` type
**File**: `src/providers/types.ts:2-34`
**Changes**: add `cacheWrite5mTokens?: number`, `cacheWrite1hTokens?: number`, `models?: CostModelUsage[]` where `CostModelUsage = { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, webSearchRequests?, harnessCostUsd? }`.

#### 2. Claude adapter result handler
**File**: `src/providers/claude-adapter.ts:932-978`
**Changes**: parse `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` → the two new fields (leave undefined when `cache_creation` absent — old CLI versions). Map `json.modelUsage` entries → `models[]` (`cacheCreationInputTokens`→`cacheWriteTokens`, `costUSD`→`harnessCostUsd`, `webSearchRequests` passthrough). `totalCostUsd` stays the harness self-report (lands in `harnessCostUsd` server-side per Phase 1).

#### 3. Runner
**File**: `src/commands/runner.ts:2088-2110` (`saveCostData`)
**Changes**: none — POSTs `CostData` verbatim; Phase 1 already widened the body schema. Verify only.

### Success Criteria:

#### Automated Verification:
- [x] New test in `src/tests/claude-adapter.test.ts` (processStreams style, mocked `Bun.spawn` streaming NDJSON per the comment at `:188-194`): a result line with `cache_creation` split + 2-model `modelUsage` → `CostData` carries split + both model entries with exact token numbers
- [x] Old-CLI compat test: result line WITHOUT `cache_creation`/`modelUsage` → fields undefined, no throw
- [x] `bun run test:root -- src/tests/claude-adapter.test.ts src/tests/claude-adapter-otel.test.ts` (55 pass)
- [x] `bun run tsc:check && bun run lint`

#### Automated QA:
- [x] Replay the prod `aef117fe` result line (fixture from the research doc) through the adapter; assert `cacheWrite1hTokens === 199428`, `cacheWrite5mTokens === 0` — landed as a permanent test case (also pins `totalCostUsd === 9.4629795`)

#### Manual Verification:
- [ ] None (covered by automated)

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 3: Server pricing correctness (golden-tested)

### Overview

The recompute reproduces provider billing math exactly: TTL-aware cache writes, per-model pricing over the breakdown, anthropic-style input semantics, claude-managed runtime fee, web-search requests. Golden tests pin the three prod-verified tasks to the cent.

### Changes Required:

#### 1. Token classes + seed/refresh
**File**: `src/types.ts:2545-2554` — add `"cache_write_1h"` and `"web_search"` to `PricingTokenClassSchema` (Zod is the sole gate since migration 063; no SQL migration needed).
**File**: `src/be/seed-pricing.ts` (`projectCostBlock` :90-123) — for providers `claude`/`claude-managed`/`pi` (Anthropic-billed), also emit `cache_write_1h = 2 × cost.input` when `cost.cache_write` exists. `pricing-refresh.ts` consumes the same builder (`insertChangedPricingRows` :42-71) — no refresh-side change.
**File**: `src/be/seed-pricing.ts` (`MANUAL_PRICING_OVERRIDES` :36-65) — add `web_search` for `claude`/`claude-managed`, model `'*'`, `pricePerMillionUsd = 10 × 1000` ($10 per 1k requests, per-request unit convention documented next to `runtime_hour`).

#### 2. Recompute rewrite
**File**: `src/http/session-data.ts:200-319`
**Changes**: extract a pure `recomputeSessionCost(body, lookupRates)` (new `src/http/session-cost-recompute.ts`) so it's unit-testable:
- Input semantics map: `ANTHROPIC_INPUT_PROVIDERS = {claude, claude-managed, pi}` → uncached input = `inputTokens` as-is; others keep `max(0, input − cacheRead)` (codex confirmed OpenAI-inclusive at `codex-adapter.ts:952-955`; opencode stays OpenAI-style pending verification — see derail notes).
- Cache-write pricing: when the 5m/1h split is present, price each part at its class rate. When absent, legacy single-class behavior.
- Per-model loop: when `body.models[]` present, price each entry at its own (normalized) model rates; distribute the session TTL ratio `r = w1h/(w1h+w5m)` across each model's cacheWriteTokens (r is 0 or 1 in practice; documented approximation for sidechains). If ANY model lacks input+output rows → whole row `unpriced` (keep harness value; partial pricing is dishonest). Totals stored on the row = sums across models; `modelBreakdown` JSON stores per-model tokens + priced `costUsd` + `harnessCostUsd`.
- claude-managed: add runtime fee `durationMs/3_600_000 × rate(runtime_hour, '*')` — the current recompute silently DROPS the $0.08/h fee that `claude-managed-adapter.ts:405-425` includes (defect found during planning).
- web_search: `Σ models[].webSearchRequests × rate / 1e6`.

#### 3. Golden tests
**File**: new `src/tests/session-costs-golden.test.ts` (real-HTTP-server pattern from `session-costs-codex-recompute.test.ts`, rates via `insertPricingRow`):
- `aef117fe` (opus-5, single model, all-1h writes): expect `totalCostUsd === 9.4629795` exactly
- `f9769315` (opus-4-8 + haiku breakdown): per-model pricing; totals = sum of both models' tokens
- `28943d8a` (sonnet-5 at intro rates 2/10/0.2, 1h write 4.0): expect `20.6115904` (compute in-test; the plan's earlier `20.610840…` literal was a hand-arithmetic slip) — and `harnessCostUsd` stores 30.9174
- codex row: input-inclusive subtraction unchanged
- claude-managed row: token cost + runtime fee ≈ adapter's own arithmetic (`claude-managed-adapter.test.ts:895-961` parity)

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/session-costs-golden.test.ts` — golden numbers exact (no toBeCloseTo; string/epsilon ≤ 1e-9) — 12 pass
- [x] Full cost suite: `bun run test:root -- src/tests/session-costs.test.ts src/tests/session-costs-codex-recompute.test.ts src/tests/session-costs-recompute-all-providers.test.ts src/tests/session-costs-model-key-normalize.test.ts src/tests/pricing-refresh.test.ts src/tests/pricing-routes.test.ts src/tests/otel-session-cost-metrics.test.ts` — 118 pass across 8 files (incl. golden)
- [x] `bun run tsc:check && bun run lint`
- [x] Fresh-DB boot seeds `cache_write_1h` rows: 140 rows (+ 2 `web_search` rows); opus-5 1h = $10/M = 2× input confirmed

#### Automated QA:
- [x] End-to-end POST replay of all three prod fixtures against a locally seeded server (REAL models.dev seeded rates, not test-injected): `aef117fe` → 9.4629795 EXACT; `28943d8a` → 20.6115904 at intro rates with harness 30.9173856 preserved; `f9769315` → 12.491706 without web searches, and EXACTLY 13.051706 (== harness) once `webSearchRequests: 56` is included — the $0.56 gap in the audit was 56 web searches at $0.01, now priced

#### Manual Verification:
- [ ] None

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 4: Opencode message-id dedup

### Overview

Opencode cost/token accumulation is keyed by message id (last finalized snapshot wins), killing the ~2× inflation confirmed on 37/42 prod tasks.

### Changes Required:

#### 1. Adapter accumulator
**File**: `src/providers/opencode-adapter.ts:433-460`
**Changes**: replace running `+=` fields with `finalizedMessages = Map<string, {cost, tokens}>` keyed on `msg.id`; on each finalized `message.updated`, upsert the snapshot; totals derived by summing the map (in `buildCostData` :592-608, and for `numTurns` = map size). Also accumulate `msg.tokens.reasoning` → `reasoningOutputTokens` (currently dropped). `context_usage` emit block (:461-481) unchanged (last-write-wins gauge; harmless on duplicates).

#### 2. Tests
**File**: `src/tests/opencode-adapter.test.ts` (cost-aggregation describe :532-597)
**Changes**: add cases — (a) same `msg.id` finalized twice → counted once; (b) second finalized update with different cost → last value used; (c) two distinct ids → summed; (d) reasoning tokens accumulate.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/opencode-adapter.test.ts` (36 pass; 4 new dedup/last-wins/reasoning cases)
- [x] `bun run tsc:check && bun run lint`

#### Automated QA:
- [x] Replay a captured prod duplicate-event sequence (from task `8fc625d7`, the exact-2× example) through the adapter → cost equals the deduped truth — verified against the REAL prod events 2026-08-06: 134 finalized `message.updated` over 67 distinct ids (exact 2×); dedup-by-id sum $0.253684 vs stored $0.507368512 (= 2× exactly); event shape matches the unit-test fixtures (same id finalized twice, identical values)

#### Manual Verification:
- [ ] None

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 5: Codex turn accumulation + rate unification + docs

### Overview

Codex sessions sum usage across turns instead of keeping only the last turn (defect found during planning: `lastUsage` is overwritten at `codex-adapter.ts:945`, so steered/multi-turn sessions under-count); codex fallback rates refreshed; the whole contract documented.

### Changes Required:

#### 1. Codex adapter
**File**: `src/providers/codex-adapter.ts:945` (turn.completed) + `:692-730` (buildCostData)
**Changes**: accumulate `turn.completed` usage into running totals (Σ input/cached/output/reasoning across turns) instead of overwriting `lastUsage`. First: add a 2-turn fixture test to pin the SDK semantic (per-turn usage per the adapter's own comment at :952-955); if the SDK turns out to report cumulative-across-turns, keep overwrite and document — the test decides.
**File**: `src/providers/codex-models.ts:141-205` — update `FALLBACK_CODEX_MODEL_PRICING` (terra 2.5/15 vs published 2/12; luna 1/6 vs 0.2/1.2) and add a comment: fallback is advisory only; canonical price is the server recompute; drift metric (Phase 1) is the watchdog.

#### 2. Docs (same-PR rule)
**File**: `docs-site/content/docs/(documentation)/guides/cost-and-context-computation.mdx`
**Changes**: document dual numbers (`totalCostUsd` canonical recompute vs `harnessCostUsd` advisory), TTL classes, per-model breakdown, input-semantics map, drift metric.
**File**: `src/providers/pricing-sources.md`
**Changes**: sonnet-5 intro-pricing note (until 2026-08-31), GPT-5.6 >272k 2× tier as a documented under-count bound, codex fallback demotion.

### Success Criteria:

#### Automated Verification:
- [x] New codex test: two `turn.completed` events → summed tokens in `CostData`: `bun run test:root -- src/tests/codex-adapter.test.ts` (73 pass; SDK `Usage` documented per-turn → accumulation)
- [x] `bun run test:root -- src/tests/codex-adapter-otel.test.ts src/tests/codex-swarm-events.test.ts` (15 pass)
- [x] `bun run tsc:check && bun run lint` (full 13-file cost/adapter battery: 276 pass)
- [x] EXTRA (refresh fallout repair): the Phase-3 models.dev snapshot refresh dropped delisted-but-still-runnable models (gpt-5.1/5.2-codex family, 12 legacy anthropic ids), breaking context-window + reasoning-effort gating (3 codex-adapter tests). Fixed durably: 5 codex pins in `PINNED_MODELSDEV_ENTRIES` + `carryForwardDelistedModels()` in `scripts/refresh-modelsdev-pricing.ts` (515 entries carried forward); cold-start re-verified (sonnet-5 $2 intro, 1h rows seeded)

#### Automated QA:
- [x] Docs-only change verified side-effect-free (no route/schema changes; `openapi.json` untouched by Phase 5); mdx content cross-checked against shipped recompute behavior

#### Manual Verification:
- [ ] Skim the two doc pages for accuracy against the shipped behavior

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 6 (optional, gated): historical backfill

### Overview

A dry-run-by-default script recomputes historical claude `pricing-table` rows from `session_logs` result lines (harnessCostUsd + modelBreakdown + corrected totals). Prod execution is a separate go/no-go with Taras.

### Changes Required:

#### 1. Script
**File**: new `scripts/backfill-cost-accuracy.ts`
**Changes**: iterate claude result lines (same parse as the audit script), join to `session_costs` rows, write `harnessCostUsd` always; with `--apply --recompute` also rewrite `totalCostUsd` using Phase-3 logic. Default = dry-run report (counts + $ deltas per model). Reuses `recomputeSessionCost` from Phase 3.

### Success Criteria:

#### Automated Verification:
- [ ] Dry-run against a dev DB copy completes and reports plausible deltas: `bun run scripts/backfill-cost-accuracy.ts --db ./agent-swarm-db.sqlite`
- [ ] `bun run tsc:check && bun run lint`

#### Automated QA:
- [ ] On a synthetic DB seeded with the golden fixtures, `--apply` produces exactly the golden totals

#### Manual Verification:
- [ ] Taras decides whether/when to run against prod (backup first per prod runbook)

**Implementation Note**: This phase is optional — skip unless explicitly requested.

---

## Manual E2E (against a real local stack)

Copied from `LOCAL_TESTING.md` (minimal smoke) + `swarm-local-e2e` skill for the task round-trip:

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Build worker image (slim sufficient)
bun run docker:build:worker:slim

# 3. Start lead + worker (branch-specific names)
SUFFIX=$(git branch --show-current | tr '/' '-')
docker run --rm -d --name e2e-lead-$SUFFIX --env-file .env.docker-lead \
  -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:slim
docker run --rm -d --name e2e-worker-$SUFFIX --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:slim

# 4. Verify registration (wait ~15s)
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
  | jq '.agents[] | {name, isLead, status}'

# 5. Run a trivial claude task through the swarm-local-e2e skill flow ("Say hi")
#    (skill owns task creation + log verification)

# 6. THE assertion — both numbers stored, split + breakdown present:
sqlite3 agent-swarm-db.sqlite "SELECT model, costSource, totalCostUsd, harnessCostUsd, \
  cacheWrite1hTokens, cacheWrite5mTokens, substr(modelBreakdown,1,120) \
  FROM session_costs ORDER BY createdAt DESC LIMIT 3;"
# Expect: harnessCostUsd NOT NULL; for claude: cacheWrite1hTokens > 0 (worker CC uses 1h TTL);
# totalCostUsd within ~1% of harnessCostUsd for a single-model no-search task on a
# correctly-priced model (opus-5) — the two now agree because the recompute is TTL-aware.

# 7. UI spot-check: task page → cost section shows drift tooltip when values differ
# 8. Cleanup
docker stop e2e-lead-$SUFFIX e2e-worker-$SUFFIX
kill $(lsof -ti :3013 -sTCP:LISTEN)

# 9. Post-deploy (prod): re-run the audit sweep and confirm drift ≈ 0 on new rows
ssh swarm python3 - < /tmp/cost-audit-prod.py
```

---

---

## Appendix

- **Derail notes** (found during planning, handled or explicitly parked):
  - `codex-adapter.ts:945` overwrites `lastUsage` per turn → multi-turn/steered codex sessions store only the last turn's tokens (fixed in Phase 5; new defect, not in the audit doc).
  - Server recompute drops claude-managed's $0.08/h runtime fee that the adapter includes (fixed in Phase 3; new defect).
  - Opencode `msg.tokens.reasoning` currently dropped on the floor (picked up in Phase 4).
  - `CostData.provider` union lacks `"gemini"` while `PricingProviderSchema` has it (`src/providers/types.ts:27-33` vs `src/types.ts:2534-2543`) — parked, no gemini adapter exists.
  - Opencode input-token semantics (inclusive vs exclusive of cache read) — VERIFIED during Phase 4 against prod events (task `8fc625d7`, 2026-08-06): 53/53 finalized messages with cache reads show `input < cacheRead`, i.e. DISJOINT (anthropic-style). The recompute set was inverted to `INCLUSIVE_INPUT_PROVIDERS = {codex}` — subtraction only where verified inclusive; opencode input is billed as-is.
  - `normalizeModelKey` doesn't lowercase (`GPT-5.4` row seen in prod) — cosmetic, parked.
- **Prod verification data** (from the audit, reusable as fixtures):
  - `aef117fe-19ef-4519-839a-f1c6303e4340`: opus-5, in 138 / out 53,185 / cr 12,276,769 / cw1h 199,428 / cw5m 0 → harness $9.4629795
  - `f9769315-7fc8-4c5c-a756-b835510fc7c0`: modelUsage opus-4-8 {in 702,173, out 160,898, cr 2,401,012, cw 365,510, $12.948921} + haiku-4-5 {in 81,410, out 4,275, $0.102785}; total $13.051706
  - `28943d8a-4135-4e14-9b4d-c2db2054c3e6`: sonnet-5, in 1,944 / out 145,646 / cr 86,126,352 / cw1h 481,493 → harness $30.9173856 (stale 3/15 rates); intro-rate truth ≈ $20.61
- **References**:
  - Research: `thoughts/taras/research/2026-08-06-task-vs-session-cost-mismatch-audit.md`
  - Audit sweep script: `/tmp/cost-audit-prod.py` (re-runnable via `ssh swarm python3 - < ...`)
  - Anthropic pricing (sonnet-5 intro through 2026-08-31): docs.claude.com/en/docs/about-claude/pricing
