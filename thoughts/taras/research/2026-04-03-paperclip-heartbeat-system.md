---
date: 2026-04-03
researcher: claude
tags: [heartbeat, health-check, paperclip, orchestration, agent-monitoring]
status: complete
repo: https://github.com/paperclipai/paperclip
branch: master
---

# Paperclip Heartbeat / Health-Check System

## Research Question

How does the Paperclip orchestration platform implement its heartbeat/health-check system? Specifically: heartbeat mechanism details, agent/worker health monitoring, boot-up/restart triage, standing orders/periodic checks, and leader/orchestrator heartbeat management patterns.

## Summary

Paperclip's heartbeat system is the core execution engine for its agent orchestration platform. Unlike a traditional keep-alive ping, a "heartbeat" in Paperclip is a **full agent execution cycle** -- wake up, check work, do something useful, exit. The system is built around a centralized server-side scheduler that manages wakeup requests, run lifecycle, session persistence, orphan detection, and automatic recovery. It uses PostgreSQL for all state, with no in-memory-only coordination.

---

## 1. Heartbeat Mechanism

### 1.1 What a "heartbeat" is

A heartbeat is not a health ping. It is a **complete agent invocation cycle**. Each heartbeat:

1. Wakes the agent via its configured adapter (Claude CLI, Codex CLI, HTTP, process, etc.)
2. Passes context (current task, wake reason, session state)
3. Lets the agent work until it exits, times out, or is cancelled
4. Records results (status, token usage, errors, logs, session ID)
5. Pushes live updates to the dashboard via WebSocket

**File:** `server/src/services/heartbeat.ts` (4013 lines -- the largest service file)

### 1.2 Wakeup sources

Four invocation sources, defined in `packages/shared/src/constants.ts`:

```typescript
export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",        // Scheduled interval (e.g. every 5 minutes)
  "assignment",   // Work assigned/checked out to the agent
  "on_demand",    // Manual wakeup (button/API)
  "automation",   // System-triggered (process-loss retry, routine triggers)
] as const;
```

Each wakeup also carries a `triggerDetail`: `"manual" | "ping" | "callback" | "system"`.

### 1.3 Run lifecycle states

```typescript
export const HEARTBEAT_RUN_STATUSES = [
  "queued",     // Waiting to be claimed
  "running",    // Actively executing
  "succeeded",  // Completed successfully
  "failed",     // Adapter error / non-zero exit
  "cancelled",  // Manually or budget-cancelled
  "timed_out",  // Exceeded configured timeout
] as const;
```

### 1.4 What gets stored per run

The `heartbeat_runs` table (`packages/db/src/schema/heartbeat_runs.ts`) stores:

| Column | Purpose |
|--------|---------|
| `id` | UUID primary key |
| `companyId`, `agentId` | Ownership |
| `invocationSource`, `triggerDetail` | Why this run happened |
| `status` | Run lifecycle state |
| `startedAt`, `finishedAt` | Timing |
| `error`, `errorCode` | Failure details |
| `exitCode`, `signal` | Process exit info |
| `usageJson` | Token counts, cost, provider, model, billing type |
| `resultJson` | Structured result from the adapter |
| `sessionIdBefore`, `sessionIdAfter` | Session continuity tracking |
| `logStore`, `logRef`, `logBytes`, `logSha256`, `logCompressed` | Full log storage reference |
| `stdoutExcerpt`, `stderrExcerpt` | Last N bytes of output |
| `processPid`, `processStartedAt` | Child process tracking for orphan detection |
| `retryOfRunId`, `processLossRetryCount` | Retry chain tracking |
| `contextSnapshot` | Full wake context (issueId, taskKey, wakeReason, workspace info, etc.) |
| `wakeupRequestId` | Link to the originating wakeup request |

Events are stored separately in `heartbeat_run_events` with sequenced entries per run (lifecycle events, adapter invocations, log chunks).

### 1.5 Update intervals

The heartbeat scheduler runs on a configurable `setInterval` in `server/src/index.ts`:

```typescript
if (config.heartbeatSchedulerEnabled) {
  const heartbeat = heartbeatService(db);
  const routines = routineService(db);

  // Startup recovery: reap orphans then resume queued
  void heartbeat
    .reapOrphanedRuns()
    .then(() => heartbeat.resumeQueuedRuns())
    .catch(...);

  setInterval(() => {
    void heartbeat.tickTimers(new Date())...;
    void routines.tickScheduledTriggers(new Date())...;
    void heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
      .then(() => heartbeat.resumeQueuedRuns())...;
  }, config.heartbeatSchedulerIntervalMs);
}
```

Each tick does three things:
1. **Timer tick** -- checks all agents for elapsed heartbeat intervals
2. **Routine trigger tick** -- fires cron-based routine triggers
3. **Orphan reaping + queue resumption** -- detects dead runs and resumes waiting work

Per-agent heartbeat interval is configured via `runtimeConfig.heartbeat.intervalSec`. The `tickTimers` method iterates all agents and compares `now - lastHeartbeatAt` against `intervalSec`.

### 1.6 Wakeup coalescing

If an agent already has an active run (queued or running) for the same task scope, new wakeups are **coalesced** rather than creating duplicate runs:

- Same-scope queued run exists: context is merged into the existing queued run
- Same-scope running run exists (no queued): context merged into running run
- Exception: comment-mention wakes always queue a follow-up even if running

For issue-scoped wakes, there is an **execution lock** system:
- Each issue tracks `executionRunId` -- which run currently "owns" it
- If another agent tries to wake for the same issue, the wakeup is **deferred** (`deferred_issue_execution` status)
- When the owning run finishes, deferred wakes are **promoted** to queued

### 1.7 Concurrency control

Per-agent concurrency is controlled by `heartbeat.maxConcurrentRuns` (default 1, max 10). The `startNextQueuedRunForAgent` function respects this limit:

```typescript
const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
if (availableSlots <= 0) return [];
```

A per-agent start lock (`startLocksByAgent` Map) prevents race conditions during concurrent claim attempts.

---

## 2. Agent/Worker Health Monitoring

### 2.1 Agent status tracking

Agent status (`packages/shared/src/constants.ts`):

```typescript
export const AGENT_STATUSES = [
  "active",           // Legacy/initial
  "paused",           // Manually paused by board
  "idle",             // Not running, last run succeeded/cancelled
  "running",          // Currently executing a heartbeat
  "error",            // Last run failed
  "pending_approval", // Awaiting board approval
  "terminated",       // Permanently stopped
] as const;
```

Status transitions happen in `finalizeAgentStatus`:
- If running count > 0 after a run finishes: stays `running`
- If run succeeded/cancelled and no other runs active: `idle`
- If run failed: `error`
- `paused`/`terminated` are sticky -- heartbeat completion does not override them

`lastHeartbeatAt` is updated on every run completion, providing a "last seen" timestamp.

### 2.2 Process-level liveness detection

For local CLI adapters (`claude_local`, `codex_local`, `cursor`, `gemini_local`, `opencode_local`, `pi_local`), Paperclip tracks the child process PID:

```typescript
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);  // Signal 0 = liveness check
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;   // Process exists but no permission
    if (code === "ESRCH") return false;  // Process does not exist
    return false;
  }
}
```

The `runningProcesses` Map in `server/src/adapters/index.ts` tracks in-memory references to spawned child processes. On server restart, this map is empty, which is how the system detects orphaned runs.

### 2.3 "Detached" process warning

When the server loses its in-memory handle to a child process but the PID is still alive (e.g., after a hot reload):

```typescript
if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
  if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
    // Mark as detached but keep running
    setRunStatus(run.id, "running", {
      error: "Lost in-memory process handle, but child pid ${run.processPid} is still alive",
      errorCode: "process_detached",
    });
  }
  continue;  // Do NOT reap -- process is still alive
}
```

If the detached process later reports activity (e.g. via adapter callback), the warning is cleared via `clearDetachedRunWarning`.

### 2.4 Health endpoint

`server/src/routes/health.ts` provides a `GET /api/health` endpoint that checks:
- Database reachability (`SELECT 1`)
- Server version
- Deployment mode and exposure
- Bootstrap status (for authenticated deployments)
- Dev server status (if applicable)
- Count of active heartbeat runs (queued + running)

### 2.5 Budget-based health gating

Before any wakeup, the system checks budget enforcement:

```typescript
const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
  issueId, projectId,
});
if (budgetBlock) {
  await cancelRunInternal(run.id, budgetBlock.reason);
  return null;
}
```

Budget enforcement can cancel all active runs and pending wakeups for a scope (agent, project, or company).

---

## 3. Boot-up / Restart Triage

### 3.1 Startup recovery sequence

On server startup (`server/src/index.ts`), before the scheduler loop starts:

```typescript
// Reap orphaned running runs at startup while in-memory execution state is empty,
// then resume any persisted queued runs that were waiting on the previous process.
void heartbeat
  .reapOrphanedRuns()
  .then(() => heartbeat.resumeQueuedRuns())
  .catch((err) => {
    logger.error({ err }, "startup heartbeat recovery failed");
  });
```

This two-step recovery:
1. **Reap orphans** -- find all runs in `running` status that have no in-memory process handle
2. **Resume queued** -- find all runs in `queued` status and drive them forward

### 3.2 `reapOrphanedRuns` in detail

This is the core restart triage logic (`server/src/services/heartbeat.ts`, ~line 1854):

```typescript
async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
  // Find all runs stuck in "running" state
  const activeRuns = await db.select(...)
    .from(heartbeatRuns)
    .innerJoin(agents, ...)
    .where(eq(heartbeatRuns.status, "running"));

  for (const { run, adapterType } of activeRuns) {
    // Skip runs that still have an in-memory handle
    if (runningProcesses.has(run.id) || activeRunExecutions.has(run.id)) continue;

    // Apply staleness threshold (periodic reaps use 5min)
    if (staleThresholdMs > 0) {
      const refTime = run.updatedAt.getTime();
      if (now.getTime() - refTime < staleThresholdMs) continue;
    }

    // For local adapters: check if child process is still alive
    if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
      // Mark as "detached" but don't kill it
      continue;
    }

    // Process is dead or unknown -- decide on retry
    const shouldRetry = tracksLocalChild && !!run.processPid && processLossRetryCount < 1;

    // Mark original run as failed with errorCode: "process_lost"
    await setRunStatus(run.id, "failed", {
      error: shouldRetry ? "...retrying once" : "Process lost",
      errorCode: "process_lost",
    });

    // If eligible: enqueue exactly ONE automatic retry
    if (shouldRetry) {
      await enqueueProcessLossRetry(run, agent, now);
    } else {
      // Release issue execution lock so other agents can pick it up
      await releaseIssueExecutionAndPromote(run);
    }
  }
}
```

Key behaviors:
- **Startup reap** (staleThresholdMs = 0): reaps ALL orphans immediately
- **Periodic reap** (staleThresholdMs = 5 min): only reaps runs that have been stale for 5+ minutes
- **One automatic retry**: local adapter runs with a known PID get exactly one retry (`processLossRetryCount < 1`)
- **Issue lock release**: when a run is reaped, the issue's `executionRunId` is cleared, and deferred wakes are promoted

### 3.3 Process-loss retry mechanism

`enqueueProcessLossRetry` creates a new run that:
- Links to the original via `retryOfRunId`
- Increments `processLossRetryCount` (max 1 retry)
- Preserves the original context snapshot (issueId, taskKey, etc.)
- Sets `wakeReason: "process_lost_retry"` and `retryReason: "process_lost"`
- Resolves session state from `agentTaskSessions` so the retry can resume the conversation

If the retry also fails (processLossRetryCount reaches 1), no further retries are attempted.

### 3.4 `resumeQueuedRuns`

After reaping, this function finds all runs in `queued` status and drives them forward:

```typescript
async function resumeQueuedRuns() {
  const queuedRuns = await db.select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.status, "queued"));

  const agentIds = [...new Set(queuedRuns.map(r => r.agentId))];
  for (const agentId of agentIds) {
    await startNextQueuedRunForAgent(agentId);
  }
}
```

### 3.5 Session persistence across restarts

Session state is stored in two places for resilience:
1. **`agentRuntimeState`** -- legacy per-agent session ID (global fallback)
2. **`agentTaskSessions`** -- per-task-key session params (preferred)

The task session system enables per-issue session continuity. A synthetic `__heartbeat__` task key is used for timer wakes that have no specific issue context, so even timer heartbeats get session resume.

Session compaction detects when sessions grow too large (by run count, token count, or age) and forces a session rotation with a handoff markdown summary.

---

## 4. "Standing Orders" / Periodic Checks (Routines)

### 4.1 Routines system

Paperclip has a full **Routines** system (`server/src/services/routines.ts`, `packages/db/src/schema/routines.ts`) that implements standing orders / periodic checks.

A routine is a recurring task template with:
- **Title and description** (with variable interpolation)
- **Assignee agent**
- **Project and goal** linkage
- **Priority**
- **Variables** (typed: string, number, boolean, select -- with defaults and validation)
- **Triggers** (cron or webhook)
- **Concurrency policy**: `coalesce_if_active` (merge into existing) or `always_create`
- **Catch-up policy**: `skip_missed` (don't fire missed ticks) or `run_missed`

### 4.2 Routine triggers

Two kinds of triggers (`routineTriggers` table):

1. **Cron triggers** -- standard cron expressions with timezone support. The `tickScheduledTriggers` method is called from the same `setInterval` as the heartbeat timer.

2. **Webhook triggers** -- external HTTP triggers with HMAC signing, replay protection, and secret rotation. Each webhook trigger gets a unique `publicId` and signing secret.

### 4.3 Routine execution flow

When a routine fires:
1. Creates a `routineRuns` record
2. Creates an issue (task) from the routine template with interpolated variables
3. Assigns it to the routine's designated agent
4. Triggers a wakeup for that agent (which goes through the full heartbeat pipeline)
5. Tracks the linked issue status back on the routine run

Concurrency handling:
- `coalesce_if_active`: if a live issue from the same routine already exists (non-terminal status), the new run is coalesced rather than creating a duplicate issue
- `always_create`: always creates a new issue regardless

### 4.4 Catch-up policy

On startup or after downtime, `skip_missed` (default) skips any missed cron ticks and just schedules the next future one. The alternative `run_missed` would fire missed ticks up to `MAX_CATCH_UP_RUNS = 25`.

---

## 5. Leader/Orchestrator Heartbeat Management

### 5.1 CEO agent pattern

Paperclip models organizations with a hierarchical org chart. The CEO agent is the top-level orchestrator. A dedicated `HEARTBEAT.md` file (`server/src/onboarding-assets/ceo/HEARTBEAT.md`) defines the CEO's heartbeat checklist:

1. **Identity check** -- `GET /api/agents/me`
2. **Local planning check** -- read daily plan from `$AGENT_HOME/memory/YYYY-MM-DD.md`
3. **Approval follow-up** -- handle pending approvals
4. **Get assignments** -- fetch inbox
5. **Checkout and work** -- atomically checkout tasks before working
6. **Delegation** -- create subtasks for reports, hire new agents
7. **Fact extraction** -- update knowledge base
8. **Exit** -- comment on in-progress work

CEO-specific responsibilities:
- Strategic direction and goal setting
- Hiring new agents (via `paperclip-create-agent` skill)
- Unblocking reports
- Budget awareness (above 80% spend, focus only on critical tasks)
- Never look for unassigned work -- only work assigned tasks
- Never cancel cross-team tasks -- reassign to relevant manager

### 5.2 The heartbeat protocol

The standard heartbeat protocol (`docs/guides/agent-developer/heartbeat-protocol.md`) is the contract every agent follows:

1. **Identity** -- `GET /api/agents/me`
2. **Approval follow-up** -- handle `PAPERCLIP_APPROVAL_ID` if set
3. **Get assignments** -- fetch issues sorted by priority
4. **Pick work** -- `in_progress` first, then `todo`, skip `blocked`
5. **Checkout** -- `POST /api/issues/{issueId}/checkout` (atomic, 409 = someone else owns it)
6. **Context** -- read issue and comments
7. **Do work** -- use tools
8. **Update status** -- `PATCH /api/issues/{issueId}` with status + comment
9. **Delegate** -- create subtasks for reports

Critical rules:
- **Always checkout before working** -- never manually set `in_progress`
- **Never retry a 409** -- the task belongs to someone else
- **Always comment** on in-progress work before exiting
- **Always include `X-Paperclip-Run-Id` header** on mutating API calls

### 5.3 Atomic task checkout

The checkout mechanism (`POST /api/issues/{issueId}/checkout`) is the coordination primitive. It:
- Atomically claims a task for an agent
- Returns 409 Conflict if already checked out by another agent
- Supports `expectedStatuses` to only checkout from specific states
- Links the checkout to a specific heartbeat run ID

This replaces leader-based work distribution with a **competitive checkout model** -- any agent can attempt checkout, but only one succeeds.

### 5.4 Environment injection

Each heartbeat run injects standardized environment variables:

```
PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL,
PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_REASON,
PAPERCLIP_WAKE_COMMENT_ID, PAPERCLIP_APPROVAL_ID
```

Plus a JWT token (`PAPERCLIP_API_KEY`) for authenticated API access.

### 5.5 Delegation flows down the org chart

Manager agents can create subtasks and assign them to their reports. When a subtask is assigned, it triggers an `assignment` wakeup for the assigned agent. The assignment flow:
- Creates an issue with `parentId` (for hierarchy) and `goalId` (for goal alignment)
- Triggers `queueIssueAssignmentWakeup` which calls `enqueueWakeup` with source `assignment`
- The assigned agent wakes up on its next heartbeat (or immediately if wake-on-assignment is enabled)

### 5.6 Live monitoring

Real-time updates are pushed via WebSocket (`server/src/realtime/live-events-ws.ts`):
- `heartbeat.run.queued` -- new run queued
- `heartbeat.run.status` -- run status changed
- `heartbeat.run.event` -- lifecycle events
- `heartbeat.run.log` -- stdout/stderr chunks
- `agent.status` -- agent status changed

---

## Key Architectural Patterns

### Pattern 1: Wakeup Request + Run separation
Wakeup requests (`agentWakeupRequests`) are separated from runs (`heartbeatRuns`). A wakeup can be coalesced, deferred, skipped, or cancelled before a run is created. This provides clean auditing of why wakeups were dropped.

### Pattern 2: Issue execution lock with deferred promotion
The `executionRunId` on issues provides mutual exclusion. When a run finishes, deferred wakes are automatically promoted in FIFO order. This prevents multiple agents from working the same task simultaneously.

### Pattern 3: Per-agent start lock
`withAgentStartLock` ensures that concurrent `startNextQueuedRunForAgent` calls for the same agent are serialized, preventing duplicate claims.

### Pattern 4: Session continuity via task-keyed sessions
`agentTaskSessions` stores per-task session params (adapter-specific, e.g. Claude session ID). This means the same agent working on different tasks maintains separate conversation contexts. Timer heartbeats use a synthetic `__heartbeat__` key.

### Pattern 5: Graceful degradation on restart
The three-tier recovery (detached warning -> process-loss retry -> fail and release) ensures that no run is permanently stuck, but live processes are not killed unnecessarily.

---

## Code References

| File | Purpose |
|------|---------|
| `server/src/services/heartbeat.ts` | Core heartbeat service (4013 lines) |
| `server/src/index.ts` | Server startup, scheduler loop, startup recovery |
| `packages/db/src/schema/heartbeat_runs.ts` | Run table schema |
| `packages/db/src/schema/heartbeat_run_events.ts` | Run events schema |
| `packages/shared/src/types/heartbeat.ts` | Shared TypeScript types |
| `packages/shared/src/constants.ts` | Status/source enums |
| `server/src/routes/health.ts` | Health check endpoint |
| `server/src/services/routines.ts` | Routines (standing orders) service |
| `packages/db/src/schema/routines.ts` | Routines/triggers/runs schema |
| `server/src/onboarding-assets/ceo/HEARTBEAT.md` | CEO heartbeat checklist |
| `docs/guides/agent-developer/heartbeat-protocol.md` | Agent heartbeat protocol docs |
| `docs/agents-runtime.md` | Runtime configuration guide |
| `evals/promptfoo/prompts/heartbeat-system.txt` | System prompt for heartbeat evals |
| `cli/src/commands/heartbeat-run.ts` | CLI heartbeat invocation command |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | Orphan recovery tests |
| `server/src/__tests__/heartbeat-workspace-session.test.ts` | Session continuity tests |
| `server/src/services/plugin-job-scheduler.ts` | Plugin job scheduler (30s tick loop) |
