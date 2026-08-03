---
date: 2026-08-02T22:00:00Z
author: claude (orchestrator session)
topic: "Swarm Apps — Spike 3 Spec (sync + PM app), FROZEN"
status: frozen
branch: spike/swarm-apps
---

# Spike 3 (FROZEN): source-bound columns + sync engine + the PM app (autopilot cluster)

Extends spikes 1/2/2.5 (specs: ./2026-08-01-swarm-apps-spike-spec.md,
./2026-08-01-swarm-apps-spike2-spec.md, ./2026-08-02-swarm-apps-spike25-catalog-spec.md).
Same branch `spike/swarm-apps`, same NEVER-merge rule. PR #1066 is the review surface.

Recon references (exact signatures/wiring — implementers MUST read before coding):
`/tmp/recon3-apps-server.md`, `/tmp/recon3-schedules.md`, `/tmp/recon3-scripts-tasks.md`,
`/tmp/recon3-connections-sources.md`, `/tmp/recon3-actions-ui.md`, `/tmp/recon3-workflows-stretch.md`.

Design decisions in force (brainstorm 2026-08-01): sync = one-way inbound projections;
synced columns READ-ONLY on every write surface; mutations agent-mediated ("Tackle");
scheduled pull + on-demand refresh = same engine, two triggers; ONE join key per
(model × source); transforms from a named allowlist; hooks stay OUT.

Recon-driven calls baked into this spec:
- **Sync engine is server-side code** (`src/apps/sync.ts`), not a swarm script — scripts
  have no row-write surface and the engine can reuse row-store's mutex/index machinery
  directly. Scripts/schedules reach it through a new `app-sync` MCP tool.
- **Source #2 = GitHub public issues** (zero credentials in the isolated DB — recon
  dispositive; Linear stays a platform-version concern). Unauthenticated, 60 req/hr cap
  is fine at spike cadence.
- **Zero apps/ui changes.** Freshness renders through existing `date`/`badge` columns;
  the sync action returns the script-kind response shape so the existing `app.action`
  runtime gives the "refreshing…" state + refetch-after-ok for free (recon3-actions-ui
  §5). There is NO UI slice this spike.
- **No new schedule targetType** — schedules use the existing `targetType:'script'`
  (migration 103) with a tiny saved script calling `ctx.swarm.app_sync(...)`.

## AMENDMENT v2 (2026-08-03, Taras): sources are DYNAMIC — script-backed by default

The frozen v1 shipped a closed connector enum (`swarm-tasks` | `github-issues`) with both
pull functions hardcoded in `src/apps/sync.ts`. That contradicts the design: **sources
must never be hardcoded** — an agent must be able to add a new source without a server
deploy. Only an internal connector like the swarm task pool may stay native.

Contract changes (everything not listed here — reconciliation, join keys, provenance,
stale semantics, read-only enforcement, entry points, freshness — is UNCHANGED):

1. `SourceDef` becomes a discriminated union on `connector`:
   ```ts
   | { connector: "swarm-tasks"; joinKey: string; config?: Record<string, scalar> }   // native, unchanged
   | { connector: "script"; joinKey: string; scriptId: string;                        // THE default kind
       args?: Record<string, unknown> }
   ```
   `github-issues` is REMOVED from the enum and from sync.ts. Its pull logic moves to a
   catalog seed script `github-issues-pull` (src/be/seed-scripts/catalog/, mirroring the
   existing gh scripts) so it stays batteries-included but lives in user-space.
2. Script-source contract: the engine calls `runScript` (same run-as resolution +
   credential wiring as the script action kind in src/http/apps.ts) with
   `args = { ...source.args, app: { id }, model, source: <name> }`. The script's return
   value MUST be `Array<{ key: string, fields: Record<string, unknown> }>` (validated
   with zod; `key` coerced via String(); record cap 500; invalid shape or
   runScript error/timeout → pass error, zero row churn). Pull still happens OUTSIDE
   the reconcile lock.
3. Validation: `scriptId` must exist (`getScriptById`, same pattern + issue wording as
   script actions); the connector-specific `config.repo` check is deleted with the enum.
4. `github-issues-pull` seed script: args `{ repo: "owner/name", state?: "open"|"closed"|"all",
   limit?: <=100 }`, validates repo shape itself (reject "."/".." segments), fetches with
   the same headers/timeout/PR-filtering/projection as the v1 connector, returns the
   record array. Seed-script registration per runbooks/seed-scripts.md.
5. Skill: source section rewritten — script sources are THE way; worked example uses
   `github-issues-pull` (find its scriptId via script tools); swarm-tasks documented as
   the one native connector; the pull-window/staleness caveat stays.
6. Tests: script-source pass (stub script via the scripts DB layer), return-shape
   rejection, missing-script validation issue, run-as + args injection; github connector
   unit tests convert to seed-script tests where sensible; swarm-tasks tests unchanged.
7. E2E migration: the two live apps (PM Inbox 6f93f0ce, scratch 12218dfe) get their
   `gh`/`github` sources patched to `{connector: "script", scriptId: <github-issues-pull>}`
   and must sync identically afterwards.

## Non-goals

No webhooks; no two-way sync / write-back; no cross-source entity resolution (union
semantics: a row belongs to at most ONE source — merging Linear+GitHub facets into one
row is platform-version); no connections-primitive integration (the spike `connector`
enum maps to the future `{connection, entity}` pair — document, don't build); no row
migration / index rebuild on schema change (existing spike limitation); no query-language
growth (equality/sort/limit stays); no hooks; no multi-page apps; no app versioning; no
per-app ACL; no new npm deps; no new capability flag (everything under `pages`).

## Slice fences

- **Orchestrator (already committed before the slice starts):** this spec. After the
  slice: E2E artifacts under `scripts/dev/` (PM-app seeds, sync-cron script source),
  progress-doc update.
- **Server slice (Codex gpt-5.6 sol):** `src/**`, `templates/skills/apps/content.md`,
  regenerated `openapi.json` + docs-site api-reference + `src/scripts-runtime/types/*.d.ts`.
  MUST NOT touch `apps/ui/**`. Treats `src/apps/catalog.generated.json` as READ-ONLY
  (no catalog change needed — verify none of your changes require one). MUST NOT git
  commit. Task-0 note: the action loop is already browser-verified on the isolated
  stack; do not change the script-kind/task-kind action contracts.

---

## 1. Definition schema growth (`src/apps/definition.ts`)

### 1a. Model-level `sources` map

```ts
// inside ModelDef
sources?: Record<string, SourceDef>;   // 0..4 entries, names: same regex as models/queries

type SourceDef = {
  connector: "swarm-tasks" | "github-issues";
  joinKey: string;          // column name in THIS model; declared ONCE per (model × source)
  config?: Record<string, string | number | boolean>;  // flat scalars, connector-specific
};
```

### 1b. Column-level source binding

```ts
// inside ColumnDef
source?: {
  of: string;               // key in the model's `sources` map
  field: string;            // dotted path into the connector's record projection (see §4)
  transform?: "slug" | "lower" | "upper" | "cents" | "date-parse";
};
```

### 1c. Semantic checks (same `AppValidationIssue[] {path, message}` contract, added in
`parseAppDefinition` next to the existing script-existence check — recon3-apps-server §3)

Every failure = one path-bearing issue (paths like `models.issue.sources.gh.joinKey`,
`models.issue.columns.title.source.of`):

1. `sources.<name>.joinKey` references an existing column of the SAME model with
   `kind: "string"`.
2. Connector-specific required config: `github-issues` requires `config.repo` matching
   `^[\w.-]+\/[\w.-]+$`; `swarm-tasks` has no required config. Unknown config keys are
   allowed (flat scalars only, enforced by the zod shape).
3. `columns.<col>.source.of` references an existing key of the model's `sources` map;
   `field` non-empty.
4. Transform/kind compatibility: `slug`/`lower`/`upper` only on `kind:"string"` columns;
   `cents` only on `kind:"number"`; `date-parse` only on `kind:"date"`.
5. The join-key column MUST NOT itself carry a `source` binding (it is implicitly
   managed by the engine) and MUST NOT be `required` or carry a `default`.
6. Source-bound columns MUST NOT be `required` and MUST NOT carry a `default` (sync may
   legitimately write null; defaults would lie).
7. If a model declares any `sources`, every REQUIRED owned column of that model must
   carry a `default` (otherwise sync-created rows could never satisfy it).

### 1d. New reserved row-field names

Add `source`, `syncedAt`, `stale` to the reserved column-name check in
`ModelDefSchema`'s superRefine (currently `id`/`createdAt`/`updatedAt` —
recon3-apps-server §5).

### 1e. `sync` action kind (third `AppActionDefSchema` variant)

```ts
| { kind: "sync"; model?: string; source?: string }
```

Semantic checks: `model`, if present, exists and has a non-empty `sources` map;
`source`, if present, exists on the named model (or on at least one model when `model`
is omitted). An app with a sync action but zero (model × source) pairs matching = issue.

### 1f. Merge-patch atomicity growth (`applyAppDefinitionPatch`)

`models.<name>.columns.<col>` and `models.<name>.sources.<src>` values become **atomic
subtrees** (whole-replace, `null` deletes), exactly like `page.elements.<id>` /
`actions.<name>` today. Rationale: deep-merging a column def can splice half of an old
`source` binding into a new one; zod's required `kind` makes accidental partial
replacements fail loudly. Update the skill's patch-semantics section accordingly.

## 2. Read-only enforcement (`src/apps/row-store.ts`)

`prepareValues()` is the single choke point for create + patch (recon3-apps-server §4).
It gains an options bag `{ allowSourceManaged?: boolean }` (default false):

- When false (ALL external surfaces: HTTP row create/patch/bulk — there are no MCP row
  tools), a write touching a source-bound column OR a join-key column is rejected with a
  path-bearing issue: `{ path: "<col>", message: "column is a read-only projection from
  source \"<src>\"; mutate it via the source or a sync-refresh" }` (join-key wording:
  "column is the sync join key and is managed by the sync engine").
- Reserved sync fields (`source`/`syncedAt`/`stale`) already fail the unknown-column
  check — keep that behavior.
- When true (sync engine only), source-bound + join-key writes are allowed; `required`
  checks are skipped for source-bound columns (they can't be required anyway per §1c.6).

## 3. Row envelope: provenance + freshness

`AppRow` stays FLAT (`{id, ...values, createdAt, updatedAt}`), gaining three optional
system fields written ONLY by the sync engine:

```ts
source?: string;      // the sources-map key this row is projected from
syncedAt?: string;    // ISO — last time this row was confirmed present in the source
stale?: boolean;      // true = row vanished from the source on a later pass (kept, flagged)
```

- Owned (non-synced) rows never carry these fields.
- `syncedAt` becomes a **sortable system field** in `applyQuery` (alongside
  `createdAt`/`updatedAt`); `stale`/`source` are NOT sortable/filterable server-side —
  client-side `Table.filters` covers them (e.g. `{"stale": true}`).
- Freshness surfacing needs ZERO new UI: a Table column `{key:"syncedAt", kind:"date"}`
  renders via formatSmartTime; `{key:"stale", kind:"badge", tones:{"true":"warning"}}`
  flags stale rows (recon3-actions-ui §3).

## 4. Sync engine (`src/apps/sync.ts`)

### Connector interface (two concrete pull functions, NO framework)

```ts
type SourceRecord = { key: string; fields: Record<string, unknown> };
type Connector = {
  pull(config: Record<string, string | number | boolean>): Promise<SourceRecord[]>;
};
export const CONNECTORS: Record<"swarm-tasks" | "github-issues", Connector>;
```

**swarm-tasks** (internal — direct DB read, this is API-server code): config
`{ status?: string /* comma-list filter */, limit?: number <= 200 (default 100),
includeHeartbeat?: boolean (default false) }`. `key = task.id`. `fields` projection
(flat, camelCase): `id, status, prompt (truncated to 1000 chars), source, agentId,
tags, priority, createdAt, updatedAt, vcsProvider, vcsNumber, vcsUrl, vcsAuthor`
(fields per recon3-scripts-tasks §Q4; reuse the internal list query, not HTTP).

**github-issues**: config `{ repo: "owner/name" (required), state?: "open"|"closed"|"all"
(default "open"), limit?: number <= 100 (default 50) }`. One GET
`https://api.github.com/repos/<repo>/issues?state=<state>&per_page=<limit>` with headers
`Accept: application/vnd.github+json`, `User-Agent: agent-swarm-apps-sync`, 10s
AbortController timeout. Filter out entries carrying a `pull_request` key (the issues
endpoint includes PRs). `key = String(issue.number)`. `fields` projection (flat,
camelCase): `number, id, title, state, body (truncated to 1000), userLogin
(= user.login), labelsCsv (= labels[].name joined ","), comments, htmlUrl, createdAt,
updatedAt`. Non-2xx → the pass FAILS with the status in the error (no row changes).
This is a fixed-host fetch — consistent with repo convention, no SSRF guard involved
(recon3-connections-sources §5).

### Pass algorithm

```
runSyncPass(app, modelName, sourceName) -> SyncPassResult
  source = model.sources[sourceName]; records = CONNECTORS[source.connector].pull(config)
  existing = listAppRows(app.id, modelName)
  mine = rows where row.source === sourceName, keyed by row[source.joinKey]
  now = ISO timestamp; seen = Set
  for each record (cap: connector limits above):
    values = { [source.joinKey]: record.key }
    for each column bound to this source:
      raw = getByDottedPath(record.fields, binding.field)
      values[col] = applyTransform(raw, binding.transform, column.kind)
        // wrong-type / invalid enum / failed transform → null + a warning entry
        // (pass keeps going; warnings capped at 20 in the result)
    if match = mine.get(record.key):
      write only if some projected value differs OR match.stale
      → patch via row-store with { allowSourceManaged: true },
        setting syncedAt = now, stale = false; owned columns UNTOUCHED
    else:
      create via row-store with { allowSourceManaged: true }: projected values +
      owned-column defaults + source/syncedAt/stale envelope fields
      (respect the existing per-model row cap — hitting it fails the pass with an error)
    seen.add(record.key)
  for row in mine where key ∉ seen and row.stale !== true:
    patch stale = true (syncedAt UNCHANGED — it records last confirmed presence)
  return { model, source: sourceName, connector, pulled, created, updated, unchanged,
           markedStale, warnings, durationMs, error? }
```

Transforms (`applyTransform`): `slug` = lowercase, non-alphanumeric runs → `-`, trimmed;
`lower`/`upper` = String case; `cents` = `Math.round(Number(v) * 100)` (NaN → null +
warning); `date-parse` = `new Date(v).toISOString()` (invalid → null + warning). No
transform: value passes through the same kind-coercion rules external writes use.

Passes for one app run SEQUENTIALLY (reuse the per-model write mutex via row-store —
do not hand-roll locking in sync.ts). `runAppSync(app, {model?, source?})` expands to
all matching (model × source) pairs and returns `{ ok, passes: SyncPassResult[] }`
(`ok` = every pass error-free); zero matching pairs is an error for the HTTP/action
callers (400 issue-style) and a `toolErr` for the MCP tool.

## 5. Entry points (one engine, three doors)

1. **HTTP** `POST /api/apps/{id}/sync` body `{ model?: string, source?: string }` —
   route() factory, `rbac: { permission: "app.manage" }`, `authorizeAppWrite()` like the
   actions endpoint. 404 unknown app; 400 (issues[]) zero matching pairs / unknown
   model/source. 200 → `{ ok, passes }`.
2. **Action kind `sync`** — new branch in the actions endpoint (`src/http/apps.ts`,
   next to script/task kinds): runs `runAppSync` synchronously and responds
   `{ ok, result: { passes }, ...(error), durationMs }` — the SAME key shape as the
   script kind (NO `taskId`), so the existing UI `app.action` runtime shows
   running→ok/error and refetches all queries with zero changes. Verify against
   `apps/ui/src/pages/apps/[id]/page.tsx:314-360` (recon3-actions-ui §1) — match, do
   not modify the UI.
3. **MCP tools** (files mirroring `src/tools/app-get.ts`; registered in the
   `hasCapability("pages")` block in src/server.ts; `toolOk`/`toolErr` +
   `swarmToolOutputSchema` loose outputs; NUDGES only via the central map):
   - `app-sync`: input `{ appId, model?, source? }` → runs `runAppSync`; details = short
     rendered per-pass table; data `{ passes }`.
   - `app-query`: input `{ appId, query }` (named query) → same `applyQuery` path as
     `GET /api/apps/{id}/queries/{name}`; details = rendered table (registrar overflow
     spill handles size — NO manual truncation); data `{ rows, count }`. This is the
     "agents are end-users" primitive the digest stretch needs (rows are otherwise
     unreachable from scripts — recon3-workflows-stretch §1).
   - SDK map entries `app_sync`, `app_query` in `SDK_TOOL_NAME_MAP`, then
     `bun run build:script-types` and commit the regenerated `.d.ts`.
4. **Schedules** — NO server code. E2E wires: saved script (orchestrator artifact,
   committed at `scripts/dev/app-sync-cron.script.ts`) whose body is essentially
   `await ctx.swarm.app_sync({ appId: args.appId })` + a schedule row with
   `targetType: "script"` (create/trigger shapes: recon3-schedules.md; immediate fire
   via `POST /api/schedules/{id}/run`, scheduler ticks in-process on :3113).

## 6. Seeded `apps` skill (`templates/skills/apps/content.md`)

New "Synced sources" section — this is the 1-call-vs-flailing surface for the PM finale,
quality matters: model `sources` map (connector enum + per-source `joinKey` + config
reference for both connectors incl. the exact `fields` projections from §4); column
`source` bindings `{of, field, transform?}` + the transform allowlist + compatibility
rules; the read-only contract (synced + join-key columns reject direct writes — mutate
via source or refresh); row system fields `source`/`syncedAt`/`stale` + the freshness
recipe (`syncedAt` date column, `stale` badge column, `syncedAt` sortable); the `sync`
action kind + Refresh-button recipe (Button → `app.action` → status badge at
`/actions/<name>/status`); `app_sync`/`app_query` tools with when-to-use; Tackle recipe
(task-kind action invoked from `rowActions` with `input: { issue: { "$row": "" } }` —
whole-row context lands in the task prompt); required-owned-columns-need-defaults rule;
updated patch semantics (columns/sources entries now atomic). Update the component/
binding reference tables in place; keep existing style (tables, escaped pipes).
Verify `bun run check:skill-sources`.

## 7. Tests (`src/tests/apps-spike3.test.ts`, mirroring the spike-2 harness)

1. **Schema**: a full sources+bindings definition parses; every §1c check rejects with
   the right path (bad joinKey ref, joinKey→number column, missing github repo, bad
   `of` ref, transform/kind mismatch, binding on join-key column, required source-bound
   column, sources-model with defaultless required owned column, sync action → unknown
   model/source); reserved names `source`/`syncedAt`/`stale` rejected as column names.
2. **Read-only**: HTTP row create + patch rejecting source-bound and join-key columns
   with path-bearing issues; owned columns on the same model still writable; bulk
   endpoint enforces too.
3. **Sync pass** (github connector: mock `globalThis.fetch` per bun-test convention —
   beware mock.module leaks, keep to fetch stubbing; swarm-tasks connector: seed real
   task rows through the DB layer): first pass creates rows with
   source/syncedAt/stale=false + join key + transforms applied; second pass with
   changed source data updates ONLY projected columns (an owned column hand-set via
   sync-internal write stays untouched); unchanged records don't rewrite (unchanged
   count); record disappearance marks stale=true (syncedAt unchanged); reappearance
   clears stale; invalid enum/number → null + warning; pull failure (non-2xx) → pass
   error, zero row churn.
4. **Endpoints**: `POST /api/apps/:id/sync` happy + 404 + 400-no-pairs; `sync`-kind
   action through the actions endpoint returns the script-kind-shaped response (assert
   `taskId` absent, `ok`/`result.passes` present).
5. **MCP**: `app-sync` + `app-query` round-trips (register agent, real client —
   mirroring existing app-tool test style).
6. **Regressions**: Bookmarks fixture + APP_SEED page still pass `parseAppDefinition`;
   spike-2 patch tests still green with the new column/source atomicity (adjust ONLY the
   spike-2 assertions that asserted deep-merge of column defs, if any).

## 8. Verification (server slice runs ALL, must pass)

```
bun run lint && bun run tsc:check
bun run test:root -- src/tests/apps-spike3.test.ts
bun run test:root -- src/tests/apps-spike.test.ts src/tests/apps-spike2.test.ts
bun run test:root
bash scripts/check-db-boundary.sh && bun run check:rbac-coverage
bun run check:skill-sources && bun run check:sdk-tool-registration
bun run build:script-types   # commit regenerated .d.ts (SDK map grew)
bun run docs:openapi         # commit openapi.json + docs-site output
```

## 9. E2E acceptance (orchestrator, isolated stack ONLY)

API :3113 (restart to pick up code — NOTE: must export `MCP_BASE_URL=http://localhost:3113`;
the repo `.env` carries a dead ngrok URL that Bun auto-loads and runScript falls back to —
this broke task 0 until fixed), vite :5375, worker relaunch (new skill + tools). NEVER
touch :3013/:5274/agent-swarm-db.sqlite.

1. Curl: definition with sources upserts; synced-column direct write → 400 path-bearing
   issue; `POST /sync` pulls swarm tasks + GitHub issues into rows (verify provenance
   fields); config-narrowing patch (e.g. state open→closed) → vanished rows flagged
   stale; re-widen → stale clears.
2. MCP client: `app-sync`, `app-query`, plus an `app-patch` carrying a sources model.
3. Schedule: create `targetType:'script'` schedule → immediate-run endpoint → rows
   appear (schedule leg proven without waiting for cron).
4. **PM-app finale (zero-shot, the point of the spike)**: worker task, NO format primer:
   build "PM Inbox" — Issue model synced from the swarm's own task pool AND a public
   GitHub repo, inbox layout (2.5 catalog: Split/Tabs/SearchInput/filters), freshness
   columns, a Refresh `sync` action with observable status, and a "Tackle" task-kind
   rowAction carrying the row. Agent must get there with ONLY the seeded skill + tool
   descriptions (app-upsert/app-patch loop, 0-rejection target like spikes 1/2).
5. Browser (agent-browser): synced rows visible in the running app; Refresh click →
   running→ok + row deltas; Tackle click → task spawns, taskStatus mirrors to terminal;
   stale badge renders after a narrowing patch.
6. **Stretch (autopilot)**: workflow with a `swarm-script` node whose script calls
   `ctx.swarm.app_query` on the PM app + `page_create` for a digest page; wire a
   cron-style schedule `targetType:'workflow'`; trigger once and link the digest
   (shapes: recon3-workflows-stretch.md — note the swarm-script `{{path}}` raw-value
   interpolation gotcha).
