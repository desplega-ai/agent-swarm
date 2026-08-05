---
date: 2026-08-04T00:00:00+02:00
author: taras
topic: "Real-time collaboration primitive — WS transport + CRDT rooms on KV, usable from pages, apps, scripts and agents"
tags: [brainstorm, realtime, websocket, crdt, automerge, yjs, kv, pages, apps, scripts]
status: complete
exploration_type: idea
last_updated: 2026-08-04
last_updated_by: taras
---

# Real-time collab primitive — Brainstorm

## Context

Issue [#1090](https://github.com/desplega-ai/agent-swarm/issues/1090) proposes a **shared-state primitive for agent-built multiplayer pages**: `swarmSdk.room()` giving a page a CRDT-merged persistent doc plus ephemeral presence, with page-scoped rooms, dedicated `page_room_docs` / `page_room_updates` tables, and a WS riding the existing `node:http` listener.

Taras wants to go **one step further**: not a pages feature, but a **platform primitive**.

> "a *primitive* for real-time collab based on kv for state persistance and a way to use it anywhere, in apps (see upcoming draft PR), pages, scripts, etc. probably two fold: one is the ws abstraction, two is the automerge/yjs for crdt"

So the framing shifts on three axes vs the issue:

| Axis | Issue #1090 | This brainstorm |
|---|---|---|
| Scope | pages only | pages + apps + scripts + agents (+ dashboard UI?) |
| Persistence | new dedicated tables (`page_room_docs` + `page_room_updates`) | **KV** |
| Shape | one `room()` API | **two layers**: (1) WS/realtime transport abstraction, (2) CRDT layer on top |

The layered framing matters beyond collab: the Swarm Apps brainstorm explicitly **deferred reactive push** and settled for polling, noting that Convex-style reactivity is "cheap only for reads the server can dependency-track". A generic realtime channel layer is exactly the missing piece for app query invalidation — the same transport serving two very different consumers.

## Ironed facts (codebase, 2026-08-04)

Gathered before the Q&A so we spend questions on decisions, not lookups.

### KV as it exists today
- `kv_entries(namespace, key, value TEXT, value_type CHECK IN ('json','string','integer'), expires_at, created_at, updated_at)`, `PRIMARY KEY (namespace, key)`, `WITHOUT ROWID` (`src/be/migrations/061_kv_store.sql`).
- **Value column is `TEXT`, not `BLOB`.** CRDT updates (Automerge/Yjs) are `Uint8Array` → base64 into a JSON/string value, ~33% size overhead, or a new value_type + column.
- `MAX_KV_BODY_BYTES = 2 MiB` per value; `MAX_KV_LIST_LIMIT = 1000` per list page (`src/http/kv.ts`).
- **No CAS, no cross-key transactions.** Only `kv_incr` is atomic (documented hard limit in `templates/skills/kv-storage/content.md`; measured in the `kv-typed-store-pattern` experiment). Concurrent read-modify-write on one key loses updates.
- Namespace resolution is the interesting part — it is already the "usable anywhere" scoping model: explicit → `sourceTaskId`'s `contextKey` → `task:agent:<id>` (`src/tools/kv/resolve-namespace.ts`); HTTP additionally forces `task:page:<id>` from the proxy-injected `X-Page-Id` so a page cannot escape its own namespace.
- ~~Reserved-namespace mechanism exists (`isReservedNamespace`)~~ **CORRECTED 2026-08-04**: `src/kv-reserved-namespaces.ts` is **spike-branch only** (`origin/spike/swarm-apps`), not on `main`. The equivalent mechanism that *is* on `main` is `mcpOverflowAuthError`, called from the same two chokepoints (`authorizeWrite` in `src/http/kv.ts`, `kvWriteAuthError` in `src/tools/kv/kv-write-auth.ts`) — that is the precedent to model on.
- No per-namespace write ACL. Any authenticated caller can write any non-reserved namespace.

### Pages
- CSP (`src/http/pages-public.ts:308`): `script-src` already has `'unsafe-eval'` (Automerge WASM compiles); `connect-src 'self'` → **a WS on a second port is blocked**, must ride the existing listener or CSP changes.
- `src/http/index.ts:210` is a plain `node:http` `createServer`; the `upgrade` event fires under Bun 1.3.11 (verified in the issue). No WebSocket exists in the API today; no `ws`/`yjs`/`automerge` dependency.
- **Pages have no viewer identity.** Page-session cookie payload is `{pageId, exp}` (`src/utils/page-session.ts:20`); the proxy forwards `X-Agent-ID: page.agentId` for *every* viewer (`src/http/page-proxy.ts:155`). `templates/skills/pages/content.md` claims viewer identity exists — that claim is false, and it is a standalone bug.
- Browser SDK is injected as `window.swarmSdk` (`src/artifact-sdk/browser-sdk.ts`), already exposing `swarmSdk.kv` with the namespace forced to `task:page:<id>`.

### Apps (spike/swarm-apps, PR #1066, draft — DO NOT MERGE)
- App model rows already **live in KV**: namespace `apps:<appId>`, keys `<model>/row/<id>` + `idx/...` entries, all writes funnelled through `src/apps/row-store.ts` under a per-(app,model) **in-process mutation lock**.
- UI runtime: one `@json-render/core` `StateStore` per mounted app (JSON-Pointer paths, `useSyncExternalStore`), flat roots `/route`, `/queries/<q>`, `/actions/<a>`, `/forms/…`, `/ui/…`. Queries mirror react-query results — **polling**.
- Next-iteration brainstorm (2026-08-03) already decides a **global ctx** `/apps/<id>/…` with split data plane (keyed by defining app, "shared cache + liveness across consumers") and interaction plane (keyed by instance). "Shared liveness" is a realtime hook waiting for a transport.
- **No per-human identity in the dashboard**: it runs on the operator key. `aswt_` user tokens exist but the Apps UI has no flow to mint/store one. Per-user features are told to follow the favorites pattern (`user:<userId>` vs one shared `operator` scope).

### Scripts runtime
- User TS runs in a `Bun.spawn` subprocess under `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, a wall-clock AbortController (30s default, up to 5m where exposed), 1 MB stdout cap; config arrives over **stdin** as `SwarmConfigPayload`.
- Implication: a script is a **short-lived, non-interactive** participant. "A script joins a room" realistically means *read doc → change doc → exit*, not *hold a socket*. `ulimit -n 64` and no long-lived process make sustained WS participation a non-goal without a different execution mode.

### Deployment
- Helm chart exists (`charts/agent-swarm`) → multi-replica deployments are expressible. In-process room state means either sticky sessions, single-replica, or a broker.

## Exploration

### Q: What does "based on KV for state persistence" mean concretely for the CRDT bytes?
**Snapshot-only, one KV key per room.** The server holds the live CRDT doc in memory, applies and broadcasts changes, and debounce-writes the compacted `Automerge.save()` / `Y.encodeStateAsUpdate()` to a single KV key. No append-only update log, no compaction job, no GC of update rows. The durability window between debounce flushes is covered by clients re-syncing from their own CRDT state on reconnect.

**Insights:**
- This deletes the largest chunk of issue #1090's proposed design (`page_room_updates`, the fold transaction, its GC hook into `scheduleApiGc`) and replaces it with one KV write. The write-amplification worry that motivated the two-tier design doesn't apply once the hot path is memory + broadcast and only the *debounced* result touches storage.
- **Durability is now explicitly best-effort**, and that has to be stated in the primitive's contract, not discovered. "Your change is durable once the flush lands" is a real semantic difference from "durable once its row commits". Acceptable for boards/games/editors where every peer holds a full replica; **not** acceptable for anything treated as a system of record. The skill docs must say so, because agents will otherwise use a room as a database.
- The **2 MiB `MAX_KV_BODY_BYTES` cap becomes the per-room size ceiling** — and it is a *feature*. It structurally enforces the "never write per-frame state to the doc" rule the issue worried about, and it makes the unbounded-growth risk a bounded one. But Automerge keeps change history inside `save()`, so a long-lived room approaches the cap through history, not live data — **history compaction / `room.reset()` is a v1 concern, not a v2 one**.
- Storing the room's materialised state as an ordinary KV value means **reads come free everywhere KV already reaches**: a script can `kv_get` the room doc, an agent can `kv-get` it, the existing dashboard KV browser can show it. Only *writes* need the new machinery. That is what makes "usable anywhere" cheap.
- Open sub-fork this creates: the value is binary (base64 in a TEXT column) and only meaningful after CRDT decode, so a raw `kv-get` returns an opaque blob. Either the room subsystem also maintains a **plain-JSON materialised view** alongside the binary snapshot (readable by anything, 2× storage, always one flush behind), or non-WS readers need a decode step. Revisit during synthesis.
- The room's KV keys must live in a **reserved namespace family** (the `apps:*` precedent, `src/kv-reserved-namespaces.ts`) so generic KV writers can't corrupt a snapshot by hand.

### Q: Which surfaces are in v1?
**Pages + agents-via-MCP.** Apps come "once the PR is merged — as far as it's abstracted / there are tools for it, then it should be easy to integrate." And a counter-question: **what about workflows?**

**Insights:**
- Deferring apps *without* deferring the abstraction is the right call, but it converts "is the transport layer public?" from a design preference into a **hard requirement**: apps must be able to integrate later with zero re-architecture. The apps consumer wants query-invalidation push (channel layer), not CRDT docs — so v1 has to ship the channel layer as a real, documented primitive even though pages+agents alone could get by with a CRDT-private socket.
- Pages + agents is also the minimum pair that proves the *differentiating* claim. Pages alone is "we shipped y-websocket"; the agent peer is the reason this belongs in the swarm.

#### On workflows — three distinct integrations, only one of which is new work

**Fact found:** workflows already have an in-process pub/sub — `workflowEventBus` (`src/workflows/event-bus.ts`), consumed by `wait` nodes in `mode: event` with `scope: run | global`, fed by built-in lifecycle events (`task.*`, `approval.resolved`, `github.*`, `gitlab.*`, `agentmail.*`) and by two HTTP signal endpoints (`POST /api/workflow-runs/<id>/events`, `POST /api/workflow-events`). The runbook documents its **multi-instance limitation** explicitly: "in-process `EventEmitter` … a signal emitted on instance A will not reach a wait paused on instance B. Single-instance only for v1; cross-instance fan-out (Redis pub/sub, etc.) is a separate plan."

1. **Workflow as a room participant** (write/read the doc) — probably **zero new node type**. A `swarm-script` node calling the same room SDK the scripts surface exposes covers it. Same batch-participant shape as scripts: read → change → exit.
2. **Room changes waking a workflow** — one `workflowEventBus.emit('room.changed', …)` from the room subsystem and `wait` nodes get human-in-the-loop for free: a human moves a card on an agent-built page, the paused workflow resumes. **This is the highest-leverage integration in the whole feature** and it is nearly free. Caveat: the runbook's documented ordering trap applies (the wait must subscribe before the event fires), so the natural pattern is external-signal, which room changes are.
3. **Workflow run progress pushed to a page/UI** — the reverse direction; the channel layer again, same consumer shape as apps.
- The unavoidable conclusion (confirmed in the next answer): **`workflowEventBus` and the new "WS abstraction" are the same problem.** Both are in-process pub/sub; both have the same multi-replica limitation; both have the same documented fix (a broker). Building a second, parallel in-process bus for realtime would be a mistake — we'd own two buses and have to fix cross-instance twice.

### Q: How do the realtime layer and `workflowEventBus` relate?
**One bus with a broker-shaped interface, still in-process for v1.** `workflowEventBus` becomes a caller of a single publish/subscribe/topic layer; rooms publish `room.changed` onto it; WS clients subscribe to topics through it. No new infra, no behaviour change for workflows, and the multi-replica fix becomes one swap-in adapter instead of two separate plans.

**Insights:**
- The refactor must be **behaviour-preserving on the workflow side first** — wait nodes are load-bearing and their semantics (`scope: run | global`, `_runId` injection, one-shot delivery, the documented subscribe-before-emit ordering trap) have to survive unchanged. Practically: extract the interface, keep `EventEmitter` as the implementation, prove wait-node tests green, *then* build rooms on top.
- The two existing HTTP signal endpoints (`POST /api/workflow-runs/<id>/events`, `POST /api/workflow-events`) are already the "publish from outside" surface. A generic channel layer should probably subsume rather than duplicate them.
- One-shot delivery (bus) vs durable subscription (a WS client that reconnects and must not miss state) are genuinely different semantics. The unified interface has to express both, or rooms carry their own catch-up path (which they do anyway — a reconnecting Yjs client syncs from the server doc, it doesn't replay events). Worth being explicit: **the bus is fire-and-forget; room correctness never depends on bus delivery.**
- `room.changed` on the bus is the human-in-the-loop unlock, and it composes with the existing `filter` mechanism (`filter: { room: "board", page: "<id>" }`).

### Q: Which CRDT engine?
**Yjs.**

**Insights:**
- The CSP problem from issue #1090 evaporates: Yjs is pure JS, so there's no `.wasm` fetch to be blocked by `connect-src 'self'` and nothing to self-host. Pages can `import` it from `cdn.jsdelivr.net`, which `script-src` already allows — meaning **zero CSP changes for the CRDT** (the WS still has to ride the existing listener).
- Yjs's tombstone GC (`gc: true`) is what makes the 2 MiB snapshot ceiling survivable. Automerge's full-history `save()` has no truncation by design and would have forced history compaction into v1.
- **Effective ceiling is lower than 2 MiB**: Yjs updates are `Uint8Array`, the KV `value` column is `TEXT`, so the snapshot is base64 — ~1.5 MiB of real state per room. Fine for boards/games/docs; must be documented, and the room subsystem should surface size so a room can fail loudly rather than silently stop persisting.
- **`y-protocols/awareness` is presence, off the shelf** — and it is ephemeral and never persisted *by design*, which matches the issue's explicit "presence is never persisted" commitment exactly rather than approximately. Cursors, selections, who's-online come free.
- The server must hold a **live `Y.Doc` per active room**, not act as a dumb relay. Forced by two independent requirements: something has to produce the snapshot for KV, and an agent changing the doc over HTTP/MCP has no client-side replica. Bun runs Yjs fine (pure JS). This also means late joiners sync from the server doc rather than replaying anything.
- **The ergonomics gap is the main adoption risk.** `ymap.set('3','x')` is worse for agent codegen than `d.board[3] = 'x'`, and agents build only what the skill tells them exists. Two mitigations to decide in the plan: wrap Yjs in a proxy layer (`syncedstore` / `valtio-yjs`) to restore plain-mutation ergonomics, or ship a hand-rolled thin wrapper for the shapes we care about (map/array/text) and let the skill doc carry the weight. Recommend the latter — one dependency less, and the wrapper only needs to cover what the skill documents.
- Monaco is already in `apps/ui`, so `y-monaco` makes a collaborative editor a near-freebie if that ever becomes a target.

### Q: How is a room addressed and scoped?
**Namespace-derived — a room is a live KV key.** Room id = `<kv-namespace>/<name>`, resolved by the rules KV already uses. Pages are force-pinned to `task:page:<id>` and cannot escape; bearer-authed callers (agents, scripts, workflow nodes) may name a namespace explicitly, which is exactly what lets an agent join a page's room. Cross-page shared rooms stay out of v1 but aren't designed out.

**Insights:**
- **The asymmetry is the security model, and it's already the KV security model** — untrusted clients (pages) get a server-pinned namespace from a header the proxy injects; trusted bearer callers get explicit addressing. Nothing new to invent, nothing new to audit. `X-Page-Id` handling in the KV handler is the exact precedent to mirror.
- Reuse of `resolveNamespace` means the surfaces list from the earlier answer maps mechanically: page → `task:page:<id>`, agent → `task:agent:<id>`, task-scoped script → the task's `contextKey`, app (later) → `apps:<appId>`. The apps integration Taras wants to be "easy once the PR merges" is then genuinely easy: apps already own `apps:<appId>`.
- Room snapshot keys must sit in a **reserved namespace family** so a hand-written `kv-set` can't corrupt a live room. But rooms are addressed *by* a normal namespace — so the reservation is on the key prefix within it (e.g. `_room/<name>`) rather than on the namespace. Needs care: `isReservedNamespace` is namespace-granular today, so this is a small extension (reserved key prefixes) rather than a reuse.
- Name validation (`[a-zA-Z0-9_-]{1,64}`) still applies as in the issue — a page picks any room name and cannot escape its own prefix.
- Deferred-but-not-blocked: cross-page/shared rooms via asset-key namespaces (`shared/…`, `personal/<userId>/…`). The addressing scheme accommodates it later by granting a namespace; nothing needs to change in the room layer itself.

### Q: How much identity work is in scope?
**Fix page viewer identity as a prerequisite change, shipped as its own PR.** Widen the signed `page_session` payload to `{pageId, exp, uid?, name?}`, stamped at `POST /api/pages/:id/launch` — the one bearer-authed moment where the server knows the viewer. Operator-key sessions get no `uid` → generated guest handle. Password-mode pages mint on `?key=` with no bearer → anonymous by construction.

**Insights:**
- This isn't only a presence enabler, it's a **correctness fix with a security flavour**. `templates/skills/pages/content.md` tells agents that actions on `authed`/`password` pages "run with the viewer's identity, not the page author's." That is false: `src/http/page-proxy.ts:155` forwards `X-Agent-ID: page.agentId` unconditionally. Anyone who built a page trusting that sentence got author-scoped writes for every viewer. The doc fix ships with the code fix regardless of whether rooms happen.
- Because it's HMAC-signed and stamped server-side, **identity is not a client-supplied field** — which is what makes presence names trustworthy enough to be more than decoration, and keeps the door open to using the same identity for room-level authorization later.
- The two degenerate cases are clean rules rather than special cases: no bearer at mint time → anonymous; operator key → guest. Worth stating that way in the skill doc so agents don't treat guest as an error.
- Explicitly **not** in scope: minting `aswt_` user tokens in the dashboard. That is the blocker the apps next-iteration brainstorm identified for per-user config, bound elements, and row provenance — real, but its own project. Consequence to accept: on an operator-key dashboard, apps-side presence would show guests until that lands.

### Q: Which agent-participation mechanisms ship in v1?
**`room-get` / `room-change` MCP tools + `room.changed` on the event bus feeding workflow `wait` nodes.** Long-poll `room-wait` and harness steering on room change are deferred.

**Insights:**
- These two are the minimum that makes the differentiator real: tools give agents read/write, the bus gives them a *reason to wake up*. Everything else is latency optimisation.
- Deferring `room-wait` means the flagship "AI opponent" demo has to be expressed as a **workflow** (wait on `room.changed` → agent-task → loop) rather than an in-task loop. That's more moving parts for a demo, but it exercises the workflow integration — which is arguably the more valuable thing to prove. Worth naming the tradeoff explicitly when the demo is designed.
- The tools must go through the server's **live** `Y.Doc`, not the KV snapshot, or an agent write would be lost the next time the flush overwrites it. `room-get` can read either (snapshot is cheaper, one flush stale); `room-change` cannot.
- Same server-side change path serves MCP tools, scripts, and `swarm-script` workflow nodes — one implementation, three surfaces. Confirms workflows need no new node type.
- `room.changed` needs **debounce/coalescing before it hits the bus**, or a fast-moving room floods every wait-node listener and every downstream task. A per-room emit budget (e.g. leading-edge + trailing-edge within N ms) should be in the design, not bolted on.

### Q: What does the room API look like?
**A thin swarm wrapper with Yjs hidden.** `room.state`, `room.change(fn)`, `room.on('change')`, `room.presence.set/on`, plus a `room.ydoc` escape hatch for power uses like `y-monaco`.

**Insights:**
- The decisive argument is the **script and MCP surfaces**: a change *intent* applied server-side means Yjs never ships into the 512 MB-ulimited script sandbox (`ulimit -v 524288`, `-n 64`) or into the MCP tool layer. Exposing `Y.Doc` directly would have forced a second, different API for those surfaces — two shapes to document, two for agents to learn, and the "primitive" framing collapses.
- Wrapper correctness becomes our problem, and the sharp edge is `room.change(fn)`: making a plain-object mutation callback produce correct Yjs ops for nested maps/arrays is the part that's easy to get subtly wrong. Scope the wrapper to the shapes the skill documents (map, array, counter, text) and fail loudly outside them, rather than pretending to support arbitrary JS mutation.
- **The skill doc is the actual deliverable.** Agents build only what the skill tells them exists — the same lesson `project_script_prompting_gaps` recorded when a missing `(args, ctx)` signature in the rubric caused 25 failed runs. A wrapper whose ergonomics are good but undocumented is worth nothing.
- The escape hatch is what keeps the Yjs ecosystem (y-monaco, y-codemirror, y-prosemirror) reachable without the wrapper having to model text editing.
- Presence rides `y-protocols/awareness` underneath but should be surfaced as `room.presence` — the ephemerality guarantee ("never persisted") is a contract statement, not an implementation note.

### Q: What's the schema-drift contract?
**Declared `schemaVersion` + explicit `room.reset()`.** The page declares its version; the server stores it beside the snapshot; on mismatch the room opens **stale — readable, not writable** — until the page resets or migrates.

**Insights:**
- Read-but-not-write on mismatch is the load-bearing detail: the old state stays recoverable (an agent can `room-get` it and salvage content into the new shape) instead of being destroyed by the redeploy that caused the problem.
- This slots naturally next to the KV snapshot as one more stored field — no new table, no new lifecycle. Cheap enough that there's no excuse to defer it.
- It reinforces the issue's `body`-is-the-program / doc-is-runtime-state split: a redeploy is a *deploy*, and deploys of incompatible programs should refuse to silently reinterpret old state. Same instinct as the apps lifecycle contract's fail-loud `snapshotApp()` and lossy-migration refusal.
- Follow-on to settle in the plan: what "reset" means for connected clients mid-session (they hold a replica of the old doc — a reset must invalidate it, not merge with it), and whether `room.reset()` should be reachable from MCP so an agent can unstick a room it broke.

### Q: Which guardrails land in v1?
**Room-count + byte caps (fail-loud), and idle eviction + cascade delete.** Per-connection throttling and the documented `scrubSecrets` boundary were not selected.

**Insights:**
- The two selected are the ones with irreversible failure modes — disk exhaustion and orphaned state — so this is the right cut if only two ship.
- **Pushback on the throttle deferral:** it isn't really a feature, it's a default. Since we own the wrapper (previous answer), presence broadcasts can be throttled *inside* `room.presence.set()` at ~20–30 Hz for free — agent-written `mousemove` handlers essentially never throttle, and 10 viewers at 60 Hz is the most likely way a demo falls over. Recommend folding it into the wrapper rather than tracking it as a separate guardrail. A server-side change-op rate limit is the genuinely deferrable half.
- **Pushback on the `scrubSecrets` boundary:** the code cost is zero — it's one sentence in `templates/skills/pages/content.md` plus not routing room content into session logs. Given the repo rule that every log egress point must scrub, leaving room state as an *undocumented* bypass is worse than leaving it as a documented one. Recommend shipping the sentence with v1 even though the guardrail is deferred.
- The byte cap has to be enforced on the **base64-encoded** value, since that's what `MAX_KV_BODY_BYTES` measures — the room-facing limit should be advertised as ~1.5 MiB of state, not 2 MiB.
- Fail-loud matters most here: the pathological outcome is a room that keeps accepting changes in memory while silently failing to persist. The cap must surface to the page and to `room-change` callers, not just to the server log.

### Q: How do non-WS readers see room state?
**Binary-only persistence (one stored copy), plus a stateless decode path** — Taras: "we should have 1, but maybe have a way to 'decrypt' too."

**Insights:** Agreed, and it's cheap because decoding a Yjs update is *pure* — no live room, no server state, no lock. Concretely three touchpoints, all reading the same single stored copy:
- **`POST /api/rooms/decode`** (or `/api/rooms/materialize`) — takes a base64 snapshot, returns plain JSON. Stateless, works on a value obtained from `kv-get`, a DB dump, or a curl. This is the "decrypt" utility.
- **Scripts SDK** — `ctx.swarm.room.decode(value)` fronts that endpoint, so the sandbox still never needs the Yjs dependency.
- **Dashboard KV browser** — detects a room snapshot and renders the decoded view inline. `apps/ui` can decode client-side since Yjs is pure JS and already bundled for the room UI.
- Net effect: one source of truth, no dual-write drift, no 2× storage cost, and room state is still inspectable from anywhere someone can reach a value. The framing that survives is "**a room is a live KV key, and the decoder is public**" — accurate rather than over-promised.
- Worth noting the endpoint is a decoder, not an authorizer: it takes a *value* the caller already holds, so it grants no new read access and needs no room-level permission check beyond ordinary API auth.

### Q: How does this get built?
**Three staged PRs, with PR 3 gated on an agent-authored demo.** PR 1 = page viewer identity fix. PR 2 = broker-shaped bus extraction + WS upgrade + channel primitive. PR 3 = rooms (Yjs, snapshot, wrapper, MCP tools, `room.changed`, caps, skill doc), not merged until an agent builds a working multiplayer page from **nothing but the skill doc**.

**Insights:**
- The gate is the important part, not the count. It converts the flagged ergonomics risk into an acceptance test instead of a spike cycle: if the agent can't build the demo from the doc, the wrapper or the prose is wrong, and that's discovered before merge rather than after adoption.
- PR ordering is also a risk ordering: PR 1 touches auth but is small and independently valuable; PR 2 touches a load-bearing existing system (wait nodes) and must be provably behaviour-preserving; PR 3 is all-new surface where mistakes are cheap. Reviewing them separately is what makes the bus refactor auditable.
- PR 2 has a natural "prove it's real" option that costs almost nothing: point the channel primitive at something non-collaborative (live workflow-run progress, or killing one dashboard poll loop) so the transport ships with a load-bearing user rather than a hypothetical one.
- The demo should exercise **two rooms** (one long-lived, one disposable), a persisted doc, ephemeral cursors, real viewer identity vs guest, and an agent peer — that's the full contract in one artifact, as the issue proposed.

## Synthesis

### Key Decisions

1. **Persistence = snapshot-only, one KV key per room.** Server holds the live doc in memory; a debounced flush writes the compacted, base64'd Yjs state to a single KV key. No append-only update log, no fold transaction, no update GC. Durability is explicitly best-effort within the flush window, covered by client re-sync — and that must be **stated in the primitive's contract**, because agents will otherwise treat a room as a database.
2. **v1 surfaces = pages + agents (MCP).** Apps integrate after PR #1066 merges, on the condition that the transport is abstracted enough to make that wiring rather than re-architecture. **Workflows are in v1** via two paths that need no new node type: a `swarm-script` node acting as a room participant, and `room.changed` waking `wait` nodes.
3. **One event bus with a broker-shaped interface, in-process for v1.** `workflowEventBus` becomes a caller of it; rooms publish onto it; WS clients subscribe through it. Refactor must be behaviour-preserving for wait nodes first. Multi-replica becomes one swap-in adapter instead of two separate plans. The bus is fire-and-forget: **room correctness never depends on bus delivery.**
4. **Yjs, not Automerge.** Pure JS → no WASM, so the `connect-src 'self'` blocking problem disappears and pages load it from jsdelivr under the existing `script-src`. Tombstone GC is what makes the snapshot ceiling survivable. `y-protocols/awareness` gives ephemeral presence by design. Server holds a **live `Y.Doc` per active room** (forced by snapshot production + agent writes), not a dumb relay.
5. **Addressing: a room is a live KV key.** Room id = `<kv-namespace>/<name>`, resolved by existing KV rules — pages force-pinned to `task:page:<id>` via the proxy-injected header, bearer callers explicit. Name validated `[a-zA-Z0-9_-]{1,64}`. Snapshots live under a reserved key prefix inside the namespace.
6. **Page viewer identity fixed first, as its own PR.** Signed payload widens to `{pageId, exp, uid?, name?}`, stamped at `POST /api/pages/:id/launch`. Operator key → guest handle; password-mode → anonymous by construction. Corrects the false claim in `templates/skills/pages/content.md`, which is a live bug independent of this feature.
7. **API = thin swarm wrapper, Yjs hidden.** `room.state` / `room.change(fn)` / `room.on('change')` / `room.presence` / `room.reset()`, with `room.ydoc` as the escape hatch. Non-browser surfaces send change *intents* applied server-side, so Yjs never enters the script sandbox or the MCP layer. Wrapper scope is limited to documented shapes (map, array, counter, text) and fails loudly outside them.
8. **Agent participation v1 = `room-get` / `room-change` MCP tools + `room.changed` on the bus.** `room-change` must go through the live doc, never the snapshot. Emits are debounced/coalesced per room.
9. **Schema drift = declared `schemaVersion` + explicit `room.reset()`.** Mismatch opens the room **stale: readable, not writable**, so old state stays salvageable instead of being destroyed by the redeploy that broke it.
10. **Guardrails v1 = room-count + byte caps (fail-loud) and idle eviction + cascade delete.** Caps enforce on the base64 value, so the advertised ceiling is ~1.5 MiB of state.
11. **Readability = one binary copy + a public decoder.** Stateless `POST /api/rooms/decode`, `ctx.swarm.room.decode()` in scripts, inline decode in the dashboard KV browser. No dual-write, no drift, no 2× storage. The decoder takes a value the caller already holds, so it grants no new read access.
12. **Sequencing = 3 PRs, PR 3 gated on an agent building the demo from the skill doc alone.**

**Deferred (with the default recorded):**
- *Per-connection presence throttle* — defaulting to **fold it into the wrapper as a default**, not track it as a guardrail. It's free once we own the SDK, and unthrottled `mousemove` is the most likely way a demo falls over. Server-side change-op rate limiting is the genuinely deferrable half.
- *`scrubSecrets` boundary* — defaulting to **ship the doc sentence in v1 anyway** (zero code cost); an undocumented bypass is worse than a documented one given the repo's egress rule.
- *`room-wait` long-poll MCP tool* — defaulting to **add after v1** if the workflow-driven demo proves clumsy in practice.
- *Harness steering on room change* — defaulting to **follow-up**, gated on rooms proving themselves and on a debounce/filter story.
- *Cross-page / shared rooms* — defaulting to **asset-key namespaces (`shared/…`, `personal/<userId>/…`) later**; the addressing scheme accommodates it without changing the room layer.
- *Multi-replica broker* — defaulting to **in-process now, adapter swap later**; documented as single-replica exactly as the workflows runbook already documents for the bus.
- *`aswt_` user-token minting in the dashboard* — defaulting to **separate project**; consequence accepted that apps-side presence shows guests until it lands.
- *`room.reset()` reachable from MCP* — defaulting to **yes**, so an agent can unstick a room it broke.
- *What the demo actually is* — defaulting to **decide at plan time**, but it must exercise two rooms (one long-lived, one disposable), a persisted doc, ephemeral cursors, viewer identity vs guest, and an agent peer.

### Open Questions

**ALL ANSWERED 2026-08-04** → [thoughts/taras/research/2026-08-04-realtime-collab-primitive-open-questions.md](../research/2026-08-04-realtime-collab-primitive-open-questions.md). Headlines:

- ~~Does a full WebSocket session work on the existing `node:http` listener?~~ **YES** — verified empirically inside `oven/bun:1.3.11` (the pinned prod image): handshake, text + binary frames, 3 MiB messages, ping/pong, cookie-at-upgrade, 401-before-handshake, 25-client fan-out, clean close, HTTP coexistence on the same port, ~253k msg/s at 2 KB frames. **No topology change needed.** Caveats: Bun shims `ws` with its own builtin (the npm package is never loaded); `bufferedAmount` grows and **never decrements**, so backpressure must be tracked application-side; `_socket` is `undefined`; `perMessageDeflate` is not negotiated.
- ~~Does the page proxy pass through WS upgrades?~~ **No, and it doesn't need to.** The proxy forwards via `fetch()` and can never carry an upgrade — so the WS must live on its own path, *not* under `/@swarm/api/*`. The page document is served from the **API origin** (`GET /p/:id`), so `connect-src 'self'` resolves there and a same-origin `wss://` needs **no CSP change**. New constraint: `PAGE_SESSION_TTL_SECONDS = 3600` — decide whether a socket may outlive its cookie.
- ~~RBAC carve-out precedent?~~ **None needed.** `check-rbac-coverage` iterates only the `route()`-populated `routeRegistry` and **skips GET entirely**; an `upgrade` handler on `httpServer` is invisible to it and to OpenAPI, with no error. Precedent: all of `handleCore`, `/mcp`, `/mcp-user`. A `kv-namespace` RBAC resource kind and a `kv.write.any` verb already exist.
- ~~Reserved key prefixes?~~ **No key-level reservation exists**, and the namespace-level helper is spike-only (see the correction above). Keys already allow `/` and `:`, so a `_room/<name>` prefix needs no schema change. Two chokepoints cover the whole public surface (`authorizeWrite`, `kvWriteAuthError`) — but note `authorizeWrite` **falls through to ALLOW** for any namespace outside `mcp:overflow:*` / `task:page:*` / `task:agent:*`, and 11 internal subsystems bypass both by calling `upsertKv` from `src/be/db.ts` directly.
- ~~`scheduleApiGc` suitable for idle-room eviction?~~ **Yes — its enclosing 5-minute `startApiGcInterval`.** `closeIdleMcpTransports` (2 h idle timeout) is a direct structural template: live per-entity map + activity map + sweep + `onClose` cascade, plus event-driven cleanup and a shutdown drain. Flush-on-exit belongs in `shutdown()` (`src/http/index.ts:407-477`). Related: **KV has no background expiry sweep at all** — a snapshot TTL alone would never reclaim disk.
- ~~Yjs build/version + CSP?~~ **Pin `yjs@13.6.32` + `y-protocols@1.0.7`.** `dist/yjs.mjs` is a 299 KB self-contained ESM file on both jsdelivr and unpkg, which `script-src` already allows — no CSP change. `y-protocols`'s package-root `/+esm` 404s; use the `awareness/` subpath. Alternative worth considering at plan time: serve Yjs from a same-origin path (`'self'`) and drop the CDN dependency entirely — the browser SDK is already injected inline, so this is just a second static asset.
- ~~Realistic snapshot sizes?~~ **Comfortable.** 200-card kanban + 20,000 edits = **273 KiB base64, 13% of cap**; 50 KB char-by-char text = 67 KiB (3%); 5,000 accumulated tic-tac-toe matches in one room = 539 KiB (26%). Cap is hit at **~4,000 kanban cards**. `gc: true` is load-bearing — the same kanban with `gc: false` is 1.32 MiB (66%), 5× larger. A single field edit produces a 1,081 B update. **Presence verified never to touch the doc**: 5,000 awareness cursor updates left the snapshot byte-identical.
- ~~Do live pages rely on the false viewer-identity claim?~~ **No shipped page does** — both bundled examples are static HTML with zero `swarmSdk` calls. The claim appears twice (`templates/skills/pages/content.md:163-165` and `:460-462`). Fixing `X-Agent-ID` would change task `creatorAgentId`, task-steer RBAC principal (incl. `isLead`), and audit-user attribution; it would **not** change events or approval-request responses — those already take identity from the request body and never verify it.

### Constraints Identified

- **KV**: `value` is `TEXT` (json/string/integer), `MAX_KV_BODY_BYTES = 2 MiB` → **~1.5 MiB of real state per room after base64**; no CAS; no cross-key transactions; `PRIMARY KEY (namespace, key)`, `WITHOUT ROWID`.
- **CSP** (`src/http/pages-public.ts:308`): `script-src` allows `'unsafe-eval'` + jsdelivr/unpkg (Yjs loads fine); `connect-src 'self'` means the WS must ride the **same host and port** as the existing listener — a second port is blocked.
- `src/http/index.ts:210` is a plain `node:http` `createServer`; **no WebSocket, no `ws`/`yjs`/`automerge` dependency exists in the repo today**.
- **Scripts runtime**: `Bun.spawn` under `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, 30 s default / 5 m max, 1 MB stdout cap → **batch participant only**; Yjs must not ship into the sandbox.
- **`workflowEventBus` semantics must survive the refactor unchanged**: `scope: run | global`, automatic `_runId` injection on run-scoped signals, one-shot delivery, and the documented subscribe-before-emit ordering trap.
- **API server is the sole DB owner** (`scripts/check-db-boundary.sh`); worker-side code must never import `src/be/db`. The room subsystem is server-side by construction.
- WS routes are **not expressible through the `route()`/OpenAPI factory**; `bun run check:rbac-coverage` is CI-enforced → needs an explicit carve-out plus a declared posture.
- **Multi-replica**: rooms and the bus are in-process → single API replica (or sticky sessions) until a broker adapter lands. The helm chart makes multi-replica expressible, so this needs documenting, not just knowing.
- **Room state bypasses `scrubSecrets`** — an explicit boundary, not a silent one.
- Pages have **no viewer identity** today; the dashboard has **no per-human identity** (operator key, no `aswt_` minting flow).
- New MCP tools must be registered in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) or excluded with a reason — CI-enforced.

### Core Requirements

1. **Page viewer identity**: signed `{pageId, exp, uid?, name?}` stamped at launch-mint; guest/anonymous degradation as stated rules; `templates/skills/pages/content.md` corrected; `X-Agent-ID` forwarding reconsidered for viewer-scoped actions.
2. **Broker-shaped pub/sub interface**; `workflowEventBus` refactored onto it with wait-node tests green and unchanged.
3. **WS upgrade on the existing listener**, cookie-authed via `extractAndVerifyCookie`, with an RBAC carve-out and declared posture.
4. **Channel primitive** (subscribe / publish / topic) as a documented public surface — the thing apps integrate against later; ideally shipped with one real non-collaborative consumer.
5. **Room layer**: live `Y.Doc` per active room, `y-protocols/awareness` presence, debounced base64 snapshot to a reserved key prefix in the caller's namespace, `schemaVersion` stored alongside, stale-on-mismatch.
6. **Thin wrapper SDK** (`state` / `change` / `on` / `presence` / `reset` / `ydoc`) injected via `BROWSER_SDK_JS`, with presence throttling on by default.
7. **`room-get` / `room-change` / `room-reset` MCP tools** operating on the live doc, plus script-SDK equivalents and `SDK_TOOL_NAME_MAP` registration.
8. **`room.changed` emitted on the bus**, debounced/coalesced, filterable by room and namespace so `wait` nodes can target precisely.
9. **Stateless `POST /api/rooms/decode`** + script-SDK decode + inline decode in the dashboard KV browser.
10. **Caps and lifecycle**: rooms-per-namespace and bytes-per-room enforced on the encoded value, failing loudly to both page and MCP callers; idle eviction with flush; cascade delete with the owning page.
11. **Pages skill section** documenting the room API, the best-effort durability contract, the ~1.5 MiB ceiling, `schemaVersion` / `reset`, presence ephemerality, and the `scrubSecrets` boundary — this is what determines adoption.

## Next Steps

- Issue [#1090](https://github.com/desplega-ai/agent-swarm/issues/1090) should be updated to reflect the generalisation: KV snapshot instead of dedicated tables, Yjs instead of Automerge, bus unification, and platform scope rather than pages-only.
- PR 1 (page viewer identity) is independently shippable and can start immediately — it is a bug fix that happens to unblock presence.
- ~~**Handoff (decided 2026-08-04): `/research` on the fact-shaped Open Questions above**~~ — **DONE**, see [thoughts/taras/research/2026-08-04-realtime-collab-primitive-open-questions.md](../research/2026-08-04-realtime-collab-primitive-open-questions.md). Nothing invalidated the design; the WS transport is verified on the pinned production runtime.
- **Next: `/create-plan`** with both this brainstorm and the research doc as input. Items the plan must pick up beyond the decisions above:
  - Application-side backpressure tracking (`bufferedAmount` is broken under Bun's `ws` shim).
  - Whether a room socket may outlive its 1-hour `page_session` cookie, or is revalidated.
  - `gc: true` set explicitly at `Y.Doc` construction — it is worth 5× on snapshot size.
  - Yjs delivery: same-origin static asset vs CDN.
  - Room-snapshot reclamation must be an active sweep (KV expiry alone never deletes rows).
  - Guard placement at `authorizeWrite` + `kvWriteAuthError`, mirroring `mcpOverflowAuthError`.
