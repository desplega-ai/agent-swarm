---
date: 2026-11-17T17:40:00+01:00
author: Taras
topic: "Durable Object-like primitive for swarm scripts"
tags: [brainstorm, scripts, kv, durable-objects, primitives]
status: complete
exploration_type: idea
last_updated: 2026-11-17
last_updated_by: Claude
---

# Durable Object-like primitive for swarm scripts: Brainstorm

## Context

In the prod swarm, agents often use KV to hold state between runs. Taras proposes a primitive for that pattern, modeled on Cloudflare Durable Objects (not plain Workers).

Initial idea:
- A script can export by default a class that implements a `DurableObject`-style interface, in place of the current `(args, ctx)` function export.
- The class holds state. The runtime persists that state durably in KV.
- The normal script executor runs it.
- Open framing: is this a new script type, or a general script capability?

Reference model (Cloudflare Durable Objects): one named instance per id, single-threaded (requests to one id are serialized), private transactional storage, alarms for scheduled wake-ups, addressable by name from other code.

### Codebase facts (gathered 2026-11-17)

- **Export contract:** only `export default` as a function. Native `eval-harness.ts:131-168` and QuickJS `quickjs-prelude.ts:575,600` call `mod.default(args, ctx)`. One optional named export, `argsSchema`. `script_upsert` typecheck pins `ScriptMain = (args, ctx) => unknown` (`typecheck.ts:936,1606`). A default-exported class fails today.
- **Lifecycle:** native is one `Bun.spawn` per run. QuickJS is a worker pool with one job per worker. No state survives across runs. Wall clock: 30 s default, 5 min max (`executors/types.ts:135,142`).
- **KV:** `kv_entries(namespace, key, value, value_type, expires_at)`, PK `(namespace, key)`. Lazy TTL, `kv-incr` in a transaction, prefix list (cap 1000), 2 MiB per value. **No compare-and-swap, no version, no watch.** Namespace defaults to the task `contextKey`, then `task:agent:<id>`. Scripts reach it as `ctx.swarm.kv_*`.
- **Durable script workflows** (`src/script-workflows/`): long runs (24 h cap) with a step journal `script_run_journal UNIQUE(runId, stepKey)` and replay. Steps: `rawLlm`, `agentTask`, `swarmScript`, `humanInTheLoop`. No sleep or wait-for-event step found. Supervisor process manager.
- **Invocation paths:** `script_run`, saved scripts by name, workflow nodes (`script`, `swarm-script`), schedules (`targetType='script'`), per-script HTTP endpoints (`/api/x/script/{endpointId}`), App actions (`kind: "script"`), durable runs (`/api/script-runs`).
- **Serialization today:** no per-key lock or single-writer mechanism. Only `BEGIN IMMEDIATE` per DB transaction.
- **Realtime rooms:** in-memory Yjs docs on the API, persisted to KV `_room/<name>` with about 1 s flush. Single API replica assumed. Precedent for "API owns a live object, KV holds its snapshot".
- **Swarm Apps:** model rows live in KV. Actions run saved scripts. Apps are a likely consumer of objects.

## Exploration

> The Q&A below records the session in order. Later rounds supersede earlier text. **The Synthesis section is authoritative.** Superseded points carry a *(superseded)* note.

### Q: Which Durable Object traits must be in v1?
Named instances with state (1), serialized calls per id (2, "we could use sqlite txs"), and addressable RPC (4). Alarms (3) are wanted, but they must reuse existing primitives such as schedules, not a new alarm system.

**Insights:**
- v1 = identity + state + single-writer + callable methods. Alarms become "an object method as a schedule target", which needs only a new target shape on schedules.
- **Pushback on "sqlite txs" for serialization.** A call runs user code for up to 30 s (5 min max) and does network I/O. SQLite has one writer for the whole DB. Holding `BEGIN IMMEDIATE` for the length of a call blocks every other write in the swarm. The transaction must cover only the state load and the state commit, not the method body.
- Optimistic concurrency (version + retry on conflict) is also weak here. A retry re-runs the method, and methods have side effects (`send-task`, Slack, HTTP). A retry can send the task twice.
- So serialization needs a lock or queue held outside the DB transaction: for example, an API-owned FIFO per object id plus a lease row for crash recovery. Rooms already accept "single API replica" as a constraint.

### Q: How should calls to one object id be serialized?
"The easiest and cleanest one." Postgres support may come later.

**Insights:**
- Postgres implies more than one API replica becomes possible. An in-memory FIFO binds an object to one process, so it does not survive that move. Rooms carry the same debt, and we should not add more of it.
- **Decision: a DB lease per object id.** A call takes the lease in a short transaction (`UPDATE ... SET leaseHolder, leaseExpiresAt WHERE leaseHolder IS NULL OR leaseExpiresAt < now`), runs the method with no transaction open, then commits the new state and releases the lease in one short transaction. The commit checks that the caller still holds the lease (fencing), so a call whose lease expired cannot overwrite newer state.
- Plain SQL, portable to Postgres. Postgres can later swap the lease for `SELECT ... FOR UPDATE SKIP LOCKED` or advisory locks with no API change.
- A waiting caller retries the lease with backoff. A same-process wake-up (event bus on release) is an optimization, not a requirement.
- Lease length must be bigger than the method wall clock (30 s default), with a heartbeat for long calls. *(superseded in Round 3: TTL = wall clock + margin, no heartbeat)*

### Q: Where does object state live?
First answer: own table, with the follow-up "do you really believe KV would not work?". After a re-check, the answer is **snapshot on KV**.

**Insights:**
- I overstated the KV objection. The object runtime is server code, so it runs conditional SQL on `kv_entries` directly. It needs no public CAS tool. `expires_at` already gives a lease with expiry.
- **Decision:** each object gets its own KV namespace `object:<class>:<id>`. *(superseded: final layout is namespace `durable:<scriptId>`, keys `state/<id>` and `lease/<id>`; see Synthesis)* It holds:
  - `state`: the whole JSON snapshot, loaded before a call and saved after it.
  - `__lease`: holder + `expires_at`. Taken with an insert-if-absent-or-expired transaction. The commit checks the holder (fencing) and bumps a version in the same transaction.
- Free reuse: KV tools and UI for inspection, TTL, 2 MiB per value, prefix list (list objects of a class).
- Required guard: agent-facing `kv_set` / `kv_delete` / `kv_incr` must refuse `object:*` namespaces. Reads can stay open for debugging. *(superseded: family `durable`, reads gated on script-run permission)*
- The same namespace can later hold multi-key storage (`this.storage.get/put`) with no migration.

### Q: How does an author declare an object?
Class default export. One `scripts` table. The default export is either a function (normal script) or a `DurableObject` implementation (object script).

**Insights:**
- Not a new entity. A script's "kind" derives from its default export at upsert time.
- Changes needed: the eval harness (native `eval-harness.ts`, QuickJS `quickjs-prelude.ts`) branches on class vs function. Typecheck `typecheck.ts` accepts `ScriptMain | DurableObjectClass`. Signature extraction (`extract-signature.ts`) reads public async methods and their arg types into a per-method args schema.
- Sketch (not final):
  ```ts
  export default class Counter extends DurableObject<{ count: number }> {
    initialState() { return { count: 0 }; }
    async increment(args: { by?: number }, ctx: ScriptContext) {
      this.state.count += args.by ?? 1;
      return this.state.count;
    }
  }
  ```
- Each call is still one normal script run: construct the class, set `this.state` from KV, call the method, save `this.state`. No long-lived process, so both executors work unchanged in their lifecycle.
- Code versioning: a call runs the latest script version against the stored state. State shape migrations are the author's job (for example a `version` field in state). Open: whether to pin.

### Q: Which callers can reach an object method in v1?
All of them: schedules (alarms), workflow nodes, App actions, HTTP endpoints, plus agent and script calls. For agent and script calls, Taras asks to extend the existing script tools instead of adding new ones: "something new in swarm means the swarm needs to learn how to use it."

**Insights:**
- Agreed. A new `object-call` tool is not worth it. Every new tool costs prompt surface, skill docs, e2e coverage and model learning.
- **Decision: one shared call-target shape on every script call site:** `object: { id, method }` next to the existing script reference and `args`.
  - `script_run` (saved mode): `{ name, object: { id, method }, args }`. Scripts already reach it as `ctx.swarm.script_run`. *(superseded in Round 2: `ctx.durable` adds a typed namespace on top)*
  - Schedules (`targetType='script'`), `swarm-script` workflow node, App action `kind: "script"`, per-script HTTP endpoints: the same optional `object` field.
  - Rule: `object` is required when the script exports a `DurableObject` and refused when it exports a function. Clear error text in both cases, through the `NUDGES` map.
- Inspection needs no new tool either: reads of `object:*` KV namespaces stay open (`kv_get`, `kv_list`). *(superseded: reads gated, see Round 3)* `script-query-types` (there is no `script-get` tool) should show the kind and the method list.
- Agent learning then lands in one place: the `swarm-scripts` skill gets an "Objects" section. A typed sugar such as `ctx.objects.get(name, id).increment()` can come later, if usage shows the need. *(superseded: Round 2 decided `ctx.durable`; `ctx.objects` is taken)*

### Q: Who can call which object id?
Global per script. Namespace `object:<scriptId>:<id>`. *(superseded: namespace `durable:<scriptId>`; v1 object scripts are global scope only, see Round 3)*

**Insights:**
- No new RBAC verb. Permission to run the script is permission to call any of its objects.
- `scriptId`, not the name, so a rename keeps state. Deleting the script should delete its `object:<scriptId>:*` namespaces (or leave them to TTL, see lifecycle).
- Ids are free strings chosen by the caller. Creation is implicit on first call (`initialState()`), as in Durable Objects.

### Q: What happens to state when a method throws or times out?
Discard all `this.state` changes and release the lease. The caller gets the error. Taras adds: "we should take into account versioning."

**Insights:**
- State only moves on success, like a rolled-back transaction. This also matches timeouts, where the process dies and no state can be read.
- Side effects before the throw are not undone. The skill doc must say: put the side effect last, or split it into its own method.
- "Versioning" has two meanings, handled separately:
  1. **State version** (a commit counter): bumped on every successful commit and checked with the lease for fencing. Already in the design.
  2. **Code version vs stored state**: `script_versions` exists, so a new script version can meet state written by an older one. See the next question.

### Q: When new code meets state written by an older version, what runs?
Latest code plus a migrate hook.

**Insights:**
- The stored snapshot carries `{ codeVersion, stateVersion, state }`.
- On load, if `codeVersion` < the current script version, the runtime calls the optional `migrate(state, fromVersion)` before the method. The migrated state commits together with the method's changes, so a failed method also discards the migration (consistent with the failure rule).
- No hook declared: the old state passes through as-is.
- Lazy per object. No bulk migration job. Objects that nobody calls stay on old shapes, which is harmless.

### Q: What if a method calls its own object again (A -> A, A -> B -> A)?
Reject with a clear error.

**Insights:**
- The run credential (`runScriptWithRunCredential` mints a per-run token) carries the chain of object leases held upstream. *(mechanism fixed in Round 3: `objectChain` + `depth` columns on `session_tokens`)* A call to an object already in the chain fails at once: "object X is already in this call chain".
- Normal contention gets a lease-wait timeout (about 30 s) that fails with "object busy". The caller can retry.
- Chain tracking needs the chain to pass through `ctx.swarm.script_run` and through agent tasks started from a method (a method that calls `send-task` must not leak its lease into the child task, which runs later and outside the call).

### Q: How do objects end?
`this.destroy()` plus an optional idle TTL.

**Insights:**
- `this.destroy()` inside a method: on success, the runtime deletes `state/<id>` (and later `data/<id>/*`).
- `static idleTtlSec` on the class: each commit sets KV `expires_at` = now + TTL. Lazy KV expiry is fine, because an expired read returns "absent", which means a fresh `initialState()`.
- Script delete removes the whole `object:<scriptId>` namespace.

### Q: Can an object method do long work?
"Let's do 2 via 1": long work runs as a durable script run, started by a short method, and it reports back through a callback method.

**Insights:**
- The object coordinates, the durable run works. A method starts the durable run (existing `/api/script-runs` path) and returns at once. The lease is released at commit, so the object stays callable for hours of background work.
- **Callback = the shared call-target shape again.** A durable run start (and later an agent task, through the defer or wait-on-task path) accepts `onComplete: { script, object: { id, method } }`. On finish the runtime calls that method with `{ runId, status, result | error }`. No new concept: it is one more script call site.
- The lease chain does not pass into the spawned run. The run starts after the method, so its callback into the same object is not re-entry. It waits for the lease like any caller.
- Ordering risk: if a method starts a run and then throws, state is discarded but the run still goes, and its callback arrives for work the object "does not know". v1 rule: start long work as the last step, and callback methods must accept unknown `runId`s. Deferred: an outbox (start runs only after a successful commit).
- The same pattern covers alarms: a method creates a one-time schedule whose target is `{ script, object: { id, method } }`.

**Refinement on the KV layout** (from thinking about listing): one namespace per script, not per object. Namespace `object:<scriptId>`, keys `state/<id>` and `lease/<id>`. Then `kv_list({ namespace, prefix: "state/" })` lists the objects of a script with no new tool. Multi-key storage later uses `data/<id>/<key>`. *(final name: `durable:<scriptId>`)*

### Q: What do we call the base class?
`DurableObject`.

**Insights:**
- Models and people already know the pattern from Cloudflare, so the learning cost is lower.
- Risk: models expect Cloudflare APIs (`this.ctx.storage`, `fetch()`, `env`). The skill doc gets one short "differences from Cloudflare" table.

### Round 2 (after research review, 2026-11-17)

Taras's review comment on the research doc asked how objects fit extensions, Apps and pages. It also asked about typed access from scripts and pages, objects as page storage, and streaming or WebSocket needs. Facts: [research doc](../research/2026-11-17-durable-script-objects.md), sections 7 to 10.

#### Q: How do other scripts get typed access?
A 4th type contributor plus `ctx.durable`.

**Insights:**
- Today `script_run` returns `unknown`, and no generator turns one script's `signatureJson` into caller types.
- The contributor works like Apps' `App_<Name>`. It renders each object script's methods into a `DurableRegistry`.
- Call shape: `ctx.durable.prCoordinator("repo#1").requestReview({...})`, with typed args and result. It is sugar over `script_run` + `object`, so the runtime path stays one.
- The name is `durable`, because `ctx.objects` is already taken (`SDK_NAMESPACES` holds `objects`, `sheets`, `boards`).
- This replaces the earlier "deferred typed sugar" decision. Staleness follows the existing posture: stored scripts are not re-typechecked when an object script changes.

#### Q: Can pages use objects as their state?
Yes, through `swarmSdk.durable(script, id).method(args)` in the injected page SDK.

**Insights:**
- Pages today keep state in KV `task:page:<id>` and have no scripts domain in the SDK.
- The call goes through the page proxy to `script_run` + `object`. It runs as the page owner's agent, like other page SDK calls.
- Pages gain single-writer state plus server-side logic (votes, queues, counters) that plain page KV cannot give.
- **Auth consequence:** a public page (anonymous guests allowed) lets any visitor call any method of any object the owner can reach. So every page call passes `caller: { kind: "page", pageId, viewer? }` into the method, as App actions already pass `caller`. The object decides. The skill doc must say this plainly.
- The page SDK stays plain JS. A typed `.d.ts` for page code can follow later (none exists today).

#### Q: What realtime support do objects get?
A change feed on a realtime channel.

**Insights:**
- After each successful commit (`afterCommit`), publish `{ id, stateVersion }` on channel `durable:<scriptId>:<id>`. Pages subscribe with the existing `swarmSdk.channel()`, then re-read or re-call. *(superseded in Round 3: subscribe-only namespace `durable:<scriptId>`, hashed channel name, `swarmSdk.durable().subscribe()`)*
- No streamed method results in v1. Script runs are request/response, and no streaming path exists.
- This inherits the single-replica limit of the realtime bus (`runbooks/realtime-rooms.md:89`). That is acceptable for a notification. The state itself stays correct across replicas, because it lives in the DB.

#### Q: How do extensions use objects?
They bundle object scripts and get `ctx.durable` in hook ctx.

**Insights:**
- `assets.scripts` are normal global scripts owned by `ext:<name>`, so object scripts ship there once the kind exists.
- Hook ctx gains the same typed `ctx.durable`. Calls carry `callOrigin: "extension"`, so tool hooks do not recurse.
- Hooks get per-entity single-writer state (per task, per PR). Today nothing serializes hook calls per entity.

#### Corrections from research (no new decision, mechanism changed)
- **Re-entry detection.** Research found that a nested `script_run` writes its `script_runs` row only after it ends (`recordInlineScriptRun`). Workflow steps and App actions write no row at all. So "walk the running `parentScriptRunId` chain" has nothing to walk.
  - New mechanism: the run token provenance carries the chain. Provenance already flows server-side through tokens (`sourceScriptRunId`, `sourceStepId`, forgery-proof per the existing test). Add `objectChain` (held `scriptId:id` pairs) and a `depth` counter.
  - A nested mint inherits them from `getCurrentRunProvenance()`. Re-entry and the depth cap check that list, not DB rows.
  - Precedent: `MAX_SUB_WORKFLOW_DEPTH = 16` with lineage and cycle checks (`sub-workflow.ts:33-34`).
- **`onComplete` dispatch and replicas.** `workflowEventBus` is an in-process `EventEmitter`. A bus listener is fine for v1 (single API process). A multi-replica future needs the callback recorded durably, for example a pending-callback row the finish path writes in its transaction, so that any process can dispatch it. Deferred, defaulting to a bus listener plus a startup reconcile of finished runs whose callback has not fired.
- **Lease helper.** `claimKv` already gives an atomic take-if-absent-or-expired TTL lease, and comb shows the settle pattern (token check inside a transaction, then overwrite or delete). The object lease reuses it. The commit is a transaction that checks the lease token, writes `state/<id>`, and deletes `lease/<id>`.

#### Round 3: review fixes (2026-11-17)

An independent review found 5 Critical, 10 Important and 4 Minor issues. Taras said: "auto fix and update the doc". Each fix below is now a decision, and the Synthesis reflects it. The log is in "Review Errata" at the end.

- **Method allowlist (C2).**
  - Callable methods are the subclass's own prototype methods, minus a reserved set: `constructor`, `initialState`, `migrate`, `destroy`, any name that starts with `_`, and statics.
  - Upsert writes the allowlist into `signatureJson.methods`. The host refuses a method that is not on the list before it takes the lease.
- **Re-entry mechanism (C3).**
  - The lease value is a random lease token, not a `runId`.
  - A migration adds `objectChain TEXT` (JSON list of `scriptId:id`) and `depth INTEGER` to `session_tokens`. Provenance is stored as columns there today (`users.ts:764-767`).
  - Every mint path inherits both from `getCurrentRunProvenance()`.
  - Paths that do not inherit them fall back to the busy timeout. These are App actions, UI-spec script actions, app sync, heartbeat, follow-up gate (all `runSavedScriptAsAgent`), extension hooks, schedules and `x.ts` endpoints.
  - Depth cap: 16, the same as `MAX_SUB_WORKFLOW_DEPTH`.
- **`onComplete` delivery (C4).**
  - `script_launchRun` resolves the target to a `scriptId` at launch. It stores it in a new `script_runs.onCompleteJson` column, and adds `callbackFiredAt`.
  - When the run reaches a terminal status, the finish path schedules dispatch through `afterCommit`. The dispatcher calls the method, and it sets `callbackFiredAt` after that method commits.
  - Delivery is **at least once**. "object busy" retries up to 5 times with backoff. A method that throws is not retried and is logged. Callbacks must be idempotent (key on `runId`).
  - The callback runs as the agent that launched the run.
  - On API startup, a reconcile pass dispatches every terminal run with `onCompleteJson` set and `callbackFiredAt` null.
  - `paused` runs never resume today (research Q3), so they get no callback until they finish.
- **Public exposure is deny by default (C5).**
  - A class opts methods into public paths with `static exposed = { page: ["cast"], http: ["hit"] }`.
  - Agents, scripts, schedules, workflow nodes, App actions and `onComplete` can call any allowlisted method. Pages and `x.ts` endpoints can call only `exposed` methods.
  - An HTTP endpoint pins one `objectMethod`. It reads the id from the request body field `objectId`, validated against an optional `idPattern` on the endpoint row.
  - Caller identity is `ctx.caller`, never inside args:
    ```
    { kind: "agent" | "script" | "schedule" | "workflow" | "app" | "page" | "http" | "callback", agentId?, pageId?, viewerUserId?, endpointId?, runId? }
    ```
- **Realtime feed (C1).**
  - Add realtime namespace `durable:<scriptId>`. `authorizeRoomNamespace` gets a branch that allows subscribe only and refuses client publish. Only the server publishes.
  - The channel name is `d_` plus the first 40 hex chars of `sha256(id)`. That fits `^[a-zA-Z0-9_-]{1,64}$` (`src/realtime/browser.ts:370`).
  - Page code never builds the name. It calls `await swarmSdk.durable(script, id).subscribe(cb)`.
  - Pages may subscribe to a `durable:` namespace only for scripts with at least one `exposed.page` method. Today page connections are pinned to their own namespace (`src/realtime/auth.ts:59-62`).
- **Lease mechanics (I1).**
  - Lease TTL = the method wall clock + 10 s margin. There is no heartbeat. If the API process dies, the object stays locked for at most that TTL.
  - Taking the lease uses `claimKv` (`db.ts:14053-14075`), which never claims a row with a NULL `expires_at`. So the lease key always has a TTL.
  - Waiting is polling with jittered backoff, bounded by the smaller of 30 s and the caller's remaining wall clock. There is no fairness, and starvation under heavy contention is accepted in v1.
  - If the lease token no longer matches at commit, the outcome is "lease lost". State is not saved, the caller gets an error, and side effects already ran.
- **Commit transaction (I2).** In one `getDbClient().transaction`:
  1. Check that `lease/<id>` holds this call's token.
  2. Check the loaded `stateVersion`.
  3. If the state changed, upsert `state/<id>` with `stateVersion + 1`, the current `codeVersion` and `expires_at` = now + `idleTtlSec` (when set). If it did not change, refresh only `expires_at`.
  4. Delete `lease/<id>`.
  5. `afterCommit`: publish on the feed, but only when the state changed.
  - Before step 1, the host checks the encoded state size against the KV 2 MiB limit and fails with "state too large".
- **Scope, naming and reads (I3).**
  - v1 object scripts must be **global scope**. Upsert refuses a `DurableObject` in agent scope. That removes name shadowing (agent scope resolves first, `http/scripts.ts:611-615`), and schedules (global-name only) can target every object script.
  - Every saved target (schedule, workflow node, App action, endpoint, `onCompleteJson`) stores the `scriptId`.
  - The KV family is **`durable`**, not `object`, to match `ctx.durable` and avoid confusion with the existing `objects` primitive (`sdk-allowlist.ts:274`).
  - The family is reserved for writes. Agent reads of `durable:<scriptId>` are allowed only to callers that can run that script, and go through `scrubSecrets` on egress.
- **Version downgrade and migrate failure (I4).**
  - If the stored `codeVersion` is greater than the running version (for example a workflow node with an old `pinHash`), the call fails with "state written by a newer version". It does not run old code on newer state.
  - A `migrate()` that throws makes every call to that object fail until the code is fixed. The skill doc says so.
- **Destroy (I5).** A call that arrives after `destroy()` gets a fresh `initialState()`. That includes queued waiters, alarms and `onComplete`. This is accepted and documented, with no tombstone in v1. Alarms that must not resurrect an object check a state field.
- **Names and fields (I6).**
  - `this.id` is a read-only base-class property.
  - `ctx.durable` keys are the camelCase of the script name (`pr-coordinator` → `prCoordinator`). Upsert refuses an object script whose camelCase key collides with another one.
  - `ctx.caller` is set for every origin (see C5).
  - Examples now use the real names: `task_send`, `schedule_create` with `targetType` / `scriptName` / `delayMs` / `cronExpression`, workflow node `scriptName`, App action `scriptId`.
- **Executors (I7).**
  - `ctx.durable` is a new ctx namespace. That needs both preludes (the QuickJS ctx is a frozen Proxy), the native ctx and the typecheck base, plus a `RESERVED_CTX_KEYS` entry.
  - The state is captured when the method returns. Un-awaited work that mutates `this.state` after return is lost on both executors: QuickJS drops it, and native drains it but no longer reads state. The skill doc says so.
- **Extensions (I8): moved out of v1.** The `ext:<name>` RBAC on `script_run` is unknown (research residual gap). A lease wait inside a hook can block event dispatch for up to 30 s. A hook fired by a method's own tool call can deadlock until the timeout. Revisit after PR 4, with a short hook lease wait and chain inheritance.
- **Planner checklist (I9).**
  - Observability: add `objectScriptId`, `objectId` and `method` columns to `script_runs`. Make every object call record a row (today App actions and workflow steps write none).
  - Limits: a state size check before commit. A call-rate limit for `page` and `http` callers.
  - Migrations, numbered against `main`'s tail at plan time:
    - `scheduled_tasks` object columns;
    - `script_apis` `objectMethod` + `idPattern`;
    - `session_tokens` `objectChain` + `depth`;
    - `script_runs` `onCompleteJson`, `callbackFiredAt` and the object columns.
  - Tests: e2e scenarios in `scripts/e2e/scenarios/` and `coverage-manifest.json` entries. No new unit tests for API code.
  - Docs: the `swarm-scripts` skill plus `build:skill-md`, `docs:openapi` for new route fields, and `build:script-types` for the SDK `.d.ts`.
- **v1 slicing (I10).** Four PRs, each shippable:
  - **PR 1, core:** class export on both executors, lease and commit, `script_run` and `ctx.swarm.script_run` with `object`, the method allowlist, the KV `durable` family guard, re-entry and depth, `ctx.caller`, run-row columns, the skill doc and e2e scenarios.
  - **PR 2, alarms and long work:** schedules, the `swarm-script` node, and `onComplete` with persistence and reconcile.
  - **PR 3, typing and Apps:** `ctx.durable` with the type contributor, and App script actions.
  - **PR 4, public surfaces:** `exposed`, pages (`swarmSdk.durable` + `subscribe`), HTTP endpoints and the realtime feed.
  - Extensions come later.

## Synthesis

### Key Decisions
- **Not a new entity.** An object is a saved **global-scope** script whose default export is `class X extends DurableObject<State>`. A function default export stays a normal script. The kind derives from the export at upsert.
- **v1 traits:** named instances + state, single-writer per id, callable methods. Alarms reuse schedules.
- **Callable methods:** the subclass's own prototype methods minus `constructor`, `initialState`, `migrate`, `destroy`, `_*` and statics. The allowlist is stored in `signatureJson.methods` and enforced before the lease.
- **Single-writer = KV lease with fencing.** `claimKv` takes `lease/<id>` with a random token and TTL = wall clock + 10 s (no heartbeat). One commit transaction checks the token, writes the state, deletes the lease. No transaction is open while user code runs. Lease wait: polling with backoff, up to the smaller of 30 s and the caller's remaining wall clock. A token mismatch at commit is "lease lost". Plain SQL, portable to Postgres and to more than one API replica.
- **Storage = snapshot on KV.** Namespace `durable:<scriptId>`, keys `state/<id>` (`{ codeVersion, stateVersion, state }`) and `lease/<id>`. The family is write-reserved. Reads are allowed only to callers that can run the script, and are scrubbed. Unchanged state only refreshes the TTL. Size is checked against 2 MiB before commit.
- **Scope:** global per script. Permission to run the script is permission to call its objects (for allowlisted methods). No new RBAC verb. Implicit creation on first call through `initialState()`.
- **Public paths are deny by default.** Pages and `x.ts` endpoints may call only methods listed in `static exposed = { page: [...], http: [...] }`. Every call gets `ctx.caller` (`kind` + ids).
- **No new tools.** One shared call-target shape `object: { id, method }` on every script call site: `script_run` (saved mode, so also `ctx.swarm.script_run`), schedules, `swarm-script` workflow node, App `kind: "script"` actions, per-script HTTP endpoints. Saved targets store the `scriptId`. `object` is required for object scripts and refused for function scripts.
- **Failure:** a throw or timeout discards state changes and releases the lease. Side effects are not undone. State is captured at return, so mutations after return are lost.
- **Code versioning:** latest code always. An optional `migrate(state, fromVersion)` runs lazily when the stored `codeVersion` is older, and commits with the method. A stored `codeVersion` newer than the running one fails the call.
- **Re-entry and depth:** the chain of held objects and a depth counter ride in run-token provenance (`session_tokens.objectChain`, `depth`), inherited on every mint path that carries provenance. Re-entry fails at once. Depth > 16 fails. Other contention fails after the lease wait as "object busy". Paths without provenance fall back to the busy timeout.
- **Lifecycle:** `this.destroy()` plus optional `static idleTtlSec`. A call after destroy re-creates the object (accepted, documented). Script delete removes the namespace.
- **Long work:** short methods only. Long work runs as a durable script run with `onComplete: { script, object: { id, method } }`. Stored as `script_runs.onCompleteJson` + `callbackFiredAt`. Dispatch is at-least-once after commit, with a busy retry and a startup reconcile. It runs as the launching agent. The lease chain does not pass into spawned runs.
- **Typed access:** a 4th script type contributor renders object methods into a `DurableRegistry`. Scripts call `ctx.durable.<camelName>(id).<method>(args)`, which is sugar over `script_run` + `object`. CamelCase collisions are refused at upsert.
- **Pages:** `swarmSdk.durable(script, id).method(args)` and `.subscribe(cb)` in the page SDK. Run as the page owner's agent, `exposed.page` methods only.
- **Realtime:** after a commit that changed state, the server publishes `{ id, stateVersion }` on namespace `durable:<scriptId>`, channel `d_<sha256(id)[0:40]>`. Clients may only subscribe. No streamed method results.
- **Name:** `DurableObject`.
- **Delivery order:** PR 1 core, PR 2 alarms + `onComplete`, PR 3 `ctx.durable` + Apps, PR 4 pages + HTTP + feed. Extensions come later.
- Deferred: extensions (`ctx.durable` in hooks, bundled object scripts). Defaulting to "not in v1".
- Deferred: an outbox that starts long work only after a successful commit. Defaulting to the rule "start long work as the last step, callbacks accept unknown `runId`s".
- Deferred: read-only methods without a lease. Defaulting to "every method takes the lease".
- Deferred: multi-key storage (`this.storage.get/put` under `data/<id>/<key>`). Defaulting to snapshot only.
- Deferred: agent-scope object scripts. Defaulting to global scope only.
- Deferred: fair lease queueing and a lease heartbeat. Defaulting to backoff polling and TTL = wall clock + margin.

### Examples

These sketches show the intended shape. The SDK names (`script_run`, `script_launchRun`, `schedule_create`, `task_send`) and the existing fields (`targetType`, `scriptName`, `delayMs`, `cronExpression`, `scriptId`) exist today. `object`, `onComplete`, `exposed`, `ctx.caller` and `ctx.durable` are proposals.

**1. The smallest object: a rate limiter per Slack channel.**

```ts
// saved script "channel-rate-limit"
type State = { windowStart: number; count: number };

export default class ChannelRateLimit extends DurableObject<State> {
  static idleTtlSec = 24 * 3600; // forget idle channels after a day

  initialState(): State {
    return { windowStart: Date.now(), count: 0 };
  }

  async hit(args: { limit: number; windowSec: number }) {
    const now = Date.now();
    if (now - this.state.windowStart > args.windowSec * 1000) {
      this.state = { windowStart: now, count: 0 };
    }
    if (this.state.count >= args.limit) return { allowed: false };
    this.state.count += 1;
    return { allowed: true, remaining: args.limit - this.state.count };
  }

  async peek() {
    return this.state;
  }
}
```

**2. Callers. The same object from an agent and from another script.**

```jsonc
// agent tool call (existing tool, one new field)
script_run {
  "name": "channel-rate-limit",
  "object": { "id": "C0AR967K0KZ", "method": "hit" },
  "args": { "limit": 5, "windowSec": 60 }
}
// -> { "allowed": true, "remaining": 4 }
```

```ts
// inside any other script
const r = await ctx.swarm.script_run({
  name: "channel-rate-limit",
  object: { id: channelId, method: "hit" },
  args: { limit: 5, windowSec: 60 },
});
if (!r.allowed) return "rate limited";

// typed sugar (Round 2): same call, args and result typed from the class
const r2 = await ctx.durable.channelRateLimit(channelId).hit({ limit: 5, windowSec: 60 });
```

```js
// page code: the injected page SDK, plus a live feed (see Example 7 for the class)
const poll = swarmSdk.durable("lunch-poll", "2026-11-18");
await poll.cast({ option: "ramen" });     // only methods in static exposed.page
await poll.subscribe(refresh);            // server-published { id, stateVersion } events
```

**3. A coordinator with long work, a callback, an alarm, a migration and an end.**

```ts
// saved script "pr-coordinator", object id = "<repo>#<pr>"
type State = {
  v: 2;
  reviews: Record<string, "running" | "done" | "failed">; // runId -> status
  lastResult?: unknown;
};

export default class PrCoordinator extends DurableObject<State> {
  static idleTtlSec = 30 * 24 * 3600;

  initialState(): State {
    return { v: 2, reviews: {} };
  }

  // Runs lazily when state was written by an older script version.
  // fromVersion is the script version that wrote the state, not state.v.
  migrate(old: any, fromVersion: number): State {
    if (fromVersion < 4) return { v: 2, reviews: old.runs ?? {} };
    return old;
  }

  // Short method: start long work, record it, return. The lease is released at commit.
  async requestReview(args: { repo: string; pr: number }, ctx: ScriptContext) {
    const run = await ctx.swarm.script_launchRun({
      name: "pr-review-workflow",
      args,
      onComplete: {
        script: "pr-coordinator",
        object: { id: this.id, method: "onReviewDone" },
      },
    });
    this.state.reviews[run.runId] = "running";
    // Alarm: an existing one-time schedule that targets this object.
    await ctx.swarm.schedule_create({
      targetType: "script",
      scriptName: "pr-coordinator",              // stored as scriptId
      object: { id: this.id, method: "checkStale" },
      delayMs: 2 * 3600_000,
    });
    return { runId: run.runId };
  }

  // Callback from the durable run. Takes the lease like any caller.
  // Delivery is at least once, so this must be idempotent (keyed on runId).
  async onReviewDone(args: { runId: string; status: "completed" | "failed"; result?: unknown }, ctx: ScriptContext) {
    if (ctx.caller.kind !== "callback") return;
    if (this.state.reviews[args.runId] !== "running") return; // unknown or already handled
    this.state.reviews[args.runId] = args.status === "completed" ? "done" : "failed";
    this.state.lastResult = args.result;
  }

  async checkStale(_args: {}, ctx: ScriptContext) {
    const stuck = Object.entries(this.state.reviews).filter(([, s]) => s === "running");
    if (stuck.length) await ctx.swarm.task_send({ task: `Review stuck on ${this.id}` }); // args per task_send
  }

  async merged() {
    this.destroy(); // state is deleted when this method commits
  }
}
```

**4. Other call sites. The same target shape everywhere.**

```jsonc
// schedule (cron alarm)
{ "targetType": "script", "scriptName": "pr-coordinator",
  "object": { "id": "agent-swarm#3280", "method": "checkStale" }, "cronExpression": "0 * * * *" }

// workflow node (swarm-script config uses scriptName)
{ "type": "swarm-script", "config": { "scriptName": "pr-coordinator",
  "object": { "id": "{{trigger.repo}}#{{trigger.pr}}", "method": "requestReview" },
  "args": { "repo": "{{trigger.repo}}", "pr": "{{trigger.pr}}" } } }

// App action (existing shape is { scriptId, args })
{ "kind": "script", "scriptId": "<channel-rate-limit scriptId>",
  "object": { "id": "{{row.channelId}}", "method": "peek" } }

// HTTP endpoint row (script_apis): one pinned method, id from the body
{ "authMode": "none", "objectMethod": "cast", "idPattern": "^\\d{4}-\\d{2}-\\d{2}$" }
// POST /api/x/script/<endpointId>  { "objectId": "2026-11-18", "args": { "option": "ramen" } }
```

**5. What is stored, and what agents can see.**

```jsonc
// kv_get { namespace: "durable:<scriptId>", key: "state/agent-swarm#3280" }  (needs permission to run the script)
{ "codeVersion": 5, "stateVersion": 12,
  "state": { "v": 2, "reviews": { "run_abc": "done" }, "lastResult": { "verdict": "lgtm" } } }

// kv_list { namespace: "durable:<scriptId>", prefix: "state/" }  -> one key per live object, 1000 per page (use offset)
// kv_set  { namespace: "durable:<scriptId>", ... }                -> error: object state is written only by object calls
```

**6. Errors the caller can get.**

| Case | Error text (sketch) |
|---|---|
| Lease not free within about 30 s | `object busy: pr-coordinator/agent-swarm#3280. Retry later.` |
| Call back into an object already in the chain | `object pr-coordinator/agent-swarm#3280 is already in this call chain` |
| `object` passed to a function script | `script "x" is not a DurableObject. Remove "object".` |
| `object` missing for an object script | `script "pr-coordinator" is a DurableObject. Pass object: { id, method }.` |
| Unknown method | `pr-coordinator has no method "foo". Methods: requestReview, onReviewDone, checkStale, merged` |
| Method throws | the error itself. State is unchanged. |
| Method not callable (reserved, `_*`, static) | `pr-coordinator.migrate is not callable` |
| Method not exposed to a page or endpoint | `lunch-poll.close is not exposed to page callers` |
| Lease expired before commit | `lease lost on pr-coordinator/agent-swarm#3280. State not saved. Side effects may have run.` |
| State over 2 MiB | `state too large for pr-coordinator/agent-swarm#3280 (2.4 MiB > 2 MiB). State not saved.` |
| Chain deeper than 16 | `call depth 17 exceeds the limit of 16` |
| Stored state newer than running code | `state of pr-coordinator/agent-swarm#3280 was written by version 7. This call runs version 5.` |

**7. A public page object with deny-by-default exposure.**

```ts
// saved script "lunch-poll" (global scope), object id = a date
type State = { open: boolean; votes: Record<string, string> }; // voter -> option

export default class LunchPoll extends DurableObject<State> {
  static exposed = { page: ["cast", "tally"] }; // "close" stays agent-only
  static idleTtlSec = 7 * 24 * 3600;

  initialState(): State { return { open: true, votes: {} }; }

  async cast(args: { option: string }, ctx: ScriptContext) {
    if (!this.state.open) throw new Error("poll closed");
    const voter = ctx.caller.viewerUserId ?? `guest:${ctx.caller.pageId}`;
    this.state.votes[voter] = args.option;
    return this.tally();
  }

  async tally() {
    const counts: Record<string, number> = {};
    for (const o of Object.values(this.state.votes)) counts[o] = (counts[o] ?? 0) + 1;
    return counts;
  }

  async close() { this.state.open = false; }
}
```

### Resolved Questions (checked against the code on 2026-11-17)

1. **SDK names.** All three exist and are reachable from scripts today (`sdk-allowlist.ts`):
   - `ctx.swarm.script_run`: maps to `script-run` and `POST /api/scripts/run`.
   - `ctx.swarm.script_launchRun`: maps to `launch-script-run`, with `script_getRun` / `script_listRuns`. It goes through `/api/mcp-bridge`.
   - `ctx.swarm.schedule_create`: maps to `create-schedule` and `POST /api/schedules`.
   - **Effect:** the snippets use the real names. *(Round 3 correction: `ctx.durable` is a new ctx namespace. It needs a `RESERVED_CTX_KEYS` entry and changes to both preludes.)*
2. **Completion hooks: none.**
   - Durable runs only call `updateScriptRun*` on finish (`supervisor.ts`, `src/http/script-runs.ts:664-689`). No event, hook or webhook.
   - `deferred_task_waits` (150/153) and `deferred_event_waits` (339) wake on task or event, then create a standalone **agent task** through a one-time schedule. They have no script target.
   - **Decision (Taras, 2026-11-17): build `onComplete`.** The run-finish path emits `script_run.finished` through `getDbClient().afterCommit`. A dispatcher then calls the object method with `{ runId, status, result | error }`. It fires on failure and on supervisor-detected crash too.
   - v1 covers durable runs only. An agent-task `onComplete` (through the defer path) is deferred.
3. **KV guard.**
   - Writes are checked in two places: `kvWriteAuthError` (`src/tools/kv/kv-write-auth.ts`) for tools, and `authorizeWrite` (`src/http/kv.ts:369-390`) for HTTP. The script SDK `kv_*` calls use the HTTP routes. Both read `RESERVED_FAMILIES` in `src/kv-reserved-namespaces.ts`.
   - Precedent: `_room/` keys are already refused on both paths.
   - Internal writers (`upsertKv`, `deleteKv`, `incrKv`, `claimKv` in `src/be/db.ts`) skip auth. Apps (`src/apps/row-store.ts`) write reserved namespaces this way.
   - **Effect:** add the family to `RESERVED_FAMILIES`. That blocks agent writes on every path. *(Round 3: the family is named `durable`, and reads are gated on permission to run the script, with scrubbing.)* The object runtime writes through the internal helpers. `claimKv` is a candidate for taking the lease. Check its semantics in the plan.
4. **QuickJS and native.**
   - Both epilogues check `typeof mod.default === "function"` (a class passes), then call `mod.default(args, ctx)` without `new`. A class throws there.
   - Results cross as `JSON.stringify` only (`quickjs-prelude.ts:603-612`).
   - **Effect:** both epilogues (`eval-harness.ts` and `quickjs-prelude.ts`) need one branch. Detect a `DurableObject` subclass, then `new`, set `id` / `state`, optionally `migrate`, dispatch the method, and return `{ result, state, destroyed }` as JSON.
   - State must be JSON. That matches the existing result rule. The host does the load, lease and commit. The guest never touches KV for its own state.
5. **Call chain for re-entry.**
   - The run token carries `agentId` plus `sourceScriptRunId` / `sourceStepId`. A nested `script_run` mints a new token, and `script_runs.parentScriptRunId` records the parent. Client-forged values are ignored (tested).
   - No depth counter or recursion guard exists.
   - *(superseded: inline rows are written only after a run ends, and some paths write none. Round 3 decision: a random lease token, plus `objectChain` / `depth` columns on `session_tokens`, inherited on every mint.)*
   - Add a depth cap (for example 16) on the same walk. That also closes the missing recursion guard for plain scripts.
6. **Signatures.**
   - `extract-signature.ts` reads only a default function. It writes `scripts.signatureJson` (a JSON column) and `argsJsonSchema` from an optional zod `argsSchema`.
   - There is **no `script-get` tool**. Details come from `script-query-types` (with `name`) and the HTTP detail route. `script-search` embeds `signatureJson`.
   - **Effect:** for a class, write `signatureJson = { kind: "object", methods: { <name>: { argsType, resultType, description } } }` into the same column. No migration. An optional `static argsSchemas = { hit: z.object(...) }` gives per-method validation.
   - `script-query-types` shows the kind and the methods. Search embeds the method names and docs.
7. **KV schema and limits.**
   - Only 082 (`created_by` / `updated_by`) and 319 (indexes) change `kv_entries` after 061. 2 MiB per value, list cap 1000, no per-namespace limit.
   - **Effect:** none. The `kv_list` cap of 1000 means a script with more live objects pages with `offset`.
8. **Call-site targets.**

   | Call site | Stored as | Change for `object` |
   |---|---|---|
   | `script_run` / `ctx.swarm.script_run` | request body | zod field |
   | Schedules | typed columns on `scheduled_tasks` (`targetType`, `scriptName`, `scriptArgs`) | migration: `scriptObjectId`, `scriptObjectMethod` columns |
   | `swarm-script` workflow node | zod config in `workflows.definition` JSON | zod field, no migration |
   | App action `kind: "script"` | `{ scriptId, args }` in `apps.definition` JSON | zod field, no migration |
   | Per-script HTTP endpoint | `script_apis` typed table, args from the request | migration: `objectMethod` column; id from the request |

   - Schedules get real columns. Hiding `object` inside `scriptArgs` would mix the target with the args.
   - Deferred: how an HTTP endpoint takes the object id. Defaulting to a fixed `objectMethod` per endpoint, with the id read from the request body field `objectId`.

### Open Questions
(Fact-shaped. The plan answers them from code.)
- Which mint paths pass provenance today, beyond `/api/scripts/run`? List each one that must inherit `objectChain` / `depth`.
- What RBAC applies to `ext:<name>` agents on `script_run`? (Needed before extensions come back into scope.)
- `listScriptConnections` scoping rules: the new `durable` type contributor should filter the same way.
- The exact finish points to hook for `onComplete` dispatch: the status route, the supervisor `exited` handler, cancel, `abortScriptRunLimit` and spawn failure.
- Does `EVENT_TRIGGER_NAMES` need a script-run event, or does `onComplete` stay a direct dispatch?

### Constraints Identified
- SQLite has one writer for the whole DB. No transaction may span user code.
- Postgres and more than one API replica may come later. No process-local ownership of objects.
- Script wall clock is 30 s default, 5 min max. The lease must be longer, with a heartbeat for long calls.
- KV value limit is 2 MiB, so the state snapshot is bounded by it.
- Both executors (native subprocess, QuickJS pool) must support object scripts.
- Worker-side code must not import `src/be/db`. The lease and commit logic lives on the API side.
- New tool surface is costly: the swarm must learn every new tool. Prefer extending existing script call sites.
- The CLAUDE.md rule: no new unit tests for API code. Prove behavior with e2e scenarios in `scripts/e2e/scenarios/`.
- `workflowEventBus` and the realtime bus are in-process. Anything that must survive a restart or cross replicas is written to the DB, not only emitted.
- Realtime channel names must match `^[a-zA-Z0-9_-]{1,64}$`, and page connections are pinned to their own namespace today.
- Public callers (anonymous pages, `authMode: "none"` endpoints) exist. Every public entry point is deny by default.

### Core Requirements
**PR 1, core**
1. An author writes `export default class X extends DurableObject<State>` (global scope) with `initialState()`, public async methods, optional `migrate()`, `static idleTtlSec` and `static exposed`. `this.id` is read-only. `script_upsert` typechecks it, stores the method allowlist in `signatureJson.methods`, and refuses agent scope and camelCase collisions.
2. A caller invokes `script_run({ name, object: { id, method }, args })` from an agent, or `ctx.swarm.script_run` from a script, and gets the method's return value. Non-allowlisted methods fail before the lease.
3. Two calls to the same `(script, id)` never run at the same time. Calls to different ids run in parallel.
4. State persists only when the method returns without an error, the lease token still matches, and the state is under 2 MiB.
5. "object busy" after the lease wait. Re-entry fails at once. Depth > 16 fails. A newer stored `codeVersion` fails.
6. Agents read `durable:<scriptId>` only with permission to run the script. Nobody writes it except the object runtime.
7. Every call gets `ctx.caller`. Every object call records a `script_runs` row with `objectScriptId`, `objectId` and `method`.
8. The `swarm-scripts` skill documents objects. It includes a "differences from Cloudflare" table, the at-least-once and idempotency rules, the lost-after-return rule, and destroy resurrection.

**PR 2, alarms and long work**

9. Schedules and the `swarm-script` node accept `object` and store the `scriptId`.
10. `script_launchRun` accepts `onComplete`. Dispatch is at least once after a terminal status, with a busy retry, `callbackFiredAt`, and a startup reconcile.

**PR 3, typing and Apps**

11. `ctx.durable.<camelName>(id).<method>(args)` is typed from the object script's methods.
12. App script actions accept `object`.

**PR 4, public surfaces**

13. Pages call `swarmSdk.durable(script, id).method(args)` and `.subscribe(cb)`, limited to `exposed.page`.
14. HTTP endpoints pin `objectMethod`, which must be in `exposed.http`, and validate `objectId` against `idPattern`.
15. A commit that changed state publishes `{ id, stateVersion }` on namespace `durable:<scriptId>`, channel `d_<sha256(id)[0:40]>`. Clients may only subscribe.
16. Calls from `page` and `http` callers are rate-limited.

## Next Steps
- Research done: [2026-11-17-durable-script-objects.md](../research/2026-11-17-durable-script-objects.md) (revision 2).
- Next: `/desplega:create-plan` with this brainstorm and the research doc as input.

## Review Errata

_Reviewed: 2026-11-17 by an independent Claude review agent. Applied in full on Taras's instruction ("auto fix and update the doc")._

### Applied
- [x] C1 Realtime feed broken (channel regex, page namespace pinning, client publish, async `channel()`): subscribe-only `durable:<scriptId>` namespace, hashed channel name, `swarmSdk.durable().subscribe()`.
- [x] C2 No callable-method rule: allowlist (own prototype methods minus reserved, `_*`, statics), enforced before the lease.
- [x] C3 Two re-entry mechanisms: Resolved Q5 superseded. Random lease token, `session_tokens.objectChain` + `depth` migration, uncovered paths listed.
- [x] C4 `onComplete` delivery undefined: `onCompleteJson` + `callbackFiredAt`, at-least-once, busy retry, startup reconcile, runs as the launching agent, `paused` noted.
- [x] C5 Public paths reach any object: deny-by-default `static exposed`, pinned endpoint method + `idPattern`, `ctx.caller`.
- [x] I1 Lease mechanics: TTL = wall clock + 10 s, no heartbeat, wait bounded by the caller deadline, no fairness, "lease lost" outcome.
- [x] I2 Commit contents listed. Unchanged state only refreshes the TTL and does not publish.
- [x] I3 Global-scope object scripts only, `scriptId` in saved targets, family renamed `durable`, gated and scrubbed reads.
- [x] I4 Newer stored `codeVersion` fails the call. A throwing `migrate()` is documented.
- [x] I5 Destroy resurrection accepted and documented.
- [x] I6 Example names fixed (`task_send`, `schedule_create` fields, `scriptName`, `scriptId`). `this.id`, the camelCase rule and `ctx.caller` for all origins added.
- [x] I7 `ctx.durable` acknowledged as a new namespace. Mutations after return are lost.
- [x] I8 Extensions moved out of v1.
- [x] I9 Planner checklist: observability columns, limits, migration list, tests, docs.
- [x] I10 v1 split into four PRs. Core Requirements regrouped by PR.
- [x] M1 Early exploration text marked superseded. Synthesis declared authoritative.
- [x] M2 `migrate` example comment: `fromVersion` is the script version.
- [x] M3 Open Questions now list the real fact-shaped gaps.
- [x] M4 Listing pages at 1000 with offset, noted in Example 5.
