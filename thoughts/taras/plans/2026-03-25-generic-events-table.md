---
date: 2026-03-25T20:00:00Z
topic: "Generic Events Table"
status: completed
autonomy: autopilot
---

# Generic Events Table

## Goal

Add a generic `events` table to agent-swarm for tracking tool call usage, skill invocations, and other measurable signals from harnesses. Designed to be forward-compatible with Datadog/Grafana export.

## Context

Currently we have:
- `agent_log` — lifecycle events (task_created, agent_joined, etc.) — too high-level for tool/skill tracking
- `session_costs` — aggregate token/cost per session — no per-tool breakdown
- `session_logs` — raw JSON lines from CLI — unstructured, requires parsing
- `ProviderEvent.tool_start` — emitted by adapters but only used for throttled progress text, never persisted

We need a structured, queryable events table that captures tool calls, skill invocations, and is extensible for future metric types without new migrations.

## Design Decisions

1. **Generic table with typed columns** — `category` + `event` as indexed TEXT (fast GROUP BY), `data` as JSON (flexible payload). Not a typed-per-metric table.
2. **Batch ingestion from workers** — workers buffer events in-memory, flush periodically via POST (same pattern as session logs).
3. **No `tool_end` emission yet** — Claude adapter doesn't emit `tool_end` today. Phase 1 captures `tool_start` only. Phase 2 can add duration tracking when adapter support lands.
4. **Next migration**: `021_events.sql`
5. **Follow `createSessionCost` pattern** (Pattern B) — `.run()` with no RETURNING, reconstruct locally. High-volume inserts don't need DB round-trips.
6. **Client-side timestamp in `data`** — workers include `clientTimestamp` in the `data` JSON for ordering within batches. The `createdAt` column is set server-side on insert.
7. **Lean event data** — only store key identifiers (toolName, filePath, pattern, skillName), not full args blobs. Use `extractToolKey()` helper to select the right field per tool.

---

## Phase 1: Schema + Types + DB Functions

### Files to create/modify

| File | Action |
|------|--------|
| `src/be/migrations/021_events.sql` | Create |
| `src/types.ts` | Add Zod schemas + TS types |
| `src/be/events.ts` | Create — CRUD functions (separate from db.ts to keep it manageable) |

### Migration: `021_events.sql`

```sql
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    source TEXT NOT NULL,
    agentId TEXT,
    taskId TEXT,
    sessionId TEXT,
    parentEventId TEXT,
    numericValue REAL,
    durationMs INTEGER,
    data TEXT,
    createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_agentId ON events(agentId);
CREATE INDEX IF NOT EXISTS idx_events_taskId ON events(taskId);
CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId);
CREATE INDEX IF NOT EXISTS idx_events_createdAt ON events(createdAt);
```

### Types: `src/types.ts`

Add after the `SessionCost` section:

```typescript
// -- Events --

export const EventCategorySchema = z.enum([
  "tool",
  "skill",
  "session",
  "api",
  "task",
  "workflow",
  "system",
]);

export const EventStatusSchema = z.enum(["ok", "error", "timeout", "skipped"]);

export const EventSourceSchema = z.enum(["worker", "api", "hook", "scheduler", "cli"]);

export const EventNameSchema = z.enum([
  // Tool events
  "tool.start",
  "tool.end",
  // Skill events
  "skill.invoke",
  "skill.complete",
  // Session events
  "session.start",
  "session.end",
  "session.resume",
  "session.cost",
  // API events
  "api.request",
  "api.error",
  // Task events
  "task.poll",
  "task.assign",
  "task.timeout",
  // Workflow events
  "workflow.step.start",
  "workflow.step.end",
  "workflow.run.start",
  "workflow.run.end",
  // System events
  "system.boot",
  "system.migration",
  "system.error",
]);

export const SwarmEventSchema = z.object({
  id: z.uuid(),
  category: EventCategorySchema,
  event: EventNameSchema,
  status: EventStatusSchema,
  source: EventSourceSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  parentEventId: z.string().optional(),
  numericValue: z.number().optional(),
  durationMs: z.number().int().optional(),
  data: z.record(z.unknown()).optional(),
  createdAt: z.iso.datetime(),
});

export type EventCategory = z.infer<typeof EventCategorySchema>;
export type EventStatus = z.infer<typeof EventStatusSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventName = z.infer<typeof EventNameSchema>;
export type SwarmEvent = z.infer<typeof SwarmEventSchema>;
```

### DB Functions: `src/be/events.ts`

Separate file (not in db.ts) — imports `getDb()` from `./db`. Follows the `sessionCostQueries` pattern:

```typescript
// -- Events --

type EventRow = {
  id: string;
  category: string;
  event: string;
  status: string;
  source: string;
  agentId: string | null;
  taskId: string | null;
  sessionId: string | null;
  parentEventId: string | null;
  numericValue: number | null;
  durationMs: number | null;
  data: string | null;
  createdAt: string;
};

function rowToSwarmEvent(row: EventRow): SwarmEvent {
  return {
    id: row.id,
    category: row.category as EventCategory,
    event: row.event as EventName,
    status: row.status as EventStatus,
    source: row.source as EventSource,
    agentId: row.agentId ?? undefined,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    parentEventId: row.parentEventId ?? undefined,
    numericValue: row.numericValue ?? undefined,
    durationMs: row.durationMs ?? undefined,
    data: row.data ? JSON.parse(row.data) : undefined,
    createdAt: row.createdAt,
  };
}

const eventQueries = {
  insert: () =>
    getDb().prepare<
      null,
      [string, string, string, string, string, string | null, string | null,
       string | null, string | null, number | null, number | null, string | null]
    >(
      `INSERT INTO events (id, category, event, status, source, agentId, taskId,
       sessionId, parentEventId, numericValue, durationMs, data, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByCategory: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE category = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByEvent: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE event = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByAgentId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByTaskId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getBySessionId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getAll: () =>
    getDb().prepare<EventRow, [number]>(
      "SELECT * FROM events ORDER BY createdAt DESC LIMIT ?",
    ),

  countByEvent: () =>
    getDb().prepare<{ event: string; count: number }, []>(
      "SELECT event, COUNT(*) as count FROM events GROUP BY event ORDER BY count DESC",
    ),

  countByEventForAgent: () =>
    getDb().prepare<{ event: string; count: number }, [string]>(
      "SELECT event, COUNT(*) as count FROM events WHERE agentId = ? GROUP BY event ORDER BY count DESC",
    ),
};
```

**Create function** — single event:

```typescript
export interface CreateEventInput {
  category: EventCategory;
  event: EventName;
  status?: EventStatus;
  source: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  parentEventId?: string;
  numericValue?: number;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export function createEvent(input: CreateEventInput): SwarmEvent {
  const id = crypto.randomUUID();
  eventQueries.insert().run(
    id,
    input.category,
    input.event,
    input.status ?? "ok",
    input.source,
    input.agentId ?? null,
    input.taskId ?? null,
    input.sessionId ?? null,
    input.parentEventId ?? null,
    input.numericValue ?? null,
    input.durationMs ?? null,
    input.data ? JSON.stringify(input.data) : null,
  );
  return {
    id,
    category: input.category,
    event: input.event,
    status: input.status ?? "ok",
    source: input.source,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    parentEventId: input.parentEventId,
    numericValue: input.numericValue,
    durationMs: input.durationMs,
    data: input.data,
    createdAt: new Date().toISOString(),
  };
}
```

**Batch create** — for worker flush (wraps in transaction):

```typescript
export function createEventsBatch(inputs: CreateEventInput[]): number {
  const insert = eventQueries.insert();
  const tx = getDb().transaction(() => {
    for (const input of inputs) {
      const id = crypto.randomUUID();
      insert.run(
        id,
        input.category,
        input.event,
        input.status ?? "ok",
        input.source,
        input.agentId ?? null,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.parentEventId ?? null,
        input.numericValue ?? null,
        input.durationMs ?? null,
        input.data ? JSON.stringify(input.data) : null,
      );
    }
  });
  tx();
  return inputs.length;
}
```

**Query functions:**

```typescript
export function getEventsByCategory(category: EventCategory, limit = 100): SwarmEvent[] {
  return eventQueries.getByCategory().all(category, limit).map(rowToSwarmEvent);
}

export function getEventsByEvent(event: EventName, limit = 100): SwarmEvent[] {
  return eventQueries.getByEvent().all(event, limit).map(rowToSwarmEvent);
}

export function getEventsByAgentId(agentId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getByAgentId().all(agentId, limit).map(rowToSwarmEvent);
}

export function getEventsByTaskId(taskId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getByTaskId().all(taskId, limit).map(rowToSwarmEvent);
}

export function getEventsBySessionId(sessionId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getBySessionId().all(sessionId, limit).map(rowToSwarmEvent);
}

export function getAllEvents(limit = 100): SwarmEvent[] {
  return eventQueries.getAll().all(limit).map(rowToSwarmEvent);
}

export function getEventCounts(): Array<{ event: string; count: number }> {
  return eventQueries.countByEvent().all();
}

export function getEventCountsForAgent(agentId: string): Array<{ event: string; count: number }> {
  return eventQueries.countByEventForAgent().all(agentId);
}

export function getEventCountsFiltered(filters: {
  category?: EventCategory;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
}): Array<{ event: string; count: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.category) { conditions.push("category = ?"); params.push(filters.category); }
  if (filters.source) { conditions.push("source = ?"); params.push(filters.source); }
  if (filters.agentId) { conditions.push("agentId = ?"); params.push(filters.agentId); }
  if (filters.taskId) { conditions.push("taskId = ?"); params.push(filters.taskId); }
  if (filters.sessionId) { conditions.push("sessionId = ?"); params.push(filters.sessionId); }
  if (filters.since) { conditions.push("createdAt >= ?"); params.push(filters.since); }
  if (filters.until) { conditions.push("createdAt <= ?"); params.push(filters.until); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT event, COUNT(*) as count FROM events ${where} GROUP BY event ORDER BY count DESC`;
  return getDb().prepare<{ event: string; count: number }, (string | number)[]>(sql).all(...params);
}
```

**Filtered query** (for dashboard — date range, multi-filter):

```typescript
export function getEventsFiltered(filters: {
  category?: EventCategory;
  event?: EventName;
  status?: EventStatus;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
  limit?: number;
}): SwarmEvent[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.category) { conditions.push("category = ?"); params.push(filters.category); }
  if (filters.event) { conditions.push("event = ?"); params.push(filters.event); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  if (filters.source) { conditions.push("source = ?"); params.push(filters.source); }
  if (filters.agentId) { conditions.push("agentId = ?"); params.push(filters.agentId); }
  if (filters.taskId) { conditions.push("taskId = ?"); params.push(filters.taskId); }
  if (filters.sessionId) { conditions.push("sessionId = ?"); params.push(filters.sessionId); }
  if (filters.since) { conditions.push("createdAt >= ?"); params.push(filters.since); }
  if (filters.until) { conditions.push("createdAt <= ?"); params.push(filters.until); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;
  params.push(limit);

  const sql = `SELECT * FROM events ${where} ORDER BY createdAt DESC LIMIT ?`;
  return getDb().prepare<EventRow, (string | number)[]>(sql).all(...params).map(rowToSwarmEvent);
}
```

### Verification

```bash
# Fresh DB test
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
sleep 2
# Check table exists
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/events | jq .
kill $(lsof -ti :3013)

# Type check
bun run tsc:check

# Lint
bun run lint:fix
```

---

## Phase 2: HTTP Endpoints

### Files to create/modify

| File | Action |
|------|--------|
| `src/http/events.ts` | Create — POST + GET endpoints |
| `src/http/index.ts` | Add handler to chain |
| `scripts/generate-openapi.ts` | Add import |

### Endpoints

**POST /api/events** — Single event ingestion

```typescript
const createEventRoute = route({
  method: "post",
  path: "/api/events",
  pattern: ["api", "events"],
  summary: "Store a single event",
  tags: ["Events"],
  body: z.object({
    category: EventCategorySchema,
    event: EventNameSchema,
    status: EventStatusSchema.optional(),
    source: EventSourceSchema,
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    parentEventId: z.string().optional(),
    numericValue: z.number().optional(),
    durationMs: z.number().int().optional(),
    data: z.record(z.unknown()).optional(),
  }),
  responses: {
    201: { description: "Event stored" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});
```

**POST /api/events/batch** — Batch ingestion (worker flush)

```typescript
const createEventsBatchRoute = route({
  method: "post",
  path: "/api/events/batch",
  pattern: ["api", "events", "batch"],
  summary: "Store multiple events in a batch",
  tags: ["Events"],
  body: z.object({
    events: z.array(z.object({
      category: EventCategorySchema,
      event: EventNameSchema,
      status: EventStatusSchema.optional(),
      source: EventSourceSchema,
      agentId: z.string().optional(),
      taskId: z.string().optional(),
      sessionId: z.string().optional(),
      parentEventId: z.string().optional(),
      numericValue: z.number().optional(),
      durationMs: z.number().int().optional(),
      data: z.record(z.unknown()).optional(),
    })).min(1).max(500),
  }),
  responses: {
    201: { description: "Events stored" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});
```

**GET /api/events** — Query events (dashboard + API)

```typescript
const getEventsRoute = route({
  method: "get",
  path: "/api/events",
  pattern: ["api", "events"],
  summary: "Query events with filters",
  tags: ["Events"],
  query: z.object({
    category: EventCategorySchema.optional(),
    event: EventNameSchema.optional(),
    status: EventStatusSchema.optional(),
    source: EventSourceSchema.optional(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: { description: "List of events" },
  },
  auth: { apiKey: true },
});
```

**GET /api/events/counts** — Aggregated counts (dashboard charts)

```typescript
const getEventCountsRoute = route({
  method: "get",
  path: "/api/events/counts",
  pattern: ["api", "events", "counts"],
  summary: "Get event counts grouped by event name",
  tags: ["Events"],
  query: z.object({
    category: EventCategorySchema.optional(),
    source: EventSourceSchema.optional(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  }),
  responses: {
    200: { description: "Event counts" },
  },
  auth: { apiKey: true },
});
```

### Handler integration

In `src/http/index.ts`:
```typescript
import { handleEvents } from "./events";
// Add to handlers array:
() => handleEvents(req, res, pathSegments, queryParams, myAgentId),
```

In `scripts/generate-openapi.ts`:
```typescript
import "../src/http/events";
```

### Verification

```bash
# Start server
bun run start:http &
sleep 2

# POST single event
curl -s -X POST http://localhost:3013/api/events \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"category":"tool","event":"tool.start","source":"worker","agentId":"test-agent","data":{"toolName":"Read","args":{"file_path":"/tmp/test.txt"}}}' | jq .

# POST batch
curl -s -X POST http://localhost:3013/api/events/batch \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"category":"tool","event":"tool.start","source":"worker","data":{"toolName":"Bash"}},{"category":"skill","event":"skill.invoke","source":"worker","data":{"skillName":"commit"}}]}' | jq .

# GET with filters
curl -s "http://localhost:3013/api/events?category=tool&limit=10" \
  -H "Authorization: Bearer 123123" | jq .

# GET counts
curl -s "http://localhost:3013/api/events/counts" \
  -H "Authorization: Bearer 123123" | jq .

# Regenerate OpenAPI spec
bun run docs:openapi

kill $(lsof -ti :3013)
```

---

## Phase 3: Worker-Side Event Emission

### Files to modify

| File | Action |
|------|--------|
| `src/commands/runner.ts` | Add event buffering + flush + emit on tool_start/skill |

### Design

Add an event buffer in the runner, similar to how session logs are buffered and flushed:

```typescript
// Event buffer (flushes to API periodically)
const eventBuffer: CreateEventInput[] = [];
const EVENT_FLUSH_INTERVAL_MS = 5000; // 5 seconds
const EVENT_BUFFER_MAX = 50; // flush if buffer exceeds this

function bufferEvent(event: CreateEventInput) {
  eventBuffer.push(event);
  if (eventBuffer.length >= EVENT_BUFFER_MAX) {
    flushEvents();
  }
}

async function flushEvents() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  try {
    await fetch(`${opts.apiUrl}/api/events/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        "X-Agent-ID": opts.agentId,
      },
      body: JSON.stringify({ events: batch }),
    });
  } catch {
    // Non-blocking — event loss is acceptable
  }
}

// Periodic flush
const eventFlushTimer = setInterval(flushEvents, EVENT_FLUSH_INTERVAL_MS);
// Clean up on session end
// clearInterval(eventFlushTimer); await flushEvents();
```

### Event emission points in runner

**1. `case "tool_start"`** (line ~1466):

```typescript
case "tool_start": {
  // Existing progress logic...

  // NEW: buffer tool event
  bufferEvent({
    category: "tool",
    event: "tool.start",
    source: "worker",
    agentId: opts.agentId,
    taskId: effectiveTaskId,
    sessionId: opts.sessionId,
    data: {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      ...extractToolKey(event.toolName, event.args),
      clientTimestamp: new Date().toISOString(),
    },
  });
  break;
}
```

**`extractToolKey` helper** — pulls only the identifying key from args, not the full payload:

```typescript
function extractToolKey(
  toolName: string,
  args: unknown,
): Record<string, string | undefined> {
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      return { filePath: a.file_path as string | undefined };
    case "Bash":
      return { description: a.description as string | undefined };
    case "Grep":
      return { pattern: a.pattern as string | undefined };
    case "Glob":
      return { pattern: a.pattern as string | undefined };
    case "Skill":
      return { skillName: a.skill as string | undefined };
    case "Agent":
      return { description: a.description as string | undefined };
    default:
      // MCP tools: just the tool name, no args
      return {};
  }
}
```

**2. Skill detection** — when `toolName === "Skill"`, also emit a skill event:

```typescript
if (event.toolName === "Skill") {
  const args = event.args as Record<string, unknown>;
  bufferEvent({
    category: "skill",
    event: "skill.invoke",
    source: "worker",
    agentId: opts.agentId,
    taskId: effectiveTaskId,
    sessionId: opts.sessionId,
    data: {
      skillName: args.skill as string,
      clientTimestamp: new Date().toISOString(),
    },
  });
}
```

**3. Session start/end** — emit session lifecycle events:

```typescript
// On session_init event:
bufferEvent({
  category: "session",
  event: "session.start",
  source: "worker",
  agentId: opts.agentId,
  taskId: effectiveTaskId,
  sessionId: event.sessionId,
});

// On result event (session end):
bufferEvent({
  category: "session",
  event: "session.end",
  source: "worker",
  agentId: opts.agentId,
  taskId: effectiveTaskId,
  sessionId: opts.sessionId,
  status: event.isError ? "error" : "ok",
  durationMs: Date.now() - sessionStartTime,
  data: {
    model: event.cost.model,
    totalCostUsd: event.cost.totalCostUsd,
    inputTokens: event.cost.inputTokens,
    outputTokens: event.cost.outputTokens,
  },
});
```

### Verification

```bash
# Full E2E: API + Docker worker
rm -f agent-swarm-db.sqlite*
bun run start:http &
sleep 2

# Build and run worker
bun run docker:build:worker
docker run --rm -d --name e2e-events-test \
  --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3203:3000 agent-swarm-worker:latest

# Create a trivial task
curl -s -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d '{"title":"Say hi","description":"Just say hello"}' | jq .

# Wait for task completion (~30s), then check events
sleep 30
curl -s "http://localhost:3013/api/events?category=tool&limit=20" \
  -H "Authorization: Bearer 123123" | jq '.events[] | {event, data}'

curl -s "http://localhost:3013/api/events/counts" \
  -H "Authorization: Bearer 123123" | jq .

# Cleanup
docker stop e2e-events-test
kill $(lsof -ti :3013)
```

---

## Phase 4: Pre-PR Checklist

```bash
# Lint + format
bun run lint:fix

# Type check
bun run tsc:check

# Unit tests
bun test

# DB boundary check
bash scripts/check-db-boundary.sh

# OpenAPI spec
bun run docs:openapi

# Fresh DB migration test
rm -f agent-swarm-db.sqlite*
bun run start:http &
sleep 2
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/events | jq .
kill $(lsof -ti :3013)
```

---

## Out of Scope (Future)

- **`tool_end` events with duration** — requires Claude adapter changes to emit `tool_end`
- **API request events** — instrument `src/http/index.ts` to emit `api.request` events
- **Datadog/Grafana drain** — export events to external backends
- **Dashboard UI** — charts/tables in new-ui for event analytics
- **Event retention/cleanup** — periodic purge of old events (cron job)
- **Workflow step events** — instrument workflow executor
