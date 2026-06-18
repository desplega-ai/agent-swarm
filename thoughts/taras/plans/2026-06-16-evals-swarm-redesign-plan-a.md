---
date: 2026-06-16T00:00:00Z
planner: Claude
topic: "Evals swarm-mechanics redesign — Plan A: foundations + delegation axis + de-risk pilot"
status: completed
autonomy: critical
commit_per_phase: true
last_updated: 2026-06-16
last_updated_by: Claude (orchestrator — all 4 phases done; Pilot-2 GO after N2/N4 fix)
related:
  - thoughts/taras/plans/2026-06-15-evals-swarm-redesign-scope.md
  - thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md
  - thoughts/taras/research/2026-06-16-delegation-eval-design-swarm.md
tags: [evals, swarm-mechanics, delegation, reliability, plan]
---

# Evals Swarm-Mechanics Redesign — Plan A: Foundations + Delegation Axis + De-risk Pilot

## Overview

Redesign the evals matrix to **discriminate the swarm itself** (emergent multi-agent behavior) rather than single-model code quality. Plan A delivers the shared infra, the first behavioral axis (delegation & lifecycle, using the deployed swarm's verified `delegation-probe` design), a convergent reliability metric so attempt-count `n` is a confidence dial, and a **real-E2B de-risk pilot** that must prove discrimination before we build the tool-use/resource-efficiency axis (Plan B).

- **Motivation**: Negative finding (`thoughts/taras/plans/2026-06-15-evals-swarm-mechanics-rethink-handoff.md`) — current swarm-mechanics scenarios don't discriminate model tiers because correctness saturates and the soft judge is too noisy. Reframe (Taras): score the swarm's *behavior* deterministically, and make `n` reduce uncertainty instead of inflating "best@n" luck.
- **Related**: scope `thoughts/taras/plans/2026-06-15-evals-swarm-redesign-scope.md`; research `thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md`; adopted delegation design `thoughts/taras/research/2026-06-16-delegation-eval-design-swarm.md`; engine `evals/src/scoring.ts`, `evals/src/runner/index.ts`.

## Current State Analysis

- **Scoring engine is reusable as-is.** OutcomeSpec v2 = gates + weighted dimensions, `score = Σwᵢ·dimᵢ/Σwᵢ`, `passed = allGatesPass && score ≥ passThreshold` (default 0.75), checks-XOR-judge per dimension (`evals/src/scoring.ts:82-105`, `evals/src/types.ts:214-240`, normalize `evals/src/normalize-outcome.ts:20-35`). A dimension named `efficiency` with neither checks nor judge is scored deterministically from cost/time vs budget (`evals/src/runner/index.ts:828-883`).
- **Scenario authoring is well-patterned.** `evals/scenarios/distributed-audit.ts:204-346` is the closest model for `delegation-probe`: `workers: [...]` + `lead: {...}`, `seed: { sqlDump }`, `tasks` with `worker: "lead"` + `dependsOn`, `outcome: { gates, dimensions }`. Deterministic checks are `{ name, weight?, fn: async (ctx) => CheckResult }` (`evals/src/types.ts:159-179`); reusable helpers in `evals/src/judge/deterministic.ts` (`allTasksCompleted` :55-68, `fileContainsOnWorker` :86-104, `fileAbsentOnWorker` :107-119). Registration: `evals/scenarios/index.ts:22-37`. Seed dumps live in `evals/scenarios/fixtures/` (loaded host-side `evals/src/runner/index.ts:88-115,943-959`; imported into the API sandbox DB `evals/src/swarm/sandbox.ts:399-433`).
- **`ctx.apiGet` exists but is unused by checks today.** `JudgeContext.apiGet: (path) => client.get(path)` is wired (`evals/src/runner/index.ts:1487`) and consumed only by the agentic judge (`evals/src/judge/agentic.ts:224`). No scenario check calls it — checks today have the *worker* hit the API and grade a written file. The delegation checks introduce the first check-side `apiGet` usage. Test fixtures stub `apiGet: async () => ({})` (`evals/src/runner/scoring.test.ts:104`) → new check tests need a richer stub.
- **The runner only tracks the upfront task set.** `ctx.tasks` = the scenario-authored tasks; the runner creates them upfront and awaits only those (`evals/src/runner/index.ts:1259-1281`). Tasks the agents spawn at runtime — lead-delegated **child tasks** and the auto **follow-up** tasks created when a worker completes (`src/tasks/worker-follow-up.ts:63-141`, `taskType='follow-up'`, `source='system'`, `parentTaskId`=worker task, assigned to the lead) — are invisible to scoring. These ARE the delegation artifacts the `delegation-probe` rubric needs.
- **Most signals are GET-reachable; tool-error needs a parse.** Per-attempt the API exposes: `GET /api/tasks?fields=full` (list; serializes `taskType`/`parentTaskId`/`creatorAgentId`/`offeredTo`/`source` but can't *filter* by them — `db.ts:1567-1688`, route `tasks.ts:45-73`), `GET /api/tasks/:id` (full task + embedded `agent_log` `logs` — `tasks.ts:151-168`, `db.ts:2817-2824`), `GET /api/tasks/:taskId/session-logs` (`session-data.ts:42-60`), `GET /api/events`(+`/counts`), `GET /api/session-costs`, `GET /api/script-runs`, `GET /api/workflows`. Because each attempt boots a fresh DB, **listing all tasks returns exactly this attempt's set** (scenario + spawned). Tool errors live only inside raw `session_logs.content` JSONL (provider-shape-dependent, e.g. Claude `tool_result.is_error`) — no structured column.
- **Reliability headline is "best@n" (the luck dial).** `summarizeRun`/`CellSummary` (`evals/src/results.ts:45-105`) computes `passedAny` (cell green if *any* attempt passed — `:65`), `avgScore` (mean), `bestScore` (max), `passed` count; **no CI, no pass-rate at cell level**. Calibration ship-gate `frontierAvg − budgetAvg ≥ 0.2` runs off `avgScore` (`evals/scripts/calibration-report.ts:25-34,70-109`). Per-attempt `passed`/`score` ARE persisted (`attempts` table), so a convergent metric is an aggregation + render change, no new per-attempt field.
- **Configs/anchors exist.** `claude-opus-4.8`, `claude-haiku`, `pi-deepseek-flash`, `pi-gemini-flash` (`evals/configs/index.ts`); `budget` preset `["claude-haiku","pi-deepseek-flash","pi-gemini-flash","codex-5.4-mini"]` (`evals/configs/presets.ts:97-102`); calibration anchors `FRONTIER=["claude-opus-4.8","codex-5.5"]`, `BUDGET=["pi-deepseek-flash","claude-haiku"]` (`calibration-report.ts:25-34`).

## Desired End State

A `delegation-probe` scenario scores the lead's delegation behavior **deterministically** (no judge) from the task/`agent_log`/`session_logs` paper-trail; the runner tracks runtime-spawned tasks so those signals are visible; the matrix headline is a **mean dimension-score + confidence interval** (with pass-rate/Wilson companion) that tightens with `n`; and a real-E2B 2-tier pilot has **demonstrated** that `delegation-probe` separates a frontier model from a weak budget anchor (or told us to redesign it) — gating Plan B.

Verify: `cd evals && bun run tsc:check && bun test` green; `bun run lint` (root) clean; a local unit test scores `delegation-probe`'s checks against a synthetic `JudgeContext`; `bun src/cli.ts show <pilotRunId>` renders mean±CI per cell; the pilot's frontier−budget gap (over mean±CI) is reported with significance at the run's `n`.

## What We're NOT Doing

- **No new persisted `tool.end` event** — tool-error rate (Plan B) parses `session_logs` instead.
- **No queue-claim contention modeling** — worker tasks stay hard-assigned by index.
- **No memory-axis rebuild** — `memory-distractor`/`memory-coordination` already discriminate.
- **No scoring-engine rewrite** — reuse gates + weighted dimensions + checks-XOR-judge + deterministic-efficiency.
- **No Plan B (tool-use/resource efficiency) here** — authored separately *after* the pilot, since pilot results may reshape it.

## Implementation Approach

- **Foundations first, behavior second, pilot last.** Phase 1 = shared infra (session-logs parser + runtime-spawned-task tracking). Phase 2 = `delegation-probe` scenario + deterministic rubric. Phase 3 = convergent reliability metric (so the pilot reads discrimination correctly). Phase 4 = the real-E2B de-risk pilot — **hard stop** → author Plan B.
- **Enumerate spawned tasks by listing, not new endpoints.** Fresh-DB-per-attempt means `GET /api/tasks?fields=full&limit=N` returns the whole attempt; merge non-scenario tasks into `ctx.tasks`. Optional thin `?taskType=` route filter (no DB change) is a follow-up nicety, not a blocker.
- **`apiGet` in checks is a new but small pattern** — resolve lead/worker agent ids from `ctx.workers` (`isLead`/`agentId`), read the per-task `agent_log` via `GET /api/tasks/:id`, and the lead's session for the solo-research check via `GET /api/tasks/:leadTaskId/session-logs`.
- **Mean+CI is the headline; pass-rate/Wilson rides along.** Mean preserves the partial-credit gradation that separates tiers; the CI (bootstrap over per-attempt scores) tightens ~1/√n. Recompute the calibration gap over mean±CI so a gap is reported as significant-at-`n`.
- **Commit per phase** after manual verification passes (`[phase N] <desc>`).

## Quick Verification Reference

- Type check: `cd evals && bun run tsc:check`  (`tsc --noEmit && tsc --noEmit -p ui`)
- Unit tests: `cd evals && bun test`  (single file: `bun test <path>.test.ts`)
- Lint (root): `bun run lint`  (read-only, as CI runs it)
- DB boundary (root): `bash scripts/check-db-boundary.sh`
- Pilot sweep (real E2B, local DB): `cd evals && EVALS_DB_PATH=/tmp/evals-pilot.sqlite EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN='' bun src/cli.ts run --scenarios delegation-probe --configs claude-opus-4.8,pi-deepseek-flash --attempts 5 --judge-model deepseek/deepseek-v4-pro`  (needs `E2B_API_KEY`, `OPENROUTER_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`; `OPENAI_API_KEY` only if a codex config is used)
- Read results: `cd evals && EVALS_DB_PATH=/tmp/evals-pilot.sqlite bun src/cli.ts show <runId>`

> Gotcha (from prior sweeps): `EVALS_DB_SYNC_URL` **overrides** `EVALS_DB_PATH`; to force a local DB you must also pass `EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN=''` (`evals/src/db/client.ts:16-58`).

---

## Phase 1: Foundations — session-logs parser + runtime-spawned-task tracking

### Overview

Two reusable pieces the delegation rubric (and Plan B) depend on: (1) a provider-shape-aware parser that extracts `tool_use` entries from `session_logs.content`, and (2) runtime-spawned-task enumeration so `ctx.tasks` includes lead-delegated child tasks + auto follow-ups, not just the upfront scenario tasks.

### Changes Required:

#### 1. Session-logs tool_use parser
**File**: `evals/src/judge/session-log-parse.ts` (new)
**Changes**: Export `parseToolUses(logRows: SessionLogRow[]): ToolUse[]` where `ToolUse = { taskId?, toolName, input, isError? }`. Parse each row's `content` JSON; cover the providers in the eval roster — Claude (`assistant.message.content[].type==='tool_use'` → `name`/`input`; results via `tool_result.is_error`), Codex (`item.completed` tool items), and pi/opencode shapes. Tolerate malformed/non-tool lines (skip, never throw). Add a small `toolUseMatches(name, patterns)` helper for MCP tool-name matching (e.g. `mcp__agent-swarm__send-task`, `get-tasks`). Source-of-truth for shapes: `src/providers/claude-adapter.ts:802-809` (Claude `tool_use`), `src/providers/codex-adapter.ts:713,754` (Codex), the swarm design doc's `content` example.

#### 2. Runtime-spawned-task enumeration
**File**: `evals/src/runner/index.ts` (after the existing await loop, ~`:1277`)
**Changes**: After the scenario tasks reach terminal and before building `JudgeContext`, fetch the full attempt task set via `client.get("/api/tasks?fields=full&limit=200")` and merge any tasks not already in `tasks` (the spawned child + follow-up + resume tasks) into the set passed as `ctx.tasks`. Keep the existing `taskIds`/skip logic for the scenario tasks; spawned tasks are added read-only for scoring (not awaited). Log the count of spawned tasks captured.
**File**: `evals/src/swarm/client.ts`
**Changes**: Add a typed helper `listAllTasks(): Promise<SwarmTask[]>` wrapping `get("/api/tasks?fields=full&limit=200")` (returns `.tasks`), so the runner and checks share one call.

#### 3. (Optional, no-DB-change) surface `taskType` filter on the list route
**File**: `src/http/tasks.ts:53-68,337-347`
**Changes**: Add `taskType` to the `listTasks` query schema and pass it into the `filters` object — `getAllTasks` already honors `filters.taskType` (`src/be/db.ts:1615-1618`). Pure route wiring, no DB/migration change. After: `bun run docs:openapi` + commit `openapi.json`. *Only do this if the list+client-filter approach in #2 proves awkward; otherwise defer.*

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `cd evals && bun run tsc:check`
- [x] Unit tests pass: `cd evals && bun test`
- [x] New parser test passes: `cd evals && bun test src/judge/session-log-parse.test.ts` — feeds fixture `session_logs.content` lines for Claude + Codex (+ pi/opencode if in roster) and asserts extracted tool names/inputs and `isError` flags.
- [x] Lint clean (root): `bun run lint`
- [x] DB boundary holds (root): `bash scripts/check-db-boundary.sh` (evals reads only via HTTP)
- [ ] If route filter added: `bun run docs:openapi` leaves no diff after commit. _(DEFERRED — optional `taskType` route filter not added; the list+client-filter approach in #2 is clean, so no `src/http/tasks.ts`/`openapi.json` change.)_

#### Automated QA:
- [x] Agent runs a focused script that builds a synthetic `JudgeContext` whose `apiGet("/api/tasks?fields=full&limit=200")` returns a fixture set of {1 lead task, 2 child tasks (`creatorAgentId`=lead), 2 follow-ups (`taskType='follow-up'`)} and confirms the runner's enumeration merges all 5 into `ctx.tasks` (vs the 1 upfront). _(evals/src/runner/spawned-tasks.test.ts)_

#### Manual Verification:
- [ ] Parser shapes look right against a real recent `session_logs` row for each provider we actually run (eyeball one Claude + one pi sample).

**Implementation Note**: After this phase, pause for manual confirmation; commit `[phase 1] evals foundations: session-log parser + runtime-task tracking`.

---

## Phase 2: `delegation-probe` scenario + deterministic rubric

### Overview

Add the `delegation-probe` scenario (a two-shard research task the lead MUST delegate) and its deterministic gates + `delegation`/`correctness` dimensions, adopting the deployed swarm's verified rubric (`thoughts/taras/research/2026-06-16-delegation-eval-design-swarm.md`). No judge.

### Changes Required:

#### 1. Seed fixture
**File**: `evals/scenarios/fixtures/delegation-probe-history.sql` (new)
**Changes**: A `sqlite3 .dump`-format fixture (~20 terminal `agent_tasks` rows with a known answer key: completed count, top-priority completed title, failed count, cancelled count) following `evals/scenarios/fixtures/README.md` conventions (must include `_migrations`; no `agents`/in-flight tasks/`agent_memory`). Model on `sql-audit-history.sql`. Validated by `SQL_DUMP_NAME_RE` + `validateSqlDumpText` (`evals/src/registry.ts:55-56,251-255`, runner `:88-96`).

#### 2. Scenario module
**File**: `evals/scenarios/delegation-probe.ts` (new)
**Changes**: Export `delegationProbe: Scenario` modeled on `distributed-audit.ts:204-346`: `workers: [{name:"researcher-alpha"},{name:"researcher-beta"}]`, `lead: {name:"Lead", template:"lead"}`, `seed: { sqlDump: "delegation-probe-history.sql" }`, one `worker: "lead"` task whose description explicitly says *"delegate to your two workers — do NOT query the tasks API yourself"* (removes the legit-solo exception), then `outcome` (below). `LEAD_WORKER = 2` constant; `REPORT_FILE = "/workspace/audit/merged-report.md"`.
**File**: `evals/scenarios/index.ts:4,22-33`
**Changes**: Import + add `delegationProbe` to the `scenarios` array.

#### 3. Delegation checks (deterministic, `apiGet`-based)
**File**: `evals/scenarios/delegation-probe.ts` (same module) + shared helpers in `evals/src/judge/deterministic.ts` if reused
**Changes**: Implement the rubric checks as `DeterministicCheck`s, resolving `leadAgentId = ctx.workers.find(w=>w.isLead)?.agentId` and `workerAgentIds = ctx.workers.filter(w=>!w.isLead).map(w=>w.agentId)`:
- **Gates**: `allTasksCompleted()` (existing helper) + `fileContainsOnWorker(LEAD_WORKER, REPORT_FILE, /\S/)`.
- **`delegation` dimension (weight 5)** — weighted checks: `P1 child-tasks-created` (≥2 tasks in `ctx.tasks` with `creatorAgentId===leadAgentId && agentId∈workerAgentIds && parentTaskId===leadSeedTaskId`, w3); `P2 worker-tasks-completed` (≥2 of those `completed` with non-empty `output`, w2); `P3 follow-up-received` (≥1 task `source==='system' && taskType==='follow-up' && parentTaskId∈childTaskIds`, w2); `P4 workers-have-sessions` (each child task has `session_logs` via `apiGet("/api/tasks/<id>/session-logs?limit=1")` non-empty, w1); `N1 no-solo-research` (lead's `session_logs` via `apiGet("/api/tasks/<leadTaskId>/session-logs?limit=500")` → `parseToolUses` → NO `get-tasks` tool_use with a status filter; if violated, **dimension → 0**); `N2 no-implementation-tools` (lead session has no `Edit`/`Write`/data-`Bash`; penalty); `N3 no-delegation-loops` (no task with `creatorAgentId∈workerAgentIds && parentTaskId`; penalty); `N4 no-re-doing-work` (after first follow-up, lead session has no data-research tool calls; penalty).
- **`correctness` dimension (weight 2)** — `P5 merged-report-exists` + `P6 merged-report-correct` (proximity-anchored regexes over the answer-key facts, mirroring `mergedCorrectness` `distributed-audit.ts:142-162`).
- **`outcome`**: `{ gates:[...], dimensions:[ {name:"delegation", weight:5, checks:[...]}, {name:"correctness", weight:2, checks:[P5,P6]} ] }`. Aggregate = `(5·delegation + 2·correctness)/7`; default threshold 0.75. (`delegation` is a custom `DimensionName` — allowed via `string & {}`, `evals/src/types.ts:185-190`.)

> Note: N1's "dimension → 0 on violation" needs implementing as a check whose `fn` returns `{pass:false, score:0}` AND ensuring it dominates — simplest is a dedicated gate-like check inside the dimension that the runner's weighted-mean can't dilute. **Decision to confirm in review**: implement N1 as a *dimension-zeroing* check (special-cased) vs a heavy negative weight. Default: zero-the-dimension via a wrapper that short-circuits the weighted mean to 0 when N1 fails.

### Success Criteria:

#### Automated Verification:
- [x] Type check: `cd evals && bun run tsc:check`
- [x] Scenario validates: `cd evals && bun src/cli.ts registry` lists `delegation-probe` with no validation error (fixture name, dimensions, checks-XOR-judge).
- [x] Rubric unit test: `cd evals && bun test scenarios/delegation-probe.test.ts` — constructs a synthetic `JudgeContext` (stubbed `apiGet` returning fixture task list + per-task session-logs) for three cases: (a) clean delegation → high `delegation`; (b) solo-but-correct lead (N1 fires) → `delegation` 0 though `correctness` high; (c) delegation loop (N3) → penalized. Asserts the aggregate and `passed`. _(7 tests; case (b') additionally proves N1 dominates P1–P4 partial credit.)_
- [x] Lint clean (root): `bun run lint` _(after `lint:fix` reformatted the two new evals files; re-ran read-only `lint` clean.)_

#### Automated QA:
- [x] Agent runs `bun src/cli.ts registry` and confirms `delegation-probe` is registered, gates/dimensions parse, and the seed fixture loads (`validateSqlDumpText` passes on the new `.sql`).

#### Manual Verification:
- [ ] Read the scenario task description — confirm it unambiguously mandates delegation and the answer key lives only in the seeded DB (not in the prompt).

**Implementation Note**: Pure evals-package work (no `src/` change unless the optional Phase-1 route filter). Pause; commit `[phase 2] delegation-probe scenario + deterministic rubric`.

---

## Phase 3: Convergent reliability metric (mean + CI; pass-rate/Wilson companion)

### Overview

Replace the "best@n" headline with a convergent cell estimator: **mean dimension-score + confidence interval** (tightens with `n`) as the discrimination headline, **pass-rate + Wilson interval** as the interpretable companion. Surface in `CellSummary` → API → CLI `show` (+ serve UI), and recompute the calibration gap over mean±CI.

### Changes Required:

#### 1. Cell aggregation
**File**: `evals/src/results.ts:3-23,45-105` (`CellSummary` + `summarizeRun`)
**Changes**: Add to `CellSummary`: `meanScore` (already `avgScore` — alias/keep), `scoreCI: { lo: number; hi: number; method: "bootstrap" }` (bootstrap percentile CI over the cell's per-attempt `score`s; deterministic seed for reproducibility), `passRate: number` (passed/finished), `passRateCI: { lo, hi }` (Wilson). Keep `passedAny`/`passedFirst`/`bestScore` as drill-down fields (no longer the headline).
**File**: `evals/src/stats.ts` (new) or inline in results.ts
**Changes**: `bootstrapCI(scores, { iters, alpha, seed })` and `wilsonInterval(passed, total, z)` pure helpers + unit tests.

#### 2. API surface
**File**: `evals/src/api/server.ts:455,502`
**Changes**: `summarizeRun` already spreads into `GET /api/runs` and `/api/runs/:id`; the new `CellSummary` fields flow automatically. Confirm the analytics path (`evals/src/api/analytics.ts`) still builds (it has its own `passRate`).

#### 3. CLI `show`
**File**: `evals/src/cli.ts:177-212`
**Changes**: Render each cell as `meanScore ±halfCI` (e.g. `0.78 ±0.06`) with the pass-rate as a secondary line/column; replace the `passedAny ✓/✗` headline with a threshold-vs-CI indicator (e.g. ✓ when `scoreCI.lo ≥ passThreshold`, ~ when CI straddles it, ✗ when `scoreCI.hi < threshold`). Keep `bestScore`/pass@1 available in a verbose/`--detail` view.

#### 4. Serve UI
**File**: `evals/ui/*` (matrix cell component consuming `/api/runs/:id`)
**Changes**: Show mean±CI and a confidence affordance (e.g. CI bar / tooltip "n=5, ±0.06"). Lightest-touch surfacing; the message "more attempts ⇒ tighter band" must be visible.

#### 5. Calibration gap over mean±CI
**File**: `evals/scripts/calibration-report.ts:70-109`
**Changes**: Compute `gap = frontierMean − budgetMean` AND a significance flag (gap CI excludes 0, from the per-cohort score CIs). Keep `SHIP_GATE_GAP = 0.2` but report "significant at n=X" alongside.

### Success Criteria:

#### Automated Verification:
- [x] Type check: `cd evals && bun run tsc:check` (incl. `-p ui`)
- [x] Stats unit tests: `cd evals && bun test src/stats.test.ts` — `wilsonInterval`/`bootstrapCI` against known fixtures (e.g. 3/5 passes → Wilson ≈ [0.23,0.88]; CI narrows as n grows; deterministic seed → stable bounds). _(22 pass; also covers the new `bootstrapDiffCI` diff-of-means CI + significance flag used by the calibration gap.)_
- [x] `summarizeRun` test: `cd evals && bun test src/results.test.ts` — multi-attempt cell yields `meanScore`/`scoreCI`/`passRate`/`passRateCI`; CI width shrinks for n=10 vs n=3 on the same score distribution. _(9 pass.)_
- [x] UI builds: `cd evals && bun run ui:build`
- [x] Lint clean (root): `bun run lint`

#### Automated QA:
- [x] Agent runs `bun src/cli.ts show <existingRunId>` against a prior local run DB and confirms the matrix now prints mean±CI + pass-rate and the ✓/~/✗ threshold-vs-CI indicator. _(No prior eval run DB present locally → used the synthetic-render path: `evals/src/cli-show.test.ts` (6 pass) drives the cell renderer with a multi-attempt `CellSummary` and asserts the `mean ±halfCI` headline + pass-rate + ✓/~/✗ threshold-vs-CI indicator. Live `show` against a real run DB happens in the Phase 4 pilot.)_

#### Manual Verification:
- [ ] Eyeball the serve UI (`bun src/cli.ts serve`, http://localhost:4801) — the CI/`n` affordance reads as "higher n = tighter = more trustworthy."

**Implementation Note**: Touches `evals/ui` → per CLAUDE.md, frontend changes are manual-QA'd by Taras (no qa-use YAML in this repo). Pause; commit `[phase 3] convergent reliability metric (mean+CI, pass-rate/Wilson)`.

---

## Phase 4: De-risk pilot — 2-tier E2B sweep of `delegation-probe` (HARD STOP)

### Overview

Run `delegation-probe` on a frontier model vs a weak budget anchor on real E2B at meaningful `n`, read the convergent metric, and decide: does it discriminate? This phase produces **evidence + a go/no-go**, not code. **Implementation stops here** — Plan B (tool-use/resource efficiency) is authored only after reviewing these results.

### Changes Required:

#### 1. Pilot run + capture
**File**: `thoughts/taras/qa/2026-06-16-delegation-probe-pilot.md` (new — evidence doc)
**Changes**: Run the sweep (below), capture per-cell `meanScore ±CI`, `passRate`, and the per-dimension breakdown (`delegation` vs `correctness`) for both tiers; record the frontier−budget gap + significance-at-`n`; note which budget anchor was used and why.

#### 2. Anchor decision
**File**: same evidence doc + (if changed) `evals/scripts/calibration-report.ts:25-34` / `evals/configs/presets.ts`
**Changes**: Pick the budget anchor that makes the gap meaningful (start `pi-deepseek-flash`; if it doesn't fail enough, try a weaker `pi-gemini-flash-lite`/`pi-glm-flash` per scope). Record the choice for Plan B.

### Success Criteria:

#### Automated Verification:
- [ ] Sweep completes without harness errors: `cd evals && EVALS_DB_PATH=/tmp/evals-pilot.sqlite EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN='' bun src/cli.ts run --scenarios delegation-probe --configs claude-opus-4.8,pi-deepseek-flash --attempts 5 --judge-model deepseek/deepseek-v4-pro` (exit 0; no `waiting_for_credentials` failures). (`delegation-probe` is judge-free, so the judge model only matters once a judged dimension exists — `deepseek/deepseek-v4-pro` is the standing default per `agentic.ts:18`.)
- [ ] Results readable: `cd evals && EVALS_DB_PATH=/tmp/evals-pilot.sqlite bun src/cli.ts show <runId>` prints mean±CI for both cells.

#### Automated QA:
- [ ] Agent extracts the per-dimension scores from the run DB and computes the frontier−budget `delegation`-dimension gap + whether its CI excludes 0 at n=5; writes them into the evidence doc.

#### Manual Verification:
- [ ] **Taras reviews the discrimination result.** Decision: (a) gap is real & significant → proceed to author Plan B; (b) it saturates (both tiers ace or both fail delegation) → redesign `delegation-probe` (harder mandate / weaker anchor / more attempts) before Plan B. **This is the hard gate.**

**Implementation Note**: No source commit (run + evidence doc only). Real-E2B spend (~$5–15) — confirm budget before running. Do NOT start Plan B until Taras signs off on the pilot.

---

## Appendix

- **Follow-up plans**: **Plan B — Tool-use & resource efficiency axis** (authored after Phase 4): native-primitive usage (`script_runs.scriptName`/`isScratch`, `workflows.createdByAgentId`, delegation reuse) + tool hygiene/cost (events `tool.start` mix, tool-error rate via the Phase-1 `session-log-parse` parser, `session_costs` cost/tokens/`durationMs`/`numTurns` as first-class efficiency dimensions, `agent_tasks` compaction aggregates).
- **Derail notes**:
  - The swarm design doc's example paths (`/api/session-logs?taskId=`, `/api/tasks?limit=100` with `creatorAgentId` filter) don't match the real API — correct to `GET /api/tasks/:taskId/session-logs` and list-then-client-filter (see Current State).
  - `ctx.apiGet` in checks is a new pattern → enrich the test stub beyond `async () => ({})`.
  - Consider promoting P1–P4/N1–N4 helpers into `evals/src/judge/deterministic.ts` if Plan B reuses them.
- **References**:
  - Scope: `thoughts/taras/plans/2026-06-15-evals-swarm-redesign-scope.md`
  - Research: `thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md`
  - Adopted delegation design (deployed swarm): `thoughts/taras/research/2026-06-16-delegation-eval-design-swarm.md`
  - Engine/auth patterns: `evals/scenarios/distributed-audit.ts`, `evals/src/judge/deterministic.ts`, `evals/src/results.ts`, `evals/src/runner/index.ts:1487`, `evals/configs/presets.ts`
</content>
