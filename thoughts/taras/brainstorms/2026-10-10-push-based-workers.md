---
date: 2026-10-10
author: Taras (with Claude)
topic: "Push-based workers: spin up workers on demand and push work to them"
tags: [brainstorm, workers, dispatch, scaling, runtime]
status: complete
exploration_type: idea
last_updated: 2026-10-10
last_updated_by: Claude
---

# Push-based workers. Brainstorm

## Context

Today workers pull work. Each worker runs a long-lived loop, polls the API with its agent ID, and claims tasks assigned to it (or from the pool).

Taras wants to explore a push-based alternative. The API (or an orchestrator next to it) would spin up workers on demand and push the work to them.

Motivation (Taras): make it easy to set up a swarm where workers start on demand and receive work directly. The pull model is already mostly agent-ID based, so the "pool" benefit of pull is small in practice.

Exploration type: idea to develop. The pull model works. Push is a new capability to shape, not a fix.

### Prior art

- **`thoughts/taras/brainstorms/2026-05-12-agents-push-api-mode.md`** (parked). The main predecessor. Motivation then: serverless runners, real-time UI, resource savings. Decisions then:
  - Asymmetric inversion. The API stays gateway and DB owner. Workers expose an HTTP receiver.
  - Pluggable transport descriptor on the `agents` row (`transport_kind`, `transport_target`, `transport_meta`). Kinds: `docker-callback-url`, `cloud-run-url`, `lambda-arn`, `claude-managed`.
  - Lifetime is a property of the transport (per-task or per-agent woken on demand).
  - Workspace on a per-agent persistent volume.
  - All four API-to-worker concerns become pushes: assign, stop/kill, config refresh, user feedback.
  - `agent_outbox` table with retry, ack, per-agent FIFO, idempotent workers.
  - Deployment switch `SWARM_TRANSPORT_MODE=push|poll`.
  - Open then: wake payload shape, claude-managed mapping, volume lifecycle, a measured resource baseline.
- `thoughts/taras/brainstorms/2026-07-21-swarm-extensibility-routing.md` (parked): routing hooks on `task.before_assign`. Sandbox spawn p50 179 ms, a warm pool may be needed.
- `thoughts/taras/research/2026-04-03-paperclip-heartbeat-system.md`: Paperclip wakes agents through adapters (CLI, HTTP, process) with an `on_demand` wake reason. Reference design.
- `thoughts/taras/brainstorms/2026-10-10-computer-primitive.md`: puts the worker model out of scope. Sandboxes can be "computers" that agents drive, which is a different axis.
- `2025-12-23-worker-lead-spawn-triggers.md` and the openclaw plan: not about provisioning (false positives).

### Facts: the pull model today (codebase, 2026-10-10)

- Workers long-poll `GET /api/poll` with `X-Agent-ID` (`src/http/poll.ts:174`). 2 s interval, 60 s long-poll window (`src/commands/runner.ts:5571`).
- Capabilities, role, `maxTasks`, provider go once at registration (`POST /api/agents`). A new `AGENT_ID` auto-creates the agent row.
- Poll waterfall: offered tasks, then pending tasks assigned to this agent, then mentions/lead triggers, then pool auto-claim filtered by harness and `routingAffinity`. The heartbeat also pre-assigns pool tasks to idle workers (`autoAssignPoolTasks`, `src/heartbeat/heartbeat.ts:1113`).
- Multi-runtime is on by default. Several processes share one `AGENT_ID`, one `runtime_instances` row each (migration 132).
- Dead worker: heartbeat sweep every 90 s, stall thresholds 5/15/30 min, `remediateCrashedWorkerTask` supersedes with a resume task pinned to the same agent for a grace window.
- Durable identity is keyed by `AGENT_ID`. Profile (`claudeMd`, `soulMd`, `identityMd`, `setupScript`, `toolsMd`, ...), memory, agent-scoped skills and config all live server-side. They survive worker death.
- Workspace (repo clones, `/workspace`) is worker-local. The k8s chart gives each pod a PVC.
- Native session resume is gone. Follow-ups rebuild context via `src/commands/context-preamble.ts`, so a fresh worker can continue a task with no local session state.

### Facts: existing on-demand pieces

- **E2B:** an operator CLI (`src/commands/e2b.ts`, `src/e2b/dispatch.ts`). The API never calls it. Sandboxes boot and then poll. Default agent ID `e2b-<sandbox-id>`, TTL 3600 s.
- **claude-managed / devin:** the session runs remotely, but a long-lived local worker still polls and then relays to the vendor API.
- **k8s chart:** fixed replicas per pool StatefulSet. No HPA/KEDA. Docs only advise queue-depth autoscaling.
- **No server-initiated dispatch exists:** no API-to-worker push, no worker HTTP receiver, no outbox, no autoscaler.
- **Templates** (`templates/official/*`, registry at templates.agent-swarm.dev) already act as a worker blueprint. A worker boots with `TEMPLATE_ID` and pulls profile files + `agentDefaults`. Applied worker-side. No server-side "create agent from template" API.

## Exploration

### Q: What must be pushed: the runtime (API starts a worker when work exists) or the task itself (API delivers work to a worker)?
Both. Today's docker-compose setup (long-lived workers) should receive work by push instead of poll. On top, an infra abstraction is baked in, so on-demand workers work too.

**Insights:** Two separate pieces, and they compose:
1. **Delivery:** how work reaches a worker that exists. Push replaces poll for every worker, long-lived included.
2. **Provisioning:** an infra abstraction the API uses to start a worker when work exists and none is live. Docker compose is one backend (or a "static" backend that never provisions).
The May brainstorm bundled these into one transport descriptor. Splitting them lets compose users get push delivery without any provisioning, and lets provisioning reuse the same delivery path.

### Q: For push delivery, who opens the connection?
Worker dials, API pushes. The worker opens a persistent connection (WebSocket/SSE) to the API at boot. The API pushes assign, stop, config and steer events over it. On-demand workers get their first task in the boot payload and then attach.

Follow-up from Taras: "imagine if the API is running in Vercel (for example), and the workers run in E2B, or even some in k8s, some in E2B, etc."

**Insights:**
- Worker-dials works for any worker placement (compose, k8s, E2B, behind NAT). No inbound port, no callback-URL auth.
- Heterogeneous placement (some workers in k8s, some in E2B, some in compose) fits the split from Q1: each worker group has a provisioning backend, and all share one delivery channel.
- **Tension: a serverless API (Vercel) cannot hold persistent worker connections.** Vercel functions are request-scoped, so the "API pushes over a held socket" model needs a broker outside the API (Redis pub/sub, Ably, a small relay), or the push becomes "API invokes the provider with the payload".
- **Facts (2026-10-10):** the API is stateful today, beyond the socket question:
  - SQLite file DB only. No Postgres or other networked DB adapter in `src/be` (grep for postgres / DATABASE_URL / libsql / turso: no hits).
  - In-process timers drive the heartbeat (`src/heartbeat/heartbeat.ts:1879`, `:2000`) and the scheduler (`src/scheduler/scheduler.ts:535`).
  - The `/api/realtime` ws hub lives in the API process.
  So "API on Vercel" is a separate, larger migration (networked DB, external cron, external broker), not a side effect of push delivery.

### Q: Is a serverless API in scope, or is mixed worker placement the real goal?
Mixed workers only. The API stays a long-lived process. The goal is workers anywhere (k8s, E2B, compose) under one API, provisioned per group, receiving work over a worker-dialed socket. A serverless API is a separate future project.

**Insights:** The worker-dials channel decision stands unchanged. Vercel was an illustration of "API and workers live in different places", which the long-lived API already supports, since workers only need outbound HTTPS to it.

### Q: What does the API provision when work arrives: compute for an existing agent, or a fresh agent?
A runtime for a durable agent. The agent is the durable identity (profile, memory, skills, routing). The runtime is disposable compute. Work routes to agent X. If X has no live runtime, X's bound backend starts one. Scale-out means more runtimes for the same agent.

**Insights:**
- This maps onto what exists: `agents` row = identity, `runtime_instances` row = compute (migration 132, multi-runtime on by default). No new identity concept.
- New per-agent fact needed: which backend provisions its runtimes (a binding from agent to backend, for example "coder -> k8s pool A", "researcher -> E2B").
- Profile and memory are already server-side and synced at boot, and follow-ups rebuild context via the preamble. So a fresh runtime can pick up any task for its agent.
- Workspace is the one piece of agent state that is worker-local. On-demand runtimes need a policy for it (open branch).

### Q: When does the API wake a runtime, and can unassigned pool tasks go to a sleeping agent?
Warm first, then wake. Wake fires when a task is pending for agent X and X has no live runtime with a free slot. Pool routing treats on-demand agents as eligible, but prefers agents with a live free slot. It wakes only when nothing live fits.

**Insights:**
- Two eligibility tiers in routing: "live with free slot" beats "sleeping but wakeable". Today `autoAssignPoolTasks` (`src/heartbeat/heartbeat.ts:1113`) only considers live idle workers, and pool claims happen at poll time. With push, the API must make the pool decision itself, since nobody polls.
- Consequence: with push delivery, routing moves fully server-side. The poll waterfall (`src/http/poll.ts`) turns into an "assign and push" step that runs on task create / task release / runtime attach. This lines up with the `task.before_assign` edge idea from the 2026-07-21 extensibility brainstorm.
- Wake needs dedupe: two tasks for the same sleeping agent must not start two runtimes unless the scale-out policy says so. A "provisioning" runtime state (requested, not yet attached) is needed.

### Q: How does an on-demand runtime end?
Idle timeout per binding is the default. The binding can also select "exit after each task". Example from Taras: with E2B, run X task sandboxes, one per task.

**Insights:**
- Lifecycle is a binding setting with two modes: `idle` (exit after N minutes without tasks, `never` for static compose/k8s) and `per-task` (one runtime per task, exits on completion).
- `per-task` makes scale-out the normal case: 5 pending tasks for the coder agent means 5 sandboxes. The concurrency cap therefore matters more than in the idle mode.
- Backend hard limits (E2B TTL, k8s quotas) still apply on top.
- Pause/resume (E2B pause, k8s scale-to-0 with PVC) was not chosen. It stays a possible later backend optimization for wake latency and workspace reuse.

### Q: How is concurrency capped when runtimes scale out?
`agents.maxTasks` stays the agent's total concurrent-task cap. The binding sets `slotsPerRuntime` (1 for per-task sandboxes, N for a long-lived worker). The API starts enough runtimes to cover pending tasks, never above `maxTasks / slotsPerRuntime`. An optional binding-level `maxRuntimes` gives a cost ceiling across agents that share a backend.

**Insights:**
- Reuses the existing cap and the existing `runtime_instances.reported_slots` field. Capacity math stays server-side, as `hasCapacity` already is.
- Interaction with budgets: `canClaim` (budget gate) runs before a task starts today. Wake must run the same gate before provisioning, or a refused task still costs a sandbox boot.

### Q: What happens to the workspace for on-demand runtimes?
Fresh by default, volume optional. Each runtime boots with an empty workspace and clones what it needs. Durable output goes through git push, agent-fs and memory, as today. A backend may mount a per-agent volume (for example a k8s PVC) as an opt-in speed-up. No volume lifecycle or GC in v1.

**Insights:**
- Drops the May 2026 "per-agent persistent volume" decision. That decision also breaks with parallel per-task runtimes, which would write the same volume.
- Cost moves to wake latency: clone time on every cold start. Mitigations later: shallow clones, a prebuilt image per repo (E2B template), or the opt-in volume.
- Dev servers and watchers do not survive a runtime exit. Agents that need them use an `idle: never` binding.

### Q: Where do backend definitions and agent-to-backend bindings live?
A server-side DB entity, defined like harnesses. Example from Taras: "I want the k8s / E2B backend to use this base image instead."

**Insights:**
- Two layers, mirroring `HARNESS_PROVIDER`:
  - **Backend kind** (code): a pluggable adapter per infrastructure (compose-static, docker, k8s, e2b, ...). Contract roughly `provision(spec) -> handle`, `terminate(handle)`, `status(handle)`.
  - **Runtime pool** (DB row): one configured instance of a kind. Holds base image / E2B template, lifecycle (`idle: N min | never` or `per-task`), `slotsPerRuntime`, `maxRuntimes`, env, and credential refs into the encrypted secrets store.
- Agents reference a pool. Several agents can share a pool (for example one E2B pool for all researchers).
- Managed through API, MCP and UI, RBAC-gated, live-editable. Env can seed a default pool so plain compose installs need no setup.
- The image override is per pool, so "use this base image for k8s" is one field edit, not a redeploy.

### Q: What happens to the poll endpoint once push exists?
Support both, as a deployment-wide switch (the May 2026 `SWARM_TRANSPORT_MODE=push|poll` shape). Claude recommended "keep poll as a fallback transport inside one model". Taras chose the explicit switch.

**Insights:**
- Cost: two delivery code paths, both need tests. Default stays `poll`, so existing installs see no change.
- Claude's assumption (to confirm in planning): provisioning (runtime pools) is orthogonal to the switch. In `poll` mode a provisioned runtime boots and polls, which is how E2B dispatch already works. In `push` mode it boots and dials the socket. So on-demand workers do not require push mode.
- In `push` mode routing is fully server-side (see the wake-rule insight). In `poll` mode the current poll waterfall stays. The planner should check how much of the server-side assign step both modes can share, to keep the two paths thin.

### Q: What credential does an on-demand runtime get?
A scoped per-runtime token, bound to (agentId, runtimeId), injected by the backend at provision time and revoked on teardown. Taras asked if the user-token mechanism already covers this.

**Facts (codebase, 2026-10-10):**
- User tokens (`aswt_`, `user_tokens`, migration 067) authenticate as a **user**, scoped by that user's RBAC grant. No agent binding, no expiry. Not the right fit.
- `src/http/api-keys.ts` is the provider credential pool (Anthropic/Codex keys), not swarm auth.
- **Session tokens (`aseph_`, migration 149) are the closest fit.** They resolve to `{kind:"agent", agentId, taskId}`, are hashed, have a mandatory `expiresAt`, and can be revoked (`src/be/users.ts:545-610`). Minted via `POST /api/sessions/tokens` (operator only, max TTL 7 days, `src/http/sessions.ts:78-212`). Only the ACP adapter uses them today.
- With the swarm key, any caller can claim any `X-Agent-ID` (`src/http/index.ts:332`, `src/http/request-principal.ts:29-32`). Only `/mcp` rejects an `X-Agent-ID` that differs from the token binding (`src/http/mcp.ts:99-114`). `/api/poll` and most REST handlers read the header without a cross-check.

**Insights:** Reuse `aseph_` rather than build new auth. Gaps to close:
1. Binding is (agentId, taskId). A runtime serves many tasks, so it needs an agent-scoped variant (nullable `taskId` or a runtime kind bound to `runtimeId`).
2. Move the X-Agent-ID binding check from `mcp.ts` to the central auth path, so poll, tasks, progress and heartbeat cannot be spoofed with an agent token.
3. Worker code calls `getApiKey()`. It must accept the injected agent token instead.
4. The provisioner mints at provision time and revokes on teardown.
5. Find which worker-needed routes (register, config) require operator scope today and would reject an agent principal.

### Q: Does the lead follow the same model, or stay always-on?
Same as any other agent: the lead can be fully on-demand.

**Insights:**
- No lead special case in the pool model. A lead bound to an `idle: never` pool behaves like today.
- A lead on an on-demand pool means every lead trigger becomes a wake source: Slack messages, mentions, escalations from `escalateStarvedPoolTasks`, HITL follow-ups, channel activity. Today several of these are produced at poll time for the lead (the poll waterfall step 3/4). In push mode they must become server-side "pending work for agent X" so the wake rule sees them.
- Cost: a Slack reply to a sleeping lead waits on a cold start plus clone. Operators who care pick `idle: never` for the lead.
- Single-lead invariant (`src/tools/join-swarm.ts:100`) must hold across runtimes: a lead pool scales to at most one agent, though multi-runtime for that agent may still apply.

### Q: Which backend kinds ship in v1?
static + docker + e2b, with k8s as the next adapter. Taras asked for the difference between static and docker, and raised a new layer: the **controller / supervisor**, the service that lets the API control an infra provider (Docker socket, k8s API, ...). It should be an N-M relationship that composes easily.

**static vs docker:**
- `static`: the operator starts the workers (compose, helm StatefulSet, a laptop). The API never starts or stops them. They register and receive work. This is today's model, kept as a pool kind so static and on-demand agents share one config surface.
- `docker`: the API asks a Docker daemon to start and stop worker containers on demand. Same image as static, but the lifecycle is owned by the swarm.

**Insights on the controller layer:**
- The provider adapter needs a place to run with access to the infra. The Docker socket is on one host, the k8s API is inside (or reachable from) a cluster, E2B is a public REST API. These are often not where the API runs.
- So a third concept emerges between pools and infra:
  - **Provider adapter** (code): docker, k8s, e2b, ... (the "backend kind" from before).
  - **Controller** (a running thing with credentials to one infra target): "docker socket on host A", "k8s cluster B, namespace swarm", "E2B team X".
  - **Pool** (config): image, lifecycle, slots, caps. Placed on one or more controllers.
- N-M reading: one controller serves many pools, and one pool can use several controllers (for example k8s first, spill to E2B when the cluster is full).
- A remote controller can reuse the worker-dials channel: it connects out to the API and receives `provision` / `terminate` commands. Then the API never needs inbound access to any infra, which is the same property chosen for workers.

### Q: Where does a controller run?
Built-in and remote, with the same contract. The API hosts built-in controllers for providers it can reach (E2B over HTTPS, a reachable k8s API, the local Docker socket in compose). A small standalone `swarm-controller` process (same CLI and image) dials the API for infra the API cannot reach (Docker on another host, in-cluster k8s). Both register as controllers and take the same commands.

**Insights:**
- A one-box compose install stays one box: the built-in docker controller uses the mounted socket.
- Infra credentials can stay out of the API when an operator prefers: run a remote controller next to the infra and give the API only the controller's identity.
- Controllers need identity, liveness and auth like workers: a controller token (same `aseph_`-style scoped token, kind = controller), a presence row, and a disconnect = "can't provision here" signal.
- Controller capacity (free k8s quota, E2B concurrency limit) becomes an input to placement.

### Q: When a pool could use several controllers, how does the API pick one?
Start simple: one controller per pool in v1. Multi-controller placement (for example "k8s first, spill to E2B") is v2. The data model stays open to it (a placement list with one entry in v1).

Taras also asked: does the API run on a single node only? And could the lead be pull-based while coders are on demand?

**Insights:**
- **Single node: yes, today.** SQLite single writer, in-process heartbeat and scheduler timers, in-process ws hub, and the k8s chart pins the API to `replicas: 1`. This design keeps that. Controllers and workers can be anywhere. Only the API is one node.
- **Lead pull-based + coders on demand: yes, and Claude thinks it is the best default topology.** The lead is the latency-sensitive agent (Slack replies, routing). Coders are bursty and benefit most from on-demand. It works today-compatible: the lead runs as a `static` pool on poll, coders run on a `docker` / `e2b` pool.
- This conflicts with the earlier deployment-wide `push|poll` switch. "Lead polls, coders get push" needs the delivery mode per pool, not per deployment. (With the switch on `poll`, the topology still works: on-demand coders boot and poll, like E2B dispatch today.)

### Q: Move the push/poll choice from a deployment switch to a per-pool setting?
Per pool. Each pool sets `delivery: poll | push`. A deployment env var only sets the default for pools that do not set it. This replaces the deployment-wide switch decided earlier.

**Insights:** Same two delivery code paths, chosen per pool. Example topology in one swarm: lead on a `static` pool with `poll`, coders on an `e2b` pool with `push` and `per-task` lifecycle.

### Q: What is the delivery guarantee for pushed work?
DB is truth, push is a nudge. Assignment stays a DB state, as today. The push only says "you have work". The worker acks by starting the task (existing `startTask`). On every connect or reconnect, the API replays all assigned-but-not-started work. Work not started after T seconds is unassigned and routed again.

**Insights:**
- Drops the May 2026 `agent_outbox` table. Push and poll then read the same DB state, which keeps the two delivery paths thin: poll = "worker asks", push = "API tells, worker fetches the same thing".
- Idempotency comes free: `startTask` is already an atomic state change, so a duplicate nudge is a no-op.
- Liveness bonus: a socket disconnect is an immediate signal. It can shorten the 5/15/30 min stall thresholds for push pools (the planner must update `runbooks/heartbeat-crash-recovery.md` in the same PR).
- Non-task events (stop, config refresh, steer) follow the same rule: the DB holds the state (cancel flag, config version, steering queue), the push is a nudge, and reconnect replays.

### Q: What happens when provisioning fails?
Retry, then fail the task loudly. The task stays pending while the API retries with backoff (for example 3 tries over about 5 minutes). Each failure shows on the pool and controller in the UI. After the last try, the task fails with the provisioning error, and the lead gets the usual failure follow-up. A pool that keeps failing stops being woken (circuit breaker) until it recovers.

**Insights:** The budget gate (`canClaim`) runs before the first provisioning attempt, so a budget refusal never costs a boot.

## Synthesis

### The model in one picture

```
agent (durable identity: profile, memory, skills, routing)
  └─ bound to ─> pool (config: provider kind, image/template, lifecycle, slotsPerRuntime, maxRuntimes, delivery: poll|push)
                    └─ placed on ─> controller (running thing with creds to one infra target; built-in or remote)
                                       └─ starts/stops ─> runtime (disposable compute, one runtime_instances row)
```

Example swarm: lead on a `static` pool with `poll` (always on). Coders on an `e2b` pool with `push` and `per-task` lifecycle (one sandbox per task, up to `maxTasks`). Researchers on a `docker` pool with `idle: 10 min`.

### Interfaces (mirrors the harness-provider shape)

Harness providers today (`src/providers/types.ts`): `ProviderAdapter` with `name`, `traits`, `createSession()`. A lazy `switch` in `createProviderAdapter(name)` (`src/providers/index.ts:24`) picks the adapter. `ProviderNameSchema` validates names, and `src/tests/provider-registration.test.ts` checks every touch point. Runtime providers copy that shape one to one:

| Harness providers | Runtime providers |
|---|---|
| `ProviderAdapter` | `RuntimeProvider` |
| `createProviderAdapter(name)` lazy switch | `createRuntimeProvider(kind)` lazy switch |
| `ProviderNameSchema` | `RuntimeProviderKindSchema` |
| `ProviderTraits` | `RuntimeProviderTraits` |
| `checkCredentials(env) -> CredStatus` | `checkConfig(config) -> ConfigStatus` |
| `provider-registration.test.ts` | `runtime-provider-registration.test.ts` |
| `runbooks/harness-providers.md` | `runbooks/runtime-providers.md` |

**Runtime provider: one adapter per infra kind. DB-free, runs in the API or in a remote controller.**

```ts
// src/runtime-providers/types.ts
export type RuntimeProviderKind = "static" | "docker" | "e2b" | "k8s";

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly traits: RuntimeProviderTraits;
  /** Validate controller + pool config before use (like checkCredentials). */
  checkConfig(config: RuntimeTargetConfig): ConfigStatus;
  /** Start one runtime. Resolves when the infra accepted it, not when the worker registered. */
  provision(req: ProvisionRequest): Promise<RuntimeHandle>;
  terminate(handle: RuntimeHandle, reason: string): Promise<void>;
  status(handle: RuntimeHandle): Promise<RuntimeStatus>;
  /** Every runtime this provider owns on the target, found by swarm labels. Reconcile finds orphans with it. */
  list(target: RuntimeTargetConfig): Promise<RuntimeHandle[]>;
}

export interface RuntimeProviderTraits {
  canProvision: boolean;   // false for "static": operator-managed, never started by the swarm
  ephemeralDisk: boolean;  // workspace is gone on exit
  supportsPause: boolean;  // later: E2B pause/resume
  maxTtlSec?: number;      // provider hard cap (E2B)
}

export interface ProvisionRequest {
  runtimeId: string;       // pre-allocated runtime_instances id
  agentId: string;
  poolId: string;
  image: string;           // docker image | E2B template | k8s image
  env: Record<string, string>; // MCP_BASE_URL, AGENT_ID, RUNTIME_ID, scoped token, INITIAL_TASK_ID, pool env
  resources?: { cpu?: number; memoryMb?: number };
  ttlSec?: number;
  labels: Record<string, string>; // swarm.runtime-id, swarm.pool-id, swarm.agent-id
}

export interface RuntimeHandle {
  kind: RuntimeProviderKind;
  controllerId: string;
  externalId: string;      // container id | sandbox id | pod name
  meta?: Record<string, string>;
}

export type RuntimeStatus = "starting" | "running" | "exited" | "failed" | "unknown";
```

**Controller: a running host for one provider plus credentials to one target.** The provider code is the same in both placements. Only the transport differs.

```ts
// src/runtime-providers/controller.ts
export interface ControllerCommands {   // what the API asks a controller to do
  provision(req: ProvisionRequest): Promise<RuntimeHandle>;
  terminate(handle: RuntimeHandle, reason: string): Promise<void>;
  status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>>;
  list(): Promise<RuntimeHandle[]>;
}
// BuiltinController: in-process, wraps a RuntimeProvider directly.
// RemoteController: the API side of a ws session. A `swarm-controller` process
//   dials /api/controllers/connect, receives {op, id, payload} commands, runs them
//   on its local RuntimeProvider, and replies {id, ok, result | error}.
```

**Supervisor: the API-side reconcile loop. It owns the DB and decides what should run.** Shape is a k8s-style reconcile. It compares desired runtimes (demand) with actual runtimes (`runtime_instances` + `list()`), then provisions, reaps idle runtimes, and kills orphans.

```ts
// src/be/runtime-pools/supervisor.ts (API only)
for each pool with canProvision:
  demand  = pending tasks for the pool's agents that no live free slot covers   // warm first, then wake
  desired = min(ceil(demand / slotsPerRuntime), maxTasks / slotsPerRuntime, pool.maxRuntimes)
  actual  = runtimes in provisioning | running
  if desired > actual: budget gate -> mint token -> insert runtime row (provisioning) -> controller.provision()
  reap runtimes idle past pool.idleMinutes (or done, for per-task) -> controller.terminate() -> revoke token
  orphans = controller.list() minus known rows -> terminate
```

**Where it lives** (follows the existing `src/extensions/` + `src/be/extensions/` + `src/http/extensions.ts` split):

```
src/runtime-providers/          DB-free. Interface, lazy switch, adapters. Also used by the remote controller.
  types.ts  index.ts  static.ts  docker.ts  e2b.ts  k8s.ts  controller.ts
  docker.ts -> Docker Engine API over the unix socket with fetch (no dockerode dependency)
  e2b.ts    -> wraps src/e2b/dispatch.ts (createSandbox / killSandbox / listSandboxes are DB-free and reusable as-is)
src/be/runtime-pools/           API only. db.ts (pools, controllers, runtime rows via getDbClient), supervisor.ts, demand.ts
src/be/migrations/NNN_runtime_pools.sql   runtime_pools, runtime_controllers, agents.runtime_pool_id, runtime_instances.{pool_id, external_handle, provision_state}
src/http/runtime-pools.ts       route() handlers for pools and controllers, RBAC + response schemas
src/http/controllers-connect.ts ws endpoint for remote controllers (and later push-mode workers)
src/tools/runtime-pool-*.ts     MCP tools (register in SDK_TOOL_NAME_MAP or EXCLUDED_TOOLS)
src/commands/controller.ts      `agent-swarm controller` CLI: the remote controller process
runbooks/runtime-providers.md   same-PR doc rule + "adding a provider" checklist
```

`src/runtime-providers/` stays out of `src/providers/` on purpose. That directory is the worker-side harness tree, and the name clash would confuse both.

### Key Decisions

1. **Two separate pieces that compose:** delivery (how work reaches a live worker) and provisioning (starting a worker when work exists and none is live).
2. **Push channel: the worker dials, the API pushes** over a persistent socket (reuse the `/api/realtime` ws hub). No inbound ports, no callback URLs. On-demand runtimes get their first task in the boot payload.
3. **The API stays one long-lived node.** Mixed worker placement (compose, k8s, E2B) is the goal. A serverless API (Vercel-style) is a separate future project.
4. **Provision a runtime for a durable agent,** not a fresh agent per task. Agent = identity. Runtime = compute. Scale-out = more runtimes for the same agent.
5. **Wake rule: warm first, then wake.** Wake when a task is pending for agent X and no live runtime of X has a free slot. Pool routing prefers live free slots and wakes only when nothing live fits. Wake is deduplicated through a "provisioning" runtime state.
6. **Lifecycle per pool:** `idle` (exit after N minutes, `never` for static) by default, or `per-task` (one runtime per task, for example X E2B sandboxes).
7. **Concurrency:** `agents.maxTasks` stays the total cap. Pool sets `slotsPerRuntime`. Optional pool `maxRuntimes` as a cost ceiling.
8. **Workspace: fresh by default.** Durable output goes through git, agent-fs and memory. A per-agent volume is an opt-in backend feature. No volume lifecycle in v1. (Replaces the May 2026 volume decision.)
9. **Configuration is a DB entity, defined like harnesses.** Provider kinds are code adapters. Pools are DB rows (image override, lifecycle, caps, credential refs into the secrets store), managed via API, MCP and UI, RBAC-gated. Env seeds a default pool for compose.
10. **Delivery mode per pool:** `poll | push`. A deployment env var sets only the default. Lead-polls + coders-pushed in one swarm is supported.
11. **Delivery guarantee: DB is truth, push is a nudge.** The worker acks by starting the task. Reconnect replays all assigned-but-not-started work. Unstarted after T seconds = route again. No outbox table. (Replaces the May 2026 outbox decision.) Stop, config and steer events follow the same rule.
12. **Runtime credential: a scoped token** bound to the agent (and runtime), minted at provision time, revoked at teardown. Build on the existing `aseph_` session tokens.
13. **The lead is an agent like any other.** It can sit on an on-demand pool. Lead triggers (Slack, mentions, escalations, HITL) then become wake sources. An `idle: never` pool reproduces today's behavior.
14. **v1 provider kinds: `static`, `docker`, `e2b`.** `k8s` is the next adapter.
15. **Controllers: built-in and remote, same contract.** Built-in controllers run in the API for reachable infra (E2B, local Docker socket). A standalone `swarm-controller` dials the API for infra the API cannot reach. Controllers have identity, a scoped token and presence.
16. **One controller per pool in v1.** The data model keeps a placement list, so v2 can add "k8s first, spill to E2B".
17. **Provisioning failure:** retry with backoff, show the error on pool and controller, then fail the task loudly. Circuit breaker on a pool that keeps failing. The budget gate runs before provisioning.
- **Deferred:** warm pool / `minRuntimes` (wake latency). Defaulting to 0 (pure on-demand) unless revisited. Clone time on cold start is the main latency cost.
- **Deferred:** pause/resume on idle (E2B pause, k8s scale-to-0 with PVC). Defaulting to exit-on-idle unless revisited.
- **Deferred:** multi-controller placement strategies (ordered spill-over, weighted). v2.
- **Deferred:** serverless API (networked DB, external cron, external broker). Separate project.

### Open Questions: resolved (2026-10-10, review round 1)

Each item lists the facts found in the code, then the decision.

1. **Shared assign step.**
   - Facts: offered, pending and pool-claim triggers already come from DB state (`src/http/poll.ts:392-662`). The budget gate (`canClaim`) runs on a persisted candidate. `autoAssignPoolTasks` already writes `pending` (`src/heartbeat/heartbeat.ts:1113`). Mentions are persisted in `channel_messages`. Only `channel_activity` is computed at poll time, through a live Slack call (`poll.ts:695-761`). Escalations, follow-ups and budget follow-ups are persisted lead tasks.
   - **Decision:** extract one server-side `assignWork(agentId)` (offered, pending, pool claim, budget gate) and share it. Poll calls it inline, so poll behavior does not change. Push mode calls it on task create, task release and runtime attach, then sends a nudge. `channel_activity` stays poll-only in v1: a lead with `LEAD_MONITOR_CHANNELS=true` must use `poll` delivery. A server-side Slack timer comes later.
2. **Worker socket.**
   - Facts: `/api/realtime` (`src/realtime/transport.ts:134-160`) already accepts an operator key plus `X-Agent-ID` (identity `agent`). It has pub/sub channels, and the server can publish (`realtimeBus.publish`). Gaps:
     - subscribe reads are open on non-reserved namespaces;
     - the bus is in-process with no replay;
     - only the browser SDK reconnects;
     - an `aseph_` token does not yield an agent identity there.
   - **Decision:** reuse the hub with a reserved `worker:<agentId>` namespace. Only that agent (or its runtime token) can subscribe to it. The server publishes nudges there. Replay is not needed: on reconnect, the worker triggers `assignWork()`. Add a small worker-side reconnect client.
3. **Runtime token.**
   - Facts: `aseph_` exists since #1417 (2026-09-14) for the ACP harness only. ACP hands MCP credentials to a third-party agent binary. So the worker exchanges the operator key for a 24 h token bound to (agentId, taskId), and revokes it when the session ends. `taskId` is NOT NULL (migration 149). `/mcp` requires both `X-Agent-ID` and `X-Source-Task-Id` to match the token (`src/http/mcp.ts:99-114`).
   - **Decision:** extend `session_tokens`. A new migration makes `taskId` nullable and adds `runtimeId`. A token with no `taskId` is a runtime token: it is bound to the agent and valid for any task of that agent. The `X-Agent-ID` binding check moves from `mcp.ts` to the central auth path. The realtime hub learns to read the agent from the token. The token is revoked on terminate.
   - Unverified: whether every boot-time route (register, config, session logs) accepts an agent principal. Test it with a real call in the plan.
4. **First task for a new runtime.**
   - Facts: the runner has no "start with task X" env. Before the first poll, boot runs the entrypoint: repo clones, setup scripts, `npx skills` installs (`docker-entrypoint.sh:784-1044`). Then it registers and waits for credentials.
   - **Decision:** no special path. The task is already pending-assigned in the DB before provisioning. The first poll or socket connect runs `assignWork()` and returns it.
5. **Provisioning state.**
   - Facts: `runtime_instances.status` is a Zod-only enum (`active | offline`, `src/types.ts:1967`) with no SQL CHECK. Rows are created on registration. Rows are reaped after `RUNTIME_STALE_THRESHOLD_MIN` (5 min). `upsertRuntimeInstance` forces `active`. `reported_slots` is informational only.
   - **Decision:** reuse `runtime_instances`, one row from request to exit:
     - The supervisor pre-inserts the row (`provisioning`, `pool_id`, external handle).
     - The worker registers with `RUNTIME_ID`, which flips the row to `active`.
     - The reaper skips `provisioning` rows. A separate provision timeout fails them.
     - The liveness and capacity helpers count `provisioning` rows, so wake dedupe works.
6. **Templates.**
   - Facts: `TEMPLATE_ID` is applied only by the worker at boot (`runner.ts:5577`). Template files are fallbacks when the DB profile is empty. The `agents` row stores no template reference.
   - **Decision:** a pool's env map may set `TEMPLATE_ID` like any other env var. The first runtime seeds the agent profile from it, and the DB profile wins afterwards. Server-side "create agent from template" stays a separate feature.
7. **Cold start per provider:** measured by the spike. See "Spike results" below.

### Constraints Identified

- DB-ownership invariant holds. Controllers and workers talk to the API over HTTP/ws only. Pools, controllers and runtime state live in the API DB.
- The API is a single node (SQLite single writer, in-process timers, in-process ws hub, chart `replicas: 1`).
- X-Agent-ID is self-declared with the swarm key today. Agent-scoped tokens only help after the binding check moves from `mcp.ts` to the central auth path.
- Single-lead invariant (`src/tools/join-swarm.ts:100`) must hold with on-demand and multi-runtime leads.
- Heartbeat and crash-recovery changes must update `runbooks/heartbeat-crash-recovery.md` in the same PR.
- New migrations must follow the ordinal rules (`scripts/check-migration-conflicts.sh`). New REST routes use `route()` with RBAC posture and response schemas.
- Pool credentials go through the encrypted secrets store and `scrubSecrets` at every egress.
- Existing installs must see no change: the default pool is `static` + `poll`.

### Core Requirements

- An operator can define a pool (provider kind, image or template, lifecycle, slots, caps, delivery mode) and bind agents to it, via API, MCP and UI.
- When work exists for an agent with no live free slot, the API starts a runtime through the pool's controller, within `maxTasks` and `maxRuntimes`, after the budget gate.
- A runtime boots with a scoped token and its first task, and either polls or dials the socket per the pool's delivery mode.
- A push-mode worker receives assign, stop, config and steer nudges. On reconnect it receives all pending state.
- An idle runtime exits per its pool lifecycle. A `per-task` runtime exits when its task finishes. Its token is revoked.
- Provisioning failures are visible on the pool and controller, are retried, and finally fail the task with a clear reason.
- A remote `swarm-controller` can register with the API and provision on infra the API cannot reach, with the same contract as a built-in controller.
- Static compose and k8s workers keep working unchanged.

## Spike results (2026-10-10)

The spike checks the provisioning half only. Delivery stays pull: the worker boots from the stock image and polls.

**Code:**
- `src/runtime-providers/{types,index,docker,e2b}.ts`: the `RuntimeProvider` interface, a lazy factory, and two adapters.
  - `docker` uses the Docker Engine API over the unix socket with Bun `fetch`. No new dependency.
  - `e2b` wraps `src/e2b/dispatch.ts` unchanged.
- `scripts/spike-runtime-providers.ts` plays the supervisor by hand:
  1. Create a task pinned to a new agent id. No agent row and no runtime exist yet.
  2. `provision()` a runtime for that agent.
  3. Watch the API until the task is done.
  4. `terminate()` the runtime, then confirm that `list()` no longer reports it.

**Setup:**
- Local API from this branch (fresh temp DB, integrations off, random API key).
- Docker: the `ghcr.io/desplega-ai/agent-swarm-worker:slim` image on OrbStack, with the API reached at `host.docker.internal`.
- E2B: the `agent-swarm-worker-1-168-0` template, with the API exposed through an ngrok tunnel.
- Task: "store-progress 'pong'" on the `smol` tier (haiku).
- Fresh DB, so there were no repos to clone and no setup scripts. These are best-case boots.

| Provider | Run | Infra accepted | Worker registered | Task started | Task done | Terminated, `list()` empty |
|---|---|---|---|---|---|---|
| docker | 1 | 0.3 s | 3.3 s | 3.4 s | 7.4 s | 7.5 s, yes |
| docker | 2 | 0.2 s | 2.2 s | 2.2 s | 8.2 s | 8.4 s, yes |
| docker | 3 | 0.2 s | 2.2 s | 2.2 s | 5.2 s | 5.4 s, yes |
| e2b | 1 | 4.3 s | 20.4 s | 36.5 s | 51.5 s | 51.7 s, yes |
| e2b | 2 | 3.9 s | 21.4 s | 37.4 s | 53.7 s | 53.9 s, yes |

All 5 tasks completed with output `pong`.

**Findings:**
- **"Work for an agent that does not exist yet" already works.** `POST /api/tasks` with an unknown `agentId` creates a `pending` task. A runtime that boots with that `AGENT_ID` registers the agent and picks the task up on its first poll. No `INITIAL_TASK_ID` is needed, which confirms open question 4.
- **The interface held for both providers without changes.** `provision`, `status`, `terminate` and label-based `list` cover the lifecycle. Labels (Docker) and metadata (E2B) carry `swarm.runtime-id`, `swarm.pool-id` and `swarm.agent-id`.
- **E2B's 16 s between "registered" and "started" is boot chattiness, not compute.** Between registration and the first poll the worker makes 73 sequential API calls, 42 of them skill-file downloads. Each call crosses ngrok and the E2B region, so latency multiplies. On local Docker the same calls take about 0 s.
  - Follow-up candidate: a bulk boot-bundle endpoint (skills, files, config, prompt templates in one response), or baking seeded skills into the image.
  - This matters more for `per-task` pools, which pay it on every task.
- **E2B infra time (about 4 s)** includes the fixed 2 s liveness wait in `startDetachedProcess`. Sandbox creation itself is about 2 s.
- **Stale agent state after terminate.** After `terminate()`, the agent still shows `idle` until the stale-runtime reaper runs. The supervisor must mark the runtime offline on terminate, or the warm-first rule will count a dead runtime as live.
- **Exposure note.** The ngrok tunnel was up only for the E2B runs, with a random 48-hex API key, and was closed afterwards. A real setup needs a stable public API URL, which every E2B worker already needs today.

## Next Steps

- `/create-plan` from this brainstorm. The open questions are resolved, so a separate `/research` pass is not needed.
- Suggested first slice: `static` + `docker` providers with `poll` delivery, plus the supervisor, the pool table and the runtime token. Then the `push` delivery path, then `e2b`, then the remote controller.
- Separate small follow-up: a bulk boot-bundle endpoint to cut the 73-call boot sequence.
