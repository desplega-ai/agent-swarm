---
date: 2026-01-15
author: Claude
status: ready
tags: [scheduling, cron, sqlite, task-automation, implementation]
related_research: thoughts/shared/research/2026-01-15-scheduled-tasks.md
---

# Scheduled Tasks Feature - Implementation Plan

**Date**: 2026-01-15
**Status**: Ready for Implementation

## Overview

Implement a native SQLite-based scheduled tasks feature for the agent-swarm. This allows defining recurring tasks (via cron expressions or intervals) that automatically create agent tasks at specified times. The scheduler follows existing architectural patterns (SQLite persistence, interval-based polling) and integrates seamlessly with the existing task system.

## Current State Analysis

The agent-swarm currently supports:
- **Task creation**: via `createTaskExtended()` in `src/be/db.ts`
- **Task pool**: unassigned tasks workers can claim
- **Interval polling**: pattern established in `src/slack/watcher.ts`
- **MCP tools**: registered via capability-gated `createToolRegistrar` pattern
- **Graceful shutdown**: SIGINT handler in `src/http.ts`

### Key Discoveries:
- Database uses SQLite with WAL mode, singleton pattern (`src/be/db.ts`)
- Schema created in transaction
- Migrations use try-catch for ALTER TABLE
- Slack watcher demonstrates polling pattern with throttling and optimistic locking (`src/slack/watcher.ts`)
- Tools registered via `createToolRegistrar` with Zod schemas (`src/tools/utils.ts`)

## Desired End State

A fully functional scheduler that:
1. Stores schedule definitions in SQLite (`scheduled_tasks` table)
2. Polls for due schedules every 10 seconds (configurable)
3. Creates tasks via existing `createTaskExtended` when schedules are due
4. Provides 5 MCP tools for schedule management
5. Starts on server startup and stops gracefully on shutdown
6. Supports both cron expressions and interval-based scheduling

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run lint` - Linting
- `bun run typecheck` - Type checking
- `bun test` - Run tests (if available)
- `bun run build` - Build

Key files to check:
- `src/be/db.ts` - Schema and database functions
- `src/scheduler/scheduler.ts` - Core scheduler service
- `src/tools/schedules/*.ts` - MCP tools
- `src/http.ts` - Server startup/shutdown integration

## What We're NOT Doing

- **Catch-up execution**: Missed schedules during downtime will be skipped (user requirement)
- **Concurrency limits**: No limit on concurrent scheduled task instances (user requirement)
- **Task dependencies**: Scheduled tasks won't depend on other tasks (user requirement)
- **Notifications**: No automatic Slack/GitHub notifications (each task defines its own connections)
- **Horizontal scaling**: Single-instance scheduler (can be added later with leader election)
- **UI dashboard**: No frontend changes in this phase

## Implementation Approach

Follow existing patterns:
1. Add `scheduled_tasks` table schema in `db.ts`
2. Create scheduler service following `slack/watcher.ts` pattern
3. Register MCP tools following existing tool patterns
4. Integrate startup/shutdown in `http.ts`

---

## Phase 1: Database Schema & Core Types

### Overview
Add the `scheduled_tasks` table schema and TypeScript types.

### Changes Required:

#### 1. Schema Definition
**File**: `src/be/db.ts`
**Location**: After existing table definitions (~line 190, before indexes)

**Add table creation:**
```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
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
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  CHECK (cronExpression IS NOT NULL OR intervalMs IS NOT NULL)
)
```

**Add indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt);
```

#### 2. Type Definitions
**File**: `src/types.ts`
**Location**: After AgentTask definitions

**Add new types:**
```typescript
export const ScheduledTaskSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  cronExpression: z.string().optional(),
  intervalMs: z.number().int().positive().optional(),
  taskTemplate: z.string().min(1),
  taskType: z.string().max(50).optional(),
  tags: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  targetAgentId: z.uuid().optional(),
  enabled: z.boolean().default(true),
  lastRunAt: z.iso.datetime().optional(),
  nextRunAt: z.iso.datetime().optional(),
  createdByAgentId: z.uuid().optional(),
  timezone: z.string().default('UTC'),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
}).refine(
  data => data.cronExpression || data.intervalMs,
  { message: "Either cronExpression or intervalMs must be provided" }
);

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;
```

#### 3. Database Helper Functions
**File**: `src/be/db.ts`
**Location**: After existing task functions

**Add CRUD functions:**
- `getScheduledTasks(filters?)` - List schedules with optional filters
- `getScheduledTaskById(id)` - Get single schedule
- `getScheduledTaskByName(name)` - Get by unique name
- `createScheduledTask(data)` - Create new schedule
- `updateScheduledTask(id, data)` - Update existing schedule
- `deleteScheduledTask(id)` - Delete schedule
- `getDueScheduledTasks()` - Query `enabled=1 AND nextRunAt <= now`

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Database initializes without errors
- [ ] Can query `scheduled_tasks` table via SQLite CLI

**Implementation Note**: After completing this phase, verify schema is created correctly before proceeding.

---

## Phase 2: Scheduler Service

### Overview
Create the core scheduler service that polls for due schedules and creates tasks.

### Changes Required:

#### 1. Install cron-parser Package
**Command**: `bun add cron-parser`

#### 2. Create Scheduler Service
**File**: `src/scheduler/scheduler.ts` (new file)

**Implementation following slack/watcher.ts pattern:**

```typescript
import { parseExpression } from 'cron-parser';
import { getDb, createTaskExtended, getDueScheduledTasks, updateScheduledTask } from '../be/db';
import type { ScheduledTask } from '../types';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

// Calculate next run time based on cron or interval
export function calculateNextRun(schedule: ScheduledTask, fromTime: Date = new Date()): string {
  if (schedule.cronExpression) {
    const interval = parseExpression(schedule.cronExpression, {
      currentDate: fromTime,
      tz: schedule.timezone || 'UTC',
    });
    return interval.next().toISOString();
  }

  if (schedule.intervalMs) {
    return new Date(fromTime.getTime() + schedule.intervalMs).toISOString();
  }

  throw new Error('Schedule must have cronExpression or intervalMs');
}

// Execute a single scheduled task
async function executeSchedule(schedule: ScheduledTask): Promise<void> {
  const now = new Date().toISOString();

  // Create the actual task
  createTaskExtended(schedule.taskTemplate, {
    creatorAgentId: schedule.createdByAgentId,
    taskType: schedule.taskType,
    tags: [...schedule.tags, 'scheduled', `schedule:${schedule.name}`],
    priority: schedule.priority,
    agentId: schedule.targetAgentId, // null goes to pool
  });

  // Update lastRunAt and nextRunAt
  const nextRun = calculateNextRun(schedule, new Date());
  updateScheduledTask(schedule.id, {
    lastRunAt: now,
    nextRunAt: nextRun,
    lastUpdatedAt: now,
  });

  console.log(`[Scheduler] Executed schedule "${schedule.name}", next run: ${nextRun}`);
}

// Main polling function
export function startScheduler(intervalMs = 10000): void {
  if (schedulerInterval) {
    console.log('[Scheduler] Already running');
    return;
  }

  console.log(`[Scheduler] Starting with ${intervalMs}ms polling interval`);

  schedulerInterval = setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const dueSchedules = getDueScheduledTasks();

      for (const schedule of dueSchedules) {
        try {
          await executeSchedule(schedule);
        } catch (err) {
          console.error(`[Scheduler] Error executing "${schedule.name}":`, err);
        }
      }
    } finally {
      isProcessing = false;
    }
  }, intervalMs);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    isProcessing = false;
    console.log('[Scheduler] Stopped');
  }
}

// Run a schedule immediately (manual trigger)
export async function runScheduleNow(scheduleId: string): Promise<void> {
  const schedule = getScheduledTaskById(scheduleId);
  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }
  if (!schedule.enabled) {
    throw new Error(`Schedule is disabled: ${schedule.name}`);
  }
  await executeSchedule(schedule);
}
```

#### 3. Create Index File
**File**: `src/scheduler/index.ts` (new file)

```typescript
export { startScheduler, stopScheduler, runScheduleNow, calculateNextRun } from './scheduler';
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Package `cron-parser` installed successfully

#### Manual Verification:
- [ ] Scheduler starts without errors
- [ ] Test cron parsing: `parseExpression('0 9 * * *')` returns valid next date

**Implementation Note**: Test cron-parser integration before proceeding.

---

## Phase 3: MCP Tools

### Overview
Create 5 MCP tools for schedule management: list-schedules, create-schedule, update-schedule, delete-schedule, run-schedule-now.

### Changes Required:

#### 1. Create Tools Directory
**Directory**: `src/tools/schedules/`

#### 2. list-schedules Tool
**File**: `src/tools/schedules/list-schedules.ts`

```typescript
import type { McpServer } from '@anthropic-ai/sdk/resources/mcp';
import { z } from 'zod';
import { createToolRegistrar } from '../utils';
import { getScheduledTasks } from '../../be/db';
import { ScheduledTaskSchema } from '../../types';

export const registerListSchedulesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    'list-schedules',
    {
      title: 'List scheduled tasks',
      description: 'View all scheduled tasks with optional filters.',
      inputSchema: z.object({
        enabled: z.boolean().optional().describe('Filter by enabled status'),
        name: z.string().optional().describe('Filter by name (partial match)'),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        schedules: z.array(ScheduledTaskSchema),
        count: z.number(),
      }),
    },
    async ({ enabled, name }, requestInfo, _meta) => {
      const schedules = getScheduledTasks({ enabled, name });
      return {
        success: true,
        schedules,
        count: schedules.length,
      };
    },
  );
};
```

#### 3. create-schedule Tool
**File**: `src/tools/schedules/create-schedule.ts`

Implements schedule creation with:
- Required: name, taskTemplate
- Optional: cronExpression, intervalMs, description, taskType, tags, priority, targetAgentId, timezone
- Validates cron expression syntax
- Calculates initial nextRunAt
- Respects schedule ownership (createdByAgentId from requestInfo, or defaults to lead)

#### 4. update-schedule Tool
**File**: `src/tools/schedules/update-schedule.ts`

Implements schedule updates:
- Update by ID or name
- Can enable/disable schedule
- Recalculates nextRunAt if cron/interval changes
- Only creator or lead can update

#### 5. delete-schedule Tool
**File**: `src/tools/schedules/delete-schedule.ts`

Implements schedule deletion:
- Delete by ID or name
- Only creator or lead can delete

#### 6. run-schedule-now Tool
**File**: `src/tools/schedules/run-schedule-now.ts`

Implements immediate execution:
- Trigger by ID or name
- Creates task immediately
- Updates lastRunAt but not nextRunAt (regular schedule continues)

#### 7. Index File
**File**: `src/tools/schedules/index.ts`

```typescript
export { registerListSchedulesTool } from './list-schedules';
export { registerCreateScheduleTool } from './create-schedule';
export { registerUpdateScheduleTool } from './update-schedule';
export { registerDeleteScheduleTool } from './delete-schedule';
export { registerRunScheduleNowTool } from './run-schedule-now';
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Each tool registers without errors
- [ ] Tools appear in MCP tool list

**Implementation Note**: After completing this phase, test each tool manually via MCP client.

---

## Phase 4: Server Integration

### Overview
Wire up scheduler startup/shutdown and register MCP tools.

### Changes Required:

#### 1. Add Capability Gate
**File**: `src/server.ts`

Add new capability for scheduling:
```typescript
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services,scheduling";
```

Register tools if capability enabled:
```typescript
if (hasCapability("scheduling")) {
  registerListSchedulesTool(server);
  registerCreateScheduleTool(server);
  registerUpdateScheduleTool(server);
  registerDeleteScheduleTool(server);
  registerRunScheduleNowTool(server);
}
```

#### 2. Start Scheduler on Server Start
**File**: `src/http.ts`

In `httpServer.listen()` callback:
```typescript
// Start scheduler (if configured)
if (hasCapability("scheduling")) {
  const { startScheduler } = await import('./scheduler');
  startScheduler(Number(process.env.SCHEDULER_INTERVAL_MS) || 10000);
}
```

#### 3. Stop Scheduler on Shutdown
**File**: `src/http.ts`

In `shutdown()` function:
```typescript
// Stop scheduler
if (hasCapability("scheduling")) {
  const { stopScheduler } = await import('./scheduler');
  stopScheduler();
}
```

#### 4. Environment Variable Documentation
**File**: `.env.example`

Add:
```bash
# Scheduler configuration
SCHEDULER_INTERVAL_MS=10000  # Polling interval (default: 10 seconds)
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Server starts with scheduler running (check logs)
- [ ] Server shutdown stops scheduler cleanly
- [ ] Tools available via MCP when capability enabled

---

## Phase 5: Testing & Documentation

### Overview
Add tests and update documentation.

### Changes Required:

#### 1. Unit Tests
**File**: `src/scheduler/scheduler.test.ts`

Test cases:
- `calculateNextRun` with cron expression
- `calculateNextRun` with interval
- `calculateNextRun` with timezone
- Scheduler starts and stops correctly

#### 2. Update MCP.md
**File**: `MCP.md`

Add section documenting new tools:
- `list-schedules`
- `create-schedule`
- `update-schedule`
- `delete-schedule`
- `run-schedule-now`

Include examples for cron and interval scheduling.

#### 3. Update README.md
**File**: `README.md`

Add brief mention of scheduling capability in features section.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test` passes (if tests are set up)
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Documentation is clear and accurate
- [ ] Examples work as documented

---

## Testing Strategy

### Unit Tests
- `calculateNextRun` function with various cron expressions
- Database CRUD functions for scheduled_tasks
- Cron expression validation

### Integration Tests
- End-to-end: create schedule -> wait for execution -> verify task created
- Tool validation: verify MCP tool schemas

### Manual Testing Steps
1. Create a schedule with 1-minute interval
2. Wait for task to be created
3. Verify task appears in task list with correct metadata
4. Disable schedule, verify no new tasks
5. Run schedule manually, verify task created
6. Delete schedule, verify removal

---

## References

- Research document: `thoughts/shared/research/2026-01-15-scheduled-tasks.md`
- Existing polling pattern: `src/slack/watcher.ts`
- Task creation: `src/be/db.ts`
- Tool registration: `src/tools/utils.ts`
- cron-parser docs: https://www.npmjs.com/package/cron-parser
