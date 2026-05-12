---
date: 2026-05-12T00:00:00Z
author: Taras
topic: "Push-mode runners: agents call API instead of polling"
tags: [brainstorm, runners, architecture, serverless, sse, websockets, push-vs-poll]
status: parked
exploration_type: idea
last_updated: 2026-05-12
last_updated_by: Taras
---

# Push-mode Runners — Brainstorm

## Context

Today, runners (Claude / Codex / pi / opencode harnesses) execute as long-lived processes inside Docker workers and **poll** the API for state (assignments, commands, config). The HTTP server owns the SQLite DB and is the single source of truth.

Taras is exploring inverting this: have agents **push** state to the API and have the API **push** state back to runners and UIs, rather than each side polling.

Stated motivations:

1. **Serverless runners** — if runners no longer need to poll, they can run as ephemeral compute (Lambda / Cloud Run / Fly Machines / Anthropic's managed sandbox) that spins up per task and exits.
2. **Real-time UI** — replace UI polling of `/tasks/*` with SSE / WebSockets pushed by the server when state changes.
3. **Resource savings** — eliminate idle poll loops in workers and the dashboard.

Related existing pieces:

- `HARNESS_PROVIDER=claude-managed` already runs runners in Anthropic's cloud sandbox (one foot in the serverless world).
- BU instrumentation already emits flow events (`task`, `agent`, `api`) — a candidate event source for pushes.
- `pm2-start` runs `lead` (3201) and `worker` (3202) as persistent local processes today.

## Exploration

### Q1: Which direction of the data flow is the main pain point — runner→API, API→runner, API→UI, or all three?

**Answer:** "It would be like API (as the gateway, performs what it does now) and then it would trigger events that get pushed to the worker APIs. Then we would have proxies too (e.g. for the UI thing) and also worker pushing to API (this already happens)."

**Insights:**
- The inversion is asymmetric: workers become **HTTP servers** that the API calls into. Server→worker is the new direction; worker→server stays as-is (already a push today).
- "Proxies for UI" suggests a fan-out layer that takes API events and re-broadcasts to subscribed UI clients (SSE/WS multiplexer).
- This shape has a hard constraint: workers must be **addressable** by the API. That's trivial for long-lived Docker workers (known IP/hostname) but is the central design question for serverless runners — Lambda is fundamentally inbound-only-from-API-Gateway, while Cloud Run / Fly Machines / Anthropic's managed sandbox can be given stable URLs.
- The API gateway role staying intact is good — it preserves the DB-ownership invariant and the auth surface (`API_KEY` + `X-Agent-ID`).

### Q2: How does the API reach a worker — registered URL, persistent socket, cloud-provider invoke, or a mix?

**Answer:** "We could store that in the agents table, and then figure out if that is something that could be seeded or configured somehow? I guess it might depend on where (e.g. Docker Compose vs Lambda)."

**Insights:**
- Routing info lives on the agent row — implies a polymorphic "transport descriptor" column (or a small set of columns: `transport_kind`, `transport_target`, `transport_meta`).
- Seeded vs runtime-registered both need to work: Docker Compose can hard-code the URL via env (`WORKER_CALLBACK_URL=http://worker:3202`), while Lambda would seed a function ARN at agent-creation time; ephemeral Cloud Run instances would self-register on boot.
- This is essentially a pluggable transport abstraction — same shape as `HARNESS_PROVIDER`, but for inbound delivery. New providers slot in without changing the dispatch path.
- Auth becomes interesting: a callback URL is a capability that must not leak. Either the worker proves identity via a shared secret in the push body, or we mint per-agent push tokens at registration.

### Q3: What's the intended lifetime of a runner in push mode?

**Answer:** "It's a good question, probably a mix of 1 and 2 (i.e. it depends on infra?)."

(Option 1 = one runner per task; Option 2 = one runner per agent, woken on demand. Notably **not** Option 3, "long-lived runner, push replaces poll".)

**Insights:**
- The goal is genuinely to move off long-lived workers — push-replaces-poll alone isn't the win Taras wants. This means **state externalization is a hard requirement**, not a nice-to-have.
- Lifetime becomes a property of the transport/agent row, same shape as Q2's addressability. Probably the same column.
- Hardest constraint this introduces: the **workspace** (repo checkout, generated files, harness transcript, long-running dev servers) currently lives on the worker's local FS. If the runner can die between turns, the workspace has to live somewhere durable that the next instance can attach.
- `HARNESS_PROVIDER=claude-managed` already solves workspace state in Anthropic's sandbox — that's likely the lowest-friction first serverless target. Lambda/Cloud Run would need a volume strategy (EFS / Cloud Run mounts / object-store snapshot).

### Q4: Where does the workspace live when the runner can die between turns?

**Answer:** "Mounted/network volume per agent."

**Insights:**
- This is the Fly Machines / EBS-backed model: runner compute is ephemeral, but its disk state isn't. Pragmatic — accepts that "truly stateless" isn't worth chasing.
- The volume becomes the new long-lived agent identity. You can't relocate an agent across hosts without migrating the volume. That's a meaningful constraint for the scheduler.
- **Dev servers are casualties.** `bun run dev`, file watchers, language-server processes — none of these survive runner death. Agents that depend on them need either (a) startup-time process re-spawning baked into the harness, or (b) an explicit "this task needs a long-lived sidecar" affinity that pins it to a non-serverless transport.
- Cost story changes: storage is paid for while the agent sleeps, in exchange for not paying compute. Net win depends on volume size vs idle compute cost. For a code agent, repo checkouts can be GBs — volume cost is non-trivial.
- Snapshot / clone / "fork an agent at this point in time" becomes a natural feature once volumes are the identity.

### Q5: Which API→worker events actually need to be pushed?

**Answer:** All four — task assigned / wake-up, stop / pause / kill commands, config / secrets / env refresh, user feedback / chat message during a run.

**Insights:**
- Full poll surface needs push counterparts. No "we'll keep polling for X" escape hatch.
- The four event types have meaningfully different characteristics:
  - **Wake-up** — rare, triggers cold start, tolerates seconds of delay, must eventually deliver.
  - **Stop/kill** — latency-critical, only meaningful while runner is running (no point pushing to a sleeping agent).
  - **Feedback** — timing-sensitive (user is watching), must reach the active turn.
  - **Config refresh** — invalidation; can fail-and-retry; not blocking.
- This rules out a single uniform transport. The outbox can carry all four, but the dispatcher needs per-event-type rules (e.g. "stop" is no-op if agent is `idle`; "wake-up" implies invoke-then-deliver for serverless transports).

### Q6: What delivery guarantee do you want for API→worker pushes?

**Answer:** "Outbox + retry + ack from worker."

**Insights:**
- New DB table (`agent_outbox` or similar): rows = `{ id, agent_id, event_kind, payload, status, attempts, next_attempt_at, created_at, delivered_at }`. Status transitions: `pending → in_flight → delivered | failed`.
- Server-side delivery worker (separate from request handlers) drains the outbox: picks pending rows, attempts push to the agent's transport target, marks `in_flight`, waits for ack via existing worker→API channel.
- Ack endpoint: probably `POST /agents/:id/events/:eventId/ack` — reuses the existing `API_KEY` + `X-Agent-ID` auth surface.
- **Idempotency requirement on the worker.** Retries can deliver the same event twice; the worker must dedupe by event id. The harness command dispatch needs to handle "I've already processed event N".
- **Per-agent ordering matters** — config refresh ordering before task assignment, etc. Outbox should respect per-agent FIFO; simplest is a single in-flight event per agent at a time.
- **Wake-up coupling:** for serverless agents, the dispatcher must invoke-then-deliver. Either the invoke itself carries the event (preferred, fewer round-trips), or it triggers the agent to come fetch its outbox (back to a tiny pull, but only on cold start).
- Outbox doubles as **audit log** — useful for debugging "did the worker actually get the stop command?". Big DX win.
- This is meaningfully more server complexity than fire-and-forget but is the only sane foundation for ephemeral runners. Worth it.

### Q7: How does the UI receive real-time updates?

**Answer:** "API server exposes SSE/WS directly."

**Insights:**
- Same `Bun.serve()` that owns the DB also exposes `/events?task=X` (SSE) or `/events/ws` (WS). After every relevant DB write, the request handler fans out to in-process subscribers.
- Preserves the DB-ownership invariant — no extra service, no extra moving parts. Worker→API stays REST; UI→API just gains a subscribe channel.
- Auth reuses `API_KEY` validation in the upgrade/handshake handler. Probably scope subscriptions per task/agent so a token can't tail everything.
- **Source of truth for events:** simplest is to emit into an in-process pub/sub right after the DB write in each route handler. Could also lean on BU instrumentation `ensure()` calls as the trigger — they already fire post-mutation, outside transactions. Reusing BU avoids duplicating the "after state changes" plumbing.
- Hard limitation: subscribers are pinned to one API process. SQLite single-writer constraint already pins the API to one process today, so this isn't a new ceiling. If/when the API ever scales out (Postgres/distributed), this becomes Redis pub/sub or LISTEN/NOTIFY territory.
- This decision unifies nicely with the outbox: the same write path that enqueues a worker push can also fan to UI subscribers. One emit, two consumers.

### Q8: How should push mode coexist with today's polling workers?

**Answer:** "It's either one or the other, it's like a flag / env var."

**Insights:**
- Mode is a deployment-level switch, not a per-agent decision. For a given install the runtime is either fully push or fully poll; there's no "this agent pushes while that one polls" complexity.
- Both code paths still need to exist in the codebase (workers ship both a poll loop and an outbox receiver/server). Selected at boot via env (`SWARM_TRANSPORT_MODE=push|poll`).
- DB-side schema (outbox table, agent transport columns) lands regardless — they're only *used* in push mode but they're schema-additive, so no incompatibility risk for poll-mode deployments.
- The serverless transports (Lambda / Cloud Run / managed) are *only* available when `SWARM_TRANSPORT_MODE=push`. In poll mode, those transport kinds aren't reachable and the docker worker is the only option.
- Migration story for an existing user: flip the env var, restart, optionally switch some agents to a serverless transport_kind. No data migration. Rollback = flip back.
- This biases the design toward making the push path symmetric with poll's behavior — same observable outcomes for tasks, just different transport plumbing. Easier to reason about correctness, easier to A/B compare.

## Synthesis

### Key Decisions

1. **Inversion shape is asymmetric API↔worker, not a symmetric mesh.** API server keeps its gateway role (DB ownership, auth surface). Worker→API stays as today's REST push. The new direction is API→worker, where workers expose an HTTP receiver.
2. **Transport is pluggable, descriptor lives on the agent row.** New columns on `agents` (e.g. `transport_kind`, `transport_target`, `transport_meta`) describe how the API reaches a given worker. Initial kinds: `docker-callback-url`, `cloud-run-url`, `lambda-arn`, `claude-managed`. New kinds slot in like `HARNESS_PROVIDER` does.
3. **Lifetime is a property of the transport, not a global setting.** Mix of per-task (Lambda-style) and per-agent woken-on-demand (Cloud Run / Fly Machines). The legacy long-lived Docker worker is treated as a degenerate "always woken" case.
4. **Workspace state lives on a per-agent persistent volume.** Compute is ephemeral, disk isn't. Dev servers don't survive runner death — agents that depend on them either re-spawn on wake or pin to a non-serverless transport.
5. **All four current API→worker poll concerns become pushes:** wake-up / task assignment, stop / pause / kill, config + secrets refresh, user feedback during a run.
6. **Outbox + retry + ack is the delivery contract.** New `agent_outbox` table; server-side delivery worker drains it; workers ack via existing auth surface; per-agent FIFO; idempotency required on the worker. Outbox doubles as audit log.
7. **UI gets SSE/WS directly from the API server**, in-process. After every relevant DB write, fan-out to subscribers. Same emit can drive both the outbox enqueue and the UI fan-out.
8. **Push vs poll is a deployment-level mode**, set by env var (`SWARM_TRANSPORT_MODE=push|poll`). Workers carry both code paths but only one is active per install. Schema additions are additive — no migration risk for poll-mode deployments.

### Constraints Identified

- **DB-ownership invariant is preserved.** Workers never touch SQLite directly; outbox lives in the API DB; SSE/WS subscribers live in the API process. No new boundary violations.
- **SQLite single-writer caps in-process fan-out scaling.** Fine for current single-process API; if/when the API horizontally scales, SSE/WS needs Redis pub/sub or LISTEN/NOTIFY (Postgres). Not a today problem.
- **Persistent volume per agent is non-trivial cost.** Repo checkouts are GBs; volume storage is paid while agent sleeps. Net resource win vs idle compute is workload-dependent — needs measurement, not assumed.
- **Idempotency required on worker side.** Outbox retries can deliver the same event twice. Harness command dispatch must dedupe by event id.
- **Auth on the new server-side worker URL.** Callback URLs are capabilities; need shared secret in push body, mint per-agent push tokens, or signature on outbox events.
- **Long-running subprocesses (`bun run dev`, watchers, LSPs) are casualties of ephemeral compute.** Either re-spawn on wake or pin those agents to long-lived transport.
- **Stop/kill semantics are tricky for sleeping agents.** Pushing a stop to a scaled-to-zero agent is largely a no-op; the dispatcher needs per-event-kind rules.
- **Wake-up coupling for serverless:** the dispatcher must invoke-then-deliver. Cleanest is to embed the event in the invoke payload (one round-trip). Falling back to "invoke and let it pull its outbox" reintroduces a tiny pull on cold start.

### Open Questions

- **What is the wake-up payload shape?** A single event embedded in the invoke vs invoke-then-fetch. The first is fewer round-trips; the second is uniform with warm-path delivery.
- **Per-agent FIFO vs per-event-kind ordering.** Should a `config-refresh` block a queued `task-assigned`? Probably yes (config first), but stop/kill probably preempts. Needs a small priority/ordering policy.
- **Where do BU instrumentation events fit?** They already fire post-mutation, outside transactions. They're a candidate trigger for both the outbox enqueue and the UI fan-out — possibly the *only* trigger, removing duplicate plumbing. Worth checking against `ensure()` semantics.
- **How does the "proxy for UI" idea evolve if the API ever scales horizontally?** Today's "in-process SSE/WS" answer locks in a single-process ceiling. Should the abstraction be designed to slot in a fan-out service later without changing the UI contract?
- **What's the actual measurable resource win?** Need a baseline: today's worker idle CPU, dashboard poll bandwidth, DB read load. Otherwise "spend less resources" is a vibe, not a metric.
- **How does Anthropic's claude-managed sandbox map onto this transport abstraction?** Probably the lowest-friction first serverless target, but its API for "deliver an event to a specific session" needs to be checked. May lack push primitives entirely, in which case it's invoke-style only.
- **How is the per-agent volume provisioned, garbage-collected, and migrated when the agent's transport changes?** Not addressed.

### Core Requirements (lightweight PRD)

**Server side**

- New `agent_outbox` table with per-agent FIFO and ack tracking.
- New columns on `agents` for transport descriptor (`transport_kind`, `transport_target`, `transport_meta`).
- Server-side delivery worker (background loop or post-write trigger) that drains the outbox using the agent's transport.
- New endpoints: ack inbound (`POST /agents/:id/events/:eventId/ack`); UI subscribe (`GET /events?task=X` SSE and/or `WS /events/ws`).
- In-process pub/sub bus that route handlers (or BU `ensure()` calls) emit into; subscribed by both the outbox enqueuer and the UI SSE/WS endpoint.
- Auth: per-agent push token (or signed event payload) to authenticate API→worker pushes.

**Worker side**

- HTTP receiver server in the worker process that accepts pushes for the four event kinds.
- Idempotency by event id at the dispatch layer.
- Existing poll loop kept behind the env-var switch for poll-mode deployments.
- Self-registration on boot for transport kinds where target URL is dynamic (Cloud Run / Fly Machines).

**Transport adapters (pluggable, mirroring `HARNESS_PROVIDER` shape)**

- `docker-callback-url` — hard-coded URL via env, infinite TTL, always reachable.
- `cloud-run-url` — registered URL on boot, scales-to-zero with HTTP wake.
- `lambda-arn` — SDK-based invoke per event; payload carries the event.
- `claude-managed` — uses Anthropic's session/invoke primitives (TBD; may need polling fallback if no push primitive exists).

**Operational mode switch**

- `SWARM_TRANSPORT_MODE=push|poll` env var, default `poll` for backward compat.
- Schema migrations land regardless and are additive only.
- Rollback = flip env var, restart.

**Observability**

- Outbox table is queryable as audit log (which event, which agent, when delivered).
- Delivery latency metric per transport kind.
- Resource baseline measurement before/after to validate the third motivation.

## Next Steps

- **Parked 2026-05-12.** Synthesis is complete; no immediate research or plan. Pick up later via `/desplega:research` (to map current poll loops, BU instrumentation, agents-table shape, claude-managed integration, and SSE/WS feasibility in `Bun.serve`) or `/desplega:create-plan` if the synthesis is detailed enough to plan against directly.
