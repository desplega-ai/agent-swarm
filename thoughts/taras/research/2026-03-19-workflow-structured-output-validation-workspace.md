---
date: 2026-03-20
topic: "Workflow Gaps: Structured Output, Validation Nodes, Workspace Scoping"
status: complete
researcher: taras+claude
iteration: 2 (review feedback from 2026-03-20)
---

# Workflow Feature Gaps Research

**Context**: Three feature gaps identified for the next workflow engine implementation cycle. This research documents the current state, key files, and gap analysis for each.

**Prior art**: `thoughts/taras/research/2026-03-19-workflow-node-io-schemas-and-bugs.md` covers I/O schemas and engine bugs. This document covers the next layer: structured extraction, validation nodes, and workspace scoping.

---

## 1. Structured Output Extraction for Agent-Tasks

### Current State

**How agent-tasks work today:**

1. **Task creation** (`src/workflows/executors/agent-task.ts:64-72`): The executor calls `db.createTaskExtended(config.template, {...})` with the interpolated task description string, optional `agentId`, `tags`, `priority`, `offerMode`. The task is linked to the workflow via `workflowRunId` and `workflowRunStepId`.

2. **Async pause** (`src/workflows/executors/agent-task.ts:75-80`): The executor returns `{ status: "success", async: true, waitFor: "task.completed", correlationId: task.id }`. The engine checkpoints the step as "waiting" and pauses the workflow run (`src/workflows/engine.ts:429-431`).

3. **Worker picks up task** (`src/commands/runner.ts:2031-2037`): The runner polls for triggers, gets a `task_assigned` trigger, and spawns a Claude session. The prompt is built from the task description and injected context (memories, epic context, repo context).

4. **Claude completes task**: The agent calls `store-progress` MCP tool with `status: "completed"` and an output string. This calls `completeTask(id, output)` in the DB (`src/be/db.ts:1322-1356`).

5. **Event emission** (`src/be/db.ts:1343-1351`): `completeTask()` emits `workflowEventBus.emit("task.completed", { taskId, output, agentId, workflowRunId, workflowRunStepId })`. The `output` field is the raw string from `store-progress`.

6. **Workflow resume** (`src/workflows/resume.ts:62-87`): The `task.completed` listener picks up the event, creates `stepOutput = { taskId, taskOutput: event.output }`, checkpoints the step, and continues the graph walk.

**Key observation**: Task output is always a **plain string** (`z.string().optional()` in `AgentTaskSchema` at `src/types.ts:98`). There is no structured extraction. The `AgentTaskOutputSchema` declares `taskOutput: z.unknown()` (`src/workflows/executors/agent-task.ts:17-19`), meaning downstream nodes receive an untyped string.

### Key Files

| File | Lines | Role |
|------|-------|------|
| `src/workflows/executors/agent-task.ts` | 1-82 | Executor: creates task, returns async result |
| `src/workflows/resume.ts` | 31-87 | Resumes workflow when task completes |
| `src/be/db.ts` | 1322-1356 | `completeTask()`: stores output, emits event |
| `src/commands/runner.ts` | 282-341 | `ensureTaskFinished()`: runner fallback for task status |
| `src/workflows/engine.ts` | 429-431 | Handles async results (checkpoints waiting) |
| `src/types.ts` | 98 | `output: z.string().optional()` on AgentTaskSchema |

### Gap Analysis

**What's missing**: When an agent-task node completes, the workflow has no way to extract structured data from the agent's free-text output. Every downstream node sees `taskOutput` as an opaque string.

**Revised approach** -- Do this at the **task level** (not workflow-only), so any task can opt into structured output regardless of whether it was created by a workflow:

1. **Add `outputSchema` to `AgentTaskSchema`** (`src/types.ts:98`): Optional JSON Schema field on the task itself. When set, the task "knows" it should produce structured output.

2. **Prompt injection**: When the runner builds the task prompt (`runner.ts`), if `outputSchema` is set, append the schema to the prompt so the agent knows what structure to produce.

3. **Primary path: agent calls `store-progress` during the run** -- Both adapters instruct the agent (via prompt injection) to call `store-progress` with JSON-structured output conforming to the schema. The `store-progress` tool validates the output:

   - Attempt `JSON.parse(output)`
   - If valid JSON, validate against `outputSchema`
   - If invalid JSON or doesn’t match schema: **fail the tool call** (NOT the task) with an error message describing what’s wrong and asking the agent to retry with the correct format. This gives the agent a chance to self-correct.
   - If valid and matches: store as-is, proceed normally.

4. **Claude adapter fallback**: If the Claude session ends and no structured output was successfully stored via `store-progress`, the runner does a **fallback extraction** using:
   ```
   claude -p ‘<extract prompt with raw output>’ --json-schema ‘<schema>’ --output-format json --model sonnet
   ```
   This is a one-shot extraction call with `--model sonnet` (hardcoded, cheap). The `structured_output` field from the result is stored as the task output. Confirmed working:
   ```
   claude -p ‘list files in ~’ --json-schema ‘{“type”:”object”,...}’ --output-format json --model haiku
   # Result JSON has: “structured_output”: { “files”: [“Applications”, ...] }
   ```

5. **Pi-mono adapter**: No fallback extraction. If the task ends and no structured output was stored via `store-progress`, **fail the task**. Pi agents are expected to comply with the schema via prompt injection + `store-progress` validation loop.

4. **Where changes go**:
   - `src/types.ts`: Add `outputSchema: z.record(z.string(), z.unknown()).optional()` to `AgentTaskSchema`
   - `src/tools/store-progress.ts:123-131`: After `completeTask()`, if task has `outputSchema`, run extraction
   - `src/workflows/executors/agent-task.ts:64-72`: Forward `outputSchema` from workflow config to `createTaskExtended()`
   - `src/workflows/resume.ts:77`: The extracted structured output flows naturally -- `event.output` is already the stored output

**Key insight from `store-progress` research**: The tool accepts `output` as a plain string (`src/tools/store-progress.ts:57`). After storing it, it also creates memory records and follow-up tasks (lines 178-305). Structured output extraction should happen **before** memory indexing so the memory record gets the clean structured data too.

**Key insight about runner fallback**: `ensureTaskFinished()` (`runner.ts:274-341`) is idempotent -- if the agent already called `store-progress`, it's a no-op. So extraction at `store-progress` time is the right place, not the runner fallback.

### Dependencies

**AI SDK is already a dependency** (`package.json:99`): `"ai": "^6.0.116"` and `"@ai-sdk/openai": "^3.0.41"`. Both are used by the `raw-llm` executor (`src/workflows/executors/raw-llm.ts:39-61`) and the `validate` executor (`src/workflows/executors/validate.ts:114-141`). No new packages needed.

**Existing pattern to follow**: The `raw-llm` executor already does `generateObject()` with `jsonSchema()` for structured output (`src/workflows/executors/raw-llm.ts:47-53`). The `validate` executor also uses `generateObject()` with a fixed schema (`src/workflows/executors/validate.ts:122-141`). The extraction code can follow the same pattern.

---

## 2. Validation Node Pattern

### Current State

**Existing validation system** (`src/workflows/validation.ts`, `src/workflows/engine.ts:447-475`):

The engine has **inline step validation** -- each node can declare a `validation` block that runs immediately after the node completes. This is NOT a separate graph node; it's an annotation on the node being validated.

**How it works today:**

1. **Configuration** (`src/types.ts:583-589`):
   ```
   StepValidationConfigSchema = {
     executor: string (default: "validate"),
     config: Record<string, unknown>,
     mustPass: boolean (default: false),
     retry: RetryPolicySchema.optional()
   }
   ```

2. **Trigger** (`src/workflows/engine.ts:448-449`): After a step completes successfully, if `node.validation` is set, the engine calls `runStepValidation()`.

3. **Validation execution** (`src/workflows/validation.ts:18-78`): Creates a validation context with the step's output injected, runs the validation executor (default: `validate`), checks if the result has `pass === true`.

4. **Outcomes** (`src/workflows/validation.ts:4`):
   - `"pass"` -- Step output accepted, continue to successors
   - `"halt"` -- `mustPass` is true, no retry configured -- run fails (`engine.ts:451-455`)
   - `"retry"` -- `mustPass` is true, retry configured -- step is re-queued via `checkpointStepFailure` with retry policy (`engine.ts:457-474`)

5. **Retry context** (`src/workflows/engine.ts:458-463`): When validation fails with retry, the validation result is appended to a history array at `ctx[${nodeId}_validations]`. This history is available to the retried step so it can see what went wrong.

6. **Validate executor** (`src/workflows/executors/validate.ts`): Supports two modes:
   - **Schema validation** (`config.schema`): Basic JSON Schema checks (type, required, const, enum)
   - **LLM validation** (`config.prompt`): Uses AI SDK `generateObject()` to ask an LLM to evaluate output against criteria, returns `{pass, reasoning, confidence}`

### Key Files

| File | Lines | Role |
|------|-------|------|
| `src/workflows/validation.ts` | 1-78 | `runStepValidation()`: orchestrates validation after step completion |
| `src/workflows/engine.ts` | 447-475 | Engine hook: calls validation, handles retry/halt outcomes |
| `src/workflows/executors/validate.ts` | 1-215 | Validate executor: schema + LLM validation |
| `src/types.ts` | 576-589 | `ValidationResultSchema`, `StepValidationConfigSchema` |
| `src/workflows/checkpoint.ts` | 34-72 | `checkpointStepFailure()`: handles retry scheduling |
| `src/workflows/retry-poller.ts` | 1-177 | Polls for retryable steps, re-executes them |

### Gap Analysis

**What exists**: Inline validation that can retry the SAME node when validation fails. The step is set to `"failed"`, previous output + validation result are stored in the `${nodeId}_validations` history array (`engine.ts:459-462`), and the retry poller re-executes the step with that history available in context.

**Can any executor type be used as a validator?** Yes and no. The registry lookup is unrestricted -- `validation.ts:30-32` calls `registry.get(executorType)` which resolves any registered executor (`property-match`, `raw-llm`, `script`, etc.). **However**, the pass/fail contract is hardcoded (`validation.ts:53-56`):
```
const passed = result.output && (result.output as { pass?: boolean }).pass === true;
```
Only the `validate` executor produces `{ pass: boolean }` in its output. Other executors:
- `script` produces `{ exitCode, stdout, stderr }` -- always "fails" the check
- `raw-llm` produces `{ result, model }` -- always "fails"
- `property-match` produces `{ passed, results }` -- note `passed` not `pass`, also fails

**To support any executor as a validator**, we'd need to normalize the pass/fail contract. Options:
1. **Adapter layer**: Map each executor's output to `{ pass }` (e.g., `script.exitCode === 0 → pass: true`, `property-match.passed → pass`)
2. **Convention**: Require all executors to include `pass` in their output when used as validators
3. **Config-based**: Add a `passCondition` to the validation config (e.g., `"passCondition": "output.exitCode === 0"`)

**Bug discovered: Retry poller skips validation re-check.** After a validation-triggered retry, the retry poller (`retry-poller.ts:77-119`) re-runs the step executor but does NOT call `runStepValidation()` on the result. It goes straight to `checkpointStep()` + `walkGraph()`. This means a retried step's output is never re-validated -- the validation gate is only applied on the first execution. This should be fixed regardless of whether we add validation nodes.

**What's missing for "validation nodes"**: The concept of a **separate graph node** that acts as a validator for another node's output and can **re-trigger the upstream node** on failure.

**Current limitations:**

1. **No cross-node validation re-trigger**: Today, validation can only retry the node it's attached to. There's no way for Node C (validator) to say "Node B's output is bad, re-run Node B." The engine's `walkGraph` only moves forward; it never re-queues a completed node.

2. **No "re-queue a previously completed node"** (`src/workflows/engine.ts:291`): When a step is memoized as completed (`existingStep.status === "completed"`), the engine skips it and returns its stored output. There's no mechanism to invalidate a completed step.

3. **No feedback loop edges**: The graph is a DAG. Node definitions use `next` to point forward. There's no way to express "on validation failure, go back to node X."

4. **No way to store failed step output for re-use**: When we mark a step as failed for re-trigger, the previous output should be preserved so the validator can reference it and the retried step can see what it produced before.

**What would need to change:**

1. **Step invalidation + output preservation**: Add a `resetCompletedStep(runId, nodeId)` function that:
   - Clears the step's `"completed"` status
<!-- review-line-start(0f10f16a) -->
   - Appends the previous output to `ctx[${nodeId}_previousOutputs]` array (accumulates across retries, so retry N can see all N-1 prior outputs)
   - Appends the validation result to `ctx[${nodeId}_validations]` array (reusing the existing array pattern -- already supports multiple entries)
   - Sets the step to `"failed"` with retry policy

2. **Backward edges with guards**: Allow `next` to reference upstream nodes, but only on specific ports (e.g., `"fail": "upstream_node"`). The engine would need cycle detection with a max-retry guard to prevent infinite loops.

3. **Re-execution with context**: When a validator re-triggers an upstream node, the upstream node should receive the validation feedback. This already partially exists via the `${nodeId}_validations` history array mechanism in the engine (`engine.ts:459-462`), but it only works for inline validation retries, not cross-node re-triggers.

4. **Execution counter per node**: To prevent infinite loops, each node would need an execution counter (not just the run-level `MAX_ITERATIONS`). The engine already has `MAX_ITERATIONS` (`engine.ts:23`), but a per-node counter would be more precise.

5. **Fix retry poller validation re-check**: The retry poller must call `runStepValidation()` after re-executing a step, just like the main engine loop does. This is a prerequisite bugfix.

### Edge Cases

- **Cycles**: A validation node pointing back to its target creates a cycle. Must have a per-node max execution count to break cycles. The existing `MAX_ITERATIONS` (default 100) provides a safety net but is too coarse.
- **Max retries exhausted**: When the validator has failed N times and re-triggered the upstream node N times, what happens? Options: (a) fail the run, (b) continue without validation, (c) route to an "escalation" port.
- **Multiple validators**: Two validator nodes both targeting the same upstream node. If one passes and the other fails, the failed one would reset the upstream node, invalidating the passed one's context. Need clear semantics: either validators run sequentially, or the "strictest wins" rule applies.
- **Async nodes**: If the upstream node is an agent-task (async), re-triggering it creates a new task and waits again. The engine re-enters the waiting state for a previously completed node. This is expected behavior.

---

## 3. Workspace Scoping for Agent-Tasks

### Current State

**How workers set up their workspace today:**

1. **Docker build** (`Dockerfile.worker:149,157-158`): Creates `/workspace`, `/workspace/personal`, `/workspace/shared` directories. The worker process runs in `/workspace` (`WORKDIR /workspace`).

2. **Entrypoint workspace setup** (`docker-entrypoint.sh`):
   - **Archil FUSE mounts** (lines 28-57): If `ARCHIL_MOUNT_TOKEN` is set, mounts shared and personal disks at `/workspace/shared` and `/workspace/personal`.
   - **Repo auto-clone** (lines 334-373): Fetches registered repos from `GET /api/repos?autoClone=true` and clones them to their configured `clonePath` (typically `/workspace/repos/<name>`).
   - **Per-agent directories** (lines 572-624): Creates agent-specific subdirectories under `/workspace/shared/{thoughts,memory,downloads,misc}/$AGENT_ID/`.
   - **Startup script** (lines 376-549): Executes `/workspace/start-up.sh` if it exists, which can contain agent-specific workspace setup.

3. **Per-task working directory** (`src/commands/runner.ts:2139-2173`): The runner resolves the working directory for each task with this priority:
   - `task.dir` -- explicit absolute path set on the task (`AgentTaskSchema.dir` at `src/types.ts:128`)
   - `currentRepoContext.clonePath` -- if the task has a `vcsRepo`, the runner ensures the repo is cloned and uses its path
   - `process.cwd()` -- fallback to `/workspace`

4. **Task dir field**: The `AgentTaskSchema` already has `dir: z.string().min(1).startsWith("/").optional()` (`src/types.ts:128`). The `CreateTaskOptions` interface also has `dir?: string` (`src/be/db.ts:1733`). Tasks CAN be created with an explicit working directory.

5. **Runner cwd usage** (`src/commands/runner.ts:1174`): The `ProviderSessionConfig.cwd` is set to `opts.cwd || process.cwd()`. This is passed to the Claude/Pi-mono adapter which uses it as the spawned process's working directory.

### Key Files

| File | Lines | Role |
|------|-------|------|
| `Dockerfile.worker` | 149-158 | Creates workspace directories |
| `docker-entrypoint.sh` | 28-57, 334-373, 572-624 | Mounts, clones repos, sets up per-agent dirs |
| `src/commands/runner.ts` | 2139-2173 | Resolves per-task working directory |
| `src/types.ts` | 128 | `dir` field on `AgentTaskSchema` |
| `src/be/db.ts` | 1707-1740 | `CreateTaskOptions` with `dir` and `vcsRepo` fields |
| `src/workflows/executors/agent-task.ts` | 8-14 | `AgentTaskConfigSchema` -- current config fields |
| `.wts-setup.ts` | 1-167 | Worktree setup: port allocation, env copying (local dev, not Docker) |

### Gap Analysis

**What exists**: Tasks already support `dir` and `vcsRepo` fields. The runner already resolves working directories per-task. Repos are auto-cloned at container startup.

**What's missing in the workflow context**: The `AgentTaskConfigSchema` (`src/workflows/executors/agent-task.ts:8-14`) does NOT expose `dir`, `vcsRepo`, or any workspace-related fields. It only has:
```
template: string,       // task description
agentId: string.uuid(), // optional target agent
tags: string[],         // optional tags
priority: number,       // optional priority
offerMode: boolean      // optional offer mode
```

The `createTaskExtended` call in the executor (`agent-task.ts:64-72`) passes `workflowRunId` and `workflowRunStepId`, but NOT `dir` or `vcsRepo`. These fields from `CreateTaskOptions` are unused by the workflow executor.

**What would need to change:**

1. **Extend `AgentTaskConfigSchema`**: Add optional fields:
   ```typescript
   dir: z.string().startsWith("/").optional(),
   vcsRepo: z.string().optional(),
   model: z.string().optional(),
   parentTaskId: z.string().uuid().optional(),
   ```

2. **Pass fields through to `createTaskExtended`**: In the executor's `execute()` method, forward the new config fields:
   ```typescript
   const task = db.createTaskExtended(config.template, {
     // ...existing fields...
     dir: config.dir,
     vcsRepo: config.vcsRepo,
     model: config.model,
   });
   ```

3. **Interpolation support**: The `dir` and `vcsRepo` fields should be interpolatable, so workflows can derive them from trigger data:
   ```json
   {
     "type": "agent-task",
     "inputs": { "repo": "trigger.repo" },
     "config": {
       "template": "Review the code",
       "vcsRepo": "{{repo}}"
     }
   }
   ```
   This already works because the engine deep-interpolates all config values before passing them to the executor (`engine.ts:356`).

### Design Considerations

- **Cleanup**: No cleanup is needed for the workspace itself. Repos cloned at startup persist across tasks. If a task creates temporary files, the agent is responsible for cleanup (or the container restart handles it).

- **Error recovery**: If `dir` points to a non-existent path, the runner already handles this gracefully (`runner.ts:2144-2157`) -- it logs a warning and falls back to the default cwd. The same behavior would apply to workflow-created tasks.

- **Concurrent access**: Multiple concurrent agent-tasks from the same workflow could target the same repo directory. This is the same problem as regular multi-agent work on a single repo. The existing pattern (worktrees via `wts`) handles this for local dev. In Docker, each container has its own filesystem, so there's no conflict between containers. Within a single container (multiple concurrent tasks), the agent is expected to use branches/worktrees.

- **Multi-repo**: A workflow that needs tasks on different repos can set `vcsRepo` per agent-task node. The runner already handles per-task repo resolution, so this works out of the box once the config fields are forwarded.

- **Worktree integration**: The `.wts-setup.ts` script handles worktree creation for local development (port allocation, env file copying). This is orthogonal to Docker-based workspace scoping. However, a workflow could include a `script` executor step that runs `wts create` to set up a worktree, then pass the worktree path as `dir` to subsequent agent-task nodes.

---

## Summary of Changes Required

| Feature | Complexity | Files to Change | New Dependencies |
|---------|-----------|----------------|-----------------|
| **Structured Output** | Medium | `types.ts`, `store-progress.ts`, `agent-task.ts`, `resume.ts` | None (AI SDK already present) |
| **Validation Bug Fix** | Low | `retry-poller.ts` | None |
| **Validation Node Executors** | Medium | `validation.ts` (pass/fail contract normalization) | None |
| **Validation Nodes (cross-node)** | High | `engine.ts`, `checkpoint.ts`, `db.ts`, `types.ts` | None |
| **Workspace Scoping** | Low | `agent-task.ts` (config schema + passthrough) | None |

**Recommended implementation order**: Workspace Scoping first (smallest change, immediate value), then Validation Bug Fix (small, prerequisite), then Structured Output (medium, builds on existing AI SDK patterns), then Validation Node Executors (medium), then Validation Nodes cross-node (largest, most design decisions).

---

## E2E Verification Scenarios

### Common E2E Setup

All E2E scenarios below require the API server and at least a lead Docker worker running:

```bash
# Clean DB + start API
rm -f agent-swarm-db.sqlite*
bun run start:http &

# Build Docker image with current code
bun run docker:build:worker

# Start lead container
docker run --rm -d --name e2e-lead \
  --env-file .env.docker-lead -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest

# Start worker container
docker run --rm -d --name e2e-worker \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

# Wait for registration (~15s)
sleep 15
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents[] | {name, isLead, status}'
```

### Workspace Scoping E2Es

```bash
# E2E 1: Workflow creates task with explicit dir
# Create a workflow with agent-task node that sets dir
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "name": "workspace-scoping-test",
    "nodes": [{
      "id": "task1",
      "type": "agent-task",
      "config": {
        "template": "List files in the current directory and report back",
        "dir": "/workspace/repos/agent-swarm"
      }
    }],
    "trigger": { "type": "manual" }
  }'

# Trigger the workflow
curl -s -X POST http://localhost:3013/api/workflows/<id>/trigger \
  -H "Authorization: Bearer 123123"

# Verify: check the created task has dir set
curl -s http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" | jq '.tasks[0] | {dir, description}'
# Expected: dir = "/workspace/repos/agent-swarm"

# Wait for worker to pick up and complete (~30s for trivial task)
# Check worker logs for cwd resolution
docker logs e2e-worker 2>&1 | grep -i "working directory\|cwd"

# E2E 2: Workflow creates task with vcsRepo (auto-resolved dir)
# Same as above but with "vcsRepo": "agent-swarm" instead of "dir"
# Verify: runner resolves vcsRepo to clonePath

# E2E 3: Interpolated dir from trigger data
# Trigger workflow with: { "repo_path": "/workspace/repos/my-repo" }
# Node config: { "dir": "{{repo_path}}" }
# Verify: task.dir = "/workspace/repos/my-repo"
```

### Structured Output E2Es

(Uses common E2E setup above — API + lead + worker must be running)

```bash
# E2E 1: Task with outputSchema, agent produces valid JSON
# Create a task with outputSchema
curl -s -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "description": "Count the files in /tmp and report: {\"fileCount\": <number>, \"largestFile\": \"<name>\"}",
    "outputSchema": {
      "type": "object",
      "properties": {
        "fileCount": { "type": "number" },
        "largestFile": { "type": "string" }
      },
      "required": ["fileCount", "largestFile"]
    }
  }'

# After agent completes, verify output is structured JSON (not raw string)
curl -s http://localhost:3013/api/tasks/<id> \
  -H "Authorization: Bearer 123123" | jq '.task.output | fromjson'
# Expected: { "fileCount": N, "largestFile": "..." }

# E2E 2: Task with outputSchema, agent produces free text -> extraction
# Create task where agent is likely to produce prose, not JSON
# Verify: store-progress extracts structured data via AI SDK fallback

# E2E 3: Workflow agent-task with outputSchema flows to downstream node
# Create workflow: agent-task (outputSchema) -> raw-llm (uses {{task1.taskOutput.fileCount}})
# Verify: downstream node receives structured object, not string
```

### Validation Bug Fix E2E

```bash
# E2E 1: Validation-triggered retry should re-validate after retry
# Create workflow with node + inline validation (mustPass + retry)
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "name": "validation-retry-test",
    "nodes": [{
      "id": "llm1",
      "type": "raw-llm",
      "config": {
        "prompt": "Generate a random number between 1 and 100",
        "model": "google/gemini-3-flash-preview"
      },
      "validation": {
        "executor": "validate",
        "config": {
          "prompt": "Does the output contain a number greater than 50? Only pass if yes."
        },
        "mustPass": true,
        "retry": { "maxRetries": 3, "strategy": "static", "baseDelayMs": 1000 }
      }
    }],
    "trigger": { "type": "manual" }
  }'

# Trigger and monitor
curl -s -X POST http://localhost:3013/api/workflows/<id>/trigger \
  -H "Authorization: Bearer 123123"

# Check workflow run steps -- verify validation runs on EACH attempt, not just first
curl -s http://localhost:3013/api/workflow-runs/<run_id> \
  -H "Authorization: Bearer 123123" | jq '.steps[] | {nodeId, status, retryCount}'
# Before fix: validation only runs on first attempt
# After fix: validation runs on every retry attempt
```

### Validation Node Executor E2Es

```bash
# E2E 1: Script executor as validator (exit code 0 = pass)
# Create workflow node with validation using script executor
# validation: { "executor": "script", "config": { "script": "echo $OUTPUT | jq .fileCount" } }
# Verify: exit code 0 maps to pass, non-zero maps to fail

# E2E 2: property-match executor as validator
# validation: { "executor": "property-match", "config": { "conditions": [...] } }
# Verify: property-match "passed" field maps to validation pass/fail
```

---

## References

- Prior research: `thoughts/taras/research/2026-03-19-workflow-node-io-schemas-and-bugs.md`
- Prior research: `thoughts/taras/research/2026-03-06-workflow-engine-design.md`
- Prior plan: `thoughts/taras/plans/2026-03-18-workflow-redesign.md`
- Engine: `src/workflows/engine.ts`
- Resume: `src/workflows/resume.ts`
- Agent-task executor: `src/workflows/executors/agent-task.ts`
- Validate executor: `src/workflows/executors/validate.ts`
- Validation: `src/workflows/validation.ts`
- Retry poller: `src/workflows/retry-poller.ts`
- Types: `src/types.ts`
- Runner: `src/commands/runner.ts`
- DB: `src/be/db.ts`
- Dockerfile: `Dockerfile.worker`
- Entrypoint: `docker-entrypoint.sh`
