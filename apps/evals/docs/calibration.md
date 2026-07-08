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

Pinned frontier model: `claude-opus-4.8`. Fill in after the sweep.

| Scenario               | frontierAvg | budgetAvg | gap | verdict (PASS / FAIL / BORDERLINE) | runId |
|------------------------|-------------|-----------|-----|-------------------------------------|-------|
| `sql-audit`            |             |           |     |                                     |       |
| `memory-distractor`    |             |           |     |                                     |       |
| `bug-ladder`           |             |           |     |                                     |       |
| `relay-pipeline`       |             |           |     |                                     |       |
| `distributed-audit`    |             |           |     |                                     |       |
| `delegation-probe`     |             |           |     |                                     |       |

## v9 orchestration-substrate catalog — `delegation-chain` N-bump reading (2026-07-08)

`delegation-chain` (v9 catalog, `scenarios/delegation-chain.ts`) is a *different* scenario set from the
round-11 six above and was never run through the frontier/budget ship gate. It carries its own open
question, closed here.

### The verdict, leading (not raw pass-rate)

**`claude-haiku` × `delegation-chain` at N=10 is ✗ — confidently BELOW the 0.75 pass threshold, not
small-N noise.** `scoreCI = [0.03, 0.23]` sits entirely under the bar; `passRateCI = [0, 0.28]` does too.
The scenario is doing its job (correctly failing a budget-tier config on a task designed to discriminate
frontier from budget), not miscalibrated.

### What the original "0.74 mean / 0-of-2 pass" reading actually was

The number quoted in the brief traces to `run-202606302342-e283fd` (the 2026-06-30 overnight sweep that
got orphaned by an E2B sandbox-expiry / server-restart race — fixed by PR #871, "recover orphaned runs on
restart"). Its `delegation-chain × claude-haiku` cell shows
`attempts: 2, finished: 1` — **only one of the two attempts ever ran**; the other never got a slot before
the run died. That lone finished attempt scored `0.7381` (`scoreCI = [0.7381, 0.7381]`, degenerate — a
single point can't bound itself). "0.74 mean" was **N=1**, not N=2, and the "0-of-2 pass" framing implied
two comparable samples where there was really one.

### The N=10 re-run (this task)

Re-ran `delegation-chain × claude-haiku` at N=10 via the deployed evals API
(`run-202607081443-76fc91`, `attemptsPerCell: 10, concurrency: 3`, ~$2.33 total E2B/model spend):

| Metric | Value |
|---|---|
| N | 10 (10/10 finished, 0 errors) |
| meanScore | 0.114 |
| scoreCI (bootstrap, 95%) | [0.029, 0.229] |
| passRate | 0/10 (0%) |
| passRateCI (Wilson, 95%) | [0, 0.278] |
| passThreshold | 0.75 (`DEFAULT_PASS_THRESHOLD`, unmodified by the scenario) |
| **CI-aware indicator** | **✗** (`scoreCI.hi = 0.229 < 0.75`) |

The true convergent mean (~0.11) is far below the single lucky N=1 draw (0.74) that originally raised the
"is 0.75 miscalibrated?" question. At N=10 the picture flips: **the 0.74 reading was itself the noise** —
an outlier high sample from a one-shot orphaned run — not evidence that the threshold is unfair. With 10x
the sample, `claude-haiku` fails this scenario hard and consistently (9 of 10 attempts scored ≤ 0.19; one
outlier attempt hit 0.57, still nowhere near 0.75).

**Conclusion: no threshold change needed.** `delegation-chain`'s 0.75 bar is not miscalibrated for the
budget cohort — it's discriminating exactly as a v9 orchestration-substrate scenario should.

### Known gap, not fixed here (small follow-up)

`src/cli.ts`'s `show`/`formatShowCell` **already** leads with the CI-aware ✓/~/✗ mark (see
`formatShowCell`, `apps/evals/src/cli.ts`) — that surface is fine. The gap is in
**`src/api/analytics.ts`**, which backs the public landing-page analytics + `AnalyticsPage.tsx`: every
rollup (`finishGroup`, per-model, per-scenario, leaderboard) computes only a raw `passRate = ratio(passed,
graded)` with **no `scoreCI`/Wilson interval at all**. That's the "canonical baseline" surface a human or
this doc's own prior guidance would reach for first, and it can still produce exactly this kind of
misleading single-N read. Adding bootstrap/Wilson CI to the analytics rollups is real work (five call
sites, plus a UI change to render the indicator) — flagging as a follow-up rather than doing it inline
here.

### Follow-up: frontier anchors still unread at meaningful N

The same orphaned run left `claude-sonnet-5` (mean 0.595, N=1), `claude-opus-4.8` (mean 0, N=1), and
`codex-5.4-mini` (mean 0.357, N=2) similarly under-sampled for `delegation-chain`. If a full frontier-vs-
budget spread is wanted for this scenario (the round-11-style `≥0.2` gate), those need their own N≥8 sweep
too — scoped out here since the brief's specific question was about the `claude-haiku` "0.74" reading.

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
