# Swarm Apps — Spike Spec (v0, FROZEN)

Branch: `spike/swarm-apps` (from main @ 4a192581). Throwaway-lean per Taras's call:
one `apps` table with the WHOLE definition embedded as JSON; server-native CRUD over KV;
UI renders via the existing json-render pages stack. This branch never merges to main.

Source brainstorm: thoughts/taras/brainstorms/2026-08-01-swarm-apps.md

## Non-goals (do NOT build)
No sync/provenance/join keys, no hooks, no schedules integration, no app versioning,
no guest sharing, no action taxonomy beyond CRUD, no changes to the existing kv tool
surface, no worker image changes, no two-way anything.

## Slice fences
- **Server slice (Codex)**: only `src/**`, `scripts/**` (if a check needs an allowlist entry),
  `openapi.json` + `docs-site/content/docs/api-reference/**` (regenerated). MUST NOT touch `apps/ui/`.
  MUST NOT git commit.
- **UI slice (Opus agent)**: only `apps/ui/**`. MUST NOT touch root `src/`. MUST NOT git commit.

---

## 1. AppDefinition schema (server-side zod — new file `src/apps/definition.ts`)

```ts
// names: /^[a-z][a-zA-Z0-9_]{0,39}$/ for model + column + query names
// reserved column names (reject): id, createdAt, updatedAt

type ColumnKind = 'string' | 'number' | 'boolean' | 'date' | 'enum';

interface ColumnDef {
  kind: ColumnKind;
  required?: boolean;            // default false; enforced on create only
  enum?: string[];               // required iff kind === 'enum', non-empty, unique
  index?: boolean;               // secondary index rows; enum columns are ALWAYS indexed
  default?: string | number | boolean;  // static default applied at create, must match kind
}

interface ModelDef { columns: Record<string, ColumnDef> }  // 1..40 columns

interface AppQueryDef {
  model: string;                                    // must exist in models
  filter?: Record<string, string | number | boolean>; // equality only; cols must exist
  sort?: { column: string; dir: 'asc' | 'desc' };   // model column or createdAt/updatedAt
  limit?: number;                                   // default 200, max 1000
}

interface AppDefinition {
  models: Record<string, ModelDef>;    // 1..10 models
  queries?: Record<string, AppQueryDef>;
  page: Record<string, unknown>;       // json-render tree; server validates "is an object" only
}
```

Validation errors are the agent-retry contract: HTTP 400 with
`{ error: "invalid app definition", issues: [{ path: "models.idea.columns.status.enum", message: "..." }] }`.
Use zod's error flattening to produce `issues`.

## 2. Migration

`src/be/migrations/124_apps_spike.sql` (highest existing is 123_slack_messages.sql; follow existing file style — leading comment explaining the table):

```sql
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 3. KV layout + write path (new `src/apps/row-store.ts`, server-side; may import src/be)

- Row:   `app/<appId>/<model>/row/<rowId>`  → JSON row
- Index: `app/<appId>/<model>/idx/<col>/<encodeURIComponent(String(val))>/<rowId>` → "1"
  - maintained for: kind === 'enum', plus any column with index: true whose kind is
    string | boolean | enum. Numbers/dates are NOT indexable in v0.
- Row shape: `{ id: crypto.randomUUID(), createdAt: ISO, updatedAt: ISO, ...columns }`
- Storage: use the exported KV helpers in `src/be/db.ts` directly (server-side code may import
  src/be — this is API-server code): `getKv(namespace, key)`, `upsertKv({namespace, key, value,
  valueType: 'json'})`, `deleteKv(namespace, key)`, `listKv(namespace, {prefix, limit, offset})`
  (ORDER BY key asc, prefix LIKE-escaped), `countKv(namespace, {prefix})`. Full reference:
  /tmp/recon-kv.md.
- Namespace = `apps:<appId>`; key = `<model>/row/<rowId>` and `<model>/idx/<col>/<enc>/<rowId>`.
  Namespace+key must satisfy KV_NAME_REGEX (/^[a-zA-Z0-9._:/%-]{1,512}$/) — we only write via
  db helpers (validation lives at the HTTP boundary), and enc = encodeURIComponent output only
  contains regex-legal chars. Cap enc(val) segments at 128 chars (truncate) so keys stay <512.
- Scans: listKv with prefix `<model>/row/` and a large limit (pass limit: 100000, offset 0 —
  the db helper has no internal cap; the 1000 cap is HTTP-layer only). App purge: loop
  listKv(namespace, {prefix: '', ...}) + deleteKv each (spike scale), or add a
  `deleteKvByNamespace(namespace)` helper next to the other KV helpers in db.ts if cleaner.
- Trait validation on every write (create: apply defaults, then required check; patch:
  unknown columns rejected, kind check per provided column; setting a required column to
  null is rejected). date = ISO-8601 parseable string, stored as string.
- **Write serialization**: in-process mutex per `${appId}:${model}` — a
  `Map<string, Promise<unknown>>` promise chain. ALL row mutations (create/patch/delete/bulk,
  and app-delete purge) run through it. Reads bypass.
- Update: if an indexed column's value changed → delete old idx key + write new, same
  logical operation as the row write (sequential under the mutex is fine; no cross-key txn exists).
- Delete row: delete row key + all its idx keys.
- Delete app: prefix-purge `app/<appId>/`.

## 4. HTTP endpoints (new `src/http/apps.ts`, route() factory, registered in all-routes.ts)

Apps (definition CRUD):
- `GET    /api/apps`               → `{ apps: [{id,name,description,createdAt,updatedAt}] }` (no definition)
- `POST   /api/apps`               body `{name, description?, definition}` → 201 `{ app }`
- `GET    /api/apps/:id`           → `{ app }` (incl. definition)
- `PUT    /api/apps/:id`           body `{name?, description?, definition?}` → `{ app }` (re-validate; NO row
                                     migration/index rebuild on schema change in v0 — document in a comment)
- `DELETE /api/apps/:id`           → `{ ok: true }` (also purges `app/<id>/` KV prefix)

Rows (server-native CRUD):
- `POST   /api/apps/:id/models/:model/rows`        body `{values}` → 201 `{ row }`
- `POST   /api/apps/:id/models/:model/rows/bulk`   body `{rows: [{values}]}` (max 500) → `{ rows }`
- `GET    /api/apps/:id/models/:model/rows`        query `filter.<col>=v` (repeatable), `sort=<col>:<asc|desc>`,
                                                    `limit` → `{ rows, total }`
                                                    impl: prefix scan + in-server equality filter/sort/limit;
                                                    single-equality-filter-on-indexed-col MAY use the idx prefix.
- `GET    /api/apps/:id/models/:model/rows/:rowId` → `{ row }`
- `PATCH  /api/apps/:id/models/:model/rows/:rowId` body `{values}` → `{ row }`
- `DELETE /api/apps/:id/models/:model/rows/:rowId` → `{ ok: true }`

Named queries (what the UI polls):
- `GET    /api/apps/:id/queries/:name` → `{ rows }` (resolves the AppQueryDef)

Errors: 404 unknown app/model/row/query; 400 `{ error, issues? }` for validation.
RBAC: every non-GET declares `rbac: { permission: "app.manage" }`; register the new verb
`app.manage` in the PERMISSIONS object in src/rbac/permissions.ts and wire it in
src/rbac/legacy-policy.ts using the most permissive existing rule that fits (e.g.
`anyAuthenticated`) — this is a spike, mirror how the closest existing feature (pages)
does it; handlers call `can({principal, verb, source})` and gate on `decision.allow`.
Exact patterns + can() signature: /tmp/recon-routes.md.
After adding the route file: import in src/http/all-routes.ts, run `bun run docs:openapi`,
keep regenerated openapi.json + docs-site api-reference output.

## 5. MCP tool `app-upsert` (new `src/tools/app-upsert.ts`)

Mirror src/tools/create-page.ts structure. Input: `{ name, description?, definition, appId? }`
(definition as object). Validates with the SAME zod as the route. On failure: `toolErr` with
the full `issues` list in details (this IS the agent retry loop). On success: `toolOk` with
`{ appId, url: "/apps/<id>" }`-style details. Register wherever create-page registers, and
add to SDK_TOOL_NAME_MAP in src/scripts-runtime/sdk-allowlist.ts (mirroring create-page's
treatment; if create-page is EXCLUDED, exclude app-upsert with reason "spike").
If SDK map is touched → run `bun run build:script-types` and commit generated .d.ts per CLAUDE.md.

## 6. Server tests (`src/tests/apps-spike.test.ts`, follow existing http-test conventions)

1. definition validation: accept ideas-tracker def; reject unknown kind, enum without values,
   reserved column name, query referencing missing model/column.
2. row CRUD happy path incl. defaults applied, updatedAt changes on patch.
3. trait validation failures (wrong type, enum non-member, required missing) → 400 with issues.
4. index rewrite: create with status=open → idx key exists; patch to done → old idx key gone,
   new one present; delete → both gone.
5. concurrency: Promise.all(30 creates) → 30 rows, 30 idx keys, no lost writes.
6. named query: filter + sort + limit correct.
7. app delete purges all row+idx keys.

Verification commands (server slice must run + pass ALL):
```
bun run lint
bun run tsc:check
bun run test:root -- src/tests/apps-spike.test.ts
bun run test:root
bash scripts/check-db-boundary.sh
bun run check:rbac-coverage
bun run docs:openapi   # then git status must show only expected regenerated files
```

## 7. UI slice (apps/ui only — frozen against the API contract above)

- Routes: `/apps` (minimal list: name + link) and `/apps/:id` (the app runtime), registered
  in apps/ui/src/app/router.tsx (react-router-dom createBrowserRouter, follow the lazy pattern
  used by sibling routes). Data fetching follows the repo convention: @tanstack/react-query
  hooks in src/api/hooks/<domain>.ts with 5s refetchInterval (the existing polling default).
  API access via the existing ApiClient (src/api/.../client.ts) — do NOT hand-roll a third
  bearer/base-url resolver (there are already duplicated copies; reuse ApiClient or the
  renderer's existing helpers). Full stack reference: /tmp/recon-ui.md.
- IMPORTANT catalog reality: the current catalog + registry + actions all live inside
  apps/ui/src/pages/pages/[id]/json-page-renderer.tsx (single file). Extract the catalog +
  registry setup into a shared module under apps/ui/src (so the pages renderer and the new
  app runtime both use it), then extend it with the new components. Keep the pages renderer
  behavior unchanged. RepeatScopeProvider ($item/$index) exists in @json-render/react 0.19.0
  but is currently unused — the Table rowActions implementation may use it, or Table may
  render rows directly in React and invoke action chains programmatically per row.
- `/apps/:id` runtime:
  1. GET /api/apps/:id → definition.
  2. For each `definition.queries` entry: GET /api/apps/:id/queries/<name>, store into
     json-render state at `/queries/<name>` as `{ data: rows, loading, error }`; poll every 5s.
  3. Render `definition.page` with the existing json-render stack (same providers as the
     pages renderer) + extended catalog + two new actions:
     - `app.mutate` `{ model, op: 'create'|'update'|'delete', rowId?, values? }` → call the
       rows API → refetch all queries whose model matches → clear the originating form state on create.
     - `app.refresh` `{ query? }` → refetch one/all queries.
- Catalog additions (extend the existing swarmCatalog — shared file, apps-usable from pages too):
  - `Table`: `{ data: <binding to /queries/x/data>, columns: [{key,label}], rowActions?: [{label, actions}] }`
    (rowActions receive `$item`); use existing dashboard table components/styling.
  - `Form`: `{ id, fields: [{name,label,kind: 'string'|'number'|'boolean'|'date'|'enum', options?}],
    submitLabel, onSubmit: <action chain> }` — field values live in json-render state under
    `/forms/<id>/<name>` via $bindState; onSubmit runs with the collected values.
  - `Badge` (status pill), `Select`/`Input` only if Form needs them as catalog-level nodes —
    otherwise keep them internal to Form.
- Reuse existing shadcn/dashboard primitives; NO new npm deps.
- Loading/error/empty states for Table required (empty state message prop with default).

Verification (UI slice must run + pass):
```
cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b
```

## 8. Seed — ideas tracker (hand-authored first test)

Create via `POST /api/apps` (curl doc; write `scripts/dev/seed-ideas-app.ts` or a .sh with the
JSON inline — server slice owns this file):

- models.idea: title(string, required), status(enum: open|in_progress|done, default open),
  votes(number, default 0), notes(string)
- queries.allIdeas: { model: idea, sort: { column: createdAt, dir: desc } }
- page: Container[ Heading "Ideas", Form(title, notes → app.mutate create idea),
  Table(allIdeas: title, status(Badge), votes; rowActions: "Start"(status→in_progress),
  "Done"(status→done), "Delete") ]

The exact page JSON is authored by the UI slice (it knows the final catalog props) and placed
in the seed file location as `apps/ui/APP_SEED.json` — server seed script reads it if present,
else uses a minimal inline fallback. (Keeps the fence: UI owns page JSON, server owns the script.)

## 9. E2E acceptance (orchestrator runs after both slices)

1. Fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` boots, migration applies.
2. Seed script creates the ideas app; curl CRUD round-trip works; query endpoint returns sorted rows.
3. Dashboard `/apps/:id` renders the tracker; create via form; status advance via row action;
   delete; list updates within one poll cycle.
4. `app-upsert` MCP tool: invalid definition returns machine-readable issues; valid returns appId.
