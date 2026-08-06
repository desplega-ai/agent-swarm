---
date: 2026-08-06T00:00:00+02:00
author: claude
topic: "Swarm Apps — sync sources + connections phase (re-add on main, productionized)"
tags: [plan, swarm-apps, sync, connections, script-connections, schema-change]
status: draft
branch: main (cut a feature branch, e.g. `feat/apps-sync-connections`)
last_updated: 2026-08-06
last_updated_by: claude
---

# Swarm Apps — Sync / Connections Phase

## Open decisions — RESOLVED (Taras, 2026-08-06)

**All four resolved as the plan defaults**: (1) create-only, no adoption; (2) preflight-scan + hand-rename; (3) no debounce in v1; (4) `connection` optional. The plan below already encodes these defaults — no amendments required. Original decision text kept for context:

1. **Row adoption.** When a pull returns a record whose join-key value already exists on a row that carries **no** `source` (an operator-created or previously-detached row), should the pass (a) adopt that row — take ownership, overwrite its bound columns, keep its owned columns — or (b) create a second, separately-owned row (the frozen spike-3 behaviour)? Default in this plan: **(b) create-only, no adoption** — which means `remove source → re-add source` duplicates every row, and "convert an existing hand-maintained model into a synced one" is not expressible. (Needed by: Phase 3 + Phase 4.)
2. **Reserved-name collision on live data.** `source` / `syncedAt` / `stale` become reserved column names. If a live app (prod or a dev DB) already declares a model column with one of those names, its definition becomes invalid on deploy (`definitionError` → app shows "needs repair"; writes 409). Do we (a) hand-rename the offending column via `app-patch` before merging, or (b) ship a `format-upgrades.ts` upgrade that auto-renames `source` → `source_` etc. on read? Default in this plan: **(a) preflight-scan + hand-rename**, because no upgrade can guess what the app's pages bind to. (Needed by: Phase 1, before deploy.)
3. **Sync rate control.** Should the server enforce a minimum interval / debounce per `(app, model, source)` — so a Refresh button held down, a tight schedule, and an agent loop cannot hammer a third-party API — or is trusting callers acceptable for v1? Default in this plan: **no debounce in v1** (script timeout + the 500-record pull cap are the only limits). (Needed by: Phase 5.)
4. **Is `connection` mandatory for external sources?** A script source may today reach `api.github.com` with the *default* `GITHUB_TOKEN` egress binding — no connection row involved. Should a source that talks to an external host be **required** to name a `connection` (fail-closed, "credentials only via the connections system"), or does `connection` stay **optional** with ambient default bindings allowed? Default in this plan: **optional** — the server cannot tell which hosts a script will touch, so a mandatory field would be enforcement theatre; declaring it buys write-time validation + preflight, not egress control. (Needed by: Phase 1 + Phase 4.)

---

## Overview

Re-add external data sources and sync to Swarm Apps, on current `main` (Swarm Apps merged as PR #1066 / `30f79a92`), and wire source credentials through the **connections** system that did not exist when spike 3 ran.

- **Motivation.** v1 apps are self-contained over KV rows. The recurring real use case (PM inbox, tracker, review queue) needs a one-way inbound projection of an external system into a model, refreshable on demand and on a schedule, without a deploy.
- **This is a fresh re-add, not a file revival.** `src/apps/sync.ts` does not exist on main — the spike-3 implementation was surgically removed by `thoughts/taras/plans/2026-08-03-swarm-apps-shrink-oneshot.md`. The shrink deliberately **kept** the generic query engine (`applyQuery`, `app-query`, the named-query route) and the `skipUpdatedAt` row-write option; both are load-bearing here.
- **Normative inputs.** `thoughts/taras/design-docs/swarm-apps.md` (Invariants I1–I11 apply unchanged); `thoughts/taras/plans/2026-08-02-swarm-apps-spike3-sync-spec.md` **including AMENDMENT v2** (the validated design — sources are dynamic/script-backed); `thoughts/taras/brainstorms/2026-08-03-swarm-apps-next-iterations.md` (why connections were cut); `thoughts/taras/brainstorms/2026-07-21-connections-redesign.md` + `src/be/script-connections.ts` (the credential system to integrate).

## Current State Analysis

Branch `main` at `30f79a92`. Highest migration: `src/be/migrations/126_apps.sql`. **This plan adds no migration** — sources live inside the versioned `definition` JSON, row provenance lives in the KV row envelope, and no new table is introduced (so `scripts/check-audit-columns.sh` is a no-op here).

**Apps core (what exists, what it costs us):**
- `src/apps/definition.ts` — `AppDefinitionSchema` (`:270-393`): `models` / `queries` / `actions` / `elements` / `userConfig` / `pages` / `defaultPage`. `ModelDefSchema` (`:122-140`) rejects column names present in `SYSTEM_COLUMN_KINDS` (`:153-159` = `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`). Named-query **filters** fall back to `SYSTEM_COLUMN_KINDS` (`:343-378`); named-query **sort** is hardcoded to `createdAt`/`updatedAt` + model columns (`:379-391`). Unknown top-level keys are fail-loud (`:489-500`).
- `parseAppDefinition` (`:474-543`) already does DB-backed semantic validation: script-action existence via `getScriptById`, plus the **agent script-ownership gate** (`:524-539`) with grandfathering of ids already stored (`collectScriptActionIds` `:461-472`). Source scripts must reuse this rule verbatim.
- `applyAppDefinitionPatch` (`:667-677`) → `applyMergePatch` with `entriesAreAtomic` (`:630-636`): `actions.<n>`, `elements.<n>`, `userConfig.<f>`, `models.<m>.columns.<c>`, `elements.<n>.elements.<id>`, `pages.<p>.{elements,params}`. `models.<m>.sources.<s>` must join that list.
- `src/apps/row-store.ts` — `AppRow` = flat `{id, createdAt, updatedAt, createdBy?, updatedBy?, ...values}` (`:11-17`); `AppRowWriteOptions` already carries `skipUpdatedAt` + `actor` (`:19-23`). `prepareValues` (`:95-134`) is the **single choke point** for create + patch and rejects unknown columns. `withMutationLock(appId, model)` (`:136-148`) is the per-(app,model) mutex; `createAppRowUnlocked` / `patchAppRowUnlocked` / `writeAppRowForMigrationUnlocked` / `rebuildAppColumnIndexUnlocked` are the in-lock primitives. `currentModelDefinition` (`:167-182`) is the "re-read the definition inside the lock" precedent. `skipUpdatedAt: true` also suppresses `updatedBy` (`:325-327`).
- `src/apps/schema-migrate.ts` — `withAppDefinitionLock` (`:908-913`, sentinel `__definition__` on the same mutex map, **must be taken before any model lock**), `withModelLocks` (`:915-932`, sorted acquisition by the caller), `migrateAppSchema` (`:934-980`: dry-run `buildPlan` → raise all issues → single `getDb().transaction()` around snapshot + row writes + index rebuild + definition write). Directive vocabulary + report: `:24-68`. Element compat gate: `:138-352`, escape hatch `forceElementBreak`.
- `src/http/apps.ts` — every route via `route()`; `app.use` on runtime data + actions (`:294-433`), `app.manage` on definition lifecycle. `authorizeApp` (`:436-467`) resolves the RBAC principal **and** the actor string (`user:<id>` / `agent:<id>` / `operator`) in one call. Action dispatch at `:1060-1145`: script kind runs `runSavedScriptAsAgent({script, input: {...action.args, ...input, app:{id}}, agentId: getSavedScriptOwnerAgentId(script)})` and answers `{ok, result, stdout, error?, durationMs}` through `scrubObject`; task kind answers `{ok, taskId, status}` and falls back to `getLeadAgent()`. PATCH/PUT wrap everything in `withAppDefinitionLock` (`:1165`, `:1250`).
- MCP tools: `app-get` + `app-query` live in `src/tools/app-get.ts` (`app-query.ts` is a one-line re-export shim); both gate with `can({verb:"app.use", resource:{kind:"app",appId}})` and return `toolOk/toolErr` + `swarmToolOutputSchema`. Registered under `hasCapability("pages")` (`src/server.ts:471-483`), listed in `DEFERRED_TOOLS` (`src/tools/tool-config.ts:167-174`), SDK map `src/scripts-runtime/sdk-allowlist.ts:144-151`.
- UI: `apps/ui/src/components/apps/app-surface.tsx:906-958` — `app.action` branches on `response.taskId` first, then `response.ok` → `{status:"ok", result}` + `ctx.refetchAll()`. **A sync action that answers with the script-kind shape (no `taskId`) needs zero UI change.**

**Connections / credentials (the new seam):**
- `src/be/scripts/run-saved.ts:13-31` — `runSavedScriptAsAgent` is the whole credential story: `buildScriptCredentialBindingsWithFailures({agentId})` (egress secrets, `[REDACTED:<configKey>]` substituted in headers/query at the sandbox fetch patch, host-allowlisted) + `getScriptApiConnectionDescriptors({agentId})` (typed `ctx.api.<slug>` clients) + `getScriptMcpConnectionDescriptors({agentId})`. Scripts never see raw secret material.
- `listScriptConnections({agentId, repoId})` (`src/be/script-connections.ts:589-610`) resolves **global** connections for any agent plus that agent's agent-scoped ones. Connections are lead-managed global vault entries in v1 (connections-redesign decision), so a global connection is reachable from any run-as identity.
- `getSavedScriptOwnerAgentId(script)` = `scopeId ?? createdByAgentId` (`run-saved.ts:9-11`). **Seeded catalog scripts are owner-less** (`src/be/seed-scripts/index.ts:290-317` upserts at `scope:"global", scopeId:null, agentId:null`) — so the app *action* path's `runAsAgentId` check would 400 on them. Precedent for the fallback: the scheduler runs global scripts as `schedule.createdByAgentId ?? "schedule"` (`src/scheduler/scheduler.ts:84-96`), and app *task* actions already fall back to `getLeadAgent()` (`src/http/apps.ts:1131`).
- Script typecheck injects the **live** connection registry (`src/be/scripts/typecheck.ts:2, :395-400` → `getScriptApiTypes()`), so a seeded catalog script must not reference `ctx.api.<slug>` (no connections exist on a fresh DB — it would fail `bun run test:root` and boot seeding). Seeded scripts use raw `fetch` + placeholder substitution; user-authored scripts use `ctx.api.<slug>` literally.
- Schedules: `targetType:"script"` requires `scriptName` (`src/http/schedules.ts:319-323`) and resolves **global scope only**; global script upsert is lead-gated (`src/http/scripts.ts:427-440`). A seeded catalog script is therefore the only friction-free scheduled-sync target.

**Tests:** `src/tests/apps-spike{,2,4,5}.test.ts`, `apps-elements.test.ts`, `apps-element-assembly.test.ts`, `apps-rbac.test.ts`, `apps-user-config.test.ts` — each hand-rolls a `node:http` server around `handleApps` with its own on-disk sqlite. Reuse that harness. `mock.module` leaks process-wide (bun-test gotcha) — stub `globalThis.fetch` only.

## Desired End State

1. A model may declare up to 4 **sources**. A source is `{connector:"script", scriptId, joinKey, args?, connection?}` (the default and the only extensible kind) or `{connector:"swarm-tasks", joinKey, config?}` (the one native/internal connector). **No server-side connector enum ever grows again.**
2. Columns bind to a source field (`{of, field, transform?}`). Source-bound and join-key columns are **read-only on every external write path** (HTTP row create/patch/bulk), rejected with path-bearing `issues[]`.
3. Rows carry flat provenance: `source`, `syncedAt`, `stale`. `syncedAt` is sortable and bumped on every confirmed-present row **without touching `updatedAt`**; `source`/`stale` are filterable in named queries.
4. A pass **pulls outside** the per-(app,model) mutation lock and **reconciles inside** it, re-reading the definition in-lock — the spike-3 review empirically reproduced duplicated rows from an unlocked read-modify-write.
5. Three doors, one engine: `POST /api/apps/{id}/sync`, a `sync` action kind (script-kind response shape → zero UI changes), and the `app-sync` MCP tool. Scheduled sync reuses `targetType:"script"` with a seeded catalog script.
6. Source and binding edits are **schema changes**: they go through `withAppDefinitionLock` + `migrateAppSchema` + `app_versions` snapshots, with a documented free-vs-gated matrix; join-key and connector changes on a source with rows are rejected; source removal detaches rows (data preserved, envelope stripped) and is reported.
7. Sync scripts get provider credentials the way every other script does — through the connections system, resolved for the run-as identity — and a source may **declare** its connection so the dependency is validated at write time and preflighted before a pull.
8. Agents can discover an app's callable surface (queries / actions / their params) from `app-get` without reading the skill end to end.

## What We're NOT Doing

- No webhooks, no two-way sync / write-back, no cross-source entity resolution (a row belongs to at most ONE source).
- No new schedule `targetType` — `targetType:"script"` + a seeded script is the scheduled door.
- No new connector enum entries, ever. `github-issues` is a **catalog seed script**, not server code.
- No `apps/ui/**` changes (the sync action reuses the script-kind response shape; freshness renders through the existing `date` / `badge` column kinds). No `qa-use` requirement is triggered.
- No new SQL migration, no new table, no new RBAC verb (`app.use` covers runtime sync; see Implementation Approach).
- No change to the existing **script-action** run-as behaviour (owner-only, 400 on owner-less scripts). The sync engine gets its own run-as resolver; unifying them is a flagged follow-up.
- No per-app grant policy or UI, no viewer-bound script credentials — blocked on the separate RBAC track. This plan only threads the invoking principal.
- No sync-state table / pass history persistence, no incremental cursors, no partial-page pagination inside the engine (a source script owns its own paging).
- No relaxation of the connections model (no per-source secret storage, no new auth type).

## Implementation Approach

Locked rules (Taras — do not reopen):
- Sources are **dynamic by default**: script-backed. Only internal connectors (swarm-tasks) may be native.
- **One join key per (model × source)**; source-bound + join-key columns read-only externally, rejected with path-bearing `issues[]`.
- Flat row provenance `source` / `syncedAt` / `stale`; `syncedAt` sortable, bumped on every confirmed-present row, `updatedAt` untouched.
- **Pull outside the lock, reconcile inside** the per-(app,model) mutation lock.
- Three doors: HTTP `/sync`, `sync` action kind (script-kind response shape), `app-sync` MCP tool. Schedules via `targetType:"script"`.
- Source / join-key renames are forbidden via `issues[]` (remove + add instead).

Decisions made in this plan (autopilot; flag if wrong):
- **`POST /api/apps/{id}/sync` is `rbac: { permission: "app.use" }`**, not `app.manage` as the frozen spec said. Sync writes rows; row CRUD and action invocation are already `app.use`, and the `sync` action kind reaches the same engine through the `app.use`-gated action route. Two doors to one engine with different verbs would be incoherent.
- **Run-as resolution for a source pull**: `getSavedScriptOwnerAgentId(script) ?? getLeadAgent()?.id ?? "app-sync"`. Owner-less **seeded** scripts must be runnable (the whole catalog-script design depends on it), the lead is a real UUID agent (avoids the non-UUID-agent MCP output-validation trap), and `getLeadAgent()` fallback is the precedent already sitting in the same action handler. Consequence: an owner-less global source script sees **global + lead-scoped** connections. Documented in the skill.
- **`connection` is a slug reference, optional, validated against the run-as identity's scope** at definition-write time (`listScriptConnections({agentId: runAs})`, must exist and be `enabled`) and preflighted before each pull. It buys fail-fast + a visible dependency in `app-get`; it does **not** gate egress (see Open decision 4). It is injected into the script's args as `connection: "<slug>"` so one generic script can serve N connections.
- **Source scripts inherit the action script-ownership gate verbatim** (`parseAppDefinition`): an agent writer may only wire scripts it owns or global ones; ids already stored are grandfathered. `collectScriptActionIds` grows to also collect `models.*.sources.*.scriptId`.
- **Pull contract accepts a completeness signal.** The script returns `Array<{key, fields}>` **or** `{records: Array<{key, fields}>, complete?: boolean}`. When `complete === false` — or when the 500-record cap is hit — the engine **skips the stale sweep** and emits a warning. This is a deliberate extension of the frozen spec: spike-3 ops experience showed staleness is window-relative (a `limit:50` pull against 200 open issues marks 150 rows stale every pass), and this is the cheapest honest fix.
- **`source` / `stale` become filterable in named queries** (via `SYSTEM_COLUMN_KINDS`) — a deviation from spike-3, which pushed them to client-side `Table.filters`. On main, system columns are already filter-capable for free (`definition.ts:343-378`), so this costs nothing and removes a footgun.
- **Source removal detaches, never destroys** (Invariant I4): bound columns keep their last-synced values as ordinary columns, the `source`/`syncedAt`/`stale` envelope is stripped, and the count lands in the migration report as `detachedRows`.
- **Binding an existing column that already carries values is rejected** with a count-bearing issue (the next pass would silently overwrite human-entered data). The escape hatch is the existing directive vocabulary: hide/purge the column, then add it bound.
- **Everything the engine returns goes through `scrubSecrets`/`scrubObject`** before it reaches an HTTP body, a tool result, or a log line — script stderr and provider error bodies are prime secret carriers.
- Commit per phase: `[phase N] <description>` after manual confirmation.

## Quick Verification Reference

From the repo root (never against `./agent-swarm-db.sqlite` — dev-DB fallback hazard):

```bash
bun run lint && bun run tsc:check
bun run test:root -- src/tests/apps-sync.test.ts
bun run test:root -- src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts src/tests/apps-spike5.test.ts
bun run test:root -- src/tests/apps-elements.test.ts src/tests/apps-element-assembly.test.ts src/tests/apps-rbac.test.ts src/tests/apps-user-config.test.ts
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bun run check:rbac-coverage
bun run check:dep-graph
bun run docs:openapi                       # commit openapi.json + docs-site/content/docs/api-reference/**
bun run build:script-types                 # commit src/scripts-runtime/types/*.d.ts
bun run scripts/check-sdk-tool-registration.ts
bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files
```

Isolated API for QA/E2E (**always** an isolated DB + `--no-env-file`; the repo `.env` carries a stale `MCP_BASE_URL` that `runScript` falls back to):

```bash
kill $(lsof -t -iTCP:3113 -sTCP:LISTEN) 2>/dev/null
nohup env BUN_OPTIONS=--no-env-file DATABASE_PATH=/tmp/apps-sync-e2e.sqlite PORT=3113 \
  AGENT_SWARM_API_KEY=123123 MCP_BASE_URL=http://localhost:3113 \
  SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true \
  bun --expose-gc src/http.ts >> /tmp/apps-sync-api.log 2>&1 &
```

MCP tool calls: the three-step handshake in `LOCAL_TESTING.md:100-133` (`X-Agent-ID` **must** be a real UUID; `Accept: application/json, text/event-stream`).
UI (read-only QA, no UI change expected): `cd apps/ui && VITE_API_URL=http://localhost:3113 bun run dev --port 5375`, inspected with `agent-browser`.

---

## Phase 1: Definition surface — sources, column bindings, sync action kind

### Overview

Grow the definition contract: a model-level `sources` map, column-level `source` bindings, the `sync` action kind, the three new reserved row-field names, patch atomicity for source subtrees, and every semantic check — including the connection reference and the script-ownership gate. No engine yet; nothing syncs after this phase.

### Changes Required:

#### 1. Schema + semantic checks
**File**: `src/apps/definition.ts`
**Changes**:
- `SourceDefSchema` = discriminated union on `connector`. A model may declare **multiple named sources** (up to the 4-entry cap) — including several of the same connector, e.g. two `swarm-tasks` sources with different filters; each source owns its rows independently via `row.source === <name>` and has its own join key:
  - `{ connector: "script", scriptId: z.string().uuid(), joinKey: AppNameSchema, args?: Record<string, unknown>, connection?: z.string().min(1) }`
  - `{ connector: "swarm-tasks", joinKey: AppNameSchema, config?: Record<string, string|number|boolean> }` — config carries `status?`/`limit?`/`includeHeartbeat?` **plus scoping filters** (review add, 2026-08-06): `agentId?` (tasks of one agent), `tags?` (comma-list), `assetKey?` (asset-namespace prefix). Pairing convention: task actions spawned by the app stamp an asset key under the app's namespace (e.g. `shared/apps/<appId>/…`), so a `swarm-tasks` source scoped to that prefix pulls exactly "the app's tasks".
- `ModelDefSchema` gains `sources?: z.record(AppNameSchema, SourceDefSchema)` with a 0–4 entry cap (issue path `models.<m>.sources`).
- `ColumnDefSchema` gains `source?: { of: string; field: z.string().min(1); transform?: "slug"|"lower"|"upper"|"cents"|"date-parse" }`.
- `AppActionDefSchema` gains the third variant `{ kind: "sync", model?: AppNameSchema, source?: AppNameSchema }`.
- `SYSTEM_COLUMN_KINDS` += `source: "string"`, `syncedAt: "date"`, `stale: "boolean"` — this simultaneously (a) reserves the names in `ModelDefSchema`'s superRefine and (b) makes them filterable in named queries. Extend the named-query **sort** allowlist (`:379-391`) with `syncedAt`.
- Semantic checks in `parseAppDefinition`, each one path-bearing issue (spike-3 §1c, verbatim except where noted):
  1. `sources.<s>.joinKey` names an existing, non-hidden `kind:"string"` column of the same model.
  2. The join-key column carries no `source` binding, is not `required`, and has no `default`.
  3. `columns.<c>.source.of` names an existing key of the model's `sources`; `field` non-empty.
  4. Transform/kind compatibility: `slug`/`lower`/`upper` → string, `cents` → number, `date-parse` → date.
  5. Source-bound columns are not `required` and carry no `default`.
  6. A model with any `sources` must give every **required owned** column a `default` (sync-created rows must be able to satisfy it).
  7. `connector:"script"` → `getScriptById(scriptId)` exists (issue wording mirrors script actions) **and** passes the agent-writer ownership gate; grow `collectScriptActionIds` to also collect source script ids for grandfathering.
  8. `connection`, when present, resolves via `listScriptConnections({ agentId: <run-as of that source's script> })` to an `enabled` connection with that slug — else `models.<m>.sources.<s>.connection: connection "<slug>" not found or disabled for the sync run-as identity`.
  9. `sync` action: `model` (if given) exists and has a non-empty `sources`; `source` (if given) exists on that model, or on ≥1 model when `model` is omitted; zero matching `(model × source)` pairs → issue.
- `applyMergePatch`: add `path.length === 3 && path[0] === "models" && path[2] === "sources"` to `entriesAreAtomic` — a source subtree is whole-replace (`null` deletes), like columns. Half-merging a `SourceDef` across connector kinds is exactly the failure the discriminated union should make impossible.

#### 2. Shared run-as resolver
**File**: `src/apps/sync-run-as.ts` (new, ~25 lines)
**Changes**: `resolveSyncRunAs(script): string` = `getSavedScriptOwnerAgentId(script) ?? getLeadAgent()?.id ?? "app-sync"`. Used by both the validator (check 8) and the engine (Phase 4) so validation and runtime can never disagree about whose connections count.

#### 3. Tests
**File**: `src/tests/apps-sync.test.ts` (new; copy the harness from `src/tests/apps-spike5.test.ts` — hand-rolled `node:http` around `handleApps`, isolated sqlite)
**Changes**: a full sources+bindings definition parses; each of checks 1–9 rejects with the exact path; `source`/`syncedAt`/`stale` rejected as column names; a `sources` patch replaces the whole subtree (no cross-connector splice); `models.<m>.sources.<s> = null` deletes; named query can `filter: {stale: true}` and `sort: {column:"syncedAt"}`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync.test.ts`
- [ ] No regressions: `bun run test:root -- src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike4.test.ts src/tests/apps-spike5.test.ts src/tests/apps-elements.test.ts src/tests/apps-element-assembly.test.ts src/tests/apps-rbac.test.ts src/tests/apps-user-config.test.ts`
- [ ] `bun run lint && bun run tsc:check`
- [ ] `bash scripts/check-db-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [ ] **Reserved-name preflight (Open decision 2)** — run against a copy of the prod DB and the local dev DB:
      `sqlite3 <db> "SELECT id, name FROM apps WHERE definition LIKE '%\"source\"%' OR definition LIKE '%\"syncedAt\"%' OR definition LIKE '%\"stale\"%'"` then inspect each hit's `models.*.columns` keys. Zero collisions → proceed; any collision → stop and take Taras's answer.
- [ ] Boot the isolated API (Quick Reference recipe) on a copy of the prod DB; `curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/apps | jq '[.apps[]] | length'` and then `GET /api/apps/<id>` for each — **no** app returns `definitionError`.

#### Manual Verification:
- [ ] Read the rejection payload for a wrong `source.of` and a disabled `connection` — is it actionable for an agent without reading the skill?

**Implementation Note**: Pause, confirm, commit `[phase 1] apps sync: definition surface`.

---

## Phase 2: Row envelope + read-only enforcement + query surface

### Overview

Rows learn provenance; external write paths learn that source-bound and join-key columns are not theirs to write.

### Changes Required:

#### 1. Row envelope + write options
**File**: `src/apps/row-store.ts`
**Changes**:
- `AppRow` gains `source?: string; syncedAt?: string; stale?: boolean` (still flat).
- `AppRowWriteOptions` gains `allowSourceManaged?: boolean` (default false) and `envelope?: { source: string; syncedAt: string; stale: boolean }` (only honoured when `allowSourceManaged` is true; applied after `prepareValues`, in `createRowUnlocked` / `patchPreparedRowUnlocked`).
- `prepareValues(definition, values, mode, options)`: when `allowSourceManaged !== true`, a write naming a column with a `source` binding, or the join-key column of any of the model's sources, throws `AppRowValidationError` with `{path: "values.<col>", message: 'column is a read-only projection from source "<src>"; mutate it via the source or a sync refresh'}` (join-key wording: `column is the sync join key and is managed by the sync engine`). When `allowSourceManaged === true`, those writes are allowed and `required` is skipped for source-bound columns.
- Owned rows never gain envelope fields; `deleteAppRow` is unchanged (an operator may still delete a synced row — the next pass recreates it, which is the honest behaviour).

#### 2. Query/sort surface
**File**: `src/http/apps.ts`
**Changes**: `syncedAt` joins the `listRows` sort allowlist (`:925-935`) and the date-comparison predicate in both `listRows` and `applyQuery` (`:733-740`). `filtersFromQuery` (ad-hoc REST `filter.<col>`) stays model-columns-only — unchanged, documented.

#### 3. Tests
**File**: `src/tests/apps-sync.test.ts` (extend)
**Changes**: HTTP row create + patch + bulk each reject a source-bound column and the join-key column with path-bearing issues; owned columns on the same model stay writable; reserved envelope names still fail the unknown-column check; `?sort=syncedAt:desc` orders by date; a row written with `{allowSourceManaged:true, envelope}` round-trips its envelope through `GET /rows` and `app-query`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync.test.ts`
- [ ] No regressions (same app-test list as Phase 1)
- [ ] `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Against :3113 — create an app with a `gh` source and a bound `title` column, then `POST /api/apps/<id>/models/<m>/rows -d '{"values":{"title":"x"}}'` → 400 with the read-only issue; the same POST with only owned columns → 201.

#### Manual Verification:
- [ ] Confirm a synced row rendered by an existing `Table` with `{key:"syncedAt", kind:"date"}` + `{key:"stale", kind:"badge"}` needs no UI change (inspect on :5375 after Phase 4 seeds rows; may be deferred to the Phase 4 QA).

**Implementation Note**: Pause, confirm, commit `[phase 2] apps sync: row envelope + read-only enforcement`.

---

## Phase 3: Source edits as schema changes (lifecycle + compat matrix)

### Overview

Adding, changing, and removing sources / bindings runs through the existing schema-change engine under `withAppDefinitionLock`, snapshots into `app_versions`, and gets a documented free-vs-gated matrix. This is what makes sources safe to iterate on a live app.

### Changes Required:

#### 1. Plan builder
**File**: `src/apps/schema-migrate.ts`
**Changes**: extend `planModel` / `buildPlan` with source-aware classification (all issues path-bearing, all raised in the dry-run before any write):

| Edit | Verdict |
|---|---|
| Add a `sources.<s>` entry | **free** (Phase-1 validation may still reject, e.g. required-defaultless owned column) |
| Add a new column with a `source` binding | **free** |
| Bind an **existing** column that has values in ≥1 row | **rejected** — `models.<m>.columns.<c>.source: binding an existing column would let the next pass overwrite <n> row(s) of existing data; hide or purge the column and add it bound instead` |
| Bind an existing column with zero values | **free** |
| Change a binding's `field` / `transform` | **free** (column is already source-owned) |
| Change `args` / `config` / `connection` / `scriptId` | **free** (window changes churn staleness — documented) |
| Change `joinKey` on an existing source | **rejected** — `join key is immutable; remove the source and add it again` |
| Change `connector` on a source that owns ≥1 row | **rejected** with the row count (same remove+add remedy) |
| Remove `sources.<s>` | **free, detaching**: for every row with `row.source === s`, strip `source`/`syncedAt`/`stale` (values preserved), count into the report |
| Remove a bound column | unchanged — the existing hide/purge rules apply |

- `AppMigrationReportSchema` + `AppMigrationReportOutputSchema` gain `detachedRows: number`.
- Detach row writes reuse `writeAppRowForMigrationUnlocked` inside the existing transaction with `skipUpdatedAt` semantics (no `updatedAt` / `updatedBy` churn) — a detach is not a data edit.
- Dangling bindings can't survive a source removal: Phase-1 check 3 already rejects `source.of` pointing at a missing source, so the agent's patch must remove both in one call. Confirm the ordering (validation runs before `migrateAppSchema` on both PUT and PATCH — `src/http/apps.ts:1180-1200`).

#### 2. Tests
**File**: `src/tests/apps-sync.test.ts` (extend)
**Changes**: every row of the matrix, each asserting the rejection path/count or the applied effect; `app_versions` gains a snapshot for a sources-only patch; detach preserves values + strips the envelope + reports `detachedRows`; a rejected edit writes **nothing** (definition and rows byte-identical after the 400); `app-rollback` across a source-adding version restores cleanly.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync.test.ts`
- [ ] `bun run test:root -- src/tests/apps-spike5.test.ts` (the schema-change engine's own suite — unchanged behaviour for source-less apps)
- [ ] `bun run lint && bun run tsc:check`
- [ ] `bun run docs:openapi` — the `detachedRows` report field is OpenAPI-visible; commit `openapi.json` + `docs-site/content/docs/api-reference/**`

#### Automated QA:
- [ ] Against :3113 — `app-patch` a live scratch app to add a source → `GET /api/apps/<id>/versions` shows a new version; patch `joinKey` → 400 immutable; remove the source → 200 with `migration.detachedRows > 0` and `GET /rows` shows values intact and no `source` field.

#### Manual Verification:
- [ ] Sanity-read one rejection payload end to end: does it tell an agent exactly which patch to send instead?

**Implementation Note**: Pause, confirm, commit `[phase 3] apps sync: source edits as schema changes`.

---

## Phase 4: Sync engine (`src/apps/sync.ts`) + connections wiring

### Overview

The engine: pull outside the lock (script source via the connections-scoped script run, or the native swarm-tasks connector), reconcile inside it, project + transform, write provenance, sweep stale.

### Changes Required:

#### 1. Engine
**File**: `src/apps/sync.ts` (new)
**Changes**:
```ts
type SourceRecord = { key: string; fields: Record<string, unknown> };
type PullResult   = { records: SourceRecord[]; complete: boolean; warnings: string[] };

export type SyncPassResult = {
  model: string; source: string; connector: "script" | "swarm-tasks";
  pulled: number; created: number; updated: number; refreshed: number;
  unchanged: number; markedStale: number; staleSweepSkipped?: boolean;
  warnings: string[]; durationMs: number; invokedBy?: string; error?: string;
};

export async function runAppSync(input: {
  appId: string; model?: string; source?: string; invokedBy?: string;
}): Promise<{ ok: boolean; passes: SyncPassResult[] }>;
```
- **Pair expansion**: `runAppSync` resolves the app, expands `{model?, source?}` to all matching `(model × source)` pairs, and runs passes **sequentially**. Zero matching pairs is an error (400-style issue for HTTP/action, `toolErr` for MCP).
- **Single-flight + sync status (review add, 2026-08-06)**: an in-process in-flight map keyed `<appId>:<model>:<source>` — if a pass for that pair is already running, a new trigger does **not** pull again; its `SyncPassResult` short-circuits to `{skipped: true, alreadyRunning: true}`. After every completed pass the engine writes minimal last-pass state (no history) to KV under the reserved apps namespace — `apps:<id>:sync-status:<model>:<source>` = `{lastStartedAt, lastFinishedAt, ok, created, updated, refreshed, markedStale, error?}` — via the engine's internal write path (the `apps:*` guard blocks only the generic KV choke points). Surface it: sync responses include the pair's status, and the app runtime payload exposes per-source status so UI/agents can render "syncing / last synced / last error".
- **Pull (outside the lock)**:
  - `connector:"script"` — `getScriptById(source.scriptId)`; preflight the `connection` (Phase-1 check 8, re-run at runtime because a connection can be disabled after the write) → on failure the pass errors with **zero row churn**. Then `runSavedScriptAsAgent({ script, agentId: resolveSyncRunAs(script), input: { ...source.args, app: {id}, model, source: <name>, ...(source.connection ? {connection: source.connection} : {}) } })`. This is the entire credential story: `runSavedScriptAsAgent` already wires `egressSecrets` (`[REDACTED:<key>]` substitution at the sandbox fetch patch, host-allowlisted) + `ctx.api.<slug>` + `ctx.mcp.<slug>` for that identity. **The engine never reads, resolves, or forwards secret material.**
  - **Canonical sync-script contract** (every sync script, always): return `Array<{key, fields}>` (bare array = complete snapshot) **or** `{records, complete?}` — `complete: false` means "the pull window may have missed records; do not sweep stale". Validated with zod; `key` coerced with `String()`; hard cap 500 records (over cap → truncate to 500, `complete = false`, warning). Invalid shape / non-zero exit / runtime error / timeout → pass error, zero row churn. Phase 7's skill section documents this contract **verbatim** for script authors.
  - `connector:"swarm-tasks"` — internal, direct `getAllTasks(filters)` (`src/be/db.ts:2203-2242`) with config `{status?: comma-list, agentId?: uuid, tags?: comma-list, assetKey?: namespace-prefix, limit?: <=200 (default 100), includeHeartbeat?: boolean (default false)}` — `agentId`/`tags` map onto the existing `getAllTasks` filter surface; `assetKey` prefix-filters via the asset-management query path if `getAllTasks` lacks it natively; `key = task.id`; flat camelCase projection `id, status, prompt (≤1000 chars), source, agentId, tags, priority, createdAt, updatedAt, vcsProvider, vcsNumber, vcsUrl, vcsAuthor`; `complete = records.length < limit`.
- **Reconcile (inside `withMutationLock(appId, model)`)**:
  1. Re-read the model definition in-lock (`currentModelDefinition` pattern). If the model, the source, or the join key changed since the pull → abort the pass with an error, zero writes.
  2. `mine` = rows where `row.source === sourceName`, keyed by `row[joinKey]`.
  3. Per record: project each bound column via `getByDottedPath(record.fields, binding.field)` → `applyTransform` (`slug`, `lower`, `upper`, `cents` = `Math.round(Number(v)*100)`, `date-parse` = `new Date(v).toISOString()`; failure → `null` + warning, warnings capped at 20 per pass).
     - **match** → `patchAppRowUnlocked` with `{allowSourceManaged: true, envelope: {source, syncedAt: now, stale: false}}`. If any projected value differs: normal `updatedAt` bump with `actor: "sync:<source>"` (`updated`). If nothing differs: `skipUpdatedAt: true` (`refreshed` — `syncedAt` advances, `updatedAt`/`updatedBy` untouched, per the locked rule).
     - **no match** → `createAppRowUnlocked` with projected values + owned-column defaults + the envelope, `actor: "sync:<source>"` (Open decision 1 governs whether an unowned row with a matching key is adopted; default = no).
  4. Stale sweep — **only when `complete === true`**: rows in `mine` whose key was not seen and whose `stale !== true` get `{stale: true}` with `skipUpdatedAt: true` (`syncedAt` unchanged — it records last confirmed presence). When `complete === false`, skip the sweep, set `staleSweepSkipped: true` and warn.
- Every returned `SyncPassResult` passes through `scrubObject` / `scrubSecrets` (`src/utils/secret-scrubber.ts`) before leaving the module.

#### 2. Boundary compliance
**Files**: `src/apps/sync.ts`
**Changes**: `src/apps/` is API-server code — direct `src/be/db` imports are fine (`row-store.ts` already does it); it must **not** be imported from `src/commands/`, `src/providers/`, or `src/scripts-runtime/`. Verify with `bash scripts/check-db-boundary.sh` + `bun run check:dep-graph`.

#### 3. Tests
**File**: `src/tests/apps-sync-engine.test.ts` (new — kept separate so the fetch stubs never bleed into the schema tests)
**Changes**:
- Script source: stub script rows through the scripts DB layer; first pass creates rows with `source`/`syncedAt`/`stale:false` + join key + transforms; second pass with changed data updates only projected columns (an owned column set through a source-managed write stays untouched) and bumps `updatedAt`; an unchanged pass bumps `syncedAt` only (`updatedAt` + `updatedBy` byte-identical); vanished record → `stale:true` with `syncedAt` unchanged; reappearance clears `stale`; `complete:false` → no stale sweep + warning + `staleSweepSkipped`; >500 records truncated + `complete:false`; bad return shape / non-zero exit → pass error with **zero** row writes.
- `args` injection: assert `{...args, app:{id}, model, source, connection?}` reaches the script (echo script).
- Run-as: owner-owned script runs as its owner; owner-less global script runs as the lead; a disabled/missing `connection` fails preflight before the script runs (assert the script was never invoked).
- Native swarm-tasks: seed real task rows through the DB layer; projection + `includeHeartbeat` default; `limit` boundary sets `complete:false`.
- **Concurrency (the regression this design exists for)**: barrier-gate a slow pull so a second `runAppSync` and a concurrent row create interleave; assert no duplicate rows and a consistent final row set.
- Scrubbing: a pass whose script stderr contains a known secret value returns it redacted.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync-engine.test.ts`
- [ ] `bun run test:root -- src/tests/apps-sync.test.ts`
- [ ] `bun run lint && bun run tsc:check`
- [ ] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bun run check:dep-graph`

#### Automated QA:
- [ ] Against :3113 — upsert a saved script that returns two fixed records, wire it as a source, call the engine through Phase 5's route once it exists (or a temporary `bun` REPL harness against the isolated DB), and confirm rows + envelope in `GET /rows`.

#### Manual Verification:
- [ ] `grep -i "redacted\|bearer\|token" /tmp/apps-sync-api.log` after a failing GitHub pull — no secret material, no raw provider auth header.

**Implementation Note**: Pause, confirm, commit `[phase 4] apps sync: engine + connection-scoped pulls`.

---

## Phase 5: Three doors — HTTP route, `sync` action kind, `app-sync` MCP tool

### Overview

Expose the one engine through the three entry points, with the sync action deliberately shaped like the script action so the dashboard needs zero changes.

### Changes Required:

#### 1. HTTP route
**File**: `src/http/apps.ts` (+ `src/http/all-routes.ts` is untouched — the handler file is already imported)
**Changes**: `syncAppRoute = route({ method: "post", path: "/api/apps/{id}/sync", pattern: ["api","apps",null,"sync"], body: z.object({model: AppNameSchema.optional(), source: AppNameSchema.optional()}), rbac: { permission: "app.use" }, responses: {200, 400, 403, 404, 409} })`. Handler: `authorizeAppUse` (returns the actor) → `definitionNeedsRepair` 409 → `runAppSync({appId, model, source, invokedBy: actor})` → `json(res, scrubObject({ok, passes}))`. Unknown model/source or zero matching pairs → 400 with `issues[]`.

#### 2. `sync` action kind
**File**: `src/http/apps.ts` (action dispatch, next to the script/task branches at `:1081-1145`)
**Changes**: `action.kind === "sync"` → `runAppSync({appId, model: action.model, source: action.source, invokedBy: actor})` → respond `scrubObject({ ok, result: { passes }, ...(error && {error}), durationMs })`. **No `taskId` key** — `app-surface.tsx:927-945` branches on `taskId` first, so this shape gives running → ok/error + `refetchAll()` for free. Assert this in the tests rather than trusting the comment.

#### 3. MCP tool
**Files**: `src/tools/app-sync.ts` (new), `src/server.ts`, `src/tools/tool-config.ts`, `src/scripts-runtime/sdk-allowlist.ts`
**Changes**:
- `app-sync`: `inputSchema` `{appId, model?, source?}` (strict is fine on input); `outputSchema: swarmToolOutputSchema({ passes: z.array(z.looseObject({})).optional(), ok: z.boolean().optional() })` — **loose, no format pins**; `rbac: { permission: "app.use" }` + the same in-handler `can({resource:{kind:"app",appId}})` check `app-get`/`app-query` do; `toolOk` with a short rendered per-pass table in `details` (no hand-truncation — the registrar spills overflow), `toolErr` on `ok === false`.
- Register in the `hasCapability("pages")` block in `src/server.ts:471-483`; add `"app-sync"` to `DEFERRED_TOOLS` (`src/tools/tool-config.ts:167-174`, next to the other `app-*` entries); add `app_sync: "app-sync"` to `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts:144-151`) → `bun run build:script-types`, commit the regenerated `.d.ts`.

#### 4. Script delete guard (review add, 2026-08-06)
**Files**: the script delete handler in `src/http/scripts.ts` (+ a `collectSourceScriptIds` sibling next to `collectScriptActionIds` in `src/apps/definition.ts`)
**Changes**: deleting a script that any app definition references — as a `sources.<s>.scriptId` **or** a script-kind action — returns 409 with `issues[]` naming the referencing apps (`app "<name>" (<id>) uses this script at models.<m>.sources.<s>`). Scan stored definitions with the tolerant decoder, and still block when the raw JSON of a *broken* definition contains the id — a broken app is not consent to break it further. Script **updates** stay allowed: runtime return-shape validation turns a contract break into a pass error with zero row churn, and the Phase-4 sync-status surface makes the breakage visible instead of silent.

#### 5. Tests
**File**: `src/tests/apps-sync-engine.test.ts` (extend)
**Changes**: `POST /sync` happy path + 404 unknown app + 400 no-matching-pairs + 403 posture; sync-kind action response asserts `taskId` **absent** and `ok` / `result.passes` present (the zero-UI-change contract); `app-sync` MCP round-trip through a real client with a UUID agent id (mirroring the existing app-tool test style). Script-delete guard: deleting a script referenced by a source (or script action) → 409 naming the app in `issues[]`; after removing the source via `app-patch`, the delete succeeds.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync-engine.test.ts src/tests/apps-sync.test.ts`
- [ ] `bun run lint && bun run tsc:check`
- [ ] `bun run check:rbac-coverage`
- [ ] `bun run scripts/check-sdk-tool-registration.ts`
- [ ] `bun run build:script-types` → `git diff --stat src/scripts-runtime/types` shows the `app_sync` entry; commit
- [ ] `bun run docs:openapi` → `git diff --stat openapi.json` shows `/api/apps/{id}/sync`; commit `openapi.json` + `docs-site/content/docs/api-reference/**`

#### Automated QA:
- [ ] Against :3113 — `POST /api/apps/<id>/sync` returns `{ok:true, passes:[...]}`; invoking a `sync` action through `POST /api/apps/<id>/actions/<name>` returns the same shape without `taskId`; `app-sync` via the MCP handshake (`LOCAL_TESTING.md:100-133`) returns a rendered table.

#### Manual Verification:
- [ ] On :5375 with `agent-browser`: a Button wired to `app.action` on the sync action shows running → ok and the table refreshes — with **zero** `apps/ui/` diff (`git status apps/ui` clean).

**Implementation Note**: Pause, confirm, commit `[phase 5] apps sync: HTTP route, sync action kind, app-sync tool`.

---

## Phase 6: Catalog seed scripts — `github-issues-pull` + scheduled sync

### Overview

Batteries included, in user space: the GitHub source that AMENDMENT v2 moved out of the server, and the tiny script that makes `targetType:"script"` schedules a real sync door.

### Changes Required:

#### 1. `github-issues-pull`
**Files**: `src/be/seed-scripts/catalog/github-issues-pull.ts` (new), `src/be/seed-scripts/index.ts` (text import + `SEED_SCRIPTS` manifest entry with search-friendly `description` + `intent`)
**Changes**:
- `args`: `{ repo: "owner/name" (required, validated in-script — reject `.`/`..` segments), state?: "open"|"closed"|"all" (default "open"), limit?: <=100 (default 100), connection?: string }`.
- One `GET https://api.github.com/repos/<repo>/issues?state=<state>&per_page=<limit>` via `ctx.stdlib.fetchJson` with `Accept: application/vnd.github+json`, `User-Agent: agent-swarm-apps-sync`, `Authorization: Bearer [REDACTED:GITHUB_TOKEN]` and a 10s timeout. **The placeholder is the point**: the sandbox's egress layer substitutes the real token only toward allowed hosts and only when a binding is active for the run-as identity — the script never sees secret material and never calls `/api/config/resolved?includeSecrets=true` (unlike the older `gh-pr-snapshot` pattern; do not copy that part).
- **Must not reference `ctx.api.<slug>`** — seeded scripts are typechecked against the *live* connection registry (`src/be/scripts/typecheck.ts:395-400`), which is empty on a fresh DB. `connection` is accepted, echoed into the result metadata, and otherwise unused by this script; user-authored source scripts are the ones that use `ctx.api.<slug>` literally.
- Filter entries carrying `pull_request` (**the issues endpoint interleaves PRs** — spike-3 ops gotcha; without the filter the pull window silently shrinks). `key = String(issue.number)`.
- Flat camelCase projection: `number, id, title, state, body (≤1000 chars), userLogin, labelsCsv, comments, htmlUrl, createdAt, updatedAt`.
- Returns `{ records, complete }` per the **canonical sync-script contract** (Phase 4 — the one contract every sync script follows), computing `complete = rawPageLength < limit` **before** PR filtering — a full raw page means "there may be more", so the engine must not sweep stale. This script is the worked example of computing `complete` under client-side filtering.
- Non-2xx → return `{ error: "..." }` (the engine turns a non-conforming return into a pass error with zero row churn).

#### 2. `app-sync-run`
**Files**: `src/be/seed-scripts/catalog/app-sync-run.ts` (new), `src/be/seed-scripts/index.ts`
**Changes**: `args {appId, model?, source?}` → `await ctx.swarm.app_sync({appId, model, source})`, returns the tool payload. ~15 lines. This is what a `targetType:"script"` schedule points at (schedules resolve **global** scripts only, and global upsert is lead-gated — a seeded script sidesteps that entirely).

#### 3. Docs touch
**File**: `docs-site/content/docs/(documentation)/guides/script-connections.mdx`
**Changes**: one short section — "Apps sync sources use connections": a source names a `connection` slug, credentials resolve for the sync run-as identity (script owner, else the lead), scripts never unwrap secrets.

#### 4. Tests
**File**: `src/tests/apps-sync-engine.test.ts` (extend)
**Changes**: `github-issues-pull` against a stubbed `globalThis.fetch` — PR entries filtered out, projection shape, `complete` flag at page boundaries, malformed `repo` rejected, non-2xx → error return; `app-sync-run` seeds and typechecks (covered by the seeder's own typecheck at boot, asserted here through `typecheckScript`). **Dummy-HTTP-server integration case (review add, 2026-08-06)**: a local `Bun.serve()` fixture serving canned issue pages on `127.0.0.1`, with a source script pointed at it through the real script sandbox + egress path (allowlist the fixture origin for the test identity) — exercising timeouts, pagination/`complete` at a page boundary, and the no-secret-material invariant without touching GitHub.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/apps-sync-engine.test.ts`
- [ ] `bun run lint && bun run tsc:check`
- [ ] Seeder health on a **fresh** isolated DB: `rm -f /tmp/apps-sync-seed.sqlite && BUN_OPTIONS=--no-env-file DATABASE_PATH=/tmp/apps-sync-seed.sqlite PORT=3114 MCP_BASE_URL=http://localhost:3114 bun src/http.ts` boots with both scripts seeded (typecheck runs inside `scriptsSeeder.apply`) — then `curl -s -H "Authorization: Bearer 123123" "http://localhost:3114/api/scripts?scope=global" | jq '[.scripts[].name] | index("github-issues-pull")'` is non-null. Kill the process afterwards.

#### Automated QA:
- [ ] Against :3113 — a `{connector:"script", scriptId:<github-issues-pull>}` source against a small public repo creates rows; narrow `state` to `closed` and re-sync → previously-seen rows go `stale:true`; widen back → `stale` clears.
- [ ] Schedule leg: `POST /api/schedules` with `targetType:"script"`, `scriptName:"app-sync-run"`, `scriptArgs:{appId}` → `POST /api/schedules/<id>/run` → rows appear (proves the cron door without waiting for a tick).

#### Manual Verification:
- [ ] Confirm the seeded scripts read well as *examples* — an agent copying `github-issues-pull` should land on the right contract (`{records, complete}`, placeholder auth, no secret reads).

**Implementation Note**: Pause, confirm, commit `[phase 6] apps sync: github-issues-pull + app-sync-run catalog scripts`.

---

## Phase 7: Discoverability ride-along — NUDGES + seeded `apps` skill

### Overview

Two small surfaces that decide whether any of the above is actually used: a nudge that teaches an agent to read an app's callable surface from `app-get`, and the skill sections that teach sources, sync, freshness, and the read-only contract.

### Changes Required:

#### 1. Nudge
**File**: `src/tools/utils.ts` (the central `NUDGES` map, `:238-277` — **not** an ad-hoc per-tool string)
**Changes**: add an `"app-get"` entry: when the returned app declares queries or actions, emit one sentence — *"This app's callable surface is `definition.queries` (run with `app-query`, passing any `$param` values) and `definition.actions` (invoke with `POST /api/apps/<id>/actions/<name>`; `sync` actions refresh sources)."* Guard on `r.ok` and on the presence of queries/actions so source-less/action-less apps stay quiet.

#### 2. Skill
**File**: `templates/skills/apps/content.md` (config unchanged; `templates/skills/apps/` has no `SKILL.md`, so nothing to regenerate there — but run the drift checks anyway)
**Changes**:
- New **"Sources and sync"** section after "Models": the `sources` map (script connector is THE way; `swarm-tasks` is the one native connector); `joinKey` rules; column `source` bindings + the transform allowlist + kind compatibility; the read-only contract (source-bound + join-key columns reject direct writes — mutate via the source or a refresh); `connection` (what it validates, and that the sync run-as identity is the script owner, else the lead — so global connections always work and agent-scoped ones need matching ownership); the **canonical sync-script contract, verbatim from Phase 4** (`(args, ctx)`, args carry `app`/`model`/`source`/`connection`; return `Array<{key, fields}>` — bare array = complete snapshot — or `{records, complete}`, with `complete:false` = "window may have missed records, no stale sweep"); the **window/staleness caveat** (a narrow pull window marks everything outside it stale; return `complete:false` when the window may be truncated); required-owned-columns-need-defaults.
- New **"Freshness and the refresh button"** recipe: `{key:"syncedAt", kind:"date"}` + `{key:"stale", kind:"badge", tones:{"true":"warning"}}` columns; the `sync` action kind + a Button → `app.action` → status badge; `app-sync` / `app-query` when to use which.
- New **"Reading an app's callable surface"** subsection under the tools/iteration section, mirroring the nudge (queries + their `$param`s, actions + their kinds) so script and agent authors can drive an app they did not write.
- Update **"Safe schema evolution"** with the Phase-3 matrix (immutable `joinKey`, remove+add instead of rename, detach-on-removal, "bind a fresh column, not a populated one").
- Update **"Patch semantics"**: `models.<m>.sources.<s>` entries are atomic subtrees.

#### 3. Tests
**File**: `src/tests/apps-sync-engine.test.ts` (extend) or the existing tool-result tests
**Changes**: `app-get` on an app with queries/actions carries the nudge; on a bare app it does not.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run check:skill-sources && bun run check:skill-md && bun run check:seed-skill-files`
- [ ] `bun run test:root -- src/tests/apps-sync-engine.test.ts`
- [ ] `bun run lint && bun run tsc:check`
- [ ] Full suite once: `bun run test:root`

#### Automated QA:
- [ ] Restart :3113 → the seeded `apps` skill content updates (version-aware seeding preserves user edits). The list route omits `content` by default, so assert with `curl -s -H "Authorization: Bearer 123123" "http://localhost:3113/api/skills?fields=full" | jq -r '.skills[] | select(.name=="apps") | .content' | grep -c "Sources and sync"` → 1.
- [ ] `app-get` through the MCP handshake shows the nudge line ahead of the payload.

#### Manual Verification:
- [ ] Read the new skill sections as an agent would: is the source-script return contract unambiguous in one pass? (This is the 1-call-vs-flailing surface — spike-3's whole PM finale hinged on it.)

**Implementation Note**: Pause, confirm, commit `[phase 7] apps sync: nudge + apps skill sections`.

---

## Manual E2E (final, against a real local stack)

Isolated stack only — API :3113 on `/tmp/apps-sync-e2e.sqlite`, UI :5375. **Never** `:3013` / `./agent-swarm-db.sqlite`. Back up first: `cp /tmp/apps-sync-e2e.sqlite /tmp/apps-sync-e2e.backup-$(date +%s).sqlite`.

```bash
# 0. Boot (Quick Verification Reference recipe), then a worker/lead only if step 6 is run.
export API=http://localhost:3113; export KEY=123123
curl -s -H "Authorization: Bearer $KEY" $API/api/apps | jq '.apps | length'

# 1. Native source, zero credentials: an app whose model is projected from the swarm's own task pool.
#    (app-upsert via MCP or POST /api/apps; model `task` with columns taskKey(string, joinKey),
#     status(enum), title(string, source->prompt), note(string, OWNED) and
#     sources: { pool: { connector:"swarm-tasks", joinKey:"taskKey", config:{limit:50} } })
APP=<app-id>
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{}' $API/api/apps/$APP/sync | jq '.passes'
curl -s -H "Authorization: Bearer $KEY" "$API/api/apps/$APP/models/task/rows?sort=syncedAt:desc" \
  | jq '.rows[0] | {source, syncedAt, stale, taskKey}'

# 2. Read-only contract
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"values":{"title":"hand edit"}}' $API/api/apps/$APP/models/task/rows/<rowId> | jq '.issues'   # → read-only projection issue
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"values":{"note":"mine"}}' $API/api/apps/$APP/models/task/rows/<rowId> | jq '.row.note'        # → "mine"

# 3. Idempotence + freshness: re-sync, assert updatedAt frozen and syncedAt advanced
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}' $API/api/apps/$APP/sync | jq '.passes[0] | {created, updated, refreshed, markedStale}'

# 4. Script source + connection: register a connection for a credentialed API, upsert a saved
#    source script that reads ctx.api.<slug>, wire it as { connector:"script", scriptId, connection:"<slug>" }.
curl -s -H "Authorization: Bearer $KEY" $API/api/script-connections | jq '.connections[] | {slug, kind, enabled}'
#    then disable the connection and re-sync → pass error naming the connection, ZERO row churn:
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}' $API/api/apps/$APP/sync | jq '.passes[0].error'

# 4b. Dummy external API (review add, 2026-08-06): run a throwaway fixture —
#     bun -e 'Bun.serve({port: 9391, fetch: () => Response.json([{number:1, title:"fixture", state:"open", ...}])})' —
#     point a source script at http://127.0.0.1:9391 (allowlist the origin), sync, assert rows + a second
#     concurrent POST /sync returns alreadyRunning for the in-flight pair, then kill the fixture mid-pull
#     → pass error, zero row churn, error visible in apps:<id>:sync-status KV.

# 5. GitHub catalog source (public repo, no creds needed): patch in
#    { connector:"script", scriptId:<github-issues-pull>, joinKey:"issueKey", args:{repo:"<owner>/<name>"} }
#    → sync → rows; narrow args.state to "closed" → previously-seen rows go stale:true (syncedAt frozen);
#    widen back → stale clears. Confirm no PR rows leaked in.

# 6. Scheduled door
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"apps-sync-e2e","targetType":"script","scriptName":"app-sync-run","scriptArgs":{"appId":"'$APP'"},"cron":"0 * * * *"}' \
  $API/api/schedules | jq '.schedule.id'
curl -s -X POST -H "Authorization: Bearer $KEY" $API/api/schedules/<scheduleId>/run | jq '.'

# 7. MCP door (handshake per LOCAL_TESTING.md:100-133, X-Agent-ID must be `uuidgen`)
#    tools/call app-sync {appId} → rendered per-pass table; tools/call app-get {appId} → nudge present.

# 8. Schema-change lifecycle
#    app-patch: change sources.pool.joinKey → 400 immutable
#    app-patch: bind an existing populated owned column → 400 with row count
#    app-patch: sources.pool = null (+ drop its bindings) → 200 with migration.detachedRows > 0;
#      rows keep their values, lose source/syncedAt/stale
#    GET /api/apps/$APP/versions → a version per definition write; app-rollback to the pre-source version → clean

# 9. UI (read-only regression, expect zero apps/ui diff)
#    cd apps/ui && VITE_API_URL=http://localhost:3113 bun run dev --port 5375
#    agent-browser: table shows syncedAt (smart time) + stale badge; Refresh button runs the sync action
#    (running → ok) and the table refetches; no console errors; `git status apps/ui` clean.

# 10. Secret hygiene
grep -iE "bearer [a-z0-9_\-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}" /tmp/apps-sync-api.log   # → no matches

# 11. Zero-shot agent finale (the real acceptance test): with NO primer beyond the seeded skill and tool
#     descriptions, task a worker: "Build a PM Inbox app: an Issue model synced from this swarm's task
#     pool AND from GitHub issues of <owner>/<repo>, with freshness columns, a Refresh action, and a
#     Tackle row action that spawns a task carrying the row." Success = it lands without server-side
#     rejections it cannot self-correct from, and Refresh works in the browser.
```

---

## Appendix — deliberate deviations from the frozen spike-3 spec

| Spec said | This plan does | Why |
|---|---|---|
| `POST /sync` uses `app.manage` | `app.use` | The sync action kind reaches the same engine through the `app.use` action route; row writes are `app.use` everywhere else. |
| Pull returns `Array<{key, fields}>` | Also accepts `{records, complete?}` | Window-relative staleness (spike-3 ops gotcha): a truncated pull otherwise marks every out-of-window row stale on every pass. |
| `stale`/`source` not server-filterable | Filterable in named queries | `SYSTEM_COLUMN_KINDS` already grants this for free on main; client-side-only filtering was a spike-era limitation. |
| Rows rewritten only when values differ | Every confirmed-present row's `syncedAt` advances (`skipUpdatedAt: true`) | Taras's locked rule — freshness must be meaningful. Cost: one KV write per row per pass; the report distinguishes `refreshed` from `updated`. |
| No connections integration ("document, don't build") | `connection` slug on script sources, validated at write time and preflighted per pass | Connections exist now; this is the phase's headline requirement. |
| Script actions' run-as (owner only) reused verbatim | Sync adds `?? lead ?? "app-sync"` | Seeded catalog scripts are owner-less and would otherwise be unrunnable. The **action** path is intentionally left alone (behaviour change out of scope — flagged follow-up). |
| Source removal unspecified | Detaches rows + reports `detachedRows` | Invariant I4 (schema changes never silently destroy data). |

Follow-ups explicitly not in this plan: unify the script-action run-as resolver with `resolveSyncRunAs`; full per-source sync **history** (minimal last-pass status + single-flight IS in scope — Phase 4, review add 2026-08-06); cursor-based incremental pulls; adoption of unowned rows (Open decision 1); per-app grants for sync (blocked on the RBAC track).
