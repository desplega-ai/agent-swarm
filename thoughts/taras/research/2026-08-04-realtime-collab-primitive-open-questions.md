---
date: 2026-08-04T00:00:00+02:00
researcher: claude
topic: "Real-time collab primitive — answers to the 8 open questions (WS transport, page CSP/identity, RBAC, KV reservations, GC, Yjs sizing)"
tags: [research, realtime, websocket, crdt, yjs, kv, pages, rbac, csp, bun]
status: complete
last_updated: 2026-08-04
last_updated_by: claude
git_commit: f6b8a0baf306bb604c8d39ce88356f5622a34a9e
branch: main
repository: desplega-ai/agent-swarm
source_brainstorm: thoughts/taras/brainstorms/2026-08-04-realtime-collab-primitive.md
---

# Real-time collab primitive — Open Questions answered

## Research Question

Answer the eight fact-shaped Open Questions left by [the brainstorm](../brainstorms/2026-08-04-realtime-collab-primitive.md), which settled the design (Yjs CRDT rooms, snapshot-in-KV persistence, unified broker-shaped event bus, thin wrapper SDK, 3-PR sequence) but left factual viability questions unresolved.

Two questions (Q1 WS viability, Q7 Yjs sizing) were answered **empirically** with throwaway spikes in `/tmp/rt-spike`, including a run inside `oven/bun:1.3.11` — the exact image `Dockerfile`/`Dockerfile.worker` pin.

## Summary

**No question invalidates the design. The riskiest assumption — that a full WebSocket session works on the existing `node:http` listener — holds on the pinned production runtime.** Four findings adjust the plan rather than the architecture:

1. **WS works** end-to-end on `node:http` `createServer` under Bun **1.3.11** — handshake, text + binary frames, 3 MiB messages, ping/pong, clean close, 25-client fan-out, HTTP coexistence on the same port, and 253k msg/s at 2 KB frames. **But** Bun silently shims the `ws` package with its own builtin (the installed npm `ws` is never loaded), and in that shim **`bufferedAmount` grows and never decrements** — it is unusable as a backpressure signal, and `_socket` is `undefined` so there is no raw-socket fallback. Backpressure must be tracked application-side.
2. **The CSP is fine and the page proxy is irrelevant.** The page document is served from the **API origin** (`GET /p/:id`), so `connect-src 'self'` resolves to the API origin and a same-origin `wss://` needs no CSP change. `page-proxy.ts` forwards with `fetch()` and can never carry an upgrade — so the WS must live on its own path, **not** under `/@swarm/api/*`. New constraint discovered: the `page_session` cookie **TTL is 1 hour**.
3. **No RBAC carve-out is needed.** `check-rbac-coverage` iterates only the in-memory `routeRegistry` populated by `route()`, and **skips GET entirely**. An upgrade handler registered on `httpServer` never enters the registry — invisible to the checker and to OpenAPI, with no error. `/health`, `/mcp`, `/mcp-user` and all of `handleCore` already work exactly this way.
4. **Yjs sizing is not a constraint at realistic scale.** A 200-card kanban after 20,000 edits is **273 KiB base64 = 13% of the 2 MiB cap**; 50 KB of char-by-char text is 67 KiB (3%); 5,000 accumulated tic-tac-toe matches in one room is 539 KiB (26%). The cap is hit at **~4,000 kanban-shaped cards**. `gc: true` is doing the heavy lifting: the same kanban with `gc: false` is **1.32 MiB (66%)** — 5× larger.

Two corrections to brainstorm assumptions are noted in [Corrections](#corrections-to-brainstorm-assumptions).

## Detailed Findings

### Q1 — Does a full WebSocket session work on the existing `node:http` listener under Bun?

**Yes.** Verified empirically, twice: on local Bun 1.3.14 and inside `oven/bun:1.3.11` (the version pinned at `Dockerfile:5`, `Dockerfile.worker:27`, and `package.json:57` `packageManager`). Identical results on both.

The spike replicated the repo's topology exactly: a plain `node:http` `createServer` with a request handler doing route dispatch, plus `server.on('upgrade')` → `WebSocketServer({ noServer: true }).handleUpgrade(...)`.

| Check | Result |
|---|---|
| HTTP routes coexist with WS on one listener/port | PASS |
| Handshake completes (101 Switching Protocols) | PASS — `upgrade` event fires |
| `Cookie` header reaches the upgrade handler | PASS — cookie-auth at upgrade is viable |
| Text frame round-trip | PASS |
| Binary frame round-trip (`Uint8Array` — what Yjs updates are) | PASS |
| 3 MiB binary message fragments + reassembles | PASS |
| Ping/pong control frames (both directions) | PASS |
| Unauthenticated upgrade rejected with 401 **before** handshake | PASS |
| Upgrade path routing (unknown path refused) | PASS |
| 25-client subscribe + broadcast fan-out | PASS |
| Clean close handshake (code 1000) | PASS |
| Server survives abrupt client `terminate()` | PASS |

Throughput on Bun 1.3.11: **20,000 × 2 KB frames delivered in 79 ms — ~253,000 msg/s**. (A 512 KiB-per-message test was far slower, ~1.4 MiB/s; large frames are the slow path, small frames are not. Room traffic is small frames — a single-field Yjs edit produces a **1,081-byte** update.)

**Three runtime caveats, all verified:**

- **Bun shims `ws` with its own builtin.** A marker appended to `node_modules/ws/index.js` never executed: `loaded npm ws from node_modules: false`. Stack traces read `at <anonymous> (ws:200:20)` — an internal module, and the line number differs between Bun 1.3.11 and 1.3.14. Consequence: `ws`'s documented behaviour is not authoritative here; only what Bun's shim implements matters, and it cannot be swapped by installing a different `ws` version.
- **`bufferedAmount` is not a usable backpressure signal.** After all 20,000 frames were confirmed delivered, `bufferedAmount` still read **21,597,245**. It grows during sends and never decrements. A separate test with an actively-reading peer never reached 0 within 15 s despite delivery. Backpressure must be inferred application-side (in-flight counters, ack/echo timing, or send-rate limits), not read off the socket.
- **`ws._socket` is `undefined`** and `perMessageDeflate` is **not negotiated even when both sides request it** (`extensions: ""`). No raw-socket access, no compression. Yjs updates are already compact binary, so compression matters little; the absence of socket access rules out socket-level tuning.

One unhandled `ErrorEvent` appeared during spike teardown after all assertions passed. An isolated reproduction (abrupt `terminate()` with and without an `error` listener on the peer socket) did **not** reproduce it and the server stayed healthy (`204` after the fact). Not root-caused; the practical takeaway is to attach an `error` listener to every socket.

**Codebase facts confirming the topology:**
- `src/http/index.ts:210` — `const httpServer = createHttpServer(async (req, res) => {` — `node:http`, not `Bun.serve`. Started at `src/http/index.ts:568-696`.
- `Bun.serve` exists only in `src/artifact-sdk/server.ts:126` (a separate embedded dev server) and in `src/tests/*.test.ts` mocks — never the API listener.
- **No `server.on('upgrade')` handler exists anywhere in `src/` today**, and no `ws`/`yjs`/`automerge` dependency.
- Dispatch: the `createHttpServer` callback at `src/http/index.ts:210` → `handleCore` (`:299`) → a first-match-wins loop over ~50 `handleXxx` closures (`:306-367`) → 404 fallback (`:369-371`). Nothing inspects `req.headers.upgrade` or `req.socket` before dispatch; an upgrade listener would be registered on `httpServer` itself, orthogonal to this path.
- **Precedent for long-lived in-process state**: `transports`, `mcpSessionAgents`, `transportsUser`, `sessionUsers`, `transportActivity`, `transportActivityUser` at `src/http/index.ts:202-208`, each holding a live `StreamableHTTPServerTransport` per MCP session, persisted onto `globalState` (`:399-405`) so they survive Bun hot-reload. This is the closest existing analogue to "one live `Y.Doc` per room" — including the hot-reload survival trick.

### Q2 — Does the page proxy pass through WS upgrades, and what does `connect-src 'self'` resolve to?

**The proxy does not and cannot — and does not need to.**

- `src/http/page-proxy.ts` proxies **outbound calls from the page's JS to the API** (`/@swarm/api/*` → in-process rewrite → `/api/*` on `http://127.0.0.1:${port}`), not page loads (`page-proxy.ts:14-21`, `:140-149`).
- It forwards with **`fetch()`** (`page-proxy.ts:185-192`), which cannot carry an `Upgrade` handshake. It registers only GET/POST/PUT/DELETE/PATCH (`:35-100`) and never inspects `req.headers.upgrade`.
- It does **not** blanket-forward headers — it builds an explicit allowlist (`page-proxy.ts:156-170`): `Authorization: Bearer ${apiKey}`, `X-Agent-ID: page.agentId`, `X-Page-Id: page.id`, plus `Content-Type`/`Accept` copied when present.

**`'self'` resolves to the API origin.** The page's HTML bytes are served by `GET /p/{id}` (`src/http/pages-public.ts:35-50`) on the API origin (`MCP_BASE_URL`/`PUBLIC_MCP_BASE_URL`), iframed by the SPA at `${APP_URL}/pages/:id`. Because the *document* comes from the API origin, `connect-src 'self'` (`pages-public.ts:315`) permits `wss://<api-origin>/…`. **No CSP change is needed for the WebSocket**, provided it terminates on the API origin's host **and port** — which is exactly the existing listener.

Full CSP, `src/http/pages-public.ts:308-317`:

```
default-src 'self'
script-src  'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com
font-src    'self' https://fonts.gstatic.com data:
img-src     'self' data: https:
media-src   'self' data: https: blob:
connect-src 'self'
frame-ancestors 'self' <configured APP_URLs> [+ localhost fallbacks when NODE_ENV !== production]
```

Emitted only on `/p/:id` HTML responses (`pages-public.ts:582`, `:607`), not on `/p/:id.json`.

**Consequences for the design:**
- The WS endpoint must be its own path (e.g. `/@swarm/rooms`) handled by the `upgrade` listener — **not** routed through `/@swarm/api/*`, which is a `fetch()` proxy.
- **Cookie flows correctly**: `page_session` is `HttpOnly; Path=/`, host-only (no `Domain=`), and in production `SameSite=None; Secure` (`src/utils/page-session.ts:237-256`) — so it is sent on a WS handshake originating from the cross-site iframe. In dev it is `SameSite=Lax` without `Secure`.
- **New constraint: `PAGE_SESSION_TTL_SECONDS = 3600`** (`src/utils/page-session.ts:224`). A cookie authenticated at upgrade time is only valid for an hour, but an established socket is never re-checked. The plan must decide: re-auth only on reconnect (simple, means a socket can outlive its cookie), or periodic revalidation over the socket.
- Payload today is exactly `{ pageId: string; exp: number }` (`page-session.ts:20-24`); HMAC-SHA256 with `PAGE_SESSION_SECRET || getApiKey()`, fail-closed (`:47-57`), constant-time compare (`:137-140`), expiry-checked (`:171`).

**Mint sites, confirming the brainstorm's degradation rules:**

| Mode | Cookie minted where | Bearer present at mint? |
|---|---|---|
| `public` | `POST /api/pages/{id}/launch` (`src/http/pages.ts:694`) | Yes (bearer-gated route) — but not required to view |
| `authed` | Same launch route; `GET /p/:id` without a cookie → 401 (`pages-public.ts:370-376`) | **Yes** — this is the `uid` stamping opportunity |
| `password` | **Launch route rejects with 400** (`pages.ts:686-690`); minted inline after `Bun.password.verify` in `GET /p/:id` (`pages-public.ts:502-516`) | **No** — `auth: { apiKey: false }`; anonymous by construction, as the brainstorm assumed |

The launch route (`src/http/pages.ts:128-140`) declares no `auth: { apiKey: false }` override, so it inherits the default bearer gate — confirmed by its own comment: *"No per-page ACL in v1: the bearer is the API_KEY, same trust as the rest of the API"* (`pages.ts:692-693`).

### Q3 — RBAC carve-out precedent for a non-`route()` endpoint

**No carve-out is needed. An upgrade handler is invisible to the gate by construction.**

`scripts/check-rbac-coverage.ts` discovers routes by **importing the in-memory registry**, not by scanning source or reading `openapi.json`:

```ts
// scripts/check-rbac-coverage.ts:34-36
import "../src/http/all-routes";
import { routeRegistry } from "../src/http/route-def";
import { PERMISSION_VERBS } from "../src/rbac/permissions";
```

`checkRoutes()` (`scripts/check-rbac-coverage.ts:350-378`) starts with `if (def.method === "get") continue;` — **GET routes are exempt entirely** — then requires every remaining `routeRegistry` entry to carry either an inline `rbac` field or a `ROUTE_RBAC_BACKLOG` key. A handler that never calls `route()` never enters `routeRegistry` and is therefore never examined.

The same is true of OpenAPI: `generateOpenApiSpec()` (`src/http/openapi.ts:40-76`) iterates the identical `routeRegistry`. An unregistered endpoint is silently absent — no error, no warning. `src/http/route-def.ts:98-100` states it outright: *"Core routes (/health, /ping, /me, etc.) and the MCP transport don't go through the `route()` factory."*

**Existing precedent** (raw-dispatch, never registered): all of `handleCore` (`src/http/core.ts:276-548`) — `/health`, `/openapi.json`, `/docs`, `POST /internal/reload-config`, `/me`, `/cancelled-tasks`, `POST /ping`, `POST /close`; plus `handleMcp` (`src/http/mcp.ts:98,107`, literal `req.url !== "/mcp"`) and `handleMcpUser` (`src/http/mcp-user.ts:31,40`).

There is also a **hybrid** precedent worth copying: `src/http/page-proxy.ts` registers its routes via `route()` *purely* so `isPublicRoute()` skips the bearer gate, while dispatching with a `startsWith` check (`page-proxy.ts:25-27`, `:114`). `src/http/pages-public.ts:454-457` does the same for `/p/:id`. If a WS endpoint wants an OpenAPI presence or a declared posture, that hybrid is the shape.

**Adding a verb**, if the room layer wants one (`src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`, `src/rbac/can.ts:29-44`):
1. Add `{ description, namespace }` to `PERMISSIONS` (`src/rbac/permissions.ts:19+`).
2. Add a matching `LEGACY_POLICY` entry — compile-time enforced by `satisfies Record<PermissionVerb, LegacyRule>` (`legacy-policy.ts:200`).
3. Call `can({ principal, verb, resource, source })` at a real call site — `checkVerbs()` fails CI on a "dead verb" (`check-rbac-coverage.ts:196-201`).
4. For an HTTP route, add `rbac: { permission: "<verb>" }`.

Resource kinds available today (`src/rbac/types.ts:20-34`): `task`, `agent`, **`kv-namespace`**, `owned`, `none`. Principals: `{kind:"agent", agentId, isLead}` | `{kind:"user", userId}` | `{kind:"operator"}`.

**`ungated` reason categories in use** (9 inline declarations across 6 files): self-scoped to the caller's own resource (`src/http/skills.ts:297`); auth enforced inline rather than via `can()` (`src/http/assets.ts:73-74`); mirrors a sibling route's pre-RBAC posture (`src/http/tasks.ts:465-466`, `src/http/schedules.ts:183-185`); no per-agent principal applies (`src/http/fs.ts:87-89`); worker callback verified against the task assignee (`src/http/tasks.ts:256-301`).

### Q4 — Reserved key prefixes inside a writable namespace

**No key-level reservation exists anywhere today**, and the namespace-level mechanism the brainstorm cites is **spike-branch-only**.

- `src/kv-reserved-namespaces.ts` does **not exist on `main`**; `grep -rn "isReservedNamespace"` across `main` returns zero hits in `src/`.
- On `origin/spike/swarm-apps` it exists with exactly **two call sites**, and they are precisely the two hook points a room-key guard would need:
  - `src/http/kv.ts:326` — inside `authorizeWrite`
  - `src/tools/kv/kv-write-auth.ts:20` — inside `kvWriteAuthError`
- Both mirror the shape of the existing **`mcpOverflowAuthError`** guard, which is on `main` today and is the real precedent for a namespace-family guard in both functions.

**Key validation is charset/length only** — no prefix denylist, no system/user key distinction (`src/types.ts:2613-2634`):

```ts
export const KV_NAME_REGEX = /^[a-zA-Z0-9._:/%-]{1,512}$/;
export const KvNamespaceSchema = z.string().min(1).max(512).regex(KV_NAME_REGEX, …);
export const KvKeySchema      = z.string().min(1).max(512).regex(KV_NAME_REGEX, …);
```

`src/http/kv.ts:224-241` re-validates the decoded path segment against a slightly narrower regex (no `%`). Because `/` and `:` are legal in keys, a `_room/<name>` prefix is expressible without schema changes.

**Do all write routes enforce a guard?** Every HTTP and MCP write path runs `authorizeWrite` / `kvWriteAuthError`, so a guard added to those two functions covers the full public surface:

| Route | Namespace source | Guard fn |
|---|---|---|
| `PUT /api/kv/{key}` (`kv.ts:103-113`) | `resolveNamespaceFromHeaders` — `X-Page-Id` → task `contextKey` → `task:agent:<id>` (`kv.ts:256-291`) | `authorizeWrite` (`kv.ts:634`) |
| `DELETE /api/kv/{key}` (`kv.ts:115-129`) | same | `authorizeWrite` (`kv.ts:671`) |
| `POST /api/kv/{key}/incr` (`kv.ts:131-141`) | same | `authorizeWrite` (`kv.ts:586`) |
| `PUT /api/kv/_/{namespace}/{key}` (`kv.ts:164-174`) | URL segment via `decodeKvSegment` (`kv.ts:457`) | `authorizeWrite` (`kv.ts:634`) |
| `DELETE /api/kv/_/{namespace}/{key}` (`kv.ts:176-189`) | `decodeKvSegment` (`kv.ts:466`) | `authorizeWrite` (`kv.ts:671`) |
| `POST /api/kv/_/{namespace}/{key}/incr` (`kv.ts:191-201`) | `decodeKvSegment` (`kv.ts:564`) | `authorizeWrite` (`kv.ts:586`) |
| MCP `kv-set` / `kv-delete` / `kv-incr` | `resolveNamespace` (`src/tools/kv/resolve-namespace.ts:25-58`) | `kvWriteAuthError` (`kv-write-auth.ts:15-44`) |

**Two important gaps:**

1. **`authorizeWrite` falls through to ALLOW.** Only `mcp:overflow:*`, `task:page:*` (requires the page header) and `task:agent:*` (requires `kv.write.any` via `can()`) are gated — *"everything else → allow (any authenticated caller)"* (`src/http/kv.ts:314-320`). A room namespace outside those families is freely writable by any authenticated caller unless a guard is added.
2. **Internal subsystems bypass both guards entirely** by importing `upsertKv`/`deleteKv`/`incrKv` from `src/be/db.ts` directly. Eleven such call sites exist on `main` — `src/be/unmapped-identities.ts:68-90`, `src/github/handlers.ts:184,195`, `src/gitlab/handlers.ts:100,111`, `src/linear/sync.ts:377,435,446`, `src/linear/oauth.ts:63`, `src/slack/enrich.ts:64,91,139`, `src/http/users.ts:340,494-495`, `src/integrations/kapso/config.ts:68-96`, `src/http/scripts.ts:543`, `src/tools/utils.ts:591-596`. `src/be/db.ts:14069-14071` is explicit: *"All sizing / regex validation happens at the HTTP / MCP boundary so the helpers below can assume well-formed inputs."* The room subsystem would join this list — which is the correct pattern, and also why the guard must live at the boundary rather than in the DB helpers.

**Value encoding + the size cap** (`src/http/kv.ts:365-404`, `:642-647`): `MAX_KV_BODY_BYTES = 2 MiB` is measured on `Buffer.byteLength(encoded.stored, "utf8")` — the post-`JSON.stringify` string for `json`, or the raw string for `string`. A base64 snapshot stored as `value_type: 'string'` is therefore counted as its base64 length, exactly as the brainstorm assumed. **There is no binary/base64 handling in the KV path today** — no `base64` occurrence anywhere in it. A pre-flight `Content-Length` check runs first (`kv.ts:454/494/557`) but is best-effort (skipped when the header is absent).

### Q5 — Does `scheduleApiGc` suit idle-room eviction?

`scheduleApiGc` itself (`src/http/index.ts:144-162`) is only a `global.gc()` trigger on a zero-delay `unref()`'d timer, no-op unless the runtime exposes `gc`. **The useful hook is its enclosing interval**, `startApiGcInterval` (`src/http/index.ts:164-194`):

- Cadence **`API_GC_INTERVAL_MS = 5 * 60 * 1000`** (5 min, `src/http/index.ts:139`).
- Per tick it calls `closeIdleMcpTransports(...)` and `closeIdleMcpUserTransports(...)` with `MCP_TRANSPORT_IDLE_TIMEOUT_MS = 2h` (`src/http/mcp.ts:12`), then `scheduleApiGc("periodic API sweep")`.
- Registered once at `src/http/index.ts:496`, guarded by `globalState.__apiGcInterval` against hot-reload double-registration, `unref()`'d, cleared in `shutdown()` (`:448-451`).

**`closeIdleMcpTransports` (`src/http/mcp.ts:24-59`) is a direct structural precedent for idle-room eviction**: a map of live per-entity objects + a last-activity map, swept on the same 5-minute tick against an idle threshold, with an `onClose` callback for cascade cleanup. The MCP transports additionally get event-driven cleanup (`onsessionclosed`/`transport.onclose`, `src/http/mcp.ts:137-150`) and a shutdown-time drain (`src/http/index.ts:453-468`) — three layers a room registry would want to mirror.

**Flush-on-exit hook**: `shutdown()` (`src/http/index.ts:407-477`), registered for SIGINT/SIGTERM at `:480-490` and guarded by `globalState.__sigintRegistered`. It runs `stopX()` calls in sequence, drains both MCP transport maps, then `httpServer.closeAllConnections()` → `httpServer.close(() => { closeDb(); process.exit(0); })` (`:471-476`). A room-flush belongs alongside the other `stopX()` calls, before `closeDb()`.

**Related, and relevant to snapshot GC**: KV has **no background expiry sweep at all**. `src/be/migrations/061_kv_store.sql:12-15` — *"Lazy expire on read: `getKv` DELETEs single expired rows; `listKv` filters in the SELECT but does not delete… **No background sweep.**"* The only production use of `sweepExpiredKvPrefix` is `src/tools/utils.ts:591`, run synchronously on every MCP overflow spill — cleanup piggybacked on write activity. A room-snapshot TTL would therefore need either the 5-minute interval or the same piggyback trick; setting `expires_at` alone would leave rows on disk indefinitely.

Other server-level timers, for context: RBAC audit flush + daily retention GC (`src/be/rbac-audit.ts:207,244`), OAuth pending GC (5 min, `src/http/oauth-callback.ts:314`), memory GC (1 h, `src/http/memory.ts:1002`), OAuth refresh sweep (15 min), heartbeat (90 s default), scheduler (10 s), script-run supervisor reconcile (15 s).

### Q6 — Which Yjs build/version, and does it load under the pages CSP?

**Pin `yjs@13.6.32` and `y-protocols@1.0.7`** (both latest, both verified working together in the spike).

CDN availability, both origins already in `script-src`:

| URL | Status | Size | Sub-imports |
|---|---|---|---|
| `https://cdn.jsdelivr.net/npm/yjs@13.6.32/dist/yjs.mjs` | 200 | 299,797 B | **none — self-contained** |
| `https://unpkg.com/yjs@13.6.32/dist/yjs.mjs` | 200 | 299,797 B | none |
| `https://cdn.jsdelivr.net/npm/yjs@13.6.32/+esm` | 200 | 79,709 B | fans out to `/npm/lib0@0.2.117/*/+esm` (same origin, so CSP-allowed, but many round trips) |
| `https://cdn.jsdelivr.net/npm/y-protocols@1.0.7/awareness/+esm` | 200 | 3,771 B | — |
| `https://cdn.jsdelivr.net/npm/y-protocols@1.0.7/+esm` | **404** | — | package root has no `+esm`; use the `awareness/` subpath or `dist/awareness.cjs` (200, 11,148 B) |

`script-src` already lists `https://cdn.jsdelivr.net` and `https://unpkg.com` (`src/http/pages-public.ts:310`), so **either CDN path works with no CSP change**.

**A same-origin option avoids the CDN entirely.** The browser SDK is injected *inline* today — `const injection = \`${PAGE_HEAD_DEFAULTS}<script>${BROWSER_SDK_JS}</script><script>${SWARM_UI_JS}</script>\`` (`src/http/pages-public.ts:141`), covered by `script-src 'unsafe-inline'`. `BROWSER_SDK_JS` is ~18 KB (`src/artifact-sdk/browser-sdk.ts:23`). Inlining another 300 KB into every page response would be wasteful, but serving Yjs from a same-origin path (e.g. `/@swarm/yjs.mjs`) is covered by `script-src 'self'`, is cacheable, and removes a third-party runtime dependency from every multiplayer page. Both options are CSP-clean; this is a plan-time choice, not a blocker.

**Presence verified off the shelf** (`y-protocols/awareness` with `yjs@13.6.32`):
- An awareness update carrying identity + cursor is **87 bytes** on the wire.
- `applyAwarenessUpdate` on a second doc surfaces the peer state correctly.
- **5,000 `setLocalStateField('cursor', …)` calls left the document snapshot at 2 bytes — unchanged.** Awareness genuinely never touches the doc, confirming the "presence is never persisted" contract is structural rather than a discipline we have to enforce.
- `removeAwarenessStates` cleanly drops peers on disconnect.

### Q7 — Realistic Yjs snapshot sizes vs the base64 ceiling

Measured with `yjs@13.6.32`, `gc: true` unless noted, sizes as `Y.encodeStateAsUpdate()` raw and base64, against `MAX_KV_BODY_BYTES = 2 MiB`:

| Scenario | Raw | Base64 | % of 2 MiB cap |
|---|---|---|---|
| Tic-tac-toe — one finished match (7 moves) | 235 B | 316 B | 0.02% |
| Kanban 200 cards, no churn | 80.5 KiB | 107.3 KiB | 5.24% |
| Kanban 200 cards + 2,000 edits | 98.1 KiB | 130.9 KiB | 6.39% |
| **Kanban 200 cards + 20,000 edits** (≈ a year of heavy use) | 204.9 KiB | **273.1 KiB** | **13.34%** |
| Same, but `gc: false` | 1015.0 KiB | 1.32 MiB | 66.08% |
| Text 50 KB typed char-by-char | 50.0 KiB | 66.7 KiB | 3.26% |
| Text 50 KB + 2,000 deletions (`gc: true`) | 75.9 KiB | 101.2 KiB | 4.94% |
| Same, `gc: false` | 95.4 KiB | 127.3 KiB | 6.21% |
| Text 200 KB typed char-by-char | 200.0 KiB | 266.7 KiB | 13.02% |
| 5,000 tic-tac-toe matches accumulated in **one** room | 404.1 KiB | 538.8 KiB | 26.31% |
| 60 s of 60 Hz cursor writes **into the doc** (`Y.Map` set) | 58 B | 80 B | 0.00% |

**Ceiling: ~4,000 kanban-shaped cards fill the 2 MiB base64 cap.**

Other measurements:
- A **single field edit** produces a **1,081 B** raw / 1,444 B base64 incremental update — i.e. a typical WS frame.
- Round-trip fidelity confirmed: `Y.applyUpdate(new Y.Doc(), snapshot)` restored all 200 cards.
- For the same 200-card doc: materialised JSON **69.1 KiB** vs Yjs snapshot **85.5 KiB** raw / **114.0 KiB** base64 — so the binary snapshot is ~1.65× the plain JSON once base64 is applied. Relevant to the decode-endpoint decision (the dual-write option the brainstorm rejected would have cost roughly +60%, not +100%).

**Two nuances that refine the brainstorm's assumptions:**
- **`gc: true` is doing the work, and it is what keeps rooms small** — 5× on the churned kanban. It must be explicit in the room-creation code, not assumed.
- **Repeated `Y.Map.set` on the same key costs essentially nothing** (60 s of 60 Hz cursor writes → 58 B), because GC collapses superseded values. The size risk is **array and text growth**, not map churn. The "never write per-frame state to the doc" rule is still right (it wastes bandwidth and floods `room.changed`), but the *storage* argument for it is weaker than the brainstorm implied — the honest justification is broadcast cost and event-bus noise.

### Q8 — Do live pages depend on the current (incorrect) viewer-identity behaviour?

**No bundled/seeded page does.** The only two shipped example pages — `templates/skills/pages/files/examples/annotated-pr.html` and `report-page.html` — contain **no `swarmSdk` calls at all**; they are static HTML. No baked equivalents exist under `plugin/skills/pages/`. Every `swarmSdk` write call in the repo is inside skill-doc code snippets (`templates/skills/pages/content.md:239,243`; `templates/skills/kv-storage/content.md:173-176`). User-authored pages in a live DB are outside what static analysis can see.

**The false claim appears twice** in `templates/skills/pages/content.md`:
- `:460-462` — *"Declared actions on `authed` / `password` pages run with the **viewer's** identity, not the page author's. A button that says 'Delete all tasks' will delete the viewer's tasks if the viewer clicks it."*
- `:163-165` (auth-mode table) — *"Browser SDK calls run as the viewing user"* (`authed`), *"SDK calls run as viewer's identity"* (`password`).

The code contradicts both: `src/http/page-proxy.ts:158` sets `"X-Agent-ID": page.agentId` unconditionally — no branch on `authMode`, on the cookie, or on any viewer state — and `PageSessionPayload` has no viewer field at all (`src/utils/page-session.ts:20-24`).

**Blast radius if the forwarded identity becomes the viewer's** — `src/http/index.ts:303` (`const myAgentId = req.headers["x-agent-id"]`) feeds every downstream handler:

| Consumer | Location | Change |
|---|---|---|
| Task creation attribution | `src/http/tasks.ts:639` — `creatorAgentId: myAgentId` | Tasks created from a page would be attributed to the viewer, not the author |
| Task-steer RBAC principal | `canSteerTask()`, `src/http/tasks.ts:470-499` — builds `{kind:"agent", agentId: myAgentId, isLead}` | **Authorization change** — including the `isLead` flag |
| Audit-user resolution | `resolveHttpAuditUserId(req, myAgentId)`, `src/be/audit-user.ts:64-73`, called at `tasks.ts:600,804` | Audit rows attribute to the viewer |
| KV `isLead` check | `buildAuthCtx()`, `src/http/kv.ts:299-308` → `authorizeWrite` | Largely moot: the proxy also sets `X-Page-Id`, and `kv.ts:412-424` force-pins page requests to `task:page:<id>` before the `task:agent:*` branch is reached |
| `swarmSdk.events.create` | `src/http/events.ts:116,25` — `_myAgentId` is unused; `agentId` comes from the **request body** | **No change** |
| `swarmSdk.approvalRequests.respond` | `src/http/approval-requests.ts:103,171` — `respondedBy` is a free-form optional body string, never cross-checked | **No change** |

The last two rows are their own finding: **event attribution and approval `respondedBy` are already client-supplied and unverified**, so a page can assert any identity on those paths today regardless of what `X-Agent-ID` says.

## Corrections to brainstorm assumptions

1. **`src/kv-reserved-namespaces.ts` is not on `main`** — the brainstorm's Ironed Facts cite it as an existing precedent ("Reserved-namespace mechanism exists"). It exists only on `origin/spike/swarm-apps`. The mechanism that *is* on `main` and does the same job is `mcpOverflowAuthError`, called from the same two functions (`authorizeWrite`, `kvWriteAuthError`). The plan should reference that instead, and treat the reserved-namespace helper as arriving with the apps PR.
2. **The storage argument against per-frame writes is weaker than stated** — repeated `Y.Map.set` on one key costs ~0 bytes after GC (Q7). The real costs are broadcast bandwidth and `room.changed` flooding. Keep the rule, fix the justification.

## Code References

- `src/http/index.ts:210` — `createHttpServer` (the listener an `upgrade` handler attaches to)
- `src/http/index.ts:139,164-194,496` — `API_GC_INTERVAL_MS`, `startApiGcInterval`, registration
- `src/http/index.ts:202-208,399-405` — live per-session object maps + `globalState` hot-reload persistence
- `src/http/index.ts:407-477,480-490` — `shutdown()` and its SIGINT/SIGTERM registration
- `src/http/mcp.ts:24-59,137-150` — idle sweep + event-driven cleanup (the room-eviction template)
- `src/http/pages-public.ts:35-50,141,308-317,502-516` — page route, SDK injection, `buildCsp()`, password-mode mint
- `src/http/page-proxy.ts:14-21,114,151-160,185-192` — proxy direction, dispatch, injected headers, `fetch()` forwarding
- `src/utils/page-session.ts:20-24,47-57,224,237-256` — payload, secret, 1 h TTL, cookie attributes
- `src/http/pages.ts:128-140,686-690,694` — launch route, password rejection, cookie mint
- `scripts/check-rbac-coverage.ts:34-36,350-378` — registry-based discovery, GET exemption
- `src/http/route-def.ts:36-43,98-100,157-215` — `rbac` field, "core routes don't go through route()", the factory
- `src/http/kv.ts:44,224-241,256-291,314-355,365-404,412-432,642-647` — cap, key regex, namespace resolution, `authorizeWrite`, encoding, page pinning, size check
- `src/tools/kv/kv-write-auth.ts:15-44` — the MCP-side twin of `authorizeWrite`
- `src/be/db.ts:14061-14380` — KV helpers, no validation, no reservation
- `src/be/migrations/061_kv_store.sql:12-15,24-25` — lazy expiry / no background sweep; `value_type` CHECK
- `src/rbac/types.ts:20-34` — resource kinds incl. `kv-namespace`
- `templates/skills/pages/content.md:163-165,460-462` — the two false viewer-identity claims

## Spike Artifacts

Throwaway, in `/tmp/rt-spike` (not committed): `ws-spike.mjs` (13-check WS suite), `probe2/3/4/5/6.mjs` (module resolution, ping/pong direction, backpressure, throughput, error isolation), `yjs-size.mjs` (sizing table), `aware.mjs` (presence). The WS suite and probe5/6 were run inside `oven/bun:1.3.11` via `docker run --rm -v /tmp/rt-spike:/spike -w /spike oven/bun:1.3.11`.
