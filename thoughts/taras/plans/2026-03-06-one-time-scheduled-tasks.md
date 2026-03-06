---
date: 2026-03-06T12:00:00Z
topic: "One-Time Scheduled Tasks"
type: plan
status: draft
---

# One-Time Scheduled Tasks

## Overview

Extend the existing schedules system to support one-time (delayed) tasks — e.g., "do this in 30 minutes." A new `scheduleType` column distinguishes recurring from one-time schedules. One-time schedules auto-disable after execution and don't require a cron expression or interval.

## Current State

- `scheduled_tasks` table stores recurring schedules with `cronExpression` or `intervalMs` (at least one required via CHECK constraint)
- Scheduler polls every 10s, finds due schedules (`nextRunAt <= now`), creates tasks, then recalculates `nextRunAt`
- After execution, `calculateNextRun()` always computes the next occurrence — no concept of "run once and stop"
- MCP tools: `create-schedule`, `update-schedule`, `delete-schedule`, `list-schedules`, `run-schedule-now`
- UI: schedule list/detail pages in `new-ui/`

## Desired End State

- Agents can create one-time schedules: `create-schedule --name "deploy-reminder" --taskTemplate "Deploy staging" --delayMs 1800000` (30 min from now)
- Alternatively: `--runAt "2026-03-06T15:00:00Z"` for an absolute time
- One-time schedules appear in the schedules list with a distinct type indicator
- After execution, one-time schedules auto-disable (set `enabled = 0`) and don't recalculate `nextRunAt`
- The CHECK constraint is relaxed: one-time schedules don't need `cronExpression` or `intervalMs`
- Existing recurring schedules are unaffected (backward compatible)

## Design Decisions

**Column name**: `scheduleType TEXT NOT NULL DEFAULT 'recurring' CHECK(scheduleType IN ('recurring', 'one_time'))` — clear, extensible, and easy to query. The column is NOT optional (`NOT NULL`). Existing schedules get `'recurring'` automatically via the `DEFAULT` value during migration (the `INSERT ... SELECT *, 'recurring'` copies all rows with the explicit value). For the MCP/API input, the parameter defaults to `'recurring'` so existing callers are unaffected.

**Input params**: Accept `delayMs` (relative) or `runAt` (absolute ISO datetime) on `create-schedule`. These are NOT stored columns — they compute `nextRunAt` at creation time. `delayMs` and `runAt` are mutually exclusive with `cronExpression`/`intervalMs` for one-time schedules.

**Auto-cleanup**: One-time schedules are auto-disabled after execution, NOT deleted. This preserves history and lets agents see what ran. The `lastRunAt` timestamp serves as proof of execution.

**Default filtering**: The API and UI should hide executed one-time schedules by default (i.e., where `scheduleType = 'one_time' AND enabled = 0`). The API `GET /api/schedules` and `list-schedules` MCP tool will add a `hideCompleted` filter (default `true`) that excludes these. The UI will have a "Show completed one-time" toggle to reveal them.

**Validation**: For `scheduleType = 'one_time'`, exactly one of `delayMs` or `runAt` must be provided (and no cron/interval). For `scheduleType = 'recurring'` (default), existing validation applies (cron or interval required).

---

## Phase 1: Database Migration

Add `scheduleType` column and relax the CHECK constraint.

### Files to modify:
- `src/be/migrations/` — new migration file

### Steps:

1. Create `src/be/migrations/NNN_one_time_schedules.sql` (next number after highest existing):

```sql
-- Add scheduleType column
-- The existing CHECK (cronExpression IS NOT NULL OR intervalMs IS NOT NULL)
-- blocks one-time schedules. We must recreate the table.

-- Step 1: Rename existing table
ALTER TABLE scheduled_tasks RENAME TO _scheduled_tasks_old;

-- Step 2: Create new table with updated constraints
CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    cronExpression TEXT,
    intervalMs INTEGER,
    taskTemplate TEXT NOT NULL,
    taskType TEXT,
    tags TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50,
    targetAgentId TEXT,
    enabled INTEGER DEFAULT 1,
    lastRunAt TEXT,
    nextRunAt TEXT,
    createdByAgentId TEXT,
    timezone TEXT DEFAULT 'UTC',
    consecutiveErrors INTEGER DEFAULT 0,
    lastErrorAt TEXT,
    lastErrorMessage TEXT,
    model TEXT,
    scheduleType TEXT NOT NULL DEFAULT 'recurring' CHECK(scheduleType IN ('recurring', 'one_time')),
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    CHECK (
        (scheduleType = 'recurring' AND (cronExpression IS NOT NULL OR intervalMs IS NOT NULL))
        OR
        (scheduleType = 'one_time')
    )
);

-- Step 3: Copy data (all existing schedules are 'recurring')
INSERT INTO scheduled_tasks SELECT *, 'recurring' FROM _scheduled_tasks_old;

-- Step 4: Drop old table
DROP TABLE _scheduled_tasks_old;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(scheduleType);
```

2. Also update `001_initial.sql` to include `scheduleType` in the CREATE TABLE for fresh DBs (the migration runner's bootstrap logic handles existing DBs).

3. Update `src/be/db.ts`:
   - Add `scheduleType` to `ScheduledTaskRow` type (~line 3890)
   - Add `scheduleType` to `rowToScheduledTask()` mapping (~line 3914)
   - Add `scheduleType` to `CreateScheduledTaskData` interface (~line 3981)
   - Add `scheduleType` to `createScheduledTask()` INSERT (~line 3998)
   - Add `scheduleType` to `UpdateScheduledTaskData` interface (~line 4034)
   - Add `scheduleType` to `updateScheduledTask()` SET handling (~line 4055)

4. Update `src/types.ts`:
   - Add `scheduleType` to `ScheduledTaskSchema` (~line 356)
   - Adjust the `.refine()` to account for one-time schedules (~line 380)

### Success Criteria:

#### Automated Verification:
- [x] Fresh DB starts clean: `rm agent-swarm-db.sqlite && bun run start:http` (starts without errors)
- [x] Existing DB migrates: `bun run start:http` (starts without errors with existing DB)
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] Query `SELECT sql FROM sqlite_master WHERE name='scheduled_tasks'` — confirms new CHECK and `scheduleType` column
- [x] Existing schedules have `scheduleType = 'recurring'` after migration

**Implementation Note**: Pause for verification before proceeding to Phase 2.

---

## Phase 2: Scheduler Logic for One-Time Execution

Modify the scheduler to handle one-time schedules: execute once, then auto-disable.

### Files to modify:
- `src/scheduler/scheduler.ts`

### Steps:

1. In `executeSchedule()` (~line 107): After creating the task, check `schedule.scheduleType`:
   - If `'one_time'`: set `enabled = false`, `nextRunAt = null`, update `lastRunAt`. Do NOT call `calculateNextRun()`.
   - If `'recurring'` (default): existing behavior — call `calculateNextRun()` and update `nextRunAt`.

2. In `recoverMissedSchedules()` (~line 19): Same one-time check — auto-disable after recovery run instead of recalculating next run.

3. In `runScheduleNow()` (~line 237): After creating the task, if `schedule.scheduleType === 'one_time'`, auto-disable (set `enabled = false`, clear `nextRunAt`). Manual runs of one-time schedules should also mark them as completed.

4. In the error handler within `executeSchedule()` (~line 139): If `schedule.scheduleType === 'one_time'` and execution fails, auto-disable immediately (no backoff retries — the one-time window has passed). Set `enabled = false` with the error info.

5. `calculateNextRun()` needs no changes — it's simply not called for one-time schedules.

**All code paths that execute a schedule must check `scheduleType` and auto-disable for one-time.** This includes: normal execution, recovery, manual run, and error handling.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Existing scheduler tests pass: `bun test src/scheduler/scheduler.test.ts`
- [x] Existing scheduled tasks tests pass: `bun test src/tests/scheduled-tasks.test.ts`

#### Manual Verification:
- [x] Create a one-time schedule via DB insert with `nextRunAt` 15s in the future, verify it executes and auto-disables (will verify during E2E)

**Implementation Note**: Pause for verification before proceeding to Phase 3.

---

## Phase 3: MCP Tool Updates

Update `create-schedule` and `update-schedule` tools to accept one-time schedule parameters.

### Files to modify:
- `src/tools/schedules/create-schedule.ts`
- `src/tools/schedules/update-schedule.ts`
- `src/tools/schedules/list-schedules.ts` (add filter by scheduleType)

### Steps:

1. **`create-schedule.ts`**: Add new input params:
   - `scheduleType: z.enum(['recurring', 'one_time']).default('recurring')`
   - `delayMs: z.number().int().positive().optional()` — "run in X milliseconds from now"
   - `runAt: z.string().datetime().optional()` — "run at this exact time"
   - Validation:
     - If `scheduleType = 'one_time'`: require exactly one of `delayMs` or `runAt`. Reject `cronExpression`/`intervalMs`.
     - If `scheduleType = 'recurring'` (or omitted): existing validation (require cron or interval). Reject `delayMs`/`runAt`.
   - Compute `nextRunAt`:
     - From `delayMs`: `new Date(Date.now() + delayMs).toISOString()`
     - From `runAt`: validate it's in the future, use directly
   - Pass `scheduleType` to `createScheduledTask()`

2. **`update-schedule.ts`**:
   - Do NOT allow changing `scheduleType` after creation (prevent confusion)
   - For one-time schedules: allow updating `runAt` (recompute `nextRunAt`) if not yet executed
   - For one-time schedules that have already run (`enabled = false`, `lastRunAt` set): reject updates with helpful message

3. **`list-schedules.ts`**:
   - Add optional `scheduleType` filter param
   - Add `hideCompleted` boolean param (default `true`) — when true, excludes schedules where `scheduleType = 'one_time' AND enabled = false`

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All existing tests pass: `bun test`

#### Manual Verification:
- [x] Via MCP: create a one-time schedule with `delayMs: 60000` — verify it shows `nextRunAt` ~1 min in future
- [x] Via MCP: create a one-time schedule with `runAt` in the past — verify rejection
- [x] Via MCP: list schedules filtered by `scheduleType: 'one_time'`
- [x] Via MCP: verify creating a recurring schedule still works as before

**Implementation Note**: Pause for verification before proceeding to Phase 4.

---

## Phase 4: HTTP API Updates

Update the HTTP API to support one-time schedule creation and filtering.

### Files to modify:
- `src/http/schedules.ts`

### Steps:

1. **POST /api/schedules**: Accept `scheduleType`, `delayMs`, `runAt` in body. Apply same validation as MCP tool.
2. **PUT /api/schedules/:id**: Same restrictions as MCP update tool (no type change, etc.)
3. **GET /api/schedules** (if list endpoint exists): Support `?scheduleType=one_time` and `?hideCompleted=false` query filters. Default behavior hides executed one-time schedules.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] HTTP integration tests pass: `bun test src/tests/http-api-integration.test.ts`

#### Manual Verification:
- [x] `curl -X POST /api/schedules` with one-time payload — returns 201 with schedule
- [x] `curl -X POST /api/schedules` with invalid combo (one_time + cronExpression) — returns 400

**Implementation Note**: Pause for verification before proceeding to Phase 5.

---

## Phase 5: UI Updates

Update the dashboard to display and distinguish one-time schedules.

### Files to modify:
- `new-ui/src/api/types.ts` — add `scheduleType` to `ScheduledTask` interface
- `new-ui/src/pages/schedules/page.tsx` — show schedule type in list, add filter
- `new-ui/src/pages/schedules/[id]/page.tsx` — show schedule type in detail view

### Steps:

1. Add `scheduleType?: 'recurring' | 'one_time'` to the `ScheduledTask` interface in `new-ui/src/api/types.ts`
2. In the schedules list page, add a badge/indicator for one-time vs recurring
3. In the schedule detail page, show the type and appropriate timing info (for one-time: "Runs at X" or "Ran at X"; for recurring: existing cron/interval display)
4. Add a "Show completed one-time" toggle (default off) to reveal executed one-time schedules
5. Optionally add a filter chip to toggle between all/recurring/one-time

### Success Criteria:

#### Automated Verification:
- [x] UI type check passes: `cd new-ui && pnpm exec tsc --noEmit`
- [x] UI lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [x] One-time schedules show a distinct badge in the list
- [x] Completed one-time schedules show "Executed at X" instead of "Next run: disabled"

**Implementation Note**: Pause for verification before proceeding to Phase 6.

---

## Phase 6: Tests

Add unit tests for the new one-time schedule behavior.

### Files to modify:
- `src/tests/scheduled-tasks.test.ts` — or new test file `src/tests/one-time-schedules.test.ts`
- `src/scheduler/scheduler.test.ts`

### Tests to add:

1. **Create one-time schedule with delayMs** — verify `nextRunAt` is computed correctly, `scheduleType` is `'one_time'`
2. **Create one-time schedule with runAt** — verify `nextRunAt` matches `runAt`
3. **Reject one-time with cron** — verify error when providing both `scheduleType: 'one_time'` and `cronExpression`
4. **Reject recurring with delayMs** — verify error when providing `delayMs` without `scheduleType: 'one_time'`
5. **Execute one-time schedule** — verify task is created, schedule is auto-disabled, `nextRunAt` is cleared
6. **One-time recovery** — verify missed one-time schedule fires once and auto-disables
7. **Reject runAt in the past** — verify appropriate error

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `bun test`
- [x] Type check passes: `bun run tsc:check`

#### Manual Verification:
- [x] Review test coverage is adequate

**Implementation Note**: Pause for verification before final review.

---

## Manual E2E Verification

After all phases are complete, verify end-to-end:

```bash
# 1. Start fresh
rm agent-swarm-db.sqlite
bun run start:http

# 2. Create a one-time schedule (runs in 30 seconds)
curl -X POST http://localhost:3013/api/schedules \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-one-time",
    "taskTemplate": "Say hello - this is a one-time test",
    "scheduleType": "one_time",
    "delayMs": 30000
  }'

# 2b. Create a one-time schedule with runAt (1 minute from now)
RUNAT=$(date -u -v+1M +"%Y-%m-%dT%H:%M:%SZ")
curl -X POST http://localhost:3013/api/schedules \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"test-one-time-runat\",
    \"taskTemplate\": \"Say hello - runAt test\",
    \"scheduleType\": \"one_time\",
    \"runAt\": \"$RUNAT\"
  }"

# 3. Verify both appear in schedule list
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/schedules

# 4. Wait 30s-60s, then verify:
#    - A task was created (check /api/tasks)
#    - The schedule is now disabled (check /api/schedules/<id>)
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/schedules/<id>

# 5. Create a recurring schedule (verify no regression)
curl -X POST http://localhost:3013/api/schedules \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-recurring",
    "taskTemplate": "Recurring test",
    "cronExpression": "*/1 * * * *"
  }'

# 6. Verify the UI shows both schedules with correct type badges
# Open http://localhost:5274/schedules
```

## Risk Assessment

- **Low risk**: Adding a column with a default value is backward-compatible
- **Medium risk**: Table recreation in migration — must be tested with both fresh and existing DBs
- **Low risk**: Scheduler changes are isolated to the one-time code path; recurring behavior is unchanged
- **Low risk**: UI changes are additive (new badge, optional filter)
