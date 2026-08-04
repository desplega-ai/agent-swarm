---
date: 2026-08-04T10:00:00+02:00
author: claude
topic: "Swarm Apps productionization: lifecycle, elements, global ctx, viewer RBAC, userConfig"
tags: [plan, swarm-apps, app-lifecycle, elements, rbac, user-config]
status: completed # all 8 phases implemented+reviewed+QA'd 2026-08-04 (commits ac419df9..f22342f4); final Manual E2E green incl. zero-shot worker finale (REST path — MCP-surface re-run optional); see Appendix "Final E2E notes"
branch: spike/swarm-apps
last_updated: 2026-08-04
last_updated_by: claude
---

# Swarm Apps Productionization — Lifecycle, Elements, Global Ctx, Viewer RBAC, userConfig

## Overview

Implement the five productionization slices on `spike/swarm-apps` (worktree `~/worktrees/agent-swarm/2026-08-03-swarm-apps`, API :3113, vite :5375, DB `/tmp/apps-spike-e2e.sqlite`): the frozen spike-5 lifecycle contract, reusable `elements`, the global UI ctx, viewer identity + per-app RBAC, and `userConfig`.

- **Motivation**: Spikes 1–5 validated the app contract; the shrink slice (connections removal, legacy `page` removal, provenance columns — commits 029e3629 + 51ef30d1) already shipped. This is the heavy remainder that turns the spike into the productionization base.
- **Related**: `thoughts/taras/brainstorms/2026-08-03-swarm-apps-next-iterations.md` (all decisions), `thoughts/taras/plans/2026-08-03-swarm-apps-spike5-lifecycle-spec.md` (frozen lifecycle contract — normative for Phases 1–3)

## Current State Analysis

Worktree HEAD `22f724cc` (clean apart from this plan file); shrink commits `029e3629` + `51ef30d1` are in. Highest migration: `124_apps_spike.sql`. None of the lifecycle files exist yet (`src/apps/{version,schema-migrate,format-upgrades}.ts`, `src/tools/app-{history,diff,rollback}.ts`, `src/tests/apps-spike5.test.ts` — all absent). Dev DB holds 8 apps; API live on :3113.

**Server (apps core):**
- `AppDefinitionSchema` (`src/apps/definition.ts:147-247`): `models` (required, count 1–10 at `:176-179`), `queries`, `actions` (max 20), `pages` (required), `defaultPage`. Column cap 1–40 (`:69-71`); `SYSTEM_COLUMN_KINDS` = id/createdAt/updatedAt/createdBy/updatedBy (`:94-100`). Legacy `page` is rejected fail-loud in `parseAppDefinition` (`:282-292`).
- Page element trees are `z.unknown()` at the Zod layer; real validation is imperative in `src/apps/page-validator.ts` (`ELEMENT_KEYS` `:31`, root-reachability `:850-865`, cycle rejection `:824-848`).
- Atomic merge-patch subtrees via `entriesAreAtomic` (`definition.ts:377-380`): `actions.<name>`, `models.<m>.columns.<c>`, `pages.<p>.elements.<id>`, `pages.<p>.params.<param>`. Patch guards at `:328-371`.
- `decodeApp` **throws** on parse failure (`src/apps/store.ts:23-32`) — the AMENDMENT-v2 brick class is still live. No `schemaVersion`, no format upgrades, no `app_versions`.
- Row store: actor reaches writes as a collapsed string `user:<id>` | `agent:<id>` | `operator` (`src/apps/row-store.ts:17-21`); `skipUpdatedAt` also suppresses `updatedBy` (`:272-280`); per-(app,model) async mutex `withMutationLock` (`:131-143`); purge-lock recursion precedent (`:337-355`); idx keys diffed on patch (`:271,288-294`).
- HTTP (`src/http/apps.ts`): mutating routes carry `rbac: { permission: "app.manage" }`; **all GETs undeclared/ungated** (list/get/rows/named-query). `authorizeAppWrite` (`:287-315`) builds the principal, calls `can()` with `resource: {kind:"none"}`, returns the actor string. Script actions run with the script owner's bindings — spike tradeoff flagged inline (`:830-831`). PUT/PATCH handlers still say "schema updates do not migrate rows" (`:898`, `:930`).
- MCP tools: `app-upsert`, `app-patch` (no `migration` field yet), `app-get` + `app-query`, `app-list`; SDK map entries at `src/scripts-runtime/sdk-allowlist.ts:144-148`.
- Precedents: `snapshotWorkflow` (`src/workflows/version.ts:13-44`, table in `008_workflow_redesign.sql:74-82`); diff-spawn `computeDiff` (`src/tools/context-diff.ts:9-38`).

**RBAC / identity:**
- Verbs are a const map (`src/rbac/permissions.ts:19-240`); `app.manage` at `:204-207` → `anyAuthenticated` (`src/rbac/legacy-policy.ts:192`). `RbacResource` is a typed discriminated union (`src/rbac/types.ts:20-34`) — adding per-app scoping means a new union member. `LEGACY_POLICY` is compile-time exhaustive (`legacy-policy.ts:201`). Resource-scoped `can()` precedent: `src/http/kv.ts:344-358`.
- `HttpRequestAuth` = operator (fingerprint) | user (userId) (`src/utils/request-auth-context.ts:5-7`), produced by `resolveHttpRequestAuth` (`src/http/auth.ts:13-32`); `aswt_` tokens have full mint/revoke (`src/be/users.ts:455-535`) **including dashboard UI** (People page, `apps/ui/src/pages/people/[id]/mint-token-dialog.tsx`).
- Favorites actor-scoping precedent: `resolveHttpFavoriteOwner` (`src/http/favorite-owner.ts:18-39`) → `scope: "user:<id>" | "operator"` decoupled from audit `actorId`; SQL table with `UNIQUE(favoriteScope, itemType, itemId)` (`116_favorite_principal_scope.sql`).
- `check:rbac-coverage` **skips GET routes** (`scripts/check-rbac-coverage.ts:356`) — gating GETs is additive and won't be regression-checked by CI; the plan compensates with tests.

**UI runtime (`apps/ui/src/pages/apps/[id]/page.tsx`):**
- One `createStateStore` per mounted app, keyed only by React `key={app.id}` (`page.tsx:435-441`, `:902`); the store factory has no namespace concept — isolation is purely the remount.
- Unprefixed paths everywhere: `/route` (`:438,491`), `/queries/<q>` mirror from react-query (`:504-539`), `/actions/<a>` + task polling (`:296-359,601-647`), `/forms/<id>/<f>` + `/ui/<id>/{value,tab}` written directly by 6 components via `useStateStore()` (`components.tsx:408,470,534,747,984,1132`).
- Renderer dispatch is `registry[element.type]` with children resolved as `spec.elements[childKey]` lookups (`@json-render/react` `index.mjs:967-971,985-1007`); components never see `spec` — **a render-time element-ref is not expressible without forking the library**. Repeat via `RepeatChildren` (`index.mjs:1022-1070`).
- React-query cache keys already namespace by appId (`use-apps.ts`) — only json-render store paths are unprefixed.
- Dashboard calls `/api/apps/*` with the shared connection API key (`client.ts:197-206,2748-2768`; `lib/config.ts:159-165`) — no `aswt_` flow wired into the apps UI.
- No per-user/settings surface in the apps area (only `AppHeaderActions`, `page.tsx:822-878`).

**Tests:** `apps-spike{,2,4}.test.ts` hand-roll a `node:http` server around `handleApps` with a dedicated on-disk sqlite per file — reuse that boilerplate pattern.

## Desired End State

1. Every definition-mutating write snapshots to `app_versions` first (fail-closed); `decodeApp` never throws (format upgrades + `definitionError`); rollback = forward-migrate; agents drive it via `app-history`/`app-diff`/`app-rollback`.
2. Schema evolution is backward-compat by default: hide-don't-delete columns, dry-run classification with row counts, explicit `migration` directives for lossy ops, migration report with `orphanFields`.
3. Apps declare reusable `elements` **inside the definition JSON** (top-level field — no new DB column): pure (typed props + `ElementSlot`) and bound (defining app's queries/actions), private-by-default with `export` opt-in; cross-app refs float, gated by the same compat classifier (with the `forceElementBreak` escape hatch).
4. The UI ctx is **dashboard-global**: a store registry mounts each app at `/apps/<appId>/…`, definitions keep app-relative paths, the app renderer is an embeddable `<AppSurface>` decoupled from the `/apps/[id]` route so apps/elements can render anywhere in the dashboard. Data plane is keyed by defining app at the fetch layer (react-query, single fetch/shared liveness) and mirrored per-consumer at `/refs/<definingAppId>/…` in the store; interaction state keys per instance.
5. Per-app RBAC exists **as plumbing**: verb `app.use` scoped to `{kind:"app", appId}` reaches `can()` on rendering/queries/rows/actions; `app.manage` shrinks to definition lifecycle; the viewer's actor threads into provenance and action invocation. NOTE (review I9): with `app.use` → `anyAuthenticated` and the dashboard on the operator key, "embedding never launders privileges" is *structurally prepared, not enforced* — enforcement lands when a real per-app policy + dashboard user-token adoption follow up.
6. Apps declare a `userConfig` schema in the definition; per-(app,user) values live outside it (survive rollback), surface read-only at `/apps/<id>/user/<field>`, and are editable via a settings surface.
7. Pure-UI apps are legal: models lower bound relaxed to 0.

Verify: all phases green under the commands in each phase + the final Manual E2E against the running :3113 stack.

## What We're NOT Doing

- Re-planning the shipped shrink slice (connections/sync removal, legacy `page` removal, `createdBy`/`updatedBy` provenance).
- Connections/sync layer (later iteration; `{connection, entity}` transition becomes a future format upgrade).
- Migration renumbering / port to a fresh branch off main (happens at port time, after validation).
- Spike-5 "out of scope" items: dashboard history/diff/rollback UI, version pruning, row-level history, in-place column rename, cross-model moves, computed backfills, multi-instance locking.
- Spec's format upgrade #2 (`connector: "github-issues"` → script) — **moot post-shrink**; replaced by a defensive strip-`sources`/strip-`page` upgrade (deviation from the frozen spec, flagged).
- Dashboard-wide `aswt_` login/session UX — the People-page mint flow exists; adopting user tokens as the dashboard's default credential is a follow-up. Operator-key sessions degrade to the shared `operator` scope (favorites precedent).
- A dedicated "app needs repair" dashboard state (generic error card only — spec's productization flag).
- New UI unit-test infra / qa-use YAML (per Taras's standing preference; Automated QA uses agent-browser against :5375).

## Implementation Approach

Locked directives (Taras, 2026-08-04):
- **`elements` is a top-level field inside the definition JSON** — NOT a new DB column/table. It rides the `definition` column, so `app_versions` snapshots, merge-patch atomicity, and the compat classifier cover it with zero extra storage plumbing.
- **The global UI ctx is dashboard-global, not apps-page-local**: store registry + renderer hoisted above the route tree; apps and exported elements can later mount anywhere in the dashboard.

Decisions made in this plan (autopilot; flag if wrong — revised after the 2026-08-04 review, `thoughts/taras/reviews/2026-08-04-swarm-apps-productionization-review.md`):
- **ElementRef resolved by spec assembly, not a renderer fork**: a new validated node type `ElementRef` is expanded client-side before `<Renderer>` — clone the target element subtree, namespace its node ids and interaction ids per instance, rewrite bound data refs to the **consumer-local mirror root** `/refs/<definingAppId>/…` (see next bullet), splice consumer children into the `ElementSlot`. `@json-render` stays stock. *(Reviewed fallback if the mirror design fights the renderer: register `ElementRef` as a real component that nests `<StateProvider store={viewOf(definingApp)}><Renderer spec={sub}/></StateProvider>` — `Renderer`'s `spec` is a plain prop and providers nest, so this is also stock-library.)*
- **Global store + prefixing `StoreView`, NO absolute escape**: one module-level global `StateStore`; each mounted app gets a view that prefixes **every** path with `/apps/<appId>`. Review C1: `$state`/`$bindState` resolve via `getByPath(stateModel, path)` against the view's *subtree snapshot* (`@json-render/core` `index.mjs:272-292`, react `index.mjs:79-83`) — an absolute path can never resolve declaratively, so the earlier escape design was unsound. Instead, bound-element data flows stay at the fetch layer: react-query is already appId-keyed (single fetch, shared liveness); the query mirror ALSO writes the defining app's slots into each consuming app's subtree at `/refs/<definingAppId>/queries/<q>` (cheap per-consumer duplication of the store mirror only). `StoreView` implements the **full** `StateStore` contract incl. `update` (`store-utils-D98Czbil.d.ts:400-421`), with a **cached snapshot** — seed `/apps/<id> = {}` at mount so `useSyncExternalStore` never sees a fresh object per call. `immutableSetByPath` clones only along the changed path, so sibling app subtrees keep referential identity and unrelated apps skip re-renders. Definitions stay app-relative → no format upgrade needed, elements stay portable.
- **Instance scoping fixes the reuse collision class**: interaction ids inside an expanded element instance are rewritten to `instances/<instanceKey>/<origId>`. Two raw same-id inputs hand-authored in one page still share state (documented, unchanged). Deliberate deviation from the brainstorm's `/pages/<p>/instances/…` shape: no `pages/<p>` segment, so the same instanceKey on two pages of one app shares interaction state — consistent with the ctx's cross-page-warm property.
- **Unknown top-level definition keys are rejected fail-loud** (review I10): `AppDefinitionSchema` is non-strict, so a typo'd `element:`/`userconfig:` key would 200 and silently vanish — the worst agent-facing failure mode, now applying to the headline features. `parseAppDefinition` gains an explicit unknown-top-level-key issue (Phase 1).
- **Verb split**: `app.use` (render, queries, row CRUD, action invoke — scoped `{kind:"app", appId}`) vs `app.manage` (create/update/patch/delete/rollback of the app itself). Legacy policy maps `app.use` → `anyAuthenticated` (behavioral no-op today, real plumbing for later lockdown).
- **userConfig values**: new SQL table `app_user_config` `UNIQUE(appId, scope)` (favorites shape), tolerant read (unknown fields dropped, nonconforming values → default). Schema changes to `userConfig` never block writes — reported, not gated (per-user prefs; defaults are an acceptable fallback). Rollback restores the schema, never touches values.
- **Sequencing**: lifecycle first (Phases 1–3, everything after is born versionable), then elements server-side (4), then the UI refactor in two steps — parity refactor (5) before new rendering behavior (6) — then RBAC (7), then userConfig (8, uses 5's ctx and 7's scoping).
- Standing mandate for all delegated runs (spec §Slices): isolated `DATABASE_PATH` + `BUN_OPTIONS=--no-env-file` — three dev-DB pollution incidents.
- Commit-per-phase: yes — `[phase N] <description>` after manual confirmation.

## Quick Verification Reference

All from the worktree root `~/worktrees/agent-swarm/2026-08-03-swarm-apps`:

```bash
bun run lint && bun run tsc:check
bun run test:root -- src/tests/<file>.test.ts        # one file
bash scripts/check-db-boundary.sh
bun run check:rbac-coverage && bun run docs:openapi
bun run check:skill-sources
bun run scripts/check-sdk-tool-registration.ts
# UI: cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b
```

API restart on new code (spec env mandate):
```bash
kill $(lsof -t -iTCP:3113 -sTCP:LISTEN); nohup env DATABASE_PATH=/tmp/apps-spike-e2e.sqlite PORT=3113 \
  MCP_BASE_URL=http://localhost:3113 SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true \
  LINEAR_DISABLE=true bun --expose-gc src/http.ts >> /tmp/apps-api.log 2>&1 &
```

MCP tool calls against :3113: LOCAL_TESTING.md:108-133 curl session recipe (`X-Agent-ID` must be a valid UUID; pin `43172bc2-3887-402b-a111-be451a083e3a` for E2E tasks).

---

## Phase 1: app_versions + fail-closed snapshots + tolerant decodeApp

### Overview

Every definition-mutating write snapshots first and can never be bricked by an unparseable stored definition: `app_versions` table, `snapshotApp()`, the `schemaVersion` format-upgrade registry, tolerant `decodeApp` with `definitionError`, and the version-listing routes.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/125_app_versions.sql`
**Changes**: Exactly the spec §1 DDL (`UNIQUE(appId, version)`, snapshot TEXT, `changedByAgentId`, no version col on `apps`).

#### 2. Snapshot engine
**File**: `src/apps/version.ts` (new)
**Changes**: `snapshotApp(appId, changedByAgentId?)` mirroring `src/workflows/version.ts:13-44`; snapshot = `{name, description, definition}` with definition captured **as stored raw JSON** (even if unparseable). DB accessors follow the `workflow_versions` pattern in `src/be/db.ts:9463-9502`. Called before PUT/PATCH (and later rollback); **fail-closed** — snapshot failure aborts the write. POST create does not snapshot.

#### 3. Format upgrades + tolerant decode
**Files**: `src/apps/format-upgrades.ts` (new), `src/apps/store.ts`, `src/apps/definition.ts`
**Changes**: ordered registry `[{from, to, upgrade(raw)}]` applied stepwise on raw stored JSON before Zod; `schemaVersion` is server-managed (stripped from incoming writes at `parseAppDefinition`/patch guards, stamped CURRENT on every store, read-only in responses; absent ⇒ 0). Ship **upgrade #1 (0→1): CONVERT legacy `page` → `pages.main` + `defaultPage: "main"`** (per spec §4 — stripping would brick legacy-only apps since `pages` is required, review C2), **and strip `models.*.sources` / column `source` bindings**. Both halves are purely defensive: no live app in the dev DB carries `page` or `sources` (hand-migrated in the shrink), and the non-strict schema already drops `sources` at parse — upgrade #1 exists to prove the registry class, not to rescue live rows. `decodeApp` becomes: raw → upgrade chain → `safeParse` → on failure return app with `definitionError: issues[]` + raw definition instead of throwing (`store.ts:23-32`). GET 200s with `definitionError` surfaced; named queries/actions against a broken app → 409 `definition needs repair`; PUT (full replace) works against a broken app.
Also in `parseAppDefinition` (review I10): reject **unknown top-level definition keys** with an explicit issue (`unknown top-level key "<k>" — did you mean …`) — the non-strict schema otherwise 200s and silently discards agent typos like `element:`; keep non-strict behavior below top level.

#### 4. Routes
**File**: `src/http/apps.ts` (+ `openapi.json` regen)
**Changes**: `GET /api/apps/{id}/versions`, `GET /api/apps/{id}/versions/{version}` via `route()` — registered **before** the `{id}` wildcard (workflows route-order gotcha). Reading a snapshot applies format upgrades. Wire `snapshotApp` into PUT/PATCH handlers; snapshot's `changedByAgentId` from the caller's agent id when present.

#### 5. Tests
**File**: `src/tests/apps-spike5.test.ts` (new; hand-rolled `handleApps` server per existing pattern, isolated sqlite)
**Changes**: snapshot on PUT/PATCH; fail-closed snapshot (inject failure → write aborted); snapshot captures raw JSON for unparseable defs; format upgrade #1 (sqlite-insert legacy `page` + `sources` shapes → GET 200 with `pages.main` + `defaultPage` → next write persists stamped); unparseable → `definitionError` + PUT still works; `schemaVersion` stripped from input / stamped on store; unknown top-level key → fail-loud issue; versions routes incl. route-order.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/apps-spike5.test.ts`
- [x] No regressions: `bun run test:root -- src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts`
- [x] `bun run lint && bun run tsc:check`
- [x] `bash scripts/check-db-boundary.sh`
- [x] Routes in spec: `bun run docs:openapi` and `git diff --stat openapi.json` shows the two versions routes

#### Automated QA:
- [x] Restart API (Quick Reference recipe); migration 125 applies clean on `/tmp/apps-spike-e2e.sqlite`; all 8 live apps `GET 200`: `curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/apps | jq '.apps | length'` → 8
- [x] PATCH Notes Mini (`bae5343b-119b-47e4-915f-ba3ced9073f1`) description → `GET /api/apps/bae5343b-119b-47e4-915f-ba3ced9073f1/versions` shows version 1; `sqlite3 /tmp/apps-spike-e2e.sqlite "SELECT version FROM app_versions"` confirms
- [x] sqlite-insert a scratch app with legacy `page` shape into an **isolated** DB copy → GET 200 with `pages.main`; one PATCH → stored JSON stamped + upgraded (sqlite check)

#### Manual Verification:
- [x] Skim `/tmp/apps-api.log` for snapshot/decode noise on normal traffic (QA agent + orchestrator: only pre-existing sqlite-vec/business-use noise; delegated by Taras 2026-08-04)

**Implementation Note**: After this phase, pause for manual confirmation, then commit `[phase 1] app_versions + tolerant decodeApp`.

---

## Phase 2: Schema-change engine (hidden columns, migration directives, dry-run)

### Overview

Definition writes against row-holding models run the spec §3 engine: dry-run classify → fail-loud with counts or apply under the model mutex — hide-don't-delete, `migration` directive vocabulary, purge, auto-backfill, idx rebuild, migration report with `orphanFields`.

### Changes Required:

#### 1. Engine
**File**: `src/apps/schema-migrate.ts` (new)
**Changes**: spec §3 pipeline per write: merge/validate → diff old vs new models → dry-run scan under `withMutationLock(appId, model)` per affected model (sequential, purge-lock precedent `row-store.ts:337-355`) → destructive-without-directive ⇒ 400/toolErr with path+count-bearing issues, nothing written → else snapshot → write pass (rows + idx, `skipUpdatedAt: true`, actor undefined so `updatedBy` untouched per `row-store.ts:272-280`) → definition write. Directive vocabulary `set` / `{from, map, else}` / `{coerce, else}` / `{purge}` validated against the merged definition; built-in coercions per spec §3b; required+default auto-backfill; report `{scanned, backfilled, coerced, mapped, elsed, purgedValues, idxRebuilt, orphanFields}`.
**Unparseable old side** (review I6 — PUT/rollback must work against a `definitionError` app): when the stored definition doesn't parse, the engine treats old models as **empty** — no destructive classification is possible (nothing to diff), every incoming column is an add; the dry-run still scans existing rows, so undeclared fields surface as `orphanFields` and `required`-without-`default` adds still fail-loud against rows. Rows are never touched implicitly on this path (preserve+report).

#### 2. Hidden columns
**Files**: `src/apps/definition.ts`, `src/apps/page-validator.ts`, `src/apps/row-store.ts`
**Changes**: `ColumnDefSchema` gains `hidden?: boolean`. Hidden = validator-invisible for queries/filters/sorts/page bindings/row writes (same treatment as nonexistent — agents co-migrate via issues[]); name reuse blocked ("name held by hidden column — unhide or purge"); still counts toward the 40-col cap; `required` ignored while hidden; idx entries stop being maintained + lazily dropped. Hard delete (`columns.<c> = null`) allowed iff zero rows carry values or `{purge: true}`.

#### 3. Write-surface plumbing
**Files**: `src/http/apps.ts`, `src/tools/app-patch.ts`, `src/tools/app-upsert.ts`
**Changes**: PUT + PATCH (HTTP) and `app-patch`/`app-upsert` (MCP) accept optional `migration`; engine runs on the definition diff regardless of surface; migration report on the HTTP response and toolOk `details`/`data`; delete the two "spike limitation" comments (`apps.ts:898,930`).

#### 4. Tests
**File**: `src/tests/apps-spike5.test.ts` (extend)
**Changes**: spec's coverage floor for this tier — hide/unhide metadata-only (rows byte-identical); name-reuse block; hard-delete zero-rows vs count-bearing issue vs purge (rows + idx verified); kind-change dry-run counts + coerce-with-else; enum-narrow map-from-self; required+default auto-backfill; skipUpdatedAt on all migration writes (updatedAt AND updatedBy unchanged); orphan-field reporting; migration-vs-concurrent-row-create serialization under the mutex (barrier-gated, spike-3 precedent).

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/apps-spike5.test.ts`
- [x] Full suite: `bun run test:root -- src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts`
- [x] `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh`
- [x] `bun run docs:openapi` + commit — the `migration` request field and migration-report response are OpenAPI-visible (review I7)

#### Automated QA (against :3113, Spike3 Scratch PM `12218dfe-8d17-458a-9e48-75881f682030`, 19 rows):
- [x] `columns.note = null` PATCH → 400 with row count; `note.hidden = true` → 200 and `sqlite3`/KV shows rows untouched; add new column `note` → 400 name-held; `migration {note:{purge:true}}` + `columns.note = null` → field gone from all rows, idx clean (one-shot form initially 400'd — guard-ordering bug, fixed in review round + regression test)
- [x] Patch a string column to `kind: number` on mixed values → 400 with per-value counts; retry with `{coerce: true, else: null}` → 200, report shows coerced/elsed, idx rebuilt
- [x] Add a required column with a default → auto-backfill visible on existing rows without a directive

#### Manual Verification:
- [x] Read one 400 issue payload end-to-end — is it actually actionable for an agent (paths, counts, suggested escape hatch)? (QA proxy + orchestrator: payload carries path, per-value counts, concrete escape hatches; hidden-guard message made honest in review round; delegated by Taras 2026-08-04)

**Implementation Note**: Pause, confirm, commit `[phase 2] schema-change engine`.

---

## Phase 3: Rollback + app-history/app-diff/app-rollback tools + skill

### Overview

Rollback-as-forward-migrate lands with its agent surface: `POST /api/apps/{id}/rollback`, the three MCP tools, and the seeded `apps` skill teaching the backward-compat model.

### Changes Required:

#### 1. Rollback
**Files**: `src/apps/version.ts`, `src/http/apps.ts`
**Changes**: `POST /api/apps/{id}/rollback` body `{version, migration?}` (`rbac: { permission: "app.manage" }`): snapshot current (rollback is undoable) → treat target snapshot's definition (upgrade-chain applied) as the incoming definition of a normal update → full Phase-2 engine. Lossy restore → 400 with the exact `migration` entries needed. Works against a `definitionError` app.

#### 2. MCP tools
**Files**: `src/tools/app-history.ts`, `src/tools/app-diff.ts`, `src/tools/app-rollback.ts` (new), `src/tools/index.ts`/registrar wiring, `src/scripts-runtime/sdk-allowlist.ts`
**Changes**: per spec §2 — `app-history {appId, limit?}` (table of version/createdAt/changedByAgentId + head, one-line digest per version); `app-diff {appId, from?, to?}` (`from` defaults to the newest snapshot, `to` defaults CURRENT — spec §2; unified diff of pretty-printed JSON via the `computeDiff` precedent `src/tools/context-diff.ts:9-38`); `app-rollback {appId, version, migration?}`. All `toolOk`/`toolErr`, loose output schemas, `can()` `app.manage` gates. `SDK_TOOL_NAME_MAP` entries `app_history`/`app_diff`/`app_rollback`. Run `bun run build:script-types` if the generated `.d.ts` changes.

#### 3. Seeded skill
**File**: `templates/skills/apps/content.md`
**Changes**: spec §5 — hide-over-delete model, hidden-column semantics + name-reuse rule, `migration` vocabulary with the flag→priority+status worked example, fail-loud counts, history/diff/rollback usage, migration report + orphanFields, server-managed `schemaVersion`.

#### 4. Tests
**File**: `src/tests/apps-spike5.test.ts` (extend)
**Changes**: rollback lossless (unhide path) + rollback-needs-directive; new snapshot exists for pre-rollback state; rollback on `definitionError` app; tool-level round-trips for history/diff/rollback (registrar pattern from `apps-spike4.test.ts` "app MCP iteration tools").

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/apps-spike5.test.ts` (full lifecycle floor green)
- [x] `bun run lint && bun run tsc:check`
- [x] `bun run check:rbac-coverage` (rollback route declared)
- [x] `bun run docs:openapi` — rollback route present; commit regenerated spec
- [x] `bun run check:skill-sources`
- [x] `bun run scripts/check-sdk-tool-registration.ts`

#### Automated QA (MCP curl session per LOCAL_TESTING.md:108-133, agent `43172bc2-3887-402b-a111-be451a083e3a`):
- [x] `app-history` on Spike3 Scratch PM lists the Phase-2 QA writes; `app-diff` v1..CURRENT shows the hidden/purged column churn
- [x] `app-rollback` Spike3 Scratch PM to v1 → definition restored (hidden column visible again), 19 rows intact, a NEW snapshot exists for the pre-rollback state; `app-diff` v1..CURRENT ≈ empty (QA note: v1's own snapshot is structurally invalid — pre-existing seed defect — so the flow was exercised against v2; that discovery produced the distinct broken-snapshot error class + test in the review round)

#### Manual Verification:
- [x] Run the spec's zero-shot finale (flag → priority/status restructure + rollback, spec §Finale) as a worker task and judge the agent's path quality (ran as the final Manual E2E step 2 — PASSED both directions, zero data loss; see Appendix "Final E2E notes"; Taras delegated manual QA 2026-08-04)

**Implementation Note**: Pause, confirm, commit `[phase 3] rollback + history/diff tools + skill`. Phases 1–3 = the complete frozen spec; re-read the spec top-to-bottom before committing and log any deviation in the Appendix.

---

## Phase 4: `elements` definition surface (server)

### Overview

The definition grows a top-level `elements` field (inside the definition JSON — no storage change): pure and bound modes, export opt-in, `ElementRef` node validation incl. cross-app refs with the compat gate, patch atomicity, and the 0-model relaxation for pure-UI apps.

### Changes Required:

#### 1. Schema
**File**: `src/apps/definition.ts`
**Changes**:
```ts
elements?: Record<AppName, {
  mode: "pure" | "bound";
  export?: boolean;                     // private by default
  props?: Record<AppName, { kind: ColumnKind; required?: boolean; default?: string|number|boolean }>;
  root: string;
  elements: Record<string, unknown>;    // same node vocabulary as pages
}>
```
Caps: ≤ 20 elements per app, element subtree node budget same as pages. Relax the models lower bound `1 → 0` (`definition.ts:176-179`) — a 0-model app must still have valid `pages` (pure-UI apps); queries/actions referencing models keep existing validation. Atomicity (`entriesAreAtomic`, `definition.ts:377-380`): add `elements.<name>` and `elements.<name>.elements.<id>`.

#### 2. Catalog (review C3 — the server validator rejects unknown component types)
**Files**: `apps/ui/src/lib/json-render/catalog.ts`, `src/apps/catalog.generated.json` (regenerated)
**Changes**: `page-validator.ts:674-678` rejects any `type` not in the catalog, and the server catalog is **generated from the UI catalog** (`cd apps/ui && bun run generate:catalog-schema`, output committed). Register the two new node types there: `ElementRef` (props: `app?`, `element`, `props?`, `instanceKey?`; has a children slot) and `ElementSlot` (leaf; marks the pure-element children insertion point — named to stay clearly apart from the catalog's existing `slots` mechanism on Stack/Grid/Split/Tabs/Container/Card/Drawer, which is a different concept and stays untouched). Regen + commit the generated JSON. Add a drift guard to this phase's verification (there is no CI check for catalog regen today).

#### 3. Validation
**File**: `src/apps/page-validator.ts` (+ `parseAppDefinition` in `definition.ts`)
**Changes**: validate each element subtree with the existing page machinery (root-reachability, cycles, catalog props). Mode rules — **pure**: `$state` bindings restricted to `/props/<declared>` (+ `$item`/`$index` in repeats); at most one `ElementSlot` node; no `app.action`/`app.mutate`/query refs. **bound**: may bind the defining app's `/queries/<q>` and invoke its `actions`/models (all must exist; hidden-column rules apply); props allowed too. `ElementRef` valid in pages AND inside elements (no self/cycle refs — reject recursive expansion at validation time, depth cap 5). Same-app refs: element must exist. Cross-app refs: target app exists + element is `export: true` + prop values type-check against the target's declared props (children only allowed if target has an `ElementSlot`).
**Cross-app compat gate** (in `schema-migrate.ts` classifier), with the review-I4 failure modes closed:
- On a definition write to app A, scan other apps' definitions for `ElementRef`s targeting A; removing/unexporting/mode-changing an exported element, or removing a declared prop, that is referenced ⇒ issue listing the referencing apps (breaking change ⇒ new element name, per brainstorm). Additive changes pass.
- **Unparseable consumers**: apps whose stored definition doesn't parse are scanned as raw JSON (grep-level `"element"` / target-app-id match); if raw-scan is inconclusive, the gate reports `"N apps unscannable"` as part of the issue rather than silently passing a breaking change.
- **Escape hatch**: write surfaces (PUT/PATCH/`app-patch`/rollback) accept `forceElementBreak?: string[]` (element names) — consumers of a listed element are accepted as broken (they render the Phase-6 error card). This is the abandoned-consumer answer.
- **Rollback trips the gate too** (rollback = forward-migrate): rolling A back across an exported-element addition that B references ⇒ same issue, same `forceElementBreak` hatch.
- **`DELETE /api/apps/{id}` stays ungated** by the compat gate — consumers of a deleted app degrade to the error card (float-model asymmetry, stated here deliberately).
- Cost note (productization flag, Appendix): full-JSON scan of every app per definition write, no reverse index.

#### 4. Tools/docs
**Files**: `src/tools/app-upsert.ts`/`app-patch.ts` (descriptions + `forceElementBreak` input), `templates/skills/apps/content.md`
**Changes**: document `elements`, modes, export, `ElementRef`, `ElementSlot`, the compat gate + `forceElementBreak`, and 0-model pure-UI apps in the tool descriptions + seeded skill.

#### 5. Tests
**File**: `src/tests/apps-elements.test.ts` (new)
**Changes**: schema + mode validation (pure binding escape rejected, bound query ref to missing query rejected); `ElementSlot` rules; `ElementRef` same-app/cross-app/unexported/missing/prop-type/cycle/depth cases; patch atomicity of `elements.<name>` and inner nodes; snapshot coverage (elements ride `app_versions`, rollback restores them); compat gate (breaking exported element referenced by app B ⇒ issue naming B; `forceElementBreak` bypass; unparseable consumer reported; unreferenced private element churns freely); 0-model app round-trip.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/apps-elements.test.ts` (17 tests post-review-round)
- [x] Lifecycle + prior suites: `bun run test:root -- src/tests/apps-spike5.test.ts src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts`
- [x] `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh`
- [x] `bun run check:skill-sources`
- [x] Catalog drift guard: `cd apps/ui && bun run generate:catalog-schema && git diff --exit-code ../../src/apps/catalog.generated.json` (pre-commit form: regen byte-stable across runs, sha `9374a393…`)
- [x] UI package still builds: `cd apps/ui && bun run lint && bunx tsc -b` (catalog.ts changed; APP_SEED.json pre-existing lint failure fixed in 167f5944)

#### Automated QA (against :3113):
- [x] Via MCP `app-patch`: add an exported pure element (e.g. a stat card) to Notes Mini (`bae5343b…`); add a private bound element (query-backed list); `app-get` shows both; version history gained a snapshot (names: `noteStatCard` / `recentNotes` — element names share AppNameSchema, hyphens invalid)
- [x] Create fixture app **"Element Consumer"** (id `78eef421-f91a-44d8-a594-daad27c47cd0` — reused by Phase 6/8 QA and Manual E2E); `app-patch` an `ElementRef` to the exported element → accepted; to the private one → rejected with the export issue
- [x] Attempt to delete the referenced exported element from Notes Mini → 400 issue naming Element Consumer; retry with `forceElementBreak: ["<name>"]` on a **DB copy** → accepted (don't break the live fixture)
- [x] Create a 0-model pure-UI app (pages + pure elements only) → accepted; `GET` 200 ("Phase4 Zero Model" `ad83fefa-b733-427b-8e09-51b5ac5ffac8`)

#### Manual Verification:
- [x] Review the element validation issue texts for agent-actionability (QA + both review axes assessed messages; `$self` leak fixed in review round; delegated by Taras 2026-08-04)

**Implementation Note**: Pause, confirm, commit `[phase 4] elements definition surface`. UI does not render `ElementRef` yet — that's Phase 6; an `ElementRef` in a live page renders as the renderer's fallback (acceptable mid-stack, don't add refs to live apps' default pages until Phase 6).

---

## Phase 5: Global UI ctx — store registry + embeddable AppSurface (parity refactor)

### Overview

One dashboard-global state store with per-app mounts (`/apps/<appId>/…`), definitions keep app-relative paths via a prefixing `StoreView`, and the runtime becomes an embeddable `<AppSurface>` decoupled from the `/apps/[id]` route. No new rendering *features*, but three deliberate behavior changes ride along (review M5): cross-app-warm state, a store that survives unmount (no eviction), and shared `/route` between two surfaces of the same app.

### Changes Required:

#### 1. Store registry
**File**: `apps/ui/src/lib/json-render/store-registry.ts` (new)
**Changes**: module-level global `createStateStore({})` + `getAppStoreView(appId)` returning a cached `StoreView` implementing the **full** `StateStore` contract — `get`/`set`/`update`/`getSnapshot`/`subscribe` (`update` is required by the type, review I2) — prefixing **every** path with `/apps/<appId>` (no absolute escape — review C1; Phase 6 uses the `/refs` mirror instead). `getSnapshot()` presents the app's subtree as root for `$state` resolution (definitions stay unprefixed; verify against how `StateProvider` consumes the store, `page.tsx:740-744`) and MUST return a **cached/stable** object: seed `/apps/<appId> = {}` at view creation so the subtree always exists — a computed-per-call fallback `{}` trips React's "getSnapshot should be cached" infinite-loop guard. `immutableSetByPath` clones only along the changed path, so sibling app subtrees keep referential identity (unrelated apps skip re-renders — state this in a code comment).

#### 2. AppSurface extraction
**Files**: `apps/ui/src/components/apps/app-surface.tsx` (new, extracted from `apps/ui/src/pages/apps/[id]/page.tsx`), `page.tsx` (becomes a thin route wrapper)
**Changes**: move `AppRuntime` + `RuntimeCtx`/`ctxRef` (`page.tsx:122-132,459-476`), the query mirror (`:504-539`), action handlers (`:554-647`), `pollActionTask` (`:296-359`), and the provider triple (`:740-744`) into `AppSurface({app, mode, pageName, navigate})`. Replace `storeRef`/`createStateStore` (`:435-441`) with `getAppStoreView(app.id)`. **First-paint route seed** (review I3): the old constructor seeded `{route}` so deep-linked route-driven UI (Drawer via route param, `visible` conditions) renders on first paint; with a shared store, seed `/apps/<id>/route` synchronously at view acquisition keyed by a route **signature** — reseed only when the signature differs, so a warm re-entry with a *different* route doesn't render stale route state (shipped behavior; see Appendix Phase-5 note (b)). The `/route` mirror (`:488-492`) writes through the view — per-mount, so two concurrent surfaces of different apps can't race; two surfaces of the *same* app share route state (accepted; note in code). Keep `key={app.id}` remount on the route page for poll disposal (`pollRef`); the store itself survives unmount — cross-app-warm by design (brainstorm). Components (`apps/ui/src/lib/json-render/components.tsx`) stay untouched, and `catalog.ts` is untouched **beyond Phase 4's `ElementRef`/`ElementSlot` additions** — components keep writing app-relative paths through the view they get from context.

#### 3. Embeddability proof (locked directive, review M4)
**File**: `apps/ui/src/app/router.tsx` + a small dev-only page
**Changes**: add a dev-only route (e.g. `/dev/embed-test`) that mounts an `<AppSurface>` for a hardcoded/query-param app id on a non-apps page — proves the "mountable anywhere in the dashboard" directive this iteration instead of trusting it untested.

#### 4. Devtool sanity surface
**File**: `apps/ui/src/components/apps/app-surface.tsx`
**Changes**: dev-only `window.__swarmAppsStore` handle exposing the global store snapshot (makes the QA checks below scriptable via agent-browser console).

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [x] Root suites still green: `bun run test:root -- src/tests/apps-spike4.test.ts` (server untouched — sanity)

#### Automated QA (agent-browser against http://localhost:5375):
- [x] Parity walkthrough on PM Inbox (`6f93f0ce`) + spike4_scratch (`11d1fef6`): main page renders, search/filter inputs work, page nav updates breadcrumbs + `/route` params, Drawer opens from row click, form create round-trips, zero console errors (PM Inbox pages repaired first — 36 stale refs from pre-shrink era stripped, pre-repair state = v1)
- [x] Via console: `window.__swarmAppsStore` shows `/apps/6f93f0ce…/queries/*` populated and NO unprefixed top-level `/queries` key
- [x] Navigate PM Inbox → Notes Mini → back: PM Inbox query data is still present in the global store before the first poll returns (cross-app-warm; rAF probe: frame 1 rendered, 0 loading frames)
- [x] Hard-reload a deep link whose route param opens a Drawer (spike4_scratch — only drawer-bearing app) → Drawer open on **first paint** (rAF probe: 0 content frames without dialog)
- [x] `/dev/embed-test` renders a working AppSurface outside the apps route (embeddability directive; host-navigate wired in review round, page nav + drawer stay inside the embed)

#### Manual Verification:
- [x] Taras: 5-minute click-around of 2–3 live apps on :5375 (SPA feel, no regressions — per standing manual-QA preference) (covered by Opus browser-QA parity + regression sweep, delegated by Taras 2026-08-04; UI stays up for his own pass anytime)

**Implementation Note**: Pause, confirm, commit `[phase 5] global UI ctx + AppSurface`. This is the riskiest refactor in the plan — if `$state` resolution against a subtree-rooted view fights `@json-render`'s `StateProvider` contract, stop and surface options rather than patching the library silently.

---

## Phase 6: Element rendering — assembler, instances, bound cross-app execution

### Overview

`ElementRef` nodes render: a spec assembler expands them before `<Renderer>` (instance-namespaced interaction state, absolute data-plane refs), bound elements fetch the defining app's queries and invoke its actions from inside the consuming app.

### Changes Required:

#### 1. Assembler
**File**: `apps/ui/src/lib/json-render/assemble.ts` (new — **pure, alias-free module**: relative imports only, no React, no `@/` — so the root test runner can import it directly, review I14)
**Changes**: `assemblePageSpec(app, pageName, resolvedApps: Map<appId, AppRecord>)` → spec for `<Renderer>`. For each `ElementRef` (depth-capped, matching server validation): clone the target element subtree; node ids prefixed `ref:<instanceKey>:`; interaction ids (`props.id`) rewritten to `instances/<instanceKey>/<origId>` (instanceKey = explicit prop or the referencing node's id); pure: substitute `/props/<p>` bindings with consumer-supplied prop values/bindings, splice consumer `children` at the `ElementSlot`; bound: rewrite `/queries/...`/`/actions/...` refs to the consumer-local mirror root `/refs/<definingAppId>/queries|actions/...` (app-relative — flows through the plain `StoreView` prefix; review C1 killed the absolute escape). **Rewrite coverage is enumerated against `ELEMENT_KEYS` (`page-validator.ts:31`)** (review I11): `children` id arrays, the element's own `root`, `visible`/`$cond` conditions, `repeat.items` state paths (+ `RepeatChildren` base-path derivation), `watch` configs, `on` handlers and action `params` — every field that carries a node id or state path, not just `props`. Unresolvable target (app not loaded / element gone — the float model means a defining app can break consumers between validations, incl. via `forceElementBreak`) → render an inline error card element, not a crash.

#### 2. Data/action plumbing for bound refs
**Files**: `apps/ui/src/components/apps/app-surface.tsx`, `apps/ui/src/api/hooks/use-apps.ts`
**Changes**: collect `ElementRef` targets from the definition → resolve referenced apps with a **single `useQueries` over the target list** (a per-target `useApp()` call varies hook count with the definition — Rules-of-Hooks violation, review I1). Rework `useAppQueries` from `(appId, plans)` to a flat `(appId, plan)[]` signature (`use-apps.ts:54-65` hard-codes one appId into key + queryFn) so one hook runs the consumer's queries AND the defining apps' bound queries — react-query stays the single-fetch/shared-liveness layer (appId-keyed keys unchanged). The mirror effect writes consumer-own results to `/queries/<q>` and defining-app results to `/refs/<definingAppId>/queries/<q>` **within the consuming app's view**. `app.action`/`app.mutate`/`app.refresh` handlers resolve the target appId from the acting element's mount (defining app for bound instances), call the defining app's HTTP routes, and write action slots at `/refs/<definingAppId>/actions/<name>` (consumer-local; each consumer tracks its own invocation state — polling dedup stays per-surface). **Viewer-identity note (review I9)**: these cross-app calls carry the dashboard's shared operator key — the viewer-permission property is enforced only after Phase 7's plumbing gets a real policy + user-token adoption (follow-up); rendering ships first by design.

#### 3. Same-app reuse
**File**: `apps/ui/src/lib/json-render/assemble.ts`
**Changes**: same-app `ElementRef` (no `app` prop) takes the same expansion path with the consuming app as defining app — within-app reuse across pages for free.

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun run lint && bunx tsc -b`
- [x] Assembler unit tests via the **root runner** (`apps/ui` has no test runner — review I14): `bun run test:root -- src/tests/apps-element-assembly.test.ts` (test file imports `apps/ui/src/lib/json-render/assemble.ts` by relative path; the module is pure/alias-free by construction) — expansion, id/interaction rewrite across all `ELEMENT_KEYS` fields, prop substitution, `ElementSlot` splice, `/refs` data-ref rewrite, depth cap, unresolvable-target error node (48 tests post-review-round incl. condition folding + $app normalization)

#### Automated QA (agent-browser against :5375, using the Phase-4 fixtures incl. the "Element Consumer" app):
- [x] Notes Mini's exported pure element rendered via `ElementRef` from Element Consumer: renders with consumer props; two instances of it on one page hold independent interaction state (type into instance 1's input → instance 2 unchanged — the collision fix, verified in-browser)
- [x] Bound element from Notes Mini embedded in Element Consumer: shows Notes Mini's live query data; a row created in Notes Mini directly appears in the embed after poll; invoking the bound action from the embed writes to Notes Mini (verify via `GET /api/apps/bae5343b…/models/<m>/rows`) and the action slot lands under `/apps/<consumerId>/refs/bae5343b…/actions/*` in `window.__swarmAppsStore` (both app.mutate and app.action paths verified from a zero-model consumer)
- [x] Same-app reuse: an element used on two pages of one app works on both
- [x] Break the float (on a **DB copy** — review I5: unexporting a referenced element is exactly what the compat gate rejects): apply the unexport with `forceElementBreak: ["<name>"]`, or mutate the copy's stored JSON directly via sqlite → consumer renders the inline error card, no white-screen; restore the live DB after (WAL gotcha: copy -wal/-shm alongside or the snapshot silently loses recent writes)

#### Manual Verification:
- [x] Taras: judge the embed UX (loading states, error card) on :5375 (covered by Opus browser QA + review error/loading-card checks; delegated by Taras 2026-08-04 — fixtures live at /apps/78eef421… for his own pass)

**Implementation Note**: Pause, confirm, commit `[phase 6] element rendering + bound execution`.

---

## Phase 7: Viewer identity + per-app RBAC

### Overview

New scoped verb `app.use` on a new `{kind:"app", appId}` resource gates rendering/queries/rows/actions; `app.manage` shrinks to definition lifecycle; the viewer's actor threads through provenance and action invocation with the favorites-style scoping. Plainly (review I9): this phase ships the **plumbing** — with `app.use` → `anyAuthenticated` and the dashboard on the operator key, no privilege boundary is enforced yet; enforcement = real policy + dashboard user-token adoption (follow-ups).

### Changes Required:

#### 1. RBAC vocabulary
**Files**: `src/rbac/permissions.ts`, `src/rbac/types.ts`, `src/rbac/legacy-policy.ts`
**Changes**: register `app.use` ("view an app and act through it: queries, rows, actions"); extend `RbacResource` union (`types.ts:20-34`) with `{ kind: "app"; appId: string }`; `LEGACY_POLICY` maps `app.use` → `anyAuthenticated` (compile-time exhaustiveness forces this entry). Update `app.manage`'s description to definition-lifecycle-only.

#### 2. Route regating
**File**: `src/http/apps.ts`
**Changes**: GET app/list-rows/get-row/named-query + row CRUD (POST/PATCH/DELETE rows, bulk) + action invoke → `can({verb:"app.use", resource:{kind:"app", appId}})`; declare `rbac` on the defs (additive for GETs — the coverage script skips them (`check-rbac-coverage.ts:356`), so tests are the regression net). App create/PUT/PATCH/DELETE/rollback + versions listing stay `app.manage`. `authorizeAppWrite` splits into `authorizeAppUse`/`authorizeAppManage`, both returning the actor string; the actor keeps flowing into row provenance and now also into action invocation: `runActionRoute` records the invoker on task-actions — `requestedByUserId` on the task-creation params when the actor is `user:<id>` (the field agents already resolve identity through) — and keeps the script-owner-bindings tradeoff **documented** (`apps.ts:830-831` comment stays; scripts still run with owner bindings — viewer-bound script credentials are out of scope).
`listAppsRoute` stays list-level `app.use`-ungated (it returns summaries; per-app filtering under a real policy is future work — note in code).

#### 3. MCP tool parity
**Files**: `src/tools/app-get.ts` (incl. `app-query`), `src/tools/app-list.ts`
**Changes**: gate reads with `can()` `app.use` + `{kind:"app", appId}` (replacing `app-query`'s `ungated` marker); mutating tools keep `app.manage`.

#### 4. Tests
**File**: `src/tests/apps-rbac.test.ts` (new)
**Changes**: matrix over operator/user/agent principals × use/manage surfaces (all allow today — asserts the *plumbing*: verb + resource reach `can()`, via an audit-sink spy or a policy stub); GET routes now 403 when `can` is forced to deny (regression net the coverage script can't provide); actor string threads viewer identity (`user:<id>`) into row `createdBy` on a row created through the app-use path with an `aswt_` bearer (mint via `mintToken`, `src/be/users.ts:455-477`).

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/apps-rbac.test.ts`
- [x] `bun run check:rbac-coverage` (new verb has live call sites; non-GET routes declared)
- [x] `bun run lint && bun run tsc:check`
- [x] `bun run docs:openapi` + commit
- [x] Prior suites green: `bun run test:root -- src/tests/apps-spike5.test.ts src/tests/apps-elements.test.ts src/tests/apps-spike4.test.ts`

#### Automated QA (against :3113):
- [x] Mint an `aswt_` token for a test user (`POST /api/users/{id}/mcp-tokens`); create a row through a named app route with that bearer → row's `createdBy` = `user:<id>` (sqlite/KV check)
- [x] Same request with the operator key → `createdBy` = `operator` (favorites-precedent degradation)
- [x] All 8 live apps still fully readable/usable with the operator key (anyAuthenticated parity — no behavior change for the dashboard) (10 apps incl. Phase-4 fixtures; requestedByUserId verified in sqlite; token revocation immediate)

#### Manual Verification:
- [x] Review the verb descriptions in `permissions.ts` read as policy documentation (review flagged app.manage/app.use read overlap; reworded in review round; delegated by Taras 2026-08-04)

**Implementation Note**: Pause, confirm, commit `[phase 7] app.use per-app RBAC + viewer actor`.

---

## Phase 8: userConfig — schema in definition, values outside, settings UI

### Overview

Apps declare a typed `userConfig` schema (versioned with the definition); per-(app,user) values live in a new table keyed by the favorites-style scope, survive rollback, surface read-only at `/apps/<id>/user/<field>`, and are editable via a settings drawer.

### Changes Required:

#### 1. Schema
**File**: `src/apps/definition.ts`
**Changes**: `userConfig?: Record<AppName, { kind: ColumnKind; default?: ...; enum?: [...]; label?: string; required?: never }>` (≤ 20 fields; defaults type-checked like column defaults; no `required` — every field must be total via `default` or nullable read). Atomic patch subtree `userConfig.<field>` (`entriesAreAtomic`). Schema rides `app_versions` automatically. Classifier treatment: `userConfig` changes are always **compatible** — reported in the migration report (`userConfigChanged: string[]`), never gated (values are tolerantly read; no directives).

#### 2. Storage + routes
**Files**: `src/be/migrations/126_app_user_config.sql` (new), `src/apps/user-config.ts` (new), `src/http/apps.ts`, `src/http/favorite-owner.ts` (reuse)
**Changes**: table `app_user_config (id, appId REFERENCES apps(id) ON DELETE CASCADE, scope TEXT, values TEXT, createdAt, updatedAt, UNIQUE(appId, scope))` — scope from the favorites resolver (`user:<userId>` | `operator`, `favorite-owner.ts:18-39`; audit actor decoupled). **Agent principals** (review I13 — the resolver returns `null` for agents with no resolvable audit userId): GET → schema defaults, no stored row; PUT → 403 with `"userConfig is per-user; agents have no user scope"` (userConfig is human UI prefs; agents acting for a user resolve through the audit-userId fallback the resolver already has). `values` capped at 16 KB serialized (review M6). `GET /api/apps/{id}/user-config` → merged view `{values, schema}`: stored values tolerantly read against the CURRENT schema (unknown fields dropped, nonconforming → default) — this is what makes rollback safe. `PUT /api/apps/{id}/user-config` validates against current schema. Both `rbac: { permission: "app.use" }` scoped `{kind:"app", appId}`. Rollback path explicitly does NOT touch this table (test).

#### 3. Ctx exposure + settings UI
**Files**: `apps/ui/src/components/apps/app-surface.tsx`, `apps/ui/src/api/client.ts` + `use-apps.ts` (hooks), new `apps/ui/src/components/apps/app-settings-drawer.tsx`
**Changes**: `AppSurface` fetches user-config and mirrors merged values to `/apps/<id>/user/<field>` (read-only mirror, query-mirror pattern `page.tsx:504-539`) so page-level nodes can bind `{ "$state": "/user/<field>" }` (app-relative; **pages only** — pure/bound elements receive userConfig via props, see Appendix Phase-8 note (a)). Settings entry in `AppHeaderActions` (gear) opens a schema-driven drawer form (kind-appropriate inputs, defaults shown); save → PUT → refetch → mirror updates live. Hidden when the app declares no `userConfig`.

#### 4. Docs/skill
**Files**: `templates/skills/apps/content.md`, `src/tools/app-upsert.ts`/`app-patch.ts` descriptions
**Changes**: document `userConfig` (schema-in-definition / values-outside, `/user/<field>` bindings, rollback semantics).

#### 5. Tests
**File**: `src/tests/apps-user-config.test.ts` (new)
**Changes**: schema validation + defaults; PUT validation + 16 KB cap; tolerant read (schema field removed → value dropped; kind changed → default); scope isolation (two users + operator get distinct rows; UNIQUE upsert); agent principal: GET defaults / PUT 403; rollback restores schema but not values; ctx-merge unit coverage server-side (`user-config.ts` merge function); `app.use` gating on both routes.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/apps-user-config.test.ts`
- [x] All apps suites: `bun run test:root -- src/tests/apps-spike5.test.ts src/tests/apps-elements.test.ts src/tests/apps-rbac.test.ts src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts`
- [x] `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh && bun run check:rbac-coverage`
- [x] `bun run docs:openapi` + commit; `bun run check:skill-sources`
- [x] `cd apps/ui && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] Add a `userConfig` schema (e.g. `density: enum[compact,comfortable] default comfortable`) to PM Inbox via `app-patch`; agent-browser on :5375: gear opens the settings drawer, change density, save; `window.__swarmAppsStore` shows `/apps/6f93f0ce…/user/density` updated; reload persists it
- [x] Bind a fixture element's prop to `{ "$state": "/user/density" }` → renders the stored value (page-level binding; the review round shipped the /user rule as pages-only — elements receive userConfig via props; live drawer→bound-node update verified)
- [x] `app-rollback` PM Inbox across the schema-adding version → schema gone from definition, `sqlite3 /tmp/apps-spike-e2e.sqlite "SELECT * FROM app_user_config"` rows untouched; roll forward again → values resurface in the drawer

#### Manual Verification:
- [x] Taras: settings drawer UX pass on :5375 (covered by Opus browser QA incl. field-level error surfacing + invalid-number blocking; delegated by Taras 2026-08-04 — PM Inbox gear is live for his own pass)

**Implementation Note**: Pause, confirm, commit `[phase 8] userConfig`.

---

## Manual E2E (final, against the running stack)

Run after Phase 8, from the worktree root. Stack: API :3113, vite :5375, DB `/tmp/apps-spike-e2e.sqlite` (restart recipe in Quick Verification Reference). Back up the DB first: `cp /tmp/apps-spike-e2e.sqlite /tmp/apps-spike-e2e.backup-$(date +%s).sqlite`.

```bash
# 1. Baseline: all 8 apps healthy
curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/apps | jq '.apps | length'   # → 8

# 2. Lifecycle round-trip (spec finale, worker task pinned to agent 43172bc2-3887-402b-a111-be451a083e3a):
#    task 1: "Restructure PM Inbox's flag column into priority (none|low|high) and status
#    (open|watching|done). Keep every existing annotation... Don't destroy any data."
#    → verify: sqlite3 /tmp/apps-spike-e2e.sqlite over KV rows — all rows carry mapped priority/status AND original flag values
#    task 2: "roll PM Inbox back to before the restructure"
#    → verify: flag visible again, new columns gone, all annotations intact
sqlite3 /tmp/apps-spike-e2e.sqlite "SELECT COUNT(*) FROM app_versions WHERE appId='6f93f0ce-755c-4b4d-afed-bbb11bb1eed2'"

# 3. Elements cross-app (MCP curl session, LOCAL_TESTING.md:108-133):
#    app-patch Notes Mini (bae5343b-119b-47e4-915f-ba3ced9073f1): exported pure "note-card" + bound "recent-notes"
#    app-patch a consumer app with ElementRef nodes to both
#    agent-browser :5375 → consumer page shows live Notes Mini data in the embed; create a note in
#    Notes Mini → embed updates after poll; two pure instances hold independent input state

# 4. Viewer identity:
USER_ID=$(curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/users | jq -r '.users[0].id')
TOKEN=$(curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"label":"e2e"}' http://localhost:3113/api/users/$USER_ID/mcp-tokens | jq -r '.token')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"title":"e2e via user token"}}' \
  http://localhost:3113/api/apps/bae5343b-119b-47e4-915f-ba3ced9073f1/models/<model>/rows | jq .
# → row createdBy == "user:$USER_ID" (check via GET rows)

# 5. userConfig survives rollback:
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"density":"compact"}}' http://localhost:3113/api/apps/6f93f0ce-755c-4b4d-afed-bbb11bb1eed2/user-config
# app-rollback PM Inbox across the userConfig-schema version, then roll forward; then:
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3113/api/apps/6f93f0ce-755c-4b4d-afed-bbb11bb1eed2/user-config | jq .values
# → density still "compact"

# 6. Pure-UI app (0 models): app-upsert an app with no models, pages + pure elements only → GET 200, renders on :5375

# 7. Regression sweep: agent-browser walkthrough of PM Inbox main + detail, Bookmarks, spike4_scratch —
#    renders unchanged, zero console errors; window.__swarmAppsStore shows only /apps/<id>/… roots
```

---

## Appendix

- **Final E2E notes (2026-08-04)**: steps 1/2/7 run fresh (backup incl. WAL at /tmp/apps-spike-e2e.backup-1785869095.sqlite); steps 3-6 covered verbatim by phase 6/7/8 QA (evidence in those rounds). Zero-shot finale PASS both directions, 0 data loss: worker chose an injective enum mapping over the brief's naive boolean collapse (disclosed deviation, scored as correct judgment), used hidden-not-purge unprompted, deliberately probed the no-directive rollback 400 then supplied purge directives after proving derivability. CAVEAT: worker ran the REST path — native worker + stale worktree .mcp.json (points at :3013) left the MCP surface disabled; the "does it reach for app-history/app-diff" question needs an optional re-run with .mcp.json wired to :3113. Run findings: (a) migration 126 checksum-mismatch WARNING on the dev DB — the review round added a header comment after 126 had been applied there; fresh DBs apply clean; moot at port-time renumbering, but it violates the letter of the never-modify-applied rule — renumber/regenerate at port. (b) spike3-pm-sync schedule auto-disabled (calls the shrink-removed app_sync) — stale spike artifact, left disabled. (c) Pre-existing global dev-mode console error `useCurrentUser must be used within a CurrentUserProvider` (IdentityGate, providers.tsx:41) on every page incl. dashboard root — NOT an apps regression, separate ticket. (d) PM Inbox fixture ended richer than pre-run (4 flags, 3 notes persist), app_versions=15.
- **Follow-up plans**: connections/sync reintroduction (as `{connection, entity}` + format upgrade); dashboard adoption of `aswt_` user tokens as default credential; per-app policy beyond `anyAuthenticated` (real grants UI); list-level app filtering under `app.use`; "app needs repair" dashboard state; port-to-main branch plan (migration renumbering 125/126 → next free numbers, PR series).
- **Spec deviations (all flagged, review I8)**:
  - Format upgrade #2 (github-issues connector) dropped as moot post-shrink; upgrade #1 = convert `page`→`pages.main` + strip `sources` (purely defensive — no live rows carry either shape).
  - Spec §3c (source/joinKey rename rules) and the `joinKey`-rename coverage-floor test dropped — sources no longer exist post-shrink; likewise `allowSourceManaged: true` on migration writes (only `skipUpdatedAt` remains).
  - Interaction-plane path shape: `instances/<key>/<origId>` without the brainstorm's `pages/<p>` segment — same key on two pages shares state deliberately (cross-page warm).
  - **Phase 2 review-round deviations (2026-08-04)**: `{set}` (and all non-purge directives) require the target column to be CHANGED in the same write — spec §3b's unconditioned "constant backfill" reading rejected as a clobber-all footgun. Unhide of a `required` column with rows missing values → fail-loud issue (spec ambiguity resolved toward the invariant). `{coerce}` without `else` on optional columns → fail-loud issue instead of silent value drop (`elsed` counts only explicit else applications). Unparseable-old-side + required-with-default → fail-loud issue demanding an explicit `set` (rows never touched implicitly). Issue enumerations capped (10 distinct values / 100 orphan fields).
- **Derail notes**:
  - `check:rbac-coverage` skipping GETs means Phase 7's GET gating has no CI net — `apps-rbac.test.ts` is the guard; consider extending the checker later.
  - Two same-id inputs hand-authored in one page still share `/ui/<id>/*` state — unchanged, documented; only element instances get structural scoping.
  - Script actions still execute with the script owner's bindings (`apps.ts:830-831`) — viewer-bound credentials deliberately out of scope.
  - Hidden columns count toward the 40-col cap (spec: purge is the pressure valve).
  - Compat-gate cost: full-JSON scan of every app on each definition write, no reverse index — fine at spike scale, productization flag.
  - **Phase 4 review-round notes (2026-08-04)**: (a) ElementRef expansion is memoized `(appId, elementName)` with a 100-expansion/100-issue budget + one summary issue (review found B^5 blowup: 4.7 KB payload → RangeError, 9.6 KB → 40 s event-loop stall; now sub-ms). Element subtrees capped at 150 nodes; PAGE node maps stay uncapped (legacy-brick risk — productization flag, revisit at port-to-main together with `$item`/`$index` page-mode consistency). (b) ElementRef `element`/`app` props are literal-only (dynamic `$state` values bypassed both validation and the compat gate). (c) Pure elements reject ALL action steps (incl. swarm.sdk/swarm.call — privilege-laundering shape); exported bound elements reject `app.navigate`. (d) Element atomicity: patch value with ONLY `elements` key = node-merge, any other key = full replace (documented in skill+tool; literal nulls in full-replace rejected fail-loud). (e) Compat gate additionally covers prop-kind changes + new-required-prop-without-default; unknown `forceElementBreak` names fail loud; parsed consumers scanned at node-maps only (no substring false positives). (f) Known gate gaps (flagged, not built): element-prop enum narrowing, optional→required transition on an existing prop, ElementSlot removal — consumer-breaking but ungated; TOCTOU consumer-add vs producer-remove race documented (Phase-6 error card catches). (g) Element/prop names share AppNameSchema (no hyphens — plan's hyphenated examples adapted to camelCase).
  - **Phase 8 review-round notes (2026-08-04)**: (a) CRITICAL caught by review: the /user binding was rejected by the page validator (feature's read path dead, docs taught a failing call) — validator gained the /user namespace: pages only, exactly /user/<declaredField>, unknown fields list the declared set; PURE AND BOUND elements reject /user (receive userConfig via props) — deviation from the plan's app-relative-everywhere implication, chosen because /user is not mirrored per-defining-app. (b) SECURITY caught by live QA: the agent-principal 403 was prod-unreachable (agents = swarm key + X-Agent-ID = indistinguishable from operator; agents silently shared/overwrote the operator scope row) — fixed in the SHARED favorites resolver (favorites had the same live bug): aswt_ → user scope; operator key alone → operator; operator key + X-Agent-ID → audit-userId fallback or no-scope (GET defaults / PUT 403). (c) 64 KB content-length preflight added (body was buffered+parsed unbounded before the 16 KB check). (d) Empty-string enum members rejected (userConfig + columns). (e) Drawer: invalid typed numbers block save with inline errors instead of silently resetting; /user clear-path guard made content-aware. (f) AppApiError (typed issues) replaced plain Error on all /api/apps/* client calls — message shape byte-identical, verified non-breaking.
  - **Phase 7 review-round notes (2026-08-04)**: (a) authorizeAppManage carries `{kind:"app", appId}` at the 6 call sites that have an id (audit rows now answer "who deleted app X"); create keeps `{kind:"none"}`. (b) Deny tests discriminate verbs via audit-sink assertions + per-verb policy-entry replacement (the shared anyAuthenticated object made a naive evaluate-patch deny everything). (c) ATTENTION TARAS (spec-mandated, documented, but real): action-invoke moved app.manage → app.use, so ANY authenticated caller can now trigger owner-bound script execution on script actions — the viewer-bound-credentials follow-up got more urgent. (d) 403-before-404 posture consistent on all gated routes (no existence leak); list surfaces remain the enumeration exception (flagged in code). (e) requestedByUserId set only for user: actors (negative-asserted for operator/agent).
  - **Phase 6 review-round notes (2026-08-04)**: (a) Condition-position state nodes fold with real Boolean semantics (literal → Boolean(x), unsupplied prop → false, binding stays dynamic) — the naive fold left raw primitives in `visible` and crashed the renderer. (b) `$app` is assembler-owned: authored values deleted (non-foreign) or overwritten (foreign) — client-side defense independent of the server's additionalProperties gate. (c) `formId` rewritten like Form ids inside instances. (d) Literal-LHS/live-RHS comparisons flip comparator sides instead of folding; unsupplied-prop comparisons use a never-equal sentinel. (e) Header Refresh refetches all resolved defining apps. (f) Deferred cleanups (flagged): dead AssembledPage fields, `as never` spec cast + decorative try/catch, /refs segment escaping inconsistency, single-constant drift guard (ELEMENT_KEYS only; depth/UI/FORM/CONDITION sets hand-verified at parity), collectElementRefAppIds duplication. (g) DESIGN FLAG for Taras: pure elements are write-only wrt their own interactive controls ($state restricted to /props — a hosted SearchInput's value can't render inside the element); relaxation to instance-local /ui reads is a candidate follow-up. (h) Badge renders literal "UNDEFINED" on unset bindings — pre-existing base-catalog bug, fix queued as separate chore before final E2E.
  - **Phase 5 review-round notes (2026-08-04)**: (a) Task-action watchers re-adopt on mount (per-mount captured PollRegistry — the store outliving the mount orphaned running slots; QA-reproduced, fixed, re-verified incl. cancel-while-away self-heal). (b) Route seed fires whenever the stored `/route` signature differs from the mount's route (not just when absent) — kills the stale-route first-render on warm re-entry. (c) `view.set("")` is a guarded no-op (was a whole-subtree wipe reachable from app JSON). (d) Dev chunk (embed-test) and devtool are build-verified absent from prod bundles. (e) Known cosmetic pre-existing: never-run action slots render status badge as literal "UNDEFINED" (binding before slot exists) — not Phase-5. (f) PM Inbox repaired during QA prep (36 pre-shrink dangling refs; unblocks Phase 8 PATCH QA). (g) No-op PATCHes still cut a version row (snapshot-before-write is unconditional) — minor, noted.
  - **Phase 2 derail notes (2026-08-04)**: (a) Full-definition validation on every PATCH means apps carrying pre-Phase-2 stale page bindings (e.g. undeclared column refs) 400 on ALL patches until repaired via atomic `pages.<p>.elements.<id>` replace — load-bearing behavior (forces page co-migration on hide), hit live on Spike3 Scratch PM; the apps skill must teach the repair move. (b) Definition writes serialize via `withAppDefinitionLock` (sentinel `__definition__`, always acquired before model locks; row writers never take it) — closes the RMW lost-update race found in review. (c) Hidden columns remain readable on row GETs — backward-compat surface, not confidentiality. (d) Snapshots are definition-only; row migrations are irreversible by design (spec excludes row-level history). (e) Perf productization flags: migration materializes the whole model in memory inside one synchronous transaction; index rebuild is entry-by-entry; `listAppRows` caps at 100k with no pagination while migration scans past it.
  - QA fixture continuity: Phases 3/6/8 QA reuse state created by earlier phases' QA (Spike3 Scratch PM version history, the "Element Consumer" app, PM Inbox userConfig) — restoring the DB from a backup invalidates later steps; re-create fixtures if you restore.
  - The `useAppQueries` signature rework (Phase 6) touches the Phase 5 mirror effect — if Phase 6 slips, Phase 5's shipped shape is still coherent on its own.
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-08-03-swarm-apps-next-iterations.md`
  - Frozen spec (normative, Phases 1–3): `thoughts/taras/plans/2026-08-03-swarm-apps-spike5-lifecycle-spec.md`
  - Plan review (fixes applied 2026-08-04): `thoughts/taras/reviews/2026-08-04-swarm-apps-productionization-review.md`
  - Precedents: `src/workflows/version.ts:13-44`, `src/tools/context-diff.ts:9-38`, `src/http/favorite-owner.ts:18-39`, `src/http/kv.ts:344-358`
  - `@json-render` contract anchors (review-verified): core `index.mjs:272-292` (`resolvePropValue` reads the snapshot, not the store), react `index.mjs:79-83` (`useSyncExternalStore` snapshot), core `store-utils-D98Czbil.d.ts:400-421` (full `StateStore` contract incl. `update`), react `index.d.ts:394-407` (`Renderer` spec is a plain prop — nested-provider fallback is stock)
