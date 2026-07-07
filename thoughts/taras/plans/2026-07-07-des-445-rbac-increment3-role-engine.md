---
date: 2026-07-07T00:00:00Z
author: Claude
planner: Claude
topic: "DES-445 RBAC increment 3 — role engine (per-user, union, deny-deferred)"
tags: [plan, rbac, auth, security, des-445]
status: draft
autonomy: autopilot
last_updated: 2026-07-07
last_updated_by: Claude
related_design: thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md
related_plan: thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md
related_research: thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md
---

# DES-445 RBAC Increment 3 — Role Engine (per-user, union, deny-deferred) Implementation Plan

## Overview

Build the role storage + effective-grant engine and the user-token admission gate behind a new `RBAC_ENABLED` flag: `roles` / `role_permissions` / `principal_roles` tables, union-of-roles grant resolution, built-in seed roles with a default role attached to every user (so enabling is a behavioral no-op), and an idempotent `rbac bootstrap` CLI backfill.

- **Motivation**: DES-445 — constrain `aswt_` user tokens now (the already-trustworthy principal) without waiting on agent identity hardening (increment 4).
- **Related**: `thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md` (design authority, signed off 2026-07-07), `thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md`, `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`, Linear DES-445.

## Current State Analysis

**Auth + dispatch.** `handleCore` (`src/http/core.ts:197-442`) resolves auth for every non-public request: `resolveHttpRequestAuth` at `src/http/core.ts:251` (401 at `:253-258`), then `setRequestAuth(req, auth)` at `:259`. Only two principal kinds exist on HTTP: `{ kind: "operator" }` and `{ kind: "user", userId, user }` (`src/http/auth.ts:13-32`, `src/utils/request-auth-context.ts:5-7`). `aswt_` bearers resolve via `resolveUserByToken` (sha256 hash lookup in `user_tokens`, active users only). `/mcp-user` and public routes skip the bearer gate (`core.ts:245-249`, auth = null); `handleMcpUser` does its own `aswt_` auth (`src/http/mcp-user.ts:23-49`). After `handleCore` returns `false`, `src/http/index.ts:298-353` runs the ordered per-domain handler chain; there is **no central registry-driven dispatcher** — each `handle*` matches its own `route()` defs.

**Route metadata.** `RouteDef.rbac?: { permission: PermissionVerb } | { ungated: string }` (`src/http/route-def.ts:43`) is declaration-only today; the only consumer is `scripts/check-rbac-coverage.ts`. The matched `RouteDef` is NOT a local variable at `core.ts:251`, but `findRoute(method, pathSegments)` (`src/http/route-def.ts:102-114`) is a pure registry lookup already exercised per-request for telemetry (`src/http/index.ts:243`); it returns `undefined` for core/inline routes and MCP transport. Only 12 non-GET routes declare `rbac: { permission }` inline today (scripts/fs/kv/config); `PUT /api/favorites` is the sole inline `{ ungated }` (`src/http/favorites.ts:35`); ~149 non-GET routes sit in `ROUTE_RBAC_BACKLOG` (`scripts/check-rbac-coverage.ts:219`) with no verb — including `POST /api/tasks` and all `/api/users/*` writes.

**RBAC engine.** `can(check)` (`src/rbac/can.ts:29-44`) is pure + sync, backed by the static `LEGACY_POLICY` predicate table (`src/rbac/legacy-policy.ts:145-185`, exhaustive over the 39 `PermissionVerb`s in `src/rbac/permissions.ts:19-176`). There is **no role/grant storage anywhere**. User principals get authority only via `requester-owns-task` (`legacy-policy.ts:87-97`) and the unconditional user-pass in `task.fs.mutate` (`legacy-policy.ts:119-131`); every lead rule denies users outright. Audit: `enqueueAuditRow(check, decision)` (`src/be/rbac-audit.ts:94-112`) buffers into `permission_audit` (migration `108_rbac_permission_audit.sql`); sink wired pre-listen at `src/http/index.ts:525-527`.

**DB + seeding.** Highest migration is 108; runner (`src/be/migrations/runner.ts:113`) applies lexically-sorted forward-only SQL, each in its own transaction, `PRAGMA foreign_keys = OFF` during the pass. House conventions (migration 105/108): camelCase columns, `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))`, `CHECK (x IN (...))` enums, `CREATE INDEX IF NOT EXISTS idx_<table>_<cols>`. Idempotent boot seeding precedent: `seedPricingFromModelsDev()` — `INSERT OR IGNORE` in a transaction, called at `src/http/index.ts:498-505` and `src/server.ts:177-183`. Users are INSERTed in exactly two production paths: `createUser` (`src/be/db.ts:10940`) and `findOrCreateUserByEmail` (`src/be/users.ts:314-353`), plus raw test INSERTs. Tokens mint via `mintToken` (`src/be/users.ts:431-453`) / `POST /api/users/{id}/mcp-tokens` (`src/http/users.ts:520-539`).

**Flag + CLI + boundary.** No `RBAC_ENABLED` exists; house idiom is strict `=== "true"` (`src/be/rbac-audit.ts:44-46`). No `rbac` CLI command exists; the sanctioned CLI-needs-DB shape is the `scripts` command: thin dispatch branch in `src/cli.tsx:680-688` dynamic-importing a module under `src/be/` (passes `scripts/check-db-boundary.sh`, which greps only for `be/db` / `bun:sqlite` import strings per file).

**Tests.** Wire e2e helpers (`src/tests/rbac-e2e-helpers.ts`) spawn the real server as a subprocess with a fresh temp sqlite and per-boot env injection (`spawnSwarmServer({ env: {...} })` — `rbac-lifecycle-e2e.test.ts:129,151` already override RBAC env per boot; zero cross-file leak). In-process env mutation follows the snapshot/restore discipline of `src/tests/rbac-audit.test.ts:76-109`. Wire tests create a user + `aswt_` token via `POST /api/users` then `POST /api/users/{id}/mcp-tokens` (`rbac-wire-e2e.test.ts:107-113`).

## Desired End State

With `RBAC_ENABLED` unset (default): byte-for-byte today's behavior. With `RBAC_ENABLED=true`:

1. `roles`, `role_permissions`, `principal_roles` tables exist; built-in `admin` (grants-all) and `requester` (own-task verbs) roles are seeded; every user (existing and future) holds `admin` by default.
2. A user token's request is admitted in `handleCore` right after auth: effective grant = union of attached roles' verb-sets; a `grantsAll` role bypasses admission (exactly today's behavior — the no-op guarantee); otherwise the matched route's `rbac.permission` must be in the union; GET/HEAD falls back to allow; non-GET with no verb (ungated / backlogged / no RouteDef) → 403 fail-closed.
3. Operator principals and the agent path are completely untouched. `/mcp-user` MCP tool calls are untouched (tool admission is increment 5).
4. Admission decisions for non-wildcard grants flow into the existing `permission_audit` table.
5. `bun run src/cli.tsx rbac bootstrap` idempotently syncs built-in roles and attaches the default role to role-less users, printing a summary.
6. Acceptance: the full slice-1 RBAC suite passes with `RBAC_ENABLED=true` (behavioral no-op with seeded defaults).

## What We're NOT Doing

- No `deny` primitive, conditions, or resource-pattern matchers (design §3 — deferred until a real subtract-requirement appears).
- No per-token role scoping / `user_api_keys` / intersection rule (increment 4; the schema here stays monotone-narrowing-compatible).
- No agent-principal roles (`principal_roles.principalType` reserves `'agent'` in the CHECK, but no agent rows are written — increment 4/6).
- No role-management HTTP API or UI (attach/detach beyond CLI+SQL is future work).
- No `ROUTE_RBAC_BACKLOG` burn-down and no MCP-tool admission (`ToolConfig.rbac`) — increment 5.
- No changes to handler-level `can()` calls or `LEGACY_POLICY` (Layer b stays as-is, design §2).
- No grant caching (per-request indexed lookups on in-process SQLite; optimize later if measured).
- No `db-query` gating (open question, design §8.2).

## Implementation Approach

- **Admission lives inside `handleCore`, immediately after `setRequestAuth` (`core.ts:259`)** — not in the `index.ts` handler loop. This covers the inline core routes (`/ping`, `/close`, `/internal/reload-config`) AND every `route()` route (handleCore runs first for all of them), and it makes the in-process test harnesses (which call `handleCore` + one `handle*` directly) exercise admission for free. `findRoute()` (`route-def.ts:102`) supplies the matched RouteDef; it's promoted from telemetry-only to load-bearing.
- **The no-op reconciliation: `roles.grantsAll`.** "Current user capability" includes 149 verb-less backlogged routes, which no verb-set can express. The faithful legacy-equivalent default role is therefore a wildcard: `admin` has `grantsAll=1` and bypasses admission entirely (like operator). Verb-listing roles (e.g. `requester`) get the strict fail-closed posture from design §4. Union stays monotonic: any attached `grantsAll` role ⇒ unrestricted.
- **Default-role attachment is airtight via migration backfill + an `AFTER INSERT ON users` trigger.** The trigger covers both production insert paths and raw test INSERTs atomically, with no import-cycle or call-site risk. The `rbac bootstrap` CLI is the operator-facing idempotent safety net (attaches the default only to users with *zero* roles — never re-adds a deliberately detached role alongside remaining ones).
- **Built-in role verb-sets are code-authoritative.** Migration seeds the initial snapshot; `ensureRbacSeedsSynced()` (boot + CLI) re-syncs built-in roles' `role_permissions` from a `BUILTIN_ROLES` constant so new verbs can join `requester` without a migration. Custom (non-builtin) roles are never touched by sync.
- **Grant resolution is a new API-side module `src/be/rbac-roles.ts`** (per-domain pattern like `src/be/users.ts` / `src/be/rbac-audit.ts`); `src/rbac/admission.ts` holds the *pure* decision function + `isRbacEnabled()`, keeping `src/rbac/can.ts` untouched and sync.
- **Admission audits through the existing buffered writer** (`src/be/rbac-audit.ts`) via a new `enqueueAdmissionRow` that reuses the buffer/flush machinery; only non-wildcard grants are logged (both allow and deny), so default-role traffic adds zero audit noise.
- **CLI naming deviation**: the design note says `rbac:bootstrap`, but no colon-style command exists in `src/cli.tsx` — following the `scripts reembed` precedent this ships as `rbac bootstrap` (flagged for Taras in review).

## Quick Verification Reference

- `bun test src/tests/rbac-roles.test.ts src/tests/rbac-admission.test.ts` — new suites
- `RBAC_ENABLED=true bun test src/tests/rbac-charact-http.test.ts src/tests/rbac-charact-misc-tools.test.ts src/tests/rbac-charact-skills.test.ts src/tests/rbac-charact-slack.test.ts src/tests/rbac-engine.test.ts src/tests/rbac-audit.test.ts src/tests/user-token-rest-auth.test.ts` — in-process no-op acceptance (wire-surface flag-ON proof lives in `rbac-admission-e2e`'s no-op leg, which boots with an explicit `opts.env` override — the helper pins `RBAC_ENABLED:"false"` after the `process.env` spread, so a shell-level flag never reaches subprocess suites)
- `bun run tsc:check` && `bun run lint` && `bun test`
- `bun run check:rbac-coverage` && `bash scripts/check-db-boundary.sh` && `bun run check:dep-graph`

---

## Phase 1: Migration 109 — role tables, seeds, backfill, default-role trigger

### Overview

Deliverable: `src/be/migrations/109_rbac_roles.sql` — the three tables, built-in role seed rows, `requester` verb snapshot, principal backfill for existing users, and the new-user default-role trigger. No TypeScript changes; behavior is inert.

### Changes Required:

#### 1. New migration
**File**: `src/be/migrations/109_rbac_roles.sql`
**Changes**: Following house conventions (camelCase, `IF NOT EXISTS`, header comment explaining semantics + pointing at the design note):

```sql
CREATE TABLE IF NOT EXISTS roles (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  isBuiltin     INTEGER NOT NULL DEFAULT 0,
  grantsAll     INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
  roleId    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  verb      TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (roleId, verb)
);

CREATE TABLE IF NOT EXISTS principal_roles (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  principalType TEXT NOT NULL CHECK (principalType IN ('user','agent')),
  principalId   TEXT NOT NULL,
  roleId        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (principalType, principalId, roleId)
);
CREATE INDEX IF NOT EXISTS idx_principal_roles_principal
  ON principal_roles(principalType, principalId);

-- Built-in roles: fixed ids so trigger/backfill SQL and code can reference them.
INSERT OR IGNORE INTO roles (id, name, description, isBuiltin, grantsAll) VALUES
  ('rbac-role-admin', 'admin',
   'Full access including verb-less routes (legacy-equivalent default).', 1, 1),
  ('rbac-role-requester', 'requester',
   'Own-task lifecycle: what legacy policy grants user principals.', 1, 0);

-- Initial snapshot of the requester verb-set; code (BUILTIN_ROLES in
-- src/be/rbac-roles.ts) is authoritative and re-syncs at boot.
INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES
  ('rbac-role-requester', 'task.read.own'),
  ('rbac-role-requester', 'task.cancel.own'),
  ('rbac-role-requester', 'task.action.own'),
  ('rbac-role-requester', 'task.fs.mutate');

-- Backfill: every existing user holds the default role.
INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  SELECT 'user', id, 'rbac-role-admin' FROM users;

-- Every future user row (createUser, findOrCreateUserByEmail, raw test
-- INSERTs) gets the default role atomically.
CREATE TRIGGER IF NOT EXISTS trg_users_default_role
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  VALUES ('user', NEW.id, 'rbac-role-admin');
END;
```

Notes: no `CHECK` on `role_permissions.verb` (the verb registry lives in TS and evolves; writes validate via `PermissionVerbSchema` in Phase 2 — also note `.sql` files are NOT scanned by `check:rbac-coverage` invariant 2, so the code constant in `src/be/rbac-roles.ts` is what keeps the verbs "live"). No FK on `principalId` (reserved `'agent'` type has no single parent table). **Trigger fragility**: this is the first `CREATE TRIGGER` in the codebase, and SQLite silently drops triggers when a table is rebuilt (the 067-style create/copy/drop/rename dance) — the migration header comment MUST warn that any future `users` rebuild must recreate `trg_users_default_role`, and `ensureRbacSeedsSynced` (Phase 2) self-heals it at boot as a backstop. Per CLAUDE.md migration rules: forward-only, never modify once applied.

### Success Criteria:

#### Automated Verification:
- [ ] Fresh DB boots clean: `rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm && timeout 15 bun run start:http; test $? -eq 124` (server starts, no migration error in output)
- [ ] Existing DB upgrades clean: re-run `timeout 15 bun run start:http` against the DB produced above (109 already applied → runner skips it, no error)
- [ ] Schema + seeds present: `sqlite3 agent-swarm-db.sqlite "SELECT name FROM roles ORDER BY name;"` prints `admin` and `requester`; `sqlite3 agent-swarm-db.sqlite "SELECT count(*) FROM role_permissions WHERE roleId='rbac-role-requester';"` prints `4`
- [ ] Trigger works: `sqlite3 agent-swarm-db.sqlite "INSERT INTO users (id, name) VALUES ('trig-test-user','Trig Test'); SELECT roleId FROM principal_roles WHERE principalId='trig-test-user';"` prints `rbac-role-admin`
- [ ] Full suite untouched: `bun test`
- [ ] `bun run lint` passes

#### Automated QA:
- [ ] Agent verifies backfill on a DB that had pre-existing users: create 2 users via `POST /api/users` on a fresh DB, stop the server, confirm `sqlite3 agent-swarm-db.sqlite "SELECT count(*) FROM principal_roles WHERE roleId='rbac-role-admin';"` equals the user count (trigger path), and confirm `_migrations` contains version 109

#### Manual Verification:
- [ ] None — schema-only phase, fully machine-checkable

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 2: Grant engine — `src/be/rbac-roles.ts` + boot seed sync

### Overview

Deliverable: an API-side module exposing effective-grant resolution (union + wildcard), role attach/detach helpers, and idempotent built-in-role sync wired into both server boot paths — plus its unit suite.

### Changes Required:

#### 1. Grant engine module
**File**: `src/be/rbac-roles.ts` (new)
**Changes**: Follow the `src/be/rbac-audit.ts` / `src/be/users.ts` module shape (`import { getDb } from "./db"`, statements prepared inside functions, mutations in `db.transaction()`):

- `export const BUILTIN_ROLES` — code-authoritative definitions: `admin` (`grantsAll: true`, no verbs) and `requester` (`["task.read.own","task.cancel.own","task.action.own","task.fs.mutate"]`), fixed ids `rbac-role-admin` / `rbac-role-requester`, `DEFAULT_ROLE_ID = "rbac-role-admin"`. Verb lists typed as `PermissionVerb[]` (import from `../rbac`).
- `export type EffectiveGrant = { grantsAll: boolean; verbs: ReadonlySet<PermissionVerb> }`.
- `export function getUserGrant(userId: string): EffectiveGrant` — single query: `SELECT r.grantsAll, rp.verb FROM principal_roles pr JOIN roles r ON r.id = pr.roleId LEFT JOIN role_permissions rp ON rp.roleId = r.id WHERE pr.principalType = 'user' AND pr.principalId = ?`. Zero rows → `{ grantsAll: false, verbs: new Set() }` (fail-closed).
- `export function attachRole(userId: string, roleName: string): void` / `export function detachRole(userId: string, roleName: string): void` / `export function listUserRoles(userId: string)` — used by tests, bootstrap, and future increments. `attachRole` validates the role exists; `INSERT OR IGNORE`.
- `export function ensureRbacSeedsSynced(opts?: { quiet?: boolean }): void` — idempotent, transactional: upsert `BUILTIN_ROLES` rows by fixed id (`INSERT OR IGNORE`), then make each built-in role's `role_permissions` exactly match its code verb-set (insert missing, delete extras — built-in roles only; custom roles untouched). Validates verbs with `PermissionVerbSchema` before insert. Finally re-executes the `CREATE TRIGGER IF NOT EXISTS trg_users_default_role ...` DDL: this is the first trigger in the codebase, and a future users-table rebuild (the 067-style create/copy/drop/rename dance) silently drops triggers — boot self-heals it. One-line summary log like `seedPricingFromModelsDev`.

#### 2. Boot wiring
**File**: `src/http/index.ts` (~`:498-518`, next to `seedPricingFromModelsDev`) and `src/server.ts` (~`:177-183`)
**Changes**: call `ensureRbacSeedsSynced()` in the same try/catch style as the pricing seed, pre-listen.

#### 3. Unit tests
**File**: `src/tests/rbac-roles.test.ts` (new)
**Changes**: temp-DB harness (same `initDb`-on-tmpdir pattern as `rbac-audit.test.ts`). Cover: union across multiple roles; wildcard short-circuit (`admin` + anything ⇒ `grantsAll`); empty grant for role-less user; unknown userId; attach/detach idempotence; trigger attachment on `createUser`; `ensureRbacSeedsSynced` heals a deleted built-in role, restores a tampered `requester` verb-set, and never touches a custom role's verbs; recreates the default-role trigger after a simulated `DROP TRIGGER trg_users_default_role`; invalid verb rejected by `attachRole`-adjacent seed validation.

### Success Criteria:

#### Automated Verification:
- [ ] New suite passes: `bun test src/tests/rbac-roles.test.ts`
- [ ] Types + lint: `bun run tsc:check` && `bun run lint`
- [ ] Boundary intact: `bash scripts/check-db-boundary.sh` && `bun run check:dep-graph`
- [ ] Full suite: `bun test`

#### Automated QA:
- [ ] Agent boots the server (`bun run start:http`) and confirms the boot log contains the one-line RBAC seed-sync summary; then deletes a `requester` verb row via `sqlite3`, reboots, and confirms the row is restored (code-authoritative sync demonstrated end-to-end)

#### Manual Verification:
- [ ] None — engine is fully unit-tested; no user-visible behavior yet

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 3: Admission gate — `RBAC_ENABLED`, `handleCore` wiring, audit

### Overview

Deliverable: the Layer-(a) admission gate live behind `RBAC_ENABLED` — pure decision function in `src/rbac/admission.ts`, wired into `handleCore` after auth, denials/allows audited — plus the flag-ON no-op acceptance run.

### Changes Required:

#### 1. Pure admission decision
**File**: `src/rbac/admission.ts` (new; re-export from `src/rbac/index.ts`)
**Changes**:
- `export function isRbacEnabled(): boolean` — `process.env.RBAC_ENABLED === "true"` (house idiom, `rbac-audit.ts:44-46`).
- `export type AdmissionDecision = { allow: true; verb?: PermissionVerb } | { allow: false; reason: string; verb?: PermissionVerb }`.
- `export function decideAdmission(input: { method: string; rbac: RouteDef["rbac"] | undefined; routeKnown: boolean; grant: EffectiveGrant }): AdmissionDecision` — pure, no DB, no env:
  - `grant.grantsAll` ⇒ allow (callers should short-circuit before even calling; kept here too for safety).
  - `rbac` is `{ permission }` ⇒ allow iff `grant.verbs.has(permission)`; deny reason `admission: missing permission '<verb>'`.
  - method `GET`/`HEAD` ⇒ allow (read fallback, design §6 — verb wins over method when declared, which the previous branch already handles).
  - anything else (non-GET with `{ ungated }`, no `rbac` field, or unknown route incl. inline core routes) ⇒ deny, reason `admission: route has no permission verb (operator-only)` (design §4 fail-closed posture).
- Import types only (`EffectiveGrant` as a structural type or redeclared locally) so `src/rbac/` stays DB-free; `can.ts` untouched.

#### 2. handleCore wiring
**File**: `src/http/core.ts` (immediately after `setRequestAuth(req, auth)` at `:259`)
**Changes**:
```ts
if (auth.kind === "user" && isRbacEnabled()) {
  const grant = getUserGrant(auth.userId);            // src/be/rbac-roles
  if (!grant.grantsAll) {
    const def = findRoute(req.method, pathSegments);   // src/http/route-def
    const decision = decideAdmission({ method: req.method ?? "", rbac: def?.rbac, routeKnown: def !== undefined, grant });
    enqueueAdmissionRow({ userId: auth.userId, decision, method: req.method, route: def?.path ?? pathSegments.join("/") });
    if (!decision.allow) { jsonError(res, "Forbidden: " + decision.reason, 403); return true; }
  }
}
```
`jsonError` from `src/http/utils.ts:135` keeps the `{ error }` house shape. Operator principals, null-auth paths (`/mcp-user`, public routes), and the agent surface never enter this block.

#### 3. Admission audit rows
**File**: `src/be/rbac-audit.ts`
**Changes**: `export function enqueueAdmissionRow(...)` reusing the existing buffer/flush/kill-switch: `principalType: 'user'`, `principalId: userId`, `verb: decision.verb ?? "(admission:no-verb)"`, `resourceType: 'http-route'`, `resourceId: "<METHOD> <route path or raw segments>"`, `decision`, `reason`, `source: 'http'`. Called only for non-wildcard grants (both allow and deny), so default-role traffic adds no rows.

#### 4. Unit + in-process tests
**File**: `src/tests/rbac-admission.test.ts` (new)
**Changes**: (a) pure `decideAdmission` matrix — verb hit, verb miss, GET fallback, HEAD, ungated non-GET, no-rbac non-GET, unknown route non-GET, wildcard, empty grant; (b) in-process `handleCore` wiring test with the `rbac-audit.test.ts:76-109` env snapshot/restore discipline: flag OFF ⇒ no gate; flag ON + default admin user ⇒ passthrough; flag ON + user narrowed to `requester` (via `detachRole`/`attachRole`) ⇒ 403 on a verb-less non-GET (e.g. `POST /ping` or a registered backlogged route), 200-path on GET, allowed on a `task.fs.mutate`-declared route match; audit rows enqueued with expected reasons. Import the relevant route modules so `findRoute` sees them (in-process registry population caveat — note it in the test header).

#### 5. Test-harness env pin
**File**: `src/tests/rbac-e2e-helpers.ts` (`spawnSwarmServer` env block, `:79-96`)
**Changes**: pin `RBAC_ENABLED: "false"` in the base env (after the `...process.env` spread, before `...opts.env`) so suites are deterministic regardless of the developer's shell. Consequence (deliberate): a shell-level `RBAC_ENABLED=true` never reaches subprocess suites — flag-ON wire coverage comes exclusively from suites passing `opts.env: { RBAC_ENABLED: "true" }` (Phase 4's `rbac-admission-e2e`).

### Success Criteria:

#### Automated Verification:
- [ ] New suite passes: `bun test src/tests/rbac-admission.test.ts`
- [ ] **No-op acceptance (the increment's acceptance criterion)**: `RBAC_ENABLED=true bun test src/tests/rbac-charact-http.test.ts src/tests/rbac-charact-misc-tools.test.ts src/tests/rbac-charact-skills.test.ts src/tests/rbac-charact-slack.test.ts src/tests/rbac-engine.test.ts src/tests/rbac-audit.test.ts src/tests/user-token-rest-auth.test.ts` — all green. `user-token-rest-auth.test.ts` and `rbac-charact-http.test.ts` are the strongest witnesses: both drive non-GET requests with `aswt_` bearers through the real `handleCore` and expect 201 — they pass only if the trigger-attached default role truly bypasses admission. (The wire suite is deliberately excluded here: the Phase-3 helper pin overrides a shell-level flag in subprocesses; wire-surface flag-ON proof is Phase 4's `rbac-admission-e2e` no-op leg.)
- [ ] Default-off regression: `bun test` (flag unset)
- [ ] `bun run tsc:check` && `bun run lint` && `bun run check:rbac-coverage` && `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent runs a live curl walkthrough against `RBAC_ENABLED=true bun run start:http`: create user + mint token (`POST /api/users`, `POST /api/users/{id}/mcp-tokens`), verify `POST /api/tasks` with the `aswt_` bearer succeeds (default admin ⇒ no-op), narrow the user to `requester` via `sqlite3`, verify the same `POST /api/tasks` now returns 403 with the `{ error }` body, `GET /api/tasks` still 200, and a `permission_audit` row exists with `resourceType='http-route'` and a deny decision

#### Manual Verification:
- [ ] None — behavior is fully exercised by the suites and the QA walkthrough

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 4: `rbac bootstrap` CLI, wire e2e, docs

### Overview

Deliverable: the operator-facing `rbac bootstrap` command, a dedicated flag-ON wire e2e suite, and the flag documented on every env surface.

### Changes Required:

#### 1. CLI command
**File**: `src/cli.tsx` + `src/be/rbac-roles.ts`
**Changes**: follow the `scripts reembed` shape exactly (`cli.tsx:680-688`):
- `COMMAND_HELP.rbac` entry (usage `agent-swarm rbac bootstrap`, description, options, examples) + `["rbac", "RBAC role management (bootstrap)"]` in the `printHelp()` commands array (~`:371-388`) + routing branch before `render()` that dynamic-imports `runRbacCliCommand` from `./be/rbac-roles`.
- Expect dependency-cruiser to emit a `no-worker-reaches-db` **warn** (not error) for `cli.tsx → be/rbac-roles → be/db` — same severity and precedent as the existing `cli.tsx → be/scripts/maintenance` edge (`.dependency-cruiser.cjs:27-34`); CI fails only on error-severity, so `bun run check:dep-graph` stays green.
- `export async function runRbacCliCommand(args: string[])` in `src/be/rbac-roles.ts`: only `bootstrap` subcommand — runs `ensureRbacSeedsSynced()`, attaches `DEFAULT_ROLE_ID` to every user with **zero** attached roles (never touches users who hold any role — a deliberately narrowed user stays narrowed), prints a summary: roles table (name / builtin / grantsAll / verb count / attached-user count), users backfilled this run, whether `RBAC_ENABLED` is set. Idempotent: second run backfills 0. Honors `DATABASE_PATH` (via `getDb()` lazy init, same as `scripts reembed`).
- **When it runs** (per Taras's review question, 2026-07-08): never required in the happy path (migration backfills, trigger covers new users, boot self-heals seeds + trigger). It's the operator tool for (a) the **pre-enable audit** — run before flipping `RBAC_ENABLED=true` on an existing deployment to confirm every user holds a role; (b) **drift recovery** after manual DB surgery or a restore that stripped users to zero roles; (c) periodic sanity. Document exactly this in the runbook entry (Phase 4 change #3).

#### 2. Wire e2e — admission over real HTTP
**File**: `src/tests/rbac-admission-e2e.test.ts` (new, reusing `rbac-e2e-helpers.ts`)
**Changes**: one `spawnSwarmServer({ env: { RBAC_ENABLED: "true" } })` boot on a fresh temp DB:
- No-op leg: create user via API, mint token, `POST /api/tasks` (body `{ task: "hello" }`) with the `aswt_` bearer ⇒ 201; operator bearer unaffected everywhere.
- Narrowed leg: rewrite `principal_roles` for the user to `requester` via a writable `bun:sqlite` connection on the temp DB (WAL allows the cross-process write; helpers already read cross-process at `:268-305`): `POST /api/tasks` ⇒ 403 (backlogged, verb-less); `PUT /api/favorites` ⇒ 403 (inline-ungated non-GET — fail-closed by design); `GET /api/tasks?requestedByUserId=...` ⇒ 200; a `task.fs.mutate`-declared route admits (handler-level `can()` then applies as Layer b).
- Audit leg: `waitForAuditCount`-style assertion that admission deny rows landed in `permission_audit` with `resourceType='http-route'`.
- Flag-off leg: second boot without the env override ⇒ narrowed user can `POST /api/tasks` again (flag truly gates everything).

#### 3. Documentation surfaces
**Files**: `runbooks/local-development.md` (env-var table, `:15-27`), `.env.example`, `docker-compose.example.yml` (api `environment:` block, `${RBAC_ENABLED:-false}` passthrough pattern)
**Changes**: add `RBAC_ENABLED` — `unset (off)` default, `=true` gates `aswt_` user tokens at HTTP admission against their role grant; operator key and agents unaffected; link the design note. Mention `rbac bootstrap` in the runbook next to the flag.

### Success Criteria:

#### Automated Verification:
- [ ] New e2e passes: `bun test src/tests/rbac-admission-e2e.test.ts`
- [ ] CLI help renders: `bun run src/cli.tsx help` (lists `rbac`) and `bun run src/cli.tsx rbac --help`
- [ ] Full merge-gate mirror: `bun install --frozen-lockfile && bun run lint && bun run tsc:check && bun test && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:rbac-coverage`
- [ ] No OpenAPI drift expected (no route added/changed); confirm `git diff --exit-code openapi.json` after `bun run docs:openapi` if CI complains

#### Automated QA:
- [ ] Agent runs `bun run src/cli.tsx rbac bootstrap` twice against a live DB where one user was stripped of all roles (via `sqlite3 DELETE`): first run reports exactly 1 user backfilled, second reports 0; summary table lists `admin` and `requester` with correct counts

#### Manual Verification:
- [ ] Taras reviews the `rbac bootstrap` summary output format (operator-facing UX)
- [ ] Taras confirms the `rbac bootstrap` (vs `rbac:bootstrap`) naming deviation

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Appendix

- **Follow-up plans**: increment 4 (signed agent identity + `user_api_keys` with the intersection rule — must reconcile with existing `user_tokens`), increment 5 (admission contract on tools + `ROUTE_RBAC_BACKLOG` burn-down starting with skills/mcp-servers/scripts), increment 6 (resource ACLs). All framed in the design note §7.
- **Derail notes**:
  - `PUT /api/favorites` (inline `{ ungated }`, self-scoped) gets 403 for narrowed users under the fail-closed posture even though it's cross-principal-safe — a candidate for an `anyAuthenticated`-style verb (e.g. `favorite.write.own`) early in the increment-5 burn-down.
  - `DEPLOYMENT.md:431` references `docs/ENVS.md` which does not exist — dangling doc pointer noticed during research.
  - `permission_audit.originatorUserId` is still always null (`rbac-audit.ts:79-80`); admission rows populate `principalId` only, consistent with slice 1.
  - Grant lookup is per-request with no cache; if user-token traffic ever grows, add a small TTL cache keyed on userId with explicit invalidation in `attachRole`/`detachRole`.
- **References**:
  - Design note: `thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md`
  - Slice-1 plan: `thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md`
  - Research: `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`
  - Key code: `src/http/core.ts:244-260`, `src/http/route-def.ts:43,102`, `src/rbac/*`, `src/be/rbac-audit.ts`, `scripts/check-rbac-coverage.ts:219,373`

---

## Manual E2E

Real commands against a local backend (API key default `123123`; from LOCAL_TESTING.md + runbooks/local-development.md). Placeholders: `<USER_ID>`, `<TOKEN>`.

```bash
# 0. Fresh DB, flag ON (LOCAL_TESTING.md smoke-test preamble)
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
RBAC_ENABLED=true bun run start:http &
sleep 3

# 1. Migration + seeds applied
sqlite3 agent-swarm-db.sqlite "SELECT name, isBuiltin, grantsAll FROM roles ORDER BY name;"
# expect: admin|1|1  and  requester|1|0

# 2. Create a user and mint an aswt_ token (same sequence as rbac-wire-e2e.test.ts:107-113)
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"E2E User","email":"rbac-e2e@example.com"}' http://localhost:3013/api/users | jq -r '.user.id'
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{}' http://localhost:3013/api/users/<USER_ID>/mcp-tokens | jq -r '.plaintext'   # aswt_...

# 3. Default role attached by trigger
sqlite3 agent-swarm-db.sqlite "SELECT roleId FROM principal_roles WHERE principalId='<USER_ID>';"
# expect: rbac-role-admin

# 4. No-op leg: default (admin) user behaves exactly like today
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" -d '{"task":"rbac e2e no-op"}' http://localhost:3013/api/tasks
# expect: 201

# 5. Narrow the user to requester, then re-test
sqlite3 agent-swarm-db.sqlite "DELETE FROM principal_roles WHERE principalId='<USER_ID>';
INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user','<USER_ID>','rbac-role-requester');"
curl -s -w '\n%{http_code}\n' -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" -d '{"task":"should be blocked"}' http://localhost:3013/api/tasks
# expect: {"error":"Forbidden: ..."} and 403 (POST /api/tasks is backlogged — no verb)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <TOKEN>" http://localhost:3013/api/tasks
# expect: 200 (GET fallback)

# 6. Admission audit rows landed
sqlite3 agent-swarm-db.sqlite \
  "SELECT verb, decision, reason, resourceId FROM permission_audit WHERE resourceType='http-route' ORDER BY ts DESC LIMIT 5;"

# 7. Bootstrap CLI idempotence (strip the user fully first)
sqlite3 agent-swarm-db.sqlite "DELETE FROM principal_roles WHERE principalId='<USER_ID>';"
bun run src/cli.tsx rbac bootstrap    # expect: 1 user backfilled + summary table
bun run src/cli.tsx rbac bootstrap    # expect: 0 users backfilled

# 8. Flag OFF ⇒ today's behavior (kill server, restart without the flag)
kill $(lsof -ti :3013)
bun run start:http &
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" -d '{"task":"flag off"}' http://localhost:3013/api/tasks
# expect: 201 even though the user only holds requester — flag gates everything

# 9. Cleanup
kill $(lsof -ti :3013)
```

---

## Review Errata

_Reviewed: 2026-07-07 by Claude (desplega:reviewing, autopilot; adversarial codebase verification via sub-agent)_

### Important

- [ ] **Increment-3's real-world enforcement surface is small — confirm the scope is acceptable.** The templated `aswt_` population (Claude Code / Cursor / VS Code snippets from the mint-token dialog, `apps/ui/src/lib/mcp-client-snippets.ts:22-64`) all points at `/mcp-user`, which `handleCore` exempts from the auth block (`src/http/core.ts:245-249`) — those clients never pass admission until increment 5 (tool-level `rbac`). REST-with-`aswt_` is fully supported (`src/tests/user-token-rest-auth.test.ts`) but has no documented production client today; the dashboard sends whatever key the operator pasted (`apps/ui/src/api/client.ts:161-170`). So `RBAC_ENABLED=true` in increment 3 constrains ad-hoc REST callers and future clients — consistent with the design note's sequencing, but worth stating expectations explicitly.
- [ ] **`X-Source-Task-Id` user-attribution path is outside this gate — track for increment 4.** `resolveHttpAuditUserId` (`src/be/audit-user.ts:40-49`) falls back to the self-asserted `x-source-task-id` header: an operator/agent-authenticated request can *act as* a task's requesting user (row ownership on `PUT /api/favorites`, `src/http/favorites.ts:81`; audit attribution on schedules/workflows/pages/scripts). Not an admission hole under this increment's threat model (admission gates `aswt_` bearers; operator bypasses by design; agent identity is untrusted until increment 4's signed context) — but it means "acting as a user" ≠ "authenticated as a user", which increment 4/6 must reconcile.

### Resolved

- [x] **Flag-ON acceptance contradiction** — the Phase-3 helper pin (`RBAC_ENABLED:"false"` after the `process.env` spread, `rbac-e2e-helpers.ts:79-96`) would have silently neutralized `RBAC_ENABLED=true` for the wire suite, making that leg of the acceptance vacuous. Fixed: wire suite removed from the flag-ON acceptance list; wire-surface proof is `rbac-admission-e2e`'s no-op leg (explicit `opts.env`); consequence documented on the pin itself.
- [x] **Missing no-op witnesses** — `src/tests/user-token-rest-auth.test.ts` (POST /api/tasks with `aswt_` through real `handleCore`, expects 201) and `rbac-charact-http.test.ts:207-215` (POST fs write with `aswt_`) are the two existing suites that genuinely exercise the gate under flag ON; added to the acceptance command.
- [x] **Trigger-rebuild fragility** — first `CREATE TRIGGER` in the codebase; a future users-table rebuild (067-style dance) silently drops it. Fixed: migration header warning + `ensureRbacSeedsSynced` re-executes `CREATE TRIGGER IF NOT EXISTS` at boot + unit test for the self-heal.
- [x] **dep-graph expectation** — `cli.tsx → be/rbac-roles → be/db` triggers the `no-worker-reaches-db` **warn** rule (`.dependency-cruiser.cjs:27-34`), same as the existing `be/scripts/maintenance` precedent; CI unaffected. Noted in Phase 4.
- [x] **Coverage-check nuance** — `.sql` files are not scanned by `check:rbac-coverage` invariant 2 (`.ts`-only walk, `check-rbac-coverage.ts:139-146`); the `BUILTIN_ROLES` constant in `src/be/rbac-roles.ts` is what keeps seeded verbs "live". Noted in Phase 1.
- [x] Verified safe (no plan change needed): minimal `INSERT INTO users (id, name)` is valid (`name` is the only NOT-NULL-without-default column); `handleCore` is the single HTTP entry (no websocket/second-listener bypass; `resolveHttpRequestAuth` called only at `core.ts:251`); `GET /me` / `GET /cancelled-tasks` are principal-blind GETs, unchanged by the GET fallback.
