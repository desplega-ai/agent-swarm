---
date: 2026-06-12T00:00:00+02:00
author: Taras
topic: "Evals scenario catalog redesign for score discrimination"
tags: [brainstorm, evals, scoring, scenarios, judges]
status: complete
exploration_type: problem
last_updated: 2026-06-13
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

### Q: Which capability domains should the first batch cover?
All four: (1) Code build/debug/fix, (2) Memory + distractors, (3) Multi-worker coordination, (4) Data/API investigation.

**Insights:** With 5–8 scenarios and 4 domains, that's 1–2 scenarios per domain spanning easy→hard. The soft dimensions from the brief (instruction-following, communication) aren't separate domains — they weave in as judge-fed dimensions across scenarios (e.g. report quality on the investigation scenario, constraint adherence on the code scenario).

### Q: Per-attempt cost ceiling for the heaviest scenarios?
~$1–2 at the deep end; easy scenarios stay ≤$0.25. Calibration sweep for an 8-scenario batch lands around $30–60.

**Insights:** Enough headroom for multi-worker chains + agentic judges on hard scenarios. Cost ceilings become per-scenario metadata (also feeds the opt-in efficiency dimension's budget).

## Synthesis

### Key Decisions

1. **Tiered grading everywhere** — both deterministic checks and judges become graded, not binary. `CheckResult` gains `score?: number` (omitted → derived from `pass`).
2. **Gates + threshold pass semantics** — checks split into *gates* (binary must-pass: "did the scenario fundamentally happen") and *graded* components. `passed = allGatesPass && score ≥ passThreshold`. Score is always computed and stored, even on gate failure.
3. **Named weighted dimensions** are the composition unit: `score = Σ wᵢ·dimᵢ / Σ wᵢ`. Each dimension is fed by graded deterministic checks OR a judge rubric (llm or agentic). Ladders live *inside* dimensions as ordered subgoal checks.
4. **Fixed core taxonomy + custom**: `correctness`, `completeness`, `efficiency`, `instruction-following`, `communication` aggregate cross-scenario in analytics; custom dimension names allowed, scoped to their scenario.
5. **Efficiency = deterministic, opt-in** — computed from attempt `costUsd`/tokens/duration vs a per-scenario budget; no judge. Weight 0/omitted by default.
6. **Judge cost is a soft constraint** — design driver is signal quality per dimension, not judge spend. Deterministic preferred where more *reliable*, not because cheaper.
7. **Clean-slate catalog** — the existing 7 scenarios are deleted (too easy), mined for machinery (seeding, rosters, relay, exec checks). New batch covers all 4 domains: code build/debug/fix, memory + distractors, multi-worker coordination, data/API investigation.
8. **Agentic judge extension is in scope** — judge gets tools over the full `ctx.workers` roster plus a system-prompt manifest of available workers and their roles (names, templates, lead vs member).
9. **Calibration run gates shipping** — each new scenario × frontier + budget anchor configs × 3 attempts; ship only if anchors separate by ~≥0.2. Spread numbers get recorded as the scenario's baseline.
10. **Cost ceilings**: ≤$0.25/attempt easy, ~$1–2 deep end; ceilings stored as scenario metadata (doubles as the efficiency-dimension budget).

### Proposed OutcomeSpec v2 (sketch)

```ts
interface OutcomeSpec {
  gates?: DeterministicCheck[];        // binary must-pass
  dimensions?: DimensionSpec[];        // weighted, graded
  passThreshold?: number;              // applies to weighted score (configurable per scenario; default 0.75)
  // v1 fields (checks / llmJudge / agenticJudge) normalized internally:
  // checks → gates; llmJudge/agenticJudge → single dimension weight 1
}

interface DimensionSpec {
  name: CoreDimension | (string & {}); // core enum validated, custom allowed
  weight: number;
  checks?: GradedCheck[];              // fn returns CheckResult { pass, score? } (+ optional per-check weight)
  judge?: { rubric: string; model?: string; agentic?: boolean; maxSteps?: number };
}
```

Storage: `judgments` gains nullable `dimension` + `weight` columns (kind stays `'llm' | 'deterministic'`); per-judgment rows are the source of truth for dimension breakdowns (attempt-level rollup deferred — future migration if analytics queries need it). Old rows have NULLs → render exactly as today.

### Grading semantics (review additions)

- **Graded check contract**: a graded check returns `score ∈ [0,1]` (plus optional detail); the stored `pass` is derived (`score ≥ 1` → full credit). Dimension score = weighted average of member check scores (per-check `weight`, default 1).
- **Failure semantics**: a graded check that *throws* scores 0 (counts against the config — its sandbox state caused it). A judge **infra** failure (after the existing agentic→llm fallback) marks the attempt `error` and excludes it from analytics — never silently scored 0, so judge flake can't masquerade as a bad config.
- **Ship-gate formula (calibration)**: frontier anchors = claude (opus), codex (gpt-5-5); budget anchors = pi (haiku, deepseek flash, grok build, gemini 3 flash). Gate: `mean(frontier avg) − mean(budget avg) ≥ 0.2` per scenario, each anchor averaged over 3 attempts; borderline gaps (0.1–0.3) get +2 attempts before the verdict.
- **Core dimension definitions** (keep rubrics consistent cross-scenario): *correctness* = outputs/answers are right; *completeness* = all subgoals/parts addressed; *efficiency* = resource use vs budget; *instruction-following* = constraints and required formats respected; *communication* = clarity, specificity, and citation quality of reports/updates.
- **Non-goal (v2)**: per-dimension pass thresholds — only the global `passThreshold` exists.

### First batch sketch (7 scenarios, easy→hard)

| # | Scenario | Domain | Workers | Grading | Cost/attempt | Expected spread (budget→frontier) |
|---|---|---|---|---|---|---|
| 1 | `sql-audit` — seeded DB ~30 tasks + red herrings; graded questions (count → which → cross-reference anomaly) | Data/API | 1 | correctness: answer-key checks per question; communication: judge on final report | ~$0.15–0.3 | 0.4 → 0.9 |
| 2 | `memory-distractor` — seeded ground-truth memories; prompt embeds plausible-wrong defaults; facts of graded obscurity | Memory | 1 | correctness: per-fact checks; custom `retrieval-fidelity`: agentic judge verifies retrieved-not-guessed | ~$0.15 | 0.3 → 0.85 |
| 3 | `bug-ladder` — seeded repo, 4–5 bugs of graded difficulty (typo → logic → edge case → subtle), each with own test group | Code | 1 | correctness: fraction of test groups green; instruction-following: tests-unmodified check + constraint adherence; efficiency: vs $0.5 budget (first end-to-end exercise of the dimension) | ~$0.3–0.5 | 0.35 → 0.9 |
| 4 | `cross-worker-invent` — worker A invents value (UUID); B, C must obtain via communication, not guessing | Multi-worker | 3 | correctness: per-hop propagation checks; custom `provenance`: agentic judge cross-checks all workers' sandboxes | ~$0.3–0.5 | 0.3 → 0.8 |
| 5 | `relay-pipeline` — graded successor of relay-handoff: chained transforms where each stage's fidelity is independently checkable | Multi-worker | 2–3 | correctness per stage (chained deps = natural partial credit); completeness | ~$0.3 | 0.4 → 0.9 |
| 6 | `plan-implement-review` — lead decomposes 3-task chain: plan → implement → review-with-citations | Multi-worker + Code | lead + 2–3 | correctness: stage subgoals; communication: judge grades review specificity (cites real lines); instruction-following | ~$1–2 | 0.3 → 0.8 |
| 7 | `distributed-audit` (stretch) — investigation sharded across workers, lead merges into one report | Data + Multi-worker | lead + 2 | completeness: shard coverage checks; correctness: merged answer key; communication: judge on report | ~$1 | 0.25 → 0.75 |

Notes: scenarios 4 and 5 overlap deliberately but grade different things — 4 grades *provenance* (value obtained via communication, not guessed), 5 grades *transformation fidelity* along the chain. Deep scenarios (6, 7) need a raised `timeoutMs`.

### Resolved during review (2026-06-13)

- **Deleted scenarios / old attempts**: no tombstones needed — old attempts can simply be deleted; the eval DB is local. Removes the "must keep rendering" constraint for the old catalog's attempts.
- **Judge variance**: simple first — single judge call per dimension; N-sample/median can come later if soft dimensions prove noisy.
- **Dimension breakdown storage**: per-judgment rows only for now (nullable `dimension` + `weight` columns); attempt-level rollup is a future migration if analytics queries need it.
- **`passThreshold`**: configurable per scenario; default **0.75**.
- **Calibration anchor configs**: claude (opus) + codex (gpt-5-5), and pi (haiku, deepseek flash, grok build, gemini 3 flash) — 6 anchors first; opencode and other variants later. Note: 6 anchors × 3 attempts raises sweep cost vs the 2–3-anchor estimate (~$60–180 for the full batch at the deep end).

### Resolved during review — follow-up

- **Anti-gaming**: becomes a design-time checklist applied to **every** new scenario (not just distractor ones): (1) distractors genuinely plausible, (2) ground truth not derivable from the prompt alone, (3) checks not satisfiable by echoing the prompt or guessing, (4) grading criteria not leaked to the worker. The calibration sweep then verifies empirically — a gameable scenario shows up as everyone acing it and fails the ≥0.2 spread gate.

### Constraints Identified

- Eval DB is local/disposable — old attempts for deleted scenarios get purged rather than preserved; new judgment/attempt columns stay nullable so any retained v1 rows render unchanged.
- Scenarios self-contained in E2B sandboxes (seeding machinery: sqlDump, memories, repo fixtures).
- Round 9 (UI/analytics) is in flight — this lands as its own round after; analytics additions (per-dimension views, saturation flags) must layer on round-9 surfaces, not fork them.
- Agentic judge is worker-0-bound today — extension is a prerequisite for scenarios 4, 6, 7.
- `judgments.kind` has a CHECK constraint (`'llm' | 'deterministic'`) — keep kinds stable, add columns instead.

### Core Requirements

1. OutcomeSpec v2: gates + weighted dimensions (checks or judge per dimension), `CheckResult.score`, back-compat normalization of v1 specs.
2. Runner: weighted aggregation, score-on-gate-failure, per-dimension judgment persistence.
3. Agentic judge: full-roster tools + worker-roles manifest in system prompt + access to task records/session transcripts (required by the communication dimensions in scenarios 1, 6, 7).
4. Efficiency dimension: deterministic scoring vs per-scenario budget metadata.
5. Catalog: delete 7 old scenarios and purge their stored attempts (local DB), add the 7-scenario batch above.
6. Analytics: per-dimension breakdown (core taxonomy), attempt score now meaningful as a continuous rank signal.
7. Calibration sweep tooling/recipe + documented per-scenario baseline spreads; ship gate = anchors separate by ~≥0.2. Anchor set: claude (opus), codex (gpt-5-5), pi (haiku / deepseek flash / grok build / gemini 3 flash).
8. Anti-gaming design checklist applied to every scenario (plausible distractors; truth not derivable from prompt; checks not satisfiable by echo/guess; grading criteria not leaked to workers).

## Next Steps

- ~~`/review` critique pass on this document~~ — done 2026-06-13, findings auto-applied (see Review Errata).
- Convert into an implementation round via `/desplega:create-plan` with this brainstorm as input context.

## Review Errata

_Reviewed: 2026-06-13 by Claude (auto-apply mode)_

### Applied

- [x] **Failure semantics were undefined** — specified: graded check throws → score 0; judge infra failure (post-fallback) → attempt `error`, excluded from analytics. (→ Grading semantics)
- [x] **Graded-check `pass`/`score` relationship was undefined** — specified: `score ∈ [0,1]`, stored `pass` derived as `score ≥ 1`; dimension = weighted avg of member checks. (→ Grading semantics)
- [x] **Ship gate was imprecise with 6 anchors** — specified frontier/budget partition and `mean(frontier) − mean(budget) ≥ 0.2` formula, +2 attempts for borderline gaps. (→ Grading semantics)
- [x] **Efficiency dimension wasn't exercised by any batch scenario** — added to `bug-ladder` (vs $0.5 budget). (→ batch table row 3)
- [x] **Communication dimensions need judge access to transcripts/task records**, not just sandbox FS — added to Core Requirement 3.
- [x] **Core dimensions lacked definitions** (rubric drift risk across scenarios) — added one-liners. (→ Grading semantics)
- [x] `passThreshold` inconsistency: code sketch said "~0.6" while the review resolution set 0.75 — aligned to 0.75.
- [x] Storage paragraph contradicted the review resolution (mentioned attempt-level rollup JSON as part of v2) — aligned to per-judgment rows only, rollup deferred.
- [x] Scenario 4 vs 5 overlap justified explicitly; noted raised `timeoutMs` for deep scenarios 6–7. (→ note under batch table)
- [x] Declared explicit v2 non-goal: per-dimension pass thresholds (prevents plan scope creep).
