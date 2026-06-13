---
date: 2026-06-12T00:00:00+02:00
author: Taras
topic: "Evals scenario catalog redesign for score discrimination"
tags: [brainstorm, evals, scoring, scenarios, judges]
status: in-progress
exploration_type: problem
last_updated: 2026-06-12
last_updated_by: Claude
---

# Evals scenario catalog redesign for score discrimination — Brainstorm

## Context

**Problem:** The evals matrix (`evals/` — scenario × harness-config on E2B) can't discriminate between frontier and budget models. The 7 registered scenarios (`evals/scenarios/index.ts`) nearly all score binary 1.00 — capable harnesses "just work", so the matrix tells us pass-rate, not quality ranking.

**Why scores are binary today** (from `evals/src/runner/index.ts:1072–1223`):
- 6/7 scenarios are deterministic-checks-only; `CheckResult` is `{ pass: boolean }` — no partial credit.
- Final aggregation is all-AND: `passed = checksPass && llmPass && agenticPass`; when no judge runs, `score = passed ? 1 : 0`.
- Judges (llm/agentic) do emit continuous `score ∈ [0,1]` gated by `passThreshold` (default 0.7), but only `memory-pipeline` uses one.
- No weights, dimensions, or rubric-per-dimension anywhere in `OutcomeSpec` (`evals/src/types.ts:123–131`).

**Storage / back-compat surface:**
- `attempts.score REAL`, `attempts.passed INTEGER`; `judgments` rows are `kind IN ('llm','deterministic')`, `pass` required, `score` nullable. 100+ stored attempts must keep rendering in the UI.

**Adjacent work (must not conflict):**
- Round 9 (2026-06-12 spec) is UI/analytics only — quadrant quartile bands, config presets, transcript UX. No OutcomeSpec changes there; this redesign lands as its own round after round 9.
- v6 spec §13.2 backlog: `sql-audit-history`, `memory-distractor`, `cross-worker-invent` (blocked: agentic judge is worker-0-bound), `chain-depth-3`, `tier-ladder` run recipe.
- WorkerSpec rosters + lead landed in v7; judge model default is DeepSeek V4 Pro.

**Goals to explore:**
1. Scenarios with genuine partial credit (difficulty ladders, graded subgoals, distractors, chained dependencies).
2. Multi-dimension grading (correctness, completeness, efficiency/cost discipline, instruction-following, communication) with per-dimension weights → weighted attempt score; composition with checks + llmJudge/agenticJudge + passThreshold.
3. OutcomeSpec schema changes with back-compat for stored judgments.
4. First batch: 5–8 scenario designs easy→hard with expected score spreads, multi-worker/lead variants, per-scenario cost ceilings.

**Constraints:**
- Judge cost proportionate — deterministic checks preferred; judge only where judgment is genuinely needed.
- Scenarios self-contained in E2B sandboxes.
- Existing stored attempts keep rendering.
- End state: written proposal reviewable via file-review → converts into an implementation round.

## Exploration

### Q: Where should score discrimination primarily come from — graded deterministic subgoal checks (scenario-content lever) or judge dimension rubrics (grading-machinery lever)?
Tiered grading across the board: not only making the AI judge non-binary, but making **all** the checks of a scenario tiered/graded as well.

**Insights:** This generalizes beyond "deterministic-first vs judge-led" — the whole grading pipeline becomes graded. `CheckResult` needs to carry partial scores (or tier membership), not just `pass: boolean`, and aggregation must move from all-AND to a tiered/weighted composition. "Tiered" may also imply difficulty tiers within a scenario (ladder semantics) — to clarify in aggregation question.

### Q: With graded checks everywhere, what should `passed` mean?
Gates + threshold (option 1): checks split into **gating** (must-pass; fail → attempt fails, score still computed) and **graded** (weighted into score). `passed = all gates pass AND score ≥ passThreshold`. Taras asked for a definition of "gate" — answered: a gate is a hard-requirement check encoding "did the scenario fundamentally happen" (task completed, output file exists, sandbox healthy); graded checks measure *how well* (subgoals, quality, correctness details).

**Insights:** Preserves hard-requirement semantics and pass-rate analytics while letting score carry the discrimination. Old scenarios map cleanly: every existing check is a gate with no graded checks → identical behavior, zero back-compat risk.

### Q: How should graded components compose into the attempt score?
Named dimensions: scenario declares weighted dimensions; each dimension is fed by deterministic checks OR a judge rubric section. Attempt score = weighted average of dimension scores. Chosen shape:

```ts
outcome: {
  gates: [taskCompleted, outputExists],
  dimensions: [
    { name: 'correctness',  weight: 0.5, checks: [countIs42, idsCited] },
    { name: 'completeness', weight: 0.3, checks: [allRowsHandled] },
    { name: 'communication', weight: 0.2, judge: { rubric: '...' } },
  ],
  passThreshold: 0.6,
}
// score = 0.5*corr + 0.3*comp + 0.2*comm
```

**Insights:** Dimensions unify the two levers — checks and judges are both dimension feeders, so judge cost stays opt-in per dimension. Ladder semantics can still be expressed *inside* a dimension (ordered subgoal checks with increasing difficulty). Per-dimension analytics across the matrix becomes possible ("config X weak on instruction-following").

### Q: Fixed dimension taxonomy or free-form per scenario?
Fixed core + custom: a standard enum (~`correctness`, `completeness`, `efficiency`, `instruction-following`, `communication`) that analytics aggregates on cross-scenario, plus optional scenario-specific custom dimensions that render only within that scenario.

**Insights:** Schema-wise: `name: CoreDimension | (string & {})` — validate core names strictly, allow custom strings. Analytics keys on the core set; custom dimensions still feed the attempt score but don't appear in cross-scenario dimension charts.

### Q: (clarification surfaced) How relevant is judge cost as a constraint?
"The important thing is tracking how good the swarm is in different dims and setups — the cost of judging is not that relevant tbh."

**Insights:** The brief's "judge cost proportionate" constraint is softer than written. We can use judges liberally where they add signal (soft dimensions, anti-gaming verification) — the design driver is **signal quality per dimension**, not judge spend. Deterministic checks remain preferred where they're *more reliable*, not because they're cheaper.

### Q: Should the swarm's own resource use (attempt costUsd/tokens/duration) be a scored dimension?
Deterministic, opt-in: `efficiency` is a core dimension computed deterministically from attempt cost/tokens/duration against a per-scenario budget — no judge involved. Scenarios opt in with an explicit weight; capability-focused scenarios set weight 0 (or omit it).

**Insights:** Needs a per-scenario budget field (e.g. `budgetUsd` / `budgetMs`) and a mapping function (e.g. 1.0 at ≤ budget, linear decay to 0 at N× budget). Data already exists on `AttemptRow` — this dimension is computable retroactively for old attempts, unlike check-based dimensions.

### Q: What happens to the existing 7 scenarios — tiers + retrofit, freeze, or flat catalog?
"They seem too easy tbh — I'm fine deleting them and thinking of new ones; we can use the inspiration though."

**Insights:** The new catalog is a clean-slate design that mines the old scenarios for *machinery* (seeding, multi-worker rosters, relay handoffs, bunTestGreen-style exec checks) rather than retrofitting them. Back-compat caveat to carry into the proposal: 100+ stored attempts reference `scenario_id` — deletion must not break old-attempt rendering (check whether the UI resolves scenarios from the live registry or from a serialized snapshot per run; if registry, we need tombstones/archived scenario metadata).

### Q: How do we validate that new scenarios actually discriminate?
Calibration run: the implementation round ends with a calibration sweep — each new scenario × 2–3 anchor configs (one frontier, one budget, e.g. claude/sonnet vs pi/deepseek-flash) × 3 attempts. A scenario ships only if anchors separate by a margin (~≥0.2 score gap).

**Insights:** This makes "expected score spread" a testable acceptance criterion per scenario, not a guess. Calibration artifacts (anchor scores, spread) should be recorded in the proposal/scenario docs so future saturation is detectable against a baseline.

### Q: Include the agentic-judge workers[] extension in scope (it's currently worker-0-bound)?
Yes — the judge should have access to **all** workers, and ("important!") its system prompt must describe which workers are available and their roles (names, templates, lead vs member) so it knows what it's inspecting.

**Insights:** Scope now includes runner work, not just schema + scenarios: judge toolset over the full `ctx.workers` roster (read files / exec per worker) + a roster manifest injected into the judge's system prompt. This unblocks v6's `cross-worker-invent` and makes judge-fed dimensions viable for multi-worker/lead scenarios. The roster data already exists (`AttemptRow.workers` / WorkerRosterEntry).

## Synthesis

### Key Decisions
- [Filled after exploration]

### Open Questions
- [Filled after exploration]

### Constraints Identified
- [Filled after exploration]

### Core Requirements
- [Filled after exploration]

## Next Steps

- [Handoff decision: research, plan, or parked]
