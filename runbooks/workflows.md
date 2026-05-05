# Workflows runbook

Workflows are DAGs of nodes connected via `next`. Reference for authoring nodes with the `create-workflow` tool.

## Cross-node data access

Upstream outputs are **not** available by default. Declare an `inputs` mapping:

- Keys are local names for `{{interpolation}}`.
- Values are context paths (usually a node ID).
- Agent-task output shape is `{ taskId, taskOutput }`, so access via `localName.taskOutput.field`.
- For trigger data: `{ "pr": "trigger.pullRequest" }` → `{{pr.number}}`.

Without `inputs`, upstream references silently resolve to empty strings — check `diagnostics.unresolvedTokens`.

## Structured output

Schema goes in `config.outputSchema` (not node-level). The agent produces JSON matching it; validated by `store-progress`.

## Interpolation

`{{path.to.value}}` in any string field inside `config`. Objects get JSON-stringified; nulls become empty strings.

## Agent-task config fields

- `template` (required)
- `outputSchema`
- `agentId`
- `tags`
- `priority` (0–100, default 50)
- `offerMode`
- `dir`
- `vcsRepo`
- `model`
- `parentTaskId`

## Trigger schema

`triggerSchema` is an optional JSON Schema attached to a workflow that validates the `triggerData` payload for every trigger path — manual `/trigger`, webhooks, schedules, and MCP `trigger-workflow`. When set, mismatched payloads are rejected before the workflow starts (no run is created, no nodes execute). When unset (the default), any payload is accepted.

Use one when you want to fail fast and self-document the contract a webhook or upstream caller is expected to honor (e.g. "this workflow needs `pr.number`").

### Supported subset

The validator (`src/workflows/json-schema-validator.ts`) supports a deliberately minimal JSON-Schema subset:

- `type` — `"object"`, `"string"`, `"number"`, `"boolean"`, `"array"`
- `required` — array of required property names (objects only)
- `properties` — map of property name → schema (recursive)
- `enum` — array of allowed primitive values (strict equality)
- `const` — a single allowed value (strict equality)
- `items` — schema applied to every element of an array (recursive)

**All other keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`, `additionalProperties`, …) are silently ignored.** Authoring tools should surface this caveat near the editor, and reviewers should reject schemas that depend on unsupported keywords for correctness.

### Setting `triggerSchema`

| Surface | Method | Body field | `null` clears? |
|---|---|---|---|
| MCP | `create-workflow` | `triggerSchema?: object` | n/a (omit = none) |
| MCP | `update-workflow` | `triggerSchema?: object \| null` | yes |
| MCP | `patch-workflow` | `triggerSchema?: object \| null` | yes |
| HTTP | `POST /api/workflows` | `triggerSchema?: object` | n/a |
| HTTP | `PUT /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |
| HTTP | `PATCH /api/workflows/{id}` | `triggerSchema?: object \| null` | yes |

Semantics: `undefined` / omitted = leave unchanged, object = set/replace, `null` = clear. Identical across all three update surfaces.

### How errors surface

When a trigger payload fails validation the engine throws `TriggerSchemaError` (`src/workflows/engine.ts:31-36`) carrying the per-field validator output. Each surface formats it differently but the underlying `details: string[]` array is identical:

**HTTP** — both `POST /api/workflows/{id}/trigger` and `POST /api/workflows/webhooks/{id}` return `400 Bad Request` with the frozen body shape:

```json
{
  "error": "TriggerSchemaError",
  "message": "Trigger schema validation failed: root: missing required property \"pr\"",
  "details": ["root: missing required property \"pr\""]
}
```

`details` is the array returned by `validateJsonSchema()` — one string per failing field, prefixed with the dotted path (e.g. `pr.number: expected type "number", got string`). The helper that writes this body lives at `src/http/utils.ts` (`triggerSchemaErrorResponse`).

**MCP** — `trigger-workflow` returns `success: false` with structured content alongside a human-readable bulleted message in `content[0].text`:

```json
{
  "success": false,
  "message": "Trigger payload did not match the workflow's triggerSchema (1 error).",
  "validationErrors": ["root: missing required property \"pr\""],
  "triggerSchema": { "type": "object", "required": ["pr"], "properties": { ... } }
}
```

The echoed `triggerSchema` lets agents self-correct without a follow-up `get-workflow` call. Generic non-validation failures still flow through the existing `Failed: ${err}` path.

### Cross-references

- Validator implementation + supported subset: `src/workflows/json-schema-validator.ts`
- Engine throw site: `src/workflows/engine.ts:31-36` (`TriggerSchemaError` class) and `:54-60` (validation gate)
- HTTP 400 helper: `src/http/utils.ts` (`triggerSchemaErrorResponse`)
- MCP error formatting: `src/tools/workflows/trigger-workflow.ts` (`TriggerSchemaError` branch)
