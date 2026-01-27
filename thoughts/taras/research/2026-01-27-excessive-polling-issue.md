---
date: 2026-01-27T09:30:00Z
topic: "Excessive Agent Polling Consuming Credits"
author: Claude
status: complete
---

# Research: Excessive Agent Polling Consuming Credits

**Issue**: Workers continuously polling for tasks at full capacity, consuming excessive API credits

## Problem Description

From the production logs, workers are stuck in a tight loop:
1. All 3 workers are at capacity (3/3)
2. Each worker keeps calling `poll-task` MCP tool every ~1-2 seconds
3. Each poll returns `success: false` (no task available)
4. Workers immediately poll again
5. This continues indefinitely until SIGTERM

## Root Cause Analysis

### The Core Problem

**File**: `src/tools/poll-task.ts:197`

When a Claude instance calls `poll-task` and no task is found after the 60-second timeout, it returns:

```typescript
message: `No task assigned within the polling duration, please keep polling until a task is assigned.`,
```

**This message explicitly instructs Claude to keep polling**, creating an infinite loop where:
1. Claude calls `poll-task`
2. Waits up to 60 seconds (line 17: `MAX_POLL_DURATION_MS = 1 * 60 * 1000`)
3. Gets "no task, please keep polling"
4. Calls `poll-task` again immediately
5. Repeat forever

Each `poll-task` call is an API request that consumes credits.

### Why This Happens

Looking at the logs:

```
✓ Result: {"content":"{\"yourAgentId\":\"16990304...\"success\":false,\"message...
▶ Tool: agent-swarm:poll-task
```

The Claude instances are **inside** the workers, actively running and calling `poll-task` repeatedly. This means:

1. A schedule or trigger spawns 3 Claude instances
2. Each Claude instance is instructed to "poll for tasks"
3. When no tasks are assigned, they follow the instruction to "keep polling"
4. All 3 keep polling indefinitely

### The Two Polling Layers

There are **two separate mechanisms** at play:

#### 1. Runner-Level Polling (Not the main problem)

**File**: `src/commands/runner.ts:1558-1563`

When agents are at capacity, the runner logs every second but doesn't make expensive API calls:

```typescript
} else {
  console.log(`[${role}] At capacity (${state.activeTasks.size}/${state.maxConcurrent}), waiting for completion...`);
  await Bun.sleep(1000);  // Fixed 1-second sleep
}
```

#### 2. Claude Instance Polling (THE PROBLEM)

**File**: `src/tools/poll-task.ts`

The poll-task MCP tool that Claude instances call repeatedly. Each call:
- Makes an API request (credits consumed)
- Waits up to 60 seconds internally polling the DB every 2 seconds
- Returns "keep polling" message on timeout
- Claude immediately calls again

## The Core Issues

### Issue 1: poll-task Encourages Infinite Polling

The message "please keep polling until a task is assigned" is problematic. If an agent is spawned without a task, it will poll forever.

**Location**: `src/tools/poll-task.ts:197`

### Issue 2: No Exit Condition for Idle Agents

There's no mechanism for a Claude instance to gracefully exit when:
- No task is found after N attempts
- No task is assigned within a reasonable timeout
- Agent capacity is already saturated

### Issue 3: No Backoff on Empty Poll

The poll-task tool doesn't implement any backoff when no tasks are available. It polls every 2 seconds for 60 seconds, then immediately restarts.

**Location**: `src/tools/poll-task.ts:181` - `DEFAULT_POLL_INTERVAL_MS = 2000`

## Proposed Solution: Block Response After Max Empty Polls

Use the existing hook "block" mechanism (same as task cancellation) to enforce a strict exit condition.

### Implementation Plan

#### 1. Add Poll Tracking to Agent Schema

**File**: `src/types.ts`

Add new field to `AgentSchema`:
```typescript
// Poll tracking for exit enforcement (consecutive empty polls)
emptyPollCount: z.number().int().min(0).default(0),
```

#### 2. Add Database Migration

**File**: `src/be/db.ts`

Add migration:
```typescript
try {
  db.run(`ALTER TABLE agents ADD COLUMN emptyPollCount INTEGER DEFAULT 0`);
} catch {
  /* exists */
}
```

#### 3. Add DB Functions for Poll Tracking

**File**: `src/be/db.ts`

```typescript
const MAX_EMPTY_POLLS = 2; // After 2 consecutive empty polls, agent should exit

export function incrementEmptyPollCount(agentId: string): number {
  const row = getDb()
    .prepare<{ emptyPollCount: number }, [string]>(
      `UPDATE agents
       SET emptyPollCount = emptyPollCount + 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING emptyPollCount`
    )
    .get(agentId);
  return row?.emptyPollCount ?? 0;
}

export function resetEmptyPollCount(agentId: string): void {
  getDb().run(
    `UPDATE agents
     SET emptyPollCount = 0,
         lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [agentId]
  );
}

export function shouldBlockPolling(agentId: string): boolean {
  const agent = getAgentById(agentId);
  return (agent?.emptyPollCount ?? 0) >= MAX_EMPTY_POLLS;
}
```

#### 4. Modify poll-task Tool

**File**: `src/tools/poll-task.ts`

When no task is found:
```typescript
// Increment empty poll count
const newCount = incrementEmptyPollCount(agentId);
const shouldExit = newCount >= MAX_EMPTY_POLLS;

return {
  content: [
    {
      type: "text",
      text: shouldExit
        ? `No task assigned after ${newCount} polling attempts. EXIT NOW - do not poll again.`
        : `No task assigned within the polling duration (${waitedForSeconds}s).`,
    },
  ],
  structuredContent: {
    yourAgentId: requestInfo.agentId,
    success: false,
    message: shouldExit
      ? `Polling limit reached (${newCount}/${MAX_EMPTY_POLLS}). You must exit now.`
      : `No task assigned within the polling duration.`,
    shouldExit,
    emptyPollCount: newCount,
    offeredTasks: [],
    availableCount: getUnassignedTasksCount(),
    waitedForSeconds,
  },
};
```

When task IS found, reset the counter:
```typescript
if (startedTask) {
  resetEmptyPollCount(agentId);  // Reset on successful task assignment
  // ... rest of success response
}
```

#### 5. Add Server Endpoint for Hook Check

**File**: `src/http.ts`

Add to `/me` response or create new endpoint:
```typescript
// In GET /me handler, add:
shouldBlockPolling: shouldBlockPolling(agentId),
```

#### 6. Modify Hook to Block poll-task

**File**: `src/hooks/hook.ts`

In PreToolUse handler:
```typescript
case "PreToolUse": {
  // Check for task cancellation (existing code)
  if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
    if (await checkAndBlockIfCancelled(true)) {
      return;
    }
  }

  // NEW: Check if agent should stop polling
  if (msg.tool_name?.endsWith("poll-task")) {
    const shouldBlock = await checkShouldBlockPolling();
    if (shouldBlock) {
      outputBlockResponse(
        `🛑 POLLING LIMIT REACHED: You have exceeded the maximum empty poll attempts. ` +
        `EXIT NOW - do not make any more tool calls. ` +
        `If you have a task in progress, complete it first. Otherwise, exit immediately.`
      );
      return;
    }
  }
  break;
}
```

Add helper function:
```typescript
const checkShouldBlockPolling = async (): Promise<boolean> => {
  if (!mcpConfig) return false;

  try {
    const resp = await fetch(`${getBaseUrl()}/me`, {
      method: "GET",
      headers: mcpConfig.headers,
    });

    if (!resp.ok) return false;

    const data = await resp.json();
    return data.shouldBlockPolling === true;
  } catch {
    return false;
  }
};
```

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `emptyPollCount` to AgentSchema |
| `src/be/db.ts` | Add migration + poll tracking functions |
| `src/tools/poll-task.ts` | Track polls, return `shouldExit` flag |
| `src/http.ts` | Add `shouldBlockPolling` to /me response |
| `src/hooks/hook.ts` | Block poll-task when limit reached |

## Constants

```typescript
const MAX_EMPTY_POLLS = 2;  // After 2 consecutive empty polls (each ~60s), exit
```

This means an agent will poll for up to ~2 minutes before being forced to exit, which is reasonable for detecting "no work available" while not being too aggressive.

## Alternative Approaches Considered

1. **Message-only approach**: Just change the message to say "exit now" - but Claude might ignore it
2. **Exponential backoff**: Increase poll interval - but doesn't solve the core issue of infinite polling
3. **Single poll only**: Exit after first empty poll - too aggressive, might miss tasks that arrive shortly after

## Why Block Response is Best

The block response approach:
- **Server-enforced**: Can't be ignored by Claude
- **Uses existing mechanism**: Same pattern as task cancellation
- **Graceful**: Allows 2 attempts before blocking
- **Clear**: Explicit block with reason, not a suggestion

## Testing Plan

1. Deploy with MAX_EMPTY_POLLS = 2
2. Monitor agent exits after 2 empty polls
3. Verify counter resets when tasks are assigned
4. Check that the block response actually prevents further calls
