---
date: 2026-08-06T00:00:00+02:00
author: claude
topic: "Per-app generated TypeScript types for swarm scripts (type-contributor seam v1)"
tags: [plan, swarm-apps, scripts-runtime, typecheck, codegen, monaco]
status: completed
branch: main
git_commit: 30f79a927bb6c95b53da8797629cf13b67360159
last_updated: 2026-08-06
last_updated_by: claude
---

# Per-app generated TypeScript types for swarm scripts

## Open decisions — RESOLVED (Taras, 2026-08-06)

**All three resolved as the plan defaults**: (1) loose fallback overload stays; (2) 32 KB cap on the app block as a source constant (promote to the config catalog only if it ever needs tuning); (3) accept ungated exposure now, `context` param is the documented filter hook for when per-app policy lands. The plan below already encodes these defaults — no amendments required. Original decision text kept for context:

1. **`app_query` typing strictness.** Keep the existing loose signature `app_query(args: { appId: string; query: string; params?: Record<string, string | number | boolean> }): Promise<unknown>` as a trailing fallback overload — the plan's default, so nothing that compiles today stops compiling, but a typo'd query name against a *known* app still compiles silently (falling back to `Promise<unknown>`) — or drop the fallback so unknown app ids / query names / param shapes become hard `script_upsert` typecheck errors (real validation, but breaks every script that builds `appId` dynamically or passes `"5"` where a number column is declared)?

2. **Agent-context budget for the generated block.** `script-query-types` proxies `GET /api/scripts/type-defs` with `uncappedDetails: true` (`src/tools/script-common.ts:136-142`), so the entire blob lands in the calling agent's context, and the app block is emitted **twice** (flat `sdkTypes` + ambient `stdlibTypes`). Today's payload is ~37 KB (~9k tokens); ~12 typical apps add ~48 KB (~12k tokens). Plan default: include per-app types on every consumer with a **32 KB cap** on the app block (whole apps dropped oldest-first, omitted apps named in a trailing comment, cap as a source constant). Alternatives: a different cap; making the cap an operator-tunable env var via the Settings → Configuration catalog; or excluding the app block from the agent-facing `script-query-types` path entirely (typecheck + Monaco only).

3. **Per-app RBAC exposure.** The generated block hands every app's model/column/enum vocabulary to every script author and every agent that calls `script-query-types`, regardless of `app.use` grants. Plan default: accept it now (it matches today's already-ungated `GET /api/apps/{id}` and `app.use` → `anyAuthenticated`), and filter by `can({verb: "app.use", resource: {kind: "app", appId}})` only when a real per-app policy lands — the `context` parameter on the generator is the documented hook. Alternative: filter through `can()` immediately, which costs one RBAC audit-sink row per app per typecheck/type-defs call.

## Implementation notes (2026-08-06, post-review)

Independent review round (Codex gpt-5.6-sol) surfaced three verified defects, all fixed in the review-fixes commit: (1) `commentSafe` now also strips U+2028/U+2029 — they are JS line terminators, so a hostile app name could break out of a `//` comment and inject declarations; (2) the skipped/omitted-app trailer comments are bounded to 10 listed apps + a counter, making the 32 KB budget a hard invariant (previously a pathological catalog could push metadata alone past 80 KB); (3) the model-interface dedupe set reserves `ActionName`, so a model literally named `actionName` becomes `ActionName_2` instead of a duplicate-identifier collision with the generated alias. Also added: a `{name}/types` both-blobs test.

PR review round (Codex connector bot, P2): the plan's `$param` rule "if the kinds differ, emit the union" was wrong — `resolveQueryFilters` validates ONE param value against EVERY filter column that references it, so a reused `$param` accepts only the **intersection** of its columns' inputs. Fixed: overlapping enums → literal intersection, enum + string column → the enum literals, disjoint columns → `never` (specialized overload uncallable; the loose fallback still compiles such calls, untyped).

Two accepted deviations from the plan's letter (both consequences of locked decision #1, the retained loose fallback overload):
- Phase 2 test (c): an invalid enum literal passed *directly* to a known `app_query` call compiles via the fallback (as the plan's own `$param` note and Risks appendix predict). The test instead pins the generated enum union type itself. The delivered gate is row-shape inference, not param-value validation.
- E2E step 9's `grep -c "pwned" → 0` oracle is wrong as written: sanitization neutralizes the *escape* (`*/`, line terminators) but deliberately leaves harmless text inside the comment, so the word survives inertly. Verified live: no top-level statement, blob parses, script upserts still 200.

## Overview

Scripts that touch Swarm Apps get **real per-app types** — model row interfaces (enum columns as literal unions), per-query `app_query` overloads with typed `$param` objects and typed result rows, and a documentation-grade action-name union — generated on the fly from the `apps` table, served identically to (a) the server-side `script_upsert` typecheck and (b) the dashboard's Monaco editor.

- **Motivation**: `app_query` is the only script-reachable app data path today and it is typed `Promise<unknown>` (`src/be/scripts/typecheck.ts:281-285`); authors have to hand-verify query names, param names, and row shapes against `app-get` output. The generation machinery already exists for script connections.
- **Why it is small**: `typecheckScript()` re-composes its ambient `.d.ts` set **per call** from a static base plus two DB-driven generators (`getScriptApiTypes` / `getScriptMcpTypes`, `src/be/script-connections.ts:2105-2130`). A per-app generator is one more function of that exact shape, spliced into the same assembly helpers. `ctx.swarm` is a name-dispatching `Proxy` (`src/scripts-runtime/swarm-sdk.ts:508-519`), so the typed surface is a **pure `.d.ts` overlay with zero runtime changes**. The Monaco path is already wired end-to-end (`GET /api/scripts/type-defs` → `useScriptTypeDefs` → `ScriptSourceEditor` extra libs) and needs no new endpoint and no Monaco upgrade.
- **Related**: `thoughts/taras/research/2026-08-06-swarm-apps-script-typegen.md` (authoritative research); `thoughts/taras/plans/2026-08-04-swarm-apps-productionization.md` (the app lifecycle/schema-migration engine this consumes).

## Current State Analysis

**Typecheck assembly (server).**
- `typecheckScript(source, { agentId?, repoId? })` (`src/be/scripts/typecheck.ts:922-987`) builds a 5-entry in-memory `files` Map and a fresh `ts.createProgram` per call. Only `/virtual/swarm-sdk.d.ts` is dynamic: `scriptSdkTypesWithGeneratedApis(getScriptApiTypes(context), getScriptMcpTypes(context))` (`:395-400`).
- `scriptStdlibTypesWithGeneratedApis(api, mcp)` (`:443-448`) wraps the same body in `declare module "swarm-sdk" { … }` — the doc comment there already explains that **Monaco resolves the bare `swarm-sdk` import through this ambient copy**, unlike the server's custom resolver which maps the specifier onto the flat file. Anything a generator emits must therefore land in **both** helpers.
- Diagnostics are filtered to `USER_FILE` / `CHECK_FILE` only (`:967-970`), so generated-file noise can never surface — but a *malformed* generated block can still poison inference in the user file.
- `typecheckScript` is called from exactly one place: `script_upsert` (`src/http/scripts.ts:442`). Inline `script_run` and the `swarm-script` workflow executor (`src/workflows/executors/swarm-script.ts:82`) never typecheck — unchanged by this plan.

**Endpoints + dashboard (already exist).**
- `GET /api/scripts/type-defs` (`src/http/scripts.ts:199-209`, handler `:682-691`) returns `{ sdkTypes, stdlibTypes }` from the two helpers with **no context**; `GET /api/scripts/{name}/types` (`:718-746`) does the same with `{ agentId }`. Both are `route()`-registered and OpenAPI-visible.
- `apps/ui/src/api/hooks/use-scripts.ts:50-61` (`useScriptTypeDefs`) fetches it with `staleTime: Number.POSITIVE_INFINITY` and the now-false comment "SDK/stdlib .d.ts are baked into the server build — static for the session".
- `apps/ui/src/components/scripts/script-source-editor.tsx:21-38` registers both blobs as Monaco `extraLib`s keyed by URI with a content-equality guard. Consumers: `pages/scripts/[id]/page.tsx` (read-only viewer) and `pages/connections/playground-panel.tsx:233,402,416` (the editable authoring surface). **Monaco is already the script editor — no upgrade needed.**
- `apps/ui/src/api/hooks/use-script-connections.ts:112,124,137` already invalidates `["script-type-defs"]` on connection mutations — the precedent. There is **no** app-definition-mutating hook in the dashboard (apps are authored by agents over MCP/REST), so app-driven staleness has nothing to hang an invalidation off.

**App definitions (the type source).**
- `getApp(id)` → `decodeApp(row)` → `decodeAppDefinition` (`src/apps/store.ts:118-125, 56-81, 35-53`): tolerant `safeParse` + format-upgrade chain; failures populate `definitionError` instead of throwing. `listApps()` (`:127-140`) drops the definition, so the generator needs a new sibling that keeps it.
- Column kinds `string|number|boolean|date|enum` with `required?`, `enum?`, `hidden?` (`src/apps/definition.ts:16,24-70`); models 1–40 columns, ≤10 models (`:122-140, 300-304`); actions ≤20 (`:306-313`); queries **uncapped** (bounded only by the 5 MB body cap, `src/http/apps.ts:71`).
- System columns on every row: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` (`definition.ts:147-159`; runtime shape `AppRow` at `src/apps/row-store.ts:11-17`).
- Named queries (`definition.ts:161-173`): `{ model, filter?, sort?, limit? }` where a filter value is a literal or `{ $param: name }`. `resolveQueryFilters` (`src/http/apps.ts:594-644`) makes **every declared `$param` required** and **rejects undeclared param names** — so the params object is exactly typeable. `coerceQueryParamValue` (`:582-592`) is *more* lenient than the declared kind (accepts stringified numbers).
- Model/query/action/column names are already TS-identifier-safe (`AppNameSchema` = `/^[a-z][a-zA-Z0-9_]{0,39}$/`, `definition.ts:12`). **App `name` is free-form** `z.string().min(1)` (`src/http/apps.ts:152`) — the only place needing sanitization. App ids are server-generated UUIDs (`src/apps/store.ts:93`).
- Actions are **not reachable from scripts at all**: `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts:144-151`) exposes `app_get/history/diff/list/patch/query/rollback/upsert` only; row CRUD and action invoke are REST-only (`src/http/apps.ts:296-420`).

**Runtime return shape (what the overlay must promise).** `ctx.swarm.app_query(...)` → `callTool` → generic `/api/mcp-bridge` POST → `scrubObject({ success, status, data })` (`src/scripts-runtime/swarm-sdk.ts:433-460`), where `data` is the tool's `structuredContent` — the swarm envelope (`success`, `message`, `details?`) with `data` keys spread on top (`src/tools/utils.ts:170-181, 305-330`; bridge at `src/http/mcp-bridge.ts:100-102`). For `app-query` that is `{ rows?, count?, issues?, missingParams? }` (`src/tools/app-get.ts:84-90`).

**Sizes today.** `src/scripts-runtime/types/swarm-sdk.d.ts` = 18,431 B, `stdlib.d.ts` = 19,109 B → the type-defs payload is ~37 KB with zero connections/apps.

## Desired End State

1. A named, documented **type-contributor seam**: `(context: ScriptTypeContext) => string`, with `getScriptApiTypes` / `getScriptMcpTypes` / `getScriptAppTypes` as its three implementations and one assembly point (`scriptSdkTypesWithGeneratedApis` / `scriptStdlibTypesWithGeneratedApis`). Adding a fourth contributor (typed workflows) is one parameter + one call site, with no compiler-host or Map changes. No registry, no plugin system.
2. `getScriptAppTypes()` renders, for every decodable app: a doc-commented `namespace App_<Pascal>` with one interface per model (system columns + declared columns, enum columns as literal unions, hidden columns omitted) and an `ActionName` union; plus one `app_query` overload per named query, merged into `SwarmSdk` via interface declaration merging, returning `SwarmAppQueryResult<Row>`.
3. `script_upsert`'s typecheck, `GET /api/scripts/type-defs`, `GET /api/scripts/{name}/types` and therefore `script-query-types` all carry the same block — one generator, one assembly, no divergence.
4. Monaco in the dashboard shows per-app completions, hovers and diagnostics with no new endpoint, no new component, and no stale-forever cache.
5. Zero runtime changes: no new MCP tool, no `SDK_TOOL_NAME_MAP` entry, no migration, no new route, no RBAC verb.
6. A fresh/empty DB produces a byte-identical committed baseline (`bun run check:script-types` stays green).

## What We're NOT Doing

- **No per-script declared-deps column** (locked): selection is "all apps", mirroring `listScriptConnections`'s inject-everything precedent.
- **No strict end-to-end action typing** (locked): script-action `args`/results stay `unknown`; only names + kinds are emitted, as documentation. No new action-invoke tool for scripts.
- **No re-typecheck / invalidation engine** for stored scripts when an app's schema changes (`migrateAppSchema`, `src/apps/schema-migrate.ts:934-980`). Explicit documented deferral — see "Staleness" below.
- No typecheck gate for `script_run` (inline scratch stays ungated by design) or for `swarm-script` workflow nodes.
- No per-app typing of `app_get`/`app_patch`/`app_upsert` definition payloads, no page/element/userConfig types.
- No `ctx.apps.<slug>` namespace (would require inventing runtime surface; the research's option 2).
- No caching layer on the generator (definitions are already-materialized JSON on the row; rendering is pure string work).
- No Monaco upgrade/replacement, no new UI test infra, no qa-use YAML (per standing preference — screenshots for the merge gate only).

## Implementation Approach

### Decisions made here (autopilot — flag if wrong)

- **Fold into the existing assembly, don't add a virtual file.** The Monaco path *requires* the block inside the ambient `declare module "swarm-sdk"` body, and the server path requires it in the flat file. Both come from `stdlibTypesFor(...)` / `SCRIPT_SDK_TYPES`, so a third parameter on the two helpers covers every consumer and leaves `typecheckScript`'s `files` Map and `createCompilerHost` untouched (research open question #1, answered).
- **Extend, don't rewrite, `app_query`.** The generated overloads are appended after the static base in the same module scope, so interface declaration merging puts them ahead of the base signature (string-literal "specialized" signatures also sort first). A literal `appId` + `query` narrows; anything else falls back to today's loose signature. This is what makes the change non-breaking — and what open decision #1 asks about.
- **Seam home: `src/be/scripts/type-contributors.ts`** (new, ~25 lines: `ScriptTypeContext`, `ScriptTypeContributor`, the contract doc comment). It exists to (a) name the seam for the future typed-workflows contributor and (b) avoid a cycle (`typecheck.ts` already imports `script-connections.ts`). **Generator home: `src/apps/script-types.ts`** (research open question #5, answered: keep the apps module self-contained; `src/be/script-connections.ts` is already 2,130 lines).
- **Split pure from impure**: `renderAppTypes(apps: AppRecord[]): string` (pure, unit-testable with no DB) + `getScriptAppTypes(context: ScriptTypeContext = {}): string` (one `listAppRecords()` read, then `renderAppTypes`). New `listAppRecords()` in `src/apps/store.ts` — same query as `listApps()` but returning decoded `AppRecord[]`.
- **`context` is accepted and today unused for filtering** (apps are global — no scope columns on the `apps` table, `126_apps.sql:4-11`). Documented as the hook for open decision #3. It is *not* passed to `can()` — that would write one RBAC audit row per app per call (`src/rbac/can.ts:29-42`).
- **Apps with `definitionError` are skipped**, replaced by a one-line comment naming the app id. A broken definition must never break every script author's typecheck.
- **Hidden columns are omitted** (they are validator-invisible for queries/filters/bindings; `runbooks`-level semantics from the Phase-2 schema engine). **No index signature** on row interfaces — catching `row.titel` is worth more than modelling orphan fields.
- **Staleness: documented deferral, plus one cheap editor fix.** The server regenerates per call, so the typecheck is never stale at write time; the only stale artifact is a stored script's historical `typeChecked=1` flag — the identical, pre-existing gap for `script_connections`. The user-visible staleness is Monaco holding a session-long cache, which Phase 3 fixes with a finite `staleTime`. No dependency tracker, no `migrateAppSchema` hook.

### Generated `.d.ts` shape (sketch)

Emitted once when ≥1 decodable app exists (empty string otherwise, so the committed baseline never drifts):

```ts
// ── Swarm Apps: generated per-app types (source: apps table) ───────────────
// Rows are the app's declared columns plus the 5 system columns. Query
// overloads narrow only when appId AND query are string literals.

export interface SwarmAppQueryResult<Row> {
  success: boolean;
  status: number;
  data: {
    success: boolean;
    message: string;
    details?: string;
    rows?: Row[];
    count?: number;
    [key: string]: unknown;
  };
}

/** App "PM Inbox" — id 6f93f0ce-755c-4b4d-afed-bbb11bb1eed2 */
export namespace App_PmInbox {
  /** Model `issue`. */
  export interface Issue {
    id: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string;
    updatedBy?: string;
    title: string;
    /** enum */
    flag?: "none" | "watch" | "urgent";
    /** date — ISO-8601 string */
    dueAt?: string;
  }
  /** Declared actions. Invocation is REST-only: POST /api/apps/<id>/actions/<name>. */
  export type ActionName = "closeIssue" | "notifyOwner";
}

export interface SwarmSdk {
  /** App "PM Inbox" · query `urgentIssues` → rows of model `issue`. No params. */
  app_query(args: {
    appId: "6f93f0ce-755c-4b4d-afed-bbb11bb1eed2";
    query: "urgentIssues";
    params?: Record<string, never>;
  }): Promise<SwarmAppQueryResult<App_PmInbox.Issue>>;

  /** App "PM Inbox" · query `issueDetail` → rows of model `issue`. Params: `issueId` filters column `id`. */
  app_query(args: {
    appId: "6f93f0ce-755c-4b4d-afed-bbb11bb1eed2";
    query: "issueDetail";
    params: { issueId: string };
  }): Promise<SwarmAppQueryResult<App_PmInbox.Issue>>;
}
```

### Identifier derivation + collisions

| Input | Rule |
|---|---|
| Namespace | `App_` + PascalCase of the app name with non-alphanumerics as word separators, non-ASCII stripped, leading digits dropped. `"PM Inbox"` → `App_PmInbox`; `"spike4_scratch"` → `App_Spike4Scratch`; empty/garbage → `App_Unnamed`. The `App_` prefix guarantees no collision with base SDK names (none start with `App_`). |
| Namespace collision | Deterministic order (`createdAt ASC, id ASC`); first keeps the bare name, subsequent get `_2`, `_3`, … The doc comment always carries the exact app id, so the mapping is never ambiguous. |
| Model interface | PascalCase of the model name (already identifier-safe); same `_2` dedupe within a namespace (`myModel` vs `my_model` both → `MyModel`). |
| Free-form text in comments | App name/description are user-controlled: strip newlines and `*/`, cap at 80 chars. **Injection guard — covered by a hostile-name test.** |
| String literals | App ids go through `JSON.stringify` (defence in depth; ids are server-generated UUIDs today). Enum values likewise. |

### Column kind → TS mapping

| Column kind | TS | Note |
|---|---|---|
| `string` | `string` | |
| `number` | `number` | |
| `boolean` | `boolean` | |
| `date` | `string` | ISO-8601; a `/** date */` doc comment carries the intent |
| `enum` | `"a" \| "b" \| …` | The whole point — misspelled statuses become compile errors |
| `required: true` | non-optional property | |
| otherwise | `prop?:` | |
| `hidden: true` | omitted | |
| system columns | `id/createdAt/updatedAt: string`, `createdBy?/updatedBy?: string` | from `SYSTEM_COLUMN_KINDS` |

**`$param` filters**: for each `{ $param: p }` filter value on column `c`, the params property `p` gets column `c`'s TS type (system columns via `SYSTEM_COLUMN_KINDS`). All declared params are **required** (runtime rejects missing ones); a query with none gets `params?: Record<string, never>`. Two filters referencing the same `$param` name collapse to one property (kinds identical in practice; if they differ, emit the union). Note the deliberate narrowing: runtime coercion accepts `"5"` for a number column, the type does not — with the fallback overload in place (open decision #1) such a call still compiles, just untyped.

### Size sanity check

Measured baseline: 18,431 B (`swarm-sdk.d.ts`) + 19,109 B (`stdlib.d.ts`) = ~37 KB with zero apps/connections.

Rendered estimate (~45 B per column line, ~160 B per query overload, ~150 B per model wrapper):

| App shape | Block size |
|---|---|
| Typical (2 models × 8 cols, 4 queries, 3 actions) | ~1.6–2 KB |
| Worst legal app (10 models × 40 cols, 20 queries) | ~22–25 KB |
| 12 typical apps | ~24 KB |

Impact per consumer:
- **tsc** — one extra ~25 KB source in a program that already loads `lib.es2022.d.ts` (~1 MB) under `skipLibCheck`. Noise. Overload count (≈ total queries across apps, typically < 100) is well inside TS's comfort zone.
- **Monaco** — an extra ~50 KB on the type-defs payload, registered once per content change. Noise.
- **Agent context** — the binding constraint: `script-query-types` renders both blobs uncapped, so the app block is counted **twice**: 12 typical apps ≈ +48 KB ≈ +12k tokens on a single tool call.

⇒ Mitigation (only because that last number demands it): a `MAX_APP_TYPES_BYTES = 32 * 1024` budget in `src/apps/script-types.ts`. Apps are rendered in `createdAt ASC` order; once the accumulated block would exceed the budget, remaining apps are dropped **whole** (never mid-interface) and a trailing comment names them: `// N more app(s) omitted (type budget): <name> (<id>), … — call app-get for their shape.` Deterministic, diff-stable, and a no-op below ~16 apps. See open decision #2.

## Quick Verification Reference

All from the repo root. **Use an isolated `DATABASE_PATH` for anything that boots the API — the dev-DB fallback (`getDb()` → `initDb("./agent-swarm-db.sqlite")`, `src/be/db.ts:405-410`) silently applies migrations to the dev DB.** Unit tests are safe: `src/tests/preload.ts` installs an in-memory migration template.

```bash
bun run lint && bun run tsc:check
bun run test:root -- src/tests/<file>.test.ts
bash scripts/check-db-boundary.sh
bun run check:dep-graph
bun run check:script-types            # regenerates committed .d.ts, fails on drift
bun run docs:openapi                  # only if a route def changed
bun run check:skill-sources && bun run check:skill-md
cd apps/ui && bun run lint && bunx tsc -b
```

Isolated API for QA/E2E (port 3013 so the vite proxy needs no change):

```bash
DATABASE_PATH=/tmp/apps-typegen-e2e.sqlite PORT=3013 MCP_BASE_URL=http://localhost:3013 \
  SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true \
  bun src/http.ts > /tmp/apps-typegen-api.log 2>&1 &
```

MCP tool calls: the handshake recipe in `LOCAL_TESTING.md:99-133` (`X-Agent-ID` must be a real UUID — `AGENT_ID=$(uuidgen)`).

---

## Phase 1: Generator + contributor seam (pure, unwired)

### Overview

The renderer and its DB read land first, fully tested, with nothing consuming them yet.

### Changes Required:

#### 1. Seam definition
**File**: `src/be/scripts/type-contributors.ts` (new)
**Changes**: `export type ScriptTypeContext = { agentId?: string; repoId?: string }` and `export type ScriptTypeContributor = (context: ScriptTypeContext) => string`, with the contract in a doc comment: a contributor returns a `.d.ts` **fragment** valid both as a module body and inside `declare module "swarm-sdk" { … }`; it may only declare names it owns (prefix-namespaced) or merge into `SwarmSdk`; it must return `""` when it has nothing to contribute; it must never throw. Names the three implementations and states that a fourth (typed workflows, when `swarm-script` nodes get a typecheck gate) is one parameter on the two assembly helpers.

#### 2. Store read
**File**: `src/apps/store.ts`
**Changes**: `listAppRecords(): AppRecord[]` — same SELECT as `listApps()` (`:127-140`) but `.map(decodeApp)`, ordered `created_at ASC, id ASC` for deterministic generation order.

#### 3. Renderer
**File**: `src/apps/script-types.ts` (new)
**Changes**:
- `renderAppTypes(apps: AppRecord[]): string` — pure. Emits the preamble + `SwarmAppQueryResult<Row>` once, then per app: doc comment, `namespace App_<Pascal>` with one interface per model and the `ActionName` union, then the `SwarmSdk` merge block with one `app_query` overload per named query. Skips `definitionError` apps with a comment. Applies the `MAX_APP_TYPES_BYTES = 32 * 1024` budget with whole-app truncation + trailing omitted-apps comment. Returns `""` for zero renderable apps.
- Local helpers (not exported): `pascalIdentifier`, `dedupe`, `commentSafe` (strip newlines + `*/`, cap 80), `tsTypeForColumn`.
- `getScriptAppTypes(context: ScriptTypeContext = {}): string` — `renderAppTypes(listAppRecords())`; `context` documented as the future `app.use` filter hook (open decision #3). Wrapped so a DB error returns `""` rather than breaking every typecheck.

#### 4. Tests
**File**: `src/tests/apps-script-types.test.ts` (new; `initDb(TEST_DB_PATH)` / `closeDb` + `unlink` pattern from `src/tests/apps-spike5.test.ts:1-33`)
**Changes**: renderer unit tests over hand-built `AppRecord`s (no DB) — kind mapping incl. enum literal unions and ISO-date comment; required vs optional; hidden columns omitted; system columns present; `$param` typing incl. a param on a system column (`id`) and an enum column; no-param query → `params?: Record<string, never>`; action union; namespace derivation table cases (`"PM Inbox"`, `"spike4_scratch"`, `"  "`, non-ASCII); namespace and model-name collision suffixes; hostile app name (`*/ export const pwned = 1;` and a newline) neutralised; `definitionError` app skipped with a comment and does not abort the rest; zero apps → `""`; budget truncation drops whole apps and names them. Plus DB-level tests: `getScriptAppTypes()` over 2 created apps contains both namespaces in `createdAt` order.
- **Self-check the emitted text compiles**: one test feeds `renderAppTypes(...)` through `typecheckScript` as part of a trivial script's SDK context (Phase 2 wires that; here assert the string is syntactically valid via `ts.createSourceFile(...).parseDiagnostics.length === 0`).

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/apps-script-types.test.ts`
- [x] `bun run lint && bun run tsc:check`
- [x] `bash scripts/check-db-boundary.sh` (generator reads via `src/apps/store.ts`, server-side only)
- [x] `bun run check:dep-graph` (no new forbidden edge; `src/be/scripts` → `src/apps` is permitted)
- [x] No app regressions: `bun run test:root -- src/tests/apps-spike5.test.ts src/tests/apps-spike.test.ts`

#### Manual Verification:
- [x] Read one rendered block end-to-end (via live `GET /api/scripts/type-defs` for the PM Inbox fixture) — matches the plan sketch byte-for-byte in shape; doc comments carry app name, id, query→model mapping and params

**Implementation Note**: pause for confirmation, then commit `[phase 1] per-app script type generator + contributor seam`.

---

## Phase 2: Wire into typecheck + the three type-serving endpoints

### Overview

One parameter on each assembly helper; every existing consumer picks the block up for free.

### Changes Required:

#### 1. Assembly
**File**: `src/be/scripts/typecheck.ts`
**Changes**: import `getScriptAppTypes` from `@/apps/script-types` and `ScriptTypeContext` from `./type-contributors`; add a third parameter `appTypes = getScriptAppTypes()` to `scriptSdkTypesWithGeneratedApis` (`:395-400`) and `scriptStdlibTypesWithGeneratedApis` (`:443-448`), appended **after** the api/mcp blocks (declaration-merging order is load-bearing — the generated overloads must follow the static `SwarmSdk`). `typecheckScript` passes `getScriptAppTypes(context)`; its `context` parameter type becomes `ScriptTypeContext`. No change to the `files` Map or `createCompilerHost`.

#### 2. Endpoints
**File**: `src/http/scripts.ts`
**Changes**: `typeDefsRoute` handler (`:683-691`) and the `{name}/types` handler (`:718-746`) pass an explicit third argument (`getScriptAppTypes()` / `getScriptAppTypes({ agentId: agent.id })`) rather than relying on the default, so the two dynamic sources are visible side by side. Update `typeDefsRoute`'s `description` (`:206`) to mention per-app generated types → regenerate `openapi.json`. No new route, no RBAC posture change (both are GETs).

#### 3. Tests
**Files**: `src/tests/scripts-typecheck.test.ts` (extend), `src/tests/scripts-http.test.ts` (extend)
**Changes**:
- New `describe("per-app generated types")` in the typecheck test: create an app (enum column + a `$param` query) via `createApp`, then assert — (a) a script reading `res.data.rows?.[0].<declaredColumn>` typechecks; (b) reading a **misspelled** column errors with a diagnostic naming the identifier; (c) assigning an invalid enum literal to a filtered param errors; (d) a **dynamic** `appId` (from `args`) still compiles via the fallback overload; (e) an app whose stored definition is unparseable does not break an otherwise-valid script; (f) zero apps → unchanged behavior. (b)+(c) are the guard for merged-overload ordering.
- `scripts-http.test.ts`: `GET /api/scripts/type-defs` body contains the app namespace in **both** `sdkTypes` and `stdlibTypes` after an app exists, and contains neither before.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/scripts-typecheck.test.ts src/tests/scripts-http.test.ts src/tests/apps-script-types.test.ts`
- [x] `bun run lint && bun run tsc:check`
- [x] `bun run check:script-types` — fresh throwaway DB has no apps, so `src/scripts-runtime/types/*.d.ts` are byte-identical (no commit expected)
- [x] `bun run docs:openapi` && `git diff --stat openapi.json` shows only the type-defs description change — commit it
- [x] `bun run check:rbac-coverage` (no non-GET routes added — guard only)
- [x] Broad regression: `bun run test:root -- src/tests/scripts-mcp-e2e.test.ts src/tests/script-connections.test.ts`

#### Automated QA (isolated API on :3013, Quick Reference recipe):
- [x] `POST /api/apps` an app with an enum column + a `$param` query, then `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs | jq -r .sdkTypes | grep -c "App_"` → ≥ 1
- [x] `POST /api/scripts/upsert` (with `X-Agent-ID: $(uuidgen)`) a script that misspells a row column → 400 with a structured diagnostic naming the column; fix the spelling → 200 (diagnostic: `Property 'titel' does not exist on type 'Issue'. Did you mean 'title'?`)
- [x] Payload budget: `curl -s … /api/scripts/type-defs | wc -c` recorded before/after the app exists — 35,351 → 38,553 B (+3.2 KB for one typical app across both blobs; within the estimate)

#### Manual Verification:
- [x] Read one failing `script_upsert` diagnostic as an agent would — points at the app column with a fix suggestion (TS2551 incl. `Did you mean 'title'?`), no compiler noise

**Implementation Note**: pause, confirm, commit `[phase 2] wire per-app types into typecheck + type-defs endpoints`.

---

## Phase 3: Dashboard Monaco freshness

### Overview

Monaco already loads the assembled blobs; the only defect is a session-long cache that predates DB-driven types.

### Changes Required:

#### 1. Query freshness
**File**: `apps/ui/src/api/hooks/use-scripts.ts` (`useScriptTypeDefs`, `:50-61`)
**Changes**: replace `staleTime: Number.POSITIVE_INFINITY` with `staleTime: 60_000` (refetch on remount when stale; keep `refetchInterval: false` and `refetchOnWindowFocus: false` — the blob is tens of KB and apps change out-of-band). Correct the now-false comment: the blobs are DB-derived (connections **and** apps), not build-baked. No component change — `registerScriptTypeDefs` (`script-source-editor.tsx:21-38`) already re-registers on content change and the `useEffect` at `:79-81` covers late arrival.

#### 2. Type doc
**File**: `apps/ui/src/api/types.ts` (`ScriptTypeDefs`, `:1237`)
**Changes**: comment update only — "SDK + stdlib .d.ts (incl. generated connection + per-app types)".

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun run lint && bunx tsc -b`
- [x] `cd apps/ui && bun run check:tokens` (no styling touched — guard only)

#### Automated QA (agent-browser against `cd apps/ui && bun run dev` — `portless ui.swarm vite`, i.e. `https://ui.swarm.localhost` or `http://localhost:5274` depending on local setup; API proxy target is :3013, which the Quick Reference recipe puts on an isolated DB):
- [x] Open a script detail page (`/scripts/<id>`) → hover `ctx.swarm.app_query` shows the per-app overload (`Promise<SwarmAppQueryResult<App_PmInbox.Issue>> (+2 overloads)` with the generated doc comment), not `Promise<unknown>`
- [x] In the editable playground (`/connections` → Playground tab) `query: "` completion lists the declared query name; bad row column shows a red squiggle with quick-fix
- [x] `app-patch` the app to add a column → hard-reload the editor page → `owner` appears in row completions (staleness path)
- [x] Screenshots captured for the PR (apps/ui changes are merge-gate-enforced): /tmp/des767-shots/{A2-hover-typed,B2-query-completions,B3-typo-squiggle,B4-row-completions}.png

#### Manual Verification:
- [ ] Taras: quick editor pass — do the app namespaces make the completion list noisy?

**Implementation Note**: pause, confirm, commit `[phase 3] refresh script type-defs cache for DB-driven types`.

---

## Phase 4: Docs + skills

### Overview

Three short, factual corrections — one of them fixes a statement the SDK now contradicts.

### Changes Required:

#### 1. Scripts skill
**File**: `templates/skills/swarm-scripts/content.md` (`:138`)
**Changes**: the claim "**All SDK methods return `Promise<unknown>`**" becomes false for `app_query` with a literal `appId` + `query`. Rewrite to: SDK methods return `Promise<unknown>` **except** `app_query` against a known app, which returns `{ success, status, data: { rows?, count?, … } }` with typed rows; keep the defensive-unwrapping guidance for everything else. Regenerate `SKILL.md`.

#### 2. Apps skill
**File**: `templates/skills/apps/content.md` (near `:257`)
**Changes**: two sentences — saved scripts get generated per-app types (namespace + typed `app_query` overloads) automatically; `script-query-types` shows them; actions remain REST-only from scripts. Regenerate `SKILL.md`.

#### 3. Repo conventions
**File**: `CLAUDE.md` (the `scripts-runtime` `<important if>` block)
**Changes**: two lines — the ambient `.d.ts` is assembled per call from a static base + N **type contributors** (`src/be/scripts/type-contributors.ts`); adding one is a parameter on `scriptSdkTypesWithGeneratedApis` / `scriptStdlibTypesWithGeneratedApis`, never a compiler-host change. State the staleness posture: stored scripts are **not** re-typechecked when an app or connection changes.

### Success Criteria:

#### Automated Verification:
- [x] `bun run build:skill-md` && `bun run check:skill-md` && `bun run check:skill-sources`
- [x] `bun run check:seed-skill-files` (no `files/` touched — guard only)
- [x] `bun run lint`
- [x] Generated `SKILL.md` files committed alongside their `content.md`

#### Manual Verification:
- [x] The apps-skill sentence is true for an agent that has never seen this plan (no forward references)

**Implementation Note**: pause, confirm, commit `[phase 4] document the type-contributor seam + per-app script types`.

---

## Manual E2E (final, against a real local stack)

Isolated DB, API on :3013, vite on :5274. **Never run this against `./agent-swarm-db.sqlite`.**

```bash
# 0. Stack
rm -f /tmp/apps-typegen-e2e.sqlite*
DATABASE_PATH=/tmp/apps-typegen-e2e.sqlite PORT=3013 MCP_BASE_URL=http://localhost:3013 \
  SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true LINEAR_DISABLE=true \
  bun src/http.ts > /tmp/apps-typegen-api.log 2>&1 &
AGENT_ID=$(uuidgen)

# 1. Baseline on an empty DB: no app block, payload ~37 KB
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs \
  | jq -r '.sdkTypes' | grep -c "App_"        # → 0
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs | wc -c

# 2. Create an app (enum column + $param query + an action)
APP_ID=$(curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"PM Inbox","definition":{
        "models":{"issue":{"columns":{"title":{"kind":"string","required":true},
                                       "flag":{"kind":"enum","enum":["none","watch","urgent"]}}}},
        "queries":{"urgentIssues":{"model":"issue","filter":{"flag":"urgent"}},
                   "issueDetail":{"model":"issue","filter":{"id":{"$param":"issueId"}}}},
        "actions":{"closeIssue":{"kind":"task","prompt":"close it"}},
        "pages":{"main":{"root":"root","elements":{"root":{"type":"Container","props":{}}}}},
        "defaultPage":"main"}}' \
  http://localhost:3013/api/apps | jq -r '.app.id')

# 3. Types now carry the app — in BOTH blobs
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs \
  | jq -r '.sdkTypes' | sed -n '/App_PmInbox/,/^}/p'
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs \
  | jq -r '.stdlibTypes' | grep -c "App_PmInbox"     # → ≥ 1
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs | wc -c

# 4. Typecheck gate: wrong row column is rejected
curl -s -X POST -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d "{\"name\":\"typegen-e2e\",\"source\":\"import type { ScriptContext } from 'swarm-sdk';\nexport default async function (args: unknown, ctx: ScriptContext) {\n  const res = await ctx.swarm.app_query({ appId: '$APP_ID', query: 'urgentIssues' });\n  return res.data.rows?.map((r) => r.titel);\n}\"}" \
  http://localhost:3013/api/scripts/upsert | jq '.error, .structured[0].message'   # → typo diagnostic
# ...then rerun with r.title → 200, and with query:'urgentIssues' misspelled → still 200 (fallback overload; see open decision #1)

# 5. Run it end to end (needs a row first)
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"values":{"title":"first","flag":"urgent"}}' \
  http://localhost:3013/api/apps/$APP_ID/models/issue/rows | jq '.row.id'
curl -s -X POST -H "Authorization: Bearer 123123" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"typegen-e2e","args":{}}' http://localhost:3013/api/scripts/run | jq '.result'

# 6. Agent surface: script-query-types (MCP handshake per LOCAL_TESTING.md:99-133)
#    tools/call script-query-types with {} → details include the App_PmInbox block; record the byte size.

# 7. Schema change is picked up with no restart
curl -s -X PATCH -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"definition":{"models":{"issue":{"columns":{"owner":{"kind":"string"}}}}}}' \
  http://localhost:3013/api/apps/$APP_ID | jq '.app.definition.models.issue.columns | keys'
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs \
  | jq -r '.sdkTypes' | grep -c "owner"          # → ≥ 1

# 8. Broken definition never breaks authoring
sqlite3 /tmp/apps-typegen-e2e.sqlite "INSERT INTO apps (id,name,description,definition,created_at,updated_at) \
  VALUES ('broken-1','Broken App',NULL,'{\"models\":\"nope\"}','2026-08-06T00:00:00Z','2026-08-06T00:00:00Z');"
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs | jq -r '.sdkTypes' \
  | grep -i "broken-1"                            # → the skip comment, and step 4's script still upserts

# 9. Hostile name is neutralised
curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"name":"*/ export const pwned = 1; /*","definition":{ …minimal… }}' http://localhost:3013/api/apps >/dev/null
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/scripts/type-defs | jq -r '.sdkTypes' | grep -c "pwned"   # → 0
#     and step 4's valid script still upserts (200)

# 10. Dashboard (proxies /api → :3013): script page hover + playground completions + post-patch refresh
cd apps/ui && bun run dev   # portless: https://ui.swarm.localhost (or http://localhost:5274)
#     agent-browser: /scripts/<id> hover app_query → typed overload; playground completion on `query: "`;
#     after step 7, hard reload → `owner` appears. Screenshots for the PR.

# 11. Cleanup
kill %1; rm -f /tmp/apps-typegen-e2e.sqlite*
```

---

## Appendix

**Risks / things that could bite**
- **Merged-overload ordering** is the one non-obvious TS dependency: the generated block must be appended *after* the static `SwarmSdk`. Phase 2 tests (b)+(c) are the guard; if ordering ever flips, those tests fail loudly instead of silently degrading to `unknown`.
- **Double emission**: the block appears in `sdkTypes` and again inside `stdlibTypes`' ambient module. Required (server resolver vs Monaco ambient resolution) but it doubles the agent-context cost — the driver behind open decision #2.
- **Fallback overload swallows typos** in query names (open decision #1). The real gate this feature delivers is *row-shape* inference, not name validation.
- **`typeChecked=1` never expires** when an app's schema changes — deferred by design, identical to the pre-existing `script_connections` gap. `migrateAppSchema`'s single transaction (`src/apps/schema-migrate.ts:934-980`) remains the clean hook if it ever matters.
- **Queries are uncapped** per app (unlike models ≤10, actions ≤20), so a single pathological app can dominate the budget; the whole-app truncation keeps output valid, but a per-app cap may be worth adding if it ever happens in practice.
- **Free-form app names** are the only untrusted text reaching the compiler input — comment sanitisation + `JSON.stringify`'d literals + the hostile-name test are the mitigation.

**References**
- Research (authoritative): `thoughts/taras/research/2026-08-06-swarm-apps-script-typegen.md`
- Precedent generators: `src/be/script-connections.ts:2105-2130` (`getScriptApiTypes` / `getScriptMcpTypes`), selection at `:589-609`
- Assembly + host: `src/be/scripts/typecheck.ts:395-400, 443-448, 798-853, 922-987`
- Runtime dispatch (why this is types-only): `src/scripts-runtime/swarm-sdk.ts:433-460, 508-519`
- App schema: `src/apps/definition.ts:16,24-70,122-140,147-173,175-188`; store `src/apps/store.ts:35-140`
- Query params contract: `src/http/apps.ts:582-644`
- Result envelope: `src/tools/utils.ts:170-181,305-330`; `src/http/mcp-bridge.ts:100-102`; `src/tools/app-get.ts:76-120`
- Editor path: `apps/ui/src/components/scripts/script-source-editor.tsx:21-38`, `apps/ui/src/api/hooks/use-scripts.ts:50-61`, `apps/ui/src/pages/connections/playground-panel.tsx:233`
- Committed baseline + drift check: `scripts/bundle-script-types.ts`, `scripts/check-script-types-freshness.sh`
