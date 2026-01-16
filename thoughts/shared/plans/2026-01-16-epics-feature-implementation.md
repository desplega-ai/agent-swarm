---
date: 2026-01-16
author: Claude (Researcher Agent)
status: ready
tags: [epics, task-management, project-organization, implementation]
related_research: /workspace/shared/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-01-16-epics-feature-research.md
---

# Epics Feature - Implementation Plan

**Date**: 2026-01-16
**Status**: Ready for Implementation

## Overview

Implement an "epics" feature for the agent-swarm that enables project-level task organization. An epic represents a larger initiative with a goal, PRD (Product Requirements Document), and plan, with multiple tasks assigned to it. This follows the established patterns from scheduled_tasks and integrates with the existing task management system.

## Current State Analysis

The agent-swarm currently supports:
- **Task management**: via `agent_tasks` table and `createTaskExtended()` in `src/be/db.ts`
- **Task pool**: unassigned tasks workers can claim
- **Scheduled tasks**: template-based recurring task creation (closest existing pattern)
- **MCP tools**: registered via capability-gated `createToolRegistrar` pattern
- **HTTP REST API**: path-segment matching in `src/http.ts`

### Key Discoveries:
- Database uses SQLite with WAL mode, singleton pattern (`src/be/db.ts:25-34`)
- Schema created in transaction with `CREATE TABLE IF NOT EXISTS` statements
- Migrations use try-catch for `ALTER TABLE` to handle existing columns
- Tools registered via `createToolRegistrar` with Zod schemas (`src/tools/utils.ts:86-115`)
- Scheduled tasks demonstrate "parent entity with child tasks" pattern via tags (`schedule:{name}`)
- Types defined in `src/types.ts` using Zod with type inference

## Desired End State

A fully functional epics feature that:
1. Stores epic definitions in SQLite (`epics` table)
2. Links tasks to epics via `epicId` foreign key on `agent_tasks`
3. Provides 7 MCP tools for epic management
4. Exposes 6 HTTP REST endpoints for the UI
5. Supports both static and dynamic task assignment to epics
6. Tracks epic progress based on task completion
7. Integrates with existing workflow commands

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run lint` - Linting
- `bun run typecheck` - Type checking
- `bun test` - Run tests
- `bun run build` - Build

Key files to check:
- `src/be/db.ts` - Schema and database functions
- `src/types.ts` - Type definitions
- `src/tools/epics/*.ts` - MCP tools
- `src/server.ts` - Tool registration
- `src/http.ts` - HTTP endpoints

## What We're NOT Doing

- **Automatic task creation from plan**: Epics store plan text but don't auto-parse it into tasks (user requirement)
- **Complex progress formulas**: Progress is simple completed_tasks / total_tasks ratio
- **Epic dependencies**: Epics don't depend on other epics (can be added later)
- **Epic scheduling**: No cron/interval-based epic triggers (different from scheduled_tasks)
- **UI dashboard**: Frontend changes are out of scope for this phase
- **GitHub milestone sync**: No automatic GitHub milestone creation (can be added later)

## Implementation Approach

Follow existing patterns:
1. Add `epics` table schema in `db.ts`
2. Add `epicId` column to `agent_tasks` table
3. Create Zod types in `types.ts`
4. Create MCP tools in `src/tools/epics/` directory
5. Register tools with new "epics" capability
6. Add HTTP REST endpoints in `http.ts`

---

## Phase 1: Database Schema & Core Types

### Overview
Add the `epics` table schema, `epicId` foreign key on tasks, and TypeScript types.

### Changes Required:

#### 1. Schema Definition - Epics Table
**File**: `src/be/db.ts`
**Location**: After scheduled_tasks table definition (~line 275)

**Add table creation:**
```sql
CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  goal TEXT NOT NULL,
  prd TEXT,
  plan TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  priority INTEGER DEFAULT 50,
  tags TEXT DEFAULT '[]',
  createdByAgentId TEXT,
  leadAgentId TEXT,
  researchDocPath TEXT,
  planDocPath TEXT,
  slackChannelId TEXT,
  slackThreadTs TEXT,
  githubRepo TEXT,
  githubMilestone TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  startedAt TEXT,
  completedAt TEXT,
  FOREIGN KEY (createdByAgentId) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (leadAgentId) REFERENCES agents(id) ON DELETE SET NULL
)
```

**Add indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_epics_status ON epics(status);
CREATE INDEX IF NOT EXISTS idx_epics_createdByAgentId ON epics(createdByAgentId);
CREATE INDEX IF NOT EXISTS idx_epics_leadAgentId ON epics(leadAgentId);
```

#### 2. Migration - Add epicId to agent_tasks
**File**: `src/be/db.ts`
**Location**: After existing migrations (~line 425)

**Add migration:**
```typescript
// Epic feature migration: Add epicId to agent_tasks
try {
  db.run(`ALTER TABLE agent_tasks ADD COLUMN epicId TEXT REFERENCES epics(id) ON DELETE SET NULL`);
} catch {
  /* exists */
}
try {
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_epicId ON agent_tasks(epicId)`);
} catch {
  /* exists */
}
```

#### 3. Type Definitions
**File**: `src/types.ts`
**Location**: After ScheduledTaskSchema (~line 291)

**Add new types:**
```typescript
// ============================================================================
// Epic Types
// ============================================================================

export const EpicStatusSchema = z.enum([
  "draft",      // Epic is being defined
  "active",     // Epic is in progress
  "paused",     // Epic is temporarily paused
  "completed",  // All tasks completed
  "cancelled",  // Epic was cancelled
]);

export const EpicSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  goal: z.string().min(1),
  prd: z.string().optional(),        // Product Requirements Document
  plan: z.string().optional(),       // Implementation plan
  status: EpicStatusSchema.default("draft"),
  priority: z.number().int().min(0).max(100).default(50),
  tags: z.array(z.string()).default([]),
  createdByAgentId: z.uuid().optional(),
  leadAgentId: z.uuid().optional(),
  researchDocPath: z.string().optional(),
  planDocPath: z.string().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  githubRepo: z.string().optional(),
  githubMilestone: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});

export type EpicStatus = z.infer<typeof EpicStatusSchema>;
export type Epic = z.infer<typeof EpicSchema>;

// Epic with computed progress
export const EpicWithProgressSchema = EpicSchema.extend({
  taskStats: z.object({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    inProgress: z.number(),
    pending: z.number(),
  }),
  progress: z.number().min(0).max(100),  // Percentage
});

export type EpicWithProgress = z.infer<typeof EpicWithProgressSchema>;
```

#### 4. Update AgentTaskSchema
**File**: `src/types.ts`
**Location**: In AgentTaskSchema (~line 58-105)

**Add epicId field:**
```typescript
// Epic association (optional)
epicId: z.uuid().optional(),
```

#### 5. Database Helper Functions
**File**: `src/be/db.ts`
**Location**: After scheduled task functions (~line 3400+)

**Add type definition:**
```typescript
type EpicRow = {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  prd: string | null;
  plan: string | null;
  status: EpicStatus;
  priority: number;
  tags: string | null;
  createdByAgentId: string | null;
  leadAgentId: string | null;
  researchDocPath: string | null;
  planDocPath: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  githubRepo: string | null;
  githubMilestone: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function rowToEpic(row: EpicRow): Epic {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    goal: row.goal,
    prd: row.prd ?? undefined,
    plan: row.plan ?? undefined,
    status: row.status,
    priority: row.priority,
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdByAgentId: row.createdByAgentId ?? undefined,
    leadAgentId: row.leadAgentId ?? undefined,
    researchDocPath: row.researchDocPath ?? undefined,
    planDocPath: row.planDocPath ?? undefined,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    githubRepo: row.githubRepo ?? undefined,
    githubMilestone: row.githubMilestone ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}
```

**Add CRUD functions:**
```typescript
// ============================================================================
// Epic Functions
// ============================================================================

export interface EpicFilters {
  status?: EpicStatus;
  createdByAgentId?: string;
  leadAgentId?: string;
  search?: string;
  limit?: number;
}

export function getEpics(filters?: EpicFilters): Epic[] {
  let query = "SELECT * FROM epics WHERE 1=1";
  const params: (string | number)[] = [];

  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.createdByAgentId) {
    query += " AND createdByAgentId = ?";
    params.push(filters.createdByAgentId);
  }
  if (filters?.leadAgentId) {
    query += " AND leadAgentId = ?";
    params.push(filters.leadAgentId);
  }
  if (filters?.search) {
    query += " AND (name LIKE ? OR description LIKE ? OR goal LIKE ?)";
    const searchTerm = `%${filters.search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  query += " ORDER BY priority DESC, createdAt DESC";

  if (filters?.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
  }

  return getDb()
    .prepare<EpicRow, (string | number)[]>(query)
    .all(...params)
    .map(rowToEpic);
}

export function getEpicById(id: string): Epic | null {
  const row = getDb()
    .prepare<EpicRow, [string]>("SELECT * FROM epics WHERE id = ?")
    .get(id);
  return row ? rowToEpic(row) : null;
}

export function getEpicByName(name: string): Epic | null {
  const row = getDb()
    .prepare<EpicRow, [string]>("SELECT * FROM epics WHERE name = ?")
    .get(name);
  return row ? rowToEpic(row) : null;
}

export interface CreateEpicData {
  name: string;
  goal: string;
  description?: string;
  prd?: string;
  plan?: string;
  priority?: number;
  tags?: string[];
  createdByAgentId?: string;
  leadAgentId?: string;
  researchDocPath?: string;
  planDocPath?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

export function createEpic(data: CreateEpicData): Epic {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = getDb()
    .prepare<EpicRow, (string | number | null)[]>(
      `INSERT INTO epics (
        id, name, description, goal, prd, plan, status, priority, tags,
        createdByAgentId, leadAgentId, researchDocPath, planDocPath,
        slackChannelId, slackThreadTs, githubRepo, githubMilestone,
        createdAt, lastUpdatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(
      id,
      data.name,
      data.description ?? null,
      data.goal,
      data.prd ?? null,
      data.plan ?? null,
      data.priority ?? 50,
      JSON.stringify(data.tags ?? []),
      data.createdByAgentId ?? null,
      data.leadAgentId ?? null,
      data.researchDocPath ?? null,
      data.planDocPath ?? null,
      data.slackChannelId ?? null,
      data.slackThreadTs ?? null,
      data.githubRepo ?? null,
      data.githubMilestone ?? null,
      now,
      now
    );

  if (!row) {
    throw new Error("Failed to create epic");
  }

  // Create log entry
  try {
    createLogEntry({
      eventType: "task_created", // Reuse existing event type
      agentId: data.createdByAgentId,
      taskId: id,
      newValue: "draft",
      metadata: { type: "epic", name: data.name },
    });
  } catch {}

  return rowToEpic(row);
}

export interface UpdateEpicData {
  name?: string;
  description?: string;
  goal?: string;
  prd?: string;
  plan?: string;
  status?: EpicStatus;
  priority?: number;
  tags?: string[];
  leadAgentId?: string | null;
  researchDocPath?: string;
  planDocPath?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

export function updateEpic(id: string, data: UpdateEpicData): Epic | null {
  const epic = getEpicById(id);
  if (!epic) return null;

  const now = new Date().toISOString();
  const updates: string[] = ["lastUpdatedAt = ?"];
  const params: (string | number | null)[] = [now];

  if (data.name !== undefined) {
    updates.push("name = ?");
    params.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description);
  }
  if (data.goal !== undefined) {
    updates.push("goal = ?");
    params.push(data.goal);
  }
  if (data.prd !== undefined) {
    updates.push("prd = ?");
    params.push(data.prd);
  }
  if (data.plan !== undefined) {
    updates.push("plan = ?");
    params.push(data.plan);
  }
  if (data.status !== undefined) {
    updates.push("status = ?");
    params.push(data.status);

    // Set startedAt when transitioning to active
    if (data.status === "active" && !epic.startedAt) {
      updates.push("startedAt = ?");
      params.push(now);
    }
    // Set completedAt when completing
    if (data.status === "completed" && !epic.completedAt) {
      updates.push("completedAt = ?");
      params.push(now);
    }
  }
  if (data.priority !== undefined) {
    updates.push("priority = ?");
    params.push(data.priority);
  }
  if (data.tags !== undefined) {
    updates.push("tags = ?");
    params.push(JSON.stringify(data.tags));
  }
  if (data.leadAgentId !== undefined) {
    updates.push("leadAgentId = ?");
    params.push(data.leadAgentId);
  }
  if (data.researchDocPath !== undefined) {
    updates.push("researchDocPath = ?");
    params.push(data.researchDocPath);
  }
  if (data.planDocPath !== undefined) {
    updates.push("planDocPath = ?");
    params.push(data.planDocPath);
  }
  if (data.slackChannelId !== undefined) {
    updates.push("slackChannelId = ?");
    params.push(data.slackChannelId);
  }
  if (data.slackThreadTs !== undefined) {
    updates.push("slackThreadTs = ?");
    params.push(data.slackThreadTs);
  }
  if (data.githubRepo !== undefined) {
    updates.push("githubRepo = ?");
    params.push(data.githubRepo);
  }
  if (data.githubMilestone !== undefined) {
    updates.push("githubMilestone = ?");
    params.push(data.githubMilestone);
  }

  params.push(id);

  const row = getDb()
    .prepare<EpicRow, (string | number | null)[]>(
      `UPDATE epics SET ${updates.join(", ")} WHERE id = ? RETURNING *`
    )
    .get(...params);

  return row ? rowToEpic(row) : null;
}

export function deleteEpic(id: string): boolean {
  // First unassign all tasks from this epic
  getDb().prepare("UPDATE agent_tasks SET epicId = NULL WHERE epicId = ?").run(id);

  const result = getDb().prepare("DELETE FROM epics WHERE id = ?").run(id);
  return result.changes > 0;
}

// Get task statistics for an epic
export function getEpicTaskStats(epicId: string): {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  pending: number;
  unassigned: number;
} {
  const row = getDb()
    .prepare<
      {
        total: number;
        completed: number;
        failed: number;
        in_progress: number;
        pending: number;
        unassigned: number;
      },
      [string]
    >(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned
      FROM agent_tasks WHERE epicId = ?`
    )
    .get(epicId);

  return {
    total: row?.total ?? 0,
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    inProgress: row?.in_progress ?? 0,
    pending: row?.pending ?? 0,
    unassigned: row?.unassigned ?? 0,
  };
}

// Get epic with progress calculation
export function getEpicWithProgress(id: string): EpicWithProgress | null {
  const epic = getEpicById(id);
  if (!epic) return null;

  const stats = getEpicTaskStats(id);
  const progress = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  return {
    ...epic,
    taskStats: stats,
    progress,
  };
}

// Get tasks for an epic
export function getTasksByEpicId(epicId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      "SELECT * FROM agent_tasks WHERE epicId = ? ORDER BY priority DESC, createdAt ASC"
    )
    .all(epicId)
    .map(rowToAgentTask);
}

// Assign task to epic
export function assignTaskToEpic(taskId: string, epicId: string): AgentTask | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string]>(
      "UPDATE agent_tasks SET epicId = ?, lastUpdatedAt = ? WHERE id = ? RETURNING *"
    )
    .get(epicId, now, taskId);
  return row ? rowToAgentTask(row) : null;
}

// Unassign task from epic
export function unassignTaskFromEpic(taskId: string): AgentTask | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      "UPDATE agent_tasks SET epicId = NULL, lastUpdatedAt = ? WHERE id = ? RETURNING *"
    )
    .get(now, taskId);
  return row ? rowToAgentTask(row) : null;
}
```

#### 6. Update CreateTaskOptions
**File**: `src/be/db.ts`
**Location**: In CreateTaskOptions interface (~line 1612-1632)

**Add epicId field:**
```typescript
epicId?: string;
```

#### 7. Update createTaskExtended
**File**: `src/be/db.ts`
**Location**: In createTaskExtended function (~line 1634-1694)

**Add epicId to INSERT statement and parameters.**

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Database initializes without errors
- [ ] Can query `epics` table via SQLite CLI
- [ ] Can create a test epic and verify it persists

**Implementation Note**: After completing this phase, verify schema is created correctly before proceeding. Test with: `sqlite3 agent-swarm-db.sqlite ".schema epics"`

---

## Phase 2: MCP Tools

### Overview
Create 7 MCP tools for epic management in a new `src/tools/epics/` directory.

### Changes Required:

#### 1. Create Tools Directory
**Directory**: `src/tools/epics/`

#### 2. create-epic Tool
**File**: `src/tools/epics/create-epic.ts`

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createEpic, getAgentById, getEpicByName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerCreateEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-epic",
    {
      title: "Create Epic",
      description: "Create a new epic (project) to organize related tasks.",
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("Unique name for the epic"),
        goal: z.string().min(1).describe("The goal/objective of this epic"),
        description: z.string().optional().describe("Detailed description"),
        prd: z.string().optional().describe("Product Requirements Document (markdown)"),
        plan: z.string().optional().describe("Implementation plan (markdown)"),
        priority: z.number().int().min(0).max(100).default(50).optional(),
        tags: z.array(z.string()).optional().describe("Tags for filtering"),
        leadAgentId: z.string().uuid().optional().describe("Lead agent for this epic"),
        researchDocPath: z.string().optional().describe("Path to research document"),
        planDocPath: z.string().optional().describe("Path to plan document"),
        slackChannelId: z.string().optional(),
        slackThreadTs: z.string().optional(),
        githubRepo: z.string().optional(),
        githubMilestone: z.string().optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        epic: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: { success: false, message: 'Agent ID not found.' },
        };
      }

      // Check for duplicate name
      const existing = getEpicByName(args.name);
      if (existing) {
        return {
          content: [{ type: "text", text: `Epic "${args.name}" already exists.` }],
          structuredContent: { success: false, message: `Epic "${args.name}" already exists.` },
        };
      }

      // Validate leadAgentId if provided
      if (args.leadAgentId) {
        const agent = getAgentById(args.leadAgentId);
        if (!agent) {
          return {
            content: [{ type: "text", text: `Lead agent not found: ${args.leadAgentId}` }],
            structuredContent: { success: false, message: `Lead agent not found.` },
          };
        }
      }

      try {
        const epic = createEpic({
          ...args,
          createdByAgentId: requestInfo.agentId,
        });

        return {
          content: [{ type: "text", text: `Created epic "${epic.name}" (${epic.id})` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created epic "${epic.name}".`,
            epic,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create epic: ${message}` }],
          structuredContent: { success: false, message: `Failed: ${message}` },
        };
      }
    },
  );
};
```

#### 3. list-epics Tool
**File**: `src/tools/epics/list-epics.ts`

Filters: status, search, leadAgentId, createdByAgentId
Returns: array of epics with progress

#### 4. get-epic-details Tool
**File**: `src/tools/epics/get-epic-details.ts`

- Get by ID or name
- Returns epic with progress, task list, and logs

#### 5. update-epic Tool
**File**: `src/tools/epics/update-epic.ts`

- Update by ID or name
- Authorization: only creator, lead, or swarm lead can update
- Can update status, goal, PRD, plan, etc.

#### 6. delete-epic Tool
**File**: `src/tools/epics/delete-epic.ts`

- Delete by ID or name
- Authorization: only creator or swarm lead can delete
- Tasks are unassigned (not deleted) when epic is deleted

#### 7. assign-task-to-epic Tool
**File**: `src/tools/epics/assign-task-to-epic.ts`

- Assign existing task to an epic
- Validates both task and epic exist

#### 8. unassign-task-from-epic Tool
**File**: `src/tools/epics/unassign-task-from-epic.ts`

- Remove task from epic (keeps task, just clears epicId)

#### 9. Index File
**File**: `src/tools/epics/index.ts`

```typescript
export { registerCreateEpicTool } from "./create-epic";
export { registerListEpicsTool } from "./list-epics";
export { registerGetEpicDetailsTool } from "./get-epic-details";
export { registerUpdateEpicTool } from "./update-epic";
export { registerDeleteEpicTool } from "./delete-epic";
export { registerAssignTaskToEpicTool } from "./assign-task-to-epic";
export { registerUnassignTaskFromEpicTool } from "./unassign-task-from-epic";
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Each tool registers without errors
- [ ] Can create, list, update, delete epics via MCP

**Implementation Note**: Test each tool manually before proceeding.

---

## Phase 3: Server Integration

### Overview
Register MCP tools with the "epics" capability and add HTTP REST endpoints.

### Changes Required:

#### 1. Add Imports
**File**: `src/server.ts`
**Location**: After scheduling imports (~line 29)

```typescript
// Epics capability
import {
  registerCreateEpicTool,
  registerListEpicsTool,
  registerGetEpicDetailsTool,
  registerUpdateEpicTool,
  registerDeleteEpicTool,
  registerAssignTaskToEpicTool,
  registerUnassignTaskFromEpicTool,
} from "./tools/epics";
```

#### 2. Update DEFAULT_CAPABILITIES
**File**: `src/server.ts`
**Location**: Line 45

```typescript
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services,scheduling,epics";
```

#### 3. Register Tools
**File**: `src/server.ts`
**Location**: After scheduling tools (~line 128)

```typescript
// Epics capability - epic/project management
if (hasCapability("epics")) {
  registerCreateEpicTool(server);
  registerListEpicsTool(server);
  registerGetEpicDetailsTool(server);
  registerUpdateEpicTool(server);
  registerDeleteEpicTool(server);
  registerAssignTaskToEpicTool(server);
  registerUnassignTaskFromEpicTool(server);
}
```

#### 4. Add HTTP Endpoints
**File**: `src/http.ts`
**Location**: After scheduled-tasks endpoints (~line 1408)

```typescript
// ============================================================================
// Epic Endpoints
// ============================================================================

// GET /api/epics - List all epics
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  !pathSegments[2]
) {
  const status = queryParams.get("status") as EpicStatus | null;
  const search = queryParams.get("search");
  const leadAgentId = queryParams.get("leadAgentId");
  const epics = getEpics({
    status: status || undefined,
    search: search || undefined,
    leadAgentId: leadAgentId || undefined,
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ epics, total: epics.length }));
  return;
}

// POST /api/epics - Create a new epic
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  !pathSegments[2]
) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  if (!body.name || !body.goal) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: name, goal" }));
    return;
  }

  try {
    const epic = createEpic({
      ...body,
      createdByAgentId: myAgentId || undefined,
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(epic));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to create epic" }));
  }
  return;
}

// GET /api/epics/:id - Get single epic with progress and tasks
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  pathSegments[2] &&
  !pathSegments[3]
) {
  const epicId = pathSegments[2];
  const epic = getEpicWithProgress(epicId);

  if (!epic) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Epic not found" }));
    return;
  }

  const tasks = getTasksByEpicId(epicId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ...epic, tasks }));
  return;
}

// PUT /api/epics/:id - Update an epic
if (
  req.method === "PUT" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  pathSegments[2] &&
  !pathSegments[3]
) {
  const epicId = pathSegments[2];
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const epic = updateEpic(epicId, body);
  if (!epic) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Epic not found" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(epic));
  return;
}

// DELETE /api/epics/:id - Delete an epic
if (
  req.method === "DELETE" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  pathSegments[2] &&
  !pathSegments[3]
) {
  const epicId = pathSegments[2];
  const deleted = deleteEpic(epicId);

  if (!deleted) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Epic not found" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true }));
  return;
}

// POST /api/epics/:id/tasks - Add task to epic (create new or assign existing)
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "epics" &&
  pathSegments[2] &&
  pathSegments[3] === "tasks"
) {
  const epicId = pathSegments[2];
  const epic = getEpicById(epicId);

  if (!epic) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Epic not found" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  // If taskId provided, assign existing task
  if (body.taskId) {
    const task = assignTaskToEpic(body.taskId, epicId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
    return;
  }

  // Otherwise create new task in this epic
  if (!body.task) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing task description or taskId" }));
    return;
  }

  try {
    const task = createTaskExtended(body.task, {
      ...body,
      epicId,
      creatorAgentId: myAgentId || undefined,
      tags: [...(body.tags || []), `epic:${epic.name}`],
      source: "api",
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to create task" }));
  }
  return;
}
```

#### 5. Add Imports to http.ts
**File**: `src/http.ts`
**Location**: Top of file with other imports

```typescript
import type { EpicStatus } from "./types";
import {
  getEpics,
  getEpicById,
  getEpicWithProgress,
  getTasksByEpicId,
  createEpic,
  updateEpic,
  deleteEpic,
  assignTaskToEpic,
} from "./be/db";
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Tools available via MCP when capability enabled
- [ ] HTTP endpoints respond correctly
- [ ] Can create epic via API, add tasks, view progress

---

## Phase 4: Integration with send-task

### Overview
Allow creating tasks directly associated with an epic via the send-task tool.

### Changes Required:

#### 1. Update send-task Input Schema
**File**: `src/tools/send-task.ts`
**Location**: In inputSchema (~line 15-41)

Add:
```typescript
epicId: z.string().uuid().optional().describe("Epic to associate this task with."),
```

#### 2. Update send-task Handler
**File**: `src/tools/send-task.ts`
**Location**: In handler, add epicId to createTaskExtended call

```typescript
// Validate epicId if provided
if (epicId) {
  const epic = getEpicById(epicId);
  if (!epic) {
    return {
      content: [{ type: "text", text: `Epic not found: ${epicId}` }],
      structuredContent: { success: false, message: `Epic not found.` },
    };
  }
}

// In createTaskExtended call:
const task = createTaskExtended(taskDescription, {
  ...existingOptions,
  epicId,
  tags: epicId ? [...(tags || []), `epic:${epicName}`] : tags,
});
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Can create task with epicId via send-task
- [ ] Task appears in epic's task list

---

## Phase 5: Testing & Documentation

### Overview
Add tests and update documentation.

### Changes Required:

#### 1. Unit Tests
**File**: `src/tests/epics.test.ts`

Test cases:
- Create epic with required fields only
- Create epic with all fields
- List epics with filters
- Get epic with progress calculation
- Update epic status transitions
- Delete epic (tasks unassigned)
- Assign/unassign task to epic

#### 2. Integration Tests
**File**: `src/tests/epics-api.test.ts`

Test HTTP endpoints:
- GET /api/epics
- POST /api/epics
- GET /api/epics/:id
- PUT /api/epics/:id
- DELETE /api/epics/:id
- POST /api/epics/:id/tasks

#### 3. Update MCP.md
**File**: `MCP.md`

Add section documenting new tools:
- `create-epic`
- `list-epics`
- `get-epic-details`
- `update-epic`
- `delete-epic`
- `assign-task-to-epic`
- `unassign-task-from-epic`

Include usage examples.

#### 4. Update README.md
**File**: `README.md`

Add brief mention of epics capability in features section.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test` passes
- [ ] `bun run lint` passes

#### Manual Verification:
- [ ] Documentation is accurate
- [ ] Examples work as documented

---

## Testing Strategy

### Unit Tests
- Epic CRUD functions in db.ts
- Progress calculation
- Status transitions (draft -> active -> completed)

### Integration Tests
- End-to-end: create epic -> add tasks -> complete tasks -> verify progress
- MCP tool validation
- HTTP API endpoints

### Manual Testing Steps
1. Create an epic with name and goal
2. Add PRD and plan
3. Create tasks within the epic
4. Assign existing tasks to epic
5. Complete some tasks, verify progress updates
6. Update epic status to active
7. Complete all tasks, verify 100% progress
8. Mark epic as completed
9. Delete epic, verify tasks are unassigned

---

## References

- Research document: `/workspace/shared/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-01-16-epics-feature-research.md`
- Scheduled tasks implementation (similar pattern): `thoughts/shared/plans/2026-01-15-scheduled-tasks-implementation.md`
- Existing task management: `src/be/db.ts`
- Tool registration: `src/tools/utils.ts`
- Type definitions: `src/types.ts`
