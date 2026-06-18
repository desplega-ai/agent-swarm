---
date: 2026-06-16
author: Claude (orchestrator)
topic: "Phase 4 de-risk pilot — delegation-probe 2-tier E2B sweep"
run_id: run-202606161340-0b26da
status: complete — GO after fix. Pilot-1 (run-…0b26da) NO-GO (delegation 0.50 constant); N2/N4 fixed; Pilot-2 (run-…da82ac) GO — delegation gap 0.60, significant at n=5
related:
  - thoughts/taras/plans/2026-06-16-evals-swarm-redesign-plan-a.md
  - thoughts/taras/research/2026-06-16-delegation-probe-050-rootcause.md
tags: [evals, delegation, pilot, de-risk, discrimination, no-go]
---

# Phase 4 de-risk pilot — `delegation-probe` (HARD GATE result)

> ## UPDATE 2026-06-16 — Re-pilot after N2/N4 fix → **GO**
>
> The N2/N4 penalty bug (below) was fixed (`fix(evals): delegation-probe N2/N4 penalties no longer crush to 0.50`, PR #775). Re-pilot `run-202606161445-da82ac`, same 2-tier n=5, **$3.89**, 10/10 finished, no harness errors:
>
> ```
> delegation-probe   ✓ 1.00 ±0.00 · 100%      ✗ 0.57 ±0.11 · 0%
> 5/10 passed · 1/2 cells passed
> ```
>
> | config | delegation (mean) | correctness | total | pass |
> |---|---|---|---|---|
> | claude-opus-4.8 | **1.00** (1,1,1,1,1) | 1.00 | 1.00 ×5 | **5/5** |
> | pi-deepseek-flash | **0.40** (0, .5, .5, .5, .5) | 1.00 | .29/.64×4 | 0/5 |
>
> - **Delegation-dimension gap = 1.00 − 0.40 = 0.60** (was 0.00). claude uniformly 1.0; pi ranges 0.0–0.5 → the diff CI excludes 0 with wide margin → **significant at n=5**. Total-score gap 0.43, well over the 0.2 ship gate, and now driven by the *delegation* axis, not correctness.
> - **correctness saturated** (both tiers 1.00) — the intended outcome: both models *can* audit, so discrimination correctly falls to *delegation behavior*. This is exactly the reframe the redesign set out to achieve.
> - pi shows the designed dynamic range: 0.00 (worst — solo/zeroed by N1, or no clean children), 0.50 (delegated but also self-audited → N2/N4). claude delegates cleanly → 1.0.
> - Phase-3 metric validated on real data: ✓ for claude (CI ≥ 0.75), ✗ for pi (CI < 0.75).
>
> **Verdict: GO for Plan B.** Caveat: claude sits at the 1.0 ceiling — with only 2 tiers we can't see gradation *above* a clean delegator. The deployed-swarm "delegation-quality" design task (finer positive grading) is the right follow-up to add headroom for mid-tier configs; it is a refinement, not a blocker.
>
> ---
>
> ## UPDATE 2026-06-16 — Pilot-3 (+Q1+Q4 quality checks)
>
> Added two deterministic quality positives (swarm proposal, PR #775): **Q1** task-count discipline (w1), **Q4** facts-flow-through-workers (w2), folded into the composite check (positiveTotal P1-P4=8 + Q1,Q4=3 = 11), guarded on P1. Pilot-3 `run-202606162038-a48639`, n=5, **$3.93**.
>
> ```
> delegation-probe   ~ 0.84 ±0.22 · 80%      ✗ 0.63 ±0.02 · 0%
> 4/10 passed · 1/2 cells passed
> ```
>
> | config | delegation per-attempt | notes |
> |---|---|---|
> | claude-opus-4.8 | 1.00, 1.00, 1.00, **0.82**, **0.45** | spread appeared — quality layer grades |
> | pi-deepseek-flash | 0.50 ×5 | full positives, −N2−N4 (db-query self-audit) |
>
> **Artifact investigation verdict — the gradation is REAL, not a Q4 artifact:**
> - **Q4 has NO false-negatives** on this dataset — it scored 1.0 wherever a report existed; the answer-key regexes matched every worker-reported fact. Do NOT loosen Q4. Q1/Q4 need NOT be split into a separate dimension; they behaved correctly.
> - **claude #3 (0.82):** perfect delegation (2 children completed, Q1=1, Q4=1, no penalties) but **P3=0 — no follow-up task was emitted** (`9/11=0.82`). The other 3 perfect runs each got 2 follow-ups; #3 got 0. Likely a **swarm follow-up-dispatcher flake** (3 fast attempts scored within ~4s) — i.e. P3 may be measuring the dispatcher, not the model.
> - **claude #4 (0.45):** genuinely botched — workers stuck `in_progress`, no report written (correctness 0.00). Real failure, correctly scored (`5/11`).
> - **pi 0.50 ×5:** delegates faithfully (11/11 positives) but the lead also runs `db-query` to audit the seeded history itself → **N2 −0.25 + N4 −0.25**. Exactly the anti-gaming behavior the penalties target. Legit.
>
> **The one open item: P3 (follow-up-received) validity.** The follow-up is a SYSTEM emission (created when a worker completes), not a lead behavior the model controls. If emission is timing/load-dependent, P3 penalizes infra, not delegation quality. Harden / reconsider P3 before trusting it as a tier discriminator. (Root-cause of the #3 non-emission under investigation.)
>
> **Net:** delegation-probe discriminates and the quality layer is sound. Q1/Q4 confirmed as real signal. Total spend across 3 pilots ~$12.
>
> ---
>
> ## UPDATE 2026-06-17 — Pilot-4 (P3 dropped, Q4→w4): rubric is now VALID
>
> Dropped the brittle P3 (follow-up-received) check — it penalized a lead that legitimately disabled redundant system follow-ups (`followUpConfig.disabled`) even on a perfect run. Folded its weight into Q4 (2→4). Pilot-4 `run-202606162212-36304f`, n=5, **$4.33**.
>
> ```
> delegation-probe   ~ 0.86 ±0.20 · 80%      ✗ 0.57 ±0.11 · 0%
> 4/10 passed · 1/2 cells passed
> ```
>
> | config | per-attempt delegation | note |
> |---|---|---|
> | claude-opus-4.8 | **1.00, 1.00, 1.00, 1.00, 0.45** | 4 clean perfects; #1 is a real botch (correctness 0.00, no valid report) |
> | pi-deepseek-flash | 0.50, 0.50, 0.50, **0.00**, 0.50 | delegates-but-self-audits (−N2−N4); #3 worse |
>
> - **The P3 fix worked**: the spurious pilot-3 0.82 is gone — every faithful claude run scores a clean **1.0**. The only low claude score is a genuine task failure, correctly scored. The rubric no longer introduces variance — remaining variance is REAL behavior.
> - **Q4-at-36% did NOT misfire**: all faithful claude runs hit Q4=1.0; no phrasing false-negative.
> - claude delegation mean ≈ 0.89 (4×1.0 + 1×0.45), pi ≈ 0.40. The cell reads "~" only because of the one *real* claude botch widening the CI at n=5 — honest, not noise. Higher n would tighten it around claude's true ~80% completion rate on this scenario.
>
> ### Final rubric (delegation dimension, weight 5; single composite check)
> Positives (total 11): P1 children-created (3), P2 children-completed (2), P4 workers-have-sessions (1), Q1 task-count-discipline (1), **Q4 facts-flow-through-workers (4)**. Penalties: N1 solo-research → hard-zero; N2 self-audit (db-query/Bash) −0.25; N3 delegation-loop −0.5; N4 re-research-after-delegating −0.25. Correctness dimension (weight 2) = answer-key regexes. Aggregate (5·deleg + 2·corr)/7, threshold 0.75.
>
> **delegation-probe is DONE and validated** across 4 real-E2B pilots (~$16): it discriminates frontier (claude, ~0.89 delegation / 80% pass) from budget (pi, ~0.40 / 0% pass) on the *behavioral* axis, with correctness saturated. Quality checks (Q1/Q4) confirmed as real signal; the two brittleness bugs (N2/N4 Write, P3 follow-up) found and fixed by the de-risk loop.
>
> ---
> Original Pilot-1 finding (NO-GO, pre-fix) preserved below.


## What ran

```
cd evals && EVALS_DB_PATH=/tmp/evals-pilot.sqlite EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN='' \
  bun src/cli.ts run --scenarios delegation-probe \
  --configs claude-opus-4.8,pi-deepseek-flash --attempts 5 --judge-model deepseek/deepseek-v4-pro
```

- Run `run-202606161340-0b26da` — 1 scenario × 2 configs × 5 attempts = **10 attempts**, concurrency 2, fresh local DB per attempt.
- **10/10 finished, 0 harness errors** (no `waiting_for_credentials`, all sandboxes booted, 1 MB seed imported ~3s each).
- **Total cost: $4.20** (claude ≈ $0.56–$0.86/attempt; pi ≈ $0.07–$0.10/attempt).
- delegation-probe is judge-free → the `--judge-model` is inert here.

## Headline (Phase-3 metric, rendered against a REAL run DB)

```
run-202606161340-0b26da [done] mean±CI @n=5
delegation-probe   ✗ 0.64 ±0.00 · 0%    ✗ 0.56 ±0.09 · 0%
legend: «mean ±halfCI · pass-rate» · ✓ CI≥0.75 · ~ CI straddles · ✗ CI<0.75
0/2 cells passed · 10/10 attempts finished · $4.1981 total
```

(This also satisfies the Phase-3 "render mean±CI against a real run" QA — it was only done synthetically before, no prior run DB existed.)

## Per-attempt, per-dimension breakdown

Aggregate = `(5·delegation + 2·correctness)/7`, pass threshold 0.75.

| config | attempt | delegation (w5) | correctness (w2) | total | gates |
|---|---|---|---|---|---|
| claude-opus-4.8 | 0 | **0.50** | 1.00 | 0.643 | both pass |
| claude-opus-4.8 | 1 | **0.50** | 1.00 | 0.643 | both pass |
| claude-opus-4.8 | 2 | **0.50** | 1.00 | 0.643 | both pass |
| claude-opus-4.8 | 3 | **0.50** | 1.00 | 0.643 | both pass |
| claude-opus-4.8 | 4 | **0.50** | 1.00 | 0.643 | both pass |
| pi-deepseek-flash | 0 | **0.50** | 1.00 | 0.643 | both pass |
| pi-deepseek-flash | 1 | **0.50** | 0.75 | 0.571 | both pass |
| pi-deepseek-flash | 2 | **0.50** | 1.00 | 0.643 | both pass |
| pi-deepseek-flash | 3 | **0.50** | 0.00 | 0.357 | report-exists FAIL (no report) |
| pi-deepseek-flash | 4 | **0.50** | 0.75 | 0.571 | both pass |

## The critical finding

**The `delegation` dimension scored EXACTLY 0.50 on all 10 attempts — both tiers, every attempt.**

- **Delegation gap (frontier − budget): 0.00.** The CI is `[0, 0]` → **not significant**. The axis the scenario exists to measure produced **zero discrimination**.
- All total-score separation comes from **correctness** (claude 1.00 ×5 → mean 1.00; pi mean 0.70). Correctness gap ≈ 0.30 — but correctness is the seeded-answer-key audit, i.e. exactly the **saturating single-model-quality signal the redesign set out to move away from**.
- Total-score gap 0.643 − 0.557 = **0.086**, below the 0.2 ship gate, and driven by the wrong dimension.
- **0.50 is also a ceiling**: with delegation pinned at 0.50, the max achievable total is `(5·0.5 + 2·1.0)/7 = 0.643` — so **no config can ever pass** the 0.75 threshold regardless of behavior. Hence 0/10 passed.

### Why this is a bug, not parity

claude-opus-4.8 **demonstrably delegated**: its workers audited the seeded 20-task history and reported real figures that the lead merged into a correct report (correctness = 1.00 on all 5). A genuinely-delegating frontier model scoring the *same* 0.50 as the budget anchor means the rubric is **under-crediting real delegation** — a measurement bug, not a behavioral tie. A perfectly uniform 0.50 = 4/8 of the positive weight across 10 independent attempts is the signature of a constant, data-blind result.

Root-cause analysis (which sub-checks P1–P4/N1–N4 fire, and whether the runtime-spawned child/follow-up tasks were actually captured by the Phase-1 enumeration against the real API) is in `thoughts/taras/research/2026-06-16-delegation-probe-050-rootcause.md`. The per-attempt `task` + `raw-session-logs` artifacts are preserved in `/tmp/evals-pilot.sqlite` (`artifacts` table).

## Verdict — HARD GATE

**NO-GO on authoring Plan B as planned.** Per the plan's Phase-4 decision rule, this is case (b): the scenario does not discriminate on its core axis. Plan B (tool-use / resource-efficiency) is built on the same delegation paper-trail + the Phase-1 enumeration, so building it now would inherit whatever pins delegation at 0.50.

**Recommended sequence before Plan B:**
1. Fix the delegation rubric / enumeration so the dimension reflects real delegation (root-cause doc has the specifics).
2. Re-pilot `delegation-probe` (same 2-tier n=5) and confirm the **delegation-dimension** gap (not total) is positive and its CI excludes 0.
3. Only then author Plan B.

## What the pilot positively de-risked

- Harness path is solid: delegation-probe boots, seeds, runs lead+2 workers on real E2B, and scores deterministically with **no harness errors** at n=5 for ~$4.
- The Phase-3 convergent metric renders correctly on real data (mean±CI · pass-rate · ✓/~/✗), and the `±0.00` CI on claude's 5 identical scores is exactly the "tight band = high confidence" behavior intended — here it tightly confirms a *broken-constant* signal, which is the metric doing its job.
- The fixture + gates + correctness dimension work end-to-end (correctness discriminated pi's attempts: 0.00–1.00).
