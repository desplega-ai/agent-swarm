---
title: Context Window Usage Tracking in Tasks
date: 2026-03-25
status: research-complete
autonomy: autopilot
---

# Context Window Usage Tracking in Tasks

## Goal

Track context window usage per task, including:
1. **Per-message context usage** — `{used}/{total} ({pct}%)` pushed progressively
2. **Compaction count** — number of compaction/summarization events per task
3. **Total context used** — final aggregate at task completion

Must work for **both providers**: Claude Code and Pi-mono.

---

## Current State: What Exists Today

### Token Tracking (session_costs table)

Tokens are already tracked at session end via `session_costs`:

| Field | Source | Notes |
|-------|--------|-------|
| `inputTokens` | Both providers | Cumulative input tokens |
| `outputTokens` | Both providers | Cumulative output tokens |
| `cacheReadTokens` | Both providers | Cache hit tokens |
| `cacheWriteTokens` | Both providers | Cache creation tokens |
| `totalCostUsd` | Both providers | USD cost |
| `durationMs` | Claude only | Pi-mono hardcodes to 0 |
| `numTurns` | Both providers | Message count |
| `model` | Both providers | Model name string |

**Flow**: Provider adapter → `CostData` → Runner → `POST /api/session-costs` → `session_costs` table

### What Does NOT Exist Today

- No per-message context window tracking
- No compaction event counting
- No context window size metadata (total capacity)
- No progressive context usage snapshots

---

## Provider Capabilities

### Claude Code

**Context window info: AVAILABLE per-turn in stream-json `assistant` events.**

Every `assistant` event in Claude Code's `--output-format stream-json` output includes a `message.usage` object:

```json
{
  "type": "assistant",
  "message": {
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 1754,
      "cache_read_input_tokens": 76819,
      "output_tokens": 8,
      "service_tier": "standard"
    },
    "model": "claude-opus-4-6",
    "content": [...]
  }
}
```

**Context window usage per turn** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. This represents the total tokens sent to the model in that API call — effectively the context window utilization at that point.

Verified in:
- Local interactive session JSONL (`~/.claude/projects/.../session.jsonl`)
- Worker stream-json logs (`logs/<agentId>/<session>.jsonl`)

**The claude-adapter already parses `assistant` events** (line 318 in `claude-adapter.ts`) but only extracts `content` blocks for tool_use. The `message.usage` field is ignored.

**What we CAN get (per turn)**:
- **Context tokens in use**: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- **Context window size**: known per model via lookup table (Opus 4.6 = 1M, Sonnet 4.6 = 200K, Haiku = 200K)
- **Context percentage**: `contextUsed / contextWindowSize * 100`
- **Output tokens**: `output_tokens` per turn
- **Compaction detection**: context size drops significantly between consecutive turns (e.g., 850K → 200K)
- **Compaction count**: also detectable via PreCompact hook

**What we CANNOT get**:
- Post-compaction exact token count in the same event (next turn reveals it)
- Internal breakdown of what's in context (system prompt vs conversation vs tool results)

**PreCompact hook**: Additionally fires before compaction — useful as an explicit signal. Handler in `src/hooks/hook.ts:763` currently only injects goal reminder.

#### Concrete Examples: Claude Code stream-json Events

**`system/init` event** (first event, gives model name):
```json
{
  "type": "system",
  "subtype": "init",
  "model": "claude-opus-4-6",
  "session_id": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
  "cwd": "/Users/taras/Documents/code/agent-swarm",
  "claude_code_version": "2.1.75",
  "permissionMode": "bypassPermissions"
}
```
→ Extract `model` → lookup context window size (1M for opus-4-6).

**`assistant` event** (every turn, has per-turn `message.usage`):
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "role": "assistant",
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 1754,
      "cache_read_input_tokens": 76819,
      "output_tokens": 8,
      "service_tier": "standard"
    },
    "content": [...]
  }
}
```
→ `contextUsed = 3 + 1754 + 76819 = 78,576` → `78,576 / 1,000,000 = 7.9%`

**`result` event** (session end, has `modelUsage` with `contextWindow`):
```json
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.7565345,
  "duration_ms": 100135,
  "num_turns": 17,
  "usage": {
    "input_tokens": 32,
    "cache_creation_input_tokens": 52360,
    "cache_read_input_tokens": 662549,
    "output_tokens": 3914
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "inputTokens": 32,
      "outputTokens": 3914,
      "cacheReadInputTokens": 662549,
      "cacheCreationInputTokens": 52360,
      "costUSD": 0.7565345
    }
  }
}
```
→ `modelUsage[model].contextWindow` gives the authoritative context window size at session end. Can be used to correct/validate the lookup table.

**Note**: The `result.modelUsage.contextWindow` value may differ from the expected model max (e.g., showed 200K for Opus 4.6 in one session). This could be plan/version dependent. The lookup table should be the primary source, with `modelUsage.contextWindow` as a runtime override when available.

#### Formula

```
contextUsed = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
contextTotal = CONTEXT_WINDOW_SIZES[model]  // from init event model name
contextPercent = (contextUsed / contextTotal) * 100
```

This is available from **the very first assistant turn** — no need to wait for session end.

### Pi-mono

**Context window info: Available via `ctx.getContextUsage()` in event handlers.**

Pi-mono's extension event handlers receive a `ctx` parameter with:
```typescript
interface ContextUsage {
  tokens: number | null;    // Estimated tokens in context (null after compaction)
  contextWindow: number;     // Max context window size
  percent: number;           // Usage percentage
}
```

**Currently NOT used** — the `context` event handler in `pi-mono-extension.ts:565` only uses `_ctx` (underscore prefix = ignored).

**Compaction**: The `context` event IS the compaction event (fires before compaction). `ctx.getContextUsage()` would give us the pre-compaction usage.

**Session stats at end**: `getSessionStats()` provides cumulative token counts but NOT final context usage.

**What we CAN get from Pi-mono**:
- Real-time context usage (tokens, contextWindow, percent) at every event
- Compaction events (the `context` event itself)
- Pre-compaction context state

**What we CANNOT easily get**:
- Per-message context usage (only at event boundaries, not every assistant message)
- Post-compaction context state (tokens is `null` right after compaction)

---

## Proposed Design

### 1. New DB Table: `task_context_snapshots`

Stores progressive context usage snapshots, one per significant event.

```sql
CREATE TABLE IF NOT EXISTS task_context_snapshots (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sessionId TEXT NOT NULL,              -- Claude/Pi-mono session ID for log correlation

    -- Context window state
    contextUsedTokens INTEGER,           -- Tokens currently in context window
    contextTotalTokens INTEGER NOT NULL,  -- Max context window size for this model
    contextPercent REAL,                  -- Usage percentage (0-100)

    -- Event metadata
    eventType TEXT NOT NULL,              -- 'progress' | 'compaction' | 'completion'

    -- Compaction-specific fields (NULL for non-compaction events)
    compactTrigger TEXT,                  -- 'auto' | 'manual' (from compact_metadata.trigger)
    preCompactTokens INTEGER,            -- Token count before compaction (from compact_metadata.pre_tokens)

    -- Cumulative token counters (at this point in time)
    cumulativeInputTokens INTEGER DEFAULT 0,
    cumulativeOutputTokens INTEGER DEFAULT 0,

    createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON task_context_snapshots(taskId);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_agent ON task_context_snapshots(agentId);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON task_context_snapshots(sessionId);
```

### 2. New Columns on `agent_tasks`

```sql
ALTER TABLE agent_tasks ADD COLUMN compactionCount INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN peakContextPercent REAL;           -- Highest % reached
ALTER TABLE agent_tasks ADD COLUMN totalContextTokensUsed INTEGER;    -- Final cumulative (input + output)
ALTER TABLE agent_tasks ADD COLUMN contextWindowSize INTEGER;         -- Model's max context window
```

### 3. Context Window Size: Runtime-First, Lookup as Fallback

Both providers can report the context window size at runtime — a static lookup table is a **fallback only**.

#### Claude Code: runtime from `modelUsage.contextWindow`

The `result` event at session end provides the authoritative value:
```json
"modelUsage": { "claude-opus-4-6": { "contextWindow": 200000 } }
```

**Important**: 1M context is a beta opt-in (`SdkBeta = "context-1m-2025-08-07"`). Without the beta, Opus defaults to 200K. The `contextWindow` value in `modelUsage` reflects the **actual** context window for that session (beta or not). This is why the worker log showed 200K for Opus — the beta wasn’t enabled.

**Problem**: `modelUsage` only arrives at session end. For per-turn tracking before the result, we need a fallback. Options:
1. Use the lookup table initially, then correct with `modelUsage.contextWindow` when received
2. Store the last-known `contextWindow` per model per agent in the DB (from previous sessions)
3. Accept approximate % until the `result` event arrives

#### Pi-mono: runtime from `ctx.getContextUsage().contextWindow`

Available at every event handler call — no lookup needed. `ctx.getContextUsage()` returns `contextWindow` directly from the model provider.

#### Fallback lookup table

For the first few turns of a Claude session (before `result`), use a lookup. Source:
- Claude models: https://platform.claude.com/docs/en/about-claude/models/overview
- Gemini/Pi-mono models: `ctx.getContextUsage().contextWindow` at runtime (no static lookup needed)

```typescript
// Fallback only — runtime values take precedence
const CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
  // Claude models (default without 1M beta)
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  // With 1M beta enabled (agent-swarm enables this):
  // "claude-opus-4-6": 1_000_000,
  "default": 200_000,
};
```

**Recommended approach**: On session start, use fallback. On first `result` event (or from previous session data), update to authoritative `contextWindow`. Store the authoritative value per model in the agent’s config or a lightweight cache, so subsequent sessions start with the correct value.

This should live in a shared module (e.g., `src/utils/context-window.ts`) since both API and worker code may need it. However, **workers must NOT import DB code** — the lookup is pure data, safe for both sides.

### 4. Data Collection: Claude Code

#### Per-turn Context Usage (from `assistant` events in stream-json)

Modify `claude-adapter.ts` to extract `message.usage` from every `assistant` event and emit a new `context_usage` event:

```typescript
// In processJsonLine(), after existing assistant message handling (line ~318)
if (json.type === "assistant" && json.message?.usage) {
  const usage = json.message.usage;
  const contextTokens = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  const contextWindow = getContextWindowSize(this.model); // lookup

  this.emit({
    type: "context_usage",
    contextUsedTokens: contextTokens,
    contextTotalTokens: contextWindow,
    contextPercent: (contextTokens / contextWindow) * 100,
    outputTokens: usage.output_tokens ?? 0,
  });
}
```

The runner then forwards these events to the API (throttled — see rate limiting below).

#### Compaction Detection

Two complementary mechanisms:

1. **PreCompact hook** (explicit signal): Modify `src/hooks/hook.ts` to POST a compaction event:
```typescript
case "PreCompact": {
  const taskFileData = await readTaskFile();
  if (taskFileData?.taskId) {
    await fetch(`${apiUrl}/api/tasks/${taskFileData.taskId}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "X-Agent-ID": agentId },
      body: JSON.stringify({ eventType: "compaction" }),
    }).catch(() => {});
  }
  break;
}
```

2. **Context drop detection** (in runner): If `contextUsedTokens` drops >50% between consecutive events, flag as compaction. This is a backup for cases where the hook doesn't fire.

#### Final Context Data (on session end)

The `result` event already provides cumulative tokens. Add context window metadata:

```typescript
// In runner.ts after session ends
const contextWindowSize = getContextWindowSize(model);
// Include in the POST /api/tasks/{id}/context call
await fetch(`${apiUrl}/api/tasks/${taskId}/context`, {
  method: "POST",
  body: JSON.stringify({
    eventType: "completion",
    contextTotalTokens: contextWindowSize,
    cumulativeInputTokens: cost.inputTokens,
    cumulativeOutputTokens: cost.outputTokens,
  }),
});
```

### 5. Data Collection: Pi-mono

#### Real-time Context Usage (from extension events)

Pi-mono CAN provide real-time context usage. Modify event handlers:

```typescript
// In pi-mono-extension.ts — any event handler that receives ctx
pi.on("context", async (_event, ctx) => {
  const usage = ctx.getContextUsage();

  // Report to API
  if (config.taskId && usage) {
    await fetch(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
      method: "POST",
      headers: { ... },
      body: JSON.stringify({
        eventType: "compaction",
        contextUsedTokens: usage.tokens,
        contextTotalTokens: usage.contextWindow,
        contextPercent: usage.percent,
      }),
    }).catch(() => {});
  }

  // Existing goal reminder...
});
```

#### Per-turn snapshots

Could also hook into `input` or `output` events to capture context state at each turn:

```typescript
pi.on("output", async (_event, ctx) => {
  const usage = ctx.getContextUsage();
  if (config.taskId && usage?.tokens != null) {
    await fetch(`${config.apiUrl}/api/tasks/${config.taskId}/context`, {
      method: "POST",
      headers: { ... },
      body: JSON.stringify({
        eventType: "progress",
        contextUsedTokens: usage.tokens,
        contextTotalTokens: usage.contextWindow,
        contextPercent: usage.percent,
      }),
    }).catch(() => {});
  }
});
```

#### Concrete Example: Pi-mono ContextUsage

```typescript
// ctx.getContextUsage() returns:
{
  tokens: 145000,      // estimated tokens currently in context (null right after compaction)
  contextWindow: 1000000,  // max context window for this model
  percent: 14.5           // usage percentage
}
```

#### Formula (Pi-mono)

```
contextUsed = ctx.getContextUsage().tokens
contextTotal = ctx.getContextUsage().contextWindow
contextPercent = ctx.getContextUsage().percent  // already computed
```

Available at every extension event (`context`, `input`, `output`).

### 6. New API Endpoint

```
POST /api/tasks/:id/context
```

**Input**:
```typescript
{
  eventType: "progress" | "compaction" | "completion",
  contextUsedTokens?: number,
  contextTotalTokens?: number,
  contextPercent?: number,
  cumulativeInputTokens?: number,
  cumulativeOutputTokens?: number,
}
```

**Behavior**:
- Creates a `task_context_snapshots` row
- If `eventType === "compaction"`: increment `agent_tasks.compactionCount`
- If `eventType === "completion"`: update `agent_tasks.totalContextTokensUsed` and `contextWindowSize`
- Always: update `agent_tasks.peakContextPercent` if new percent > current peak

### 7. Reading Context Data

Extend existing endpoints:

**GET /api/tasks/:id** — include context fields in response:
```json
{
  "compactionCount": 2,
  "peakContextPercent": 87.3,
  "totalContextTokensUsed": 485000,
  "contextWindowSize": 1000000,
  "lastContextSessionId": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
  "lastContextUpdatedAt": "2026-03-25T15:43:00.000Z"
}
```

**GET /api/tasks/:id/context** — full snapshot history (with session correlation):
```json
{
  "snapshots": [
    {
      "id": "snap-abc123",
      "eventType": "progress",
      "contextPercent": 45.2,
      "contextUsedTokens": 452000,
      "contextTotalTokens": 1000000,
      "sessionId": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
      "createdAt": "2026-03-25T15:30:12.000Z"
    },
    {
      "id": "snap-def456",
      "eventType": "compaction",
      "contextPercent": 92.1,
      "contextUsedTokens": 921000,
      "contextTotalTokens": 1000000,
      "compactTrigger": "auto",
      "preCompactTokens": 921000,
      "sessionId": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
      "createdAt": "2026-03-25T15:35:44.000Z"
    },
    {
      "id": "snap-ghi789",
      "eventType": "progress",
      "contextPercent": 23.5,
      "contextUsedTokens": 235000,
      "contextTotalTokens": 1000000,
      "sessionId": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
      "createdAt": "2026-03-25T15:36:02.000Z"
    },
    {
      "id": "snap-jkl012",
      "eventType": "completion",
      "cumulativeInputTokens": 485000,
      "cumulativeOutputTokens": 12000,
      "contextTotalTokens": 1000000,
      "sessionId": "b8529f7b-a3dc-4c90-b7de-0c2b67b9e216",
      "createdAt": "2026-03-25T15:43:00.000Z"
    }
  ]
}
```

### 8. MCP Tool: store-progress Extension

Extend the existing `store-progress` MCP tool to accept context data:

```typescript
// Additional optional field in store-progress input
contextUsage?: {
  usedTokens?: number,
  totalTokens?: number,
  percent?: number,
}
```

This allows agents to self-report context usage (useful for future providers or external agents that have access to their own context metrics).

---

## Provider Comparison Summary

| Capability | Claude Code | Pi-mono |
|-----------|-------------|---------|
| Context window size | Lookup table (by model) | `ctx.getContextUsage().contextWindow` |
| Real-time context % | **YES** — computed from `message.usage` per turn | `ctx.getContextUsage().percent` |
| Tokens in context | **YES** — `input + cache_create + cache_read` per turn | `ctx.getContextUsage().tokens` |
| Compaction detection | Context drop between turns + PreCompact hook | `context` event fires (with metrics) |
| Compaction count | Count PreCompact invocations (or detect drops) | Count `context` events |
| Cumulative tokens | `result` event at session end | `getSessionStats()` at session end |
| Per-message tracking | **YES** — every `assistant` event has `usage` | Via `output`/`input` events |

**Both providers support real-time per-turn context tracking.** The data sources differ but the output shape can be unified.

---

## Key Considerations

### Rate Limiting Context Snapshots

Pi-mono could generate many snapshots per task. Consider:
- Throttle to max 1 snapshot per 30 seconds per task
- Or only snapshot on significant change (>5% context change)
- Compaction events always recorded (no throttle)

### Worker/API Boundary

All context data flows via HTTP — workers never write to DB directly. The `POST /api/tasks/:id/context` endpoint lives on the API server. Both the hook (Claude) and extension (Pi-mono) make HTTP calls.

### Data for the "push per message" Requirement

**Both providers can push context usage per turn:**

For Claude Code: every `assistant` event in stream-json has `message.usage`:
- `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` = context tokens in use
- Combined with model lookup → `{used}/{total} ({pct}%)`
- Compaction visible as context drop between turns + PreCompact hook

For Pi-mono: `ctx.getContextUsage()` in event handlers:
- `tokens` / `contextWindow` / `percent` — direct values
- `context` event = compaction signal

**Unified output shape for both**: `{ contextUsedTokens, contextTotalTokens, contextPercent, eventType }`

---

## Files to Modify

### API Server (src/be/, src/http/, src/tools/)
1. `src/be/migrations/NNN_context_usage.sql` — new migration for table + columns
2. `src/be/db.ts` — CRUD functions for context snapshots, increment compactionCount
3. `src/http/tasks.ts` or new `src/http/context.ts` — `POST/GET /api/tasks/:id/context`
4. `src/tools/store-progress.ts` — accept optional `contextUsage` in input schema
5. `src/types.ts` — Zod schemas for context snapshot, updated AgentTask schema
6. `src/utils/context-window.ts` — model→context window size lookup (shared, no DB imports)

### Worker Side (src/hooks/, src/providers/, src/commands/)
7. `src/hooks/hook.ts` — PreCompact handler: POST compaction event to API
8. `src/providers/pi-mono-extension.ts` — context event: POST compaction + usage to API; optionally output event for per-turn tracking
9. `src/commands/runner.ts` — on session end: POST completion context event

### UI (new-ui/)
10. Task detail page — show compactionCount, peakContextPercent, totalContextTokensUsed
11. Optional: context usage timeline chart from snapshots

---

## Official Claude Agent SDK Types (Reference)

These are the official TypeScript types from `@anthropic-ai/claude-agent-sdk` that are relevant to context tracking. Our stream-json parsing should align with these.

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: "assistant";
  uuid: UUID;
  session_id: string;
  message: BetaMessage;  // From @anthropic-ai/sdk — includes `usage` and `model`
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
};
```

The `BetaMessage.usage` field has the per-turn token counts:
```typescript
type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};
```

### SDKCompactBoundaryMessage

**This is the compaction event** — emitted when context is compacted:
```typescript
type SDKCompactBoundaryMessage = {
  type: "system";
  subtype: "compact_boundary";
  uuid: UUID;
  session_id: string;
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;            // Token count BEFORE compaction
  };
};
```

This gives us `pre_tokens` — the exact context size before compaction. The next `assistant` event's usage will show the post-compaction size.

### SDKStatusMessage (compacting status)

```typescript
type SDKStatusMessage = {
  type: "system";
  subtype: "status";
  status: "compacting" | null;     // Fires when compaction starts
  permissionMode?: PermissionMode;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (session end)

```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | ...;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: { [modelName: string]: ModelUsage };
  // ...
};
```

With `ModelUsage` providing the authoritative context window:
```typescript
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;        // ← Model's max context window
  maxOutputTokens: number;      // ← Model's max output tokens
};
```

### SDKMessage union (all event types)

```typescript
type SDKMessage =
  | SDKAssistantMessage        // ← per-turn usage
  | SDKUserMessage
  | SDKResultMessage           // ← session-end totals + modelUsage.contextWindow
  | SDKCompactBoundaryMessage  // ← compaction with pre_tokens
  | SDKStatusMessage           // ← "compacting" status
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage
  | SDKToolProgressMessage | SDKToolUseSummaryMessage
  | SDKAuthStatusMessage | SDKRateLimitEvent
  | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskProgressMessage
  | SDKFilesPersistedEvent | SDKPromptSuggestionMessage
  | SDKUserMessageReplay;
```

### Implications for Implementation

With the official SDK types, the Claude adapter can extract:

1. **Per-turn context usage** from `SDKAssistantMessage.message.usage`:
   - `contextUsed = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

2. **Compaction events** from `SDKCompactBoundaryMessage`:
   - `compact_metadata.pre_tokens` = exact context size before compaction
   - `compact_metadata.trigger` = "auto" or "manual"
   - Increment `compactionCount` on the task

3. **Compacting status** from `SDKStatusMessage`:
   - `status === "compacting"` signals compaction in progress

4. **Context window size** from `SDKResultMessage.modelUsage[model].contextWindow`:
   - Authoritative value at session end
   - Use to validate/update the lookup table

The `claude-adapter.ts` currently only processes `system/init`, `result`, and `assistant` (for tool_use). It needs to also handle:
- `assistant` → extract `message.usage` for per-turn context tracking
- `system/compact_boundary` → extract `compact_metadata` for compaction counting
- `system/status` → detect "compacting" state (optional, nice-to-have)
- `result` → extract `modelUsage[model].contextWindow` (already partially handled)

---

## Open Questions

1. **Snapshot frequency**: Both providers emit per-turn data. Throttle to max 1 snapshot per N seconds? Or store all and let the UI aggregate? High-frequency snapshots = more DB writes but better granularity for charts.
2. **store-progress integration**: Should the agent also self-report context usage via MCP tool (useful for external/future providers), or keep it automatic from adapters/hooks only?
3. **Historical backfill**: Do we want to estimate context data for existing completed tasks from their session_costs records + session logs?
4. **Compaction detection threshold**: What context drop % between turns should count as compaction? 50%? Need to verify typical compaction ratios.
