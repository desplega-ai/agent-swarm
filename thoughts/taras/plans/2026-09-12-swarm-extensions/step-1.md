---
id: step-1
name: Extension storage, REST, typecheck
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Extension storage, REST, typecheck

## Overview
After this step an operator can `POST /api/extensions/upsert` a single-file TypeScript extension and get back a typecheck or allowlist error, list extensions and their versions, read the run log, patch priority and config, and delete. Nothing executes yet. The contract file and the generated `swarm-extension.d.ts` exist so the typecheck is real. Read the brainstorm's Synthesis (contract sketch, Types, V1 events table, Key Decisions) before starting.

## Changes Required:

#### 1. Contract
**File**: `src/extensions/contract.ts` (new)
**Changes**: Export the types from the brainstorm's Types sketch: `Runtime`, `ExtensionManifest`, `ApiCtx`, `WorkerCtx` (reserved), `CtxFor`, `PreResult`, `SwarmEventMap` with all 13 v1 events and their `event` / `modify` / `result` shapes, `ExtensionApi`, `SwarmExtension`, plus helpers `block(reason)` and `modify(data)`. Event payload types: `TaskCreateEvent` (`{ options: CreateTaskOptions; description: string; origin; requestInfo? }`), `TaskCreateModify` (input-only subset of `CreateTaskOptions` plus `description`), `TaskFollowUpEvent`, `TaskFollowUpModify`, `SlackRouteEvent`, `SlackRouteModify` (`{ target: { kind: "agent"; agentId } | { kind: "lead" } | { kind: "broadcast" } }`), `HeartbeatRemediateEvent` (`{ task; session?; classification; proposedAction; taskAgeMs; sessionHeartbeatAgeMs? }`), `HeartbeatRemediateModify` (`{ proposedAction }`), `ToolCallEvent` (`{ tool; args; requestInfo }`), `ToolCallModify` (`{ args }`), and the `post.*` payloads mirroring the bus emits in `src/be/db.ts:3151` and `:5424`. Reuse `CreateTaskOptions`, `AgentTask`, `RequestInfo` types; do not duplicate them.

#### 2. Generated ambient types
**File**: `scripts/bundle-extension-types.ts` (new), `src/scripts-runtime/types/swarm-extension.d.ts` (generated), `package.json` (`build:extension-types` script), `scripts/check-script-types-freshness.sh` (add the new file)
**Changes**: Emit declarations for `src/extensions/contract.ts` with `ts.createProgram({ declaration: true, emitDeclarationOnly: true })`, inline the imported `CreateTaskOptions` / `AgentTask` / `RequestInfo` declarations (or re-export them from the existing `swarm-sdk.d.ts`), and write a single `declare module "swarm-extension" { ... }` file. `ctx.swarm` is typed as the `SwarmSdk` interface from `swarm-sdk.d.ts`. Follow `scripts/bundle-script-types.ts:34-47` for the write + `bunx biome format` step. Add the Dockerfile `bun build` staging only if the `.d.ts` must exist on disk for the compiled binary (mirror how `swarm-sdk.d.ts` reaches `SCRIPT_TYPES_DIR`, Dockerfile lines 47-58 and 118-123).

#### 3. Migration
**File**: `src/be/migrations/147_extensions.sql` (new; confirm ordinal per root.md pre-flight)
**Changes**: Three tables, styled after `064_scripts.sql` with the audit columns from `082_user_audit_fields.sql:79` included up front:
- `extensions`: `id TEXT PK, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', runtime TEXT NOT NULL DEFAULT 'api' CHECK(runtime IN ('api','worker')), source TEXT NOT NULL, contentHash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, activeVersion INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 100, configJson TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','enabled','error','auto-disabled')), consecutiveFailures INTEGER NOT NULL DEFAULT 0, lastError TEXT, agentId TEXT, createdByAgentId TEXT, created_by TEXT, updated_by TEXT, createdAt, updatedAt`.
- `extension_versions`: `id, extensionId FK ON DELETE CASCADE, version, source, contentHash, changedByAgentId, changedAt, changeReason, created_by, updated_by, UNIQUE(extensionId, version)`.
- `extension_runs`: `id, extensionId FK ON DELETE CASCADE, version, event TEXT, action TEXT CHECK(action IN ('continue','modify','block','error','timeout','load-error')), durationMs INTEGER, message TEXT, createdAt`; index on `(extensionId, createdAt)`.
Add `extension_runs` to `.non-audit-tables` with a reason (append-only log) if `scripts/check-audit-columns.sh` flags it.

#### 4. Entity schemas
**File**: `src/types.ts`
**Changes**: Add `ExtensionSchema`, `ExtensionVersionSchema`, `ExtensionRunSchema` (Zod, named so routes emit `$ref`s), and `ExtensionUpsertBodySchema` (`{ name, source, description?, runtime?, priority?, config? }`). Export inferred types.

#### 5. DB module
**File**: `src/be/extensions/db.ts` (new)
**Changes**: Mirror `src/be/scripts/db.ts`: `upsertExtensionByName` (content-hash dedup, version bump + `extension_versions` row on change, never touches `enabled` / `activeVersion` unless `{ activate: true }` is passed), `getExtensionById`, `getExtensionByName`, `listExtensions`, `listExtensionVersions`, `getExtensionVersion`, `updateExtensionMeta` (priority, config, description), `setExtensionState` (enabled, status, activeVersion, agentId, consecutiveFailures, lastError), `deleteExtension`, `insertExtensionRun` (prunes to the newest 500 rows per extension in the same transaction), `listExtensionRuns`. All through `getDbClient()`, `createdBy` / `updatedBy` from the caller.

#### 6. Allowlist and typecheck
**File**: `src/scripts-runtime/import-allowlist.ts`, `src/be/scripts/typecheck.ts`, `src/be/extensions/validate.ts` (new)
**Changes**: Parameterize the allowlist: `checkImportAllowlist(source, { allowedBare, allowRelative })` with the existing call sites passing today's defaults. Extensions pass `{ allowedBare: ["swarm-extension", "zod", "stdlib"], allowRelative: false }`. Extract from `typecheckScript` a reusable `typecheckWithAmbient({ source, ambientFiles, checkFile })` (or add a `mode: "extension"` option) that swaps the check file to assert `export default` is `SwarmExtension<typeof manifest>` and `manifest.runtime === "api"`. `validateExtensionSource(source)` runs allowlist, then typecheck, then rejects `runtime: "worker"` with the message from the brainstorm. Returns `{ ok: true, manifest } | { ok: false, diagnostics }`. Also extract the `manifest` literal (name, description, runtime, priority default) with the TypeScript AST so `name` in the body must match `manifest.name`.

#### 7. REST routes
**File**: `src/http/extensions.ts` (new), `src/http/all-routes.ts` (import), `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`
**Changes**: Routes via `route()`, all with `responses` schemas from `src/types.ts`:
- `POST /api/extensions/upsert` — `rbac: { permission: "extension.write" }`; body `ExtensionUpsertBodySchema`; runs `validateExtensionSource`; 400 on diagnostics with the structured list; when the caller is an operator (no agent principal) and the extension is enabled, pass `{ activate: true }` (step-2 wires the reload); agent callers never activate.
- `GET /api/extensions`, `GET /api/extensions/{id}`, `GET /api/extensions/{id}/versions`, `GET /api/extensions/{id}/runs?limit=` (GET, no rbac needed).
- `GET /api/extensions/type-defs` — returns the generated `swarm-extension.d.ts` text (`unstructured`) for the editor.
- `PATCH /api/extensions/{id}` — `rbac: { permission: "extension.write" }`; body `{ priority?, config?, description? }`; validates `config` against the manifest's Zod schema by evaluating nothing: store as-is here, step-2 validates on enable.
- `DELETE /api/extensions/{id}` — `rbac: { permission: "extension.write" }`; 409 when enabled.
- Enable, disable, and activate-version routes are **defined here as stubs returning 501** with `rbac: { permission: "extension.activate" }` so OpenAPI and RBAC coverage are complete; step-2 fills the handlers.
Verbs: `extension.write` (lead agents and operators) and `extension.activate` (operators only). Map them in `legacy-policy.ts` using the same level the operator-only config routes use (check `POST /api/config` in `src/http/config.ts` and its verb); if no operator-only level exists, add one and document it in the route description.

#### 8. Tests
**File**: `src/tests/extensions-db.test.ts`, `src/tests/extensions-validate.test.ts`, `src/tests/extensions-http.test.ts` (new), `src/tests/fixtures/extensions/` (new: `minimal.ts`, `bad-import.ts`, `bad-return-shape.ts`, `worker-runtime.ts`)
**Changes**: Follow `src/tests/scripts-db.test.ts` and `scripts-http.test.ts` (direct handler calls, temp SQLite via `initDb`, cleanup in `afterAll`, no fixed ports). Cover: upsert creates version 1; same source dedupes; changed source bumps version and snapshots; runs prune at 500; allowlist rejects `node:fs` and relative imports; typecheck rejects a wrong modify shape and `runtime: "worker"`; PATCH updates priority; DELETE on enabled returns 409; agent upsert never sets `enabled`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-db.test.ts src/tests/extensions-validate.test.ts src/tests/extensions-http.test.ts`
- [ ] `bun run tsc:check`
- [ ] `bun run lint`
- [ ] `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] `bash scripts/check-audit-columns.sh && bash scripts/check-migration-conflicts.sh && bash scripts/check-db-boundary.sh`
- [ ] `bun run build:extension-types && bun run check:script-types` (generated file committed and fresh)
- [ ] `bun run docs:openapi` and commit `openapi.json` + `docs-site/content/docs/api-reference/**`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Boot the API against a fresh scratch DB (`DATABASE_PATH=/tmp/ext-step1.sqlite bun run start:http`), upsert `src/tests/fixtures/extensions/minimal.ts` via curl, list it, fetch versions, upsert a changed source, confirm `version: 2` and two version rows, PATCH priority to 10, GET `/api/extensions/type-defs` returns text containing `declare module "swarm-extension"`.
- [ ] Upsert `bad-import.ts` and `worker-runtime.ts` and confirm 400 with a readable diagnostic for each.
- [ ] Boot against a copy of an existing pre-migration DB and confirm only migration 147 applies.

#### Manual Verification:
- [ ] Taras reads the generated `swarm-extension.d.ts` once and confirms the event names and modify shapes match the brainstorm table.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
