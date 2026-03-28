---
date: 2026-03-19T18:00:00Z
topic: "Workflow Node I/O Schemas, Data Flow Mapping, and Engine Bugs"
status: complete
researcher: taras+claude
autonomy: verbose
---

# Workflow Node I/O Schemas, Data Flow Mapping, and Engine Bugs

**Context**: QA of the workflow redesign (plan: `thoughts/taras/plans/2026-03-18-workflow-redesign.md`) revealed that the engine has no typed input/output contracts on workflow nodes and several execution bugs.

**Scope**: Three areas — (1) dynamic I/O schema validation, (2) output-to-input mapping between nodes, (3) engine bugs found during code review.

---

## 1. Current State

### How data flows today

```
Workflow triggers → ctx = { trigger: <payload>, input: <resolved vars> }
                         ↓
Node A executes → ctx["A"] = <A's output>
                         ↓
Node B config: "Process {{A.stdout}}" → interpolate() → "Process hello"
                         ↓
Node B executes → ctx["B"] = <B's output>
                         ↓
...continues until terminal nodes
```

### What exists

| Mechanism | Where | What it does |
|-----------|-------|-------------|
| **Workflow-level `input`** | `WorkflowSchema.input` | `Record<string, InputValue>` — resolves `${ENV}`, `secret.X`, literals at start |
| **Executor `configSchema`** | Each executor class | Zod schema validating the node's `config` object at runtime |
| **Executor `outputSchema`** | Each executor class | Zod schema validating the executor's return value at runtime |
| **Template interpolation** | `template.ts` | `{{path.to.value}}` → traverses context object, returns string |
| **Context bag** | `engine.ts` | Single `Record<string, unknown>` accumulating all outputs by nodeId |

### What's missing

| Gap | Impact |
|-----|--------|
| No **workflow trigger schema** | Callers (UI, agents, webhooks) don't know what data to pass |
| No **node input declaration** | Can't validate that upstream nodes produce what downstream nodes need |
| No **node output declaration** | Downstream nodes can't reason about available fields at authoring time |
| No **static data flow validation** | `validateDefinition()` checks graph structure only, not data wiring |
| No **interpolation failure reporting** | `{{typo}}` → silent empty string |

---

## 2. Bug Catalog

### Bug 1: Silent Interpolation Failure (Critical)

**File**: `src/workflows/template.ts:10,13`
**Problem**: When a `{{path.to.value}}` fails to resolve (typo, missing field, null midway), it returns `""` with zero logging. Downstream executors receive wrong data silently.

```typescript
// template.ts:10 — returns "" on mid-path failure
if (value == null || typeof value !== "object") return "";
// template.ts:13 — returns "" on final null
if (value == null) return "";
```

**Example**: `{{fetch.stdot}}` (typo for `stdout`) → `""` → executor runs with empty input → wrong results, no error signal.

**Proposed fix**: Return unresolved tokens alongside the result. Log warnings in the engine. Fail the step when node has input declarations with required fields. Store unresolved tokens in the step record for debugging visibility.

```typescript
export function interpolate(
  template: string,
  ctx: Record<string, unknown>,
): { result: string; unresolved: string[] } {
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
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
  return { result, unresolved };
}
```

Additionally, store unresolved tokens in the step record for debugging visibility:

```typescript
// In the engine, after interpolation:
if (unresolved.length > 0) {
  updateWorkflowRunStep(stepId, {
    diagnostics: { unresolvedTokens: unresolved }
  });
}
```

> **Testing note (Taras)**: Must have exhaustive unit tests covering all edge cases: missing path, null midway, typo, valid path, object stringification, nested objects, arrays, empty context. Full edge case matrix.

---

### Bug 2: Shallow Config Interpolation (High)

**File**: `src/workflows/engine.ts:266-274`
**Problem**: Only top-level string values in `config` are interpolated. Arrays and nested objects are passed through as-is.

```typescript
// engine.ts:268-273
for (const [key, value] of Object.entries(node.config)) {
  if (typeof value === "string") {
    interpolatedConfig[key] = interpolate(value, ctx);  // ✓ top-level string
  } else {
    interpolatedConfig[key] = value;  // ✗ arrays, objects skipped
  }
}
```

**Example**: `config.tags: ["{{nodeId}}", "fixed"]` — the `{{nodeId}}` is never replaced. The `agent-task` executor has to manually interpolate tags in its own `execute()` method.

**Proposed fix**: Deep interpolation utility that walks the config tree:

```typescript
function deepInterpolate(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolate(value, ctx).result;
  if (Array.isArray(value)) return value.map((v) => deepInterpolate(v, ctx));
  if (value != null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepInterpolate(v, ctx);
    }
    return result;
  }
  return value;
}
```

> **Testing note (Taras)**: Same exhaustive unit test coverage — nested objects, arrays of strings, mixed arrays, deeply nested, empty arrays, null values within arrays.

---

### Bug 3: Convergence Node Deadlock (High)

**File**: `src/workflows/engine.ts:170-179`, `src/workflows/engine.ts:206-216`
**Problem**: `getAllPredecessors()` returns ALL nodes that structurally point to a target node, regardless of which branch was taken at runtime. This causes deadlocks when conditional branches converge.

**Concrete example**:
```
A (next: { "true": "C", "false": "B" })
B (next: "C")
```

If A evaluates to `true` → routes directly to C:
1. `getAllPredecessors("C")` returns `["A", "B"]`
2. A is completed, but B was never executed (A skipped it)
3. `allPredsCompleted` = false (B not in completedNodeIds)
4. **C never runs → deadlock**

```typescript
// engine.ts:206-216 — finds ALL structural predecessors
function getAllPredecessors(def: WorkflowDefinition, nodeId: string): string[] {
  const preds: string[] = [];
  for (const node of def.nodes) {
    if (!node.next) continue;
    const targets = typeof node.next === "string" ? [node.next] : Object.values(node.next);
    if (targets.includes(nodeId)) {
      preds.push(node.id);  // ← Includes nodes on untaken branches
    }
  }
  return preds;
}
```

**Proposed fix**: Track the "active edge set" during execution. When a node completes with a specific port, only the edges for that port are "active". Convergence checks should only wait for predecessors whose edges are active.

```typescript
// Track active edges instead of just completed nodes
const activeEdges = new Set<string>(); // "sourceId→targetId"

// When a node completes with a port:
const successors = getSuccessors(def, node.id, result.nextPort || "default");
for (const succ of successors) {
  activeEdges.add(`${node.id}→${succ.id}`);
}

// Convergence check: only wait for predecessors with active edges
function getActivePredecessors(nodeId: string): string[] {
  return getAllPredecessors(def, nodeId).filter(
    (predId) => activeEdges.has(`${predId}→${nodeId}`)
  );
}
```

---

### Bug 4: MAX_ITERATIONS Counts Batches, Not Nodes (Medium)

**File**: `src/workflows/engine.ts:118-127`
**Problem**: `iterationCount` increments once per while-loop iteration (per batch of parallel nodes). A workflow with 200 parallel nodes = 1 iteration. Meanwhile, a simple linear chain of 101 nodes would fail.

**Proposed fix**: Count total node executions, not loop iterations. Or keep both: a per-node execution count AND a batch iteration limit.

---

### Bug 5: Context Injection Without Output Validation on Recovery (Medium)

**File**: `src/workflows/engine.ts:104-113`
**Problem**: On recovery/re-walk, completed steps get their stored output re-injected into context without any validation. If a step was completed with corrupted output (null, wrong type), downstream nodes get bad data.

```typescript
if (step?.output !== undefined) {
  ctx[nodeId] = step.output;  // No validation of output shape
}
```

**Proposed fix**: Validate output against the executor's `outputSchema` before injection. On validation failure, log a warning and either skip (lenient) or fail the run (strict).

> **Planning note (Taras)**: This should be bundled with the checkpoint/recovery phase (Phase 3 scope) in the implementation plan.

---

### Bug 6: JSON.stringify Crash on Circular References (Medium)

**File**: `src/workflows/template.ts:14`
**Problem**: `JSON.stringify(value)` will throw if the context contains circular references. This is an unhandled exception.

**Proposed fix**: Use a safe stringify that handles circular refs:
```typescript
return typeof value === "object" ? safeStringify(value) : String(value);
// where safeStringify catches TypeError and returns "[Circular]" or similar
```

---

### Bug 7: Retry Validation Context Overwrites Previous (Low)

**File**: `src/workflows/engine.ts:354-356`
**Problem**: Multiple validation retries overwrite the previous validation context under `${nodeId}_validation`. No history of previous attempts.

**Proposed fix**: Use an array: `ctx[${nodeId}_validations] = [...prev, retryContext]` or index by attempt: `ctx[${nodeId}_validation_${attempt}]`.

---

## 3. Design Proposal: Node I/O Schemas + Explicit Data Mapping

### Approach: Option B — Explicit `inputs` mapping with typed bindings

**Decision**: Since no workflows exist in production (feature is in alpha), we go with Option B — explicit data mapping. This is cleaner and more explicit than implicit interpolation-only.

### Node schema changes

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
  inputs: z.record(z.string(), z.string()).optional(),        // { localName: "sourceNodeId.field" }
  // NEW: Optional I/O schemas (JSON Schema format)
  inputSchema: z.record(z.string(), z.unknown()).optional(),  // Validates resolved inputs
  outputSchema: z.record(z.string(), z.unknown()).optional(), // Validates executor output
});
```

### How `inputs` works

The `inputs` field maps **context paths** to **local names** available in that node's config interpolation:

```json
{
  "id": "review",
  "type": "agent-task",
  "inputs": {
    "prNumber": "trigger.prNumber",
    "codeContent": "fetch.stdout"
  },
  "config": {
    "template": "Review PR #{{prNumber}}: {{codeContent}}"
  }
}
```

**Engine behavior**:
1. Resolve `inputs` by traversing the context bag for each path
2. Build a **local context** for this node: `{ ...resolvedInputs }`
3. Interpolate `config` against the local context (not the global bag)
4. If `inputSchema` exists, validate the resolved inputs against it
5. Execute the node
6. If `outputSchema` exists, validate the output (on top of executor's base schema)

**Key change**: Interpolation context becomes **local** (only declared inputs), not global (entire context bag). This forces explicit data wiring and catches missing references at resolution time rather than silently producing empty strings.

**Backward compatibility**: When a node has no `inputs` field, its interpolation context is **empty** (not the global bag). Since the feature is in alpha with no existing workflows, there is no backward compatibility concern — all workflows must use explicit `inputs` mappings going forward. The `trigger` and `input` prefixes are always available as built-in context sources regardless of `inputs` declarations.

### How executors interact with schemas

**Output validation** has two layers (both must pass):

1. **Executor's built-in `outputSchema`** (Zod) — always applies. This is the base contract. Example: script always outputs `{exitCode: number, stdout: string, stderr: string}`.
2. **Node-level `outputSchema`** (JSON Schema) — optional additional constraint on the executor's output. Useful for `agent-task` where the base output is `{taskId, taskOutput}` but the node wants to declare that `taskOutput` should match `{summary: string, rating: number}`.

**Schema derivation**: Use `zod-to-json-schema` to auto-convert executor Zod schemas to JSON Schema. No manual JSON Schema maintenance needed for built-in executors. Executors expose their schemas via:

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

abstract class BaseExecutor<TConfig, TOutput> {
  // Existing Zod schemas
  abstract readonly configSchema: TConfig;
  abstract readonly outputSchema: TOutput;

  /** Auto-derived JSON Schema for output — UI/tooling can read this */
  get outputJsonSchema(): Record<string, unknown> {
    return zodToJsonSchema(this.outputSchema) as Record<string, unknown>;
  }

  /** Auto-derived JSON Schema for config — UI/tooling can read this */
  get configJsonSchema(): Record<string, unknown> {
    return zodToJsonSchema(this.configSchema) as Record<string, unknown>;
  }
}
```

> **Clarification (from review)**: `configJsonSchema` is the JSON Schema version of the executor's `configSchema`. It describes what fields go in a node's `config` object. Example: for the script executor, it tells the UI "this node type accepts `{runtime: 'bash'|'ts'|'python', script: string, timeout?: number}`". Since we use `zod-to-json-schema`, it's auto-derived from the existing Zod schema — zero manual maintenance.

### Workflow-level trigger schema

**Decision**: Add a WF-level `triggerSchema` field that validates the trigger payload (`context.trigger`).

Rationale:
- `workflow.input` is about *resolution* (where static values come from: env vars, secrets)
- `context.trigger` is *dynamic data* passed at trigger time (PR number, webhook payload, etc.)
- The trigger schema defines the **external contract** — what callers must provide
- It's decoupled from internal node structure (reorganizing nodes doesn't change the external API)

```typescript
export const WorkflowSchema = z.object({
  // ... existing fields ...
  triggerSchema: z.record(z.string(), z.unknown()).optional(), // JSON Schema for trigger payload
});
```

**Example**:
```json
{
  "name": "PR Review Pipeline",
  "triggerSchema": {
    "type": "object",
    "properties": {
      "prNumber": { "type": "number" },
      "repo": { "type": "string" },
      "branch": { "type": "string" }
    },
    "required": ["prNumber", "repo"]
  },
  "definition": { "nodes": [...] }
}
```

When triggered via `POST /api/workflows/:id/trigger` or webhook, the engine validates the payload against `triggerSchema` before starting. Callers get a clear 400 error with the schema violation instead of a silent runtime failure.

### Static validation at creation time

Extend `validateDefinition()` to check data flow. **This must be recursive** — not just checking that source nodes exist, but that they're actually upstream (reachable before this node in the execution graph):

```typescript
// In validateDefinition():
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
        `Node "${node.id}" input "${localName}" references non-existent node "${sourceNodeId}"`
      );
      continue;
    }

    // Check source node is actually upstream (transitive predecessor of this node)
    if (!isUpstream(def, sourceNodeId, node.id)) {
      errors.push(
        `Node "${node.id}" input "${localName}" references "${sourceNodeId}" which is not upstream`
      );
    }
  }
}

/** Check if sourceId is a transitive predecessor of targetId.
 *  Builds the set of all predecessors of targetId via reverse BFS,
 *  then checks if sourceId is in that set. */
function isUpstream(
  def: WorkflowDefinition,
  sourceId: string,
  targetId: string,
): boolean {
  // Build reverse adjacency: for each node, who are its predecessors?
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

  // BFS backward from targetId — collect all transitive predecessors
  const visited = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const preds = reverseDeps.get(current) || [];
    for (const pred of preds) {
      if (visited.has(pred)) continue;
      visited.add(pred);
      if (pred === sourceId) return true; // Early exit
      queue.push(pred);
    }
  }

  return false;
}
```

### Which executors have fixed vs. dynamic outputs

| Executor | Output Shape | Fixed? | Notes |
|----------|-------------|--------|-------|
| **script** | `{exitCode, stdout, stderr}` | Yes | Auto-derived from Zod |
| **property-match** | `{passed, results[]}` | Yes | Auto-derived from Zod |
| **code-match** | `{port, rawResult}` | Yes | Auto-derived from Zod |
| **notify** | `{sent, messageId?, message}` | Yes | Auto-derived from Zod |
| **raw-llm** | `{result, model}` | Partially | `result` shape depends on `config.schema` |
| **vcs** | `{url, id}` | Yes | Auto-derived from Zod |
| **validate** | `{pass, reasoning, confidence}` | Yes | Auto-derived from Zod |
| **agent-task** | `{taskId, taskOutput}` | No | `taskOutput` is whatever the agent returns |

For `raw-llm` and `agent-task`, the node-level `outputSchema` adds value — it constrains the dynamic part.

---

## 4. Registry Enhancement

Expose executor metadata for UI/agent tooling:

```typescript
class ExecutorRegistry {
  // ... existing ...

  /** Get executor type metadata (for UI / agent tooling) */
  getExecutorMeta(type: string): {
    type: string;
    mode: "instant" | "async";
    configJsonSchema: Record<string, unknown>;
    outputJsonSchema: Record<string, unknown>;
    ports?: string[];
  } | undefined {
    const executor = this.executors.get(type);
    if (!executor) return undefined;
    return {
      type: executor.type,
      mode: executor.mode,
      configJsonSchema: executor.configJsonSchema,
      outputJsonSchema: executor.outputJsonSchema,
    };
  }

  /** Get all executor metadata — for workflow builder UI */
  getAllMeta() {
    return this.types().map((t) => this.getExecutorMeta(t)!);
  }
}
```

This enables the UI and MCP tools to show "available executor types with their expected config and output shapes" — enabling informed workflow authoring.

---

## 5. Resolved Questions

| # | Question | Resolution | Rationale |
|---|----------|-----------|-----------|
| 1 | **JSON Schema library** | Use `zod-to-json-schema` | Auto-derive from existing Zod schemas. Taras approved. |
| 2 | **Strict mode** | Warnings by default, errors when `inputs`/`inputSchema` has required fields | Add exhaustive edge case test matrix (Taras). |
| 3 | **Convergence fix scope** | Part of the plan from this research | Not a separate PR (Taras). |
| 4 | **Workflow-level input schema** | WF-level `triggerSchema` field | Validates external trigger payload. Decoupled from internal node structure. See §3. |
| 5 | **Migration** | No migration needed | Feature is in alpha, no existing workflows (Taras). |
| 6 | **Option A vs B** | Option B (explicit `inputs` mapping) | No existing workflows to break. Cleaner contracts (Taras). |
| 7 | **Bug 5 placement** | Bundle with checkpoint/recovery phase | Part of Phase 3 scope (Taras). |
| 8 | **Schema derivation** | Auto-derive via `zodToJsonSchema()` on BaseExecutor | No manual JSON Schema maintenance. Both `configJsonSchema` and `outputJsonSchema` auto-derived. (Taras) |

---

## 6. Next Steps

This research feeds into a **single implementation plan** covering:
1. Bug fixes (all 7 bugs from §2)
2. Node I/O schemas + explicit `inputs` mapping (§3)
3. Workflow-level `triggerSchema` (§3)
4. Registry metadata enhancement (§4)
5. Exhaustive test matrix for interpolation edge cases

---

## References

- Plan: `thoughts/taras/plans/2026-03-18-workflow-redesign.md`
- Research (original): `thoughts/taras/research/2026-03-06-workflow-engine-design.md`
- Research (redesign): `thoughts/taras/research/2026-03-18-workflow-redesign.md`
- Engine: `src/workflows/engine.ts`
- Template: `src/workflows/template.ts`
- Types: `src/types.ts:593-601` (WorkflowNodeSchema)
- Definition utils: `src/workflows/definition.ts`
- Executors: `src/workflows/executors/`

---

## Review Notes (2026-03-19)

**Reviewer**: Claude (code-verified review)

### Changes made during review

1. **Fixed `isUpstream()` algorithm** (§3) — Original BFS checked reachability from entry, which is incorrect. A node reachable from entry is not necessarily upstream of the target (could be on a parallel branch). Replaced with reverse BFS from `targetId` that collects transitive predecessors and checks if `sourceId` is among them.

2. **Merged Bug 5 into Bug 1** — "No Unresolved Token Tracking" was a duplicate of Bug 1 ("Silent Interpolation Failure"). The `diagnostics` storage code is now included in Bug 1. Bug count reduced from 8 to 7.

3. **Added backward compatibility clarification** (§3) — Explicitly stated that nodes without `inputs` get an empty interpolation context (not the global bag), which is safe since the feature is in alpha with no existing workflows.

### All bug claims verified against codebase

All 7 bugs were verified with exact line-number matches against the actual source code. No discrepancies found.

### Open questions for the implementation plan

1. **`triggerSchema` enforcement for webhooks** — Webhook payloads (GitHub, Slack) have externally-determined shapes. Should `triggerSchema` be enforced (reject non-conforming payloads) or advisory (log warning, continue) for webhook-triggered workflows? This affects whether webhook integrations need per-workflow schema authoring.

2. **`ports` in registry metadata** — The `getExecutorMeta()` return type includes `ports?: string[]` but executors don't currently expose a `ports` list. The plan needs to either (a) add a `ports` property to `BaseExecutor` that executors override, or (b) remove `ports` from the proposal.

3. **Bug 3 fix requires more engine surgery** — The active-edge tracking proposal is conceptual (data structures only), unlike the other bug fixes which are drop-in ready. The plan should account for this being a larger scope item that touches the core `walkGraph` loop.
