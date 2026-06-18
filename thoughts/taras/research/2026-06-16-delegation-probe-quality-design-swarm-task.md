---
date: 2026-06-16T00:00:00Z
topic: "Swarm design task — delegation-probe quality grading"
author: Claude (orchestrator)
status: dispatched-to-swarm
related:
  - thoughts/taras/research/2026-06-16-delegation-probe-050-rootcause.md
  - thoughts/taras/qa/2026-06-16-delegation-probe-pilot.md
tags: [evals, delegation, swarm-task, design, dogfooding]
---

# Swarm design task — make `delegation-probe` grade delegation *quality*

**Branch:** `evals/swarm-redesign-plan-a` (PR #775). Read these first:
- `thoughts/taras/research/2026-06-16-delegation-probe-050-rootcause.md` — why the `delegation` dimension was stuck at 0.50
- `thoughts/taras/qa/2026-06-16-delegation-probe-pilot.md` — the pilot evidence (claude-opus-4.8 vs pi-deepseek-flash, n=5)
- `evals/scenarios/delegation-probe.ts` — the scenario + rubric
- `evals/src/scoring.ts` + `evals/src/types.ts` — gates + weighted dimensions + **checks-XOR-judge** contract

## The problem you're solving (design, not the bug fix)
We're separately fixing the mechanical N2/N4 penalty bug that pinned `delegation` at 0.50. The OPEN design question for you:

The current `delegation` dimension only grades **that** delegation happened (children created, completed, follow-up received, no solo research) — not how **well** it was done. After the penalty fix, a frontier and a budget model that both "delegated at all" may still cluster. We want the dimension to discriminate delegation **quality**.

## What to propose (a design, grounded in the pilot evidence — do NOT implement yet)
1. **Deterministic quality-graded positives.** What concrete, deterministic checks could capture *good* delegation? Candidates to evaluate (add/cut/refine): balanced shards across the two workers; child-task descriptions that contain real routing instructions (not empty/boilerplate); faithful merge (lead's report reflects what workers actually reported, not re-derived); no redundant re-work after follow-ups; sensible task count (exactly 2 children, not 1 or 7). For each: how to detect it deterministically from the captured `task` artifact + `session_logs` (via the Phase-1 parser `evals/src/judge/session-log-parse.ts`), and a proposed weight.
2. **Non-deterministic (judge) component — should there be one, and how to anchor it.** The ORIGINAL negative finding was that the soft judge was too *noisy* to discriminate tiers (that's why this redesign went deterministic). So: do we need a judge at all? If yes, it must be a SEPARATE `delegation-quality` dimension (checks-XOR-judge → a dimension is either deterministic checks OR a judge, never mixed), with a TIGHTLY-ANCHORED rubric (specific 0/1 anchored criteria, low-variance) — propose that rubric, and argue why it won't reintroduce the noise. If you think deterministic positives suffice, say so and why.
3. **Anti-gaming.** The pilot found a lead can audit the seeded history itself via the `db-query` MCP tool and dodge the "no solo research" checks. Call out any other gaming routes your proposed checks open, and how to close them.

## Deliverable
A concrete proposal: the revised `delegation` (and/or new `delegation-quality`) dimension — exact checks, weights, any judge rubric — with the reasoning tied to the pilot evidence. **Deterministic-first**; only reach for a judge where determinism genuinely can't capture the quality signal. Post it as a comment on PR #775 or a short doc under `thoughts/`. Do not change the scenario code or re-run E2B (that's expensive — we'll pilot it).
