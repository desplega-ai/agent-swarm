---
id: step-5
name: Supervisor core on docker pools
depends_on: [step-1, step-2, step-3]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Supervisor core on docker pools

## Overview

The API-side reconcile loop that turns demand into runtimes. For each provisioning pool it compares desired runtimes (pending work not covered by a live free slot, plus `minRuntimes`) with actual runtimes, then provisions through the pool's controller, reaps idle or finished runtimes, and kills orphans. Each runtime has one `runtime_instances` row from request to exit, and boots with a runtime token (step-2) as its credential. Done = with the flag on, a task pinned to an agent on a `docker` pool starts a container, completes, and the container is removed after the idle timeout (or right after the task for `per-task`), with the agent shown offline afterwards. Happy path only: retries, circuit breaker, death recovery and token rotation are step-6.

This step is large (controller layer, liveness changes, runner exit, supervisor). It stays one node because none of the parts is QA-able alone. If an executor hits the 2-round limit, split along "controller layer + liveness" and "supervisor loop".

## Changes Required:

#### 1. Controller layer
**File**: `src/runtime-providers/controller.ts` (new, DB-free), `src/be/runtime-pools/controllers.ts` (new, API only)
**Changes**:
- `ControllerCommands`: `provision(req)`, `terminate(handle, reason)`, `status(handles) -> Record<externalId, RuntimeStatus>`, `list(ownerId)`, optional `renew`/`pause`/`resume` passthroughs.
- `BuiltinController` wraps a `RuntimeProvider` plus a resolved target config. Target config = controller `config` merged with the decrypted `secret_config` (`decryptSecret`, `src/be/crypto/secrets-cipher.ts:56`). These values are never written to `swarm_config`, never injected into runtime env, and go through `scrubSecrets` in every error path (register them with `registerVolatileSecret`, `src/utils/secret-scrubber.ts:1025`).
- `getControllerCommands(controllerId)` returns the builtin instance. Step-10 adds the remote branch behind the same function.
- Owner id: `ensureRuntimeOwnerId()` creates a global `swarm_config` row `runtime_owner_id` (random UUID) once. It is passed to every `provision` and `list` call.

#### 2. Runtime row lifecycle + liveness
**File**: `src/be/multi-runtime.ts`, `src/http/agents.ts:636-747`, `src/http/poll.ts:372-377`
**Changes**:
- `insertProvisioningRuntime({id, agentId, poolId, controllerId})`: explicit `status='provisioning'`, `provision_requested_at=now`.
- `expireStaleRuntimeInstances` (`:401`) skips `provisioning` rows (the supervisor owns their timeout).
- `upsertRuntimeInstance` (`:184`) adopts a `provisioning` row with the same id and agent: flips to `active`, keeps `pool_id`/`controller_id`/`external_handle`.
- Poll refuses work to a runtime with `draining=1` (`{trigger:null}`), so a runtime chosen for reaping cannot claim new work in the race window.
- New helpers: `listPoolRuntimes(poolId)`, `countCoveringRuntimes(agentId)` = live `active` + `provisioning` rows, `markRuntimeTerminated(id, reason)` = `markRuntimeInstanceOffline` + `reconcileAgentStatusFromRuntimes` + `revokeRuntimeTokensForRuntime` in one place (fixes the spike's "agent still idle after terminate").
#### 3. Demand
**File**: `src/be/runtime-pools/demand.ts` (new)
**Changes**:
- `pendingWorkForAgent(agentId)`: `pending` tasks assigned to the agent with ready dependencies, `offered` tasks to it, and unclaimed mentions (same predicate as `claimMentions`, `src/be/db.ts:4216`, read-only). This makes lead triggers wake an on-demand lead.
- `computeDesired(pool, agents)`: per agent, `uncovered = work - freeSlots(liveRuntimes)`; `desired = clamp(current + ceil(uncovered / slotsPerRuntime), minRuntimes, floor(maxTasks / slotsPerRuntime))`; then cap the pool total at `max_runtimes`. Deterministic, pure, unit-tested.

#### 4. Supervisor loop
**File**: `src/be/runtime-pools/supervisor.ts` (new), wired in `src/http/index.ts` next to the heartbeat (`:777`) and shutdown (`:463`)
**Changes**:
- `startRuntimeSupervisor(intervalMs)` / `stopRuntimeSupervisor()` / exported `reconcileOnce()`. Interval `RUNTIME_SUPERVISOR_INTERVAL_MS` (default 5000). Re-entrancy guard. Only when `RUNTIME_POOLS_ENABLED`.
- Requires multi-runtime. With `MULTI_RUNTIME_ENABLED=false`, registration overwrites `agents.maxTasks` with the runtime's slots (`src/http/agents.ts:663-672`), no runtime row is upserted (so `provisioning` never flips to `active`), and `/close` takes the whole agent offline. The supervisor refuses to start in that case, logs one error, and `/status` reports `runtime_pools.supervisor = "disabled: MULTI_RUNTIME_ENABLED=false"`.
- Debounced kick (250 ms) on `task.created` for a pool-bound agent whose task is `pending`/`offered` (the event has no `status`/`offeredTo`, `src/be/db.ts:2939-2950`, so re-read the task by id), so wake latency is not bounded by the interval.
- Per pool with `canProvision`, `enabled`:
  1. **Provision** (`desired > actual`): `canClaim(agentId, now, topTask.requestedByUserId)` first (refusal = no boot). Allocate `runtimeId`, mint runtime token, `insertProvisioningRuntime`, then `controller.provision()` with env: `MCP_BASE_URL` = controller `config.WORKER_API_URL` ?? `RUNTIME_WORKER_API_URL` ?? `getPublicMcpBaseUrl()` (`src/utils/constants.ts:71`); `AGENT_ID`; `AGENT_ROLE` (`lead` if `isLead`); `HARNESS_PROVIDER` from the agent row; `API_KEY` and `AGENT_SWARM_API_KEY` = token; `SWARM_RUNTIME_INSTANCE_ID`; `MAX_CONCURRENT_TASKS` = `slotsPerRuntime` (read by `resolveMaxConcurrent`, `src/commands/runner.ts:1209`); `SWARM_DELIVERY_MODE` (pool resolved); `SWARM_EXIT_AFTER_TASKS=1` for `per-task`; `TEMPLATE_ID` if set; then pool `env` (pool env cannot override the identity/credential keys above). Labels: runtime, pool, agent, owner. Store `external_handle`. On provision error: `markRuntimeTerminated` with the error in `provision_error` (step-6 adds retries).
  2. **Reap**: track `idle_since` per active runtime (no `active_sessions` row with its `runtimeInstanceId`). `idle` lifecycle with `idle_minutes` set: idle past the limit and not needed by `minRuntimes` → set `draining=1`, then next tick, if still idle, `controller.terminate()` + `markRuntimeTerminated`. `per-task`: a runtime that exited by itself (status `exited`) or is idle after running one task → terminate + mark.
  3. **Orphans**: `controller.list(ownerId)` minus rows not `offline` → terminate. Rows whose handle is not in `list()` and status is `exited` → `markRuntimeTerminated` (step-6 adds task recovery for the non-clean case).
- Never provisions for `static` pools. Agents with no pool are untouched.

#### 5. Runner: exit after N tasks
**File**: `src/commands/runner.ts` (main loop `:6519`, `checkCompletedProcesses` `:4975`)
**Changes**: `SWARM_EXIT_AFTER_TASKS=N` → after N tasks finish and no task is active, call `/close` and exit 0. Unset = today's behavior.

#### 6. Compose wiring
**File**: `docker-compose.local.yml`, `runbooks/runtime-providers.md`
**Changes**: commented-out docker socket mount on the API service plus `RUNTIME_POOLS_ENABLED`, `RUNTIME_WORKER_API_URL=http://api:3013`, and the network name for `DOCKER_NETWORK`. Runbook section "Docker pools in compose".

#### 7. Runbook
**File**: `runbooks/heartbeat-crash-recovery.md` §1a (L102-163)
**Changes**: `provisioning` rows (skipped by the reaper, owned by the supervisor), `draining`, terminate marks offline at once. Add the supervisor to the env knobs table (L608).

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-supervisor.test.ts src/tests/runtime-demand.test.ts src/tests/multi-runtime-registration.test.ts src/tests/runner-exit-after-tasks.test.ts src/tests/heartbeat.test.ts`
- [x] `bun run test:root -- src/tests/runtime-supervisor.test.ts` drives `reconcileOnce()` with a fake provider (in-memory `RuntimeProvider`) and covers: wake on pending task; no wake when a live free slot exists; budget refusal = no provision; dedupe (two ticks, one runtime while `provisioning`); `maxTasks/slotsPerRuntime` and `max_runtimes` caps; `minRuntimes` floor; idle reap with draining two-phase; per-task reap; orphan kill; owner filter; env contents (token, runtime id, no pool override of identity keys); terminate marks agent offline immediately; static pools never provisioned; flag off = loop not started; `MULTI_RUNTIME_ENABLED=false` = loop refuses to start with the status reason; controller secrets absent from runtime env
- [x] `bun run test:root -- src/tests/runtime-demand.test.ts` covers `pendingWorkForAgent` (pending with deps, offered, mentions) and `computeDesired` table cases
- [x] `bun run test:root -- src/tests/multi-runtime-registration.test.ts src/tests/runtime-supervisor.test.ts`: registration adopts a `provisioning` row; reaper skips `provisioning`; poll refuses a draining runtime
- [x] `bash scripts/check-db-boundary.sh && bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Local Docker/OrbStack, API on a temp DB: `RUNTIME_POOLS_ENABLED=true RUNTIME_WORKER_API_URL=http://host.docker.internal:<port> DATABASE_PATH=/tmp/rp5.sqlite PORT=<port> bun run start:http`. Create a `docker` pool (`image: ghcr.io/desplega-ai/agent-swarm-worker:slim`, `lifecycle: idle`, `idleMinutes: 1`) on `builtin-docker`, create an agent on it, create a task pinned to it ("store-progress 'pong'", `modelTier: smol`). Observe: a `swarm-rt-*` container appears (`docker ps`), the runtime row goes `provisioning → active`, the task completes, after about 1-2 min the container is gone, the runtime row is `offline`, the agent is `offline`, the token is revoked.
- [x] Same with `lifecycle: per-task` and 2 tasks: 2 containers, each exits after its task.
- [x] Orphan: start a container by hand with the swarm labels and this swarm's owner id. Within one tick it is removed.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-5] supervisor core on docker pools`.
