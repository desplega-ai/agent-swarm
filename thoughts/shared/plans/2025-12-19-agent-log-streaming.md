# Agent Log Streaming and SSE Implementation Plan

## Overview

Implement real-time log streaming from worker agents to the frontend dashboard. Worker agents will stream their Claude CLI output to the API server, which stores logs on disk and broadcasts them via Server-Sent Events (SSE) to connected frontend clients viewing task details.

## Current State Analysis

### Existing Infrastructure
- **Runner** (`src/commands/runner.ts`): Spawns Claude CLI with `--output-format stream-json`, captures stdout/stderr to local JSONL files organized by session ID
- **Hooks** (`src/hooks/hook.ts`): Intercepts Claude Code events, communicates with MCP server for agent status tracking
- **HTTP Server** (`src/http.ts`): REST API with Node.js `createHttpServer`, no custom SSE endpoints yet (only MCP SDK streaming)
- **Frontend** (`ui/src/components/TaskDetailPanel.tsx`): Polls every 5 seconds via React Query, displays database logs only

### Key Discoveries
- Runner uses `sessionId` for log organization, not `taskId` - no link between logs and tasks currently
- Hook already handles `PostToolUse` events and can intercept `poll-task` and `store-progress` responses
- Bun file APIs available: `Bun.file()`, `Bun.write()`, `file.exists()`, `file.text()`
- Poll-task response structure at `src/tools/poll-task.ts:101-108` includes `task.id` in `structuredContent`

## Desired End State

After implementation:
1. Worker agents stream their Claude CLI output to the API in real-time
2. Logs are persisted to `/logs/{taskId}.jsonl` files on the API server
3. Frontend receives live log updates via SSE when viewing in-progress tasks
4. TaskDetailPanel shows streaming logs without polling delay

### Verification
- Start API server and worker
- Assign a task to the worker
- Open TaskDetailPanel for that task
- Observe logs appearing in real-time (< 1 second delay)
- Verify logs persist after task completion

## What We're NOT Doing

- Streaming Claude Code native JSONL files (`~/.claude/projects/...`)
- Log pagination or search
- Log level filtering
- Log retention policies or cleanup
- WebSocket implementation (SSE is simpler and sufficient)
- Authentication for SSE endpoints (inherits existing API key auth)

## Implementation Approach

Use file-based task ID tracking via `/tmp/.task.json` to link runner logs to tasks. The hook writes the current task ID when `poll-task` succeeds and clears it on task completion. The runner reads this file and streams log chunks to the API. The API stores logs on disk and broadcasts to SSE subscribers.

---

## Phase 1: Hook - Track Current Task ID

### Overview
Modify the hook to write the current task ID to a temp file when a task is assigned, and clear it when the task completes or fails.

### Changes Required

#### 1. Add Task File Tracking
**File**: `src/hooks/hook.ts`
**Changes**: Add task file write/clear logic in PostToolUse handler

```typescript
// Add at top of file after imports
const TASK_FILE = "/tmp/.task.json";

// In the PostToolUse case (around line 172), replace the existing handler:
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
      } catch {
        // Ignore errors clearing task file
      }
    }
  }

  // Keep existing agent info output
  if (agentInfo) {
    if (agentInfo.isLead) {
      if (msg.tool_name?.endsWith("send-task")) {
        const maybeTaskId = (msg.tool_response as { task?: { id?: string } })?.task?.id;
        console.log(
          `Task sent successfully.${maybeTaskId ? ` Task ID: ${maybeTaskId}.` : ""} Monitor progress using the get-task-details tool periodically.`,
        );
      }
    } else {
      console.log(
        `Remember to call store-progress periodically to update the lead agent on your progress.`,
      );
    }
  }
  break;
```

### Success Criteria

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc`
- [ ] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Start a worker agent and assign it a task
- [ ] Verify `/tmp/.task.json` is created with correct `taskId` after poll-task succeeds
- [ ] Verify `/tmp/.task.json` is cleared (empty) after task completes or fails

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the task file tracking works correctly before proceeding to Phase 2.

---

## Phase 2: Runner - Stream Logs to API

### Overview
Modify the runner to read the current task ID and stream log entries to the API server as they're captured from Claude CLI.

### Changes Required

#### 1. Add Task ID Reading and API Streaming
**File**: `src/commands/runner.ts`
**Changes**: Add helper functions and modify stdout/stderr capture loops

```typescript
// Add after existing imports (around line 5)
const TASK_FILE = "/tmp/.task.json";
const API_BASE_URL = process.env.MCP_BASE_URL || "http://localhost:3013";
const API_KEY = process.env.API_KEY || "";

// Add helper functions before runClaudeIteration (around line 35)
async function getCurrentTaskId(): Promise<string | null> {
  try {
    const file = Bun.file(TASK_FILE);
    if (await file.exists()) {
      const content = await file.text();
      if (!content.trim()) return null;
      const data = JSON.parse(content);
      return data.taskId || null;
    }
  } catch {
    // Ignore errors reading task file
  }
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
  } catch {
    // Fire and forget - don't block on API errors
  }
}
```

#### 2. Modify Stdout Processing Loop
**File**: `src/commands/runner.ts`
**Changes**: Add API streaming in the stdout loop (around line 77-126)

```typescript
// Inside stdoutPromise, after logFileHandle.write(text):
const taskId = await getCurrentTaskId();
if (taskId) {
  // Stream each parsed JSON line to API
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const json = JSON.parse(line.trim());
      // Don't await - fire and forget
      streamLogToApi(taskId, {
        type: json.type || "unknown",
        content: json,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-JSON lines also streamed
      if (line.trim()) {
        streamLogToApi(taskId, {
          type: "raw",
          content: line.trim(),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}
```

#### 3. Modify Stderr Processing Loop
**File**: `src/commands/runner.ts`
**Changes**: Add API streaming in the stderr loop (around line 128-142)

```typescript
// Inside stderrPromise, after logFileHandle.write():
const taskId = await getCurrentTaskId();
if (taskId) {
  streamLogToApi(taskId, {
    type: "stderr",
    content: text,
    timestamp: new Date().toISOString(),
  });
}
```

### Success Criteria

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc`
- [ ] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Start API server with logging enabled
- [ ] Run a worker and assign a task
- [ ] Observe POST requests to `/api/tasks/:id/logs` in API logs (will 404 until Phase 3)
- [ ] Verify runner doesn't crash or slow down due to API streaming

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the runner is attempting to stream logs before proceeding to Phase 3.

---

## Phase 3: API Server - Log Ingestion + SSE Broadcast

### Overview
Add three new endpoints to the HTTP server: POST for receiving logs, GET for retrieving stored logs, and GET with SSE for streaming new logs to subscribers.

### Changes Required

#### 1. Add SSE Subscriber Management
**File**: `src/http.ts`
**Changes**: Add subscriber tracking and broadcast helper near the top

```typescript
// Add after existing imports and before globalState definition (around line 25)
import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG_DIR = process.env.LOG_DIR || "./logs";

// SSE subscribers per task
const taskLogSubscribers: Map<string, Set<ServerResponse>> = new Map();

function broadcastToTaskSubscribers(taskId: string, data: object): void {
  const subscribers = taskLogSubscribers.get(taskId);
  if (!subscribers || subscribers.size === 0) return;

  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(message);
    } catch {
      // Remove dead connections
      subscribers.delete(res);
    }
  }
}
```

#### 2. Add POST /api/tasks/:id/logs Endpoint
**File**: `src/http.ts`
**Changes**: Add log ingestion endpoint (add before the MCP endpoint section, around line 320)

```typescript
// POST /api/tasks/:id/logs - Receive log chunks from runner
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "tasks" &&
  pathSegments[2] &&
  pathSegments[3] === "logs" &&
  !pathSegments[4]
) {
  const taskId = pathSegments[2];

  // Read request body
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let logEntry: object;
  try {
    logEntry = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  // Add receivedAt timestamp
  const enrichedEntry = {
    ...logEntry,
    receivedAt: new Date().toISOString(),
  };

  // Ensure log directory exists
  await mkdir(LOG_DIR, { recursive: true });

  // Append to task log file
  const logFile = `${LOG_DIR}/${taskId}.jsonl`;
  await appendFile(logFile, JSON.stringify(enrichedEntry) + "\n");

  // Broadcast to SSE subscribers
  broadcastToTaskSubscribers(taskId, enrichedEntry);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true }));
  return;
}
```

#### 3. Add GET /api/tasks/:id/logs Endpoint
**File**: `src/http.ts`
**Changes**: Add log retrieval endpoint

```typescript
// GET /api/tasks/:id/logs - Retrieve stored logs
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "tasks" &&
  pathSegments[2] &&
  pathSegments[3] === "logs" &&
  !pathSegments[4]
) {
  const taskId = pathSegments[2];
  const logFile = `${LOG_DIR}/${taskId}.jsonl`;

  if (!existsSync(logFile)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs: [] }));
    return;
  }

  // Read and parse JSONL file
  const logs: object[] = [];
  const fileStream = createReadStream(logFile);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        logs.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ logs }));
  return;
}
```

#### 4. Add GET /api/tasks/:id/logs/stream SSE Endpoint
**File**: `src/http.ts`
**Changes**: Add SSE streaming endpoint

```typescript
// GET /api/tasks/:id/logs/stream - SSE subscription for new logs
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "tasks" &&
  pathSegments[2] &&
  pathSegments[3] === "logs" &&
  pathSegments[4] === "stream"
) {
  const taskId = pathSegments[2];

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected", taskId })}\n\n`);

  // Add to subscribers
  if (!taskLogSubscribers.has(taskId)) {
    taskLogSubscribers.set(taskId, new Set());
  }
  taskLogSubscribers.get(taskId)!.add(res);

  // Cleanup on close
  req.on("close", () => {
    const subscribers = taskLogSubscribers.get(taskId);
    if (subscribers) {
      subscribers.delete(res);
      if (subscribers.size === 0) {
        taskLogSubscribers.delete(taskId);
      }
    }
  });

  // Keep connection alive with periodic heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on("close", () => clearInterval(heartbeat));

  return;
}
```

### Success Criteria

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc`
- [ ] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Start API server
- [ ] POST a test log: `curl -X POST http://localhost:3013/api/tasks/test-id/logs -H "Content-Type: application/json" -d '{"type":"test","content":"hello"}'`
- [ ] GET the logs: `curl http://localhost:3013/api/tasks/test-id/logs`
- [ ] Subscribe to SSE: `curl -N http://localhost:3013/api/tasks/test-id/logs/stream`
- [ ] POST another log and see it appear in the SSE stream
- [ ] Verify log file exists at `./logs/test-id.jsonl`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the API endpoints work correctly before proceeding to Phase 4.

---

## Phase 4: Frontend - SSE Subscription

### Overview
Add SSE subscription helper and modify TaskDetailPanel to use real-time log streaming for in-progress tasks.

### Changes Required

#### 1. Add StreamingLogEntry Type
**File**: `ui/src/types/api.ts`
**Changes**: Add type definition for streaming logs

```typescript
// Add after AgentLog interface (around line 48)
export interface StreamingLogEntry {
  type: string;
  content: unknown;
  timestamp: string;
  receivedAt?: string;
}
```

#### 2. Add SSE Subscription Helper
**File**: `ui/src/lib/api.ts`
**Changes**: Add SSE subscription function

```typescript
// Add after existing methods in ApiClient class (before the closing brace)
subscribeToTaskLogs(
  taskId: string,
  onLog: (log: StreamingLogEntry) => void,
  onError?: (error: Event) => void,
  onConnected?: () => void
): () => void {
  const url = `${this.getBaseUrl()}/api/tasks/${taskId}/logs/stream`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "connected") {
        onConnected?.();
      } else {
        onLog(data);
      }
    } catch {
      // Ignore parse errors
    }
  };

  eventSource.onerror = (error) => {
    onError?.(error);
  };

  // Return cleanup function
  return () => {
    eventSource.close();
  };
}
```

Also add the import at the top:
```typescript
import type { StreamingLogEntry } from "@/types/api";
```

#### 3. Add Streaming Logs Hook
**File**: `ui/src/hooks/useStreamingLogs.ts` (new file)
**Changes**: Create custom hook for SSE subscription

```typescript
import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import type { StreamingLogEntry } from "@/types/api";

export function useStreamingLogs(taskId: string, enabled: boolean) {
  const [logs, setLogs] = useState<StreamingLogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Event | null>(null);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  useEffect(() => {
    if (!enabled || !taskId) {
      setIsConnected(false);
      return;
    }

    const unsubscribe = api.subscribeToTaskLogs(
      taskId,
      (log) => {
        setLogs((prev) => [...prev, log]);
      },
      (err) => {
        setError(err);
        setIsConnected(false);
      },
      () => {
        setIsConnected(true);
        setError(null);
      }
    );

    return () => {
      unsubscribe();
      setIsConnected(false);
    };
  }, [taskId, enabled]);

  return { logs, isConnected, error, clearLogs };
}
```

#### 4. Update TaskDetailPanel
**File**: `ui/src/components/TaskDetailPanel.tsx`
**Changes**: Add streaming logs display for in-progress tasks

```typescript
// Add import at top
import { useStreamingLogs } from "@/hooks/useStreamingLogs";

// Inside TaskDetailPanel component, after existing hooks (around line 30)
const isInProgress = task?.status === "in_progress";
const { logs: streamingLogs, isConnected } = useStreamingLogs(
  taskId,
  isInProgress
);

// Add a new section in the UI to display streaming logs
// This should be added in the progress section area (around line 260-324)
// Add after the existing progress logs display:

{isInProgress && (
  <Box sx={{ mt: 2 }}>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      Live Output {isConnected && <Chip size="sm" color="success">Connected</Chip>}
    </Typography>
    <Box
      sx={{
        maxHeight: 300,
        overflow: "auto",
        bgcolor: "background.level1",
        borderRadius: "sm",
        p: 1,
        fontFamily: "monospace",
        fontSize: "xs",
      }}
    >
      {streamingLogs.length === 0 ? (
        <Typography level="body-sm" sx={{ color: "text.tertiary" }}>
          Waiting for logs...
        </Typography>
      ) : (
        streamingLogs.map((log, i) => (
          <Box key={i} sx={{ py: 0.5, borderBottom: "1px solid", borderColor: "divider" }}>
            <Typography
              level="body-xs"
              sx={{
                color: log.type === "stderr" ? "danger.500" : "text.primary",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {typeof log.content === "string"
                ? log.content
                : JSON.stringify(log.content, null, 2)}
            </Typography>
            <Typography level="body-xs" sx={{ color: "text.tertiary", fontSize: "10px" }}>
              {log.timestamp}
            </Typography>
          </Box>
        ))
      )}
    </Box>
  </Box>
)}
```

Also add the Chip import if not already present:
```typescript
import { Chip } from "@mui/joy";
```

### Success Criteria

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc`
- [ ] Linting passes: `bun run lint`
- [ ] Frontend builds: `cd ui && bun run build`

#### Manual Verification:
- [ ] Start API server and frontend
- [ ] Create a task and assign it to a worker
- [ ] Open TaskDetailPanel for the in-progress task
- [ ] Verify "Live Output" section appears with "Connected" indicator
- [ ] Observe logs appearing in real-time as worker executes
- [ ] Verify logs stop streaming when task completes
- [ ] Refresh page and verify historical logs are still visible

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the full end-to-end streaming works correctly before proceeding to Phase 5.

---

## Phase 5: Backend Types

### Overview
Add the StreamingLogEntry type to the backend for consistency.

### Changes Required

#### 1. Add StreamingLogEntry Type
**File**: `src/types.ts`
**Changes**: Add type definition

```typescript
// Add after AgentLogSchema (around line 138)
export const StreamingLogEntrySchema = z.object({
  type: z.string(),
  content: z.unknown(),
  timestamp: z.iso.datetime(),
  receivedAt: z.iso.datetime().optional(),
});

export type StreamingLogEntry = z.infer<typeof StreamingLogEntrySchema>;
```

### Success Criteria

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc`
- [ ] Linting passes: `bun run lint`

#### Manual Verification:
- [ ] Types are consistent between frontend and backend

---

## Testing Strategy

### Unit Tests
- Hook task file write/clear operations
- Runner task ID reading
- API log file parsing

### Integration Tests
- Full flow: hook writes task ID → runner streams → API stores → SSE broadcasts
- Multiple concurrent task subscriptions
- Connection cleanup on client disconnect

### Manual Testing Steps
1. Start API server: `bun run dev:http`
2. Start a worker agent
3. Create and assign a task via Slack or API
4. Open frontend dashboard and select the task
5. Verify "Live Output" section shows real-time logs
6. Wait for task completion
7. Refresh page and verify logs persist
8. Check `./logs/{taskId}.jsonl` file exists with correct content

## Performance Considerations

- **Fire-and-forget streaming**: Runner doesn't await API responses to avoid blocking Claude CLI processing
- **SSE heartbeat**: 30-second interval prevents connection timeout
- **Subscriber cleanup**: Dead connections are removed on write failure
- **File append**: Logs are appended, not rewritten, for efficiency

## Migration Notes

- No database migration required (logs stored on filesystem)
- Existing session-based logs in `./logs/{sessionId}/` are unaffected
- New task-based logs stored in `./logs/{taskId}.jsonl`

## References

- Related research: `thoughts/shared/research/2025-12-19-agent-log-streaming.md`
- Hook event handling: `src/hooks/hook.ts:172-188`
- Runner stdout capture: `src/commands/runner.ts:77-126`
- Existing SSE pattern: `src/http.ts:339-347` (MCP transport)
- Frontend polling: `ui/src/main.tsx:13`
