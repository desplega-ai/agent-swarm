# Swarm Apps

Swarm Apps are persistent, agent-authored internal applications: a schema-backed row store, named queries, source sync, custom script/task/sync actions, and a validated json-render interface served at `/apps/<id>`. Use an app when people need to view and change live records; use `create_page` for a static snapshot and `artifacts` for custom server logic or a UI outside this catalog.

> **Capability gate**: app tools are available when the server's `CAPABILITIES` includes `pages` (for example `CAPABILITIES=core,task-pool,pages`). There is no separate `apps` capability. If these tools are absent from your MCP list, this is why.

## Tools and iteration loop

| Tool | Use it for |
|---|---|
| `app-list` | Discover apps by id, name, description, and timestamps. Definitions are omitted. |
| `app-get` | Read one complete stored definition before changing it. |
| `app-upsert` | Create an app, or replace an existing app's entire definition when you intentionally have the full desired state. |
| `app-patch` | Make a focused change while preserving everything not mentioned in the patch. Prefer this for iteration. |
| `app-sync` | Pull source projections into app rows. Optionally restrict one pass with `model` and/or `source`; use this for agent-driven or scheduled refreshes. |
| `app-query` | Run one declared named query and return its rows. Use this when an agent or saved script needs to consume app data rather than render the app UI. |

For every edit: `app-get` -> modify the smallest coherent subtree -> `app-patch` -> if rejected, fix every returned `issues[]` entry (`path` + `message`) and retry. Validation happens before storage, so a rejected update leaves the saved app unchanged. Do not guess at the current definition or use `app-upsert` with a partial definition.

`app-patch` can also change `name`; omit `description` to preserve it or pass `description: null` to clear it.

## Definition reference

```json
{
  "models": {
    "modelName": {
      "sources": {
        "sourceName": { "connector": "github-issues", "joinKey": "externalId", "config": { "repo": "owner/name" } }
      },
      "columns": {
        "externalId": { "kind": "string" },
        "title": { "kind": "string", "source": { "of": "sourceName", "field": "title" } }
      }
    }
  },
  "queries": { "queryName": { "model": "modelName" } },
  "actions": { "actionName": { "kind": "sync", "model": "modelName", "source": "sourceName" } },
  "page": { "root": "root", "elements": { "root": { "type": "Container", "props": {} } } }
}
```

Model, query, action, and column names start with a lowercase letter, contain only letters, numbers, or underscores, and are at most 40 characters. A definition has 1-10 models; each model has 1-40 columns.

### Models

Each column is `{ "kind": ..., "required"?: boolean, "default"?: ..., "index"?: boolean, "enum"?: string[] }`.

| `kind` | Values and indexing | Source transforms |
|---|---|---|
| `string` | String value; set `index: true` only when equality lookups need it. | `slug`, `lower`, `upper` |
| `number` | Finite number; never indexed. | `cents` |
| `boolean` | Boolean; set `index: true` only when equality lookups need it. | none |
| `date` | ISO-8601 string; never indexed. | `date-parse` |
| `enum` | String from the non-empty unique `enum` list; always indexed, without `index: true`. | none |

`default` must match the column kind (and be one of the enum values). `required: true` rejects missing/null values unless a default supplies the value. `id`, `createdAt`, and `updatedAt` are system columns and reserved names; rows always expose them.

`source`, `syncedAt`, and `stale` are also reserved system column names. A model with any synced source must give every required owned column a `default`, because a sync-created row has no caller-supplied owned values.

## Synced sources

Synced sources are one-way inbound projections. A row belongs to at most one source, and a sync refresh updates only that source's bound columns and provenance fields; owned columns remain untouched. Connectors are configured directly on a model for this spike and do not use the connections primitive.

Declare up to four named sources on a model. Source names follow the same lowercase-letter-first, letters/numbers/underscores-only rule as model and query names. Each source declares one string join-key column on that model:

```json
{
  "sources": {
    "tasks": {
      "connector": "swarm-tasks",
      "joinKey": "taskId",
      "config": { "status": "pending,in_progress", "limit": 100, "includeHeartbeat": false }
    },
    "github": {
      "connector": "github-issues",
      "joinKey": "githubNumber",
      "config": { "repo": "owner/name", "state": "open", "limit": 50 }
    }
  }
}
```

| Connector | Configuration | Exact projected `fields` |
|---|---|---|
| `swarm-tasks` | `status?`: comma-separated filter; `limit?`: at most 200, default 100; `includeHeartbeat?`: default `false`. | `id`, `status`, `prompt` (truncated to 1000 characters), `source`, `agentId`, `tags`, `priority`, `createdAt`, `updatedAt`, `vcsProvider`, `vcsNumber`, `vcsUrl`, `vcsAuthor` |
| `github-issues` | `repo`: required `owner/name`; `state?`: `open` \| `closed` \| `all`, default `open`; `limit?`: at most 100, default 50. Public issues only; pull requests returned by GitHub's issues endpoint are excluded. | `number`, `id`, `title`, `state`, `body` (truncated to 1000 characters), `userLogin`, `labelsCsv`, `comments`, `htmlUrl`, `createdAt`, `updatedAt` |

Connector config is a flat map of string, number, or boolean scalars. Unknown config keys are preserved, but `github-issues.config.repo` is required and must match `^[\w.-]+\/[\w.-]+$` (`owner/name` using letters, numbers, underscores, dots, or hyphens); neither segment may be `.` or `..`.

The join-key column must exist on the same model with `kind: "string"`. It is implicitly managed by sync, so it cannot have a `source` binding, be required, or carry a default.

Bind projected fields to columns with `source: { "of": "<sourceName>", "field": "<dotted.path>", "transform"?: "..." }`:

```json
{
  "columns": {
    "githubNumber": { "kind": "string" },
    "title": { "kind": "string", "source": { "of": "github", "field": "title" } },
    "reporter": { "kind": "string", "source": { "of": "github", "field": "userLogin", "transform": "lower" } },
    "openedAt": { "kind": "date", "source": { "of": "github", "field": "createdAt", "transform": "date-parse" } }
  }
}
```

`of` must name a source on the same model and `field` must be non-empty. Dotted paths traverse the connector projection. Source-bound columns cannot be required or have defaults because a valid projection may be null.

| Transform | Compatible column kind | Behavior |
|---|---|---|
| `slug` | `string` | Lowercase; replace non-alphanumeric runs with `-`; trim leading/trailing `-`. |
| `lower` | `string` | Convert to lowercase text. |
| `upper` | `string` | Convert to uppercase text. |
| `cents` | `number` | `Math.round(Number(value) * 100)`; an invalid number becomes null with a sync warning. |
| `date-parse` | `date` | Parse with `new Date(value).toISOString()`; an invalid date becomes null with a sync warning. |

With no transform, sync applies the same kind coercion as an external row write. Wrong-type values, invalid enum members, and failed transforms become null with a warning instead of aborting the pass.

Source-bound columns and join-key columns are read-only on direct row create, update, and bulk mutation surfaces. Mutate them in the upstream source, then run a sync refresh. Only the sync engine may write them.

Synced rows add three flat system fields: `source` is the model source name, `syncedAt` is the ISO timestamp when the row was last confirmed present, and `stale` is `true` when a later pass no longer finds it. Every seen row gets a fresh `syncedAt`; when projected values and `stale` are unchanged, that metadata-only refresh does not change `updatedAt`. Sync keeps vanished rows and flags them stale; reappearance clears the flag. Owned rows do not carry these fields.

Staleness is relative to the connector's configured bounded pull window: a record that falls outside the selected `limit` may be marked stale even when it still exists upstream, so choose connector filters and limits to cover the records whose freshness the app must track.

Surface freshness with existing Table column kinds:

```json
{
  "columns": [
    { "key": "syncedAt", "label": "Last synced", "kind": "date" },
    { "key": "stale", "label": "Freshness", "kind": "badge", "tones": { "true": "warning" } }
  ]
}
```

`syncedAt` is sortable like `createdAt` and `updatedAt`. `source` and `stale` are not server-side query filter/sort fields; use Table `filters` for client-side filtering.

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

`filter` is equality-only and each value must match its model column. `sort.column` is a model column, `createdAt`, `updatedAt`, or `syncedAt`; `dir` is `asc` or `desc`. `limit` is an integer from 1 through 1000. Query runtime state is `{ data, loading, error }` under `/queries/<queryName>`.

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
    },
    "refreshIssues": {
      "kind": "sync",
      "model": "issue",
      "source": "github"
    }
  }
}
```

| Kind | Contract |
|---|---|
| `script` | `scriptId` must identify an existing script; optional `args` are defaults. Invocation input overrides same-named defaults, and the runtime also supplies `app: { id }`. |
| `task` | `prompt` must be non-empty; omit `agentId` to use default (lead) assignment. Only set `agentId` to a real agent UUID. Invocation `input` is included as context for the task prompt. |
| `sync` | Optional `model` narrows to one model with sources; optional `source` narrows to one source. With neither, refresh every model/source pair. A named source must exist on the named model, or on at least one model when `model` is omitted. |

- Invocation state lands at `/actions/<name>` as `{ status, result?, error?, taskId?, taskStatus? }`, where `status` is `"running"`, `"ok"`, or `"error"`.

Use a sync action for an observable Refresh button. Bind a Badge to its status so the same `app.action` invocation exposes `running` -> `ok`/`error`; successful sync actions refetch the app's queries.

```json
{
  "actions": {
    "refreshIssues": { "kind": "sync", "model": "issue", "source": "github" }
  },
  "page": {
    "root": "toolbar",
    "elements": {
      "toolbar": { "type": "Stack", "props": { "direction": "row", "gap": "sm", "align": "center" }, "children": ["refresh", "refreshStatus"] },
      "refresh": {
        "type": "Button",
        "props": { "label": "Refresh", "variant": "outline" },
        "on": { "press": [{ "action": "app.action", "params": { "name": "refreshIssues" } }] }
      },
      "refreshStatus": {
        "type": "Badge",
        "props": { "text": { "$state": "/actions/refreshIssues/status" }, "tone": "neutral" }
      }
    }
  }
}
```

Use a task action named Tackle when a person should hand one synced issue to the swarm. Pass the complete current row under `input.issue`; `{ "$row": "" }` resolves to the whole row and that context lands in the task prompt.

```json
{
  "actions": {
    "tackle": { "kind": "task", "prompt": "Tackle this issue. Inspect the supplied issue context, do the work, and report the outcome." }
  },
  "page": {
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
}
```

For direct MCP calls, `app-sync` accepts `{ appId, model?, source? }` and returns per-pass pull/create/update/stale counts; use it for an agent-triggered refresh. `app-query` accepts `{ appId, query }` and returns rows from that declared named query; use it when an agent needs to read app state without scraping the UI.

Saved scripts use the generated SDK names `ctx.swarm.app_sync({ appId, model?, source? })` and `ctx.swarm.app_query({ appId, query })`. A schedule can target a saved script that calls `app_sync`; do not invent a schedule target type for apps. Use `app_query` in scripts or workflows that turn current app rows into reports, digests, or follow-up work.

### Page tree

`page.root` names one entry in the non-empty `page.elements` map. Elements are a flat, single-parent tree: ids are map keys, `children` contains ids (not nested elements), all elements must be reachable from `root`, and cycles, missing children, or shared children are invalid. Element keys are `type`, `props`, `children`, `on`, `visible`, `repeat`, and `watch`; only components with a `default` child slot accept `children` (Stack, Grid, Split, Tabs, Container, and Card). `watch` maps state paths to an action step or chain.

```json
{
  "page": {
    "root": "root",
    "elements": {
      "root": {
        "type": "Container",
        "props": { "direction": "column", "gap": "md" },
        "children": ["title", "refresh"]
      },
      "title": { "type": "Heading", "props": { "text": "Ideas", "level": "h1" } },
      "refresh": {
        "type": "Button",
        "props": { "label": "Refresh", "variant": "outline" },
        "on": { "press": [{ "action": "app.refresh", "params": {} }] }
      }
    }
  }
}
```

## Component catalog (all 18)

Props reject unknown keys. A `{"$state":"..."}` binding may replace a literal prop value at any depth.

| Component | Required props | Optional props / values |
|---|---|---|
| `Stack` | none | Primary layout; `direction: "column", "row"`, `gap`, `padding: "none", "xs", "sm", "md", "lg", "xl"`; `align: "start", "center", "end", "stretch"`, `justify: "start", "center", "end", "between"`, `wrap`; has the `default` child slot. |
| `Grid` | none | Responsive `columns`: integer 1 through 6, or `{ base, sm, md, lg }` counts 1 through 6; `gap` uses the Stack spacing values; has the `default` child slot. |
| `Split` | none | `ratio: "1-1", "1-2", "2-1", "1-3", "3-1"`, `gap`, `collapseBelow: "sm", "md", "lg"`, `reverse`; has the positional `default` child slot. |
| `Divider` | none | `label`; no children. |
| `Tabs` | `id`, `tabs` | `tabs` entries are `{ key, label? }`; `defaultTab`; has the positional `default` child slot. |
| `Container` | none | Legacy layout primitive; prefer Stack. `direction: "row", "column"`, `gap: "none", "sm", "md", "lg"`; has the `default` child slot. |
| `Card` | none | `title`, `description`; has the `default` child slot. |
| `Heading` | `text` | `level: "h1", "h2", or "h3"`. |
| `Text` | `content` | `tone: "default" or "muted"`. |
| `Markdown` | `content` | Rendered Markdown for help, instructions, and rich prose; no children. |
| `SearchInput` | `id` | `placeholder`, `label`; writes debounced text to `/ui/<id>/value`; no children. |
| `Select` | `id`, `options` | `options` are strings or `{ value, label? }`; `placeholder`, `label`, `clearable`; writes a string or null to `/ui/<id>/value`; no children. |
| `Button` | `label` | `variant: "default", "secondary", "outline", "ghost", or "destructive"`; dispatch with element-level `on.press`. |
| `Metric` | `label`, `value` | `value` is string or number. |
| `Alert` | `message` | `title`, `tone: "info", "success", "warning", or "error"`. |
| `Badge` | `text` | `text` is string or number; `tone: "neutral", "success", "active", "error", "info", "pending", "warning", or "paused"`. |
| `Table` | `columns` | `data`, `loading`, `error`, `emptyMessage`, `rowActions`, `search`, `filters`; synced freshness uses ordinary date/badge columns; see below. |
| `Form` | `id`, `fields`, `onSubmit` | `title`, `submitLabel`; see below. |

Table details:

- `columns[]`: `{ key, label?, kind?, tones?: {value: badgeTone}, width?: number }`. `kind` is `text`, `string`, `enum`, `number`, `boolean`, `date`, or `badge`; `string` and `enum` render as text.
- Synced-row freshness uses ordinary columns: render `syncedAt` with `kind: "date"`, and render `stale` with `kind: "badge"` plus `tones: { "true": "warning" }`.
- `rowActions[]`: `{ label, variant?, confirm?, actions }`. Variants add `destructive-outline` to the Button variants. `destructive` and `destructive-outline` confirm by default; customize with `{ "title": ..., "description": ..., "confirmLabel": ... }`, or use a bare `confirm` string as the dialog description (use `confirm: false` only for a reversible action).
- `search`: optional string; case-insensitive substring matching across the listed string and number columns. Bind a SearchInput value for client-side search.
- `filters`: optional record of per-column string, number, boolean, or null values. Null, empty, or absent values disable one filter. Bind Select values for client-side equality filters.

Form details:

- `fields[]`: `{ name, label?, kind?, options?: string[], placeholder?, required? }`; `kind` is `string`, `text`, `number`, `boolean`, `date`, or `enum`, and enum fields need `options`.
- Values live at `/forms/<formId>/<fieldName>`. `onSubmit` is an action chain.

## Layout & interactivity

Use `Stack` as the primary page and section layout; `Container` is the legacy two-prop primitive retained for existing pages. Stack supports vertical or horizontal flow, shared spacing, alignment, justification, wrapping, and padding. Use `Grid` for responsive card or metric strips: set one column count or breakpoint counts such as `{ "base": 1, "md": 2, "lg": 3 }`.

`Split` and `Tabs` children are positional. For Split, `children[0]` is the first pane, `children[1]` is the second, and extra children append inside the second pane. Below `collapseBelow`, panes stack; `reverse` changes only that narrow-layout stacking order. For Tabs, `children[i]` is the body for `tabs[i]`; keep both arrays in the same order and with the same count. Inactive tab children stay mounted but hidden, so Tables keep polling. Use `Divider` to separate sections and `Markdown` for richer explanatory content.

SearchInput and Select are client-side controls: each needs a literal `id` and writes state under `/ui/<id>/value`; Tabs writes its active key to `/ui/<id>/tab`. Bind those values into a Table's `search` and `filters` props. This filters already-polled rows locally; it does not alter or re-run the named query.

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
- `/ui/<id>/...`, where a SearchInput, Select, or Tabs element has that literal `props.id` (SearchInput and Select use `/value`; Tabs uses `/tab`)
- `/actions/<declaredAction>/...`

Only inside action-chain `params` (`on.<event>`, `Table.rowActions[].actions`, or `Form.onSubmit`) these scoped sentinels are valid, recursively inside objects and arrays:

| Sentinel | Resolves to |
|---|---|
| `{ "$row": "id" }` | Current Table row's `id`; another column name selects that field. |
| `{ "$row": "" }` | Entire current Table row. |
| `{ "$rowIndex": true }` | Current Table row index. |
| `{ "$form": "title" }` | One current Form value. |
| `{ "$form": "" }` | All current Form values. |
| `{ "$state": "/queries/allIdeas/data" }` | Current value at a valid app state path, including action state such as `/actions/refreshIssues/status`. |

Each sentinel object must contain exactly the single key shown.

An action-chain step is `{ "action": "<type>", "params": {...} }`. Available action types:

- `app.mutate`: `{ model, op, rowId?, values?, formId? }`, where `op` is `"create"`, `"update"`, or `"delete"`. `update`/`delete` require `rowId` (usually `{ "$row": "id" }`); literal `values` keys must be model columns. Successful mutation refetches all queries on that model.
- `app.refresh`: `{ query? }`; omit `query` to refetch all, or name a declared query.
- `app.action`: `{ name, input? }`; `name` must be declared in definition `actions`. Use a sync-kind action for a Refresh control. For a task-kind row action, pass whole-row context with `input: { issue: { "$row": "" } }`.
- `swarm.sdk`: `{ sdk, args? }`; invokes a catalog-supported Swarm browser SDK method with the viewer's bearer.
- `swarm.call`: `{ method, endpoint: "/api/...", body? }`, where `method` is `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, or `"PATCH"`; raw authenticated API call.

## Patch semantics

`app-patch.definition` is RFC 7396 JSON Merge Patch applied to the stored definition:

- omitted keys stay unchanged;
- object keys merge recursively;
- arrays and scalar values replace;
- `null` deletes a key;
- exception: every supplied `page.elements.<id>`, `actions.<name>`, `models.<name>.columns.<col>`, and `models.<name>.sources.<src>` value is atomic and replaces that complete stored element/action/column/source; `null` deletes it.

Because elements, actions, columns, and sources are atomic, include the complete desired object when changing one. For example, changing only a Table's `emptyMessage` requires sending its full `{ "type": "Table", "props": ... }` element; changing a source's `config.state` requires sending its complete `{ "connector", "joinKey", "config" }` source definition. The merged result is validated as a whole; on failure, read `issues[]`, correct the paths, and retry without assuming anything was written.

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
    "page": {
      "elements": {
        "title": { "type": "Heading", "props": { "text": "Prioritized ideas", "level": "h1" } }
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
    "page": {
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
  }
}
```

The tool returns `{ appId, url: "/apps/<id>" }`. Open that URL to verify the live UI, then continue with the read-patch-validate loop above.
