---
date: 2026-10-10T14:25:50+0200
author: taras
topic: "A \"computer\" primitive for the swarm"
tags: [brainstorm, exty, browser, devices, connections, primitives]
status: complete
exploration_type: idea
last_updated: 2026-10-10
last_updated_by: taras
---

# A "computer" primitive for the swarm. Brainstorm

## Context

**What prompted this.** The work in `../exty` (Taras's personal MV3 browser extension) turned a human's browser into a resource that the swarm can read and drive. We want to know what the general primitive behind that is, and how it would fit into agent-swarm as a first-class concept.

**What exty does today (facts, from `../exty` docs on 2026-10-09).**

- Features: Browser (shared tabs), Gateway (Cloudflare Worker + Durable Object), Recorder (meeting transcription to agent-fs), Inbox (`inbox_notify`, `inbox_ask`, `inbox_askAsync`), Teach (lessons, skillify), Triggers (browser events to swarm tasks or workflows), agent-swarm side panel, agent-fs save.
- The gateway exposes 23 `browser_*` operations plus `recorder_*` and `inbox_*` over `POST /rpc/:operationId`, with an OpenAPI spec and a per-operation level (`read` or `control`).
- Consent model: the human shares a tab as read-only or full control (Cmd+J). Unshared tabs return 403. A share ends when the tab closes. Visible indicators (title marker, glow, pill with a trusted-click Stop button).
- Identity: one browser = one paired device (device token). Keys are minted per device. Invites pair a teammate's browser without the pairing secret.
- Presence: the browser holds a WebSocket to the gateway. `GET /status` reports `online`, served operations, `lastSeenAt`. Offline gives 503.
- Human channel: Inbox asks steer the task (queue mode) or spawn a follow-up when the task ended.
- Events: `browser.tab.shared`, `browser.download.finished`, `recorder.recording.ended`, `recorder.summary.ready`. Triggers rules turn them into lead tasks or workflow triggers.

**How the swarm sees exty today.** Only as a Script Connection of kind `openapi` (`ctx.api.extyBrave.browserOpenTab(...)`), one per browser. Nothing in agent-swarm knows "exty", "device", "browser" or "shared tab" by name. The swarm has no model of presence, ownership, consent level, or which human sits behind a connection.

**Initial thought.** A "computer" would be the swarm-side primitive that exty is one implementation of: a human-owned machine (browser, desktop, phone, dev box) that agents can be granted scoped access to, with presence, consent, ownership, operations and events as first-class fields.

## Exploration

### Q: What counts as a "computer" in this primitive?
Any machine, human-owned or swarm-owned. Browsers (exty) and later desktops and phones, but also cloud sandboxes (E2B, managed sandboxes, k8s pods). One abstraction for "a machine the swarm can reach".

**Insights:** This merges two trust models in one entity. A person's laptop is lent, scoped, revocable, and a human watches it. A sandbox is owned, disposable, and nobody watches it. The primitive needs an `owner` axis (user vs swarm) and a `consent` axis that is real for human-owned machines and trivially "full" for swarm-owned ones. Device type (browser, desktop, phone, vm) is then a third, orthogonal axis that decides which operations exist. Risk to watch: the human-owned case must not inherit the sandbox's "do anything" defaults.

### Q: What does an agent do with a computer: drive it from outside, run on it, or both?
Drive it from outside. A computer is a target the agent operates through typed operations (click, readPage, exec, screenshot). Agents keep running where they run today. Workers, Docker, E2B and managed sandboxes stay as they are.

**Insights:** This keeps the primitive small and matches exty's gateway shape one to one. A swarm-owned VM is a computer with `exec` and `fs` operations and full consent, not a new worker runtime. The worker model is explicitly out of scope.

**Facts gathered (codebase, 2026-10-10):**
- `script_connections` (migration 117) has `scope` in {global, agent, repo} with `scope_id`. There is no `user` scope and no owner column, only `created_by` / `updated_by` audit fields. No health, presence or last-seen. `refresh` only re-fetches the spec.
- Scripts resolve `ctx.api.<slug>` from `getScriptApiConnectionDescriptors({ agentId })` (`src/be/script-connections.ts:2116`), filtered by scope only.
- No "device", "computer" or "exty" entity exists anywhere in agent-swarm.
- Users are first class (`users`, `user_external_ids`, `user_tokens`). Decision from the 2026-05-18 brainstorm: humans observe and configure, tasks are never assigned to humans. `agent_tasks.requestedByUserId` links a task to its human.
- Agent presence is poll-driven: `agents.status` plus `runtime_instances.last_seen_at`. Extensions get an offline `ext:<name>` agent row and no presence.
- Human in the loop today: `request-human-input` creates an `approval_requests` row, never blocks, and the answer comes back as a `hitl-follow-up` task. Steering is human to agent only.
- Task gating: `requires: AutomationIntegrationId[]` on schedules and workflows checks swarm-level integrations (`automation-preflight.ts`). Nothing gates a task claim on a per-user resource.
- The API already runs a `ws` WebSocket hub at `/api/realtime` (`src/realtime/transport.ts`) for Pages and Apps rooms, with ticket auth and agent/user/guest identity. Nothing device-oriented.

### Q: What must the swarm know about a computer that it does not know about a connection? (v1 first-class fields)
All four: owner, presence, consent level, kind and operations.

**Insights:** With all four first class, a computer is clearly more than a connection row with extra columns. Owner needs a user link that connections lack (no `user` scope today). Presence needs a push or poll path that nothing in the connection code has. Consent is a live, owner-controlled state that changes without any swarm action (the human clicks Stop). Kind and operations overlap with the OpenAPI spec, so the question is whether the swarm derives them from the spec or the device declares them. The sum points at a new entity that *uses* a connection for transport rather than *is* one.

### Q: How does a computer relate to the existing primitives in the data model?
Taras did not pick a shape. He added three requirements instead:

1. **Providers.** A computer comes from a provider. Exty is one. A cloud browser service such as Browser Use Cloud could be another, noVNC-like: a remote machine with a screen.
2. **Persistence.** A computer is durable. It is not "spawn a sandbox, use it, drop it" like today's E2B or Docker runs. It keeps state (sessions, logins, files) and you come back to it.
3. **Human view and takeover.** The human must be able to see the screen and take control as a human. This is key, not optional.

**Insights:**
- A provider abstraction is the real seam. Exty is a *human-owned, attach-only* provider (the device exists, the swarm gets lent access). A cloud browser is a *swarm-owned, provisioned* provider (the swarm creates it, pays for it, and keeps it). Both expose: presence, operations, a live view, and a takeover path.
- Persistence makes a computer a long-lived asset with a lifecycle (provisioning, online, offline or suspended, destroyed) and a running cost while idle. That is a different shape from a task-scoped sandbox, and it is why it deserves its own entity rather than a per-task resource.
- "See the screen and take control" is the same affordance from both sides. Exty already has it for free: the human is sitting at the browser, the glow and the pill show what the agent does, and Stop ends the share. A cloud provider needs a live view URL (noVNC, provider live URL) embedded in the dashboard, plus a takeover protocol: who holds the input, does the agent pause, how does control return.
- The 2026-05-18 decision "humans observe and configure, tasks are never assigned to humans" still holds. Takeover is a human *operating a computer* next to an agent, not a human *doing a task*.
- The exty gateway's `read` and `control` levels generalize: `view` (see the screen), `read` (inspect state), `control` (drive input). The human always has all three on their own computer.

### Q: Does "new `computers` entity plus provider adapters, provider decides transport" fit?
Not settled. Taras is between "provider decides transport" and "every provider goes through a Script Connection", because scripts are the key way agents will drive computers.

**Insights:**
- The actual requirement behind option 2 is not "OpenAPI everywhere". It is: *every computer must be drivable from a script through one typed surface, whatever its provider*. Option 2 gets that by forcing a gateway per provider. Option 1 only gets it if the swarm projects every adapter into the script SDK.
- A hybrid satisfies both: the swarm itself is the gateway. The API server exposes every computer under one route (`/api/computers/:id/rpc/:operation`) and a generated typed client in the script SDK. The exty adapter proxies to the exty gateway. A cloud adapter calls its SDK. Presence, lifecycle and live view are adapter methods and never enter the operation spec. No provider has to ship an OpenAPI gateway.
- The remaining fork is *who defines the operation vocabulary*. If the swarm defines it per kind (a `browser` contract: openTab, readPage, find, click, type, screenshot, ...), a script written against Taras's Brave also runs against a Browser Use Cloud browser. Exty's 23 `browser_*` operations are a ready-made first draft of that contract. If each provider's own spec is the surface, scripts stay provider-specific.
- Exty's non-computer operations (`inbox_*`, `recorder_*`) are exty features, not computer operations. They stay on the existing Script Connection (`ctx.api.extyBrave`). The computer surface carries only the kind contract. So the connection does not go away; it narrows to "exty extras".

### Q: Who defines the operation vocabulary a script codes against?
The swarm, per kind. A `browser` contract owned by the swarm, seeded from exty's 23 `browser_*` operations. Adapters map providers onto it. Scripts call `ctx.computers.<slug>.readPage(...)` and run unchanged across providers of the same kind. Exty extras (`inbox_*`, `recorder_*`) stay on the existing connection.

**Insights:**
- Entity shape is now settled by consequence: a `computers` entity, provider adapters server-side, one swarm-hosted RPC route per computer, and a generated typed client per kind in the script SDK. This is the "new entity plus adapters" shape with scripts first.
- The kind contract is the portability promise and the versioning burden. A new provider that cannot serve an operation must say so (declared operations are a subset of the kind contract), and the client should surface "not supported by this computer" before the call, not as a 503 after.
- The exty gateway spec and the swarm's `browser` contract will drift unless one is derived from the other. Simplest: the swarm contract is the source, and exty's gateway keeps its own spec; the exty adapter is the mapping and the only place drift shows.
- `ctx.computers` is a new SDK surface next to `ctx.api` and `ctx.swarm`. It needs a type contributor (`src/be/scripts/type-contributors.ts`), the same way connections and apps do.

### Q: Who may create a swarm-owned computer, and what is its lifecycle?
Agents may also provision, under a budget. An operator provisions from the dashboard, a human-owned one is registered by pairing, and an agent can ask for a new computer of a kind within a cap. It persists after the task.

**Insights:**
- Day-one needs that follow from this: an idle policy per computer (suspend after N minutes, destroy after M days, both provider-driven where the provider supports it), a reaper sweep like the approval and heartbeat sweeps, and a cost line per computer so the usage page can show it next to token spend. The existing `budget-admission.ts` layers (global, agent, requesting user) are the natural place for the provisioning cap.
- Provisioning is a mutation with lasting cost, so it should be an explicit script or tool call with the kind, a reason and the task id recorded on the row, never an implicit side effect of "give me a browser".
- Ownership of an agent-provisioned computer is still open: the requesting user, the agent, or the swarm. This decides who sees it, who pays and who may destroy it.
- Lifecycle states: `provisioning`, `online`, `offline` (human device away or cloud machine suspended), `destroyed`. Human-owned computers never enter `provisioning` or `destroyed` from the swarm side, only paired and unpaired.

### Q: Who may use a computer?
Owner's tasks by default, explicit lend. A human-owned computer serves only tasks whose requesting user is the owner, plus computers the owner marked as lent to the swarm. An agent-provisioned computer belongs to the requesting user of that task, or to the swarm when there is none, and follows the same rule. Consent level guards what an allowed task may do.

**Insights:**
- The check is "task.requestedByUserId equals computer.ownerUserId, or computer.lentToSwarm", evaluated when a script or tool resolves `ctx.computers`. A task with no requesting user (a schedule, a system follow-up) sees only swarm-owned and lent computers. Delegated child tasks inherit the root task's requesting user, which they already carry.
- This is the first per-user resource a task is gated on. Nothing like it exists today (`requires` checks swarm-level integrations only). It is cheap to enforce at resolution time and it needs no claim-path change.
- "Lent to the swarm" is a per-computer boolean the owner flips, not a grant list. Per-user grants can come later if a team needs them.
- An exty-paired browser has one human sitting at it, so owner is known at pairing time: the user whose agent-swarm connection linked the gateway. Exty already knows this user (it holds a user token or an operator key).

### Q: What happens to the agent when the human takes the controls?
"A bit of 1 and 2": the agent is told and keeps running, but with a pause flavor. Interpretation recorded here (to confirm in review):

- The computer enters `human-controlled`. A control operation from an agent does not fail at once. It waits for hand-back up to a bound (the script wall clock minus a margin, or a `waitForControlMs` argument), then returns a clear "human has the controls" error. Read and view keep working during the wait.
- On hand-back the task gets a steering message (queue mode, as exty's inbox already does) with what the human did: a before and after screenshot and, where the provider has it, a short action log. A running task reads it at its next turn. An ended task gets a follow-up, which the steer path already promotes.
- No task-level pause primitive. The wait lives in the operation call, so it works on every harness and the task model does not change.

**Insights:**
- This is a lock with a handoff note, not a pause. It fits "let me fix this login, then you continue" for short takeovers, and degrades to the exty behavior (403, agent adapts) for long ones.
- Exty already has half of this: the share levels, the trusted-click Stop, the steer on inbox answers. The new parts are the `human-controlled` state as a first-class value the swarm stores, the bounded wait, and the hand-back summary.
- The live view in the dashboard needs a "Take control" and a "Hand back" button that flip this state. For an exty computer the human is at the keyboard, so "take control" is implicit the moment they move the mouse; exty would need to report that. Open fact: can an MV3 extension detect human input on a shared tab reliably (trusted events in the content script).

### Q: A task needs a computer that is offline. What should happen?
Resume if swarm-owned, else ask the owner once. A suspended cloud computer is resumed by the adapter on first use. A human-owned offline computer fails fast with "offline since <time>", and the agent is nudged to ask the owner (`request-human-input`, or exty's inbox when the owner has it) and continue as a follow-up.

**Insights:**
- Presence therefore has to be known *before* the call, which fixes the presence mechanics: the swarm stores `presence` and `lastSeenAt` per computer, updated by a push from the device or adapter (exty's gateway can call the swarm on connect and disconnect, a cloud adapter polls its API on a sweep). The list a script sees carries presence, so an agent can pick an online computer without a failed call.
- Lazy resume means the first operation on a suspended machine is slow (seconds to a minute). The client should report "resuming" rather than time out at 25 s, so the per-operation timeout needs a resume-aware path or the resume should be an explicit `ensureOnline()` step the generated client calls first.
- The existing `NUDGES` map in `src/tools/utils.ts` is the place for the "owner offline, ask them" steer.
- No new task state, no claim-path change. The 2026-05-18 rule stays intact: a human is asked, never assigned.

### Q: What do agents get as MCP tools, beyond scripts?
Discovery and lifecycle only: `list-computers` (presence, kind, consent, owner), `computer-provision` (kind, reason, under budget) and `computer-live-view` (a URL to share with the human). All driving goes through scripts.

**Insights:**
- Three tools, all registered in `SDK_TOOL_NAME_MAP` so scripts can call them too. `computer-provision` is the only one with lasting cost and gets the budget check and a NUDGE about idle cost.
- The kind contract is documented once, in a seeded skill (`templates/skills/computers/`), with a script example per kind. That is where the model learns the vocabulary, not from tool schemas.
- `computer-live-view` makes the human side reachable from Slack or a task thread: the agent can post "watch here" before a risky step. For exty the URL is the dashboard's Computers page; for a cloud provider it is the provider's live URL or a dashboard embed.

### Q: Which providers and kinds are in v1?
Browser kind only, with two providers: exty (human-owned, attach) and one cloud browser service (swarm-owned, provisioned, live view). Desktop, phone and vm kinds come later.

**Insights:** Two providers of one kind is the minimum that proves the contract and the adapter seam. The cloud provider is also the only path that exercises provisioning, lazy resume, idle cost and a non-exty live view. Taras named Browser Use Cloud; whether it is the right first cloud provider is a research fact (persistent sessions, live view URL, resume, idle pricing).

## Synthesis

### Key Decisions
- **Boundary.** A computer is any machine the swarm can reach, human-owned or swarm-owned. Owner, consent and kind are three orthogonal axes.
- **Relation.** Agents drive a computer from outside through typed operations. Agents never run on it. Workers, Docker, E2B and managed sandboxes are unchanged and out of scope.
- **Entity.** A new `computers` entity with server-side provider adapters (like `src/providers/` for harnesses). Fields: owner, kind, provider, lifecycle state, presence and last seen, consent level, declared operations, live view. The exty adapter reuses the existing Script Connection for transport; exty extras (`inbox_*`, `recorder_*`) stay on `ctx.api.extyBrave`.
- **Script contract.** The swarm defines one operation vocabulary per kind. The `browser` contract is seeded from exty's 23 `browser_*` operations. The API hosts one RPC route per computer and generates a typed `ctx.computers.<slug>` client per kind. Scripts are portable across providers of a kind. Declared operations are a subset of the contract and unsupported ones are visible before the call.
- **Lifecycle.** Operators provision from the dashboard and register human-owned computers by pairing. Agents may provision under a budget, with kind, reason and task id recorded. States: `provisioning`, `online`, `offline`, `human-controlled`, `destroyed`. Idle suspend and a reaper sweep exist from day one.
- **Access.** A computer serves tasks whose requesting user is its owner, plus computers the owner marked "lent to the swarm". An agent-provisioned computer belongs to the requesting user, or to the swarm when there is none. Enforced when `ctx.computers` resolves, no claim-path change.
- **Takeover.** The human can always see the screen and take control. The computer enters `human-controlled`; agent control operations wait for hand-back up to a bound, then fail with a clear error, while read and view keep working. Hand-back steers the task with a before and after summary. No task pause primitive.
- **Offline.** A suspended swarm-owned computer resumes lazily on first use. An offline human-owned computer fails fast with "offline since", and the agent is nudged to ask the owner once and continue as a follow-up. No waiting, no queued task state.
- **MCP surface.** `list-computers`, `computer-provision`, `computer-live-view`. All driving is through scripts. The contract lives in a seeded skill with examples.
- **v1 scope.** `browser` kind, exty plus one cloud browser provider.
- Deferred: **which cloud provider**. Defaulting to Browser Use Cloud (named by Taras) unless research shows it lacks persistent sessions or a live view URL.
- Deferred: **computer events into swarm triggers** (tab shared, download finished). Defaulting to exty's own Triggers feature for v1; the swarm consumes nothing new.
- Deferred: **idle policy defaults**. Defaulting to suspend after 30 minutes idle and destroy after 7 days unused, both operator-tunable, both only where the provider supports them.
- Deferred: **exact takeover blend** (bounded wait length, what the hand-back summary contains). The interpretation in the takeover Q above is the default until review says otherwise.
- Deferred: **per-user grant lists**. Not in v1. "Lent to the swarm" is a boolean.
- Deferred: **presence transport for exty**. Defaulting to the gateway pushing connect and disconnect to the swarm, with a sweep that polls `GET /status` as a fallback.

### Open Questions
- Browser Use Cloud (or the chosen cloud provider): does it support persistent browser sessions or profiles across runs, a live view URL (noVNC or similar), suspend and resume, and what does an idle session cost?
- In `../exty`: can the content script detect trusted human input on a shared tab reliably enough to flip the computer to `human-controlled`, and can the gateway emit connect and disconnect callbacks to a swarm URL?
- How does exty know the swarm user at link time (user token vs operator key), so the owner can be set when the computer is registered?
- How is a new `ctx.*` SDK surface added: the type contributor in `src/be/scripts/type-contributors.ts`, the runtime in `src/scripts-runtime/ctx.ts`, and the QuickJS prelude mirror in `executors/quickjs-prelude.ts`?
- Where are the script wall clock (30 s default, up to 5 m) and the 25 s per-call timeout set, to size the bounded takeover wait and the lazy resume path?
- Which of exty's 23 `browser_*` operations carry exty-only semantics (agent-fs screenshot upload, captured downloads, dialogs policy) that the swarm contract must generalize or drop?
- How do budget admission layers (`src/be/budget-admission.ts`) and the usage page attribute non-token cost today, so a per-computer cost line can join them?
- Can the dashboard embed a third-party live view (CSP, iframe, auth) or does it need to open it in a new tab?

### Constraints Identified
- The API server is the sole DB owner. Adapters, the RPC route, presence sweeps and the reaper live server side (`src/be`, `src/http`). Workers reach computers only through the API.
- Scripts first. `ctx.computers` needs a type contributor, a QuickJS mirror and entries in `SDK_TOOL_NAME_MAP`. Scripts run under a 30 s default wall clock, so long waits must be explicit and bounded.
- Provider credentials are secrets: encrypted swarm config or credential bindings, egress allowlisted per provider host (SSRF fail-closed in production), scrubbed at every log egress.
- Non-GET routes declare an RBAC posture and a typed 2xx schema. A migration is needed and must sort above `main`'s tail.
- Humans are never assigned tasks (2026-05-18 decision). Takeover and asks go through steering and `request-human-input`.
- Exty's gateway spec stays exty's. The adapter is the only mapping, so contract drift is visible in one file.
- Persistence has cost. Provisioning is gated by the existing budget layers and every computer shows its cost.

### Core Requirements
- A `computers` table and API (list, get, register, provision, destroy, set lent, set consent, take control, hand back) with owner, kind, provider, state, presence, last seen, consent, declared operations, live view URL, cost to date, and the provisioning task and reason.
- A provider adapter interface: `provision`, `destroy`, `suspend`, `resume`, `presence`, `liveView`, `call(operation, body)`, `declaredOperations`. Two adapters in v1: exty (attach only) and one cloud browser.
- A swarm-owned `browser` kind contract seeded from exty's operations, versioned, with a generated typed client per kind in the script SDK as `ctx.computers.<slug>`.
- One RPC route per computer on the API, with owner and consent checks, a "human has the controls" bounded wait, and an "offline since" fast fail.
- Presence updates by push from exty's gateway and by a sweep for cloud adapters, plus a reaper that applies the idle policy.
- Three MCP tools: `list-computers`, `computer-provision`, `computer-live-view`. A seeded `computers` skill with the contract and one script example per operation group.
- A dashboard Computers page: list with presence and owner, a detail view with the live view, Take control and Hand back buttons, lend toggle, consent level, cost, and destroy.
- Exty changes: register the paired browser as a computer at link time with the owner, report connect and disconnect, report human input as a takeover, and keep the gateway spec unchanged.

## Next Steps

- Brainstorm complete on 2026-10-10. Handed off as a draft PR so the document is reviewable in place.
- Next: `/desplega:research` on the Open Questions above (cloud provider facts, exty human-input detection and connect callbacks, the `ctx.*` SDK contributor path, cost attribution, dashboard embed), then `/desplega:create-plan` for v1 (browser kind, exty plus one cloud provider).
