# Inverse Teleport Implementation Plan

## Overview

Implement "teleport-out" feature: a local Claude Code session can transfer its context to a distributed worker agent to continue the work. This is the inverse of Claude Code Web's teleport feature (which brings web sessions to local CLI).

## Current State Analysis

The Agent Swarm MCP currently provides:
- HTTP server with REST API and MCP transport (`src/http.ts`)
- SQLite database with `agents`, `agent_tasks`, `agent_log`, `channels`, `services`, `session_logs` tables (`src/be/db.ts`)
- MCP tools for agent coordination (`src/tools/*.ts`)
- CLI runners for lead/worker agents (`src/commands/*.ts`)
- Hook system for session lifecycle events (`src/hooks/hook.ts`)
- Capability-based feature flags (`src/server.ts:27-36`)
- Runner-level polling endpoint (`GET /api/poll` in `src/http.ts:282-379`)

**What's Missing:**
- No mechanism for local sessions to export context
- Tasks are simple text strings, not rich context packages
- Workers have no way to receive session context beyond task descriptions
- No teleport request tracking or lifecycle management

### Key Discoveries:
- Tasks flow through `send-task` tool with simple string payload (`src/tools/send-task.ts`)
- Workers poll for tasks via `poll-task` with 60-second timeout (`src/tools/poll-task.ts`)
- Tools return dual `content`/`structuredContent` format (`src/tools/poll-task.ts:131-148`)
- Tools use `createToolRegistrar()` helper with `title` property (`src/tools/utils.ts:86-115`)
- Hook system can provide guidance to workers on session start (`src/hooks/hook.ts`)
- Database uses transactions for atomic operations (`src/be/db.ts`)
- HTTP server uses Node.js http patterns, not Bun.serve (`src/http.ts`)

## Desired End State

After implementation:
1. Local Claude Code session calls `teleport-out` with summary and context
2. Teleport request is stored in database with rich context package
3. Worker polls for teleports via `/api/poll` or `poll-teleport` MCP tool and claims one atomically
4. Worker continues the work with full context understanding
5. Teleport lifecycle is tracked (pending → claimed → started → completed/failed)
6. Log events track teleport lifecycle for auditing

### Verification:
- Local session can call `teleport-out` and receive teleport ID
- Worker receives rich context package via `poll-teleport` or `/api/poll`
- Teleport status visible in dashboard/API
- Worker completes task with proper tracking
- Log events appear in `/api/logs`

## What We're NOT Doing

- **Full conversation history transfer** - Summary + context is sufficient
- **Claude CLI session file sync** - Workers are distributed (no shared filesystem)
- **Native `--resume` integration** - Would require session file transfer
- **Multi-teleport fan-out** - One teleport goes to one worker
- **Teleport cancellation UI** - Can be added later
- **File content sync** - Workers must have access to the same repo/codebase
- **Dashboard UI for teleports** - Can be added in future iteration

## Implementation Approach

Add a new `teleport_requests` table with rich context schema. Create 5 new MCP tools for the teleport lifecycle. Add `teleport` capability flag. Integrate with runner-level `/api/poll` endpoint. Workers check for teleports before regular tasks. Context is provided as initial prompt material.

---

## Phase 1: Database Schema Updates

### Overview
Add teleport request storage and tracking.

### Changes Required:

#### 1. Types (`src/types.ts`)

Add teleport request schema and log event types. Add after `SessionLogSchema` (around line 187):

```typescript
// Teleport Request Types
export const TeleportRequestStatusSchema = z.enum([
  "pending",    // Created, waiting for worker
  "claimed",    // Worker claimed it
  "started",    // Worker began work
  "completed",  // Work finished successfully
  "failed"      // Work failed
]);
export type TeleportRequestStatus = z.infer<typeof TeleportRequestStatusSchema>;

export const RelevantFileSchema = z.object({
  path: z.string(),
  summary: z.string().optional(),
  content: z.string().optional(),
});
export type RelevantFile = z.infer<typeof RelevantFileSchema>;

export const TeleportRequestSchema = z.object({
  id: z.string().uuid(),
  sourceAgentId: z.string().optional(),      // Who sent it (may be null for non-swarm sessions)
  targetAgentId: z.string().optional(),      // Specific worker or null for any
  status: TeleportRequestStatusSchema,

  // Context Package
  summary: z.string().min(1),                // Required: AI summary of session
  currentGoal: z.string().optional(),        // What to accomplish
  relevantFiles: z.string().optional(),      // JSON array of RelevantFile
  contextNotes: z.string().optional(),       // Additional context
  workingDirectory: z.string().optional(),   // CWD of original session
  projectPath: z.string().optional(),        // Project root

  // Timestamps
  createdAt: z.string(),
  claimedAt: z.string().optional(),
  claimedBy: z.string().optional(),          // Agent ID that claimed it
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),

  // Result
  resultTaskId: z.string().optional(),       // Links to agent_tasks when work begins
  output: z.string().optional(),
  failureReason: z.string().optional(),
});
export type TeleportRequest = z.infer<typeof TeleportRequestSchema>;
```

Also update `AgentLogEventTypeSchema` to add teleport events (around line 141):

```typescript
export const AgentLogEventTypeSchema = z.enum([
  // ... existing events
  "agent_joined",
  "agent_status_change",
  "agent_left",
  "task_created",
  "task_status_change",
  "task_progress",
  "task_offered",
  "task_accepted",
  "task_rejected",
  "task_claimed",
  "task_released",
  "channel_message",
  "service_registered",
  "service_unregistered",
  "service_status_change",
  // NEW teleport events
  "teleport_created",
  "teleport_claimed",
  "teleport_started",
  "teleport_completed",
  "teleport_failed",
]);
```

#### 2. Database Schema (`src/be/db.ts`)

Add type imports at top of file:

```typescript
import type {
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentStatus,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentWithTasks,
  Channel,
  ChannelMessage,
  ChannelType,
  Service,
  ServiceStatus,
  SessionLog,
  TeleportRequest,
  TeleportRequestStatus,  // ADD THIS
} from "../types";
```

Add table creation after `session_logs` table (around line 170):

```sql
-- Teleport requests table
CREATE TABLE IF NOT EXISTS teleport_requests (
  id TEXT PRIMARY KEY,
  sourceAgentId TEXT,
  targetAgentId TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'started', 'completed', 'failed')),

  -- Context Package
  summary TEXT NOT NULL,
  currentGoal TEXT,
  relevantFiles TEXT,
  contextNotes TEXT,
  workingDirectory TEXT,
  projectPath TEXT,

  -- Timestamps
  createdAt TEXT NOT NULL,
  claimedAt TEXT,
  claimedBy TEXT,
  startedAt TEXT,
  finishedAt TEXT,

  -- Result
  resultTaskId TEXT,
  output TEXT,
  failureReason TEXT,

  FOREIGN KEY (sourceAgentId) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (targetAgentId) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (claimedBy) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (resultTaskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_teleport_requests_status ON teleport_requests(status);
CREATE INDEX IF NOT EXISTS idx_teleport_requests_targetAgentId ON teleport_requests(targetAgentId);
CREATE INDEX IF NOT EXISTS idx_teleport_requests_claimedBy ON teleport_requests(claimedBy);
```

#### 3. Database Functions (`src/be/db.ts`)

Add type and CRUD functions at end of file (after session log functions):

```typescript
// ============================================================================
// Teleport Request Operations
// ============================================================================

type TeleportRequestRow = {
  id: string;
  sourceAgentId: string | null;
  targetAgentId: string | null;
  status: TeleportRequestStatus;
  summary: string;
  currentGoal: string | null;
  relevantFiles: string | null;
  contextNotes: string | null;
  workingDirectory: string | null;
  projectPath: string | null;
  createdAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  resultTaskId: string | null;
  output: string | null;
  failureReason: string | null;
};

function rowToTeleportRequest(row: TeleportRequestRow): TeleportRequest {
  return {
    id: row.id,
    sourceAgentId: row.sourceAgentId ?? undefined,
    targetAgentId: row.targetAgentId ?? undefined,
    status: row.status,
    summary: row.summary,
    currentGoal: row.currentGoal ?? undefined,
    relevantFiles: row.relevantFiles ?? undefined,
    contextNotes: row.contextNotes ?? undefined,
    workingDirectory: row.workingDirectory ?? undefined,
    projectPath: row.projectPath ?? undefined,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt ?? undefined,
    claimedBy: row.claimedBy ?? undefined,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    resultTaskId: row.resultTaskId ?? undefined,
    output: row.output ?? undefined,
    failureReason: row.failureReason ?? undefined,
  };
}

export function createTeleportRequest(data: {
  summary: string;
  currentGoal?: string;
  relevantFiles?: string;
  contextNotes?: string;
  workingDirectory?: string;
  projectPath?: string;
  sourceAgentId?: string;
  targetAgentId?: string;
}): TeleportRequest {
  const id = crypto.randomUUID();
  const row = getDb()
    .prepare<TeleportRequestRow, [string, string | null, string | null, string, string | null, string | null, string | null, string | null, string | null]>(
      `INSERT INTO teleport_requests
       (id, sourceAgentId, targetAgentId, status, summary, currentGoal, relevantFiles, contextNotes, workingDirectory, projectPath, createdAt)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`
    )
    .get(
      id,
      data.sourceAgentId ?? null,
      data.targetAgentId ?? null,
      data.summary,
      data.currentGoal ?? null,
      data.relevantFiles ?? null,
      data.contextNotes ?? null,
      data.workingDirectory ?? null,
      data.projectPath ?? null
    );
  if (!row) throw new Error("Failed to create teleport request");

  try {
    createLogEntry({
      eventType: "teleport_created",
      agentId: data.sourceAgentId,
      metadata: { teleportId: id, targetAgentId: data.targetAgentId },
    });
  } catch {}

  return rowToTeleportRequest(row);
}

export function getTeleportRequestById(id: string): TeleportRequest | null {
  const row = getDb()
    .prepare<TeleportRequestRow, [string]>("SELECT * FROM teleport_requests WHERE id = ?")
    .get(id);
  return row ? rowToTeleportRequest(row) : null;
}

export function getPendingTeleportForAgent(agentId: string): TeleportRequest | null {
  // Find pending teleport targeted to this agent OR any unassigned pending teleport
  const row = getDb()
    .prepare<TeleportRequestRow, [string]>(
      `SELECT * FROM teleport_requests
       WHERE status = 'pending'
       AND (targetAgentId = ? OR targetAgentId IS NULL)
       ORDER BY createdAt ASC
       LIMIT 1`
    )
    .get(agentId);
  return row ? rowToTeleportRequest(row) : null;
}

export function claimTeleportRequest(teleportId: string, agentId: string): TeleportRequest | null {
  const row = getDb()
    .prepare<TeleportRequestRow, [string, string]>(
      `UPDATE teleport_requests
       SET status = 'claimed', claimedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), claimedBy = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`
    )
    .get(agentId, teleportId);

  if (row) {
    try {
      createLogEntry({
        eventType: "teleport_claimed",
        agentId,
        metadata: { teleportId },
      });
    } catch {}
  }

  return row ? rowToTeleportRequest(row) : null;
}

export function startTeleportRequest(teleportId: string, taskId?: string): TeleportRequest | null {
  const teleport = getTeleportRequestById(teleportId);
  const row = getDb()
    .prepare<TeleportRequestRow, [string | null, string]>(
      `UPDATE teleport_requests
       SET status = 'started', startedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), resultTaskId = ?
       WHERE id = ? AND status = 'claimed'
       RETURNING *`
    )
    .get(taskId ?? null, teleportId);

  if (row) {
    try {
      createLogEntry({
        eventType: "teleport_started",
        agentId: teleport?.claimedBy,
        metadata: { teleportId, taskId },
      });
    } catch {}
  }

  return row ? rowToTeleportRequest(row) : null;
}

export function completeTeleportRequest(teleportId: string, output?: string): TeleportRequest | null {
  const teleport = getTeleportRequestById(teleportId);
  const row = getDb()
    .prepare<TeleportRequestRow, [string | null, string]>(
      `UPDATE teleport_requests
       SET status = 'completed', finishedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), output = ?
       WHERE id = ? AND status IN ('claimed', 'started')
       RETURNING *`
    )
    .get(output ?? null, teleportId);

  if (row) {
    try {
      createLogEntry({
        eventType: "teleport_completed",
        agentId: teleport?.claimedBy,
        metadata: { teleportId },
      });
    } catch {}
  }

  return row ? rowToTeleportRequest(row) : null;
}

export function failTeleportRequest(teleportId: string, failureReason: string): TeleportRequest | null {
  const teleport = getTeleportRequestById(teleportId);
  const row = getDb()
    .prepare<TeleportRequestRow, [string, string]>(
      `UPDATE teleport_requests
       SET status = 'failed', finishedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), failureReason = ?
       WHERE id = ? AND status IN ('claimed', 'started')
       RETURNING *`
    )
    .get(failureReason, teleportId);

  if (row) {
    try {
      createLogEntry({
        eventType: "teleport_failed",
        agentId: teleport?.claimedBy,
        metadata: { teleportId, failureReason },
      });
    } catch {}
  }

  return row ? rowToTeleportRequest(row) : null;
}

export function getAllTeleportRequests(options?: { status?: TeleportRequestStatus }): TeleportRequest[] {
  if (options?.status) {
    return getDb()
      .prepare<TeleportRequestRow, [string]>(
        "SELECT * FROM teleport_requests WHERE status = ? ORDER BY createdAt DESC"
      )
      .all(options.status)
      .map(rowToTeleportRequest);
  }
  return getDb()
    .prepare<TeleportRequestRow, []>("SELECT * FROM teleport_requests ORDER BY createdAt DESC")
    .all()
    .map(rowToTeleportRequest);
}

export function getPendingTeleportCount(): number {
  const result = getDb()
    .prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM teleport_requests WHERE status = 'pending'"
    )
    .get();
  return result?.count ?? 0;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Server starts without errors: `bun run dev:http`
- [ ] Database table created (check with sqlite3 CLI)

#### Manual Verification:
- [ ] Can manually insert/query teleport_requests table

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the database changes work correctly before proceeding to the next phase.

---

## Phase 2: Teleport MCP Tools

### Overview
Add 5 new MCP tools for teleport lifecycle management.

### Changes Required:

#### 1. teleport-out Tool (`src/tools/teleport-out.ts`)

**File**: `src/tools/teleport-out.ts` (NEW)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createTeleportRequest,
  getAgentById,
  getAllAgents,
} from "@/be/db";
import { createToolRegistrar, type RequestInfo } from "@/tools/utils";
import { RelevantFileSchema } from "@/types";

const inputSchema = z.object({
  summary: z.string().min(1).describe("AI-generated summary of current session and work accomplished"),
  currentGoal: z.string().optional().describe("What you're trying to accomplish"),
  relevantFiles: z.array(RelevantFileSchema).optional().describe("Files relevant to the task"),
  contextNotes: z.string().optional().describe("Additional context for the receiving agent"),
  targetAgentId: z.string().uuid().optional().describe("Specific worker agent ID, or omit for any available worker"),
  workingDirectory: z.string().optional().describe("Current working directory"),
  projectPath: z.string().optional().describe("Project root path"),
});

const outputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  teleportId: z.string().uuid().optional(),
  message: z.string(),
  targetAgent: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }).optional(),
});

export const registerTeleportOutTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "teleport-out",
    {
      title: "Teleport session to worker",
      description: "Transfer current session context to a worker agent to continue the work",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      // Validate target agent if specified
      if (args.targetAgentId) {
        const targetAgent = getAgentById(args.targetAgentId);
        if (!targetAgent) {
          return {
            content: [{ type: "text", text: `Target agent ${args.targetAgentId} not found` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Target agent ${args.targetAgentId} not found`,
            },
          };
        }
        if (targetAgent.isLead) {
          return {
            content: [{ type: "text", text: "Cannot teleport to lead agent. Choose a worker agent." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Cannot teleport to lead agent. Choose a worker agent.",
            },
          };
        }
        if (targetAgent.status === "offline") {
          return {
            content: [{ type: "text", text: `Target agent "${targetAgent.name}" is offline` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Target agent "${targetAgent.name}" is offline`,
            },
          };
        }
      } else {
        // Check if any workers are available
        const workers = getAllAgents().filter(a => !a.isLead && a.status !== "offline");
        if (workers.length === 0) {
          return {
            content: [{ type: "text", text: "No worker agents available to receive teleport" }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "No worker agents available to receive teleport",
            },
          };
        }
      }

      // Serialize relevantFiles if provided
      const relevantFilesJson = args.relevantFiles
        ? JSON.stringify(args.relevantFiles)
        : undefined;

      // Create teleport request
      const teleport = createTeleportRequest({
        summary: args.summary,
        currentGoal: args.currentGoal,
        relevantFiles: relevantFilesJson,
        contextNotes: args.contextNotes,
        workingDirectory: args.workingDirectory,
        projectPath: args.projectPath,
        sourceAgentId: requestInfo.agentId,
        targetAgentId: args.targetAgentId,
      });

      const targetAgent = args.targetAgentId
        ? getAgentById(args.targetAgentId)
        : undefined;

      const message = args.targetAgentId
        ? `Session teleported to ${targetAgent?.name}. Teleport ID: ${teleport.id}`
        : `Session teleported to swarm. Any available worker will pick it up. Teleport ID: ${teleport.id}`;

      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          teleportId: teleport.id,
          message,
          targetAgent: targetAgent
            ? { id: targetAgent.id, name: targetAgent.name, status: targetAgent.status }
            : undefined,
        },
      };
    }
  );
};
```

#### 2. poll-teleport Tool (`src/tools/poll-teleport.ts`)

**File**: `src/tools/poll-teleport.ts` (NEW)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getPendingTeleportForAgent,
  claimTeleportRequest,
  getAgentById,
  updateAgentStatus,
  getDb,
} from "@/be/db";
import { createToolRegistrar, type RequestInfo } from "@/tools/utils";
import { TeleportRequestSchema } from "@/types";

const inputSchema = z.object({});

const outputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  message: z.string(),
  teleport: TeleportRequestSchema.optional(),
  waitedForSeconds: z.number(),
});

const POLL_TIMEOUT_MS = 30_000; // 30 seconds (shorter than poll-task)
const POLL_INTERVAL_MS = 2_000; // 2 seconds

export const registerPollTeleportTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "poll-teleport",
    {
      title: "Poll for teleport requests",
      description: "Poll for pending teleport requests to continue another session's work",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      const agentId = requestInfo.agentId;
      if (!agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required. Set X-Agent-ID header." }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required. Set X-Agent-ID header.",
            waitedForSeconds: 0,
          },
        };
      }

      const agent = getAgentById(agentId);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Agent ${agentId} not found` }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Agent ${agentId} not found`,
            waitedForSeconds: 0,
          },
        };
      }

      if (agent.isLead) {
        return {
          content: [{ type: "text", text: "Lead agents cannot poll for teleports" }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "Lead agents cannot poll for teleports",
            waitedForSeconds: 0,
          },
        };
      }

      const startTime = Date.now();
      let elapsedMs = 0;

      while (elapsedMs < POLL_TIMEOUT_MS) {
        // Try to claim a pending teleport atomically using transaction
        const result = getDb().transaction(() => {
          const pending = getPendingTeleportForAgent(agentId);
          if (!pending) return null;

          const claimed = claimTeleportRequest(pending.id, agentId);
          return claimed;
        })();

        if (result) {
          // Update agent status to busy
          updateAgentStatus(agentId, "busy");

          const message = `Claimed teleport ${result.id}. Context follows.`;
          return {
            content: [{ type: "text", text: message }],
            structuredContent: {
              yourAgentId: agentId,
              success: true,
              message,
              teleport: result,
              waitedForSeconds: Math.round(elapsedMs / 1000),
            },
          };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        elapsedMs = Date.now() - startTime;
      }

      return {
        content: [{ type: "text", text: "No teleport requests available. Try poll-task for regular tasks." }],
        structuredContent: {
          yourAgentId: agentId,
          success: false,
          message: "No teleport requests available. Try poll-task for regular tasks.",
          waitedForSeconds: Math.round(POLL_TIMEOUT_MS / 1000),
        },
      };
    }
  );
};
```

#### 3. start-teleport Tool (`src/tools/start-teleport.ts`)

**File**: `src/tools/start-teleport.ts` (NEW)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  startTeleportRequest,
  getTeleportRequestById,
  createTask,
} from "@/be/db";
import { createToolRegistrar, type RequestInfo } from "@/tools/utils";

const inputSchema = z.object({
  teleportId: z.string().uuid().describe("The teleport request ID to start working on"),
});

const outputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  message: z.string(),
  taskId: z.string().uuid().optional(),
});

export const registerStartTeleportTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "start-teleport",
    {
      title: "Start teleport work",
      description: "Mark a teleport request as started and create a tracking task",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      const agentId = requestInfo.agentId;
      if (!agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required" }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required",
          },
        };
      }

      const teleport = getTeleportRequestById(args.teleportId);
      if (!teleport) {
        return {
          content: [{ type: "text", text: `Teleport ${args.teleportId} not found` }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Teleport ${args.teleportId} not found`,
          },
        };
      }

      if (teleport.claimedBy !== agentId) {
        return {
          content: [{ type: "text", text: "You did not claim this teleport" }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "You did not claim this teleport",
          },
        };
      }

      if (teleport.status !== "claimed") {
        return {
          content: [{ type: "text", text: `Teleport is ${teleport.status}, not claimed` }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Teleport is ${teleport.status}, not claimed`,
          },
        };
      }

      // Create a tracking task with teleport context
      const taskDescription = teleport.currentGoal
        ? `[Teleport] ${teleport.currentGoal}`
        : `[Teleport] Continue: ${teleport.summary.slice(0, 100)}...`;

      const task = createTask(agentId, taskDescription, {
        source: "mcp",
      });

      // Mark teleport as started
      const started = startTeleportRequest(args.teleportId, task.id);

      if (!started) {
        return {
          content: [{ type: "text", text: "Failed to start teleport" }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "Failed to start teleport",
          },
        };
      }

      const message = `Teleport started. Task ${task.id} created for tracking.`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          yourAgentId: agentId,
          success: true,
          message,
          taskId: task.id,
        },
      };
    }
  );
};
```

#### 4. complete-teleport Tool (`src/tools/complete-teleport.ts`)

**File**: `src/tools/complete-teleport.ts` (NEW)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTeleportRequest,
  failTeleportRequest,
  getTeleportRequestById,
  updateAgentStatus,
  completeTask,
  failTask,
} from "@/be/db";
import { createToolRegistrar, type RequestInfo } from "@/tools/utils";

const inputSchema = z.object({
  teleportId: z.string().uuid().describe("The teleport request ID"),
  status: z.enum(["completed", "failed"]).describe("Final status"),
  output: z.string().optional().describe("Result/output of the work (for completed)"),
  failureReason: z.string().optional().describe("Reason for failure (for failed)"),
});

const outputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  message: z.string(),
});

export const registerCompleteTeleportTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "complete-teleport",
    {
      title: "Complete teleport work",
      description: "Mark a teleport request as completed or failed",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      const agentId = requestInfo.agentId;
      if (!agentId) {
        return {
          content: [{ type: "text", text: "Agent ID required" }],
          structuredContent: {
            yourAgentId: undefined,
            success: false,
            message: "Agent ID required",
          },
        };
      }

      const teleport = getTeleportRequestById(args.teleportId);
      if (!teleport) {
        return {
          content: [{ type: "text", text: `Teleport ${args.teleportId} not found` }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Teleport ${args.teleportId} not found`,
          },
        };
      }

      if (teleport.claimedBy !== agentId) {
        return {
          content: [{ type: "text", text: "You did not claim this teleport" }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "You did not claim this teleport",
          },
        };
      }

      let result;
      if (args.status === "completed") {
        result = completeTeleportRequest(args.teleportId, args.output);
        // Also complete the tracking task if it exists
        if (teleport.resultTaskId) {
          completeTask(teleport.resultTaskId, args.output);
        }
      } else {
        result = failTeleportRequest(args.teleportId, args.failureReason || "Unknown error");
        if (teleport.resultTaskId) {
          failTask(teleport.resultTaskId, args.failureReason || "Unknown error");
        }
      }

      if (!result) {
        return {
          content: [{ type: "text", text: "Failed to update teleport status" }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "Failed to update teleport status",
          },
        };
      }

      // Set agent back to idle
      updateAgentStatus(agentId, "idle");

      const message = `Teleport ${args.status}`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          yourAgentId: agentId,
          success: true,
          message,
        },
      };
    }
  );
};
```

#### 5. get-teleport-details Tool (`src/tools/get-teleport-details.ts`)

**File**: `src/tools/get-teleport-details.ts` (NEW)

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getTeleportRequestById, getAgentById } from "@/be/db";
import { createToolRegistrar, type RequestInfo } from "@/tools/utils";
import { TeleportRequestSchema } from "@/types";

const inputSchema = z.object({
  teleportId: z.string().uuid().describe("The teleport request ID to get details for"),
});

const outputSchema = z.object({
  yourAgentId: z.string().optional(),
  success: z.boolean(),
  message: z.string(),
  teleport: TeleportRequestSchema.optional(),
  sourceAgent: z.object({
    id: z.string(),
    name: z.string(),
  }).optional(),
  claimedByAgent: z.object({
    id: z.string(),
    name: z.string(),
  }).optional(),
});

export const registerGetTeleportDetailsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-teleport-details",
    {
      title: "Get teleport details",
      description: "Get details of a teleport request",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      const teleport = getTeleportRequestById(args.teleportId);

      if (!teleport) {
        return {
          content: [{ type: "text", text: `Teleport ${args.teleportId} not found` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Teleport ${args.teleportId} not found`,
          },
        };
      }

      const sourceAgent = teleport.sourceAgentId
        ? getAgentById(teleport.sourceAgentId)
        : undefined;

      const claimedByAgent = teleport.claimedBy
        ? getAgentById(teleport.claimedBy)
        : undefined;

      const message = `Teleport ${teleport.id} is ${teleport.status}`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message,
          teleport,
          sourceAgent: sourceAgent
            ? { id: sourceAgent.id, name: sourceAgent.name }
            : undefined,
          claimedByAgent: claimedByAgent
            ? { id: claimedByAgent.id, name: claimedByAgent.name }
            : undefined,
        },
      };
    }
  );
};
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Server starts: `bun run dev:http`

#### Manual Verification:
- [ ] Can call `teleport-out` and receive teleport ID
- [ ] Can call `poll-teleport` and receive pending teleport
- [ ] Teleport lifecycle flows correctly

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to the next phase.

---

## Phase 3: Register Tools in Server

### Overview
Wire up the new teleport tools in the MCP server with capability flag.

### Changes Required:

#### 1. Update Server (`src/server.ts`)

Add imports after existing tool imports:

```typescript
import { registerTeleportOutTool } from "./tools/teleport-out";
import { registerPollTeleportTool } from "./tools/poll-teleport";
import { registerStartTeleportTool } from "./tools/start-teleport";
import { registerCompleteTeleportTool } from "./tools/complete-teleport";
import { registerGetTeleportDetailsTool } from "./tools/get-teleport-details";
```

Update DEFAULT_CAPABILITIES (line 27):

```typescript
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services,teleport";
```

Add capability-gated registration after existing capability blocks (around line 94):

```typescript
if (hasCapability("teleport")) {
  registerTeleportOutTool(server);
  registerPollTeleportTool(server);
  registerStartTeleportTool(server);
  registerCompleteTeleportTool(server);
  registerGetTeleportDetailsTool(server);
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Server starts and lists teleport tools

#### Manual Verification:
- [ ] Tools appear in MCP tool list when capability enabled
- [ ] Tools do NOT appear when capability disabled

---

## Phase 4: Runner-Level Polling Integration

### Overview
Add teleport detection to the runner-level `/api/poll` endpoint so runners can detect teleports without using MCP tools.

### Changes Required:

#### 1. Update HTTP Server (`src/http.ts`)

Add import at top:

```typescript
import { getPendingTeleportForAgent } from "./be/db";
```

Update `GET /api/poll` handler (around line 294) to check for teleports FIRST:

```typescript
// GET /api/poll - Poll for triggers (tasks, mentions, etc.)
if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "poll") {
  // ... existing agent validation ...

  // Use transaction for consistent reads across all trigger checks
  const result = getDb().transaction(() => {
    const agent = getAgentById(myAgentId);
    if (!agent) {
      return { error: "Agent not found", status: 404 };
    }

    // === TELEPORT CHECK (highest priority for workers) ===
    if (!agent.isLead) {
      const pendingTeleport = getPendingTeleportForAgent(myAgentId);
      if (pendingTeleport) {
        return {
          trigger: {
            type: "teleport_pending",
            teleportId: pendingTeleport.id,
            teleport: pendingTeleport,
          },
        };
      }
    }

    // Check for offered tasks (existing code)
    const offeredTasks = getOfferedTasksForAgent(myAgentId);
    // ... rest of existing code ...
  })();
  // ... rest of handler ...
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Server starts without errors

#### Manual Verification:
- [ ] `/api/poll` returns `teleport_pending` trigger when teleport exists
- [ ] Teleport trigger has higher priority than offered tasks for workers

---

## Phase 5: Worker Hook Integration

### Overview
Update worker hooks to inform about teleport availability.

### Changes Required:

#### 1. Update Hook Messages (`src/hooks/hook.ts`)

Add teleport info to `InboxSummary` type and `getInboxSummary()` in db.ts first, then update hook.

In `src/be/db.ts`, update `InboxSummary` interface (around line 1609):

```typescript
export interface InboxSummary {
  unreadCount: number;
  mentionsCount: number;
  offeredTasksCount: number;
  poolTasksCount: number;
  inProgressCount: number;
  pendingTeleportsCount: number;  // ADD THIS
  recentMentions: MentionPreview[];
}
```

Update `getInboxSummary()` function to include teleport count:

```typescript
// Add after poolResult (around line 1659)
const teleportResult = db
  .prepare<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM teleport_requests WHERE status = 'pending' AND (targetAgentId = ? OR targetAgentId IS NULL)"
  )
  .get(agentId);

// Include in return object
return {
  // ... existing fields ...
  pendingTeleportsCount: teleportResult?.count ?? 0,
  // ...
};
```

Update `formatSystemTray()` in `src/hooks/hook.ts` to show teleport count in status display.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Hook message includes teleport info

#### Manual Verification:
- [ ] Worker sees teleport count in system tray on session start

---

## Phase 6: HTTP API Endpoints

### Overview
Add REST endpoints for dashboard visibility.

### Changes Required:

#### 1. Update HTTP Server (`src/http.ts`)

Add imports:

```typescript
import {
  // ... existing imports ...
  getAllTeleportRequests,
  getTeleportRequestById,
  getPendingTeleportCount,
} from "./be/db";
import type { TeleportRequestStatus } from "./types";
```

Add teleport endpoints after existing API routes (around line 675):

```typescript
// GET /api/teleports - List teleport requests
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "teleports" &&
  !pathSegments[2]
) {
  const status = queryParams.get("status") as TeleportRequestStatus | null;
  const teleports = getAllTeleportRequests(status ? { status } : undefined);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ teleports }));
  return;
}

// GET /api/teleports/:id - Get teleport details
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "teleports" &&
  pathSegments[2]
) {
  const teleportId = pathSegments[2];
  const teleport = getTeleportRequestById(teleportId);

  if (!teleport) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Teleport not found" }));
    return;
  }

  const sourceAgent = teleport.sourceAgentId
    ? getAgentById(teleport.sourceAgentId)
    : undefined;
  const claimedByAgent = teleport.claimedBy
    ? getAgentById(teleport.claimedBy)
    : undefined;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    teleport,
    sourceAgent,
    claimedByAgent,
  }));
  return;
}
```

Update `/api/stats` endpoint to include teleport counts (around line 631):

```typescript
// GET /api/stats - Dashboard summary stats
if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "stats") {
  const agents = getAllAgents();
  const tasks = getAllTasks();
  const teleports = getAllTeleportRequests();

  const stats = {
    agents: {
      total: agents.length,
      idle: agents.filter((a) => a.status === "idle").length,
      busy: agents.filter((a) => a.status === "busy").length,
      offline: agents.filter((a) => a.status === "offline").length,
    },
    tasks: {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    },
    teleports: {
      total: teleports.length,
      pending: teleports.filter((t) => t.status === "pending").length,
      claimed: teleports.filter((t) => t.status === "claimed").length,
      started: teleports.filter((t) => t.status === "started").length,
      completed: teleports.filter((t) => t.status === "completed").length,
      failed: teleports.filter((t) => t.status === "failed").length,
    },
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats));
  return;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Server starts without errors

#### Manual Verification:
- [ ] `/api/teleports` returns list
- [ ] `/api/teleports/:id` returns details
- [ ] `/api/stats` includes teleport counts

---

## User Experience Flow

### Sending (Local Session)

```
User: "Send this to a worker to continue"

Claude: I'll package the current context and teleport it to an available worker.

[Calls teleport-out with:
  summary: "Implementing user authentication. Created login form, connected to API.
            Currently debugging token refresh - getting 401 intermittently."
  currentGoal: "Fix token refresh to prevent session expiration"
  relevantFiles: [
    { path: "src/components/LoginForm.tsx", summary: "Login UI" },
    { path: "src/api/auth.ts", summary: "Auth client with refresh logic" }
  ]
  contextNotes: "The refresh endpoint seems to fail after ~15 minutes of inactivity"
]

Claude: Session teleported! Teleport ID: abc-12345
        A worker will pick this up and continue the debugging.
```

### Receiving (Worker)

```
[Worker calls poll-teleport OR runner detects via /api/poll, receives:]

{
  "success": true,
  "teleport": {
    "id": "abc-12345",
    "summary": "Implementing user authentication...",
    "currentGoal": "Fix token refresh to prevent session expiration",
    "relevantFiles": "[{...}]",
    "contextNotes": "The refresh endpoint seems to fail after ~15 minutes..."
  }
}

Claude: Received teleport abc-12345!

I'm continuing work from another session. Here's the context:
- **Summary**: Implementing user authentication. Login form created, API connected.
- **Current Goal**: Fix token refresh to prevent session expiration
- **Key Files**: src/components/LoginForm.tsx, src/api/auth.ts
- **Notes**: Refresh fails after ~15 minutes of inactivity

Let me start by reading the auth.ts file to understand the refresh logic...

[Calls start-teleport to begin tracking]
[Does the work]
[Calls complete-teleport when done]
```

---

## Testing Strategy

### Unit Tests

Create `src/tools/teleport-out.test.ts`:

```typescript
import { test, expect, describe, beforeEach, mock } from "bun:test";

// Mock database functions
mock.module("../be/db", () => ({
  createTeleportRequest: mock(() => ({
    id: "test-uuid",
    status: "pending",
    summary: "Test summary",
    createdAt: new Date().toISOString(),
  })),
  getAgentById: mock((id: string) => {
    if (id === "worker-1") return { id: "worker-1", name: "Worker", isLead: false, status: "idle" };
    if (id === "lead-1") return { id: "lead-1", name: "Lead", isLead: true, status: "idle" };
    return null;
  }),
  getAllAgents: mock(() => [
    { id: "worker-1", name: "Worker", isLead: false, status: "idle" },
  ]),
}));

describe("teleport-out", () => {
  test("creates teleport request with summary", async () => {
    // Test implementation
  });

  test("rejects teleport to lead agent", async () => {
    // Test implementation
  });

  test("rejects when no workers available", async () => {
    // Test implementation
  });
});
```

### Integration Tests

Manual testing checklist:

1. **Teleport Creation**
   - Call `teleport-out` from local session
   - Verify teleport appears in `/api/teleports`
   - Verify status is "pending"

2. **Teleport Claiming**
   - Start a worker
   - Worker calls `poll-teleport` OR runner detects via `/api/poll`
   - Verify teleport status changes to "claimed"

3. **Teleport Completion**
   - Worker calls `start-teleport`
   - Worker calls `complete-teleport`
   - Verify status is "completed"

4. **Error Cases**
   - Teleport to offline agent - verify rejection
   - Teleport to lead agent - verify rejection
   - Double-claim - verify only one succeeds

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/types.ts` | Edit | Add TeleportRequest types + log events |
| `src/be/db.ts` | Edit | Add teleport_requests table + CRUD + inbox update |
| `src/tools/teleport-out.ts` | Create | Send context to swarm |
| `src/tools/poll-teleport.ts` | Create | Worker claims teleport |
| `src/tools/start-teleport.ts` | Create | Worker starts work |
| `src/tools/complete-teleport.ts` | Create | Worker completes |
| `src/tools/get-teleport-details.ts` | Create | View status |
| `src/server.ts` | Edit | Register tools + capability flag |
| `src/hooks/hook.ts` | Edit | Worker teleport awareness |
| `src/http.ts` | Edit | REST API endpoints + /api/poll integration |

---

## References

- Claude Code Web teleport: `claude --teleport <session_id>`
- Session storage: `~/.claude/projects/`
- Existing task flow: `src/tools/send-task.ts`, `src/tools/poll-task.ts`
- Tool patterns: `src/tools/poll-task.ts:131-148` (return shape)
- Hook system: `src/hooks/hook.ts`
- Capability system: `src/server.ts:27-36`
- Runner polling: `src/http.ts:282-379`
- Research: `thoughts/shared/research/2025-01-09-inverse-teleport-plan-review.md`
