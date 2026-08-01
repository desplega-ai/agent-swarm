---
date: 2026-08-01T17:30:00Z
author: claude (orchestrator session)
topic: "Swarm Apps — Spike 2 Spec (iteration loop), FROZEN"
status: frozen
branch: spike/swarm-apps
---

# Swarm Apps — Spike 2 Spec (v1, FROZEN): the iteration loop

Branch: `spike/swarm-apps` (NEVER merges to main). Builds on Spike 1 (frozen v0 spec:
./2026-08-01-swarm-apps-spike-spec.md, all committed through 7c000861). Recon references
(read these before implementing — they hold exact signatures/wiring):
`/tmp/recon2-apps-server.md`, `/tmp/recon2-workflow-patch.md`, `/tmp/recon2-skills.md`,
`/tmp/recon2-ui.md`, `/tmp/recon2-scripts-tasks.md`, `/tmp/recon2-kv-guard.md`.

## Non-goals
No app versioning/snapshots (no app_versions table — noted gap, spike 3+), no sync,
no schedules/workflows integration, no multi-page apps, no layout-primitive catalog
expansion, no human definition editor, no new npm deps, no new server capability flag
(everything stays under the `pages` capability like app-upsert).

## Slice fences
- **Orchestrator (already committed before slices start):** this spec;
  `apps/ui/src/lib/json-render/catalog.ts` gains the `app.action` action schema +
  exported `swarmCatalogSpec`; `apps/ui/scripts/generate-catalog-schema.ts`;
  generated artifact `src/apps/catalog.generated.json`.
- **Server slice (Codex sol):** `src/**`, `templates/skills/apps/**`, `scripts/**`
  (only if a check needs it), regenerated `openapi.json` + docs-site api-reference.
  MUST NOT touch `apps/ui/`. Treats `src/apps/catalog.generated.json` as READ-ONLY.
  MUST NOT git commit.
- **UI slice (Opus workflow):** `apps/ui/**` only. MUST NOT touch root `src/` except
  regenerating `src/apps/catalog.generated.json` via the generator IF it changes a
  prop/param schema (it should not need to — `app.action` is pre-added). MUST NOT
  git commit.

---

## 1. Definition schema growth: `actions` (server)

`src/apps/definition.ts` — `AppDefinition` gains:

```ts
actions?: Record<string, AppActionDef>;   // 0..20, names: same regex as models/queries

type AppActionDef =
  | { kind: "script"; scriptId: string; args?: Record<string, unknown> }  // scriptId = scripts.id uuid
  | { kind: "task"; prompt: string; agentId?: string };                    // prompt non-empty
```

Zod: discriminated union on `kind`. Semantic checks at write time (upsert/PUT/PATCH),
reported through the SAME `AppValidationIssue[] {path,message}` contract:
- `actions.<name>.scriptId` must exist in the scripts table (`getScriptById`).
- `agentId`, if present, must be a UUID (existence check NOT required — spike).

## 2. Page validator (server) — `src/apps/page-validator.ts`

Replaces the `z.record(z.string(), z.unknown())` hole for `definition.page`. Runs inside
`parseAppDefinition` (so upsert, PUT, PATCH, and the MCP tools all get it for free).
All issues use paths rooted at `page.` (e.g. `page.elements.ideasTable.props.columns`).

Input artifact: `src/apps/catalog.generated.json` (committed, generated from the UI zod
catalog — import as JSON). Shape:

```jsonc
{
  "componentTypes": ["Container", ...],
  "actionTypes": ["swarm.sdk", "swarm.call", "app.mutate", "app.refresh", "app.action"],
  "components": { "<type>": { "description": "...", "slots": ["default"]?, "props": <draft-7 JSON Schema> } },
  "actions": { "<type>": { "description": "...", "params": <draft-7 JSON Schema> } }
}
```

Checks (all statically checkable; every failure = one issue):
1. **Shape**: `page.root` is a string; `page.elements` is a non-empty record. Each element
   is an object whose allowed keys MIRROR the `@json-render/core@0.19` element type
   (read `apps/ui/node_modules/@json-render/core` .d.ts — expect `type`, `props`,
   `children`, `on`, `visible`, `repeat`; reject unknown keys with an issue).
2. **Tree**: `root` exists in `elements`; every `children` id exists; every element is
   reachable from root (orphans = issue); no cycles; an element referenced as a child by
   two parents = issue. `children` only allowed on components whose artifact entry has
   `slots` (Container, Card).
3. **Component types**: `type` ∈ `componentTypes`.
4. **Props**: validate `props` against the component's draft-7 schema with a small
   hand-rolled subset validator (`type`, `properties`, `required`, `additionalProperties`,
   `enum`, `const`, `items`, `anyOf`, nullable unions — that is all zod v4 emits for these
   plain object schemas; do NOT add ajv). **Binding exception**: any sub-value that is an
   object with exactly one key `$state` (string value) is accepted at ANY position and its
   path is collected for check 5. Objects with exactly one key `$row` / `$rowIndex` /
   `$form` are accepted only INSIDE action-chain `params` (rowActions/onSubmit/on chains).
5. **State refs**: every collected `$state` path must match `/queries/<name>[/...]` with
   `<name>` ∈ `definition.queries`, or `/forms/<formId>[/...]` where some element is a
   `Form` with `props.id === formId`, or `/actions/<name>[/...]` with `<name>` ∈
   `definition.actions`. Anything else = issue.
6. **Action chains**: chains live in element-level `on.<event>` arrays AND inside
   `Table.props.rowActions[].actions` / `Form.props.onSubmit`. For every step
   `{action, params}`:
   - `action` ∈ `actionTypes`;
   - `app.mutate`: `params.model` ∈ models; `op` ∈ create|update|delete; update/delete
     must carry `rowId` (literal string or `$row` sentinel object); if `values` is a
     plain object (not a `$form` sentinel), its literal keys must be known columns of
     the model (values that are sentinel objects are skipped);
   - `app.refresh`: literal `query` string must ∈ queries;
   - `app.action`: `params.name` ∈ `definition.actions`.

Export `validatePage(definition, catalog): AppValidationIssue[]` + keep
`parseAppDefinition`'s discriminated-union return shape unchanged.

## 3. `app-get` / `app-list` / `app-patch` MCP tools (server)

New files `src/tools/app-get.ts`, `src/tools/app-list.ts`, `src/tools/app-patch.ts`,
mirroring `src/tools/app-upsert.ts` (createToolRegistrar, toolOk/toolErr,
`swarmToolOutputSchema` loose outputs, registered in src/server.ts inside the existing
`hasCapability("pages")` block next to app-upsert; SDK map entries `app_get`, `app_list`,
`app_patch` in SDK_TOOL_NAME_MAP; then `bun run build:script-types` + commit .d.ts).

- `app-list`: input `{}`. Data: `{ apps: [{id,name,description,createdAt,updatedAt}] }`
  (summaries only, mirrors `listApps()`). details = short rendered table.
- `app-get`: input `{ appId }`. Data: full app record incl. `definition`; details =
  JSON.stringify of the record (registrar KV-overflow spill handles size — NO manual
  truncation). 404 → toolErr.
- `app-patch`: input `{ appId, name?, description? (string|null — null clears),
  definition? (object) }`. Semantics for `definition`:
  - **RFC 7396 JSON Merge Patch** against the stored definition (`null` deletes keys,
    objects merge recursively, arrays/scalars replace), EXCEPT:
  - values of the `page.elements` map and the `actions` map are **atomic subtrees**:
    a provided element/action value REPLACES the stored one wholesale (no recursive
    merge); `null` deletes the element/action.
  - Implement as `applyAppDefinitionPatch(stored, patch): AppDefinition-shaped unknown`
    in `src/apps/definition.ts` (pure; no generic deep-merge util exists in the repo —
    write it here, not in src/utils).
  - Pipeline (mirrors workflows patch tooling): load (404 → toolErr) → apply patch in
    memory → `parseAppDefinition` on the RESULT (page validator included) → on failure
    toolErr with full `issues` in BOTH details and data (identical to app-upsert) and
    NOTHING written → `updateApp` → toolOk with `{ appId, url: "/apps/<id>" }` + updated
    record in data.
  - RBAC: same `app.manage` gate via `can()` as app-upsert. app-get/app-list are reads —
    no gate (mirror HTTP GETs).

HTTP: add `PATCH /api/apps/:id` (route() factory, `rbac: { permission: "app.manage" }`)
with the same body/semantics (share `applyAppDefinitionPatch` — no divergent logic), and
normalize the list-rows `sort=` error to `{error, issues}` shape while in there (recon
flagged the inconsistency). After route changes: `bun run docs:openapi`, commit outputs.

## 4. Custom actions endpoint (server)

`POST /api/apps/:id/actions/:name` body `{ input?: Record<string, unknown> }`
(route() factory, `rbac: { permission: "app.manage" }`, gate via the existing
`authorizeAppWrite()` helper in src/http/apps.ts).

- 404 unknown app / unknown action name. 400 non-object input.
- `kind: "script"`: look up `getScriptById(scriptId)` (400 with issue-style error if
  deleted since); run-as resolution copies the script_apis precedent
  (src/http/scripts.ts:790): `runAsAgentId = script.scopeId ?? script.createdByAgentId`;
  call `runScript` with args `{ ...action.args, ...input, app: { id: appId } }`.
  Response 200:
  `{ ok: exitCode===0 && !error && !runtimeError, result, stdout, error?, durationMs }`
  (scrub through existing result shaping; never leak env).
- `kind: "task"`: `createTaskWithSiblingAwareness(` prompt + `"\n\n[App action] app=<appId>
  action=<name> input=<JSON.stringify(input)>"`, `{ source: "api", agentId:
  action.agentId /* omit → lead default */ })`. Response 200: `{ ok: true, taskId, status }`.
- Task observation is the existing ungated `GET /api/tasks/{id}` — no new endpoint.

## 5. Reserved-namespace guard `apps:*` (server)

New `src/kv-reserved-namespaces.ts`: `isReservedNamespace(ns)` (= `ns === "apps" ||
ns.startsWith("apps:")`) + `reservedNamespaceError(ns)` (message names the app surface:
"namespace is reserved for swarm apps; use the app row endpoints"). Wire into EXACTLY the
two write choke points (recon-verified): `authorizeWrite()` in `src/http/kv.ts` (→ 403)
and `kvWriteAuthError()` in `src/tools/kv/kv-write-auth.ts` (→ toolErr). Reads
(authorizeRead/kvReadAuthError) stay OPEN. Do NOT touch `src/be/db.ts` —
`src/apps/row-store.ts` writes through it directly and must keep working. Script-SDK kv
calls flow through the HTTP choke point already (no third guard).

## 6. Seeded `apps` skill (server)

`templates/skills/apps/{config.json, content.md}` modeled on `templates/skills/pages/`
(config fields incl. `runAllSeedersCandidate: true`; name MUST equal dir name; no
`files/`, so no build:seed-skill-files run). Wire two static text-imports + a
`BUILT_IN_SKILL_SOURCES` entry in `src/be/seed-skills/index.ts`.

content.md (NO frontmatter) must cover — this is the 1-call-vs-flailing surface, quality
matters: what apps are; capability-gate blockquote (pages capability); the four tools
(app-upsert / app-get / app-list / app-patch) with when-to-use; definition reference
(models: column kinds, required/default, enum always indexed, string/boolean opt-in
index, number/date never indexed, reserved column names; queries: equality filter, sort,
limit; actions: script/task kinds; page: root+elements tree, flat ids, slots/children
rule); the FULL component catalog reference (all 10 components + key props, `$state`
binding shape `{"$state": "/queries/<name>/data"}`, `$row`/`$rowIndex`/`$form` semantics,
confirm-on-destructive default); patch semantics (RFC 7396 + atomic `page.elements.*` /
`actions.*`, null-clears, "validate result, retry from issues[]"); a compact worked
example (condensed ideas tracker); an iteration recipe (app-get → edit → app-patch →
fix issues[] loop). Verify with `bun run check:skill-sources`.

Prompt mention: new template `system.agent.apps` in `src/prompts/session-templates.ts`
(registered like `system.agent.artifacts`), wired in `src/prompts/base-prompt.ts`'s
conditional suffix but gated on the NEWER `serverCapabilities` mechanism checked against
`"pages"` (`hasCapability("pages", ...)` style used by services/slack — recon2-skills.md
documents both patterns). 2–3 sentences: apps exist, use the `apps` skill, tools named.

## 7. Server tests — `src/tests/apps-spike2.test.ts`

Mirror apps-spike.test.ts harness (raw node:http around handleApps + initDb on a
dedicated sqlite path, UUID agent id, targeted beforeEach cleanup). Cover:
1. Patch: shallow name/description (+null clears description); merge-add a column;
   null-delete a query; page.elements.<id> wholesale replace (verify sibling props
   dropped, not merged); page.elements.<id> null-delete; actions.<name> atomic replace.
2. Patch validation failure (patched result invalid) → 400 issues, stored app unchanged.
3. Page validator: each check-class rejects (orphan element, missing child id, cycle,
   unknown component type, bad enum prop, `$state` to undeclared query, `$form` to
   missing form id, app.mutate unknown model, update without rowId, unknown action type,
   app.action to undeclared action) with a path-bearing issue; APP_SEED.json's page
   PASSES verbatim (regression gate).
4. KV guard: HTTP PUT/DELETE/incr on `apps:x` → 403; kv-set/kv-delete/kv-incr MCP tools
   → isError; kv-get/kv-list on `apps:*` still OK; app row create still works (row-store
   unaffected).
5. Actions: script kind end-to-end (create a trivial script via the scripts DB layer,
   invoke, assert ok+result); unknown action 404; task kind creates a task row (assert
   via GET /api/tasks/{id}).
6. MCP tools: app-get returns definition; app-list summaries; app-patch happy + issues
   round-trip (mirroring existing app-upsert test coverage style).

Verification (server slice runs ALL, must pass):
```
bun run lint && bun run tsc:check
bun run test:root -- src/tests/apps-spike2.test.ts
bun run test:root -- src/tests/apps-spike.test.ts src/tests/kv-http.test.ts src/tests/kv-tool.test.ts
bun run test:root
bash scripts/check-db-boundary.sh && bun run check:rbac-coverage
bun run check:skill-sources && bun run check:sdk-tool-registration
bun run build:script-types   # commit generated .d.ts if SDK map changed
bun run docs:openapi         # commit openapi.json + docs-site output
```

## 8. UI slice (apps/ui only)

1. **Sidebar**: "Apps" entry in `app-sidebar.tsx` directly ABOVE Approvals; lucide icon
   (`LayoutGrid` or `AppWindow`); beta marker = `Badge size="tag"` "BETA" (status-info
   tokens) wrapped in `Tooltip` ("Swarm Apps — experimental: agent-built internal apps").
   No raw palette literals (check:tokens gate).
2. **Breadcrumbs**: `breadcrumbs.tsx` — add `apps` → "Apps" routeLabel + contextual
   app-name crumb for `/apps/:id` via the existing `useApp()` hook (mirror how other
   detail crumbs resolve names).
3. **Detail page** (`pages/apps/[id]/page.tsx`): mirror the pages/[id] chrome (exempt
   from DetailPageBody — rendered-surface-dominated): PageHeader with app name,
   description, and an action cluster: Open Full, Copy chromeless link, manual Refresh.
   Keep the runtime dominant; keep the scroll-region contract
   (`flex flex-col flex-1 min-h-0 overflow-y-auto`).
4. **View modes** (query-string, mirrors pages `?mode=full` pattern via useSearchParams):
   `?mode=full` → `fixed inset-0 z-50` overlay, slim header (app name + Exit full);
   `?mode=chromeless` → the rendered page only, NO header at all (embed surface).
5. **`app.action` runtime action** (schema pre-added to the catalog by orchestrator):
   handler in the /apps/:id runtime POSTs `/api/apps/:id/actions/<name>` `{input}` via the
   existing swarm-actions HTTP helper; writes `{ status: "running"|"ok"|"error", result?,
   error?, taskId?, taskStatus? }` to json-render state at `/actions/<name>`; on script-ok
   refetch ALL queries; for task kind poll `GET /api/tasks/<taskId>` on the standard 5s
   cadence until terminal status, mirroring into `/actions/<name>/taskStatus`. Pages
   renderer registers an inert stub (same as app.mutate there). Respect the existing
   ctxRef pattern (ActionProvider snapshots handlers on mount — read fresh state through
   the ref, recon2-ui.md documents it).
6. If (and only if) a catalog schema changes: `cd apps/ui && bun run generate:catalog-schema`
   and include the regenerated `src/apps/catalog.generated.json`.

Verification: `cd apps/ui && bun install --frozen-lockfile && bun run lint &&
bun run check:tokens && bunx tsc -b`.

## 9. E2E acceptance (orchestrator, after both slices + review + commits)

Isolated stack only (API :3113, DB /tmp/apps-spike-e2e.sqlite, vite :5375). Restart the
API (new tools/routes/skill seeding) and the worker (nohup + disown, .mcp.json with
Authorization + X-Agent-ID in worker cwd). NEVER touch :3013/:5274/agent-swarm-db.sqlite.

1. Curl: PATCH /api/apps/:id merge semantics on a scratch app; invalid patch → 400
   issues; apps:* kv PUT → 403; script action invoke → ok; task action → taskId.
2. MCP client: app-list, app-get (Bookmarks), app-patch invalid (issues) + valid.
3. Browser (agent-browser): sidebar entry + beta tooltip, breadcrumbs, detail chrome,
   ?mode=full, ?mode=chromeless.
4. **Finale**: worker task "add a rating filter to the Bookmarks app" → agent must
   app-get → app-patch (add rating column + filtered query/UI its own way) → running
   app at /apps/fe3f60c8… updates within one poll. Zero-shot with ONLY the seeded skill
   + tool descriptions (no format primer in the task text — that's the point).
