---
date: 2026-08-06T00:00:00+02:00
researcher: claude
git_commit: 30f79a927bb6c95b53da8797629cf13b67360159
branch: main
repository: agent-swarm
topic: "On-the-fly per-app TypeScript type generation for swarm scripts — feasibility and reusable seam design"
tags: [research, codebase, swarm-apps, scripts-runtime, typecheck, codegen, typescript]
status: complete
last_updated: 2026-08-06
last_updated_by: claude
---

# Research: On-the-fly per-app TypeScript type generation for swarm scripts

## Research Question

Swarm Apps (merged PR #1066, `feat(apps)` at `30f79a92`) store app definitions (models with typed columns, named queries, custom actions, exported elements) in an API-server-owned `apps` table. Swarm scripts can already call generic app tools (`app_query`, `app_get`, …) with loosely typed JSON in/out. How feasible is on-the-fly, per-app TypeScript type generation for scripts — synthesized declaration text automatically added to a script's typecheck (and ideally authoring) context — and how should the mechanism be designed as a reusable seam so other subsystems (e.g. a future "typed workflows") can contribute generated types too?

This is as-is documentation plus a feasibility/open-questions section. Nothing was implemented.

## Summary

**Highly feasible, and there is already a working precedent for almost the exact shape needed.** `typecheckScript()` (`src/be/scripts/typecheck.ts:922-987`) does not read any `.d.ts` from disk at typecheck time — it builds a `Map<string, string>` of five **in-memory virtual files** fresh on every call and feeds them straight into `ts.createProgram` via a custom `CompilerHost` whose `getSourceFile`/`fileExists`/`readFile` are all Map-backed (`typecheck.ts:798-853`). One of those virtual files, `/virtual/swarm-sdk.d.ts`, is already assembled dynamically per invocation by concatenating a static base interface with two **context-scoped, DB-driven generated blocks**: `getScriptApiTypes(context)` and `getScriptMcpTypes(context)` (`src/be/script-connections.ts:2106-2130`), which read pre-generated TS text cached on `script_connections` rows and splice it into a small `ScriptApiRegistry`/`ScriptMcpRegistry` interface. **A per-app types contributor is structurally the same problem with one extra field to plumb through** (`context.appId`/`context.appIds` alongside the existing `agentId`/`repoId`), a third generated block (e.g. `getScriptAppTypes(context)`), and one more virtual file added to the two arrays in `typecheckScript`.

The app-side inputs for such a generator already exist in one place: `getApp(appId)` → `decodeApp()` (`src/apps/store.ts:56-81, 118-125`) returns a fully resolved, **never-throwing** `AppDefinition` (tolerant `safeParse` + format-upgrade chain, not the throwing `.parse` an earlier spike used). Column kinds (`string|number|boolean|date|enum`, `src/apps/definition.ts:16`), model shapes, named-query result rows (= model columns + 5 system columns, `definition.ts:153-159`), and action names/kinds are all statically knowable from one `AppDefinition` object. Two things are **not** statically knowable: script-action `args`/results (`Record<string, unknown>` / `z.unknown()`) and page-element internals (`elements: z.unknown()`).

The runtime surface needs **zero changes** to support this as a pure compile-time overlay: `ctx.swarm` is a `Proxy` that dispatches every property access by name string to a generic `/api/mcp-bridge` call (`src/scripts-runtime/swarm-sdk.ts:508-519, 443-449`); today's `app_query`/`app_get` already flow through this exact generic path with `Promise<unknown>` signatures. A typed overlay (`app_query` overloaded per literal `appId`, or a synthesized `ctx.apps.<appId>.query(...)` namespace) changes only the `.d.ts` text — the wire calls stay byte-identical.

The main open design work is **selection** (which apps' types to inject — the closest precedent, `listScriptConnections`, injects *everything in scope*, not source-referenced or declared-dep apps, because the `scripts` table has no metadata/JSON column to hold a declared-deps list today) and **staleness** (schema changes go through a synchronous, transactional `migrateAppSchema()` that snapshots + migrates rows + writes the new definition atomically, §5 below — but nothing anywhere invalidates a script's `typeChecked` flag or re-typechecks scripts when an app definition changes; that gap already exists today for the analogous `script_connections` case and would need the same non-answer or a new answer for apps).

## Detailed Findings

### 1. Typecheck pipeline today

`typecheckScript(source, context)` (`src/be/scripts/typecheck.ts:922-987`) is a single pure function, called fresh on every invocation — **nothing about the ambient type set is baked once and reused**; it is fully re-composed per call from module-level string constants plus two dynamic lookups.

Per call it builds an in-memory `files: Map<string, string>` (`typecheck.ts:942-956`) with five entries:

| Virtual path | Content | Static or dynamic |
|---|---|---|
| `/virtual/user-script.ts` | the script source being checked | input |
| `/virtual/swarm-sdk.d.ts` | `scriptSdkTypesWithGeneratedApis(getScriptApiTypes(context), getScriptMcpTypes(context))` | **dynamic per call** — `SCRIPT_SDK_TYPES` constant (`:29-393`) + two context-scoped generated blocks |
| `/virtual/stdlib.d.ts` | `SCRIPT_STDLIB_TYPES` (`:430`) | static, module-level |
| `/virtual/runtime-globals.d.ts` | `SCRIPT_RUNTIME_GLOBALS` (`:461-774`) | static, module-level |
| `/virtual/check.ts` | a 4-line wrapper importing the user script and type-asserting it against `ScriptMain` (`:948-955`) | static template |

`createCompilerHost(files, options)` (`:798-853`) starts from `ts.createCompilerHost` and overrides `getSourceFile` (`:805-812`), `fileExists` (`:814-817`), and `readFile` (`:819-822`) to check the `files` Map first via `ts.createSourceFile(...)` directly on the in-memory string — disk is only a fallback (used for TypeScript's own lib files and `node_modules/zod`). `resolveModuleNames` (`:828-842`) hard-maps the three magic specifiers `./user-script`, `swarm-sdk`, `stdlib` to the virtual paths; everything else resolves from a real on-disk base (`scriptTypesBase()`, `:792-796` — repo root in dev, `SCRIPT_TYPES_DIR` env var in the compiled binary) so bare imports like `zod` still work. `ts.createProgram([USER_FILE, CHECK_FILE, SDK_FILE, STDLIB_FILE, RUNTIME_GLOBALS_FILE], options, host)` (`:959-963`) is called fresh every time; diagnostics are filtered to only `USER_FILE`/`CHECK_FILE` (`:967-970`) so noise inside the SDK/stdlib/runtime-globals files themselves never surfaces.

`getScriptApiTypes(context)` / `getScriptMcpTypes(context)` — the existing precedent for exactly this seam — live in `src/be/script-connections.ts:2106-2130`. They call `listScriptConnections(context)` (`:589-609`, filters by `kind`, `enabled`, and scope-applicability against `context.agentId`/`context.repoId`), pull each connection's **pre-generated** `generatedTypes` string (computed once at connection create/refresh time from an OpenAPI/GraphQL spec or MCP tool list and cached on the `script_connections.generated_types` column — see `:990-1039, 1444-1466, 1579-1902`), and splice them into a small `ScriptApiRegistry`/`ScriptMcpRegistry` interface keyed by connection slug. **Selection strategy today is "everything enabled and in scope," not "only what the script references."**

`scripts/bundle-script-types.ts` (build-time, `bun run build:script-types` = `package.json:80`) is a *separate* concern: it spins up a throwaway DB, boots a full-surface MCP server, validates `SDK_ALLOWLIST` against the live tool registry, and writes the **committed, checked-in** `src/scripts-runtime/types/{swarm-sdk,stdlib}.d.ts` files under `src/scripts-runtime/types/`. These committed files are documentation/IDE-hint/drift-check artifacts only (`check:script-types` = `bash scripts/check-script-types-freshness.sh`, wired into merge-gate CI as job `script-types-freshness` gated on file-change detection at `.github/workflows/merge-gate.yml:22,103,526-545`) — **the API binary never reads them at runtime**; `typecheckScript` always regenerates the SDK `.d.ts` text in-process per call as shown above.

`SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`, shape `Record<sdkMethodName, mcpToolName>`) already contains eight app entries (`:144-151`): `app_get→app-get`, `app_history→app-history`, `app_diff→app-diff`, `app_list→app-list`, `app_patch→app-patch`, `app_query→app-query`, `app_rollback→app-rollback`, `app_upsert→app-upsert`. Their current hand-written signatures live directly in the `SwarmSdk` interface inside `SCRIPT_SDK_TYPES` (`typecheck.ts:270-300`), e.g.:

```ts
app_query(args: {
  appId: string;
  query: string;
  params?: Record<string, string | number | boolean>;
}): Promise<unknown>;
```

Both `app_query` and `app_get`'s Zod output schemas use `z.looseObject({})`/`z.unknown()` (`src/tools/app-get.ts:41-43, 84-91`) — maximally loose, no per-app generics. That's exactly the gap a typegen seam would close.

### 2. Injection seam

Concretely, adding one more generated `.d.ts` string to a single typecheck run requires:

1. A new context-scoped generator function analogous to `getScriptApiTypes`/`getScriptMcpTypes`, e.g. `getScriptAppTypes(context: { agentId?: string; repoId?: string; appIds?: string[] })` in a new or existing `src/be/` module, returning a TS string (an interface or namespace per app).
2. One more line in `scriptSdkTypesWithGeneratedApis` (`typecheck.ts:395-400`) — or a fourth virtual file entirely if the app types should be a separate module rather than folded into `swarm-sdk`.
3. One more entry in the `files` Map and the `ts.createProgram` file-list array (`typecheck.ts:942-963`).

No compiler-host changes are needed — the Map-backed `getSourceFile`/`fileExists`/`readFile` overrides already treat any virtual path uniformly; a new key just works. **Deployment constraint respected**: the generator would call `getApp(appId)` (a `bun:sqlite` read via `getDb()`, `src/apps/store.ts:118-125`), never touch `templates/` or any repo-relative path, so it works identically in the compiled binary and in dev — exactly the same constraint the existing `getScriptApiTypes`/`getScriptMcpTypes` already satisfy (they too are pure DB reads, no filesystem).

One nuance: unlike `script_connections.generated_types` (pre-computed once at connection refresh time and cached because it derives from a potentially large fetched OpenAPI/GraphQL spec), an app's `AppDefinition` is already a small, fully-materialized JSON blob sitting on the `apps` row — synthesizing its `.d.ts` from `decodeApp()`'s output is cheap, in-process string work with no I/O. **On-the-fly generation with no caching layer is plausible for apps** even though the connections precedent caches; caching could be added later purely as a perf optimization (store on `apps.definitionDtsCache` or similar) without changing the seam's shape.

### 3. App schema availability

`AppDefinitionSchema` (`src/apps/definition.ts:270-279`, current `main`, no `sources`/sync system — that machinery from an earlier spike branch was not carried into the merged PR #1066) is:

```ts
export const AppDefinitionSchema = z.object({
  models: z.record(AppNameSchema, ModelDefSchema),
  queries: z.record(AppNameSchema, AppQueryDefSchema).optional(),
  actions: z.record(AppNameSchema, AppActionDefSchema).optional(),
  elements: AppElementsSchema.optional(),
  userConfig: UserConfigSchema.optional(),
  pages: z.record(AppNameSchema, AppPageSchema),
  defaultPage: AppNameSchema,
}).superRefine(...)
```

- **Columns** (`ColumnDefSchema`, `definition.ts:16, 24-70`): `kind: "string"|"number"|"boolean"|"date"|"enum"`, `required?`, `enum?` (string array, required+unique iff `kind==="enum"`), `index?`, `default?`, `hidden?`. The kind→TS mapping is implicit (enforced only by the `default`-value `superRefine`, `:50-69`) but trivial to make explicit: `string→string`, `number→number`, `boolean→boolean`, `date→string` (ISO-8601), `enum→` a union of the declared string literals.
- **Model** (`ModelDefSchema`, `:122-140`): `{ columns: Record<name, ColumnDef> }`, 1–40 columns, reserved names rejected against `SYSTEM_COLUMN_KINDS` (`:153-159`: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` — all statically typed, so a row type is `columns-as-declared & { id: string; createdAt: string; updatedAt: string; createdBy?: string; updatedBy?: string }`).
- **Named query** (`AppQueryDefSchema`, `:161-173`): `{ model, filter?, sort?, limit? }`. Filter values are either literals or `{ $param: name }` refs (`AppQueryParamRefSchema`, `:142-146`) — **param names are declared** (as the `$param` string) but **param types are not** declared separately; a codegen would need to infer each param's type from the filter column's declared kind (the column the param is compared against). **Result shape IS statically knowable**: rows of the target model + system columns, per the cross-check at `:333-359` which already validates that filter/sort columns exist and aren't hidden.
- **Action** (`AppActionDefSchema`, discriminated union, `:175-188`): `kind: "script"` (`scriptId`, `args?: Record<string, unknown>`) or `kind: "task"` (`prompt`, `agentId?`). Action **names** and **kind** are statically knowable; script-action `args`/return and task-action result are **not** (arbitrary JSON / async task lifecycle, respectively).
- **Elements/pages** (`AppElementSchema`/`AppPageSchema`, `:199-266`): element `props` (`ElementPropDefSchema`, `:208-247`) mirror `ColumnDefSchema` and ARE typeable; `elements: z.unknown()` (the json-render tree itself) is NOT.

**Single resolved lookup point**: `getApp(id: string): AppRecord | null` (`src/apps/store.ts:118-125`) → `decodeApp(row)` (`:56-81`) → `decodeAppDefinition(rawJson)` (`:36-54`), which runs `upgradeAppDefinition(raw)` (format-version upgrade chain, `src/apps/format-upgrades.ts`) then `AppDefinitionSchema.safeParse` — **non-throwing**, unlike the throwing `.parse` an earlier spike-branch version used (per `thoughts/taras/research/2026-08-03-swarm-apps-spike5-lifecycle-research.md`, since superseded on `main`). On decode failure `AppRecord.definitionError` is populated instead of throwing, and `definition.schemaVersion` is stamped with `CURRENT_APP_SCHEMA_VERSION`. A typegen function should treat a present `definitionError` as "cannot synthesize types for this app" (skip / emit a stub) rather than crashing the whole typecheck run.

### 4. Runtime surface

`ctx.swarm` is built by `createSwarmSdk(config)` (`src/scripts-runtime/swarm-sdk.ts:508-519`) as a `Proxy` whose `get` trap returns, for *any* string property name, a generic `(args) => callTool(prop, args, config)` closure — there is no per-method code generation at runtime. App calls specifically have no specialized REST endpoint (`bridgeRequestFor()`'s switch has no `app_` case, `:427-430`) and fall through to the generic path: `mcpToolNameForSdkMethod(name)` maps `"app_query"→"app-query"` via `SDK_TOOL_NAME_MAP`, then a `POST /api/mcp-bridge` with `{ tool, args }` (`:443-449`).

**A typed per-app surface can be a pure compile-time overlay with zero runtime changes.** Since dispatch is 100% property-name-string-driven, adding new typed methods/overloads to the `.d.ts` (e.g. `app_query` overloaded on a literal `appId` union, or a synthesized second interface `ScriptAppRegistry` mirroring `ScriptApiRegistry`/`ScriptMcpRegistry` exposed as `ctx.apps.<slugOrId>.query(...)`) requires no change to `swarm-sdk.ts`, `sdk-allowlist.ts`'s runtime behavior, or `mcp-bridge`. The only reason to touch runtime code would be an ergonomic decision to expose a friendlier call shape (e.g. `ctx.apps.<name>.rows.query(...)`) rather than reusing the existing generic `ctx.swarm.app_query({ appId, query, params })` shape typed more precisely — a naming/DX choice, not a feasibility blocker.

`Redacted<string>` (bearer) is defined at `src/scripts-runtime/redacted.ts:9` and only unwrapped at HTTP-header construction (`src/scripts-runtime/swarm-sdk.ts:15`) — irrelevant to app typing but confirms the SDK-config plumbing (stdin JSON `SwarmConfigPayload` → `SwarmConfig` → `ctx`, `src/scripts-runtime/loader.ts:41-60`, `src/scripts-runtime/eval-harness.ts:101-119`) is untouched by this feature.

### 5. Selection and staleness

**Selection.** The `scripts` table (`src/be/migrations/064_scripts.sql`, plus `066_scripts_args_json_schema.sql` adding `argsJsonSchema`, `082_user_audit_fields.sql` adding `created_by`/`updated_by`) has **no JSON-metadata/tags/declared-deps column** — columns are `id, name, scope, scopeId, source, description, intent, signatureJson, contentHash, version, isScratch, typeChecked, fsMode, createdByAgentId, argsJsonSchema, created_by, updated_by, createdAt, updatedAt`. There is nowhere today to persist an explicit "this script depends on app X" declaration. The closest working precedent, `listScriptConnections(context)` (`src/be/script-connections.ts:589-609`), resolves the analogous question — "which of N connections' generated types go into this typecheck?" — by injecting **everything enabled and in scope** (global scripts get all global connections; agent-scoped scripts get scope-applicable ones), not by parsing the source for references and not via a declared-deps field. The same answer (inject types for every app the caller can see, or every app in the same scope) is the path of least resistance for a first cut; a declared-deps field would need a new migration adding e.g. a nullable `appDepsJson TEXT` column, mirroring how `argsJsonSchema` was added post-hoc in `066_scripts_args_json_schema.sql`.

`typecheckScript`'s caller, `script_upsert` (`src/http/scripts.ts:442`: `typecheckScript(parsed.body.source, { agentId: agent.id })`), passes only `{ agentId }` today — no script-row fields flow into the typecheck call beyond that, so any app-selection logic would need either (a) a global/agent-scoped "all visible apps" query (cheap, matches the connections precedent) or (b) a static-analysis pass over `source` grepping for `appId: "..."` string literals (fragile, and defeated by dynamically-constructed IDs) or (c) the new declared-deps column plus a UI/tool affordance to set it.

**Staleness.** `app_versions` (`src/be/migrations/126_apps.sql:13-21`) is a proper history table (`id, appId, version, snapshot, changedByAgentId, createdAt`, `UNIQUE(appId, version)`), populated by `snapshotApp()` (`src/apps/version.ts:69-83`) which reads the **pre-write** definition and computes `version = max+1`. The actual schema-change engine is `migrateAppSchema()` (`src/apps/schema-migrate.ts:934-980`): under `withModelLocks`, it builds a migration plan, then inside a **single DB transaction** runs `snapshot()` → per-model row rewrites (`writeAppRowForMigrationUnlocked`) → index rebuilds (`rebuildAppColumnIndexUnlocked`) → `writeDefinition()`. This means an app's definition change (via `app-upsert`/`app-patch`/`app-rollback`) is atomic and synchronous with the row migration and the version snapshot — there is exactly one moment where "the app's shape changed," which is a clean hook point for invalidation.

**However, no such hook exists today, for apps or for the directly analogous `script_connections` case.** Nothing calls back into `scripts` to flip `typeChecked` to 0 or trigger a re-typecheck when an app definition (or a script connection) changes; a script that was typechecked against an old app shape keeps `typeChecked=1` indefinitely. Per project convention, **inline `script_run` skips `typecheckScript` entirely** (confirmed: `typecheckScript` is only referenced from `script_upsert` at `src/http/scripts.ts:442`, and the `swarm-script` workflow executor (`src/workflows/executors/swarm-script.ts:82`) calls `runScript()` directly with no typecheck call anywhere in that file) — so the staleness question only matters for the `script_upsert` (durable, named scripts) path, not the scratch/inline hot path. This is a gap to design around, not resolve here: candidates are "typecheck is best-effort at write time only, like today" (do nothing new) vs. "re-typecheck affected scripts synchronously inside `migrateAppSchema`'s transaction" (expensive, couples two subsystems) vs. "mark affected scripts stale and surface it passively" (needs the declared-deps field from the selection question to know which scripts are "affected").

### 6. Precedents in-repo

**(a) `apps/ui/scripts/generate-catalog-schema.ts` → `src/apps/catalog.generated.json`.** Reads `swarmCatalogSpec` (Zod schemas) from `apps/ui/src/lib/json-render/catalog.ts`, converts to JSON Schema via `z.toJSONSchema()`, writes a plain JSON artifact to `src/apps/catalog.generated.json` (invoked manually via `apps/ui/package.json:13`'s `generate:catalog-schema` — **no CI drift check exists for this one**, a known gap flagged in `thoughts/taras/reviews/2026-08-04-swarm-apps-productionization-review.md:131`). Root `src/apps/definition.ts:4` consumes it via a plain `import catalog from "./catalog.generated.json"` — the boundary rule ("root src must not import apps/ui") is satisfied because the cross-boundary artifact is JSON bytes, not TypeScript, and the generator itself lives under `apps/ui/` and is never imported by root code. This is the precedent for "codegen crossing a hard architectural boundary by emitting a data artifact instead of code" — not directly reusable for app-types (which are entirely server-side and don't cross the root/apps-ui boundary), but a useful pattern reference if a future contributor needs to synthesize types from UI-owned schemas.

**(b) `scripts/bundle-script-types.ts`.** Build-time only; boots a throwaway DB + full MCP server, derives `.d.ts` text from the live tool registry, writes committed files under `src/scripts-runtime/types/`, checked for staleness by `check:script-types` in CI. This is the "static, baked, source-of-truth-is-the-tool-registry" codegen pattern — the opposite end of the spectrum from `getScriptApiTypes`/`getScriptMcpTypes`'s "dynamic, per-invocation, source-of-truth-is-the-DB" pattern. Per-app types should follow the **latter** pattern (dynamic/per-invocation), since app definitions are user data that changes far more often than the MCP tool registry.

**(c) Other generated-artifact inventory found**: `openapi.json` + `docs-site/content/docs/api-reference/**` (from `scripts/generate-openapi.ts`, CI drift-checked); `src/be/seed-skills/bundled-files.generated.json` (from `scripts/build-seed-skill-files.ts`, CI drift-checked, never hand-edited). All of these are build-time/committed artifacts; **none of them is the "dynamic per-request in-memory string" pattern except `getScriptApiTypes`/`getScriptMcpTypes`**, which makes that pair the only directly transplantable precedent for this feature.

### 7. Typed workflows reusability

Workflow node IO today is effectively untyped: `WorkflowNode.config` is `z.record(z.string(), z.unknown())`, `inputs` is `z.record(z.string(), z.string())` (just context-path strings for `{{token}}` interpolation, no type carried), and `outputSchema` is an optional loose JSON-shape used only for post-hoc validation of agent-task structured output (`src/types.ts:1520-1567`; `runbooks/workflows.md:5-19` — "Without `inputs`, upstream references silently resolve to empty strings," checked only via `diagnostics.unresolvedTokens`). Crucially, the `swarm-script` node executor (`src/workflows/executors/swarm-script.ts:82`) calls `runScript()` directly and **never calls `typecheckScript`** — workflow authoring has no typecheck gate at all today, unlike `script_upsert`.

For a future "typed workflows" feature to plug into the same seam, it would need: (1) a call site that invokes `typecheckScript`-equivalent logic at workflow-definition time (a gap that doesn't exist yet, independent of app-types), and (2) the same context-scoped generator contract (`getScript*Types(context) → string`) so that whatever produces per-app `.d.ts` for scripts is directly reusable for `swarm-script` nodes inside workflows without duplicating the app→TS synthesis logic. The seam design proposed below (a named, registered generator function returning a `.d.ts` string block, keyed into the `files` Map by a stable virtual path) is already shaped to support this — a second caller (a future workflow-node typecheck gate) would call the same `getScriptAppTypes(context)` and splice it into its own `files` Map the same way `script_upsert` does today.

## Feasibility & candidate seam design

**Verdict: feasible with a small, well-contained change.** The hard parts (in-memory multi-file compiler host, per-invocation dynamic type assembly, context-scoped DB-driven generator pattern) are already built and working for the near-identical `script_connections` case. This is additive engineering, not new architecture.

### Contributor interface

Define a small, explicit contract other subsystems can implement, mirroring the existing pair:

```ts
// analogous to getScriptApiTypes / getScriptMcpTypes in src/be/script-connections.ts
function getScriptAppTypes(context: {
  agentId?: string;
  repoId?: string;
  appIds?: string[]; // selection override, see below
}): string
```

Returned as one more virtual file (`/virtual/app-types.d.ts` or folded into the existing `swarm-sdk.d.ts` blob via `scriptSdkTypesWithGeneratedApis`), added to the `files` Map and program file-list in `typecheckScript` (`typecheck.ts:942-963`). This keeps the "contributor" contract uniform: **any subsystem that can produce a `(context) => string` function can be spliced into a typecheck run** — apps today, workflows tomorrow, without touching the compiler-host plumbing again.

### Per-app `.d.ts` shape (sketch)

For an app with model `issue { title: string; flag: enum["none","watch","urgent"] }` and query `urgent`:

```ts
declare namespace App_<appId-or-slug> {
  interface Issue {
    id: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
    updatedBy?: string;
    title: string;
    flag: "none" | "watch" | "urgent";
  }
  interface Queries {
    urgent: { result: Issue[] };
  }
  interface Actions {
    // script/task actions: names statically known, args/result NOT
    closeIssue: { args: Record<string, unknown>; result: unknown };
  }
}
```

Two realistic exposure choices, in increasing order of runtime/ergonomic investment (both are pure-`.d.ts` — no runtime code needed either way per §4):

1. **Overload the existing generic call.** Keep `ctx.swarm.app_query`/`app_get` as the only call surface, but generate literal-`appId`-keyed overloads so TS narrows the return type when `appId` is a string literal matching a known app. Zero new surface for script authors to learn; works today's shape.
2. **Synthesize a friendlier namespace**, e.g. `ctx.apps.<slug>.query.urgent(params)` / `ctx.apps.<slug>.rows: Issue[]`. Better DX, but requires deciding a stable per-app identifier for the property name (slug vs id — apps only have `id`/`name` today, no reserved "slug" field) and is a bigger design surface than this research needs to settle.

### Selection strategies (tradeoffs)

| Strategy | Pros | Cons |
|---|---|---|
| **All apps in scope** (mirrors `listScriptConnections`) | Zero new schema; matches existing precedent exactly; simplest to ship | `.d.ts` grows with every app in the swarm; could get large/slow to synthesize (mitigated — synthesis is cheap, no I/O per §2) and noisy for autocomplete |
| **Source-grep for `appId: "..."` literals** | No schema change; narrower injected surface | Fragile (dynamic IDs, indirection defeat it); only ever a heuristic, never authoritative |
| **Explicit declared-deps column on `scripts`** | Precise, authoritative, matches "the author says what they need" | New migration; new UI/tool affordance to set it; scripts written before the feature exists have nothing declared |

Recommendation implied by the precedent already in the repo: ship "all apps in scope" first (same shape as connections), revisit if `.d.ts` size or noise becomes a real problem.

### Staleness / versioning tie-in

`migrateAppSchema()`'s single transaction (snapshot → migrate rows → write definition, `schema-migrate.ts:934-980`) is a clean single hook point if invalidation is ever wanted — but no invalidation exists today for the *directly analogous* `script_connections` case either, so building one for apps first would be scope creep beyond "pure types" unless requested. The honest current answer, consistent with how connections behave today, is: **typecheck reflects the app's shape at typecheck time only; a script's `typeChecked=1` flag does not track any app's subsequent schema changes.** If this generator is invoked live inside a script-authoring UI (not just at `script_upsert` write time), authors would always see the current shape when they re-typecheck on demand — the staleness gap only bites the stored `typeChecked` flag on already-saved scripts.

## Open Questions

1. Should the generated app-types block live inside `swarm-sdk.d.ts` (folded via `scriptSdkTypesWithGeneratedApis`) or as its own virtual module — the latter keeps app-type diagnostics visually separable in `program.getSemanticDiagnostics()` output but the current diagnostic filter only allows `USER_FILE`/`CHECK_FILE` anyway (`typecheck.ts:967-970`), so this is mostly a code-organization question, not a behavioral one.
2. Does `script_upsert`'s call site need to grow beyond `{ agentId }` (`src/http/scripts.ts:442`) to pass through app-selection context (e.g. `repoId`, or a future declared-deps list read off the request body), and is that plumbed the same way as `getScriptApiTypes`/`getScriptMcpTypes` already receive `context`?
3. Is "all apps in scope" an acceptable default given the swarm could plausibly host many apps over time — is there a practical ceiling (like the `models` ≤10, `actions` ≤20 caps already enforced on a single app) worth applying to "how many apps' types get injected into one typecheck"?
4. Should action `args`/results stay `Record<string, unknown>`/`unknown` forever, or is there value in a future opt-in where a script action declares an `argsJsonSchema`-style shape (the `scripts` table already has `argsJsonSchema` for the *script itself* — could an app action reference/embed a schema the same way)?
5. Does this seam belong in `src/be/script-connections.ts` (next to its two siblings) or a new `src/apps/script-types.ts` (keeping the apps module self-contained) — a purely organizational call with no functional stakes, deferred to implementation time.
6. If a script-authoring UI wants live/on-demand typecheck (not just at `script_upsert`), does it call the same generator through a lighter endpoint, and does that change the "on-the-fly, no caching" cost calculus in §2 (e.g. many rapid re-typechecks while an author types)?

## Code References

| File | Line(s) | Description |
|---|---|---|
| `src/be/scripts/typecheck.ts` | 922-987 | `typecheckScript` — builds the in-memory `files` Map and calls `ts.createProgram` fresh per invocation |
| `src/be/scripts/typecheck.ts` | 798-853 | `createCompilerHost` — Map-backed `getSourceFile`/`fileExists`/`readFile`, module resolution for magic specifiers + real `node_modules` fallback |
| `src/be/scripts/typecheck.ts` | 395-400 | `scriptSdkTypesWithGeneratedApis` — where a third generated block would be spliced in |
| `src/be/scripts/typecheck.ts` | 270-300 | `SwarmSdk` interface's current hand-written `app_*` method signatures (all `Promise<unknown>`) |
| `src/be/scripts/typecheck.ts` | 792-796, 844-850 | `scriptTypesBase()` / `TS_LIB_DIR` — dev-vs-compiled-binary module/lib resolution, confirms no repo-file dependency at runtime |
| `src/be/script-connections.ts` | 2106-2130 | `getScriptApiTypes` / `getScriptMcpTypes` — the direct precedent: context-scoped, DB-driven, per-invocation `.d.ts` string generators |
| `src/be/script-connections.ts` | 589-609 | `listScriptConnections` — "everything enabled and in scope" selection strategy (the precedent for app selection) |
| `src/be/script-connections.ts` | 990-1039, 1444-1466, 1579-1902 | Where `generatedTypes` is computed once and cached on the connection row (contrast: apps don't need this cache, see §2) |
| `src/apps/definition.ts` | 16, 24-70 | `ColumnKindSchema` / `ColumnDefSchema` — the five column kinds and their implicit TS mapping |
| `src/apps/definition.ts` | 122-140 | `ModelDefSchema` |
| `src/apps/definition.ts` | 153-159 | `SYSTEM_COLUMN_KINDS` — the 5 system columns every row/query-result carries |
| `src/apps/definition.ts` | 142-146, 161-173 | `AppQueryParamRefSchema` / `AppQueryDefSchema` — query param refs (names known, types not) and statically-knowable result shape |
| `src/apps/definition.ts` | 175-188 | `AppActionDefSchema` — script/task action kinds; args/result not statically knowable |
| `src/apps/definition.ts` | 208-266 | `ElementPropDefSchema` / `AppElementSchema` — element props are typeable, `elements: z.unknown()` tree is not |
| `src/apps/definition.ts` | 270-279 | `AppDefinitionSchema` — top-level shape on current `main` (no source/sync system) |
| `src/apps/store.ts` | 36-54, 56-81, 118-125 | `decodeAppDefinition` / `decodeApp` / `getApp` — the single resolved-lookup entry point, now tolerant (`safeParse` + format-upgrade, not throwing) |
| `src/apps/format-upgrades.ts` | — | `CURRENT_APP_SCHEMA_VERSION`, `stampAppDefinition`, `upgradeAppDefinition` — the schemaVersion-stamp-and-lazy-upgrade mechanism that replaced the earlier spike's throwing decode |
| `src/apps/version.ts` | 69-83 | `snapshotApp` — pre-write snapshot, `version = max+1` |
| `src/apps/schema-migrate.ts` | 934-980 | `migrateAppSchema` — single transaction: snapshot → row migration → index rebuild → write definition (the atomic hook point for any future invalidation) |
| `src/be/migrations/126_apps.sql` | 1-30 | `apps` / `app_versions` / `app_user_config` tables |
| `src/be/migrations/064_scripts.sql` | 1-35 | `scripts` / `script_versions` tables — no metadata/deps column exists |
| `src/http/scripts.ts` | 442 | `script_upsert`'s `typecheckScript(parsed.body.source, { agentId: agent.id })` call site |
| `src/workflows/executors/swarm-script.ts` | 82 | `runScript()` call with no `typecheckScript` anywhere in the executor — workflow swarm-script nodes are never typechecked today |
| `src/scripts-runtime/swarm-sdk.ts` | 508-519 | `createSwarmSdk` — the `Proxy` that dispatches every `ctx.swarm.<name>` call by property-name string |
| `src/scripts-runtime/swarm-sdk.ts` | 427-449 | `bridgeRequestFor` fallthrough → generic `/api/mcp-bridge` POST — confirms zero runtime specialization for `app_*` calls today |
| `src/scripts-runtime/sdk-allowlist.ts` | 144-151 | `SDK_TOOL_NAME_MAP` app entries |
| `src/tools/app-get.ts` | 38-43, 76-91 | `app_get`/`app_query` Zod input/output schemas — `z.looseObject`/`z.unknown`, no per-app generics |
| `apps/ui/scripts/generate-catalog-schema.ts` | — | UI→root JSON-artifact codegen precedent (crosses the apps-ui/root boundary via plain JSON, not TS import) |
| `src/apps/catalog.generated.json` | — | Consumed at `src/apps/definition.ts:4` |
| `scripts/bundle-script-types.ts` | — | Build-time, committed-artifact codegen precedent (opposite pattern: static/baked vs. dynamic/per-invocation) |
| `.github/workflows/merge-gate.yml` | 22, 103, 526-545 | `script-types-freshness` CI job — the drift-check pattern for the *committed* `.d.ts` files (not directly applicable to per-app dynamic types, which are never committed) |
| `src/types.ts` | 1520-1567 | `WorkflowNode` schema — `config`/`inputs` are loose JSON, no per-node-type output schema |
| `runbooks/workflows.md` | 5-19, 133-171 | Node IO / `inputs` mapping / `swarm-script` node docs |

## Appendix

- **Scope note**: the earlier spike-branch research (`thoughts/taras/research/2026-08-03-swarm-apps-spike5-lifecycle-research.md`) describes a `sources`/sync system (KV-row sync from external connectors) and a throwing `decodeApp` that were both part of the pre-merge spike branch. Neither is present in the merged `main` state investigated here (migration `126_apps.sql`, no `src/apps/sync.ts`, `decodeApp` uses `safeParse`) — the productionized PR #1066 appears to have shipped a simplified/rewritten version without sync, plus the versioning + schema-migration engine the spike doc had flagged as absent. Any future typegen work should treat `main`'s current shape (this doc) as authoritative, not the spike doc.
- **Related research**: `thoughts/taras/research/2026-08-03-swarm-apps-spike5-lifecycle-research.md` (pre-merge spike state, superseded); `thoughts/taras/reviews/2026-08-04-swarm-apps-productionization-review.md` (flags the missing `catalog.generated.json` CI drift check, cited in §6).
