---
date: 2025-12-19T10:45:00-05:00
researcher: Claude-Main
git_commit: 7cb27a1
branch: main
repository: cc-orch-mcp
topic: "Agent Log Streaming and SSE Implementation"
tags: [research, logging, sse, streaming, worker-agents, frontend]
status: complete
last_updated: 2025-12-19
last_updated_by: Claude-Main
---

# Research: Agent Log Streaming and SSE Implementation

**Date**: 2025-12-19T10:45:00-05:00
**Researcher**: Claude-Main
**Git Commit**: 7cb27a1
**Branch**: main
**Repository**: cc-orch-mcp

## Research Question

How to store logs of Claude agents in the file system (not DB), stream them to the API for storage, and stream them via SSE to the frontend when viewing a task being executed.

## Summary

Three existing log sources were identified in the codebase. The recommended approach uses Claude Code hooks to track the current task ID via `/tmp/.task.json`, then streams log chunks from the runner to the API, which broadcasts to frontend via SSE.

## Detailed Findings

### Existing Log Sources

| Source | Location | Content | Format |
|--------|----------|---------|--------|
| **Claude Code native** | `~/.claude/projects/{path}/*.jsonl` | Full conversation + tool calls + thinking | JSONL per-message |
| **Worker runner logs** | `./logs/{sessionId}/{timestamp}.jsonl` | Raw Claude CLI stream output | JSONL continuous |
| **Database event logs** | `agent_log` table in SQLite | Task state changes + progress | Structured rows |

### Claude Code Native JSONL Files

Located at `~/.claude/projects/{escaped-project-path}/`:

**File types:**
- `{uuid}.jsonl` - Main conversation sessions
- `agent-{short-id}.jsonl` - Sub-agent (Task tool) sessions

**Record structure:**
- `sessionId` - UUID linking all messages
- `type` - `user`, `assistant`, `system`, `summary`
- `timestamp` - ISO datetime
- `message.content` - Array of thinking blocks, text, tool_use
- `message.model` - Model used
- `message.usage` - Token counts

**Sub-agent files include:**
- `agentId` - Short ID matching filename
- `slug` - Human-readable name
- `isSidechain: true` - Marker for sub-agent

### Worker Runner Implementation

**File:** `src/commands/runner.ts`

The runner spawns Claude CLI with `--output-format stream-json` (line 43) and captures:

**Stdout parsing (lines 77-126):**
```typescript
for await (const chunk of proc.stdout) {
  const text = new TextDecoder().decode(chunk);
  logFileHandle.write(text);  // writes to local JSONL file

  // Parses JSON lines into event types:
  // - assistant (message content)
  // - tool_use (tool calls)
  // - result (tool results)
  // - error (errors)
  // - system (system messages)
}
```

**Stderr capture (lines 128-142):**
```typescript
for await (const chunk of proc.stderr) {
  const text = new TextDecoder().decode(chunk);
  logFileHandle.write(JSON.stringify({ type: "stderr", content: text, timestamp }));
}
```

**Log directory structure:**
```
./logs/{sessionId}/
  ├── {timestamp}.jsonl     # Per-iteration logs
  └── errors.jsonl          # Error entries
```

### Hook System

**File:** `src/hooks/hook.ts`

Hooks intercept Claude Code events via stdin JSON:

**HookMessage fields:**
- `hook_event_name` - Event type (SessionStart, PostToolUse, Stop, etc.)
- `tool_name` - For tool events
- `tool_input` - Tool input parameters
- `tool_response` - Tool response data

**PostToolUse event** can intercept:
- `poll-task` response containing `task.id`
- `store-progress` input containing `status` (completed/failed)

### HTTP Server

**File:** `src/http.ts`

Current endpoints:
- `GET /api/tasks/:id` - Returns task with database logs
- `GET /api/logs` - Returns recent activity logs

MCP SSE support exists via `StreamableHTTPServerTransport` (lines 339-347).

### Frontend

**File:** `ui/src/components/TaskDetailPanel.tsx`

Currently uses polling via TanStack Query with 5-second interval (`ui/src/main.tsx:13`).

## Proposed Architecture

```
Worker Container                         API Server                      Frontend
┌─────────────────┐                   ┌─────────────────┐           ┌─────────────────┐
│ Claude CLI      │                   │                 │           │                 │
│ (stream-json)   │                   │ POST /api/tasks │           │ EventSource     │
│       ↓         │                   │ /:id/logs       │──────────▶│ subscription    │
│ runner.ts       │──────────────────▶│       ↓         │           │       ↓         │
│ (parse chunks)  │                   │ Store + SSE     │           │ TaskDetailPanel │
│       ↑         │                   │ broadcast       │           │ (live logs)     │
│ hook writes     │                   │       ↓         │           │                 │
│ /tmp/.task.json │                   │ GET /api/tasks  │◀──────────│                 │
└─────────────────┘                   │ /:id/logs/stream│           └─────────────────┘
                                      └─────────────────┘
```

## Implementation Plan

### Step 1: Hook - Track Current Task ID

**File:** `src/hooks/hook.ts`

In `PostToolUse` handler:
- When `poll-task` succeeds, write `/tmp/.task.json` with `{ taskId, assignedAt }`
- When `store-progress` completes/fails, clear `/tmp/.task.json`

```typescript
const TASK_FILE = "/tmp/.task.json";

case "PostToolUse":
  // Track task assignment from poll-task
  if (msg.tool_name?.endsWith("poll-task")) {
    const response = msg.tool_response as { success?: boolean; task?: { id: string } };
    if (response?.success && response?.task?.id) {
      await Bun.write(TASK_FILE, JSON.stringify({
        taskId: response.task.id,
        assignedAt: new Date().toISOString()
      }));
    }
  }

  // Clear on task completion/failure
  if (msg.tool_name?.endsWith("store-progress")) {
    const input = msg.tool_input as { status?: string };
    if (input?.status === "completed" || input?.status === "failed") {
      try {
        const file = Bun.file(TASK_FILE);
        if (await file.exists()) {
          await Bun.write(TASK_FILE, "");
        }
      } catch {}
    }
  }
  break;
```

### Step 2: Runner - Stream Logs to API

**File:** `src/commands/runner.ts`

- Add `getCurrentTaskId()` function to read `/tmp/.task.json`
- In stdout/stderr loops, POST log chunks to `/api/tasks/:id/logs`

```typescript
const TASK_FILE = "/tmp/.task.json";
const API_BASE_URL = process.env.MCP_BASE_URL || "http://localhost:3013";
const API_KEY = process.env.API_KEY || "";

async function getCurrentTaskId(): Promise<string | null> {
  try {
    const file = Bun.file(TASK_FILE);
    if (await file.exists()) {
      const content = await file.text();
      if (!content.trim()) return null;
      const data = JSON.parse(content);
      return data.taskId || null;
    }
  } catch {}
  return null;
}

async function streamLogToApi(taskId: string, logEntry: object): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/tasks/${taskId}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(logEntry),
    });
  } catch (err) {
    console.error(`[runner] Failed to stream log: ${err}`);
  }
}
```

### Step 3: API Server - Log Ingestion + SSE Broadcast

**File:** `src/http.ts`

New endpoints:
- `POST /api/tasks/:id/logs` - Worker pushes log chunks
- `GET /api/tasks/:id/logs` - Get logs from disk
- `GET /api/tasks/:id/logs/stream` - SSE subscription for new logs

```typescript
// File-based storage in /logs directory
const LOG_DIR = process.env.LOG_DIR || "./logs";
const taskLogSubscribers: Record<string, Set<ServerResponse>> = {};

// POST /api/tasks/:id/logs - Receive log chunks
// - Append to /logs/{taskId}.jsonl file
// - Broadcast to SSE subscribers

// GET /api/tasks/:id/logs - Read existing logs
// - Read and parse /logs/{taskId}.jsonl
// - Return all log entries

// GET /api/tasks/:id/logs/stream - SSE endpoint
// - Register subscriber for new logs
// - Broadcast when POST receives new entries
// - Cleanup on close
```

### Step 4: Frontend - SSE Subscription

**Files:** `ui/src/lib/api.ts`, `ui/src/components/TaskDetailPanel.tsx`

- Add `subscribeToTaskLogs()` SSE helper using EventSource
- Subscribe to SSE for in-progress tasks
- Display streaming logs in real-time

```typescript
export function subscribeToTaskLogs(
  taskId: string,
  onLog: (log: { type: string; content: unknown; timestamp: string }) => void,
  onError?: (error: Event) => void
): () => void {
  const url = `${baseUrl}/api/tasks/${taskId}/logs/stream`;
  const eventSource = new EventSource(url);
  eventSource.onmessage = (event) => onLog(JSON.parse(event.data));
  eventSource.onerror = onError;
  return () => eventSource.close();
}
```

### Step 5: Types

**Files:** `src/types.ts`, `ui/src/types/api.ts`

```typescript
export interface StreamingLogEntry {
  type: string;
  content: unknown;
  timestamp: string;
  receivedAt?: string;
}
```

## Code References

- `src/commands/runner.ts:37-164` - Claude CLI spawning and stream capture
- `src/commands/runner.ts:77-126` - Stdout parsing loop
- `src/commands/runner.ts:128-142` - Stderr capture loop
- `src/hooks/hook.ts:172-188` - PostToolUse handler
- `src/hooks/hook.ts:175-181` - send-task response handling (pattern to follow)
- `src/tools/poll-task.ts:101-108` - poll-task response structure with task.id
- `src/tools/store-progress.ts:79-101` - store-progress status handling
- `src/http.ts:339-347` - Existing SSE/MCP transport pattern
- `ui/src/main.tsx:13` - Current 5-second polling interval
- `ui/src/components/TaskDetailPanel.tsx:29-30` - Current data fetching

## Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/hook.ts` | Add task file tracking in PostToolUse |
| `src/commands/runner.ts` | Add API streaming in stdout/stderr loops |
| `src/http.ts` | Add POST + GET + SSE endpoints for task logs |
| `src/types.ts` | Add StreamingLogEntry type |
| `ui/src/lib/api.ts` | Add SSE subscription helper |
| `ui/src/components/TaskDetailPanel.tsx` | Add SSE subscription + live log display |
| `ui/src/types/api.ts` | Add StreamingLogEntry type |

## Testing Plan

1. Start API server: `bun run dev:http`
2. Run a worker with a task
3. Verify `/tmp/.task.json` is created on poll-task
4. Verify logs appear at `GET /api/tasks/:id/logs`
5. Verify SSE stream at `GET /api/tasks/:id/logs/stream`
6. Verify `/tmp/.task.json` is cleared on completion
7. Verify frontend shows live logs

## Future Enhancements (Out of Scope)

- Persist logs to file system instead of memory
- Add log pagination/search
- Add log level filtering
- Stream Claude Code native JSONL files (`~/.claude/projects/...`)
- Tail existing log files for historical context

## Design Decisions

**Log Storage:** Persist to disk in the mounted `/logs` directory (not in-memory). API serves existing logs via GET, then streams new logs via SSE.

**Log Retention:** Keep all logs per task (no limit).

**Claude Code native JSONL:** Out of scope for now, potentially in future iterations.
