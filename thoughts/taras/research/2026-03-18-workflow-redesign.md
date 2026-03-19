---
date: 2026-03-18T14:30:00Z
topic: "Workflow Engine Redesign"
status: reviewed
researcher: taras+claude
---

# Workflow Engine Redesign — Research

**Status**: v2 — incorporates Taras review feedback + Temporal research
**Prior art**: [Content-Agent Workflow Engine Mechanics](/Users/taras/Documents/code/content-agent/thoughts/shared/research/2026-03-18-workflow-engine-mechanics.md)
**Supersedes**: [2026-03-06-workflow-engine-design.md](./2026-03-06-workflow-engine-design.md) (original design that led to current implementation)

---

## 1. Motivation

The current workflow engine (shipped from the March 6 design) works but has architectural issues:

1. **Cyclical triggers** — Event-based triggers (task.created, task.completed) fire workflows that create tasks, creating infinite loops. Guard logic is fragile.
2. **No executor abstraction** — Node executors are scattered across files with no unified contract. Adding a new step type means touching engine code.
3. **No validation/quality gates** — No built-in way to validate step outputs, retry on failure, or gate workflow progression.
4. **No durability guarantees** — If the process crashes mid-workflow, recovery depends on detecting "stuck" runs after the fact.
5. **No versioning** — Workflow definitions are mutable JSON in the DB with no history.
6. **No workflow templates** — Can't share reusable workflow patterns (e.g., content-agent daily docs update, weekly blog post generator, QA weekly bug bash). Templates should be first-class: define once, instantiate many times with different inputs.

The goal: redesign the workflow engine to adopt the **executor registry pattern** from content-agent, add **checkpoint-based durability**, and clean up the execution model — while preserving DAG support and the multi-agent task delegation model.

---

## 2. Design Decisions (from Q&A with Taras)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Core pattern** | Executor registry (class-based) + validation model | Clean `execute(input) → output`, quality gates, retry. Extensible via class inheritance. |
| **Execution model** | Directed graph with event-loop style executor | Idle until step ready → execute → checkpoint → next. Cycles allowed with max-iterations guard. See §4.8. |
| **Durability** | Checkpoint-based | Persist after each step, resume from last success. Aspire to deterministic replay later. |
| **Definitions** | Keep in database (JSON) | UI-friendly, API-driven. Add version history table. |
| **Triggers** | Simplify: webhook (HMAC) + schedule (via scheduleId ref). Manual always available (UI or agent MCP tool). | Event-based triggers deferred — too cyclical. |
| **Step types (initial)** | script, agent-task, raw-llm, vcs, property-match, code-match, send-message, validate | Start lean, extend via registry. |
| **LLM execution** | Agent tasks (primary) + raw AI SDK/OpenRouter (secondary) | Complex work = agent task. Simple structured ops = direct LLM call. |
| **Validation** | Executor `fn(output) → {pass, reasoning, confidence}` per-step | Reusable RetryPolicy type. Global final validation deferred. |
| **Context chain** | Node IDs (current style) | Machine-friendly, avoids naming conflicts in DAG. |
| **Schedules** | Triggers array on workflow, schedule ID reference to `scheduled_tasks` | SOT in schedules table, atomic removal. |
| **Schema format** | Nodes with `next` references, edges auto-generated for UI | Compact authoring, nodes are the key structure, edges purely visual. |
| **Migration** | Rip and replace | Clean break on `feat/workflow-redesign` branch. Nobody uses current workflows. |
| **Templates** | First-class workflow templates, instantiable with custom inputs | Enable reusable patterns across domains. |

**Future direction**: Agent-defined reusable "tools" as first-class citizens — think little lambdas that agents can define and then reference in workflow steps. Not in scope for this redesign but the class-based executor pattern should make this extensible.

---

## 3. Current System Inventory

### 3.1 What Exists Today

**Database tables** (from `003_workflows.sql`, `004_workflow_source.sql`):
- `workflows` — DAG definitions (JSON: `{nodes, edges}`)
- `workflow_runs` — Execution instances (status, context, error)
- `workflow_run_steps` — Per-node execution history
- `agent_tasks` extensions — `workflowRunId`, `workflowRunStepId` columns

**Engine** (`src/workflows/`):
- `engine.ts` — BFS DAG walker, `startWorkflowExecution()`, `walkGraph()`, `executeNode()`
- `resume.ts` — Event bus listeners for task.completed/failed/cancelled → resume waiting runs
- `recovery.ts` — Detect stuck runs (waiting + task already done), re-trigger resume
- `triggers.ts` — Match events → fire workflows
- `event-bus.ts` — Simple in-process EventEmitter
- `template.ts` — `{{path.to.value}}` interpolation
- `llm-provider.ts` — OpenRouter or Claude CLI for `llm-classify` node
- `index.ts` — `initWorkflows()` wires up event listeners

**Node executors** (`src/workflows/nodes/`):
- `create-task.ts` — Async: creates agent task, pauses workflow
- `delegate-to-agent.ts` — Async: assigns/offers task to agent
- `send-message.ts` — Instant: posts to channel
- `property-match.ts` — Instant: JSONPath condition evaluation
- `code-match.ts` — Instant: sandboxed JS evaluation
- `llm-classify.ts` — Instant (awaited): AI SDK structured output for classification

**Trigger nodes** (7 types): `trigger-new-task`, `trigger-task-completed`, `trigger-webhook`, `trigger-email`, `trigger-slack-message`, `trigger-github-event`, `trigger-gitlab-event`

**MCP tools** (`src/tools/workflows/`): 9 tools (CRUD + trigger + runs + retry)
**HTTP API** (`src/http/workflows.ts`): Full REST for workflows, runs, steps, retry, webhook trigger
**Tests**: ~2,500 lines across 9 test files + E2E script

### 3.2 What Gets Replaced

| Component | Action |
|-----------|--------|
| `src/workflows/engine.ts` | **Replace** — New engine with executor registry + checkpoint durability |
| `src/workflows/nodes/*` | **Replace** — Rewrite as executor classes registered in registry |
| `src/workflows/triggers.ts` | **Replace** — Simplify to webhook + schedule + manual |
| `src/workflows/resume.ts` | **Refactor** — Keep event-driven resume for async executors but integrate into new engine |
| `src/workflows/recovery.ts` | **Refactor** — Checkpoint-based recovery replaces stuck-run detection |
| `src/workflows/event-bus.ts` | **Keep** — Still needed for async task completion events |
| `src/workflows/template.ts` | **Keep** — Template interpolation is fine |
| `src/workflows/llm-provider.ts` | **Refactor** — Becomes part of `raw-llm` executor |
| DB schema | **Migrate** — New migration for schema changes |
| MCP tools | **Update** — Same tools, updated to new engine |
| HTTP API | **Update** — Same endpoints, updated to new engine |
| Tests | **Rewrite** — New tests for new engine |

---

## 4. Proposed Architecture

### 4.1 Executor Registry (Class-Based)

The core abstraction: every step is an **executor class** registered by type name. The class-based approach enables:
- Typed configs and outputs via Zod schemas
- Constructor-injected dependencies (DB, event bus, etc.)
- Extensibility through inheritance
- Future: agent-defined custom executors

```typescript
import { z, type ZodType } from "zod";

// ─── Shared Types ───────────────────────────────────────────

/** Reusable retry policy — used by validation, steps, etc. */
const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  strategy: z.enum(["exponential", "static", "linear"]).default("exponential"),
  baseDelayMs: z.number().int().min(0).default(1000),
  maxDelayMs: z.number().int().min(0).default(60000),
});
type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/** Execution metadata passed to every executor */
const ExecutorMetaSchema = z.object({
  runId: z.string().uuid(),
  stepId: z.string().uuid(),
  nodeId: z.string(),
  workflowId: z.string().uuid(),
  dryRun: z.boolean().default(false),
});
type ExecutorMeta = z.infer<typeof ExecutorMetaSchema>;

// ─── Executor Base Class ────────────────────────────────────

abstract class BaseExecutor<
  TConfig extends ZodType = ZodType,
  TOutput extends ZodType = ZodType,
> {
  abstract readonly type: string;
  abstract readonly mode: "instant" | "async";
  abstract readonly configSchema: TConfig;
  abstract readonly outputSchema: TOutput;

  /** Optional retry policy — override per executor type */
  readonly retryPolicy?: RetryPolicy;

  constructor(protected readonly deps: ExecutorDependencies) {}

  /** Validate config, execute, validate output — catches Zod errors at both boundaries */
  async run(input: ExecutorInput): Promise<ExecutorResult<z.infer<TOutput>>> {
    // Validate input config
    const configResult = this.configSchema.safeParse(input.config);
    if (!configResult.success) {
      return { status: "failed", error: `Input validation failed: ${configResult.error.message}` };
    }

    const result = await this.execute(configResult.data, input.context, input.meta);

    // Validate output
    if (result.status === "success" && result.output !== undefined) {
      const outputResult = this.outputSchema.safeParse(result.output);
      if (!outputResult.success) {
        return { status: "failed", error: `Output validation failed: ${outputResult.error.message}` };
      }
    }
    return result;
  }

  /** Implement this in each executor */
  protected abstract execute(
    config: z.infer<TConfig>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<TOutput>>>;
}

interface ExecutorDependencies {
  db: typeof import("../be/db");
  eventBus: WorkflowEventBus;
  interpolate: (template: string, ctx: Record<string, unknown>) => string;
}

interface ExecutorInput {
  config: Record<string, unknown>;
  context: Readonly<Record<string, unknown>>;
  meta: ExecutorMeta;
}

interface ExecutorResult<TOutput = unknown> {
  status: "success" | "failed" | "skipped";
  output?: TOutput;
  nextPort?: string;   // default: "default"
  error?: string;
}

/** Async executors signal the engine to pause */
interface AsyncExecutorResult<TOutput = unknown> extends ExecutorResult<TOutput> {
  async: true;
  waitFor: string;         // e.g., "task.completed"
  correlationId: string;   // e.g., taskId
}

// ─── Registry ───────────────────────────────────────────────

class ExecutorRegistry {
  private executors = new Map<string, BaseExecutor>();

  register(executor: BaseExecutor): void {
    this.executors.set(executor.type, executor);
  }

  get(type: string): BaseExecutor {
    const executor = this.executors.get(type);
    if (!executor) throw new Error(`Unknown executor type: ${type}`);
    return executor;
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }
}
```

**Example: notify executor implementation**

```typescript
class NotifyExecutor extends BaseExecutor<typeof NotifyConfigSchema, typeof NotifyOutputSchema> {
  readonly type = "notify";
  readonly mode = "instant" as const;

  readonly configSchema = z.object({
    channel: z.enum(["swarm", "slack", "email"]),
    target: z.string().optional(),
    template: z.string(),
  });

  readonly outputSchema = z.object({
    sent: z.boolean(),
    messageId: z.string().optional(),
  });

  protected async execute(
    config: z.infer<typeof this.configSchema>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof this.outputSchema>>> {
    const message = this.deps.interpolate(config.template, context);

    if (meta.dryRun) {
      return { status: "success", output: { sent: false } };
    }

    switch (config.channel) {
      case "swarm":
        const msgId = this.deps.db.postMessage(config.target ?? "general", message);
        return { status: "success", output: { sent: true, messageId: msgId } };
      case "slack":
        // ... slack posting logic
      case "email":
        // ... email sending logic
    }
  }
}

// Registration
registry.register(new NotifyExecutor(deps));
```

### 4.2 Initial Executor Set

| Executor | Type | Mode | What it does |
|----------|------|------|-------------|
| **script** | `script` | Instant | Run bash/TS(bun)/Python script. Config: `{runtime, script, args, timeout, cwd?, workerId? (future)}`. Scripts can be scoped to run on a specific worker machine via `workerId` (future — dispatch mechanism TBD). |
| **agent-task** | `agent-task` | **Async** | Create task for worker agent. Config: `{template, agentId?, tags?, priority?}`. Pauses workflow until task completes. |
| **raw-llm** | `raw-llm` | Instant | Direct AI SDK + OpenRouter call. Config: `{prompt, model?, schema?}`. Returns structured output via Zod. |
| **vcs** | `vcs` | Instant | Version control operations. Config: `{action: "create-issue" \| "create-pr" \| "comment", provider: "github" \| "gitlab", repo, ...}`. |
| **property-match** | `property-match` | Instant | JSONPath condition evaluation. Returns `nextPort: "true" \| "false"`. |
| **code-match** | `code-match` | Instant | Sandboxed JS evaluation. Returns `nextPort` based on result. |
| **notify** | `notify` | Instant | Multi-channel notification. Config: `{channel: "swarm" \| "slack" \| "email", target?, template}`. |
| **validate** | `validate` | Instant | Quality gate. Config: `{targetNodeId, prompt?, schema?}`. Returns `{pass, reasoning, confidence}`. |

### 4.3 Validation System

Validation is an executor with a special relationship to the engine.

```typescript
const ValidationResultSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});
type ValidationResult = z.infer<typeof ValidationResultSchema>;

const StepValidationConfigSchema = z.object({
  /** Executor type for validation (default: "validate") */
  executor: z.string().default("validate"),
  /** Config passed to the validation executor */
  config: z.record(z.unknown()),
  /** If true, a failed validation halts the workflow */
  mustPass: z.boolean().default(false),
  /** Retry policy on validation failure */
  retry: RetryPolicySchema.optional(),
});
type StepValidationConfig = z.infer<typeof StepValidationConfigSchema>;
```

Per-step: any node can have a `validation` field. After the step executes, the engine runs the validation executor. If `retry` is set, re-runs the step with `{previousOutput, validationResult}` injected into context, following the retry policy (exponential, static, or linear backoff).

### 4.4 Checkpoint-Based Durability

After each step completes:
1. Write step result to `workflow_run_steps`
2. Write accumulated context to `workflow_runs.context`
3. Both in a single SQLite transaction (atomic checkpoint)

Key features:
- **Step-level retry** — Each executor can declare a `RetryPolicy`. The engine handles retry scheduling.
- **Idempotency keys** — Steps get a deterministic key `${runId}:${nodeId}` to prevent double execution.
- **Context snapshots** — Context written atomically with step completion.
- **Recovery on startup** — Scan for `status: 'running'` runs, find last completed step, resume from successors.
- **All JSON parsed via Zod** — No raw `JSON.parse`. Every DB read validates through schemas.

```typescript
// Recovery — Zod-validated, type-safe
async function recoverIncompleteRuns(): Promise<void> {
  const incompleteRuns = db.getWorkflowRunsByStatus(["running", "waiting"]);

  for (const run of incompleteRuns) {
    const completedStepNodeIds = db.getCompletedStepNodeIds(run.id);
    const context = WorkflowContextSchema.parse(JSON.parse(run.context));
    const def = WorkflowDefinitionSchema.parse(JSON.parse(run.workflow.definition));

    const readyNodes = findReadyNodes(def, completedStepNodeIds);

    if (readyNodes.length > 0) {
      await walkGraph(def, run.id, context, readyNodes);
    }
  }
}
```

**Retry with backoff** — Applied per-step when execution fails:

```typescript
function calculateDelay(policy: RetryPolicy, attempt: number): number {
  switch (policy.strategy) {
    case "exponential": {
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      return Math.floor(Math.random() * delay); // full jitter
    }
    case "linear":
      return Math.min(policy.baseDelayMs * attempt, policy.maxDelayMs);
    case "static":
      return policy.baseDelayMs;
  }
}
```

A retry poller runs on `setInterval` (e.g., every 5s), picks up failed steps past their `nextRetryAt`, and re-executes them. This same poller mechanism doubles as the executor for durable timer nodes (future).

### 4.5 Workflow Definition Schema

**Decision: Nodes with `next` references (Option B)**. Edges are auto-generated for UI rendering.

Nodes are the canonical structure. When `next` is absent → the workflow terminates at that node. No special "input" or "output" node types — any node can be an entry point (no incoming references) or a terminal (no `next`).

```typescript
const WorkflowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),                      // executor type name
  label: z.string().optional(),
  config: z.record(z.unknown()),
  /** Next node(s) — string for single, object for port-based branching */
  next: z.union([
    z.string(),                           // single next: "nodeId"
    z.record(z.string(), z.string()),     // port-based: { "true": "n3", "false": "n4" }
  ]).optional(),
  /** Per-step validation config */
  validation: StepValidationConfigSchema.optional(),
  /** Per-step retry policy (overrides executor default) */
  retry: RetryPolicySchema.optional(),
});
type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).min(1),
});
type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** Auto-generate edges from `next` references — for UI graph rendering */
function generateEdges(def: WorkflowDefinition): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  for (const node of def.nodes) {
    if (!node.next) continue;
    if (typeof node.next === "string") {
      edges.push({ id: `${node.id}→${node.next}`, source: node.id, target: node.next, sourcePort: "default" });
    } else {
      for (const [port, targetId] of Object.entries(node.next)) {
        edges.push({ id: `${node.id}→${targetId}:${port}`, source: node.id, target: targetId, sourcePort: port });
      }
    }
  }
  return edges;
}
```

**Consistency validation** — Before a workflow can run, validate:
1. All `next` references point to existing node IDs
2. Exactly **one entry node** (a node with no incoming `next` references). Multiple triggers can invoke the same workflow, but execution always starts at the single entry node. The trigger payload is injected into `context.trigger` before the entry node runs.
3. No orphaned nodes (every non-entry node must be reachable from the entry node)
4. Cycles are explicitly allowed — the graph is a **directed graph** (not strictly a DAG). The engine must enforce a `maxIterations` guard per node (default: 100) to prevent infinite loops. When a node exceeds `maxIterations`, the run fails with `error: "max iterations exceeded on node <id>"`

**Example: linear workflow**
```json
{
  "nodes": [
    { "id": "extract", "type": "script", "config": { "runtime": "bash", "script": "scripts/extract.sh" }, "next": "check" },
    { "id": "check", "type": "property-match", "config": { "property": "{{extract.exitCode}}", "operator": "eq", "value": 0 }, "next": { "true": "process", "false": "notify-fail" } },
    { "id": "process", "type": "agent-task", "config": { "template": "Process: {{extract.output}}" } },
    { "id": "notify-fail", "type": "notify", "config": { "channel": "slack", "template": "Extract failed: {{extract.error}}" } }
  ]
}
```

> **Convention**: Nodes without a `next` field are **terminal nodes** — execution ends when they complete. In this example, both `process` and `notify-fail` are terminal nodes (the workflow ends at whichever branch is taken).

### 4.6 Trigger System

Workflows have a `triggers` array in their definition. Each trigger is typed.

> **Note**: All workflows can always be triggered manually (via `POST /api/workflows/:id/trigger` from the UI or an agent using the `trigger-workflow` MCP tool). The `triggers` array only declares **additional** trigger mechanisms beyond manual. If `triggers` is empty or absent, the workflow is manual-only.

```typescript
const TriggerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("webhook"),
    hmacSecret: z.string().optional(),      // HMAC-SHA256 signature verification
    hmacHeader: z.string().default("X-Hub-Signature-256"),
  }),
  z.object({
    type: z.literal("schedule"),
    scheduleId: z.string().uuid(),          // Reference to scheduled_tasks row
  }),
]);
type TriggerConfig = z.infer<typeof TriggerConfigSchema>;
```

**Manual trigger** (always available): `POST /api/workflows/:id/trigger` — requires API auth (Bearer token). Callable from the dashboard UI or by agents via the `trigger-workflow` MCP tool. Payload passed as `context.trigger`.

**Webhook trigger**: `POST /api/webhooks/:workflowId` — optionally verified via HMAC-SHA256 signature. The workflow's `hmacSecret` is used to verify the `X-Hub-Signature-256` header (or custom header).

**Schedule trigger**: The workflow references a `scheduleId` from the existing `scheduled_tasks` table. The schedule's SOT is in `scheduled_tasks` — the workflow just links to it. Creating/removing a schedule atomically updates both the `scheduled_tasks` row and the workflow's `triggers` array.

Event-based triggers (task.created, github.*, slack.*) deferred to a later phase.

### 4.7 Version History

Simple JSON snapshot table:

```sql
CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflowId TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,      -- JSON: WorkflowSnapshot (see below)
  changedByAgentId TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  UNIQUE(workflowId, version)
);
```

**Snapshot contents** — the `snapshot` column stores the full workflow record as it existed before the update:

```typescript
const WorkflowSnapshotSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  definition: WorkflowDefinitionSchema,   // { nodes: [...] }
  triggers: z.array(TriggerConfigSchema),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(InputValueSchema).optional(),
  enabled: z.boolean(),
});
```

On every `UPDATE` to a workflow, insert a version record with the **previous** state. The current state is always in the `workflows` table.

### 4.8 Execution Model (Event-Loop Style)

The workflow executor runs **in-process in the API server**. It follows an event-loop approach:

```
┌─────────────────────────────────────────────────────────────┐
│                 WORKFLOW EXECUTOR (in API process)            │
│                                                              │
│  State: IDLE                                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Event arrives (trigger, task completion, retry timer) │ │
│  └──────────────┬─────────────────────────────────────────┘ │
│                 ▼                                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Find ready steps (predecessors all completed)         │ │
│  │  For each ready step:                                  │ │
│  │                                                        │ │
│  │  ┌─ Instant (script, llm, condition, notify, vcs) ──┐ │ │
│  │  │  Execute in-process                                │ │ │
│  │  │  Checkpoint result to DB (atomic transaction)      │ │ │
│  │  │  Add output to context                             │ │ │
│  │  │  Find next ready steps → continue loop             │ │ │
│  │  └────────────────────────────────────────────────────┘ │ │
│  │                                                        │ │
│  │  ┌─ Async (agent-task) ───────────────────────────────┐ │ │
│  │  │  Create task, store correlation ID                  │ │ │
│  │  │  Mark step as "waiting", checkpoint to DB          │ │ │
│  │  │  → Return to IDLE (don't block)                    │ │ │
│  │  │  → When task completes, event bus fires            │ │ │
│  │  │  → Executor wakes up, resumes from next step       │ │ │
│  │  └────────────────────────────────────────────────────┘ │ │
│  │                                                        │ │
│  │  When no more ready steps → workflow complete          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Retry Poller (setInterval ~5s)                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Query: steps WHERE status='failed' AND nextRetryAt≤now│ │
│  │  Re-execute each via the same loop                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Startup Recovery                                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Find runs with status='running' but no active steps  │ │
│  │  Resume from last checkpoint                          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

> **Event-based execution**: Yes — the executor loop is purely event-driven. It only moves forward when an event arrives (trigger invocation, task completion callback, or retry poller tick). Between events, the executor is idle and holds no resources.

> **Execution timeout**: Each instant executor should declare a `timeoutMs` in its config (e.g., script executor defaults to 30s, raw-llm to 60s). The engine wraps `execute()` in a `Promise.race` with a timeout. If the timeout fires, the step is marked `failed` with `error: “timeout”` and follows the retry policy. For async executors (agent-task), the timeout is handled by the task system itself (task-level TTL), not the workflow engine.

**Key principle**: The executor is **never blocked**. Instant steps execute and immediately checkpoint. Async steps mark as waiting and return control. The event bus / retry poller re-enters the loop when work becomes available.

**Parallel step execution**: When the graph has nodes whose predecessors are all completed, they can execute concurrently via `Promise.all()`. This is a natural consequence of the "find ready steps" approach.

**Where things run**:
- The executor loop itself runs in the API server process
- Instant steps (script, LLM, conditions) run in-process or as subprocesses
- Async steps (agent-task) create tasks that run on worker machines
- Scripts with a `workerId` config are dispatched to that specific worker (future: via task with script payload)

### 4.9 Input Resolution

Workflow-level `input` supports variable resolution:

```typescript
const EnvVarSchema = z.string().regex(/^\$\{.+\}$/);         // env var: ${MY_VAR}
const SecretRefSchema = z.string().regex(/^secret\..+$/);     // swarm secret: secret.OPENAI_KEY
const LiteralSchema = z.string();                             // literal value

const InputValueSchema = z.union([EnvVarSchema, SecretRefSchema, LiteralSchema]);
```

Resolution at workflow start:
- `${ENV_VAR}` → `process.env.ENV_VAR`
- `secret.NAME` → fetched from swarm secrets store
- Literal strings → passed through

### 4.10 Workflow Templates

Templates are workflow definitions designed for reuse:

```typescript
const WorkflowTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  category: z.string(),                     // e.g., "content", "qa", "devops"
  /** Template variables — must be provided when instantiating */
  variables: z.array(z.object({
    name: z.string(),
    description: z.string(),
    type: z.enum(["string", "number", "boolean"]),
    default: z.unknown().optional(),
    required: z.boolean().default(true),
  })),
  /** The workflow definition with {{variable}} placeholders */
  definition: WorkflowDefinitionSchema,
});
```

**Examples**:
- "Daily Blog Generator" template — variables: `{repo, branch, topic_source}`
- "Weekly QA Bug Bash" template — variables: `{test_suite, notify_channel}`
- "PR Review Pipeline" template — variables: `{repo, reviewers, auto_merge}`

Templates can be stored alongside regular workflows or in the existing templates registry.

### 4.11 Cooldown System

Simple pre-execution check:

```typescript
const CooldownConfigSchema = z.object({
  hours: z.number().min(0),
});

/** Check before starting a workflow */
async function shouldSkipCooldown(workflowId: string, cooldown: CooldownConfig): Promise<boolean> {
  const lastSuccess = db.getLastSuccessfulRun(workflowId);
  if (!lastSuccess) return false;
  const hoursSince = (Date.now() - new Date(lastSuccess.finishedAt).getTime()) / 3600000;
  return hoursSince < cooldown.hours;
}
```

Defined at workflow level: `cooldown: { hours: 24 }`. Checked before execution starts. If within cooldown, the run is skipped with `status: "skipped"`, `error: "cooldown"`.

---

## 5. Comparison: Content-Agent vs Proposed Design

| Aspect | Content-Agent | Proposed Agent-Swarm |
|--------|--------------|---------------------|
| Format | YAML files | JSON in DB + version history |
| Execution | Linear sequential | Directed graph (event-loop BFS walk, supports loops + branches) |
| Executors | 4 (prompt, bash, git_pr, imgflip) | 8 initial (script, agent-task, raw-llm, vcs, property-match, code-match, notify, validate) |
| Registry | Hardcoded if/elif | Class-based `ExecutorRegistry` with typed config/output (Zod) |
| Context | `steps.<name>.output` | `ctx[nodeId]` |
| Async | None — runs to completion | Async executors pause/resume via event bus |
| Validation | Litmus test config block + retry | Validation executor with reusable `RetryPolicy` type |
| Durability | None (re-run from start) | Checkpoint-based (resume from last completed step) |
| Scheduling | Inline YAML, APScheduler | `triggers[]` with `scheduleId` ref to `scheduled_tasks` |
| Cooldowns | Built-in per-workflow | Pre-execution check, workflow-level config |
| Triggers | Cron + CLI + programmatic | Manual always available (UI/agent) + webhook (HMAC) + schedule |
| Templates | YAML files = implicit templates | First-class template system with variables |
| Input resolution | `${ENV_VAR}`, `data/file.json` | `${ENV_VAR}`, `secret.NAME` |
| Typing | Python, untyped | Full Zod schemas for config, output, context |

---

## 6. Resolved Questions

| # | Question | Resolution |
|---|----------|-----------|
| 6.1 | Schema format | **Nodes with `next`**, edges auto-generated for UI. Support loops + branches. No special input/output nodes. |
| 6.2 | Cooldowns | **Yes** — part of initial execution logic, pre-execution check. |
| 6.3 | Input resolution | **Yes** — `${ENV_VAR}` and `secret.NAME` supported. |
| 6.4 | Retry policy | **Reusable `RetryPolicy` type** with strategy: exponential/static/linear. Used by validation and step-level retry. |
| 6.5 | Parallel execution | **Yes** — natural consequence of "find ready steps" in directed graph. Nodes with all predecessors completed run via `Promise.all()`. |
| 6.6 | Global final validation | **Deferred** — not in initial scope. |
| 6.7 | Existing workflow migration | **Not needed** — nobody uses current workflows. Clean slate. |

---

## 7. Key Files to Change

```
src/workflows/
  engine.ts           → Full rewrite (executor registry + checkpoint + event-loop)
  nodes/              → Delete, replaced by executors/
  resume.ts           → Refactor for new engine
  recovery.ts         → Replace with checkpoint-based recovery
  triggers.ts         → Simplify to webhook + schedule + manual
  event-bus.ts        → Keep
  template.ts         → Keep, add secret.NAME support
  llm-provider.ts     → Move into raw-llm executor
  index.ts            → Update initialization

src/be/
  migrations/
    NNN_workflow_redesign.sql  → Schema changes (version history, retry columns, triggers)
  db.ts               → Update workflow query functions

src/tools/workflows/  → Update MCP tools for new types
src/http/workflows.ts → Update HTTP handlers, HMAC verification
src/types.ts          → Update workflow type definitions (Zod schemas)

NEW files:
  src/workflows/executors/       → Executor implementations
    base.ts                      → BaseExecutor class
    registry.ts                  → ExecutorRegistry
    script.ts                    → Script executor (bash/ts/python)
    agent-task.ts                → Async task creation executor
    raw-llm.ts                   → Direct LLM call executor
    vcs.ts                       → Version control executor (GitHub/GitLab)
    notify.ts                    → Multi-channel notification executor
    validate.ts                  → Validation executor
  src/workflows/checkpoint.ts    → Checkpoint persistence logic
  src/workflows/version.ts       → Version history logic
  src/workflows/retry-poller.ts  → Retry poller (setInterval)
  src/workflows/validation.ts    → Validation engine (wraps validate executor)
  src/workflows/templates.ts     → Template instantiation logic
```

---

## 8. Temporal-Like Patterns — Research Findings

Background research investigated Temporal, Inngest, Restate, DBOS, Hatchet, @hazeljs/flow, and a SQLite-based proof-of-concept. Key findings:

### 8.1 We Don't Need Full Temporal

Our workflows are **declarative directed graphs**, not arbitrary code. The graph structure itself is the replay mechanism — we don't need deterministic replay. What we need is **step result memoization** (skip completed steps on resume).

### 8.2 Minimum Viable Durable Execution

The existing `walkGraph` (currently named `walkDag` — to be renamed) + `workflow_run_steps` is **80% there**. Four concrete additions:

1. **Context checkpoint after every step** (currently only done on `waiting` — also do it on each `completed`)
2. **Retry columns** on `workflow_run_steps`: `retryCount`, `maxRetries`, `nextRetryAt` + a poller
3. **Step memoization** in `walkGraph`: before executing, check if step already completed → skip and inject stored output
4. **Startup recovery**: extend to handle "process crashed mid-walk" (runs in `running` status with no active steps)

### 8.3 DB Schema Additions

```sql
ALTER TABLE workflow_run_steps ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run_steps ADD COLUMN maxRetries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE workflow_run_steps ADD COLUMN nextRetryAt TEXT;  -- ISO timestamp
ALTER TABLE workflow_run_steps ADD COLUMN idempotencyKey TEXT;  -- runId:nodeId

CREATE INDEX IF NOT EXISTS idx_wrs_retry
  ON workflow_run_steps(status, nextRetryAt)
  WHERE status = 'failed' AND nextRetryAt IS NOT NULL;
```

### 8.4 Signals, Timers, Child Workflows

- **Signals**: Already implemented via `status: 'waiting'` + event bus resume. No changes needed.
- **Timers**: A future `timer` node type that writes `nextRetryAt` and returns `mode: "async"`. The retry poller doubles as the timer executor.
- **Child workflows**: A node type that calls `startWorkflowExecution()` for another workflow and returns `mode: "async"`. Store `parentRunId`/`parentStepId` for the callback.

### 8.5 What We Explicitly Skip

- **Full deterministic replay** — graphs are declarative, structure = replay
- **Event sourcing** — step log is sufficient
- **Separate worker processes** — single-process SQLite
- **Distributed locking** — SQLite WAL mode, no contention
- **External dependencies** — no Temporal, Inngest, or other infra. Pure bun:sqlite.

### 8.6 Idempotency Gap

If a `create-task` step succeeds but the process crashes before recording the step as `completed`, retrying will create a duplicate task.

**Mitigation**: The engine enforces idempotency at the executor level. Before executing any step, the engine checks for an existing completed step with the same idempotency key (`${runId}:${nodeId}`). If found, it skips execution and injects the stored output into context. For async executors specifically, the executor itself must also check — e.g., the `agent-task` executor queries for an existing task with the matching idempotency key before creating a new one. This is a **mandatory contract** for all async executor implementations.

---

## 9. Next Steps

1. ~~Finalize schema format~~ → **Decided: nodes with `next`, edges auto-generated**
2. ~~Finalize open questions~~ → **All resolved (§6)**
3. **Write implementation plan** — phase by phase with verification at each step
4. **Implement** — rip-and-replace on this branch

---

## Review Errata

_Reviewed: 2026-03-18 by Claude (automated review + codebase verification)_
_File review: 2026-03-18 by Taras (14 inline comments processed)_

### Pending

- [ ] **Code References table** — Add a structured table of key `file:line` references for the implementer. To be added during plan creation.

### Resolved

- [x] **DAG → directed graph terminology** — Standardized to "directed graph" throughout. Renamed `walkDag` → `walkGraph`. Added `maxIterations` guard (default: 100) to §4.5.
- [x] **Missing Research Question/Summary** — Dismissed by Taras: motivation section is sufficient.
- [x] **Unhandled ZodError in `BaseExecutor.run()`** — Updated pseudocode to use `safeParse()` for both input config and output validation.
- [x] **Single entry node constraint** — Added to §4.5: exactly one entry node, trigger payload in `context.trigger`.
- [x] **script executor `workerId`** — Marked as "(future)" in config and description.
- [x] **InputValueSchema invalid Zod** — Fixed to use `z.string().regex()`.
- [x] **Idempotency gap** — Resolved in §8.6 with engine-level memoization + mandatory async executor idempotency key check.
- [x] **Webhook HMAC upgrade** — Dismissed: nobody uses current workflows, clean slate.
- [x] **Manual trigger redundancy** — Removed from `TriggerConfigSchema`. All workflows always manually triggerable (UI or agent MCP tool).
- [x] **Executor implementation example** — Added notify executor example after §4.1.
- [x] **"No next = end" clarification** — Added convention note after linear workflow example.
- [x] **Snapshot type** — Added `WorkflowSnapshotSchema` type definition to §4.7.
- [x] **Execution timeout** — Added to §4.8: `Promise.race` for instant executors, task-level TTL for async.
- [x] **Event-based executor loop** — Confirmed in §4.8: purely event-driven, idle between events.
- [x] Frontmatter field `author` → `researcher` — auto-fixed
- [x] Test count corrected to ~2,500 lines across 9 test files — auto-fixed
- [x] All prior art, tables, files, tools verified against codebase
- [x] Context checkpoint gap claim (§8.2) verified accurate
