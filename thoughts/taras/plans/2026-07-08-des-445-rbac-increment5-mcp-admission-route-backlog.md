---
date: 2026-07-08T00:00:00Z
author: Claude
planner: Claude
topic: "DES-445 RBAC increment 5 — MCP tool admission + route-backlog burn-down"
tags: [plan, rbac, auth, security, des-445, mcp]
status: completed
autonomy: critical
last_updated: 2026-07-09
last_updated_by: Codex
related_design: thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md
related_plan: thoughts/taras/plans/2026-07-07-des-445-rbac-increment3-role-engine.md
---

# DES-445 RBAC Increment 5 — MCP Tool Admission + Route-Backlog Burn-Down

## Overview

Extend RBAC enforcement to the two surfaces increment 3 deliberately left ungated: **user-token MCP tool calls on `/mcp-user`** (where the real templated-client user population lives) and the **first tranche of the HTTP route backlog** (favorites, skills, mcp-servers, scripts). Register the new own-scoped verbs and decide which join the built-in requester role.

- **Motivation**: DES-445. Increments 1+2 (#921), increment 3 role engine (#935) + auto-backfill (#936) shipped; `RBAC_ENABLED` is ON in prod but a behavioral no-op because every user holds the built-in grantsAll admin role. Increment 5 makes the enforcement machinery actually cover the surfaces users hit.
- **Related**:
  - `thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md` (design authority; §7 frames the increments)
  - `thoughts/taras/plans/2026-07-07-des-445-rbac-increment3-role-engine.md` (what shipped; Appendix + Review Errata list increment-5 candidates)
  - `src/rbac/` (verb registry, admission, legacy-policy), `scripts/check-rbac-coverage.ts`

## Current State Analysis

### Two RBAC layers (do not conflate)

1. **`can()`** — legacy per-call-site verb check (`src/rbac/can.ts:29`). Pure, synchronous, evaluates the `LEGACY_POLICY` rule table (`src/rbac/legacy-policy.ts:145`). Route/tool handlers call it inline **today**. Does **not** read `RBAC_ENABLED`; reproduces pre-RBAC inline authz for **agent/operator** principals.
2. **`decideAdmission()` + `getUserGrant()` + `isRbacEnabled()`** — the DB-backed role engine (increment 3). Wired at `src/http/core.ts:266-287`, fires **only** for `auth.kind === "user"` when `RBAC_ENABLED=true`. This is the layer increment 5 extends to the MCP surface.

The admission decision (`src/rbac/admission.ts:20-43`): `grant.grantsAll` → allow (bypass); route declares `rbac.permission` → allow iff `grant.verbs.has(verb)`; no verb + `GET`/`HEAD` → allow (read fallback); verb-less non-GET → **fail-closed** (operator-only). `decideAdmission` takes an in-memory `grant` — never touches the DB. Audit rows written via `enqueueAdmissionRow` (`src/be/rbac-audit.ts:117`) **only for non-grantsAll grants** (`core.ts:268,276`), so default-role traffic adds zero audit noise — part of the no-op guarantee.

### `/mcp-user` surface (the real user population)

- Routed via `handleMcpUser` (`src/http/mcp-user.ts`), dispatched from `src/http/index.ts:69`. Opts **out** of the swarm-API-key gate — `core.ts:248-254` sets `setRequestAuth(req, null)` for `/mcp-user`, so it never reaches the HTTP admission gate. Auth is its own `aswt_` bearer flow: `resolveUserByToken` → active `User` (`mcp-user.ts:16-29`).
- The resolved `user` is captured into the per-session server: `createUserServer(user)` (`mcp-user.ts:86`, `src/server-user.ts`). **User identity is in closure scope for every tool handler** — no request-metadata threading needed.
- Exactly **5 tools**, an explicit hand-built allowlist (not a filter over the agent registry), in `src/server-user.ts`: `send-task` (:57, write/create), `get-tasks` (:74, readOnlyHint), `get-task-details` (:86, readOnlyHint), `cancel-task` (:98, write), `task-action` (:110, write). All delegate to shared handlers bound to `userCtx(user, sessionId)` — **ownership is already structural**; the admission verb is a policy gate on top.
- **`ToolConfig`** (`src/tools/utils.ts:111-121`) has no `rbac` field today; adding `rbac?: { permission: PermissionVerb } | { ungated: string }` is the natural extension. The dispatch seam is `createToolRegistrar` (`src/tools/utils.ts:135`), which wraps every handler in `withSpan` before `await cb(...)`. Adding `rbac` to `ToolConfig` does **not** ripple into `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) — that maps name strings, not the TS type; the 5 user tools are a disjoint surface from the scripts-runtime agent SDK.

### The verb registry & roles

- `PERMISSIONS` (`src/rbac/permissions.ts:19`) — object-of-`{description,namespace}`; `PermissionVerb`/`PERMISSION_VERBS`/`PermissionVerbSchema` derive automatically. `.own`/`.any` is **naming convention only** — "own" enforcement lives in the rule predicate, not the string.
- Adding a verb to `PERMISSIONS` **breaks `legacy-policy.ts` typecheck** (its `satisfies Record<PermissionVerb, LegacyRule>` at `:186` becomes non-exhaustive) until you map it — the enforced next step. Rules available (`LEGACY_RULES`): `lead-only`, `lead-or-task-creator`, `lead-or-resource-owner`, `lead-or-own-namespace`, `any-authenticated`, `requester-owns-task`, `memory-owner-or-lead-swarm`, `operator-or-user-or-lead-or-task-owner`.
- **Built-in roles** (`src/be/rbac-roles.ts:15-32`): `admin` (`grantsAll:true`, empty verbs — every user's default role, the no-op) and `requester` (`grantsAll:false`, verbs `task.read.own`, `task.cancel.own`, `task.action.own`, `task.fs.mutate`). Adding a verb to a built-in role = append to its `verbs[]`; `ensureRbacSeedsSynced()` reconciles on boot — **no migration**.

### Route backlog (coverage gate)

- `scripts/check-rbac-coverage.ts` enforces: every non-GET `route()` def is covered iff `def.rbac !== undefined` **XOR** its `` `${METHOD} ${path}` `` key is in `ROUTE_RBAC_BACKLOG` (`:376-392`). Gating a route = add the `rbac` field **and** delete its backlog line (having both = stale-entry error). The backlog "must only ever shrink". Also: every `PERMISSION_VERB` needs a `"verb"` string-literal call site outside `src/rbac/` — **a route/tool `rbac: { permission: "x" }` field satisfies this** (so no `can()` call is required just to keep a verb alive).
- **Favorites** — `PUT /api/favorites` (`src/http/favorites.ts:25`) is **already** `rbac: { ungated }` (self-scoped, **not** backlogged). Under admission its ungated+non-GET posture fail-closes narrowed users. We convert it to `favorite.write.own` (decision below).
- **Skills** (`src/http/skills.ts`) — 11 non-GET routes, all backlogged; verbs `skill.*` **already exist** and are `leadOnly`/`leadOrResourceOwner` in legacy-policy (`:170-176`). Skills are agent-owned (`ownerAgentId`+`scope`), no `.own` variant.
- **MCP-servers** (`src/http/mcp-servers.ts`) — 5 non-GET routes, all backlogged; verbs `mcp-server.*` **already exist** (`legacy-policy.ts:177-181`). Agent-owned.
- **Scripts** (`src/http/scripts.ts`) — `upsert`/`delete` already gated (`script.global.write`/`script.global.delete`, `leadOnly`). 6 backlogged: `run`, `search`, and 4 `apis` token-minting routes → **need 6 new verbs**.

## Desired End State

- **`RBAC_ENABLED` OFF (prod default until Taras flips)**: byte-for-byte today's behavior everywhere, including `/mcp-user`.
- **`RBAC_ENABLED` ON, grantsAll (admin) user** — every user today: MCP tool calls and the newly-gated HTTP routes behave **byte-for-byte as today** (admission bypassed, zero audit rows). The no-op guarantee holds on both surfaces.
- **`RBAC_ENABLED` ON, narrowed `requester` user**: on `/mcp-user` can `send-task` / `get-tasks` / `get-task-details` / `cancel-task` / `task-action` (requester now holds `task.create.own` + the pre-existing task verbs; reads pass via the readOnly fallback). Can `PUT /api/favorites` (holds `favorite.write.own`). Is **fail-closed** (403 / soft MCP error) on admin/lead routes (skills/mcp-servers/scripts writes) — matching increment 3.
- **`ROUTE_RBAC_BACKLOG` shrinks by 22 entries** (11 skills + 5 mcp-servers + 6 scripts); favorites was never backlogged.
- **Agent/operator behavior on every touched HTTP route is unchanged** — we add only the `rbac` admission field (user-principal layer), no new `can()` calls, so agents keep bypassing admission.
- Verified by: `bun run tsc:check`, `bun test src/tests/rbac-*.test.ts`, `bun run check:rbac-coverage`, plus new MCP-admission unit + e2e cases proving the no-op and the narrowed-user matrix.

## What We're NOT Doing

- **Increment 4 (agent identity)** — agent-token admission stays out of scope.
- **Increment 6 (resource ACLs)** — per-resource access-control lists.
- **The deny primitive** — explicit deny rules.
- **Role-management API / UI** — creating/editing roles, assigning roles to users.
- **The rest of the route backlog** — only favorites, skills, mcp-servers, scripts this increment.

### Non-negotiables

- The **flag-ON no-op guarantee** for grantsAll users stays byte-for-byte identical.
- **Fail-closed** posture for narrowed users matches increment 3.

## Implementation Approach

- **Mirror, don't fork, the admission engine.** The MCP-user gate reuses `getUserGrant` + `isRbacEnabled` + `enqueueAdmissionRow` and a new sibling `decideToolAdmission()` next to `decideAdmission()`. Same short-circuit order → the no-op and fail-closed postures are identical by construction.
- **Gate at the closure seam, not the shared registrar.** The check lives in `src/server-user.ts` (where `user` is in scope), wrapping the 5 tool registrations — never in the shared `createToolRegistrar`, so the agent `/mcp` surface is untouched.
- **readOnly tools = the GET-fallback analog.** `readOnlyHint` tools with no `rbac` verb auto-pass; write tools declare a verb. (Decision: mirror HTTP GET fallback.)
- **Route burn-down is admission-field-only.** Add `rbac: { permission }` (or `{ ungated }`) to each `route()` def and delete its backlog line. **No `can()` calls added** → agent/operator behavior byte-for-byte. (Decision: rbac field only.)
- **Reuse existing verbs where they exist** (skills `skill.*`, mcp-servers `mcp-server.*`); register **8 new verbs total** — `task.create.own`, `favorite.write.own` (both → requester role), and `script.{run,search,api.create,api.update,api.rotate,api.delete}` (none → requester).
- **Sequencing**: Phase 1 = MCP surface (highest value, self-contained, new own-verb). Phase 2 = favorites + skills (reuse + one new user-verb). Phase 3 = mcp-servers + scripts (reuse + 6 new lead/self verbs). Each phase is an independent, QA-able session; the coverage gate stays green after every phase.

### New verbs & role membership (decision summary)

| Verb | Phase | Legacy rule | Joins `requester`? | Used at |
|---|---|---|---|---|
| `task.create.own` | 1 | `any-authenticated` | **Yes** | `send-task` tool rbac field |
| `favorite.write.own` | 2 | `any-authenticated` | **Yes** | `PUT /api/favorites` rbac field |
| `script.run` | 3 | `any-authenticated` | No | `POST /api/scripts/run` rbac field |
| `script.search` | 3 | `any-authenticated` | No | `POST /api/scripts/search` rbac field |
| `script.api.create` | 3 | `lead-only` | No | `POST /api/scripts/{id}/apis` rbac field |
| `script.api.update` | 3 | `lead-only` | No | `PATCH .../apis/{endpointId}` rbac field |
| `script.api.rotate` | 3 | `lead-only` | No | `POST .../apis/{endpointId}/rotate` rbac field |
| `script.api.delete` | 3 | `lead-only` | No | `DELETE .../apis/{endpointId}` rbac field |

Reused (already registered + mapped): `skill.create.swarm`, `skill.update.any`, `skill.delete.any`, `skill.install.any`, `skill.uninstall.any`, `skill.install.global`, `mcp-server.create.swarm`, `mcp-server.update.any`, `mcp-server.delete.any`, `mcp-server.install.any`, `mcp-server.uninstall.any`, `script.global.write/delete` (already gated), plus `task.{read,cancel,action}.own` (already in requester) for the other 4 MCP tools.

## Quick Verification Reference

- Type check: `bun run tsc:check`
- Lint (read-only, as CI runs): `bun run lint`
- Unit tests: `bun test`
- RBAC coverage gate: `bun run check:rbac-coverage`
- DB boundary: `bash scripts/check-db-boundary.sh`

---

## Phase 1: MCP-user tool-level admission + `task.create.own`

### Overview

`/mcp-user` tool calls pass through the RBAC admission layer: grantsAll users bypass (byte-for-byte no-op, zero audit rows), narrowed `requester` users can drive all 5 tools, and empty-grant/undeclared-write calls fail closed with a soft MCP error. Deliverable: a working `decideToolAdmission` gate in `src/server-user.ts` + the `task.create.own` verb seeded into the requester role.

### Changes Required:

#### 1. `ToolConfig` gains an optional rbac field
**File**: `src/tools/utils.ts` (type at `:111-121`)
**Changes**: Add `rbac?: { permission: PermissionVerb } | { ungated: string }` to `ToolConfig`. Import `PermissionVerb` from `@/rbac/permissions` (type-only). No behavioral change to `createToolRegistrar` — the field is read by the user-server gate, not the shared registrar.

#### 2. New `decideToolAdmission()` — the MCP analog of `decideAdmission`
**File**: `src/rbac/admission.ts` (beside `decideAdmission` at `:20`)
**Changes**: Add
```ts
export function decideToolAdmission(input: {
  rbac: AdmissionRbac | undefined;   // reuse existing AdmissionRbac union
  readOnly: boolean;                 // from ToolAnnotations.readOnlyHint
  grant: AdmissionGrant;
}): AdmissionDecision {
  if (input.grant.grantsAll) return { allow: true };
  if (input.rbac && "permission" in input.rbac) {
    const verb = input.rbac.permission;
    return input.grant.verbs.has(verb)
      ? { allow: true, verb }
      : { allow: false, reason: `missing permission '${verb}'`, verb };
  }
  if (input.readOnly) return { allow: true };            // GET/HEAD read-fallback analog
  return { allow: false, reason: "admission: tool has no permission verb (operator-only)" };
}
```
Export from `src/rbac/index.ts`.

#### 3. Wire the gate into the user server (closure seam)
**File**: `src/server-user.ts`
**Changes**: Wrap the 5 tool registrations so that **before** dispatch, when `isRbacEnabled() && !grant.grantsAll`: resolve `grant = getUserGrant(user.id)` (per-call, matching the HTTP path's per-request lookup), call `decideToolAdmission({ rbac: config.rbac, readOnly: config.annotations?.readOnlyHint ?? false, grant })`, `enqueueAdmissionRow({ ...source: "mcp", toolName, decision })`, and on deny return a **soft `CallToolResult`** (`{ isError: true, content: [{ type: "text", text: "Forbidden: <reason>" }] }`) — NOT an HTTP 403. grantsAll and flag-off paths skip the check entirely (no audit row) → no-op preserved. Prefer a small local helper (e.g. `registerUserTool(server, user, name, config, cb)`) over editing the shared `createToolRegistrar`.
- Confirm `src/server-user.ts` is API-server-side (it is — created from the API server via `mcp-user.ts`), so importing `getUserGrant` from `@/be/rbac-roles` does not trip `scripts/check-db-boundary.sh`. (`src/http/core.ts:14` already imports it.)

#### 4. Register + map + seed `task.create.own`
**Files**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`, `src/be/rbac-roles.ts`
**Changes**:
- `permissions.ts`: add `"task.create.own": { description: "Create a task the caller owns", namespace: "task" }`.
- `legacy-policy.ts`: map `"task.create.own": anyAuthenticated` (creation has no pre-existing resource to own).
- `rbac-roles.ts`: append `"task.create.own"` to the `requester` role `verbs[]` (`:30`). `ensureRbacSeedsSynced()` inserts the `role_permissions` row on boot — no migration.

#### 5. Declare `rbac` on the 5 user tools
**File**: `src/server-user.ts`
**Changes**: `send-task` → `rbac: { permission: "task.create.own" }`; `cancel-task` → `{ permission: "task.cancel.own" }`; `task-action` → `{ permission: "task.action.own" }`; `get-tasks` / `get-task-details` → no `rbac` field (readOnlyHint auto-passes). Verify the two read tools already set `annotations: { readOnlyHint: true }`.

#### 6. Tests
**Files**: extend `src/tests/rbac-admission.test.ts` (unit) + new `src/tests/rbac-mcp-admission-e2e.test.ts` (or extend `rbac-wire-e2e.test.ts`, reuse `rbac-e2e-helpers.ts`)
**Changes**:
- Unit: `decideToolAdmission` truth table — grantsAll→allow; verb∈grant→allow; verb∉grant→deny; readOnly+no-verb→allow; non-readOnly+no-verb→deny.
- E2E: boot API with `RBAC_ENABLED=true`, mint an `aswt_` user token; **(a)** default admin user → all 5 tools succeed, **zero** admission audit rows (no-op); **(b)** narrow user to `requester` → all 5 succeed; **(c)** detach `requester` (empty grant) → `send-task`/`cancel-task`/`task-action` soft-error, `get-tasks`/`get-task-details` still succeed; **(d)** `RBAC_ENABLED` unset → all 5 succeed regardless of roles (flag-off no-op).

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check` (legacy-policy exhaustiveness forces the `task.create.own` mapping)
- [x] Lint passes: `bun run lint`
- [x] RBAC unit + e2e suites pass: `bun test src/tests/rbac-admission.test.ts src/tests/rbac-mcp-admission-e2e.test.ts src/tests/rbac-roles.test.ts`
- [x] Full existing RBAC suite still green: `bun test src/tests/rbac-*.test.ts`
- [x] Coverage gate passes (new verb has a call site via the tool rbac field): `bun run check:rbac-coverage`
- [x] DB boundary clean: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [x] Agent boots the API with `RBAC_ENABLED=true` on a fresh DB, mints a user token, and via an MCP client / curl to `/mcp-user` exercises the matrix: admin user `send-task` → success with no audit row; narrowed-to-requester user `send-task` → success; empty-grant user `send-task` → soft error while `get-tasks` → success. (Follow LOCAL_TESTING.md MCP recipe.)

#### Manual Verification:
- [x] Confirm the soft-error UX renders acceptably in a real templated client (Claude Code `/mcp-user` snippet) — a denied tool shows a readable "Forbidden" message, not a hard transport failure.

**Implementation Note**: After this phase, pause for manual confirmation. Commit-per-phase enabled → commit `[phase 1] rbac: mcp-user tool admission + task.create.own` after verification passes.

---

## Phase 2: Favorites + Skills route gating

### Overview

`PUT /api/favorites` converts from `ungated` to the new `favorite.write.own` verb (added to `requester`), and all 11 skills backlog routes declare their existing `skill.*` verbs. Deliverable: `ROUTE_RBAC_BACKLOG` shrinks by 11 (skills); favorites narrowed-user access restored; agent behavior unchanged.

### Changes Required:

#### 1. Register + map + seed `favorite.write.own`
**Files**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`, `src/be/rbac-roles.ts`
**Changes**: add `"favorite.write.own": { description: "Set a favorite the caller owns", namespace: "favorite" }`; map `"favorite.write.own": anyAuthenticated`; append to `requester` role `verbs[]`.

#### 2. Convert the favorites route
**File**: `src/http/favorites.ts` (`:25`, def at `:31-35`)
**Changes**: replace `rbac: { ungated: "..." }` with `rbac: { permission: "favorite.write.own" }`. No `can()` call (row is already self-scoped via `resolveHttpAuditUserId`). Not in `ROUTE_RBAC_BACKLOG` → no backlog deletion.

#### 3. Gate the 11 skills routes (reuse existing verbs — rbac field only)
**File**: `src/http/skills.ts`
**Changes**: add `rbac: { permission }` to each route() def:
- `POST /api/skills/{id}/files` (:99) → `skill.update.any`
- `PUT /api/skills/{id}/files/{path}` (:132) → `skill.update.any`
- `DELETE /api/skills/{id}/files/{path}` (:149) → `skill.update.any`
- `POST /api/skills` (:164) → `skill.create.swarm`
- `PUT /api/skills/{id}` (:184) → `skill.update.any`
- `DELETE /api/skills/{id}` (:200) → `skill.delete.any`
- `POST /api/skills/{id}/install` (:215) → `skill.install.any`
- `DELETE /api/skills/{id}/install/{agentId}` (:232) → `skill.uninstall.any`
- `POST /api/skills/install-remote` (:245) → `skill.install.global`
- `POST /api/skills/sync-remote` (:264) → `skill.update.any`
- `POST /api/skills/sync-filesystem` (:280) → `rbac: { ungated: "self-scoped: syncs the caller's own agent FS" }`

#### 4. Shrink the backlog
**File**: `scripts/check-rbac-coverage.ts`
**Changes**: delete the 11 skills lines from `ROUTE_RBAC_BACKLOG` (`:220-370`). Favorites has no backlog line.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] Coverage gate passes — backlog shrank by 11, no stale/both-covered errors, `favorite.write.own` has a call site: `bun run check:rbac-coverage`
- [x] RBAC + skills characterization suites pass: `bun test src/tests/rbac-charact-skills.test.ts src/tests/rbac-charact-http.test.ts src/tests/rbac-roles.test.ts`
- [x] OpenAPI still fresh (route rbac fields don't change the spec, but favorites posture noted): `bun run docs:openapi` produces no diff — if it does, commit it.

#### Automated QA:
- [x] With `RBAC_ENABLED=true`: narrowed-to-`requester` user `PUT /api/favorites` → 200 (holds `favorite.write.own`); same user `POST /api/skills` → 403 fail-closed (lacks `skill.create.swarm`); admin (grantsAll) user → both succeed. Agent principal `POST /api/skills` → unchanged from today (bypasses admission). Verify via curl against a local server.

#### Manual Verification:
- [ ] Spot-check the favorites UI in the dashboard still works for a normal (admin-role) logged-in user — the posture change is invisible to grantsAll users.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 2] rbac: gate favorites + skills routes` after verification passes.

---

## Phase 3: MCP-servers + Scripts route gating

### Overview

Gate the 5 mcp-servers routes (reusing existing `mcp-server.*` verbs) and the 6 scripts backlog routes (registering 6 new `script.*` verbs). Deliverable: `ROUTE_RBAC_BACKLOG` shrinks by a further 11 (5 mcp-servers + 6 scripts); the token-minting `apis` surface is lead-gated for user principals; agent behavior unchanged.

### Changes Required:

#### 1. Gate the 5 mcp-servers routes (reuse existing verbs — rbac field only)
**File**: `src/http/mcp-servers.ts`
**Changes**: add `rbac: { permission }` to each:
- `POST /api/mcp-servers` (:53) → `mcp-server.create.swarm`
- `PUT /api/mcp-servers/{id}` (:79) → `mcp-server.update.any`
- `DELETE /api/mcp-servers/{id}` (:94) → `mcp-server.delete.any`
- `POST /api/mcp-servers/{id}/install` (:108) → `mcp-server.install.any`
- `DELETE /api/mcp-servers/{id}/install/{agentId}` (:125) → `mcp-server.uninstall.any`

#### 2. Register + map 6 new `script.*` verbs
**Files**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`
**Changes**: add to `PERMISSIONS` and map in `LEGACY_POLICY`:
- `script.run` → `any-authenticated` (self-scoped execution as caller's agent)
- `script.search` → `any-authenticated` (read over own + global scope)
- `script.api.create` → `lead-only`
- `script.api.update` → `lead-only`
- `script.api.rotate` → `lead-only`
- `script.api.delete` → `lead-only`

(`lead-only` mirrors the existing `script.global.*` privilege level; these routes mint/rotate public bearer tokens for `POST /api/x/script/{endpointId}`.) None join the `requester` role → narrowed users fail-closed here (accepted).

#### 3. Gate the 6 scripts routes
**File**: `src/http/scripts.ts`
**Changes**: add `rbac: { permission }` to each backlog route (leave `upsert`/`delete` as-is, already gated):
- `POST /api/scripts/run` (:103) → `script.run`
- `POST /api/scripts/search` (:121) → `script.search`
- `POST /api/scripts/{id}/apis` (:256) → `script.api.create`
- `PATCH /api/scripts/{id}/apis/{endpointId}` (:301) → `script.api.update`
- `POST /api/scripts/{id}/apis/{endpointId}/rotate` (:316) → `script.api.rotate`
- `DELETE /api/scripts/{id}/apis/{endpointId}` (:331) → `script.api.delete`

#### 4. Shrink the backlog
**File**: `scripts/check-rbac-coverage.ts`
**Changes**: delete the 5 mcp-servers + 6 scripts lines from `ROUTE_RBAC_BACKLOG`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check` (exhaustiveness forces all 6 new verb mappings)
- [x] Lint passes: `bun run lint`
- [x] Coverage gate passes — backlog shrank by 11, all 6 new verbs have call sites via route rbac fields, no stale entries: `bun run check:rbac-coverage`
- [x] RBAC suites pass: `bun test src/tests/rbac-*.test.ts`
- [x] Scripts-runtime tests unaffected: `bun test src/tests/scripts-*.test.ts`

#### Automated QA:
- [x] With `RBAC_ENABLED=true`: narrowed-to-`requester` user → `POST /api/mcp-servers` and `POST /api/scripts/{id}/apis` both 403 fail-closed; admin (grantsAll) user → both succeed; agent principal → both unchanged from today. Verify via curl against a local server.

#### Manual Verification:
- [x] Confirm the scripts `apis` token-minting flow (`POST /api/scripts/{id}/apis` → `POST /api/x/script/{endpointId}`) still works end-to-end for an operator/admin caller — the gate must not break the public-endpoint issuance path.

**Implementation Note**: After this phase, pause for manual confirmation. Commit `[phase 3] rbac: gate mcp-servers + scripts routes` after verification passes.

---

## Appendix

- **Follow-up plans**:
  - Increment 4 — identity: `user_api_keys` + bearer introspection reconciled with `user_tokens`; signed agent-context token replacing self-asserted `X-Agent-ID` (prerequisite for trusting agent-role scoping).
  - Increment 6 — resource ACLs (`channel_members` / `repo_access` / `agent_access`).
  - **Remaining `ROUTE_RBAC_BACKLOG`** (~127 after this increment) — notably `POST /api/tasks` and all `/api/users/*` writes; and the ~76 `UNGATED_TOOL_FILES` on the agent MCP surface.
- **Derail notes**:
  - `POST /api/tasks` (HTTP task creation) stays backlogged this increment — it's hit by many principal kinds and is out of the stated scope. `task.create.own` is used only at the MCP `send-task` site for now; gating the HTTP route with it is a future tranche (mind the cross-principal implications).
  - The `can()`-hardening pass (gating agent principals on skills/mcp-servers/scripts HTTP routes to match their MCP-tool twins) was **deliberately deferred** — it changes non-lead agent behavior and belongs with increment 4's trusted agent identity.
  - §8.3 open question (sensitive GET reads needing explicit `*.read.secrets`-style verbs so the read-fallback stops being "all reads allowed") remains open and now applies symmetrically to the MCP readOnly fallback introduced here.
  - The `script_apis` `lead-only` mapping is a legacy-policy entry with **no `can()` caller** this increment (admission-field-only) — it documents intended agent semantics for when the hardening pass wires `can()`.
- **References**:
  - Design authority: `thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md` (§7 increment map, §4 backlog burn-down, §8.3 read verbs)
  - Increment 3 (shipped): `thoughts/taras/plans/2026-07-07-des-445-rbac-increment3-role-engine.md`
  - Coverage gate: `scripts/check-rbac-coverage.ts`; roles: `src/be/rbac-roles.ts`; admission: `src/rbac/admission.ts`
