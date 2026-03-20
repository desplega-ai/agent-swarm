---
date: 2026-03-19T19:00:00Z
topic: "Workflow Node I/O Schemas, Data Flow Mapping, and Engine Bug Fixes"
status: completed
autonomy: verbose
commit_per_phase: true
---

# Workflow I/O Schemas & Engine Bug Fixes — Implementation Plan

## Overview

Fix 7 engine bugs and add typed I/O contracts to the workflow system. This implements explicit data mapping between nodes (`inputs` field), node-level schema validation (`inputSchema`/`outputSchema`), workflow-level trigger validation (`triggerSchema`), and static data flow validation at definition time.

**Research**: `thoughts/taras/research/2026-03-19-workflow-node-io-schemas-and-bugs.md`

**JSON Schema validation approach**: `z.fromJSONSchema()` does not exist in Zod v4.2.1. Use a minimal hand-rolled validator (~40 lines) covering the subset needed: object with required/optional properties, type checks for string/number/boolean/array/object. Zero new dependencies — avoids Ajv's 200KB. Used consistently across `inputSchema`, `outputSchema`, and `triggerSchema` validation.

## Current State Analysis

The workflow engine executes a DAG of nodes, interpolating `{{path.to.value}}` tokens in config against a global context bag. There are no typed contracts between nodes, no trigger schema, and several execution bugs.

### Key Discoveries:
- `interpolate()` silently returns `""` on failure (`src/workflows/template.ts:10,13`)
- Config interpolation is shallow — only top-level strings (`src/workflows/engine.ts:268-273`)
- `getAllPredecessors()` uses structural predecessors, causing deadlocks on conditional branches (`src/workflows/engine.ts:206-216`)
- `findReadyNodes()` has the same convergence bug (`src/workflows/engine.ts:386-421`)
- Recovery re-injects outputs without validation (`src/workflows/engine.ts:109`)
- `MAX_ITERATIONS` counts batches, not node executions (`src/workflows/engine.ts:119`)
- Retry validation overwrites previous context (`src/workflows/engine.ts:354-356`)
- Registry already has `describe()`/`describeAll()` using `z.toJSONSchema()` (`src/workflows/executors/registry.ts:41-54`)
- `ExecutorDependencies.interpolate` returns `string` (`src/workflows/executors/base.ts:10`) — 5 executors call it directly
- No unit tests exist for `template.ts` interpolation
- Agent-task executor manually interpolates tags to work around shallow interpolation (`src/workflows/executors/agent-task.ts:66`)

## Desired End State

1. `interpolate()` returns `{result, unresolved}` — unresolved tokens are tracked and logged
2. Config interpolation is deep (arrays, nested objects)
3. Circular references in context don't crash `JSON.stringify`
4. Convergence nodes only wait for predecessors on active execution paths
5. Nodes declare explicit `inputs` mappings — interpolation uses local context, not global bag
6. Nodes can declare `inputSchema`/`outputSchema` for runtime validation
7. Workflows can declare `triggerSchema` — enforced with 400 on violation
8. `validateDefinition()` checks data flow (source exists + is upstream)
9. `MAX_ITERATIONS` counts node executions
10. Recovery validates output against executor schema
11. Retry validation preserves history

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type checking
- `bun run lint:fix` — Biome lint + format
- `bun test src/tests/workflow-template.test.ts` — Interpolation tests (new)
- `bun test src/tests/workflow-engine-v2.test.ts` — Engine tests
- `bun test` — All tests

Key files:
- `src/workflows/template.ts` — Interpolation utility
- `src/workflows/engine.ts` — Graph walker, step execution
- `src/workflows/definition.ts` — Validation, entry/successor utilities
- `src/types.ts:593-710` — Workflow schemas
- `src/workflows/executors/base.ts` — BaseExecutor, ExecutorDependencies
- `src/workflows/executors/registry.ts` — ExecutorRegistry
- `src/workflows/checkpoint.ts` — Step checkpoint/recovery

## What We're NOT Doing

- **Ports in registry metadata** — deferred; executors don't expose a `ports` list yet. The registry already has `describe()`/`describeAll()` using `z.toJSONSchema()` for config and output schemas — no additional registry work needed.
- **`zod-to-json-schema` dependency** — using built-in `z.toJSONSchema()` instead
- **Changing `ExecutorDependencies.interpolate` signature** — executors keep getting `string`; engine handles unresolved tracking centrally
- **Advisory/configurable triggerSchema mode** — strict enforcement only (400 on violation). All trigger paths (API, webhook) validate consistently.
- **UI changes** — no dashboard updates in this plan
- **BaseExecutor JSON Schema getters** — registry already derives these via `z.toJSONSchema()`
- **Ajv or external JSON Schema validator** — using a minimal hand-rolled validator (~40 lines) for the JSON Schema subset we need (object, required, type checks). `z.fromJSONSchema()` does not exist in Zod v4.

## Implementation Approach

Six phases, ordered by dependency chain (Bug 4 merged into Phase 2, Bug 7 merged into Phase 3):
1. Fix interpolation (foundation — everything else depends on it)
2. Fix convergence + Bug 4 MAX_ITERATIONS fix (independent of I/O schemas, unblocks correct execution)
3. Add I/O schemas + explicit inputs (core feature, includes Bug 5 + Bug 7 fixes)
4. Add triggerSchema (depends on schema infrastructure from Phase 3)
5. Static data flow validation (depends on `inputs` field from Phase 3)
6. Integration testing (validates everything together)

---

## Phase 1: Interpolation Bug Fixes (Bug 1 + Bug 2 + Bug 6)

### Overview
Fix the interpolation foundation: return unresolved tokens, support deep config trees, and handle circular references. This is the foundation for all subsequent phases.

### Changes Required:

#### 1. Rewrite `interpolate()` to return `{result, unresolved}`
**File**: `src/workflows/template.ts`
**Changes**:
- Change return type from `string` to `{ result: string; unresolved: string[] }`
- Track unresolved paths (null midway, missing key, final null)
- Add `safeStringify()` helper for circular reference protection
- Export both the new signature and a `deepInterpolate()` for nested config trees

```typescript
export interface InterpolateResult {
  result: string;
  unresolved: string[];
}

export function interpolate(
  template: string,
  ctx: Record<string, unknown>,
): InterpolateResult {
  const unresolved: string[] = [];
  const result = template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const keys = path.trim().split(".");
    let value: unknown = ctx;
    for (const key of keys) {
      if (value == null || typeof value !== "object") {
        unresolved.push(path.trim());
        return "";
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value == null) {
      unresolved.push(path.trim());
      return "";
    }
    return typeof value === "object" ? safeStringify(value) : String(value);
  });
  return { result, unresolved };
}

/** Note: safeStringify is interpolation-specific (circular ref protection).
 *  Keep in template.ts — not general enough for a shared utils file. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[Circular]";
  }
}

export function deepInterpolate(
  value: unknown,
  ctx: Record<string, unknown>,
): { value: unknown; unresolved: string[] } {
  const allUnresolved: string[] = [];

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const { result, unresolved } = interpolate(v, ctx);
      allUnresolved.push(...unresolved);
      return result;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v != null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }

  return { value: walk(value), unresolved: allUnresolved };
}
```

#### 2. Update engine to use new `interpolate()` API
**File**: `src/workflows/engine.ts`
**Changes**:
- Replace shallow interpolation loop (lines 267-274) with `deepInterpolate()`
- Collect unresolved tokens and log warnings
- Store unresolved tokens in the step record via `updateWorkflowRunStep`
- Cast `deepInterpolate` result to `Record<string, unknown>` at the call site (input is always `node.config` which is `Record<string, unknown>`)

```typescript
// Replace lines 267-274 with:
const { value, unresolved } = deepInterpolate(node.config, ctx);
const interpolatedConfig = value as Record<string, unknown>;

if (unresolved.length > 0) {
  console.warn(
    `[workflow] Step ${node.id}: unresolved interpolation tokens: ${unresolved.join(", ")}`,
  );
  updateWorkflowRunStep(stepId, {
    diagnostics: JSON.stringify({ unresolvedTokens: unresolved }),
  });
}
```

#### 3. Update `ExecutorDependencies.interpolate` wrapper
**File**: `src/workflows/executors/base.ts`
**Changes**: No signature change. The dependency stays `(template: string, ctx: Record<string, unknown>) => string`.

**File**: Where deps are created (executor registration site — likely `src/workflows/executors/index.ts` or wherever `createExecutorRegistry` builds deps)
**Changes**: The deps `interpolate` function wraps the new API, extracting `.result`:

```typescript
interpolate: (template, ctx) => interpolate(template, ctx).result,
```

#### 4. Remove agent-task manual interpolation workaround
**File**: `src/workflows/executors/agent-task.ts`
**Changes**: Since the engine now deep-interpolates the entire config (including arrays like `tags` and `template`), the executor's manual interpolation is fully redundant. The executor's `context` parameter IS the engine's global `ctx` — same data, so no runtime-only context is lost.
- Remove line 64: `const mutableCtx = { ...context } as Record<string, unknown>;`
- Remove line 65: `const interpolatedTemplate = interpolate(config.template, mutableCtx);`
- Remove line 66: `const interpolatedTags = config.tags?.map((tag) => interpolate(tag, mutableCtx));`
- Use `config.template` and `config.tags` directly (already interpolated by engine)
- Remove the destructured `interpolate` from deps (line 39) — now unused

#### 5. Add `diagnostics` column to workflow_run_steps table
**File**: `src/be/migrations/010_step_diagnostics.sql`
**Changes**: `ALTER TABLE workflow_run_steps ADD COLUMN diagnostics TEXT;`

**File**: `src/be/db.ts`
**Changes**: Add `diagnostics` to the step update function's accepted fields.

#### 6. Create exhaustive interpolation unit tests
**File**: `src/tests/workflow-template.test.ts` (new)
**Tests**:
- **Happy paths**: Simple path, nested path, object stringification, array stringification
- **Unresolved tracking**: Missing top-level key, null midway through path, typo in path, final null value
- **Circular references**: Object with circular ref → `[Circular]` instead of crash
- **Deep interpolation**: String in array, nested object with templates, mixed array (string + number), deeply nested (3+ levels), empty array, null values in array, array of objects with templates
- **Edge cases**: Empty template, template with no tokens, empty context, whitespace in path `{{ foo.bar }}`, consecutive tokens `{{a}}{{b}}`

### Success Criteria:

#### Automated Verification:
- [x] Interpolation tests pass: `bun test src/tests/workflow-template.test.ts`
- [x] Engine tests still pass: `bun test src/tests/workflow-engine-v2.test.ts`
- [x] All workflow tests pass: `bun test src/tests/workflow-`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Verify unresolved token warnings appear in console when running a workflow with a typo in a `{{path}}`
- [x] Verify agent-task executor still works without manual tag interpolation (create a workflow with `tags: ["{{trigger.source}}", "fixed"]` and confirm both tags resolve)

**Implementation Note**: After completing this phase, pause for manual confirmation before committing.

---

## Phase 2: Convergence Node Deadlock Fix (Bug 3) + MAX_ITERATIONS Fix (Bug 4)

### Overview
Fix the convergence deadlock where conditional branches cause nodes to wait forever for predecessors that were never executed. Implement active edge tracking so convergence checks only consider predecessors on actually-taken execution paths. Fix the same bug in `findReadyNodes()`. Also fix Bug 4 (MAX_ITERATIONS counts batches, not nodes).

### Changes Required:

#### 1. Add active edge tracking to `walkGraph`
**File**: `src/workflows/engine.ts`
**Changes**:
- Add `activeEdges: Set<string>` alongside `completedNodeIds`
- When a node completes and produces successors, record the edges `sourceId→targetId` as active
- Replace the convergence check (lines 170-179) to use active edges instead of structural predecessors:

```typescript
// Track active edges: "sourceId→targetId"
const activeEdges = new Set<string>();

// ... in the results processing loop, after getting successors:
for (const succ of result.successors) {
  activeEdges.add(`${pendingNodes[i]!.id}→${succ.id}`);
  nextBatch.set(succ.id, succ);
}

// Convergence check — only wait for predecessors with active edges
const readyNext: WorkflowNode[] = [];
for (const [nodeId, node] of nextBatch) {
  if (completedNodeIds.has(nodeId)) continue;

  const allPreds = getAllPredecessors(def, nodeId);
  const activePreds = allPreds.filter((predId) => activeEdges.has(`${predId}→${nodeId}`));
  const allActivePredsCompleted = activePreds.every((p) => completedNodeIds.has(p));

  if (allActivePredsCompleted) {
    readyNext.push(node);
  }
}
```

#### 2. Add `nextPort` column to workflow_run_steps + persist active edges for recovery
**File**: `src/be/migrations/011_step_next_port.sql`
**Changes**: `ALTER TABLE workflow_run_steps ADD COLUMN nextPort TEXT;`

**File**: `src/be/db.ts`
**Changes**: Add `nextPort` to `updateWorkflowRunStep()`'s accepted fields and `rowToWorkflowRunStep()` mapping.

**File**: `src/workflows/checkpoint.ts`
**Changes**: Store `nextPort` in the step record:
```typescript
updateWorkflowRunStep(stepId, {
  status: "completed",
  output: result.output,
  nextPort: result.nextPort || "default",
  finishedAt: new Date().toISOString(),
});
```

**File**: `src/types.ts`
**Changes**: Add `nextPort: z.string().optional()` to `WorkflowRunStepSchema`.

**File**: `src/workflows/engine.ts`
**Changes**:
- On recovery (memoized re-walk, lines 104-113), reconstruct active edges from completed steps:
  - For each completed step, look up its stored `nextPort` and compute successors
  - Add corresponding edges to `activeEdges`

#### 3. Fix `findReadyNodes()` to accept active edges
**File**: `src/workflows/engine.ts`
**Changes**:
- Add optional `activeEdges?: Set<string>` parameter to `findReadyNodes()`
- When provided, use active edges for predecessor filtering (same logic as walkGraph)
- When not provided (backward compat), fall back to structural predecessors

#### 4. Fix Bug 4: Count node executions, not batches
**File**: `src/workflows/engine.ts:118-127`
**Changes**:
- Rename `iterationCount` to `nodeExecutionCount`
- Increment by the number of nodes in each batch (`pendingNodes.length`), not by 1
- Update error message to say "node executions" not "iterations"

```typescript
let nodeExecutionCount = 0;
// ...
while (pendingNodes.length > 0) {
  nodeExecutionCount += pendingNodes.length;
  if (nodeExecutionCount > MAX_ITERATIONS) {
    // ... fail with descriptive error mentioning "node executions"
  }
```

#### 5. Add convergence + Bug 4 unit tests
**File**: `src/tests/workflow-engine-v2.test.ts` (or new `src/tests/workflow-convergence.test.ts`)
**Tests**:
- **Conditional skip**: A→(true:C, false:B), B→C. When A takes "true" port, C should execute without waiting for B.
- **Normal convergence**: A→B, A→C, B→D, C→D. D waits for both B and C.
- **Diamond with conditional**: A→(true:B, false:C), B→D, C→D. Only the taken branch's predecessor gates D.
- **Recovery convergence**: Same scenarios but with memoized re-walk (some steps pre-completed).
- **Bug 4 — batch vs node count**: Workflow with 5 parallel nodes counts 5 executions (not 1). Linear chain of 50 nodes counts 50.

### Success Criteria:

#### Automated Verification:
- [x] Convergence tests pass: `bun test src/tests/workflow-engine-v2.test.ts`
- [x] All workflow tests pass: `bun test src/tests/workflow-`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Create a workflow with conditional branch convergence (A→true:C, false:B; B→C) and verify C executes when A takes the "true" path
- [ ] Verify the same workflow works correctly when A takes the "false" path (B executes, then C)
- [ ] Verify MAX_ITERATIONS error message says "node executions" not "iterations"

**Implementation Note**: After completing this phase, pause for manual confirmation before committing.

---

## Phase 3: Node I/O Schemas + Explicit Inputs Mapping (+ Bug 5, Bug 7)

### Overview
Add typed I/O contracts to workflow nodes. Nodes declare `inputs` (explicit data mapping from context paths to local names), `inputSchema` (JSON Schema validation of resolved inputs), and `outputSchema` (additional validation on top of executor's base schema). This also fixes Bug 5 (output validation on recovery) and Bug 7 (retry validation context history).

**Important context transition**: Phase 1 introduced `deepInterpolate(node.config, ctx)` against the full global context. This phase changes interpolation to use a **local context** (only declared inputs + trigger/input). This is a deliberate breaking change from Phase 1's behavior. Since the feature is in alpha with no existing workflows, this is safe.

### Changes Required:

#### 1. Extend `WorkflowNodeSchema`
**File**: `src/types.ts:593-601`
**Changes**:
```typescript
export const WorkflowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  next: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  validation: StepValidationConfigSchema.optional(),
  retry: RetryPolicySchema.optional(),
  // NEW: Explicit data mapping
  inputs: z.record(z.string(), z.string()).optional(),
  // NEW: JSON Schema for input validation
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  // NEW: JSON Schema for output validation (on top of executor base schema)
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});
```

#### 2. Implement input resolution in the engine
**File**: `src/workflows/engine.ts`
**Changes** to `executeStep()`:
- After getting the executor (line 264), before interpolation:
  1. If `node.inputs` exists, resolve each path against the global context `ctx`
  2. Build a **local context** containing only resolved inputs + built-in sources (`trigger`, `input`)
  3. Use local context for interpolation (not global `ctx`)
  4. If `node.inputs` is absent, use an empty context with only `trigger` and `input`
  5. If `node.inputSchema` exists, validate resolved inputs against it using Ajv or a lightweight JSON Schema validator

```typescript
// Build interpolation context
let interpolationCtx: Record<string, unknown>;
if (node.inputs) {
  interpolationCtx = {};
  // Always include built-in sources
  if (ctx.trigger !== undefined) interpolationCtx.trigger = ctx.trigger;
  if (ctx.input !== undefined) interpolationCtx.input = ctx.input;
  // Resolve declared inputs
  for (const [localName, sourcePath] of Object.entries(node.inputs)) {
    const keys = sourcePath.split(".");
    let value: unknown = ctx;
    for (const key of keys) {
      if (value == null || typeof value !== "object") { value = undefined; break; }
      value = (value as Record<string, unknown>)[key];
    }
    interpolationCtx[localName] = value;
  }
} else {
  // No inputs declared — only built-in sources available
  interpolationCtx = {};
  if (ctx.trigger !== undefined) interpolationCtx.trigger = ctx.trigger;
  if (ctx.input !== undefined) interpolationCtx.input = ctx.input;
}
```

#### 3. Add inputSchema validation
**File**: `src/workflows/engine.ts`
**Changes**: After resolving inputs, before interpolation:
- If `node.inputSchema` exists, validate the resolved inputs against it
- On failure, checkpoint step as failed with descriptive error

**File**: `src/workflows/json-schema-validator.ts` (new)
**Changes**: Minimal hand-rolled JSON Schema validator (~40 lines). Supports the subset we need:
- `type`: "object", "string", "number", "boolean", "array"
- `required`: array of required property names
- `properties`: map of property name → schema (recursive)
- Returns `string[]` of validation errors (empty = valid)

```typescript
export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown,
): string[] {
  const errors: string[] = [];
  // ... type checking, required fields, recursive property validation
  return errors;
}
```

This validator is reused in Phase 4 for `triggerSchema` and in this phase for `outputSchema`.

#### 4. Add node-level outputSchema validation
**File**: `src/workflows/engine.ts`
**Changes**: After executor completes successfully (before checkpoint, around line 370):
- If `node.outputSchema` exists, validate `result.output` against it
- On failure, checkpoint step as failed

#### 5. Fix Bug 5: Validate output on recovery
**File**: `src/workflows/engine.ts:104-113`
**Changes**: When re-injecting stored output on recovery:
- Look up the node's executor via registry
- Validate stored output against `executor.outputSchema.safeParse()`
- On failure, log warning and skip injection (lenient mode — don't fail the run, just warn)

```typescript
if (completedNodeIds.size > 0) {
  for (const nodeId of completedNodeIds) {
    const key = `${runId}:${nodeId}`;
    const step = getStepByIdempotencyKey(key);
    if (step?.output !== undefined) {
      // Validate output against executor schema
      const node = def.nodes.find((n) => n.id === nodeId);
      if (node && registry.has(node.type)) {
        const executor = registry.get(node.type);
        const parseResult = executor.outputSchema.safeParse(step.output);
        if (!parseResult.success) {
          console.warn(
            `[workflow] Recovery: step ${nodeId} output failed validation: ${parseResult.error.message}`,
          );
          continue; // Skip corrupted output
        }
      }
      ctx[nodeId] = step.output;
    }
  }
}
```

#### 6. Fix Bug 7: Retry validation context history
**File**: `src/workflows/engine.ts:354-356`
**Changes**:
- Change from overwriting to appending:
```typescript
if (validationResult.retryContext) {
  const historyKey = `${node.id}_validations`;
  const existing = (ctx[historyKey] as unknown[]) || [];
  ctx[historyKey] = [...existing, validationResult.retryContext];
}
```

#### 7. Tests
**File**: `src/tests/workflow-io-schemas.test.ts` (new)
**Tests**:
- **Inputs resolution**: Node with `inputs: {prNum: "trigger.prNumber"}` gets correct local context
- **Built-in sources always available**: `trigger` and `input` accessible even without declaration
- **Missing source path**: Input mapping to non-existent node → execution fails with clear error
- **InputSchema validation**: Node with inputSchema, valid input → passes; invalid → fails with error
- **OutputSchema validation**: Node with outputSchema, valid output → passes; invalid → fails
- **Recovery validation (Bug 5)**: Corrupted stored output → warned and skipped
- **No inputs field**: Node without `inputs` gets only trigger/input context
- **Bug 7 — retry history**: Three validation retries → `ctx[nodeId_validations]` is array with 3 entries
- **JSON Schema validator unit tests**: type checks, required fields, nested properties, edge cases

### Success Criteria:

#### Automated Verification:
- [x] I/O schema tests pass: `bun test src/tests/workflow-io-schemas.test.ts`
- [x] All workflow tests pass: `bun test src/tests/workflow-`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Create a workflow with explicit `inputs` mapping and verify nodes receive only declared inputs
- [ ] Create a workflow with `inputSchema` and verify that passing wrong types fails with a descriptive error
- [ ] Verify that `trigger` and `input` are always available in node context even without declaring them in `inputs`

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the largest phase — take extra care reviewing the engine changes.

---

## Phase 4: Workflow-Level triggerSchema

### Overview
Add a `triggerSchema` field to `WorkflowSchema` that validates the trigger payload on execution start. Non-conforming payloads get a 400 error.

### Changes Required:

#### 1. Add `triggerSchema` to `WorkflowSchema`
**File**: `src/types.ts:697-710`
**Changes**:
```typescript
export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  definition: WorkflowDefinitionSchema,
  triggers: z.array(TriggerConfigSchema).default([]),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(z.string(), InputValueSchema).optional(),
  triggerSchema: z.record(z.string(), z.unknown()).optional(), // NEW: JSON Schema
  createdByAgentId: z.string().uuid().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
```

Also add to `WorkflowSnapshotSchema` (line 684-693) for version history consistency.

#### 2. Validate trigger payload in `startWorkflowExecution`
**File**: `src/workflows/engine.ts`
**Changes**: After cooldown check, before creating the run:
```typescript
// Validate trigger data against triggerSchema
if (workflow.triggerSchema) {
  const validationErrors = validateJsonSchema(workflow.triggerSchema, triggerData);
  if (validationErrors.length > 0) {
    throw new TriggerSchemaError(validationErrors);
  }
}
```

#### 3. Handle validation error in both trigger endpoints
**File**: `src/http/workflows.ts`
**Changes**:
- **API trigger** (`POST /api/workflows/{id}/trigger`, line 112): Catch `TriggerSchemaError` and return 400 with validation error details.
- **Webhook trigger** (line 290): Same validation — `triggerSchema` enforced consistently across all trigger paths. Webhook payloads that don't match the schema are rejected with 400 before HMAC verification overhead.

Both paths must validate consistently. If a workflow declares `triggerSchema`, all callers (API, webhook, schedule) must conform.

#### 4. Add `triggerSchema` column to workflows table
**File**: `src/be/migrations/012_trigger_schema.sql`
**Changes**: `ALTER TABLE workflows ADD COLUMN triggerSchema TEXT;` (stored as JSON string)

**File**: `src/be/db.ts`
**Changes**: Parse `triggerSchema` from JSON on read, stringify on write.

#### 5. Tests
**File**: `src/tests/workflow-trigger-schema.test.ts` (new)
**Tests**:
- Valid trigger payload against schema → execution starts
- Invalid trigger payload → execution rejected with descriptive error
- No triggerSchema defined → any payload accepted (backward compat)
- Schema with required fields → missing field triggers error
- Trigger validation error includes field-level details

### Success Criteria:

#### Automated Verification:
- [x] Trigger schema tests pass: `bun test src/tests/workflow-trigger-schema.test.ts`
- [x] All workflow tests pass: `bun test src/tests/workflow-`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Trigger a workflow with `triggerSchema` via `POST /api/workflows/:id/trigger` with invalid payload → get 400
- [ ] Same workflow with valid payload → starts successfully
- [ ] Workflow without `triggerSchema` → any payload accepted
- [ ] Trigger via webhook endpoint with invalid payload → get 400 (consistent with API trigger)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 5: Static Data Flow Validation

### Overview
Extend `validateDefinition()` to check that input mappings reference existing, upstream nodes. Catches data wiring errors at workflow creation time.

### Changes Required:

#### 1. Add input mapping validation to `validateDefinition()`
**File**: `src/workflows/definition.ts`
**Changes**: Add a 5th validation pass after executor type checking:

```typescript
// 5. Check input mappings are satisfiable
for (const node of def.nodes) {
  if (!node.inputs) continue;
  for (const [localName, sourcePath] of Object.entries(node.inputs)) {
    const [sourceNodeId] = sourcePath.split(".");
    // Skip built-in context sources
    if (sourceNodeId === "trigger" || sourceNodeId === "input") continue;

    // Check source node exists
    const sourceNode = def.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      errors.push(
        `Node "${node.id}" input "${localName}" references non-existent node "${sourceNodeId}"`,
      );
      continue;
    }

    // Check source node is upstream (transitive predecessor)
    if (!isUpstream(def, sourceNodeId, node.id)) {
      errors.push(
        `Node "${node.id}" input "${localName}" references "${sourceNodeId}" which is not upstream`,
      );
    }
  }
}
```

#### 2. Implement `isUpstream()` utility
**File**: `src/workflows/definition.ts`
**Changes**: Add reverse BFS from target to find all transitive predecessors:

```typescript
function isUpstream(
  def: WorkflowDefinition,
  sourceId: string,
  targetId: string,
): boolean {
  const reverseDeps = new Map<string, string[]>();
  for (const node of def.nodes) {
    if (!node.next) continue;
    const targets = typeof node.next === "string"
      ? [node.next]
      : Object.values(node.next);
    for (const target of targets) {
      if (!reverseDeps.has(target)) reverseDeps.set(target, []);
      reverseDeps.get(target)!.push(node.id);
    }
  }

  const visited = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const preds = reverseDeps.get(current) || [];
    for (const pred of preds) {
      if (visited.has(pred)) continue;
      visited.add(pred);
      if (pred === sourceId) return true;
      queue.push(pred);
    }
  }
  return false;
}
```

#### 3. Tests
**File**: `src/tests/workflow-definition-validation.test.ts` (new or extend existing)
**Tests**:
- Input references existing upstream node → valid
- Input references non-existent node → error with node name
- Input references downstream node (not upstream) → error
- Input references parallel sibling (not upstream) → error
- Input references `trigger.*` or `input.*` → valid (built-in sources)
- No inputs → no data flow errors
- Complex DAG with multiple paths — verify upstream detection
- Self-referencing node: input references own node ID → error (a node is not upstream of itself)

### Success Criteria:

#### Automated Verification:
- [x] Definition validation tests pass: `bun test src/tests/workflow-definition-validation.test.ts`
- [x] All workflow tests pass: `bun test src/tests/workflow-`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Create a workflow via API with an input mapping referencing a non-existent node → get validation error
- [ ] Create a workflow with valid data flow → accepted

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: Integration Testing + Manual E2E

### Overview
Full integration test that exercises I/O schemas, convergence, triggerSchema, and bug fixes together. Plus manual E2E verification against a running API server.

### Changes Required:

#### 1. Integration test
**File**: `src/tests/workflow-integration-io.test.ts` (new)
**Tests**: A single workflow definition that exercises:
- `triggerSchema` with required fields
- Node A: `inputs: {repo: "trigger.repo"}`, `inputSchema` validates `repo` is string
- Node B: conditional next based on code-match
- Node C: converges from A's true branch (B skipped)
- Node D: `inputs: {result: "A.stdout", code: "C.taskOutput"}`, chained data flow
- Verify context bag, step diagnostics, unresolved tokens

#### 2. Manual E2E verification
Run against a real API server:

```bash
# 1. Start API
bun run start:http &

# 2. Create a workflow with triggerSchema + inputs + inputSchema
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "IO Schema Test",
    "enabled": true,
    "triggerSchema": {
      "type": "object",
      "properties": { "message": { "type": "string" } },
      "required": ["message"]
    },
    "definition": {
      "nodes": [{
        "id": "echo",
        "type": "script",
        "inputs": { "msg": "trigger.message" },
        "config": { "runtime": "bash", "script": "echo {{msg}}" }
      }]
    }
  }'

# 3. Trigger with invalid payload (should fail with 400)
curl -s -X POST http://localhost:3013/api/workflows/<id>/trigger \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"wrong": "field"}'

# 4. Trigger with valid payload
curl -s -X POST http://localhost:3013/api/workflows/<id>/trigger \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "hello world"}'

# 5. Check run status and step diagnostics
curl -s http://localhost:3013/api/workflow-runs/<runId> \
  -H "Authorization: Bearer $API_KEY" | jq '.steps[0].diagnostics'

# 6. Create workflow with input mapping typo → verify unresolved tokens logged
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Typo Test",
    "enabled": true,
    "definition": {
      "nodes": [{
        "id": "echo",
        "type": "script",
        "inputs": { "msg": "trigger.typo_field" },
        "config": { "runtime": "bash", "script": "echo {{msg}}" }
      }]
    }
  }'

# 7. Test agent-task with explicit inputs mapping (highest-value scenario)
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Task IO Test",
    "enabled": true,
    "triggerSchema": {
      "type": "object",
      "properties": { "repo": { "type": "string" } },
      "required": ["repo"]
    },
    "definition": {
      "nodes": [
        {
          "id": "fetch",
          "type": "script",
          "inputs": { "repo": "trigger.repo" },
          "config": { "runtime": "bash", "script": "echo {{repo}}" },
          "next": "review"
        },
        {
          "id": "review",
          "type": "agent-task",
          "inputs": { "code": "fetch.stdout" },
          "inputSchema": {
            "type": "object",
            "properties": { "code": { "type": "string" } },
            "required": ["code"]
          },
          "config": {
            "template": "Review this code: {{code}}",
            "tags": ["review", "{{trigger.repo}}"]
          }
        }
      ]
    }
  }'
# Trigger and verify the agent-task node receives interpolated inputs

# 8. Cleanup
kill $(lsof -ti :3013)
```

### Success Criteria:

#### Automated Verification:
- [x] Integration test passes: `bun test src/tests/workflow-integration-io.test.ts`
- [x] Full test suite passes: `bun test`
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Invalid trigger payload → 400 with schema violation details
- [x] Valid trigger payload → workflow executes, step output correct
- [x] Unresolved token → warning logged, diagnostics stored in step record
- [x] Data flows correctly through `inputs` mappings between nodes
- [ ] Agent-task node with `inputs` mapping receives interpolated data from prior script node
- [ ] Agent-task `inputSchema` validates resolved inputs before execution

**Implementation Note**: Final verification. After this phase passes, the feature is complete.

---

## Testing Strategy

| Level | Coverage |
|-------|----------|
| **Unit** | `interpolate()`, `deepInterpolate()`, `safeStringify()` — exhaustive edge case matrix |
| **Unit** | `validateJsonSchema()` — type checks, required fields, nested properties |
| **Unit** | `isUpstream()`, `validateDefinition()` data flow checks |
| **Unit** | Input resolution, inputSchema/outputSchema validation |
| **Unit** | Bug 4 (node execution counting), Bug 7 (retry context history) |
| **Integration** | Full workflow execution with I/O schemas, convergence, triggerSchema |
| **E2E** | Manual curl commands against running API server (including agent-task with inputs) |

## Dependencies

- No new npm packages required (`z.toJSONSchema()` is built-in, JSON Schema validation is hand-rolled)
- 3 new DB migrations:
  - `010_step_diagnostics.sql` — diagnostics column on workflow_run_steps (Phase 1)
  - `011_step_next_port.sql` — nextPort column on workflow_run_steps (Phase 2)
  - `012_trigger_schema.sql` — triggerSchema column on workflows (Phase 4)

## References

- Research: `thoughts/taras/research/2026-03-19-workflow-node-io-schemas-and-bugs.md`
- Redesign plan: `thoughts/taras/plans/2026-03-18-workflow-redesign.md`
- Original engine research: `thoughts/taras/research/2026-03-06-workflow-engine-design.md`
- Engine: `src/workflows/engine.ts`
- Template: `src/workflows/template.ts`
- Types: `src/types.ts:593-710`
- Definition: `src/workflows/definition.ts`
- Base executor: `src/workflows/executors/base.ts`
- Registry: `src/workflows/executors/registry.ts`
- Checkpoint: `src/workflows/checkpoint.ts`
- Agent-task executor: `src/workflows/executors/agent-task.ts`
