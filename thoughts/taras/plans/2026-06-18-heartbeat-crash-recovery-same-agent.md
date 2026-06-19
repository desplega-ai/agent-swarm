---
date: 2026-06-18T00:00:00Z
author: Taras
topic: "Heartbeat crash-recovery: same-agent pin + templated Lead fallback (replaces PR #783)"
status: completed
branch: (new branch from main)
pr: 783
tags: [heartbeat, crash-recovery, task-lifecycle, lead-routing, des-523]
---

# Heartbeat Crash-Recovery: Same-Agent Pin + Templated Lead Fallback

## Overview

Replace the heuristic that dumps crash-recovery resumes into the role-blind unassigned pool with: **pin the resume back to its own (stable-ID) agent**, and **only when that agent is genuinely gone**, hand the Lead a *templated decision task* to re-delegate. This fixes the reported symptom (crash-recovery tasks grabbed by wrong-specialization agents) at its real root — a timing-window bug — without adding a routing subsystem or a specialization data model.

- **Motivation**: Daniel (PR #783 / DES-523): "the swarm arbitrarily routes tasks from crash_recovery to any available agent… coding tasks get picked up by reviewers… a Product Manager and a Principal Researcher pick up interrupted coding tasks." PR #783 addressed this with a 970-line opt-in Lead-routing subsystem; this plan **closes that PR** and ships a far smaller fix.
- **Related**: `src/heartbeat/heartbeat.ts`, `src/tasks/worker-follow-up.ts`, `src/be/db.ts`, `src/tools/templates.ts`, `src/prompts/`, PR https://github.com/desplega-ai/agent-swarm/pull/783, Linear DES-523.
- **Complexity impact** (answering "does this reduce heartbeat code/complexity?"): vs PR #783 (~970 LOC: new task type + escalation timer + reboot branch + 3 db helpers + 2 env flags + 569-line test) this is **~10× smaller**. vs `main` it is a *small net add* to the heartbeat — one reaper function + a Lead-decision follow-up creator + a registered template + a few `findings`/log lines; it deletes no existing code (the global pool path is deliberately untouched). What it genuinely reduces is the *conceptual* complexity of the crash path: a deterministic "pin to your own agent, else hand the Lead a decision" replaces the role-blind pool race. Honest bottom line: it does **not** shrink heartbeat LOC below `main`, but it is the minimal addition that fixes the root cause and is far smaller than the rejected alternative.

## Current State Analysis
> **Line-number caveat:** all `file:line` references in this plan were captured against the PR-783 branch (`feat/lead-routed-takeover-decision`, the current checkout), which is larger than `main`. The plan is implemented from `main` (see Setup), where the same code lives at different lines. The annotations below give the verified `main` locations; **always re-grep the symbol before editing rather than trusting a raw line number.** Verified `main` anchors: `createResumeFollowUp` `worker-follow-up.ts:174`, its `preferredAgentId` liveness block `204-218` (the `if (parent.agentId && args.reason !== "graceful_shutdown")` → `if (candidate && candidate.status !== "offline")` → `if (fresh && hasCap)` nest), its `createTaskExtended` call `247`; `createTaskExtended` status derivation `db.ts:~2997`; `getStalledInProgressTasks` `db.ts:6497`; `releaseStaleReviewingTasks` `db.ts:3427`; `getUnassignedTaskIds` `db.ts:3493`; `getActiveTaskCount` `db.ts:946`; `getPendingTaskForAgent` `db.ts:1301`; `heartbeat.ts` consts `STALL_THRESHOLD_NO_SESSION_MIN:53`, `STALE_CLEANUP_THRESHOLD_MINUTES:59`, `MAX_RESUME_GENERATIONS:65`, `DEFAULT_INTERVAL_MS:47`; `cleanupStaleResources` `heartbeat.ts:564`, `autoAssignPoolTasks:513`, `runRebootSweep:390`, `remediateCrashedWorkerTask:252` (it calls `supersedeTask` at ~337 **before** `createResumeFollowUp` at ~345).


The reported mis-routing is **not** a routing-logic bug; it is a timing-window bug feeding a role-blind pool. Verified this session:

- **Agent IDs are stable across restart.** Identity is the `AGENT_ID` env var, fixed per service in compose and persisted to a per-pod PVC file `/workspace/personal/.agent-id`, reloaded on restart (`charts/agent-swarm/templates/pool-statefulset.yaml:84-92`; `src/commands/runner.ts:3647`; `DEPLOYMENT.md:162`). A crashed worker returns as the **same agent**.
- **The crashed agent's row survives intact.** It is never deleted; re-registration is an idempotent upsert keyed on the id that flips `offline→idle` and preserves `name`/`role`/`description`/`capabilities`/identity-markdown (`src/http/agents.ts:283-307`). On a hard crash nothing even marks it offline; `lastActivityAt` just goes stale.
- **`createResumeFollowUp` already prefers the original agent** (`preferredAgentId = parent.agentId`, `main:src/tasks/worker-follow-up.ts:204-218`) — but only if the agent row is not `offline` AND it had activity within `WORKER_LIVENESS_WINDOW_SECONDS` (**30s**). The block is a three-gate nest: `parent.agentId && reason !== "graceful_shutdown"` → `candidate.status !== "offline"` → `fresh && hasCap`.
- **Crash detection doesn't fire until 5 minutes** of no session (`STALL_THRESHOLD_NO_SESSION_MIN`, `src/heartbeat/heartbeat.ts:61`). So at the moment a task is declared crashed, the original agent is *by definition* >30s stale → fails the liveness gate → the resume is created **unassigned** → released to the pool → claimed by any worker (`src/http/poll.ts:314-389` `claimTask` guarded only by `status='unassigned'`; `getUnassignedTaskIds` `src/be/db.ts:3535`; `autoAssignPoolTasks` round-robin `src/heartbeat/heartbeat.ts:674`). **That role-blind pool grab is Daniel's symptom.** The 30s window can never win against a 5-min detection threshold.
- **No reliable structured specialization signal exists.** `agents.role` is hardcoded `worker`/`lead` (`src/commands/worker.ts:7`); `capabilities` is identical feature-flags across the deployment (`src/server.ts:155`). Specialization lives only in free-text (`identityMd`, `name`) — LLM-readable, not SQL-matchable. **So no specialization column is needed, and adding one is not the path.**
- **Today neither `pending` nor `offered` tasks auto-recover** if the assigned agent never picks them up — only `reviewing` has a reaper (`releaseStaleReviewingTasks`, `src/be/db.ts:3469`), which re-offers to the *same* agent. This is the one robustness gap a same-agent-pin design must close.
- **Existing Lead-default convention**: completion/integration follow-ups already create Lead-owned tasks everywhere (`createWorkerTaskFollowUp` → `createTaskExtended({ agentId: leadAgent.id, taskType: "follow-up" })` at `src/tasks/worker-follow-up.ts:133-141`; plus GitHub/GitLab/Linear/Jira/AgentMail handlers all use `agentId: lead.id`). The Lead-fallback in this plan reuses that exact pattern.

Verified mechanism facts (from this session's sub-agent, file:line exact):
- **Pinning is a one-arg change.** `createTaskExtended` derives status from args (`main:src/be/db.ts:~2997`) as a four-way ternary: `offeredTo` → `offered`; else `agentId` set → **`pending`**; else `options.status === 'backlog'` → `backlog`; else → `unassigned`. So passing `agentId: parent.agentId` (with no `offeredTo`/`status:'backlog'`) to the existing `createResumeFollowUp` create call (`main:worker-follow-up.ts:247`) makes the resume `pending` for that agent. The *only* thing blocking that today for crash_recovery is the `fresh` (30s `lastActivityAt`) check in the liveness block (`main:worker-follow-up.ts:204-218`).
- **A pinned `pending` resume is reclaimed on the agent's next poll**, gated only by capacity + dependency-readiness + budget — **no agent-status gate** (`getPendingTaskForAgent` `src/be/db.ts:1301-1319`; poll pending branch `src/http/poll.ts:182-186`). Re-registration (`src/http/agents.ts:282-303`) flips `offline→idle` and does **not** touch `agent_tasks`; the worker boot path does not fetch assigned tasks — it picks them up only via the normal poll loop. So pinning + normal poll = automatic reclaim.
- **A pinned `pending` resume is invisible to both recovery sweeps.** `getStalledInProgressTasks` is `WHERE status='in_progress'` (`src/be/db.ts:6543-6545`), used by `detectAndRemediateStalledTasks` and (with threshold 0) by `runRebootSweep` (`main:src/heartbeat/heartbeat.ts:390-472`). So a pinned resume neither loops the stall detector **nor** gets re-pooled on server reboot — but it is also never auto-recovered if its agent never returns. That gap is exactly what the Phase 3 reaper covers.
- **There is no reliable "agent gone" signal at crash time.** A hard-crashed worker is never auto-marked `offline` — the only non-test `updateAgentStatus(…, "offline")` is the graceful `POST /close` handler (`src/http/core.ts:427`). Crash is inferred at the *task/session* level (no active session / stale session heartbeat), not from agent status. So "gone" cannot be distinguished from "restarting" at remediation time; the design must pin optimistically and let the reaper decide "gone" later.
- **Thresholds/env**: `WORKER_LIVENESS_WINDOW_SECONDS=30` (`worker-follow-up.ts:23`); `STALL_THRESHOLD_NO_SESSION_MIN=5` (env `HEARTBEAT_STALL_NO_SESSION_MIN`, `heartbeat.ts:61`); `STALE_CLEANUP_THRESHOLD_MINUTES=30` (env `HEARTBEAT_STALE_CLEANUP_MIN`, `heartbeat.ts:67`); heartbeat cadence `DEFAULT_INTERVAL_MS=90_000`.

## Desired End State

When the heartbeat detects a crashed worker:
1. **Common case (agent recoverable):** the resume is assigned to the **original agent** and reclaimed when it restarts. It **never enters the unassigned pool**, so no other-specialization worker can grab it.
2. **Agent genuinely gone (rare):** a separate, **Lead-owned templated decision task** is created (registered template, not string concat) telling the Lead to re-delegate; the Lead routes the real work via `send-task(agentId=…)`. The original work task is **not** reassigned to the Lead verbatim.
3. **No stranding:** a pinned resume that is never reclaimed within a grace window escalates to the Lead decision (new reaper) — work is never lost.
4. PR #783's takeover-decision subsystem does **not** exist on the new branch (started from main). PR #783 is **already closed** — its branch/diff remains accessible as the salvage source for the Phase-2 template content.
**Docs updated in the same PR** (CLAUDE.md lifecycle/harness convention): `task-lifecycle.mdx` describes the new same-agent-pin + Lead-fallback behavior and `HEARTBEAT_RESUME_PIN_GRACE_MIN` (the grace window a resume pinned to its crashed agent waits to be reclaimed before the reaper concludes the agent is gone and escalates to a Lead decision; default ~10 min), and a CHANGELOG `[Unreleased]` entry is added.

Verify: unit tests on the heartbeat crash path assert (a) recoverable-agent → resume `agentId == original`, never `unassigned`; (b) gone-agent → a Lead-owned `task.reroute.decision` follow-up exists, resume not pooled; (c) pinned-but-unreclaimed → reaper escalates to Lead decision. Plus a Docker E2E (see Manual E2E).

## What We're NOT Doing

- **Not removing the global unassigned pool, worker self-claim, or `autoAssignPoolTasks`.** Per Taras: remove the pool *from the heartbeat crash path*, not in general. Normal task distribution (`send-task` without agentId, `poll.ts` self-claim, round-robin auto-assign) is untouched. No migration.
- **Not adding a specialization column / role vocabulary / deterministic specialization router.** Same-agent recovery makes it unnecessary; the rare gone-agent case uses Lead judgment over existing free-text.
- **Not building the PR #783 mechanism** (takeover-decision task type, escalation timer, reboot-takeover branch, 3 db helpers, env flags). We start from main (which lacks it) and close the PR.
- **Not changing crash *detection* thresholds** (`STALL_THRESHOLD_*`).
- **Not adding a migration.** Confirmed unnecessary: `taskType` is unconstrained `TEXT` (`src/be/migrations/056_drop_agent_tasks_source_check.sql`; `src/types.ts` `z.string().max(50)`), `resume`/`follow-up`/`reroute-decision` need no enum change, and the `pending`/`superseded`/`unassigned` statuses already exist. The new env vars are runtime config, not schema.

> **tracker_sync on the gone-agent path — RESOLVED (see Phase 3 (e) + #4).** At pin time, `createResumeFollowUp` repoints `tracker_sync` rows from the original task to the pinned resume R1 (`repointTrackerSyncBySwarmId`, `main:worker-follow-up.ts:264`). When Phase 3 terminalizes R1 and the Lead creates R2 via `send-task` (which does NOT go through `createResumeFollowUp`), those rows are left pointing at the failed R1 — so a crashed task with a Linear/Jira `tracker_sync` may lose its outbound completion link on the gone-agent path. The superseded parent's `resumeTaskId` log-metadata breadcrumb (`backfillSupersedeTaskResumeTaskId`, `main:db.ts:2343`) is harmless — it is observability only and never drives routing. **Decision (locked, 2026-06-18): FIX.** Implemented across Phase 3 change (e) [reaper repoints `R1 → original`] and Phase 3 #4 [`send-task` repoints terminal `original → R2`], reusing `repointTrackerSyncBySwarmId`. Cheap — one reaper line plus the already-salvaged `send-task` transfer — and it avoids silently dropping the external-tracker (Linear/Jira/GitHub) completion link on the gone-agent path. The common (same-agent reclaim) path is unaffected (R1 completes with the link intact).

## Implementation Approach

- **Setup**: PR #783 is **already closed**. Branch fresh from `main` (do not build on `feat/lead-routed-takeover-decision`, the closed PR's branch).
- **Phase 1** lands the symptom fix with the lowest blast radius (same-agent pin). After it, crash resumes never enter the pool. **But Phase 1 alone is a strict regression for the gone-agent case**: it removes the pool fallback yet adds no reaper, so a genuinely-gone agent's pinned resume becomes `pending`, is invisible to both sweeps (`getStalledInProgressTasks` is `in_progress`-only), and is silently stranded forever — whereas `main` today re-pools that work and recovers it in seconds. Therefore Phase 1 is **committable and unit-verifiable independently, but NOT independently deployable** — it must not reach prod without Phase 3.
- **Phase 2** builds the reusable Lead-decision capability (registered template + creation fn) — not wired to the crash path; exercised by tests.
- **Phase 3** adds the reaper that invokes the Phase-2 capability when a pinned resume isn't reclaimed within a grace window (the only path to the Lead decision, since "gone" can't be detected at crash time). Closes the stranding gap; the heartbeat crash path now touches the pool zero times.
- Each phase is independently **committable** and unit-verifiable, but only **Phase 3 makes the change set deployable** — do **not** ship Phase 1 or Phase 2 to prod alone, since a gone agent's pinned resume has no reaper until Phase 3. Commit per phase after manual verification; release Phases 1–3 together as one deployable unit. (Phase 4 is docs-only.)

## Quick Verification Reference

- Type check: `bun run tsc:check`
- Lint (read-only, as CI runs): `bun run lint`
- Heartbeat unit tests: `bun test src/tests/heartbeat.test.ts src/tests/heartbeat-supersede-resume.test.ts src/tests/heartbeat-checklist.test.ts` (note: the glob `src/tests/heartbeat-*.test.ts` does **not** match `heartbeat.test.ts` — no dash before `.test`; `heartbeat*.test.ts` without the dash would match all three)
- New test files: `bun test src/tests/heartbeat-reroute-decision.test.ts`
- Template tests: `bun test src/tests/prompt-template-remaining.test.ts src/tests/prompt-template-resolver.test.ts`
- DB boundary guard: `bash scripts/check-db-boundary.sh`
- Full suite (pre-PR): `bun test`

---

## Phase 1: Pin crash-recovery resume to its own agent

### Overview

The heartbeat crash-recovery path assigns the resume to the **original (stable-ID) agent** instead of releasing it to the unassigned pool when the 30s liveness window has lapsed. Deliverable: for a recoverable crashed agent, the resume row carries `agentId == original` and is reclaimed on restart; it is never `unassigned`.

### Changes Required:

#### 1. Crash-recovery resume creation — drop the 30s freshness gate
**File**: `src/tasks/worker-follow-up.ts` (the `preferredAgentId` liveness block, `main:204-218`)
**Scope**: The fix lives **entirely inside `createResumeFollowUp`'s `reason === "crash_recovery"` branch** — no edits to the detector (`detectAndRemediateStalledTasks`). This is important: `detectAndRemediateStalledTasks` has two crash branches — Case A (no active session, `STALL_THRESHOLD_NO_SESSION_MIN`) and Case B (stale session heartbeat) — and **both** funnel through `remediateCrashedWorkerTask` → `createResumeFollowUp({ reason: "crash_recovery" })`. Keying the change on `reason` therefore covers both cases with one change. Do **not** add a branch in the detector or edit only one case.

**On the "active session" signal (resolves review Q):** an `active_session` row = one worker-*run* process for a task (`active_sessions`, `UNIQUE(taskId)`), created lazily *after* the provider process spawns and heartbeated by **tool activity** (throttled ~5s; there is no wall-clock ping between tool calls). Case A (`!session`) is **AND-gated** with `task.lastUpdatedAt ≥ 5 min` (`getStalledInProgressTasks`), and `store-progress`/output writes bump `lastUpdatedAt`, so an actively-reporting worker is protected even when its session row is absent. So Case A is really a *"no live run **and** no task progress in 5 min"* signal — not a precise crash detector: it can **false-positive** on a live-but-quiet worker (one long tool call / long thinking with no session row). This is acceptable here, and the same-agent pin actually *improves* the false-positive case: a wrongly-flagged but still-alive worker gets **its own** resume back (serialized, generation-capped) instead of a *different* agent grabbing the work in parallel as happens today. No design change — the AND-gate plus `MAX_RESUME_GENERATIONS` bound the blast radius.
**Changes**: For `reason === "crash_recovery"`, set `preferredAgentId = parent.agentId` whenever the agent **row still exists and has spare capacity**, regardless of the 30s `lastActivityAt` freshness. Concretely: keep the `candidate` lookup + `activeCount < maxTasks` capacity check, but for crash_recovery do **not** require `fresh` (the 30s window). Rationale: the agent ID is stable and the row survives a crash; "no activity in 30s" at the 5-min detection mark means "restarting," not "gone."

**Retain the `candidate.status !== "offline"` sub-gate** (`main:worker-follow-up.ts:207`) — only the `fresh` check is dropped. This is intentional and is safe *only* because a hard crash never marks the agent offline: the sole non-test `updateAgentStatus(…, "offline")` is the graceful `POST /close` handler (`main:src/http/core.ts:427`). Keeping the gate means a *gracefully-closed* agent still routes to the pool (correct — it is genuinely gone), while a hard-crashed agent (stale-but-not-offline) gets pinned. **Brittleness note for future maintainers:** any future code that marks stale agents offline before remediation (operator action, a heartbeat health-check change) would silently re-open the pool path for crash_recovery — if that lands, revisit this gate.

**Investigation confirms (resolves review Q):** the *only* non-test writer of `offline` is the graceful `POST /close` handler (`main:src/http/core.ts:427`); a SIGKILLed worker is never auto-offlined — at ~5 min it is `idle`/`busy` with a stale `lastActivityAt`. The "lead is always idle" you observed is **expected, not a bug**: the busy-flip lives in the worker-only `poll-task` tool and the lead is structurally excluded from task assignment (`getIdleWorkersWithCapacity` filters `isLead=0`; the pool dispatch query excludes leads, `main:db.ts:1923`), so it holds ~0 `in_progress` tasks and `checkWorkerHealth` keeps it `idle`. **Operative consequence for this phase:** the gate that actually pushes crash_recovery to the pool today is the **`fresh` (30s) check, not `offline`** — and `worker-follow-up.ts` carries a comment (around the liveness block) that *intentionally* relies on staleness to pool crash_recovery resumes. Phase 1 must therefore **delete/replace that comment** and state explicitly that we are deliberately reversing that decision: pin to the still-recoverable same agent, dropping only `fresh` while keeping the `offline` guard.

**Capacity-ordering invariant (load-bearing):** the pin succeeds at the default `maxTasks=1` only because `remediateCrashedWorkerTask` calls `supersedeTask` (flips the crashed parent `in_progress→superseded`, freeing the agent's single `in_progress` slot — `getActiveTaskCount` counts `in_progress` only, `main:db.ts:946`) **before** `createResumeFollowUp` runs its `activeCount < (maxTasks ?? 1)` check (`main:heartbeat.ts` ~337 then ~345). If that order were reversed, `activeCount=1 < 1` is false → the pin silently fails → resume falls to the pool — the exact bug this plan fixes. Do not reorder. When the capacity gate skips the pin for crash_recovery, emit a `[Heartbeat]` **warning** so the fallback is observable rather than silent.

This makes the resume `status='pending'` for the original agent via the existing `createTaskExtended` call at `main:247` (status derived at `db.ts:~2997`). Leave `graceful_shutdown` and other reasons unchanged. Record the pin in `findings.pinnedResumes` (see Observability below) in addition to a `[Heartbeat]` log line. The existing pool path (`preferredAgentId` undefined) remains as a degenerate fallback only when `parent.agentId` is null/row absent — effectively never in normal operation (rows are never deleted).

**Observability**: add a `pinnedResumes: Array<{ taskId: string; agentId: string }>` field to the `HeartbeatFindings` interface (`main:heartbeat.ts:80`), initialize it in **both** the `codeLevelTriage` findings object (`heartbeat.ts:156`) and the cleanup-only findings object (`heartbeat.ts:853`), populate it where `autoResumedTasks` is set in `remediateCrashedWorkerTask`, and add a `parts.push(\`pinned_resumes=${findings.pinnedResumes.length}\`)` line in `logFindings` (`heartbeat.ts:885`). This is the established crash-path observability pattern (the existing tests assert on `findings.autoResumedTasks[]`); a bare `console.log` would not surface in the structured sweep summary ops reads.

*(No separate stall-detector guard is needed: a `pending` resume is invisible to `getStalledInProgressTasks` (in_progress-only, `main:db.ts:6497`), so it neither loops the stall detector nor gets re-pooled on reboot. This is asserted by a test below, not by code changes.)*

**Audit existing test**: `src/tests/heartbeat.test.ts` has a test "sets agent to idle after auto-superseding its only task" whose comment (`~line 464`) reads "the resume follow-up was routed to the unassigned pool (worker is 'dead')". Phase 1 inverts that behavior (the resume now pins to the agent). The assertion body only checks `agent.status==='idle'` so it likely still passes, but the comment becomes false — update the comment, and if any fixture implies pool-routing for a recoverable agent, fix it to reflect the pin.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB boundary guard passes: `bash scripts/check-db-boundary.sh`
- [x] Delete `src/tests/takeover-decision.test.ts` (it tests the removed PR #783 `takeover-decision` mechanism and will fail to compile once that code is absent on the main-based branch).
- [x] New/updated unit test (extend `src/tests/heartbeat-supersede-resume.test.ts`, which already exercises `reason:crash_recovery` routing): crash_recovery resume for a *recoverable* agent has `agentId === original.agentId` and `status='pending'` (NOT `unassigned`): `bun test src/tests/heartbeat-supersede-resume.test.ts`
- [x] Unit test: assert `supersedeTask` runs **before** `createResumeFollowUp` (the capacity-ordering invariant) so the pin succeeds at `maxTasks=1`: `bun test src/tests/heartbeat-supersede-resume.test.ts`
- [x] Unit test (Case B coverage): a crash detected via the **stale session-heartbeat** branch (not just the no-session branch) also pins the resume to the original agent: `bun test src/tests/heartbeat-supersede-resume.test.ts`
- [x] Unit test: running the heartbeat sweep again with the pinned `pending` resume still unclaimed creates **no** second resume (invisible to `getStalledInProgressTasks`; no loop): `bun test src/tests/heartbeat-supersede-resume.test.ts`
- [x] Existing crash→resume regression tests still pass (resume-generation budget cap, tracker-sync repointing unaffected): `bun test src/tests/heartbeat.test.ts src/tests/heartbeat-supersede-resume.test.ts`

#### Automated QA:
- [x] A test simulates: worker assigned task → goes stale past `STALL_THRESHOLD_NO_SESSION_MIN` → heartbeat sweep → assert resume is pinned to the same agentId, and a second idle worker polling does NOT receive/claim it.

#### Manual Verification:
- [x] Confirm the pinned resume is served back to the original agent on its next poll (covered by Manual E2E). **Verified 2026-06-18** — Part 1 Scenario 2 (API poll reclaim) + Part 2 (real container restart reclaims in ~6s). Evidence: `thoughts/taras/qa/2026-06-18-des523-crash-recovery-e2e.md`.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 1] pin crash-recovery resume to its own agent`.

---

## Phase 2: Registered Lead-decision template + creation capability

### Overview

Build the **reusable capability** for handing the Lead a re-delegation decision: a registered `task.reroute.decision` template + a creation function reusing the `createWorkerTaskFollowUp` pattern. The Lead receives a *decision* task (not the raw work) and re-delegates via `send-task(agentId=…)`. This capability is **invoked by the Phase 3 reaper**, not by a crash-time branch — because (per Current State) "gone" cannot be distinguished from "restarting" at crash-detection time, so the Lead path is only reached after the pin has demonstrably failed to be reclaimed within the grace window.

### Changes Required:

#### 1. Register the reroute decision template
**File**: `src/tools/templates.ts`
**Changes**: `registerTemplate({ eventType: "task.reroute.decision", header, defaultBody, variables: [{ name, description }, …], category: "task_lifecycle" })`. (`registerTemplate` requires `eventType`, `header`, `defaultBody`, `variables`, `category` — do not elide `defaultBody`/`variables`.)

**Salvage source survives PR closure**: `task.takeover.decision` exists ONLY on the to-be-closed PR-783 branch, not on `main`. As a Setup step (before `gh pr close 783`), capture its body: `git show feat/lead-routed-takeover-decision:src/tools/templates.ts` and paste the relevant template literal into this plan's Appendix so it isn't lost if the branch is gc'd.

**KEEP** these variables/content: crashed-agent `name` + `identityMd` slice, `original_task_id`, task description, attachments block, `generation_next`/`max_generations` (budget context). **DROP**: the non-existent `takeover-routing` skill reference; the `{{timeout_min}}` fail-open / 30-min escalation language; and the `original_role`/`original_provider` variables (per Current State, `role` is hardcoded `worker`/`lead` and provider is not a specialization signal — salvaging them reintroduces the role vocabulary this plan explicitly disavows).

**Mandatory dispatch instruction** (load-bearing — the budget chain and parent-tree linkage break if dropped): the template MUST tell the Lead to dispatch via `send-task` with (a) an **explicit `agentId`** (the new worker), (b) `taskType: 'resume'`, (c) the tag `resume-generation:{{generation_next}}`, (d) `parentTaskId: {{original_task_id}}`, and (e) do **not** inherit the original task's `model`. Replace the dropped fail-open language with an explicit statement: "this work will NOT fall back to the pool; you are the only re-delegation path."

**The Lead decides who — but must choose explicitly.** The template's job is to *inform*, not to force. It states which agent crashed and its identity/specialization (`name` + an `identityMd` slice) and what it was doing, as **context** for the Lead's routing decision — it does **not** mandate the same agent. The Lead re-delegates to whomever it judges appropriate (same agent, a peer, whatever). The single hard requirement is that the Lead pass an **explicit `agentId`** to `send-task`: because `send-task` auto-routes to `parentTask.agentId` when `agentId` is omitted (`main:src/tools/send-task.ts:180`), and the parent's `agentId` is the now-dead crashed worker, omitting it would silently re-strand the task on the dead agent. So the template frames it as *"here's who was on this and what they did — pick an agent to take it over; don't leave it to the default,"* **not** *"reuse the same agent."*

**Advisory-only caveat (no enforcement)**: `send-task` does NOT auto-tag the generation — `taskType` and `tags` pass straight through from the LLM caller (`main:src/tools/send-task.ts`). The generation-budget chain therefore relies entirely on the Lead obeying the template; there is no code enforcement of the tag. State this explicitly so a future maintainer doesn't assume the cap is enforced on the Lead path. (The reaper guard in Phase 3 is the code-level backstop.)

#### 2. Lead-decision creation function
**File**: `src/tasks/worker-follow-up.ts`
**Changes**: Add `createRerouteDecisionTask({ original, staleResume, reason })` that creates the Lead-owned decision task via `createTaskExtended({ agentId: getLeadAgent().id, taskType: "reroute-decision", tags: ["reroute-decision"], parentTaskId: original.id, source: "system" })` with body from `resolveTemplate("task.reroute.decision", …)`. Mirror `createWorkerTaskFollowUp` (`main:worker-follow-up.ts:63-142`) for shape/Slack-field propagation. No `getLeadAgent()` → no-op (log + return), preserving fail-safe behavior.

**Use a distinct discriminator, NOT `taskType: "follow-up"`**: ordinary completion follow-ups are already `taskType="follow-up"` parented to the same task (`createWorkerTaskFollowUp` → `createTaskExtended({ taskType: "follow-up", parentTaskId: task.id })`), so a "non-terminal follow-up child for this parent" dedup query cannot distinguish a reroute-decision from a normal completion follow-up — a pre-existing follow-up could suppress a needed reroute decision, and nothing could later find/close reroute decisions. `taskType` is unconstrained `TEXT` (no CHECK; `src/types.ts` models it as `z.string().max(50)`), so use `taskType: "reroute-decision"` plus a `"reroute-decision"` tag. **Idempotency**: add an API-owned db helper `hasNonTerminalRerouteDecisionChild(parentId)` (mirror the existing `hasNonTerminalResumeChild`, `main:db.ts:1434`) that matches a non-terminal child with `parentTaskId = original.id` AND the reroute-decision marker; skip creation if it returns true. List this helper under db.ts Changes Required. Return a discriminated result like the existing follow-up creators.

**Generation tag — derive from the failed pin, not the root parent**: pass the stale pinned resume (`staleResume`) into the template variables and compute `generation_next = getNextResumeGeneration(staleResume)` (`main:worker-follow-up.ts:36`). Do **NOT** derive it from the superseded `original` parent: the original is the ROOT task with no `resume-generation` tag, so `getNextResumeGeneration(original)` returns 1 *every* escalation cycle — the failed pin R1 was gen 1, and the Lead's R2 would also be instructed as gen 1, so `MAX_RESUME_GENERATIONS=3` is never reached via the Lead path and a flapping task could loop indefinitely. Deriving from the stale resume gives R2 = gen(R1)+1, advancing the chain correctly.

**Slack-thread re-delegation guard interaction**: `send-task` has a guard (`main:src/tools/send-task.ts:204-242`) that BLOCKS re-delegation when the source task `taskType === "follow-up"` AND it carries `slackThreadTs`/`slackChannelId` AND a completed task exists in that thread within 48h. The reroute-decision task inherits Slack context transitively via `parentTaskId`. The existing `taskType === "resume"` carve-out applies to the SOURCE, not here. Decide and document one of: (a) do NOT propagate `slackThreadTs`/`slackChannelId` onto the decision task (the guard never fires, but the Lead loses Slack context), or (b) verify the cancellation bypass covers a superseded/failed crashed parent. Cover this with a test/E2E: a Lead `send-task(agentId=B, taskType=resume, parentTaskId=original)` from the reroute-decision context succeeds even when the original's thread already had a completed sibling.

*(No crash-time wiring in this phase. The capability is exercised by tests here and invoked for real by the Phase 3 reaper. This avoids inventing a "gone" predicate at crash time, which the codebase cannot reliably supply.)*

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] Template registration test: update `src/tests/prompt-template-remaining.test.ts` — the "Task lifecycle templates are registered" test hardcodes its count and an explicit `toContain` list (currently `task.worker.completed` + `task.worker.failed`); add `expect(eventTypes).toContain('task.reroute.decision')` and bump the `(2 task_lifecycle)` label: `bun test src/tests/prompt-template-remaining.test.ts`
- [x] Template resolver test: `resolveTemplate("task.reroute.decision", { …all vars… })` returns `result.unresolved.length === 0` (no unresolved `{{…}}`) — add to `src/tests/prompt-template-resolver.test.ts`: `bun test src/tests/prompt-template-resolver.test.ts`
- [x] Unit test (new file `src/tests/heartbeat-reroute-decision.test.ts`, mirroring the deleted `takeover-decision.test.ts` DB-path setup — `const TEST_DB_PATH=...`, `initDb`, side-effect import `'../tools/templates'`): gone-agent crash → a Lead-owned `taskType='reroute-decision'` decision task exists referencing the parent; resume is NOT pooled and the original work task is NOT assigned to the Lead; `hasNonTerminalRerouteDecisionChild` dedup prevents a duplicate on a second sweep: `bun test src/tests/heartbeat-reroute-decision.test.ts`

#### Automated QA:
- [x] Test simulates a gone agent (id absent) → assert exactly one Lead-owned decision task created, body contains the original task id + crashed-agent identity, and references `send-task` re-delegation.

#### Manual Verification:
- [ ] Eyeball the rendered template body for routing clarity (the Lead must understand it should re-delegate, not execute).

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 2] templated Lead-decision fallback for gone agents`.

---

## Phase 3: Bounded reaper for unreclaimed pinned resumes

### Overview

A resume pinned to its own agent (Phase 1) that is never reclaimed within a grace window — because the agent that looked recoverable never actually returned — is escalated to the Phase-2 Lead decision. Deliverable: a reaper wired into `cleanupStaleResources` that converts a stale pinned resume into a Lead decision; after this phase the heartbeat crash path never touches the unassigned pool.

### Changes Required:

#### 1. Reaper query
**File**: `src/be/db.ts`
**Changes**: Add `getStalePinnedResumes(graceMin)`: select `agent_tasks` where `taskType='resume'` AND `status='pending'` AND `createdAt < (now - graceMin)`. Returns full rows. (API-owned query; respects `check-db-boundary.sh`.)

**The `status='pending'` clause is the load-bearing "never reclaimed" discriminator — not agent liveness.** When the original agent restarts and reclaims via the normal poll path, `getPendingTaskForAgent` → `startTask` flips the row `pending→in_progress` (`main:db.ts:1301`, `1346-1360`; `src/http/poll.ts`), so a reclaimed resume drops out of this set automatically regardless of any liveness signal. **Do NOT add an `agents.lastActivityAt < cutoff` sub-clause as the primary signal** — `lastActivityAt` is written ONLY by `updateAgentActivity` (`main:db.ts:873`) via the in-session tool-call activity ping (`PUT /api/agents/:id/activity`), NOT by `/ping` (which updates only `status`/`lastUpdatedAt`) nor by re-registration. A returned-but-idle agent (back up, polling, but not actively tool-calling — e.g. `MAX_EMPTY_POLLS` told it to stop polling) has a STALE `lastActivityAt` despite being alive, so gating on it would wrongly escalate that agent's still-pending resume — re-introducing the exact mis-routing this plan exists to eliminate. The grace window + still-`pending` is the real "not reclaimed" proof; the agent-liveness join adds false positives and little signal. If a secondary liveness guard is kept at all, gate on poll-recency (`agents.lastUpdatedAt < cutoff`, refreshed every poll) OR `agents.status='offline'` — NOT `lastActivityAt`.

#### 2. Reaper driver + escalation
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Add `escalateUnreclaimedResumes(findings)` that, for each stale pinned resume:

(a) **Atomically terminalize-if-still-pending FIRST, then escalate only on success.** Do NOT use bare `failTask` — `failTask` (`main:db.ts:2157`) guards only against TERMINAL states (`isTerminalTaskStatus`, line 2164), so it would happily fail an `in_progress` resume. Because `cleanupStaleResources` is `async`, between `getStalePinnedResumes` reading the row as `pending` and the write, the original agent can return and `startTask` the resume to `in_progress` — a TOCTOU race that would kill work the worker just started AND escalate to the Lead (duplicate/competing work). Use a dedicated conditional query, e.g. `UPDATE agent_tasks SET status='cancelled', failureReason='pin_unreclaimed_escalated', finishedAt=now WHERE id=? AND status='pending' RETURNING *`; if no row is returned (`changes===0`), the agent reclaimed it in the gap → **skip escalation entirely**.

(b) Only for rows where the conditional terminalize actually fired, resolve the original as `original = getTaskById(staleResume.parentTaskId)` (it will be in `superseded` state — that is fine; the template reads identity/description fields, not status) and call the Phase-2 `createRerouteDecisionTask({ original, staleResume, reason: "crash_recovery" })` so the Lead gets a decision referencing the **original** task and the generation budget is computed from the failed pin (see Phase 2).

(c) **Budget guard**: before escalating, if `getResumeGeneration(staleResume) >= MAX_RESUME_GENERATIONS`, terminalize the resume with a `RESUME_BUDGET_EXHAUSTED`-style reason and do **NOT** create a Lead decision — otherwise a flapping task loops forever, since `send-task` does not enforce the generation tag (Phase 2).

(d) Idempotency: the Phase-2 `hasNonTerminalRerouteDecisionChild` dedupe means a second sweep won't create a duplicate decision.

(e) **Return the tracker link to the original.** When the conditional terminalize fires, call `repointTrackerSyncBySwarmId(staleResume.id, original.id)` (`main:src/be/db-queries/tracker.ts:127`). At pin time `createResumeFollowUp` moved any `tracker_sync` rows `original → R1` (`main:worker-follow-up.ts:264`); since R1 is now dead, move them back `R1 → original` so the Lead's re-delegated resume (which sets `parentTaskId = original`) can inherit them via change #4. No-op when the task has no `tracker_sync` rows (the common case).

**Observability**: add `escalatedReroutes: Array<{ originalTaskId: string; decisionTaskId: string }>` to `HeartbeatFindings` (initialize in both findings objects, populate here) and a `parts.push(\`escalated_reroutes=${findings.escalatedReroutes.length}\`)` line in `logFindings`.

Wire the call into `cleanupStaleResources` (`main:src/heartbeat/heartbeat.ts:564`) next to `releaseStaleReviewingTasks` / `releaseStaleProcessingInbox`.

#### 3. Grace window config
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: New env-overridable const `HEARTBEAT_RESUME_PIN_GRACE_MIN` (default ~10 min — generous enough for a slow container restart/image-pull, short enough that a genuinely-gone agent's work reaches the Lead promptly). Document default and rationale. Sweep cadence is 90s, so escalation fires at the first sweep after the grace elapses.
**Grace clock / total latency note**: the grace window is measured from the resume's `createdAt`, which is crash-*detection* time — already `STALL_THRESHOLD_NO_SESSION_MIN` (~5 min) after the real crash. So the effective worst-case latency from actual crash to Lead escalation is ~5 min + grace (~10 min) ≈ 15 min. Confirm this is acceptable for the target deployment.

**Reboot durability (confirmation, no change)**: the reaper lives in `cleanupStaleResources`, which runs on **every** `runHeartbeatSweep` including the post-reboot sweep (startup runs `runRebootSweep` then the normal sweep). `runRebootSweep` operates only on `getStalledInProgressTasks` (`in_progress`-only), so a `pending` pinned resume survives reboot untouched and is caught by the reaper afterward — the query keys on reboot-durable columns (`taskType`/`status`/`createdAt`). Because grace is measured from `createdAt` (which predates the reboot), escalation may fire on the first post-reboot sweep, which is intended.

**Rollback flag (recommended)**: this plan flips the production-default crash path from "resume → pool (recovered in seconds by any live worker)" to "resume → pinned, recovered only after the grace window via the Lead" — a strictly slower worst-case for genuinely-gone agents, plus two new race-prone surfaces (reaper predicate, reaper terminalize). PR #783 shipped opt-in for exactly this reason. Gate the change so a prod issue is reversible without a revert: gate the Phase-1 pin behind `HEARTBEAT_PIN_CRASH_RESUME` (default ON; set to `0` restores the `fresh`-gated pool path verbatim), and treat `HEARTBEAT_RESUME_PIN_GRACE_MIN=0` as "reaper off." This reuses the existing env-overridable-const pattern (e.g. `WORKER_LIVENESS_WINDOW_SECONDS`, the `heartbeat.ts` threshold consts) and costs one `if`.

#### 4. Inherit `tracker_sync` on Lead re-delegation (salvaged from PR #783)
**File**: `src/tools/send-task.ts`
**Changes**: Port PR #783's `transferTrackerSyncToResumeChild` helper: when `send-task` creates a task with `taskType: "resume"` and a `parentTaskId` whose parent is in a terminal state (`superseded`/`completed`/`failed`/`cancelled`), call `repointTrackerSyncBySwarmId(parent.id, child.id)` so the new resume inherits the outbound tracker link. Invoke it on all three `send-task` creation return paths (matching the PR). Combined with change (e), this completes the chain `original → R1` (pin) → `R1 → original` (reaper) → `original → R2` (this), so a crashed tracker-origin task (Linear/Jira/GitHub) keeps its completion link even on the gone-agent path. This is general-correct behavior for any Lead re-delegation of a resume, not just this flow.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] DB boundary guard passes: `bash scripts/check-db-boundary.sh`
- [x] Unit test: a pinned resume older than the grace window with a still-absent agent → escalated to a Lead decision exactly once (idempotent across repeated sweeps): `bun test src/tests/heartbeat-*.test.ts`
- [x] Unit test: `tracker_sync` chain on the gone-agent path — seed a `tracker_sync` row on the original; assert it follows `original → R1` (pin) → `R1 → original` (reaper terminalize) → `original → R2` (Lead `send-task` resume), so R2 owns the link and R1 owns none: `bun test src/tests/heartbeat-reroute-decision.test.ts`
- [x] Unit test: a pinned resume whose agent reclaims it before the grace window is NOT escalated: `bun test src/tests/heartbeat-*.test.ts`

#### Automated QA:
- [x] Test simulates: pin resume → advance time past grace with agent still gone → run sweep → assert Lead decision created and resume no longer stuck; run sweep again → no duplicate decision.

#### Manual Verification:
- [ ] Confirm the grace default is sensible for the real restart time in the target deployment. **Data point (2026-06-18 Part 2):** a local `docker start` restart reclaimed its pin in ~6s (crash detection ~62s after kill); the 10-min default is very generous vs. that. Prod cold-start (image pull) could be longer but still well under 10min — final call is Taras's per target deployment.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 3] reaper escalates unreclaimed pinned resumes to Lead`.
---

## Phase 4: Documentation

### Overview

The full behavior is only complete after Phase 3, so document it here. This introduces user-visible behavior (same-agent pin, Lead reroute-decision fallback, `HEARTBEAT_RESUME_PIN_GRACE_MIN` / `HEARTBEAT_PIN_CRASH_RESUME` env vars) that the CLAUDE.md lifecycle/harness convention requires documenting in the same PR.

### Changes Required:

#### 1. Concept doc
**File**: `docs-site/content/docs/(documentation)/concepts/task-lifecycle.mdx`
**Changes**: After the existing "Stalled Task Recovery" content (~line 167), add a subsection "Crash Recovery — Same-Agent Pin + Lead Fallback": crash resumes pin to the original (stable-ID) agent and never enter the role-blind pool; the `HEARTBEAT_RESUME_PIN_GRACE_MIN` env var (default ~10 min) and what happens when it elapses (a Lead-owned reroute-decision task); the `HEARTBEAT_PIN_CRASH_RESUME` kill-switch. This is plain concept MDX — it does **not** require `bun run docs:openapi` (that regen is only for `api-reference/**` on route/version changes).

#### 2. Changelog
**File**: `CHANGELOG.md`
**Changes**: Add an entry under `## [Unreleased]` (`### Changed` or `### Added`) describing the same-agent-pin crash-recovery behavior, the Lead reroute-decision fallback, and the new env vars. (On the main-based branch `[Unreleased]` is empty — there is no PR #783 takeover entry to replace.)

#### 3. Maintained flow runbook
**File**: `runbooks/heartbeat-crash-recovery.md`
**Changes**: This runbook is the canonical, current-only flow reference (enforced by the CLAUDE.md `<important if>` rule on heartbeat/crash-recovery/task-assignment logic). Update **§3 "Crash-recovery routing heuristic"** — diagram, heuristic prose, and pseudocode — to the new behavior (same-agent pin → reaper → templated Lead decision), and **remove the "⚠️ Planned change (DES-523)" callout**. Add `HEARTBEAT_RESUME_PIN_GRACE_MIN` / `HEARTBEAT_PIN_CRASH_RESUME` to the env-knobs table. Leave §1 (sweep) and §2 (classifier) as-is — they are unchanged.

### Success Criteria:

#### Automated Verification:
- [x] `task-lifecycle.mdx` renders without MDX errors (docs build, if run): `cd docs-site && pnpm build` (or visual check)
- [x] No `openapi.json` drift introduced (concept MDX only): `git status` shows only intended files

#### Automated QA:
- [x] Grep the new subsection for the env-var names and confirm they match the consts added in Phase 1/3 (`HEARTBEAT_RESUME_PIN_GRACE_MIN`, `HEARTBEAT_PIN_CRASH_RESUME`).
- [x] `runbooks/heartbeat-crash-recovery.md` §3 reflects the new routing (no "Planned change" callout remains; pseudocode matches the implemented `createResumeFollowUp` + reaper): `grep -c "Planned change" runbooks/heartbeat-crash-recovery.md` returns 0.

#### Manual Verification:
- [ ] Read the new subsection end-to-end: an operator can understand when a resume pins, when it escalates to the Lead, and how to disable the behavior.

**Implementation Note**: Commit `[phase 4] document same-agent crash-recovery pin + Lead fallback`.

---

## Manual E2E

> **EXECUTED 2026-06-18 (approach C).** Full evidence: `thoughts/taras/qa/2026-06-18-des523-crash-recovery-e2e.md`.
> - **Part 1 (scripted API-level, real server, no containers/LLM): ✅ 38/38, deterministic.** Proves all four gaps — pin to own agent (not pool), same-agent reclaim, gone-agent reaper → Lead reroute-decision (idempotent, original not reassigned), and no role-blind grab.
> - **Part 2 (focused Docker happy-path, real pi/deepseek worker): ✅ 11/11 core.** Real container SIGKILL → crash-detected (Case B) → resume pinned to stable `AGENT_ID` → same-ID container restart → reclaimed in ~6s. Caveat: resume didn't reach `completed` due to deepseek upstream-idle-timeouts colliding with the 1-min test threshold (model/threshold artifact, not a DES-523 defect; gen-2 also re-pinned to A correctly).
> - **Not done:** soft/manual check that the Lead LLM re-delegates via `send-task(agentId=B)` (steps 3 below, LLM-dependent, low priority).

Run against a real local swarm using the `swarm-local-e2e` recipe (Docker lead + worker; see `runbooks/testing.md` / `LOCAL_TESTING.md`). Replace `<…>` placeholders with real ids.

1. **Setup**: bring up the full stack with `docker compose -f docker-compose.local.yml up --build` (it includes its own `api` service plus a lead + two workers with **stable** `AGENT_ID`s — do **not** also run a host `bun run start:http`, which would race the compose `api` for the DB/port). To make the E2E fast, override in the compose `api` service env: `HEARTBEAT_STALL_NO_SESSION_MIN=1`, `HEARTBEAT_RESUME_PIN_GRACE_MIN=1`, `HEARTBEAT_INTERVAL_MS=10000`. Confirm registration: `curl -s localhost:3013/api/agents -H "Authorization: Bearer $AGENT_SWARM_API_KEY"`.
2. **Same-agent recovery (happy path)**: assign a task to worker A (`send-task` with `agentId=<A>`); let it start; kill worker A's container mid-task; wait past `STALL_THRESHOLD_NO_SESSION_MIN`; confirm via API a `resume` task exists pinned to `<A>` (`agentId=<A>`, not `unassigned`); restart worker A's container (same `AGENT_ID`); confirm A reclaims and runs the resume; confirm worker B never received it.
3. **Gone-agent fallback**: assign a task to worker A; kill A and do NOT restart (or remove its `.agent-id` to simulate a new ordinal); wait past the grace window; confirm a Lead-owned `task.reroute.decision` follow-up task exists referencing the original; confirm the original work task is NOT assigned to the Lead; confirm the resume is NOT in the unassigned pool; confirm the Lead can re-delegate it to worker B via `send-task(agentId=<B>)`.
4. **No role-blind grab**: throughout, assert no resume task transitions to a worker whose role/identity differs from A's via the role-blind pool (i.e., `claimTask` from the pool never fires for a crash resume).
5. **Cleanup**: `docker compose -f docker-compose.local.yml down -v` (matches the Setup orchestration path; `bun run pm2-stop` stops the PM2 ecosystem, not these compose containers). Reset DB if needed (`rm agent-swarm-db.sqlite`).

## Appendix

- **Follow-up plans**: (optional, separate, NOT in scope) full removal of the global unassigned pool + worker self-claim across all task producers — a larger architectural change requiring blast-radius mapping of every `unassigned` producer/consumer and a transition strategy. Tee up only if desired later.
- **Derail notes**:
  - The `pending`/`offered` stale-recovery gap (no reaper today) is closed for the crash path by Phase 3; other producers of `pending`/`offered` remain unreaped — worth a separate look.
  - PR #783's `task.takeover.decision` template content is the salvage source for Phase 2; the rest of the PR is intentionally dropped.
- **References**:
  - PR #783: https://github.com/desplega-ai/agent-swarm/pull/783 (to be closed), Linear DES-523
  - Investigation findings (this session): root-cause timing bug, agent-identity lifecycle, field inventory, Lead-default convention.
