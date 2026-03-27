---
date: 2026-03-27T12:00:00Z
topic: "Workflow Patch Endpoints"
status: ready
autonomy: critical
---

# Workflow Patch Endpoints Implementation Plan

## Overview

Add two new PATCH endpoints (HTTP + MCP tools) to allow partial updates to workflow definitions without resending the entire JSON:

1. **PATCH /api/workflows/{id}** — Bulk patch: create, update, and delete nodes in a single request
2. **PATCH /api/workflows/{id}/nodes/{nodeId}** — Single node partial update

Currently, any change to a workflow's node graph requires a full `PUT` with the complete definition. For large workflows (10+ nodes), this is wasteful and error-prone for agents working with MCP tools.

## Current State Analysis

### Existing update path:
- **HTTP**: `PUT /api/workflows/{id}` in `src/http/workflows.ts:80-104` — accepts optional `definition` field containing the full `WorkflowDefinitionSchema`
- **MCP tool**: `update-workflow` in `src/tools/workflows/update-workflow.ts` — same full-replacement semantics
- **DB**: `updateWorkflow()` in `src/be/db.ts:5799` — dynamic SQL builder that replaces the `definition` column wholesale
- **Validation**: `validateDefinition()` in `src/workflows/definition.ts:137` — checks next refs, entry nodes, orphans, executor types, input mappings
- **Versioning**: `snapshotWorkflow()` in `src/workflows/version.ts` — creates a version snapshot before each update

### Key data shapes:
- `WorkflowDefinition` = `{ nodes: WorkflowNode[], onNodeFailure: "fail" | "continue" }`
- `WorkflowNode` = `{ id, type, label?, config, next?, validation?, retry?, inputs?, inputSchema?, outputSchema? }`

### Existing PATCH pattern:
- `PATCH /api/tasks/{id}/vcs` in `src/http/tasks.ts:191-209` — established pattern using `route()` factory with `method: "patch"`

### Key Discoveries:
- `route()` factory already supports `"patch"` method — `src/http/route-def.ts:7`
- No DB schema changes needed — patches are applied in memory then written as a full definition via existing `updateWorkflow()`
- `validateDefinition()` must run on the **resulting** definition after patches are applied, not on the patch payload
- Version snapshots should be created before applying patches (same as PUT)

## Desired End State

- Agents can add/remove/update individual nodes without knowing the full definition
- Both endpoints validate the resulting definition and return clear errors
- Version snapshots are created before each patch (same as PUT)
- MCP tools mirror the HTTP endpoints for agent consumption
- OpenAPI spec is updated

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bash scripts/check-db-boundary.sh` — Worker/API DB boundary
- `bun run docs:openapi` — Regenerate OpenAPI spec

Key files to check:
- `src/http/workflows.ts` — HTTP route definitions + handler
- `src/tools/workflows/` — MCP tool definitions
- `src/types.ts` — Zod schemas
- `src/workflows/definition.ts` — Definition validation

## What We're NOT Doing

- No DB schema changes — patches are applied in-memory, persisted via existing `updateWorkflow()`
- No new migration files
- No changes to workflow execution/engine logic
- No UI changes (dashboard can consume the new endpoints later)
- Not adding PATCH support for top-level workflow fields (name, description, triggers) — the existing PUT already handles those fine since they're small scalars. The PATCH is specifically for the `definition.nodes` array which is the large payload.

## Implementation Approach

Both PATCH endpoints follow the same core pattern:
1. Fetch existing workflow → 404 if not found
2. Apply patch operations to the in-memory definition via `applyDefinitionPatch()`
3. If patch errors → 400 with all errors
4. Validate the resulting definition via `validateDefinition()`
5. If validation errors → 400 with all errors
6. Snapshot version (same as PUT — snapshot before persisting)
7. Persist via `updateWorkflow(id, { definition: patchedDefinition })`
8. Return the updated workflow

**Error response format**: Both patch-level and validation-level errors use `jsonError(res, message, 400)` where `message` joins all error strings with `"; "`. This matches the existing `validateDefinition` error format in the PUT handler.

**Empty patch**: If `{}` is sent (no update/delete/create), the function returns the original definition unchanged. The endpoint will still snapshot + persist (no-op update). This is acceptable — no special-casing needed.

The bulk endpoint accepts `{ update, delete, create }` and applies operations in a deterministic order: **delete → create → update**. This order allows:
- Deleting a node and creating its replacement in the same request
- Creating a node and then updating its references in the same request

---

## Phase 1: Zod Schemas for Patch Payloads

### Overview
Define the Zod schemas for both PATCH request bodies in `src/types.ts`, keeping them co-located with the existing `WorkflowNodeSchema` and `WorkflowDefinitionSchema`.

### Changes Required:

#### 1. Patch payload schemas
**File**: `src/types.ts`
**Changes**: Add two new schemas after `WorkflowDefinitionSchema` (around line 747):

```typescript
// --- Workflow Patch Schemas ---

/** Partial node update — all fields optional except id is NOT included (comes from path/nodeId) */
export const WorkflowNodePatchSchema = WorkflowNodeSchema.partial().omit({ id: true });
export type WorkflowNodePatch = z.infer<typeof WorkflowNodePatchSchema>;

/** Bulk workflow definition patch */
export const WorkflowDefinitionPatchSchema = z.object({
  update: z
    .array(
      z.object({
        nodeId: z.string().describe("ID of the node to update"),
        node: WorkflowNodePatchSchema.describe("Partial node data to merge"),
      }),
    )
    .optional()
    .describe("Nodes to update (partial merge)"),
  delete: z
    .array(z.string())
    .optional()
    .describe("Node IDs to delete"),
  create: z
    .array(WorkflowNodeSchema)
    .optional()
    .describe("New nodes to add"),
  onNodeFailure: z
    .enum(["fail", "continue"])
    .optional()
    .describe("Update the definition-level onNodeFailure behavior"),
});
export type WorkflowDefinitionPatch = z.infer<typeof WorkflowDefinitionPatchSchema>;
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Schemas are properly exported and usable from other modules
- [ ] `WorkflowNodePatchSchema` makes all WorkflowNode fields optional and omits `id`

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 2: Patch Application Logic + Unit Tests

### Overview
Create a pure function `applyDefinitionPatch()` that takes an existing definition and a patch payload, applies the operations, and returns a result object with the patched definition and any errors. Then add unit tests for it.

The function returns `{ definition, errors }` (matching the `validateDefinition` pattern) instead of throwing — this lets callers see **all** errors at once rather than failing on the first one.

### Changes Required:

#### 1. Patch result type
**File**: `src/types.ts`
**Changes**: Add result type after `WorkflowDefinitionPatchSchema`:

```typescript
/** Result of applying a patch — collects all errors instead of throwing on the first */
export interface PatchResult {
  definition: WorkflowDefinition;
  errors: string[];
}
```

#### 2. Patch application utility
**File**: `src/workflows/definition.ts`
**Changes**: Add `applyDefinitionPatch()` function:

```typescript
import type { WorkflowDefinitionPatch, PatchResult } from "../types";

/**
 * Apply a patch to a workflow definition. Returns a result with the
 * patched definition and a list of errors (empty if all operations succeeded).
 *
 * Operations are applied in order: delete → create → update.
 * Each operation collects errors independently — all operations are attempted
 * even if earlier ones have errors. Validation of the resulting definition
 * (next refs, entry nodes, etc.) is the caller’s responsibility.
 */
export function applyDefinitionPatch(
  def: WorkflowDefinition,
  patch: WorkflowDefinitionPatch,
): PatchResult {
  const errors: string[] = [];
  let nodes = [...def.nodes];

  // 1. Delete
  if (patch.delete?.length) {
    const missing = patch.delete.filter((id) => !nodes.some((n) => n.id === id));
    if (missing.length > 0) {
      errors.push(`Cannot delete non-existent nodes: ${missing.join(", ")}`);
    }
    const toDelete = new Set(patch.delete);
    nodes = nodes.filter((n) => !toDelete.has(n.id));
  }

  // 2. Create
  if (patch.create?.length) {
    const existingIds = new Set(nodes.map((n) => n.id));
    for (const newNode of patch.create) {
      if (existingIds.has(newNode.id)) {
        errors.push(`Cannot create node with duplicate ID: "${newNode.id}"`);
        continue; // skip this node but continue processing others
      }
      nodes.push(newNode);
      existingIds.add(newNode.id);
    }
  }

  // 3. Update (shallow merge per node)
  if (patch.update?.length) {
    for (const { nodeId, node: partial } of patch.update) {
      const idx = nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) {
        errors.push(`Cannot update non-existent node: "${nodeId}"`);
        continue;
      }
      nodes[idx] = { ...nodes[idx], ...partial, id: nodeId }; // preserve id
    }
  }

  const patchedDef: WorkflowDefinition = { ...def, nodes };
  if (patch.onNodeFailure !== undefined) {
    patchedDef.onNodeFailure = patch.onNodeFailure;
  }

  return { definition: patchedDef, errors };
}
```

#### 3. Unit tests
**File**: `src/tests/workflow-patch.test.ts` (new)
**Changes**: Test `applyDefinitionPatch()`:
- Delete operation removes nodes
- Create operation adds nodes
- Update operation merges fields (shallow)
- Delete → create → update ordering works in a single patch
- Returns error for non-existent node delete (doesn’t throw)
- Returns error for duplicate node create
- Returns error for non-existent node update
- Collects multiple errors in one patch
- Preserves `onNodeFailure` and other definition-level fields
- Patches `onNodeFailure` when provided in bulk patch
- Delete + create same ID in one patch works (delete runs first)
- Empty patch returns definition unchanged with no errors

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test src/tests/workflow-patch.test.ts`

#### Manual Verification:
- [ ] Function handles delete → create → update ordering correctly
- [ ] Returns all errors collected, not just the first one
- [ ] Preserves `onNodeFailure` and other definition-level fields

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 3: HTTP Endpoints

### Overview
Add both PATCH route definitions and handler logic to `src/http/workflows.ts`.

### Changes Required:

#### 1. Route definitions
**File**: `src/http/workflows.ts`
**Changes**: Add two new route definitions after `updateWorkflowRoute` (line ~104):

```typescript
const patchWorkflowRoute = route({
  method: "patch",
  path: "/api/workflows/{id}",
  pattern: ["api", "workflows", null],
  summary: "Patch a workflow definition (create/update/delete nodes)",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  body: WorkflowDefinitionPatchSchema,
  responses: {
    200: { description: "Workflow patched (version snapshot created)" },
    400: { description: "Invalid patch or resulting definition" },
    404: { description: "Workflow not found" },
  },
});

const patchWorkflowNodeRoute = route({
  method: "patch",
  path: "/api/workflows/{id}/nodes/{nodeId}",
  pattern: ["api", "workflows", null, "nodes", null],
  summary: "Patch a single node in a workflow definition",
  tags: ["Workflows"],
  params: z.object({ id: z.string(), nodeId: z.string() }),
  body: WorkflowNodePatchSchema,
  responses: {
    200: { description: "Node patched (version snapshot created)" },
    400: { description: "Invalid patch or resulting definition" },
    404: { description: "Workflow or node not found" },
  },
});
```

#### 2. Handler logic
**File**: `src/http/workflows.ts`
**Changes**: Add handler blocks in `handleWorkflows()`. The `patchWorkflowNodeRoute` (5-segment pattern) must be checked **before** `patchWorkflowRoute` (3-segment pattern) to avoid the shorter pattern matching first. Both should go before the existing `updateWorkflowRoute` (PUT) block.

Both handlers follow the same pattern:
1. Parse request
2. Fetch existing workflow (404 if not found)
3. Call `applyDefinitionPatch()` — check `result.errors` for patch-level errors (400)
4. Call `validateDefinition()` on `result.definition` — check for graph-level errors (400)
5. Snapshot version
6. Persist via `updateWorkflow(id, { definition: result.definition })`

For the single-node endpoint, convert the body into a bulk patch: `{ update: [{ nodeId, node: body }] }`.

#### 3. Imports
**File**: `src/http/workflows.ts`
**Changes**: Add to imports:
- `WorkflowDefinitionPatchSchema`, `WorkflowNodePatchSchema` from `../types`
- `applyDefinitionPatch` from `../workflows/definition`
- `WorkflowDefinition` type from `../types`

#### 4. CORS header
**File**: `src/http/utils.ts`
**Changes**: Add `PATCH` to `Access-Control-Allow-Methods` header (currently missing — would block browser-origin PATCH requests).

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Use the seed script (`bun run scripts/seed.ts`) to populate workflows, then test PATCH against seeded data
- [ ] Test bulk PATCH with curl — create a workflow, then patch it:
  ```bash
  # Create a test workflow
  curl -s -X POST http://localhost:3013/api/workflows \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"name":"test-patch","definition":{"nodes":[{"id":"a","type":"agent-task","config":{"template":"Hello"}}]}}'

  # Bulk patch: add a node + update existing
  curl -s -X PATCH http://localhost:3013/api/workflows/<ID> \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"create":[{"id":"b","type":"agent-task","config":{"template":"World"}}],"update":[{"nodeId":"a","node":{"next":"b"}}]}'

  # Single node patch
  curl -s -X PATCH http://localhost:3013/api/workflows/<ID>/nodes/b \
    -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
    -d '{"label":"Updated Label","config":{"template":"Updated"}}'
  ```
- [ ] Verify 400 on invalid patch (e.g., deleting non-existent node)
- [ ] Verify 400 when resulting definition is structurally invalid (e.g., broken next ref)
- [ ] Verify version snapshot is created before patch

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Bulk add + wire nodes
  - Steps: 1. Create workflow with one node, 2. PATCH to add a second node and update first node's `next`, 3. GET workflow
  - Expected: Two nodes, first pointing to second via `next`
- [ ] TC-2: Delete a node
  - Steps: 1. Create workflow with two chained nodes, 2. PATCH to delete second node and remove first's `next`, 3. GET workflow
  - Expected: One node, no `next`
- [ ] TC-3: Error on invalid patch
  - Steps: 1. PATCH to delete non-existent node ID
  - Expected: 400 with clear error message
- [ ] TC-4: Error on invalid resulting graph
  - Steps: 1. PATCH to add node with `next` pointing to non-existent ID
  - Expected: 400 with validation error

---

## Phase 4: MCP Tools

### Overview
Add two new MCP tools: `patch-workflow` and `patch-workflow-node`, following the same pattern as the existing `update-workflow` tool.

### Changes Required:

#### 1. Bulk patch tool
**File**: `src/tools/workflows/patch-workflow.ts` (new)
**Changes**: Create MCP tool mirroring the bulk PATCH endpoint. Uses `getWorkflow`, `applyDefinitionPatch`, `validateDefinition`, `snapshotWorkflow`, `updateWorkflow` — same flow as HTTP handler.

Input schema:
```typescript
z.object({
  id: z.string().uuid().describe("Workflow ID to patch"),
  update: z.array(z.object({
    nodeId: z.string(),
    node: WorkflowNodePatchSchema,
  })).optional().describe("Nodes to update (partial merge)"),
  delete: z.array(z.string()).optional().describe("Node IDs to delete"),
  create: z.array(WorkflowNodeSchema).optional().describe("New nodes to add"),
  onNodeFailure: z.enum(["fail", "continue"]).optional().describe("Update onNodeFailure behavior"),
})
```

Output schema:
```typescript
z.object({
  success: z.boolean(),
  message: z.string(),
  workflow: z.unknown().optional(),
  versionCreated: z.number().optional(),
  nodesCreated: z.number().optional(),
  nodesUpdated: z.number().optional(),
  nodesDeleted: z.number().optional(),
})
```

#### 2. Single node patch tool
**File**: `src/tools/workflows/patch-workflow-node.ts` (new)
**Changes**: Create MCP tool mirroring the single node PATCH endpoint.

Input schema:
```typescript
z.object({
  id: z.string().uuid().describe("Workflow ID"),
  nodeId: z.string().describe("Node ID to update"),
  ...WorkflowNodePatchSchema.shape, // Spread the partial node fields directly as top-level params
})
```

Output schema:
```typescript
z.object({
  success: z.boolean(),
  message: z.string(),
  workflow: z.unknown().optional(),
  versionCreated: z.number().optional(),
})
```

#### 3. Register tools
**File**: `src/tools/workflows/index.ts`
**Changes**: Export both new registration functions:
```typescript
export { registerPatchWorkflowTool } from "./patch-workflow";
export { registerPatchWorkflowNodeTool } from "./patch-workflow-node";
```

#### 4. Register in tool-config
**File**: `src/tools/tool-config.ts`
**Changes**: Add both tool name strings to the `DEFERRED_TOOLS` set in the `// Workflows` section:
```typescript
"patch-workflow",
"patch-workflow-node",
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Verify tools appear in MCP tool listing via `tools/list` call
- [ ] Test `patch-workflow` tool via MCP session (create workflow, then patch nodes)
- [ ] Test `patch-workflow-node` tool via MCP session

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 5: OpenAPI Spec Regeneration

### Overview
Regenerate the OpenAPI spec to include the two new PATCH endpoints. Unit tests were already added in Phase 2.

### Changes Required:

#### 1. Regenerate OpenAPI
**Command**: `bun run docs:openapi`
**Note**: No file changes needed — the import in `scripts/generate-openapi.ts` already covers `src/http/workflows.ts`, and the new routes are auto-registered via `route()`.

### Success Criteria:

#### Automated Verification:
- [ ] OpenAPI spec regenerated: `bun run docs:openapi`
- [ ] All tests still pass: `bun test`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Verify `openapi.json` includes the two new PATCH endpoints (search for `"patch"` method)

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Manual E2E Verification

After all phases are complete, run the following against a running API server:

```bash
# Start API
bun run start:http &

# 1. Create a test workflow with 3 nodes
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "name": "patch-test",
    "definition": {
      "nodes": [
        {"id": "step1", "type": "agent-task", "config": {"template": "First"}, "next": "step2"},
        {"id": "step2", "type": "agent-task", "config": {"template": "Second"}, "next": "step3"},
        {"id": "step3", "type": "agent-task", "config": {"template": "Third"}}
      ]
    }
  }' | jq '.id'

# 2. Bulk PATCH: delete step3, create step4, update step2 to point to step4
curl -s -X PATCH http://localhost:3013/api/workflows/<ID> \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "delete": ["step3"],
    "create": [{"id": "step4", "type": "agent-task", "config": {"template": "Fourth"}}],
    "update": [{"nodeId": "step2", "node": {"next": "step4"}}]
  }' | jq '.definition.nodes | length'
# Expected: 3 (step1, step2, step4)

# 3. Single node PATCH: update step4's label and config
curl -s -X PATCH http://localhost:3013/api/workflows/<ID>/nodes/step4 \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"label": "Final Step", "config": {"template": "Updated Fourth"}}' | jq '.definition.nodes[] | select(.id == "step4")'

# 4. Verify version history grew
curl -s http://localhost:3013/api/workflows/<ID>/versions \
  -H "Authorization: Bearer 123123" | jq '.versions | length'
# Expected: 2 (one per PATCH)

# 5. Error case: patch non-existent node
curl -s -X PATCH http://localhost:3013/api/workflows/<ID>/nodes/nonexistent \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"label": "nope"}'
# Expected: 400

# Cleanup
kill $(lsof -ti :3013) 2>/dev/null
```

## Testing Strategy

- **Unit tests**: `applyDefinitionPatch()` — pure function, easy to test exhaustively
- **Integration tests**: HTTP PATCH endpoints via curl against local API
- **MCP tests**: Via MCP session handshake (see CLAUDE.md MCP testing section)

## References
- Existing PUT update: `src/http/workflows.ts:80-104`, `src/tools/workflows/update-workflow.ts`
- Existing PATCH pattern: `src/http/tasks.ts:191-209`
- Route factory: `src/http/route-def.ts`
- Definition validation: `src/workflows/definition.ts:137-235`
- DB update: `src/be/db.ts:5799-5855`

---

## Review Errata

_Reviewed: 2026-03-27 by Claude_

### Resolved
- [x] Implementation Approach step ordering didn't match Phase 3 detail (snapshot was listed as step 2) — fixed to match actual flow (snapshot after validate, before persist)
- [x] `onNodeFailure` (definition-level field) was not patchable via bulk endpoint — added to `WorkflowDefinitionPatchSchema`, `applyDefinitionPatch()`, and MCP tool input
- [x] Missing test case: delete + create same node ID in one patch — added to Phase 2 test list
- [x] Error response format unspecified — added clarification: both patch-level and validation-level errors use `jsonError` with `"; "` join, matching existing PUT pattern
- [x] Empty patch body behavior unspecified — documented as acceptable no-op (snapshot + persist unchanged definition)
- [x] CORS header missing PATCH — already addressed in Phase 3 step 4

### Notes
- `WorkflowNodeSchema.partial().omit({ id: true })` — Zod chains `.partial()` → `.omit()` correctly on `z.object` types (verification pending from codebase-analyzer agent)
- Phase 4's `...WorkflowNodePatchSchema.shape` spread for the single-node MCP tool is valid but may produce a large flat parameter list. If it causes MCP SDK issues during implementation, fall back to a nested `node: WorkflowNodePatchSchema` parameter instead.
