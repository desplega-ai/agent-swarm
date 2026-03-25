---
date: 2026-03-25T18:00:00Z
topic: "Context Window Usage Tracking"
type: plan
status: completed
research: thoughts/taras/research/2026-03-25-context-usage-tracking.md
---

# Context Window Usage Tracking — Implementation Plan

## Overview

Track context window usage per task progressively, including per-turn snapshots, compaction counting, and peak usage. Data collected from both Claude Code (stream-json `assistant` events + `compact_boundary`) and Pi-mono (`ctx.getContextUsage()`), stored via a new `task_context_snapshots` table and aggregate columns on `agent_tasks`.

## Current State Analysis

- **Token tracking exists** via `session_costs` table — cumulative per-session, posted at session end
- **No per-turn context tracking** — `claude-adapter.ts:317-334` processes `assistant` events but only extracts `tool_use` blocks; `message.usage` is ignored
- **No compaction tracking** — `compact_boundary` events from stream-json are not parsed; PreCompact hook only injects goal reminders
- **Pi-mono has unused context data** — `pi-mono-extension.ts:565` ignores `ctx.getContextUsage()` (parameter prefixed with `_ctx`)
- **`modelUsage.contextWindow` from `result` events is not extracted** — adapter only reads cumulative token counts

### Key Discoveries:
- Claude stream-json emits `SDKCompactBoundaryMessage` with `compact_metadata.pre_tokens` and `compact_metadata.trigger` — explicit compaction signal with pre-compaction token count (`claude-adapter.ts` does not parse this)
- Claude `assistant` events include per-turn `message.usage` with `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` = context tokens in use
- Pi-mono `ctx.getContextUsage()` returns `{ tokens, contextWindow, percent }` at every event
- `result` event includes `modelUsage[model].contextWindow` — authoritative context window size (differs from model defaults; e.g., Opus without 1M beta shows 200K)

## Desired End State

Every task tracks:
1. **Progressive context snapshots** — per-turn `{used}/{total} ({pct}%)` stored in `task_context_snapshots`
2. **Compaction count** — incremented on each `compact_boundary` (Claude) or `context` event (Pi-mono)
3. **Peak context %** — highest percentage reached during the task
4. **Context window size** — model's max context window (runtime-detected, fallback lookup)
5. **Snapshot history** — queryable via `GET /api/tasks/:id/context`

Both providers emit a unified `context_usage` ProviderEvent that the runner forwards to a new `POST /api/tasks/:id/context` endpoint. Pi-mono extension also posts directly for compaction events.

## Quick Verification Reference

- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bash scripts/check-db-boundary.sh` — Worker/API DB boundary

Key files:
- `src/be/migrations/021_context_usage.sql`
- `src/be/db.ts` (new context snapshot functions)
- `src/http/context.ts` (new endpoint file)
- `src/types.ts` (new schemas)
- `src/providers/claude-adapter.ts` (extract usage + compaction)
- `src/providers/pi-mono-extension.ts` (extract ctx.getContextUsage())
- `src/providers/types.ts` (new ProviderEvent types)
- `src/commands/runner.ts` (forward events to API)
- `src/utils/context-window.ts` (model → size lookup)

## What We're NOT Doing

- **Historical backfill** — not estimating context data for existing completed tasks
- **UI visualization** — dashboard charts/timeline are a separate follow-up
- **store-progress extension** — self-reported context from MCP tool is deferred (adapters provide automatic collection, making self-reporting unnecessary for now)
- **PreCompact hook modification** — `compact_boundary` stream-json events provide richer data (pre_tokens, trigger) than what the hook could offer
- **Per-model context window caching in DB** — use in-memory lookup + runtime override from `result` events; not worth a table

## Implementation Approach

Six phases, ordered by dependency:

1. **Schema & Types** — DB migration + Zod schemas + row types + DB functions + context window lookup
2. **API Endpoints** — `POST/GET /api/tasks/:id/context` + task response enrichment
3. **Claude Adapter** — extract `message.usage`, `compact_boundary`, `modelUsage.contextWindow`
4. **Pi-Mono Extension** — extract `ctx.getContextUsage()` in `context` and `tool_result` events
5. **Runner Integration** — forward adapter events to API with throttling
6. **End-to-End Verification** — local E2E with Docker containers

---

## Phase 1: Schema, Types & DB Functions

### Overview
Create the database schema, TypeScript types, row converters, and CRUD functions for context snapshots. Also create the shared context window size lookup utility.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/021_context_usage.sql`
**Changes**: New migration with:

```sql
-- Progressive context usage snapshots
CREATE TABLE IF NOT EXISTS task_context_snapshots (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sessionId TEXT NOT NULL,

    -- Context window state
    contextUsedTokens INTEGER,
    contextTotalTokens INTEGER NOT NULL,
    contextPercent REAL,

    -- Event metadata
    eventType TEXT NOT NULL CHECK (eventType IN ('progress', 'compaction', 'completion')),

    -- Compaction-specific (NULL for non-compaction)
    compactTrigger TEXT CHECK (compactTrigger IN ('auto', 'manual') OR compactTrigger IS NULL),
    preCompactTokens INTEGER,

    -- Cumulative counters at this point
    cumulativeInputTokens INTEGER DEFAULT 0,
    cumulativeOutputTokens INTEGER DEFAULT 0,

    createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON task_context_snapshots(taskId);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON task_context_snapshots(sessionId);

-- Aggregate columns on agent_tasks
ALTER TABLE agent_tasks ADD COLUMN compactionCount INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN peakContextPercent REAL;
ALTER TABLE agent_tasks ADD COLUMN totalContextTokensUsed INTEGER;
ALTER TABLE agent_tasks ADD COLUMN contextWindowSize INTEGER;
```

#### 2. Zod Schemas
**File**: `src/types.ts`
**Changes**: Add after SessionCostSchema:

- `ContextSnapshotEventTypeSchema` — `z.enum(["progress", "compaction", "completion"])`
- `ContextSnapshotSchema` — full schema matching the table columns
- Update `AgentTaskSchema` with 4 new optional fields: `compactionCount`, `peakContextPercent`, `totalContextTokensUsed`, `contextWindowSize`

#### 3. Row Type & Converter
**File**: `src/be/db.ts`
**Changes**: Add `ContextSnapshotRow` interface and `rowToContextSnapshot()` converter following the existing pattern (e.g., `SessionCostRow`/`rowToSessionCost` at db.ts:3251-3285). Update `AgentTaskRow` with the 4 new nullable columns. Update `rowToAgentTask()` to map them.

#### 4. DB CRUD Functions
**File**: `src/be/db.ts`
**Changes**: Add query object and functions:

- `contextSnapshotQueries` — `insert`, `getByTaskId`, `getBySessionId`
- `createContextSnapshot(input)` — inserts row, conditionally updates `agent_tasks`:
  - Always: update `peakContextPercent` if new percent > current
  - If `compaction`: increment `compactionCount`
  - If `completion`: set `totalContextTokensUsed`, `contextWindowSize`
- `getContextSnapshotsByTaskId(taskId, limit?)` — returns snapshots ordered by createdAt
- `getContextSummaryByTaskId(taskId)` — returns aggregate: `{ compactionCount, peakContextPercent, totalContextTokensUsed, contextWindowSize, snapshotCount }`

#### 5. Context Window Lookup Utility
**File**: `src/utils/context-window.ts` (new file)
**Changes**: Shared module (no DB imports — safe for worker/API boundary):

```typescript
const CONTEXT_WINDOW_DEFAULTS: Record<string, number> = {
  "claude-opus-4-6": 200_000,    // 1M requires beta opt-in
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "opus": 200_000,
  "sonnet": 200_000,
  "haiku": 200_000,
  "default": 200_000,
};

export function getContextWindowSize(model: string): number;
export function computeContextUsed(usage: {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number;
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Fresh DB works: `rm -f agent-swarm-db.sqlite* && bun run src/http.ts` (starts without errors, Ctrl+C)
- [x] Existing DB migrates: `bun run src/http.ts` against a pre-existing DB (starts without errors)

#### Manual Verification:
- [ ] Inspect the created DB: `sqlite3 agent-swarm-db.sqlite ".schema task_context_snapshots"` — table exists with correct columns
- [ ] Inspect agent_tasks: `sqlite3 agent-swarm-db.sqlite ".schema agent_tasks"` — has the 4 new columns
- [ ] Context window lookup returns correct values for known models

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: API Endpoints

### Overview
Create the HTTP endpoints for posting and reading context snapshots. Enrich the existing task GET response with context fields.

### Changes Required:

#### 1. New Route Handler
**File**: `src/http/context.ts` (new file)
**Changes**: Create using `route()` factory pattern from `route-def.ts`:

**POST /api/tasks/:id/context** — receives context snapshot data:
```typescript
const postContextRoute = route({
  method: "post",
  path: "/api/tasks/{id}/context",
  pattern: ["api", "tasks", null, "context"],
  summary: "Record a context usage snapshot for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    eventType: ContextSnapshotEventTypeSchema,
    sessionId: z.string(),
    contextUsedTokens: z.number().int().min(0).optional(),
    contextTotalTokens: z.number().int().min(0).optional(),
    contextPercent: z.number().min(0).max(100).optional(),
    compactTrigger: z.enum(["auto", "manual"]).optional(),
    preCompactTokens: z.number().int().min(0).optional(),
    cumulativeInputTokens: z.number().int().min(0).optional(),
    cumulativeOutputTokens: z.number().int().min(0).optional(),
  }),
  responses: {
    200: { description: "Snapshot recorded" },
    400: { description: "Validation error" },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true, agentId: true },
});
```

Handler logic:
- Validate task exists via `getTaskById`
- Call `createContextSnapshot()` from db.ts
- Return `{ ok: true, snapshotId }`

**GET /api/tasks/:id/context** — returns snapshot history:
```typescript
const getContextRoute = route({
  method: "get",
  path: "/api/tasks/{id}/context",
  pattern: ["api", "tasks", null, "context"],
  summary: "Get context usage history for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  responses: {
    200: { description: "Context snapshot history" },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});
```

Handler logic:
- Validate task exists
- Call `getContextSnapshotsByTaskId(taskId, limit)`
- Return `{ snapshots, summary: getContextSummaryByTaskId(taskId) }`

#### 2. Register Handler
**File**: `src/http/index.ts`
**Changes**: Import `handleContext` and add to handler chain (after `handleTasks`).

#### 3. OpenAPI Generation
**File**: `scripts/generate-openapi.ts`
**Changes**: Import the context route file so routes are registered in the spec.

#### 4. Task Response Enrichment
**File**: `src/http/tasks.ts`
**Changes**: The task object already includes all fields from `rowToAgentTask()`. Since Phase 1 adds the 4 new columns to `AgentTaskRow` and `rowToAgentTask()`, they'll be included automatically. No changes needed here.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] OpenAPI spec regenerates: `bun run docs:openapi` (no errors)
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] POST a test snapshot: `curl -s -X POST -H "Authorization: Bearer 123123" -H "X-Agent-ID: <test-uuid>" -H "Content-Type: application/json" http://localhost:3013/api/tasks/<task-id>/context -d '{"eventType":"progress","sessionId":"test-123","contextUsedTokens":50000,"contextTotalTokens":200000,"contextPercent":25.0}'` — returns `{ ok: true }`
- [ ] GET snapshots: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<task-id>/context` — returns the posted snapshot
- [ ] GET task includes new fields: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<task-id>` — includes `peakContextPercent: 25.0`
- [ ] POST compaction increments count: Post `eventType:"compaction"` and verify `compactionCount` increases on task

**Implementation Note**: After completing this phase, pause for manual confirmation. Start the API server (`bun run start:http`), create a test task, and exercise both endpoints.

---

## Phase 3: Claude Adapter — Context Usage Extraction

### Overview
Modify the Claude adapter to extract per-turn context usage from `assistant` events, detect compaction from `compact_boundary` events, and capture context window size from `result` events. Emit new `ProviderEvent` types.

### Changes Required:

#### 1. New ProviderEvent Types
**File**: `src/providers/types.ts`
**Changes**: Extend the `ProviderEvent` union (currently has `session_init`, `result`, `tool_start`, `raw_log`, `raw_stderr`) with:

```typescript
| {
    type: "context_usage";
    contextUsedTokens: number;
    contextTotalTokens: number;
    contextPercent: number;
    outputTokens: number;
  }
| {
    type: "compaction";
    preCompactTokens: number;
    compactTrigger: "auto" | "manual";
    contextTotalTokens: number;
  }
```

#### 2. Extract message.usage from assistant events
**File**: `src/providers/claude-adapter.ts`
**Changes**: In `processJsonLine()` at line ~317 (the `assistant` event handler), AFTER the existing `tool_use` extraction, add usage extraction:

```typescript
// After existing tool_use block extraction (line ~334)
if (json.message?.usage) {
  const usage = json.message.usage;
  const contextUsed = computeContextUsed(usage);
  const contextTotal = this.contextWindowSize;

  this.emit({
    type: "context_usage",
    contextUsedTokens: contextUsed,
    contextTotalTokens: contextTotal,
    contextPercent: contextTotal > 0 ? (contextUsed / contextTotal) * 100 : 0,
    outputTokens: usage.output_tokens ?? 0,
  });
}
```

#### 3. Detect compact_boundary events
**File**: `src/providers/claude-adapter.ts`
**Changes**: In `processJsonLine()`, add a new check after the existing `system/init` check:

```typescript
if (json.type === "system" && json.subtype === "compact_boundary"
    && json.compact_metadata) {
  this.emit({
    type: "compaction",
    preCompactTokens: json.compact_metadata.pre_tokens ?? 0,
    compactTrigger: json.compact_metadata.trigger ?? "auto",
    contextTotalTokens: this.contextWindowSize,
  });
}
```

#### 4. Extract modelUsage.contextWindow from result events
**File**: `src/providers/claude-adapter.ts`
**Changes**: In the `result` event handler (line ~285), after building `CostData`, extract context window:

```typescript
if (json.modelUsage) {
  const modelKey = Object.keys(json.modelUsage)[0];
  if (modelKey && json.modelUsage[modelKey]?.contextWindow) {
    this.contextWindowSize = json.modelUsage[modelKey].contextWindow;
  }
}
```

#### 5. Track context window size on the session
**File**: `src/providers/claude-adapter.ts`
**Changes**: Add a `contextWindowSize` field to `ClaudeSession`:

```typescript
private contextWindowSize: number;
```

Initialize from lookup in constructor: `this.contextWindowSize = getContextWindowSize(model);`

Also update from `system/init` if model is available:
```typescript
// In system/init handler, after setting _sessionId
if (json.model) {
  this.contextWindowSize = getContextWindowSize(json.model);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Unit tests pass: `bun test`

#### Manual Verification:
- [ ] Verify new event types are emitted: temporarily add a `console.log` in the runner's `onEvent` handler for `context_usage` and `compaction` events, run a short task, confirm events appear in worker logs
- [ ] Check context_usage event has reasonable values (e.g., contextPercent between 0-100, contextUsedTokens > 0)

**Implementation Note**: After completing this phase, pause for manual confirmation. The events are emitted but not yet forwarded to the API — that happens in Phase 5.

---

## Phase 4: Pi-Mono Extension — Context Usage Extraction

### Overview
Modify the Pi-mono extension to extract context usage from `ctx.getContextUsage()` and post it directly to the API. The extension already has HTTP access to the API.

### Changes Required:

#### 1. Extract context usage in `context` event
**File**: `src/providers/pi-mono-extension.ts`
**Changes**: In the `context` handler (line 565), replace `_ctx` with `ctx` and add context reporting:

```typescript
pi.on("context", async (_event, ctx) => {
  // Existing goal reminder code stays...

  // NEW: Report context usage as compaction event
  const usage = ctx.getContextUsage?.();
  if (config.taskId && usage) {
    fireAndForget(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        eventType: "compaction",
        sessionId: ctx.sessionManager?.getSessionId?.() ?? `pi-${config.taskId}`,
        contextUsedTokens: usage.tokens ?? undefined,
        contextTotalTokens: usage.contextWindow,
        contextPercent: usage.percent ?? undefined,
      }),
    });
  }
});
```

#### 2. Extract context usage in `tool_result` event (per-turn tracking)
**File**: `src/providers/pi-mono-extension.ts`
**Changes**: In the `tool_result` handler (line 482), replace `_ctx` with `ctx` and add throttled context reporting:

```typescript
// At the top of tool_result handler, after heartbeat
const usage = ctx.getContextUsage?.();
if (config.taskId && usage?.tokens != null) {
  const now = Date.now();
  if (now - lastContextPostTime >= 30_000) {
    lastContextPostTime = now;
    fireAndForget(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
      method: "POST",
      headers: apiHeaders(config),
      body: JSON.stringify({
        eventType: "progress",
        sessionId: ctx.sessionManager?.getSessionId?.() ?? `pi-${config.taskId}`,
        contextUsedTokens: usage.tokens,
        contextTotalTokens: usage.contextWindow,
        contextPercent: usage.percent,
      }),
    });
  }
}
```

Add `let lastContextPostTime = 0;` at the top of the factory function (inside `createSwarmHooksExtension`, before the event handlers).

#### 3. Post completion context on shutdown
**File**: `src/providers/pi-mono-extension.ts`
**Changes**: In `session_shutdown` (line 606), add context completion post before the existing sync calls:

```typescript
const usage = ctx.getContextUsage?.();
if (config.taskId && usage) {
  await fetch(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
    method: "POST",
    headers: apiHeaders(config),
    body: JSON.stringify({
      eventType: "completion",
      sessionId: ctx.sessionManager?.getSessionId?.() ?? `pi-${config.taskId}`,
      contextTotalTokens: usage.contextWindow,
      contextPercent: usage.percent ?? undefined,
      contextUsedTokens: usage.tokens ?? undefined,
    }),
  }).catch(() => {});
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] If a Pi-mono worker is available: run a task and verify snapshots appear in `GET /api/tasks/:id/context`
- [ ] If Pi-mono is not available: code review confirms correct `ctx.getContextUsage()` usage matches the types from `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

**Implementation Note**: Pi-mono availability depends on infrastructure. Code review is sufficient if Pi-mono cannot be tested locally.

---

## Phase 5: Runner Integration & Throttling

### Overview
Forward `context_usage` and `compaction` events from the Claude adapter to the API. Apply throttling (max 1 progress snapshot per 30s). Post completion context on session end.

### Changes Required:

#### 1. Handle new events in spawnProviderProcess
**File**: `src/commands/runner.ts`
**Changes**: In the `onEvent` handler at line ~1446, add cases for the new event types:

```typescript
// Add throttle state near line 1443 (alongside existing PROGRESS_THROTTLE_MS)
let lastContextPostTime = 0;
const CONTEXT_THROTTLE_MS = 30_000; // 30 seconds

// In the onEvent switch, add two new cases:

case "context_usage": {
  const now = Date.now();
  if (now - lastContextPostTime >= CONTEXT_THROTTLE_MS) {
    lastContextPostTime = now;
    fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-ID": opts.agentId,
        "Authorization": `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        eventType: "progress",
        sessionId: opts.runnerSessionId,
        contextUsedTokens: event.contextUsedTokens,
        contextTotalTokens: event.contextTotalTokens,
        contextPercent: event.contextPercent,
      }),
    }).catch(() => {});
  }
  break;
}

case "compaction": {
  // Always record compaction events (no throttle)
  fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": opts.agentId,
      "Authorization": `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      eventType: "compaction",
      sessionId: opts.runnerSessionId,
      preCompactTokens: event.preCompactTokens,
      compactTrigger: event.compactTrigger,
      contextTotalTokens: event.contextTotalTokens,
    }),
  }).catch(() => {});
  break;
}
```

#### 2. Post completion context on session end
**File**: `src/commands/runner.ts`
**Changes**: In the `.then()` handler on `waitForCompletion()` (around line 1552), after `saveCostData()`, post a completion context snapshot:

```typescript
// After saveCostData (line ~1563)
if (result.cost && realTaskId) {
  fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": opts.agentId,
      "Authorization": `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      eventType: "completion",
      sessionId: opts.runnerSessionId,
      cumulativeInputTokens: result.cost.inputTokens ?? 0,
      cumulativeOutputTokens: result.cost.outputTokens ?? 0,
      contextTotalTokens: getContextWindowSize(result.cost.model || "default"),
    }),
  }).catch(() => {});
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Unit tests pass: `bun test`

#### Manual Verification:
- [ ] Run a short Claude task via Docker worker against local API
- [ ] During task execution: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<task-id>/context | jq '.snapshots | length'` — shows increasing count
- [ ] After task completion: verify `eventType: "completion"` snapshot exists
- [ ] Verify `peakContextPercent` > 0 on the task: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<task-id> | jq '.peakContextPercent'`

**Implementation Note**: This phase requires a running API + Docker worker for full manual verification. Use the E2E testing flow from CLAUDE.md.

---

## Phase 6: End-to-End Verification

### Overview
Full E2E test with Docker containers to verify the complete flow works.

### Changes Required:

No new code — this phase is verification only.

### Success Criteria:

#### Automated Verification:
- [x] All checks pass: `bun run tsc:check && bun run lint:fix && bun test && bash scripts/check-db-boundary.sh`
- [x] OpenAPI spec is fresh: `bun run docs:openapi` (no uncommitted changes to `openapi.json`)

#### Manual Verification:

**E2E Test Steps:**
1. Clean DB and start API: `rm -f agent-swarm-db.sqlite* && bun run start:http &`
2. Build Docker image: `bun run docker:build:worker`
3. Start worker: `docker run --rm -d --name e2e-ctx-worker --env-file .env.docker -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest`
4. Create a trivial task: `curl -s -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/tasks -d '{"description":"Say hello and list 3 fun facts about cats","source":"manual"}'`
5. Wait for task to complete (~30s), then verify:
   - [ ] Task has context fields: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<id> | jq '{compactionCount, peakContextPercent, contextWindowSize}'`
   - [ ] Context snapshots exist: `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/<id>/context | jq '.snapshots | length'`
   - [ ] At least one `progress` snapshot with `contextPercent > 0`
   - [ ] A `completion` snapshot exists
   - [ ] `peakContextPercent` is reasonable (> 0, < 100)
6. Cleanup: `docker stop e2e-ctx-worker && kill $(lsof -ti :3013)`

**Implementation Note**: This is the final verification gate. All previous phases must pass before running E2E.

---

## Testing Strategy

**Unit tests** (`src/tests/context-snapshots.test.ts`):
- DB functions: `createContextSnapshot`, `getContextSnapshotsByTaskId`, `getContextSummaryByTaskId`
- `compactionCount` increments correctly on compaction events
- `peakContextPercent` only increases (never decreases)
- Context window lookup returns correct values for known models

**Integration tests:**
- `POST /api/tasks/:id/context` endpoint with various event types
- `GET /api/tasks/:id/context` endpoint returns correct data
- Invalid event types are rejected (400)

**E2E:**
- Phase 6 covers the full Docker-based E2E flow

## References
- Research: `thoughts/taras/research/2026-03-25-context-usage-tracking.md`
- Claude SDK types: `SDKAssistantMessage`, `SDKCompactBoundaryMessage`, `SDKResultMessage`
- Pi-mono types: `ContextUsage` interface from `@mariozechner/pi-coding-agent`

---

## Review Errata

_Reviewed: 2026-03-25 by Claude (Critical autonomy mode)_

_Verified against codebase via 4 parallel code-analysis agents checking: claude-adapter, pi-mono-extension, runner/DB, and HTTP routing patterns._

### Critical

- [x] **`contextTotalTokens` DB/API schema mismatch** — _QA 2026-03-26: RESOLVED. DB column is nullable (`INTEGER` without `NOT NULL`), Zod schema is `.optional()`, `ContextSnapshotRow` has `number | null`. Consistent across all layers._

### Important

- [x] **ProviderEvent union description is incomplete** — _QA 2026-03-26: RESOLVED. Implementation correctly extends the full union (now 11 members including `context_usage` and `compaction`). Plan description was inaccurate but implementation was correct._

- [x] **`ctx.sessionManager?.getSessionId?.()` likely doesn't exist in pi-mono** — _QA 2026-03-26: RESOLVED. Implementation uses `pi-${config.taskId}` directly in all 3 locations. Dead `getSessionId` call was not included._

- [x] **Snapshot `id` generation unspecified** — _QA 2026-03-26: RESOLVED. Uses `crypto.randomUUID()` in `createContextSnapshot()` at db.ts:7493, matching existing codebase pattern._

- [x] **`.then()` handler line number significantly off** — _QA 2026-03-26: RESOLVED. Implementation found correct locations regardless of line number drift. Completion post is at runner.ts:1611-1628, after saveCostData._

### Resolved

- [x] Missing `planner` field in YAML frontmatter — auto-noted (trivial, non-blocking)
- [x] Structural completeness verified: all required plan sections present (Overview, Current State, Desired End State, What We're NOT Doing, Phases with Changes/Success Criteria, Quick Verification Reference)
- [x] Migration number 021 confirmed correct (highest existing is 020_approval_requests.sql)
- [x] HTTP endpoint patterns (`route()` factory, handler chaining, OpenAPI registration) verified as consistent with existing codebase conventions
- [x] `fireAndForget()` and `apiHeaders()` helpers confirmed to exist in pi-mono-extension.ts (lines 29-32 and 21-27)
- [x] Claude adapter line numbers for assistant handler (317-334), result handler (285), and class structure all verified accurate
- [x] Runner `onEvent` handler at line 1446 and `PROGRESS_THROTTLE_MS` at line 1444 verified
- [x] `SessionCostRow`/`rowToSessionCost` at db.ts:3251-3285, `AgentTaskRow` at line 674, `SessionCostSchema` at types.ts:347 — all verified

---

## QA Report

_QA: 2026-03-26 by Claude (Critical autonomy mode)_

_Verified via 5 parallel agents: Phase 1 (schema/types), Phase 2 (API endpoints), Phase 3 (Claude adapter), Phase 4-5 (Pi-mono + runner), Automated checks._

### Automated Checks: ALL PASS

| Check | Result |
|-------|--------|
| `bun run tsc:check` | PASS — no type errors |
| `bun run lint:fix` | PASS — 387 files, no fixes needed |
| `bun test` | PASS — 2024 pass, 0 fail |
| `bash scripts/check-db-boundary.sh` | PASS |
| `bun run docs:openapi` | PASS — spec up to date |

### Phase Verification: ALL PASS

- **Phase 1**: Migration, Zod schemas, DB functions, context window utility — all correct
- **Phase 2**: POST/GET routes, handler registration, OpenAPI, task enrichment — all correct
- **Phase 3**: ProviderEvent types, context extraction, compaction detection, window tracking — all correct
- **Phase 4**: Pi-mono context/tool_result/shutdown handlers, throttling, session ID — all correct
- **Phase 5**: Runner context_usage/compaction/completion cases, throttling, headers — all correct
- **Phase 6**: Manual E2E — **PASS** (see below)

### Review Errata: ALL RESOLVED

All 5 errata items (1 critical, 4 important) were addressed in the implementation.

### E2E Test Results (2026-03-26)

**Setup**: Clean DB → API on port 3173 → Docker worker (`agent-swarm-worker:latest`) → trivial task ("Say hello and list 3 fun facts about cats")

**Task**: `d71b8153-0533-4844-8410-bb1f226363c1` — completed in ~20s

| Check | Result |
|-------|--------|
| Task has `compactionCount` | PASS — `0` (short task, no compaction expected) |
| Task has `peakContextPercent` | PASS — `11.73%` |
| Task has `contextWindowSize` | PASS — `200000` |
| Context snapshots exist | PASS — 2 snapshots |
| At least one `progress` snapshot with `contextPercent > 0` | PASS — `11.73%`, `23469` tokens used |
| A `completion` snapshot exists | PASS |
| `peakContextPercent` is reasonable (> 0, < 100) | PASS — `11.73%` |

**Minor observation**: The `completion` snapshot has `contextUsedTokens: null` and `contextPercent: null`. This is because the runner's completion post (runner.ts:1611-1628) only sends `cumulativeInputTokens`, `cumulativeOutputTokens`, and `contextTotalTokens` — it does not include the final context used/percent. Not a bug (the values are optional), but a possible enhancement to capture final usage from the last `context_usage` event.

### Outstanding

- [x] **Manual E2E performed** — Phase 6 Docker E2E completed successfully
- [ ] **Completion snapshot enhancement** — Consider populating `contextUsedTokens`/`contextPercent` on completion events (low priority, tracked as follow-up)
