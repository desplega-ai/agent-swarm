# Round-11 calibration sweep + ship gate

This is the repeatable recipe for calibrating the round-11 OutcomeSpec-v2 scenarios. Each new scenario must
**discriminate** frontier models from budget models: a capable harness should score materially higher than a
cheap one. The ship gate makes that quantitative.

> Calibration is a **real-money E2B sweep** — `bun src/cli.ts run …` spins up cloud sandboxes and bills the
> judge/worker model providers. Run it deliberately, against a **fresh** throwaway `EVALS_DB_PATH` so a re-run
> is clean and the production replica is never touched.

## Ship gate

For each scenario, compute the mean score of the frontier cohort and the mean score of the budget cohort, then
require the spread to clear `0.2`:

```
frontierAvg − budgetAvg ≥ 0.2   →  PASS  (scenario discriminates; keep it)
```

- `frontierAvg` = mean over the **frontier anchors** of (that anchor's mean score across its attempts).
- `budgetAvg`   = mean over the **budget anchors** of (that anchor's mean score across its attempts).

### Borderline rule

A gap in the band `[0.1, 0.3]` is **borderline** — the spread is real but the 3-attempt sample is too noisy to
trust the verdict. Run **+2 attempts per anchor** for that scenario and recompute before deciding. (The lower
edge of the band overlaps a sub-gate gap, the upper edge overlaps a clear pass — both deserve more samples
when they land near the `0.2` line.)

### Anchors (RESOLVED)

| Cohort   | Anchor config id     | Notes |
|----------|----------------------|-------|
| Frontier | `claude-opus-4.8`    | **Pinned** to the explicit 4.8 build (NOT the floating `claude-opus` alias) so the recorded baseline stays reproducible as "latest opus" advances. Record the concrete model id below regardless. |
| Frontier | `codex-5.5`          | codex harness, frontier tier. |
| Budget   | `pi-deepseek-flash`  | deepseek via the pi harness — the pi-side budget anchor. |
| Budget   | `claude-haiku`       | haiku via the claude harness — the claude-side budget anchor. |

Cohort symmetry: **1 pi + 1 claude per tier** (frontier = claude + codex; budget = claude + pi). `pi-grok-build-0.1`
and `pi-gemini-3.5-flash` are **NOT** calibration anchors (they stay in the catalog for full leaderboard sweeps).

## Cost ceilings

| Scenario class | Per-attempt target | Examples |
|----------------|--------------------|----------|
| Easy / cheap   | ≤ $0.25            | `sql-audit`, `memory-distractor`, `relay-pipeline` |
| Code / medium  | ~$0.3 – $0.5       | `bug-ladder` |
| Deep / lead    | ~$1 – $2           | `distributed-audit` |

The **full sweep** = 6 scenarios × 4 anchors × 3 attempts = 72 attempts. Budget roughly **$35 – $100** total
depending on how many deep/lead scenarios run their full attempt count and how many retries fire.

## Efficiency is a waste-guard, not a quality discriminator

The deterministic `efficiency` dimension (`budgetUsd` / `budgetMs`, scored by `efficiencyScore` with linear decay
to 0 at N× budget, N = 3) is **not** the lever that separates frontier from budget models — **correctness depth
is**. Efficiency exists only to penalize *egregious* overspend (a config that loops, retries forever, or burns
10× the cost a sane run needs). It is a floor, not a slope.

Set each scenario's `budgetUsd` to roughly **2–3× a normal frontier run's observed cost**, not to that cost. With
that headroom, any reasonable run — frontier or budget — scores efficiency ≈ 1.0, so the dimension contributes
nothing to the frontier−budget spread and the ship gate is driven entirely by the correctness/completeness
dimensions (where the discrimination is supposed to live). A run only loses efficiency points when it spends
*well past* what the task plausibly needs.

Concretely: `bug-ladder`'s `budgetUsd` was raised **0.5 → 1.5** for exactly this reason. At 0.5 a perfectly good
frontier run was getting docked on efficiency and the cohorts were being separated by *cost*, not by *who actually
fixed the bugs* — which inverts the intended signal. The 1.5 budget restores efficiency to its waste-guard role
and lets correctness depth do the discriminating.

> Rule of thumb when authoring a new scenario: take the frontier smoke run's cost, multiply by ~2.5, and use that
> as `budgetUsd`. If you find yourself tuning the budget to *create* a spread, stop — tighten the graded subgoals
> instead.

## Running the sweep

Use a **fresh** local DB so each calibration round starts from a clean schema (the v2 nullable-column ALTERs
apply at boot) and a re-run is reproducible. A bare local path is wrapped as `file:` by `db/client.ts`, so no
Turso sync URL / auth token is needed:

```bash
export EVALS_DB_PATH=/tmp/evals-round11.sqlite   # new file; the production replica is untouched
```

Required env: `E2B_API_KEY`, `OPENROUTER_API_KEY` (judge + pi workers), `CLAUDE_CODE_OAUTH_TOKEN` (claude
workers), `OPENAI_API_KEY` (codex workers).

### 1. Per-scenario smoke (cheap, 1 attempt) — do this first

Confirm each new scenario boots, seeds, grades, and produces a **non-saturated** score on at least one frontier
+ one budget anchor before committing to the full sweep:

```bash
cd evals && bun src/cli.ts run \
  --name "cal-smoke" \
  --scenarios sql-audit \
  --configs claude-opus-4.8,pi-deepseek-flash \
  --attempts 1 --concurrency 2
```

### 2. Full calibration sweep — 6 scenarios × 4 anchors × 3 attempts

Run all at once, or per scenario (so one scenario's failure doesn't abort the batch):

```bash
cd evals && bun src/cli.ts run \
  --name "round11-calibration" \
  --scenarios sql-audit,memory-distractor,bug-ladder,relay-pipeline,distributed-audit,delegation-probe \
  --configs claude-opus-4.8,codex-5.5,pi-deepseek-flash,claude-haiku \
  --attempts 3 --concurrency 4 --max-retries 1
```

If a run is interrupted, resume it (safe — leaves finished attempts intact):

```bash
cd evals && bun src/cli.ts resume <runId>
```

### 3. Inspect + apply the gate

```bash
cd evals && bun src/cli.ts show <runId>          # ASCII score matrix
cd evals && bun src/cli.ts serve --port 4801     # SPA → RunDetails per-dimension breakdown; AnalyticsPage selector
```

Compute the gate. The report helper does the frontier/budget means and `≥ 0.2` PASS/FAIL per scenario for you:

```bash
cd evals && bun scripts/calibration-report.ts <runId>
```

If you'd rather compute by hand, read `bun src/cli.ts show <runId>` and apply the formula above — the gate is
**not** blocked on the helper.

### 4. Record + decide

Record each scenario's calibrated spread (frontierAvg, budgetAvg, gap) AND the pinned frontier model
(`claude-opus-4.8`) in:

1. the scenario file's header comment, and
2. the results table below.

A scenario **ships** only if it clears the `≥ 0.2` gate. Sub-gate scenarios get reworked (stronger
distractors / harder graded subgoals / red herrings) and re-swept. Borderline scenarios (gap `0.1 – 0.3`) get
+2 attempts per anchor before the verdict.

## Recorded baselines

Pinned frontier model: `claude-opus-4.8`. Fill in after the full calibration sweep.

| Scenario               | frontierAvg | budgetAvg | gap | verdict (PASS / FAIL / BORDERLINE) | runId |
|------------------------|-------------|-----------|-----|-------------------------------------|-------|
| `sql-audit`            |             |           |     |                                     |       |
| `memory-distractor`    |             |           |     |                                     |       |
| `bug-ladder`           |             |           |     |                                     |       |
| `relay-pipeline`       |             |           |     |                                     |       |
| `distributed-audit`    |             |           |     |                                     |       |
| `delegation-probe`     |             |           |     |                                     |       |

## Budget-tier reference baselines (2026-06-30)

First recorded baselines from two bounded runs on the deployed evals service (`evals.agent-swarm.dev`).
These are **budget-tier configs only** — frontier anchors (`claude-opus-4.8`, `codex-5.5`) have not been
run yet, so the full ship-gate table above remains unfilled. These numbers establish the budget floor.

### Run: `run-202606301420-392be1` (baseline-sweep-bounded-v1)

Date: 2026-06-30. Matrix: 2 scenarios × 4 configs × 1 attempt = 8 cells. Judge: default (deepseek-v4-pro).

| Scenario    | Config                 | Score | Passed | Correctness | Cost (USD) | Duration (s) |
|-------------|------------------------|-------|--------|-------------|------------|--------------|
| `sql-audit` | `claude-haiku`         | 0.50  | no     | 0.33        | $0.131     | 241          |
| `sql-audit` | `pi-deepseek-flash`    | 1.00  | yes    | 1.00        | $0.008     | 126          |
| `sql-audit` | `pi-grok-build-0.1`    | 0.50  | no     | 0.33        | $0.120     | 227          |
| `sql-audit` | `opencode-gemini-flash` | 0.50  | no     | 0.33        | $0.068     | 212          |
| `bug-ladder` | `claude-haiku`         | 1.00  | yes    | 1.00        | $0.214     | 254          |
| `bug-ladder` | `pi-deepseek-flash`    | 1.00  | yes    | 1.00        | $0.009     | 112          |
| `bug-ladder` | `pi-grok-build-0.1`    | 1.00  | yes    | 1.00        | $0.229     | 137          |
| `bug-ladder` | `opencode-gemini-flash` | 1.00  | yes    | 1.00        | $0.138     | 191          |

**Totals:** $0.917 harness + $0.055 judge = **$0.972** total. 5/8 cells passed.

### Reference run: `run-202606301401-afe8ab`

Date: 2026-06-30 (earlier same day). Matrix: sql-audit × 4 configs × 1 attempt = 4 cells.

| Scenario    | Config                 | Score | Passed | Cost (USD) | Duration (s) |
|-------------|------------------------|-------|--------|------------|--------------|
| `sql-audit` | `claude-haiku`         | 0.50  | no     | $0.129     | 219          |
| `sql-audit` | `pi-deepseek-flash`    | 0.50  | no     | $0.007     | 148          |
| `sql-audit` | `pi-grok-build-0.1`    | 0.50  | no     | $0.116     | 111          |
| `sql-audit` | `opencode-gemini-flash` | 0.50  | no     | $0.043     | 157          |

**Totals:** $0.296 harness + $0.035 judge = **$0.331** total. 0/4 cells passed.

### Observations

1. **`bug-ladder` is saturated at n=1 for budget configs.** All 4 budget-tier configs score 1.0 — the scenario
   does not discriminate within the budget tier. It may still discriminate frontier vs budget if frontier
   achieves higher correctness depth, but at 1 attempt the floor is already at 1.0.

2. **`sql-audit` shows run-to-run variance.** `pi-deepseek-flash` scored 1.0 in `run-392be1` but 0.5 in
   `run-afe8ab`. The correctness dimension (weight 3) drives the score: 3/3 findings vs 1/3 findings.
   With n=1 the noise is too high to rank budget configs reliably.

3. **Cost efficiency varies 10–30×.** `pi-deepseek-flash` costs ~$0.008/attempt while `pi-grok-build-0.1`
   costs ~$0.12 and `claude-haiku` ~$0.13. For weekly monitoring, the cheapest config per tier is the
   pragmatic choice.

4. **Communication and gates are universally passed.** All attempts pass the binary gates and the
   communication dimension — the discrimination signal lives entirely in the correctness dimension.

### Recommended next step

Run the **full calibration sweep** (6 scenarios × 4 anchors × 3 attempts = 72 cells) to fill the ship-gate
table above. Estimated cost: **$35–100** depending on deep-scenario retry rates. This requires frontier
anchors (`claude-opus-4.8`, `codex-5.5`) and at least n=3 attempts to reduce the variance observed in
`sql-audit`. See the "Running the sweep" section above for the exact CLI command.

## Metrics we can share

The harness computes these metrics deterministically. LLMs are used **only** for judging individual
dimensions (correctness, communication) — aggregation, scoring, and the ship-gate verdict are pure math.

### Per-scenario metrics (shareable as-is)

| Metric | Formula | What it measures |
|--------|---------|------------------|
| **Pass rate** | `passed / finished` | Fraction of attempts that pass (score ≥ 0.75 AND all gates) |
| **Mean score** | `Σ scores / n` | Average weighted-dimension score across attempts (0–1) |
| **Score CI (95%)** | Bootstrap percentile, 2000 iters, seed 0xC0FFEE | Confidence interval — tightens ~1/√n |
| **Pass-rate CI** | Wilson score interval (z=1.96) | Well-behaved at 0/n and n/n |
| **Avg cost (USD)** | `Σ costUsd / n` | Mean harness cost per attempt |
| **Avg duration (s)** | `Σ durationMs / n / 1000` | Mean wall-clock time per attempt |

### Cross-tier metrics (shareable after full calibration)

| Metric | Formula | What it measures |
|--------|---------|------------------|
| **Frontier avg** | Mean score over frontier anchors | How well the best models do |
| **Budget avg** | Mean score over budget anchors | How well cheap models do |
| **Gap** | `frontierAvg − budgetAvg` | Discrimination power of the scenario |
| **Gap CI** | Bootstrap CI of difference of cohort means | Statistical significance |
| **Ship-gate** | gap ≥ 0.2 → PASS, < 0.1 → FAIL, else BORDERLINE | Should this scenario stay in the suite? |

### Per-model analytics (dashboard-ready)

| Metric | Scope | Description |
|--------|-------|-------------|
| **Model pass rate** | Cross-scenario | Overall pass rate across all scenarios |
| **Model avg score** | Cross-scenario | Mean score across all scenarios |
| **Cost per minute** | Per-model | `avgCostUsd / (avgDurationMs / 60000)` |
| **Accuracy vs efficiency scatter** | Per-model | Leaderboard chart: passRate vs avgTotalTokens |

## Swarm-mechanics scenarios — finding (2026-06-14, ACCEPTED) → PRUNED (2026-06-17, Plan A)

`memory-coordination`, `failure-recovery`, `failure-recovery-mixed` were built to test whether a harness+model is a
good **swarm participant** (shared memory, coordination, failure recovery) rather than a smart single model. The
`seed.workerFailures` failure-injection primitive works end-to-end (poisons a chosen worker at seed time, best-effort)
and is **retained as a framework primitive** even though no shipped scenario currently exercises it.

**Result: these scenarios did NOT discriminate model tiers at our measurement resolution.** Clean sweeps (opus-4.8 /
deepseek-flash / haiku):

| Scenario | opus | deepseek | haiku | gap | note |
|---|---|---|---|---|---|
| `memory-coordination` (hardened, 12 facts) | 1.00 | 1.00 | 1.00 | 0.00 | all tiers ace it even after hardening |
| `failure-recovery` (3 attempts) | 0.60 | 0.72 | 0.60 | −0.06 | recovery judge: opus 0.47 / ds 0.63 / hk 0.47, high variance |

**Why (the actual finding):** (a) the swarm **scaffolding equalizes tiers** on coordination/memory/recovery — the harness
carries the work; and/or (b) the **single-call agentic judge is too noisy** (per-attempt variance 0.40–0.90) to detect a
gap. All tiers recover a poisoned value ~equally and the judge mostly returns ~0.50. A round-3 reading of "opus 0.90 vs
budget 0.50" was a single lucky attempt and did **not** replicate at n=3; the 3× reweight it motivated was **reverted**.

**Pruned in the swarm-redesign cleanup (Plan A, 2026-06-17):** `memory-coordination`, `failure-recovery`, and
`failure-recovery-mixed` (along with `cross-worker-invent`) were the audit's clearly-measured non-discriminators and have
been **removed from the catalog**. If swarm-mechanics coverage is revisited, the levers are: N-sample median judging
(beat the noise), a tighter *deterministic* detection check (replace the soft judge), or genuinely harder failures
(mid-task worker KILL, simultaneous/cascading failures) — see the QA report Round-4 section. The `seed.workerFailures`
primitive (runner + types) is preserved for that future work.
