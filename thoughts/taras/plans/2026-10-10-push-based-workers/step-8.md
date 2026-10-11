---
id: step-8
name: Worker push client + delivery mode
depends_on: [step-1, step-7]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Worker push client + delivery mode

## Overview

A worker in `push` mode keeps a socket to `/api/realtime`, subscribes to `worker:<agentId>`, and wakes on nudges instead of polling every 2 s. On each nudge, reconnect, or a slow safety tick it runs the same fetches as today (`/api/poll`, cancel check, steering, config), so the DB stays the source of truth. Workers learn their mode from the registration response (bound pool's `delivery`, else `RUNTIME_DEFAULT_DELIVERY`), and `SWARM_DELIVERY_MODE` overrides it. Done = a docker worker in push mode picks up a new task in under a second, makes about 2 idle `/api/poll` calls per minute instead of about 30, and still works after an API restart.

## Changes Required:

#### 1. Mode resolution (server)
**File**: `src/http/agents.ts:636-747`, `src/be/runtime-pools/db.ts`
**Changes**: register response adds `deliveryMode: "poll" | "push"`: `"poll"` when `RUNTIME_POOLS_ENABLED` is off; else the bound pool's `delivery` ?? `RUNTIME_DEFAULT_DELIVERY` ?? `"poll"`. Add it to the response schema. A pool `delivery` change takes effect at the worker's next re-register (the runner already re-registers on config drift, `runner.ts:5676`).

#### 2. Worker realtime client
**File**: `src/realtime/worker-client.ts` (new, worker-side, DB-free)
**Changes**:
- Bun's global `WebSocket` with headers `Authorization`, `X-Agent-ID`, `X-Runtime-Instance-ID` (URL derived from `MCP_BASE_URL`, `ws(s)://…/api/realtime`).
- Subscribe `{op:"subscribe", namespace:"worker:<agentId>", name:"nudge"}`. Send `{ack: seq}` for every server frame (the server drops clients after 128 unacked frames, `src/realtime/transport.ts:195-198`).
- Parse nudges with the shared Zod envelope from step-7. Reconnect with jittered backoff 1 s → 30 s (port of `src/realtime/browser.ts:108-133`). On every (re)connect, emit synthetic `work` + `config` nudges (replay = re-fetch).
- API: `start()`, `stop()`, `waitForNudge(kinds, timeoutMs): Promise<Nudge | null>`, `onNudge(fn)`, `isConnected()`.
- Secrets: never log headers. Log lines go through `scrubSecrets`.

#### 3. Runner branch
**File**: `src/commands/runner.ts` (`pollForTrigger` `:3305`, call site `:6651`, loop `:6519-7104`)
**Changes**: one `deliveryMode` on `RunnerState` (from register response, env override). Poll mode: no change. Push mode:
- Poll wait: call `/api/poll` once. If no trigger, `await waitForNudge(["work"], RUNNER_PUSH_SAFETY_POLL_MS)` (default 30000), then poll once again. Budget-refused backoff unchanged.
- Cancel (`reconcileActiveTasks`, `:6607`): run on a `cancel` nudge (that task only) or the safety tick, not every loop.
- Steering (`scheduleSteeringDispatch`, `:6617`): on a `steer` nudge for the task, or the safety tick.
- Config reconcile (`:6541`): on a `config` nudge or the safety tick, instead of every 10 s.
- Capacity-full and draining sleeps (`:6632`, `:7104`) wait on `waitForNudge(["work","cancel"], 1000…5000)`.
- `/ping` keeps running at least every 30 s so runtime liveness (5 min cutoff) is unaffected.
- Fallback: socket not connected for more than 60 s → behave like poll mode (warn once) until it reconnects.

#### 4. Docs
**File**: `runbooks/heartbeat-crash-recovery.md` (§1a runtime liveness: push workers ping on the 30 s safety tick, not every loop; same-PR rule), `runbooks/runtime-providers.md` (push section; create the file if step-3 has not merged), `docs-site/content/docs/(documentation)/ui/configuration.mdx` (env vars), `apps/ui/src/lib/configuration-catalog.ts` (`RUNTIME_DEFAULT_DELIVERY` if step-1 has not registered it)
**Changes**: worker env vars `SWARM_DELIVERY_MODE`, `RUNNER_PUSH_SAFETY_POLL_MS`. Note: a lead with `LEAD_MONITOR_CHANNELS=true` must use `poll` (channel activity is computed at poll time only); the runner logs a warning and forces `poll` in that case.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/worker-realtime-client.test.ts src/tests/runner-push-delivery.test.ts src/tests/runner-polling-api.test.ts src/tests/runner-slot-reconcile.test.ts src/tests/multi-runtime-registration.test.ts`
- [x] `bun run test:root -- src/tests/worker-realtime-client.test.ts` (real transport on `port: 0`): subscribe, ack, nudge delivery, reconnect after server-side close, synthetic replay nudges, backoff bounds
- [x] `bun run test:root -- src/tests/runner-push-delivery.test.ts` (fake API pattern from `runner-polling-api.test.ts`): idle push worker polls only on nudge/safety tick; cancel nudge aborts the right task; steer nudge dispatches; config nudge triggers reconcile; socket down → poll fallback; poll mode unchanged; `LEAD_MONITOR_CHANNELS` lead forced to poll
- [x] `bun run test:root -- src/tests/multi-runtime-registration.test.ts`: register response `deliveryMode` resolution (flag off, pool push, pool null + default, env override is worker-side)
- [x] `bash scripts/check-db-boundary.sh && bun run check:api-key-boundary` pass
- [x] `bun run docs:openapi` run and committed (register response gains `deliveryMode`), no diff afterwards
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] API on a temp DB with the flag on and `RUNTIME_DEFAULT_DELIVERY=push`. Run one docker worker by hand (`docker run … -e SWARM_DELIVERY_MODE=push ghcr.io/desplega-ai/agent-swarm-worker:slim`, image built from this branch with `bun run docker:build:worker:slim`). Create a task pinned to that worker's agent (`agentId` + `routingReason: "human_pinned"`; unassigned pool tasks need step-4): `startedAt - createdAt` under 1 s (compare with a poll-mode worker: about 0-2 s).
- [x] Idle for 60 s: the API log (or a request counter) shows at most 3 `GET /api/poll` from that agent.
- [x] Restart the API process: the worker reconnects and picks up a task created right after the restart.
- [x] Cancel a running task via the API: the worker aborts it within about 1 s.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-8] worker push client + delivery mode`.
