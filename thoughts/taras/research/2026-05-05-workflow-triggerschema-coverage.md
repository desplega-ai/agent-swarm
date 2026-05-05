---
date: 2026-05-05
researcher: Claude (with Taras)
git_commit: a8fca0d206f4cc9b7262c484c4c4f006c2dd5c91
branch: main
repository: agent-swarm
topic: "Workflow `triggerSchema` end-to-end coverage"
tags: [workflows, triggerSchema, mcp-tools, frontend, validation]
status: complete
last_updated: 2026-05-05
last_updated_by: Claude
autonomy: critical
---

# Workflow `triggerSchema` end-to-end coverage

## Research question

> "I think the `triggerSchema` of the workflows is not used, and it should be, right?
>
> It should affect:
> 1. MCP tools to be able to change that (patch is ok)
> 2. FE to show in the trigger tab
> 3. Ensure it's validated on wf trigger"

## Summary

The hypothesis is **partially correct**:

| Layer | `triggerSchema` supported? |
|---|---|
| Type schemas (`src/types.ts`) | ✅ yes |
| DB column + migration | ✅ yes (migration `012_trigger_schema.sql`) |
| DB CRUD layer (`src/be/db.ts`) | ✅ yes (read, write, update, set-to-null) |
| Version snapshots (`src/workflows/version.ts`) | ✅ yes |
| Runtime validation in engine (`src/workflows/engine.ts`) | ✅ yes — `startWorkflowExecution` validates trigger data via `validateJsonSchema` and throws `TriggerSchemaError` |
| HTTP `POST /api/workflows` (create) | ✅ accepts `triggerSchema` in body |
| HTTP `PUT /api/workflows/{id}` (update) | ✅ accepts `triggerSchema` in body (nullable) |
| HTTP `PATCH /api/workflows/{id}` | ❌ only patches `definition` (DAG nodes) — does NOT touch `triggerSchema` |
| HTTP `POST /api/workflows/{id}/trigger` | ✅ goes through `startWorkflowExecution` → validation runs |
| HTTP `POST /api/webhooks/{workflowId}` | ✅ goes through `startWorkflowExecution` → validation runs |
| Schedule trigger | ✅ goes through `startWorkflowExecution` → validation runs |
| MCP tool `create-workflow` | ❌ inputSchema does NOT include `triggerSchema`, not passed to `createWorkflow()` |
| MCP tool `update-workflow` | ❌ inputSchema does NOT include `triggerSchema`, not passed to `updateWorkflow()` |
| MCP tool `patch-workflow` | ❌ only patches definition (same scope as HTTP PATCH) |
| MCP tool `trigger-workflow` | ✅ takes `triggerData`; validation happens server-side via `startWorkflowExecution` |
| Frontend `new-ui/` | 🟡 partial — Triggers tab exists (latest commit `a8fca0d`) and renders `triggerSchema` read-only via `JsonTree`. No editor; `useUpdateWorkflow` payload only supports `name \| description \| enabled`, so the FE cannot author/modify `triggerSchema` |
| Docs (`runbooks/workflows.md`, `CLAUDE.md`) | ❌ `triggerSchema` not mentioned anywhere |
| OpenAPI spec | ✅ `triggerSchema` appears (auto-generated from HTTP route definitions) |

So **runtime validation is wired up**, but **MCP tools, the PATCH endpoint, and the FE cannot author `triggerSchema`** today. To set one, an agent (or a UI feature) currently has to call `POST` or `PUT` directly via HTTP.

## Detailed findings

### 1. Type definitions

`src/types.ts:910` (in `WorkflowSnapshotSchema`):

```ts
triggerSchema: z.record(z.string(), z.unknown()).optional(),
```

`src/types.ts:928` (in `WorkflowSchema`):

```ts
triggerSchema: z.record(z.string(), z.unknown()).optional(),
```

Both treat it as an optional, opaque JSON object (i.e. a JSON Schema document). There is no Zod-level shape constraint on what counts as a valid JSON Schema; that's left to the runtime validator.

### 2. DB persistence

Migration: `src/be/migrations/012_trigger_schema.sql:1`
```sql
ALTER TABLE workflows ADD COLUMN triggerSchema TEXT;
```

DB layer in `src/be/db.ts`:
- Row type field: `triggerSchema: string | null;` (line 5409)
- Read: `JSON.parse(row.triggerSchema)` if present (lines 5427–5428)
- Insert: `INSERT INTO workflows (… triggerSchema, …)` (line 5468), serialized as JSON (line 5479)
- Update: handles `triggerSchema` set/unset (`updates.push("triggerSchema = ?")`) at lines 5554–5556
- Update input type allows `Record<string, unknown> | null` (line 5519), supporting "remove" semantics

### 3. Runtime validation

`src/workflows/engine.ts:29`:

```ts
/**
 * Error thrown when trigger data fails validation against a workflow's triggerSchema.
 */
export class TriggerSchemaError extends Error { … }
```

`src/workflows/engine.ts:54-60` (inside `startWorkflowExecution`):

```ts
// Validate trigger data against triggerSchema (before any DB writes)
if (workflow.triggerSchema) {
  const validationErrors = validateJsonSchema(workflow.triggerSchema, triggerData);
  if (validationErrors.length > 0) {
    throw new TriggerSchemaError(validationErrors);
  }
}
```

The validator implementation lives in `src/workflows/json-schema-validator.ts`. It is a **hand-rolled minimal validator** — its file-level comment says: *"Supports the subset needed for workflow I/O schemas: type (object/string/number/boolean/array), required, properties (recursive)"*. The implementation also handles `enum` and `const`. There is no support for `oneOf`/`anyOf`/`allOf`, `$ref`, format validators, pattern, additionalProperties, or array `items` constraints. A `triggerSchema` that uses any of those features will be silently ignored (extra keys), not rejected — keep schemas to the supported subset.

All trigger entry points end up here:
- HTTP `POST /api/workflows/{id}/trigger` → `src/http/workflows.ts:605`
- HTTP `POST /api/webhooks/{workflowId}` → `src/workflows/triggers.ts:51` (`handleWebhookTrigger`)
- Schedule trigger → `src/workflows/triggers.ts:75` (`handleScheduleTrigger`)
- MCP tool `trigger-workflow` → `src/tools/workflows/trigger-workflow.ts:47`

The HTTP handlers translate `TriggerSchemaError` to a 400 response:
- Manual trigger: `src/http/workflows.ts:606-612`
- Webhook: `src/http/workflows.ts:351-352`

### 4. Version snapshots

`src/workflows/version.ts:32` includes `triggerSchema` in the snapshot, so version history preserves changes to the schema.

### 5. HTTP routes

`src/http/workflows.ts` is the single file holding all workflow routes (defined via the `route()` factory).

- **POST `/api/workflows`** (`createWorkflowRoute`, line 46): body schema includes `triggerSchema: z.record(z.string(), z.unknown()).optional()` at line 59. Handler passes `parsed.body.triggerSchema` to `createWorkflow()` at line 415.
- **PUT `/api/workflows/{id}`** (`updateWorkflowRoute`, line 82): body schema includes `triggerSchema: z.record(...).optional().nullable()` at line 96. Handler passes it through, treating `null` as "remove" at line 560.
- **PATCH `/api/workflows/{id}`** (`patchWorkflowRoute`, line 108): body is `WorkflowDefinitionPatchSchema` — *only* node-level create/update/delete operations on the DAG. **No `triggerSchema` field, no metadata fields.** Confirmed at lines 483–520.
- **PATCH `/api/workflows/{id}/nodes/{nodeId}`** (`patchWorkflowNodeRoute`, line 123): patches a single node — no `triggerSchema`.
- **POST `/api/workflows/{id}/trigger`** (`triggerWorkflowRoute`, line 151): no declared body schema in route def; handler reads body via `parseBody<Record<string, unknown>>` (line 601) and passes it as `triggerData` to `startWorkflowExecution` (line 605). Validation happens inside the engine.
- **POST `/api/webhooks/{workflowId}`** (`webhookTriggerRoute`, line 246): raw body string used both for HMAC and as `triggerData`.

### 6. MCP tools

All workflow MCP tools live under `src/tools/workflows/`:
- `create-workflow.ts`
- `update-workflow.ts`
- `patch-workflow.ts`
- `patch-workflow-node.ts`
- `trigger-workflow.ts`
- `get-workflow.ts`
- `list-workflows.ts`
- `delete-workflow.ts`
- `list-workflow-runs.ts`
- `get-workflow-run.ts`
- `cancel-workflow-run.ts`
- `retry-workflow-run.ts`
- `index.ts`

`grep -n triggerSchema src/tools/workflows/*.ts` returns **zero matches**. Specifically:

- **`create-workflow.ts`**: `inputSchema` (lines 28–60) declares `name, description, definition, triggers, cooldown, input, dir, vcsRepo` — no `triggerSchema`. The `createWorkflow()` call at lines 96–106 omits `triggerSchema`, so the column is always written as `NULL` for workflows authored through this tool.
- **`update-workflow.ts`**: `inputSchema` (lines 22–50) declares the same set plus `enabled` — no `triggerSchema`. The `updateWorkflow()` call at lines 94–104 omits it, so this tool cannot set or clear `triggerSchema`.
- **`patch-workflow.ts`**: `inputSchema` (lines 20–51) only contains `id, update, delete, create, onNodeFailure` — purely DAG-level operations. No metadata fields. The handler calls `updateWorkflow(id, { definition: patchResult.definition })` at line 97 — only the definition is updated.
- **`trigger-workflow.ts`**: declares `id` and an optional `triggerData: z.record(z.string(), z.unknown())` (line 17–20) and forwards `triggerData ?? {}` to `startWorkflowExecution` (line 47). Validation happens server-side; the tool description does not mention `triggerSchema` or what shape `triggerData` should have for a given workflow.

### 7. Frontend (`new-ui/`)

`new-ui/` is a **React + Vite** app (see `new-ui/CLAUDE.md`), not Next.js. The current workflow detail surface is `new-ui/src/pages/workflows/[id]/page.tsx`. As of commit `a8fca0d` ("feat(ui): workflow ui changes"), the page has **four tabs** (lines 239–243):

```tsx
<TabsList>
  <TabsTrigger value="definition">Definition</TabsTrigger>
  <TabsTrigger value="triggers">Triggers ({workflow.triggers.length})</TabsTrigger>
  <TabsTrigger value="runs">Runs ({runs?.length ?? 0})</TabsTrigger>
  <TabsTrigger value="versions">Versions</TabsTrigger>
</TabsList>
```

The **Triggers tab** is wired to `triggerSchema`:

- `TriggersDetailPanel` (line 1094) takes a `triggerSchema?: Record<string, unknown>` prop (line 1105).
- When `triggerSchema != null`, it renders a "Trigger schema" section (line 1144) with the helper text *"Validates the payload sent to this workflow before any node runs."* and shows the schema via `JsonTree` (line 1151).
- A condensed summary also surfaces on the Definition tab via `TriggersOverviewStrip` (page.tsx:1029, also `triggerSchema`-aware at line 1079).
- The `Workflow` type in `new-ui/src/api/types.ts:454` includes `triggerSchema?: Record<string, unknown>`. Version snapshots also carry it (line 518).

So the FE **renders `triggerSchema` read-only**.

What the FE cannot do today:
- **Author / edit `triggerSchema`.** `useUpdateWorkflow` (`new-ui/src/api/hooks/use-workflows.ts:43-58`) accepts only `Partial<{ name; description; enabled }>`. The underlying `api.updateWorkflow` (`new-ui/src/api/client.ts:652-664`) mirrors that narrow type. To set or change `triggerSchema` from the UI, both would need to be widened.
- **Test a payload against `triggerSchema`.** There is no "test trigger" form on the Triggers tab — only a top-bar `Trigger` button (page.tsx:190) that calls `triggerWorkflow.mutate({ id })` with no `triggerData`, so the engine receives `{}` and any non-trivial `triggerSchema` will reject it with a 400.

### 8. Tests

Two test files cover `triggerSchema`:
- `src/tests/workflow-trigger-schema.test.ts` — dedicated suite. Sections (per `grep -n`):
  - Line 74: "Workflow triggerSchema (Phase 4)"
  - Line 162: "No triggerSchema — Any Payload Accepted"
  - Line 272: "triggerSchema Persisted in DB"
  - Line 347: "empty triggerSchema ({}) — accepts any payload"
- `src/tests/workflow-integration-io.test.ts` — fuller pipeline:
  - Line 175: "Full pipeline: triggerSchema + inputs + inputSchema + convergence + chained data flow"
  - Line 251: "triggerSchema rejects invalid payload (missing required field)"
  - Line 270: "triggerSchema rejects wrong type"
  - Line 281: "triggerSchema accepts valid payload — true branch executes"
  - Line 705: "No triggerSchema — any payload accepted (backward compat)"

The phrase "Phase 4" in the test file name suggests this was implemented as part of a phased plan; coverage is real and intentional.

### 9. Docs

- **`runbooks/workflows.md`** (35 lines, full content read): describes node DAG, cross-node `inputs`, structured output, interpolation, and agent-task config fields. Mentions `trigger` only in the interpolation example (`{ "pr": "trigger.pullRequest" }` → `{{pr.number}}`). **Does not mention `triggerSchema` at all.**
- **`CLAUDE.md`** (project root): the workflows guard block points at `runbooks/workflows.md`; no mention of `triggerSchema`.
- **`MCP.md`**: not exhaustively read in this pass, but `grep` returned no `triggerSchema` hits.
- **OpenAPI**: `openapi.json` lines 7932 and 8276 contain `triggerSchema` — auto-generated from the `route()` definitions in `src/http/workflows.ts`.

### 10. Templates

- `templates/official/issue-research/template.json` and `templates/official/customer-support-routing/template.json` are **agent templates**, not workflow templates. They contain no `trigger` or `triggerSchema` field.
- `templates-ui/` has no workflow / trigger references.

## Code references

- `src/types.ts:910` — `triggerSchema` in `WorkflowSnapshotSchema`
- `src/types.ts:928` — `triggerSchema` in `WorkflowSchema`
- `src/be/migrations/012_trigger_schema.sql:1` — DB column added
- `src/be/db.ts:5409` — column read mapping
- `src/be/db.ts:5468` — INSERT includes column
- `src/be/db.ts:5554-5556` — UPDATE handles column
- `src/workflows/engine.ts:29-36` — `TriggerSchemaError` class
- `src/workflows/engine.ts:54-60` — validation call in `startWorkflowExecution`
- `src/workflows/version.ts:32` — included in snapshots
- `src/http/workflows.ts:59` — `triggerSchema` in CREATE body
- `src/http/workflows.ts:96` — `triggerSchema` in UPDATE body
- `src/http/workflows.ts:115` — PATCH body is `WorkflowDefinitionPatchSchema` (no metadata)
- `src/http/workflows.ts:415` — CREATE handler passes `triggerSchema`
- `src/http/workflows.ts:560` — UPDATE handler passes `triggerSchema`
- `src/http/workflows.ts:588-620` — manual trigger handler (validation via engine)
- `src/http/workflows.ts:351-352` — webhook trigger handler maps error to 400
- `src/workflows/triggers.ts:51` — webhook → `startWorkflowExecution`
- `src/workflows/triggers.ts:75` — schedule → `startWorkflowExecution`
- `src/tools/workflows/create-workflow.ts:28-60,96-106` — MCP create has no `triggerSchema`
- `src/tools/workflows/update-workflow.ts:22-50,94-104` — MCP update has no `triggerSchema`
- `src/tools/workflows/patch-workflow.ts:20-51,97` — MCP patch only touches `definition`
- `src/tools/workflows/trigger-workflow.ts:15-21,47` — MCP trigger sends `triggerData`
- `new-ui/src/pages/workflows/[id]/page.tsx:239-243` — tabs (Definition / Triggers / Runs / Versions)
- `new-ui/src/pages/workflows/[id]/page.tsx:1094-1158` — `TriggersDetailPanel` (renders `triggerSchema` via `JsonTree`)
- `new-ui/src/pages/workflows/[id]/page.tsx:1029-1085` — `TriggersOverviewStrip` (single-line summary on Definition tab)
- `new-ui/src/api/types.ts:454,518` — `triggerSchema` in `Workflow` and snapshot types
- `new-ui/src/api/hooks/use-workflows.ts:43-58` — `useUpdateWorkflow` payload (narrow: name / description / enabled only)
- `new-ui/src/api/client.ts:652-664` — `api.updateWorkflow` PUT body type (matches the hook)
- `new-ui/src/pages/workflows/[id]/page.tsx:190-191` — top-bar Trigger button (sends no `triggerData`)
- `src/workflows/json-schema-validator.ts:1-10` — minimal validator subset (type / required / properties / enum / const)
- `runbooks/workflows.md` — full file, no `triggerSchema` mention
- `src/tests/workflow-trigger-schema.test.ts` — dedicated test suite
- `src/tests/workflow-integration-io.test.ts:175-330,705-721` — integration tests
- `openapi.json:7932,8276` — `triggerSchema` in spec

## Trigger-path call graph

```
POST /api/workflows/{id}/trigger   ─┐
POST /api/webhooks/{workflowId}    ─┼─►  startWorkflowExecution(workflow, triggerData, registry)
schedule fired                     ─┤        │
MCP tool trigger-workflow          ─┘        ▼
                                          if (workflow.triggerSchema)
                                              validateJsonSchema(...)
                                              throw TriggerSchemaError on failure
                                          │
                                          ▼
                                          createWorkflowRun + walk graph
```

Every trigger path goes through validation; there is no bypass.

## High-level plan (feed into `/create-plan`)

Validation is already wired end-to-end. What's missing is **authoring** (MCP + HTTP PATCH + FE) and **discoverability** (docs + a payload tester). Suggested phasing — each step is independently shippable:

1. **MCP — let agents author `triggerSchema`**
   1. Add optional `triggerSchema: z.record(z.string(), z.unknown())` to `create-workflow` `inputSchema` and pass it to `createWorkflow()` (`src/tools/workflows/create-workflow.ts`).
   2. Add optional, nullable `triggerSchema` to `update-workflow` `inputSchema` and pass it through (with `null = remove`) to `updateWorkflow()` (`src/tools/workflows/update-workflow.ts`).
   3. Update each tool's `description` to explain the JSON-Schema subset the validator supports (type / required / properties / enum / const) so agents don't write features that get silently ignored.
   4. (Skip extending `patch-workflow` — keep it DAG-only by design; per Taras "patch is ok" for the metadata case via `update-workflow`.)

2. **Backend — surface validation errors better (optional)**
   1. Confirm `TriggerSchemaError` → 400 mapping is in place for the manual `/trigger` endpoint and webhook endpoint *(already done — see `src/http/workflows.ts:606-612` and `:351-352`)*.
   2. Decide whether the MCP `trigger-workflow` tool should pre-format the `TriggerSchemaError` message (currently it falls into the generic `Failed: ${err}` branch at line 88).

3. **FE — make the existing Triggers tab editable**
   1. Widen `useUpdateWorkflow` (`new-ui/src/api/hooks/use-workflows.ts:43-58`) and `api.updateWorkflow` (`new-ui/src/api/client.ts:652-664`) to accept `triggerSchema?: Record<string, unknown> \| null`.
   2. In `TriggersDetailPanel` (`new-ui/src/pages/workflows/[id]/page.tsx:1094`), add an "Edit" affordance next to the "Trigger schema" section — open a JSON editor (the existing JSON tree is read-only; check whether a code-editor primitive is already imported or wire in a small modal).
   3. Add a "clear schema" button (sends `null`) for symmetry with the backend's nullable update.

4. **FE — payload tester on the Triggers tab**
   1. When `triggerSchema != null`, render a JSON textarea / form pre-seeded with `{}` plus an "Test trigger" button.
   2. Wire it to the existing `useTriggerWorkflow` mutation (`page.tsx:78`) but pass the body as `triggerData` instead of `{}`.
   3. Show the engine's 400 validation errors inline so users can see why a payload was rejected.

5. **Docs — close the loop**
   1. Add a `triggerSchema` section to `runbooks/workflows.md` covering: when to set one, the validator's supported subset, how validation errors surface (400 from `/trigger`, 400 from `/webhooks/{id}`).
   2. Reflect the new MCP tool fields in `MCP.md`.
   3. Add a CLAUDE.md `<important if="...">` block pointing agents at the new authoring path.

6. **Tests — extend existing coverage**
   1. Add MCP-tool tests asserting `triggerSchema` round-trips through `create-workflow` and `update-workflow`.
   2. Add a UI test (qa-use) for the Triggers-tab editor + payload tester (PR-gate requirement for `new-ui/` changes).
   3. Existing engine-level tests in `src/tests/workflow-trigger-schema.test.ts` already cover validation paths — no changes there.

## Follow-ups (initially open questions, now answered inline)

1. **Validator implementation.** `validateJsonSchema` is a hand-rolled, recursive validator at `src/workflows/json-schema-validator.ts`. It only handles `type` (object/string/number/boolean/array), `required`, `properties`, `enum`, and `const`. There is **no support for `oneOf`/`anyOf`/`allOf`, `$ref`, `pattern`, `format`, `additionalProperties`, or array `items`**. Unsupported keywords are silently ignored (not rejected), so MCP tool descriptions and FE editor hints should call out the supported subset.
2. **Auto-derivation of `triggerSchema` from `triggers`.** Searched `src/workflows/` and `src/types.ts`: there is no auto-derivation. `triggers` (webhook / schedule config) and `triggerSchema` (payload-shape JSON Schema) are independent fields. If we want, e.g., schedule triggers to default to a known-shape schema (`{ scheduleId, scheduleName, firedAt }`), that's a new feature to design.
3. **FE Triggers tab.** Confirmed present in commit `a8fca0d` — see Section 7 above. It renders `triggerSchema` read-only via `JsonTree`. The `Workflow` type in `new-ui/src/api/types.ts:454` already includes the field, so the GET path is fine; only the update path (`useUpdateWorkflow` + `api.updateWorkflow`) is currently too narrow to send `triggerSchema` back.
