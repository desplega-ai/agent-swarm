---
date: 2026-03-18T16:00:00Z
topic: "Workflow Engine Redesign"
status: completed
planner: taras+claude
research: thoughts/taras/research/2026-03-18-workflow-redesign.md
---

# Workflow Engine Redesign — Implementation Plan

## Overview

Redesign the workflow engine to replace the current BFS DAG walker with an event-loop style executor, class-based executor registry, checkpoint-based durability, and simplified trigger model. This is a rip-and-replace: nobody uses current workflows, so we take a clean break.

**Research**: `thoughts/taras/research/2026-03-18-workflow-redesign.md`
**Branch**: `feat/workflow-redesign`

## Current State Analysis

The workflow engine is a BFS DAG walker (`src/workflows/engine.ts:50-122`) that dispatches node execution via a switch statement (`engine.ts:124-167`). Six node executor functions live in `src/workflows/nodes/`, and 7 trigger node types are embedded directly in the graph as entry nodes.

### Key Discoveries:
- `walkDag()` uses a visited-set cycle guard — no retry, no checkpoint, no memoization (`engine.ts:56-121`)
- Context only persists on async pause (`resume.ts:59-60`), not after each step — crash = data loss
- `WorkflowDefinitionSchema` uses `{ nodes: [], edges: [] }` format (`types.ts:585-588`) — will change to nodes-only with `next` references
- Triggers are graph nodes (13 node types in `WorkflowNodeTypeSchema` at `types.ts:552-566`) — will be extracted to a separate `triggers` array
- Recovery is stuck-run detection via SQL join (`db.ts:6072-6088`) — will be replaced by checkpoint-based resume
- Schedules (`scheduled_tasks` table) are fully independent — no FK to workflows. Integration via `triggers[].scheduleId` is new.
- DB has 3 tables: `workflows`, `workflow_runs`, `workflow_run_steps` (migration `003_workflows.sql`)
- 9 MCP tools in `src/tools/workflows/`, 9 HTTP endpoints in `src/http/workflows.ts`
- 9 test files (~2,500 lines) — all will be rewritten
- UI: 3 pages + API hooks in `new-ui/`

## Desired End State

A workflow engine with:
1. **Executor registry** — Class-based executors with Zod-typed config/output, registered by type name
2. **Checkpoint durability** — Atomic DB write (step result + context) after every step; resume from last checkpoint on crash
3. **Event-loop execution** — Idle until event (trigger, task completion, retry tick); never blocked
4. **Simplified triggers** — Webhook (HMAC) + schedule (scheduleId ref) + manual (always available). No event-based triggers.
5. **Nodes-with-next schema** — No explicit edges; `next` field on nodes (string or port map); edges auto-generated for UI
6. **Per-step retry** — RetryPolicy with exponential/static/linear backoff, poller-based execution
7. **Per-step validation** — Validation executor runs after step, retry on failure
8. **Version history** — Snapshot table records previous state on every update
9. **Workflow templates** — First-class templates with variables, instantiable into workflows
10. **Cooldown** — Pre-execution check, workflow-level config

### Verification of end state:
```bash
bun run tsc:check                    # Types compile
bun run lint:fix                     # Biome passes
bun test src/tests/workflow-*.test.ts  # All workflow tests pass
# Manual: trigger a workflow via curl, see it execute through engine
```

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test src/tests/workflow-*.test.ts` — Run all workflow tests
- `bun test src/tests/<specific>.test.ts` — Run one test file

Key files (post-redesign):
- `src/types.ts` — Workflow Zod schemas
- `src/workflows/engine.ts` — Core engine
- `src/workflows/executors/` — All executor classes
- `src/be/migrations/008_workflow_redesign.sql` — Schema migration
- `src/be/db.ts` — Workflow DB functions
- `src/tools/workflows/` — MCP tools
- `src/http/workflows.ts` — HTTP endpoints

## What We're NOT Doing

1. **Event-based triggers** — Deferred. No `task.created`, `github.*`, `slack.*` trigger types. Only webhook + schedule + manual.
2. **Global final validation** — Deferred. Only per-step validation.
3. **Agent-defined custom executors** — Future. The registry pattern enables this but it's out of scope.
4. **Timer node type** — Future. The retry poller infrastructure supports it but we don't build the node.
5. **Child workflows** — Future. No `parentRunId`/`parentStepId` mechanism yet.
6. **Distributed workers for scripts** — The `workerId` field on script executor is marked "(future)".
7. **Full deterministic replay** — Graph structure is the replay. Step memoization is sufficient.
8. **UI redesign** — Only update types/contracts. No new UI features.
9. **Migration of existing workflows** — Nobody uses them. Clean slate.

## Implementation Approach

**Rip and replace**: Delete old engine/nodes/triggers, build new from scratch on this branch. The old code is reference material, not a constraint.

**Bottom-up**: Types → DB → Executors → Engine → Features → API → Tests → Cleanup. Each phase is independently compilable and testable.

**Tests alongside**: Each phase includes its own test file(s) to verify the phase in isolation before moving on.

---

## Phase 1: Foundation — Types, DB Migration, BaseExecutor, Registry

### Overview
Establish all type definitions, the new DB schema, and the executor framework (base class + registry). This is the foundation everything else builds on.

### Changes Required:

#### 1. Zod Schemas
**File**: `src/types.ts` (replace lines 550-642)
**Changes**:
- Replace `WorkflowNodeTypeSchema` (13 trigger+node types) with new executor types: `script`, `agent-task`, `raw-llm`, `vcs`, `property-match`, `code-match`, `notify`, `validate`
- Replace `WorkflowNodeSchema` — add `next` field (string | Record<string, string> | undefined), add `validation` and `retry` optional fields, remove `type` from fixed enum (use `z.string()` for extensibility)
- Remove `WorkflowEdgeSchema` from the definition (keep as a derived type for UI rendering)
- Replace `WorkflowDefinitionSchema` — `{ nodes: WorkflowNode[] }` (no edges)
- Add `RetryPolicySchema`, `ExecutorMetaSchema`, `ValidationResultSchema`, `StepValidationConfigSchema`
- Add `TriggerConfigSchema` (discriminated union: webhook, schedule)
- Add `CooldownConfigSchema` — shape: `{ hours?: number, minutes?: number, seconds?: number }` (at least one required; resolved to total milliseconds at runtime)
- Add `InputValueSchema` (env var, secret ref, literal)
- Add `WorkflowTemplateSchema`
- Add `WorkflowSnapshotSchema`
- Update `WorkflowSchema` — add `triggers`, `cooldown`, `input` fields
- Add `WorkflowVersionSchema`
- Keep `WorkflowRunSchema`, `WorkflowRunStepSchema` — add retry columns (`retryCount`, `maxRetries`, `nextRetryAt`, `idempotencyKey`)

#### 2. Database Migration
**File**: `src/be/migrations/008_workflow_redesign.sql` (new)
**Changes**:
- Set `PRAGMA foreign_keys=OFF` at start of migration, then NULL-out `workflowRunId`/`workflowRunStepId` on `agent_tasks`, then drop `workflow_run_steps`, `workflow_runs`, `workflows` tables (SQLite has no CASCADE on DROP TABLE), re-enable `PRAGMA foreign_keys=ON` after recreation
- Recreate `workflows` table with new columns: `triggers TEXT` (JSON), `cooldown TEXT` (JSON), `input TEXT` (JSON). Remove `webhookSecret`. Keep `id`, `name`, `description`, `enabled`, `definition`, `createdByAgentId`, `createdAt`, `lastUpdatedAt`.
- Recreate `workflow_runs` with same columns as before plus `"skipped"` in status CHECK
- Recreate `workflow_run_steps` with new columns: `retryCount INTEGER NOT NULL DEFAULT 0`, `maxRetries INTEGER NOT NULL DEFAULT 3`, `nextRetryAt TEXT`, `idempotencyKey TEXT`
- Create `workflow_versions` table: `id`, `workflowId` (FK), `version INTEGER`, `snapshot TEXT` (JSON), `changedByAgentId`, `createdAt`. UNIQUE on (workflowId, version).
- Recreate indexes: `idx_workflow_runs_workflowId`, `idx_workflow_runs_status`, `idx_workflow_run_steps_runId`, `idx_wrs_retry` (on status+nextRetryAt WHERE status='failed'), `idx_wrs_idempotency` (on idempotencyKey)
- Re-add `workflowRunId` and `workflowRunStepId` FK columns on `agent_tasks` (they survive the drop since they're on a different table, but indexes may need recreation)

#### 3. DB Query Functions
**File**: `src/be/db.ts` (update workflow section, currently lines 5712-6089)
**Changes**:
- Update `rowToWorkflow()` to parse new columns (triggers, cooldown, input)
- Update `createWorkflow()` to accept new fields
- Update `updateWorkflow()` to accept new fields
- Add `getLastSuccessfulRun(workflowId)` for cooldown check
- Add retry-related step queries: `getRetryableSteps()` (failed steps past nextRetryAt), `getCompletedStepNodeIds(runId)`
- Add `getStepByIdempotencyKey(key)` for memoization
- Update `updateWorkflowRunStep()` to handle retry fields
- Add version history functions: `createWorkflowVersion()`, `getWorkflowVersions(workflowId)`, `getWorkflowVersion(workflowId, version)`

#### 4. BaseExecutor + Registry
**File**: `src/workflows/executors/base.ts` (new)
**Changes**:
- `BaseExecutor<TConfig, TOutput>` abstract class with `type`, `mode`, `configSchema`, `outputSchema`, `retryPolicy?`
- `run(input)` method: validates config via safeParse, calls `execute()`, validates output via safeParse
- `execute()` abstract method (implemented by each executor)
- `ExecutorDependencies` interface (db, eventBus, interpolate)
- `ExecutorInput`, `ExecutorResult`, `AsyncExecutorResult` interfaces

**File**: `src/workflows/executors/registry.ts` (new)
**Changes**:
- `ExecutorRegistry` class with `register()`, `get()`, `has()`, `types()` methods
- Factory function `createExecutorRegistry(deps)` that instantiates and registers all executors

**File**: `src/workflows/executors/index.ts` (new)
**Changes**:
- Re-export base, registry, and all executor classes

#### 5. Edge Generation Utility
**File**: `src/workflows/definition.ts` (new)
**Changes**:
- `generateEdges(def: WorkflowDefinition): WorkflowEdge[]` — derives edges from `next` refs for UI rendering
- `validateDefinition(def: WorkflowDefinition): { valid: boolean, errors: string[] }` — checks: all `next` refs point to existing nodes, exactly one entry node, no orphaned nodes, all node types registered in executor registry
- `findEntryNodes(def)` — nodes with no incoming `next` references
- `getSuccessors(def, nodeId, port)` — resolve `next` field for a given port

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Migration applies on fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` (starts and creates tables)
- [x] Registry test passes: `bun test src/tests/workflow-registry.test.ts`

#### Manual Verification:
- [x] Inspect `workflow_versions` table exists in SQLite: `sqlite3 agent-swarm-db.sqlite ".schema workflow_versions"`
- [x] Inspect `workflow_run_steps` has retry columns: `sqlite3 agent-swarm-db.sqlite ".schema workflow_run_steps"`
- [x] Confirm `validateDefinition()` catches: missing next target, multiple entry nodes, orphaned nodes

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 2: Instant Executors

### Overview
Implement all 7 instant executor classes. Each gets a Zod config schema, output schema, and `execute()` method. Port existing logic from `src/workflows/nodes/` where applicable.

### Changes Required:

#### 1. Property Match Executor
**File**: `src/workflows/executors/property-match.ts` (new)
**Changes**:
- Port logic from `src/workflows/nodes/property-match.ts`
- Class `PropertyMatchExecutor extends BaseExecutor`
- Config: `{ conditions: [{ field, op, value }], mode?: "all"|"any" }` — drop flat format support (clean break)
- Output: `{ passed: boolean, results: ConditionResult[] }`
- Returns `nextPort: "true" | "false"`

#### 2. Code Match Executor
**File**: `src/workflows/executors/code-match.ts` (new)
**Changes**:
- Port logic from `src/workflows/nodes/code-match.ts`
- Class `CodeMatchExecutor extends BaseExecutor`
- Config: `{ code: string, outputPorts: string[] }`
- Output: `{ port: string, rawResult: unknown }`
- Same sandboxing (shadow dangerous globals via `new Function`)

#### 3. Notify Executor
**File**: `src/workflows/executors/notify.ts` (new)
**Changes**:
- Replaces `src/workflows/nodes/send-message.ts` (broadened to multi-channel)
- Class `NotifyExecutor extends BaseExecutor`
- Config: `{ channel: "swarm" | "slack" | "email", target?: string, template: string }`
- Output: `{ sent: boolean, messageId?: string }`
- Swarm channel: uses `db.postMessage()`. Slack/email: stubs for now (log + return sent: false).

#### 4. Raw LLM Executor
**File**: `src/workflows/executors/raw-llm.ts` (new)
**Changes**:
- Replaces `src/workflows/nodes/llm-classify.ts` + `src/workflows/llm-provider.ts` (more general)
- Class `RawLlmExecutor extends BaseExecutor`
- Config: `{ prompt: string, model?: string, schema?: Record<string, unknown>, fallbackPort?: string }`
- Uses AI SDK with OpenRouter (like current `llm-provider.ts:13-24`) — `generateObject()` when schema provided, `generateText()` otherwise
- Output: the parsed response (structured or text)
- On error: falls back to `fallbackPort` if configured, otherwise fails

#### 5. Script Executor
**File**: `src/workflows/executors/script.ts` (new)
**Changes**:
- New executor (no current equivalent)
- Class `ScriptExecutor extends BaseExecutor`
- Config: `{ runtime: "bash" | "ts" | "python", script: string, args?: string[], timeout?: number, cwd?: string }`
- Executes via `Bun.$` for bash, `bun run` for ts, `python3` for python
- Output: `{ exitCode: number, stdout: string, stderr: string }`
- Timeout via config (default 30s), enforced by Promise.race
- Returns `nextPort: "success" | "failure"` based on exit code
- **Trust boundary**: Script executor has full system access (no sandbox). Only agents with workflow-create permission can define script nodes. This is intentional — scripts are the "escape hatch" for arbitrary automation. If untrusted agents gain write access to workflow definitions, this is a privilege escalation risk.

#### 6. VCS Executor
**File**: `src/workflows/executors/vcs.ts` (new)
**Changes**:
- New executor (no current equivalent)
- Class `VcsExecutor extends BaseExecutor`
- Config: `{ action: "create-issue" | "create-pr" | "comment", provider: "github" | "gitlab", repo: string, ...actionSpecificFields }`
- Delegates to existing GitHub/GitLab utility functions in `src/github/` and equivalent
- Output: `{ url: string, id: string | number }`
- Stub implementation initially — just validate config and return mock output. Real integration in a follow-up.

#### 7. Validate Executor
**File**: `src/workflows/executors/validate.ts` (new)
**Changes**:
- New executor for quality gates
- Class `ValidateExecutor extends BaseExecutor`
- Config: `{ targetNodeId: string, prompt?: string, schema?: Record<string, unknown> }`
- Reads `context[targetNodeId]` output, evaluates against prompt (via LLM) or schema (via Zod)
- Output: `ValidationResult` — `{ pass: boolean, reasoning: string, confidence: number }`
- Returns `nextPort: "pass" | "fail"`

#### 8. Registry Wiring
**File**: `src/workflows/executors/registry.ts` (update)
**Changes**:
- Update `createExecutorRegistry(deps)` to instantiate and register all 7 instant executors

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Executor unit tests pass: `bun test src/tests/workflow-executors.test.ts`

#### Manual Verification:
- [x] Each executor's `configSchema.parse()` rejects invalid config (spot-check 2-3 executors)
- [x] PropertyMatch port routing: "true"/"false" based on condition evaluation
- [x] CodeMatch sandboxing: confirm `process`, `Bun`, `require` are undefined inside sandbox
- [x] Script executor: runs a simple bash script and captures stdout/stderr

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 3: Engine Core — walkGraph, Checkpoint, Validation, Memoization

### Overview
Replace the current BFS DAG walker with the new event-loop style engine. The engine finds ready steps, executes them (instant or async), checkpoints after each, handles validation, and supports memoization for idempotent resume.

### Changes Required:

#### 1. Engine Rewrite
**File**: `src/workflows/engine.ts` (full rewrite)
**Changes**:
- `startWorkflowExecution(workflow, triggerData)` — creates run, resolves input (env vars, secrets), checks cooldown, finds entry node, calls `walkGraph()`
- `walkGraph(def, runId, ctx, startNodes, registry)` — event-loop style:
  1. Find ready nodes (all predecessors completed)
  2. For each ready node (parallel via `Promise.all()`):
     a. Check memoization (idempotency key `${runId}:${nodeId}`) — if completed step exists, skip + inject stored output
     b. Check `maxIterations` guard (env `WORKFLOW_MAX_ITERATIONS`, default 100 per node) — fail if exceeded
     c. Get executor from registry
     d. Wrap `executor.run()` in `Promise.race` with timeout
     e. On success: run validation if configured (see below), checkpoint result
     f. On async: mark step waiting, persist context, return (engine goes idle)
     g. On failure: apply retry policy if configured, else mark step + run failed
  3. After all ready nodes processed, find next batch of ready nodes
  4. When no more ready nodes and no waiting steps → mark run completed
- `findReadyNodes(def, completedNodeIds)` — nodes whose predecessors (all nodes that reference this node via `next`) are all in `completedNodeIds`
- Timeout: `Promise.race([executor.run(input), timeoutPromise(ms)])` — default 30s for instant, configurable per-step

#### 2. Checkpoint Logic
**File**: `src/workflows/checkpoint.ts` (new)
**Changes**:
- `checkpointStep(runId, stepId, nodeId, result, ctx)` — single SQLite transaction:
  1. Update step status to `completed`, store output
  2. Update run context with `ctx[nodeId] = result.output`
  3. Both in one `db.transaction()` call
- `checkpointStepFailure(runId, stepId, error, retryPolicy?)` — marks step failed, calculates `nextRetryAt` if retries remain
- `checkpointStepWaiting(runId, stepId, ctx)` — marks step and run as waiting, persists context

#### 3. Validation Integration
**File**: `src/workflows/validation.ts` (new)
**Changes**:
- `runStepValidation(registry, stepNode, stepOutput, context, meta)` — if `stepNode.validation` is set:
  1. Get the validation executor from registry (default: "validate")
  2. Execute it with `{ targetNodeId: meta.nodeId, ...stepNode.validation.config }` and context containing step output
  3. If validation fails and `retry` is configured → inject `{ previousOutput, validationResult }` into context, return `"retry"`
  4. If validation fails and `mustPass` → return `"halt"`
  5. If validation passes → return `"pass"`

#### 4. Input Resolution
**File**: `src/workflows/input.ts` (new)
**Changes**:
- `resolveInputs(input: Record<string, string>)` — resolves `${ENV_VAR}` → `process.env`, `secret.NAME` → swarm secrets store (db config), literals → pass-through
- Called at workflow start, results merged into initial context

#### 5. Cooldown Check
**File**: `src/workflows/cooldown.ts` (new)
**Changes**:
- `shouldSkipCooldown(workflowId, cooldown)` — queries last successful run, returns true if within cooldown window
- Called in `startWorkflowExecution()` before creating a run

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Engine tests pass: `bun test src/tests/workflow-engine-v2.test.ts`

#### Manual Verification:
- [x] Linear workflow (3 instant nodes) executes to completion, context accumulates across steps
- [x] Branching workflow (property-match → two branches) follows correct port
- [x] Checkpoint: kill process mid-workflow, restart, confirm it resumes from last step (simulate by manually setting run status to 'running' with completed steps)
- [x] Memoization: re-trigger walkGraph on a run with completed steps — confirm they're skipped
- [x] Timeout: script executor with `sleep 60` fails after 30s default timeout

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 4: Async Flow — Agent-Task Executor, Resume, Recovery, Retry Poller

### Overview
Implement the async executor (agent-task), the resume mechanism for task completion events, startup recovery from checkpoints, and the retry poller for failed steps.

### Changes Required:

#### 1. Agent-Task Executor
**File**: `src/workflows/executors/agent-task.ts` (new)
**Changes**:
- Class `AgentTaskExecutor extends BaseExecutor`
- `mode: "async"`
- Config: `{ template: string, agentId?: string, tags?: string[], priority?: number, offerMode?: boolean }` — `offerMode`: when true, task is offered (agents can accept/reject) rather than directly assigned
- Execute:
  1. Check idempotency: query for existing task with key `${runId}:${nodeId}` → if found, return stored result
  2. Interpolate template and tags
  3. Call `createTaskExtended()` with `workflowRunId`, `workflowRunStepId`, `source: "workflow"`, idempotency key
  4. Return `AsyncExecutorResult` with `waitFor: "task.completed"`, `correlationId: taskId`
- Output (on resume): `{ taskId: string, taskOutput: unknown }`

#### 2. Resume Mechanism
**File**: `src/workflows/resume.ts` (refactor)
**Changes**:
- `setupWorkflowResumeListener(eventBus, registry)` — same 3 event listeners (task.completed, task.failed, task.cancelled)
- `resumeFromTaskCompletion(event)`:
  1. Load run (verify status=waiting), step (verify status=waiting), workflow definition
  2. Mark step completed with `{ taskId, taskOutput: event.output }`
  3. Checkpoint: atomic write of step result + updated context
  4. Set run status to running
  5. Find successors via `getSuccessors(def, step.nodeId, "default")`
  6. Call `walkGraph()` to continue
- `markRunFailed(event, reason)` — same as current but uses checkpoint

#### 3. Startup Recovery
**File**: `src/workflows/recovery.ts` (rewrite)
**Changes**:
- `recoverIncompleteRuns(registry)`:
  1. Query runs with status `running` or `waiting`
  2. For `running` runs: find completed steps, compute ready nodes, call `walkGraph()` from ready nodes
  3. For `waiting` runs: check if the linked task has already completed/failed/cancelled (same as current stuck-run detection) → resume or fail accordingly
- Called once on startup from `initWorkflows()`

#### 4. Retry Poller
**File**: `src/workflows/retry-poller.ts` (new)
**Changes**:
- `startRetryPoller(registry, intervalMs = 5000)` — `setTimeout` chain (schedules next tick only after current completes, preventing overlap):
  1. Calls `db.getRetryableSteps()` (failed steps where `nextRetryAt <= now` and `retryCount < maxRetries`)
  2. For each retryable step: load run, load workflow def, increment retryCount, re-execute via engine
  3. Log retry attempts
  4. After completion (or error), schedule next tick via `setTimeout(poll, intervalMs)`
- `stopRetryPoller()` — clears the pending timeout (for clean shutdown)
- `calculateDelay(policy, attempt)` — exponential (with full jitter), linear, or static backoff

#### 5. Registry Wiring
**File**: `src/workflows/executors/registry.ts` (update)
**Changes**:
- Add `AgentTaskExecutor` registration in `createExecutorRegistry()`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Async flow tests pass: `bun test src/tests/workflow-async-v2.test.ts`
- [x] Retry tests pass: `bun test src/tests/workflow-retry-v2.test.ts`

#### Manual Verification:
- [x] Agent-task executor creates a task, workflow pauses at `waiting`
- [x] Manually complete the task via API → workflow resumes and finishes
- [x] Idempotency: restart a waiting run → no duplicate task created
- [x] Recovery: start API, create a running workflow, kill process, restart → run resumes
- [x] Retry: create a step that fails with retry policy → observe poller re-executing after delay

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 5: Triggers, Version History, Templates, Cooldown

### Overview
Implement the simplified trigger system (webhook + schedule + manual), version history snapshots, workflow templates, and cooldown logic.

### Changes Required:

#### 1. Trigger System
**File**: `src/workflows/triggers.ts` (rewrite)
**Changes**:
- Remove all event-based trigger matching (no more `evaluateWorkflowTriggers()`, `matchTriggerNode()`, filter functions)
- Triggers are now stored as a `triggers[]` JSON array on the workflow record
- `handleWebhookTrigger(workflowId, payload, signature, signatureHeader)`:
  1. Load workflow, find webhook trigger in `triggers[]`
  2. If `hmacSecret` is set, verify HMAC-SHA256 signature against the header
  3. Call `startWorkflowExecution(workflow, payload)`
- Schedule triggers: the existing scheduler calls `startWorkflowExecution()` when a linked schedule fires — no special code in triggers.ts, just the `scheduleId` reference

#### 2. HTTP Webhook Endpoint
**File**: `src/http/workflows.ts` (update)
**Changes**:
- Add route `POST /api/webhooks/:workflowId` — calls `handleWebhookTrigger()`
- HMAC verification: read raw body, compute `hmac("sha256", workflow.triggers[webhook].hmacSecret, body)`, compare with signature header

#### 3. Version History
**File**: `src/workflows/version.ts` (new)
**Changes**:
- `snapshotWorkflow(workflowId, changedByAgentId?)`:
  1. Load current workflow state
  2. Get max version number for this workflow
  3. Insert `workflow_versions` row with version+1 and full snapshot (name, description, definition, triggers, cooldown, input, enabled)
- Called in `updateWorkflow()` (db.ts) before applying the update

#### 4. Template System
**File**: `src/workflows/templates.ts` (new)
**Changes**:
- `instantiateTemplate(template, variables)`:
  1. Validate all required template variables are provided
  2. Deep-clone the template definition
  3. Replace `{{variable}}` placeholders in all string fields with provided values
  4. Return a valid `WorkflowDefinition`
- `validateTemplateVariables(template, provided)` — returns list of missing required variables

#### 5. Cooldown Integration
**File**: `src/workflows/engine.ts` (update)
**Changes**:
- In `startWorkflowExecution()`, before creating a run: check `shouldSkipCooldown()` if workflow has `cooldown` configured
- If within cooldown, return early with a skipped run (status: "skipped", error: "cooldown")

#### 6. DB Status Update
**File**: `src/be/migrations/008_workflow_redesign.sql` (already includes `"skipped"` in Phase 1's CHECK constraint — no separate update needed)
**Changes**:
- Verify `"skipped"` is in `workflow_runs.status` CHECK constraint (included when recreating the table in Phase 1)

#### 7. Remove Event-Based Trigger Wiring
**File**: `src/workflows/index.ts` (update)
**Changes**:
- Remove the 16-event trigger subscription loop from `initWorkflows()`
- Keep only: `setupWorkflowResumeListener()`, `startRetryPoller()`, `recoverIncompleteRuns()`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Trigger tests pass: `bun test src/tests/workflow-triggers-v2.test.ts`
- [x] Version history tests pass: `bun test src/tests/workflow-versions.test.ts`

#### Manual Verification:
- [x] Webhook trigger: `curl -X POST http://localhost:3013/api/webhooks/<id> -d '{"test":true}'` → workflow starts
- [x] HMAC verification: same curl with wrong signature → 401
- [x] Manual trigger: `curl -X POST http://localhost:3013/api/workflows/<id>/trigger` → workflow starts
- [x] Version history: update a workflow → query `workflow_versions` table → snapshot exists
- [x] Cooldown: trigger workflow, trigger again within cooldown → second run has status "skipped"
- [x] Template: instantiate a template with variables → valid workflow created

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 6: API Layer — MCP Tools + HTTP Endpoints

### Overview
Update all 9 MCP tools and 9 HTTP endpoints to work with the new schema, types, and engine. Maintain the same tool/endpoint names for API compatibility.

### Changes Required:

#### 1. MCP Tools Update
**Files**: `src/tools/workflows/*.ts` (9 files)
**Changes per tool**:

| Tool | Key Changes |
|------|-------------|
| `create-workflow` | Accept new schema: `definition` (nodes-with-next), `triggers?`, `cooldown?`, `input?`. Validate via `validateDefinition()`. |
| `update-workflow` | Accept new fields. Call `snapshotWorkflow()` before update (version history). Validate definition if changed. |
| `delete-workflow` | No change needed (cascade delete still works). |
| `get-workflow` | Return new fields (triggers, cooldown, input). Auto-generate edges for UI rendering. |
| `list-workflows` | Return new fields. |
| `trigger-workflow` | Use `startWorkflowExecution()` — cooldown check happens inside. |
| `get-workflow-run` | Return retry columns on steps. |
| `list-workflow-runs` | Add optional `status` filter. |
| `retry-workflow-run` | Use new `retryFailedRun()` from resume.ts. |

#### 2. HTTP Endpoints Update
**File**: `src/http/workflows.ts` (update)
**Changes**:
- All existing endpoints: update request/response shapes for new schema
- `POST /api/workflows` — validate definition via `validateDefinition()`, accept triggers/cooldown/input
- `PUT /api/workflows/:id` — call `snapshotWorkflow()` before update
- `POST /api/workflows/:id/trigger` — remove `webhookSecret` check (moved to webhook endpoint)
- `POST /api/webhooks/:workflowId` — new webhook trigger endpoint with HMAC (from Phase 5)
- `GET /api/workflows/:id` — include auto-generated edges in response
- `GET /api/workflow-runs/:id` — include retry columns on steps

#### 3. Input Schema for MCP Tools
**File**: `src/tools/workflows/create-workflow.ts` (update)
**Changes**:
- Update Zod input schema to accept the new definition format
- Add `triggers`, `cooldown`, `input` optional fields

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] HTTP tests pass: `bun test src/tests/workflow-http-v2.test.ts`

#### Manual Verification:
- [x] Create a workflow via MCP tool with new schema → persisted correctly
- [x] Get workflow → response includes triggers, cooldown, edges (auto-generated)
- [x] Trigger workflow → run created, engine executes
- [x] Update workflow → version snapshot created
- [x] List workflow runs with status filter → filtered correctly
- [x] Full CRUD cycle via curl against HTTP API

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Phase 7: Integration, Cleanup, and UI Types

### Overview
Wire everything together in `index.ts`, delete old files, update the dashboard UI types, and run the full test suite.

### Changes Required:

#### 1. Initialization
**File**: `src/workflows/index.ts` (rewrite)
**Changes**:
- `initWorkflows()`:
  1. Create executor registry via `createExecutorRegistry(deps)`
  2. Call `setupWorkflowResumeListener(eventBus, registry)`
  3. Call `recoverIncompleteRuns(registry)`
  4. Call `startRetryPoller(registry)`
- Export: `startWorkflowExecution`, `workflowEventBus`, `interpolate`, `generateEdges`, `validateDefinition`
- **Note**: `interpolate()` is reused from the existing `src/workflows/template.ts` (which handles `{{nodeId.field}}` syntax). This file survives cleanup — do NOT delete it.
- Store registry as module-level singleton for access by engine, resume, recovery, poller

#### 2. Delete Old Files
**Files to delete**:
- `src/workflows/nodes/` — entire directory (6 files: code-match.ts, create-task.ts, delegate-to-agent.ts, llm-classify.ts, property-match.ts, send-message.ts)
- `src/workflows/llm-provider.ts` — replaced by raw-llm executor

#### 3. Delete Old Tests
**Files to delete**:
- `src/tests/workflow-engine.test.ts`
- `src/tests/workflow-engine-errors.test.ts`
- `src/tests/workflow-http.test.ts`
- `src/tests/workflow-triggers.test.ts`
- `src/tests/workflow-nodes-phase6.test.ts`
- `src/tests/workflow-property-match.test.ts`
- `src/tests/workflow-recovery.test.ts`
- `src/tests/workflow-resume-retry.test.ts`
- `src/tests/gitlab-workflow-triggers.test.ts`

#### 4. UI Dashboard Types
**File**: `new-ui/src/api/types.ts` (update)
**Changes**:
- Update `Workflow` type: add `triggers`, `cooldown`, `input` fields
- Update `WorkflowDefinition` type: nodes-with-next format, no explicit edges
- Add `WorkflowEdge` type (for auto-generated edges from API)
- Update `WorkflowRunStep` type: add retry columns
- Add `WorkflowVersion` type

**File**: `new-ui/src/api/client.ts` (update)
**Changes**:
- Update API calls to match new request/response shapes
- Add `getWorkflowVersions()` API call

**File**: `new-ui/src/api/hooks/use-workflows.ts` (update)
**Changes**:
- Update hook return types to match new API types

**Files**: `new-ui/src/pages/workflows/*.tsx`, `new-ui/src/pages/workflow-runs/*.tsx`
**Changes**:
- Update to render new fields (triggers list, retry info on steps)
- Use auto-generated edges for graph visualization
- No new UI features — just type compatibility

#### 5. Heartbeat Integration
**File**: `src/heartbeat/heartbeat.ts` (update)
**Changes**:
- Replace `recoverStuckWorkflowRuns()` call (line 217) with `recoverIncompleteRuns()` — or remove if recovery is now handled at startup only

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles (root): `bun run tsc:check`
- [x] TypeScript compiles (UI): `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes (root): `bun run lint:fix`
- [x] Lint passes (UI): `cd new-ui && pnpm lint`
- [x] All new workflow tests pass: `bun test src/tests/workflow-*.test.ts`
- [x] No old workflow test files remain: `ls src/tests/workflow-{engine,http,triggers,nodes-phase6,property-match,recovery,resume-retry}.test.ts` should fail
- [x] No old node files remain: `ls src/workflows/nodes/` should fail
- [x] Full test suite passes: `bun test`

#### Manual Verification:
- [x] Fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` — starts without errors
- [x] Create workflow via curl → trigger → watch run complete → query run detail with steps
- [ ] UI dashboard: workflows page loads, shows workflow list with new fields
- [ ] UI dashboard: workflow detail page shows definition (nodes-with-next rendered with auto-generated edges)
- [ ] UI dashboard: run detail page shows steps with retry info

**Implementation Note**: After completing this phase, pause for manual confirmation. Commit after verification passes.

---

## Testing Strategy

### Unit Tests (per-phase)

> **GATE RULE**: No phase may advance to the next until its unit tests are written and passing. Unit tests are not optional follow-up work — they are part of the phase's definition of done. If a phase's automated verification fails, the phase is incomplete.

- `workflow-registry.test.ts` — executor registration, type lookup, missing executor
- `workflow-executors.test.ts` — each instant executor in isolation (config validation, execute, output validation)
- `workflow-engine-v2.test.ts` — walkGraph, checkpoint, memoization, parallel execution, timeout, validation
- `workflow-async-v2.test.ts` — agent-task executor, resume from task completion, resume from task failure
- `workflow-retry-v2.test.ts` — retry poller, backoff calculation, retry limit
- `workflow-triggers-v2.test.ts` — webhook HMAC, cooldown skip, manual trigger
- `workflow-versions.test.ts` — version snapshot on update, version listing
- `workflow-http-v2.test.ts` — all HTTP endpoints with new schema

### Test Infrastructure
- Each test file uses isolated SQLite DB (existing pattern)
- Uses `initDb()` / `closeDb()` in beforeAll/afterAll
- Clean up DB files (including -wal, -shm) in afterAll
- No dependency on the full HTTP server — use minimal `node:http` handler where needed

### Manual E2E Verification

> **IMPORTANT**: Claude must run this E2E script during implementation (after Phase 7). This is the most critical verification — it exercises the full stack end-to-end.

The E2E verification is implemented as a runnable script at `scripts/e2e-workflow-redesign.sh`. The script covers 8 edge-case scenarios and auto-asserts outcomes.

#### Edge Case Scenarios

| # | Scenario | Tests | Expected |
|---|----------|-------|----------|
| 1 | **Linear happy path** | script → property-match(true) → notify | Run completes, 3 steps, context flows |
| 2 | **Branch false path** | script(exit 1) → property-match(false) → fail-notify | Follows false port, different terminal node |
| 3 | **Parallel execution** | Entry node → 2 independent notify nodes (via port-based next) | Both branches execute, run completes |
| 4 | **Async pause/resume** | script → agent-task (creates task) | Run pauses at waiting; manually complete task → run resumes and finishes |
| 5 | **Webhook trigger + HMAC** | Workflow with webhook trigger + hmacSecret | Valid HMAC → run starts; invalid HMAC → 401 |
| 6 | **Cooldown skip** | Workflow with `cooldown: { hours: 1 }` | First trigger → runs; second trigger → status "skipped" |
| 7 | **Version history** | Create → update → update | 2 version snapshots in workflow_versions |
| 8 | **Validation failure** | script → validate(mustPass: true, always-fail schema) | Run fails at validation step |

#### E2E Script

```bash
#!/usr/bin/env bash
# scripts/e2e-workflow-redesign.sh
# Run: bash scripts/e2e-workflow-redesign.sh
# Requires: API server NOT running on port 3013 (script starts its own)
set -euo pipefail

API="http://localhost:3013"
AUTH="Authorization: Bearer 123123"
CT="Content-Type: application/json"
PASS=0; FAIL=0; TOTAL=0

# ── Helpers ──────────────────────────────────────────────────
assert_eq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

assert_neq() {
  TOTAL=$((TOTAL + 1))
  local label="$1" actual="$2" unexpected="$3"
  if [ "$actual" != "$unexpected" ]; then
    echo "  ✓ $label"; PASS=$((PASS + 1))
  else
    echo "  ✗ $label (got unexpected '$unexpected')"; FAIL=$((FAIL + 1))
  fi
}

create_workflow() {
  curl -s -X POST "$API/api/workflows" -H "$AUTH" -H "$CT" -d "$1" | jq -r '.id'
}

trigger_workflow() {
  curl -s -X POST "$API/api/workflows/$1/trigger" -H "$AUTH" -H "$CT" -d "${2:-{}}" | jq -r '.runId'
}

wait_run() {
  local run_id="$1" max_wait="${2:-5}" i=0
  while [ $i -lt $max_wait ]; do
    local status
    status=$(curl -s "$API/api/workflow-runs/$run_id" -H "$AUTH" | jq -r '.run.status')
    if [ "$status" != "running" ]; then echo "$status"; return; fi
    sleep 1; i=$((i + 1))
  done
  echo "timeout"
}

get_run() {
  curl -s "$API/api/workflow-runs/$1" -H "$AUTH"
}

cleanup() {
  echo ""; echo "Cleaning up..."
  kill $(lsof -ti :3013 2>/dev/null) 2>/dev/null || true
  rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────────
echo "=== E2E Workflow Redesign Tests ==="
echo ""
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
# Wait for server to be ready (health check with retry)
for i in $(seq 1 10); do
  curl -sf "$API/api/agents" -H "$AUTH" > /dev/null 2>&1 && break
  [ $i -eq 10 ] && { echo "Server failed to start"; exit 1; }
  sleep 1
done

# ── Test 1: Linear happy path ───────────────────────────────
echo "Test 1: Linear happy path"
WF1=$(create_workflow '{
  "name": "e2e-linear",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo hello" }, "next": "check" },
    { "id": "check", "type": "property-match", "config": { "conditions": [{ "field": "s1.exitCode", "op": "eq", "value": 0 }] }, "next": { "true": "done", "false": "fail" } },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "OK: {{s1.stdout}}" } },
    { "id": "fail", "type": "notify", "config": { "channel": "swarm", "template": "FAIL" } }
  ]}
}')
RUN1=$(trigger_workflow "$WF1")
STATUS1=$(wait_run "$RUN1")
STEPS1=$(get_run "$RUN1" | jq '.steps | length')
assert_eq "run completes" "$STATUS1" "completed"
assert_eq "3 steps executed" "$STEPS1" "3"

# ── Test 2: Branch false path ───────────────────────────────
echo "Test 2: Branch false path (script fails)"
WF2=$(create_workflow '{
  "name": "e2e-branch-false",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "exit 1" }, "next": "check" },
    { "id": "check", "type": "property-match", "config": { "conditions": [{ "field": "s1.exitCode", "op": "eq", "value": 0 }] }, "next": { "true": "ok", "false": "notok" } },
    { "id": "ok", "type": "notify", "config": { "channel": "swarm", "template": "OK" } },
    { "id": "notok", "type": "notify", "config": { "channel": "swarm", "template": "NOT OK" } }
  ]}
}')
RUN2=$(trigger_workflow "$WF2")
STATUS2=$(wait_run "$RUN2")
LAST_STEP2=$(get_run "$RUN2" | jq -r '.steps[-1].nodeId')
assert_eq "run completes" "$STATUS2" "completed"
assert_eq "takes false branch" "$LAST_STEP2" "notok"

# ── Test 3: Parallel execution ──────────────────────────────
echo "Test 3: Parallel fan-out and convergence"
WF3=$(create_workflow '{
  "name": "e2e-parallel",
  "definition": { "nodes": [
    { "id": "start", "type": "code-match", "config": { "code": "return true", "outputPorts": ["a", "b"] }, "next": { "a": "branch-a", "b": "branch-b" } },
    { "id": "branch-a", "type": "notify", "config": { "channel": "swarm", "template": "Branch A" }, "next": "end" },
    { "id": "branch-b", "type": "notify", "config": { "channel": "swarm", "template": "Branch B" }, "next": "end" },
    { "id": "end", "type": "notify", "config": { "channel": "swarm", "template": "Done" } }
  ]}
}')
# Fan-out: start emits two ports → branch-a and branch-b execute in parallel → both converge on end
RUN3=$(trigger_workflow "$WF3")
STATUS3=$(wait_run "$RUN3")
STEPS3=$(get_run "$RUN3" | jq '.steps | length')
assert_eq "run completes" "$STATUS3" "completed"
assert_eq "4 steps executed (start + 2 branches + end)" "$STEPS3" "4"

# ── Test 4: Async pause/resume ──────────────────────────────
echo "Test 4: Async pause/resume (agent-task)"
WF4=$(create_workflow '{
  "name": "e2e-async",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo prep" }, "next": "task" },
    { "id": "task", "type": "agent-task", "config": { "template": "Do something: {{s1.stdout}}" }, "next": "done" },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "Task output: {{task.taskOutput}}" } }
  ]}
}')
RUN4=$(trigger_workflow "$WF4")
STATUS4=$(wait_run "$RUN4" 3)
assert_eq "run pauses at waiting" "$STATUS4" "waiting"
# Find the created task
TASK_ID=$(curl -s "$API/api/tasks?source=workflow" -H "$AUTH" | jq -r '.tasks[0].id')
assert_neq "task was created" "$TASK_ID" "null"
# Complete the task manually
curl -s -X POST "$API/api/tasks/$TASK_ID/finish" -H "$AUTH" -H "$CT" \
  -d '{"output": "task done"}' > /dev/null
sleep 2
STATUS4B=$(curl -s "$API/api/workflow-runs/$RUN4" -H "$AUTH" | jq -r '.run.status')
assert_eq "run resumes to completed" "$STATUS4B" "completed"

# ── Test 5: Webhook trigger + HMAC ──────────────────────────
echo "Test 5: Webhook trigger + HMAC"
WF5=$(create_workflow '{
  "name": "e2e-webhook",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "Webhook fired: {{trigger}}" } }
  ]},
  "triggers": [{ "type": "webhook", "hmacSecret": "test-secret-123" }]
}')
# Valid HMAC
BODY='{"event":"test"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "test-secret-123" | awk '{print "sha256="$2}')
WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/webhooks/$WF5" \
  -H "$CT" -H "X-Hub-Signature-256: $SIG" -d "$BODY")
assert_eq "valid HMAC → 201" "$WEBHOOK_STATUS" "201"
# Invalid HMAC
BAD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/webhooks/$WF5" \
  -H "$CT" -H "X-Hub-Signature-256: sha256=invalid" -d "$BODY")
assert_eq "invalid HMAC → 401" "$BAD_STATUS" "401"

# ── Test 6: Cooldown skip ───────────────────────────────────
echo "Test 6: Cooldown skip"
WF6=$(create_workflow '{
  "name": "e2e-cooldown",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "Ran" } }
  ]},
  "cooldown": { "hours": 1 }
}')
RUN6A=$(trigger_workflow "$WF6")
STATUS6A=$(wait_run "$RUN6A")
assert_eq "first run completes" "$STATUS6A" "completed"
RUN6B=$(trigger_workflow "$WF6")
STATUS6B=$(wait_run "$RUN6B" 2)
assert_eq "second run skipped (cooldown)" "$STATUS6B" "skipped"

# ── Test 7: Version history ─────────────────────────────────
echo "Test 7: Version history"
WF7=$(create_workflow '{
  "name": "e2e-versions",
  "definition": { "nodes": [
    { "id": "n1", "type": "notify", "config": { "channel": "swarm", "template": "v1" } }
  ]}
}')
curl -s -X PUT "$API/api/workflows/$WF7" -H "$AUTH" -H "$CT" \
  -d '{"description": "update 1"}' > /dev/null
curl -s -X PUT "$API/api/workflows/$WF7" -H "$AUTH" -H "$CT" \
  -d '{"description": "update 2"}' > /dev/null
VERSIONS=$(sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM workflow_versions WHERE workflowId='$WF7'")
assert_eq "2 version snapshots" "$VERSIONS" "2"

# ── Test 8: Validation failure (mustPass) ────────────────────
echo "Test 8: Validation failure halts run"
WF8=$(create_workflow '{
  "name": "e2e-validation-fail",
  "definition": { "nodes": [
    { "id": "s1", "type": "script", "config": { "runtime": "bash", "script": "echo bad-data" },
      "validation": { "executor": "validate", "config": { "targetNodeId": "s1", "schema": { "type": "object", "properties": { "stdout": { "const": "good-data" } } } }, "mustPass": true },
      "next": "done" },
    { "id": "done", "type": "notify", "config": { "channel": "swarm", "template": "Should not reach" } }
  ]}
}')
RUN8=$(trigger_workflow "$WF8")
STATUS8=$(wait_run "$RUN8")
assert_eq "run fails on validation" "$STATUS8" "failed"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
if [ $FAIL -gt 0 ]; then exit 1; fi
```

#### Running the E2E Script

```bash
# From project root (API must NOT be running on :3013)
bash scripts/e2e-workflow-redesign.sh
```

The script:
1. Starts a fresh API server with clean DB
2. Runs all 8 scenarios with auto-assertions
3. Reports pass/fail summary
4. Cleans up (kills server, removes DB)
5. Exits non-zero if any test fails

## References

- Research: `thoughts/taras/research/2026-03-18-workflow-redesign.md`
- Prior art: Content-Agent workflow engine (referenced in research §1)
- Original design: `thoughts/taras/research/2026-03-06-workflow-engine-design.md` (superseded)
- Current migration: `src/be/migrations/003_workflows.sql`
- Current engine: `src/workflows/engine.ts`
- Current types: `src/types.ts:550-642`
- Current DB functions: `src/be/db.ts:5712-6089`

---

## Review Errata

_Reviewed: 2026-03-19 by claude_

### Critical

- [x] **Migration number `005` → `008`.** All references updated to `008_workflow_redesign.sql`. Migrations 005-007 already exist.
- [x] **E2E Test 4 endpoint fixed.** Changed from `POST /api/tasks/:id/action` to `POST /api/tasks/:id/finish` with correct request body.
- [x] **SQLite CASCADE replaced.** Migration now uses `PRAGMA foreign_keys=OFF`, NULLs out `agent_tasks` FKs, drops tables, recreates, re-enables FKs.

### Important

- [x] **E2E Test 3 now tests real parallel fan-out.** Rewritten: `start` emits two ports → `branch-a` and `branch-b` execute in parallel → converge on `end`. Asserts 4 steps.
- [x] **Retry poller uses `setTimeout` chaining.** Prevents overlap — next tick scheduled only after current completes.
- [x] **Script executor trust boundary documented.** Added note: only agents with workflow-create permission can define script nodes.
- [x] **`maxIterations` is now an env var.** `WORKFLOW_MAX_ITERATIONS` (default 100).
- [x] **`interpolate()` explicitly referenced.** Phase 7 now notes reuse from `src/workflows/template.ts` and marks it as "do NOT delete".
- [x] **`offerMode` explained.** Inline description: task is offered (agents accept/reject) vs. directly assigned.
- [x] **Cooldown schema specified.** `{ hours?: number, minutes?: number, seconds?: number }` (at least one required).
- [x] **E2E health check added.** Replaced `sleep 2` with retry loop (up to 10 attempts with 1s delay).

### Minor (from codebase verification)

- [x] Event trigger count corrected from 14 to 16 (Phase 5 §7).
- [x] Phase 5 §6 "skipped" status clarified — included in Phase 1's initial migration, no separate update needed.

### Verified Accurate

- [x] `db.transaction()` pattern exists as `getDb().transaction()` in `src/be/db.ts` (5 usages).
- [x] `interpolate()` exists in `src/workflows/template.ts`.
- [x] `WorkflowDefinitionSchema` at `types.ts:585-588` — exact match.
- [x] 13 node types at `types.ts:552-566` — exact match.
- [x] 9 MCP tools, 9 HTTP endpoints, 6 node files — all accurate.
- [x] `recoverStuckWorkflowRuns()` at `heartbeat.ts:217` — exact match.
- [x] 3 trigger types (webhook, schedule, manual) — aligns with codebase.
