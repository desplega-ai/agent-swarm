---
date: 2026-06-17
topic: "Eval scenarios audit — KEEP / KILL / KEEP-AS-BENCHMARK"
tags: [evals, scenarios, discrimination, calibration, cost-benchmark, swarm-mechanics]
branch: evals/swarm-redesign-plan-a
status: research (read-only; design-level recommendation — needs a confirming sweep before pruning)
---

# Eval scenarios audit — KEEP / KILL / KEEP-AS-BENCHMARK

## Goal

Audit the 11 registered eval scenarios and recommend KEEP / KILL / KEEP-AS-BENCHMARK.
Taras's framing: it is fine to retain some "easy" scenarios where every config scores ~1.00
**specifically to compare price and speed** across model configs when quality is tied — but
prune scenarios that are redundant, flaky, expensive, or non-discriminating *without* that
benchmark value.

A GOOD scenario either:
- **discriminates on QUALITY** — dimension scores vary by tier (the `delegation-probe` model), OR
- **passes everywhere but discriminates on COST/SPEED** — all configs ~1.00, but tokens/$/latency
  differ, so it is a clean apples-to-apples price/speed benchmark (the `efficiency` dimension +
  per-attempt cost/time make this measurable).

A scenario is KILL when it saturates on quality AND has no benchmark value (redundant with a cheaper
benchmark, expensive multi-worker, flaky, or leans on the noisy agentic judge).

## Evidence base (what's design vs what's measured)

- **Measured** (real E2B sweeps, committed): the round-11 calibration sweep
  (`run-202606132111-9c9013` cheap-4 + `run-202606132125-292247` lead-2, **1 attempt/cell** — noisy)
  in `thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md`, plus the swarm-mechanics
  finding (n=3) in `evals/docs/calibration.md`, plus the `delegation-probe` pilot (n=5,
  `run-202606161445-da82ac`) in `thoughts/taras/qa/2026-06-16-delegation-probe-pilot.md`.
- **Design-only** (NO committed multi-attempt run data): `relay-pipeline` was **never swept**;
  `memory-distractor` / `cross-worker-invent` only have the single-attempt cheap-4 sweep.
- Flagged inline below as **[MEASURED]** or **[DESIGN-ONLY]** so Taras can decide what needs a
  confirming sweep before pruning.

Hard rule before acting: the round-11 cheap-4 table is **1 attempt per cell**. Saturation
(everyone at 1.00) is reliable signal; a single sub-gate number is not. Re-confirm any KILL that
rests on a single attempt with n≥3 before deleting.

## The scenario set (11 registered)

Registry: `evals/scenarios/index.ts`. Roster sizes from the harness audit
(`thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md` Part 5). Cost tiers from
`evals/docs/calibration.md` "Cost ceilings" (1 sandbox for the API + 1 per roster member, so cost
scales with workers + lead).

| # | scenario | tests what | dims (weight) — det/judge | workers | cost/speed | discriminates? | verdict | rationale |
|---|---|---|---|---|---|---|---|---|
| 1 | `sql-audit` | seeded SQL dump → 1-worker DB audit; graded answer-key | correctness(3 det) + communication(1 **judge**) | 1 | **cheap** ≤$0.25, fast | **YES — quality** [MEASURED]: opus/ds 1.00, haiku **0.49**, gap **+0.256** | **KEEP** | Only cheap single-worker scenario that clears the 0.2 gate. Discriminates because graded correctness catches haiku's DB-reasoning errors. Designated smoke (`DEFAULT_SCENARIO_IDS`). |
| 2 | `memory-distractor` | 1-worker 7-fact recall vs distractors; `score=matched/7` | correctness(3 det) + retrieval-fidelity(1 **judge**) | 1 | **cheap** ≤$0.25, fast | **NO** [MEASURED, 1-attempt]: opus/ds/haiku all 1.00, gap **0.000** | **KEEP-AS-BENCHMARK** | Saturates on quality (all tiers ace deterministic recall), but it is the cheapest pure **memory-recall** probe and needs the embedding key — keep as a $/speed benchmark for the memory path + retrieval smoke. Demote the weight-1 judge dim or make it deterministic (it adds cost/noise without moving the aggregate). |
| 3 | `bug-ladder` | 1-worker, 7 planted bugs scored by test execution + budget | correctness(3 det) + instruction-following(1 det) + efficiency(1 det) | 1 | **medium** ~$0.3–0.5 | **NO / inverted** [MEASURED, 1-attempt]: opus 0.93, ds 1.00, haiku 1.00, gap **−0.065** (efficiency penalized opus's higher spend) | **KEEP-AS-BENCHMARK** | Fully deterministic (test execution, no judge) → clean, reproducible. Doesn't discriminate quality (budget models fix the bugs too) but the `efficiency` dim + real cost make it a legitimate **$/speed code-task benchmark**. The "inversion" is the efficiency dim doing its job (frontier spent more for the same fixes) — that IS the price signal. Keep, but stop treating its aggregate as a quality gate. |
| 4 | `cross-worker-invent` | 3 workers; UUID propagation + derivations recomputed at grade time | correctness(3 det) + provenance(1 **judge**) | 3 | **medium-expensive** (3 sandboxes) | **NO** [MEASURED, 1-attempt]: opus/ds/haiku all 1.00, gap **0.000** | **KILL** | Saturates on quality AND is expensive (3 workers). The deterministic UUID-propagation correctness is trivially passed by all tiers; the provenance judge is weight-1 and can't move the aggregate. No price-benchmark edge over the cheaper single-worker scenarios. Cross-worker memory handoff is better covered by `relay-pipeline` (cheaper structurally) or folded into `delegation-probe`. |
| 5 | `relay-pipeline` | 3 workers; strict A→B→C transform chain via shared memory | correctness(3 det) + completeness(1 det) | 3 | **cheap-ish but 3 sandboxes** | **UNKNOWN** [DESIGN-ONLY — never swept] | **KILL (pending one confirming sweep)** | Fully deterministic A→B→C chain; by the round-11 pattern ("discriminates iff graded correctness catches budget errors") a strict transform relay is exactly the kind of task budget models pass → expect saturation. Never measured. Recommend: run it once at n≥3; if it saturates (likely), KILL — the cross-worker handoff axis it tests is redundant with `delegation-probe`/`distributed-audit`. Don't keep as a benchmark: 3 workers makes it a costly way to measure $/speed vs the 1-worker benchmarks. |
| 6 | `plan-implement-review` | lead + 2 workers; plan→implement→review with citations | correctness(3 det) + citation-validity(1 det) + communication(1 **judge**) + instruction-following(1 det) | lead+2 | **deep** ~$1–2, slow | **NO** [MEASURED, 1-attempt]: opus 0.99, ds 0.96, gap **+0.03** — only the communication judge moved (0.95 vs 0.75); correctness + citation tied at 1.00 | **KILL** | The most expensive scenario (lead + 2 workers, ~$1–2/attempt) and it does NOT discriminate: graded correctness + citation-validity tie at 1.00, leaving only a weight-1 noisy judge. Worst cost-to-signal ratio in the catalog. The lead-orchestration coverage it provides is better served by `delegation-probe` (which discriminates) and `distributed-audit` (which discriminates and is the same price class). |
| 7 | `distributed-audit` | lead + 2 workers; shard → audit → merge with answer-key | completeness(2 det) + correctness(3 det) + communication(1 **judge**) | lead+2 | **deep** ~$1–2, slow | **YES — quality** [MEASURED, 1-attempt]: opus 1.00, ds **0.79**, gap **+0.21**; driver = correctness 1.00 vs 0.60 (merged answer-key catches ds's miss) | **KEEP** | One of only two scenarios that clear the 0.2 gate, and the only *lead-orchestration* one that does. Expensive but earns it: the merged answer-key catches budget-model audit misses. Keep as the deep/lead quality discriminator. (Marginal at +0.21, single-attempt — re-confirm at n≥3.) |
| 8 | `memory-coordination` | 3 workers; publish→retrieve→combine 12 facts + judge | correctness(3 det) + memory-coordination(1 **judge**) | 3 | **medium-expensive** (3 sandboxes) | **NO** [MEASURED, n=3, hardened]: opus/ds/haiku all **1.00**, gap **0.00** even after hardening to 12 facts | **KILL** | Explicitly found non-discriminating (`calibration.md`, ACCEPTED finding): swarm scaffolding equalizes tiers on shared-memory coordination, and the weight-1 judge can't resolve a finer gap. Expensive (3 workers) with zero quality signal and no price-benchmark edge over the cheap memory probe (`memory-distractor`). Retain the `seed.memories` machinery; retire the scenario. |
| 9 | `failure-recovery` | 3-4 workers; seed-poisoned reconciler; recovery judge | correctness(3 det) + failure-recovery(1 **judge**, agentic) | 3-4 | **medium-expensive** | **NO** [MEASURED, n=3]: opus 0.60 / ds 0.72 / haiku 0.60, gap **−0.06**; recovery judge opus 0.47 / ds 0.63 / haiku 0.47, **variance 0.40–0.90** | **KILL** | Documented non-discriminator AND the canonical noisy-judge case: the "opus 0.90" reading was one lucky attempt that didn't replicate at n=3; the reweight it motivated was reverted. Expensive, judge-driven, noisy. Retire as a tier discriminator. Keep the `seed.workerFailures` primitive (it works) for a future *deterministic* recovery check (mid-task KILL + a det detection check), not this judge-scored version. |
| 10 | `failure-recovery-mixed` | same, mixed-tier roster (smart lead + cheap workers) | correctness(3 det) + failure-recovery(1 **judge**) | 3-4 | **medium-expensive** | **NO** [MEASURED]: smart lead did NOT rescue cheap workers — recovery tracked the verifying *worker*, not the lead | **KILL** | Same noisy judge as #9 plus a negative sub-finding (lead doesn't rescue cheap workers). No discrimination, expensive, redundant with #9. Kill both together. |
| 11 | `delegation-probe` | lead + 2 workers; did the lead DELEGATE (vs solo) + audit correctness | delegation(5 det) + correctness(2 det) | lead+2 | **deep** ~$0.4/attempt at n=5 (~$3.89/10 runs) | **YES — quality, strongest** [MEASURED, n=5]: claude **1.00** vs pi **0.40**, **delegation-dim gap 0.60**, total gap 0.43, CI excludes 0 at n=5 | **KEEP (flagship)** | The redesign's proof scenario and the model for the whole effort. Correctness *intentionally* saturates (both can audit) so discrimination falls to the **delegation behavior axis**, scored deterministically (no judge) → large, significant, reproducible gap. Caveat: claude sits at the 1.00 ceiling with only 2 tiers — the "delegation-quality" finer-grading follow-up (Q1/Q4 positives already landed in PR #775) adds headroom for mid-tier configs. |

## Recommended final set

**KEEP — quality discriminators (the core leaderboard):**
- `delegation-probe` — flagship; deterministic delegation-behavior gap 0.60 (n=5). Lead+2.
- `distributed-audit` — only lead-orchestration *quality* discriminator; correctness answer-key catches budget misses (gap +0.21). Lead+2.
- `sql-audit` — cheap single-worker quality discriminator (gap +0.256); also the smoke default. 1 worker.

**KEEP-AS-BENCHMARK — saturate on quality but cheap/clean for $/speed comparison:**
- `bug-ladder` — fully deterministic code task (test execution + efficiency dim). The cleanest **cost/speed code benchmark**; the budget anchors finish the bugs, so the only differentiator is $/tokens/latency. 1 worker, no judge.
- `memory-distractor` — cheapest **memory-recall + retrieval** path benchmark; needs the embedding key, so it doubles as the memory-path $/speed smoke. 1 worker. (Make/keep its dims deterministic; demote the weight-1 judge.)

**KILL — saturate on quality + no benchmark edge (redundant / expensive / noisy-judge):**
- `cross-worker-invent` — saturates, 3 workers, redundant cross-worker axis.
- `plan-implement-review` — most expensive (lead+2), no discrimination, only a noisy weight-1 judge moves.
- `memory-coordination` — accepted non-discriminator, 3 workers, judge-driven.
- `failure-recovery` + `failure-recovery-mixed` — accepted non-discriminators, expensive, the canonical noisy-judge pair.
- `relay-pipeline` — **KILL pending one confirming n≥3 sweep** (never measured; expected to saturate; 3-worker cost makes it a poor benchmark even if it doesn't).

Result: **3 KEEP (quality) + 2 KEEP-AS-BENCHMARK + 6 KILL** → a lean 5-scenario set
(`delegation-probe`, `distributed-audit`, `sql-audit`, `bug-ladder`, `memory-distractor`), with
`relay-pipeline`'s fate decided by one sweep.

### Why this satisfies Taras's price/speed framing
Every kept scenario has a job: 3 resolve **quality** across tiers; 2 are deliberately-saturated
**price/speed benchmarks** (a cheap code task + a cheap memory task) where all configs pass and the
`efficiency` dimension + per-attempt cost/time do the comparing. The deterministic `efficiency`
dim and stored per-attempt cost/latency already exist
(`evals/src/runner/index.ts` ~828–883, `scoring.ts`), so KEEP-AS-BENCHMARK needs no new machinery —
just a decision to read those scenarios as $/speed comparators, not quality gates. Note the
`bug-ladder` "inversion" is the price signal working: at equal quality, the cheaper model wins on
efficiency — exactly what a benchmark should show.

## Preserve the machinery even where the scenario dies
Killing a scenario should not kill reusable primitives:
- `seed.workerFailures` (from `failure-recovery`) — keep for a future **deterministic** recovery check.
- `seed.memories` embed→retrieve path (from `memory-coordination`) — already exercised by `memory-distractor`.
- The cross-worker memory-handoff fixtures (from `cross-worker-invent` / `relay-pipeline`) — fold any
  unique coverage into `delegation-probe`/`distributed-audit` before deleting the files.

## Coverage gaps (axes the kept set does NOT cover)

1. **Tool-use efficiency ("Plan B")** — the planned axis: does the swarm use its own tools well
   (uses swarm scripts vs reinvents, creates workflows, fewer tool errors, fewer wasted steps)?
   Not covered by any kept scenario. The `events` table (`021_events.sql`, `tool.start` buffered)
   and `script_runs` give deterministic counters off the log. This is the highest-value gap to fill
   next and is deliberately deterministic (dodges judge noise), matching the `delegation-probe`
   recipe. (`tool.end` is NOT persisted — only `tool.start` — so error/latency-per-tool needs care;
   see the redesign research "tool-error not queryable" caveat.)
2. **Mid-tier gradation above a clean delegator** — with only 2 tiers, `delegation-probe` shows claude
   at the 1.00 ceiling; we can't see gradation *above* a clean delegator. The delegation-quality
   finer-grading follow-up (Q1/Q4 already landed) plus a 3rd mid-tier anchor would add headroom.
3. **Real failure recovery** — once `failure-recovery` is retired as a judge scenario, there is no
   deterministic recovery coverage. A mid-task worker KILL + deterministic "did the swarm detect &
   reconcile" check would restore it without the judge noise.
4. **Memory at depth/distance** — `memory-distractor` is a shallow single-hop recall. No long-horizon
   / multi-session memory probe (LOCOMO/RULER-style) exists. Lower priority given the recall path
   already saturates at this difficulty.

## Open decisions for Taras
- **`relay-pipeline`**: spend one n≥3 sweep to confirm-then-KILL, or KILL on the design argument now?
- **KEEP-AS-BENCHMARK judges**: drop the weight-1 judge dims on `memory-distractor` (and any benchmark
  scenario) to remove per-attempt judge cost/noise, since they don't move the aggregate?
- **Re-confirm the marginal quality gates** (`sql-audit` +0.256, `distributed-audit` +0.21) at n≥3
  before locking the final set — both currently rest on single-attempt sweeps.
- **Build Plan B (tool-use efficiency)** as the next deterministic discriminator to fill the top gap.
