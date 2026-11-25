# App bindings and expressions

A prop value may be a binding instead of a literal. `{ "$state": "<path>" }` reads state.

| Root | Reads | Example |
|---|---|---|
| `/queries/<q>/data`, `/loading`, `/error` | A declared query's rows and status | `{ "$state": "/queries/days/data" }` |
| `/route`, `/route/page`, `/route/params` | The whole route, the page name, all params | `{ "$state": "/route/params" }` |
| `/route/params/<p>` | A param declared on this page | `{ "$state": "/route/params/from" }` |
| `/app/<name>` | App-wide `state` (writable) | `{ "$state": "/app/window" }` |
| `/local/<name>` | Page `state` (writable) | `{ "$state": "/local/tab" }` |
| `/user/<field>` | A declared `userConfig` field, exactly one level | `{ "$state": "/user/team" }` |
| `/forms/<formId>/<field>` | A field of the Form with that literal `props.id` | `{ "$state": "/forms/add/title" }` |
| `/ui/<id>/...` | A control with that literal `props.id`: `/value` (SearchInput, Select, Chips, NumberInput), `/tab` (Tabs), `/from` and `/to` (DateRange) | `{ "$state": "/ui/status/value" }` |
| `/actions/<a>/status` | A declared action's run state | `{ "$state": "/actions/refresh/status" }` |
| `/presence/peers`, `/presence/names`, `/presence/count` | Other viewers of this page | `{ "$state": "/presence/count" }` |

Writes (`ui.set`, `$bindState` on `Input.value`) take only `/app/<name>` and `/local/<name>`.

## Page params

`pages.<p>.params.<name>: { kind?, required? }`. `kind` is `string` (default), `number` or `boolean`. There is no `date` param kind: pass a date as an ISO `YYYY-MM-DD` string param. `date` is a model column kind; a date filter compares the stored ISO string. Read a param with `{ "$state": "/route/params/<name>" }`. `app.navigate` sets them: `{ "action": "app.navigate", "params": { "page": "detail", "params": { "id": { "$row": "id" } } } }`.

## Query `$param`

A query filter value may be `{ "$param": "<name>" }`: `"filter": { "day": { "$param": "from" } }`. The page supplies a declared route param of the same name. `app-query` takes `params: { from: "2026-11-01" }`. A missing value is an error, never an unfiltered read.

## Templates and repeats

- `{ "$template": "Hello ${/user/name}" }` interpolates `${path}` reads into a string. Inside a `repeat`, a bare `${field}` reads the item's field.
- `repeat: { "statePath": "/queries/q/data" }` renders an element once per item. Inside it, `{ "$item": "field" }` reads the item (`""` for the whole item) and `{ "$index": true }` its index.

## Action-chain sentinels

Valid inside action `params` only: `{ "$row": "id" }` (`""` for the row), `{ "$rowIndex": true }`, `{ "$form": "title" }`, `{ "$chain": "createdRowId" }`.

## Live data and watch

- `OnEnter`: `on.enter` runs on mount and when `props.deps` changes (`"deps": { "$state": "/route" }`). `props.everyMs` (1000 or more) re-runs it on an interval while the tab is visible.
- `watch: { "/local/tab": [ { "action": "app.refresh" } ] }` on an element runs a chain when a state path changes, never on first render. A watch chain may run one `app.action` or `ui.set`, as its last step.

## Expressions

One operator key with an operand array, in any prop or action param: `$add`, `$sub`, `$mul`, `$div`, `$min`, `$max`, `$eq`, `$neq`, `$not`, `$if`, `$join`, `$split`, `$length`. Example: `{ "$if": [{ "$state": "/local/live" }, 2000, null] }`.

## Visibility

`visible`: a boolean, `{ "$state": "/local/open" }`, `{ "$state": "/ui/tab/value", "eq": "all" }` (also `neq`, `gt`, `gte`, `lt`, `lte`, `not: true`), or `{ "$and": [...] }` / `{ "$or": [...] }`.
