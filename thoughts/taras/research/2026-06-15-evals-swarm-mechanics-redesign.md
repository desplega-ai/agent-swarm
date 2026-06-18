---
date: 2026-06-15T00:00:00Z
researcher: Claude
git_commit: 615f8c42cc40e01f7763f06fc05b1ab190d88cab
branch: main
repository: agent-swarm
topic: "Redesign the evals subproject to evaluate the SWARM ITSELF (emergent multi-agent mechanics), not single-model code quality"
tags: [research, evals, swarm-mechanics, memory-recall, delegation, tool-use-efficiency, deterministic-scoring, locomo, tau-bench]
status: complete
autonomy: autopilot
last_updated: 2026-06-15
last_updated_by: Claude
---

# Research: Evaluating the Swarm Itself — memory recall, expected behavior/delegation, tool-use efficiency

**Date**: 2026-06-15
**Researcher**: Claude
**Git Commit**: `615f8c42cc40e01f7763f06fc05b1ab190d88cab`
**Branch**: main

## Research Question

Following a negative finding (`thoughts/taras/plans/2026-06-15-evals-swarm-mechanics-rethink-handoff.md`) that the current swarm-mechanics scenarios do **not** discriminate model tiers — because correctness saturates (the scaffolding carries the work) and the soft agentic judge is too noisy (per-attempt variance 0.40–0.90) — re-frame the eval effort to measure **the swarm itself** rather than single-model IQ. Three candidate axes (Taras's framing):

- **(a) Memory recall** — store a fact early, recall it later (testable even single-lead, LOCOMO-style).
- **(b) Expected behavior / delegation** — "did the lead delegate to a worker when it should have?" — score the *structurally-correct action*, not the code quality.
- **(c) Tool-use efficiency** — does the swarm use its tools well? (uses swarm scripts vs reinvents? creates workflows? fewer tool errors? fewer wasted steps?)

For each: how do external frameworks score it, how does our swarm actually behave at runtime, what does the current `evals/` harness measure today, and **how could we score each DETERMINISTICALLY** to dodge judge noise.

## Summary

**The judge-noise problem is fixable, but not by swapping metrics — by redesigning what we measure so deterministic signals become valid.** The external survey (LOCOMO + memory benchmarks; τ-bench/SWE-bench/AgentBench/BFCL/MultiAgentBench) converges on one lesson: lexical/judge scoring is noisy precisely on *free-form* targets, and the field's best benchmarks dodge that by scoring against **planted ground truth** (unique tokens, final-state assertions, expected-action sets, programmatic counters) and quarantine the LLM judge to an irreducibly-subjective residue. RULER/NIAH score memory recall by checking a planted **unique high-entropy token** appears in the answer; τ²-bench scores behavior by asserting **ground-truth write-actions** appear in the trajectory; AgentBoard scores progress by **regex/state subgoal matching**; tool-use efficiency is **pure counters** off the tool-call log. pass^k (solved in *all* k runs) is the field-standard reliability metric for exactly the flakiness we hit.

**Our swarm produces a rich, DB-queryable paper-trail for all three axes.** Crucially, the research corrected a premise: there is **no auto-created "delete"/worktree-teardown task**. The real "tasks chain in reality" mechanism is a **lead-review follow-up task** (`taskType='follow-up'`, auto-created when a worker calls `store-progress` completed/failed, assigned to the lead, who is told to review and *not* re-delegate), plus a **`resume` task** (`taskType='resume'`) auto-created on supersede (graceful shutdown / context limit / crash recovery). Both leave clean `agent_tasks.taskType` + `parentTaskId` edges and `agent_log` event sequences. Delegation is observable as a new `agent_tasks` row with `creatorAgentId`=lead / `agentId|offeredTo`=worker plus `agent_log` `task_created`/`task_offered`. Tool *volume/mix*, *turns*, *cost/tokens*, *context/compaction*, *script reuse*, and *workflow authoring* are all deterministically queryable. **The one gap**: tool *error count* is **not** a structured column/event today — `tool.end` is not persisted (only `tool.start`), so tool-error rate currently requires parsing raw `session_logs.content` JSONL per provider (or adding a `tool.end` event).

**The current `evals/` harness is a good scoring engine pointed at a simplified world.** Its OutcomeSpec v2 (gates + weighted dimensions, `score = Σwᵢ·dimᵢ/Σwᵢ`, `passed = allGatesPass && score≥0.75`, checks-XOR-judge contract) and its deterministic-checks + deterministic-efficiency plumbing already exist and are reusable. But it models a **fixed, finite, author-written DAG of tasks created upfront**, hard-assigns worker tasks by index (no queue-claim contention), injects only **seed-time** failures, and **does not track or grade any task an agent spawns at runtime** (only `scenario.tasks` IDs) — so it cannot currently observe the follow-up/resume lifecycle that is the heart of "evaluate the swarm." The redesign is therefore mostly **new scenarios + new deterministic check types that read the DB/log signals**, not a scoring-engine rewrite.

---

## Detailed Findings

### Part 1 — External: how memory-recall benchmarks score (LOCOMO et al.)

**LOCOMO** (Snap Research, ACL 2024; [arxiv 2402.17753](https://arxiv.org/abs/2402.17753), [project](https://snap-research.github.io/locomo/), [GitHub](https://github.com/snap-research/locomo)) measures long-term conversational memory over very long multi-session dialogues (~300 turns, up to 35 sessions). Five QA reasoning types: **single-hop**, **multi-hop** (cross-session synthesis), **temporal**, **commonsense/open-domain**, **adversarial/unanswerable** (correct behavior = abstain). Data: sessions keyed `session_<n>` + timestamps, QA items with `question`/`answer`/`category` and — when available — **`evidence` annotations** (which dialog turns contain the answer).

Scoring (the key part):
- **Original LOCOMO scoring is deterministic & per-task** — token-level **F1** + **exact-match (EM)** + token **recall** on QA; **ROUGE + FactScore** on event summarization; **MM-Relevance/BLEU/ROUGE** on multimodal; adversarial = binary correct-abstain.
- **But the community has shown LOCOMO's lexical metrics are themselves noisy on free-form answers**: a downstream meta-comparison found F1 correlates only **r≈0.55** with human judgment vs **r≈0.83** for a binary LLM-judge-vs-reference (F1 mean 0.41, BLEU-1 0.28, LLM-judge 0.74). So Mem0/A-MEM/memobase re-implementations switched their *primary* metric to a reference-anchored `llm_score` ([Mem0 paper](https://arxiv.org/html/2504.19413v1), [memobase README](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md)).

The deterministic exemplars (synthetic / narrow-answer):
- **RULER** (NVIDIA, [GitHub](https://github.com/NVIDIA/RULER)) — **fully deterministic, no judge.** Synthetic needles are exact strings (UUIDs, magic numbers); scored by **string/substring match + recall**. The cleanest recall design.
- **NIAH** ([Kamradt](https://github.com/gkamradt/LLMTest_NeedleInAHaystack)) — widely used **keyword-presence** variant: correct iff response contains **all** required key phrases.
- **LongMemEval** ([2410.10813](https://arxiv.org/abs/2410.10813)) — measures extraction / multi-session reasoning / temporal / **knowledge-updates** / **abstention**; uses a **pinned, reproducible LLM-judge** (`seed=42`, single run) validated >97% human agreement.
- **MemGPT DMR** ([2310.08560](https://arxiv.org/pdf/2310.08560)) — deliberately uses questions with a "very narrow expected answer range" so ROUGE-L/EM is fair; nested-KV scored by exact value match.

**Deterministic patterns worth stealing for a swarm recall eval:** plant a **unique high-entropy token** (UUID/magic string) as the fact and score on **exact substring containment** (RULER/NIAH); or **all-key-phrases-present**; **constrain the answer to a narrow canonical form** so EM is fair; keep **abstention** as a separate binary check. Caveat to internalize: deterministic lexical scoring is valid **only** when the recall target is a planted, unique, exact string — *don't* try to fix judge noise by F1-ing free text. (Our existing `memory-distractor` scenario already does this: `score = matched/7` exact-fact recall.)

### Part 2 — External: how agentic/multi-agent benchmarks score behavior & efficiency

Field-wide, the lowest-noise techniques (full survey + sources in the appendix):

1. **Environment final-state assertion** — τ-bench / τ²-bench compare **final DB state == annotated goal state** (and τ²-bench a DB **hash**); SWE-bench runs **FAIL_TO_PASS + PASS_TO_PASS** test suites; WebArena uses programmatic `exact_match`/`must_include`/state queries. Lowest-noise signal; replaces most judge usage.
2. **Expected-action / write-action set matching** (the delegation primitive) — **τ²-bench** scores not just final state but whether the agent performed the **ground-truth *write actions***. **AgentBoard** decomposes a goal into ordered **subgoals** and applies `f(state, subgoal) → {0,1}` **regex/state matching** for a Progress Rate. **MARBLE/MultiAgentBench** uses programmatic **milestone KPIs**. This is exactly how you score "did the structurally-correct action happen" independent of final answer — assert a delegation/spawn action appears in the logged action trace, allowing multiple valid orderings (WebArena philosophy) to avoid brittleness.
3. **Tool-use correctness as structural checks** — **BFCL** does **AST matching** (function name + required params + types) + execution; **API-Bank** does exact-match call accuracy (right API + right params). Industry counters (Galileo/MLflow/Confident AI): **step efficiency** = optimal/actual steps, **tool-call accuracy** = right-tool ∧ valid-args, **redundant-call %**, **tool-error rate**, cost/tokens. All programmatic.
4. **Coordination** — **τ²-bench** (Dec-POMDP, coordination scored as a byproduct of shared-state correctness) is the best deterministic signal; **MARBLE** splits a programmatic milestone-KPI from a calibrated-judge Communication/Planning score.
5. **pass^k reliability** — τ-bench's metric: probability a task is solved in **all** k independent runs. Directly measures the flakiness we observed; superior to pass@1 for our purpose.
6. **Quarantine the LLM-judge** to the irreducibly-subjective slice (communication quality), and pin/calibrate it if kept. The agentic-benchmark best-practices literature ([2507.02825](https://arxiv.org/pdf/2507.02825)) names misaligned judge/ground-truth as the dominant error source.

ToolBench/ToolEval is **not** a deterministic exemplar (its Pass Rate is LLM-judged) — use BFCL/API-Bank instead.

### Part 3 — Internal: how the swarm ACTUALLY behaves (lifecycle, delegation, chaining)

**Task lifecycle / status machine.** Status enum at `src/types.ts:5-17` (`backlog → unassigned → offered → reviewing → pending → in_progress → paused → completed → failed → cancelled → superseded`); terminal set + guard at `src/types.ts:35-40`. Validity is enforced in TS only (SQL CHECK was dropped in migration 056). Initial status set by `createTaskExtended` (`src/be/db.ts:2948-2954`): `offeredTo`→`offered`, `agentId`→`pending`, `backlog`, else `unassigned`. All four terminal mutators (`completeTask` `db.ts:2088`, `failTask` `:2133`, `cancelTask` `:2181`, `supersedeTask` `:2237`) have **idempotency guards** (return `null` if already terminal) so racing sessions can't double-fire follow-ups. Every transition writes an `agent_log` row and most emit a `task.*` workflow-bus event.

**The auto-created follow-up (premise correction).** There is **no git-worktree/branch-delete auto-task.** The real "tasks chain in reality" mechanism is **`createWorkerTaskFollowUp`** (`src/tasks/worker-follow-up.ts:63-141`):
- Triggered fire-and-forget when a worker calls **`store-progress`** with `completed`/`failed` (`src/tools/store-progress.ts:441-464` — comment notes it "replaces the old poll-based tasks_finished trigger") or via `POST /api/tasks/:id/finish` (`src/http/tasks.ts:676-690`).
- Guards (`worker-follow-up.ts:71-78`): skips if `workflowRunId` set (workflow engine owns sequencing), if `followUpConfig.disabled`, if the finishing agent is itself a **lead** (prevents infinite chains), or if no lead exists.
- Creates a new task `taskType='follow-up'`, `source='system'`, `parentTaskId`=finished task, **`agentId`=the lead** (so it starts `pending`, directly assigned). Prompt templates `task.worker.completed` / `task.worker.failed` (`src/tools/templates.ts:49-133`); failed includes a cascade-impact section.
- The lead picks it up on its next poll (no worker-auto-claim branch — `src/http/poll.ts:299-305`), and the lead's system prompt (`src/prompts/session-templates.ts:86-90`) says **review the output, complete the follow-up, do NOT re-delegate** (the worker's result IS the answer). Anti-loop guard in `send-task` (`src/tools/send-task.ts:219-256`).
- **Resume follow-up:** `createResumeFollowUp` (`worker-follow-up.ts:174-272`) creates a `taskType='resume'` child when a task is **superseded** (graceful shutdown / context limit / manual / heartbeat crash-recovery, `src/heartbeat/heartbeat.ts:337-356`), tagged `auto-resume`/`reason:<x>`/`resume-generation:<n>`, routed to the parent's worker if live else the pool, repointing Linear/Jira sync rows parent→child.

**Delegation / offer / claim.** The lead delegates via **`send-task`** (`src/tools/send-task.ts`), three outcomes in one transaction (`:258-369`): no `agentId`→`unassigned` pool task; `offerMode:true`→`offered` task with `offeredTo` (worker must accept/reject); `agentId` + capacity→direct `pending`. Cannot self-assign or assign to lead. `parentTaskId` auto-routes the child to the parent's worker (`:175-182`). The offer cycle: worker poll sees offered tasks first, atomically `offered → reviewing` (`claimOfferedTask`, `src/http/poll.ts:167-180`), then `acceptTask` (`db.ts:3239`, runs a **budget admission gate**) → `pending`, or `rejectTask` (`db.ts:3269`) → `unassigned` with `rejectionReason`; stale `reviewing` returns to `offered` after 30 min (`db.ts:3367`). Pool claims: `getUnassignedTaskIds(5)` → atomic `claimTask` straight to `in_progress` (`db.ts:3177-3199`, `poll.ts:372-389`). **The "should the lead delegate" rule is a PROMPT directive, not code** (`src/prompts/session-templates.ts:49`: "You are a coordinator, NOT a worker. Delegate ALL implementation…"; decision guide at `:72-76`). Nothing forces delegation — it's the lead's LLM choosing to call `send-task`.

**Handoff channels** (all DB-observable): task creation/assignment (canonical), `store-progress` output (worker→lead, scrubbed, summarized into the follow-up), internal chat (`channel_messages` + `@mentions` waking idle agents via `claimMentions`, `poll.ts:286-297`), Slack reply threads (context auto-inherits via `parentTaskId`), and shared FS + `memory-search` over swarm-scoped memories (completed tasks auto-index into `agent_memory`, `store-progress.ts:344-394`).

**Observable signals for deterministic scoring** (delegation): new `agent_tasks` row with `creatorAgentId`=lead + `agentId|offeredTo`=worker; `agent_log` `task_created`/`task_offered` → `task_claimed`/`task_accepted`/`task_rejected`. (Follow-up/resume): `agent_tasks.taskType IN ('follow-up','resume')` + `parentTaskId` chain edge; follow-up text begins "Worker task completed — review needed."; server log `[store-progress] Created follow-up task …`. Highest-signal markers: `agent_tasks.taskType` + `parentTaskId` and the per-`taskId` `agent_log` event sequence.

### Part 4 — Internal: where tool-use efficiency is observable

**Deterministically queryable today (DB columns/events):**
- **Tool call volume & mix** — `events` table (`src/be/migrations/021_events.sql`), `event='tool.start'`, filter `agentId`/`taskId`/`sessionId`, breakdown via `data.toolName`. Written by the worker runner `src/commands/runner.ts:2930-2943`; read via `GET /api/events/counts` (`getEventCountsFiltered`, `src/be/events.ts:213`). Skill usage: `event='skill.invoke'` (`runner.ts:2948`).
- **Turns / cost / tokens / error-exit** — `session_costs` table (`migrations/001_initial.sql:179` + `063_*`): `numTurns`, `totalCostUsd`, `inputTokens`/`outputTokens`/`cacheRead`/`cacheWrite`/`reasoningOutputTokens`/`thinkingTokens`, `durationMs`, `isError`, `costSource`. `numTurns` is the closest existing "steps" signal.
- **Context / compaction efficiency** — `agent_tasks` aggregates (`compactionCount`, `peakContextPercent`, `totalContextTokensUsed`, `contextWindowSize`, `migrations/022_context_usage.sql:30-34`) + `task_context_snapshots` time series.
- **Swarm-script reuse vs reinvention** — `script_runs` table (`migrations/083_script_workflows.sql`, `085_*`): `scriptName IS NOT NULL` (used a named/saved script) + `kind` (`workflow`/`inline`) + `status` (`completed`/`failed`/…) + `agentId`. `scripts.isScratch=1` with name prefix `scratch-` = reinvented inline code auto-saved. `events.event='script.global_upsert'` = published a global script.
- **Workflow authoring** — `workflows.createdByAgentId` (+ `createdAt`, `migrations/008_workflow_redesign.sql`); execution via `workflow_runs.status`/`workflow_run_steps.status`/`.retryCount`, runtime `workflow.run.*`/`workflow.step.*` events. (No `workflow.created` event row — creation is observed via the table.)

**The gap (important):** **tool ERROR count is NOT a structured signal.** Only `tool.start` is persisted to `events`; the `tool.end` branch (`runner.ts:2963-2994`) updates only OTEL spans and does **not** `bufferEvent`, so there is no `tool.end` row and no per-tool `status='error'`. Tool errors live only inside raw `session_logs.content` JSONL (Claude `tool_result.is_error`, parsed at `src/providers/claude-adapter.ts:802`; Codex item completion) — queryable via SQL `LIKE`/JSON extraction but provider-shape-dependent, not a clean column. OTEL spans (`worker.tool`, `agentswarm.tool.*`, with `duration_ms` and error `setStatus`) are gated on `OTEL_EXPORTER_OTLP_ENDPOINT` and never written to SQLite. Tool-loop history is ephemeral `/tmp` JSON (`src/hooks/tool-loop-detection.ts`). **So a deterministic tool-error-rate metric needs either (a) parse `session_logs` JSONL, or (b) add a persisted `tool.end` event with `status`.**

### Part 5 — Audit: what the current `evals/` harness measures vs swarm reality

**Scenario catalog** (10, `evals/scenarios/index.ts:22-33`): `sql-audit` (1 worker, DB-audit), `memory-distractor` (1 worker, 7-fact recall vs distractors, `score=matched/7`), `bug-ladder` (1 worker, 7 planted bugs scored by test execution + budget), `cross-worker-invent` (3 workers, UUID propagation + derivations recomputed at grade time), `relay-pipeline` (3 workers, strict A→B→C transform chain via memory), `plan-implement-review` (lead + 2 workers, test-execution + deterministic citation-validity + judge), `distributed-audit` (lead + 2 workers, shard→merge), `memory-coordination` (3 workers, publish→retrieve→combine 12 facts + judge), `failure-recovery` / `-mixed` (3 workers, seed-time-poisoned reconciler, recovery judge).

**Task seeding & chaining — what's SIMPLIFIED.** Seed phase (`evals/src/runner/index.ts:986-1182`): memories indexed `scope:"swarm"` (gated searchable), then `seed.exec` in **worker 0's sandbox only**, then `seed.workerFailures`. Tasks (`runner/index.ts:1213-1277`): **all created upfront** in topological order; worker tasks **hard-assigned by index** (`agentId: w.agentId`, `:1227-1231`); only `worker:"lead"` tasks are left agentId-less for the API to route; `dependsOn` passed to the native swarm API; harness then awaits each to terminal. **Mismodeled vs reality:** (1) fixed finite author-written task set — **no follow-up/resume tasks, no auto-chaining/spawning, no deletion**; chaining is the static `dependsOn` DAG only. (2) **No queue-claim contention** for worker tasks (pinned by index). (3) **Any task an agent spawns at runtime is not tracked or graded** — only `scenario.tasks` IDs (`:1267-1277`). (4) Failure injection is **seed-time only**.

**Scoring engine (reusable as-is).** OutcomeSpec v2: normalization v1→v2 (`evals/src/normalize-outcome.ts:20-35`); gates = `tasksCompletedCheck` (prepended) + scenario gates, `allGatesPass = every(pass)` (`runner/index.ts:1502,1527`); dimensions each 0–1, `score = Σwᵢ·dimᵢ/Σwᵢ` (`scoring.ts:82-86`), `passed = allGatesPass && score≥0.75` (always computes score even on gate fail — anti-gaming, `scoring.ts:88-96`). **checks-XOR-judge contract** (`types.ts:214-222`): a dimension is graded by **deterministic checks** (`runChecks`, value `score ?? pass?1:0`) **XOR** by the **judge** (`judgeAgentic`/`judgeWithLlm`), never both (`runner/index.ts:659` vs `692-693`). Special **deterministic efficiency dimension** (named `efficiency`, no checks/judge) scored from real cost/time vs `budgetUsd`/`budgetMs` (linear decay 1.0→0 from budget to 3×; unpriced+no-time → `null` → dropped from divisor, `runner/index.ts:828-883`). **Deterministic dims today:** all `correctness`, `completeness`, `instruction-following`, `citation-validity`, `efficiency`. **Judge dims (all `agentic:true`):** `communication`, `retrieval-fidelity`, `provenance`, `memory-coordination`, `failure-recovery`.

**Agentic judge & its noise** (`evals/src/judge/agentic.ts:111-327`): an AI-SDK tool-loop agent (default `deepseek/deepseek-v4-pro`, maxSteps 8–12) with tools `run_command`/`read_file`/`api_get`/`submit_verdict`; input = scenario + rubric + final task records + roster manifest + **head+tail-truncated transcript** (`truncateMiddle(transcript, 60_000)`, keeps first/last 30k chars, `agentic.ts:291`; transcript = `flattenTranscript` over ALL active tasks' session logs). Output `{score, pass, reasoning}`; only `score` feeds the aggregate. **Documented non-discrimination** (`failure-recovery.ts:55-61`): opus 0.47 / deepseek 0.63 / haiku 0.47, variance 0.40–0.90; a 3× reweight was reverted; `memory-coordination` saturated at 1.00 before hardening.

**Failure injection today:** only `ScenarioSeed.workerFailures` (`types.ts:113-136`) — runs shell `commands` in `workers[entry.worker]`'s sandbox **at seed time, before any task**, best-effort/no-throw, worker-role only. No mid-run kills, partitions, restarts, or claim-time failures.

---

## Candidate eval dimensions (synthesis — feasibility map, not a plan)

Mapping Taras's three axes onto external techniques (Parts 1–2) and our observable signals (Parts 3–4), prioritizing deterministic scoring. *(This documents what is measurable and how; concrete scenario design is for the follow-on plan.)*

### (a) Memory recall — single-lead, LOCOMO/RULER-style
- **Deterministic technique:** plant a **unique high-entropy token** (UUID/magic string) as the to-be-recalled fact and score by **exact substring containment** (RULER/NIAH); for multi-fact, `matched/N` (already proven by `memory-distractor`, `score=matched/7`). For "knowledge update" cases (LongMemEval), plant an updated value and assert the *new* token appears and the *old* one does not. Keep **abstention/unanswerable** as a separate binary check.
- **Swarm angle:** store the fact via `store-progress` (auto-indexed to `agent_memory`) in session 1 / task A, recall in a later task; the fact transits **swarm memory** as the substrate. Single-lead variant: one agent, store-then-recall across context/compaction (use `agent_tasks.compactionCount` to confirm a compaction actually happened, making recall non-trivial).
- **Scoring:** deterministic checks branch only. No judge.

### (b) Expected behavior / delegation — τ²-bench write-actions + AgentBoard subgoals
- **Deterministic technique:** define the structurally-correct action as an **expected-action assertion over the logged trace**: assert a delegation occurred = a new `agent_tasks` row with `creatorAgentId`=lead ∧ `agentId|offeredTo`=worker (and/or `agent_log` `task_created`/`task_offered`). Model multi-step expectations as **ordered subgoals** (AgentBoard) with regex/state matchers, allowing valid orderings. The follow-up/resume lifecycle is itself a checkable subgoal: assert `agent_tasks.taskType='follow-up'` with `parentTaskId` appears after a worker completion (i.e., the lead actually got and closed the review loop).
- **Design tension to encode:** delegation is a **prompt directive, not enforced code** (`session-templates.ts:49`), so a scenario that *should* be delegated but is small enough to do solo is exactly the discriminating case — does the lead follow the coordinator contract? Score = did the expected delegation action appear (deterministic), not code quality.
- **Scoring:** deterministic checks against `agent_tasks` / `agent_log`. No judge for the structural fact; reserve judge only for "was the delegation *appropriate*" residue if needed.
- **Harness gap to close:** the runner must **track tasks the agents spawn at runtime** (follow-ups, lead-delegated children), not just `scenario.tasks` IDs — today it ignores them (`runner/index.ts:1267-1277`).

### (c) Tool-use efficiency — BFCL/industry counters off the log
- **Deterministic, available now:** tool **volume & mix** (`events.event='tool.start'` + `data.toolName`), **turns** (`session_costs.numTurns`), **cost/tokens** (`session_costs`), **context/compaction** (`agent_tasks` aggregates), **script reuse vs reinvention** (`script_runs.scriptName`/`kind`/`status`, `scripts.isScratch`), **workflow authoring** (`workflows.createdByAgentId`), **error-exit** (`session_costs.isError`). Step-efficiency = optimal/actual (define optimal per scenario). The existing deterministic-`efficiency` dimension already scores cost/time vs budget.
- **Needs a small enabling change:** **tool-error rate** is not a clean signal today (`tool.end` not persisted) — either parse `session_logs.content` JSONL per provider, or add a persisted `tool.end` event with `status`. This is the one infra prerequisite for the "fewer tool errors" metric.
- **Scoring:** pure counters → checks branch or a custom deterministic dimension. No judge.

### Cross-cutting
- **Adopt pass^k** (solved in all k attempts) as the reliability lens instead of relying on single lucky attempts — directly addresses the variance that produced the false opus signal.
- **Quarantine the judge** to genuinely subjective residue (communication quality); pin it (`seed`) if kept. Everything structural above is deterministic.
- **Engine is reusable**: gates + weighted dimensions + checks-XOR-judge + deterministic-efficiency already exist; the work is new scenarios + new deterministic check types + runtime-spawned-task tracking + (optional) `tool.end` persistence.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/types.ts` | 5-40 | Task status enum + terminal-status helpers |
| `src/be/db.ts` | 2088-2272 | Terminal mutators (complete/fail/cancel/supersede) + idempotency guards |
| `src/be/db.ts` | 2945-3175 | `createTaskExtended` + initial-status logic + inheritance |
| `src/be/db.ts` | 3177-3421 | claim / release / accept / reject / offer / backlog transitions |
| `src/tasks/worker-follow-up.ts` | 63-141 | `createWorkerTaskFollowUp` — the real auto follow-up (NOT a delete task) |
| `src/tasks/worker-follow-up.ts` | 174-272 | `createResumeFollowUp` — `resume` task on supersede |
| `src/tools/store-progress.ts` | 441-464 | Completion path → follow-up trigger |
| `src/tools/send-task.ts` | 258-369 | Lead delegation (pool / offer / direct-assign) |
| `src/http/poll.ts` | 167-180, 372-389 | Offer→reviewing claim; pool auto-claim |
| `src/prompts/session-templates.ts` | 49, 72-90 | Lead "coordinator, delegate ALL" directive + follow-up review instruction |
| `src/be/migrations/021_events.sql` | 1-24 | `events` table (`tool.start`, `category`/`event`/`status`/`agentId`/`taskId`/`data`) |
| `src/commands/runner.ts` | 2930-2994 | `tool.start` buffered to `events`; `tool.end` only OTEL (not persisted) |
| `src/be/migrations/001_initial.sql` | 179 | `session_costs` (numTurns/cost/tokens/isError) |
| `src/be/migrations/022_context_usage.sql` | 2, 30-34 | `task_context_snapshots` + `agent_tasks` context aggregates |
| `src/be/migrations/083_script_workflows.sql` | 3, 35 | `script_runs` + `script_run_journal` |
| `src/be/migrations/008_workflow_redesign.sql` | 17, 32, 49 | `workflows`/`workflow_runs`/`workflow_run_steps` |
| `evals/src/runner/index.ts` | 1213-1277 | Upfront topo task creation + index hard-assign + await-to-terminal |
| `evals/src/runner/index.ts` | 643-883 | `scoreDimension` (checks vs judge vs deterministic efficiency) |
| `evals/src/scoring.ts` | 41-105 | Efficiency decay, aggregate `Σwᵢ·dimᵢ/Σwᵢ`, pass logic |
| `evals/src/normalize-outcome.ts` | 20-35 | OutcomeSpec v1→v2 normalization |
| `evals/src/judge/agentic.ts` | 111-327 | Agentic judge tool-loop + head+tail transcript truncation |
| `evals/src/types.ts` | 113-136, 214-222 | `workerFailures` seed primitive; `DimensionSpec` checks-XOR-judge |
| `evals/scenarios/failure-recovery.ts` | 55-61 | Documented judge non-discrimination (opus 0.47 / ds 0.63 / hk 0.47) |

## Open Questions

- **Tool-error signal:** parse `session_logs.content` JSONL per provider, or add a persisted `tool.end` event with `status`? (The latter is a small runner change at `runner.ts:2963-2994` + a read path; the former avoids schema change but is provider-shape-coupled.)
- **Runtime-spawned-task tracking:** the runner only tracks `scenario.tasks` IDs. To grade delegation/follow-up behavior, it must enumerate tasks the agents created during the attempt (query `agent_tasks` by parent chain / `creatorAgentId`). What's the cleanest hook — post-run DB sweep, or live subscription to `task.*` bus events?
- **Queue-claim contention:** worth modeling (leave worker tasks unassigned in the pool) to evaluate claim behavior, or out of scope?
- **Budget anchor:** the handoff flagged Haiku 4.5 as too capable to fail; do the deterministic dimensions discriminate tiers on their own, or do we still need a weaker OSS anchor (pi-gemini-flash-lite / pi-glm-flash)?
- **pass^k:** add as a reporting layer over existing n-attempts, or restructure the run loop?

## Appendix

- **Architecture notes:** API server is the sole DB owner; workers talk over HTTP (so eval scorers reading `agent_tasks`/`agent_log`/`events`/`session_costs` go through the swarm API, mirroring the agentic judge's `api_get` tool). Prompt text lives in the registry (`src/prompts/`) — the "delegate ALL" contract is prompt-driven, which is what makes delegation a *behavioral* (not enforced) property worth evaluating. The evals scoring engine already separates deterministic checks from the judge cleanly (checks-XOR-judge), so adding deterministic dimensions is idiomatic.

- **Historical context (from thoughts/):**
  - `thoughts/taras/plans/2026-06-15-evals-swarm-mechanics-rethink-handoff.md` — the negative finding that motivated this research (swarm scenarios don't discriminate tiers; judge too noisy; open levers).
  - `thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md` — Rounds 1–4 OutcomeSpec v2 validation.
  - `evals/docs/calibration.md` — calibration recipe + swarm-mechanics finding.

- **External sources (full):**
  - Memory: [LOCOMO](https://arxiv.org/abs/2402.17753) / [project](https://snap-research.github.io/locomo/) / [GitHub](https://github.com/snap-research/locomo) · [Mem0 metric-reliability](https://arxiv.org/html/2504.19413v1) · [memobase eval](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md) · [LongMemEval](https://arxiv.org/abs/2410.10813) · [RULER](https://github.com/NVIDIA/RULER) · [NIAH](https://github.com/gkamradt/LLMTest_NeedleInAHaystack) · [MemGPT](https://arxiv.org/pdf/2310.08560)
  - Agentic/multi-agent/tool-use: [τ-bench](https://arxiv.org/abs/2406.12045) · [τ²-bench](https://arxiv.org/pdf/2506.07982) / [repo](https://github.com/sierra-research/tau2-bench) · [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) · [AgentBoard](https://arxiv.org/pdf/2401.13178) · [WebArena](https://webarena.dev/static/paper.pdf) · [BFCL](https://proceedings.mlr.press/v267/patil25a.html) · [API-Bank](https://ar5iv.labs.arxiv.org/html/2304.08244) · [ToolBench/ToolEval](https://openbmb.github.io/ToolBench/) (judge-based — not deterministic) · [MultiAgentBench/MARBLE](https://aclanthology.org/2025.acl-long.421/) / [repo](https://github.com/MultiagentBench/MARBLE) · [agent-eval best practices](https://arxiv.org/pdf/2507.02825) · [Galileo agent metrics](https://galileo.ai/blog/four-new-agent-evaluation-metrics)

- **Caveats on external sources:** the two web tracks could not fetch primary PDFs directly (WebFetch was redirected), so exact equation forms (τ-bench pass^k, WebArena `fuzzy_match`) are from authoritative search extracts/abstracts; mechanisms (DB-state equality, regex subgoal matching, AST matching, FAIL_TO_PASS) are corroborated across multiple sources. The LOCOMO F1-vs-judge correlation (r=0.55 vs 0.83) is a downstream community finding, not Snap's original claim.

- **Related research:**
  - `thoughts/taras/qa/2026-06-13-evals-v8-0-round11-outcomespec-v2.md` — OutcomeSpec v2 validation rounds.

## Review Errata

_Reviewed: 2026-06-15 by Claude_

**Verification done during review:** the four load-bearing claims were independently re-checked against current code (not just trusted from sub-agents): (1) `createWorkerTaskFollowUp`/`createResumeFollowUp` exist and create `taskType='follow-up'`/`'resume'` (`src/tasks/worker-follow-up.ts:63,135,174,251`) ✅; (2) NO auto-created delete/teardown task anywhere in `src/` (only an unrelated `delete-schedule` tool and a task-*file* cleanup comment) ✅; (3) the `tool_end` case (`runner.ts:2963-2995`) does only OTEL span work and does NOT `bufferEvent` — confirmed; the `bufferEvent` at `:3016` belongs to the `result`/`session.end` case ✅ (and the OTEL `tool_end` span sets `code:1`/OK unconditionally on the success path, so it doesn't capture tool errors either — the gap is slightly understated in Part 4); (4) the evals runner persists `taskIds` solely from the upfront-created `scenario.tasks` set and only awaits those (`evals/src/runner/index.ts:1259-1281`) — runtime-spawned tasks are never enumerated ✅.

### Critical
- _None._ The premise correction and the three other load-bearing claims all verified clean.

### Important
- [ ] **Discrimination is not guaranteed by determinism.** The thesis is that deterministic signals discriminate tiers where the judge didn't — but determinism only removes *noise*, it doesn't prevent *saturation*. A deterministic "did the lead delegate?" check could saturate at 1.00 (all tiers delegate) or 0.00 just as correctness did. The plan should **de-risk this first** — pilot one deterministic dimension across 2 tiers (e.g. opus vs a weak anchor) and confirm a real spread *before* building all three axes. (Partially raised in the budget-anchor open question; should be the headline risk.)
- [ ] **Our own memory subsystem was not investigated.** A memory-recall eval (axis a) exercises agent-swarm's actual memory system — `memory-search` ranking, scopes (agent vs swarm), embedding/recall in `src/be/memory/` + `runbooks/memory-system.md` + the `store-progress`→`agent_memory` auto-index. The research surveyed external memory benchmarks and the task lifecycle but not how *our* recall actually ranks/scopes results, which determines whether a planted-token recall is non-trivial. Investigate before designing axis (a).
- [ ] **Cross-provider `tool_result` shapes not enumerated.** The "parse `session_logs.content` JSONL for tool errors" fallback is provider-shape-dependent, and eval configs run multiple providers (claude/codex/pi/gemini/opencode). The plan needs the per-provider error-marker shape for each provider in the roster, or it should prefer the "add a persisted `tool.end` event with status" route (which itself requires each adapter's `tool_end` event to carry an error flag — currently it does not).

### Resolved / Minor (noted, not body-edited per no-rewrite rule)
- [x] "single-lead" (axis a) is imprecise — the deterministic recall pattern is really **single-agent / single-worker** (the existing `memory-distractor` uses 1 worker, no lead; a lead would try to delegate per its prompt directive). Term retained as Taras's framing; the body already clarifies "one agent."
- [x] The current per-cell **attempt aggregation** (how the harness combines the N attempts/cell — mean/median/etc.) is not documented in the Part-5 audit; needed to scope where pass^k plugs in. Added here as a scoping note for the plan.
</content>
</invoke>
