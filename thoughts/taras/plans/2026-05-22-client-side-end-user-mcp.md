---
date: 2026-05-22T00:00:00Z
topic: "Client-side end-user MCP (DES-444) — Implementation Plan"
status: draft
autonomy: autopilot
planner: Claude
researcher: Claude
related:
  - thoughts/taras/research/2026-05-21-client-side-mcp-grounding.md
  - thoughts/taras/brainstorms/2026-05-15-client-side-mcp.md
---

# Client-side end-user MCP (DES-444) — Implementation Plan

## Overview

Expose a hosted, end-user-facing MCP server (`/mcp-user`) that lets a swarm *user* —
authenticated by an `aswt_` bearer token — drive a small, ownership-scoped subset of task
tools from any MCP client (Claude Code, Cursor, VS Code, …). Mirrors the Slack-integration
UX without dropping into Slack.

- **Motivation**: DES-444. End-users today can only reach the swarm via Slack; this gives
  them a first-class MCP surface scoped to `requestedByUserId = me`.
- **Related**:
  - Research (binding decisions): `thoughts/taras/research/2026-05-21-client-side-mcp-grounding.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-15-client-side-mcp.md`
  - PR #500 — "Humans as first-class users" (landed the entire data layer this plan builds on)

## Current State Analysis

PR #500 landed **the whole data layer** DES-444 needs — DES-444 is purely additive (one
small migration only, to widen a CHECK constraint). What exists vs. what's missing:

**Exists & reusable:**
- Token helpers — `mintToken` / `revokeToken` / `resolveUserByToken` / `listUserTokens` /
  `recordIdentityEvent` in `src/be/users.ts:245-514`. `mintToken`/`revokeToken` emit their
  own `token_minted`/`token_revoked` identity events internally.
- Schema — `user_tokens`, `user_identity_events`, `users.dailyBudgetUsd`, `users.status`
  (migrations 067/068).
- `aswt_` secret-scrubber rule is live.
- Operator-auth middleware — `getOperatorActor(req, res)` (`src/http/operator-actor.ts:42-59`).
- People detail page — `ui/src/pages/people/[id]/page.tsx`, tabs Profile/Identities/Events
  (`:612-619`). `composeUser()` already returns a `tokens[]` array (`src/http/users.ts:56-65`);
  `UserToken` wire type exists (`ui/src/api/types.ts:276-284`). Nothing renders it.
- Per-agent budget infra — `budgets` table, `canClaim` (`src/be/budget-admission.ts:68-113`),
  `getDailySpendForAgent` (`src/be/db.ts:9471`), `getBudget`/`upsertBudget` (`:9260`,`:9287`).

**Missing — the work of this plan:**
- **No `(ctx, args) → result` tool shape.** Every tool inlines business logic in the
  `createToolRegistrar` callback (`src/tools/utils.ts:129-179`); identity is read *inside*
  each handler from the `X-Agent-ID` header via `getRequestInfo` (`utils.ts:26-49`). No ctx
  object, no exported handler functions.
- **`send-task` never sets `requestedByUserId`** — all 3 `createTaskExtended` call sites
  (`src/tools/send-task.ts:226,276,301`) omit it.
- **No second MCP route / registry.** `createServer()` (`src/server.ts:152-343`) has no
  tool-subset parameter; `handleMcp` is hardcoded to `req.url === "/mcp"` (`src/http/mcp.ts:15`).
- **No `POST/DELETE /users/:id/mcp-tokens` endpoints** — `src/http/users.ts` defers them;
  `mintToken`/`revokeToken` aren't even imported there.
- **No Tokens tab** on the People detail page.
- **`users.dailyBudgetUsd` is unenforced** — `BudgetScope` is `['global','agent']` only
  (`src/types.ts:1537`); `canClaim` keys strictly on `agentId`; `session_costs` has no
  `userId`. Nothing reads `users.dailyBudgetUsd` for enforcement.

## Desired End State

- An operator mints an `aswt_` token for a user from the People page → copies a ready
  client-config snippet.
- The user pastes it into Claude Code / Cursor / etc. → connects to `/mcp-user`.
- The user can `send-task` (task created with `requestedByUserId = them`), `get-tasks`
  (only theirs), `get-task-details` / `cancel-task` / `task-action` (forbidden on tasks
  not theirs, with an explicit error — not a "not found").
- The owner `/mcp` route, all non-task tools, and existing agent-worker flows are
  byte-for-byte unchanged.
- If the user has a `dailyBudgetUsd` cap, claim-time admission refuses their tasks once
  the day's spend hits the cap, reusing the existing backoff/notify machinery.

## What We're NOT Doing

- Self-serve onboarding / magic-link / OAuth — operator mints tokens in v1
  (`users.status='invited'` stays dormant; **research decision #7**).
- `poll-task` on the user surface (it is worker-side).
- Memory / channel / swarm-read tools on the user surface.
- MCP notifications / push delivery (v2 — `send-task` returns immediately, client polls
  `get-task-details`).
- A single-route caller-ctx auth model — **decision #6** picks two routes / two registries.
- A `session_costs.userId` column — per-user spend is computed by a join (**decision #3**).
- Refactoring non-task tools — only the 5 task tools get the `(ctx,args)` split (**decision #1**).

## Implementation Approach

- **Two routes, two registries (decision #6).** `/mcp` (owner) untouched. New `/mcp-user`
  is a sibling raw-mounted handler with its own transport map, carved out of the swarm-key
  bearer check, running its own `aswt_` middleware.
- **Per-session user binding.** `createServer()` is called fresh per MCP session and a
  session is 1:1 with one token connection — so the user-MCP server is built *with the
  resolved `User` baked in* (`createUserServer(user)`); every task-tool handler closes over
  that user. No per-call re-resolution of identity inside handlers.
- **Pure `(ctx, args) → result` handlers (decision #1).** Each of the 5 task tools exports
  a handler taking a `ToolCtx` discriminated union (`owner` | `user`). The existing
  `registerXTool(server)` becomes a thin owner-binding; the user registry binds the same
  handlers with a `user` ctx. `createToolRegistrar` (telemetry + dispatch) is reused as-is.
- **Single ownership chokepoint (decision #5).** One `assertOwnsTask(ctx, task)` helper
  gates `get-task-details` / `cancel-task` / `task-action`; an RBAC predicate can later
  widen it in one place.
- **Budget = a third `budgets` scope (decision #3).** Add a `user` scope; mirror
  `users.dailyBudgetUsd` into a `budgets` `user`-row (backfilled by the migration, kept in
  sync by the `users` create/PATCH handlers) so `canClaim` stays uniform across all 3 gates.
- **Sequencing:** handler refactor first (Phases 1–2, no behavior change), then the route
  that exercises the user ctx (Phase 3), then operator endpoints (Phase 4) and UI (Phase 5),
  then budget enforcement (Phase 6, independent — claim-time only).

## Quick Verification Reference

- Unit tests: `bun test` (single file: `bun test src/tests/<file>.test.ts`)
- Type check: `bun run tsc:check`
- Lint (read-only, as CI runs it): `bun run lint`
- DB / API-key boundary: `bash scripts/check-db-boundary.sh` & `bash scripts/check-api-key-boundary.sh`
- OpenAPI regen (after route changes): `bun run docs:openapi`
- UI: `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b`
- Fresh-DB migration test: `rm agent-swarm-db.sqlite && bun run start:http`
- Server: `bun run start:http` (port 3013) — cross-check MCP curl recipes in `LOCAL_TESTING.md` / `MCP.md`

---

## Phase 1: Tool ctx model + refactor `send-task` & `get-tasks`

### Overview

Introduce the `ToolCtx` discriminated union and the ownership chokepoint, then refactor the
two non-gated task tools (`send-task`, `get-tasks`) into exported pure
`(ctx, args) → CallToolResult` handlers. Owner `/mcp` behavior is unchanged; the user-ctx
branches are fully implemented and unit-testable even though no `/mcp-user` route exists yet.

### Changes Required:

#### 1. Tool ctx model + ownership chokepoint
**File**: `src/tools/task-tool-ctx.ts` (new)
**Changes**:
- Export the discriminated union:
  ```ts
  export type ToolCtx =
    | { kind: "owner"; agentId?: string; sourceTaskId?: string; sessionId?: string }
    | { kind: "user"; userId: string; user: User; sessionId?: string };
  ```
- `ownerCtx(info: RequestInfo): ToolCtx` — maps the existing `RequestInfo` shape.
- `userCtx(user: User, sessionId?: string): ToolCtx`.
- `assertOwnsTask(ctx: ToolCtx, task: AgentTask): CallToolResult | null` — the **single RBAC
  chokepoint**. Owner ctx → always `null` (visible). User ctx → `null` if
  `task.requestedByUserId === ctx.userId`, else an `isError` `CallToolResult` whose text +
  `structuredContent.code: "forbidden"` say *explicitly* "this task is not yours" (decision
  #5: explicit forbidden, **not** a not-found). Add a comment: *"RBAC chokepoint — a future
  admin/role tier widens visibility here, in this one function."*

#### 2. `send-task` handler split
**File**: `src/tools/send-task.ts`
**Changes**:
- Export `sendTaskInputSchema` / `sendTaskOutputSchema` (currently inline in the config).
- Extract the inlined callback (`:104-334`) into
  `export async function sendTaskHandler(ctx: ToolCtx, args): Promise<CallToolResult>`.
- Branch on `ctx.kind`:
  - `owner`: today's behavior — requires `ctx.agentId`, sets `creatorAgentId: ctx.agentId`.
  - `user`: omit `creatorAgentId`; set **`requestedByUserId: ctx.userId`** on all 3
    `createTaskExtended` calls (`:226,276,301`) — **decision #4**. Verify `createTaskExtended`
    tolerates an absent `creatorAgentId` (the Slack integration path already creates tasks
    this way; confirm at implementation).
- `registerSendTaskTool(server)` becomes thin: `createToolRegistrar(server)("send-task",
  config, (args, info) => sendTaskHandler(ownerCtx(info), args))`.

#### 3. `get-tasks` handler split + user filter
**File**: `src/tools/get-tasks.ts`, `src/be/db.ts`
**Changes**:
- Export `getTasksInputSchema` / `getTasksOutputSchema`; extract
  `export async function getTasksHandler(ctx: ToolCtx, args)`.
- Add an optional `requestedByUserId` filter to `getAllTasks` in `src/be/db.ts` (a new
  `WHERE requestedByUserId = ?` clause; today `get-tasks` has no user filter).
- `user` ctx: **always** pass `requestedByUserId: ctx.userId` to `getAllTasks` (hard scope —
  ignore `mineOnly`/`offeredToMe`, which are agent concepts). `owner` ctx: unchanged.
- `registerGetTasksTool` becomes the thin owner-binding.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] DB-boundary check passes (`task-tool-ctx.ts` must not import `src/be/db` if placed in
      worker scope — it is API-side, but confirm): `bash scripts/check-db-boundary.sh`
- [ ] Existing registrar test still green: `bun test src/tests/tool-registrar-no-input.test.ts`
- [ ] New unit test `src/tests/task-tools-ctx.test.ts`: `sendTaskHandler` with a fake
      `userCtx` writes `requestedByUserId`; `getTasksHandler` with `userCtx` only returns
      that user's tasks; `assertOwnsTask` returns an `isError` forbidden result for a
      foreign task and `null` for an owned one and for any owner ctx — `bun test src/tests/task-tools-ctx.test.ts`

#### Automated QA:
- [ ] Start `bun run start:http`; over the owner `/mcp` route call `send-task` and
      `get-tasks` exactly as before — confirm responses are unchanged (no regression from
      the extraction).

#### Manual Verification:
- [ ] Diff review: owner `/mcp` code path has zero behavior change — the only owner-visible
      delta is internal restructuring.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 2: Refactor the 3 ownership-gated task tools

### Overview

Apply the same `(ctx, args) → result` split to `get-task-details`, `cancel-task`, and
`task-action`, and route all three through `assertOwnsTask`. This phase carries the
403-not-404 ownership decision and the RBAC-chokepoint note.

### Changes Required:

#### 1. `get-task-details` handler split + ownership gate
**File**: `src/tools/get-task-details.ts`
**Changes**:
- Export schema; extract `getTaskDetailsHandler(ctx, args)`.
- After `getTaskById`, call `assertOwnsTask(ctx, task)` — return its result if non-null.
  (Today this tool has **no** permission check; user ctx adds one, owner ctx unchanged.)

#### 2. `cancel-task` handler split + ownership gate
**File**: `src/tools/cancel-task.ts`
**Changes**:
- Export schema; extract `cancelTaskHandler(ctx, args)`.
- `owner` ctx: keep today's agent permission (`isLead || creatorAgentId === agentId`).
- `user` ctx: gate via `assertOwnsTask` *before* the cancel; no agent-permission check.

#### 3. `task-action` handler split + per-action gating
**File**: `src/tools/task-action.ts`
**Changes**:
- Export schema; extract `taskActionHandler(ctx, args)`.
- `owner` ctx: today's per-action agent scoping unchanged (incl. the `canClaim` call at
  `:262` — Phase 6 extends that call).
- `user` ctx: the **only** user-allowed actions are `to_backlog` / `from_backlog`, each
  gated by `assertOwnsTask` on the target task. Agent-only actions (`claim`, `accept`,
  `reject`, `release` — they require an `agentId`) return a clear `isError` result: *"this
  action is only available to worker agents."* The `create` action is **rejected for
  users** too — `send-task` is the user create path, so allowing `task-action create` would
  duplicate it with an un-trimmed schema (resolves review I3). Net user `task-action`
  surface: two ownership-gated backlog moves.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New unit tests `src/tests/task-tools-ownership.test.ts`: each of the 3 handlers, with
      a `userCtx` whose `userId` ≠ `task.requestedByUserId`, returns the forbidden result;
      with a matching `userId`, succeeds; owner ctx behaves as before — `bun test src/tests/task-tools-ownership.test.ts`
- [ ] Full suite passes: `bun test`

#### Automated QA:
- [ ] Over owner `/mcp`, exercise `get-task-details`, `cancel-task`, `task-action`
      (release/accept) against a real task — confirm identical behavior to pre-refactor.

#### Manual Verification:
- [ ] Confirm the forbidden envelope wording reads as an explicit "not yours", and that
      `assertOwnsTask` is the *only* place ownership is decided across all 3 tools.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 3: `/mcp-user` route + user registry + `aswt_` middleware

### Overview

Add the public `/mcp-user` route: an `aswt_`-bearer middleware resolving `resolveUserByToken`,
its own transport map, and a `createUserServer(user)` registry that registers exactly the 5
refactored task tools bound with a `user` ctx.

### Changes Required:

#### 1. User-MCP registry
**File**: `src/server-user.ts` (new)
**Changes**:
- `export function createUserServer(user: User): McpServer` — builds an `McpServer` and
  registers **only** the 5 task tools via `createToolRegistrar(server)(name, config,
  (args) => xHandler(userCtx(user), args))`. `task-action` is registered **unconditionally**
  here — the user task surface is fixed, so it intentionally bypasses the owner-side
  `task-pool` capability gate.
- **User input surface (minimal, multi-tenant-safe — resolves review I3/I4).** `send-task`
  is registered with a trimmed schema: `{ task, taskType?, tags?, priority?, model? }`.
  Dropped vs. the owner schema: `agentId` / `offerMode` / `slack*` (agent/owner concepts),
  and `dir` / `vcsRepo` / `parentTaskId` / `dependsOn` — a hosted end-user must not pick the
  agent's working directory, repo, or link tasks into another user's task tree. The shared
  `sendTaskHandler` tolerates absent fields and, under `user` ctx, ignores any owner-only
  field even if present (defense in depth).

#### 2. `/mcp-user` route handler
**File**: `src/http/mcp-user.ts` (new)
**Changes**:
- `handleMcpUser(req, res, transports, sessionUsers)` mirrors `handleMcp` (`src/http/mcp.ts`)
  but:
  - matches `req.url === "/mcp-user"`;
  - on **every** request extracts `Authorization: Bearer aswt_…`, calls
    `resolveUserByToken(plaintext)`; missing / malformed / revoked / unknown → `401`;
  - **rejects (401) when `user.status !== 'active'`** — a `suspended` user with a still-live
    token must lose access immediately (resolves review C1; `resolveUserByToken` itself does
    not check `status`);
  - on a **new session** calls `createUserServer(user)` + `server.connect(transport)`, and
    records `sessionUsers[sessionId] = user.id`;
  - on an **existing session**, rejects (401) when the request's resolved `userId` ≠
    `sessionUsers[sessionId]` — a session is bound to the user it was opened for (resolves
    review I1);
  - uses its own transport map + `sessionUsers` map (both passed in); clears the
    `sessionUsers` entry on session close.
- Re-validating per request makes token revocation / suspension take effect immediately
  (cheap: sha256 + indexed lookup). `resolveUserByToken` already does the fire-and-forget
  `lastUsedAt` update.

#### 3. Wire the route into the server
**File**: `src/http/index.ts`
**Changes**:
- Add `transportsUser` and `sessionUsers` global maps (`globalState.__transportsUser ?? {}`,
  `globalState.__sessionUsers ?? {}`), stored back like `__transports` (`:76-90,235`).
- Add `() => handleMcpUser(req, res, transportsUser, sessionUsers)` to the handler chain
  (`:165-206`), adjacent to `handleMcp` (order-independent — both match exact URLs).
- Add a `transportsUser` close loop to `shutdown()` (`:237-275`), mirroring the `transports`
  loop.

#### 4. Make `/mcp-user` public (bypass swarm-key check)
**File**: `src/http/core.ts`
**Changes**:
- The bearer check at `:241-253` rejects any non-`isPublicRoute` path; `/mcp` and
  `/mcp-user` are raw-mounted so they are not in `routeRegistry`. Add an explicit carve-out:
  skip the bearer check when `req.url === "/mcp-user"` (or `?.startsWith("/mcp-user")`).
  Comment it: *"`/mcp-user` runs its own `aswt_`-token auth in `handleMcpUser`; the swarm
  API key must not gate it."*

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] New test `src/tests/mcp-user-route.test.ts`: request to `/mcp-user` with no token →
      401; with a revoked token → 401; with a **suspended user's** valid token → 401 (C1);
      with a token whose user ≠ the `mcp-session-id`'s opening user → 401 (I1); with a valid
      active-user token → MCP `initialize` + `tools/list` returns exactly the 5 task tools —
      `bun test src/tests/mcp-user-route.test.ts`
- [ ] Full suite passes: `bun test`

#### Automated QA:
- [ ] Mint a token (via `mintToken` in a script or, after Phase 4, the endpoint); `curl` an
      MCP `initialize` → `tools/list` → `tools/call send-task` against
      `http://localhost:3013/mcp-user` with `Authorization: Bearer aswt_…`. Confirm the
      created task has `requestedByUserId` = that user, and `get-tasks` over `/mcp-user`
      returns only that user's tasks.
- [ ] Confirm owner `/mcp` still works with the swarm key (regression).

#### Manual Verification:
- [ ] Confirm a revoked token stops working on the *next* request within an open session.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 4: Operator token endpoints

### Overview

Add `POST /api/users/{id}/mcp-tokens` (mint) and `DELETE /api/users/{id}/mcp-tokens/{tokenId}`
(revoke) to `src/http/users.ts`, wiring the existing `mintToken`/`revokeToken` helpers.

### Changes Required:

#### 1. Mint + revoke routes
**File**: `src/http/users.ts`
**Changes**:
- `POST /api/users/{id}/mcp-tokens` — `route()` factory (pattern `["api","users",null,
  "mcp-tokens"]`), `auth: { apiKey: true }`, body `z.object({ label: z.string().nullable()
  .optional() })`. Handler: `getOperatorActor` → 404 if user missing → `mintToken(id, label
  ?? null, actor)` → respond `{ plaintext, token: <summary>, user: composeUser(id) }`.
  Plaintext is returned **once**. (`mintToken` emits `token_minted` internally.)
- `DELETE /api/users/{id}/mcp-tokens/{tokenId}` — pattern `["api","users",null,"mcp-tokens",
  null]`, params `{ id, tokenId }`. Handler: `getOperatorActor` → `revokeToken(tokenId,
  actor)` (throws `Token not found` → map to 404) → respond `{ user: composeUser(id) }`.
  (`revokeToken` emits `token_revoked` internally.)
- Import `mintToken` / `revokeToken` from `src/be/users.ts` (not currently imported).

#### 2. OpenAPI regen
**File**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: `src/http/users.ts` is already imported by `scripts/generate-openapi.ts` — the
new `route()` calls self-register. Run `bun run docs:openapi` and commit the regenerated spec.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] OpenAPI spec is fresh (no diff after regen): `bun run docs:openapi` then `git diff --exit-code openapi.json`
- [ ] New test `src/tests/user-token-routes.test.ts`: `POST` mints (returns plaintext once,
      `aswt_`-prefixed, persists only the hash); `DELETE` revokes; both reject without the
      swarm key (401); `DELETE` of an unknown token → 404 — `bun test src/tests/user-token-routes.test.ts`

#### Automated QA:
- [ ] `curl -X POST .../api/users/<id>/mcp-tokens` with the swarm key → plaintext token in
      the response; `curl` `GET /api/users/<id>` shows the token summary (preview only, no
      plaintext); `curl -X DELETE` revokes it; the user's `recentEvents` show
      `token_minted` then `token_revoked`.

#### Manual Verification:
- [ ] Spot-check that no log line printed the plaintext token (the `aswt_` scrubber rule
      should mask it if it leaks).

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 5: People page Tokens tab

### Overview

Add a "Tokens" tab to the People detail page: a token-list panel, a mint dialog showing the
plaintext once plus the 5 data-driven client-config snippets, and revoke actions.

### Changes Required:

#### 1. Shared copy-to-clipboard component
**File**: `ui/src/components/shared/copy-button.tsx` (new)
**Changes**: Extract the local `CopyButton` from `ui/src/components/shared/markdown-view.tsx:50-74`
into a reusable exported component; re-import it in `markdown-view.tsx`.

#### 2. Client-config snippet catalog
**File**: `ui/src/lib/mcp-client-snippets.ts` (new)
**Changes**: A **data-driven** catalog (config, not code — research §"Client config snippets")
producing 5 copy entries + curl from one template, given `{ serverUrl, token }`:
1. Claude Code CLI — `claude mcp add --transport http …`
2. Cursor — `mcpServers` JSON (`url` + `headers`)
3. VS Code / Copilot — `servers` JSON, **`type: "http"`** + `headers` (note: root key is
   `servers`, not `mcpServers`)
4. Claude Desktop — **`mcp-remote` bridge** (`npx -y mcp-remote <url> --header …`); label it
   (native remote connector expects OAuth — a plain URL entry won't carry the bearer)
5. Generic `mcp-remote` bridge — covers Windsurf / Zed / Cline / Goose / JetBrains
   - plus a `curl` debugging snippet.
   `serverUrl` = `<MCP base URL>/mcp-user`. **The MCP base URL must come from server-provided
   config** — the API server (`:3013`) knows `MCP_BASE_URL`; the UI runs on a *different*
   origin (`:5274`), so `window.location.origin` is wrong (resolves review I2). Source it
   from an existing UI config/integrations endpoint, adding a small `mcpBaseUrl` field there
   if none is exposed yet.
   *Caveat (research): spot-check each client's syntax against its official docs at
   implementation time — the survey was synthesized without live doc fetches.*

#### 3. API client + hooks
**File**: `ui/src/api/client.ts`, `ui/src/api/hooks/use-users.ts`, `ui/src/api/types.ts`
**Changes**:
- `api.mintUserToken(id, label)` → `POST`; `api.revokeUserToken(id, tokenId)` → `DELETE`.
- Add a `MintTokenResponse` type (`{ plaintext, token, user }`).
- `useMintUserToken()` / `useRevokeUserToken()` mutations, invalidating `["users"]`,
  `["user", id]`, `["user-events", id]` (mirror `useUpdateUser`).

#### 4. Tokens tab + panel + mint dialog
**File**: `ui/src/pages/people/[id]/page.tsx`, `ui/src/pages/people/[id]/tokens-table.tsx`
(new), `ui/src/pages/people/[id]/mint-token-dialog.tsx` (new)
**Changes**:
- Add `"tokens"` to the tab union + `coerceTab`; add a `<TabsTrigger value="tokens">` and a
  `<TabsContent value="tokens">` wrapping `<TokensTable user={user} />`.
- `TokensTable` — lists `user.tokens` (label, `aswt_…<preview>`, createdAt, lastUsedAt,
  revoked badge); "Mint token" button; per-active-token "Revoke" (confirm).
- `MintTokenDialog` — label input → on success shows the plaintext **once** in a copy box +
  the 5 snippet entries (reuse `CopyButton`), with a clear "you won't see this again" notice.

### Success Criteria:

#### Automated Verification:
- [ ] UI type check + lint pass: `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] Browser-use (agent-browser, local URL `http://localhost:5274`) walkthrough with
      screenshots: open a person → Tokens tab → mint a token → verify plaintext + snippets
      render and copy → revoke → verify the token shows revoked. Attach screenshots.

#### Manual Verification:
- [ ] Taras manual-QAs the SPA flow (per project convention — UI unit-test infra is skipped
      in this repo). **Note:** the frontend merge-gate expects a `qa-use` session with
      screenshots; Taras to confirm whether the browser-use screenshots satisfy it or a
      `qa-use` run is still required.
- [ ] Spot-check one rendered snippet against the live client's docs before merge.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 6: User budget enforcement

### Overview

Add a `user` budget scope: widen the `budgets` CHECK constraint, mirror `users.dailyBudgetUsd`
into `budgets` `user`-rows, add a per-user daily-spend query, and a third gate in `canClaim`.

### Changes Required:

#### 1. Migration — widen the `budgets` scope
**File**: `src/be/migrations/069_budgets_user_scope.sql` (new — 069 is the next number)
**Changes**:
- SQLite cannot `ALTER`/`DROP` a CHECK constraint — recreate the `budgets` table with
  `CHECK (scope IN ('global','agent','user'))` (create new → copy rows → drop old → rename),
  preserving the `(scope, scope_id)` PK, the `daily_budget_usd >= 0` check, **and any
  existing indexes on `budgets`** (recreate them after the rename).
- Note: user-budget enforcement is **claim-time only** — like the existing agent/global
  gates, an in-flight task is never killed mid-run; a single task may overshoot the cap.
- **Backfill** the `user` rows: `INSERT INTO budgets (scope, scope_id, daily_budget_usd,
  createdAt, lastUpdatedAt) SELECT 'user', id, dailyBudgetUsd, <now>, <now> FROM users
  WHERE dailyBudgetUsd IS NOT NULL`.
- Test against a fresh DB **and** an existing one (`rm agent-swarm-db.sqlite && bun run start:http`).

#### 2. Schema enum
**File**: `src/types.ts`
**Changes**: `BudgetScopeSchema = z.enum(["global","agent","user"])` (`:1537`) — keep in
lockstep with the new CHECK.

#### 3. Per-user daily-spend query
**File**: `src/be/db.ts`
**Changes**: `getDailySpendForUser(userId: string, dateUtc: string): number` —
```sql
SELECT COALESCE(SUM(sc.totalCostUsd), 0) AS total
FROM session_costs sc
JOIN agent_tasks t ON sc.taskId = t.id
WHERE t.requestedByUserId = ? AND substr(sc.createdAt, 1, 10) = ?
```
(Join `session_costs.taskId → agent_tasks.id`, filter `requestedByUserId` — **decision #3**;
no new `session_costs.userId` column.)

#### 4. `canClaim` — third gate
**File**: `src/be/budget-admission.ts`
**Changes**:
- Signature → `canClaim(agentId: string, nowUtc: Date, requestedByUserId?: string)`.
- After the agent gate, add a `user` gate (only when `requestedByUserId` is set):
  `getBudget("user", requestedByUserId)` → if set and `getDailySpendForUser(...) >= cap` →
  refuse with `cause: "user"`.
- Extend `BudgetAdmissionRefused` with `cause: "user"` and `userSpend` / `userBudget` fields.

#### 5. Gate-site call updates
**File**: `src/http/poll.ts`, `src/tools/task-action.ts`
**Changes**:
- `poll.ts:183` (pre-assigned): the pending task is in hand — pass
  `pendingTask.requestedByUserId`.
- `poll.ts:306` (pool): today `requestedByUserId` is resolved *after* the gate (`:247-249`).
  **Reorder** — resolve the candidate task's `requestedByUserId` *before* `canClaim` so it
  can be passed in. (Flagged subtlety — confirm the pool selection still selects the same
  candidate when threading this earlier.)
- `task-action.ts:262` (accept): resolve the task's `requestedByUserId` and pass it.

#### 6. Keep the `budgets` `user`-row in sync
**File**: `src/http/users.ts`
**Changes**: In the `POST /api/users` and `PATCH /api/users/{id}` handlers, when
`dailyBudgetUsd` is set/changed: `upsertBudget("user", id, value)` if non-null, else
`deleteBudget("user", id)`. (These handlers already emit the `budget_changed` event — add
the `budgets` mirror alongside.)

#### 7. Refusal messaging for the new cause
**File**: `src/be/budget-refusal-notify.ts`, `src/utils/budget-backoff.ts` (verify)
**Changes**: The claim-time refusal envelope + lead-notification branch on `cause` — add the
`"user"` case so a user-budget refusal produces a sensible worker trigger + lead message.
Backoff already keys on refusal generically; confirm it needs no `cause`-specific change.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Migration applies cleanly on a fresh DB **and** an existing DB (`rm agent-swarm-db.sqlite
      && bun run start:http`, then again against the pre-existing DB).
- [ ] New test `src/tests/budget-user-scope.test.ts`: `getDailySpendForUser` sums only that
      user's tasks' costs; `canClaim` refuses with `cause: "user"` when the user's spend ≥
      cap and allows when below; agent/global gates unaffected — `bun test src/tests/budget-user-scope.test.ts`
- [ ] Existing budget tests still green: `bun test src/tests/budgets-routes.test.ts` and any
      `budget-admission` test file
- [ ] Full suite passes: `bun test`

#### Automated QA:
- [ ] Create a user with `dailyBudgetUsd` = small value; mint a token; over `/mcp-user`
      `send-task` repeatedly; seed `session_costs` rows (or run real tasks) to exceed the
      cap; confirm the next claim is refused at admission time (task stays `pending`, worker
      backs off) and the lead gets one notification for that `(task, day)`.
- [ ] PATCH the user's `dailyBudgetUsd` via the People page → confirm the `budgets`
      `user`-row updates (and is deleted when the field is cleared to null).

#### Manual Verification:
- [ ] Confirm the People-page budget copy ("Soft cap, enforced once MCP user-tokens ship")
      is now accurate — optionally update the copy.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Manual E2E

End-to-end check against a real local server. Replace `<USER_ID>` / `<TOKEN>` with values
from the steps. Cross-check curl/MCP framing against `MCP.md` and `LOCAL_TESTING.md`.

```bash
# 0. Fresh server
rm -f agent-swarm-db.sqlite && bun run start:http   # port 3013, swarm key default 123123

# 1. Create a user with a small budget (operator-authed)
curl -s -X POST http://localhost:3013/api/users \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"E2E User","email":"e2e@example.com","dailyBudgetUsd":0.50}'
#  -> note the returned user id  => <USER_ID>

# 2. Mint an MCP token for that user
curl -s -X POST http://localhost:3013/api/users/<USER_ID>/mcp-tokens \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"label":"laptop"}'
#  -> copy the one-time plaintext  => <TOKEN>  (starts with aswt_)

# 3. /mcp-user rejects a missing/bad token
curl -s -i -X POST http://localhost:3013/mcp-user \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'      # expect 401

# 4. /mcp-user initialize + tools/list with the token  => exactly 5 task tools
curl -s -X POST http://localhost:3013/mcp-user \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'
#  -> capture the mcp-session-id response header, reuse it below; then tools/list:
#  {"jsonrpc":"2.0","id":2,"method":"tools/list"}

# 5. send-task over /mcp-user  -> task created with requestedByUserId=<USER_ID>
#  tools/call send-task {"task":"E2E: say hello"}

# 6. get-tasks over /mcp-user  -> returns ONLY this user's tasks
#  get-task-details on a task id that is NOT this user's  -> explicit forbidden error

# 7. Owner /mcp still works with the swarm key (regression)
curl -s -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}'

# 8. Budget: drive <USER_ID>'s daily spend past 0.50 (real tasks or seeded session_costs),
#    then send-task + let a worker poll -> claim refused at admission, task stays pending.

# 9. Revoke the token; repeat step 4 -> 401
curl -s -X DELETE http://localhost:3013/api/users/<USER_ID>/mcp-tokens/<TOKEN_ID> \
  -H "Authorization: Bearer 123123"

# 10. UI: open http://localhost:5274 -> People -> the E2E user -> Tokens tab
#     -> mint, copy a snippet, revoke.
```

## Appendix

- **Derail notes:**
  - **`task-action` user-allowed action subset** (Phase 2) — resolved to `to_backlog` /
    `from_backlog` only (both ownership-gated). `claim`/`accept`/`reject`/`release` are
    agent-worker actions; `create` duplicates `send-task`. The brainstorm/research list
    `task-action` in the v1 surface but do not enumerate the per-action user policy — if a
    user-facing need for another action surfaces, revisit.
  - **`createTaskExtended` without `creatorAgentId`** — user-ctx `send-task` omits it;
    confirm the column is nullable and downstream code (assignment, dedup) tolerates it.
    The Slack integration path appears to already create tasks without an agent creator.
  - **Pool-gate reorder** (Phase 6, `poll.ts:306`) — threading `requestedByUserId` before
    `canClaim` changes the order of task resolution vs. admission; verify pool selection is
    unaffected.
  - **v2 follow-ups (not this plan):** MCP notifications / push delivery; self-serve
    onboarding (`MCP_SIGNUP_MODE`, magic-link); a per-task conversation primitive for "talk
    to my agents".
- **References:**
  - Research: `thoughts/taras/research/2026-05-21-client-side-mcp-grounding.md` (binding
    decisions #1–#7 in its Open Questions section)
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-15-client-side-mcp.md`
  - PR #500 — "Humans as first-class users"

## Review Log

_Reviewed: 2026-05-22 by Claude (`desplega:reviewing`, autopilot). Structural check passed
(all 6 phases well-formed; 19 referenced files exist; migration 069 confirmed). All
content-analysis findings below were folded into the phases — no open errata._

- [x] **C1 — Suspended users retained MCP access.** `resolveUserByToken` does not check
  `users.status`. → Phase 3 §2: `handleMcpUser` rejects `status !== 'active'`; covered by a
  Phase 3 Success Criterion.
- [x] **I1 — Session ↔ token-user binding.** → Phase 3 §2/§3: a `sessionUsers` map binds
  each `mcp-session-id` to its opening user; mismatched requests → 401; covered by a test.
- [x] **I2 — Snippet base URL.** → Phase 5 §2: MCP base URL is sourced from server config
  (`MCP_BASE_URL`), not `window.location`.
- [x] **I3 — User input surface.** → Phase 3 §1: minimal `send-task` user schema
  (`task`/`taskType`/`tags`/`priority`/`model`); Phase 2 §3: user `task-action` limited to
  `to_backlog`/`from_backlog` (no `create`).
- [x] **I4 — Foreign `parentTaskId`.** → Phase 3 §1: `parentTaskId`/`dependsOn`/`dir`/
  `vcsRepo` dropped from the user `send-task` schema entirely.
- [x] **M1 — frontmatter** — added the `planner:` field.
- [x] **M2 — `task-action` capability gate** → noted in Phase 3 §1.
- [x] **M3 — `budgets` index recreate + claim-time-only enforcement** → noted in Phase 6 §1.
