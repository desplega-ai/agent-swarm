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

For every edit: `app-get` -> modify the smallest coherent subtree -> `app-patch` -> if rejected, fix every returned `issues[]` entry (`path` + `message`) and retry. Validation happens before storage, so a rejected update leaves the saved app unchanged. Do not guess at the current definition or use `app-upsert` with a partial definition.

`app-patch` can also change `name`; omit `description` to preserve it or pass `description: null` to clear it.

## Definition reference

```json
{
  "models": { "modelName": { "columns": {} } },
  "queries": { "queryName": { "model": "modelName" } },
  "actions": { "actionName": { "kind": "task", "prompt": "..." } },
  "page": { "root": "root", "elements": { "root": { "type": "Container", "props": {} } } }
}
```

Model, query, action, and column names start with a lowercase letter, contain only letters, numbers, or underscores, and are at most 40 characters. A definition has 1-10 models; each model has 1-40 columns.

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

`filter` is equality-only and each value must match its model column. `sort.column` is a model column, `createdAt`, or `updatedAt`; `dir` is `asc` or `desc`. `limit` is an integer from 1 through 1000. Query runtime state is `{ data, loading, error }` under `/queries/<queryName>`.

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

- `script`: `scriptId` must identify an existing script; optional `args` are defaults. Invocation input overrides same-named defaults, and the runtime also supplies `app: { id }`.
- `task`: `prompt` must be non-empty; omit `agentId` to use default (lead) assignment. Only set `agentId` to a real agent UUID.
- Invocation state lands at `/actions/<name>` as `{ status: "running"|"ok"|"error", result?, error?, taskId?, taskStatus? }`.

### Page tree

`page.root` names one entry in the non-empty `page.elements` map. Elements are a flat, single-parent tree: ids are map keys, `children` contains ids (not nested elements), all elements must be reachable from `root`, and cycles, missing children, or shared children are invalid. Element keys are `type`, `props`, `children`, `on`, `visible`, `repeat`, and `watch`; only `Container` and `Card` accept `children`. `watch` maps state paths to an action step or chain.

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

## Component catalog (all 10)

Props reject unknown keys. A `{"$state":"..."}` binding may replace a literal prop value at any depth.

| Component | Required props | Optional props / values |
|---|---|---|
| `Container` | none | `direction: "row" or "column"`, `gap: "none", "sm", "md", or "lg"`; has the `default` child slot. |
| `Card` | none | `title`, `description`; has the `default` child slot. |
| `Heading` | `text` | `level: "h1", "h2", or "h3"`. |
| `Text` | `content` | `tone: "default" or "muted"`. |
| `Button` | `label` | `variant: "default", "secondary", "outline", "ghost", or "destructive"`; dispatch with element-level `on.press`. |
| `Metric` | `label`, `value` | `value` is string or number. |
| `Alert` | `message` | `title`, `tone: "info", "success", "warning", or "error"`. |
| `Badge` | `text` | `text` is string or number; `tone: "neutral", "success", "active", "error", "info", "pending", "warning", or "paused"`. |
| `Table` | `columns` | `data`, `loading`, `error`, `emptyMessage`, `rowActions`; see below. |
| `Form` | `id`, `fields`, `onSubmit` | `title`, `submitLabel`; see below. |

Table details:

- `columns[]`: `{ key, label?, kind?: "text"|"string"|"enum"|"number"|"boolean"|"date"|"badge", tones?: {value: badgeTone}, width?: number }`. `string` and `enum` render as text.
- `rowActions[]`: `{ label, variant?, confirm?, actions }`. Variants add `destructive-outline` to the Button variants. `destructive` and `destructive-outline` confirm by default; customize with `{ "title": ..., "description": ..., "confirmLabel": ... }`, or use a bare `confirm` string as the dialog description (use `confirm: false` only for a reversible action).

Form details:

- `fields[]`: `{ name, label?, kind?: "string"|"text"|"number"|"boolean"|"date"|"enum", options?: string[], placeholder?, required? }`; enum fields need `options`.
- Values live at `/forms/<formId>/<fieldName>`. `onSubmit` is an action chain.

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
- `/actions/<declaredAction>/...`

Only inside action-chain `params` (`on.<event>`, `Table.rowActions[].actions`, or `Form.onSubmit`) these scoped sentinels are valid, recursively inside objects and arrays:

| Sentinel | Resolves to |
|---|---|
| `{ "$row": "id" }` | Current Table row's `id`; another column name selects that field. |
| `{ "$row": "" }` | Entire current Table row. |
| `{ "$rowIndex": true }` | Current Table row index. |
| `{ "$form": "title" }` | One current Form value. |
| `{ "$form": "" }` | All current Form values. |
| `{ "$state": "/queries/allIdeas/data" }` | Current value at a valid app state path. |

Each sentinel object must contain exactly the single key shown.

An action-chain step is `{ "action": "<type>", "params": {...} }`. Available action types:

- `app.mutate`: `{ model, op: "create"|"update"|"delete", rowId?, values?, formId? }`. `update`/`delete` require `rowId` (usually `{ "$row": "id" }`); literal `values` keys must be model columns. Successful mutation refetches all queries on that model.
- `app.refresh`: `{ query? }`; omit `query` to refetch all, or name a declared query.
- `app.action`: `{ name, input? }`; `name` must be declared in definition `actions`.
- `swarm.sdk`: `{ sdk, args? }`; invokes a catalog-supported Swarm browser SDK method with the viewer's bearer.
- `swarm.call`: `{ method: "GET"|"POST"|"PUT"|"DELETE"|"PATCH", endpoint: "/api/...", body? }`; raw authenticated API call.

## Patch semantics

`app-patch.definition` is RFC 7396 JSON Merge Patch applied to the stored definition:

- omitted keys stay unchanged;
- object keys merge recursively;
- arrays and scalar values replace;
- `null` deletes a key;
- exception: every supplied `page.elements.<id>` and `actions.<name>` value is atomic and replaces that complete stored element/action; `null` deletes it.

Because elements and actions are atomic, include the complete desired object when changing one. For example, changing only a Table's `emptyMessage` requires sending its full `{ "type": "Table", "props": ... }` element. The merged result is validated as a whole; on failure, read `issues[]`, correct the paths, and retry without assuming anything was written.

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
