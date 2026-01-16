---
date: 2026-01-15
topic: "Scheduled Tasks for the Agent Swarm"
researcher: "Claude"
status: "complete"
tags: [scheduling, cron, sqlite, task-automation]
---

# Research: Scheduled Tasks for the Agent Swarm

**Date**: 2026-01-15
**Status**: Complete

## Research Question

How to implement scheduled/recurring tasks in the agent swarm architecture, including options for task scheduling, integration patterns, persistence mechanisms, worker assignment, and relevant libraries.

## Summary

This research explores options for implementing scheduled tasks in the agent-swarm architecture. The existing system uses SQLite for persistence with Bun runtime. After analyzing four major scheduling libraries (node-cron, BullMQ, Agenda, Bree) and the current codebase architecture, the **recommended approach is a native SQLite-based scheduler** that integrates directly with the existing task system, avoiding external dependencies like Redis or MongoDB.

## Detailed Findings

### 1. Current Agent-Swarm Architecture

The agent-swarm system is built with:

- **Runtime**: Bun (TypeScript)
- **Database**: SQLite with WAL mode (`src/be/db.ts`)
- **Task Management**: `agent_tasks` table with statuses: `unassigned`, `offered`, `reviewing`, `pending`, `in_progress`, `completed`, `failed`
- **Task Assignment**: Via `send-task` tool, supports direct assignment, offer mode, and task pool
- **Background Processing**: Uses `setInterval` for polling (e.g., Slack watcher at 3s intervals)
- **No External Dependencies**: Currently no Redis, MongoDB, or external queue systems

**Key Files:**
| File | Purpose |
|------|---------|
| `src/be/db.ts` | SQLite database initialization and schema |
| `src/types.ts` | AgentTask schema with status, priority, dependencies |
| `src/tools/send-task.ts` | Task creation and assignment logic |
| `src/slack/watcher.ts` | Example of interval-based polling pattern |

### 2. Scheduling Library Comparison

| Feature | node-cron | BullMQ | Agenda | Bree |
|---------|-----------|--------|--------|------|
| **Backend** | In-memory | Redis | MongoDB | In-memory (workers) |
| **Persistence** | No | Yes | Yes | No (DIY) |
| **Horizontal Scaling** | No | Yes | Yes | No |
| **Cron Expressions** | Yes | Yes | Yes | Yes |
| **Human-Readable** | No | No | Yes | Yes |
| **Retries** | No | Yes | Manual | No |
| **TypeScript** | Yes (v4+) | Native | Yes | Yes |
| **Weekly Downloads** | ~1.6M | ~2.1M | ~137K | ~28K |
| **External Deps** | None | Redis | MongoDB | None |

#### node-cron
- **Pros**: Lightweight, zero dependencies, simple API
- **Cons**: No persistence, jobs lost on restart, no distributed support
- **Best For**: Simple in-process scheduling where persistence isn't critical

#### BullMQ
- **Pros**: High performance, persistence via Redis, horizontal scaling, retries, rate limiting, parent-child job flows
- **Cons**: Requires Redis infrastructure, adds operational complexity
- **Best For**: High-volume distributed job queues

#### Agenda
- **Pros**: MongoDB persistence, human-readable scheduling syntax, priority support
- **Cons**: Requires MongoDB, slower maintenance cycle, some known issues with cancellation
- **Best For**: MongoDB-based applications needing job scheduling

#### Bree
- **Pros**: Worker thread isolation, no database required, multiple time formats
- **Cons**: No built-in persistence, no horizontal scaling, smaller community
- **Best For**: CPU-intensive jobs requiring process isolation

### 3. Integration Patterns for Scheduled Tasks

#### Option A: Native SQLite-Based Scheduler (Recommended)

Create a new `scheduled_tasks` table that stores scheduling configurations and uses the existing `agent_tasks` system for execution.

**Schema Design:**
```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  cronExpression TEXT,           -- Cron: "0 9 * * *"
  intervalMs INTEGER,            -- Interval: 300000 (5 min)
  taskTemplate TEXT NOT NULL,    -- Task description template
  taskType TEXT,                 -- e.g., "maintenance", "report"
  tags TEXT DEFAULT '[]',
  priority INTEGER DEFAULT 50,
  targetAgentId TEXT,            -- Specific agent, or null for pool
  enabled INTEGER DEFAULT 1,
  lastRunAt TEXT,
  nextRunAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL
);
```

**Polling Mechanism:**
```typescript
// Similar to slack/watcher.ts pattern
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 10000): void {
  schedulerInterval = setInterval(async () => {
    const now = new Date().toISOString();
    const dueTasks = getDb().prepare(`
      SELECT * FROM scheduled_tasks
      WHERE enabled = 1 AND nextRunAt <= ?
    `).all(now);

    for (const scheduled of dueTasks) {
      // Create task via existing system
      createTaskExtended(scheduled.taskTemplate, {
        taskType: scheduled.taskType,
        tags: JSON.parse(scheduled.tags),
        priority: scheduled.priority,
        agentId: scheduled.targetAgentId,
      });

      // Update next run time
      const nextRun = calculateNextRun(scheduled);
      updateScheduledTask(scheduled.id, { lastRunAt: now, nextRunAt: nextRun });
    }
  }, intervalMs);
}
```

**Pros:**
- Zero external dependencies
- Uses existing SQLite persistence (survives restarts)
- Integrates naturally with existing task flow
- Consistent with current architecture patterns

**Cons:**
- Single-instance only (no distributed scheduling)
- Requires implementing cron parsing (use `cron-parser` package)

#### Option B: node-cron with Database Persistence Layer

Use node-cron for scheduling mechanics but persist schedule definitions in SQLite.

```typescript
import cron from 'node-cron';

// On startup: reload schedules from database
const schedules = getScheduledTasksFromDb();
for (const schedule of schedules) {
  cron.schedule(schedule.cronExpression, () => {
    createTaskExtended(schedule.taskTemplate, { ... });
  }, { name: schedule.name });
}
```

**Pros:**
- Mature cron parsing library
- Simple integration

**Cons:**
- Active schedules lost on restart (must re-register)
- Doesn't track lastRunAt automatically

#### Option C: BullMQ for Full-Featured Scheduling

Add Redis and use BullMQ for a production-grade solution.

**Pros:**
- Robust, battle-tested
- Horizontal scaling ready
- Built-in retries, rate limiting

**Cons:**
- Adds Redis dependency (significant operational overhead)
- Over-engineered for current single-server setup
- Inconsistent with existing architecture philosophy

### 4. Persistence Mechanisms

#### Current State
The agent-swarm already uses SQLite with WAL mode for durability:
- Jobs persist in `agent_tasks` table
- WAL mode ensures crash recovery
- Schema migrations handled at startup

#### Recommended Approach
Extend SQLite with a `scheduled_tasks` table:

1. **Schedule Definition Persistence**: Store cron expressions, intervals, and task templates
2. **Run History**: Track `lastRunAt`, `nextRunAt` for each schedule
3. **Task Creation Audit**: Created tasks include `scheduledTaskId` foreign key for traceability

### 5. Worker Assignment Strategies

#### Strategy 1: Pool-Based (Default)
Create tasks in the unassigned pool; workers claim via `task-action claim`.

```typescript
const task = createTaskExtended(template, {
  taskType: "scheduled",
  tags: ["cron", scheduleName],
  priority: 50,
  // No agentId = goes to pool
});
```

**Best For**: Load balancing across available workers

#### Strategy 2: Targeted Assignment
Assign to a specific agent (e.g., maintenance tasks to a dedicated worker).

```typescript
const task = createTaskExtended(template, {
  agentId: config.maintenanceAgentId,
  taskType: "scheduled",
});
```

**Best For**: Specialized tasks requiring specific agent capabilities

#### Strategy 3: Round-Robin or Capability-Based
Query available workers and select based on capacity or capabilities.

```typescript
const workers = getIdleWorkersByCapability(["reporting"]);
const target = workers[0]; // or round-robin selection
createTaskExtended(template, { agentId: target.id });
```

**Best For**: Balanced distribution with capability matching

#### Strategy 4: Offer Mode
Offer scheduled tasks to agents for acceptance.

```typescript
createTaskExtended(template, {
  offeredTo: targetAgentId,
  // Agent must accept within timeout
});
```

**Best For**: Tasks requiring agent consent

### 6. Relevant Libraries

| Library | Purpose | npm Weekly DL |
|---------|---------|---------------|
| `cron-parser` | Parse cron expressions, calculate next run | ~10M |
| `croner` | Modern cron scheduler with timezone support | ~500K |
| `node-cron` | Simple cron-based scheduling | ~1.6M |
| `bullmq` | Redis-backed job queue | ~2.1M |
| `agenda` | MongoDB-backed job scheduler | ~137K |
| `bree` | Worker thread scheduler | ~28K |
| `ms` | Convert time strings ("5m", "1h") to ms | ~130M |
| `human-interval` | Parse "every 5 minutes" to ms | ~200K |

**Recommended Additions:**
- `cron-parser` - For parsing cron expressions in native solution
- `ms` - Already widely used; useful for interval parsing

## Recommendations

### Primary Recommendation: Native SQLite-Based Scheduler

Given the existing architecture (SQLite-only, single-instance, Bun runtime), implement a **native scheduler** that:

1. **Stores schedules in SQLite** (`scheduled_tasks` table)
2. **Uses interval-based polling** (consistent with `slack/watcher.ts` pattern)
3. **Creates tasks via existing `createTaskExtended`** function
4. **Parses cron expressions** via `cron-parser` package
5. **Supports both cron and interval scheduling**

**Why This Approach:**
- Zero new infrastructure (no Redis/MongoDB)
- Survives restarts via SQLite persistence
- Integrates seamlessly with existing task flow
- Consistent with architectural philosophy
- Simple to implement and maintain

### Implementation Considerations

1. **Cron Parser**: Use `cron-parser` for robust cron expression handling
   ```typescript
   import { parseExpression } from 'cron-parser';
   const interval = parseExpression('0 9 * * *');
   const nextRun = interval.next().toISOString();
   ```

2. **Timezone Support**: Store timezone in schedule definition; pass to cron-parser

3. **Idempotency**: Generate deterministic task IDs to prevent duplicate creation if scheduler runs multiple times

4. **Graceful Shutdown**: Clear interval on SIGTERM/SIGINT

5. **Monitoring**: Add MCP tools for:
   - `list-schedules` - View all scheduled tasks
   - `create-schedule` - Add new schedule
   - `update-schedule` - Modify/enable/disable
   - `delete-schedule` - Remove schedule
   - `run-schedule-now` - Trigger immediate execution

6. **UI Integration**: Add scheduled tasks panel to the existing dashboard

### Potential Challenges

| Challenge | Mitigation |
|-----------|------------|
| Missed executions during downtime | Track `lastRunAt` and `nextRunAt`; optionally catch up missed runs on startup |
| Overlapping executions | Track `running` state; skip if previous instance still running |
| Time drift | Use monotonic clock or external time source for critical schedules |
| Database locking | SQLite WAL mode handles concurrent reads well; use transactions for writes |
| Horizontal scaling (future) | Design schema to support leader election or external coordination later |

### Future Enhancements (if needed)

If horizontal scaling becomes necessary:
1. Add leader election (e.g., via SQLite row lock or external service)
2. Consider migrating to BullMQ with Redis for distributed scheduling
3. Implement schedule sharding across instances

## Design Decisions (Answered)

1. **Catch-up policy**: Missed scheduled runs will be **skipped** (not executed on startup)

2. **Concurrency limits**: **No limits** - just create tasks and let agent config handle them based on infrastructure

3. **Schedule ownership**: Optionally define who can create schedules; if not specified, **defaults to lead** for delegation

4. **Notification**: **No automatic notifications** - each task will define what it connects to

5. **Dependencies**: **Not needed** - scheduled tasks won't depend on other tasks

## Code References

- `src/be/db.ts` - Database initialization, schema, migrations
- `src/types.ts` - AgentTask schema definition
- `src/tools/send-task.ts` - Task creation and assignment
- `src/slack/watcher.ts` - Interval-based polling pattern example
- `src/tools/task-action.ts` - Task pool operations (claim, release, accept, reject)

---

## Appendix: Library Deep Dives

### node-cron Details

- **Version**: 4.0.0 (May 2025)
- **GitHub Stars**: ~3,200
- **Syntax**: Standard crontab with optional seconds field
- **Key Methods**: `schedule()`, `validate()`, `getTasks()`
- **Options**: `scheduled`, `timezone`, `name`, `runOnInit`, `recoverMissedExecutions`

### BullMQ Details

- **Version**: 5.x (Jan 2026)
- **GitHub Stars**: ~8,300
- **Architecture**: Redis Streams for persistence and coordination
- **Key Features**: Delayed jobs, repeatable jobs, priorities, retries, rate limiting, parent-child flows
- **Scaling**: Horizontal via multiple workers across machines

### Agenda Details

- **Version**: 5.0.0 (Nov 2024)
- **GitHub Stars**: ~9,600
- **Architecture**: MongoDB-backed with polling mechanism
- **Key Features**: Human-readable scheduling, priorities, concurrency control
- **Note**: Consider `@hokify/agenda` fork for TypeScript improvements

### Bree Details

- **Version**: 9.2.8 (Jan 2026)
- **GitHub Stars**: ~3,248
- **Architecture**: Node.js worker threads for sandboxed execution
- **Key Features**: Process isolation, multiple time formats, graceful shutdown
- **Note**: No built-in persistence; requires DIY implementation

---

**Sources:**
- [node-cron GitHub](https://github.com/node-cron/node-cron)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [Agenda GitHub](https://github.com/agenda/agenda)
- [Bree GitHub](https://github.com/breejs/bree)
- [Better Stack: Schedulers in Node](https://betterstack.com/community/guides/scaling-nodejs/best-nodejs-schedulers/)
- [LogRocket: Comparing Node.js Schedulers](https://blog.logrocket.com/comparing-best-node-js-schedulers/)
- [cron-parser npm](https://www.npmjs.com/package/cron-parser)
