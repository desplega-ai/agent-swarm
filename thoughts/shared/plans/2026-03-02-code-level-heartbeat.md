---
date: 2026-03-02T22:55:00Z
topic: "Code-Level Heartbeat for Swarm Triage"
type: plan
status: draft
github_issue: 101
---

# Code-Level Heartbeat for Swarm Triage — Implementation Plan

## Overview

Implement a lightweight code-level heartbeat module that runs on the API server (alongside the scheduler) to handle swarm triage WITHOUT spinning up Claude sessions. The heartbeat uses a 3-tier approach: preflight gate → code-level triage → Claude escalation (only when needed).

GitHub Issue: #101

## Current State Analysis

- **No triage code exists** — there's zero triage logic anywhere in the codebase
- **Scheduler pattern** (`src/scheduler/scheduler.ts:176-224`) provides a proven template: `startScheduler`/`stopScheduler` with `setInterval`, concurrency guard via `isProcessing` flag, and startup from `src/http.ts:2820-2825`
- **Existing DB queries** cover most needs:
  - `getTaskStats()` (`db.ts:1767`) — counts by status (in_progress, unassigned, etc.)
  - `getAllAgents()` (`db.ts:1174`) — all agents with status (idle/busy/offline)
  - `getActiveTaskCount(agentId)` (`db.ts:1282`) — per-agent active tasks
  - `hasCapacity(agentId)` (`db.ts:1294`) — capacity check
  - `releaseStaleReviewingTasks()` (`db.ts:2605`) — stale review cleanup
  - `releaseStaleMentionProcessing()` (`db.ts:3538`) — stale mention cleanup
  - `releaseStaleProcessingInbox()` (`db.ts:4421`) — stale inbox cleanup
  - `cleanupStaleSessions()` (`db.ts:6144`) — stale session cleanup
  - `getEpicsWithProgressUpdates()` (`db.ts:5233`) — epic progress
  - `getCompletedSlackTasks()` (`db.ts:1822`) — completed Slack tasks
  - `getRecentlyFinishedWorkerTasks()` (`db.ts:1839`) — unnotified worker task completions
  - `getUnassignedTasksCount()` (`db.ts:2661`) — pool size
  - `claimTask()` (`db.ts:2420`) — atomic pool task claiming
- **The scheduler is started in `http.ts:2820-2825`** and stopped in `http.ts:2766-2769`
- **Task auto-assignment currently works via polling**: workers poll `/api/poll` which returns `pool_tasks_available` trigger, then workers use `task-action` tool to claim. There's NO server-side auto-assignment.

### Key Discoveries:
- `db.ts:1587` `getTasksByStatus("in_progress")` returns all in-progress tasks
- `db.ts:1174` `getAllAgents()` returns agents with `status`, `maxTasks` fields
- `db.ts:2420` `claimTask(taskId, agentId)` is atomic — perfect for auto-assignment
- `db.ts:1517` `getPendingTaskForAgent(agentId)` finds ready tasks respecting dependency order
- `http.ts:2820-2825` shows the pattern for starting the heartbeat (dynamic import + env config)
- `scheduler/scheduler.ts:196-211` shows the concurrency guard pattern (`isProcessing` flag)
- Worker `pool_tasks_available` trigger (`http.ts:657-665`) only notifies workers about pool tasks — doesn't assign them

## Desired End State

A new `src/heartbeat/` module that:
1. Runs a configurable interval (default 90s) on the API server
2. Tier 1: Preflight gate bails early if nothing looks actionable (zero cost for healthy swarms)
3. Tier 2: Handles stall detection, worker health, pool auto-assignment, stale cleanup, epic staleness — all in code
4. Tier 3: Creates a triage task for the lead agent only when ambiguous situations need human reasoning
5. Logs all actions for observability
6. Is started/stopped alongside the scheduler in `http.ts`

## Quick Verification Reference

- `bun test src/tests/heartbeat.test.ts` — heartbeat-specific tests
- `bun run lint:fix` — lint + format
- `bun run tsc:check` — type check
- `bun test` — all tests

Key files:
- `src/heartbeat/heartbeat.ts` — main heartbeat module
- `src/heartbeat/index.ts` — barrel export
- `src/tests/heartbeat.test.ts` — tests
- `src/http.ts` — startup/shutdown integration

## What We're NOT Doing

- Not replacing the existing scheduler — the heartbeat is a separate concern
- Not adding Slack notification sending directly — the heartbeat logs findings and creates tasks
- Not building a complex rules engine — simple threshold-based checks
- Not adding a UI dashboard for heartbeat results — just console logging + task creation for escalation
- Not implementing the `swarm-heartbeat-triage` schedule (referenced in the issue but doesn't exist) — the code-level heartbeat replaces that concept entirely

## Implementation Approach

Follow the scheduler pattern exactly: create a `src/heartbeat/` module with `startHeartbeat`/`stopHeartbeat` exports, a `setInterval` loop with a concurrency guard, and start/stop it from `http.ts`. The heartbeat sweep function runs three tiers sequentially, accumulating findings. Environment variable `HEARTBEAT_INTERVAL_MS` controls the interval (default 90000 = 90s).

---

## Phase 1: Core Heartbeat Module (Tier 1 + Tier 2)

### Overview
Create the heartbeat module with the preflight gate and all code-level triage checks.

### Changes Required:

#### 1. Heartbeat Module
**File**: `src/heartbeat/heartbeat.ts` (new)
**Changes**: Create the main heartbeat module with:

- Exports: `startHeartbeat(intervalMs)`, `stopHeartbeat()`
- Internal: `runHeartbeatSweep()` with concurrency guard (`isSweeping` flag)
- Tier 1 preflight gate: `getTaskStats()` + `getAllAgents()` → bail if nothing actionable
- Tier 2 triage checks:
  1. `detectStalledTasks()` — in_progress tasks with `lastUpdatedAt` > 30min threshold
  2. `checkWorkerHealth()` — fix mismatched agent status vs active task count
  3. `autoAssignPoolTasks()` — assign unassigned tasks to idle workers using `claimTask()`
  4. `cleanupStaleResources()` — call existing stale release functions
  5. `checkEpicStaleness()` — active epics with no recent updates
- Tier 3 escalation: Create a triage task for lead agent if ambiguous findings exist
- Configurable thresholds via env vars with sensible defaults

#### 2. Barrel Export
**File**: `src/heartbeat/index.ts` (new)
**Changes**: `export { startHeartbeat, stopHeartbeat } from "./heartbeat";`

#### 3. HTTP Server Integration
**File**: `src/http.ts`
**Changes**:
- Import and start heartbeat alongside scheduler in the server listen callback (~line 2820)
- Stop heartbeat in shutdown function (~line 2766)
- Guard with env var `HEARTBEAT_DISABLE`

#### 4. New DB Queries
**File**: `src/be/db.ts`
**Changes**: Add three new functions:
- `getStalledInProgressTasks(thresholdMinutes)` — returns in_progress tasks with stale `lastUpdatedAt`
- `getIdleWorkersWithCapacity()` — non-lead, non-offline agents with idle status and remaining capacity
- `getUnassignedPoolTasks(limit)` — unassigned tasks ordered by priority DESC, createdAt ASC

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun run tsc:check`
- [ ] Lint passes: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun run lint:fix`
- [ ] File exists: `ls src/heartbeat/heartbeat.ts src/heartbeat/index.ts`

#### Manual Verification:
- [ ] Heartbeat module follows scheduler pattern (setInterval, concurrency guard, start/stop exports)
- [ ] Preflight gate queries are lightweight (single `getTaskStats()` + `getAllAgents()`)
- [ ] Auto-assignment uses atomic `claimTask()` to prevent races
- [ ] All thresholds are configurable via env vars

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Tests

### Overview
Add comprehensive tests for the heartbeat module.

### Changes Required:

#### 1. Heartbeat Tests
**File**: `src/tests/heartbeat.test.ts` (new)
**Changes**: Follow the pattern from `src/tests/scheduled-tasks.test.ts` (isolated SQLite DB, `initDb`/`closeDb` in `beforeAll`/`afterAll`):

Tests:
1. Preflight gate - empty state: No tasks, no agents → gate returns false (bail)
2. Preflight gate - healthy state: Only completed tasks, all agents idle, no pool tasks → gate returns false
3. Preflight gate - actionable state: Unassigned pool tasks exist → gate returns true
4. Stall detection: Create an in_progress task with old `lastUpdatedAt` → detected as stalled
5. Auto-assignment: Create idle worker + unassigned pool task → task gets auto-assigned via `claimTask`
6. Auto-assignment respects capacity: Worker at max capacity → not assigned
7. Auto-assignment skips leads: Lead agent is idle → not used for auto-assignment
8. Auto-assignment skips offline: Offline worker → not used for auto-assignment
9. Worker health fix: Agent marked busy with 0 active tasks → status corrected to idle
10. Concurrency guard: Two concurrent sweeps → only one runs
11. Start/stop lifecycle: `startHeartbeat` + `stopHeartbeat` work correctly

### Success Criteria:

#### Automated Verification:
- [ ] Heartbeat tests pass: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun test src/tests/heartbeat.test.ts`
- [ ] All tests pass: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun test`
- [ ] Lint passes: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun run lint:fix`

#### Manual Verification:
- [ ] Tests cover all three tiers
- [ ] Tests use isolated DB (no shared state)
- [ ] Tests clean up after themselves

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Final Polish + PR

### Overview
Run full checks and create PR.

### Changes Required:

#### 1. Final lint + type check
Run `bun run lint:fix` and `bun run tsc:check` to ensure everything is clean.

#### 2. Commit
Clear commit message referencing Issue #101.

#### 3. Create PR
Use `wts pr` to create PR with `tarasyarema` as reviewer, referencing "Closes #101".

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun test`
- [ ] Lint passes: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun run lint:fix`
- [ ] Type check passes: `cd /home/worker/.worktrees/agent-swarm/2026-03-02-feat/code-level-heartbeat && bun run tsc:check`

#### Manual Verification:
- [ ] PR created with `tarasyarema` as reviewer
- [ ] PR body references "Closes #101"
- [ ] PR body describes the 3-tier architecture

**Implementation Note**: After completing this phase, the task is done.

---

## Testing Strategy

- **Unit tests** (`src/tests/heartbeat.test.ts`): Isolated SQLite DB, test each tier independently
- **Integration**: The heartbeat uses the same DB functions as the rest of the system — no new DB schema changes needed
- **No E2E**: The heartbeat is an internal server component, tested at the unit level

## References
- GitHub Issue: #101
- Scheduler pattern: `src/scheduler/scheduler.ts`
- DB queries: `src/be/db.ts`
- HTTP server lifecycle: `src/http.ts:2762-2830`
