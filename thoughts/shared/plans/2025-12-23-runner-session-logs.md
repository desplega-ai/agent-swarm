# Runner Session Logs Implementation Plan

## Overview

Push Claude JSON lines from the runner to the API to store them in a new `session_logs` table, then display them in the task details page as a new "Session Log" tab. Logs are linked by `taskId` when known (polling mode), JSON-stringified for frontend parsing, and separate from the activity feed.

## Current State Analysis

### How It Works Now

1. **Runner** (`src/commands/runner.ts:170-249`): Spawns Claude with `--output-format stream-json`, captures stdout via `proc.stdout` pipe
2. **Log Writing** (`runner.ts:212`): Raw JSON lines written directly to `.jsonl` files on disk
3. **No API Push**: Logs stay on disk, not transmitted to API
4. **Existing Logs** (`agent_log` table): Stores activity events (`task_progress`, `task_created`, etc.) - NOT raw Claude output

### Key Discoveries

- Runner knows `taskId` in polling mode via `trigger.taskId` (`runner.ts:149-151`)
- Log file path: `{LOG_DIR}/{sessionId}/{timestamp}.jsonl` (`runner.ts:378`)
- Stdout processing in async loop (`runner.ts:207-220`)
- Pretty-print handles JSON parsing (`pretty-print.ts:79`)

## Desired End State

After this implementation:

1. **New `session_logs` table** stores Claude JSON output with `taskId`, `cli` field, and raw content
2. **Runner streams logs** to API in batched chunks during execution
3. **New API endpoints** for storing and retrieving session logs
4. **TaskDetailPanel** shows "Session Log" tab with pretty-printed JSON output
5. **Session logs are separate** from activity feed (no mixing with `task_progress`)

### Verification

- Running a task in polling mode creates session log entries linked to the task
- `GET /api/tasks/:id/session-logs` returns the raw JSON lines
- TaskDetailPanel shows "Session Log" tab with parsed/formatted output
- Activity feed remains unchanged (no new entries from session logs)

## What We're NOT Doing

- **AI-loop mode session logs**: These won't have taskId (acceptable per user decision)
- **Real-time streaming to frontend**: Frontend will poll/refresh, not WebSocket
- **Modifying existing `agent_log` table**: Session logs get their own table
- **Changing local file logging**: Disk logs continue unchanged

## Implementation Approach

We'll implement this in five phases:

1. **Phase 1**: Database schema - Add `session_logs` table
2. **Phase 2**: API endpoints - POST and GET for session logs
3. **Phase 3**: Runner changes - Stream logs to API during execution
4. **Phase 4**: Frontend types and API client updates
5. **Phase 5**: TaskDetailPanel - Add "Session Log" tab

---

## Phase 1: Database Schema

### Overview

Add a new `session_logs` table to store raw Claude JSON output, linked to tasks by `taskId`.

### Changes Required

#### 1. Add Table Definition

**File**: `src/be/db.ts`
**Location**: After line 85 (after `agent_log` table creation)

```sql
CREATE TABLE IF NOT EXISTS session_logs (
  id TEXT PRIMARY KEY,
  taskId TEXT,
  sessionId TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  cli TEXT NOT NULL DEFAULT 'claude',
  content TEXT NOT NULL,
  lineNumber INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_logs_taskId ON session_logs(taskId);
CREATE INDEX IF NOT EXISTS idx_session_logs_sessionId ON session_logs(sessionId);
```

**Fields:**
- `id` - UUID primary key
- `taskId` - Optional link to task (NULL for AI-loop mode)
- `sessionId` - Runner session ID
- `iteration` - Iteration number within session
- `cli` - CLI tool identifier (default: "claude")
- `content` - Raw JSON line (stringified)
- `lineNumber` - Order within the iteration
- `createdAt` - Timestamp

#### 2. Add TypeScript Types

**File**: `src/types.ts`
**Location**: After line 173 (after `AgentLog` type)

```typescript
// Session Log Types (raw CLI output)
export const SessionLogSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().optional(),
  sessionId: z.string(),
  iteration: z.number().int().min(1),
  cli: z.string().default("claude"),
  content: z.string(), // Raw JSON line
  lineNumber: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;
```

#### 3. Add Database Functions

**File**: `src/be/db.ts`
**Location**: After `getAllLogs` function (around line 948)

```typescript
// Session Logs

type SessionLogRow = {
  id: string;
  taskId: string | null;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

function rowToSessionLog(row: SessionLogRow): SessionLog {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId,
    iteration: row.iteration,
    cli: row.cli,
    content: row.content,
    lineNumber: row.lineNumber,
    createdAt: row.createdAt,
  };
}

export const sessionLogQueries = {
  insert: () =>
    getDb().prepare<
      SessionLogRow,
      [string, string | null, string, number, string, string, number]
    >(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    ),

  insertBatch: () =>
    getDb().prepare<
      null,
      [string, string | null, string, number, string, string, number]
    >(
      `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByTaskId: () =>
    getDb().prepare<SessionLogRow, [string]>(
      "SELECT * FROM session_logs WHERE taskId = ? ORDER BY iteration ASC, lineNumber ASC",
    ),

  getBySessionId: () =>
    getDb().prepare<SessionLogRow, [string, number]>(
      "SELECT * FROM session_logs WHERE sessionId = ? AND iteration = ? ORDER BY lineNumber ASC",
    ),
};

export function createSessionLogs(logs: {
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  lines: string[];
}): void {
  const stmt = sessionLogQueries.insertBatch();
  getDb().transaction(() => {
    for (let i = 0; i < logs.lines.length; i++) {
      stmt.run(
        crypto.randomUUID(),
        logs.taskId ?? null,
        logs.sessionId,
        logs.iteration,
        logs.cli,
        logs.lines[i],
        i,
      );
    }
  })();
}

export function getSessionLogsByTaskId(taskId: string): SessionLog[] {
  return sessionLogQueries.getByTaskId().all(taskId).map(rowToSessionLog);
}

export function getSessionLogsBySession(sessionId: string, iteration: number): SessionLog[] {
  return sessionLogQueries.getBySessionId().all(sessionId, iteration).map(rowToSessionLog);
}
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] Table created on startup (check with `sqlite3` or db init logs)

#### Manual Verification:
- [x] Run `bun run mcp` and verify no errors on startup
- [x] Confirm table exists: `sqlite3 .swarm.db ".schema session_logs"`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: API Endpoints

### Overview

Add HTTP endpoints to store and retrieve session logs.

### Changes Required

#### 1. Add Import

**File**: `src/http.ts`
**Location**: Line 35 (add to imports from `./be/db`)

Add `createSessionLogs`, `getSessionLogsByTaskId` to the imports.

#### 2. Add POST Endpoint for Batch Logs

**File**: `src/http.ts`
**Location**: After `/api/poll` endpoint (around line 355)

```typescript
// POST /api/session-logs - Store session logs (batch)
if (
  req.method === "POST" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "session-logs"
) {
  // Parse request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());

  // Validate required fields
  if (!body.sessionId || typeof body.sessionId !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid 'sessionId' field" }));
    return;
  }

  if (typeof body.iteration !== "number" || body.iteration < 1) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid 'iteration' field" }));
    return;
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid 'lines' array" }));
    return;
  }

  try {
    createSessionLogs({
      taskId: body.taskId || undefined,
      sessionId: body.sessionId,
      iteration: body.iteration,
      cli: body.cli || "claude",
      lines: body.lines,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, count: body.lines.length }));
  } catch (error) {
    console.error("[HTTP] Failed to create session logs:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to store session logs" }));
  }
  return;
}
```

#### 3. Add GET Endpoint for Task Session Logs

**File**: `src/http.ts`
**Location**: After the POST endpoint

```typescript
// GET /api/tasks/:id/session-logs - Get session logs for a task
if (
  req.method === "GET" &&
  pathSegments[0] === "api" &&
  pathSegments[1] === "tasks" &&
  pathSegments[2] &&
  pathSegments[3] === "session-logs"
) {
  const taskId = pathSegments[2];
  const task = getTaskById(taskId);

  if (!task) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Task not found" }));
    return;
  }

  const logs = getSessionLogsByTaskId(taskId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ logs }));
  return;
}
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] API returns 400 for missing sessionId
- [x] API returns 400 for missing lines array
- [x] API returns 201 on successful POST

#### Manual Verification:
- [x] Test POST:
  ```bash
  curl -X POST http://localhost:3013/api/session-logs \
    -H "Content-Type: application/json" \
    -d '{"sessionId": "test-123", "iteration": 1, "cli": "claude", "lines": ["{\"type\":\"system\"}"]}'
  ```
- [x] Test GET:
  ```bash
  curl http://localhost:3013/api/tasks/<taskId>/session-logs
  ```
- [x] Added unit tests: `src/tests/session-logs.test.ts` (13 tests passing)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Runner Changes

### Overview

Modify the runner to buffer and stream session logs to the API during execution.

### Changes Required

#### 1. Add Log Buffer and Push Function

**File**: `src/commands/runner.ts`
**Location**: After `buildPromptForTrigger` function (around line 168)

```typescript
/** Buffer for session logs */
interface LogBuffer {
  lines: string[];
  lastFlush: number;
}

/** Configuration for log streaming */
const LOG_BUFFER_SIZE = 50; // Flush after this many lines
const LOG_FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds

/** Push buffered logs to the API */
async function flushLogBuffer(
  buffer: LogBuffer,
  opts: {
    apiUrl: string;
    apiKey: string;
    agentId: string;
    sessionId: string;
    iteration: number;
    taskId?: string;
    cli?: string;
  },
): Promise<void> {
  if (buffer.lines.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  try {
    const response = await fetch(`${opts.apiUrl}/api/session-logs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: opts.sessionId,
        iteration: opts.iteration,
        taskId: opts.taskId,
        cli: opts.cli || "claude",
        lines: buffer.lines,
      }),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to push logs: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error pushing logs: ${error}`);
  }

  // Clear buffer after flush
  buffer.lines = [];
  buffer.lastFlush = Date.now();
}
```

#### 2. Update RunClaudeIterationOptions Interface

**File**: `src/commands/runner.ts`
**Location**: Line 50-56 (update existing interface)

```typescript
interface RunClaudeIterationOptions {
  prompt: string;
  logFile: string;
  systemPrompt?: string;
  additionalArgs?: string[];
  role: string;
  // New fields for log streaming
  apiUrl?: string;
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  iteration?: number;
  taskId?: string;
}
```

#### 3. Update runClaudeIteration Function

**File**: `src/commands/runner.ts`
**Location**: Update the stdout processing loop (lines 207-220)

Replace:
```typescript
const stdoutPromise = (async () => {
  if (proc.stdout) {
    for await (const chunk of proc.stdout) {
      stdoutChunks++;
      const text = new TextDecoder().decode(chunk);
      logFileHandle.write(text);

      const lines = text.split("\n");
      for (const line of lines) {
        prettyPrintLine(line, role);
      }
    }
  }
})();
```

With:
```typescript
const stdoutPromise = (async () => {
  if (proc.stdout) {
    // Initialize log buffer for API streaming
    const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now() };
    const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

    for await (const chunk of proc.stdout) {
      stdoutChunks++;
      const text = new TextDecoder().decode(chunk);
      logFileHandle.write(text);

      const lines = text.split("\n");
      for (const line of lines) {
        prettyPrintLine(line, role);

        // Buffer non-empty lines for API streaming
        if (shouldStream && line.trim()) {
          logBuffer.lines.push(line.trim());

          // Check if we should flush (buffer full or time elapsed)
          const shouldFlush =
            logBuffer.lines.length >= LOG_BUFFER_SIZE ||
            Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;

          if (shouldFlush) {
            await flushLogBuffer(logBuffer, {
              apiUrl: opts.apiUrl!,
              apiKey: opts.apiKey || "",
              agentId: opts.agentId || "",
              sessionId: opts.sessionId!,
              iteration: opts.iteration!,
              taskId: opts.taskId,
              cli: "claude",
            });
          }
        }
      }
    }

    // Final flush for remaining buffered logs
    if (shouldStream && logBuffer.lines.length > 0) {
      await flushLogBuffer(logBuffer, {
        apiUrl: opts.apiUrl!,
        apiKey: opts.apiKey || "",
        agentId: opts.agentId || "",
        sessionId: opts.sessionId!,
        iteration: opts.iteration!,
        taskId: opts.taskId,
        cli: "claude",
      });
    }
  }
})();
```

#### 4. Update runClaudeIteration Calls in Polling Mode

**File**: `src/commands/runner.ts`
**Location**: Line 395-401 (update the polling mode call)

Replace:
```typescript
const exitCode = await runClaudeIteration({
  prompt: triggerPrompt,
  logFile,
  systemPrompt: resolvedSystemPrompt,
  additionalArgs: opts.additionalArgs,
  role,
});
```

With:
```typescript
const exitCode = await runClaudeIteration({
  prompt: triggerPrompt,
  logFile,
  systemPrompt: resolvedSystemPrompt,
  additionalArgs: opts.additionalArgs,
  role,
  // Add streaming options
  apiUrl,
  apiKey,
  agentId,
  sessionId,
  iteration,
  taskId: trigger.taskId,
});
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `bun run tsc:check`
- [x] No runtime errors when starting worker in polling mode

#### Manual Verification:
- [x] Start MCP server and worker
- [x] Create a task and verify session logs appear in database
- [x] Check `sqlite3 .swarm.db "SELECT COUNT(*) FROM session_logs"`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Frontend Types and API

### Overview

Add TypeScript types and API client methods for session logs.

### Changes Required

#### 1. Add SessionLog Type

**File**: `ui/src/types/api.ts`
**Location**: After `AgentLog` interface (around line 72)

```typescript
export interface SessionLog {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
}

export interface SessionLogsResponse {
  logs: SessionLog[];
}
```

#### 2. Add API Client Method

**File**: `ui/src/lib/api.ts`
**Location**: After `fetchTask` method

```typescript
async fetchTaskSessionLogs(taskId: string): Promise<SessionLog[]> {
  const response = await this.fetch(`/tasks/${taskId}/session-logs`);
  const data = (await response.json()) as SessionLogsResponse;
  return data.logs;
}
```

#### 3. Add React Query Hook

**File**: `ui/src/hooks/queries.ts`
**Location**: After `useTask` hook

```typescript
export function useTaskSessionLogs(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "session-logs"],
    queryFn: () => api.fetchTaskSessionLogs(taskId),
    enabled: !!taskId,
    refetchInterval: 5000, // Refresh every 5 seconds for live updates
  });
}
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd ui && bun run tsc`
- [x] No type errors in api.ts or queries.ts

#### Manual Verification:
- [x] Verify types are correctly exported

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 5.

---

## Phase 5: TaskDetailPanel - Session Log Tab

### Overview

Add a "Session Log" tab to the TaskDetailPanel that displays pretty-printed Claude JSON output.

### Changes Required

#### 1. Add Import for Hook

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: Line 13 (update imports)

```typescript
import { useTask, useAgents, useTaskSessionLogs } from "../hooks/queries";
```

#### 2. Add State for Tab Selection

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: After line 34 (after `outputTab` state)

```typescript
const [mainTab, setMainTab] = useState<"details" | "session">("details");
```

#### 3. Add Session Logs Query

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: After line 31 (after `useAgents`)

```typescript
const { data: sessionLogs } = useTaskSessionLogs(taskId);
```

#### 4. Create SessionLogViewer Component

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: After `ErrorContent` component (around line 478)

```typescript
// Session Log content - pretty prints Claude JSON lines
const SessionLogContent = () => {
  const formatLogLine = (content: string) => {
    try {
      const json = JSON.parse(content);

      // Format based on type
      switch (json.type) {
        case "system":
          return {
            type: "system",
            color: colors.blue,
            content: json.subtype === "init"
              ? `Model: ${json.model}, Tools: ${json.tools?.length || 0}`
              : json.message || JSON.stringify(json, null, 2),
          };

        case "assistant":
          // Extract text content from message blocks
          const textBlocks = json.message?.content?.filter((b: { type: string }) => b.type === "text") || [];
          const toolUseBlocks = json.message?.content?.filter((b: { type: string }) => b.type === "tool_use") || [];
          return {
            type: "assistant",
            color: colors.gold,
            content: textBlocks.length > 0
              ? textBlocks.map((b: { text: string }) => b.text).join("\n")
              : toolUseBlocks.length > 0
                ? `Tool: ${toolUseBlocks[0].name}`
                : JSON.stringify(json, null, 2),
          };

        case "user":
          return {
            type: "user/tool_result",
            color: colors.purple,
            content: json.message?.content?.[0]?.content || JSON.stringify(json, null, 2),
          };

        case "result":
          return {
            type: "result",
            color: json.is_error ? colors.rust : colors.amber,
            content: `Duration: ${Math.round((json.duration_ms || 0) / 1000)}s, Cost: $${(json.total_cost_usd || 0).toFixed(4)}`,
          };

        default:
          return {
            type: json.type || "unknown",
            color: colors.tertiary,
            content: JSON.stringify(json, null, 2),
          };
      }
    } catch {
      return {
        type: "raw",
        color: colors.tertiary,
        content,
      };
    }
  };

  if (!sessionLogs || sessionLogs.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography sx={{ fontFamily: "code", fontSize: "0.75rem", color: "text.tertiary" }}>
          No session logs available
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {sessionLogs.map((log) => {
          const formatted = formatLogLine(log.content);
          return (
            <Box
              key={log.id}
              sx={{
                bgcolor: "background.level1",
                p: 1.5,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "neutral.outlinedBorder",
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                <Chip
                  size="sm"
                  variant="soft"
                  sx={{
                    fontFamily: "code",
                    fontSize: "0.6rem",
                    color: formatted.color,
                    bgcolor: isDark ? "rgba(100, 100, 100, 0.15)" : "rgba(150, 150, 150, 0.12)",
                    textTransform: "uppercase",
                  }}
                >
                  {formatted.type}
                </Chip>
                <Typography sx={{ fontFamily: "code", fontSize: "0.6rem", color: "text.tertiary" }}>
                  {formatRelativeTime(log.createdAt)}
                </Typography>
              </Box>
              <Typography
                sx={{
                  fontFamily: "code",
                  fontSize: "0.7rem",
                  color: "text.secondary",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {formatted.content}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
```

#### 5. Add Main Tab Navigation (Collapsed View)

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: Replace the collapsed content section (around line 799-803)

Replace:
```typescript
<Box sx={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
  <DetailsSection showProgress={true} />
  <CollapsedOutputSection />
</Box>
```

With:
```typescript
<Box sx={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
  <Tabs
    value={mainTab}
    onChange={(_, value) => setMainTab(value as "details" | "session")}
    sx={{ flexShrink: 0 }}
  >
    <TabList sx={getTabListStyles(colors.gold)}>
      <Tab value="details">DETAILS</Tab>
      <Tab value="session">
        SESSION LOG
        {sessionLogs && sessionLogs.length > 0 && (
          <Chip
            size="sm"
            sx={{
              ml: 0.5,
              fontFamily: "code",
              fontSize: "0.55rem",
              minHeight: "auto",
              height: 14,
              bgcolor: colors.goldSoftBg,
              color: colors.gold,
            }}
          >
            {sessionLogs.length}
          </Chip>
        )}
      </Tab>
    </TabList>
    <TabPanel value="details" sx={{ p: 0, flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <DetailsSection showProgress={true} />
      <CollapsedOutputSection />
    </TabPanel>
    <TabPanel value="session" sx={{ p: 0, flex: 1, overflow: "hidden" }}>
      <SessionLogContent />
    </TabPanel>
  </Tabs>
</Box>
```

#### 6. Add Session Log Column to Expanded View

**File**: `ui/src/components/TaskDetailPanel.tsx`
**Location**: In the expanded view section (around line 758-797), add a fourth column

After the Output/Error column, add:
```typescript
{/* Column 4: Session Log */}
<Box
  sx={{
    width: 400,
    flexShrink: 0,
    borderLeft: "1px solid",
    borderColor: "neutral.outlinedBorder",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  }}
>
  <Box sx={{ px: 2, py: 1.5, bgcolor: "background.level1", flexShrink: 0 }}>
    <Typography
      sx={{
        fontFamily: "code",
        fontSize: "0.7rem",
        color: "text.tertiary",
        letterSpacing: "0.05em",
      }}
    >
      SESSION LOG ({sessionLogs?.length || 0})
    </Typography>
  </Box>
  <SessionLogContent />
</Box>
```

### Success Criteria

#### Automated Verification:
- [x] TypeScript compiles without errors: `cd ui && bun run tsc`
- [x] No ESLint errors: `cd ui && bun run lint` (no lint script configured)

#### Manual Verification:
- [ ] Start frontend: `cd ui && bun run dev`
- [ ] Open task details for a task with session logs
- [ ] Verify "Session Log" tab appears and shows formatted entries
- [ ] Verify collapsed and expanded views both show session logs
- [ ] Verify log entries are color-coded by type

---

## Testing Strategy

### Unit Tests

Add tests for the database functions:

**File**: `src/tests/session-logs.test.ts`

```typescript
import { expect, test, beforeAll, afterAll } from "bun:test";
import { createSessionLogs, getSessionLogsByTaskId } from "../be/db";

test("creates and retrieves session logs", () => {
  const taskId = crypto.randomUUID();

  createSessionLogs({
    taskId,
    sessionId: "test-session",
    iteration: 1,
    cli: "claude",
    lines: ['{"type":"system"}', '{"type":"assistant"}'],
  });

  const logs = getSessionLogsByTaskId(taskId);
  expect(logs.length).toBe(2);
  expect(logs[0].content).toBe('{"type":"system"}');
  expect(logs[1].content).toBe('{"type":"assistant"}');
});
```

### Integration Tests

Test the API endpoints:

```bash
# POST session logs
curl -X POST http://localhost:3013/api/session-logs \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-123",
    "iteration": 1,
    "taskId": "<valid-task-id>",
    "cli": "claude",
    "lines": ["{\"type\":\"system\"}", "{\"type\":\"result\"}"]
  }'

# GET session logs for task
curl http://localhost:3013/api/tasks/<task-id>/session-logs
```

### Manual Testing Steps

1. Start MCP server: `bun run mcp`
2. Start worker in polling mode
3. Create a task and let Claude work on it
4. Open task in dashboard
5. Verify "Session Log" tab appears with entries
6. Check log entries are formatted correctly
7. Verify activity feed does NOT show session log entries

## Performance Considerations

- **Buffer size of 50 lines**: Balances real-time visibility with HTTP overhead
- **5-second flush interval**: Ensures logs appear even during slow operations
- **Indexed queries**: `taskId` and `sessionId` are indexed for fast lookups
- **Frontend polling every 5s**: Provides near-real-time updates without WebSocket complexity

## Migration Notes

- **New table**: No migration needed, table is created on startup
- **Backwards compatible**: Existing tasks without session logs show "No session logs available"
- **AI-loop mode**: Logs will be captured but without `taskId` (acceptable trade-off)

## References

- Runner implementation: `src/commands/runner.ts:170-249`
- HTTP API: `src/http.ts:277-355`
- TaskDetailPanel: `ui/src/components/TaskDetailPanel.tsx`
- Existing log types: `src/types.ts:141-173`
- Pretty-print reference: `src/utils/pretty-print.ts:73-235`
