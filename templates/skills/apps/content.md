# Swarm Apps

Swarm Apps are persistent, agent-authored internal applications: a schema-backed row store, named queries, custom script/task actions, and a validated json-render interface served at `/apps/<id>`. Use an app when people need to view and change live records; use `create_page` for a static snapshot and `artifacts` for custom server logic or a UI outside this catalog.

> **Capability gate**: app tools are available when the server's `CAPABILITIES` includes `pages` (for example `CAPABILITIES=core,task-pool,pages`). There is no separate `apps` capability. If these tools are absent from your MCP list, this is why.

## Tools and iteration loop

| Tool | Use it for |
|---|---|
| `app-list` | Discover apps by id, name, description, and timestamps. Definitions are omitted. |
| `app-get` | Read one complete stored definition before changing it. |
| `app-upsert` | Create an app, or replace an existing app's entire definition when you intentionally have the full desired state. |
| `app-patch` | Make a focused change while preserving everything not mentioned in the patch. Prefer this for iteration. |
| `app-query` | Run one declared named query and return its rows. Use this when an agent or saved script needs to consume app data rather than render the app UI. |

For every edit: `app-get` -> modify the smallest coherent subtree -> `app-patch` -> if rejected, fix every returned `issues[]` entry (`path` + `message`) and retry. Validation happens before storage, so a rejected update leaves the saved app unchanged. Do not guess at the current definition or use `app-upsert` with a partial definition.

`app-patch` can also change `name`; omit `description` to preserve it or pass `description: null` to clear it.

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
  "defaultPage": "main"
}
```

Model, query, action, column, page, and page-param names start with a lowercase letter, contain only letters, numbers, or underscores, and are at most 40 characters. A definition has 1-10 models; each model has 1-40 columns.

### Models

Each column is `{ "kind": ..., "required"?: boolean, "default"?: ..., "index"?: boolean, "enum"?: string[] }`.

| `kind` | Values and indexing |
|---|---|
| `string` | String value; set `index: true` only when equality lookups need it. |
| `number` | Finite number; never indexed. |
| `boolean` | Boolean; set `index: true` only when equality lookups need it. |
| `date` | ISO-8601 string; never indexed. |
| `enum` | String from the non-empty unique `enum` list; always indexed, without `index: true`. |

`default` must match the column kind (and be one of the enum values). `required: true` rejects missing/null values unless a default supplies the value. `id`, `createdAt`, and `updatedAt` are system columns and reserved names; rows always expose them.

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

`filter` is a strict AND of equality checks. A filter may target a declared model column or one of the system columns every row carries (`id`, `createdAt`, `updatedAt`) — filtering on `id` is the universal way to select one row for a detail view. A literal value must match the column's kind; date filters compare the stored raw ISO string, not parsed instants. Omit `limit` for the default 200 rows, or set an integer from 1 through 1000. `sort.column` is a model column, `createdAt`, or `updatedAt`; `dir` is `asc` or `desc`. Query runtime state is `{ data, loading, error }` under `/queries/<queryName>`.

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
| `task` | `prompt` must be non-empty; omit `agentId` to use default (lead) assignment. Only set `agentId` to a real agent UUID. Invocation `input` is included as context for the task prompt. |

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

Saved scripts use the generated SDK name `ctx.swarm.app_query({ appId, query, params? })`. Use `app_query` in scripts or workflows that turn current app rows into reports, digests, or follow-up work.

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

Within each page, `root` names one entry in its non-empty `elements` map. Elements are a flat, single-parent tree: ids are map keys, `children` contains ids (not nested elements), all elements must be reachable from `root`, and cycles, missing children, or shared children are invalid. Element and Form/UI ids are page-local. Element keys are `type`, `props`, `children`, `on`, `visible`, `repeat`, and `watch`; only components with a `default` child slot accept `children` (Stack, Grid, Split, Tabs, Container, Card, and Drawer). `watch` maps state paths to an action step or chain.

## Component catalog (all 20)

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
| `Table` | `columns` | `data`, `loading`, `error`, `emptyMessage`, `rowActions`, `search`, `filters`; see below. |
| `Form` | `id`, `fields`, `onSubmit` | `title`, `submitLabel`; see below. |
| `Drawer` | `param` | `title`, `description`, `side: "right" or "left"`, `size: "sm", "md", "lg", or "xl"`; has the `default` child slot. |
| `DetailList` | `fields` | `data`, `emptyMessage`, `columns: 1 or 2`; renders one record without edit controls. |

Table details:

- `columns[]`: `{ key, label?, kind?, tones?: {value: badgeTone}, width?: number }`. `kind` is `text`, `string`, `enum`, `number`, `boolean`, `date`, or `badge`; `string` and `enum` render as text.
- `rowActions[]`: `{ label, variant?, confirm?, actions }`. Variants add `destructive-outline` to the Button variants. `destructive` and `destructive-outline` confirm by default; customize with `{ "title": ..., "description": ..., "confirmLabel": ... }`, or use a bare `confirm` string as the dialog description (use `confirm: false` only for a reversible action).
- `search`: optional string; case-insensitive substring matching across the listed string and number columns. Bind a SearchInput value for client-side search.
- `filters`: optional record of per-column string, number, boolean, or null values. Null, empty, or absent values disable one filter. Bind Select values for client-side equality filters.

Form details:

- `fields[]`: `{ name, label?, kind?, options?: string[], placeholder?, required? }`; `kind` is `string`, `text`, `number`, `boolean`, `date`, or `enum`, and enum fields need `options`.
- Values live at `/forms/<formId>/<fieldName>`. `onSubmit` is an action chain.

Drawer details:

- `param` must name a param declared on the containing page. The drawer is open exactly when `/route/params/<param>` has a non-empty value, so its open state survives refresh and is shareable. Its children mount only while open; closing it clears that param with history replacement.

DetailList details:

- `fields[]`: `{ key, label?, kind?, tones? }`. Kinds reuse Table formatting (`text`, `string`, `number`, `boolean`, `date`, `badge`, `enum`) and add `code` for monospace raw or JSON values. Bind `data` to one record, commonly `/queries/<detailQuery>/data/0`.

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
- `/ui/<id>/...`, where a SearchInput, Select, or Tabs element has that literal `props.id` (SearchInput and Select use `/value`; Tabs uses `/tab`)
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

Each sentinel object must contain exactly the single key shown.

An action-chain step is `{ "action": "<type>", "params": {...} }`. Available action types:

- `app.mutate`: `{ model, op, rowId?, values?, formId? }`, where `op` is `"create"`, `"update"`, or `"delete"`. `update`/`delete` require `rowId` (usually `{ "$row": "id" }`); literal `values` keys must be model columns. Successful mutation refetches all queries on that model.
- `app.refresh`: `{ query? }`; omit `query` to refetch all, or name a declared query.
- `app.action`: `{ name, input? }`; `name` must be declared in definition `actions`. For a task-kind row action, pass whole-row context with `input: { issue: { "$row": "" } }`.
- `app.navigate`: `{ page, params? }`; `page` must be declared, supplied keys must be params of the target page, and every required target param must be supplied. `params` replace the current route params wholesale and may contain action sentinels. Navigation pushes history, so browser Back returns to the previous page/params; only `mode` is preserved automatically.
- `swarm.sdk`: `{ sdk, args? }`; invokes a catalog-supported Swarm browser SDK method with the viewer's bearer.
- `swarm.call`: `{ method, endpoint: "/api/...", body? }`, where `method` is `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, or `"PATCH"`; raw authenticated API call.

## Patch semantics

`app-patch.definition` is RFC 7396 JSON Merge Patch applied to the stored definition:

- omitted keys stay unchanged;
- object keys merge recursively;
- arrays and scalar values replace;
- `null` deletes a key;
- exception: every supplied `pages.<page>.elements.<id>`, `pages.<page>.params.<param>`, `actions.<name>`, and `models.<name>.columns.<col>` value is atomic and replaces that complete stored element/action/column/param declaration; `null` deletes it.

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
