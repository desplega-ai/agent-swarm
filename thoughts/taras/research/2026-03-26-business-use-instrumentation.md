---
date: 2026-03-26T12:00:00-07:00
researcher: Claude
git_commit: 437e967
branch: main
repository: agent-swarm
topic: "Business-use instrumentation: current usage, correctness, and needed changes"
tags: [research, business-use, instrumentation, state-machine, distributed]
status: complete
autonomy: critical
last_updated: 2026-03-26
last_updated_by: Claude
---

# Research: Business-Use Instrumentation in Agent Swarm

**Date**: 2026-03-26
**Researcher**: Claude
**Git Commit**: 437e967
**Branch**: main

## Research Question

Check the current usage of `@desplega.ai/business-use` in the agent-swarm, determine if it's being used correctly, and identify needed changes. Specific concerns:
1. Are states like `paused` or `cancelled_pending` modeled correctly as events that fire conditionally?
2. Is the global state machine correct?
3. Are events properly conditioned for a distributed system (API + workers)?
4. Is the default 10s backend timeout being addressed via the `conditions` parameter?

## Summary

Agent Swarm uses `@desplega.ai/business-use` v0.4.2 with 16 `ensure()`/`assert()` calls across 7 files, spanning 3 flows (`task`, `agent`, `api`). The instrumentation covers the distributed API server + Docker worker architecture with cross-process event linking via shared `runId` (taskId) and `depIds`.

**Three critical issues were found:**

1. **No timeout control anywhere.** Zero calls use the `conditions: [{ timeout_ms: N }]` parameter. If the business-use backend has a default 10s timeout, virtually every assert event would time out — tasks routinely take minutes to hours between `started` → `completed`.

2. **Missing `filter` for conditional events.** Events like `paused`, `cancelled_pending`, `cancelled_in_progress` are modeled as asserts that MUST happen in every task run, but in reality most tasks never get paused or cancelled. Only `scheduler_started` uses `filter` to gate on whether scheduling is enabled. The other conditional events should use `filter` to signal to the backend that they are optional branches, not mandatory steps.

3. **`resumed` → terminal state dependency gap.** After a pause/resume cycle, `completed`/`failed`/`cancelled_in_progress` still declare `depIds: ["started"]`, not `["resumed"]`. The Mermaid diagram in BUSINESS_USE.md shows `resumed → completed/failed/cancelled_in_progress` as logical transitions, but the actual `depIds` don't reflect this — meaning the backend's DAG doesn't know about the resumed→terminal path.

## Detailed Findings

### 1. SDK API Surface

The SDK (v0.4.2) exports `initialize()`, `ensure()`, `act()`, `assert()`, and `shutdown()`.

**`ensure()` signature** (`node_modules/@desplega.ai/business-use/dist/index.d.ts:280-291`):
```typescript
function ensure<TData>(options: {
  id: string;
  flow: string;
  runId: string | (() => string);
  data: TData;
  filter?: boolean | ((data, ctx) => boolean);    // Backend-evaluated gate
  depIds?: string[] | (() => string[]);            // Upstream dependencies
  validator?: (data, ctx) => boolean;              // Presence → assert, absence → act
  description?: string;
  conditions?: NodeCondition[] | (() => NodeCondition[]);  // [{timeout_ms?: number}]
  additional_meta?: Record<string, any>;
});
```

Key facts:
- **`conditions`**: Array of `{ timeout_ms?: number }` — controls how long the backend waits for this event before marking it timed out. Passed through to the backend without client-side interpretation.
- **`filter`**: Backend-evaluated function that determines whether the event should even be considered. Returns `false` → event is skipped/ignored during evaluation.
- **Default timeout**: The SDK itself has NO default. The 10s default (if it exists) is a backend-side concern.
- **`act` vs `assert`**: Determined by `validator` presence (`index.js:354`). `act` = records a fact. `assert` = backend evaluates the validator.
- **Serialization**: Both `filter` and `validator` are serialized via `.toString()` and shipped to the backend as JS expressions. Must be self-contained.
- **No-op mode**: If `BUSINESS_USE_API_KEY` env var is missing, all calls silently do nothing.

### 2. Flow: `task` (runId = taskId)

The largest flow with 11 nodes. Events are emitted from both API server and Docker workers.

#### State Machine (current `depIds` graph)

```
created (act) ─────────────────────────────────────────────┐
  ├── started (assert: previousStatus=pending)             │
  │     ├── completed (assert: previousStatus=in_progress) │
  │     ├── failed (assert: previousStatus=in_progress)    │
  │     ├── cancelled_in_progress (assert: prev=in_progress)
  │     ├── paused (assert: previousStatus=in_progress)    │
  │     │     └── resumed (assert: previousStatus=paused)  │
  │     ├── worker_received (act) ──[WORKER SIDE]──────────┤
  │     │     └── worker_process_spawned (act)              │
  │     │           └── worker_process_finished (assert: exitCode=0)
  │     │                                                   │
  └── cancelled_pending (assert: previousStatus=pending) ──┘
```

#### Node Details

| Node | File:Line | Type | depIds | Validator | filter | conditions |
|------|-----------|------|--------|-----------|--------|------------|
| `created` | `src/http/tasks.ts:258` | act | — | No | No | **No** |
| `started` | `src/http/poll.ts:133` | assert | `["created"]` | `previousStatus === "pending"` | No | **No** |
| `cancelled_pending` | `src/http/tasks.ts:335` | assert | `["created"]` | `previousStatus === "pending"` | No | **No** |
| `cancelled_in_progress` | `src/http/tasks.ts:349` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `completed` | `src/http/tasks.ts:461` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `completed` | `src/tools/store-progress.ts:166` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `failed` | `src/http/tasks.ts:461` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `failed` | `src/tools/store-progress.ts:190` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `paused` | `src/http/tasks.ts:522` | assert | `["started"]` | `previousStatus === "in_progress"` | No | **No** |
| `resumed` | `src/http/tasks.ts:577` | assert | `["paused"]` | `previousStatus === "paused"` | No | **No** |
| `worker_received` | `src/commands/runner.ts:2782` | act | `["started"]` | No | No | **No** |
| `worker_process_spawned` | `src/commands/runner.ts:3012` | act | `["worker_received"]` | No | No | **No** |
| `worker_process_finished` | `src/commands/runner.ts:1980` | assert | `["worker_process_spawned"]` | `exitCode === 0` | No | **No** |

**Key observation**: Every single `conditions` column is **No**. No event has timeout control.

#### Dual Emission Paths

`completed` and `failed` can be emitted from two locations:
- **REST path**: `POST /api/tasks/{id}/finish` → `src/http/tasks.ts:461` (dynamic `finishEventId`)
- **MCP path**: `store-progress` tool → `src/tools/store-progress.ts:166/190`

Both paths use identical validators and depIds.

**Duplicate emission risk**: Both paths can fire for the same taskId. In practice, the REST path (`/api/tasks/{id}/finish`) is called by the worker's `ensureTaskFinished()` after process exit, while the MCP path (`store-progress`) is called by the agent process itself before exit. The application does guard against this — `store-progress.ts:143` checks `existingTask.status` and skips if already in a terminal state, and `tasks.ts:459` has a similar guard (`if (transitionResult)`). So only one path should emit per task, but both emit the same event ID, which is correct.

#### Cross-Process Event Chain

```
API Server                              Docker Worker
──────────                              ─────────────
created ──► started ──────────────────► worker_received
                │                              │
                │                       worker_process_spawned
                │                              │
                │                       worker_process_finished
                │
                ├──► completed/failed
                ├──► cancelled_in_progress
                └──► paused ──► resumed
```

The bridge is `worker_received` with `depIds: ["started"]`. Both sides use the same `flow: "task"` and `runId: taskId`, so the business-use backend correlates them.

### 3. Flow: `agent` (runId = agentId)

| Node | File:Line | Type | depIds | Validator | filter | conditions |
|------|-----------|------|--------|-----------|--------|------------|
| `registered` | `src/http/agents.ts:184` | act | — | No | No | **No** |
| `reconnected` | `src/http/agents.ts:195` | assert | `["registered"]` | `ctx.deps.length > 0` | No | **No** |

This flow is simple and likely correct — an agent must register before reconnecting. The `reconnected` event's validator just checks that a `registered` dep exists.

### 4. Flow: `api` (runId = `run_${Date.now()}`)

| Node | File:Line | Type | depIds | Validator | filter | conditions |
|------|-----------|------|--------|-----------|--------|------------|
| `listen` | `src/http/index.ts:189` | act* | — | No | No | **No** |
| `scheduler_started` | `src/scheduler/scheduler.ts:263` | assert | `["listen"]` | checks capabilities includes "scheduling" | **Yes** (same logic) | **No** |

*Note: `listen` uses `assert()` helper but has no validator, so it behaves as an act. Minor inconsistency — should use `ensure()` or `act()` instead.

`scheduler_started` is the **only event in the entire codebase that uses `filter`**. It correctly gates on whether scheduling is enabled.

### 5. Initialization

Two `initialize()` calls — one per process type:

| Side | File:Line | Context |
|------|-----------|---------|
| API Server | `src/http/index.ts:183` | Module-level, before server starts listening |
| Worker | `src/commands/runner.ts:2083` | Inside main run function, before provider adapter creation |

Both read `BUSINESS_USE_API_KEY` and `BUSINESS_USE_URL` from env. If key is missing → no-op mode.

Env configuration:
- `.env:16-17` → API server: `http://localhost:13370`
- `.env.docker:27-28` → Worker: `http://host.docker.internal:13370`
- `.env.docker-lead:17-18` → Lead: `http://host.docker.internal:13370`

### 6. Issues Identified

#### Issue A: No Timeout Control (Critical)

**Every event** uses the backend's default timeout (reportedly 10s). Real-world timings:

| Transition | Typical Duration | Needs `timeout_ms` |
|------------|-----------------|---------------------|
| `created` → `started` | seconds to minutes (depends on worker polling) | ~300,000 (5 min) |
| `started` → `completed` | minutes to hours | ~3,600,000 (1 hour) |
| `started` → `failed` | minutes to hours | ~3,600,000 (1 hour) |
| `started` → `paused` | varies | ~3,600,000 (1 hour) |
| `started` → `cancelled_in_progress` | varies | ~3,600,000 (1 hour) |
| `created` → `cancelled_pending` | seconds to days | ~86,400,000 (1 day) |
| `paused` → `resumed` | minutes to days | ~86,400,000 (1 day) |
| `started` → `worker_received` | seconds (polling interval) | ~60,000 (1 min) |
| `worker_received` → `worker_process_spawned` | seconds | ~60,000 (1 min) |
| `worker_process_spawned` → `worker_process_finished` | minutes to hours | ~3,600,000 (1 hour) |
| `registered` → `reconnected` | minutes to days | ~86,400,000 (1 day) |
| `listen` → `scheduler_started` | milliseconds | ~10,000 (10s default is fine) |

#### Issue B: Missing `filter` for Optional Branches (Critical)

The task flow has multiple branches that are **mutually exclusive and conditional**:

- A task that completes normally will NEVER fire `cancelled_pending`, `cancelled_in_progress`, `paused`, or `failed`
- A task that gets cancelled while pending will NEVER fire `started`, `completed`, etc.
- The `paused`/`resumed` cycle may never happen

Without `filter`, the backend may treat ALL branches as expected outcomes and flag missing events as failures. Only `scheduler_started` currently uses `filter`.

Events that need `filter`, with proposed filter logic:

| Event | Filter Logic | Rationale |
|-------|-------------|-----------|
| `cancelled_pending` | `(data) => data.previousStatus === "pending"` | Only fires when task was cancelled while still pending |
| `cancelled_in_progress` | `(data) => data.previousStatus === "in_progress"` | Only fires when task was cancelled while running |
| `paused` | `(data) => data.previousStatus === "in_progress"` | Only fires when task is explicitly paused |
| `resumed` | `(data) => data.previousStatus === "paused"` | Only fires after a paused task resumes |
| `worker_received` | `(data) => !!data.taskId` | Only fires for task-type triggers on Docker workers |
| `worker_process_spawned` | `(data) => !!data.taskId` | Only fires after successful process spawn |
| `worker_process_finished` | `(data) => !!data.taskId` | Only fires after process exits |

Note: The filter functions mirror the existing validators for most events, which is the same pattern used by `scheduler_started`. The filter tells the backend "this event is only relevant when this condition holds", so missing events that don't match the filter are not flagged as failures.

#### Issue C: `resumed` → Terminal State Dependency Gap

The Mermaid diagram shows:
```
resumed --> completed
resumed --> failed
resumed --> cancelled_in_progress
```

But the actual code has `completed`, `failed`, and `cancelled_in_progress` all depending on `["started"]`, not `["resumed"]`. After a pause/resume cycle, the terminal events' dependency chain doesn't include `resumed`, so the backend's DAG has a structural gap.

**Implementation note**: Taras confirmed that terminal events after resume should depend on BOTH `["started", "resumed"]`. Since `depIds` are hardcoded at the call site, this requires conditional logic — the `completed`/`failed`/`cancelled_in_progress` ensure calls need to check whether the task was previously paused (e.g., by checking `task.status === "paused"` before the transition, or tracking a `wasPaused` flag) and include `"resumed"` in `depIds` only when applicable. The simplest approach: read `previousStatus` from the task record before the transition, and if it was `"paused"`, use `depIds: ["started", "resumed"]` instead of `["started"]`.

#### Issue D: `listen` Uses Wrong Helper

`src/http/index.ts:189` uses `assert()` to emit the `listen` event, but passes no validator. The `assert()` helper always creates an "assert" type node regardless of validator presence. Should use `ensure()` (auto-determines) or `act()` for consistency.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/http/index.ts` | 183 | SDK initialization (API side) |
| `src/http/index.ts` | 189 | `api.listen` event (uses `assert()` without validator) |
| `src/http/tasks.ts` | 258 | `task.created` event |
| `src/http/tasks.ts` | 335 | `task.cancelled_pending` event |
| `src/http/tasks.ts` | 349 | `task.cancelled_in_progress` event |
| `src/http/tasks.ts` | 461 | `task.completed` / `task.failed` via REST |
| `src/http/tasks.ts` | 522 | `task.paused` event |
| `src/http/tasks.ts` | 577 | `task.resumed` event |
| `src/http/poll.ts` | 133 | `task.started` event |
| `src/http/agents.ts` | 184 | `agent.registered` event |
| `src/http/agents.ts` | 195 | `agent.reconnected` event |
| `src/tools/store-progress.ts` | 166 | `task.completed` via MCP |
| `src/tools/store-progress.ts` | 190 | `task.failed` via MCP |
| `src/scheduler/scheduler.ts` | 263 | `api.scheduler_started` event (only event using `filter`) |
| `src/commands/runner.ts` | 2083 | SDK initialization (worker side) |
| `src/commands/runner.ts` | 2782 | `task.worker_received` event |
| `src/commands/runner.ts` | 3012 | `task.worker_process_spawned` event |
| `src/commands/runner.ts` | 1980 | `task.worker_process_finished` event |
| `node_modules/@desplega.ai/business-use/dist/index.d.ts` | 280 | `ensure()` type signature |
| `node_modules/@desplega.ai/business-use/dist/index.d.ts` | 57 | `NodeCondition` schema (`timeout_ms`) |
| `scripts/generate-business-use-docs.ts` | — | BUSINESS_USE.md generator |

## Architecture Documentation

### Current Patterns

- **Implicit flow definitions**: No registry or `defineFlow()` calls. Flows emerge from individual `ensure()` calls specifying `flow` and `id`. The backend accumulates nodes/edges over time.
- **Validators are self-contained**: Serialized via `.toString()` and executed on the backend. Cannot reference closures or external variables.
- **Events placed AFTER mutations**: Most `ensure()` calls run after the DB transaction completes. Two exceptions inside transactions (`poll.ts:133`, `store-progress.ts:166/190`) — safe because `ensure()` only queues to in-memory buffer.
- **Dual emission paths**: `completed`/`failed` can fire from either the REST finish endpoint or the MCP store-progress tool, with identical validators.
- **Cross-process correlation**: API and worker events share `flow: "task"` + `runId: taskId`. Worker events reference API events via `depIds` (e.g., `worker_received` depends on `started`).

### What's Working Correctly

- State machine validators correctly check `previousStatus` against expected values
- Cross-process `depIds` linking is sound (worker → API via shared runId)
- The `scheduler_started` filter pattern is the correct model for conditional events
- Event placement after mutations is correct (no risk of emitting events for rolled-back transactions)
- No-op mode when `BUSINESS_USE_API_KEY` is missing works as expected

## Resolved Questions

1. **Backend default timeout is 10s** — Confirmed by Taras. All events without explicit `conditions: [{ timeout_ms }]` use this default, which is far too short for task lifecycle events.

2. **Backend DOES treat missing events as failures** — Confirmed. This is the core problem: without `filter` on conditional branches (cancelled, paused), every normally-completing task shows “missing” cancelled/paused events as failures.

3. **`reconnected` can allow multiple occurrences** — Acceptable, but note that in existing swarms agents may already be connected without a `registered` event in the backend, so introducing this retroactively may cause failures for existing agents. Needs a migration strategy.

4. **`completed`/`failed` after resume should depend on BOTH `[“started”]` and `[“resumed”]`** — Taras confirmed both dependencies should be present for the pause/resume path, not just one or the other.

5. **JS SDK `act()`/`assert()` wrappers have a confirmed bug** — `timeoutMs` is accepted in the type signature but silently dropped (never translated to `conditions`). Additionally, `act()`/`assert()` don’t expose `conditions` at all, so there’s no way to set timeouts through the convenience wrappers. This is a JS SDK bug to fix upstream. For now, use `ensure()` directly with `conditions: [{ timeout_ms }]` in agent-swarm.

## Open Questions

- How to handle the migration for existing swarms where `registered` events may not exist in the business-use backend for already-running agents?
