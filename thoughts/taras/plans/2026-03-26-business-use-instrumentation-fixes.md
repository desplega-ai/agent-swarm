---
date: 2026-03-26
planner: Claude
status: ready
autonomy: critical
source: thoughts/taras/research/2026-03-26-business-use-instrumentation.md
commit_per_phase: true
---

# Business-Use Instrumentation Fixes — Implementation Plan

## Overview

Fix five issues in the `@desplega.ai/business-use` instrumentation across agent-swarm's distributed API + worker architecture:

1. **No timeout control** — All 17 `ensure()`/`assert()` calls use the backend's 10s default, far too short for task lifecycle events that take minutes to hours.
2. **Missing `filter` on conditional branches** — Events like `cancelled_pending`, `paused`, `failed` are treated as mandatory by the backend, causing false failures for normally-completing tasks.
3. **`resumed` → terminal state `depIds` gap** — After pause/resume, terminal events still depend only on `["started"]`, not `["started", "resumed"]`.
4. **`cancelled_in_progress` validator bug (pre-existing)** — `cancelTask()` accepts `paused` status, but the ensure validator only checks `previousStatus === "in_progress"`, causing validator failures when cancelling paused tasks.
5. **`listen` uses wrong helper** — Uses `assert()` without a validator; should use `ensure()`.

## Current State Analysis

- 17 instrumentation calls across 7 files, spanning 3 flows (`task`, `agent`, `api`)
- SDK version: `@desplega.ai/business-use` v0.4.2
- Only `scheduler_started` uses `filter`; zero calls use `conditions`
- The JS SDK `act()`/`assert()` wrappers silently drop `timeoutMs` — must use `ensure()` with `conditions` directly
- Events are placed AFTER DB mutations (correct), with two inside transactions (`poll.ts:133`, `store-progress.ts:166/190`) — safe since `ensure()` queues to an in-memory buffer

### Key Discoveries:
- `completed`/`failed` have dual emission paths (REST `/finish` endpoint + MCP `store-progress`), both need identical fixes
- Worker events (`runner.ts`) run in Docker with no local DB — they bridge to API events via shared `flow: "task"` + `runId: taskId`
- `listen` event at `src/http/index.ts:189` uses `assert()` import but passes no validator — inconsistent
- `reconnected` at `src/http/agents.ts:195` has a validator but no filter — existing agents without `registered` events in the backend would cause failures

## Desired End State

Every `ensure()` call has:
1. Appropriate `conditions: [{ timeout_ms }]` matching real-world timing
2. `filter` on all conditional/optional events using `ctx.deps` pattern
3. Correct `depIds` reflecting the full dependency chain (including `resumed`)
4. Consistent use of `ensure()` (not raw `assert()`)

Verification: run `bun run docs:business-use` to regenerate BUSINESS_USE.md, then evaluate flows against the BU backend with `uvx business-use-core@latest flow eval <runId> <flow> -g -v`.

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bun run docs:business-use` — Regenerate BUSINESS_USE.md (requires BU backend)

Key files:
- `src/http/tasks.ts` — 6 ensure calls (created, cancelled_pending, cancelled_in_progress, completed/failed, paused, resumed)
- `src/http/poll.ts` — 1 ensure call (started)
- `src/http/agents.ts` — 2 ensure calls (registered, reconnected)
- `src/http/index.ts` — 1 assert call (listen) + initialize
- `src/tools/store-progress.ts` — 2 ensure calls (completed, failed)
- `src/commands/runner.ts` — 3 ensure calls (worker_received, worker_process_spawned, worker_process_finished) + initialize
- `src/scheduler/scheduler.ts` — 1 ensure call (scheduler_started)

## What We're NOT Doing

- **Not upgrading the SDK** — v0.4.2 `ensure()` supports `conditions` and `filter`; no upgrade needed
- **Not fixing the SDK `act()`/`assert()` `timeoutMs` bug** — that's an upstream fix; we use `ensure()` directly
- **Not adding new events** — scope is fixing existing instrumentation only
- **Not restructuring the flow graph** — keeping the same event IDs, flows, and `depIds` structure (except for Issue C)
- **Not handling migration for existing agents** — the `reconnected` filter handles this gracefully (deps.length check)

## Implementation Approach

Each phase addresses one issue independently. Phases 1-4 touch the same files but different parameters within each `ensure()` call, so they can be done sequentially without conflicts. Phase 5 regenerates docs after all code changes.

**Filter design decision**: Use context-based filters (`ctx.deps`) following the `scheduler_started` pattern. All conditional events get `filter: ({}, ctx) => ctx.deps.length > 0` — this checks whether the declared upstream deps were emitted in this run. For events whose deps always exist (e.g., `cancelled_pending` depends on `created`), the filter still marks the event as conditional in the backend's evaluation. Terminal states sharing the same dep (`completed`/`failed`/`cancelled_in_progress` all depend on `started`) become "optional but at least one expected."

---

## Phase 1: Add Timeout Conditions

### Overview
Add `conditions: [{ timeout_ms }]` to every `ensure()` call with a downstream dependency. Root events (`created`, `registered`, `listen`) don't need timeouts since nothing waits for them — they're the starting point. All other events get timeouts matching real-world timing.

### Changes Required:

#### 1. Task flow — API side
**File**: `src/http/poll.ts`
**Changes**: Add `conditions` to `started` (line ~133)
```typescript
conditions: [{ timeout_ms: 300_000 }], // 5 min: polling interval + queue wait
```

**File**: `src/http/tasks.ts`
**Changes**: Add `conditions` to 5 events:
- `cancelled_pending` (line ~335): `conditions: [{ timeout_ms: 86_400_000 }]` — 1 day: task may sit pending for a long time
- `cancelled_in_progress` (line ~349): `conditions: [{ timeout_ms: 3_600_000 }]` — 1 hour: task running time
- `completed`/`failed` (line ~461): `conditions: [{ timeout_ms: 3_600_000 }]` — 1 hour: task running time
- `paused` (line ~522): `conditions: [{ timeout_ms: 3_600_000 }]` — 1 hour
- `resumed` (line ~577): `conditions: [{ timeout_ms: 86_400_000 }]` — 1 day: tasks may stay paused for extended periods

**File**: `src/tools/store-progress.ts`
**Changes**: Add `conditions` to both `completed` (line ~166) and `failed` (line ~190):
```typescript
conditions: [{ timeout_ms: 3_600_000 }], // 1 hour
```

#### 2. Task flow — Worker side
**File**: `src/commands/runner.ts`
**Changes**: Add `conditions` to 3 events:
- `worker_received` (line ~2782): `conditions: [{ timeout_ms: 60_000 }]` — 1 min: immediate after poll
- `worker_process_spawned` (line ~3012): `conditions: [{ timeout_ms: 60_000 }]` — 1 min: process startup
- `worker_process_finished` (line ~1980): `conditions: [{ timeout_ms: 3_600_000 }]` — 1 hour: process runtime

#### 3. Agent flow
**File**: `src/http/agents.ts`
**Changes**: Add `conditions` to `reconnected` (line ~195):
```typescript
conditions: [{ timeout_ms: 86_400_000 }], // 1 day: agents may be offline for extended periods
```

#### 4. API flow
**File**: `src/scheduler/scheduler.ts`
**Changes**: Add `conditions` to `scheduler_started` (line ~263):
```typescript
conditions: [{ timeout_ms: 10_000 }], // 10s: scheduler starts immediately after listen
```

### Summary of timeout values:

| Event | timeout_ms | Human-readable | Rationale |
|-------|-----------|----------------|-----------|
| `started` | 300,000 | 5 min | Polling interval + queue wait |
| `cancelled_pending` | 86,400,000 | 1 day | Tasks may sit pending indefinitely |
| `cancelled_in_progress` | 3,600,000 | 1 hour | Task execution time |
| `completed`/`failed` (both paths) | 3,600,000 | 1 hour | Task execution time |
| `paused` | 3,600,000 | 1 hour | Task execution time before pause |
| `resumed` | 86,400,000 | 1 day | Tasks may stay paused for days |
| `worker_received` | 60,000 | 1 min | Immediate after poll |
| `worker_process_spawned` | 60,000 | 1 min | Process startup |
| `worker_process_finished` | 3,600,000 | 1 hour | Process runtime |
| `reconnected` | 86,400,000 | 1 day | Agents may be offline |
| `scheduler_started` | 10,000 | 10s | Immediate after listen |

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Verify all non-root ensure calls have `conditions`: `grep -A20 "ensure({" src/http/tasks.ts src/http/poll.ts src/http/agents.ts src/tools/store-progress.ts src/commands/runner.ts src/scheduler/scheduler.ts | grep -B1 "conditions:"`

#### Manual Verification:
- [ ] Review each `conditions` value against the timeout table above
- [ ] Verify root events (`created`, `registered`, `listen`) do NOT have `conditions` (they don't need it)
- [ ] Spot-check that `conditions` is placed after `data` and before the closing `})`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Add Filters to Conditional Events

### Overview
Add `filter` to all conditional/optional events using context-based `ctx.deps` pattern. The filter `({}, ctx) => ctx.deps.length > 0` checks whether the declared upstream deps were emitted. For missing events where the dep wasn't emitted, `ctx.deps` is empty → filter returns false → backend doesn't flag as missing.

### Filter Design:

| Event | depIds | Filter | Why |
|-------|--------|--------|-----|
| `started` | `["created"]` | `({}, ctx) => ctx.deps.length > 0` | Optional if cancelled while pending |
| `cancelled_pending` | `["created"]` | `({}, ctx) => ctx.deps.length > 0` | Alternative to started path |
| `cancelled_in_progress` | `["started"]` | `({}, ctx) => ctx.deps.length > 0` | Alternative terminal state |
| `completed` | `["started"]` | `({}, ctx) => ctx.deps.length > 0` | Alternative terminal state |
| `failed` | `["started"]` | `({}, ctx) => ctx.deps.length > 0` | Alternative terminal state |
| `paused` | `["started"]` | `({}, ctx) => ctx.deps.length > 0` | Optional lifecycle event |
| `resumed` | `["paused"]` | `({}, ctx) => ctx.deps.length > 0` | Only relevant after pause |
| `worker_received` | `["started"]` | `({}, ctx) => ctx.deps.length > 0` | Not all tasks go to workers |
| `worker_process_spawned` | `["worker_received"]` | `({}, ctx) => ctx.deps.length > 0` | Chains from worker_received |
| `worker_process_finished` | `["worker_process_spawned"]` | `({}, ctx) => ctx.deps.length > 0` | Chains from worker_process_spawned |
| `reconnected` | `["registered"]` | `({}, ctx) => ctx.deps.length > 0` | Agent may never reconnect; also handles existing agents without `registered` event |
| `scheduler_started` | `["listen"]` | Keep existing | Already has capabilities check |

**Note on `started` and `cancelled_pending`**: Both depend on `created` which always fires, so `ctx.deps.length > 0` always returns true for both. However, the presence of a `filter` function marks these events as **conditional** in the backend's evaluation — the backend won't treat a missing conditional event as a hard failure. The flow graph structure enforces "at least one path from created" implicitly.

### Changes Required:

#### 1. Task flow — API side
**File**: `src/http/poll.ts`
**Changes**: Add `filter` to `started` (line ~133):
```typescript
filter: ({}, ctx) => ctx.deps.length > 0,
```

**File**: `src/http/tasks.ts`
**Changes**: Add `filter` to 5 events:
- `cancelled_pending` (line ~335)
- `cancelled_in_progress` (line ~349)
- `completed`/`failed` (line ~461)
- `paused` (line ~522)
- `resumed` (line ~577)

All use the same filter:
```typescript
filter: ({}, ctx) => ctx.deps.length > 0,
```

**File**: `src/tools/store-progress.ts`
**Changes**: Add `filter` to `completed` (line ~166) and `failed` (line ~190):
```typescript
filter: ({}, ctx) => ctx.deps.length > 0,
```

#### 2. Task flow — Worker side
**File**: `src/commands/runner.ts`
**Changes**: Add `filter` to all 3 events:
- `worker_received` (line ~2782)
- `worker_process_spawned` (line ~3012)
- `worker_process_finished` (line ~1980)

All use:
```typescript
filter: ({}, ctx) => ctx.deps.length > 0,
```

#### 3. Agent flow
**File**: `src/http/agents.ts`
**Changes**: Add `filter` to `reconnected` (line ~195):
```typescript
filter: ({}, ctx) => ctx.deps.length > 0,
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Verify filter count matches expected (11 events with filter): `grep -c "filter:" src/http/tasks.ts src/http/poll.ts src/http/agents.ts src/tools/store-progress.ts src/commands/runner.ts src/scheduler/scheduler.ts`

#### Manual Verification:
- [ ] Confirm `scheduler_started` filter was NOT modified (it has custom capabilities logic)
- [ ] Confirm root events (`created`, `registered`, `listen`) do NOT have filters
- [ ] Verify filter functions are self-contained (no closures, no external references) — they get serialized via `.toString()`
- [ ] Confirm `reconnected` now has both `filter` AND `validator` (both checking `ctx.deps`)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Fix Dependency Gaps and Validator Bug for Pause/Resume/Cancel Paths

### Overview
Three related issues in how the `depIds` and validators handle pause-related state transitions:

1. **`resumed` → terminal `depIds` gap**: After pause/resume, terminal events (`completed`, `failed`, `cancelled_in_progress`) depend only on `["started"]`, not `["started", "resumed"]`.
2. **`paused` → `cancelled_in_progress` validator bug (pre-existing)**: `cancelTask()` in `db.ts:1454` accepts `paused` status, but the `cancelled_in_progress` ensure validator is `data.previousStatus === "in_progress"`. Cancelling a currently-paused task hits the `else` branch at `tasks.ts:348` with `previousStatus: "paused"` → validator returns false.
3. **`paused` → `cancelled_in_progress` depIds**: When cancelled while paused, `depIds` should include `"paused"`, not `"resumed"`.

**Why `was_paused` column is needed**: At the completion/failure ensure call sites, the task status is always `"in_progress"` (either never paused, or paused-then-resumed). `resumeTask()` at `db.ts:1538` sets status back to `"in_progress"`, erasing pause history. No `pausedAt`/`resumedAt` fields exist on the task model. The `agent_log` table has the history but querying it at ensure-time adds unneeded complexity. A `was_paused` boolean on the task row is the simplest approach.

**Scope of variable access at each call site** (verified by codebase analysis):

| Call site | Task variable | Status at ensure-time | Notes |
|-----------|--------------|----------------------|-------|
| `tasks.ts:461` (finish) | No task in scope | Hardcoded `"in_progress"` | Transaction at 411-452 scopes `task` internally; result returned as `{ task }` |
| `tasks.ts:349` (cancel) | `task` (line 298) | Pre-transition status | Could be `"in_progress"` or `"paused"` |
| `store-progress.ts:166/190` | `existingTask` (line 100) | Pre-transition status | Always `"in_progress"` (completeTask/failTask guard) |

### Changes Required:

#### 1. Schema change
**File**: `src/be/migrations/024_add_was_paused.sql`
```sql
ALTER TABLE agent_tasks ADD COLUMN was_paused INTEGER NOT NULL DEFAULT 0;
```

#### 2. DB functions
**File**: `src/be/db.ts`
**Changes**:
- In `resumeTask()` (line 1538): update SQL to also set `was_paused = 1` alongside `status = 'in_progress'`
- In `pauseTask()` (line 1499): update SQL to also set `was_paused = 1` (set on pause, not just resume, so the cancel-while-paused path also sees it)
- In all task SELECT queries (e.g., `getTaskById`, `taskQueries`): include `was_paused` in the selected columns
- Map `was_paused` (INTEGER 0/1) to `wasPaused` (boolean) in TypeScript result mapping

#### 3. Type definition
**File**: `src/types.ts`
**Changes**: Add `wasPaused` to `AgentTaskSchema`:
```typescript
wasPaused: z.boolean().default(false),
```

#### 4. REST finish endpoint — conditional `depIds`
**File**: `src/http/tasks.ts` (line 461)
**Changes**: The transaction result at line 411-452 returns `{ task }` (post-transition). Modify the transaction to ALSO return the `wasPaused` flag from the pre-transition task:

```typescript
// Inside the transaction (before completeTask/failTask):
const wasPaused = task.wasPaused;
// ... existing completeTask/failTask logic ...
return { task: updatedTask, wasPaused };
```

Then at the ensure call (line 461):
```typescript
depIds: result.wasPaused ? ["started", "resumed"] : ["started"],
```

#### 5. MCP store-progress tool — conditional `depIds`
**File**: `src/tools/store-progress.ts` (lines 166, 190)
**Changes**: `existingTask` is already in scope (fetched at line 100). Use directly:
```typescript
depIds: existingTask.wasPaused ? ["started", "resumed"] : ["started"],
```

#### 6. Cancel in-progress — fix validator AND conditional `depIds`
**File**: `src/http/tasks.ts` (line 349)
**Changes**: The `task` variable (fetched at line 298) has the pre-transition status. Three fixes:

a) **Validator**: Accept both `"in_progress"` and `"paused"`:
```typescript
validator: (data) => data.previousStatus === "in_progress" || data.previousStatus === "paused",
```

b) **`depIds`**: Conditional based on actual pre-transition status:
```typescript
depIds: task.status === "paused"
  ? ["started", "paused"]          // cancelled while paused
  : task.wasPaused
    ? ["started", "resumed"]       // cancelled after resume
    : ["started"],                 // cancelled while running (never paused)
```

c) **`data.previousStatus`**: Already correct — uses `task.status` which is the pre-transition value.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] Migration file exists: `ls src/be/migrations/024_add_was_paused.sql`
- [ ] `pauseTask` and `resumeTask` set was_paused: `grep -n "was_paused" src/be/db.ts`
- [ ] Terminal events have conditional depIds: `grep -A2 "depIds:" src/http/tasks.ts src/tools/store-progress.ts | grep -c "wasPaused\|task.status"`
- [ ] Validator fix applied: `grep "paused" src/http/tasks.ts | grep "validator"`

#### Manual Verification:
- [ ] Test with fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` — verify server starts without errors
- [ ] Test with existing DB: restart server with existing DB — verify migration 024 applies cleanly
- [ ] Verify `wasPaused` is included in task API responses: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks | jq '.tasks[0].wasPaused'`
- [ ] Verify cancel-while-paused path: create task → start → pause → cancel → check ensure data has `previousStatus: "paused"` and `depIds: ["started", "paused"]`

**Implementation Note**: After completing this phase, pause for manual confirmation. This phase touches the DB schema — extra care needed. Create commit after verification passes.

---

## Phase 4: Fix `listen` to Use `ensure()`

### Overview
Replace the `assert()` call for the `listen` event with `ensure()`. Since `listen` has no validator, `ensure()` will auto-detect it as an `act`. Also clean up the import.

### Changes Required:

#### 1. Fix the call and import
**File**: `src/http/index.ts`
**Changes**:
- Change import from `import { assert, initialize }` to `import { ensure, initialize }`
- Replace the `assert({...})` call at line ~189 with `ensure({...})`
- The parameters stay identical (id, flow, runId, data) — no validator, no filter, no conditions (root event)

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tests pass: `bun test`
- [ ] No more `assert` import from business-use: `grep "assert.*business-use" src/http/index.ts` (should return nothing)
- [ ] `ensure` is used instead: `grep "ensure({" src/http/index.ts`

#### Manual Verification:
- [ ] Verify server starts without errors: `bun run start:http` (check for business-use init log)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: Regenerate Documentation + Final Verification

### Overview
Regenerate BUSINESS_USE.md to reflect all changes. Run flow evaluation against the BU backend if available. Verify the complete instrumentation is correct.

### Changes Required:

#### 1. Regenerate BUSINESS_USE.md
```bash
bun run docs:business-use
```

This requires the BU backend running at `localhost:13370`. If not available, skip this step and note it for later.

#### 2. Final audit
Run a comprehensive grep to verify every ensure call has all required parameters:

```bash
# Check all ensure calls have conditions (except root events)
grep -B1 -A15 "ensure({" src/http/tasks.ts src/http/poll.ts src/http/agents.ts \
  src/tools/store-progress.ts src/commands/runner.ts src/scheduler/scheduler.ts

# Check all conditional events have filter
grep -c "filter:" src/http/tasks.ts src/http/poll.ts src/http/agents.ts \
  src/tools/store-progress.ts src/commands/runner.ts
```

### Success Criteria:

#### Automated Verification:
- [ ] Full pre-PR checks pass: `bun run tsc:check && bun run lint:fix && bun test && bash scripts/check-db-boundary.sh`
- [ ] BUSINESS_USE.md regenerated (if BU backend available): `bun run docs:business-use`

#### Manual Verification:
- [ ] Review regenerated BUSINESS_USE.md — verify Mermaid diagrams show correct edges including `resumed → completed/failed/cancelled_in_progress`
- [ ] If BU backend is running, evaluate a test flow: `uvx business-use-core@latest flow eval <runId> task -g -v`
- [ ] Final review of all changes via `git diff`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Manual E2E Verification

After all phases are complete, run a full end-to-end test:

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Start BU backend (if available)
uvx business-use-core@latest server dev &

# 3. Create a test task
curl -s -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"task": "Say hi", "source": "manual"}' | jq '.task.id'

# 4. Register an agent and poll (the task should go through created → started)
# Use the Docker worker flow or manual API calls

# 5. Evaluate the task flow in BU backend
uvx business-use-core@latest flow eval <taskId> task -g -v

# 6. Verify no timeout violations, no missing-event failures for conditional events

# 7. Test pause/resume path (if possible):
# POST /api/tasks/<id>/pause → POST /api/tasks/<id>/resume → finish
# Then evaluate flow — should show resumed in depIds of terminal event

# 8. Test cancel-while-pending path:
# Create task, cancel before any agent polls
# Evaluate flow — cancelled_pending should fire, started/completed should NOT be flagged

# 9. Test cancel-while-paused path:
# Create task → start → pause → cancel (don't resume first)
# Evaluate flow — cancelled_in_progress should fire with previousStatus: "paused"
# depIds should be ["started", "paused"], validator should accept "paused"

# 10. Cleanup
kill $(lsof -ti :3013) 2>/dev/null
kill $(lsof -ti :13370) 2>/dev/null
```

## Testing Strategy

- **Unit tests**: Existing `bun test` suite covers DB operations and API routes — ensure no regressions
- **Type check**: `bun run tsc:check` ensures all `ensure()` calls match the SDK's type signature
- **Integration**: Docker E2E with BU backend evaluates flow correctness end-to-end
- **Schema migration**: Test with both fresh DB and existing DB to verify migration applies cleanly

## References
- Research: `thoughts/taras/research/2026-03-26-business-use-instrumentation.md`
- Documentation: `BUSINESS_USE.md`
- SDK types: `node_modules/@desplega.ai/business-use/dist/index.d.ts`
- CLAUDE.md business-use section: guidelines for adding new events

## Review Errata

_Reviewed: 2026-03-26 by Claude (self-review with codebase verification)_

### Resolved
- [x] **Phase 3 had "Decision needed during implementation"** — resolved: `was_paused` column IS necessary (verified: no `pausedAt`/`resumedAt` fields exist, `resumeTask()` erases pause history by setting status back to `in_progress`). Migration number specified as 024.
- [x] **Phase 3 referenced `existingTask` at `tasks.ts:461` but no task variable is in scope** — fixed: plan now specifies passing `wasPaused` from inside the transaction via the return value.
- [x] **Pre-existing `cancelled_in_progress` validator bug discovered** — added to plan as Issue 4. Validator now accepts both `"in_progress"` and `"paused"`. depIds made conditional for the cancel-while-paused path.
- [x] **Phase 1 automated verification grep was weak** — fixed: grep now checks for `conditions:` presence, not just `ensure({` listing.
- [x] **Missing cancel-while-paused E2E test** — added to Manual E2E Verification section.
- [x] **Frontmatter used `author` instead of `planner`** — fixed.
- [x] **Migration table name** — corrected to `agent_tasks` (not `tasks`).
