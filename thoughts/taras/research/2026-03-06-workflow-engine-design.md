# Workflow Engine Design Research
**Date**: 2026-03-06
**Context**: Building a lightweight workflow/automation engine inside the agent-swarm TypeScript/Bun/SQLite application.

---

## 1. Key Requirements Recap

- **Node types**: Triggers (webhook, schedule, new-task), conditionals (LLM-classify, property-match), actions (create-task, send-message, delegate)
- **Storage**: SQLite-native — DAG definition + execution state
- **Execution model**: Event-driven, fire-and-forget — trigger fires, engine evaluates DAG, executes actions. No durable/resumable long-running flows needed.
- **LLM routing**: Some conditional nodes call the LLM to classify the event and branch accordingly.

---

## 2. How Existing Systems Store DAG Definitions

### 2a. n8n — JSON Blob per Workflow

n8n stores each workflow as a single JSON document. This is the dominant pattern for node-based editors.

**Top-level shape:**
```json
{
  "id": "workflow-uuid",
  "name": "My Workflow",
  "active": true,
  "nodes": [ /* array of node objects */ ],
  "connections": { /* adjacency map: source-node → port → [targets] */ },
  "settings": { "errorWorkflow": "...", "timezone": "..." },
  "staticData": null
}
```

**Each node:**
```json
{
  "id": "node-uuid",
  "name": "Check Bug Report",
  "type": "n8n-nodes-base.if",
  "typeVersion": 2,
  "position": [620, 300],
  "parameters": {
    "conditions": {
      "string": [{ "value1": "={{ $json.type }}", "operation": "equals", "value2": "bug" }]
    }
  }
}
```

**Connections (adjacency map by node name → output port type → array of arrays):**
```json
{
  "Webhook": {
    "main": [[{ "node": "Check Bug Report", "type": "main", "index": 0 }]]
  },
  "Check Bug Report": {
    "main": [
      [{ "node": "Create Bug Task", "type": "main", "index": 0 }],   // true branch
      [{ "node": "Create Feature Task", "type": "main", "index": 0 }] // false branch
    ]
  }
}
```

**Key insight**: The connections object is `Record<sourceNodeName, Record<portType, Array<Array<{ node, type, index }>>>>`. Output port 0 = true/first, output port 1 = false/second for IF nodes. Each inner array is one output port's list of targets (supporting fan-out).

**Verdict for us**: The n8n JSON-blob approach maps cleanly to a single SQLite TEXT column (`definition JSON`). Great for our use case since we read the whole definition when a trigger fires. No need to join across tables just to reconstruct the graph.

### 2b. Windmill — OpenFlow JSON Format

Windmill uses its own open spec called OpenFlow. Structurally similar: a JSON document with a `value` field containing an array of `modules` (steps). Conditionals are represented as branch modules with sub-steps. The DAG is expressed as a linear sequence where branch points have inline child sequences — more like a tree than a pure graph.

**Less relevant** for us since Windmill workflows are more sequential/tree-shaped, while n8n's adjacency-map approach handles arbitrary fan-in/fan-out.

### 2c. Normalized Tables (Classical Workflow Engines)

Traditional BPM-style engines (BPEL, Imixs, etc.) use normalized tables:

```sql
workflow_definitions (id, name, version, created_at)
workflow_nodes       (id, workflow_id, node_type, config JSON, position_x, position_y)
workflow_edges       (id, workflow_id, source_node_id, source_port, target_node_id, target_port)
workflow_instances   (id, workflow_id, status, context JSON, created_at, updated_at)
workflow_step_log    (id, instance_id, node_id, status, input JSON, output JSON, started_at, finished_at)
```

**Pros**: Query individual nodes/edges, add indexes, join on workflow_id.
**Cons**: Reconstructing the full graph requires joining 2-3 tables. For our case (read the full graph on trigger fire, no node-level querying), this is overhead without benefit.

**Verdict**: For read-heavy "load entire workflow on event" usage, JSON blob wins in SQLite. Use normalized tables only if you need to query "which workflows use node type X" or do per-node analytics.

---

## 3. SQLite Schema Recommendation

Two tables: one for definitions (the DAG), one for runs (execution state per trigger fire).

```sql
-- Workflow definitions (the DAG as a JSON blob)
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,        -- uuid
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  trigger     TEXT NOT NULL,           -- 'webhook' | 'schedule' | 'new-task' | etc.
  trigger_config JSON,                 -- e.g. { "cron": "*/5 * * * *" } or { "event": "task.created" }
  definition  JSON NOT NULL,           -- full DAG: { nodes: [...], edges: [...] }
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Execution runs (one row per trigger fire)
CREATE TABLE workflow_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  status       TEXT NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  trigger_data JSON,           -- the raw event that fired the trigger
  context      JSON,           -- accumulated data as nodes execute (keyed by node id)
  error        TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

-- Optional: per-node execution log for debugging
CREATE TABLE workflow_run_steps (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id      TEXT NOT NULL,
  node_type    TEXT NOT NULL,
  status       TEXT NOT NULL,  -- 'completed' | 'failed' | 'skipped'
  input        JSON,
  output       JSON,
  error        TEXT,
  executed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_run_steps_run_id ON workflow_run_steps(run_id);
```

**Definition JSON shape** (what goes in `workflows.definition`):

```ts
interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface WorkflowNode {
  id: string;           // "node-uuid"
  type: NodeType;       // 'webhook-trigger' | 'schedule-trigger' | 'new-task-trigger'
                        // | 'llm-classify' | 'property-match'
                        // | 'create-task' | 'send-message' | 'delegate'
  label?: string;
  config: Record<string, unknown>; // node-type-specific config
}

interface WorkflowEdge {
  id: string;
  source: string;       // source node id
  sourcePort: string;   // "default" | "true" | "false" | label of classification output
  target: string;       // target node id
}
```

Edges use named ports instead of index numbers (unlike n8n). This is cleaner for LLM-classification nodes that output multiple named branches (e.g. `"bug"`, `"feature"`, `"question"`, `"spam"`).

---

## 4. Execution Engine Architecture

### 4a. The Pattern: Event-Fired Synchronous DAG Walk

Since there is no need for durability/resumability (agents handle async work), the execution model is simple:

```
Event arrives → load workflow definition → walk DAG from trigger node → execute each reachable node in topological order → done
```

This is the Inngest model *without* the durable execution layer. Inngest's key insight: memoize step outputs so that if the function crashes it can resume. We don't need that — our runs are short-lived and synchronous from the engine's perspective.

**Core executor loop (pseudocode):**

```ts
async function runWorkflow(workflow: WorkflowDefinition, triggerData: unknown) {
  const ctx: Record<string, unknown> = { trigger: triggerData };
  const queue = [findTriggerNode(workflow)];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    const input = resolveInputs(node, ctx, workflow);
    const result = await executeNode(node, input);

    ctx[node.id] = result.output;

    // result.nextPort is "default" | "true" | "false" | a classification label
    const nextNodes = getSuccessors(workflow, node.id, result.nextPort);
    queue.push(...nextNodes);
  }
}
```

Key design decisions:
1. **Context map** (`ctx`) keyed by node ID — each node's output is stored and available to downstream nodes via expression resolution (like n8n's `$node["node-name"].json.fieldName`).
2. **nextPort** — the output of a node execution includes *which* port to traverse. Conditional nodes return the port label matching their decision.
3. **Topological order via BFS** — simple queue works for DAGs; no need for a full topological sort library.
4. **Synchronous within the engine** — actions like "create task" call the existing agent-swarm API/DB directly. The engine awaits each node before moving on.

### 4b. What Temporal and Inngest Teach Us (and Why We Don't Need It)

- **Temporal**: stores every step as an event in an append-only history. On failure, replays the history deterministically to reconstruct state. Great for month-long workflows; overkill for our use case.
- **Inngest**: re-executes the entire function from scratch on each step, memoizing completed steps via a state store. Same durability goal as Temporal but using the existing DB rather than a separate service.

**Our model is simpler**: fire trigger → execute to completion → write a run row to SQLite when done. If the process crashes mid-run, the run stays `'running'` forever — acceptable for short automation runs. A watchdog can mark stuck runs as failed after a timeout.

### 4c. Node Execution Interface

```ts
type NodeResult = {
  output: Record<string, unknown>; // stored in ctx[node.id]
  nextPort: string;                 // which outgoing edge(s) to follow
};

type NodeExecutor = (node: WorkflowNode, input: Record<string, unknown>) => Promise<NodeResult>;
```

Register executors by node type in a map:

```ts
const executors: Record<string, NodeExecutor> = {
  'webhook-trigger':  webhookTriggerExecutor,
  'new-task-trigger': newTaskTriggerExecutor,
  'property-match':   propertyMatchExecutor,
  'llm-classify':     llmClassifyExecutor,
  'create-task':      createTaskExecutor,
  'send-message':     sendMessageExecutor,
  'delegate':         delegateExecutor,
};
```

This is the **registry pattern** used by n8n (node type string → handler) and ts-edge (node functions registered by name).

---

## 5. Conditional Nodes

### 5a. Property-Match Node (deterministic)

Config:
```json
{
  "type": "property-match",
  "config": {
    "field": "$.event.type",       // JSONPath into trigger data
    "operator": "equals",          // equals | contains | regex | gt | lt
    "value": "bug",
    "truePort": "true",
    "falsePort": "false"
  }
}
```

Executor: evaluate the condition, return `nextPort: "true"` or `"false"`.

n8n's IF node behavior: when multiple items arrive, each is individually evaluated and routed. Both output ports can have items simultaneously. For our case (single event per trigger), this is just a simple branch.

### 5b. LLM-Classify Node

This is the most interesting case. AWS Prescriptive Guidance, LangChain, and the semantic-router project all converge on the same pattern:

**Pattern: LLM-as-Classifier with Structured Output**

Config:
```json
{
  "type": "llm-classify",
  "config": {
    "prompt": "Classify the following support ticket into exactly one of: bug, feature, question, spam.\n\nTicket: {{trigger.body.text}}\n\nRespond with JSON: { \"category\": \"<one of the above>\" }",
    "outputField": "category",
    "model": "claude-haiku-3-5",   // use cheap/fast model
    "categories": ["bug", "feature", "question", "spam"],
    "fallbackPort": "question"     // if LLM returns unexpected value
  }
}
```

The outgoing edges use port names matching the categories: `"bug"`, `"feature"`, `"question"`, `"spam"`.

**Executor:**
```ts
async function llmClassifyExecutor(node, input): Promise<NodeResult> {
  const prompt = interpolate(node.config.prompt, input);
  const response = await callLLM(node.config.model, prompt);
  // parse structured output — use `response_format: { type: "json_object" }` or tool_use
  const parsed = JSON.parse(response);
  const category = parsed[node.config.outputField];
  const port = node.config.categories.includes(category)
    ? category
    : node.config.fallbackPort;
  return { output: parsed, nextPort: port };
}
```

**Reliability notes from research:**
- Use structured output / `response_format: json_object` or tool-calling to avoid parse failures.
- Use a fast, cheap model (Haiku, GPT-4o-mini) — classification tasks don't need frontier models.
- Always define a `fallbackPort` for when the LLM returns an unexpected category.
- Semantic Router (aurelio-labs) takes a different approach: embed the categories and compute cosine similarity instead of calling an LLM for each routing decision. Faster and cheaper, but less flexible for nuanced classification.

**Two routing strategies to consider:**

| Strategy | How it works | When to use |
|---|---|---|
| LLM structured output | Ask LLM to classify, parse JSON | Complex/nuanced classification |
| Embedding similarity | Embed input, compare to category centroids | High-volume, simple categories |

For agent-swarm's use case (webhook events, new tasks), LLM structured output is simpler to implement and flexible enough.

---

## 6. Input Resolution / Template Expressions

Every downstream node needs to reference data from upstream nodes. The standard approach (n8n, Windmill) is a simple expression language in node config values:

- n8n: `={{ $node["Webhook"].json.body.type }}`
- Windmill: `results.step1.field`

For our use case, a minimal JSONPath or mustache-style approach is sufficient:

```ts
// In node config: "{{trigger.body.text}}" or "{{nodes.classify-node.category}}"
function resolveValue(template: string, ctx: Record<string, unknown>): unknown {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    return getPath(ctx, path.trim()); // simple dot-path resolver
  });
}
```

The context object shape:
```ts
{
  trigger: { /* raw trigger payload */ },
  nodes: {
    "node-id-1": { /* output of node 1 */ },
    "node-id-2": { /* output of node 2 */ },
  }
}
```

---

## 7. Trigger Subscription Model

Triggers are not part of the execution engine — they are the entry points. The pattern:

```
EventBus.on('task.created', (event) => {
  const matchingWorkflows = await db.query(
    'SELECT * FROM workflows WHERE enabled = 1 AND trigger = ?', ['new-task']
  );
  for (const wf of matchingWorkflows) {
    await runWorkflow(JSON.parse(wf.definition), event);
  }
});
```

Each trigger type maps to an internal event:
- `webhook` → an HTTP POST hits `/webhooks/:workflowId`
- `schedule` → a cron job fires (use existing `bun` cron or setInterval)
- `new-task` → subscribe to the existing task-created event in agent-swarm

Trigger-specific config lives in `workflows.trigger_config` and `workflows.trigger` (the type discriminant), not inside the DAG definition. This keeps the definition pure graph and the trigger wiring separate.

---

## 8. What ts-edge Teaches Us (Lightweight TypeScript DAG)

ts-edge (cgoinglove/ts-edge) is the closest thing to what we'd build:
- Nodes are functions registered by name
- Edges define flow between them
- Conditional branching via returning a port/key from the node function
- Type-safe: input/output types validated at compile time
- Built-in state management (shared mutable context)

The key API insight from ts-edge: **a node function returns both its output AND the name of the next node(s) to execute**. This is cleaner than a separate edge-lookup step. For our case, we'll handle the edge lookup in the engine (so workflow definitions can be stored in SQLite), but the conceptual model is the same.

---

## 9. Recommended Design Summary

### Schema
- **JSON blob** for workflow definitions in SQLite (`workflows.definition`). One row per workflow, full DAG in a single TEXT/JSON column.
- **Normalized run tracking** for execution state (`workflow_runs`, `workflow_run_steps`). Rows are cheap; this gives you debuggability and the ability to query run history.

### DAG Representation
- **Node array + Edge array** (not n8n's adjacency map). Cleaner to reason about, easier to traverse programmatically, easier to build a UI for later.
- Named ports on edges (`sourcePort: "true" | "false" | "bug" | "feature"`).

### Execution Model
- Synchronous BFS/DFS walk of the DAG on each trigger fire.
- No durability/memoization needed — runs are short (seconds).
- Executor registry: `Map<nodeType, NodeExecutor>`.
- Context accumulation map: `{ trigger: ..., nodes: { [nodeId]: output } }`.
- Write run row at start (`status: 'running'`), update at end (`status: 'completed' | 'failed'`).

### LLM Routing
- Structured output (JSON mode) from a fast model.
- Named output ports matching the classification categories.
- Fallback port for unexpected outputs.
- Config includes the prompt template, model, category list, and fallback.

### Branching Logic
- Property-match: pure JS evaluation, no LLM.
- LLM-classify: async LLM call, structured output, port = returned category.
- Both node types return `{ output, nextPort }`.
- Engine follows edges where `edge.source === node.id && edge.sourcePort === nextPort`.

---

## 10. References

- [n8n Workflow JSON Format Guide](https://generactorai.com/blog/n8n/20174/n8n-workflow-json-format-guide/)
- [n8n Workflows and Data Flow (DeepWiki)](https://deepwiki.com/n8n-io/n8n-docs/2.1-workflows-and-data-flow)
- [n8n IF/Switch Conditional Routing Guide](https://n8n.blog/n8n-if-switch-conditional-routing-guide/)
- [Windmill OpenFlow Format](https://www.windmill.dev/docs/openflow)
- [Windmill Architecture and Data Exchange](https://www.windmill.dev/docs/flows/architecture)
- [Inngest — How Functions Are Executed (Durable Execution)](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Inngest — How a Durable Workflow Engine Works](https://www.inngest.com/blog/how-durable-workflow-engines-work)
- [Inngest Steps](https://www.inngest.com/docs/learn/inngest-steps)
- [Building a Durable Execution Engine With SQLite (Gunnar Morling)](https://www.morling.dev/blog/building-durable-execution-engine-with-sqlite/)
- [OpenWorkflow — TypeScript/SQLite durable workflows](https://github.com/openworkflowdev/openworkflow)
- [ts-edge — Lightweight TypeScript DAG engine](https://github.com/cgoinglove/ts-edge)
- [AWS Prescriptive Guidance — Workflow for Routing (Agentic AI)](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-for-routing.html)
- [AWS — Routing Dynamic Dispatch Patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/routing-dynamic-dispatch-patterns.html)
- [Semantic Router (aurelio-labs)](https://github.com/aurelio-labs/semantic-router)
- [Temporal — Workflow Engine Design Principles](https://temporal.io/blog/workflow-engine-principles)
- [Temporal — Event History (TypeScript)](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript)
- [GeeksforGeeks — Database Design for Workflow Management Systems](https://www.geeksforgeeks.org/dbms/database-design-for-workflow-management-systems/)
- [Architecture Weekly — Workflow Engine Design Proposal](https://www.architecture-weekly.com/p/workflow-engine-design-proposal-tell)
- [Temporal Community — Executing a DAG in a Workflow](https://community.temporal.io/t/executing-a-dag-in-a-workflow/8472)
