---
date: 2026-06-15T00:00:00Z
author: Claude (scope draft for Taras review)
topic: "Evals swarm-mechanics redesign — what we will actually plan for"
status: scope-for-review
related:
  - thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md
  - thoughts/taras/plans/2026-06-15-evals-swarm-mechanics-rethink-handoff.md
tags: [evals, swarm-mechanics, delegation, tool-efficiency, reliability, scope]
---

# Scope: Evals swarm-mechanics redesign

> This is the **pre-plan scope** for your review — what we will actually plan for, not the plan itself.
> Grounded in `thoughts/taras/research/2026-06-15-evals-swarm-mechanics-redesign.md` (+ its errata) and two follow-up gap investigations (memory subsystem; attempt aggregation). Once you've commented, I turn this into the full implementation plan via `/desplega:create-plan`.

## Goal

Make the evals matrix **discriminate the swarm itself** — not single-model code quality — by scoring **emergent multi-agent behavior** with deterministic, low-noise signals, and by making attempt-count `n` a **confidence dial** rather than a luck dial.

## Decisions locked (from our discussion)

1. **Build two axes together:** (b) **delegation & lifecycle** and (c) **tool-use efficiency**. They share the same data-access and runtime-task-tracking infra, so we amortize the overlap.
2. **Memory recall axis is NOT a new build.** The LOCOMO/RULER "plant a unique token, exact-substring match" trick does **not** transfer — our recall is semantic embedding search (OpenAI `text-embedding-3-small`, cosine KNN + composite reranker), with **free auto-injection** of top-5 memories (composite sim > 0.4) into the task prompt at dispatch. A bare token is flaky/non-discriminating. Memory is the **most mature axis already** (`memory-distractor` discriminates ~0.43 budget vs ~1.0 frontier via semantically-near distractors + buried/cross-ref facts + anchored partial-credit checks). We leave it as-is.
3. **Reliability = `n` as a confidence dial (asymptotic).** Replace the current "best@n" headline (a cell passes if *any* attempt passed — `results.ts:65`, the literal lucky-attempt trap) with a **convergent estimator**: report the true success-probability estimate (pass-rate / mean score) **plus a confidence interval that tightens as n grows**, baked into both the scoring system and the UI so "higher n ⇒ more trustworthy" is explicit. The per-attempt `passed`/`score` are already persisted per attempt (`attempts.passed`, `results.ts` `summarizeRun`), so this is an aggregation + UI change, no new per-attempt field.
4. **Data access = swarm-API proxy (already largely in place).** Deterministic checks already receive `ctx.apiGet(path)` — a raw authenticated GET against the attempt's swarm API (`evals/src/runner/index.ts:1487`) — plus `SwarmClient.get<T>(path)` and typed helpers (`getTask`/`getSessionLogs`/`getSessionCosts`/`listAgents`/`searchMemory`, `evals/src/swarm/client.ts`). So checks read tasks/memory/events/logs/costs over HTTP today. **No new DB persistence, no direct `bun:sqlite` reads.** The work is confirming the right GET endpoints/filters exist and adding thin proxy/helper coverage where a needed query isn't reachable.
5. **Runtime-spawned-task tracking is IN scope.** The runner currently persists & grades only the upfront `scenario.tasks` set (`evals/src/runner/index.ts:1259-1281`) and ignores any task the agents spawn at runtime. We add enumeration of agent-spawned tasks (follow-up / resume / lead-delegated children) via the API so delegation & lifecycle become gradeable.

## Out of scope (explicitly NOT doing)

- **New persisted `tool.end` event.** Per the proxy decision, tool-error rate comes from the **session-logs endpoint** (parse `is_error` per provider), not a schema change. (Cost: a small provider-shape parser — see open questions.)
- **Budget-anchor swap** (Haiku → weaker OSS). Deferred; decide during the de-risk run, not up front.
- **Queue-claim contention** modeling (leaving worker tasks unassigned in the pool). Keep current hard-assignment.
- **Memory axis rebuild** (per decision 2).
- **Scoring-engine rewrite.** OutcomeSpec v2 (gates + weighted dimensions, `score = Σwᵢ·dimᵢ/Σwᵢ`, `passed = allGatesPass && score≥0.75`, checks-XOR-judge, deterministic-efficiency dimension) is reused as-is (`evals/src/scoring.ts`, `normalize-outcome.ts`). New work = new scenarios + new deterministic check types.

## Axis (b) — Delegation & lifecycle

**What we measure (deterministically, via `ctx.apiGet`):** did the swarm take the *structurally-correct* coordination actions, independent of final-answer quality. Modeled as an **expected-action / ordered-subgoal assertion** (τ²-bench write-actions + AgentBoard subgoal-matching from the external survey).

**Observable signals (all swarm-API/DB-backed, verified in research):**
- **Delegation happened:** a new task row with `creatorAgentId`=lead ∧ (`agentId`|`offeredTo`)=worker; `agent_log` `task_created`/`task_offered` → `task_claimed`/`task_accepted`.
- **The follow-up review loop closed:** `agent_tasks.taskType='follow-up'`, `source='system'`, `parentTaskId`=the finished task, assigned to the lead (`src/tasks/worker-follow-up.ts:63-141`). (The real "tasks chain in reality" mechanism — NOT a delete task.)
- **Resume on interruption:** `agent_tasks.taskType='resume'` + tags + `parentTaskId` (`worker-follow-up.ts:174-272`).

**Scenario shape (sketch — plan to detail):** a task that is *small enough to do solo* but, per the lead's "delegate ALL" prompt directive (`src/prompts/session-templates.ts:49`), *should* be delegated. The discriminating question: does the lead follow the coordinator contract? Score = expected delegation/lifecycle actions present (deterministic), allowing valid orderings. Judge reserved (if at all) only for "was delegation *appropriate*" residue.

**Why it can discriminate:** delegation is a **prompt directive, not enforced code** — so weaker models that ignore the contract (do it themselves, skip the review loop, over-delegate, or loop) diverge structurally from stronger ones. (Discrimination still must be proven — see de-risk.)

## Axis (c) — Tool-use & resource efficiency

**What we measure (deterministic counters, BFCL/industry-style):** does the swarm use its tools well AND cheaply — both *tool hygiene* and *resource cost*. Two sub-groups:

**(c1) Native-swarm-primitive usage (per your comment).** The swarm exposes first-class primitives via API — does it actually leverage them rather than reinvent or flail?
- **Swarm scripts — reuse vs reinvention:** `script_runs.scriptName`/`kind`/`status`; `scripts.isScratch=1` (`scratch-` prefix) = reinvented inline; `events.script.global_upsert` = published a reusable script.
- **Workflow authoring:** `workflows.createdByAgentId` (+ `workflow_runs`/`workflow_run_steps.status`/`retryCount`).
- **Delegation / sub-agents:** the axis-(b) signals double as primitive-usage signals (did it use send-task / offer-claim / the follow-up loop instead of cramming everything into one session).
- **Memory:** did it use memory-search / inject-learning to coordinate (read via the memory endpoints) instead of re-deriving.

**(c2) Tool hygiene + resource cost.**
- **Tool volume & mix:** `events` where `event='tool.start'`, by `agentId`/`taskId`, `data.toolName` (`GET /api/events/counts`); `event='skill.invoke'` for skills.
- **Tool-error rate:** parse session-logs (`getSessionLogs`/`apiGet` → provider JSONL, Claude `tool_result.is_error` etc.). **No new persistence** (per decision); provider-shape parser is the cost.
- **Cost, token usage, and wall-clock time — first-class (per your comment):** `session_costs` (`totalCostUsd`, input/output/cache/reasoning tokens, `durationMs`, `numTurns`, `isError`) plus task-level timing. These become explicit efficiency dimensions, not just a pass/fail budget guard.
- **Context/compaction waste:** `agent_tasks` aggregates (`compactionCount`, `peakContextPercent`) + `task_context_snapshots`.

**Scoring:** pure counters → checks branch and/or a custom deterministic dimension (the deterministic-`efficiency` dimension machinery already exists, `runner/index.ts:828-883`; cost/time decay is already implemented there and extends naturally to tokens).

## Reliability & discrimination (the `n` confidence dial)

- **Metric:** move the headline off `passedAny` (best@n). Report a convergent success-probability estimate with an interval that tightens with `n` (candidate: **pass-rate + Wilson interval**, or **mean score + bootstrap CI** — plan to pick). Keep pass@1 and per-attempt detail as drill-downs.
- **UI:** surface the interval/`n` so "more attempts ⇒ tighter ⇒ more trustworthy" is visible; a single lucky attempt no longer flips a cell green. Insertion point: `summarizeRun`/`CellSummary` (`evals/src/results.ts:45-105`) → `GET /api/runs(/:id)` → CLI `show` + `serve` UI. Calibration gap (`evals/scripts/calibration-report.ts`, ship gate ≥0.2) can be redefined over the convergent metric instead of raw mean.
- **De-risk (determinism ≠ discrimination):** determinism removes *noise*, not *saturation*. Before building every dimension out, run the **first deterministic dimension of each axis across 2 tiers** (strong vs a weak anchor) at a meaningful `n` and read the convergent estimate + interval — if a behavioral metric saturates (all tiers delegate / all error-free), redesign the scenario *before* investing further. This naturally answers the deferred budget-anchor question.

## Open questions to resolve in the plan

1. **Convergent metric choice + UI** — _my rec (confirm in plan):_ make the **mean dimension-score with a confidence interval the discrimination headline**. Rationale: our dimensions are graded (partial credit in [0,1]), so the mean preserves the gradation that actually separates tiers — binarizing to a pass-rate throws that signal away — and a CI tightens ~1/√n, which is exactly the "`n` ⇒ confidence" property you want. Keep **pass-rate with a Wilson interval** alongside as the interpretable "fraction that cleared the 0.75 bar," and pass@1 + per-attempt as drill-downs. Redefine the frontier−budget calibration gap over the **mean-score-with-CI** so we can state whether a gap is *significant at the given n* (not just numerically ≥0.2). Open part: exact CI method (bootstrap vs normal-approx) and the CLI `show` / `serve`-matrix rendering. **wdyt — agree mean+CI as headline over pass-rate?**
2. **Endpoint/filter gaps** — _resolved by audit; see [Endpoint reachability](#endpoint-reachability-audit-result) below._ Bottom line: **most signals are reachable over GET today; the proxy gap is small.** Per-task lifecycle/delegation events come free via `GET /api/tasks/:id` (embedded `agent_log` `logs`), and the task object already serializes `taskType`/`parentTaskId`/`creatorAgentId`/`offeredTo`/`source`. The only real gaps: `GET /api/tasks` can't yet filter by `parentTaskId`/`creatorAgentId`/`taskType` (one is a no-DB-change route tweak; two need a thin DB filter), and there's no standalone/eventType-filtered `agent_log` route. None block us — enumerate runtime-spawned tasks by list+client-filter, or add the thin filters.
3. **Delegation counterfactual — RESOLVED** by the deployed swarm's design doc (`thoughts/taras/research/2026-06-16-delegation-eval-design-swarm.md`; original in agent-fs at `thoughts/c06cca59-187e-4aa6-8472-8ac6caf177af/research/2026-06-16-delegation-eval-design.md`). Adopt its **`delegation-probe`** scenario (a two-shard research task — modeled on the working `distributed-audit.ts` — whose prompt explicitly says "delegate to your two workers, do NOT query the tasks API yourself," removing the legit-solo exception). The solo-but-correct problem is solved by check **N1 `no-solo-research`**: scan the lead's `session_logs` for data-research tool calls (`get-tasks` with status filters); if present, the `delegation` dimension scores **0** regardless of final answer. Full rubric: gates (all-tasks-completed, merged-report-exists) + positive checks (P1 child-tasks-created, P2 worker-tasks-completed, P3 follow-up-received, P4 worker-sessions-exist, P5/P6 report exists+correct) + penalty checks (N1 no-solo-research, N2 no-implementation-tools, N3 no-delegation-loops, N4 no-re-doing-work). Aggregate `(5·delegation + 2·correctness)/7`, threshold 0.75. _My one caveat for the plan:_ N1/N2/N4 scan `session_logs.content` for tool_use names — provider-shape-dependent (Claude `tool_use` JSON), so the parser must cover each provider in the eval roster, and N1 assumes "research = `get-tasks` with status filter" (a clean assumption for *this* scenario since the audit data lives only in the tasks API).
4. **Tool-error provider parser:** which providers are in the eval roster, and the per-provider `is_error` marker shape, for the session-logs parse.
5. **De-risk anchor:** which weak tier for the 2-tier discrimination run.

## What gets delivered by the eventual plan

- New deterministic check types (read via `ctx.apiGet`) for delegation/lifecycle and tool-efficiency signals above.
- 1–2 new scenarios per axis exercising those signals, with partial-credit anchored dimensions.
- Runner change: enumerate + track runtime-spawned tasks.
- Reliability: convergent-with-`n` cell metric + UI surfacing, replacing best@n as the headline.
- A 2-tier de-risk run gating full build-out.
- (Possibly) thin swarm-API proxy/endpoint additions if a needed query isn't reachable via existing GETs.

## Endpoint reachability (audit result)

Definitive audit of which signals an eval check can read over GET today (via `ctx.apiGet`) vs what needs a thin route addition. **Verdict: most signals are already reachable; only 4 small gaps, none blocking.**

**Reachable today:**
- `GET /api/tasks/:id` → full task incl. `taskType`, `parentTaskId`, `creatorAgentId`, `offeredTo`, `source`, **plus the embedded `agent_log` `logs`** (per-task lifecycle sequence: `task_created`/`task_offered`/`task_claimed`/`task_accepted`/`task_status_change`…). So for any *known* task id, the whole delegation/follow-up event sequence is one GET away. (`tasks.ts:151-168`, serializer `db.ts:1055-1145`, logs `db.ts:2817-2824`)
- `GET /api/tasks` list — filters: `status` (CSV), `agentId` (assignee), `source` (CSV), `search`, `createdAfter`, `limit`/`offset`, `fields`. (`tasks.ts:45-73`)
- `GET /api/logs?agentId=` — agent_log by agent (no eventType filter). (`stats.ts:19-32`)
- `GET /api/events` + `/api/events/counts` — full filters incl. `event`/`status`/`agentId`/`taskId`/`sessionId`. (`events.ts:64-107`)
- `GET /api/tasks/:id/session-logs`, `GET /api/session-costs`, `GET /api/script-runs`, `GET /api/scripts`, `GET /api/workflows`(+`/:id/runs`), `GET /api/tasks/:id/context` — all reachable with the filters axis (c) needs. Memory: `POST /api/memory/search`|`list` (POST), `GET /api/memory/retrievals`.

**Gaps (thin additions, none blocking):**
1. `GET /api/tasks?taskType=` — **smallest**: `getAllTasks` already honors `taskType` (`db.ts:1615-1618`); the route just doesn't surface the query param. **No DB change** — add to the query schema + filters object (`tasks.ts:53-68,337-347`).
2. `GET /api/tasks?parentTaskId=` — needs a new DB filter + route wiring (no SQL condition today).
3. `GET /api/tasks?creatorAgentId=` — serialized but not filterable; needs a new DB filter + route wiring.
4. Standalone / `eventType`-filtered `agent_log` read — not routed (`getLogsByEventType` exists but unrouted, `db.ts:2839-2841`). Per-task is covered by `GET /api/tasks/:id` `logs`; only a cross-swarm eventType query would need a new route.

**Implication:** runtime-spawned-task enumeration needs **no new endpoint** in the minimal version — list tasks + client-filter on the serialized `parentTaskId`/`creatorAgentId`/`taskType`, or walk each seeded task's `GET /api/tasks/:id` `logs`. If we want clean server-side filtering, gap (1) is a free win and (2)/(3) are a few lines each.

## Appendix: prompt for the deployed swarm

_For open question 3 (delegation counterfactual). Paste this to the deployed swarm to get its own take on the scenario design._

```
We're building an eval that measures whether an agent swarm's LEAD correctly
DELEGATES work to workers (vs doing it itself). It must be scored
DETERMINISTICALLY from the task records + agent_log (NOT from output quality,
and NOT by an LLM judge).

The design challenge: we need a task setup where
  (a) delegating to a worker is unambiguously the correct behavior per the
      lead's "you are a coordinator — delegate ALL implementation/research/
      analysis" contract, AND
  (b) if the lead instead does the work solo, that is observable and
      penalizable — the catch is a solo lead might STILL produce a correct
      final answer, so "task completed" alone cannot be the signal.

Questions:
1. What task characteristics make delegation unambiguously correct and make
   NOT delegating a clear contract violation? (e.g. parallelizable subtasks,
   required specialist worker roles, work exceeding one context window,
   explicit multi-worker fan-out, a step only a worker sandbox can perform.)
2. What observable signals in the task / agent_log records distinguish
   "lead delegated" from "lead did it solo"? (e.g. child tasks with
   creatorAgentId = lead and a worker assignee; the auto follow-up review
   task; worker tool/session activity vs none.)
3. How do we penalize a solo-but-correct completion WITHOUT penalizing the
   legitimate cases where solo IS correct (small bug fixes the lead is
   allowed to handle directly per the decision guide)?
4. What delegation failure modes should we also detect — over-delegation,
   delegation loops, the lead re-doing the worker's output instead of just
   reviewing it?

Give a concrete scenario design plus the exact deterministic checks
(table/column/log-event conditions) you would score it with.
```
