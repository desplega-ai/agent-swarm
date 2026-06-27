---
date: 2026-06-13T00:00:00Z
author: Taras
topic: "Evals v8.0 (round 11) — OutcomeSpec v2: gates + weighted graded dimensions"
status: implemented (working tree, uncommitted, pre-calibration-sweep)
branch: feat/evals-subproject
pr: 737
tags: [evals, scoring, outcomespec, dimensions, round-11]
source-brainstorm: thoughts/taras/brainstorms/2026-06-12-evals-scenario-discrimination.md
---

# Evals v8.0 (round 11) — OutcomeSpec v2: tiered/graded scoring

> Version note: **Resolved — v8.0** (major bump). This round is a schema-breaking grading overhaul
> (gates + weighted dimensions, `CheckResult.score`, two new `judgments` columns), so it takes a major
> version rather than the cadence-consistent +0.1 (v7.9). H1/filename reflect v8.0.

## Overview

The evals matrix (`evals/` — scenario × harness-config on E2B) can't discriminate frontier from budget
models: 6 of 7 scenarios are deterministic-checks-only, `CheckResult` is `{ pass: boolean }` (no partial
credit), and final aggregation is all-AND with `score = passed ? 1 : 0` when no judge runs
(`evals/src/runner/index.ts:1223-1224`). Capable harnesses all score 1.00.

This round implements **OutcomeSpec v2**: gates (binary must-pass) + weighted named dimensions (each fed by
graded checks or a judge), `score = Σ wᵢ·dimᵢ / Σ wᵢ`, and `passed = allGatesPass && score ≥ passThreshold`.
It extends the agentic judge to the full worker roster, adds a deterministic efficiency dimension, replaces
the 7-scenario catalog with 7 new discriminating scenarios, surfaces per-dimension analytics, and ships a
calibration sweep that gates each scenario on a ≥0.2 frontier-vs-budget spread.

**Motivation:** make `attempt.score` a continuous quality rank signal, not a pass/fail bit.

**Related:**
- Brainstorm: `thoughts/taras/brainstorms/2026-06-12-evals-scenario-discrimination.md` (Synthesis, Core
  Requirements 1-8, the 7-scenario batch table, the anti-gaming checklist).
- Current scoring surface: `evals/src/runner/index.ts:1073-1224`.
- Current schema: `evals/src/types.ts:135-152` (`CheckResult`, `DeterministicCheck`, `OutcomeSpec`).
- Round 9 (UI/analytics, quadrant bands, presets) is in flight on the same branch — analytics work here
  **layers onto** round-9 surfaces, must not fork them. **Phase 7 has an explicit round-9 precondition
  (see below) — if those components aren't merged/stable when Phase 7 runs, Phase 7 blocks or scopes down.**

## Current State Analysis

Verified against the code (line cites are exact, re-confirmed during this revision):

- **`OutcomeSpec`** lives at `evals/src/types.ts:146-152` — four optional fields: `llmJudge`,
  `agenticJudge`, `checks`, `passThreshold`. No gates/dimensions/weights. (Brainstorm cited `123-131`;
  that range is actually `AgenticJudgeSpec`, lines 127-133. See Conflict 1.)
- **`CheckResult`** = `{ pass: boolean; detail?: string }` (`types.ts:135-138`) — no numeric score.
- **`CheckRunResult extends CheckResult`** (`judge/deterministic.ts:5-9`) adds `name: string` +
  `durationMs: number`. `runChecks` returns `CheckRunResult[]`, NOT bare `CheckResult[]` — so gate rows
  already carry a `name`/`durationMs` for persistence. Dimension-level rows are NOT single checks, so they
  must synthesize their own `name`/`durationMs` (see Phase 3).
- **`DeterministicCheck`** = `{ name; fn }` (`types.ts:141-144`) — no per-check weight.
- **`runChecks` is 3-arg**: `runChecks(checks, ctx, live?)` (`deterministic.ts:15-19`); the runner calls it
  as `runChecks(checks, ctx, judgeLive)` (`runner/index.ts:1076`) so each check streams into the live judge
  trace. Any new gate/dimension loop MUST thread `judgeLive` or the live trace silently stops streaming.
- **Scoring** (`runner/index.ts:1073-1224`): `checks = [tasksCompletedCheck(tasks), ...outcome.checks]`
  (array literal at `1073`) run via `runChecks(checks, ctx, judgeLive)` (`1076`); `checksPass =
  checkResults.every(r => r.pass)` (1094); optional `llmJudge` (1100-1136) and `agenticJudge` (1138-1218)
  gated by `threshold = outcome.passThreshold ?? 0.7` (1096); final `passed = checksPass && llmPass &&
  agenticPass` (1223); `if (score === null) score = passed ? 1 : 0` (1224).
- **`tasksCompletedCheck`** is declared at `runner/index.ts:568` and prepended at the `1073` array literal.
- **`passThreshold` default 0.7** is inlined as `?? 0.7` at **two** sites: `runner/index.ts:1096` and
  `registry.ts:268`. No shared constant. (Brainstorm wants 0.75 — Conflict 2.)
- **DB schema** is inline `CREATE TABLE IF NOT EXISTS` in `evals/src/db/client.ts` (NOT file-based
  migrations); additive columns go in the `COLUMN_MIGRATIONS` array (`client.ts:173-186`), each ALTER
  wrapped in try/catch (`client.ts:150-156`). `judgments.kind` has `CHECK (kind IN ('llm','deterministic'))`
  (`client.ts:116`). `judgments.score REAL` exists (119) but is never populated for `deterministic` rows.
- **FK / cascade:** `judgments.attempt_id TEXT NOT NULL REFERENCES attempts(id)` (`client.ts:115`) and
  `artifacts.attempt_id TEXT NOT NULL REFERENCES attempts(id)` (`client.ts:127`) — **neither has
  `ON DELETE CASCADE`**, so attempts cannot be deleted before their child judgments/artifacts rows. Phase 6
  purge MUST delete children first. (Confirmed.)
- **Existing deletes** (`db/queries.ts`): per-attempt `DELETE FROM judgments WHERE attempt_id = ?` (236) and
  `DELETE FROM artifacts WHERE attempt_id = ?` (237), plus `resetErrorAttempts` (255). There is **no**
  scenario-id bulk purge.
- **`insertJudgment`** (`db/queries.ts:264-301`) already accepts `score?: number | null`; the INSERT is
  hand-written positional (column list + placeholders + args must stay in lockstep).
- **`rowToJudgment`** (`db/queries.ts:70-86`) reads the judgment columns — adding `dimension`/`weight` here
  (Phase 2) is what surfaces them on the API response; **there is no per-field serializer in the attempt
  route**.
- **Attempt route** (`api/server.ts:529-536`) returns `listJudgments(db, attempt.id)` rows raw —
  `json({ attempt: serializeAttempt(attempt), judgments, artifacts })` (536). No judgment serializer to
  edit at "532-543"; the new columns flow through for free once Phase 2's `rowToJudgment` reads them.
- **Analytics SQL** (`api/server.ts:707-718` `/api/analytics` handler reading `ANALYTICS_SQL`) aggregates
  `score`/`status` per (run, scenario, config) — it has **no `judgments.dimension` join**, so cross-scenario
  per-dimension analytics is not available from the existing query (see Phase 7 decision).
- **Agentic judge** (`judge/agentic.ts`) is worker-0-bound: `run_command`/`read_file` call
  `input.ctx.exec` / `input.ctx.readFile` (130, 147), which are worker-0 aliases. It already receives
  `input.tasks` (task records, rendered 114-119) and `input.transcript` (235, **head-only**
  `slice(0, 30_000)`), but the system prompt (223-237) carries **no roster manifest**. `input.ctx.workers[]`
  (per-worker exec/readFile, `types.ts:248`) exists but the agentic judge ignores it.
  - **Asymmetry confirmed:** `llm.ts:133` uses `truncateMiddle(input.transcript, 60_000)`
    (head+tail, `llm.ts:95-98`), whereas agentic.ts uses head-only 30k — so late-stream final-report text
    can be truncated away from the agentic judge. This matters for comms-grading scenarios 6/7 (Phase 4).
- **Catalog**: 7 scenarios registered (`scenarios/index.ts:15-23`); only `memory-pipeline` uses a judge.
- **Tests are co-located beside sources** (verified — there is **no** `evals/src/tests/` directory). Existing
  examples: `src/registry.test.ts`, `src/db/client.test.ts`, `src/judge/trace.test.ts`,
  `src/runner/topo.test.ts`, `src/api/analytics-sql.test.ts`, and `scenarios/scenarios.test.ts` (already
  exists, ~7.5KB, with structural assertions). The only judge test today is `src/judge/trace.test.ts`
  (no agentic test yet). This resolves the prior Open Question 4 — new tests go beside their sources.
- **UI**: scenario metadata is resolved from the **live registry** at request time, never snapshotted per
  attempt; attempts store only `scenario_id`. Deleting old scenarios does NOT break rendering of retained
  old attempts — the server returns `scenario: null` and the SPA shows an unregistered-scenario fallback
  (`api/server.ts:673`, `ui/src/api.ts:110-119`). So no tombstones are needed.

## Desired End State

- `OutcomeSpec` gains `gates?: DeterministicCheck[]` and `dimensions?: DimensionSpec[]`; `CheckResult`
  gains `score?: number`; `DeterministicCheck` gains `weight?: number`. v1 specs (`checks`/`llmJudge`/
  `agenticJudge`/`passThreshold`) still author and run, normalized to v2 internally.
- Runner computes `score = Σ wᵢ·dimᵢ / Σ wᵢ`, runs gates (fail → `passed = false`, score still computed
  and stored), `passed = allGatesPass && score ≥ passThreshold` (default **0.75**). A judge **infra**
  failure (post agentic→llm fallback) deterministically marks the attempt `error` (excluded from analytics).
- `judgments` carries nullable `dimension TEXT` + `weight REAL`; per-dimension rows are written; old rows
  stay NULL and render unchanged.
- Agentic judge can read/exec **any** worker, its system prompt carries a roster manifest
  (names/templates/roles/lead), and its transcript slice uses the same head+tail `truncateMiddle` strategy
  as `llm.ts` so final-report text isn't dropped (required by comms dimensions in scenarios 6/7).
- 7 new scenarios replace the old 7; the round-11 calibration runs against a fresh `EVALS_DB_PATH` file
  (Taras's choice), so the old DB is left intact/recoverable and there are no stale attempts to carry (Phase 6).
- Analytics renders a per-dimension breakdown layered on round-9 surfaces; the data source for the
  AnalyticsPage dimension selector is decided in-plan (Phase 7), not left open.
- A documented calibration sweep gates each scenario on `mean(frontier) − mean(budget) ≥ 0.2`.

## What We're NOT Doing (v2 non-goals, per brainstorm)

- **Per-dimension pass thresholds** — only the global `passThreshold` exists.
- **Attempt-level dimension rollup** (a `dimensions_json` column on `attempts`) — per-judgment rows are the
  source of truth; rollup is a future migration if analytics queries demand it.
- **N-sample / median judge variance** — single judge call per dimension; revisit if soft dimensions prove
  noisy.
- **Tombstones / archived scenario metadata** for deleted scenarios — the DB is local/disposable and old
  attempts render by raw id; no tombstone table.
- **Widening `judgments.kind`** — `dimension` is an orthogonal column; kind stays `'llm' | 'deterministic'`.
- **Cross-scenario per-dimension analytics SQL** is OUT OF SCOPE unless Phase 7 explicitly chooses the
  ANALYTICS_SQL path (default: per-run RunDetails dimension breakdown only — see Phase 7 decision).

## Implementation Approach

Strict dependency order. Phases 1-3 are the schema + scoring core and must land together-coherent (the
runner can't compile against v2 types until they exist; tests gate each step). Phase 4 (judge roster) is
independent of 1-3's aggregation but needed before the multi-worker scenarios in Phase 6. Phase 5
(efficiency) depends on Phase 1's `DimensionSpec`. Phase 6 (catalog) depends on 1-5. Phase 7 (UI) depends
on the new `judgments.dimension` column from Phase 2 **and on round-9 analytics components being
merged/stable on the branch** (precondition — see Phase 7). Phase 8 (calibration) depends on everything and
is the ship gate.

LAW numbering is used within phases (idiomatic for this subproject; see prior evals specs) so later phases
can cross-reference earlier decisions by §.

## Quick Verification Reference

Tests are **co-located beside sources** (verified — no `evals/src/tests/` dir). New test files follow that
convention. The exact paths used per phase:

| Check | Command (run from repo root unless noted) |
|---|---|
| Typecheck (src + ui) | `cd evals && bun run tsc:check` |
| All unit tests | `cd evals && bun test` |
| Registry/normalizer (P1) | `cd evals && bun test src/registry.test.ts src/normalize-outcome.test.ts` |
| DB round-trip (P2) | `cd evals && bun test src/db/client.test.ts` |
| Runner scoring (P3) | `cd evals && bun test src/runner/scoring.test.ts` |
| Aggregation/efficiency (P3/P5) | `cd evals && bun test src/scoring.test.ts` |
| Agentic judge roster (P4) | `cd evals && bun test src/judge/agentic.test.ts` |
| Scenarios (P6) | `cd evals && bun test scenarios/scenarios.test.ts` (EXTEND existing file) |
| Registry sanity (loads all scenarios) | `cd evals && bun src/cli.ts registry` |
| Root lint (read-only, mirrors CI) | `bun run lint` (repo root) |
| UI build (analytics phase) | `cd evals && bun run ui:build` |
| Serve UI + API for manual QA | `cd evals && bun src/cli.ts serve --port 4801` |
| Run a sweep | `cd evals && bun src/cli.ts run --scenarios <ids> --configs <ids> --attempts <n>` |

> `evals/package.json` defines `tsc:check`, `test`, `ui:build`, `serve`, `run`, `cli`. There is no
> `evals lint` script — lint is the **root** `bun run lint` (CI runs read-only `lint`, not `lint:fix`).

---

## Phase 1 — OutcomeSpec v2 types + v1→v2 normalization

### Goal
Add the v2 schema (gates, weighted dimensions, graded checks) as additive optional fields to
`evals/src/types.ts`, plus a pure `normalizeOutcome()` that maps any v1 spec onto the v2 shape so all
existing authoring keeps working. No runner behavior change yet — this phase is types + a normalizer +
validation + serialization, all unit-tested in isolation.

### Files to change
- `evals/src/types.ts` (`135-152`) — extend `CheckResult`, `DeterministicCheck`, `OutcomeSpec`; add
  `CoreDimension`, `DimensionName`, `JudgeSubSpec`, `DimensionSpec`, and a `NormalizedOutcome` type.
- `evals/src/registry.ts` (`86-166` validate, `201-269` serialize) — validate v2 fields; extend
  `SerializedScenario.outcome` with `gates` + `dimensions`.
- New file `evals/src/normalize-outcome.ts` — the pure normalizer (co-located with its test
  `evals/src/normalize-outcome.test.ts`).
- New shared constant `DEFAULT_PASS_THRESHOLD = 0.75`. Put it in `evals/src/scoring.ts` (the new module
  Phase 3 also uses for `aggregateScore`); import it from both `normalize-outcome.ts` and `registry.ts`.

### Step-by-step
1. In `types.ts`, extend the existing interfaces (all additions OPTIONAL for back-compat):
   ```ts
   export interface CheckResult { pass: boolean; detail?: string; score?: number; } // score ∈ [0,1]
   export interface DeterministicCheck {
     name: string;
     fn: (ctx: JudgeContext) => Promise<CheckResult>;
     weight?: number; // default 1
   }
   export type CoreDimension =
     | "correctness" | "completeness" | "efficiency" | "instruction-following" | "communication";
   export type DimensionName = CoreDimension | (string & {}); // core validated, custom allowed
   export interface JudgeSubSpec { rubric: string; model?: string; agentic?: boolean; maxSteps?: number; }
   export interface DimensionSpec {
     name: DimensionName;
     weight: number;
     checks?: DeterministicCheck[]; // graded checks feed this dimension
     judge?: JudgeSubSpec;          // OR a judge rubric
     // at least one of checks/judge required (enforced in validateScenario)
   }
   export interface OutcomeSpec {
     llmJudge?: LlmJudgeSpec;       // v1 — kept
     agenticJudge?: AgenticJudgeSpec; // v1 — kept
     checks?: DeterministicCheck[];  // v1 — kept
     passThreshold?: number;         // default DEFAULT_PASS_THRESHOLD (0.75)
     gates?: DeterministicCheck[];   // v2 — binary must-pass
     dimensions?: DimensionSpec[];   // v2 — weighted graded
   }
   ```
2. Define the normalizer (pure, no I/O) in `normalize-outcome.ts`:
   `normalizeOutcome(spec: OutcomeSpec): NormalizedOutcome` returning
   `{ gates: DeterministicCheck[]; dimensions: NormalizedDimension[]; passThreshold: number }`:
   - **v1 `checks[]` → `gates[]`** (binary must-pass), preserving order. Do NOT prepend
     `tasksCompletedCheck` here — that stays the runner's job (Phase 3) so it applies uniformly to v1 and v2.
   - **v1 `llmJudge` / `agenticJudge` → one dimension** `{ name: 'correctness', weight: 1, judge: { rubric,
     model, agentic: !!agenticJudge, maxSteps } }`. If both v1 judges are set (no current scenario does),
     prefer agentic and flag a validation warning.
   - **v2 `gates` / `dimensions`** pass through; if both v1 `checks` and v2 `gates` are present, concatenate
     `checks` after `gates` (flag a validation note — mixing is allowed but discouraged).
   - `passThreshold` resolves to `spec.passThreshold ?? DEFAULT_PASS_THRESHOLD`.
   - **Decision encoded here:** `passThreshold` applies to the **weighted aggregate** score, not per-judge
     (today it gates each judge at `runner:1119,1186`). **Resolved (Taras): gate the weighted aggregate.**
     Only old judge scenario affected is `memory-pipeline` (deleted in Phase 6). Phase 3 implements the gate.
3. Extend `validateScenario` (`registry.ts:86`) with the same string-collection pattern:
   - each `DimensionSpec` has `weight > 0` and at least one of `checks`/`judge`;
   - dimension names unique within a scenario; core names validated against the `CoreDimension` set,
     custom strings allowed (warn-only, not error);
   - per-check `weight` (if present) `> 0`;
   - if `dimensions` present, total weight `> 0` (avoid divide-by-zero in Phase 3).
4. Extend `SerializedScenario.outcome` (`registry.ts:214-219`) and `serializeScenario` (`233-269`):
   add `gates: string[]` (gate check names) and `dimensions: { name; weight; checks: string[]; judge:
   boolean }[]`. Keep the existing `checks`/`llmJudge`/`agenticJudge`/`passThreshold` fields populated from
   the **normalized** outcome so the UI sees a consistent view (the synthetic `"tasks-completed"` prepend at
   `registry.ts:257` stays).
5. Replace the inlined `?? 0.7` — but only the **registry** one in this phase (`registry.ts:268` →
   `?? DEFAULT_PASS_THRESHOLD`); the runner one (`runner/index.ts:1096`) is touched in Phase 3 to avoid a
   half-migrated default.

### Anti-gaming note
None scenario-facing yet; this phase only enables graded authoring.

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test src/registry.test.ts src/normalize-outcome.test.ts
cd evals && bun src/cli.ts registry               # all 7 OLD scenarios still load (normalization back-compat)
```
- **Automated QA:** new `src/normalize-outcome.test.ts` (co-located with the new source) asserts: v1
  `checks`→gates; v1 `llmJudge`→single correctness dimension weight 1; v2 spec passes through;
  `passThreshold` default = 0.75; total-weight=0 rejected by `validateScenario`.
- **Manual Verification:** `serializeScenario` output for `memory-pipeline` shows its judge as a dimension
  AND keeps the legacy `agenticJudge` field non-null.

---

## Phase 2 — Forward-only `judgments` migration (nullable `dimension` + `weight`)

### Goal
Add two nullable columns to `judgments` via the additive `COLUMN_MIGRATIONS` array; thread them through the
row reader/writer. No reordering of existing migrations. Old rows keep NULLs and render unchanged.

### Files to change
- `evals/src/db/client.ts` (`173-186`) — append two `ALTER` statements (do NOT touch the `kind` CHECK).
- `evals/src/db/queries.ts` (`70-86` `rowToJudgment`, `264-301` `insertJudgment`).
- `evals/src/types.ts` (`JudgmentRow`, ~698-717 per research) — add `dimension: string | null;
  weight: number | null;` (nullable, documented as NULL on pre-v2 rows).
- `evals/src/db/client.test.ts` (`77-101`) — extend the idempotency + round-trip test (this is the single
  source of DB-layer coverage for Phase 2; there is no `queries.test.ts` and none is added).

### Step-by-step
1. Append to `COLUMN_MIGRATIONS` (after the last entry, before the closing `]`):
   ```
   "ALTER TABLE judgments ADD COLUMN dimension TEXT",
   "ALTER TABLE judgments ADD COLUMN weight REAL",
   ```
   Both nullable, no DEFAULT. They run idempotently each boot via the try/catch loop (`client.ts:150-156`).
   Never reorder/remove existing entries (the loop only tolerates already-exists).
2. `rowToJudgment` (`queries.ts:70-86`): read `dimension` as `string | null`, `weight` as `number | null`.
   This is the change that makes the columns flow to the `/api/attempts/:id` response (the route returns
   `listJudgments` rows raw — no serializer to edit).
3. `insertJudgment` (`queries.ts:264-301`): add `dimension`/`weight` to the param type; append the two
   columns to the SQL column list, two `?` to the placeholders, and `j.dimension ?? null` / `j.weight ??
   null` to the args array — **column count, placeholder count, and arg count must stay in lockstep**.
4. `client.test.ts`: after `initDb`, insert a judgment with `dimension`/`weight` set and assert round-trip;
   mirror the existing `judge_model` assertion style (`client.test.ts:86-88`). Add a second assertion that a
   judgment inserted WITHOUT `dimension`/`weight` reads back NULL on both (the pre-v2 row shape).

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test src/db/client.test.ts
# Fresh-DB smoke: point at a throwaway local file and confirm boot
EVALS_DB_PATH=/tmp/evals-phase2.sqlite bun src/cli.ts registry
```
- **Automated QA:** idempotency test asserts a second `initDb` on the same DB doesn't throw and the columns
  remain usable; round-trip test asserts both the set-values and the NULL-on-omit cases.
- **Manual Verification (fresh DB):** open `/tmp/evals-phase2.sqlite` and confirm
  `PRAGMA table_info(judgments)` lists `dimension` and `weight`.
- **Manual Verification (EXISTING/older DB — CLAUDE.md migration rule):** copy a pre-round eval DB (or pull
  a snapshot of the Turso replica into a local file), point `EVALS_DB_PATH` at the copy, run
  `bun src/cli.ts registry` to trigger `initDb`, and confirm the two `ALTER TABLE judgments ADD COLUMN`
  statements apply idempotently and **old judgment rows read back with `dimension`/`weight` = NULL**. This
  closes the "old rows render unchanged" invariant against a populated DB, not just a fresh one.

---

## Phase 3 — Runner weighted aggregation + gates + score-on-gate-failure + per-dimension persistence + failure semantics

### Goal
Replace the all-AND boolean block (`runner/index.ts:1073-1224`) with: gates-first, per-dimension 0-1
sub-scores (graded checks and/or judge), weighted aggregate, `passed = allGatesPass && score ≥ threshold`.
Always compute and store `score` even when a gate fails. Persist one `judgments` row per gate and per
dimension (carrying `dimension`/`weight`). Make a genuine judge-infra failure deterministically set the
attempt to `error`.

### Files to change
- `evals/src/runner/index.ts` (`1073-1224` scoring block; retry/error path `~1391-1478`; `?? 0.7` at `1096`).
- `evals/src/judge/deterministic.ts` (`15-52` `runChecks`, `26-33` throw-catch) — thread `CheckResult.score`
  into the returned `CheckRunResult` (the `name`/`durationMs` wrapper already exists; just surface `score`).
- `evals/src/scoring.ts` (new) — `aggregateScore(dimensions)` helper + the `DEFAULT_PASS_THRESHOLD`
  constant introduced in Phase 1.
- `evals/src/judge/llm.ts` / `agentic.ts` — wrap the fallback so infra failure throws a typed error (step 5).

### Step-by-step
1. **Normalize first.** At the top of the scoring block, call `normalizeOutcome(scenario.outcome)`
   (Phase 1). Prepend the implicit `tasksCompletedCheck(tasks)` (declared `runner/index.ts:568`, currently
   prepended at the `1073` array literal) as the **first gate** so v1 and v2 both keep "tasks completed" as
   a hard requirement. (The serialized synthetic name stays `"tasks-completed"` at `registry.ts:257`.)
2. **Gates.** Run all gates via `runChecks(gates, ctx, judgeLive)` — **thread the existing `judgeLive`
   handle** (matching the current call at `runner/index.ts:1076`) so the live judge-trace keeps streaming.
   A thrown check already yields `{pass:false}` (`deterministic.ts:26-33`). `allGatesPass =
   gateResults.every(r => r.pass)`. Persist each gate as a `judgments` row using the wrapper's existing
   fields: `kind:'deterministic'`, `name: result.name`, `durationMs: result.durationMs`, `dimension: null`,
   `weight: null`, `pass: result.pass`, `score: result.score ?? (result.pass ? 1 : 0)` (gates are not
   dimensions, so `dimension`/`weight` stay NULL).
3. **Dimensions.** For each normalized dimension compute a 0-1 sub-score, and persist exactly one
   `judgments` row per dimension. **Dimension-row shape (explicit — a dimension is NOT a single check, so it
   synthesizes its own `name`/`durationMs`):**
   - **graded checks:** run via `runChecks(dimChecks, ctx, judgeLive)` (thread `judgeLive`); per-check value
     = `res.score ?? (res.pass ? 1 : 0)`; dimension sub-score = weighted mean over member checks (per-check
     `weight ?? 1`). A check that **throws** → `{pass:false}` → value 0 (counts against the config). Persist
     one row: `kind:'deterministic'`, `name: dim.name`, `durationMs: Σ member check durationMs`,
     `dimension: dim.name`, `weight: dim.weight`, `score: subScore`, `pass: subScore >= 1`.
   - **judge:** call `judgeWithLlm` or `judgeAgentic` (per `judge.agentic`) — reuse the existing call sites
     (`1105`, `1153`) and the agentic→llm fallback (`1163-1183`). `subScore = verdict.score`. Persist one
     row: `kind:'llm'`, `name: dim.name`, `durationMs:` the judge trace duration, `dimension: dim.name`,
     `weight: dim.weight`, `score: verdict.score`, `pass: subScore >= 1`, carrying steps/cost/tokens as
     today (`1200-1215`).
4. **Aggregate + pass.** `score = Σ(dim.weight · dim.subScore) / Σ dim.weight` (guard Σ=0 → only-gates
   legacy path keeps `score = allGatesPass ? 1 : 0`). `threshold = normalized.passThreshold` (default
   0.75). `passed = allGatesPass && score >= threshold`. **Do NOT early-return on gate failure** — compute
   and store `score` regardless, then set `passed=false` if any gate failed (preserve the current
   1223-1224 ordering of "compute score, then set passed"). Replace the runner's inlined `?? 0.7` (1096)
   with `DEFAULT_PASS_THRESHOLD`.
5. **Failure semantics.** Today the standalone llm-judge call (`1105-1114`) and the agentic→llm fallback
   (`1175-1182`) are uncaught, so a judge-infra throw *incidentally* propagates to
   `runAttemptWithRetry`'s catch → status `error` after retries. Make this **explicit**: wrap those calls so
   a genuine judge-infra failure throws a typed `JudgeInfraError` that `runAttemptWithRetry` (`~1391-1478`)
   maps to status `error` (NOT `failed`). **Critical:** keep `signal?.throwIfAborted()` (`1167`) ahead of
   the fallback so a cancel still leaves the attempt resumable/`pending`, never `error`. A graded **check**
   that throws stays score 0 (it's the config's sandbox state); only a **judge model/infra** flake becomes
   `error`.
6. Keep `endJudging(attempt.id)` and the `updateAttempt` finalize (`1348-1359`) writing `score`/`passed`.

### Anti-gaming note
The score-on-gate-failure rule prevents a config from "winning" by passing only the cheap gate; the
weighted dimensions carry the discrimination.

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test src/runner/scoring.test.ts   # NEW — aggregation w/ a fake JudgeContext
cd evals && bun test src/scoring.test.ts          # NEW — aggregateScore pure-fn boundaries
cd evals && bun test                              # full suite green
```
- **Automated QA (`src/runner/scoring.test.ts`, co-located beside the runner):** (a) all gates pass + two
  weighted dimensions → expected Σwᵢ·dimᵢ/Σwᵢ; (b) a failing gate → `passed=false` but `score` still
  computed and stored; (c) a graded check that throws → dimension value 0; (d) a `JudgeInfraError` from a
  stubbed judge → attempt status `error`, excluded from analytics; (e) a v1 checks-only spec → identical
  pass/fail to today (gates-only legacy path, score 1/0); (f) the persisted dimension row carries
  `name = dim.name`, `dimension = dim.name`, `weight = dim.weight`.
- **Manual Verification:** run `memory-pipeline` (still a v1 judge spec) locally against a throwaway DB and
  confirm its score is unchanged vs pre-round IF the verdict cleared the old per-judge threshold — note the
  aggregate-threshold change (resolved: gate the aggregate) means a borderline judge score that previously passed
  per-judge now gates on the aggregate. See Manual E2E.

---

## Phase 4 — Agentic judge: full-roster tools + roster manifest in system prompt + head+tail transcript

### Goal
Let the agentic judge read/exec **any** worker (not just worker 0), tell it which workers exist and their
roles via the system prompt, and switch the transcript slice to head+tail so final-report text isn't
dropped. The transcript fix is **non-optional** for comms-grading scenarios 6/7 (Core Requirement 3).

### Files to change
- `evals/src/judge/agentic.ts` (`121-237` tool defs + prompt) — add `worker` arg to `run_command`/
  `read_file`, render a roster manifest, and **switch the 30k head-only slice (235) to head+tail**.
- `evals/src/runner/index.ts` (ctxWorkers build, ~1057-1071) — populate roster metadata onto the judge ctx.
- `evals/src/types.ts` (`JudgeWorkerContext` 228-233, `JudgeContext` 236-249) — extend `JudgeWorkerContext`
  with `name`/`template`/`role`/`isLead` OR add a `roster` field to `JudgeContext`.
- `evals/src/judge/llm.ts` (`121-139` prompt) — optionally inject the same roster manifest text (already
  uses `truncateMiddle(…, 60_000)` at 133, so no transcript change needed there).

### Step-by-step
1. Extend `JudgeWorkerContext` (`types.ts:228-233`) with `name?: string; template?: string; role?: 'lead' |
   'worker'; isLead?: boolean` (all optional — back-compat). Populate from `stack.workers[].member`
   (`BootMember`: index, role, `spec.name`, `spec.template`) at the ctxWorkers build site
   (`runner/index.ts:1057-1062`). Use **boot-time** `BootMember` data (available now), NOT the later
   `WorkerRosterEntry` (`types.ts:478-513`, captured end-of-attempt).
2. In `agentic.ts`, change `run_command`/`read_file` input schemas to add
   `worker: z.number().int().optional()` (default 0 — back-compat). Dispatch to
   `input.ctx.workers[worker]?.exec` / `.readFile`; guard out-of-range (`if (!w) return { error:
   'no such worker' }`). Mirror the precedent in `deterministic.ts:85-119` (`fileContainsOnWorker`). Keep
   `input.ctx.exec`/`readFile` worker-0 aliases intact so existing deterministic checks are unaffected.
3. Render a roster manifest block in the agentic prompt (after task summaries, ~line 232):
   ```
   ## Workers in this attempt
   - worker 0: name "scribe-a", template "researcher", role worker
   - worker 1: name "Lead", template "coordinator", role lead  ← LEAD
   ```
   built from `input.ctx.workers[]`. Tell the judge it can target a specific worker via the `worker` arg.
4. **Switch the transcript slice (235) to head+tail** so late-stream final-report text reaches the judge.
   Reuse the same strategy as `llm.ts`: either import/share `truncateMiddle` (`llm.ts:95-98`) and call
   `truncateMiddle(input.transcript, 60_000)`, or replicate the head+tail logic at the agentic call site.
   Scenarios 6 (`plan-implement-review`) and 7 (`distributed-audit`) grade communication/citation quality on
   the FINAL report; with head-only 30k that text can be truncated away. This step is a **dependency** of
   those scenarios' communication dimension, not optional.
5. Mirror the roster manifest into `llm.ts` prompt (121-139) so the non-agentic fallback also has labels.

### Anti-gaming note
The roster manifest lets the judge attribute "who said what" — required so a comms dimension can verify a
value was *communicated* between workers, not guessed (scenarios 4, 6, 7).

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test src/judge/agentic.test.ts   # NEW sibling to src/judge/trace.test.ts
```
- **Automated QA (`src/judge/agentic.test.ts`, new — there is no agentic test today, only `trace.test.ts`):**
  (a) `run_command` with `worker: 1` dispatches to `ctx.workers[1].exec`; (b) out-of-range worker returns an
  error object, not a throw; (c) the rendered prompt contains the roster block and marks the lead;
  (d) **the rendered agentic prompt includes TAIL content of a long transcript** (assert a sentinel string
  placed at the end of a >60k transcript survives `truncateMiddle`, proving final-report text isn't dropped).
- **Manual Verification:** run `cross-worker-invent` (Phase 6) under serve mode and read the judge trace —
  confirm it inspected `worker 1`/`worker 2` sandboxes.

---

## Phase 5 — Deterministic efficiency dimension vs per-scenario budget metadata

### Goal
Add `budgetUsd` / `budgetMs` scenario metadata and a deterministic `efficiency` dimension computed from the
attempt's recorded `costUsd` / `durationMs` against the budget — no judge. Opt-in (weight 0/omitted by
default).

### Files to change
- `evals/src/types.ts` (`Scenario` 188-213) — add `budgetUsd?: number; budgetMs?: number;` beside
  `timeoutMs`.
- `evals/src/registry.ts` — validate budgets positive; serialize them into `SerializedScenario`.
- `evals/src/scoring.ts` — `efficiencyScore(observed, budget)` mapping (1.0 at ≤ budget, linear decay to 0
  at N× budget).
- `evals/src/runner/index.ts` — when a dimension named `efficiency` has no checks/judge, compute it
  deterministically from `attempt.costUsd` / `durationMs` (already captured before judging).

### Step-by-step
1. Add `budgetUsd`/`budgetMs` to `Scenario`; validate `> 0` when present.
2. `efficiencyScore`: `clamp(1 - max(0, (observed - budget)) / ((N-1)·budget), 0, 1)` with N e.g. 3 (full
   credit ≤ budget, zero at 3× budget). Document the constant. If both cost and time budgets are set, take
   the min of the two sub-scores (worst-case discipline) — decide and document.
3. In the runner, recognize a dimension with `name: 'efficiency'` and no `checks`/`judge` as the
   deterministic efficiency dimension; feed it `attempt.costUsd` (and `durationMs`) vs the scenario budget.
   Guard the **unpriced** case: if `costUsd` is null (`costSource` unpriced), the efficiency dimension must
   skip (drop from the weighted average, re-normalize remaining weights) rather than score 0 — a missing
   price is not a model failure (Open Question 6). Document this.
4. Persist the efficiency dimension as a `judgments` row `kind:'deterministic'`, `name:'efficiency'`,
   `dimension:'efficiency'`, `weight`, `score`, `durationMs:` the time to compute it (≈0; or the attempt
   duration — pick one and document).

### Anti-gaming note
Efficiency is computed from real attempt cost/duration, not self-reported — a worker can't game it by
claiming to be fast.

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test src/scoring.test.ts   # efficiencyScore boundaries: ≤budget→1, N×→0, unpriced→skip
```
- **Automated QA:** `efficiencyScore` returns 1.0 at observed=budget, 0 at observed=N×budget, 0.5 midway;
  the runner-level unpriced path re-normalizes the remaining dimensions and the test asserts the divisor
  excludes efficiency (this part lives in `src/runner/scoring.test.ts` since it needs the runner aggregation).
- **Manual Verification:** `bug-ladder` (Phase 6) sets `budgetUsd: 0.5`; confirm a cheap frontier run scores
  efficiency ≈1 and an expensive budget run scores lower in the judge/attempt breakdown.

---

## Phase 6 — Catalog: delete 7 old scenarios + author 7 new scenarios (round runs on a fresh DB)

### Goal
Replace `scenarios/index.ts`'s 7 scenarios with the 7 new discriminating ones and author each new scenario
against the anti-gaming checklist. **Resolved (Taras): the round-11 calibration runs against a FRESH
`EVALS_DB_PATH` file** — a clean slate with zero risk to the old DB (which stays intact and recoverable). No
in-place purge script is built; old attempts in the old DB are simply not carried over.

### Files to change
- `evals/scenarios/index.ts` — replace the import list + `scenarios` array + `DEFAULT_SCENARIO_IDS`.
- Delete `evals/scenarios/{build-verify-fix,memory-pipeline,memory-seeded-recall,relay-handoff,roster-demo,
  sql-seeded-history,two-workers}.ts` (mine for machinery first).
- New: `evals/scenarios/{sql-audit,memory-distractor,bug-ladder,cross-worker-invent,relay-pipeline,
  plan-implement-review,distributed-audit}.ts`.
- New fixtures under `evals/scenarios/fixtures/` (sql dumps, repo tarballs/heredocs) as needed.
- New graded check factories in `evals/src/judge/deterministic.ts` (return `CheckResult` with `score`).
- EXTEND the EXISTING `evals/scenarios/scenarios.test.ts` (do NOT create a second file) with structural
  assertions for the new scenarios.
- _(No purge script.)_ The round uses a fresh `EVALS_DB_PATH` file (Taras's choice); the old DB is left
  untouched. See the fresh-DB note below.

### Machinery to mine (confirmed reusable)
- `sql-audit` / `distributed-audit`: `seed.sqlDump` + richer multi-row `.sql` + `apiGet` + `fileContains`
  (from `sql-seeded-history`).
- `memory-distractor`: `seed.memories` + per-fact `fileContains` graded checks (from `memory-seeded-recall`).
- `bug-ladder`: `seed.exec` heredoc test suites + `dependsOn` + per-test-group green checks (from
  `build-verify-fix`).
- `cross-worker-invent` / `relay-pipeline`: `workers: 2-3` + `seed.exec` + `dependsOn` +
  `fileContainsOnWorker` / `fileAbsentOnWorker` (from `relay-handoff`).
- `plan-implement-review` / `distributed-audit`: `lead` + `WorkerSpec[]` + multi-task chains (from
  `roster-demo`). **Cap:** `MAX_WORKERS = 3` (`registry.ts:13`) — relay/distributed chains max 3 workers
  (+ lead, which is outside the cap).

### Scenario specs (from brainstorm batch table, with anti-gaming applied to EACH)
1. **`sql-audit`** (Data, 1 worker, ~$0.15-0.3, spread 0.4→0.9): seeded DB ~30 tasks + red herrings.
   Dimensions: `correctness` (answer-key `fileContains` checks per graded question: count → which →
   cross-reference anomaly), `communication` (judge on final report). Anti-gaming: red-herring rows make
   the count non-trivial; the anomaly isn't derivable from the prompt; answer-key values never appear in
   the task text; the rubric isn't shown to the worker.
2. **`memory-distractor`** (Memory, 1, ~$0.15, 0.3→0.85): seeded ground-truth memories; prompt embeds
   plausible-WRONG defaults. Dimensions: `correctness` (per-fact checks), custom `retrieval-fidelity`
   (agentic judge verifies retrieved-not-guessed). Anti-gaming: the plausible-wrong default in the prompt is
   the distractor; echoing the prompt scores 0 on the per-fact checks; the judge cross-checks the sandbox to
   confirm the worker actually searched memory.
3. **`bug-ladder`** (Code, 1, ~$0.3-0.5, 0.35→0.9, `budgetUsd: 0.5`): seeded repo, 4-5 bugs of graded
   difficulty (typo → logic → edge case → subtle), each its own test group. Dimensions: `correctness`
   (fraction of test groups green — needs `CheckResult.score`), `instruction-following` (tests-unmodified
   check + constraint adherence), `efficiency` (vs $0.5 budget — first end-to-end exercise). Anti-gaming:
   tests-unmodified gate prevents gaming by editing tests; bug fixes aren't derivable from the prompt;
   graded by test execution, not self-report.
4. **`cross-worker-invent`** (Multi-worker, 3, ~$0.3-0.5, 0.3→0.8): worker A invents a UUID; B, C must
   obtain it via communication, not guessing. Dimensions: `correctness` (per-hop propagation
   `fileContainsOnWorker` checks), custom `provenance` (agentic judge cross-checks all workers' sandboxes —
   requires Phase 4). Anti-gaming: the UUID is random per attempt (not in any prompt); guessing is
   astronomically unlikely; the judge verifies the value propagated by communication, not coincidence.
5. **`relay-pipeline`** (Multi-worker, 2-3, ~$0.3, 0.4→0.9): chained transforms where each stage's fidelity
   is independently checkable. Dimensions: `correctness` per stage (chained deps = natural partial credit),
   `completeness`. Anti-gaming: each transform's correct output isn't derivable from the prompt; graded by
   per-stage checks on actual files.
6. **`plan-implement-review`** (Multi-worker + Code, lead + 2-3, ~$1-2, 0.3→0.8, raised `timeoutMs`): lead
   decomposes a 3-task chain plan → implement → review-with-citations. Dimensions: `correctness` (stage
   subgoals), `communication` (judge grades review specificity — must cite real lines; **depends on Phase 4
   head+tail transcript so the final review text reaches the judge**), `instruction-following`. Anti-gaming:
   review must cite real file lines (judge verifies against sandbox); plan quality not promptable; rubric
   hidden from workers.
7. **`distributed-audit`** (Data + Multi-worker, lead + 2, ~$1, 0.25→0.75, raised `timeoutMs`):
   investigation sharded across workers, lead merges one report. Dimensions: `completeness` (shard-coverage
   checks), `correctness` (merged answer key), `communication` (judge on report; **depends on Phase 4
   head+tail transcript**). Anti-gaming: each shard's answer isn't in the prompt; coverage checks require
   all shards handled; merge graded against a hidden key.

Set `DEFAULT_SCENARIO_IDS` to a cheap smoke scenario (e.g. `memory-distractor` or `sql-audit`).

### Clean slate via a fresh DB (Taras's choice — replaces the in-place purge)
The round runs against a **fresh `EVALS_DB_PATH` file** rather than deleting rows from the existing DB:

```bash
export EVALS_DB_PATH=/tmp/evals-round11.sqlite   # new file; old DB untouched & recoverable
```

This is the zero-risk clean slate: the two Phase-2 ALTERs apply at boot to the new file, only round-11
scenarios are registered, and there are no stale old-scenario attempts to filter out. No
`purge-scenarios.ts` helper is built. (For reference, in-place deletion would have been hazardous: there is
**no `ON DELETE CASCADE`** on `judgments`/`artifacts` FKs — `client.ts:115,127` — so it would have required a
child-first delete `judgments → artifacts → attempts` keyed on `attempt_id`, never against the shared replica
`EVALS_DB_SYNC_URL`. The fresh-DB path avoids all of that.)

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun src/cli.ts registry              # exactly the 7 NEW scenarios load, no validation errors
cd evals && bun test scenarios/scenarios.test.ts # EXTENDED existing file — per-scenario structural assertions
cd evals && bun test src/registry.test.ts
# Clean slate for the round: a fresh DB file (old DB untouched)
cd evals && EVALS_DB_PATH=/tmp/evals-round11.sqlite bun src/cli.ts registry   # boots fresh, only round-11 scenarios
```
- **Automated QA:** `scenarios/scenarios.test.ts` (extended) asserts each new scenario has gates + ≥1
  dimension with weight > 0, budgets where specified, multi-worker counts ≤ 3, and that graded checks return
  `score`.
- **Manual Verification:** point `serve` at the OLD DB (not the round-11 file) and confirm old attempts for
  the deleted scenarios still render as raw-id fallback — confirms the registry-resolved (not snapshot)
  finding holds after the scenarios are removed from the registry. (The round-11 fresh DB simply has no old
  attempts.)

---

## Phase 7 — Analytics / UI per-dimension breakdown (layered on round-9 surfaces)

### Goal
Surface the per-dimension `judgments` data in the evals SPA without forking round-9 components. All new
fields additive/optional; old attempts (NULL dimension) render unchanged.

### Precondition (round-9 dependency — explicit)
Phase 7 reuses the round-9 analytics components (`HeatTable`, `ScatterChart`, the FROZEN quadrant-band
geometry, presets). Round 9 is "in flight on the same branch." **Phase 7 requires those components to be
merged/stable on the branch at implementation time.** If they are not:
- block Phase 7 until they land, OR
- scope Phase 7 down to **RunDetailsPage per-dimension breakdown only** (which depends only on Phase 2's
  column + Phase 3's rows, not on round-9 charts) and defer the AnalyticsPage dimension selector.
State the assumed branch state in the implementation commit so the implementer knows whether the round-9
components exist and with what prop shape.

### Files to change
- `evals/ui/src/types.ts` (`JudgmentJson` 349-367) — add optional `dimension`/`weight`. **No `server.ts`
  change is needed** — the `/api/attempts/:id` route returns `listJudgments` rows raw (`server.ts:529-536`),
  so the fields flow to the API response for free via Phase 2's `rowToJudgment`. Verify (don't add a
  serializer) that the API already emits `dimension`/`weight`.
- `evals/ui/src/pages/RunDetailsPage.tsx` (`JUDGMENT_COLUMNS` 1764-1831, `ChecksTab` 1833-1875) — add a
  Dimension column and/or group rows by dimension with per-dimension weighted sub-score headers.
- `evals/ui/src/pages/ScenariosPage.tsx` (`404-528`) — render the dimension/weight config.
- `evals/ui/src/pages/AnalyticsPage.tsx` — add a **dimension selector** (see data-source decision below).

### Data-source decision for the AnalyticsPage dimension selector (pick one — default = A)
The existing `ANALYTICS_SQL` (`server.ts:707-718`) aggregates per-attempt `score`/`status` only — it has
**no `judgments.dimension` join**, so cross-scenario per-dimension scores are not available from it today.
Choose:
- **(A) DEFAULT — scope the dimension selector to per-run RunDetails only.** Cross-scenario per-dimension
  analytics is a Phase-7 **non-goal**; the AnalyticsPage heat/scatter keep using `attempt.score` (the richer
  aggregate from Phase 3 already spreads the 1.00 cluster for free). RunDetailsPage gets the full
  per-dimension breakdown from the already-loaded per-attempt judgments. This requires **no analytics-SQL
  change** and is the safe default.
- **(B) Cross-scenario per-dimension analytics.** Add a `dimension`-grouped aggregation to `ANALYTICS_SQL`
  (or a sibling query) joining `judgments.dimension`, expose it on `/api/analytics`, and feed it to
  `HeatTable.value` / `ScatterChart` y-axis. If chosen, add a test mirroring `src/api/analytics-sql.test.ts`.
  Only take (B) if the cross-scenario per-dimension view is explicitly wanted — it's strictly more work.

### Step-by-step
1. UI types: add optional `dimension`/`weight`; default render to a dash when null (frozen-contract
   convention). Confirm the API already emits the fields (no server serializer to add).
2. RunDetailsPage: group the Checks/Judgments table by `dimension` (NULL → "overall/legacy" bucket), show a
   weighted sub-score header per dimension. Keep `StatusScore` as the per-row verdict glyph.
3. AnalyticsPage: implement the dimension selector per the chosen data-source option above. Under (A), the
   selector reshapes only RunDetails / per-run views; under (B), it reshapes the cross-scenario heat/scatter.
   Either way, reuse the existing round-9 components and quadrant prop — add data + a selector, never new
   chart geometry.
4. Do NOT change `attempt.score` render sites (`Matrix.bestScore`, `StatusScore`, `HeatTable`, scatter y) —
   the richer aggregate from Phase 3 already spreads the 1.00 cluster there for free.

### Verification
```bash
cd evals && bun run tsc:check        # includes `tsc --noEmit -p ui`
cd evals && bun run ui:build
bun run lint                          # repo root
# If option (B) was taken:
cd evals && bun test src/api/analytics-sql.test.ts
```
- **Automated QA:** under option (A), evals UI has no unit-test infra; the gate is compile-only per
  merge-gate.yml (evals is NOT in the qa-use filter) — `ui:build` + `tsc:check` are the gate. Under option
  (B), the new analytics-SQL aggregation gets a test beside `analytics-sql.test.ts`.
- **Manual Verification:** `cd evals && bun src/cli.ts serve --port 4801`, open the SPA, view a Phase-8
  calibration run: per-dimension breakdown renders in RunDetails, the dimension selector reshapes the
  appropriate view, and an OLD attempt shows dashes for dimension/weight (no crash).

---

## Phase 8 — Calibration sweep tooling/recipe + documented baseline spreads + ship gate

### Goal
A documented, repeatable calibration recipe that runs each new scenario × the 4 anchor configs × 3
attempts, records per-scenario baseline spreads, and applies the ship gate
`mean(frontier) − mean(budget) ≥ 0.2`.

### Files to change
- New: `evals/docs/calibration.md` (or `evals/scenarios/CALIBRATION.md`) — the recipe + recorded baselines.
- Optionally a small helper script `evals/scripts/calibration-report.ts` that reads the run via the existing
  `listAttempts` + `summarizeRun` and prints frontier/budget means per scenario (avoids hand math). **Use
  this exact path (`evals/scripts/calibration-report.ts`) in both this phase and the Manual E2E** — the
  evals package has no `scripts/` dir today; this creates it, mirroring the repo-root `scripts/` convention.
- Each new scenario file — add a top comment recording its calibrated spread (frontier avg, budget avg, gap).

### Anchor configs (verified against `evals/configs/index.ts`)
- **Frontier:** `claude-opus-4.8`, `codex-5.5`.
  > **Resolved (Taras):** the frontier opus anchor is **pinned to `claude-opus-4.8`** (explicit pin,
  > `configs/index.ts:36-50`) rather than the floating `claude-opus` alias (which resolves to `model: "opus"`,
  > `index.ts:30-34`) — so the recorded baseline spread stays reproducible as "latest opus" advances. Record
  > the concrete model id in `calibration.md` regardless.
- **Budget:** `pi-deepseek-flash`, `claude-haiku` (both confirmed present in `configs/index.ts`).
  > **Resolved (Taras):** the calibration budget cohort is **two anchors — `pi-deepseek-flash` (deepseek
  > via pi) + `claude-haiku` (haiku via claude)**. The brainstorm's `pi-haiku` doesn't exist (confirmed), so
  > haiku is anchored on claude and deepseek represents the pi side. `pi-grok-build-0.1` and
  > `pi-gemini-3.5-flash` are **dropped from the calibration anchor set** (they stay in the catalog for full
  > leaderboard sweeps). Cohort is 1 pi + 1 claude per tier — symmetric with the frontier cohort
  > (`claude-opus-4.8` + `codex-5.5`). _Review note:_ if you meant to keep all four budget anchors, say so
  > and I'll restore grok-build + gemini.

### Step-by-step
1. Write `calibration.md`: the exact `run` command (below), the ship gate formula, the borderline rule
   (gaps 0.1-0.3 → +2 attempts), cost ceilings (≤$0.25 easy, ~$1-2 deep; full 7-scenario × 4-anchor × 3
   sweep ~$40-120), the pinned frontier model (`claude-opus-4.8`), the budget cohort
   (`pi-deepseek-flash` + `claude-haiku`), and a results table to fill in per scenario.
2. (Optional) `evals/scripts/calibration-report.ts`: given a `runId`, compute `mean(frontier avg)` and
   `mean(budget avg)` per scenario from stored attempt scores, print the gap and PASS/FAIL vs 0.2.
3. Run the sweep (Manual E2E below), record spreads in each scenario file's header comment, and only keep a
   scenario in `DEFAULT_SCENARIO_IDS` / mark it shippable if it clears the gate.

### Verification
```bash
cd evals && bun run tsc:check
cd evals && bun test                         # full suite still green after report helper
cd evals && bun src/cli.ts registry          # all 7 scenarios + 4 anchor configs resolve by id
```
- **Automated QA:** if `calibration-report.ts` is added, a unit test feeds synthetic attempts (3 frontier
  ≈0.9, 3 budget ≈0.4) and asserts the computed gap = 0.5 and PASS.
- **Manual Verification:** the Manual E2E section below is this phase's acceptance — a real sweep clearing
  the ship gate.

---

## Manual E2E — Calibration sweep on E2B (ship gate)

Prereqs (env): `E2B_API_KEY`, `OPENROUTER_API_KEY` (judge + pi workers), `CLAUDE_CODE_OAUTH_TOKEN` (claude
workers), `OPENAI_API_KEY` (codex workers), and either `EVALS_DB_PATH=<local file>` for a throwaway DB or
the Turso replica env (`EVALS_DB_SYNC_URL` + `EVALS_DB_AUTH_TOKEN`). A bare local path is wrapped as `file:`
by `db/client.ts`, so `EVALS_DB_PATH=/tmp/...` needs no sync URL/auth. Use a throwaway local DB for
calibration so a re-run is clean — and so the NEW v2 scoring runs against a FRESH schema (the two Phase-2
ALTERs applied at boot):

```bash
export EVALS_DB_PATH=/tmp/evals-calibration.sqlite
```

> Back-compat (covered in Phase 2 Manual Verification): the two new nullable columns also apply idempotently
> against an EXISTING/older eval DB; run the Phase-2 existing-DB check before relying on a populated replica.

1. **Per-scenario smoke (cheap, 1 attempt) before the full sweep** — verify each new scenario boots, seeds,
   grades, and produces a non-saturated score on at least one frontier + one budget anchor:

```bash
cd evals && bun src/cli.ts run \
  --name "cal-smoke" \
  --scenarios sql-audit \
  --configs claude-opus-4.8,pi-deepseek-flash \
  --attempts 1 --concurrency 2
```

2. **Full calibration sweep** — each new scenario × the 4 anchors × 3 attempts. Run per scenario (so a
   single scenario's failure doesn't abort the batch) or all at once.

```bash
# all scenarios, all anchors, 3 attempts each (heaviest — ~$40-120 total)
cd evals && bun src/cli.ts run \
  --name "round11-calibration" \
  --scenarios sql-audit,memory-distractor,bug-ladder,cross-worker-invent,relay-pipeline,plan-implement-review,distributed-audit \
  --configs claude-opus-4.8,codex-5.5,pi-deepseek-flash,claude-haiku \
  --attempts 3 --concurrency 4 --max-retries 1
```

(If a run is interrupted, resume it: `cd evals && bun src/cli.ts resume <runId>`.)

3. **Inspect the matrix + per-dimension breakdown:**

```bash
cd evals && bun src/cli.ts show <runId>           # ASCII score matrix
cd evals && bun src/cli.ts serve --port 4801      # open the SPA → RunDetails → per-dimension; AnalyticsPage dimension selector
```

4. **Apply the ship gate** per scenario. Frontier anchors = {`claude-opus-4.8`, `codex-5.5`}; budget anchors =
   {`pi-deepseek-flash`, `claude-haiku`} (1 pi + 1 claude per tier). For each scenario:
   - `frontierAvg` = mean over frontier anchors of (that anchor's mean score over its 3 attempts);
   - `budgetAvg` = mean over budget anchors of (that anchor's mean score over its 3 attempts);
   - **Ship gate:** `frontierAvg − budgetAvg ≥ 0.2`. Borderline (gap 0.1-0.3): run +2 attempts per anchor
     before the verdict.

   The gate is **NOT blocked on the optional report helper**. If `evals/scripts/calibration-report.ts` was
   built, use it; otherwise compute the gate by hand from `bun src/cli.ts show <runId>` per the formula:

```bash
# preferred (if built):
cd evals && bun scripts/calibration-report.ts <runId>   # per-scenario frontierAvg, budgetAvg, gap, PASS/FAIL
# fallback (always available): read `bun src/cli.ts show <runId>` and apply the formula by hand
```

5. **Record** each scenario's calibrated spread (frontierAvg, budgetAvg, gap) AND the pinned frontier
   model (`claude-opus-4.8`) in its scenario-file header comment and in `evals/docs/calibration.md`. A
   scenario ships only if it clears the gate; sub-gate scenarios get reworked (stronger distractors / harder
   graded subgoals) and re-swept.

---

## Appendix — Back-compat invariants (carry through every phase)

- **Nullable columns:** `judgments.dimension` / `judgments.weight` are NULL on all pre-v2 rows and render as
  a dash; never backfill. Verified idempotent against BOTH a fresh DB and an existing populated DB (Phase 2).
- **v1→v2 normalization is mandatory:** every existing authoring key (`checks`, `llmJudge`, `agenticJudge`,
  `passThreshold`) keeps working via `normalizeOutcome` — `checks → gates`, single judge → one correctness
  dimension weight 1.
- **Aggregate-threshold behavior change:** `passThreshold` now gates the WEIGHTED AGGREGATE, not each judge
  individually (was `runner:1119,1186`). **Resolved (Taras): gate the weighted aggregate.** The only old
  judge scenario affected (`memory-pipeline`) is deleted in Phase 6, so there's no live regression.
- **Old-attempt rendering:** scenario metadata is registry-resolved, not snapshotted; deleting the old 7
  scenarios is safe — the server returns `scenario: null` and the SPA shows the unregistered-scenario
  fallback (`api/server.ts:673`, `ui/src/api.ts:110-119`). No tombstones. The round runs on a fresh
  `EVALS_DB_PATH` (Taras's choice), so no in-place purge is performed; the old DB stays intact.
- **`judgments.kind` stays `'llm' | 'deterministic'`** — `dimension` is an orthogonal column.
- **`DEFAULT_PASS_THRESHOLD = 0.75`** lives in one module (`scoring.ts`) and replaces both inlined `?? 0.7`
  literals (`runner/index.ts:1096`, `registry.ts:268`) — do not reintroduce a literal.
- **`runChecks` live-trace threading:** every new `runChecks(gates|dimChecks, ctx, judgeLive)` call MUST
  thread the existing `judgeLive` handle (matching `runner/index.ts:1076`) or the live judge-trace silently
  stops streaming for gates/dimensions.
- **Judge-infra failure → `error` (excluded from analytics); graded-check throw → score 0** — never let
  judge flake masquerade as a 0-score config failure; never let a config's broken sandbox masquerade as a
  judge error. Cancel (`signal.throwIfAborted()`) stays ahead of the fallback so a cancel leaves the attempt
  resumable, never `error`.