# Implementation Plan

**Status:** implemented
**Date:** 2026-04-03
**Commit per phase:** Yes

## Overview

Fix the lead agent's heartbeat checklist and boot triage so it effectively triages swarm state after reboots instead of dismissing stale tasks as "healthy" or reboot failures as "expected auto-cleanup."

## Current State Analysis

### Boot timeline (broken)
```
T+0s   startHeartbeat() called
T+5s   First runHeartbeatSweep() — uses 5-min threshold, catches nothing fresh
T+30s  createBootTriageTask() — lead sees stale tasks as "healthy" (sweep hasn't caught them)
T+90s  Second sweep — still too early for tasks updated <5 min before restart
T+5m+  Tasks finally eligible for auto-fail (5-min no-session threshold)
```

The boot triage fires at T+30s but the sweep's shortest threshold is 5 minutes. Tasks updated shortly before the restart look "healthy" to the lead.

### Periodic heartbeat (broken behavior)
The lead sees "7x worker session not found" failures, calls them "expected auto-cleanup", marks "All clear." No instruction tells it these represent interrupted work needing re-creation.

### Key Discoveries:
- `detectAndRemediateStalledTasks()` at `src/heartbeat/heartbeat.ts:161` uses `getStalledInProgressTasks(5)` — 5-min minimum age filter
- `getStalledInProgressTasks(thresholdMinutes)` at `src/be/db.ts:5144` filters by `lastUpdatedAt < cutoff` — passing 0 effectively returns ALL in_progress tasks
- `createBootTriageTask()` at `src/heartbeat/heartbeat.ts:613` fires at T+30s via `setTimeout` in `startHeartbeatChecklist()` at line 667
- `gatherSystemStatus()` at `src/heartbeat/heartbeat.ts:354` has no `isBootTriage` parameter — same generic output for both boot and periodic
- `failTask()` at `src/be/db.ts:1431` accepts `(id, reason)` — reason is a free-text string, no structured metadata
- `createTaskExtended()` at `src/be/db.ts:1853` supports `parentTaskId` which auto-inherits Slack/AgentMail metadata from parent (lines 1864-1887). Returns `AgentTask` (never null — throws on failure)
- No existing task-level auto-retry pattern — workflow retry exists (`src/workflows/retry-poller.ts`) but not for agent tasks
- Tags stored as JSON string array, queried via `LIKE '%"tag"%'` pattern at `src/be/db.ts:1086`
- `rowToAgentTask` and `AgentTaskRow` are NOT exported from `src/be/db.ts` — internal helpers only
- `getTasksByStatus(status)` IS exported from `src/be/db.ts:1012` — returns `AgentTask[]`
- Graceful shutdown pauses tasks (status `paused`, `was_paused=1`). Workers resume paused tasks on restart via `GET /api/paused-tasks`. Reboot sweep correctly skips these (only targets `in_progress`)

## Desired End State

### Boot timeline (fixed)
```
T+0s   startHeartbeat() called
T+5s   runRebootSweep() — aggressive, NO threshold. Auto-fails all in_progress tasks
         with no active session. Auto-creates retry tasks with parentTaskId.
T+90s  createBootTriageTask() — lead sees accurate post-remediation status:
         "Reboot-Interrupted Work" section with full task IDs and retry status
T+90s  Second runHeartbeatSweep() — normal recurring sweep begins
T+30m  First checkHeartbeatChecklist() — periodic checklist with improved prompt
```

### Periodic heartbeat (fixed behavior)
The lead reads explicit instructions: "Failures with reason 'worker session not found' indicate interrupted work. Check what the task was. Re-create if needed. Do NOT dismiss as 'expected auto-cleanup.'" Cannot mark "All clear" if reboot failures exist in last 6 hours.

### Verification
- After a restart, all in_progress tasks with dead workers are auto-failed within 5s
- Each auto-failed task gets exactly one retry task (via parentTaskId, tagged `reboot-retry`)
- Boot triage shows "Reboot-Interrupted Work" section with full IDs, retry status, and mandatory triage
- Periodic heartbeat explicitly warns about reboot failures
- Existing tests pass, new tests cover reboot sweep and retry logic

## Quick Verification Reference

Common commands:
- `bun test src/tests/heartbeat.test.ts` — heartbeat unit tests
- `bun test src/tests/heartbeat-checklist.test.ts` — checklist unit tests
- `bun run tsc:check` — type check
- `bun run lint:fix` — lint and format

Key files:
- `src/heartbeat/heartbeat.ts` — core sweep, reboot sweep, boot triage, status gathering
- `src/heartbeat/templates.ts` — prompt templates
- `src/tests/heartbeat.test.ts` — heartbeat tests
- `src/tests/heartbeat-checklist.test.ts` — checklist tests

## What We're NOT Doing

- No new database migrations (using existing `parentTaskId` column for retry linkage)
- No changes to worker-side heartbeat sending (`src/hooks/hook.ts`, `src/providers/pi-mono-extension.ts`)
- No changes to the infrastructure sweep's normal thresholds (5/15/30 min) — only the reboot sweep ignores them
- No changes to the dashboard UI
- No changes to the MCP tool definitions
- No changes to `paused` task handling — paused tasks follow a separate resume path via `GET /api/paused-tasks` and should NOT be auto-failed by the reboot sweep (it only targets `in_progress`)

## Implementation Approach

Three phases, ordered by dependency:
1. **Phase 1: Aggressive reboot sweep + auto-retry** — Core infrastructure. Adds `runRebootSweep()` that ignores thresholds and creates retry tasks.
2. **Phase 2: Enhanced boot triage** — Delay boot triage to T+90s, add "Reboot-Interrupted Work" section with full IDs and pending/offered orphan detection.
3. **Phase 3: Prompt improvements** — Template changes for both checklist and boot-triage prompts, plus lead CLAUDE.md updates.

---

## Phase 1: Aggressive Reboot Sweep + Auto-Retry

### Overview
Add a `runRebootSweep()` function that runs at T+5s after server start. Unlike the normal sweep, it ignores age thresholds — any `in_progress` task whose worker has no active session is immediately auto-failed. For each auto-failed task, a retry task is auto-created using `parentTaskId` linkage.

### Changes Required:

#### 1. Reboot sweep function
**File**: `src/heartbeat/heartbeat.ts`
**Changes**:

Add module-level state to track reboot-affected tasks:
```typescript
/** Tasks auto-failed during the reboot sweep, consumed by boot triage */
let rebootAffectedTasks: Array<{ original: AgentTask; retryTaskId: string | null }> = [];
```

Add `runRebootSweep()` function after `detectAndRemediateStalledTasks()` (~line 220):
```typescript
/**
 * Aggressive sweep that runs once after server restart.
 * Ignores age thresholds — any in_progress task with no active session is auto-failed.
 * Creates exactly one retry task per failed task via parentTaskId.
 */
export async function runRebootSweep(): Promise<void> {
  // Use isSweeping guard to prevent concurrent execution with normal sweep
  if (isSweeping) {
    console.log("[Heartbeat] Reboot sweep skipped — another sweep is running");
    return;
  }
  isSweeping = true;

  try {
    // Get ALL in_progress tasks (threshold=0 means cutoff=now, effectively all)
    const allInProgress = getStalledInProgressTasks(0);
    if (allInProgress.length === 0) {
      console.log("[Heartbeat] Reboot sweep: no in-progress tasks found");
      return; // finally block will still run and reset isSweeping
    }

    rebootAffectedTasks = [];
    const reason = "Auto-failed by reboot sweep: worker session not found after server restart";

    for (const task of allInProgress) {
      if (!task.agentId) continue;

      const session = getActiveSessionForTask(task.id);
      if (session) continue; // Session exists — worker might still be alive, skip

      // Auto-fail the task
      const failed = failTask(task.id, reason);
      if (!failed) continue;

      // Fix agent status
      if (getActiveTaskCount(task.agentId) === 0) {
        updateAgentStatus(task.agentId, "idle");
      }

      // Auto-retry: create a replacement task with parentTaskId
      let retryTaskId: string | null = null;

      // Guard: only retry if parent doesn't already have a retry child
      const existingRetry = getDb()
        .prepare<{ id: string }, [string]>(
          `SELECT id FROM agent_tasks
           WHERE parentTaskId = ?
             AND status NOT IN ('completed', 'failed', 'cancelled')
           LIMIT 1`
        )
        .get(task.id);

      if (!existingRetry) {
        try {
          const retryTask = createTaskExtended(task.task, {
            parentTaskId: task.id,
            tags: ["reboot-retry", "auto-generated"],
            priority: task.priority,
            source: task.source,
            taskType: task.taskType ?? undefined,
            // No agentId — goes to pool as unassigned, auto-assign will route it
          });
          retryTaskId = retryTask.id;
          console.log(`[Heartbeat] Reboot retry created: ${retryTaskId} (parent: ${task.id})`);
        } catch (err) {
          console.error(`[Heartbeat] Failed to create retry task for ${task.id}:`, err);
        }
      }

      rebootAffectedTasks.push({ original: failed, retryTaskId });
    }

    console.log(
      `[Heartbeat] Reboot sweep complete: ${rebootAffectedTasks.length} task(s) auto-failed and retried`
    );
  } finally {
    isSweeping = false;
  }
}
```

Add a getter for boot triage to consume:
```typescript
/** Get tasks affected by the most recent reboot sweep */
export function getRebootAffectedTasks() {
  return rebootAffectedTasks;
}
```

#### 2. Wire reboot sweep into startup
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: In `startHeartbeat()` (line 577), replace the initial `setTimeout(() => runHeartbeatSweep(), 5000)` with:

```typescript
// Run aggressive reboot sweep first (no thresholds), then normal sweep cycle
setTimeout(async () => {
  await runRebootSweep();
  // First normal sweep after reboot sweep completes
  runHeartbeatSweep();
}, 5000);
```

#### 3. Export from index
**File**: `src/heartbeat/index.ts`
**Changes**: Add `runRebootSweep` and `getRebootAffectedTasks` to exports:
```typescript
export { startHeartbeat, stopHeartbeat, runRebootSweep, getRebootAffectedTasks } from "./heartbeat";
```

#### 4. Skip retry for heartbeat/system tasks
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: In `runRebootSweep()`, add this check right after the `if (!failed) continue;` line and the agent status fix, BEFORE the auto-retry block:
```typescript
// Don't retry system-generated heartbeat tasks
const skipRetryTypes = ["heartbeat-checklist", "boot-triage", "heartbeat"];
if (skipRetryTypes.includes(task.taskType ?? "")) {
  rebootAffectedTasks.push({ original: failed, retryTaskId: null });
  continue;
}
```
**Note**: This must be inserted into the `runRebootSweep()` function from step 1, between the agent status fix and the `// Auto-retry: create a replacement task` comment.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing heartbeat tests pass: `bun test src/tests/heartbeat.test.ts`
- [x] Existing checklist tests pass: `bun test src/tests/heartbeat-checklist.test.ts`

#### Manual Verification:
- [x] Start server with `bun run start:http`, verify "[Heartbeat] Reboot sweep: no in-progress tasks found" in logs (clean state)
- [x] Create a task manually, start a worker, kill the worker, restart the server. Verify the task is auto-failed within 5s and a retry task appears
- [x] Verify retry task has correct `parentTaskId`, tags `["reboot-retry", "auto-generated"]`, and is `unassigned`
- [x] Verify no retry is created for heartbeat-checklist or boot-triage tasks (covered by unit tests)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Enhanced Boot Triage

### Overview
Delay boot triage from T+30s to T+90s (after reboot sweep has completed). Add a "Reboot-Interrupted Work" section to the boot triage system status with full task IDs, retry status, and mandatory triage instructions. Include orphaned pending/offered tasks.

### Changes Required:

#### 1. Delay boot triage
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: In `startHeartbeatChecklist()` (line 667), change the boot triage delay:

```typescript
// Old: setTimeout(() => createBootTriageTask(), 30_000);
// New: Delay to T+90s — after reboot sweep (T+5s) has completed and results are available
setTimeout(() => createBootTriageTask(), 90_000);
```

#### 2. Add `isBootTriage` parameter to `gatherSystemStatus()`
**File**: `src/heartbeat/heartbeat.ts`
**Changes**:

First, add `getTasksByStatus` to the import from `../be/db` (line 1):
```typescript
import {
  // ... existing imports ...
  getTasksByStatus,  // <-- add this
} from "../be/db";
```

Then modify `gatherSystemStatus()` signature and add a boot-specific section:

```typescript
export function gatherSystemStatus(options?: { isBootTriage?: boolean }): string {
```

After the existing "Stalled Tasks" section (~line 383), add:

```typescript
// Reboot-interrupted work (boot triage only)
if (options?.isBootTriage) {
  const rebootTasks = getRebootAffectedTasks();

  if (rebootTasks.length > 0) {
    sections.push("");
    sections.push("## Reboot-Interrupted Work [auto-generated, ACTION REQUIRED]");
    sections.push(
      "The following tasks were in-progress before the restart. Their workers are no longer active."
    );
    sections.push("Each has been auto-failed and a retry task created where applicable.");
    sections.push("");

    for (const { original, retryTaskId } of rebootTasks) {
      const agentName = original.agentId
        ? getAllAgents().find((a) => a.id === original.agentId)?.name ?? original.agentId
        : "unassigned";
      const retryNote = retryTaskId
        ? `→ retry created: ${retryTaskId}`
        : "→ no retry (system task)";
      sections.push(
        `- [${original.id}] "${original.task.slice(0, 100)}" — was on ${agentName} ${retryNote}`
      );
    }

    sections.push("");
    sections.push("**You MUST triage each task above:**");
    sections.push("- Verify the retry task is progressing (check via `get-task-details`)");
    sections.push("- If the retry failed or the work is no longer needed, cancel it");
    sections.push("- Do NOT mark this boot triage as complete until all items are triaged");
  }

  // Orphaned pending/offered tasks (assigned to workers with no active session)
  // Note: uses exported getTasksByStatus() — do NOT use raw AgentTaskRow/rowToAgentTask
  // (those are internal to db.ts and not exported)
  const allAgents = getAllAgents();
  const orphanedTasks: AgentTask[] = [];

  for (const status of ["pending", "offered"] as const) {
    const tasks = getTasksByStatus(status);

    for (const task of tasks) {
      if (!task.agentId) continue;
      const agent = allAgents.find((a) => a.id === task.agentId);
      // If agent is offline or has no active sessions, task is orphaned
      if (!agent || agent.status === "offline") {
        orphanedTasks.push(task);
      }
    }
  }

  if (orphanedTasks.length > 0) {
    sections.push("");
    sections.push("## Orphaned Tasks [auto-generated, NEEDS ATTENTION]");
    sections.push(
      "These tasks are pending/offered but assigned to workers that are offline:"
    );
    for (const task of orphanedTasks) {
      const agentName = allAgents.find((a) => a.id === task.agentId)?.name ?? task.agentId ?? "?";
      sections.push(
        `- [${task.id}] "${task.task.slice(0, 100)}" — status: ${task.status}, assigned to: ${agentName}`
      );
    }
    sections.push("");
    sections.push("Consider re-assigning or cancelling these tasks.");
    sections.push("Note: Some workers may appear offline briefly while re-registering after the restart. Wait a few minutes before acting on these — auto-assign will handle re-routing once workers come online.");
  }
}
```

#### 3. Pass `isBootTriage` in `createBootTriageTask()`
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: In `createBootTriageTask()` (line 631):

```typescript
// Old: const systemStatus = gatherSystemStatus();
const systemStatus = gatherSystemStatus({ isBootTriage: true });
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test src/tests/heartbeat.test.ts && bun test src/tests/heartbeat-checklist.test.ts`

#### Manual Verification:
- [x] Start server, verify boot triage task appears at ~T+90s (not T+30s) — E2E confirmed at ~93s
- [x] Kill a worker mid-task, restart server. Verify boot triage includes "Reboot-Interrupted Work" section with full task IDs — E2E confirmed
- [x] Verify retry task IDs appear next to each auto-failed task — E2E confirmed
- [x] If any pending/offered tasks have offline agents, verify "Orphaned Tasks" section appears — covered by unit tests
- [x] Verify task IDs are full (not truncated to 8 chars) — covered by unit tests + E2E

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Prompt Improvements

### Overview
Update the heartbeat checklist and boot-triage prompt templates to give the lead explicit, non-dismissable instructions about reboot failures. Update the lead's CLAUDE.md with HEARTBEAT.md evolution guidance.

### Changes Required:

#### 1. Strengthen `heartbeat.checklist` template
**File**: `src/heartbeat/templates.ts`
**Changes**: Replace the `defaultBody` of the `heartbeat.checklist` template (lines 17-32):

```typescript
defaultBody: `Task Type: Heartbeat Checklist
Goal: Review system status and your standing orders, take action if needed.

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (snapshot from HEARTBEAT.md)
{{heartbeat_content}}

> The above is a snapshot. For the latest version, read \`/workspace/HEARTBEAT.md\` directly.

## Instructions
1. **Read your HEARTBEAT.md** — run \`read /workspace/HEARTBEAT.md\` to get the latest standing orders (the snapshot above may be slightly stale).
2. Review the system status above for anything that needs attention (stalled tasks, idle workers with available work, anomalies).
3. **CRITICAL — Reboot failure triage:** Failures with reason “worker session not found” or “worker session heartbeat is stale” indicate tasks that were INTERRUPTED by a server restart. These are NOT “expected auto-cleanup” — they represent work that was lost mid-execution. For each such failure:
   - Check what the task was (via \`get-task-details\` with the task ID from the failure)
   - If a retry task was auto-created (tagged \`reboot-retry\`), verify it is progressing
   - If no retry exists and the work is still needed, re-create the task
   - Do NOT dismiss these as “expected” or “auto-cleanup”
4. Review your standing orders for any periodic checks or actions.
5. If something needs attention — take action now using your available tools (create tasks, post to Slack, cancel stuck tasks, etc.).
6. If everything looks healthy and no standing orders are actionable — complete this task with a brief “All clear” summary. You may NOT say “All clear” if reboot-related failures exist that haven't been triaged.
7. Do NOT create another heartbeat-checklist task — the system handles scheduling.
8. **Update your standing orders** — After every heartbeat check, edit \`/workspace/HEARTBEAT.md\` directly. Add new patterns you noticed (recurring failures, workers needing attention), remove resolved items. This is your live operational runbook — keep it current.`,
```

#### 2. Strengthen `heartbeat.boot-triage` template
**File**: `src/heartbeat/templates.ts`
**Changes**: Replace the `defaultBody` of the `heartbeat.boot-triage` template (lines 53-76):

```typescript
defaultBody: `Task Type: Boot Triage
Goal: The system just restarted — assess current state and take action on interrupted work.

## Boot Event [auto-generated]
The API server has just restarted (deployment, pod rotation, or crash). An aggressive reboot sweep ran automatically and:
- Auto-failed all in-progress tasks whose workers had no active session
- Created retry tasks for each (tagged \`reboot-retry\`, linked via \`parentTaskId\`)

## Current System Status [auto-generated]
{{system_status}}

## Your Standing Orders (from HEARTBEAT.md)
{{heartbeat_content}}

## Instructions
1. **Triage reboot-interrupted work FIRST.** If the "Reboot-Interrupted Work" section above lists tasks:
   - For each task: verify the retry is progressing via \`get-task-details\` with the retry task ID
   - If a retry failed or is stuck, re-create the task manually
   - If the work is no longer needed, cancel the retry task
   - You MUST address every item — do NOT skip this section
2. **Check orphaned tasks.** If the "Orphaned Tasks" section lists pending/offered tasks assigned to offline workers, re-assign or cancel them.
3. Review agent status — are all expected workers online? If not, note which are missing.
4. Review your standing orders for any post-reboot checks.
5. Take action using your available tools.
6. Complete this task with a summary of what you found and what actions you took. Include the status of each reboot-interrupted task.
7. Do NOT create another boot-triage task — this is a one-off event.
8. **Update your standing orders** — If the reboot revealed a pattern worth monitoring (e.g., frequent restarts, specific tasks that keep failing), add a standing order to HEARTBEAT.md via \`update-profile\` with \`heartbeatMd\`.`,
```

#### 3. Update lead CLAUDE.md
**File**: `templates/official/lead/CLAUDE.md`
**Changes**: Find the HEARTBEAT.md description (search for `Your periodic checklist`) and replace:

```markdown
- **`/workspace/HEARTBEAT.md`** — Your live operational runbook. The system reads this every 30 minutes
  and creates a task for you with system status + your standing orders. You MUST keep this current:
  add new patterns you notice, remove resolved items. After every heartbeat check, update it via
  `update-profile` with `heartbeatMd`. An empty HEARTBEAT.md disables periodic checks.
```

#### 4. Update default HEARTBEAT.md template
**File**: `templates/official/lead/HEARTBEAT.md`
**Changes**: Replace the empty template with actionable defaults:

```markdown
# Heartbeat Checklist

## Standing Orders

- Check Slack for unaddressed requests older than 1 hour
- Review active tasks for any that seem stuck (no progress updates in 30+ min)
- If idle workers exist and unassigned tasks are available, investigate and route them
- Check for failed tasks — especially "worker session not found" failures which indicate interrupted work that may need re-creation
- Review reboot-retry tasks — verify they are progressing, cancel if work is no longer needed
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test src/tests/heartbeat.test.ts && bun test src/tests/heartbeat-checklist.test.ts`

#### Manual Verification:
- [x] Review the rendered checklist template: "CRITICAL — Reboot failure triage" is instruction #3
- [x] Review the rendered boot-triage template: "Triage reboot-interrupted work FIRST" is instruction #1
- [x] Verify the lead's CLAUDE.md description matches the new runbook framing
- [x] Verify HEARTBEAT.md template has real defaults (not just comments)
- [x] E2E confirmed: boot triage task body includes correct template with reboot instructions

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

### Unit tests (add to existing test files)

**`src/tests/heartbeat.test.ts`** — add:
- `runRebootSweep()` with no in_progress tasks → no-op
- `runRebootSweep()` with in_progress task + no session → auto-fails + creates retry
- `runRebootSweep()` with in_progress task + active session → skips (worker alive)
- `runRebootSweep()` retry dedup: parent already has non-terminal child → no second retry
- `runRebootSweep()` skip system tasks: `taskType=heartbeat-checklist` → no retry created
- `getRebootAffectedTasks()` returns correct data after sweep
- `runRebootSweep()` when `isSweeping` is true → returns immediately without modifying any tasks (race condition guard)

**`src/tests/heartbeat-checklist.test.ts`** — add:
- `gatherSystemStatus({ isBootTriage: true })` includes "Reboot-Interrupted Work" section
- `gatherSystemStatus({ isBootTriage: true })` includes orphaned pending/offered tasks
- `gatherSystemStatus()` (no boot flag) does NOT include reboot sections
- Full task IDs in output (not truncated)

### Manual E2E test

> **E2E executed 2026-04-03** — All checks passed. Automated script created a worker + task, killed server, restarted, and verified: reboot sweep at T+5s auto-failed the task + created retry with correct tags/parentTaskId; boot triage appeared at ~T+93s with "Reboot-Interrupted Work" section containing full task IDs and retry references.

### E2E Test A: Boot triage with reboot sweep

```bash
# 1. Start server
bun run start:http

# 2. Create a test task assigned to a worker
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Test task for reboot sweep", "agentId": "<worker-uuid>"}'

# 3. Simulate worker (mark task in_progress if not already)
# 4. Kill the server (Ctrl+C)
# 5. Restart: bun run start:http
# 6. Check logs for:
#    "[Heartbeat] Reboot sweep complete: 1 task(s) auto-failed and retried"
#    "[Heartbeat] Reboot retry created: <id> (parent: <id>)"
# 7. Wait ~90s, check for boot triage task:
curl -s http://localhost:3013/api/tasks?status=pending \
  -H "Authorization: Bearer 123123" | jq '.tasks[] | select(.taskType == "boot-triage")'
# 8. Verify boot triage contains "Reboot-Interrupted Work" section with full IDs
```

### E2E Test B: Periodic heartbeat with reboot failures

Tests that the lead's periodic checklist correctly surfaces reboot failures
instead of dismissing them as "expected auto-cleanup."

```bash
# 1. Start server with a short checklist interval (1 min instead of 30 min)
HEARTBEAT_CHECKLIST_INTERVAL_MS=60000 bun run start:http

# 2. Ensure lead has a non-empty HEARTBEAT.md (via API)
LEAD_ID=$(curl -s http://localhost:3013/api/agents \
  -H "Authorization: Bearer 123123" | jq -r '.agents[] | select(.isLead) | .id')
curl -X PUT http://localhost:3013/api/agents/$LEAD_ID/profile \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"heartbeatMd": "# Standing Orders\n- Check for failed tasks that need retry"}'

# 3. Create a task, assign to a worker, simulate it going in_progress
curl -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Important feature work", "agentId": "<worker-uuid>"}'

# 4. Kill the worker (not the server) — let the heartbeat sweep auto-fail the task
#    Wait for the 5-min no-session threshold to trigger auto-fail

# 5. Wait for the next checklist cycle (~1 min with the override)
#    Check for a heartbeat-checklist task:
curl -s http://localhost:3013/api/tasks?status=pending \
  -H "Authorization: Bearer 123123" | jq '.tasks[] | select(.taskType == "heartbeat-checklist")'

# 6. Verify the checklist task description includes:
#    - "Recent Failures" section with "worker session not found"
#    - The improved instructions about NOT dismissing reboot failures

# 7. If running a real lead agent: observe that it triages the failure
#    instead of saying "expected auto-cleanup, All clear"
```

## Errata

_Added 2026-04-03 during plan review. Cross-referenced all code snippets against the actual codebase._

### E1: `createTaskExtended` return type is `AgentTask`, not `AgentTask | null` (Phase 1, fixed)

The task description stated `createTaskExtended` returns `AgentTask | null`. The actual signature at `src/be/db.ts:1853` is:
```typescript
export function createTaskExtended(task: string, options?: CreateTaskOptions): AgentTask
```
It throws on failure (line 1953: `if (!row) throw new Error("Failed to create task")`), never returns null. The Phase 1 code snippet used `retryTask?.id ?? null` with unnecessary optional chaining. **Fixed**: replaced with `retryTask.id` and wrapped in try/catch for safety.

### E2: `rowToAgentTask` and `AgentTaskRow` are NOT exported from `db.ts` (Phase 2, fixed)

The Phase 2 orphaned-tasks query used `getDb().prepare<AgentTaskRow, [string]>(...).all(status).map(rowToAgentTask)` directly. Both `AgentTaskRow` (type, line 693) and `rowToAgentTask` (function, line 748) are internal to `src/be/db.ts` and not exported. `heartbeat.ts` does not import them and cannot access them.

**Fixed**: Replaced with the exported `getTasksByStatus(status)` function (line 1012), which internally does the same query and mapping. Added `getTasksByStatus` to the import list from `../be/db`.

### E3: Race condition between `runRebootSweep()` and `runHeartbeatSweep()` (Phase 1, fixed)

The original plan did not include an `isSweeping` guard in `runRebootSweep()`. Although the startup code runs them sequentially (`await runRebootSweep(); runHeartbeatSweep()`), the interval timer set by `setInterval` in `startHeartbeat()` fires independently. If the reboot sweep takes longer than `intervalMs`, a normal sweep could start concurrently.

**Fixed**: Added `isSweeping` guard and try/finally to `runRebootSweep()`, matching the pattern already used by `runHeartbeatSweep()`.

### E4: `source` field on `AgentTask` is non-optional (minor, fixed)

`AgentTask.source` is typed as `AgentTaskSource` with `.default("mcp")` — it always has a value. The plan used `task.source ?? undefined` which is harmless but misleading (the `?? undefined` never triggers). **Fixed**: changed to `task.source` directly.

### E5: Missing `runRebootSweep` in index.ts exports (Phase 1, fixed)

The plan only mentioned exporting `getRebootAffectedTasks` from `src/heartbeat/index.ts`, but `runRebootSweep` also needs to be exported if any external code calls it (e.g., tests). **Fixed**: added both to the export statement.

### E6: Paused tasks are not mentioned in "What We're NOT Doing" (fixed)

The codebase has a graceful shutdown mechanism (`src/commands/runner.ts`) that pauses in-progress tasks (status `paused`, `was_paused=1`). Workers resume these on restart via `GET /api/paused-tasks`. The reboot sweep correctly targets only `in_progress` tasks and skips `paused` ones — but this distinction is not documented in the plan. Implementers should be aware that `paused` tasks follow a separate resume path and should NOT be auto-failed by the reboot sweep.

### E7: Test strategy does not cover the `isSweeping` race condition (fixed)

The unit test plan lists reboot sweep scenarios but does not include a test verifying that `runRebootSweep` and `runHeartbeatSweep` cannot run concurrently. Consider adding: "If `isSweeping` is true when `runRebootSweep()` is called, it should return immediately without modifying any tasks."

### E8: Orphaned-task detection may be noisy post-reboot (fixed)

After a reboot, most workers will briefly be `offline` while re-registering. The Phase 2 orphaned-task query checks `agent.status === "offline"` — at T+90s (when boot triage runs), workers that are still re-registering will appear offline and their `pending`/`offered` tasks will show as orphaned. This may produce false positives. The auto-assign mechanism will handle re-routing once workers come online, so this is informational noise rather than a bug — but the boot triage prompt should note this possibility.

### E9: Lead CLAUDE.md line numbers are approximate (fixed)

The plan references "line 21-23" for the HEARTBEAT.md description in `templates/official/lead/CLAUDE.md`. These line numbers are correct as of the current commit, but the file has no line-stable anchors. Implementers should search for the text `Your periodic checklist` rather than relying on line numbers.

## References
- Research & assessment: `thoughts/taras/research/2026-04-03-heartbeat-unified-assessment.md`
- Paperclip heartbeat: `thoughts/taras/research/2026-04-03-paperclip-heartbeat-system.md`
- OpenClaw heartbeat: `thoughts/taras/research/2026-04-03-openclaw-heartbeat-health-system.md`
