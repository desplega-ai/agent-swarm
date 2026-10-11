---
id: step-4
name: Server-side pool routing
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: Server-side pool routing

## Overview

Unassigned pool tasks get routed by the API itself, right when they appear, instead of waiting for a polling worker or the 90 s heartbeat. Two tiers ("warm first, then wake"): a live eligible agent with a free slot wins. If none exists after a short grace (`RUNTIME_WAKE_GRACE_SEC`, default 15), an eligible agent bound to a provisionable pool is chosen and the task becomes `pending` for it, which the supervisor (step-5) treats as demand. Done = with the flag on, a pool task is assigned within a second to a live idle worker, or after the grace to an on-demand agent, observable through the API alone (no supervisor needed). Push-mode workers (step-8) depend on this, since nobody polls the pool for them. The step also re-routes stuck wake assignments (brainstorm decision 11) and makes sleeping pool agents count as reachable, so lead triggers, Slack follow-ups, escalations and boot triage do not treat them as dead.

## Changes Required:

#### 1. Extract the routing core
**File**: `src/heartbeat/heartbeat.ts:1157` (`autoAssignPoolTasks`), new `src/be/runtime-pools/routing.ts`
**Changes**:
- Move the candidate logic into `routePoolTasks(opts: {taskIds?: string[]; now?: Date})` in `routing.ts`. Flag off: tier 1 is today's logic unchanged (`getIdleWorkersWithCapacity()` filtered by `emptyPollCount`, `agentsWithLiveRuntime()`, `isAgentEligibleForTask`, `poolTaskRunsOnHarness`, then `assignUnassignedTaskPending` CAS).
- Flag on: tier 1 means "a live free slot", not "an idle agent". `getIdleWorkersWithCapacity` selects only `status='idle'` (`src/be/db.ts:7209-7213`), so a `busy` agent with spare slots would be skipped and tier 2 would boot a runtime while a live slot exists. Build tier-1 candidates from non-lead agents with a live runtime (`agentsWithLiveRuntime()`) and headroom `maxTasks - (pending + in_progress) > 0`, any status except `offline`/`waiting_for_credentials`.
- `autoAssignPoolTasks` becomes a thin call to `routePoolTasks({})` so the heartbeat keeps its behavior when the flag is off (tier 2 disabled).
- `task.created` does not carry `status` or `offeredTo` (`src/be/db.ts:2939-2950`): listeners re-read the task by id (`getTaskById`) before deciding. Do not change the event payload in this step.
- Tier 2 (flag on only): for tasks older than `RUNTIME_WAKE_GRACE_SEC` with no tier-1 match, candidates are agents with `runtime_pool_id` set whose pool is `enabled`, has a provisioning kind (`createRuntimeProvider` traits `canProvision`, or a `kind !== 'static'` check if step-3 has not merged), and whose circuit is closed (`circuit_open_until` null or past). Same eligibility and harness filters. Skip leads for pool tasks (today's rule). Pick the agent with the most headroom: `maxTasks - (pending + in_progress)`, ties by name. Skip an agent with no headroom.
- Budget gate: call `canClaim(agentId, now, task.requestedByUserId)` before a tier-2 assignment. A refusal leaves the task unassigned (no boot is paid for a refused task).
- Tier-2 assignments set `agent_tasks.pool_wake_at = now` (column added in migration 206) so they can be told apart from human pins. Do NOT use `routingReason = "pool_wake"`: `routing_reason` has a SQL CHECK (migration 152) that rejects it, and rebuilding `agent_tasks` is out of scope (orchestrator amendment 2026-10-11). Leave `routingReason` as the routing code would set it otherwise.
- Re-route (brainstorm decision 11): a pool-wake task (`pool_wake_at` set) still `pending` `RUNTIME_WAKE_REROUTE_SEC` (default 600) after `pool_wake_at`, or whose pool's circuit is open, is released back to `unassigned` (`releaseTask`, `src/be/db.ts:3018`) and routed again (a live slot may exist by now). Human-pinned tasks are never moved.

#### 2. Triggers
**File**: `src/be/runtime-pools/routing.ts`, `src/http/index.ts` boot wiring
**Changes**: when the flag is on:
- `workflowEventBus.on("task.created")` for `status === 'unassigned'` → `routePoolTasks({taskIds:[id]})` (tier 1 now; tier 2 is picked up by the timer once grace passes).
- `releaseTask` (`src/be/db.ts:3018`) and `rejectTask` (`:3097`) → same, via `afterCommit`.
- A light timer (`RUNTIME_ROUTING_INTERVAL_MS`, default 5000) runs `routePoolTasks({})` for grace expiry and anything missed. Start/stop beside the heartbeat (`src/http/index.ts:777`, shutdown `:463`). Re-entrancy guard like `isSweeping`.

#### 3. Reachability: a sleeping pool agent is not "offline"
**File**: `src/be/runtime-pools/reachability.ts` (new), call sites below
**Changes**: Pool agents sit at `status='offline'` while asleep (created offline in step-1, set offline again at terminate in step-5). Today `offline` means "unreachable" in several gates, which breaks an on-demand lead and sleeping coders (brainstorm decision 13). Add `isAgentReachable(agent)`: not `offline`, OR (flag on AND bound to an `enabled` pool with a provisioning kind and a closed circuit). Use it at:
- `src/tools/send-task.ts:294` ("No online Lead" for user MCP).
- `src/slack/router.ts:86-99` (thread follow-up to an offline worker, fallback to the lead).
- `src/tasks/worker-follow-up.ts:144` and `src/heartbeat/heartbeat.ts:1258` (escalations skipped for offline agents).
- `src/heartbeat/heartbeat.ts:1633`, `:1658-1680` (boot triage "Orphaned Tasks NEEDS ATTENTION"): pending tasks of reachable pool agents are not orphans, so the lead does not cancel or reroute work that is waiting for a wake.
Lead wake demand itself (`pendingWorkForAgent`) is step-5's.

#### 4. Runbook
**File**: `runbooks/heartbeat-crash-recovery.md` §4 routing affinity (L330+), §5 follow-ups
**Changes**: update the mermaid + pseudocode for the two tiers, the grace, the re-route, the triggers, reachability and the flag (same-PR rule).

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-pool-routing.test.ts src/tests/heartbeat.test.ts`
- [x] `bun run test:root -- src/tests/runtime-pool-routing.test.ts` cases cover: tier 1 beats tier 2; tier 2 waits for the grace; flag off → tier 2 never runs and heartbeat behavior is identical; harness and affinity filters apply to tier 2; circuit-open and disabled pools skipped; budget refusal leaves the task unassigned; headroom choice; flag-on tier 1 picks a busy agent with a free slot over waking; `pool_wake` re-route after the timeout and on circuit open, human pins untouched; `task.created` / release / reject triggers
- [x] `bun run test:root -- src/tests/runtime-pool-reachability.test.ts` covers `isAgentReachable` and each call site: user `send-task` to a sleeping pool lead succeeds, Slack follow-up routes to a sleeping pool worker, escalation not skipped, boot triage omits pool agents' pending tasks; flag off = today's behavior
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-async-db-seam.sh` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Boot the API on a temp DB with the flag on and `RUNTIME_WAKE_GRACE_SEC=3`. Create a `docker` pool and one agent on it (`POST /api/runtime-pools/{id}/agents`). Create an unassigned pool task with curl. After about 3-8 s, `GET /api/tasks/{id}` shows `status=pending`, `agentId=<pool agent>`.
- [x] Register a live idle worker by hand (`POST /api/agents` + `/ping` loop from a small script), create another pool task: it goes to the live worker within about 1 s, not the pool agent.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-4] server-side pool routing`.
