---
date: 2026-04-28
author: claude (taras)
topic: "Per-agent daily cost budget with refusal-at-claim — V1"
tags: [plan, cost-control, agents, budgets, claim-flow, notifications]
status: completed
autonomy: critical
related_brainstorm: thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md
related_research: thoughts/taras/research/2026-04-28-per-agent-daily-cost-budget.md
last_updated: 2026-04-28
last_updated_by: claude (phase-running, phase 6)
---

# Per-Agent Daily Cost Budget (V1) Implementation Plan

## Overview

Add a two-tier (global + per-agent) USD daily cost budget that refuses task claims at admission time once spend exceeds budget, while letting in-flight work finish (bounded overshoot). Refusals become observable lead notifications, deduped per `(task_id, day)`.

- **Motivation**: compliance / billing limits — a single misbehaving or runaway agent must not be able to consume disproportionate spend. Budgets must be enforceable and auditable.
- **Related**:
  - Brainstorm: [`thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md`](../brainstorms/2026-04-28-per-agent-daily-cost-budget.md)
  - Research: [`thoughts/taras/research/2026-04-28-per-agent-daily-cost-budget.md`](../research/2026-04-28-per-agent-daily-cost-budget.md)

## Current State Analysis

**Claim chokepoints** (research §R1):

- `GET /api/poll` (`src/http/poll.ts:71-318`) is the runner's only claim path; the entire trigger evaluation runs in one synchronous `getDb().transaction(...)` (`poll.ts:102-229`). Three task-acquisition sub-paths share that transaction — offered (`poll.ts:108-123`), pre-assigned pending (`poll.ts:127-171`, gated by `hasCapacity`), and unassigned-pool (`poll.ts:197-225`, workers only, gated by `hasCapacity`).
- MCP `task-action` `accept` action (`src/tools/task-action.ts:222-253`) is a fifth gate site — confirmed by D-R2 — used when an agent accepts an offered task. The other in-session MCP claim surfaces (`task-action` claim, `poll-task`) are explicitly out of scope for V1 (D-R1).
- `hasCapacity(agentId)` (`src/be/db.ts:726-731`) is the existing call-site analog: in-transaction, per-agent, returns boolean. The budget admission predicate slots in alongside it.
- "No task available" today is `200 { "trigger": null }` (`poll.ts:228, 313`); a refusal will return `200 { "trigger": { "type": "budget_refused", … } }`.

**Cost data flow already in place** (research §R2 — Decision #14 verified SAFE):

- All three providers (claude, pi, codex in `src/providers/`) emit a shared `CostData` interface at session end. Adapter → `runner.ts` listener (`runner.ts:1751-1773`) → `saveCostData` (`runner.ts:1004-1027`) → `POST /api/session-costs` → `handleSessionData` (`src/http/session-data.ts:168-193`) → `createSessionCost` (`src/be/db.ts:3558-3594`) → `session_costs` table (migration `001_initial.sql:179-196`).
- Claude self-reports `total_cost_usd` (`claude-adapter.ts:414-437`); pi self-reports `stats.cost` (`pi-mono-adapter.ts:300-368`, covers Anthropic/OpenAI/Google/OpenRouter via `@mariozechner/pi-ai`); Gemini routes through pi.
- Codex is the only provider that does NOT self-report USD — it emits tokens only and USD is computed locally against the hard-coded `CODEX_MODEL_PRICING` const (`src/providers/codex-models.ts:97-141`). This is the seed for the DB price book.
- No DB-backed pricing table exists today. No `budgets` / `daily_spend` / refusal-event tables. Grep confirms the codebase has no `budget`, `spend`, `daily_limit`, or `cost_limit` references.

**Notification rail** (research §R3):

- `completeTask` / `failTask` (`db.ts:1541-1605`) only update DB rows + emit to in-process `workflowEventBus` (workflow engine consumer only — does NOT reach leads).
- The lead-notification path is **follow-up task injection**: `store-progress.ts:343-351` calls `createTaskExtended` (`db.ts:2002-2137`) inserting a new `agent_tasks` row assigned to the lead with `source: "system"`, `taskType: "follow-up"`, `parentTaskId: <originalTaskId>`. Lead picks it up via the normal `task_assigned` trigger.
- Templates registered in `src/tools/templates.ts` via `registerTemplate({ eventType, header, defaultBody, variables, category })` — a third `task.budget.refused` template fits this same pattern (existing pair `task.worker.completed` / `task.worker.failed` lines 14, 68).
- `workflowEventBus.emit(event: string, data: unknown)` (`src/workflows/event-bus.ts`) is string-keyed; per D-R6 we mirror the existing emit pattern at `db.ts:1561-1571` so DAG sequencing notices refusals.

**Worker dispatch** (research §R1, sub-agent confirmed):

- `Trigger` discriminated union at `runner.ts:1247-1278` enumerates 5 types today (`task_assigned | task_offered | unread_mentions | pool_tasks_available | channel_activity`). New variant `budget_refused` is added here.
- `buildPromptForTrigger` switch at `runner.ts:1376-1467` resolves a template per trigger type. New case mirrors the existing pattern.
- **No back-off precedent exists** — sub-agent confirmed runner has no consecutive-refusal / exponential / skip-count state today. We add the first one. Inject before `pollForTrigger` call at `runner.ts:2951` (`pollInterval: PollIntervalMs` is constant at line 2955; back-off multiplier is local state in the loop).
- `incrementEmptyPollCount` is called from `poll-task.ts:138, 178` — refused outcomes need a separate path that bypasses these (D-R3).

**Migration & DB conventions**:

- Forward-only SQL migrations in `src/be/migrations/NNN_*.sql`. Highest existing is `043_jira_source.sql`; **next is `044`**. Naming convention is `NNN_snake_case_description.sql`. Recent precedents include seed-data INSERTs (`002_one_time_schedules.sql:40-51`) and table rebuilds with CHECK changes (`009_tracker_integration.sql`).
- API server is sole DB owner. Worker-side code (`src/providers/`, `src/commands/`, `src/prompts/`) MUST NOT import `bun:sqlite` or `src/be/db` (enforced by `scripts/check-db-boundary.sh`). All pricing lookups for cost recomputation happen API-side at `POST /api/session-costs`.

**REST CRUD pattern**:

- The cleanest analog is `src/http/schedules.ts` (sub-agent confirmed): `route()` factory with method/path/pattern/summary/tags/params/body/responses, full CRUD with composite-or-UUID params, conditional Zod validation, idempotency via 409 on dupe, auth defaulting to `apiKey: true`. Wire new handlers into `src/http/index.ts` handlers array. Register in `scripts/generate-openapi.ts` via `import "../src/http/budgets";` then `bun run docs:openapi`.

**Test conventions**:

- Real `bun:sqlite` file-based DB per test (`initDb(TEST_DB_PATH)` in `beforeAll`, `unlink` `.sqlite/-wal/-shm` in `afterAll`). Helper `createAgent({ id, name, isLead, status, maxTasks })` for setup. Existing references: `runner-polling-api.test.ts`, `session-costs.test.ts`, `db-capacity.test.ts`, `trigger-claiming.test.ts`, `pool-session-logs.test.ts`.

## Desired End State

- Two new operator-facing primitives: a daily USD budget at scope `global` (one row) and at scope `agent` (one row per agent). Missing config = unlimited (default).
- Every claim site evaluates `global_spend_today < global_budget` AND `agent_spend_today < agent_budget` inside the existing claim transaction. Either failing returns `{ "trigger": { "type": "budget_refused", "cause": "agent" | "global", "agentSpend"?, "agentBudget"?, "globalSpend"?, "globalBudget"?, "resetAt": "<ISO 8601>" } }` from `/api/poll`, or a structured refusal from MCP `task-action` `accept`.
- Worker dispatches `budget_refused` triggers through `buildPromptForTrigger` with exponential back-off (initial poll interval, doubling on each consecutive refusal, capped at 5 min); back-off resets on any non-refused trigger. Refused polls do not increment the empty-poll counter.
- On the FIRST refusal per `(task_id, day)` only, the lead receives a follow-up task generated from a new `task.budget.refused` template. `workflowEventBus` emits `task.budget_refused` for DAG sequencing parity with `task.failed` / `task.cancelled`.
- DB has three new tables (`budgets`, `pricing`, `budget_refusal_notifications`) and one new index on `session_costs(agentId, createdAt)` for fast daily-spend aggregation. `pricing` is seeded with Codex model rows; `POST /api/session-costs` recomputes USD for `provider="codex"` from DB rows when present (operator-tunable), trusting harness-reported USD for Claude / pi.
- REST endpoints under `/api/budgets/*` and `/api/pricing/*` allow CRUD via curl. OpenAPI spec is regenerated.
- Reset window: UTC midnight (Decision #8). Daily totals query rows where `date(createdAt / 1000, 'unixepoch') = date('now', 'utc')` etc.

## What We're NOT Doing

- **In-session MCP claim surfaces** (`task-action` `claim` action, `poll-task` MCP tool) are NOT gated in V1 (D-R1). An agent that already has an open MCP session can bypass the budget gate via these. Accepted as a known limitation.
- **No mid-task interruption.** Once a task is claimed and started, it runs to completion (Decision #2). Bounded overshoot is the audit story (Decision #3).
- **No per-task cost ceiling.** Decision #3 walked back from "hard cap, zero overshoot" — runaway protection is the existing harness `max-tokens`/`max-turns`/timeout caps, not new V1 work.
- **No `pool_tasks_available` cleanup.** D-R7 confirmed it's dead in production but cleanup is out of scope.
- **No 80% / 95% threshold alerts.** Decision #13: refusal IS the alert.
- **No operator override / force-claim.** Decision #11: operators raise the budget config to grant headroom.
- **No team / project / org / per-model scopes.** Decision #4: only global + per-agent in V1; the `(scope, scope_id)` schema admits future scopes without migration churn.
- **No new dashboard UI.** Per scoping answer: REST endpoints only; UI deferred to a follow-up plan (see Appendix).
- **No discount-tier accounting.** Decision #5 indicates we'd want it where available, but V1 records what the harness reports for Claude / pi and what `pricing` rows say for Codex — no batch / cache-discount tier modeling.

## Implementation Approach

- **Schema first, behavior last.** Phase 1 is purely additive DB work — no production code path touches the new tables yet — so it can ship and migrate cleanly without affecting existing flows.
- **Library before wiring.** Phase 2 adds pure `canClaim` + spend-aggregation helpers with thorough unit tests; Phase 3 wires them into the three claim sites under one transaction. Buys us isolated test surface for the predicate.
- **Server-side gate first, worker dispatch second.** Phase 3 makes the server return `budget_refused` envelopes; Phase 4 teaches the worker to recognize and back off. The worker can absorb an unknown trigger gracefully (logs + sleep) for one revision if Phase 3 lands first.
- **Notifications and observability ride existing rails.** Phase 5 reuses `createTaskExtended` (the established lead-notification pattern from `store-progress.ts:343-351`) and emits a sibling `workflowEventBus` event. No new transport.
- **Operator surface last.** Phase 6 adds REST CRUD for budgets and pricing — by this point the underlying mechanism is proven, so the API is just exposing it.
- **One commit per phase** (commit cadence answer): `[phase N] <brief description>` after each phase's manual verification passes.

## Quick Verification Reference

Common commands to run from repo root after each phase:

- Lint (CI uses `lint`, not `lint:fix`): `bun run lint`
- Type-check: `bun run tsc:check`
- Unit tests (full suite): `bun test`
- Single-file unit test: `bun test src/tests/<file>.test.ts`
- DB-boundary check: `bash scripts/check-db-boundary.sh`
- After any HTTP route change OR `package.json` version bump: `bun run docs:openapi` (commits `openapi.json`)
- Fresh-DB sanity (validates new migration runs cleanly): `rm -f agent-swarm-db.sqlite && bun run start:http` then Ctrl-C
- Server log smoke test: `bun run pm2-logs` after `bun run pm2-restart`

---

## Phase 1: Schema + price-book DB-ification

### Overview

Land migration `044_budgets_and_pricing.sql` with three new tables (`budgets`, `pricing`, `budget_refusal_notifications`) and one new composite index on `session_costs`, plus seed `pricing` rows from `CODEX_MODEL_PRICING`. Add Zod schemas in `src/types.ts`. No behavior change — production code paths still ignore the new tables.

### Changes Required:

#### 1. Migration file

**File**: `src/be/migrations/044_budgets_and_pricing.sql`
**Changes**:
- Create `budgets(scope TEXT NOT NULL, scope_id TEXT NOT NULL, daily_budget_usd REAL NOT NULL, createdAt INTEGER NOT NULL, lastUpdatedAt INTEGER NOT NULL, PRIMARY KEY(scope, scope_id), CHECK(scope IN ('global', 'agent')), CHECK(daily_budget_usd >= 0))`. The well-known global row has `scope_id = ''` (empty string) so the composite key remains uniform.
- Create `pricing(provider TEXT NOT NULL, model TEXT NOT NULL, token_class TEXT NOT NULL, effective_from INTEGER NOT NULL, price_per_million_usd REAL NOT NULL, createdAt INTEGER NOT NULL, lastUpdatedAt INTEGER NOT NULL, PRIMARY KEY(provider, model, token_class, effective_from), CHECK(provider IN ('claude', 'codex', 'pi')), CHECK(token_class IN ('input', 'cached_input', 'output')))`. **Why `effective_from` in the PK** (response to review comment): prices change over time — a model can get cheaper or more expensive — so the price book is append-only by `(provider, model, token_class)`, with `effective_from` (epoch ms, UTC) breaking ties. The cost-recompute lookup (Phase 6) selects the row with the **largest `effective_from <= session_cost.createdAt`**, which keeps historical USD audit-correct even if the operator later inserts a new price for the same model. Combined with the fact that `session_costs.totalCostUsd` is locked at insert (immutable), this gives us two independent layers of audit immutability — correct historical math AND immutable historical totals.
- Create `budget_refusal_notifications(task_id TEXT NOT NULL, date TEXT NOT NULL, agent_id TEXT NOT NULL, cause TEXT NOT NULL, agent_spend_usd REAL, agent_budget_usd REAL, global_spend_usd REAL, global_budget_usd REAL, follow_up_task_id TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(task_id, date), CHECK(cause IN ('agent', 'global')))`. `INSERT OR IGNORE` against PK gives atomic dedup.
- Add `CREATE INDEX IF NOT EXISTS idx_session_costs_agent_created ON session_costs(agentId, createdAt)` for daily-spend aggregation.
- Add `CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing(provider, model, token_class, effective_from DESC)` so the "latest active price" lookup is O(log n) per (provider, model, token_class).
- Seed `pricing` rows (one per `(model, token_class)` triple) from existing `CODEX_MODEL_PRICING` const at `src/providers/codex-models.ts:97-119`. Convert per-million-token rates 1:1. Seed uses `INSERT OR IGNORE` with a fixed `effective_from = 0` (epoch) so re-runs of the migration on a populated DB are no-ops, and any operator-inserted later row naturally wins.

#### 2. Zod / TS schemas

**File**: `src/types.ts`
**Changes**:
- Add `BudgetScopeSchema = z.enum(['global', 'agent'])`.
- Add `BudgetSchema = z.object({ scope: BudgetScopeSchema, scopeId: z.string(), dailyBudgetUsd: z.number().nonnegative(), createdAt: z.number(), lastUpdatedAt: z.number() })`.
- Add `PricingTokenClassSchema = z.enum(['input', 'cached_input', 'output'])`.
- Add `PricingRowSchema = z.object({ provider: z.enum(['claude', 'codex', 'pi']), model: z.string(), tokenClass: PricingTokenClassSchema, effectiveFrom: z.number().nonnegative(), pricePerMillionUsd: z.number().nonnegative(), createdAt: z.number(), lastUpdatedAt: z.number() })`.
- Add `BudgetRefusalCauseSchema = z.enum(['agent', 'global'])`.
- Add `BudgetRefusalNotificationSchema` mirroring the table columns.
- Export inferred types.

#### 3. Codex pricing const stays put (Phase 6 makes DB authoritative)

**File**: `src/providers/codex-models.ts`
**Changes**: NO changes in Phase 1. Worker still uses local TS const for cost computation. Phase 6 adds API-side recompute on receipt at `POST /api/session-costs`.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] Fresh-DB migration runs cleanly: `rm -f agent-swarm-db.sqlite && bun run start:http` (Ctrl-C after "API listening")
- [x] Existing-DB migration runs cleanly: with the production DB present, `bun run start:http` applies 044 without error
- [x] Schemas typecheck against the SQL CHECK constraints (manual diff against migration file)
- [x] Unit test verifying seed rows: `bun test src/tests/migration-044-budgets.test.ts` — new test file that opens a fresh DB and SELECTs `pricing` rows, asserts non-zero count, that every model in `CODEX_MODEL_PRICING` has corresponding rows for `input`/`cached_input`/`output`, that every seed row has `effective_from = 0`, and that re-applying migration 044 (or running `INSERT OR IGNORE` of the seed again) does NOT duplicate rows
- [x] Unit test verifying append-only price history: insert a second pricing row for `(codex, gpt-5.3-codex, input, effective_from=NOW)` with a different price; assert the seeded row at `effective_from=0` is still present, and that a "latest active row" lookup at `now()` returns the new row while a lookup at epoch returns the seed

#### Automated QA:
- [x] Inspect schema with `sqlite3 agent-swarm-db.sqlite ".schema budgets"`, `".schema pricing"`, `".schema budget_refusal_notifications"`, `".indexes session_costs"` — assert PK / CHECK / UNIQUE / index match the migration

#### Manual Verification:
- [ ] None — the migration-044 unit test (above) already asserts every `CODEX_MODEL_PRICING` model has the right rows, and the schema-inspection QA covers the table shape. Skip.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] schema + price-book seed` once verification passes.

---

## Phase 2: Spend aggregation + admission predicate library

### Overview

Pure-function helpers for daily-spend aggregation and a `canClaim(agentId)` predicate that returns either `{ allowed: true }` or a structured refusal envelope. No call sites are wired yet — this phase is unit-test surface only.

### Changes Required:

#### 1. DB query helpers

**File**: `src/be/db.ts`
**Changes**: Add (alphabetically near existing budget-adjacent helpers):
- `getBudget(scope: 'global' | 'agent', scopeId: string): Budget | null` — single SELECT.
- `getDailySpendForAgent(agentId: string, dateUtc: string): number` — `SELECT COALESCE(SUM(totalCostUsd), 0) FROM session_costs WHERE agentId = ? AND date(createdAt / 1000, 'unixepoch') = ?`. `dateUtc` is `YYYY-MM-DD` UTC.
- `getDailySpendGlobal(dateUtc: string): number` — same query without `agentId` filter.
- `recordBudgetRefusalNotification(args)` returns `{ inserted: boolean; row: BudgetRefusalNotification }`. Uses `INSERT OR IGNORE` for atomic dedup; if `changes() === 0`, SELECTs the existing row.
- `hasBudgetRefusalNotificationToday(taskId, date): boolean` (used by tests / observability).

#### 2. Admission predicate

**File**: `src/be/budget-admission.ts` (new)
**Changes**: Export `canClaim(agentId: string, nowUtc: Date): { allowed: true } | { allowed: false, cause: 'agent' | 'global', agentSpend?: number, agentBudget?: number, globalSpend?: number, globalBudget?: number, resetAt: string }`. Implementation:
0. **Kill switch**: if `process.env.BUDGET_ADMISSION_DISABLED === 'true'`, return `{ allowed: true }` immediately. Logs a single `console.warn` per process boot so operators don't deploy with this flag and forget. Why this exists: a misconfigured `daily_budget_usd = 0` (e.g. fat-finger on the `PUT /api/budgets/global/`) would brick every claim path swarm-wide; the env-var bypass is the documented operator escape hatch (Decision #11 says no in-line force-claim, but env-var-at-boot is at the operations layer, not the runtime layer, and is a pure additive).
1. Compute `dateUtc` from `nowUtc` (`YYYY-MM-DD`).
2. Compute `resetAt` = next UTC midnight (ISO 8601). Edge case: if `nowUtc` is exactly UTC midnight (millisecond zero of the day), `resetAt` is +24h (the FOLLOWING midnight, not the current instant). Test this explicitly.
3. Look up `getBudget('global', '')` → if present and `getDailySpendGlobal(dateUtc) >= dailyBudgetUsd`: return refusal with `cause: 'global'` + global fields.
4. Look up `getBudget('agent', agentId)` → if present and `getDailySpendForAgent(agentId, dateUtc) >= dailyBudgetUsd`: return refusal with `cause: 'agent'` + agent fields.
5. Otherwise `{ allowed: true }`.

Why a separate file (not inline in `db.ts`): keeps the predicate composable, easier to unit test, and avoids growing `db.ts` further.

#### 3. Tests

**File**: `src/tests/budget-admission.test.ts` (new)
**Changes**: Cover:
- Missing budget rows ⇒ `{ allowed: true }` (default unlimited).
- Global budget set, spend below ⇒ allowed.
- Global budget set, spend at ceiling ⇒ refused with `cause: 'global'`.
- Agent budget set, agent spend at ceiling ⇒ refused with `cause: 'agent'`.
- Both set, both blown ⇒ refused with `cause: 'global'` (global is checked first).
- Spend on a different day's `createdAt` does NOT count toward today.
- `recordBudgetRefusalNotification` called twice with same `(taskId, date)` ⇒ second returns `{ inserted: false }`.
- `resetAt` is UTC midnight of the next day (not local).
- `resetAt` at exact-midnight `nowUtc` returns the FOLLOWING midnight (+24h), not the current instant.
- `BUDGET_ADMISSION_DISABLED=true` env var short-circuits to `{ allowed: true }` regardless of budget rows.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] All new unit tests pass: `bun test src/tests/budget-admission.test.ts`
- [x] Full unit suite still green: `bun test`

#### Automated QA:
- [x] Test asserts `getDailySpendForAgent` uses the index (EXPLAIN QUERY PLAN over a seeded DB returns "USING INDEX idx_session_costs_agent_created" — included in the test file)

#### Manual Verification:
- [ ] None — phase is library-level. Skip.

**Implementation Note**: Pause for confirmation. Commit `[phase 2] budget admission predicate + spend queries` once verification passes.

---

## Phase 3: Wire admission predicate into claim sites

### Overview

Insert `canClaim(agentId)` adjacent to `hasCapacity` checks at the three V1 gate sites (`/api/poll` pre-assigned pending, `/api/poll` pool, MCP `task-action` `accept`). Introduce the new `budget_refused` trigger envelope. Refused outcomes bypass `incrementEmptyPollCount`.

### Changes Required:

#### 1. `/api/poll` — pre-assigned pending path

**File**: `src/http/poll.ts:127-171`
**Changes**: Inside the existing transaction, BEFORE `startTask`, call `canClaim(agentId, new Date())`. If `!result.allowed`, return `{ trigger: { type: 'budget_refused', cause, agentSpend?, agentBudget?, globalSpend?, globalBudget?, resetAt } }`. Critical: the canClaim call is in-transaction so capacity AND budget gates share atomicity.

#### 2. `/api/poll` — unassigned-pool path

**File**: `src/http/poll.ts:197-225`
**Changes**: Same predicate insertion, BEFORE the `claimTask` loop. Note: pool path is workers-only (`!agent.isLead`), so per-agent budgets are most relevant here. Still check global budget too.

#### 3. MCP `task-action` `accept` action

**File**: `src/tools/task-action.ts:222-253`
**Changes**: Insert `canClaim(agentId, new Date())` after `checkDependencies` (line 243) and before `acceptTask` (line 244). Refusal returns `{ success: false, message: "Refused: <cause>...", refusalCause: 'agent' | 'global', agentSpend?, … }` (extend the output Zod at `task-action.ts:81-86`).

#### 4. Trigger type extension (server side)

**File**: `src/types.ts` (or wherever the API trigger response is typed)
**Changes**: Add `BudgetRefusedTriggerSchema` to the trigger union returned by `/api/poll`. Fields: `type: 'budget_refused'`, `cause: 'agent' | 'global'`, `agentSpend?`, `agentBudget?`, `globalSpend?`, `globalBudget?`, `resetAt: string` (ISO 8601).

#### 5. Empty-poll bookkeeping bypass (D-R3)

**File**: `src/tools/poll-task.ts:138, 178`
**Changes**: Add a `wasBudgetRefused` boolean check before `incrementEmptyPollCount`. Same change at any matching server-side accounting in `src/http/poll.ts` if applicable. Include comment: `"Refused ≠ empty (D-R3)."`

#### 6. Server-side tests

**File**: `src/tests/budget-claim-gate.test.ts` (new)
**Changes**: Cover:
- `/api/poll` returns `{ trigger: null }` when no budgets configured + tasks available (existing behavior preserved).
- `/api/poll` returns `{ trigger: { type: 'task_assigned', … } }` when budgets present but spend below ceiling.
- `/api/poll` returns `{ trigger: { type: 'budget_refused', cause: 'agent', … } }` when agent budget blown.
- `/api/poll` returns `{ trigger: { type: 'budget_refused', cause: 'global', … } }` when global blown.
- MCP `task-action` `accept` returns `{ success: false, refusalCause: 'agent', … }` when agent blown.
- Refused poll does NOT increment `emptyPollCount`.
- Race: two agents poll at the same time; only one task is claimed; the other gets either the next task or `{ trigger: null }` (existing race correctness preserved).

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] New gate tests pass: `bun test src/tests/budget-claim-gate.test.ts`
- [x] Existing claim-flow tests still green: `bun test src/tests/runner-polling-api.test.ts src/tests/db-capacity.test.ts src/tests/trigger-claiming.test.ts src/tests/pool-session-logs.test.ts`

#### Automated QA:
- [x] curl walkthrough: with `API_KEY=123123` and a seeded DB containing `(scope='agent', scope_id=<id>, daily_budget_usd=0.01)` + a session_cost row pushing the agent over, `curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: <id>" http://localhost:3013/api/poll` returns `{"trigger":{"type":"budget_refused","cause":"agent",...}}`. Documented as a one-liner in `LOCAL_TESTING.md` (or this plan's Manual E2E section).

#### Manual Verification:
- [ ] Hit `/api/poll` with the curl above against `bun run start:http` to confirm the envelope shape end-to-end.

**Implementation Note**: Pause for confirmation. Commit `[phase 3] wire budget admission into claim sites` once verification passes.

---

## Phase 4: Worker dispatch + exponential back-off

### Overview

Teach the worker to recognize `budget_refused` triggers, log a useful diagnostic, and back off the poll interval exponentially (initial 2s → cap 5 min, doubling per consecutive refusal, resetting on any non-refused outcome). Add the new case to `buildPromptForTrigger`.

### Changes Required:

#### 1. Trigger union (worker side)

**File**: `src/commands/runner.ts:1247-1278`
**Changes**: Extend the `Trigger` discriminated union: add `| { type: 'budget_refused'; cause: 'agent' | 'global'; agentSpend?: number; agentBudget?: number; globalSpend?: number; globalBudget?: number; resetAt: string }`.

#### 2. Dispatch case

**File**: `src/commands/runner.ts:1376-1467`
**Changes**: Refusals are handled in the poll loop (item 3), so they never reach `buildPromptForTrigger` in normal flow. Still add a defensive `case 'budget_refused'` that logs and returns `null` (the poll loop already handles `null` triggers gracefully today) — protection against future refactors that bypass the loop's pre-dispatch handling. Pure defensive code, never exercised in tested paths.

**Older-worker compat note**: pre-this-feature workers will receive the new `budget_refused` envelope from the API and reject it as an unknown discriminator (existing `Trigger` switch is exhaustive in TypeScript but does not error at runtime — falls through to default behavior of logging + sleeping a poll interval). That degrades to "no back-off, polls keep firing" — not catastrophic, just suboptimal. Coordinate the deploy: ship the API-side refusal envelope (Phase 3) only after worker images for Phase 4 are built and rolled out, OR temporarily set `BUDGET_ADMISSION_DISABLED=true` (added Phase 2) until both halves are deployed.

#### 3. Back-off state in poll loop

**File**: `src/commands/runner.ts:2891-2960`
**Changes**: Add local `let consecutiveBudgetRefusals = 0;` outside the loop. After each `pollForTrigger` result:
- If `trigger?.type === 'budget_refused'`: log structured payload (cause + spend/budget/resetAt, scrubbed via `scrubSecrets`), set `consecutiveBudgetRefusals++`, compute `backoffMs = Math.min(5 * 60 * 1000, basePollInterval * 2 ** (consecutiveBudgetRefusals - 1))`, sleep `backoffMs`, **continue** (do NOT increment empty-poll count).
- If trigger is non-null AND not `budget_refused`: reset `consecutiveBudgetRefusals = 0`, dispatch normally.
- If trigger is null: existing behavior.

Cap is 5 min per scoping answer. Initial interval is `basePollInterval` (today's `PollIntervalMs`).

#### 4. Worker tests

**File**: `src/tests/runner-budget-refused.test.ts` (new)
**Changes**: Stub `pollForTrigger` to return `budget_refused` repeatedly. Assert:
- Back-off doubles up to but not past 5 min.
- `consecutiveBudgetRefusals` resets to 0 after one non-refused (`task_assigned`) trigger.
- Empty-poll counter is unchanged across refusals.
- The structured log is emitted via `scrubSecrets`.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] Worker back-off tests pass: `bun test src/tests/runner-budget-refused.test.ts`
- [x] Full suite green: `bun test`

#### Automated QA:
- [x] PM2 walkthrough: ran the Option B fallback (standalone `bun` script driving a stubbed `pollForTrigger` returning `budget_refused` 12× then `task_assigned` then 3× refusal). Output proves doubling 2s → 4s → 8s → 16s → 32s → 64s → 128s → 256s → cap at 300s, then reset to 2s after the non-refused trigger. First 3 log lines (verbatim): `[lead] budget_refused — backing off 2000ms: {"event":"budget_refused","cause":"global",...,"consecutiveRefusals":1,"backoffMs":2000}` / `[lead] budget_refused — backing off 4000ms: {... "consecutiveRefusals":2,"backoffMs":4000}` / `[lead] budget_refused — backing off 8000ms: {... "consecutiveRefusals":3,"backoffMs":8000}`. Real PM2/Docker walkthrough deferred to manual run (skipped to avoid heavyweight docker:build:worker rebuild during phase agent execution).

#### Manual Verification:
- [ ] Confirm on a local PM2 run that the worker doesn't busy-loop after refusal (CPU stays idle between back-off intervals; visible via `top`).

**Implementation Note**: Pause for confirmation. Commit `[phase 4] worker dispatch + back-off on budget_refused` once verification passes.

---

## Phase 5: Lead notification rail + workflow bus event

### Overview

On the FIRST refusal per `(task_id, today_utc)` only, inject a follow-up `agent_tasks` row to the lead via `createTaskExtended`. Register a new `task.budget.refused` template. Emit `task.budget_refused` to `workflowEventBus` in parity with `task.failed` / `task.cancelled`.

### Changes Required:

#### 1. Refusal-side notification injection

**File**: `src/http/poll.ts` (refusal sites at lines 127, 204), `src/tools/task-action.ts` (refusal site at the new accept gate)
**Changes**: After computing the refusal (still inside the same transaction so dedup is atomic), call:
```ts
const dedup = recordBudgetRefusalNotification({
  taskId, date: utcDate, agentId, cause,
  agentSpendUsd, agentBudgetUsd, globalSpendUsd, globalBudgetUsd,
});
// Capture leadAgent inside the txn so the after-commit step has it ready.
const leadAgent = dedup.inserted ? getLeadAgent() : null;
```
(`getLeadAgent` is the existing helper used by `store-progress.ts` — confirm name during implementation; if it lives elsewhere, expose / reuse the same lookup it does.)

After `transaction()` returns, if `dedup.inserted` was true AND `leadAgent` resolved:
1. Resolve template body via the existing `resolveTemplateAsync` flow (used by `buildPromptForTrigger`).
2. Call `createTaskExtended(<resolved body>, { agentId: leadAgent.id, source: 'system', taskType: 'follow-up', parentTaskId: taskId, slackChannelId: task.slackChannelId, slackThreadTs: task.slackThreadTs, slackUserId: task.slackUserId })`.
3. UPDATE `budget_refusal_notifications` SET `follow_up_task_id = ?` WHERE `task_id = ?` AND `date = ?`. This write-back is what makes the dedup row useful for audit (e.g. "find the lead-facing follow-up that was created when this task was first refused").

**Partial-failure note** (acknowledged limitation, not blocking): if the API process crashes between transaction commit (notification recorded) and `createTaskExtended` (lead notified), the dedup row exists but the lead never sees the refusal. Subsequent same-day refusals on the same task will be silently deduped. V1 acceptance: this is a known edge case under crash conditions; observability is via the `budget_refusal_notifications` table itself (operators can query for rows with `follow_up_task_id IS NULL`). Recovery / sweeper job is out of scope for V1 — captured in the Appendix as a follow-up.

#### 2. New template

**File**: `src/tools/templates.ts`
**Changes**: Register `task.budget.refused`:
```ts
registerTemplate({
  eventType: 'task.budget.refused',
  header: '',
  defaultBody: `Budget refusal — task is blocked.

Cause: {{cause}}
Agent: {{agent_name}}
Task: {{task_desc}}
Spend / budget: {{spend_summary}}
Resets at: {{reset_at}}

Decide whether to raise the budget, reassign, or wait for the daily reset.
Use \`get-task-details\` with taskId "{{task_id}}" for full details.`,
  variables: [
    { name: 'cause', description: "'agent' or 'global'" },
    { name: 'agent_name', description: 'Refusing agent name or ID prefix' },
    { name: 'task_desc', description: 'Task description (truncated to 200 chars)' },
    { name: 'spend_summary', description: 'Formatted "$X / $Y" pair' },
    { name: 'reset_at', description: 'UTC reset time (human readable)' },
    { name: 'task_id', description: 'Original task ID' },
  ],
  category: 'task_lifecycle',
});
```

#### 3. Workflow event bus emit (D-R6)

**File**: `src/be/db.ts` — extract a small helper or emit directly from the refusal site after-commit
**Changes**: `import("../workflows/event-bus").then(({workflowEventBus}) => workflowEventBus.emit('task.budget_refused', { taskId, agentId, cause, ... }));`. Mirror the existing emit pattern at `db.ts:1561-1571`.

#### 4. Tests

**File**: `src/tests/budget-refusal-notification.test.ts` (new)
**Changes**: Cover:
- First refusal of a task creates exactly one follow-up `agent_tasks` row owned by the lead.
- Second refusal of the same task on the same UTC day creates ZERO additional follow-ups (dedup via `INSERT OR IGNORE`).
- Refusal of the same task on the next UTC day creates a new follow-up (the `(task_id, date)` PK rolls over).
- `task.budget.refused` event reaches `workflowEventBus` (subscribe in test).
- Slack context (`slackChannelId`, `slackThreadTs`, `slackUserId`) inherits from the parent task into the follow-up.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] New notification tests pass: `bun test src/tests/budget-refusal-notification.test.ts`
- [x] Full suite green: `bun test`

#### Automated QA:
- [x] Walkthrough: blow a budget locally, poll twice, confirm exactly one follow-up task lands in the lead's queue (`sqlite3 agent-swarm-db.sqlite "SELECT id, agentId, parentTaskId, taskType FROM agent_tasks WHERE taskType='follow-up' ORDER BY createdAt DESC LIMIT 5"`).

#### Manual Verification:
- [ ] None — automated coverage suffices.

**Implementation Note**: Pause for confirmation. Commit `[phase 5] budget refusal notifications + workflow bus event` once verification passes.

---

## Phase 6: REST surfaces (budgets + pricing) + Codex USD recompute

### Overview

Expose `/api/budgets/*` and `/api/pricing/*` CRUD via the `route()` factory. Move Codex USD authority to the API: on `POST /api/session-costs`, when `provider === 'codex'` and DB pricing rows exist for that model, recompute `totalCostUsd` from tokens × DB rates. Trust harness-reported USD for Claude / pi as-is (D-R5). Regenerate OpenAPI.

### Changes Required:

#### 1. Budgets REST surface

**File**: `src/http/budgets.ts` (new)
**Changes**: Mirror `src/http/schedules.ts` shape. Endpoints:
- `GET /api/budgets` → list all rows (auth: apiKey).
- `GET /api/budgets/{scope}/{scopeId}` → single row or 404. (`scopeId` = `''` for global; URL-encoded.)
- `PUT /api/budgets/{scope}/{scopeId}` → upsert with body `{ dailyBudgetUsd: number }`.
- `DELETE /api/budgets/{scope}/{scopeId}` → 204.
Request/response Zod schemas use `BudgetSchema` from Phase 1. Auth defaults to `apiKey: true` (existing convention — there is no role/RBAC in this codebase, so an API-key-bearing operator is the implicit "admin" surface).

DB helpers in `src/be/db.ts`: `getBudgets()`, `upsertBudget(...)`, `deleteBudget(scope, scopeId)`.

**Mutation audit logging** (compliance — extends brainstorm R6 from refusal-only to operator-mutation): every PUT and DELETE writes one row to `agent_logs` (the existing audit log used by `completeTask` / `failTask` at `db.ts:1561-1571`) with `eventType: 'budget.upserted'` or `'budget.deleted'`, payload including before/after values and the API-key fingerprint (e.g. `sha256(apiKey).slice(0,8)` — never the raw key — scrubbed via `scrubSecrets`). This gives compliance reviewers a full chain of "who set what budget when" without expanding the scope to a full RBAC system.

#### 2. Pricing REST surface

**File**: `src/http/pricing.ts` (new)
**Changes**:
- `GET /api/pricing` → list all rows (full history, all providers/models/classes/effective-froms). Useful for operator-side audit of price changes.
- `GET /api/pricing/{provider}/{model}/{tokenClass}` → list rows for that triple (latest first by `effective_from DESC`). Returns `[]` if none (NOT 404 — empty is a valid state for "model not seeded").
- `GET /api/pricing/{provider}/{model}/{tokenClass}/active` → returns the currently-active row (largest `effective_from <= now`) or 404.
- `POST /api/pricing/{provider}/{model}/{tokenClass}` → INSERT a new row with body `{ pricePerMillionUsd: number, effectiveFrom?: number }` (default `effectiveFrom = Date.now()`). 409 if a row with the same `(provider, model, token_class, effective_from)` already exists. **No PUT** — pricing rows are append-only by design (audit immutability); operators add new rows rather than mutating old ones. **Same-millisecond collision**: two rapid POSTs against the same `(provider, model, token_class)` may collide on `effective_from = Date.now()`; the second returns 409. Operator workaround is to send an explicit `effectiveFrom` in the body (advance by 1 ms). Test this case explicitly.
- `DELETE /api/pricing/{provider}/{model}/{tokenClass}/{effectiveFrom}` → 204. Allowed (typo correction, etc.) but discouraged operationally — call it out in the response body or docs as "use only to fix mistakes; recomputation of historical session_costs is not retroactive."

DB helpers: `getAllPricingRows()`, `getPricingRows(provider, model, tokenClass)`, `getActivePricingRow(provider, model, tokenClass, atEpochMs)`, `insertPricingRow(...)`, `deletePricingRow(provider, model, tokenClass, effectiveFrom)`.

**Mutation audit logging**: same as budgets — every POST and DELETE writes an `agent_logs` row (`pricing.inserted` / `pricing.deleted`) with payload including the `(provider, model, token_class, effective_from, price_per_million_usd)` tuple and the API-key fingerprint.

#### 3. Wire into HTTP handler chain

**File**: `src/http/index.ts:115-130` (handlers array)
**Changes**: Add `() => handleBudgets(req, res, pathSegments, queryParams, myAgentId),` and `() => handlePricing(req, res, pathSegments, queryParams, myAgentId),` (alphabetical placement).

#### 4. OpenAPI registration

**File**: `scripts/generate-openapi.ts:18` (imports section)
**Changes**: Add `import "../src/http/budgets";` and `import "../src/http/pricing";`.

#### 5. Mini-migration for `costSource` column

**File**: `src/be/migrations/045_session_costs_cost_source.sql` (new)
**Changes**: `ALTER TABLE session_costs ADD COLUMN costSource TEXT NOT NULL DEFAULT 'harness' CHECK(costSource IN ('harness', 'pricing-table'));`. Backfill is automatic via the `DEFAULT 'harness'` — every existing row reads as harness-sourced (which it was). New rows write the actual source.

#### 6. Codex USD recompute on receipt

**File**: `src/http/session-data.ts:168-193` (`handleSessionData` for `POST /api/session-costs`)
**Changes**: When `provider === 'codex'`: call `getActivePricingRow('codex', model, tokenClass, now)` for each of `input` / `cached_input` / `output`. The "active" lookup is the row with the largest `effective_from <= now`. If all three rows resolve, recompute `totalCostUsd = (inputTokens * inputPrice + cachedInputTokens * cachedPrice + outputTokens * outputPrice) / 1_000_000`, overwrite the worker-reported value, and write `costSource = 'pricing-table'`. If any class has no row, fall back to the worker's value with `costSource = 'harness'` (back-compat for unseeded models). Claude / pi paths always use `costSource = 'harness'`.

Note: this is the only place Phase 6 touches existing behavior beyond the additive REST surface. Claude / pi paths unchanged — their `totalCostUsd` is recorded as-is from harness self-report and `costSource = 'harness'`.

#### 7. Regenerate OpenAPI

Run `bun run docs:openapi`; commit `openapi.json` AND any regenerated `docs-site/content/docs/api-reference/**` files.

#### 8. Tests

**File**: `src/tests/budgets-routes.test.ts`, `src/tests/pricing-routes.test.ts` (new), and additions to `src/tests/session-costs.test.ts`
**Changes**:
- CRUD round-trip for `/api/budgets/*` (200, 404, 400 validation, 204 delete).
- Pricing routes (200 list, 200 history, 200 active, 409 duplicate insert, 204 delete, 400 validation).
- 409 same-millisecond collision on POST `/api/pricing/...` when `effectiveFrom` is omitted twice in rapid succession; explicit `effectiveFrom` body field unblocks.
- Mutation audit rows: each PUT/DELETE on `/api/budgets` and POST/DELETE on `/api/pricing` writes one `agent_logs` row with the expected `eventType`, payload, and key fingerprint (raw key never leaks).
- 401 / 403 on missing or wrong API key.
- `POST /api/session-costs` with `provider='codex'` recomputes USD when DB pricing rows exist for all three classes; falls back to worker value (with `costSource='harness'`) when any class is missing.
- **Historical-correctness test** (this is the response to the review comment about pricing changes): seed an old codex pricing row at `effective_from=T0`, then `POST /api/session-costs` with `createdAt = T0 + 1`; assert recompute used the T0 price. Then insert a new pricing row at `effective_from=T0 + 100`, then `POST` another session_cost with `createdAt = T0 + 200`; assert recompute used the new price. Then `POST` a session_cost with `createdAt = T0 + 50`; assert recompute STILL used the T0 price (older data uses older price even if the row was inserted later, because `effective_from` is what gates lookup, not insertion order).
- `POST /api/session-costs` with `provider='claude'` / `'pi'` records harness USD as-is regardless of DB pricing rows; `costSource='harness'`.

### Success Criteria:

#### Automated Verification:
- [x] Lint passes: `bun run lint`
- [x] Type-check passes: `bun run tsc:check`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] New REST tests pass: `bun test src/tests/budgets-routes.test.ts src/tests/pricing-routes.test.ts`
- [x] Updated cost tests pass: `bun test src/tests/session-costs.test.ts` (and new `src/tests/session-costs-codex-recompute.test.ts`)
- [x] OpenAPI regen produces no spurious diffs: `bun run docs:openapi && git diff --exit-code openapi.json` (after intentional changes are staged)
- [x] Full suite green: `bun test` (3005 pass / 0 fail)
- [x] OpenAPI spec includes the new operations: `jq -e '.paths["/api/budgets"].get and .paths["/api/budgets/{scope}/{scopeId}"].put and .paths["/api/pricing"].get and .paths["/api/pricing/{provider}/{model}/{tokenClass}"].get and .paths["/api/pricing/{provider}/{model}/{tokenClass}/active"].get' openapi.json` exits 0
- [x] OpenAPI spec validates as well-formed OpenAPI 3.x: `bunx @apidevtools/swagger-cli validate openapi.json` exits 0 (`redocly lint` reports 12 PRE-EXISTING errors unrelated to Phase 6 — they exist on `main`)
- [x] Spec request/response schemas match the new Zod schemas: `bun scripts/check-openapi-budgets.ts` exits 0

#### Automated QA:
- [x] curl walkthrough committed to plan (or `LOCAL_TESTING.md`):
  ```bash
  # Set a per-agent budget
  curl -X PUT http://localhost:3013/api/budgets/agent/<agent_id> \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"dailyBudgetUsd": 5.0}'
  # Read it back
  curl http://localhost:3013/api/budgets/agent/<agent_id> -H "Authorization: Bearer 123123"
  # List all
  curl http://localhost:3013/api/budgets -H "Authorization: Bearer 123123"
  # Update Codex pricing for a model
  curl -X PUT http://localhost:3013/api/pricing/codex/gpt-5.3-codex/input \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"pricePerMillionUsd": 1.50}'
  ```
  Each call returns a documented JSON shape; verify against the new OpenAPI spec.

#### Manual Verification:
- [ ] None — the OpenAPI spec checks above (jq path-existence assertion + redocly/swagger-cli structural validation + `check-openapi-budgets.ts` schema-shape assertion) cover what was originally a "render in Swagger UI" eyeball pass. Skip.

**Implementation Note**: Pause for confirmation. Commit `[phase 6] REST surfaces + Codex USD recompute` once verification passes.

---

## Manual E2E

Verify the full feature against a real local backend. Run from repo root after Phase 6 lands.

```bash
# 1. Fresh DB & start API
rm -f agent-swarm-db.sqlite
bun run start:http &
sleep 2

# 2. Create a worker agent
curl -X POST http://localhost:3013/api/agents \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"budget-test-worker","isLead":false}'
AGENT_ID="<paste id from response>"

# 3. Set a tiny per-agent daily budget
curl -X PUT "http://localhost:3013/api/budgets/agent/$AGENT_ID" \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"dailyBudgetUsd": 0.01}'

# 4. Simulate spend pushing the agent over
curl -X POST http://localhost:3013/api/session-costs \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"e2e-1","totalCostUsd":0.05,"durationMs":5000,"numTurns":1}'

# 5. Create a pending task assigned to this agent
TASK_ID=$(curl -s -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d "{\"task\":\"E2E budget test\",\"agentId\":\"$AGENT_ID\"}" | jq -r '.id')

# 6. Poll: expect budget_refused
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" \
  http://localhost:3013/api/poll
# → {"trigger":{"type":"budget_refused","cause":"agent","agentSpend":0.05,"agentBudget":0.01,"resetAt":"..."}}

# 7. Confirm a follow-up task landed for the lead
sqlite3 agent-swarm-db.sqlite \
  "SELECT id, agentId, parentTaskId, taskType FROM agent_tasks \
   WHERE parentTaskId = '$TASK_ID' AND taskType = 'follow-up';"
# → exactly one row

# 8. Poll again — confirm dedup (no second follow-up)
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" \
  http://localhost:3013/api/poll
sqlite3 agent-swarm-db.sqlite \
  "SELECT COUNT(*) FROM agent_tasks WHERE parentTaskId = '$TASK_ID' AND taskType='follow-up';"
# → still 1

# 9. Raise the budget; confirm the agent can now claim
curl -X PUT "http://localhost:3013/api/budgets/agent/$AGENT_ID" \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"dailyBudgetUsd": 100.0}'
curl -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" \
  http://localhost:3013/api/poll
# → {"trigger":{"type":"task_assigned",...}}

# 10. Tear down
kill %1
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
```

Optional Codex-pricing check:
```bash
# Override Codex input price; emit a Codex session-cost; confirm USD is recomputed
curl -X PUT http://localhost:3013/api/pricing/codex/gpt-5.3-codex/input \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"pricePerMillionUsd": 999.99}'
curl -X POST http://localhost:3013/api/session-costs \
  -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"codex-1","totalCostUsd":0.001,"inputTokens":1000,"outputTokens":500,"model":"gpt-5.3-codex","provider":"codex"}'
sqlite3 agent-swarm-db.sqlite "SELECT totalCostUsd FROM session_costs WHERE sessionId='codex-1';"
# → recomputed value (much higher than 0.001), proving DB pricing is authoritative for Codex
```

---

## Appendix

- **Follow-up plans**:
  - **UI for budgets + spend dashboard** (`new-ui/`): visualize current daily spend vs. budget per agent and globally, with edit forms for budgets and pricing. Requires a `qa-use` session per `runbooks/testing.md` because it touches `new-ui/`. Out of scope for V1 per scoping answer.
  - **In-session MCP claim gating** (D-R1): extend the budget gate to MCP `task-action` claim and `poll-task` if bypass shows up in practice.
  - **Per-team / per-project / per-model budget scopes** (Decision #4 deferred): adds new `(scope, scope_id)` rows; admission predicate gains additional AND clauses.
  - **80% / 95% threshold alerts** (Decision #13 explicitly deferred): would build on the same notification rail.
  - **Refusal-notification recovery sweeper**: scan `budget_refusal_notifications WHERE follow_up_task_id IS NULL AND createdAt < now - 5min` and replay the lead notification — closes the partial-failure window noted in Phase 5.
- **Derail notes**:
  - D-R7: `pool_tasks_available` trigger is dead in production but still present in the runner Trigger union, dispatch case, and tests. Cleanup is out of scope here — would be its own small PR.
  - In-session MCP `task-action` `claim` and `poll-task` bypass the budget gate per D-R1. Document this in the budget docs once written.
  - Same-millisecond collision on `POST /api/pricing` PK is rare (operator-driven) but real — surfaced as 409 with operator-supplied `effectiveFrom` workaround; not worth a clock-monotonic fix for V1.
- **References**:
  - Research: [`thoughts/taras/research/2026-04-28-per-agent-daily-cost-budget.md`](../research/2026-04-28-per-agent-daily-cost-budget.md)
  - Brainstorm: [`thoughts/taras/brainstorms/2026-04-28-per-agent-daily-cost-budget.md`](../brainstorms/2026-04-28-per-agent-daily-cost-budget.md)
  - REST CRUD analog: `src/http/schedules.ts`
  - Notification analog: `src/tools/store-progress.ts:306-362`
  - Atomic claim analog: `src/be/db.ts:2139-2170` (`claimTask` UPDATE … WHERE … RETURNING)
  - Workflow event-bus emit pattern: `src/be/db.ts:1561-1571`

---

## Review Errata

_Reviewed: 2026-04-28 by claude (desplega:reviewing pass, auto-apply mode)_

### Applied (Important)
- [x] **I1 — Older-worker handling for `budget_refused`**: added a deploy-coordination note in Phase 4 §2 documenting that pre-feature workers degrade to "no back-off, polls keep firing" and recommending the `BUDGET_ADMISSION_DISABLED=true` bridge during partial deploys.
- [x] **I2 — Operator-mutation audit logging**: extended Phase 6 §1 (Budgets) and §2 (Pricing) to emit `budget.upserted` / `budget.deleted` / `pricing.inserted` / `pricing.deleted` rows into `agent_logs` with payload + scrubbed API-key fingerprint. Tests added in Phase 6 §8. Closes the brainstorm R6 audit-trail requirement on the operator-mutation side.
- [x] **I4 — `follow_up_task_id` write-back**: Phase 5 §1 now lays out the full three-step after-commit flow (resolve template → `createTaskExtended` → `UPDATE budget_refusal_notifications SET follow_up_task_id = ?`), so the dedup row links back to its lead-facing follow-up.
- [x] **I5 — Kill-switch env var**: Phase 2 §2 (predicate) now defines `BUDGET_ADMISSION_DISABLED=true` as a process-boot bypass that short-circuits `canClaim` to `{ allowed: true }` with a `console.warn` per boot. Test added in Phase 2 §3. Recommended bridge during the Phase 3 → Phase 4 deploy gap.
- [x] **I6 — Crash semantics between notification record + follow-up task**: Phase 5 §1 now explicitly acknowledges the partial-failure window (notification recorded, follow-up task missing). Recovery sweeper added to the Appendix follow-up plans list.

### Applied (Minor)
- [x] **M1**: Phase 1 Manual Verification was redundant with the migration-044 unit test — replaced with an explicit "skip" + cross-reference.
- [x] **M2**: Phase 4 §2 dispatch case prose was "thinking out loud" with two competing recommendations — cleaned up to "defensive log-and-null in `buildPromptForTrigger`, real handling lives in the poll loop".
- [x] **M3**: Phase 6 now lists `045_session_costs_cost_source.sql` as an explicit numbered sub-step (was previously buried in the recompute prose).
- [x] **M4**: Phase 5 §1 now shows where `leadAgent` is fetched (inside the txn, alongside the `recordBudgetRefusalNotification` call) so the after-commit step has it ready.
- [x] **M5**: Same-millisecond PK collision on `POST /api/pricing` is now called out in Phase 6 §2 with the explicit `effectiveFrom` body-field workaround, plus a test bullet in Phase 6 §8.
- [x] **M6**: `resetAt` edge case (exact-midnight `nowUtc` returning the FOLLOWING midnight, not the current instant) now spelled out in Phase 2 §2 and covered by a test bullet in Phase 2 §3.

### Not Actionable
- **I3 — Auth/role for mutating pricing and budgets**: this codebase does not have RBAC; `apiKey: true` is the existing operator bar. Documented inline in Phase 6 §1 as the explicit assumption — not a deficit of this plan, would need its own RBAC effort if compliance later requires fine-grained roles.

### Critical
None — the plan is internally consistent and its assumptions are grounded in the research.
