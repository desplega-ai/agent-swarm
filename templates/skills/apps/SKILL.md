---
name: apps
description: Build and iterate on schema-backed Swarm Apps with live models, named queries, custom actions, and json-render interfaces using the app-upsert, app-get, app-list, and app-patch tools.
---

# Swarm Apps

Swarm Apps are persistent, agent-authored internal applications: a schema-backed row store, named queries, custom script/task actions, and a validated json-render interface served at `/apps/<id>`. Use an app when people need to view and change live records; use `create_page` for a static snapshot.

> **Capability gate**: app tools are available when the server's `CAPABILITIES` includes `pages` (for example `CAPABILITIES=core,task-pool,pages`). There is no separate `apps` capability. If these tools are absent from your MCP list, this is why.

## Tools and iteration loop

| Tool | Use it for |
|---|---|
| `app-list` | Discover apps by id, name, description, and timestamps. Definitions are omitted. |
| `app-get` | Read one complete stored definition before changing it. |
| `app-upsert` | Create an app, or replace an existing app's entire definition when you intentionally have the full desired state. |
| `app-patch` | Make a focused change while preserving everything not mentioned in the patch. Prefer this for iteration. |
| `app-query` | Run one declared named query and return its rows. Use this when an agent or saved script needs to consume app data rather than render the app UI. |
| `app-rows-list` | List rows with typed equality filters, sorting, and a limit. Returns `{ rows, total }`. |
| `app-row-get` | Read a row by `rowId`. Returns `{ row }`. |
| `app-row-create` | Create a row from `values`. Returns `{ row }`. |
| `app-rows-create` | Create 1 to 500 rows from a `rows: values[]` array, within 10 MiB. Returns `{ rows }`. |
| `app-row-patch` | Patch a row by `rowId` with `values`. Returns `{ row }`. |
| `app-row-delete` | Delete a row by `rowId`. Returns `{ ok: true }`. |
| `app-rows-delete` | Delete matching rows with a non-empty `equals` filter. Returns `{ deleted }`. |
| `app-action-run` | Run a declared script, task, or sync action with `{ appId, action, input? }`. Agents can invoke it through MCP only. |
| `app-history` | List definition snapshots and their compact model/column digests before choosing a restore point. |
| `app-diff` | Show a unified definition diff; defaults to newest snapshot → CURRENT. |
| `app-rollback` | Restore a snapshot through the normal schema-migration engine. |

For every edit: `app-get` -> modify the smallest coherent subtree -> `app-patch` -> if rejected, fix every returned `issues[]` entry (`path` + `message`) and retry. Validation happens before storage, so a rejected update leaves the saved app unchanged. Do not guess at the current definition or use `app-upsert` with a partial definition.

`app-patch` can also change `name`; omit `description` to preserve it or pass `description: null` to clear it.

### Reading an app's callable surface

One `app-get` returns everything needed to drive an app you did not write: `definition.queries` are runnable with `app-query` (supply every `$param` the query references), and `definition.actions` are invocable with `app-action-run` or `POST /api/apps/<id>/actions/<name>` (a `script` action runs its script, a `task` action spawns a task, a `sync` action refreshes sources). Read the query parameters and action arguments from the definition before invocation. Do not guess parameter names.

### Verified action caller

Script actions receive `caller` as a reserved, server-stamped argument. The server overwrites `caller` from definition defaults and request input.

```typescript
type AppActionCaller = {
  kind: "user" | "agent" | "operator" | "guest";
  id: string | null;
  name?: string;
  pageId?: string;
};
```

The caller identifies the authenticated user or agent. Operator and guest callers have `id: null`. A signed page session adds `pageId`.
With the swarm key, a registered `X-Agent-ID` produces an agent caller and `agent:<id>` row provenance. Missing or unknown agent IDs remain operator callers.
Task actions include the same caller as server-verified JSON in the task prompt. Script execution still uses the saved script owner's bindings.

### Verified action caller

Script actions receive `caller` as a reserved, server-stamped argument. The server overwrites `caller` from definition defaults and request input.

```typescript
type AppActionCaller = {
  kind: "user" | "agent" | "operator" | "guest";
  id: string | null;
  name?: string;
  pageId?: string;
};
```

The caller identifies the authenticated user or agent. Operator and guest callers have `id: null`. A signed page session adds `pageId`.
With the swarm key, a registered `X-Agent-ID` produces an agent caller and `agent:<id>` row provenance. Missing or unknown agent IDs remain operator callers.
Task actions include the same caller as server-verified JSON in the task prompt. Script execution still uses the saved script owner's bindings.

## Safe schema evolution and rollback

Prefer **hiding** a column over deleting it. A hidden column's values stay on every existing row, so an unhide or rollback can make it visible again. Hiding is metadata-only: hidden columns cannot be used in queries, page bindings, `app.mutate` values, or new row writes, and `required` is ignored while hidden. Row GETs still expose the historical value for backward compatibility.

Do not reuse a hidden column name. The name remains held until you either unhide it or explicitly purge its stored values. To permanently remove a column, delete its declaration with `null` and include `{ "columnName": { "purge": true } }` in the same `migration` object. That is deliberately one-shot and irreversible for row data.

Schema-changing writes can carry this sibling `migration` object:

```json
{
  "migration": {
    "priority": { "from": "flag", "map": { "urgent": "high", "watch": "low" }, "else": "none" },
    "status": { "from": "flag", "map": { "watch": "watching", "done": "done" }, "else": "open" },
    "oldColumn": { "purge": true },
    "count": { "coerce": true, "else": 0 },
    "owner": { "set": "unassigned" }
  }
}
```

Use `set` to backfill a changed column, `from` with optional `map`/`else` to derive it from one existing (including hidden) column, `coerce` for a kind change, and `purge` only for explicit destruction. Non-purge directives target a column changed in that same write. The server fails loudly before writing when a lossy change needs a directive: inspect every returned `issues[]` item, including its per-value row counts, then choose an explicit policy and retry. Never guess a migration just to get a 200.

**Source lifecycle** rides the same engine with the same all-or-nothing guarantees. Free: adding a source, adding a NEW column with a `source` binding, binding an existing column that holds zero values, changing a binding's `field`/`transform`, and changing a source's `args`/`config`/`connection`/`scriptId` (window changes churn staleness on the next pass — expect `stale` flips when narrowing). Rejected with a path-bearing issue: changing `joinKey` (immutable — remove the source and add it again), changing `connector` while the source owns rows (row count in the message), and binding an existing column that already holds values (purge it — or add a fresh column — and bind that instead; a sync pass would otherwise overwrite the data). Removing a source **detaches** its rows: values survive as ordinary columns, the `source`/`syncedAt`/`stale` envelope is stripped, and the report counts them in `detachedRows`. A patch removing a source must drop its column bindings in the same call — a dangling `source.of` is rejected before anything is written.

Sync never adopts rows it does not own: a pulled record whose join key matches an unowned row creates a second, source-owned row. Adding a source over a join-key column that already holds values therefore duplicates those records on the first pass — and remove-source → re-add duplicates for the same reason, because detached rows keep their values. To convert a hand-maintained model into a synced one, purge the old rows first or use a fresh join-key column.

For example, split a legacy `flag` into `priority` and `status` without losing data in one patch: add the two columns, map both from `flag`, update every affected query/page binding, then hide `flag`.

```json
{
  "appId": "<app-id>",
  "definition": {
    "models": {
      "ticket": {
        "columns": {
          "priority": { "kind": "enum", "enum": ["none", "low", "high"] },
          "status": { "kind": "enum", "enum": ["open", "watching", "done"] },
          "flag": { "kind": "string", "hidden": true }
        }
      }
    }
  },
  "migration": {
    "priority": { "from": "flag", "map": { "urgent": "high", "watch": "low" }, "else": "none" },
    "status": { "from": "flag", "map": { "watch": "watching", "done": "done" }, "else": "open" }
  }
}
```

Every schema migration returns `{ scanned, backfilled, coerced, mapped, elsed, purgedValues, idxRebuilt, detachedRows, orphanFields }`. Read `orphanFields`: it reports extra row fields that predate or no longer appear in the definition; they are preserved until an explicit purge. `schemaVersion` is server-managed: never set it in an input patch or try to use it as application data.

Every successful definition write snapshots the previous definition. Use `app-history` to select a version, `app-diff({ appId, from: <version> })` to inspect it against CURRENT, then `app-rollback({ appId, version: <version>, migration? })` to restore it. Rollback is a forward migration over live rows, not row-level time travel: it creates a new pre-rollback snapshot and may reject a lossy restore with the same migration directives and counts. A rejected rollback changes nothing.

### Per-user configuration

`userConfig` declares up to 20 typed settings in the versioned definition; its values are deliberately stored outside the definition, separately for each user (and the operator dashboard). Each field is `{ "kind": "string" | "number" | "boolean" | "date" | "enum", "default"?: ..., "enum"?: [...], "label"?: "..." }`. Defaults follow column rules, including enum membership; `required` is not allowed. A missing or obsolete stored value reads as its default, or `null` when no default is declared.

Use `{ "$state": "/user/<field>" }` on a page for the read-only current-user binding; the field must be declared and the path cannot continue below it. Pure and bound reusable elements cannot bind `/user` directly — pass the value through an element prop from the consuming page. An agent acting on an owned user-requested task reads and edits that requester's preferences. `userConfig` schema changes are always migration-compatible and appear in migration reports; no migration directives are needed. Rollback restores the historical schema but never alters saved per-user values, so values can resurface when a field returns.

### Theming

An optional top-level `"theme"` sets the preset the dashboard applies to the app's rendered canvas — a lowercase slug validated by shape only. The preset catalog ships with the dashboard (`apps/ui/src/lib/themes.ts` + `theme-classics.ts` — update this list and the `app-upsert` tool description when it changes); current ids: `hive` (the stock look), the accent/field presets `meadow`, `iris`, `rose`, `cobalt`, `ember`, `carbon`, and the classic editor/platform presets `github`, `vscode`, `material`, `solarized`, `tokyo`, `monokai`, `gruvbox`, `catppuccin`. Action and destructive tones are never themed; status tones are themed ONLY by the classic presets (their identity includes a status palette — hue semantics stay fixed, success reads green and error reads red everywhere). An id the viewer's dashboard build does not know degrades to the dashboard's own theme, so unknown slugs are safe but pointless. Omit `theme` to inherit whatever theme the viewer runs; `"hive"` is an explicit reset to the stock look even inside a themed dashboard.

Viewers can override the preset per app from the app's settings drawer; the override rides the reserved `$theme` key of the user-config values (accepted on every app, even without a declared `userConfig` schema, and never visible at `/user/...`). A present override always beats the definition's `theme` — even an unrecognized one, which degrades to the dashboard theme — so treat `theme` as the app's default styling, not a guarantee.

Distinguish the two rollback 400s. A lossy-migration 400 is fixable: copy the required `migration` entries from the message and retry. A target-snapshot validation 400 explicitly says that directives cannot repair that historical definition; use `app-history` and choose a different version.

When a schema patch reports stale page/query bindings, repair them in that same patch. Page elements are atomic: replace the complete `pages.<page>.elements.<id>` declaration, removing any reference to a hidden or deleted column, instead of sending only the changed nested prop. This is also the repair move for older apps whose stored page already references an undeclared column; full-definition validation otherwise blocks every patch.

## Definition reference

```json
{
  "models": {
    "modelName": {
      "columns": {
        "externalId": { "kind": "string" },
        "title": { "kind": "string" }
      }
    }
  },
  "queries": { "queryName": { "model": "modelName" } },
  "actions": { "actionName": { "kind": "task", "prompt": "Review the current rows and report" } },
  "pages": {
    "main": {
      "root": "root",
      "elements": { "root": { "type": "Container", "props": {} } }
    }
  },
  "defaultPage": "main",
  "theme": "ember"
}
```

Model, reusable-element, element-prop, query, action, column, page, and page-param names start with a lowercase letter, contain only letters, numbers, or underscores, and are at most 40 characters. A definition has 0-10 models and at most 20 reusable elements; each declared model has 1-40 columns. Zero-model apps are valid for pure UI utilities as long as their pages and reusable elements validate.

### Reusable elements

Top-level `elements` are versioned inside the app definition and can be reused from the app's own pages or, when explicitly exported, from another app. They are private by default. Each entry declares a `mode`, optional typed `props`, one `root`, and a flat `elements` node map using the same validated tree vocabulary as a page:

```json
{
  "elements": {
    "statCard": {
      "mode": "pure",
      "export": true,
      "props": {
        "label": { "kind": "string", "required": true },
        "value": { "kind": "number", "default": 0 }
      },
      "root": "card",
      "elements": {
        "card": { "type": "Card", "props": {}, "children": ["label", "slot"] },
        "label": { "type": "Metric", "props": { "label": { "$state": "/props/label" }, "value": { "$state": "/props/value" } } },
        "slot": { "type": "ElementSlot", "props": {} }
      }
    }
  }
}
```

- `pure` elements may read only their declared `/props/<name>` state; `$item` and `$index` are also legal inside repeated nodes. They cannot invoke any action step. A pure tree may contain at most one leaf `ElementSlot` where consumer children are inserted.
- `bound` elements may additionally read the defining app's declared queries and actions and use its models. Those references are validated against the defining app, including hidden-column rules. Exported bound elements cannot use `app.navigate`; private bound elements may navigate within their defining app.
- Prop kinds are `string`, `number`, `boolean`, `date`, or `enum`. An enum prop requires a non-empty `enum: ["value", ...]` values array. A literal default and each literal consumer value must match the kind and, for enums, be one of those values. A required prop without a default must be supplied.

Reference an element with an `ElementRef` node. Omit `app` for same-app reuse; cross-app references name the defining app id and require `export: true`. `instanceKey` is optional. Consumer `children` are accepted only when the target has an `ElementSlot`:

```json
{
  "type": "ElementRef",
  "props": {
    "app": "<defining-app-id>",
    "element": "statCard",
    "props": { "label": "Open issues", "value": 12 },
    "instanceKey": "openIssues"
  },
  "children": ["details"]
}
```

Element references float to the defining app's current definition. `app` and `element` must be literal strings; dynamic references are not supported. The server rejects reference cycles and expansion deeper than five, missing/private targets, invalid props, and a breaking write to an exported element that other apps reference. Removing or unexporting an exported element, changing its mode, removing a declared prop, changing a prop kind, or adding a required prop without a default is breaking; publish the new contract under a new element name. If consumers are abandoned intentionally, retry the PUT, PATCH, or rollback with `"forceElementBreak": ["elementName"]`. The named consumers will then render an error once element rendering is available; deleting an entire app is deliberately not compatibility-gated.

### Models

Each column is `{ "kind": ..., "required"?: boolean, "default"?: ..., "index"?: boolean, "enum"?: string[], "hidden"?: boolean }`.

| `kind` | Values and indexing |
|---|---|
| `string` | String value; set `index: true` only when equality lookups need it. |
| `number` | Finite number; never indexed. |
| `boolean` | Boolean; set `index: true` only when equality lookups need it. |
| `date` | ISO-8601 string; never indexed. |
| `enum` | String from the non-empty unique `enum` list; always indexed, without `index: true`. |
| `json` | Any JSON value (object, array, nested) up to 256 KB serialized by default (`APPS_JSON_COLUMN_MAX_BYTES`); never indexed, and a named query cannot `filter` or `sort` on it. Not allowed for `userConfig` fields or element props. |

`default` must match the column kind (and be one of the enum values). `required: true` rejects missing/null values unless a default supplies the value. `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` — and the sync envelope `source`, `syncedAt`, `stale` — are system columns and reserved names. An app created before the sync envelope that declared ordinary columns with these names surfaces `definitionError` after upgrade until they are renamed: patch in a fresh column with a `{from}` migration directive, then purge the old one. Rows always expose `id`/`createdAt`/`updatedAt`; `createdBy`/`updatedBy` record the acting principal (`user:<id>`, `agent:<id>`, `operator`, or `sync:<source>` for engine writes) and are system-managed on every row write.

### Sources and sync

A model may declare up to 4 named `sources` — one-way inbound projections of an external system into its rows. The `script` connector is THE way to bring external data in (GitHub, Linear, any API): a saved script owns the fetch, its auth placeholders, and its paging. `swarm-tasks` is the one native connector, projecting this swarm's own task pool (`config`: `status`/`tags` comma-lists, `agentId`, `assetKey` namespace prefix, `limit` up to 200 — default 100, `includeHeartbeat`). Synced rows are readable by EVERY principal with `app.use` on the app; an unscoped `swarm-tasks` source publishes task prompts (truncated, secret-scrubbed) to all of them, so scope it with `config.assetKey`/`config.agentId` unless that exposure is intended. A user-invoked sync only ever pulls the invoking user's own requested tasks. Script sources run with their run-as identity's credentials — an agent-owned script runs as its owner and only the owner may wire it; an owner-less catalog (global) script runs as the LEAD, so only the lead or the operator can wire or alter such a source (stored references stay valid with their args and connection pinned).

```json
{
  "models": {
    "issue": {
      "columns": {
        "issueKey": { "kind": "string" },
        "title": { "kind": "string", "source": { "of": "gh", "field": "title" } },
        "openedAt": { "kind": "date", "source": { "of": "gh", "field": "created_at", "transform": "date-parse" } },
        "note": { "kind": "string" }
      },
      "sources": {
        "gh": { "connector": "script", "scriptId": "<script-uuid>", "joinKey": "issueKey", "args": { "repo": "owner/name" }, "connection": "github" }
      }
    }
  }
}
```

- **Join key**: each source names a `joinKey` — an owned, non-hidden `string` column carrying the external identity. It must not be `required`, must not declare a `default`, and cannot itself be source-bound. A row belongs to at most ONE source (`row.source`).
- **Column bindings**: `{ "of": "<sourceName>", "field": "user.login", "transform"? }` projects a (dotted-path) field of the pulled record into the column on every pass. Transforms and their required column kinds: `slug`/`lower`/`upper` → `string`, `cents` → `number` (×100, rounded), `date-parse` → `date` (ISO). A failed transform nulls that one column and warns; it never fails the pass.
- **Read-only contract**: source-bound columns and the join key reject every direct write (row create/patch/bulk) with a path-bearing issue — mutate them via the source or a sync refresh. Owned columns on the same model stay writable. Every `required` owned column on a sourced model must declare a `default`, because sync-created rows cannot supply it.
- **Provenance**: synced rows carry `source` (owner), `syncedAt` (last confirmed presence — sortable), and `stale` (true when a complete pull no longer returned the record; clears on reappearance). `syncedAt` advances on every confirmed row WITHOUT touching `updatedAt`; `updatedAt` moves only when projected data actually changed.
- **`connection`** (optional, script sources): names a connections-system slug the source depends on. It buys write-time validation plus a preflight before every pull; it does not by itself gate egress. Credentials resolve for the sync run-as identity — the script's owner when it has one, else the lead agent — so global connections always work and agent-scoped ones need matching script ownership. The slug is injected into the script's args as `connection`, letting one generic script serve N connections.

**The canonical sync-script contract** (every sync script, always):

```ts
export default async function run(args, ctx) {
  // args = { ...source.args, app: { id }, model: "<model>", source: "<sourceName>", connection?: "<slug>" }
  const records = [{ key: "42", fields: { title: "…", created_at: "…" } }];
  return { records, complete: true }; // or return the bare array — a bare array IS a complete snapshot
}
```

Return `Array<{ key, fields }>` or `{ records, complete? }`. `key` is the external identity the engine joins on `joinKey` (numbers are coerced to strings); `fields` is the bag bindings project from. Return `complete: false` whenever the pull window may have missed records — a paged fetch, a hit `limit`, or client-side filtering of a full page. An incomplete pull skips the stale sweep, so rows outside a narrow window are not falsely marked stale; compute `complete` BEFORE any client-side filtering. Hard cap 500 records per pull (over-cap pulls truncate and count as incomplete). An invalid return shape, thrown error, or non-zero exit fails the pass with zero row churn.

The seeded catalog script `github-issues-pull` is the worked example (placeholder auth via `[REDACTED:GITHUB_TOKEN]`, PR filtering, `complete` computed before filtering). For scheduled refreshes, point a `targetType: "script"` schedule at the seeded `app-sync-run` with `scriptArgs: { "appId": "<id>", "model"?, "source"? }`.

**Three refresh doors, one engine**: `POST /api/apps/<id>/sync` (body `{ "model"?, "source"? }`), a `sync` action kind, and the `app-sync` MCP tool (`ctx.swarm.app_sync` from scripts). `{model?, source?}` fans out to every matching (model × source) pair; each pass reports `{ pulled, created, updated, refreshed, unchanged, markedStale, warnings }`. A pair already syncing in this API process short-circuits with `alreadyRunning: true` instead of pulling twice. Each pair's last-pass status (`lastFinishedAt`, counts, `error?`) comes back as `syncStatus` — keyed `"<model>:<source>"` — on `GET /api/apps/<id>` and in `app-get` data, so UI and agents can render "last synced / last error" without extra calls.

### Freshness and the refresh button

Freshness renders with the existing column kinds — no special components. Give the table `{ "key": "syncedAt", "kind": "date" }` and `{ "key": "stale", "kind": "badge", "tones": { "true": "warning" } }` columns, declare a `sync` action, and wire a Button to it:

```json
{
  "actions": { "refresh": { "kind": "sync" } },
  "pages": {
    "main": {
      "root": "root",
      "elements": {
        "root": { "type": "Container", "props": {}, "children": ["refreshBtn", "issuesTable"] },
        "refreshBtn": {
          "type": "Button",
          "props": { "label": "Refresh" },
          "on": { "press": [{ "action": "app.action", "params": { "name": "refresh" } }] }
        },
        "issuesTable": {
          "type": "Table",
          "props": {
            "data": { "$state": "/queries/allIssues/data" },
            "columns": [
              { "key": "title", "label": "Issue" },
              { "key": "syncedAt", "label": "Synced", "kind": "date" },
              { "key": "stale", "label": "Stale", "kind": "badge", "tones": { "true": "warning" } }
            ]
          }
        }
      }
    }
  }
}
```

A `sync` action answers the script-action state shape (`/actions/refresh` → `running` → `ok`/`error`, result under `result.passes`), so the page's queries refetch when it completes. Use `app-query` to READ rows (named queries may filter on `stale`/`source` and sort by `syncedAt`); use `app-sync` to REFRESH sources; never poll a sync door in a loop — schedule it or give people the button.

### Queries

A named query is:

```json
{
  "model": "idea",
  "filter": { "status": "open" },
  "sort": { "column": "createdAt", "dir": "desc" },
  "limit": 100
}
```

`filter` is a strict AND of equality checks. A filter may target a declared model column or a system column (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, and on synced models `source`, `syncedAt`, `stale`) — filtering on `id` is the universal way to select one row for a detail view, and `{ "stale": true }` selects rows a complete pull stopped confirming. A literal value must match the column's kind; date filters compare the stored raw ISO string, not parsed instants. Omit `limit` for the default 200 rows, or set an integer from 1 through 1000. `sort.column` is a non-`json` model column, `createdAt`, `updatedAt`, or `syncedAt`; `dir` is `asc` or `desc`. Query runtime state is `{ data, loading, error }` under `/queries/<queryName>`.

A filter value may instead be exactly `{ "$param": "<name>" }`. At execution, the caller supplies that name and the server coerces its value to the filtered column's kind before equality matching:

```json
{
  "queries": {
    "issueDetail": { "model": "issue", "filter": { "issueId": { "$param": "issueId" } }, "limit": 1 }
  }
}
```

The placeholder object must contain only `$param`. Missing caller values fail loudly rather than returning unfiltered rows: HTTP reports 400 and `app-query` returns a tool error listing every missing name. Supplying a param name the query does not reference is also an error. The app UI supplies current declared route params automatically. Direct calls use `app-query({ appId, query: "issueDetail", params: { issueId: 42 } })` or `ctx.swarm.app_query({ appId, query: "issueDetail", params: { issueId: 42 } })`.

### Custom actions

Actions are optional (maximum 20) and are invoked from the page with the `app.action` runtime action.

```json
{
  "actions": {
    "recalculate": {
      "kind": "script",
      "scriptId": "00000000-0000-4000-8000-000000000000",
      "args": { "mode": "fast" }
    },
    "triage": {
      "kind": "task",
      "prompt": "Triage this idea and report a recommendation"
    }
  }
}
```

| Kind | Contract |
|---|---|
| `script` | `scriptId` must identify an existing script; optional `args` are defaults. Invocation input overrides same-named defaults, and the runtime also supplies `app: { id }`. |
| `task` | `prompt` must be non-empty; omit `agentId` to use default (lead) assignment. Only set `agentId` to a real agent UUID. Invocation `input` is included as context for the task prompt. Spawned tasks carry asset key `shared/app:<appId>/action:<name>/`, so a `swarm-tasks` source with `config.assetKey: "shared/app:<appId>/"` pulls back the tasks this app spawned. |
| `sync` | Optional `model` and `source` narrow which (model × source) pairs refresh; omitting both syncs every pair the app declares. At least one pair must exist. Answers the script-kind state shape with per-pass results under `result.passes`. |

- Invocation state lands at `/actions/<name>` as `{ status, result?, error?, taskId?, taskStatus? }`, where `status` is `"running"`, `"ok"`, or `"error"`.

Use a task action named Tackle when a person should hand one issue row to the swarm. Pass the complete current row under `input.issue`; `{ "$row": "" }` resolves to the whole row and that context lands in the task prompt.

```json
{
  "actions": {
    "tackle": { "kind": "task", "prompt": "Tackle this issue. Inspect the supplied issue context, do the work, and report the outcome." }
  },
  "pages": {
    "main": {
      "root": "issuesTable",
      "elements": {
        "issuesTable": {
          "type": "Table",
          "props": {
            "data": { "$state": "/queries/allIssues/data" },
            "columns": [{ "key": "title", "label": "Issue" }],
            "rowActions": [{
              "label": "Tackle",
              "actions": [{
                "action": "app.action",
                "params": { "name": "tackle", "input": { "issue": { "$row": "" } } }
              }]
            }]
          }
        }
      }
    }
  },
  "defaultPage": "main"
}
```

For direct MCP calls, `app-query` accepts `{ appId, query, params? }` and returns rows from that declared named query; every supplied param must be referenced by a `$param` filter in that query. Use it when an agent needs to read app state without scraping the UI.

Saved scripts use the generated SDK name `ctx.swarm.app_query({ appId, query, params? })`. Use `app_query` in scripts or workflows that turn current app rows into reports, digests, or follow-up work. Saved scripts also get generated per-app types automatically: each app contributes an `App_<Name>` namespace with one row interface per model (enum columns as literal unions) and a typed `app_query` overload per named query, all visible via `script-query-types`. Scripts can create, list, get, patch, and delete rows with the seven row tools. Actions remain REST/MCP-only and have no script SDK method.

### Pages, routes, and page trees

`pages` is a map of independently validated page trees and `defaultPage` must name one entry. Each page may also declare a display `title` and typed route `params`. On every non-default page the runtime automatically renders breadcrumbs (`<default page title> › <current page title>`, first crumb navigates back) — including in chromeless embeds — so a detail page does NOT need its own back button; give pages good `title`s instead. This complete pattern connects a table row to a typed detail route and its parameterized query:

```json
{
  "models": {
    "issue": {
      "columns": {
        "issueId": { "kind": "number" },
        "title": { "kind": "string" },
        "status": { "kind": "string" }
      }
    }
  },
  "queries": {
    "allIssues": { "model": "issue" },
    "issueDetail": {
      "model": "issue",
      "filter": { "issueId": { "$param": "issueId" } },
      "limit": 1
    }
  },
  "pages": {
    "issues": {
      "title": "Issues",
      "root": "issuesTable",
      "elements": {
        "issuesTable": {
          "type": "Table",
          "props": {
            "data": { "$state": "/queries/allIssues/data" },
            "columns": [
              { "key": "title", "label": "Issue" },
              { "key": "status", "label": "Status", "kind": "badge" }
            ],
            "rowActions": [{
              "label": "Open",
              "actions": [{
                "action": "app.navigate",
                "params": {
                  "page": "detail",
                  "params": { "issueId": { "$row": "issueId" } }
                }
              }]
            }]
          }
        }
      }
    },
    "detail": {
      "title": "Issue detail",
      "params": { "issueId": { "kind": "number", "required": true } },
      "root": "detail",
      "elements": {
        "detail": {
          "type": "DetailList",
          "props": {
            "data": { "$state": "/queries/issueDetail/data/0" },
            "fields": [{ "key": "title", "label": "Issue" }]
          }
        }
      }
    }
  },
  "defaultPage": "issues"
}
```

Drawer variant: declare a route param on the containing page, set the Drawer `props.param` to that literal param name, and use the same `app.navigate` shape targeting that page with the row id assigned to the Drawer's param. The Drawer then opens from route state without a separate action contract.

Param `kind` is `string` by default, or `number` / `boolean`; `required` defaults to false. The names `mode`, `apiUrl`, `apiKey`, `email`, and `name` are reserved. `/apps/<id>` renders `defaultPage`; `/apps/<id>/p/<page>?issueId=42` is the shareable deep link for another page. Browser navigation is client-side, so app state and polled data stay warm across page changes.

Within each page, `root` names one entry in its non-empty `elements` map. Elements are a flat, single-parent tree: ids are map keys, `children` contains ids (not nested elements), all elements must be reachable from `root`, and cycles, missing children, or shared children are invalid. Element and Form/UI ids are page-local. Element keys are `type`, `props`, `children`, `on`, `visible`, `repeat`, and `watch`; only components with a `default` child slot accept `children` (Stack, Grid, Split, Tabs, Container, Card, Section, and Drawer). `watch` maps state paths to an action step or chain.

## Component catalog (all 34)

Props reject unknown keys. A `{"$state":"..."}` binding may replace a literal prop value at any depth.

Icons: every `icon` prop (and the `Icon` block) takes one name from a curated lucide set: `plus`, `refresh-cw`, `search`, `filter`, `download`, `upload`, `external-link`, `copy`, `check`, `x`, `trash-2`, `pencil`, `eye`, `calendar`, `clock`, `user`, `users`, `bot`, `git-pull-request`, `git-branch`, `github`, `slack`, `mail`, `link`, `file-text`, `folder`, `database`, `zap`, `sparkles`, `flag`, `star`, `tag`, `alert-triangle`, `info`, `circle-check`, `trending-up`, `trending-down`, `dollar-sign`, `activity`, `rocket`. Any other name is rejected.

Tones: Badge, Metric and Progress `tone` take `neutral`, `success`, `active`, `error`, `info`, `pending`, `warning`, or `paused`.

| Component | Required props | Optional props / values |
|---|---|---|
| `Stack` | none | Primary layout; `direction: "column", "row"`, `gap`, `padding: "none", "xs", "sm", "md", "lg", "xl"`; `align: "start", "center", "end", "stretch"`, `justify: "start", "center", "end", "between"`, `wrap`; `motion: "rise"` (default), `"fade"`, or `"none"` (see Motion below); `fill` (grow to fill a `fill`-aware parent; see Layout below); has the `default` child slot. |
| `Grid` | none | Responsive `columns`: integer 1 through 6, or `{ base, sm, md, lg }` counts 1 through 6; `gap` uses the Stack spacing values; has the `default` child slot. |
| `Split` | none | `ratio: "1-1", "1-2", "2-1", "1-3", "3-1"`, `gap`, `collapseBelow: "sm", "md", "lg"`, `reverse`, `fill` (same contract as Stack); has the positional `default` child slot. |
| `Divider` | none | `label`; no children. |
| `Tabs` | `id`, `tabs` | `tabs` entries are `{ key, label?, icon?, count? }` (`count` is a number shown as a small pill); `defaultTab`; `variant: "line"` (default) or `"segmented"` (a compact segmented control, same state and warm panels); has the positional `default` child slot. |
| `Container` | none | Legacy layout primitive; prefer Stack. `direction: "row", "column"`, `gap: "none", "sm", "md", "lg"`; has the `default` child slot. |
| `Card` | none | `title`, `description`; has the `default` child slot. |
| `Heading` | `text` | `level: "h1", "h2", or "h3"`. |
| `Text` | `content` | `tone: "default" or "muted"`. |
| `Markdown` | `content` | Rendered Markdown for help, instructions, and rich prose; no children. |
| `SearchInput` | `id` | `placeholder`, `label`, `shortcut` (one key, usually `"/"`: shows a keycap and focuses the field); writes debounced text to `/ui/<id>/value`; no children. |
| `Select` | `id`, `options` | `options` are strings or `{ value, label?, icon?, hint? }`; `placeholder`, `label`, `clearable`, `searchable` (type to filter; on by default past 8 options), `searchPlaceholder`, `multiple`, `defaultValue` (seeds `/ui/<id>/value` once, before any interaction; a one-entry array with `multiple`); writes a string or null to `/ui/<id>/value`, or with `multiple` a string array (empty = nothing picked); no children. |
| `NumberInput` | `id` | `label`, `placeholder`, `min`, `max`; a text field with a decimal keyboard that writes the parsed number to `/ui/<id>/value` on every change (no debounce), or null when the field is empty; non-numeric text (a bare `-` mid-edit, letters) leaves the stored value untouched; `min`/`max` clamp the stored value and the visible text snaps to it when the field loses focus; no children. |
| `Chips` | `id`, `options` | Toggle chips for quick filters. `options` are strings or `{ value, label?, icon? }`; `multiple`; `label` (group name for screen readers). Writes a string or null to `/ui/<id>/value`, or a string array with `multiple`; pressing the selected chip clears it. |
| `Button` | `label` | `variant: "default", "secondary", "outline", "ghost", "destructive", or "destructive-outline"` (use `destructive-outline` for standalone deletes); `disabled` (constant or bound boolean); `busyWith: "<actionName>"` swaps the label for a spinner while that custom action's `/actions/<name>/status` is `"running"` (presses are ignored), then shows a check and `successLabel` for about 1.5s when it turns `"ok"`; `icon`, `iconPosition: "start" or "end"`; `size: "sm", "default", or "lg"`; `shortcut` (one key, shown as a keycap, presses the button); `hint` (tooltip); dispatch with element-level `on.press`. |
| `Metric` | `label`, `value` | The dashboard stat tile. `value` is string or number (empty renders an em dash); bind `loading` to `/queries/<name>/loading` for a skeleton while the query loads; `icon` with `tone` tinting its tile; `detail` (a line under the value); `trend: { direction: "up", "down", or "flat", label }`; `info` (explanation tooltip next to the label). |
| `Alert` | `message` | `title`, `tone: "info", "success", "warning", or "error"`, `icon` (overrides the tone icon), `actionLabel` (a button inside the callout that emits `press`; wire it with `on.press`). |
| `Badge` | `text` | `text` is string or number; `tone`; `icon` replaces the dot; `variant: "tag"` (default uppercase chip), `"status"` (sentence-case pill), `"count"` (numeric pill), or `"beta"` (the BETA tag); `status` (a lifecycle value renders the dashboard status chip); `hint` (tooltip; the beta tag's explanation). |
| `Icon` | `name` | `size: "sm", "md", or "lg"`, `tone: "default", "muted", "success", "warning", "error", or "info"`, `label` (accessible name; decorative without it). |
| `Progress` | `value` | `max` (default 100), `tone`, `label`, `variant: "bar"` (default) or `"ring"` (the dashboard progress ring; ignores `tone`), `showValue` (default true: percent for a bar, `value / max` for a ring). |
| `EmptyState` | `title` | `icon` (default inbox), `body`, `actionLabel` (a button that emits `press`; wire it with `on.press`). |
| `CopyButton` | `value` | `value` is string or number; `label` is the visible text, icon-only without it. Renders nothing for an empty value. |
| `Kbd` | `keys` | Keycaps, one per string (`["⌘", "K"]`). Display only. |
| `Skeleton` | `shape` | `shape: "line", "block", "rows", "metric", or "card"`; `count` (1-20: lines, rows, tiles, or cards); `height` (px, `block` only, default 128). Show it with `visible` bound to a query's `loading`. |
| `Spinner` | none | `variant: "ring", "ellipsis", or "bars"` (default: the dashboard spinner), `size: "sm" or "md"`, `label` (visible text and accessible name). |
| `AvatarStack` | `users` | `users` are display names (initials avatars); `max` (default 4) before a `+N` count. Hover lists every name. |
| `Section` | `title` | `description`, `collapsible`, `defaultOpen` (default true); has the `default` child slot. |
| `Table` | `columns` | `data`, `loading`, `error`, `emptyMessage`, `emptyState`, `rowActions`, `onRowClick`, `selectedId`, `rowId`, `mobile`, `mobileFields`, `search`, `filters`; see below. |
| `Form` | `id`, `fields`, `onSubmit` | `title`, `submitLabel`; see below. |
| `Drawer` | `param` | `title`, `description`, `side: "right" or "left"`, `size: "sm", "md" (default), "lg", or "xl"` (about 480/660/900/1010px at 1440px; grows with the viewport up to 640/960/1280/1600px; full width on phones), `actions` (sticky footer buttons; see below); has the `default` child slot. |
| `DetailList` | `fields` | `data`, `emptyMessage`, `columns: 1 or 2`, `loading` (bind `/queries/<name>/loading` for skeleton fields while loading); renders one record without edit controls; see below for field kinds. |
| `CardGrid` | `titleKey` | `data`, `loading`, `error`, `emptyMessage`, `imageKey`, `fields`, `columns`, `onClick`; one card per row for record browsers; see below. |
| `Kanban` | `columnField`, `columns`, `titleField` | `data`, `loading`, `cardFields`, `idField` (default `id`), `onMove`, `onCardClick`; see below. |
| `Calendar` | `startField`, `titleField` | `data`, `loading`, `endField`, `idField`, `onSelect`; read-only month grid; see below. |
| `ContributionGraph` | none | `data`, `loading`, `dateField` (default `date`), `countField`, `days` (7-730, default 365); read-only activity heatmap. |
| `Tree` | `id`, `nodes` | `label`, `maxHeight` (default `480px`), `fill`; collapsible outline of a doc-shaped value that writes the clicked node key to `/ui/<id>/value`; see below. |

Table details:

- `columns[]`: `{ key, label?, kind?, tones?: {value: badgeTone}, width?: number, pinned?: "left" or "right", align?: "start" or "end", truncate?: "end" or "middle", icon?, tooltip?: "<row field>", max?: number, format?: "<template>", onChange?: chain }`. `kind` is `text`, `string`, `enum`, `number`, `boolean`, `date`, `badge`, `status`, `user`, `agent`, `relative`, `duration`, `progress`, `copy`, `switch`, `link`, or `json`; `string` and `enum` render as text, and `json` renders a truncated single-line `JSON.stringify` preview. Pin id/actions columns so they survive horizontal scroll on narrow viewports.
  - `status`: lifecycle values (`pending`, `in_progress`, `running`, `completed`, `failed`, `cancelled`, `paused`, `reviewing`, ...) render the dashboard status chip with its icon; other values use `tones` like `badge`.
  - `user` / `agent`: avatar plus name. `relative` (and `date`): smart time, exact time on hover. `duration`: milliseconds as `1m 23s`. `progress`: a bar against `max` (default 100). `copy`: the value plus a copy button. `link`: an http(s) URL opening in a new tab (other values render as text).
  - `switch`: a toggle. `onChange` runs with `$row` = the row with this column already set to the new value, e.g. `[{ "action": "app.mutate", "params": { "model": "m", "op": "update", "rowId": { "$row": "id" }, "values": { "enabled": { "$row": "enabled" } } } }]`. Without `onChange` the switch is read-only.
  - Numbers, durations and progress right-align by default. `truncate: "middle"` keeps both ends of ids and paths. `icon` shows in the header; `tooltip` names a row field shown on hover.
  - `format`: a `{{field}}` template that combines several row fields into one cell, e.g. `"{{name}} ({{status}})"`. Placeholder names match `[\w.]+` (letters, digits, `_` and `.`; no hyphens or spaces). Each placeholder reads that row field as-is (a dotted name such as `{{owner.name}}` is a literal column name, not a nested path); a missing or null field becomes an empty string and an object or array becomes a JSON preview cut to 120 characters. The whole cell is capped at 500 characters. A templated column ignores `kind`, shows the same text in the phone list, and sorts by the composed text. `search` and `filters` still read the column's `key`.
- `onRowClick`: action chain with `$row` / `$rowIndex`, run when a row is clicked (or Enter on a focused cell). Pair it with `app.navigate` that sets a Drawer param, and bind `selectedId` to `{ "$state": "/route/params/<param>" }` so the open row stays highlighted. `rowId` names the id field (default `id`).
- Phones (below 768px): the table renders as a card list. `mobileFields: { title, subtitle?, meta?: string or string[], status? }` picks the columns; by default the first text column is the title and the first `status`/`badge` column the chip. `mobile: "scroll"` keeps the grid; it is the default when the table has `rowActions` but no `onRowClick`.
- `emptyState: { icon?, title, body? }` replaces the plain empty message. A search or filter that hides every row shows its own "No rows match" state.
- `pagination`: boolean; defaults to auto-enabling past 200 rows (set `false` to force one scroll region). `density: "compact"` tightens row height for dense readouts.
- `rowActions[]`: `{ label, variant?, icon?, placement?: "inline" or "menu", confirm?, actions }`. `placement: "menu"` moves the action into the row's More menu. Variants add `destructive-outline` to the Button variants. `destructive` and `destructive-outline` confirm by default; customize with `{ "title": ..., "description": ..., "confirmLabel": ... }`, or use a bare `confirm` string as the dialog description (use `confirm: false` only for a reversible action).
- `search`: optional string; case-insensitive substring matching across the listed string and number columns. Bind a SearchInput value for client-side search.
- `filters`: optional record of per-column string, number, boolean, null, or array values. An array means "the cell is one of these" (what a `multiple` Chips or Select writes). Null, empty strings, empty arrays, or absent values disable one filter. Bind Select or Chips values for client-side filters.

Kanban details:

- One card per `data` row, grouped by the row's `columnField` value. `columns[]` are plain strings or `{ id, label? }`, in display order; rows matching no column are hidden.
- `cardFields[]` uses the DetailList field shape (`{ key, label?, kind?, tones? }`, same kinds) for extra lines under the title.
- `onMove` is an action chain run when a card is dropped in another column. `$row` is the moved row with `columnField` already set to the new column: `[{ "action": "app.mutate", "params": { "model": "deal", "op": "update", "rowId": { "$row": "id" }, "values": { "stage": { "$row": "stage" } } } }]`. Without `onMove`, cards cannot be dragged.
- `onCardClick` is an action chain with `$row`; pair it with `app.navigate` and a `Drawer` to open a card.

Calendar details:

- `startField` / `endField` hold ISO dates, ISO datetimes, or epoch ms. An event shows on every day from start to end; without `endField` it shows on its start day.
- Each Calendar keeps its own visible month (prev/next controls in its header). `onSelect` is an action chain with `$row`, run when an event is clicked.

ContributionGraph details:

- Buckets `data` rows by the calendar day of `dateField` over the trailing `days`. Each row counts 1, or adds its numeric `countField` when set.

Tree details:

- `nodes` is a doc-shaped value: `{ root: string | string[], elements: { <key>: { type, children?: string[] } } }`, the json-render flat element map. Usually bind it to a json column: `{ "$state": "/queries/<name>/data/0/<column>" }`. A malformed or absent value renders an empty state; a `children` key missing from `elements` shows as `key — ?`. Outlines are cut at 2,000 rows with a notice; branches deeper than 32 levels keep a disabled chevron.
- Each row shows `key — type`. Clicking a row writes its key to `/ui/<id>/value`, and the row bound to that path renders selected; read the selection with `{ "$state": "/ui/<id>/value" }`. The Tree never writes `null`: when the selected key leaves the doc (a refetch, an edit) the stored key stays and no row renders selected. Selection and collapse are keyed by node key, so a key reachable through two parents selects and collapses in both places.
- Rows scroll inside `maxHeight` (default `480px`). Set `fill: true` inside a `fill` Stack or Split pane to grow to that height instead and scroll within it (ignores `maxHeight`).

Form details:

- `fields[]`: `{ name, label?, kind?, options?: string[], placeholder?, required? }`; `kind` is `string`, `text`, `number`, `boolean`, `date`, or `enum`, and enum fields need `options`.
- Values live at `/forms/<formId>/<fieldName>`. `onSubmit` is an action chain.
- The submit button shows a pending spinner while the chain runs, and `app.mutate` failures in the chain render inline under the fields (not the page banner) — no extra wiring needed.

Drawer details:

- `param` must name a param declared on the containing page. The drawer is open exactly when `/route/params/<param>` has a non-empty value, so its open state survives refresh and is shareable. Its children mount only while open; closing it clears that param with history replacement.
- `actions[]`: `{ label, variant?, icon?, confirm?, actions }`, rendered as buttons in a sticky footer under the scrolling body. Confirmation follows Table `rowActions`: destructive variants confirm by default, and a chain with an `app.mutate` delete always confirms. Chains have no `$row`; address the open record with `{ "$state": "/route/params/<param>" }`, for example `{ "action": "app.mutate", "params": { "model": "order", "op": "delete", "rowId": { "$state": "/route/params/panel" } } }`. Prev/next record navigation is not available.

DetailList details:

- `fields[]`: `{ key, label?, kind?, tones? }`. Kinds reuse Table formatting (`text`, `string`, `number`, `boolean`, `date`, `badge`, `enum`) and the Table cell renderers (`status`: lifecycle chip or `tones` pill; `user`: avatar plus name; `relative`: smart time, exact on hover; `copy`: value plus copy button), and add `code` for a monospace block and `json` for a collapsible JSON tree (objects, or a string holding JSON). Bind `data` to one record, commonly `/queries/<detailQuery>/data/0`.

Motion details:

- Every `Stack` fades its direct children in and lifts them 4px over 200ms on first paint, staggered 30ms (capped at the 10th child). It never replays on the 5s data poll. A Stack nested inside another one does not add its own entrance. `motion: "fade"` drops the lift; `motion: "none"` turns it off. Viewers with reduced motion get a 150ms fade.

CardGrid details — the visual counterpart to Table for record browsers (projects, documents, media):

- `titleKey` (required) picks the row field shown as the card title (an object value shows a JSON preview; titles are capped at 500 characters).
- `imageKey` (optional) picks a row field holding an absolute http(s) image URL and adds an image tile to every card. When it is set, a non-URL value, a missing value, or a failed load shows a placeholder tile. Omit it for text-only cards with no tile.
- `fields[]`: `{ key, kind?, tones? }`. `kind` is `text`, `string`, `enum`, `number`, `boolean`, `date`, `badge` (with `tones`), or `json` (no `label`, no `format`). A field with no `kind` whose value is an object renders like `json`. They render as an unlabeled `·`-joined meta line under the title, e.g. a `date` field for "created" and a `text` field for the author.
- `columns`: same responsive shorthand as `Grid.columns` (default `{ "base": 1, "sm": 2, "md": 3 }`).
- `onClick`: an action chain with `$row` / `$rowIndex`, run when a card is clicked or activated with Enter or Space. Commonly `app.navigate` into a detail page, the CardGrid equivalent of Table's `onRowClick`.
- Bind `data` / `loading` / `error` to a named query like Table. Loading shows skeleton cards, an error shows a callout, and no rows shows `emptyMessage`.
- It renders 200 cards at a time with a Show more button below the grid that reveals the next 200.

Shortcut details:

- `Button.shortcut` and `SearchInput.shortcut` are one key. Letters and digits match without Shift; symbols such as `/` and `?` match as typed. They do nothing while focus is in a text field, while Ctrl, Cmd, or Alt is held, or while a dialog or menu is open (unless the control is inside it, such as a Button in an open Drawer).

## Layout & interactivity

Use `Stack` as the primary page and section layout; `Container` is the legacy two-prop primitive retained for existing pages. Stack supports vertical or horizontal flow, shared spacing, alignment, justification, wrapping, and padding; row Stacks (filter bars, button rows) should set `collapseBelow: "sm"|"md"|"lg"` so they stack vertically on phones. Use `Grid` for responsive card or metric strips: a bare column count is responsive shorthand (1 column on phones, 2 from `sm`, the count from `md` up), or pin breakpoints explicitly with `{ "base": 1, "md": 2, "lg": 3 }`. `Grid` and `Split` also accept `padding` on the shared spacing scale.

`Stack` and `Split` size to their content by default, so a page scrolls as a whole. Set `fill: true` to make one grow to fill the remaining height of a `fill`-aware parent (another `fill` Stack or Split) instead; chain it from the page root down through every container on the path to the element that should scroll, and that element scrolls within whatever height is left while the page itself does not. A non-`fill` sibling (a toolbar, a header) keeps its natural height and the `fill` sibling absorbs the rest. A `fill` Split stretches both panes to the full row height, so nesting a `fill` Split inside one pane of another `fill` Split is the way to build a three-or-more column viewport-height layout (`ratio` is only ever two panes).

`Split` and `Tabs` children are positional. For Split, `children[0]` is the first pane, `children[1]` is the second, and extra children append inside the second pane. Below `collapseBelow`, panes stack; `reverse` changes only that narrow-layout stacking order. For Tabs, `children[i]` is the body for `tabs[i]`; keep both arrays in the same order and with the same count. Inactive tab children stay mounted but hidden, so Tables keep polling. Use `Divider` to separate sections and `Markdown` for richer explanatory content.

SearchInput, Select, NumberInput, Chips, and Tree are client-side controls: each needs a literal `id` and writes state under `/ui/<id>/value` (Tree writes the clicked node key); Tabs writes its active key to `/ui/<id>/tab`. Bind those values into a Table's `search` and `filters` props. This filters already-polled rows locally; it does not alter or re-run the named query.

```json
{
  "filters": { "type": "Stack", "props": { "gap": "sm" }, "children": ["query", "status"] },
  "query": { "type": "SearchInput", "props": { "id": "ideaSearch", "placeholder": "Search ideas" } },
  "status": { "type": "Select", "props": { "id": "ideaStatus", "options": ["open", "done"] } },
  "ideas": {
    "type": "Table",
    "props": {
      "data": { "$state": "/queries/allIdeas/data" },
      "columns": [{ "key": "title" }, { "key": "status" }],
      "search": { "$state": "/ui/ideaSearch/value" },
      "filters": { "status": { "$state": "/ui/ideaStatus/value" } }
    }
  }
}
```

`visible` accepts a boolean, a `$state` truthiness binding, comparisons, and logical groups. Put exactly one comparison key in each condition object. The renderer evaluates the first matching key in fixed priority order (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`; otherwise truthiness), so additional comparison keys in the same object are ignored. Use `$and` / `$or` arrays to combine conditions. `not` is a negation FLAG inside a condition object (`"not": true`), never a wrapper around one — `{ "not": { "$state": … } }` is invalid and the validator rejects it. The absent-record pattern (e.g. an alert when a detail query matched nothing) is `{ "$state": "/queries/<q>/data/0/id", "not": true }`:

```json
[
  { "$state": "/route/params/issueId", "gt": 0 },
  {
    "$and": [
      { "$state": "/route/page", "eq": "detail" },
      { "$state": "/route/params/panel", "neq": "hidden" }
    ]
  }
]
```

## Bindings, sentinels, and action chains

Use this exact query binding shape; do not invent `$query`, `$item`, or template strings:

```json
{
  "data": { "$state": "/queries/allIdeas/data" },
  "loading": { "$state": "/queries/allIdeas/loading" },
  "error": { "$state": "/queries/allIdeas/error" }
}
```

Valid `$state` roots are:

- `/queries/<declaredQuery>/...`
- `/forms/<formId>/...`, where a `Form` element has that literal `props.id`
- `/ui/<id>/...`, where a SearchInput, Select, Chips, or Tabs element has that literal `props.id` (SearchInput, Select, and Chips use `/value`; Tabs uses `/tab`)
- `/actions/<declaredAction>/...`
- `/route/page` for the active page name
- `/route/params/<declaredParam>` for a param declared on the current page

`/route` is mirrored as `{ page, params }`. Only declared params appear. Values are coerced by their declared kind: `number` becomes a number when possible; boolean strings `true`/`1` become true; failed number coercion remains the raw string.

Only inside action-chain `params` (`on.<event>`, `Table.rowActions[].actions`, or `Form.onSubmit`) these scoped sentinels are valid, recursively inside objects and arrays:

| Sentinel | Resolves to |
|---|---|
| `{ "$row": "id" }` | Current Table row's `id`; another column name selects that field. |
| `{ "$row": "" }` | Entire current Table row. |
| `{ "$rowIndex": true }` | Current Table row index. |
| `{ "$form": "title" }` | One current Form value. |
| `{ "$form": "" }` | All current Form values. |
| `{ "$state": "/queries/allIdeas/data" }` | Current value at a valid app state path, including action state such as `/actions/refreshIssues/status`. |
| `{ "$chain": "leafTaskId" }` | One chain-scope value, published by a component that runs a task chain; it carries `leafTaskId` and `newTaskId`. Where no chain scope is published, the sentinel is left in place and the action fails instead of silently dropping the parent. |
| `{ "$chain": "" }` | The whole chain scope. |

Each sentinel object must contain exactly the single key shown.

An action-chain step is `{ "action": "<type>", "params": {...} }`. Available action types:

- `app.mutate`: `{ model, op, rowId?, values?, formId? }`, where `op` is `"create"`, `"update"`, or `"delete"`. `update`/`delete` require `rowId` (usually `{ "$row": "id" }`, or `{ "$state": "/route/params/<param>" }` in a Drawer footer); literal `values` keys must be model columns. Successful mutation refetches all queries on that model.
- `app.refresh`: `{ query? }`; omit `query` to refetch all, or name a declared query.
- `app.action`: `{ name, input?, parentTaskId? }`; `name` must be declared in definition `actions`. For a task-kind row action, pass whole-row context with `input: { issue: { "$row": "" } }`. `parentTaskId` chains the created task under an existing one for task-kind actions (typically `{ "$chain": "leafTaskId" }`; a literal or `$state` task id also works); a script or sync action rejects it with 400.
- `app.navigate`: `{ page, params? }`; `page` must be declared, supplied keys must be params of the target page, and every required target param must be supplied. `params` replace the current route params wholesale and may contain action sentinels. Navigation pushes history, so browser Back returns to the previous page/params; only `mode` is preserved automatically.
- `ui.toast`: `{ message, description?, tone?, undo? }`, where `tone` is `"success"`, `"error"`, `"info"` (default), or `"warning"`. `undo: { label?, actions }` adds an Undo button (default label `Undo`) that runs `actions` as a chain; its steps are validated like any chain. Put it after the step it confirms, e.g. a row delete followed by `{ "action": "ui.toast", "params": { "message": "Order deleted", "undo": { "actions": [{ "action": "app.mutate", "params": { "model": "order", "op": "create", "values": { "title": { "$row": "title" } } } }] } } }`. Undo params resolve `$state` when Undo is pressed; `$row` / `$form` resolve when the toast is shown.
- `swarm.sdk`: `{ sdk, args? }`; invokes a catalog-supported Swarm browser SDK method with the viewer's bearer.
- `swarm.call`: `{ method, endpoint: "/api/...", body? }`, where `method` is `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, or `"PATCH"`; raw authenticated API call.

## Patch semantics

`app-patch.definition` is RFC 7396 JSON Merge Patch applied to the stored definition:

- omitted keys stay unchanged;
- object keys merge recursively;
- arrays and scalar values replace;
- `null` deletes a key;
- reusable-element disambiguation: a patch value for `elements.<name>` containing ONLY the `elements` key merges node-by-node; any other key present (`mode`, `root`, `props`, or `export`) makes it a full element replace — restate every field you want kept. In that node-by-node form, `elements.<name>.elements.<id>: null` deletes one node. Literal null nodes are rejected in a full element replace so they cannot be mistaken for deletions.
- otherwise every supplied `pages.<page>.elements.<id>`, `pages.<page>.params.<param>`, `actions.<name>`, `models.<name>.columns.<col>`, and `models.<name>.sources.<src>` value is atomic and replaces that complete declaration; `null` deletes it (deleting a source detaches its rows — see the source lifecycle above).

`pages.<page>: null` deletes a page, except the current `defaultPage` cannot be deleted. `root`, `title`, and top-level `defaultPage` use ordinary merge semantics. A top-level `page` patch is rejected with guidance to patch `pages.<name>` instead.

Because elements, param declarations, actions, and columns are atomic, include the complete desired object when changing one. For example, changing only a Table's `emptyMessage` requires sending its full `{ "type": "Table", "props": ... }` element. The merged result is validated as a whole; on failure, read `issues[]`, correct the paths, and retry without assuming anything was written.

```json
{
  "appId": "<app-id>",
  "description": null,
  "definition": {
    "models": {
      "idea": {
        "columns": {
          "priority": { "kind": "enum", "enum": ["low", "high"], "default": "low" }
        }
      }
    },
    "queries": { "openIdeas": null },
    "pages": {
      "main": {
        "elements": {
          "title": { "type": "Heading", "props": { "text": "Prioritized ideas", "level": "h1" } }
        }
      }
    }
  }
}
```

## Worked example: ideas tracker

Create this with `app-upsert`:

```json
{
  "name": "Ideas Tracker",
  "description": "Collect and manage product ideas",
  "definition": {
    "models": {
      "idea": {
        "columns": {
          "title": { "kind": "string", "required": true },
          "status": { "kind": "enum", "enum": ["open", "done"], "default": "open" }
        }
      }
    },
    "queries": {
      "allIdeas": { "model": "idea", "sort": { "column": "createdAt", "dir": "desc" } }
    },
    "actions": {
      "triage": { "kind": "task", "prompt": "Review current ideas and recommend the next one to pursue" }
    },
    "pages": {
      "main": {
        "root": "root",
        "elements": {
          "root": {
            "type": "Container",
            "props": { "direction": "column", "gap": "lg" },
            "children": ["heading", "formCard", "ideasCard", "triage"]
          },
          "heading": { "type": "Heading", "props": { "text": "Ideas", "level": "h1" } },
          "formCard": {
            "type": "Card",
            "props": { "title": "Add an idea" },
            "children": ["ideaForm"]
          },
          "ideaForm": {
            "type": "Form",
            "props": {
              "id": "newIdea",
              "fields": [{ "name": "title", "label": "Title", "required": true }],
              "submitLabel": "Add",
              "onSubmit": [{
                "action": "app.mutate",
                "params": { "model": "idea", "op": "create", "values": { "$form": "" } }
              }]
            }
          },
          "ideasCard": {
            "type": "Card",
            "props": { "title": "All ideas" },
            "children": ["ideasTable"]
          },
          "ideasTable": {
            "type": "Table",
            "props": {
              "data": { "$state": "/queries/allIdeas/data" },
              "loading": { "$state": "/queries/allIdeas/loading" },
              "error": { "$state": "/queries/allIdeas/error" },
              "columns": [
                { "key": "title", "label": "Title" },
                { "key": "status", "label": "Status", "kind": "badge", "tones": { "open": "info", "done": "success" } }
              ],
              "rowActions": [{
                "label": "Delete",
                "variant": "destructive-outline",
                "actions": [{ "action": "app.mutate", "params": { "model": "idea", "op": "delete", "rowId": { "$row": "id" } } }]
              }]
            }
          },
          "triage": {
            "type": "Button",
            "props": { "label": "Ask swarm to triage", "variant": "secondary" },
            "on": { "press": [{ "action": "app.action", "params": { "name": "triage" } }] }
          }
        }
      }
    },
    "defaultPage": "main"
  }
}
```

The tool returns `{ appId, url: "/apps/<id>" }`. Open that URL to verify the live UI, then continue with the read-patch-validate loop above.

## View and screenshot a live app

- An app renders at `<dashboard>/apps/<id>`. Two view modes are set by query string: `?mode=full` (full-viewport overlay with a slim header) and `?mode=chromeless` (only the rendered page, the embed surface). `app.navigate` keeps only `?mode`.
- Logged-in browser: a fresh dashboard has no connection and redirects to /setup. Seed the localStorage key `agent-swarm-connections` with `{connections:[{id,name,apiUrl,apiKey}],activeId}`. Build the value from an env var and pipe it to `agent-browser eval --stdin`, so the key never reaches a command line. Reload, then pick a user in the "Who are you?" dialog.
- Apps scroll inside an inner canvas, so a full-page screenshot captures only the viewport. Scroll the canvas or raise the viewport height. For mobile, set a 375px-wide viewport before the screenshot.
- App definitions: `GET /api/apps` and `GET /api/apps/<id>` with the API key as Bearer.
- Follow-up edit to a live app: list in the brief the control numbers the edit must not move, and assert them from the backing script before publishing. Take a signed-in screenshot of each changed selector at 1440px wide, save the shots to agent-fs, critique, and repeat at least 3 times. If the backing script caches results, bump its version or force a fresh run so the shots show new data.


### Rows from agents and scripts

Every row tool requires `appId` and `model`. Scripts use underscore names, such as `ctx.swarm.app_row_create` and `ctx.swarm.app_rows_list`.
Results use the usual `data` wrapper, so scripts read `res?.data ?? res`. Rows contain system fields and declared columns at the top level.
Writes record `agent:<agentId>` in `createdBy` and `updatedBy`. Source projections and join keys remain read-only. Each row input must fit within 1 MiB.

`app-rows-list` accepts `equals`, `sort: "<column>:asc|desc"`, and `limit` from 1 to 1000 (default 200).
Equality filters accept declared columns and system columns. Filter values must match the column kind and use strict equality.
`app-rows-delete` requires at least one equality filter and accepts a limit from 1 to 1000 (default 1000).

`app-action-run` returns the REST action body under `data`. Script actions run with the script owner's identity and receive the verified invoking agent as `caller`.
Scripts and extensions cannot invoke `app-action-run`.
