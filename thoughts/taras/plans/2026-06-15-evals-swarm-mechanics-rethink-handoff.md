---
date: 2026-06-15T00:20:00Z
author: Claude (handoff for Taras)
topic: "Evals swarm-mechanics — handoff after PR #737 merge; re-thinking checkpoint"
status: handoff
branch: main (PR #737 merged as 9e43745d)
related:
  - thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md
  - evals/docs/calibration.md
tags: [evals, swarm-mechanics, handoff, discrimination]
---

# Handoff — Evals swarm-mechanics, post-#737, re-thinking checkpoint

## TL;DR for the next session

- **PR #737 is MERGED to main** (squash `9e43745d`). Repo is on `main`, clean, fast-forwarded. **Branch fresh from main** for any new work (`git checkout -b <name>`).
- The big result this session is a **negative finding (accepted)**: the swarm-mechanics eval scenarios **do not discriminate model tiers** at our measurement resolution. The harness scaffolding equalizes tiers and/or the single-call agentic judge is too noisy. This is the thing the re-thinking should react to.
- Taras has **new ideas** to explore (not yet specified) — start the new session by having him lay those out, then map them against the findings below.

## What shipped this session (context)

The evals matrix (`evals/` — scenario × harness-config on E2B, OutcomeSpec v2 graded scoring) got:
1. **Round-11 OutcomeSpec v2** validated end-to-end on real E2B runs (gates + weighted dimensions, score = Σwᵢ·dimᵢ/Σwᵢ, `passed = allGatesPass && score ≥ 0.75`, per-dimension persistence, efficiency dimension, agentic judge full-roster + head+tail transcript). **No implementation defects found.**
2. **Calibration sweeps** (real E2B, ~$20 total across the session) that showed the round-11 scenarios mostly **saturate** vs `claude-haiku` (too capable a budget anchor); only `sql-audit` + `distributed-audit` cleared the ≥0.2 frontier-vs-budget gate.
3. A **swarm-mechanics spike** (the reframe Taras pushed): evaluate the SWARM (shared memory, coordination, failure recovery) as the bottleneck, not single-model IQ. Built:
   - **`seed.workerFailures` primitive** (`evals/src/types.ts` + `runner/index.ts`) — best-effort, no-throw seed-time poison of any worker. Works end-to-end (validated live).
   - **3 new scenarios** (catalog now 10): `memory-coordination`, `failure-recovery`, `failure-recovery-mixed`.
4. CI: added evals `bun test` to merge-gate; fixed a pre-existing root-test failure (see gotchas).

Commits (all on main via #737 squash): the working history was `b9836b3a` (round-11+calib) → `0c170fb9` (spike) → `9d8e5279` (reweight+harden) → `24da11c6` (revert+finding) → `cd78be6c` (UI arrow) → merge/CI fixes. All squashed into `9e43745d`.

## The core finding (what the re-thinking must absorb)

**Swarm-mechanics scenarios do NOT discriminate model tiers.** Clean sweeps (opus-4.8 / deepseek-flash / haiku):

| Scenario | opus | deepseek | haiku | gap | note |
|---|---|---|---|---|---|
| `memory-coordination` (hardened, 12 facts) | 1.00 | 1.00 | 1.00 | 0.00 | all tiers ace it even after hardening |
| `failure-recovery` (3 attempts) | 0.60 | 0.72 | 0.60 | −0.06 | recovery judge: opus 0.47 / ds 0.63 / hk 0.47 |

Why:
- **Correctness saturates** — all tiers recover the poisoned value / retrieve the memory facts equally. The swarm scaffolding carries the work.
- **The soft agentic judge is too noisy** — per-attempt variance 0.40–0.90. A round-3 reading of "opus 0.90 vs budget 0.50" was a **single lucky attempt** that did NOT replicate at n=3. (A reweight motivated by it was reverted — `24da11c6`.)
- Interesting sub-finding: **a smart lead did NOT rescue cheap workers** on `failure-recovery-mixed` (recovery quality tracked the verifying *worker*, not the lead).

**This is a real, useful result, not a failure:** at this task difficulty, agent-swarm's scaffolding equalizes model tiers, and our judge can't resolve a finer gap. Full write-up: `thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md` (Rounds 1–4) and `evals/docs/calibration.md` (Swarm-mechanics finding).

## Open levers for the re-thinking (if we keep pursuing swarm discrimination)

1. **Beat judge noise** — N-sample median judging (a plan non-goal so far), or replace the soft judge with a **tighter deterministic detection check** (e.g., grep the session logs for an explicit "mismatch/recompute" signal rather than asking a judge "did they detect it?").
2. **Genuinely harder failures** — the primitive only does *seed-time* poison. Add **mid-task worker KILL** (Medium effort, noted in the Explore findings) and **simultaneous/cascading failures** so recovery actually separates capable swarms.
3. **Swap the budget anchor** — `claude-haiku` (Haiku 4.5) is too capable to fail; a genuinely weaker OSS small model would separate cleanly. Roster has options (`pi-gemini-flash-lite`, `pi-glm-flash`, opencode-* small models).
4. **Re-weight philosophy** — for a swarm eval, swarm-behavior arguably *should* outweigh final-answer correctness, BUT only once that behavior dimension is a *reliable* signal (it isn't yet — see noise above).
5. **Accept + move on** — document the equalization finding as the product insight and pivot the eval effort elsewhere (e.g., back to single-model discrimination scenarios, or whatever Taras's new ideas are).

## Durable gotchas (carry into any new session)

- **Eval DB / WalConflict:** run sweeps on a **local DB** (`EVALS_DB_PATH=/tmp/x.sqlite`), NOT the shared Turso replica. `EVALS_DB_SYNC_URL` OVERRIDES `EVALS_DB_PATH` (`client.ts:29-52`) — to force local you must also pass `EVALS_DB_SYNC_URL='' EVALS_DB_AUTH_TOKEN=''`. Running a heavy concurrent sweep + a live `serve` both syncing Turso → `WalConflict` (errors attempts). For live UI during a sweep: point both `serve` and the sweep at the SAME local file.
- **Root `bun test` vs evals:** root `bun test` globs `evals/**/*.test.ts`. Excluded via root `bunfig.toml` `pathIgnorePatterns=["evals/**"]`. Bun positional filters are SUBSTRING matches (`bun test src` also matches `evals/src`) — do NOT use that to exclude. `cd evals && bun test` still runs (cwd-relative paths don't match the pattern).
- **Merge queue:** main uses a merge queue with auto-merge DISABLED → `gh pr merge` fails ("Auto merge is not allowed"). Enqueue via GraphQL: `mutation{ enqueuePullRequest(input:{pullRequestId:"<node id>"}){ mergeQueueEntry{ position state } } }`. No `--admin` needed.
- **Deploy-safety:** `docker-and-deploy.yml` build+push jobs are NOT version-gated (run on any `src/` push to main). Deploy/npm/E2B/release/tag ARE version-gated on a `package.json` version bump. So an evals/src merge that doesn't bump the version builds images but does NOT deploy/publish.

## Key files / pointers

- Scenarios: `evals/scenarios/*.ts` (10). Swarm ones: `memory-coordination.ts`, `failure-recovery.ts` (+ `-mixed`).
- Failure primitive: `evals/src/types.ts` (`ScenarioSeed.workerFailures`), `evals/src/runner/index.ts` (seed-phase §3, ~line 1076+).
- Scoring core: `evals/src/scoring.ts`, `normalize-outcome.ts`, `runner/index.ts` (scoring block).
- Agentic judge (roster + head+tail): `evals/src/judge/agentic.ts`.
- Calibration recipe + finding: `evals/docs/calibration.md`.
- QA report (Rounds 1–4): `thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md`.
- Configs/anchors: `evals/configs/index.ts`. CLI: `cd evals && bun src/cli.ts {registry,run,serve,show}`.
- Memory: `project_evals_round11_outcomespec_v2.md` (auto-memory) has the running log.

## How to resume

1. `cd /Users/taras/Documents/code/agent-swarm && git checkout main && git pull` (already on main, clean as of handoff).
2. `git checkout -b <new-branch>` before editing.
3. Have Taras state the new ideas; map them to the levers above.
4. Gates: `cd evals && bun run tsc:check && bun test`; root `bun run lint`. UI: `cd evals && bun run ui:build`.
5. Sweeps: local DB only (see gotcha). The 4801 `serve` (if still up) points at `/tmp/evals-live.sqlite` from this session.

## Loose ends (not blocking)

- Local branch `feat/evals-subproject` is diverged (squash) — safe to delete locally/remotely.
- Round-11 (non-swarm) scenarios still mostly saturate vs Haiku — separate from the swarm thread; revisit only if relevant to the new ideas.
- `serve` on :4801 + the `/tmp/evals-live.sqlite` from this session are ephemeral.
