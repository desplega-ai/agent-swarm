---
date: 2026-01-13
author: master lord
git_commit: 5ce502b
branch: main
repository: agent-swarm
topic: "Agent Concurrency - Parallel Claude Subprocess Execution"
tags: [plan, concurrency, runner, parallel-execution, capacity-management]
status: complete
last_updated: 2026-01-13T16:20:00Z
---

## Implementation Progress Summary

**COMPLETE - All implementation and manual verification finished.**

### Completed:
- [x] Phase 1: Database and Type Changes
- [x] Phase 2: Task Assignment Capacity Checks
- [x] Phase 3: Runner Parallel Execution
- [x] Phase 4: API and Registration Updates
- [x] Phase 5: Integration Testing (automated tests)

### Bug Fixes Applied:
1. **Poll endpoint marking tasks in_progress** (`src/http.ts:369-380`) - Fixed duplicate task polling by marking tasks as `in_progress` when returned via poll API
2. **Process completion detection** (`src/commands/runner.ts:684-699`) - Fixed using `task.process.exitCode !== null` instead of broken `Promise.race` pattern
3. **Poll endpoint capacity check** (`src/http.ts:371-384`) - Added server-side capacity check before returning pending tasks to prevent exceeding maxTasks
4. **Agent registration maxTasks sync** (`src/http.ts:315-318`, `src/be/db.ts:529-537`) - Added `updateAgentMaxTasks()` function and updated registration endpoint to sync `MAX_CONCURRENT_TASKS` env var to database when agent re-registers

### Remaining Manual Verification:
- [x] Phase 2: Capacity enforcement test - VERIFIED (2026-01-13)
- [x] Phase 3: Concurrent execution test - VERIFIED (server-side enforces maxTasks, tasks queue correctly)
- [x] Phase 4: API capacity response - VERIFIED (maxTasks shows in agent responses)
- [x] Phase 5: Full end-to-end test - VERIFIED (tasks queue when at capacity, process when slots free)

---

# Agent Concurrency Implementation Plan

## Overview

Add support for parallel Claude subprocess execution to the agent-swarm system, allowing leads and workers to handle multiple tasks concurrently. Each agent will have a configurable maximum concurrency limit (default: 1 for backwards compatibility).

## Current State Analysis

The current architecture is strictly sequential:

1. **Runner loop** (`src/commands/runner.ts:573-661`) polls for one trigger at a time and **blocks until Claude completes** before polling for the next trigger
2. **Agent status** is binary: `idle`, `busy`, `offline` (`src/types.ts:97`)
3. **Task assignment** is blocked when agent is not `idle` (`src/tools/send-task.ts:119-125`)
4. **Status management**: `store-progress.ts:91,99` sets agent to `idle` on task completion

### Key Files:
- `src/commands/runner.ts` - Main runner loop (lines 573-661)
- `src/types.ts` - Agent and task schemas
- `src/be/db.ts` - Database operations
- `src/http.ts` - HTTP API including `/api/poll` (lines 316-425)
- `src/tools/send-task.ts` - Task assignment logic
- `src/tools/store-progress.ts` - Task completion handling
- `src/tools/poll-task.ts` - MCP polling tool

## Desired End State

After implementation:
- Agents can run N Claude subprocesses concurrently (configurable via `MAX_CONCURRENT_TASKS` env var)
- Runner spawns Claude without blocking, tracking active processes in a Map
- Capacity is checked before task assignment (not binary idle/busy)
- Tasks queue in `pending` status when agent is at capacity, picked up when slots open
- Status derived from active task count (`idle` = 0 tasks, `busy` = 1+ tasks)
- Default limit is 1 (backwards compatible)

### Verification:
1. Set `MAX_CONCURRENT_TASKS=3` and send 3 tasks to a worker
2. All 3 Claude processes should run simultaneously
3. A 4th task should queue in `pending` until one completes
4. Agent status shows `busy` while any task is running

## What We're NOT Doing

- NOT changing the MCP `poll-task` tool (it's for AI-loop mode, mostly unused)
- NOT adding a formal job queue system (simple Promise tracking is sufficient)
- NOT using PM2 for subprocess management (overkill for this)
- NOT changing the lead inbox model (leads still process inbox triggers)
- NOT implementing task priority-based scheduling (FIFO from pending queue)

## Implementation Approach

**Capacity Model**: Track `maxTasks` per agent in the database, derive active count from `agent_tasks` table where `status = 'in_progress'`. This ensures accuracy without stale state.

**Process Model**: Track running Claude processes in a `Map<taskId, Promise<number>>` within the runner. Poll for new triggers when under capacity, spawn without blocking.

**Status Derivation**: Keep `idle/busy/offline` status but derive from active task count. Agent is `idle` when no in-progress tasks, `busy` otherwise.

---

## Phase 1: Database and Type Changes

### Overview
Add capacity tracking fields to the agent schema and database, implement helper functions.

### Changes Required:

#### 1. Update Agent Schema
**File**: `src/types.ts`

Add `maxTasks` field to `AgentSchema`:

```typescript
export const AgentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  isLead: z.boolean().default(false),
  status: AgentStatusSchema,

  // Profile fields
  description: z.string().optional(),
  role: z.string().max(100).optional(),
  capabilities: z.array(z.string()).default([]),

  // NEW: Concurrency limit
  maxTasks: z.number().int().min(1).max(20).default(1),

  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),
});
```

#### 2. Database Schema Migration
**File**: `src/be/db.ts`

Add column to agents table in `initDb()` (around line 42):

```sql
ALTER TABLE agents ADD COLUMN maxTasks INTEGER DEFAULT 1;
```

Handle migration for existing databases by checking if column exists.

#### 3. Add Capacity Functions
**File**: `src/be/db.ts`

Add new functions after `updateAgentStatus()` (around line 520):

```typescript
export function getActiveTaskCount(agentId: string): number {
  const result = getDb()
    .prepare<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE agentId = ? AND status = 'in_progress'"
    )
    .get(agentId);
  return result?.count ?? 0;
}

export function hasCapacity(agentId: string): boolean {
  const agent = getAgentById(agentId);
  if (!agent) return false;
  const activeCount = getActiveTaskCount(agentId);
  return activeCount < (agent.maxTasks ?? 1);
}

export function getRemainingCapacity(agentId: string): number {
  const agent = getAgentById(agentId);
  if (!agent) return 0;
  const activeCount = getActiveTaskCount(agentId);
  return Math.max(0, (agent.maxTasks ?? 1) - activeCount);
}

export function updateAgentStatusFromCapacity(agentId: string): void {
  const agent = getAgentById(agentId);
  if (!agent || agent.status === 'offline') return;

  const activeCount = getActiveTaskCount(agentId);
  const newStatus = activeCount > 0 ? 'busy' : 'idle';

  if (agent.status !== newStatus) {
    updateAgentStatus(agentId, newStatus);
  }
}
```

#### 4. Update Agent Registration
**File**: `src/be/db.ts`

Modify `createAgent()` to accept `maxTasks` parameter.

### Success Criteria:

#### Automated Verification:
- [x] Type checks pass: `bun run typecheck` (if script exists) or no TS errors
- [x] Database migration runs: start server and verify `maxTasks` column exists
- [x] Unit test for capacity functions: `bun test src/tests/db-capacity.test.ts`

#### Manual Verification:
- [x] Query `SELECT * FROM agents` shows `maxTasks` column
- [x] New agents get `maxTasks = 1` by default

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 2: Task Assignment Capacity Checks

### Overview
Replace binary `idle` checks with capacity-based checks in task assignment logic.

### Changes Required:

#### 1. Update send-task Tool
**File**: `src/tools/send-task.ts`

Replace lines 119-125:

```typescript
// OLD:
if (!offerMode && agent.status !== "idle") {
  return {
    success: false,
    message: `Agent "${agent.name}" is not idle (status: ${agent.status}). Cannot assign task directly.`,
  };
}

// NEW:
if (!offerMode && !hasCapacity(agentId)) {
  const activeCount = getActiveTaskCount(agentId);
  return {
    success: false,
    message: `Agent "${agent.name}" is at capacity (${activeCount}/${agent.maxTasks} tasks). Use offerMode: true to offer the task instead, or wait for a task to complete.`,
  };
}
```

Import the new functions at the top.

#### 2. Update store-progress Tool
**File**: `src/tools/store-progress.ts`

Replace lines 86-107:

```typescript
// Handle status change
if (status === "completed") {
  const result = completeTask(taskId, output);
  if (result) {
    updatedTask = result;
    if (existingTask.agentId) {
      // NEW: Derive status from capacity instead of always setting idle
      updateAgentStatusFromCapacity(existingTask.agentId);
    }
  }
} else if (status === "failed") {
  const result = failTask(taskId, failureReason ?? "Unknown failure");
  if (result) {
    updatedTask = result;
    if (existingTask.agentId) {
      updateAgentStatusFromCapacity(existingTask.agentId);
    }
  }
} else {
  // Progress update - ensure status reflects current load
  if (existingTask.agentId) {
    updateAgentStatusFromCapacity(existingTask.agentId);
  }
}
```

#### 3. Update task-action Tool
**File**: `src/tools/task-action.ts`

Add capacity check for `claim` action:

```typescript
case "claim": {
  if (!hasCapacity(agentId)) {
    const activeCount = getActiveTaskCount(agentId);
    const agent = getAgentById(agentId);
    return {
      success: false,
      message: `You have no capacity (${activeCount}/${agent?.maxTasks ?? 1} tasks). Complete a task first.`
    };
  }
  // ... existing claim logic
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type checks pass
- [x] Existing tests still pass: `bun test`
- [x] New test: assign task to agent at capacity, verify rejection message

#### Manual Verification:
- [ ] Set agent `maxTasks = 2`, assign 2 tasks, try to assign 3rd - should get capacity error
- [ ] Complete one task, agent should allow 3rd assignment

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 3: Runner Parallel Execution

### Overview
Transform the runner loop from blocking sequential execution to parallel subprocess management.

**IMPORTANT FIX REQUIRED**: The poll endpoint (`src/http.ts`) must mark tasks as `in_progress` when returning them to prevent duplicate polling. Add `startTask(pendingTask.id)` before returning the `task_assigned` trigger.

### Changes Required:

#### 1. Add Runner State Type
**File**: `src/commands/runner.ts`

Add new interfaces after line 100:

```typescript
interface RunningTask {
  taskId: string;
  process: ReturnType<typeof Bun.spawn>;
  logFile: string;
  startTime: Date;
  promise: Promise<number>;
}

interface RunnerState {
  activeTasks: Map<string, RunningTask>;
  maxConcurrent: number;
}
```

#### 2. Create Non-Blocking Claude Spawner
**File**: `src/commands/runner.ts`

Add new function after `runClaudeIteration()`:

```typescript
function spawnClaudeProcess(opts: RunClaudeIterationOptions): RunningTask {
  const { role, logFile } = opts;
  const Cmd = [
    "claude",
    "--model", "opus",
    "--verbose",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode", "bypassPermissions",
    "-p", opts.prompt,
  ];

  if (opts.additionalArgs?.length) {
    Cmd.push(...opts.additionalArgs);
  }

  if (opts.systemPrompt) {
    Cmd.push("--append-system-prompt", opts.systemPrompt);
  }

  console.log(`[${role}] Spawning Claude for task ${opts.taskId || 'unknown'}`);

  const logFileHandle = Bun.file(logFile).writer();

  const proc = Bun.spawn(Cmd, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Create promise that resolves when process completes
  const promise = (async () => {
    // Stream stdout and stderr (existing logic from runClaudeIteration)
    const stdoutPromise = streamStdout(proc, logFileHandle, opts);
    const stderrPromise = streamStderr(proc, logFileHandle, role);

    await Promise.all([stdoutPromise, stderrPromise]);
    await logFileHandle.end();
    return await proc.exited ?? 1;
  })();

  return {
    taskId: opts.taskId || crypto.randomUUID(),
    process: proc,
    logFile,
    startTime: new Date(),
    promise,
  };
}
```

#### 3. Refactor Main Loop
**File**: `src/commands/runner.ts`

Replace the `while (true)` loop (lines 573-661) in non-AI-loop mode:

```typescript
// Initialize runner state
const state: RunnerState = {
  activeTasks: new Map(),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT_TASKS || "1", 10),
};

console.log(`[${role}] Max concurrent tasks: ${state.maxConcurrent}`);

while (true) {
  await pingServer(apiConfig, role);

  // Check for completed processes
  await checkCompletedProcesses(state, role);

  // Only poll if we have capacity
  if (state.activeTasks.size < state.maxConcurrent) {
    console.log(`[${role}] Polling for triggers (${state.activeTasks.size}/${state.maxConcurrent} active)...`);

    const trigger = await pollForTrigger({
      apiUrl,
      apiKey,
      agentId,
      pollInterval: PollIntervalMs,
      pollTimeout: state.activeTasks.size > 0 ? 5000 : PollTimeoutMs, // Short timeout if tasks running
      since: lastFinishedTaskCheck,
    });

    if (trigger) {
      if (trigger.type === "tasks_finished") {
        lastFinishedTaskCheck = new Date().toISOString();
      }

      console.log(`[${role}] Trigger received: ${trigger.type}`);

      const triggerPrompt = buildPromptForTrigger(trigger, prompt);
      iteration++;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `${logDir}/${timestamp}-${trigger.taskId?.slice(0, 8) || 'notask'}.jsonl`;

      // Spawn without blocking
      const runningTask = spawnClaudeProcess({
        prompt: triggerPrompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
        apiUrl,
        apiKey,
        agentId,
        sessionId,
        iteration,
        taskId: trigger.taskId,
      });

      state.activeTasks.set(runningTask.taskId, runningTask);
      console.log(`[${role}] Started task ${runningTask.taskId} (${state.activeTasks.size}/${state.maxConcurrent} active)`);
    }
  } else {
    console.log(`[${role}] At capacity (${state.activeTasks.size}/${state.maxConcurrent}), waiting for completion...`);
    await Bun.sleep(1000);
  }
}
```

#### 4. Add Process Completion Handler
**File**: `src/commands/runner.ts`

**NOTE**: The original `Promise.race` pattern doesn't work because `Promise.resolve()` always wins the race even against already-resolved promises. Use Bun's native `process.exitCode` check instead:

```typescript
async function checkCompletedProcesses(state: RunnerState, role: string): Promise<void> {
  const completedTasks: string[] = [];

  for (const [taskId, task] of state.activeTasks) {
    // Check if the Bun subprocess has exited (non-blocking)
    if (task.process.exitCode !== null) {
      console.log(`[${role}] Task ${taskId.slice(0, 8)} completed with exit code ${task.process.exitCode}`);
      completedTasks.push(taskId);
    }
  }

  // Remove completed tasks from the map
  for (const taskId of completedTasks) {
    state.activeTasks.delete(taskId);
  }
}
```

#### 5. Update Graceful Shutdown
**File**: `src/commands/runner.ts`

Modify `shutdown` function (around line 65):

```typescript
const shutdown = async (signal: string) => {
  console.log(`\n[${role}] Received ${signal}, shutting down...`);

  // Wait for active tasks with timeout
  if (state && state.activeTasks.size > 0) {
    console.log(`[${role}] Waiting for ${state.activeTasks.size} active tasks to complete (30s timeout)...`);
    const deadline = Date.now() + 30000;

    while (state.activeTasks.size > 0 && Date.now() < deadline) {
      await checkCompletedProcesses(state, role);
      if (state.activeTasks.size > 0) {
        await Bun.sleep(500);
      }
    }

    // Force kill remaining
    for (const [taskId, task] of state.activeTasks) {
      console.log(`[${role}] Force stopping task ${taskId}`);
      task.process.kill("SIGTERM");
    }
  }

  if (apiConfig) {
    await closeAgent(apiConfig, role);
  }
  await savePm2State(role);
  process.exit(0);
};
```

### Success Criteria:

#### Automated Verification:
- [x] Type checks pass
- [x] Existing tests pass: `bun test`
- [ ] New test: spawn agent with `MAX_CONCURRENT_TASKS=2`, assign 2 tasks, verify both run

#### Manual Verification:
- [ ] Start worker with `MAX_CONCURRENT_TASKS=3`
- [ ] Assign 3 tasks rapidly
- [ ] Verify 3 Claude processes are running simultaneously (`ps aux | grep claude`)
- [ ] Verify all 3 complete successfully
- [ ] Test graceful shutdown with active tasks

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 4: API and Registration Updates

### Overview
Update HTTP endpoints and agent registration to support capacity configuration.

### Changes Required:

#### 1. Update Agent Registration
**File**: `src/http.ts`

In `POST /api/agents` handler (around line 280), accept `maxTasks`:

```typescript
const agent = createAgent({
  id: agentId,
  name: body.name,
  isLead: body.isLead ?? false,
  status: "idle",
  description: body.description,
  role: body.role,
  capabilities: body.capabilities,
  maxTasks: body.maxTasks ?? parseInt(process.env.MAX_CONCURRENT_TASKS || "1", 10),
});
```

#### 2. Include Capacity in Agent Responses
**File**: `src/http.ts`

Add capacity info to agent responses:

```typescript
function agentWithCapacity(agent: Agent) {
  const activeCount = getActiveTaskCount(agent.id);
  return {
    ...agent,
    capacity: {
      current: activeCount,
      max: agent.maxTasks ?? 1,
      available: Math.max(0, (agent.maxTasks ?? 1) - activeCount),
    },
  };
}
```

Apply this to `/me`, `GET /api/agents`, and poll responses.

#### 3. Update Runner Registration
**File**: `src/commands/runner.ts`

Update `registerAgent()` to send `maxTasks`:

```typescript
await registerAgent({
  apiUrl,
  apiKey,
  agentId,
  name: agentName,
  isLead: role === "lead",
  capabilities: config.capabilities,
  maxTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || "1", 10),
});
```

### Success Criteria:

#### Automated Verification:
- [x] API tests pass: `bun test src/tests/rest-api.test.ts`
- [x] Agent registration includes `maxTasks`

#### Manual Verification:
- [ ] `GET /me` response includes `capacity` object
- [ ] Start agent with `MAX_CONCURRENT_TASKS=5`, verify API shows `max: 5`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 5: Integration Testing

### Overview
Comprehensive end-to-end testing of the concurrency feature.

### Test Cases:

1. **Backwards Compatibility**
   - Start agent without `MAX_CONCURRENT_TASKS` env var
   - Verify default `maxTasks = 1`
   - Verify sequential execution (only 1 Claude at a time)

2. **Concurrent Execution**
   - Start worker with `MAX_CONCURRENT_TASKS=3`
   - Assign 5 tasks rapidly
   - Verify 3 Claude processes running
   - Verify 2 tasks queued in `pending`
   - As tasks complete, queued tasks start

3. **Capacity Enforcement**
   - Agent at capacity
   - Try to assign directly -> should get capacity error
   - Offer mode should still work

4. **Graceful Shutdown**
   - Start 3 concurrent tasks
   - Send SIGTERM
   - Verify tasks complete before exit (up to 30s)

5. **Status Accuracy**
   - Agent with 2/3 tasks running -> `status: busy`
   - All tasks complete -> `status: idle`
   - New task starts -> `status: busy`

### Success Criteria:

#### Automated Verification:
- [x] All unit tests pass: `bun test`
- [x] New integration test file passes: `bun test src/tests/concurrency.test.ts`

#### Manual Verification:
- [ ] Run through all 5 test cases above
- [ ] Monitor with `ps aux | grep claude` to verify concurrent processes
- [ ] Check UI shows correct capacity info

---

## Testing Strategy

### Unit Tests:
- `getActiveTaskCount()` returns correct count
- `hasCapacity()` returns true/false correctly
- `updateAgentStatusFromCapacity()` sets correct status
- `send-task` rejects at capacity, allows with capacity

### Integration Tests:
- Full flow: register -> assign tasks -> complete -> verify status
- Concurrent spawn verification
- Graceful shutdown with active tasks

### Manual Testing Steps:
1. Start swarm server: `bun run src/server.ts`
2. Start worker with concurrency: `MAX_CONCURRENT_TASKS=3 bun run src/cli.tsx worker`
3. Send 5 tasks via API or lead agent
4. Watch console output for concurrent spawn logs
5. Verify with `ps aux | grep claude` shows 3 processes
6. Wait for completion, verify all tasks marked complete

## Configuration Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_TASKS` | 1 | Maximum concurrent Claude subprocesses per agent |
| `SHUTDOWN_TIMEOUT` | 30000 | Milliseconds to wait for tasks on shutdown |

## References

- Existing runner architecture: `thoughts/shared/research/2025-12-22-runner-loop-architecture.md`
- Runner-level polling plan: `thoughts/shared/plans/2025-12-23-runner-level-polling.md`
- Current implementation: `src/commands/runner.ts:573-661`
