# Ralph Wiggum Iterative Task Processing Implementation Plan

## Overview

Add "Ralph Wiggum" iterative task processing to agent-swarm. Tasks with `taskType: 'ralph'` automatically run in a loop where context resets between iterations but code/files persist, enabling long-running autonomous development tasks.

## Current State Analysis

### How It Works Now

1. **Runner** (`src/commands/runner.ts:520-638`): Polls for triggers via HTTP API, spawns Claude per trigger
2. **Task System** (`src/types.ts:3-54`): Tasks have `taskType` field (string, max 50 chars) and status workflow
3. **Hooks** (`src/hooks/hook.ts`): Handle `PreCompact`, `Stop`, and other events
4. **Send-task Tool** (`src/tools/send-task.ts`): Creates tasks with metadata fields

### Key Discoveries

- Runner already has iteration tracking at `src/commands/runner.ts:518`
- `PreCompact` hook fires when context is filling up at `src/hooks/hook.ts:246`
- Task creation supports extended options at `src/be/db.ts:1024`
- Thoughts directory structure exists at `thoughts/shared/plans/`

## Desired End State

After this implementation:

1. Tasks with `taskType: 'ralph'` run in iterative loop mode
2. Agent can signal completion via `ralph-complete` tool
3. PreCompact hook writes checkpoint to signal context-full state
4. Runner detects Ralph tasks and handles with special loop logic
5. Plan files persist state between iterations

### Verification

- `bun test` passes with new Ralph tests
- Creating a Ralph task triggers loop mode in runner
- PreCompact hook creates checkpoint file for Ralph tasks
- `ralph-complete` tool ends the loop and marks task complete

## What We're NOT Doing

- Not replacing the existing runner-level polling (Ralph is an additional mode)
- Not changing how non-Ralph tasks work
- Not implementing the full Ralph Wiggum plugin (just core iteration mechanics)
- Not adding UI for Ralph task management (API only for now)

## Implementation Approach

We'll implement this in seven phases:

1. **Phase 1**: Add Ralph fields to task schema and database
2. **Phase 2**: Create checkpoint state management system
3. **Phase 3**: Create `ralph-complete` MCP tool
4. **Phase 4**: Enhance hooks for Ralph mode detection
5. **Phase 5**: Add Ralph loop handler to runner
6. **Phase 6**: Add Ralph prompting strategy
7. **Phase 7**: Update API and send-task tool for Ralph creation

---

## Phase 1: Task Schema - Ralph Fields

### Overview

Add Ralph-specific metadata fields to track iteration state and completion promise.

### Changes Required:

#### 1. Types
**File**: `src/types.ts`
**Changes**: Add Ralph fields to `AgentTaskSchema` after line 45

```typescript
// Ralph loop metadata
ralphPromise: z.string().optional(),
ralphIterations: z.number().int().min(0).default(0),
ralphMaxIterations: z.number().int().min(1).default(50),
ralphLastCheckpoint: z.iso.datetime().optional(),
ralphPlanPath: z.string().optional(),
```

#### 2. Database Schema
**File**: `src/be/db.ts`
**Changes**: Add migrations after existing ALTER statements (~line 302)

```typescript
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN ralphPromise TEXT`); } catch {}
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN ralphIterations INTEGER DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN ralphMaxIterations INTEGER DEFAULT 50`); } catch {}
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN ralphLastCheckpoint TEXT`); } catch {}
try { db.run(`ALTER TABLE agent_tasks ADD COLUMN ralphPlanPath TEXT`); } catch {}
```

Update `AgentTaskRow` type (~line 476), `rowToAgentTask()` function, `CreateTaskOptions` interface (~line 1024), and `createTaskExtended()` to handle new fields.

#### 3. Add updateRalphState Function
**File**: `src/be/db.ts`
**Changes**: Add new function after `updateTaskProgress()`

```typescript
export function updateRalphState(
  taskId: string,
  updates: { iterations?: number; lastCheckpoint?: string; promise?: string }
): AgentTask | null
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun tsc --noEmit`
- [ ] Database initializes without errors
- [ ] Tests pass: `bun test`

#### Manual Verification:
- [ ] New columns visible in SQLite schema

---

## Phase 2: Ralph Checkpoint State Management

### Overview

Create a checkpoint system for signaling between hooks and runner using filesystem.

### Changes Required:

#### 1. Create State Module
**File**: `src/ralph/state.ts` (NEW)

```typescript
import { join } from "node:path";

const RALPH_STATE_DIR = process.env.RALPH_STATE_DIR || "/tmp/ralph-state";

export interface RalphCheckpoint {
  taskId: string;
  iteration: number;
  contextFull: boolean;
  timestamp: string;
  checkpointReason: "precompact" | "stop" | "manual";
}

export async function writeCheckpoint(checkpoint: RalphCheckpoint): Promise<string> {
  const dir = RALPH_STATE_DIR;
  await Bun.$`mkdir -p ${dir}`.quiet();
  const filePath = join(dir, `${checkpoint.taskId}.checkpoint.json`);
  await Bun.write(filePath, JSON.stringify(checkpoint, null, 2));
  return filePath;
}

export async function readCheckpoint(taskId: string): Promise<RalphCheckpoint | null> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return await file.json();
  }
  return null;
}

export async function clearCheckpoint(taskId: string): Promise<void> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  try {
    await Bun.$`rm -f ${filePath}`.quiet();
  } catch {}
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles
- [ ] Unit tests pass for checkpoint operations

---

## Phase 3: Ralph-Complete Tool

### Overview

Create MCP tool for agents to signal task completion with evidence.

### Changes Required:

#### 1. Create Tool
**File**: `src/tools/ralph-complete.ts` (NEW)

Input schema:
- `taskId: z.uuid()` - Task to complete
- `summary: z.string().min(10)` - What was accomplished
- `promiseEvidence: z.string().min(10)` - Evidence that promise was met
- `artifactPaths: z.array(z.string()).optional()` - Key artifact paths

Behavior:
- Validates task is Ralph type and assigned to caller
- Marks task as completed with structured output
- Sets agent status to idle

#### 2. Register Tool
**File**: `src/server.ts`
**Changes**: Add import and registration

```typescript
import { registerRalphCompleteTool } from "@/tools/ralph-complete";
// In createServer():
registerRalphCompleteTool(server);
```

### Success Criteria:

#### Automated Verification:
- [ ] Tool appears in MCP tool list
- [ ] TypeScript compiles
- [ ] Tool validates Ralph task type before allowing completion

---

## Phase 4: Hook Enhancements

### Overview

Enhance PreCompact and Stop hooks to detect Ralph mode and signal checkpoints.

### Changes Required:

#### 1. Update Hook Handler
**File**: `src/hooks/hook.ts`

Add import:
```typescript
import { writeCheckpoint } from "@/ralph/state";
```

Add helper function:
```typescript
async function getRalphTaskForAgent(agentId: string, baseUrl: string, headers: Record<string, string>): Promise<AgentTask | null> {
  // Fetch active in_progress Ralph task for agent via API
}
```

Update `PreCompact` case (~line 246):
```typescript
case "PreCompact":
  if (agentInfo) {
    const ralphTask = await getRalphTaskForAgent(agentInfo.id, getBaseUrl(), mcpConfig?.headers || {});
    if (ralphTask) {
      await writeCheckpoint({
        taskId: ralphTask.id,
        iteration: ralphTask.ralphIterations || 0,
        contextFull: true,
        timestamp: new Date().toISOString(),
        checkpointReason: "precompact",
      });
      console.log(`[RALPH] Context 80% full for task ${ralphTask.id}. Checkpoint written.`);
      console.log(`If completion promise is met, call ralph-complete before session ends.`);
    }
  }
  break;
```

Update `Stop` case to also write checkpoint for Ralph tasks.

### Success Criteria:

#### Automated Verification:
- [ ] PreCompact hook writes checkpoint file for Ralph tasks
- [ ] Stop hook writes final checkpoint
- [ ] Checkpoint files created in `/tmp/ralph-state/`

---

## Phase 5: Runner Ralph Loop Handler

### Overview

Modify runner to detect Ralph tasks and handle with special iteration logic.

### Changes Required:

#### 1. Add Helper Functions
**File**: `src/commands/runner.ts`

```typescript
import { readCheckpoint, clearCheckpoint } from "@/ralph/state";
import { updateRalphState, getTaskById } from "@/be/db";

function isRalphTask(task: AgentTask): boolean {
  return task.taskType === "ralph";
}

function buildRalphIterationPrompt(task: AgentTask, iteration: number): string {
  // Build iteration-specific prompt with plan reference
}
```

#### 2. Add Ralph Loop Function
**File**: `src/commands/runner.ts`

```typescript
interface RalphLoopOptions {
  task: AgentTask;
  role: string;
  logDir: string;
  sessionId: string;
  resolvedSystemPrompt: string;
  additionalArgs?: string[];
  apiUrl: string;
  apiKey: string;
  agentId: string;
  isYolo: boolean;
  metadataType: string;
}

async function runRalphLoop(opts: RalphLoopOptions): Promise<void> {
  // 1. Clear stale checkpoint
  // 2. Loop until max iterations:
  //    - Build iteration prompt
  //    - Update task iteration count
  //    - Run Claude iteration
  //    - Check if task completed (ralph-complete called)
  //    - Check for checkpoint (context was full)
  //    - Continue to next iteration
}
```

#### 3. Integrate with Trigger Handler
In polling loop (~line 570), after detecting `task_assigned`:

```typescript
if (trigger.type === "task_assigned" && trigger.task) {
  const task = trigger.task as AgentTask;
  if (isRalphTask(task)) {
    await runRalphLoop({ task, ...opts });
    continue;
  }
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Ralph tasks detected by `taskType === 'ralph'`
- [ ] Special prompt built for each iteration
- [ ] Loop continues until `ralph-complete` or max iterations
- [ ] Checkpoint detection triggers new iteration

#### Manual Verification:
- [ ] Create Ralph task, assign to agent, observe loop behavior
- [ ] Verify iteration count increments correctly
- [ ] Test max iteration limit

---

## Phase 6: Prompting Strategy

### Overview

Add Ralph-specific guidance to system prompts.

### Changes Required:

#### 1. Base Prompt Addition
**File**: `src/prompts/base-prompt.ts`

Add `BASE_PROMPT_RALPH` constant with:
- Context resets but code persists explanation
- Progress file usage (`thoughts/shared/ralph/{taskId}/progress.md`)
- Context warning behavior
- `ralph-complete` tool usage instructions

Update `getBasePrompt()` to include Ralph prompt when task is Ralph type.

### Success Criteria:

#### Automated Verification:
- [ ] Ralph system prompt included when processing Ralph task
- [ ] TypeScript compiles

---

## Phase 7: API and Tool Updates

### Overview

Enable Ralph task creation via API and send-task tool.

### Changes Required:

#### 1. Update Task Creation Endpoint
**File**: `src/http.ts`

In POST /api/tasks:
- Accept Ralph fields: `ralphPromise`, `ralphMaxIterations`, `ralphPlanPath`
- Validate: Ralph tasks require `ralphPromise`

#### 2. Update send-task Tool
**File**: `src/tools/send-task.ts`

Add to input schema:
```typescript
ralphPromise: z.string().optional().describe("For Ralph tasks: completion criteria"),
ralphMaxIterations: z.number().int().min(1).max(100).optional(),
ralphPlanPath: z.string().optional().describe("Path to plan file in thoughts/"),
```

### Success Criteria:

#### Automated Verification:
- [ ] POST /api/tasks accepts Ralph fields
- [ ] send-task tool supports Ralph creation
- [ ] Validation rejects Ralph tasks without promise

---

## Testing Strategy

### Unit Tests

**File**: `src/tests/ralph.test.ts` (NEW)

```typescript
import { test, expect } from "bun:test";

test("create Ralph task with promise", () => { /* ... */ });
test("update Ralph iteration state", () => { /* ... */ });
test("checkpoint file operations", async () => { /* ... */ });
```

### Manual Testing Steps

1. Start server: `bun run src/index.ts`
2. Create Ralph task:
   ```bash
   curl -X POST http://localhost:3013/api/tasks \
     -H "Content-Type: application/json" \
     -d '{
       "task": "Create hello.ts that outputs Hello World",
       "taskType": "ralph",
       "ralphPromise": "hello.ts exists and outputs Hello World when run"
     }'
   ```
3. Start worker agent and observe loop behavior
4. Test ralph-complete ends loop
5. Test PreCompact checkpoint triggers new iteration

## Performance Considerations

- **Context reset between iterations**: Fresh context each iteration prevents degradation
- **Checkpoint file I/O**: Minimal overhead, uses `/tmp` filesystem
- **Iteration limits**: Default 50, configurable per task

## Migration Notes

- **Backwards compatible**: Non-Ralph tasks work exactly as before
- **Database migrations**: Additive only, no breaking changes
- **No data migration needed**: New fields have sensible defaults

## References

- Ralph Wiggum approach: https://awesomeclaude.ai/ralph-wiggum
- Runner implementation: `src/commands/runner.ts:520-638`
- Hook system: `src/hooks/hook.ts`
- Task schema: `src/types.ts:3-54`
- Similar plan: `thoughts/shared/plans/2025-12-23-runner-level-polling.md`
