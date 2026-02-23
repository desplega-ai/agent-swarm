---
date: 2026-02-23
author: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
topic: "Implementation Plan: P1 + P2 Openclaw Improvements"
status: ready
related_research: thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md
---

# Implementation Plan: P1 + P2 Openclaw Improvements

## Overview

This plan covers all 6 improvements from the openclaw comparison research (3 P1, 3 P2). Items are ordered by implementation dependency and difficulty. Each item includes exact file paths, code insertion points, pseudocode, and testing strategy.

**Implementation order**: 2 → 6 → 3 → 4 → 1 → 5

Rationale: Start with the simplest items that have no dependencies, then build up to more complex features.

---

## Item 2 (P1): Active Session Heartbeat — Wire Existing Endpoint

**Goal**: Call the already-existing `heartbeatActiveSession()` endpoint from the PostToolUse hook so that `cleanupStaleSessions()` can actually detect stale sessions.

**Current state**: The endpoint `PUT /api/active-sessions/heartbeat/:taskId` and DB function `heartbeatActiveSession()` (db.ts:5567) exist but are never called. Sessions only get a heartbeat timestamp at creation time.

### Files to modify

**`src/hooks/hook.ts`** — PostToolUse handler (line ~771-847)

### Implementation

Add a heartbeat call inside the `PostToolUse` case, after the ping and agent info are available. The heartbeat should fire on every tool use, which naturally provides liveness data without extra overhead.

```typescript
// Inside case "PostToolUse": (after line 771)
// Before existing logic, fire session heartbeat
if (agentInfo && !agentInfo.isLead) {
  const taskFileData = await readTaskFile();
  if (taskFileData?.taskId) {
    try {
      await fetch(`${getBaseUrl()}/api/active-sessions/heartbeat/${taskFileData.taskId}`, {
        method: "PUT",
        headers: mcpConfig!.headers,
      });
    } catch {
      // Non-blocking — heartbeat failure should not interrupt agent work
    }
  }
}
```

Insert this block at the very beginning of the `case "PostToolUse":` block (line 772, before the `if (agentInfo)` check). The heartbeat is fire-and-forget.

### Why at PostToolUse (not PreToolUse)

PreToolUse already does cancellation checks which add latency. Adding heartbeat there would compound. PostToolUse runs after the tool completes, so the latency doesn't block the agent.

### Testing

1. Start a worker, assign a task
2. Run `SELECT lastHeartbeatAt FROM active_sessions WHERE taskId = ?` — verify it updates on each tool call
3. Kill a worker mid-task, wait 30+ minutes, run `POST /api/active-sessions/cleanup` — verify stale session is deleted

### Estimated changes: ~15 lines in hook.ts

---

## Item 6 (P2): Task Progress Deduplication

**Goal**: Skip duplicate `store-progress` calls where progress text is identical to the last update within a time window.

**Current state**: `updateTaskProgress()` (db.ts:1837) stores every progress update unconditionally and creates a `task_progress` log entry each time. Agents sometimes send repeated progress messages.

### Files to modify

1. **`src/be/db.ts`** — Migration + new column + helper
2. **`src/tools/store-progress.ts`** — Dedup check before calling updateTaskProgress

### Implementation

#### Step 1: DB Migration (db.ts)

Add a new migration in the migrations block (after the existing `ALTER TABLE` migrations, around line ~800):

```typescript
// Migration: Add lastProgressText for deduplication
try {
  database.run("ALTER TABLE agent_tasks ADD COLUMN lastProgressText TEXT");
} catch {}
try {
  database.run("ALTER TABLE agent_tasks ADD COLUMN lastProgressAt TEXT");
} catch {}
```

#### Step 2: Update `updateTaskProgress` (db.ts:1837)

Modify the function to also update `lastProgressText` and `lastProgressAt`:

```typescript
export function updateTaskProgress(id: string, progress: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      `UPDATE agent_tasks SET progress = ?, lastProgressText = ?, lastProgressAt = ?, lastUpdatedAt = ?
       WHERE id = ? RETURNING *`
    )
    .get(progress, progress, new Date().toISOString(), new Date().toISOString(), id);
  // ... rest unchanged
}
```

Wait — actually the current `taskQueries.setProgress()` prepared statement handles this. We need to modify that query. Let me look at the actual query.

The simplest approach: modify `store-progress.ts` to check before calling `updateTaskProgress`.

#### Step 2 (revised): Dedup in store-progress.ts (line ~103)

Before calling `updateTaskProgress`, check if the progress text matches the existing task's progress:

```typescript
// Inside the transaction, before line 103:
if (progress) {
  // Dedup: skip if same progress text was set within the last 5 minutes
  const isDuplicate =
    existingTask.progress === progress &&
    existingTask.lastUpdatedAt &&
    Date.now() - new Date(existingTask.lastUpdatedAt).getTime() < 5 * 60 * 1000;

  if (!isDuplicate) {
    const result = updateTaskProgress(taskId, progress);
    if (result) updatedTask = result;
  }
}
```

This avoids any DB schema changes — we just compare against the existing `progress` field and `lastUpdatedAt` timestamp on the task.

### Testing

1. Call `store-progress` with progress "Working on X" twice in rapid succession
2. Verify only one `task_progress` log entry is created
3. Call again after 5+ minutes — verify it stores
4. Verify status changes (completed/failed) always go through regardless of dedup

### Estimated changes: ~10 lines in store-progress.ts (no DB migration needed)

---

## Item 3 (P1): Missed Schedule Recovery on Startup

**Goal**: When the scheduler starts, check for past-due scheduled tasks and execute them immediately instead of waiting for the next scheduled run.

**Current state**: `startScheduler()` (scheduler.ts:77) calls `processSchedules()` once on startup. `getDueScheduledTasks()` (db.ts:4242) already returns tasks where `nextRunAt <= now`, so past-due tasks ARE picked up on the first tick. However, if a task's `nextRunAt` is far in the past, `calculateNextRun()` will schedule the NEXT run from `now`, which is correct.

Wait — re-reading the code, the current `processSchedules()` ALREADY handles this because `getDueScheduledTasks()` returns `WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?` with `?` = now. So any past-due tasks are already picked up on the first tick.

**Actually needed**: The real gap is that `executeSchedule()` calls `calculateNextRun(schedule, new Date())` which calculates next run from NOW. For cron expressions, this works correctly. For intervals, this also works (next = now + interval). So the schedule recovery is already implicit.

**Remaining gap**: What if the scheduler was down and a schedule was due MULTIPLE times? E.g., an hourly schedule was down for 3 hours. Currently only one execution happens. Openclaw runs all missed past-due executions.

**Revised approach**: Add a `missedRunRecovery` option to `startScheduler()` that checks how many runs were missed and optionally catches up.

### Files to modify

**`src/scheduler/scheduler.ts`** — `startScheduler()` and new `recoverMissedSchedules()` function

### Implementation

Add a recovery function before the main poll loop:

```typescript
/**
 * Recover missed scheduled task runs from downtime.
 * Only fires ONE catch-up run per schedule (not N missed runs).
 * Tags the task with "recovered" so it's distinguishable.
 */
async function recoverMissedSchedules(): Promise<void> {
  const now = new Date();
  const dueSchedules = getDueScheduledTasks();

  for (const schedule of dueSchedules) {
    // Only recover if nextRunAt is significantly in the past (> 1 tick)
    if (!schedule.nextRunAt) continue;
    const missedBy = now.getTime() - new Date(schedule.nextRunAt).getTime();
    if (missedBy < 15000) continue; // Less than 15s — normal timing jitter

    console.log(
      `[Scheduler] Recovering missed schedule "${schedule.name}" ` +
      `(was due ${Math.round(missedBy / 1000)}s ago)`
    );

    try {
      // Use transaction for atomicity
      const tx = getDb().transaction(() => {
        createTaskExtended(schedule.taskTemplate, {
          creatorAgentId: schedule.createdByAgentId,
          taskType: schedule.taskType,
          tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "recovered"],
          priority: schedule.priority,
          agentId: schedule.targetAgentId,
        });

        // Update nextRunAt to the next FUTURE run
        const nextRun = calculateNextRun(schedule, now);
        updateScheduledTask(schedule.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: nextRun,
          lastUpdatedAt: now.toISOString(),
        });
      });
      tx();
    } catch (err) {
      console.error(`[Scheduler] Error recovering "${schedule.name}":`, err);
    }
  }
}
```

Then call it in `startScheduler()` before the first `processSchedules()`:

```typescript
export function startScheduler(intervalMs = 10000): void {
  if (schedulerInterval) {
    console.log("[Scheduler] Already running");
    return;
  }

  console.log(`[Scheduler] Starting with ${intervalMs}ms polling interval`);

  // Recover missed schedules from downtime (before normal processing)
  void recoverMissedSchedules();

  // Run immediately once, then start interval
  void processSchedules();
  // ...
}
```

**Note**: `recoverMissedSchedules()` and `processSchedules()` both call `getDueScheduledTasks()`, but `recoverMissedSchedules` updates `nextRunAt` for recovered schedules, so `processSchedules()` won't double-execute them.

### Testing

1. Create a schedule with `intervalMs: 60000` (1 minute)
2. Stop the scheduler, wait 5 minutes
3. Restart — verify exactly one "recovered" task is created
4. Verify the nextRunAt is set to a future time (not to the missed time)

### Estimated changes: ~40 lines in scheduler.ts

---

## Item 4 (P2): Exponential Backoff for Failed Scheduled Tasks

**Goal**: When a scheduled task's execution fails repeatedly, apply exponential backoff to prevent flooding and auto-disable after too many consecutive failures.

**Current state**: `executeSchedule()` (scheduler.ts:44) catches errors and logs them but takes no recovery action. The schedule fires again at the normal interval.

### Files to modify

1. **`src/be/db.ts`** — Migration for new columns + update helper
2. **`src/scheduler/scheduler.ts`** — Error tracking in `executeSchedule()`, backoff in `processSchedules()`

### Implementation

#### Step 1: DB Migration (db.ts)

Add after existing migrations:

```typescript
// Migration: Add error tracking columns to scheduled_tasks
try {
  database.run("ALTER TABLE scheduled_tasks ADD COLUMN consecutiveErrors INTEGER DEFAULT 0");
} catch {}
try {
  database.run("ALTER TABLE scheduled_tasks ADD COLUMN lastErrorAt TEXT");
} catch {}
try {
  database.run("ALTER TABLE scheduled_tasks ADD COLUMN lastErrorMessage TEXT");
} catch {}
```

#### Step 2: Update `updateScheduledTask` signature

The existing `updateScheduledTask()` (db.ts:4155) already accepts a generic update object with dynamic keys. The new columns (`consecutiveErrors`, `lastErrorAt`, `lastErrorMessage`) need to be added to its field allowlist.

In db.ts, find the `updateScheduledTask` function and add the new fields to the allowed fields list:

```typescript
// In updateScheduledTask(), add to the allowed fields:
const allowedFields = [
  // ... existing fields ...
  "consecutiveErrors",
  "lastErrorAt",
  "lastErrorMessage",
];
```

Also update the `ScheduledTask` type in `types.ts` and the `rowToScheduledTask` mapper if it exists.

#### Step 3: Backoff logic in scheduler.ts

Define the backoff schedule:

```typescript
const ERROR_BACKOFF_MS = [
  60_000,       // 1 minute
  300_000,      // 5 minutes
  900_000,      // 15 minutes
  1_800_000,    // 30 minutes
  3_600_000,    // 1 hour (cap)
];

const MAX_CONSECUTIVE_ERRORS = 5; // Auto-disable after this many

function getBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1);
  return ERROR_BACKOFF_MS[Math.max(0, idx)];
}
```

#### Step 4: Modify `executeSchedule()` to track errors

Wrap the existing `executeSchedule()` in error handling that updates the schedule on failure:

```typescript
async function executeSchedule(schedule: ScheduledTask): Promise<void> {
  try {
    const tx = getDb().transaction(() => {
      const now = new Date().toISOString();
      createTaskExtended(schedule.taskTemplate, {
        creatorAgentId: schedule.createdByAgentId,
        taskType: schedule.taskType,
        tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`],
        priority: schedule.priority,
        agentId: schedule.targetAgentId,
      });

      const nextRun = calculateNextRun(schedule, new Date());
      updateScheduledTask(schedule.id, {
        lastRunAt: now,
        nextRunAt: nextRun,
        lastUpdatedAt: now,
        // Reset error tracking on success
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
      });

      return nextRun;
    });

    const nextRun = tx();
    console.log(`[Scheduler] Executed schedule "${schedule.name}", next run: ${nextRun}`);
  } catch (err) {
    const errorCount = (schedule.consecutiveErrors ?? 0) + 1;
    const now = new Date();
    const errorMsg = err instanceof Error ? err.message : String(err);

    console.error(
      `[Scheduler] Error executing "${schedule.name}" (${errorCount} consecutive):`,
      errorMsg
    );

    const updates: Record<string, unknown> = {
      consecutiveErrors: errorCount,
      lastErrorAt: now.toISOString(),
      lastErrorMessage: errorMsg.slice(0, 500),
      lastUpdatedAt: now.toISOString(),
    };

    if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
      // Auto-disable after too many consecutive failures
      updates.enabled = 0;
      console.warn(
        `[Scheduler] Auto-disabled "${schedule.name}" after ${errorCount} consecutive errors`
      );
    } else {
      // Apply backoff to nextRunAt
      const backoff = getBackoffMs(errorCount);
      updates.nextRunAt = new Date(now.getTime() + backoff).toISOString();
      console.log(
        `[Scheduler] Backing off "${schedule.name}" for ${backoff / 1000}s`
      );
    }

    updateScheduledTask(schedule.id, updates);
  }
}
```

### Testing

1. Create a schedule with an invalid `taskTemplate` (or target a non-existent agent) to trigger failures
2. Observe `consecutiveErrors` incrementing and `nextRunAt` being pushed forward
3. After 5 failures, verify the schedule is auto-disabled (`enabled = 0`)
4. Fix the issue, re-enable the schedule, verify `consecutiveErrors` resets to 0 on success

### Estimated changes: ~60 lines in scheduler.ts, ~10 lines in db.ts

---

## Item 1 (P1): Tool Loop Detection

**Goal**: Detect when an agent is stuck in a repetitive tool call loop and intervene by blocking the tool call with an explanatory message.

**Current state**: No loop detection exists. Agents may repeat the same tool calls indefinitely (especially `Bash`, `Read`, or `Grep` with identical arguments) until context compaction or max-turns limits.

### Files to modify

1. **`src/hooks/tool-loop-detection.ts`** — New file with detection logic
2. **`src/hooks/hook.ts`** — PreToolUse handler integration

### Implementation

#### Step 1: New file `src/hooks/tool-loop-detection.ts`

```typescript
/**
 * Tool loop detection for agent-swarm hooks.
 *
 * Tracks recent tool calls per session and detects repetitive patterns.
 * Uses a file-based history to persist across hook invocations (hooks are
 * separate Bun processes, not long-running).
 */

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  timestamp: number;
}

interface LoopDetectionResult {
  blocked: boolean;
  reason?: string;
  severity?: "warning" | "critical";
}

const HISTORY_DIR = "/tmp/agent-swarm-tool-history";
const MAX_HISTORY = 30; // Sliding window size
const REPEAT_WARNING_THRESHOLD = 8;
const REPEAT_CRITICAL_THRESHOLD = 15;
const PINGPONG_WARNING_THRESHOLD = 6;
const PINGPONG_CRITICAL_THRESHOLD = 12;

/**
 * Simple hash of tool arguments for comparison.
 * Uses JSON.stringify + a basic hash to avoid storing full args.
 */
function hashArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, Object.keys(args).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * Load tool call history for a session.
 */
async function loadHistory(sessionKey: string): Promise<ToolCallRecord[]> {
  try {
    const file = Bun.file(`${HISTORY_DIR}/${sessionKey}.json`);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {}
  return [];
}

/**
 * Save tool call history for a session.
 */
async function saveHistory(sessionKey: string, history: ToolCallRecord[]): Promise<void> {
  try {
    await Bun.$`mkdir -p ${HISTORY_DIR}`.quiet();
    await Bun.write(
      `${HISTORY_DIR}/${sessionKey}.json`,
      JSON.stringify(history.slice(-MAX_HISTORY))
    );
  } catch {}
}

/**
 * Detect if the current tool call is part of a repetitive loop.
 */
export async function checkToolLoop(
  sessionKey: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<LoopDetectionResult> {
  const argsHash = hashArgs(toolInput);
  const history = await loadHistory(sessionKey);

  // Add current call to history
  history.push({ toolName, argsHash, timestamp: Date.now() });
  await saveHistory(sessionKey, history);

  // Only check if we have enough history
  if (history.length < REPEAT_WARNING_THRESHOLD) {
    return { blocked: false };
  }

  // Strategy 1: Same tool + same args repeated
  const key = `${toolName}:${argsHash}`;
  let repeatCount = 0;
  for (const record of history) {
    if (`${record.toolName}:${record.argsHash}` === key) {
      repeatCount++;
    }
  }

  if (repeatCount >= REPEAT_CRITICAL_THRESHOLD) {
    return {
      blocked: true,
      severity: "critical",
      reason: `Tool "${toolName}" has been called ${repeatCount} times with identical arguments in the last ${MAX_HISTORY} calls. You are stuck in a loop. Try a completely different approach.`,
    };
  }

  if (repeatCount >= REPEAT_WARNING_THRESHOLD) {
    return {
      blocked: false, // Warning only — don't block yet
      severity: "warning",
      reason: `Tool "${toolName}" has been called ${repeatCount} times with identical arguments. Consider trying a different approach.`,
    };
  }

  // Strategy 2: Ping-pong between two tool call patterns
  if (history.length >= PINGPONG_WARNING_THRESHOLD) {
    const recent = history.slice(-PINGPONG_CRITICAL_THRESHOLD);
    const patterns = new Map<string, number>();
    for (const r of recent) {
      const p = `${r.toolName}:${r.argsHash}`;
      patterns.set(p, (patterns.get(p) || 0) + 1);
    }

    // Check if exactly 2 patterns dominate
    const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [first, second] = sorted;
      const dominance = first[1] + second[1];
      if (dominance >= recent.length * 0.8) {
        // Two patterns account for 80%+ of recent calls
        const totalPingPong = first[1] + second[1];
        if (totalPingPong >= PINGPONG_CRITICAL_THRESHOLD) {
          return {
            blocked: true,
            severity: "critical",
            reason: `Detected ping-pong loop: alternating between "${first[0].split(":")[0]}" and "${second[0].split(":")[0]}" for ${totalPingPong} calls. Break out of this pattern.`,
          };
        }
        if (totalPingPong >= PINGPONG_WARNING_THRESHOLD) {
          return {
            blocked: false,
            severity: "warning",
            reason: `Possible ping-pong pattern detected between two tool calls. Consider a different approach.`,
          };
        }
      }
    }
  }

  return { blocked: false };
}

/**
 * Clear tool call history for a session (call on session end).
 */
export async function clearToolHistory(sessionKey: string): Promise<void> {
  try {
    await Bun.$`rm -f ${HISTORY_DIR}/${sessionKey}.json`.quiet();
  } catch {}
}
```

#### Step 2: Integrate in hook.ts PreToolUse handler

In hook.ts, add import at top:

```typescript
import { checkToolLoop, clearToolHistory } from "./tool-loop-detection";
```

In the `PreToolUse` case (after cancellation check, around line 755), add:

```typescript
// Tool loop detection (workers only, when processing a task)
if (agentInfo && !agentInfo.isLead && agentInfo.status === "busy") {
  const taskFileData = await readTaskFile();
  if (taskFileData?.taskId && msg.tool_name && msg.tool_input) {
    const result = await checkToolLoop(
      taskFileData.taskId,
      msg.tool_name,
      msg.tool_input as Record<string, unknown>
    );

    if (result.blocked) {
      outputBlockResponse(
        `🔄 LOOP DETECTED: ${result.reason} ` +
        `Stop repeating this action and try a fundamentally different approach. ` +
        `If you're truly stuck, use store-progress to report the blocker.`
      );
      return;
    }

    if (result.severity === "warning" && result.reason) {
      // Output as a non-blocking warning (just console.log, not a block response)
      console.log(`⚠️ ${result.reason}`);
    }
  }
}
```

Also clear history on `SessionStart`:

```typescript
// In case "SessionStart":, after existing logic:
// Clear any stale tool loop history
const startTaskFile = await readTaskFile();
if (startTaskFile?.taskId) {
  await clearToolHistory(startTaskFile.taskId);
}
```

### Design decisions

- **File-based history**: Hooks run as separate Bun processes (not a persistent server). State must persist across invocations → file-based storage in `/tmp`.
- **Session-scoped**: History is keyed by taskId, so each task has independent tracking.
- **Warning before blocking**: At 8 repeats, warn. At 15, block. This gives the agent a chance to self-correct.
- **Critical blocks**: Only the `outputBlockResponse` path actually stops the agent. Warnings are advisory.

### Testing

1. Create a test task that deliberately loops (e.g., a prompt that says "read the same file 20 times")
2. Observe warning at 8 repeats, block at 15
3. Verify ping-pong detection with alternating tool calls
4. Verify history is cleared on session start (no contamination between tasks)

### Estimated changes: ~160 lines in tool-loop-detection.ts, ~30 lines in hook.ts

---

## Item 5 (P2): Graceful Task Cancellation (Push-based)

**Goal**: When a task is cancelled, proactively signal the Claude subprocess instead of waiting for the next hook check.

**Current state**: Cancellation is detected via `isTaskCancelled()` in the `PreToolUse` and `UserPromptSubmit` hooks (hook.ts:748-768, 849-858). If the agent is in a long-running operation (subprocess, waiting, etc.), it won't notice until the next tool call.

### Files to modify

1. **`src/commands/runner.ts`** — Main loop: check for cancelled tasks and signal subprocess
2. **`src/http.ts`** — Add a `POST /api/tasks/:id/cancel` webhook/notification path (optional, for future)

### Implementation

#### Approach: Runner-side polling for cancellations

The runner's main loop already iterates every ~2s (PollIntervalMs). Add a cancellation check there.

In `runner.ts`, inside the main `while(true)` loop (after `checkCompletedProcesses` at line 2019), add:

```typescript
// Check for cancelled tasks and signal their subprocesses
for (const [taskId, task] of state.activeTasks) {
  try {
    const resp = await fetch(
      `${apiUrl}/cancelled-tasks?taskId=${encodeURIComponent(taskId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Agent-ID": agentId,
        },
      }
    );
    if (resp.ok) {
      const data = await resp.json() as { cancelled: Array<{ id: string }> };
      if (data.cancelled?.some(t => t.id === taskId)) {
        console.log(`[${role}] Task ${taskId.slice(0, 8)} was cancelled — sending SIGTERM to subprocess`);
        task.process.kill("SIGTERM");
        // Don't remove from activeTasks yet — checkCompletedProcesses will handle cleanup
      }
    }
  } catch {
    // Non-blocking — cancellation check is best-effort
  }
}
```

This checks each active task against the cancellation endpoint. If cancelled, it sends SIGTERM to the Claude subprocess, which triggers Claude Code's graceful shutdown (Stop hook fires, task gets cleaned up).

#### Optimization: Batch check

To avoid N API calls (one per active task), we can batch by checking all at once. However, the current `/cancelled-tasks` endpoint only supports `?taskId=` for a single task. Two options:

**Option A (Simple)**: Keep per-task checks. With maxConcurrent typically being 1-2, this is fine.

**Option B (Better)**: Modify the `/cancelled-tasks` endpoint to support `?taskIds=id1,id2,id3`. But this requires HTTP endpoint changes.

**Recommendation**: Go with Option A for simplicity. The overhead of 1-2 extra API calls per 2s is negligible.

#### Important: Only check when tasks are running

```typescript
// Only check if there are active tasks (avoid unnecessary API calls)
if (state.activeTasks.size > 0) {
  for (const [taskId, task] of state.activeTasks) {
    // ... check cancellation
  }
}
```

### Why SIGTERM (not SIGUSR1)

Claude Code's `--sigterm-timeout` flag controls how long it waits after SIGTERM before force-exiting. The Stop hook fires on SIGTERM, which gives the agent a chance to clean up. SIGUSR1 is not handled by Claude Code.

### Testing

1. Start a worker with a long-running task
2. Cancel the task via `cancel-task` MCP tool
3. Observe: within ~2 seconds, the subprocess receives SIGTERM
4. Verify the task is marked as cancelled/failed (via `ensureTaskFinished`)

### Estimated changes: ~25 lines in runner.ts

---

## Implementation Order Summary

| Order | Item | Effort | Dependencies |
|-------|------|--------|-------------|
| 1st | **Item 2**: Active Session Heartbeat | ~15 lines | None |
| 2nd | **Item 6**: Progress Deduplication | ~10 lines | None |
| 3rd | **Item 3**: Missed Schedule Recovery | ~40 lines | None |
| 4th | **Item 4**: Schedule Error Backoff | ~70 lines | Builds on Item 3's scheduler changes |
| 5th | **Item 1**: Tool Loop Detection | ~190 lines | None (but most complex) |
| 6th | **Item 5**: Push Cancellation | ~25 lines | None (but requires careful testing) |

**Total estimated new code**: ~350 lines across 5 files

---

## Rollout Strategy

### Phase 1: Low-risk improvements (Items 2, 6)
- Deploy together. Zero risk — heartbeat is fire-and-forget, dedup is a simple optimization.
- Verify heartbeat updates are flowing before proceeding.

### Phase 2: Scheduler improvements (Items 3, 4)
- Deploy together since Item 4 builds on Item 3.
- Test with a non-critical schedule first.
- Monitor `consecutiveErrors` column after deploy.

### Phase 3: Complex features (Items 1, 5)
- Deploy Item 1 (tool loop detection) first, monitor for false positives.
- Start with higher thresholds (e.g., 20 for critical) and lower once confident.
- Deploy Item 5 (push cancellation) last — test in staging by cancelling tasks manually.

### Monitoring

After deployment, track:
- Active session heartbeat frequency (should update every few seconds during active tasks)
- Progress dedup hit rate (log when a duplicate is skipped)
- Schedule recovery events (look for "recovered" tagged tasks)
- Schedule error backoff events (look for "Auto-disabled" log lines)
- Tool loop detections (warning/critical counts)
- Cancellation signal delivery latency (time between cancel API call and SIGTERM)

---

## Open Questions for Reviewer

1. **Tool loop thresholds**: Are 8/15 (warning/critical) appropriate, or should we start more conservative (e.g., 12/20)?
2. **Schedule recovery**: Should we run ALL missed executions (like openclaw) or just ONE catch-up per schedule (current plan)?
3. **Auto-disable threshold**: Is 5 consecutive errors the right threshold for auto-disabling a schedule?
4. **Cancellation signal**: Should we use SIGTERM (triggers full Stop hook) or a lighter signal? SIGTERM means the agent gets a chance to save progress.
