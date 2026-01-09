---
date: 2025-01-09T00:00:00-08:00
researcher: Claude
git_commit: 2173a8f
branch: main
repository: agent-swarm
topic: "Inverse Teleport Feature - Plan Review and Implementation Readiness"
tags: [research, codebase, inverse-teleport, teleport, session-context, worker-handoff]
status: complete
last_updated: 2025-01-09
last_updated_by: Claude
---

# Research: Inverse Teleport Feature - Plan Review and Implementation Readiness

**Date**: 2025-01-09T00:00:00-08:00
**Researcher**: Claude
**Git Commit**: 2173a8f
**Branch**: main
**Repository**: agent-swarm

## Research Question

Check existing researches and current code structure to propose an updated research to help create a plan to implement the inverse teleport feature.

## Summary

The existing inverse teleport plan (`thoughts/shared/plans/2025-12-18-inverse-teleport.md`) is comprehensive and well-designed but has **not been implemented**. The plan remains compatible with the current codebase. Three minor updates are recommended: (1) add teleport capability flag, (2) integrate with runner-level `/api/poll` endpoint, and (3) add teleport log event types.

## Detailed Findings

### 1. Existing Plan Analysis

**Location**: `thoughts/shared/plans/2025-12-18-inverse-teleport.md`

The plan defines a "teleport-out" feature where a local Claude Code session can transfer its context to a distributed worker agent to continue the work. This is the inverse of Claude Code Web's teleport feature (which brings web sessions to local CLI).

**Plan Structure (5 Phases)**:

| Phase | Description | Files Affected |
|-------|-------------|----------------|
| 1 | Database Schema Updates | `src/types.ts`, `src/be/db.ts` |
| 2 | Teleport MCP Tools (5 new) | `src/tools/teleport-*.ts` |
| 3 | Server Registration | `src/server.ts` |
| 4 | Worker Integration | `src/hooks/hook.ts` |
| 5 | HTTP API Endpoints | `src/http.ts` |

**Proposed Teleport Lifecycle**:
```
pending → claimed → started → completed/failed
```

**Proposed MCP Tools**:
1. `teleport-out` - Send context to swarm
2. `poll-teleport` - Worker claims teleport
3. `start-teleport` - Mark work started
4. `complete-teleport` - Mark completed/failed
5. `get-teleport-details` - Query status

**Context Package Schema** (from plan):
```typescript
{
  id: string,
  sourceAgentId?: string,
  targetAgentId?: string,
  status: "pending" | "claimed" | "started" | "completed" | "failed",

  // Context Package
  summary: string,           // Required: AI summary of session
  currentGoal?: string,      // What to accomplish
  relevantFiles?: string,    // JSON array of files
  contextNotes?: string,     // Additional context
  workingDirectory?: string, // CWD of original session
  projectPath?: string,      // Project root

  // Timestamps & Result tracking
  createdAt, claimedAt, claimedBy, startedAt, finishedAt,
  resultTaskId?, output?, failureReason?
}
```

### 2. Current Codebase State

#### Type System (`src/types.ts`)

**Existing patterns**:
- Zod schemas for all types: `*Schema` naming convention
- Type inference: `type X = z.infer<typeof XSchema>`
- Enums for status fields
- Optional fields with `.optional()`

**Current types defined**:
- `AgentTaskSchema` (lines 16-54)
- `AgentSchema` (lines 58-71)
- `ChannelSchema`, `ChannelMessageSchema` (lines 87-110)
- `ServiceSchema` (lines 115-138)
- `AgentLogSchema` (lines 161-173)
- `SessionLogSchema` (lines 176-187)

**No teleport types exist** - must be added per plan.

#### Database Layer (`src/be/db.ts`)

**Existing patterns**:
- `*Row` types for database rows
- `rowTo*()` conversion functions
- `*Queries` prepared statement objects
- CRUD functions with automatic log entry creation
- Transaction usage for atomic operations
- Migration via `ALTER TABLE` with try-catch blocks

**Current tables**:
- `agents` (lines 33-43)
- `agent_tasks` (lines 45-69)
- `agent_log` (lines 74-88)
- `channels` (lines 91-100)
- `channel_messages` (lines 103-114)
- `channel_read_state` (lines 121-128)
- `services` (lines 131-151)
- `session_logs` (lines 157-169)

**No teleport_requests table exists** - must be created per plan.

#### Server Registration (`src/server.ts`)

**Capability-based feature flags** (lines 27-36):
```typescript
const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services";
const CAPABILITIES = new Set(
  (process.env.CAPABILITIES || DEFAULT_CAPABILITIES).split(",").map((s) => s.trim()),
);
```

**Tools registered conditionally** (lines 71-94):
```typescript
if (hasCapability("task-pool")) {
  registerTaskActionTool(server);
}
// ... similar for messaging, profiles, services
```

**Update needed**: Add `teleport` capability (not in original plan).

#### HTTP API (`src/http.ts`)

**Runner-level polling** (`GET /api/poll`, lines 282-379):
- Checks for offered tasks
- Checks for pending tasks
- Lead-specific: unread mentions, finished worker tasks
- Worker-specific: unassigned tasks in pool

**Update needed**: Add teleport trigger check to `/api/poll` (not in original plan).

### 3. Changes Since Original Plan (2025-12-18)

| Feature Added | Date | Impact on Teleport Plan |
|---------------|------|-------------------------|
| Session logs | Dec 2025 | None - separate feature |
| Runner-level polling (`/api/poll`) | Dec 2025 | **Should integrate** |
| Capability system refined | Dec 2025 | **Should add teleport capability** |
| Services feature completed | Dec 2025 | Pattern reference |

### 4. Plan Compatibility Assessment

#### Fully Compatible (No Changes Needed)

- **Database schema design**: Follows existing patterns
- **Type definitions**: Follows existing Zod patterns
- **All 5 MCP tools**: Follow existing tool patterns
- **Hook integration**: Simple message update
- **Basic HTTP endpoints**: Follow existing patterns

#### Updates Recommended

1. **Add teleport capability flag** in `src/server.ts`:
   ```typescript
   const DEFAULT_CAPABILITIES = "core,task-pool,messaging,profiles,services,teleport";

   if (hasCapability("teleport")) {
     registerTeleportOut(server);
     registerPollTeleport(server);
     registerStartTeleport(server);
     registerCompleteTeleport(server);
     registerGetTeleportDetails(server);
   }
   ```

2. **Integrate with `/api/poll`** in `src/http.ts`:
   ```typescript
   // Add before offered task check (line 301)
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
   ```

3. **Add teleport log event types** in `src/types.ts`:
   ```typescript
   export const AgentLogEventTypeSchema = z.enum([
     // ... existing events
     "teleport_created",
     "teleport_claimed",
     "teleport_started",
     "teleport_completed",
     "teleport_failed",
   ]);
   ```

### 5. Implementation Effort Estimate

| Component | New Lines | Complexity |
|-----------|-----------|------------|
| Types (`src/types.ts`) | ~50 | Low |
| Database (`src/be/db.ts`) | ~150 | Medium |
| 5 MCP tools | ~350 total | Medium |
| Server registration | ~15 | Low |
| Hook update | ~20 | Low |
| HTTP endpoints + poll | ~80 | Medium |
| **Total** | **~665** | Medium |

### 6. Related Patterns to Follow

**Tool registration** (example from `src/tools/poll-task.ts`):
```typescript
export function registerPollTaskTool(server: McpServer): void {
  createToolRegistrar(server)(
    "poll-task",
    {
      description: "...",
      inputSchema,
      outputSchema,
    },
    async (args, requestInfo: RequestInfo) => {
      // Implementation
    }
  );
}
```

**Database CRUD** (example from `src/be/db.ts`):
```typescript
export function createTask(agentId: string, task: string, options?: {...}): AgentTask {
  const id = crypto.randomUUID();
  const row = taskQueries.insert().get(...);
  if (!row) throw new Error("Failed to create task");
  try {
    createLogEntry({ eventType: "task_created", agentId, taskId: id, ... });
  } catch {}
  return rowToAgentTask(row);
}
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Inverse Teleport Flow                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Local Session                    Server                    Worker       │
│       │                              │                         │         │
│       │-- teleport-out ------------>│                         │         │
│       │   (summary, goal,           │                         │         │
│       │    relevantFiles,           │                         │         │
│       │    contextNotes)            │                         │         │
│       │                              │                         │         │
│       │<-- teleportId --------------|                         │         │
│       │                              │                         │         │
│       │                              │   /api/poll or          │         │
│       │                              │<-- poll-teleport -------|         │
│       │                              │                         │         │
│       │                              |--- claimed teleport --->│         │
│       │                              │    (full context)       │         │
│       │                              │                         │         │
│       │                              │<-- start-teleport ------|         │
│       │                              │                         │         │
│       │                              │        [Worker does     │         │
│       │                              │         the work]       │         │
│       │                              │                         │         │
│       │                              │<-- complete-teleport ---|         │
│       │                              │    (output/failure)     │         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Code References

- Original plan: `thoughts/shared/plans/2025-12-18-inverse-teleport.md`
- Types file: `src/types.ts:1-188`
- Database layer: `src/be/db.ts:1-2053`
- Server registration: `src/server.ts:1-97`
- HTTP API: `src/http.ts:1-909`
- Capability system: `src/server.ts:27-36`
- Runner polling: `src/http.ts:282-379`
- Existing tool pattern: `src/tools/poll-task.ts`
- Existing tool pattern: `src/tools/send-task.ts`
- Hook system: `src/hooks/hook.ts`

## Related Research

- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` - Runner architecture (explains `/api/poll` endpoint)

## Open Questions

1. **Runner Polling Priority**: Should teleports have higher priority than offered tasks in `/api/poll`? Current proposal puts teleports first.

2. **Teleport Capability Default**: Should `teleport` be enabled by default in `DEFAULT_CAPABILITIES`? Recommendation: Yes, for feature discoverability.

3. **UI Integration**: The original plan doesn't cover dashboard UI for teleports. Is this needed for MVP, or can it be added later?

4. **Non-Swarm Sessions**: The original plan allows `sourceAgentId` to be null for non-swarm sessions. Should we require swarm registration, or allow anonymous teleports?

## Conclusion

The existing plan is **mostly implementation-ready** but requires several code-level corrections before implementation begins.

## Critical Implementation Corrections Required

### 1. Zod Import Path (All Tool Files)

**Plan shows:**
```typescript
import { z } from "zod/v4";
```

**Should be:**
```typescript
import * as z from "zod";
```

### 2. Tool Return Shape (All Tool Files)

**Plan shows direct object returns:**
```typescript
return {
  success: true,
  teleportId: teleport.id,
  message: "...",
};
```

**Should use dual content/structuredContent pattern:**
```typescript
return {
  content: [
    {
      type: "text",
      text: `Session teleported! Teleport ID: ${teleport.id}`,
    },
  ],
  structuredContent: {
    yourAgentId: requestInfo.agentId,
    success: true,
    teleportId: teleport.id,
    message: "...",
  },
};
```

### 3. Tool Registration Function Naming

**Plan uses:** `registerTeleportOut`, `registerPollTeleport`, etc.

**Should follow convention:** `registerTeleportOutTool`, `registerPollTeleportTool`, etc.

### 4. Missing Tool Title Property

**Plan's tool configs are missing `title` property:**
```typescript
{
  title: "Teleport session to worker",  // ADD THIS
  description: "Transfer current session context...",
  inputSchema,
  outputSchema,
},
```

### 5. HTTP Response Pattern

**Plan uses Fetch/Bun.serve style:**
```typescript
return Response.json({ teleports });
```

**Should use Node.js http pattern:**
```typescript
res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify({ teleports }));
```

### 6. Missing Type Imports in db.ts

Add to imports in `src/be/db.ts`:
```typescript
import type {
  // ... existing imports ...
  TeleportRequest,
  TeleportRequestStatus,
} from "../types";
```

## Summary of Required Updates

1. **Add `teleport` capability flag** (as noted above)
2. **Integrate with `/api/poll`** for runner-level detection (as noted above)
3. **Add teleport event types** to log schema (as noted above)
4. **Fix Zod import path** in all 5 tool files
5. **Fix tool return shape** in all 5 tool files to use content/structuredContent
6. **Rename tool registration functions** to follow `registerXxxTool` convention
7. **Add `title` property** to all tool configurations
8. **Fix HTTP response pattern** in Phase 5 endpoints
9. **Add type imports** to db.ts

The implementation can proceed using the original plan as the primary guide, with these corrections incorporated.
