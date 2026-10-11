---
id: step-7
name: "Push server: worker namespace + nudges"
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Push server: worker namespace + nudges

## Overview

The API publishes small **nudges** to a reserved realtime namespace `worker:<agentId>` whenever that agent has something new: work, a cancel, a steering message, or a config change. Only that agent can subscribe. Nobody can publish into it from a client. Nudges carry no work payload: DB stays the source of truth, and the worker fetches state the same way it does today (step-8). Done = a ws test client authenticated as agent X receives each nudge kind within a second of the triggering write, and agent Y cannot subscribe to X's channel. Behind `RUNTIME_POOLS_ENABLED`.

## Changes Required:

#### 1. Reserved namespace + auth
**File**: `src/kv-reserved-namespaces.ts:7-11`, `src/realtime/auth.ts:101-192`, `src/realtime/transport.ts:131`
**Changes**:
- Add the `worker` family to the reserved list.
- In `authorizeRoomNamespace`, before the generic reserved check (pattern: the `presence:comb:` allow-list, `auth.ts:109-150`): namespace `worker:<agentId>` with channel name `nudge` allows `subscribe`/`unsubscribe` only when `identity.agentId === <agentId>` (operator key + `X-Agent-ID`, or a runtime token once step-2 lands). Every write op (`publish`, `update`, `change`, `reset`, `presence`, `join`) is denied for all clients.
- Export `channelTopic(namespace, name)` (or a `workerNudgeTopic(agentId)` helper) so server code can publish.

#### 2. Nudge publisher
**File**: `src/be/worker-nudges.ts` (new, API only)
**Changes**:
- `publishWorkerNudge(agentId, nudge)` → `realtimeBus.publish(workerNudgeTopic(agentId), nudge)`. No-op when the flag is off.
- Envelope (Zod schema in `src/types.ts`, shared with step-8): `{v: 1, kind: "work" | "cancel" | "steer" | "config", taskId?: string, at: string}`.
- Always call it from `getDbClient().afterCommit(...)` (never `queueMicrotask`), so a nudge never announces uncommitted state.
- Config nudges for global scope go to every agent with a live `worker:` subscription. Track subscribed agent ids in the transport (a `Set` updated on subscribe/unsubscribe/close), exposed as `listSubscribedWorkerAgents()`.

#### 3. Hook points (one call each, after commit)
**File**: as listed
**Changes**:
- `work`: `task.created` via `workflowEventBus.on("task.created")` (`src/be/db.ts:2939-2958`). The payload has no `status` or `offeredTo`, so re-read the task by id and nudge `agentId` when `pending`, `offeredTo` when `offered`; `acceptTask` (offer → pending); `assignUnassignedTaskPending` (`src/be/db/tasks/write.ts:196`, also used by step-4 routing and the heartbeat); `postMessage` (`src/be/db.ts:3880`) for each mentioned agent; resume follow-ups created by `createResumeFollowUp` are covered by `task.created`.
- `cancel`: `cancelTask` (`src/be/db/tasks/write.ts:624`) → the task's `agentId`.
- `steer`: `createSteeringMessage` (`src/be/db.ts:1946`) → the task's `agentId`.
- `config`: `upsertSwarmConfig` / delete (`src/be/db.ts:6546`): agent scope → that agent; global or repo scope → all subscribed worker agents.

#### 4. Connection events (used by step-6 and step-8)
**File**: `src/realtime/transport.ts:179`, `:427-433`
**Changes**: emit `worker.socket.connected` / `worker.socket.disconnected` `{agentId, runtimeId?}` on the in-process bus when a socket that holds a `worker:` subscription opens or closes (`runtimeId` from `X-Runtime-Instance-ID`). No consumer in this step besides the test.

#### 5. Docs
**File**: `runbooks/runtime-providers.md` (create the file if step-3 has not merged; a "Push delivery" section)
**Changes**: namespace, envelope, hook list, "DB is truth, push is a nudge".

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/worker-nudges.test.ts src/tests/realtime-transport.test.ts src/tests/realtime-room-auth.test.ts`
- [x] `bun run test:root -- src/tests/worker-nudges.test.ts` (ws client pattern: `src/tests/realtime-transport.test.ts:133`) covers: subscribe as X ok; subscribe as Y to `worker:X` → error; client `publish` into `worker:X` → error; one nudge per hook point (task created pending, created offered, accept, pool assign, mention, cancel, steering, agent-scope config, global config to all subscribed); nudge fires only after commit (a rolled-back transaction publishes nothing); flag off → nothing published
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Boot the API on a temp DB with the flag on. Open a ws client (`bun -e` script with the `ws` package, `Authorization: Bearer $KEY`, `X-Agent-ID: <X>`), subscribe to `{namespace:"worker:<X>", name:"nudge"}`, ack frames. Create a task for X with curl, cancel it, post a steering message, upsert an agent-scope config: the client prints four nudges in order. A second client as Y gets an error subscribing to `worker:<X>`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-7] push server: worker namespace + nudges`.
