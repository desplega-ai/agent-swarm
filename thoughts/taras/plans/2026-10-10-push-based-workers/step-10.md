---
id: step-10
name: Remote controller
depends_on: [step-2, step-5]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-10: Remote controller

## Overview

A standalone `agent-swarm controller` process provisions runtimes on infra the API cannot reach (Docker on another host, later in-cluster k8s). It dials the API over a websocket, authenticates with a controller token, and executes `provision` / `terminate` / `status` / `list` commands on its local `RuntimeProvider`. On the API side a `RemoteController` implements the same `ControllerCommands` as the built-in one, so the supervisor does not change. Done = a pool placed on a remote docker controller provisions and reaps a runtime through the controller process, and a controller disconnect is handled with a grace period and no duplicate runtimes.

## Changes Required:

#### 1. Controller principal + token
**File**: `src/be/users.ts`, `src/http/auth.ts`, `src/utils/request-auth-context.ts`, `src/http/runtime-pools.ts`
**Changes**:
- Controller tokens reuse `session_tokens.controllerId` (migration 207 from step-2). Resolve them to `{kind: "controller", controllerId}`. A controller principal is rejected by every route except the controller ws endpoint (central check in `src/http/core.ts`). The `/api/realtime` upgrade does not pass through `core.ts` (`src/realtime/transport.ts:134-160`), so it rejects controller principals explicitly too.
- `POST /api/runtime-controllers/{id}/token` (RBAC `runtime_controller.write`, operator or user only, `placement` must be `remote`) mints a token (TTL `RUNTIME_CONTROLLER_TOKEN_TTL_DAYS`, default 90) and returns the plaintext once. Minting revokes the previous token. Controller delete revokes it.

#### 2. API-side ws endpoint + RemoteController
**File**: `src/http/controllers-connect.ts` (new), `src/be/runtime-pools/controllers.ts`, `src/http/index.ts` (upgrade wiring next to `attachRealtimeTransport`, `:435`)
**Changes**:
- Path `/api/controllers/connect`, separate from `/api/realtime`. Auth: controller token only. One live session per controller (a new connection replaces the old one).
- Protocol (Zod schemas in `src/runtime-providers/controller-protocol.ts` (new), shared with the CLI): controller → `{type:"hello", controllerId, kind, version}`; API → `{type:"cmd", id, op, payload}`; controller → `{type:"result", id, ok, result?, error?}`; ping every 15 s. Command timeout 60 s (provision may pull an image).
- On hello: controller `status='online'`, `last_seen_at`; `kind` must equal the row's kind (else close with an error and set `last_error`).
- `RemoteController` implements `ControllerCommands` over the session. `getControllerCommands(controllerId)` returns it for `placement='remote'`. When offline it throws `ControllerOfflineError`.
- Disconnect: controller `offline`. The supervisor does not provision to that pool and does not run death recovery for its runtimes during `RUNTIME_CONTROLLER_GRACE_SEC` (default 120): their rows are treated as `unknown`. After the grace: `recoverRuntime` for each (step-6 path) and fence via token revoke. A reconnect within the grace runs `list()` and reconciles: known handles stay, unknown handles with this swarm's owner id are orphans.
- `ControllerOfflineError` does not count toward the pool circuit breaker.

#### 3. CLI process
**File**: `src/commands/controller.ts` (new), `src/cli.tsx` (`COMMAND_HELP`, `printHelp()` commands array, route before `render()`)
**Changes**: `agent-swarm controller --api-url <url> --token <aseph_…> --kind docker [--docker-host unix:///var/run/docker.sock] [--docker-network <name>]` (token also via `AGENT_SWARM_CONTROLLER_TOKEN`). Builds a target config from flags/env, connects, answers commands with `createRuntimeProvider(kind)`, reconnects with jittered backoff 1 s → 30 s. Must not import `src/be/db` (add the file to the worker side of `scripts/check-db-boundary.sh` if the script needs it). Never logs the token (`scrubSecrets` on all output).

#### 4. Docs + OpenAPI
**File**: `runbooks/runtime-providers.md` (remote controller section), `runbooks/heartbeat-crash-recovery.md` §1a (controller disconnect grace → recovery and fencing; same-PR rule), `MCP.md` if a tool is added, `openapi.json` (`bun run docs:openapi`, the token route is new)
**Changes**: when to use a remote controller, minting a token, running it next to the infra, grace behavior.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-remote-controller.test.ts src/tests/runtime-controller-token.test.ts`
- [x] `bun run test:root -- src/tests/runtime-remote-controller.test.ts src/tests/runtime-controller-token.test.ts` (API on `port: 0`, in-process controller client with a fake provider) cover: hello + online; kind mismatch rejected; provision/terminate/status/list round trips; command timeout; controller token rejected on `/api/poll` and other routes; token mint revokes the previous one; lead agent mint → 403; controller token rejected on `/api/realtime`; disconnect → no provisioning and no recovery during grace; reconnect within grace keeps runtimes; grace expiry → recovery; offline errors do not trip the circuit
- [x] `bun run src/cli.tsx controller --help` prints the usage
- [x] `bun run docs:openapi` run and committed, no diff afterwards
- [x] `bash scripts/check-db-boundary.sh && bun run check:api-key-boundary && bun run check:rbac-coverage && bun run check:openapi-response-coverage` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Local Docker, API on a temp DB with the flag on. Create a `remote` docker controller, mint its token, run `bun run src/cli.tsx controller --api-url http://localhost:<port> --token <t> --kind docker` in the background. Controller shows `online`. Create a docker pool placed on it, an agent, a pinned task: a container starts through the controller process (its log shows the provision command), the task completes, the container is reaped.
- [x] Kill the controller process while a runtime is idle: controller `offline`, no new container for new demand during the grace, then restart the controller within the grace: the runtime is kept. Repeat and stay down past the grace: the runtime is recovered/fenced.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-10] remote controller`.
