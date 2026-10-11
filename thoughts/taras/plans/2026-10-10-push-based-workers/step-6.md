---
id: step-6
name: Provision failures + runtime-death recovery
depends_on: [step-5]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Provision failures + runtime-death recovery

## Overview

Make the supervisor safe when things go wrong. Provisioning failures retry with backoff, show on the pool and controller, then fail the waiting task loudly. A pool that keeps failing opens a circuit breaker. A swarm-owned runtime that dies (exit, OOM, TTL, host loss) is detected through the provider in seconds, its token is revoked (the fence), and its in-progress tasks go to the existing crash recovery instead of waiting 5-15 min for stall thresholds. Runtimes are also rotated before their token expires. Done = each failure case from the brainstorm's "Disconnects and dead runtimes" table is reproduced in a test and in a Docker QA run, with the outcome visible through the API.

## Changes Required:

#### 1. Provision retries + timeout
**File**: `src/be/runtime-pools/supervisor.ts`
**Changes**:
- A failed `provision()` or a `provisioning` row not `active` within `RUNTIME_PROVISION_TIMEOUT_SEC` (default 300) counts as one attempt. Timeout error text: `runtime did not register within <N>s (image may lack the swarm runner, or WORKER_API_URL is unreachable)`. The timed-out runtime is terminated.
- Backoff between attempts for the same agent demand: 30 s, 90 s, 180 s. `RUNTIME_PROVISION_MAX_ATTEMPTS` (default 3). Persist the count and next-attempt time on the agent row (`agents.runtime_provision_attempts`, `agents.runtime_provision_retry_at`, added in migration 206) so backoff survives an API restart and the pruning of old runtime rows. Reset both on a successful registration and after the task is failed (orchestrator amendment 2026-10-11).
- Each failure writes `last_error`/`last_error_at` on the pool and the controller, `provision_error` on the row, and increments `runtime_pools.consecutive_failures`. A successful registration resets it to 0.
- After the last attempt: fail the agent's oldest `pending` task that triggered the demand (`failTask`, `src/be/db/tasks/write.ts:477`) with reason `provisioning failed after <n> attempts: <scrubbed error>`. The existing failure follow-up path notifies the lead.

#### 2. Circuit breaker
**File**: `src/be/runtime-pools/supervisor.ts`, `src/be/runtime-pools/routing.ts` (if step-4 merged; else only the supervisor)
**Changes**: `consecutive_failures >= RUNTIME_CIRCUIT_THRESHOLD` (default 5) sets `circuit_open_until = now + RUNTIME_CIRCUIT_OPEN_MIN` (default 10). While open: no provisioning for the pool, tier-2 routing skips it, the pool shows the reason. After it expires, one half-open attempt: success closes it, failure re-opens it.

#### 3. Runtime death → crash recovery
**File**: `src/heartbeat/heartbeat.ts:694` (`remediateCrashedWorkerTask`), `src/be/runtime-pools/recovery.ts` (new)
**Changes**:
- Export a wrapper `remediateTaskForDeadRuntime(task, reason)` from `heartbeat.ts` that builds the `RemediationOptions` (`cleanupActiveSession: true`, labels `runtime-died`) and runs the same decision path (`decideRemediation`, supersede + resume pinned to the same agent, or fail at the generation cap). No duplicated remediation logic.
- `recoverRuntime(runtimeId, reason)`: `markRuntimeTerminated` (offline + token revoke + agent status), then for each `active_sessions` row with that `runtimeInstanceId` (first reader of that column) call the wrapper. Idempotent.
- Supervisor tick: batch `controller.status()` for `active` rows of provisioning pools. `exited`/`failed`, or missing from `list()` → `recoverRuntime`. `paused` (E2B) is left to step-9.
- Hung runtime: when the stalled-task classifier remediates a task whose session's runtime belongs to a pool, also `controller.terminate()` that runtime and run `recoverRuntime` (the swarm owns it, so it may kill it). Static workers keep today's behavior.

#### 4. Push socket grace
**File**: `src/be/runtime-pools/recovery.ts`
**Changes**: on `worker.socket.disconnected` (step-7) for a runtime of a push pool, schedule a status check after `RUNTIME_SOCKET_GRACE_SEC` (default 60). Provider says running → nothing (tasks continue, the worker reconnects). Provider says gone → `recoverRuntime`. If step-7 has not merged, register the listener only when the event exists (feature-detect) and cover it in step-12.

#### 5. Token-expiry rotation
**File**: `src/be/runtime-pools/supervisor.ts`
**Changes**: a runtime whose token expires within `RUNTIME_TOKEN_ROTATE_BEFORE_MIN` (default 60): idle → terminate (demand re-provisions). Busy → `draining=1` (no new tasks), demand may provision a replacement, terminate when idle.

#### 6. Runbook
**File**: `runbooks/heartbeat-crash-recovery.md` §1a + §2
**Changes**: the death-detection path, the fence, the socket grace, the circuit breaker, the new env knobs (L608 table). Keep "current behavior only".

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-supervisor-failures.test.ts src/tests/runtime-recovery.test.ts src/tests/heartbeat.test.ts`
- [x] `bun run test:root -- src/tests/runtime-supervisor-failures.test.ts src/tests/runtime-recovery.test.ts` (fake provider) cover: provision throws → backoff schedule → task failed after N with scrubbed reason; registration timeout counts as a failure and terminates; success resets the counter; circuit opens at threshold, half-open retry, closes on success; status `exited` → task superseded with a resume pinned to the same agent, session deleted, token revoked, agent offline; missing from `list()` → same; revoked token → worker call 401 (fence); socket disconnect + provider running → no recovery; disconnect + provider gone → recovery; token rotation idle vs busy (drain)
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-async-db-seam.sh` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Docker QA (setup from step-5 QA). Bad image (`busybox`): two retries visible in `GET /api/runtime-pools/{id}` (`lastError`), then the task fails with the provisioning reason.
- [x] Mid-task kill: start a long task ("sleep 120 via bash then store-progress"), `docker kill swarm-rt-<id>`. Within one supervisor tick plus a few seconds: runtime `offline`, original task `superseded`, a resume task pending for the same agent, a new container provisioned, the resume completes.
- [x] Fence: copy the dead runtime's token, `curl -H "Authorization: Bearer <token>" $API/me` → 401.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-6] provision failures + runtime-death recovery`.
