---
date: 2026-03-20
topic: "Workflow: Structured Output, Validation Fixes, Workspace Scoping"
status: ready
author: taras+claude
autonomy: critical
commit-per-phase: true
---

# Workflow: Structured Output, Validation Fixes, Workspace Scoping

## Overview

Four features to close gaps in the workflow engine: workspace scoping for agent-tasks, a validation retry bug fix, structured output extraction from agent-tasks, and validation executor adapter normalization. These are ordered by complexity (lowest first) to deliver value incrementally.

**Cross-node validation nodes** (backward edges, cycle detection, step invalidation) are explicitly deferred to a separate plan.

## Current State Analysis

**Workspace scoping**: `AgentTaskConfigSchema` (agent-task.ts:8-14) only exposes `template`, `agentId`, `tags`, `priority`, `offerMode`. The DB layer's `CreateTaskOptions` (db.ts:1707-1740) already supports `dir`, `vcsRepo`, `model`, `parentTaskId`. The runner already resolves cwd from `task.dir` > `vcsRepo clonePath` > `process.cwd()` (runner.ts:2150-2172). The gap is simply that the workflow executor doesn't forward these fields.

**Validation bug**: The retry poller (retry-poller.ts:77-128) re-runs executors after a validation-triggered retry but never calls `runStepValidation()` on the result. Validation only runs in `executeStep()` (engine.ts:447-475). This means a retried step's output is never re-validated.

**Structured output**: Task output is always `z.string().optional()` (types.ts:98). `store-progress` (store-progress.ts:124) stores raw strings. There's no way to extract structured data from agent output. The `raw-llm` executor already uses `generateObject()` with AI SDK (raw-llm.ts:47-53), so the extraction pattern exists.

**Validation executor adapters**: The pass/fail contract is hardcoded at validation.ts:53-56 (`result.output.pass === true`). Only the `validate` executor produces `{ pass: boolean }`. Other executors (`script`, `property-match`, `raw-llm`) have different output shapes and always "fail" the check.

### Key Discoveries:
- Runner cwd resolution is robust: validates `existsSync()` + `statSync()`, falls back gracefully (runner.ts:2154-2167)
- `deepInterpolate()` already handles `{{token}}` replacement in all config fields (engine.ts:356), so new fields like `dir: "{{repo_path}}"` work automatically
- Retry poller uses `setTimeout` chaining (not `setInterval`) to prevent overlap (retry-poller.ts:135)
- `store-progress` runs memory indexing AFTER task completion (store-progress.ts:178-232) — structured output should be validated BEFORE `completeTask()` call
- The `validate` executor already uses AI SDK's `generateObject()` with OpenRouter (validate.ts:114-141)

## Desired End State

1. **Workspace scoping**: Workflow `agent-task` nodes can set `dir`, `vcsRepo`, `model`, `parentTaskId` in their config. These flow through to the created task and the runner resolves the working directory accordingly.

2. **Validation bug fixed**: After a validation-triggered retry succeeds, the retry poller re-runs `runStepValidation()` before checkpointing success.

3. **Structured output**: Tasks can declare an `outputSchema` (JSON Schema). When set:
   - The agent's prompt includes the schema so it knows what structure to produce
   - `store-progress` validates output against the schema; invalid output fails the tool call (not the task), giving the agent a chance to retry
   - Claude adapter: if session ends without structured output, a fallback extraction call (`claude -p --json-schema`) produces structured data
   - Pi-mono adapter: no fallback — task fails if no valid structured output
   - Workflow `agent-task` nodes can set `outputSchema` in config, forwarded to the task

4. **Validation executor adapters**: Any executor can be used as a validator. The validation system normalizes output to `{ pass }` using an adapter layer: `script.exitCode === 0 → pass`, `property-match.passed → pass`, etc.

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — All unit tests
- `bun test src/tests/<file>.test.ts` — Specific test

Key files:
- `src/workflows/executors/agent-task.ts` — Agent-task executor (config schema + task creation)
- `src/workflows/validation.ts` — Validation orchestrator (pass/fail contract)
- `src/workflows/retry-poller.ts` — Retry loop
- `src/tools/store-progress.ts` — MCP tool for task completion
- `src/types.ts` — All Zod schemas
- `src/commands/runner.ts` — Task runner (prompt building, cwd resolution)

## What We're NOT Doing

- **Cross-node validation nodes**: No backward edges, cycle detection, or step invalidation. Deferred to a separate plan.
- **UI changes**: No dashboard changes for structured output display or validation status.
- **New dependencies**: AI SDK is already present. No new packages.
- **Full JSON Schema support**: The existing `validateJsonSchema()` is a minimal validator (supports `type`, `required`, `properties` only). We will extend it to also support `enum` and `const`, but advanced features like `pattern`, `anyOf`/`oneOf`, `$ref`, `additionalProperties` are out of scope for this plan.

## Implementation Approach

Ordered by complexity (lowest first). Each phase is independently testable and committable.

1. **Workspace scoping** — Pure config passthrough, no new logic
2. **Validation bug fix** — Small, targeted fix in retry poller
3. **Structured output** — Largest feature, builds on existing AI SDK patterns
4. **Validation executor adapters** — Normalize pass/fail contract

---

## Phase 1: Workspace Scoping for Agent-Tasks

### Overview
Extend `AgentTaskConfigSchema` to expose `dir`, `vcsRepo`, `model`, and `parentTaskId` fields, and forward them to `createTaskExtended()`. The runner and DB layer already handle these fields — the workflow executor just doesn't pass them through.

### Changes Required:

#### 1. Extend AgentTaskConfigSchema
**File**: `src/workflows/executors/agent-task.ts`
**Changes**:
- Add optional fields to `AgentTaskConfigSchema` (after line 14):
  ```typescript
  dir: z.string().min(1).optional(),
  vcsRepo: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  parentTaskId: z.string().uuid().optional(),
  ```
- Note: `dir` does NOT enforce `.startsWith("/")` here because the value may come from interpolation (e.g., `"{{repo_path}}"`) and the runner already validates the path at runtime (runner.ts:2154-2167).

#### 2. Forward fields to createTaskExtended
**File**: `src/workflows/executors/agent-task.ts`
**Changes**:
- In the `execute()` method's `createTaskExtended()` call (lines 64-72), add the new fields:
  ```typescript
  dir: config.dir,
  vcsRepo: config.vcsRepo,
  model: config.model,
  parentTaskId: config.parentTaskId,
  ```

#### 3. Unit test
**File**: `src/tests/workflow-agent-task.test.ts` (new file)
**Changes**:
- Test that `AgentTaskConfigSchema` parses configs with new fields
- Test that `execute()` creates tasks with `dir`, `vcsRepo`, `model`, `parentTaskId` set
- Use isolated SQLite DB (pattern from existing tests)

### Success Criteria:

#### Automated Verification:
- [ ] Types pass: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] New test passes: `bun test src/tests/workflow-agent-task.test.ts`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] Create a workflow with `agent-task` node that includes `dir: "/workspace/repos/agent-swarm"` and verify the created task has `dir` set via `GET /api/tasks`
- [ ] Create a workflow with interpolated `dir: "{{repo_path}}"` and trigger with `{ "repo_path": "/workspace/repos/test" }` — verify interpolation works

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Validation Retry Bug Fix

### Overview
Fix the retry poller to re-run `runStepValidation()` after successfully re-executing a step that was retried due to validation failure. Currently, the poller bypasses validation on retry, meaning a step's output is only validated on its first execution.

### Changes Required:

#### 1. Add validation re-check in retry poller
**File**: `src/workflows/retry-poller.ts`
**Changes**:
- After the executor succeeds (around line 96), before calling `checkpointStep()`:
  1. Check if the node has a `validation` config
  2. If yes, call `runStepValidation()` with the result output
  3. If validation returns `"retry"`: call `checkpointStepFailure()` again (same as lines 84-95) to schedule another retry, and `continue` to the next step
  4. If validation returns `"halt"`: mark step and run as failed
  5. If validation returns `"pass"`: proceed to `checkpointStep()` as before
- Import `runStepValidation` from `./validation`

#### 2. Unit test
**File**: `src/tests/workflow-retry-validation.test.ts` (new file)
**Changes**:
- Test: step with validation + retry → first execution fails validation → retry poller re-executes → poller re-validates the result
- Test: retry succeeds but validation still fails → another retry is scheduled (not infinite — respects maxRetries)
- Test: retry succeeds and validation passes → step checkpointed, graph continues

### Success Criteria:

#### Automated Verification:
- [ ] Types pass: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] New test passes: `bun test src/tests/workflow-retry-validation.test.ts`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] Create a workflow with `raw-llm` node + inline validation (`mustPass: true`, `retry: { maxRetries: 3 }`). The validation should be strict enough to sometimes fail. Trigger the workflow and verify via `GET /api/workflow-runs/<id>` that validation runs on each retry attempt (check step history/retryCount).

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Structured Output Extraction for Agent-Tasks

### Overview
Add `outputSchema` support to tasks. When set, the agent is prompted to produce structured output, `store-progress` validates it inline (failing the tool call, not the task, on mismatch), and the Claude adapter provides a fallback extraction if the session ends without valid structured output.

### Changes Required:

#### 1. Add outputSchema to AgentTaskSchema
**File**: `src/types.ts`
**Changes**:
- Add to `AgentTaskSchema` (near line 98):
  ```typescript
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  ```
- This represents a JSON Schema object that the task output must conform to.

#### 2. Store outputSchema in DB
**File**: `src/be/db.ts`
**Changes**:
- Add `outputSchema` to `CreateTaskOptions` interface (near line 1733):
  ```typescript
  outputSchema?: Record<string, unknown>;
  ```
- In `createTaskExtended()` SQL INSERT (lines 1822-1871): store `outputSchema` as a JSON-stringified column. If the column doesn't exist yet, add a migration.
- Check: does `agent_tasks` table already have an `outputSchema` column? If not, create migration `NNN_add_output_schema.sql`:
  ```sql
  ALTER TABLE agent_tasks ADD COLUMN outputSchema TEXT;
  ```

#### 3. Validate structured output in store-progress
**File**: `src/tools/store-progress.ts`
**Changes**:
- After the terminal state guard (line 106) and before `completeTask()` call (line 124):
  1. Load the task's `outputSchema` (already have the task object from line 95)
  2. If `outputSchema` is set and `status === "completed"` and `output` is provided:
     a. Try `JSON.parse(output)`
     b. If not valid JSON: return a tool error (NOT task failure) with message explaining the output must be valid JSON matching the schema. Include the schema in the error.
     c. If valid JSON: validate against `outputSchema` using `validateJsonSchema()` (from `src/workflows/json-schema-validator.ts`)
     d. If validation fails: return a tool error with the validation errors, asking the agent to retry
     e. If validation passes: proceed to `completeTask()` as normal
- This gives the agent multiple chances to produce correct output within the same session.
- **Validator limitation**: `validateJsonSchema()` currently only supports `type`, `required`, `properties`. Before using it here, extend it to also support `enum` and `const` (common in task output schemas). Add these checks in `json-schema-validator.ts` alongside the existing `type`/`required`/`properties` handling. Other advanced JSON Schema features (`pattern`, `anyOf`, `$ref`, etc.) are out of scope.

#### 4. Prompt injection for outputSchema
**File**: `src/commands/runner.ts`
**Changes**:
- In `buildPromptForTrigger()` (around line 892-903), after building the task_assigned prompt:
  1. Check if `trigger.task.outputSchema` exists
  2. If yes, append a section to the prompt:
     ```
     **Required Output Format**: When completing this task, you MUST call store-progress with output that is valid JSON conforming to this schema:
     ```json
     <JSON.stringify(outputSchema, null, 2)>
     ```
     Call store-progress with status "completed" and your JSON output. If your output doesn't match the schema, the tool call will fail and you should fix and retry.
     ```

#### 5. Structured output fallback in runner completion path
**File**: `src/commands/runner.ts`
**Changes**:

The existing `ensureTaskFinished()` is a simple safety net (POST status based on exit code). Rather than expanding it, extract the structured output logic into a new helper function:

- Add `async function handleStructuredOutputFallback(config: ApiConfig, taskId: string, adapterType: "claude" | "pi-mono"): Promise<string | null>`:
  1. Fetch the task via `GET /api/tasks/${taskId}` (returns task + logs)
  2. If no `outputSchema` on the task: return `null` (no-op)
  3. If the task already has `output` stored (agent called `store-progress` successfully): return `null` (already handled)
  4. **Adapter branching**:
     - **Claude adapter**: Build an extraction prompt and run fallback:
       - Build prompt from task description + progress history (filter `task.logs` for `eventType === "task_progress"`, sort chronologically, format as numbered entries) + output schema
       - The prompt structure:
         ```
         Extract structured data from this task's execution history.

         ## Task Description
         ${task.description}

         ## Progress Updates (chronological)
         ${progressEntries.map((log, i) => `${i+1}. [${log.createdAt}] ${log.newValue}`).join("\n")}

         ## Required Output Schema
         ${JSON.stringify(task.outputSchema, null, 2)}

         Extract the structured data from the progress updates above. Return ONLY valid JSON matching the schema.
         ```
       - Run extraction:
         ```typescript
         const result = await Bun.$`claude -p ${extractionPrompt} --json-schema ${JSON.stringify(schema)} --output-format json --model sonnet`.json();
         ```
       - Return `result.structured_output` as stringified JSON, or `null` on failure
     - **Pi-mono adapter**: Return a special sentinel (e.g., throw or return error string) that signals "fail the task" with reason: `"Structured output required by outputSchema but not provided via store-progress"`

- Modify `ensureTaskFinished()` to call the helper before POST:
  1. If `exitCode === 0`: call `handleStructuredOutputFallback(config, taskId, adapterType)`
  2. If it returns structured output: use it as the `output` in the finish POST
  3. If it signals failure (Pi-mono): change status to `"failed"` with the structured output failure reason
  4. If it returns `null`: proceed with existing behavior (raw fallback output)

- The `adapterType` is available in the runner's process state (`state.activeTasks` tracks which adapter spawned each process). Pass it to `ensureTaskFinished()` as a new parameter.

#### 6. JSON-parse structured output in workflow resume
**File**: `src/workflows/resume.ts`
**Changes**:
- In `resumeFromTaskCompletion()` (line 77), where `stepOutput` is built:
  ```typescript
  // Before:
  const stepOutput = { taskId: event.taskId, taskOutput: event.output };
  // After:
  let taskOutput: unknown = event.output;
  if (event.output) {
    try {
      const parsed = JSON.parse(event.output);
      if (typeof parsed === "object" && parsed !== null) {
        taskOutput = parsed;
      }
    } catch {
      // Not JSON — keep as string (non-structured output tasks)
    }
  }
  const stepOutput = { taskId: event.taskId, taskOutput };
  ```
- This ensures that when a task with `outputSchema` completes, the structured JSON is stored as a parsed object in the workflow context. Downstream nodes can then access nested fields via `{{task1.taskOutput.fileCount}}` through the `interpolate()` dot-path walker (template.ts:18-24).
- For non-structured tasks that produce plain text, the `JSON.parse()` will either fail (caught, keeps string) or parse to a non-object (keeps string). No behavioral change for existing workflows.

#### 8. Forward outputSchema from workflow config
**File**: `src/workflows/executors/agent-task.ts`
**Changes**:
- Add to `AgentTaskConfigSchema`:
  ```typescript
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  ```
- Forward in `createTaskExtended()` call:
  ```typescript
  outputSchema: config.outputSchema,
  ```

#### 9. Unit tests
**File**: `src/tests/structured-output.test.ts` (new file)
**Changes**:
- Test: store-progress with valid JSON matching schema → task completes successfully
- Test: store-progress with invalid JSON → tool call fails with error message, task stays in_progress
- Test: store-progress with valid JSON not matching schema → tool call fails with validation errors
- Test: store-progress without outputSchema → no validation, behaves as before
- Test: AgentTaskConfigSchema parses outputSchema
- Test: createTaskExtended stores outputSchema
- Test: resume.ts JSON-parses structured output → downstream context has parsed object
- Test: resume.ts non-JSON output → downstream context keeps string (backward compat)
- Test: `validateJsonSchema()` handles `enum` and `const` constraints correctly

### Success Criteria:

#### Automated Verification:
- [ ] Types pass: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] New test passes: `bun test src/tests/structured-output.test.ts`
- [ ] All tests pass: `bun test`
- [ ] Migration applies cleanly on fresh DB: `rm -f /tmp/test-migration.sqlite && DB_PATH=/tmp/test-migration.sqlite bun run start:http` (verify no errors, then Ctrl+C)

#### Manual Verification:
- [ ] Create a task with `outputSchema` via API, assign to a worker, verify the agent sees the schema in its prompt
- [ ] Verify store-progress rejects malformed output (agent retries within session)
- [ ] Verify store-progress accepts valid structured output
- [ ] Create a workflow with `agent-task` node + `outputSchema`, verify the downstream node receives structured data (not a raw string) via `GET /api/workflow-runs/<id>` context inspection
- [ ] Verify Claude adapter fallback: kill agent session before it calls store-progress, verify fallback extraction produces structured output

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Validation Executor Adapters

### Overview
Normalize the pass/fail contract so any executor type can be used as a validator. Add an adapter layer in the validation system that maps each executor's output shape to `{ pass: boolean }`.

### Changes Required:

#### 1. Add pass/fail adapter mapping
**File**: `src/workflows/validation.ts`
**Changes**:
- Add a function `extractPassResult(executorType: string, output: unknown): boolean` that normalizes executor outputs:
  ```typescript
  function extractPassResult(executorType: string, output: unknown): boolean {
    if (!output || typeof output !== "object") return false;
    const o = output as Record<string, unknown>;

    switch (executorType) {
      case "validate":
        return o.pass === true;
      case "script":
        return o.exitCode === 0;
      case "property-match":
        return o.passed === true;
      case "raw-llm":
        // For raw-llm used as validator, check if the LLM output
        // contains a structured pass result
        if (typeof o.result === "object" && o.result !== null) {
          return (o.result as Record<string, unknown>).pass === true;
        }
        return false;
      default:
        // Generic fallback: check for common pass indicators
        return o.pass === true || o.passed === true || o.exitCode === 0;
    }
  }
  ```
- Replace the hardcoded check at line 53-56:
  ```typescript
  // Before:
  const passed = result.output && (result.output as { pass?: boolean }).pass === true;
  // After:
  const passed = extractPassResult(executorType, result.output);
  ```
  Where `executorType` is the resolved executor type from `validation.executor` (already available at line 30).

#### 2. Unit tests
**File**: `src/tests/validation-adapters.test.ts` (new file)
**Changes**:
- Test: `validate` executor output `{ pass: true }` → passes
- Test: `validate` executor output `{ pass: false }` → fails
- Test: `script` executor output `{ exitCode: 0 }` → passes
- Test: `script` executor output `{ exitCode: 1 }` → fails
- Test: `property-match` executor output `{ passed: true }` → passes
- Test: `property-match` executor output `{ passed: false }` → fails
- Test: unknown executor with `{ pass: true }` → passes (generic fallback)
- Test: null/undefined output → fails

### Success Criteria:

#### Automated Verification:
- [ ] Types pass: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] New test passes: `bun test src/tests/validation-adapters.test.ts`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] Create a workflow with a `script` executor used as validator. Use a command that exits 0 on pass (`{ "executor": "script", "config": { "command": "test $(echo '$OUTPUT' | jq -r '.result') != ''" } }`). Verify the process exit code (0 = pass, non-zero = fail) maps correctly through the adapter.
- [ ] Create a workflow with `property-match` executor as validator. Verify `passed` field maps correctly.

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

**Unit tests**: Each phase adds its own test file. Tests use isolated SQLite DBs with `initDb()`/`closeDb()` lifecycle.

**Integration tests**: Manual E2E via API + Docker workers (see research doc's E2E scenarios). Not automated in CI — these require Docker workers.

**Regression**: `bun test` runs all existing tests to catch regressions.

## Manual E2E Verification

After all phases are complete, run the full E2E scenario from the research doc:

```bash
# Setup
rm -f agent-swarm-db.sqlite*
bun run start:http &
bun run docker:build:worker

docker run --rm -d --name e2e-lead \
  --env-file .env.docker-lead -e AGENT_ROLE=lead \
  -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest

docker run --rm -d --name e2e-worker \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

sleep 15

# 1. Workspace scoping: task with dir
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "name": "e2e-workspace-test",
    "nodes": [{"id": "t1", "type": "agent-task", "config": {"template": "List files in current dir", "dir": "/workspace/repos/agent-swarm"}}],
    "trigger": {"type": "manual"}
  }'
# Trigger and verify task.dir is set

# 2. Structured output: task with outputSchema
curl -s -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "description": "Count files in /tmp. Report as JSON.",
    "outputSchema": {"type": "object", "properties": {"fileCount": {"type": "number"}}, "required": ["fileCount"]}
  }'
# Verify agent sees schema in prompt, output is structured JSON

# 3. Validation retry: node with mustPass + retry
curl -s -X POST http://localhost:3013/api/workflows \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{
    "name": "e2e-validation-retry",
    "nodes": [{"id": "llm1", "type": "raw-llm", "config": {"prompt": "Generate a random number 1-100", "model": "google/gemini-3-flash-preview"}, "validation": {"executor": "validate", "config": {"prompt": "Is the number > 50?"}, "mustPass": true, "retry": {"maxRetries": 3, "strategy": "static", "baseDelayMs": 1000}}}],
    "trigger": {"type": "manual"}
  }'
# Verify validation runs on each retry

# Cleanup
docker stop e2e-lead e2e-worker
kill $(lsof -ti :3013)
```

## References

- Research: `thoughts/taras/research/2026-03-19-workflow-structured-output-validation-workspace.md`
- Prior research: `thoughts/taras/research/2026-03-19-workflow-node-io-schemas-and-bugs.md`
- Prior plan: `thoughts/taras/plans/2026-03-18-workflow-redesign.md`
- Prior plan: `thoughts/taras/plans/2026-03-19-workflow-io-schemas-and-bugs.md`

---

## Review Errata

_Reviewed: 2026-03-20 by claude_

All findings have been addressed in the plan above.

### Resolved

- [x] **Contradiction about migration** — Removed incorrect "no migration needed" claim from "What We're NOT Doing". Phase 3 step 2 correctly adds migration.
- [x] **Structured output flows as string in workflow context** — Added Phase 3 step 6: JSON-parse structured output in `resume.ts` before storing in workflow context. Ensures `{{task1.taskOutput.fileCount}}` interpolation works.
- [x] **`validateJsonSchema()` is minimal** — Added note to "What We're NOT Doing" about scope. Phase 3 step 3 now includes extending the validator to support `enum` and `const`. Added unit test for validator extensions.
- [x] **Pi-mono adapter failure path unspecified** — Phase 3 step 5 now specifies adapter branching: Claude runs fallback extraction, Pi-mono fails with descriptive reason.
- [x] **`ensureTaskFinished()` refactoring scope** — Restructured Phase 3 step 5 to extract logic into `handleStructuredOutputFallback()` helper, keeping `ensureTaskFinished()` simple with a single call to the helper.
- [x] **Phase 4 script executor test example** — Replaced misleading `echo` command with `test` command that uses actual process exit code.
