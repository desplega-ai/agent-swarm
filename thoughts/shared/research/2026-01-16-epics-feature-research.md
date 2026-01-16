---
date: 2026-01-16T17:05:00Z
researcher: Claude (Researcher Agent)
git_commit: c64aca6d034d3b1376fc2d17f813fee5e0d7122d
branch: main
repository: desplega-ai/agent-swarm
topic: "Epics Feature for Agent Swarm - Codebase Analysis"
tags: [research, codebase, epics, task-management, project-organization]
status: complete
autonomy: autopilot
last_updated: 2026-01-16
last_updated_by: Claude (Researcher Agent)
---

# Research: Epics Feature for Agent Swarm

**Date**: 2026-01-16T17:05:00Z
**Researcher**: Claude (Researcher Agent)
**Git Commit**: c64aca6d034d3b1376fc2d17f813fee5e0d7122d
**Branch**: main

## Research Question

How should an "epics" feature be implemented in the agent-swarm codebase? An epic would represent a project-level concept containing:
- A goal
- A PRD (Product Requirements Document)
- A plan
- Tasks assigned to it (either statically or dynamically as it progresses)

The feature should integrate with existing `/desplega:research`, `/desplega:create-plan`, and `/desplega:implement-plan` commands.

## Summary

The agent-swarm codebase provides a solid foundation for implementing epics through its existing task management architecture, scheduled tasks pattern (which demonstrates a "template that spawns tasks" model), and MCP tool registration system. The key implementation path involves:

1. Creating a new `epics` database table with fields for goal, PRD, plan, status, and timestamps
2. Adding an `epicId` foreign key to the existing `agent_tasks` table
3. Implementing new MCP tools following the established `createToolRegistrar` pattern
4. Adding HTTP REST endpoints following existing patterns in `http.ts`
5. Optionally integrating with the scheduler system for progress-triggered task creation

---

## Detailed Findings

### 1. Current Task Management Architecture

#### Task Table Structure (`src/be/db.ts:59-85`)

The `agent_tasks` table is the core entity for task management:

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT (UUID) | Primary key |
| `agentId` | TEXT | Assigned agent (nullable for unassigned) |
| `creatorAgentId` | TEXT | Task creator |
| `task` | TEXT | Task description |
| `status` | TEXT | Status enum (9 values) |
| `source` | TEXT | Origin (mcp, slack, api, github) |
| `taskType` | TEXT | Classification |
| `tags` | TEXT (JSON array) | Filtering tags |
| `priority` | INTEGER | 0-100 scale |
| `dependsOn` | TEXT (JSON array) | Dependency task IDs |
| Various timestamps | TEXT | createdAt, lastUpdatedAt, finishedAt |
| Slack metadata | TEXT fields | slackChannelId, slackThreadTs, slackUserId |
| GitHub metadata | TEXT fields | githubRepo, githubNumber, etc. |

**Task Statuses** (`src/types.ts:4-14`):
- `unassigned` - In task pool
- `offered` - Awaiting agent acceptance
- `reviewing` - Agent reviewing offered task
- `pending` - Assigned, waiting to start
- `in_progress` - Actively being worked
- `paused` - Interrupted, can resume
- `completed` - Successfully finished
- `failed` - Failed with reason
- `cancelled` - Cancelled by lead/creator

#### Key Task Functions (`src/be/db.ts`)

| Function | Lines | Purpose |
|----------|-------|---------|
| `createTaskExtended()` | 1634-1694 | Create task with full options |
| `getTaskById()` | 946-949 | Fetch single task |
| `getAllTasks()` | 989-1050 | Query with filters |
| `startTask()` | 924-944 | Set to in_progress |
| `completeTask()` | 1269-1292 | Mark completed |
| `failTask()` | 1294-1311 | Mark failed |
| `cancelTask()` | 1313-1340 | Cancel task |
| `updateTaskProgress()` | 1456-1469 | Update progress field |
| `checkDependencies()` | 1888-1906 | Verify all deps completed |

### 2. Database Schema and Models

#### Technology Stack
- **Database**: SQLite via `bun:sqlite`
- **ORM**: None - raw SQL queries with prepared statements
- **Type Validation**: Zod schemas in `src/types.ts`
- **Migrations**: Inline in `db.ts` using `ALTER TABLE IF NOT EXISTS` pattern

#### Schema Pattern (`src/be/db.ts:36-285`)

Tables are created within a transaction at database initialization:

```typescript
database.run("PRAGMA journal_mode = WAL;");
database.run("PRAGMA foreign_keys = ON;");

database.exec("BEGIN TRANSACTION");
try {
  // CREATE TABLE IF NOT EXISTS statements
  database.exec("COMMIT");
} catch (e) {
  database.exec("ROLLBACK");
}
```

#### Existing Tables

| Table | Purpose |
|-------|---------|
| `agents` | Agent registration and status |
| `agent_tasks` | Task assignments |
| `agent_log` | Event logging |
| `channels` | Inter-agent communication |
| `channel_messages` | Messages within channels |
| `channel_read_state` | Read tracking |
| `services` | PM2 service registry |
| `session_logs` | CLI output logging |
| `session_costs` | Usage tracking |
| `inbox_messages` | Lead inbox |
| `scheduled_tasks` | Recurring task templates |

#### Zod Schema Pattern (`src/types.ts`)

```typescript
export const AgentTaskSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid().nullable(),
  task: z.string().min(1),
  status: AgentTaskStatusSchema,
  // ... other fields
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;
```

### 3. MCP Tool Definitions

#### Tool Registration Pattern (`src/tools/utils.ts:86-115`)

All tools use the `createToolRegistrar` factory:

```typescript
export const registerSomeTools = (server: McpServer) => {
  createToolRegistrar(server)(
    "tool-name",
    {
      title: "Tool Title",
      description: "Tool description for LLM.",
      inputSchema: z.object({
        param1: z.string().describe("Param description"),
        param2: z.number().optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        data: SomeSchema.optional(),
      }),
    },
    async (args, requestInfo, meta) => {
      // Handler receives validated args + requestInfo.agentId
      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: result,
      };
    },
  );
};
```

#### Request Context Injection (`src/tools/utils.ts:18-38`)

The `X-Agent-ID` header is extracted and passed to handlers:

```typescript
export type RequestInfo = {
  sessionId: string | undefined;
  agentId: string | undefined;
};

export const getRequestInfo = (req: Meta): RequestInfo => {
  const agentIdHeader = req.requestInfo?.headers?.["x-agent-id"];
  // ... extraction logic
};
```

#### Existing Task Tools

| Tool | File | Purpose |
|------|------|---------|
| `send-task` | `src/tools/send-task.ts` | Create task (assign, offer, or pool) |
| `get-tasks` | `src/tools/get-tasks.ts` | List tasks with filters |
| `get-task-details` | `src/tools/get-task-details.ts` | Fetch task + logs |
| `task-action` | `src/tools/task-action.ts` | Claim, release, accept, reject |
| `poll-task` | `src/tools/poll-task.ts` | Get next task for agent |
| `store-progress` | `src/tools/store-progress.ts` | Update progress, complete, fail |
| `cancel-task` | `src/tools/cancel-task.ts` | Cancel task |

#### Tool Registration in Server (`src/server.ts:77-128`)

Tools are registered conditionally based on capabilities:

```typescript
// Core tools - always registered
registerJoinSwarmTool(server);
registerSendTaskTool(server);
// ...

// Capability-gated tools
if (hasCapability("scheduling")) {
  registerCreateScheduleTool(server);
  // ...
}
```

### 4. HTTP REST API Pattern

#### Endpoint Definition (`src/http.ts`)

Routes are matched using path segment arrays:

```typescript
const pathSegments = getPathSegments(req.url || "");

// GET /api/tasks
if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "tasks" && !pathSegments[2]) {
  const tasks = getAllTasks(filters);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ tasks, total }));
  return;
}
```

#### Response Patterns

**List endpoints**: `{ items: [], total: number }`
**Single resource**: Direct object
**Actions**: `{ success: boolean, message: string, entity?: object }`
**Errors**: `{ error: "Error message" }`

#### Authentication

- API Key via `Authorization: Bearer <key>` header
- Agent ID via `X-Agent-ID` header for agent-specific operations

### 5. Scheduled Tasks - Closest Existing Pattern

The `scheduled_tasks` feature demonstrates a "template that spawns tasks" pattern:

#### Schema (`src/be/db.ts:255-275`)

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  cronExpression TEXT,
  intervalMs INTEGER,
  taskTemplate TEXT NOT NULL,   -- Template for spawned tasks
  taskType TEXT,
  tags TEXT DEFAULT '[]',
  priority INTEGER DEFAULT 50,
  targetAgentId TEXT,           -- Route to specific agent
  enabled INTEGER DEFAULT 1,
  lastRunAt TEXT,
  nextRunAt TEXT,
  createdByAgentId TEXT,
  timezone TEXT DEFAULT 'UTC',
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL
)
```

#### Task Creation from Template (`src/scheduler/scheduler.ts:44-67`)

```typescript
async function executeSchedule(schedule: ScheduledTask): Promise<void> {
  const tx = getDb().transaction(() => {
    createTaskExtended(schedule.taskTemplate, {
      creatorAgentId: schedule.createdByAgentId,
      taskType: schedule.taskType,
      tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`],
      priority: schedule.priority,
      agentId: schedule.targetAgentId,
    });
    // ... update nextRunAt
  });
  tx();
}
```

**Key pattern**: Tags are used for traceability (`schedule:{name}`)

### 6. Existing Grouping/Hierarchy Concepts

Currently, there are no explicit project/epic groupings. The closest concepts are:

1. **Task Dependencies** (`dependsOn` field) - Tasks can depend on other tasks
2. **Tags** - Free-form filtering and grouping
3. **Task Type** - Classification field
4. **Scheduled Tasks** - Template that creates related tasks with shared tags

---

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/be/db.ts` | 59-85 | agent_tasks table schema |
| `src/be/db.ts` | 255-275 | scheduled_tasks table schema |
| `src/be/db.ts` | 1634-1694 | createTaskExtended function |
| `src/types.ts` | 58-105 | AgentTask Zod schema |
| `src/types.ts` | 267-291 | ScheduledTask Zod schema |
| `src/tools/utils.ts` | 86-115 | createToolRegistrar factory |
| `src/tools/send-task.ts` | 7-172 | send-task tool implementation |
| `src/server.ts` | 58-131 | createServer and tool registration |
| `src/http.ts` | 1029-1214 | Task HTTP endpoints |
| `src/scheduler/scheduler.ts` | 44-67 | executeSchedule function |

---

## Architecture Documentation

### Existing Patterns to Follow

1. **Database**: SQLite with WAL mode, foreign keys enabled, transactions for multi-step operations
2. **Types**: Zod schemas for runtime validation, TypeScript types inferred via `z.infer`
3. **MCP Tools**: `createToolRegistrar` factory with `inputSchema`/`outputSchema` Zod objects
4. **HTTP API**: Path-segment matching, JSON responses, `X-Agent-ID` authentication
5. **Traceability**: Tags for linking related entities (e.g., `schedule:{name}`)

### Extension Points for Epics

1. **New Table**: `epics` table in `src/be/db.ts`
2. **FK on Tasks**: Add `epicId` column to `agent_tasks`
3. **New Type**: `EpicSchema` in `src/types.ts`
4. **New Tools**: `src/tools/epics/` directory with create, list, get, update, delete, assign tools
5. **HTTP Endpoints**: `/api/epics` routes in `src/http.ts`
6. **Capability**: Optional `epics` capability flag

---

## Historical Context (from thoughts/)

The scheduled tasks feature was implemented following a research-then-plan approach:

- **Research**: `/workspace/agent-swarm/thoughts/shared/research/2026-01-15-scheduled-tasks.md`
- **Plan**: `/workspace/agent-swarm/thoughts/shared/plans/2026-01-15-scheduled-tasks-implementation.md`

These documents follow a structured format with YAML frontmatter, clear sections (Research Question, Summary, Detailed Findings, Recommendations), and explicit success criteria.

---

## Recommendations for Epic Schema

Based on the analysis, an `epics` table should include:

```sql
CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  goal TEXT NOT NULL,               -- The epic's objective
  prd TEXT,                         -- Product Requirements Document (markdown)
  plan TEXT,                        -- Implementation plan (markdown)
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  priority INTEGER DEFAULT 50,
  tags TEXT DEFAULT '[]',
  createdByAgentId TEXT,
  leadAgentId TEXT,                 -- Optional: primary assignee
  researchDocPath TEXT,             -- Link to /research doc
  planDocPath TEXT,                 -- Link to /plan doc
  slackChannelId TEXT,              -- Optional Slack integration
  slackThreadTs TEXT,
  githubRepo TEXT,                  -- Optional GitHub integration
  githubMilestone TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  FOREIGN KEY (createdByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (leadAgentId) REFERENCES agents(id) ON DELETE SET NULL
)
```

**Task linkage** (add to agent_tasks):
```sql
ALTER TABLE agent_tasks ADD COLUMN epicId TEXT REFERENCES epics(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId);
```

---

## Open Questions

1. **Task Creation Strategy**: Should epics support:
   - Static task lists (defined upfront)?
   - Dynamic task creation (as epic progresses)?
   - Both (hybrid approach)?

2. **Progress Tracking**: How should epic progress be calculated?
   - Count of completed tasks / total tasks?
   - Weighted by priority?
   - Manual progress field?

3. **Integration Depth**: How deeply should epics integrate with existing commands?
   - `/desplega:research` outputs to `epic.researchDocPath`?
   - `/desplega:create-plan` outputs to `epic.planDocPath`?
   - Automatic task creation from plan?

4. **UI Considerations**: Should the UI (React app in `ui/`) display epics?
   - Epic list panel?
   - Epic detail view with tasks?
   - Gantt/timeline view?

5. **Permissions**: Who can modify an epic?
   - Only creator?
   - Creator + leadAgentId?
   - Any agent?

---

## Related Research

- `/workspace/agent-swarm/thoughts/shared/research/2026-01-15-scheduled-tasks.md` - Scheduled tasks research (similar pattern)
- `/workspace/agent-swarm/thoughts/shared/plans/2026-01-15-scheduled-tasks-implementation.md` - Implementation plan template
