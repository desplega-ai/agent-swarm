---
date: 2026-03-11
author: Claude
status: draft
github_issue: https://github.com/desplega-ai/agent-swarm/issues/100
research:
  - thoughts/taras/research/2026-03-11-codex-native-support-feasibility.md
  - thoughts/taras/research/2026-03-11-codex-adapter-deep-reference.md
autonomy: autopilot
---

# Native Codex Support — Implementation Plan

## Overview

Add OpenAI Codex as a third native harness provider in agent-swarm, alongside Claude and pi-mono. The integration uses the **Codex App Server** (JSON-RPC over stdio) — not the TypeScript SDK or `codex exec` CLI — following the same `ProviderAdapter`/`ProviderSession` pattern established by the pi-mono adapter.

## Current State Analysis

The provider abstraction (`src/providers/types.ts`) is mature with two working adapters:
- **Claude** (`claude-adapter.ts`): Subprocess pattern — spawns `claude` CLI, parses JSONL stdout
- **Pi-mono** (`pi-mono-adapter.ts`): Programmatic pattern — in-process session, event handler mapping

The runner (`src/commands/runner.ts:1098-1197`) is fully provider-agnostic: calls `adapter.createSession(config)`, subscribes via `session.onEvent()`, and buffers `raw_log` events for the UI.

**The pi-mono adapter is the closer template for Codex** — both use programmatic session management with event stream monitoring for hook-equivalent behavior.

### Key Discoveries:
- `ProviderSessionConfig.resumeSessionId` exists (`types.ts:40`) but is passive — runner uses `additionalArgs` with `--resume` flag instead (`runner.ts:1820-1832`)
- `ProviderAdapter.canResume()` exists (`types.ts:73`) but is never called by the runner
- `raw_log` content must be Claude-compatible JSON for the UI session log viewer (`pi-mono-adapter.ts:196-246` shows the exact format)
- Pi-mono creates an `AGENTS.md -> CLAUDE.md` symlink (`pi-mono-adapter.ts:109-128`), but Codex has `project_doc_fallback_filenames` config that includes `CLAUDE.md` by default — symlink may be unnecessary
- Docker entrypoint (`docker-entrypoint.sh:7-19`) validates auth per provider; Dockerfile (`Dockerfile.worker:76-84`) installs CLIs sequentially
- Codex JSON-RPC uses "JSON-RPC lite" — omits the `"jsonrpc":"2.0"` field
- Codex config uses kebab-case (`danger-full-access`) but App Server API uses camelCase (`dangerFullAccess`)

## Desired End State

A worker container with `HARNESS_PROVIDER=codex` and `OPENAI_API_KEY=sk-...` can:
1. Pick up tasks from the swarm API
2. Execute them using Codex App Server with full tool access
3. Stream session logs to the dashboard in the same format as Claude/pi-mono
4. Resume paused tasks and inherit parent context via `thread/resume`
5. Respond to cancellation signals, send heartbeats, and detect tool loops

**Verification**: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/tasks` shows a Codex-executed task with status `completed`, `claudeSessionId` populated, session logs visible in dashboard.

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test src/tests/codex-adapter.test.ts` — Adapter unit tests
- `docker build -f Dockerfile.worker .` — Docker image builds

Key files to check:
- `src/providers/codex-adapter.ts` — Main adapter
- `src/providers/codex-jsonrpc.ts` — JSON-RPC client
- `src/providers/codex-types.ts` — Protocol type definitions
- `src/providers/codex-hooks.ts` — Hook-equivalent behaviors
- `src/providers/index.ts` — Factory registration
- `docker-entrypoint.sh` — Auth + config.toml generation
- `Dockerfile.worker` — Codex CLI installation

## What We're NOT Doing

1. **Subscription auth** (Strategy B/C from research) — API key only for MVP. Subscription auth with token refresh is a follow-up.
2. **`turn/steer` support** — Unique Codex capability, but extending `ProviderSession` interface is out of scope for initial implementation.
3. **`codex exec --json` fallback** — If App Server has issues, we'll fix them rather than maintaining two integration paths.
4. **Generated TypeScript types** — Hand-write the JSON-RPC message types we need rather than depending on `codex app-server generate-ts`.
5. **Long-lived app-server process** — One process per task for simplicity. Optimization to reuse processes across tasks is a follow-up.
6. **Runner resume refactor** — The research recommended refactoring the runner to use `config.resumeSessionId` instead of `additionalArgs`. This is desirable but is a separate cleanup PR — we'll work within the existing `additionalArgs` pattern for now and have the Codex adapter extract `--resume` from it (same as Claude adapter does).
7. **MCP transport fallback** — We'll use HTTP transport for MCP. If it's unreliable, we'll debug rather than add SSE fallback complexity.
8. **Auto-retry on failure** — The Claude adapter has auto-retry logic that strips `--resume` on stale session errors (`claude-adapter.ts:280-315`). We'll implement basic stale-session fallback in `createSession()` (resume fails → start fresh), but not a full multi-retry mechanism. If needed, it's a follow-up.

## Implementation Approach

Follow the pi-mono adapter pattern:
1. Build a JSON-RPC transport layer for stdio communication with the App Server
2. Implement `CodexAdapter` (factory) and `CodexSession` (running session) against the existing interfaces
3. Map Codex item notifications to Claude-compatible `raw_log` JSON for the dashboard
4. Add hook-equivalent event monitoring inline in the event handler
5. Add Docker support (CLI install, entrypoint, config.toml)
6. Test with unit tests and E2E Docker flow

---

## Phase 1: JSON-RPC Transport Client

### Overview

Build a lightweight JSON-RPC client for JSONL-over-stdio communication with the Codex App Server. This is the foundation layer — all adapter communication flows through it.

### Changes Required:

#### 1. JSON-RPC Client
**File**: `src/providers/codex-jsonrpc.ts` (new)
**Changes**: Create a JSONL-over-stdio JSON-RPC client with:

- **Types**: Define message types for the "JSON-RPC lite" protocol (no `"jsonrpc":"2.0"` field):
  ```typescript
  interface JsonRpcRequest { id: number; method: string; params?: unknown }
  interface JsonRpcResponse { id: number; result?: unknown; error?: { code: number; message: string } }
  interface JsonRpcNotification { method: string; params?: unknown }
  ```

- **Class `CodexJsonRpcClient`**:
  - Constructor takes `Bun.Subprocess` (stdin/stdout pipes)
  - `request(method, params)`: Send request, return `Promise<result>` — correlate by `id` using a `Map<number, { resolve, reject }>`
  - `notify(method, params)`: Send notification (no `id`, no response expected)
  - `onNotification(listener)`: Register listener for server-initiated notifications (method + params)
  - `onRequest(listener)`: Register listener for server-initiated requests (have `id` — must be responded to, e.g. `requestApproval`)
  - `respond(id, result)`: Send response to server-initiated request
  - `close()`: Close stdin pipe
  - Internal: Read stdout line-by-line, parse JSON, route to pending requests or notification/request listeners
  - Handle partial lines (buffer until newline)
  - Auto-increment request IDs

- **Gotchas to handle**:
  - No `"jsonrpc":"2.0"` field in any message (JSON-RPC lite)
  - Server-initiated requests (with `id`) vs notifications (without `id`) — both come from stdout
  - Distinguish response (has `id` matching a pending request) from server-initiated request (has `id` + `method`) from notification (no `id`, has `method`)

#### 2. Codex Protocol Types
**File**: `src/providers/codex-types.ts` (new)
**Changes**: Define TypeScript types for the Codex App Server protocol messages we use:

- **Handshake**: `InitializeParams`, `InitializeResult`
- **Auth**: `AccountLoginParams` (type: "apiKey")
- **Thread**: `ThreadStartParams` (with `settings`), `ThreadStartedNotification`, `ThreadResumeParams`
- **Turn**: `TurnStartParams` (with `input`), `TurnCompletedNotification` (with `usage`)
- **Items**: `ItemStartedNotification`, `ItemCompletedNotification`, `ItemDeltaNotification` — each with typed `data` per item type (`commandExecution`, `agentMessage`, `fileChange`, `mcpToolCall`, `reasoning`, `plan`)
- **Settings**: `CodexSettings` type for `thread/start` params — `model`, `developer_instructions`, `approval_policy`, `sandbox_permissions`
- **Approval**: `RequestApprovalParams`, `ApprovalResponse`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test src/tests/codex-jsonrpc.test.ts`

#### Manual Verification:
- [ ] Types cover all message formats from deep reference doc Section 5
- [ ] Client handles partial JSONL lines correctly (test with split writes)
- [ ] Server-initiated requests (approval) are correctly distinguished from notifications

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Core Adapter — Session Lifecycle

### Overview

Implement `CodexAdapter` and `CodexSession` classes against the existing `ProviderAdapter`/`ProviderSession` interfaces. This phase handles process spawning, handshake, auth, thread/turn lifecycle, and abort — but NOT event mapping (Phase 3) or hook equivalents (Phase 4).

### Changes Required:

#### 1. Codex Adapter
**File**: `src/providers/codex-adapter.ts` (new)
**Changes**:

**`CodexSession` class** (implements `ProviderSession`):
- Constructor receives `CodexJsonRpcClient`, spawned `Bun.Subprocess`, and config
- **`sessionId`**: Set from `thread/started` notification's `threadId`
- **`onEvent(listener)`**: Register event listener (used by runner)
- **`waitForCompletion()`**: Returns promise that resolves when `turn/completed` notification arrives. Build `ProviderResult` with:
  - `exitCode`: 0 for `status: "completed"`, 1 for `"failed"`, 2 for `"interrupted"`
  - `cost`: Calculate from `usage.input_tokens`, `usage.output_tokens`, `usage.cached_input_tokens` + model pricing lookup
  - `sessionId`: Thread ID
- **`abort()`**: Send `turn/interrupt` via JSON-RPC, wait for `turn/completed`
- **Internal `emit(event)`**: Push to listeners array (same pattern as pi-mono)
- **Approval handler**: On `requestApproval` server-initiated request, auto-respond with `{ decision: "accept" }` (belt-and-suspenders with `approval_policy: "never"`)

**`CodexAdapter` class** (implements `ProviderAdapter`):
- **`name`**: `"codex"`
- **`createSession(config)`**:
  1. Spawn `codex app-server --listen stdio://` via `Bun.spawn({ stdin: "pipe", stdout: "pipe", stderr: "pipe" })`
  2. Create `CodexJsonRpcClient` from subprocess
  3. Send `initialize` request, wait for response
  4. Send `initialized` notification
  5. Send `account/login/start` with `{ type: "apiKey", apiKey: env.OPENAI_API_KEY }`
  6. Determine resume: check `config.resumeSessionId` OR extract `--resume <id>` from `config.additionalArgs`
  7. If resuming: send `thread/resume { threadId }`, on failure fall back to `thread/start`
  8. If new: send `thread/start` with settings:
     ```typescript
     {
       model: config.model || "o3",
       developer_instructions: config.systemPrompt,
       approval_policy: "never",
       sandbox_permissions: "dangerFullAccess"
     }
     ```
  9. Wait for `thread/started` notification → store thread ID as `sessionId`
  10. Send `turn/start` with `{ input: [{ type: "text", text: config.prompt }] }`
  11. Return `CodexSession`
- **`canResume(sessionId)`**: Send `thread/list`, check if thread ID exists in response

**Stderr handling**: Pipe stderr through and emit as `raw_stderr` events.

**Process cleanup**: On `waitForCompletion()` resolve, close stdin, wait for process exit with 10s timeout, SIGTERM if exceeded.

#### 2. Factory Registration
**File**: `src/providers/index.ts`
**Changes**: Add `"codex"` case to the switch in `createProviderAdapter()`:
```typescript
case "codex":
  return new CodexAdapter();
```
Update error message to include `codex` in supported list.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test src/tests/codex-adapter.test.ts`

#### Manual Verification:
- [ ] With `HARNESS_PROVIDER=codex` and `OPENAI_API_KEY` set, adapter spawns app-server, completes handshake, sends a trivial prompt, and exits cleanly
- [ ] `abort()` sends `turn/interrupt` and the session terminates
- [ ] Stale session resume falls back to `thread/start` (test with fake thread ID)
- [ ] Process cleanup works — no orphaned `codex app-server` processes after session

**Implementation Note**: After completing this phase, pause for manual confirmation. This phase produces a working adapter that can execute tasks but doesn't stream logs to the UI yet.

---

## Phase 3: Event Mapping & UI Log Compatibility

### Overview

Map Codex App Server item notifications to `ProviderEvent` types and construct Claude-compatible `raw_log` JSON for the dashboard session log viewer. Follow the pi-mono adapter's format exactly (`pi-mono-adapter.ts:196-246`).

### Changes Required:

#### 1. Event Stream Processing
**File**: `src/providers/codex-adapter.ts`
**Changes**: In `CodexSession`, register a notification listener on the JSON-RPC client that maps Codex events:

**ProviderEvent mapping** (emit via `this.emit()`):

| Codex Notification | ProviderEvent |
|---|---|
| `thread/started` (threadId) | `{ type: "session_init", sessionId: threadId }` |
| `item/started` (type: `commandExecution`/`mcpToolCall`/`fileChange`) | `{ type: "tool_start", toolCallId: itemId, toolName, args }` |
| `item/completed` (type: `commandExecution`/`mcpToolCall`/`fileChange`) | `{ type: "tool_end", toolCallId: itemId, toolName, result }` |
| `item/completed` (type: `agentMessage`) | `{ type: "message", role: "assistant", content: text }` |
| `turn/completed` | `{ type: "result", cost, isError }` |
| Error responses | `{ type: "error", message }` |

**Claude-compatible `raw_log` events** (for UI rendering):

Follow the exact JSON structure from `pi-mono-adapter.ts:196-246`:

- **Agent message** (`item/completed`, type `agentMessage`):
  ```json
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"model":"o3"}}
  ```
  With deduplication: track `lastEmittedMessage`, skip if same text as last emit.

- **Tool start** (`item/started`, type `commandExecution`):
  ```json
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"item_001","name":"Bash","input":{"command":"bun test"}}],"model":"o3"}}
  ```
  Map item types to tool names: `commandExecution` → `"Bash"`, `fileChange` → `"Edit"` or `"Write"`, `mcpToolCall` → actual tool name (strip `mcp__agent-swarm__` prefix if present).

- **Tool result** (`item/completed`, type `commandExecution`):
  ```json
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"item_001","content":"exit=0\nstdout..."}]}}
  ```
  For `commandExecution`: format as `exit=${exitCode}\n${stdout}`. For `mcpToolCall`: stringify result. For `fileChange`: format as path + diff summary.

- **Reasoning** (`item/completed`, type `reasoning`):
  ```json
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."}],"model":"o3"}}
  ```

- **Streaming deltas** (`item/agentMessage/delta`): Accumulate text in a buffer per `itemId`. Emit full text on `item/completed`. Don't emit partial `raw_log` events (consistent with pi-mono which emits on `message_end`, not on deltas).

#### 2. Cost Calculation
**File**: `src/providers/codex-adapter.ts`
**Changes**: Build `CostData` from `turn/completed` usage:
```typescript
const cost: CostData = {
  sessionId: this._sessionId,
  taskId: this.config.taskId,
  agentId: this.config.agentId,
  totalCostUsd: calculateCost(usage, model), // tokens * per-token price
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cached_input_tokens,
  cacheWriteTokens: 0, // Codex doesn't report cache writes
  durationMs: Date.now() - this.startTime,
  numTurns: 1, // One turn per task execution
  model: this.config.model || "o3",
  isError: status !== "completed",
};
```

Add a simple `calculateCost(usage, model)` function with known Codex model pricing (o3, o4-mini, codex-mini). Return 0 for unknown models with a warning log.

#### 3. MCP Tool Name Normalization
**File**: `src/providers/codex-adapter.ts`
**Changes**: Codex prefixes MCP tools as `mcp__agent-swarm__<tool>`. When emitting `tool_start`/`tool_end` events and `raw_log` tool_use blocks, strip the `mcp__agent-swarm__` prefix to normalize tool names for the runner's hook-equivalent checks and UI display.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test src/tests/codex-adapter.test.ts` (add event mapping tests)

#### Manual Verification:
- [ ] Run a Codex task that uses Bash and file editing — verify session logs appear correctly in the dashboard
- [ ] Reasoning/thinking blocks render in the UI
- [ ] Tool use and tool results show with correct names (not `mcp__agent-swarm__` prefixed)
- [ ] No duplicate message bubbles in the UI (deduplication works)
- [ ] Cost data appears in the task details

**Implementation Note**: After completing this phase, pause for manual confirmation. The adapter is now fully functional for UI rendering.

---

## Phase 4: Hook-Equivalent Event Monitoring

### Overview

Implement hook-equivalent behaviors via the Codex event stream, achieving **full behavioral parity** with pi-mono's extension system (`src/providers/pi-mono-extension.ts:380-619`). The pi-mono extension implements 21 distinct behaviors across 6 event types — all must be mapped to Codex App Server notifications.

This is implemented as a separate file (`codex-hooks.ts`) following the same separation pattern as pi-mono (`pi-mono-extension.ts` is separate from `pi-mono-adapter.ts`).

### Event Mapping: Pi-mono → Codex

| Pi-mono Event | Codex Trigger | Behaviors |
|---|---|---|
| `session_start` | `thread/started` notification | Server ping, clear tool history, lead concurrent context |
| `tool_call` | `item/started` (tool types) | Cancellation check, loop detection, poll-task blocking, shared disk write prevention |
| `tool_result` | `item/completed` (tool types) | Heartbeat, activity timestamp, shared disk write failure detection, identity file sync, setup script sync, memory auto-index, store-progress reminders |
| `context` | _(no direct equivalent)_ | Goal reminder on compaction |
| `input` | Before `turn/start` | Cancellation check at iteration start |
| `session_shutdown` | Process exit / final `turn/completed` | Identity file sync, setup script sync, session summarization, mark agent offline |

### Key Architectural Difference: No Per-Tool Blocking

Pi-mono's `tool_call` handler can return `{ block: true, reason: "..." }` to prevent individual tool execution. Codex App Server with `approval_policy: "never"` has no per-tool blocking mechanism. When cancellation or loop detection triggers, the Codex adapter must use `turn/interrupt` to abort the entire turn (not just block one tool). This means:
- Cancellation is slightly more aggressive (aborts turn vs blocking one tool)
- Loop detection threshold should be slightly higher to avoid false positives (since recovery is harder)

### Changes Required:

#### 1. Codex Hooks Module
**File**: `src/providers/codex-hooks.ts` (new)
**Changes**: Create a hooks module with the same config interface as pi-mono:

```typescript
interface CodexHooksConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId: string;
  isLead: boolean;
}
```

**Shared helper functions** (same as `pi-mono-extension.ts:21-277`):
- `apiHeaders(config)` — standard auth headers (`pi-mono-extension.ts:21-27`)
- `fireAndForget(url, init)` — swallow-error fetch (`pi-mono-extension.ts:30-32`)
- `isTaskCancelled(config)` — poll cancellation endpoint (`pi-mono-extension.ts:35-52`)
- `checkShouldBlockPolling(config)` — poll `/me` for polling limit (`pi-mono-extension.ts:55-67`)
- `fetchTaskDetails(config)` — get task for goal reminder (`pi-mono-extension.ts:70-83`)
- `syncIdentityFilesToServer(config, source)` — sync SOUL.md/IDENTITY.md/TOOLS.md (`pi-mono-extension.ts:86-122`)
- `syncSetupScriptToServer(config, source)` — sync start-up.sh (`pi-mono-extension.ts:125-158`)
- `isOwnedSharedPath(path, agentId)` — check shared disk ownership (`pi-mono-extension.ts:165-168`)
- `sharedDiskWriteWarning(agentId)` — format warning message (`pi-mono-extension.ts:173-183`)
- `autoIndexMemoryFile(config, path)` — index memory file (`pi-mono-extension.ts:186-207`)
- `fetchConcurrentContext(config)` — lead concurrent context (`pi-mono-extension.ts:210-277`)
- `summarizeSession(config, sessionFile)` — Claude Haiku summarization (`pi-mono-extension.ts:280-372`)

**Note**: These are currently duplicated from `pi-mono-extension.ts`. Extracting them to a shared `src/providers/shared-hooks.ts` module is desirable but is a separate refactor — doing it here would change the pi-mono adapter's imports and risk regressions.

**Export a `CodexHooks` class** that the adapter calls at each event:

```typescript
export class CodexHooks {
  constructor(private config: CodexHooksConfig) {}

  /** Called on thread/started — equivalent to SessionStart */
  async onSessionStart(): Promise<void>

  /** Called on item/started (tool types) — equivalent to PreToolUse */
  async onToolStart(toolName: string, toolInput: unknown): Promise<{ abort: boolean; reason?: string }>

  /** Called on item/completed (tool types) — equivalent to PostToolUse */
  async onToolEnd(toolName: string, toolInput: unknown, result: unknown): Promise<void>

  /** Called before turn/start on iterations > 1 — equivalent to UserPromptSubmit */
  async onIterationStart(): Promise<{ abort: boolean; reason?: string }>

  /** Called on process exit / final turn/completed — equivalent to Stop */
  async onSessionEnd(logFile?: string): Promise<void>
}
```

#### 2. Hook Behaviors — `onSessionStart()` (→ SessionStart)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:383-401`):

1. **Server ping** — `fireAndForget(apiUrl + "/ping", { method: "POST", headers })`. Signals agent is online.
2. **Clear tool loop history** — `clearToolHistory(taskId)`. Import from `../hooks/tool-loop-detection` (same import pi-mono uses at line 10).
3. **Lead concurrent context** — If `isLead`, call `fetchConcurrentContext(config)`. Log result to console (gets captured in adapter's stderr → `raw_stderr` event). Workers skip this.

#### 3. Hook Behaviors — `onToolStart()` (→ PreToolUse)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:405-475`):

4. **Cancellation check** (workers only) — Call `isTaskCancelled(config)`. If cancelled, return `{ abort: true, reason: "..." }`. The adapter calls `this.abort()` (sends `turn/interrupt`).
5. **Tool loop detection** (workers only) — Call `checkToolLoop(taskId, toolName, toolInput)` (import from `../hooks/tool-loop-detection`). On `blocked`: return `{ abort: true, reason: "..." }`. On `warning`: log warning to console.
6. **Block poll-task** — If `toolName` ends with `"poll-task"` (accounting for Codex's `mcp__agent-swarm__` prefix), call `checkShouldBlockPolling(config)`. If blocked, return `{ abort: true }`.
7. **Shared disk write prevention** (Archil only, `ARCHIL_MOUNT_TOKEN` set) — If tool is a write/edit operation and target path is under `/workspace/shared/` but not owned by this agent, log warning. Codex tool names: check for `Bash` (command may write), `Write`, `Edit`, and `fileChange` item types.

**Tool name normalization**: Codex MCP tools arrive as `mcp__agent-swarm__<name>`. Normalize before matching: strip `mcp__agent-swarm__` prefix. Native Codex tools use PascalCase (`Bash`, `Write`, `Edit`) unlike pi-mono's lowercase (`bash`, `write`, `edit`).

#### 4. Hook Behaviors — `onToolEnd()` (→ PostToolUse)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:478-556`):

8. **Heartbeat** (workers only) — `fireAndForget(apiUrl + "/api/active-sessions/heartbeat/" + taskId, { method: "PUT", headers })`. Prevents task from being marked stale.
9. **Activity timestamp** — `fireAndForget(apiUrl + "/api/agents/" + agentId + "/activity", { method: "PUT", headers })`. Updates agent's last-active time.
10. **Shared disk write failure detection** (Archil only) — If tool result contains `"Read-only file system"` and path is under `/workspace/shared/`, log warning.
11. **Identity file sync on write** — If tool wrote to `/workspace/SOUL.md`, `/workspace/IDENTITY.md`, or `/workspace/TOOLS.md`, call `syncIdentityFilesToServer(config, "self_edit")` (fire-and-forget).
12. **Setup script sync on write** — If tool wrote to `/workspace/start-up*`, call `syncSetupScriptToServer(config, "self_edit")` (fire-and-forget).
13. **Memory auto-index** — If tool wrote to `/workspace/personal/memory/` or `/workspace/shared/memory/`, call `autoIndexMemoryFile(config, editedPath)` (fire-and-forget).
14. **Store-progress reminders** — Workers: log "Remember to call store-progress periodically...". Leads after send-task: log "Task sent successfully. Monitor progress...".

#### 5. Hook Behaviors — `onIterationStart()` (→ UserPromptSubmit)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:586-599`):

15. **Cancellation check at iteration start** (workers only) — Same as behavior #4 but triggered before sending a new `turn/start`. If cancelled, return `{ abort: true }` and the adapter skips starting the turn.

#### 6. Hook Behaviors — `onSessionEnd()` (→ Stop)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:602-618`):

16. **Identity file sync** (session end) — `syncIdentityFilesToServer(config, "session_sync")`. Final sync of SOUL.md/IDENTITY.md/TOOLS.md.
17. **Setup script sync** (session end) — `syncSetupScriptToServer(config, "session_sync")`. Final sync of start-up.sh.
18. **Session summarization** — Call `summarizeSession(config, logFile)`. Uses Claude Haiku to summarize the session transcript and index it into memory. Skip if `SKIP_SESSION_SUMMARY` env var is set.
19. **Mark agent offline** — `fireAndForget(apiUrl + "/close", { method: "POST", headers })`.

#### 7. Goal Reminder on Compaction (→ PreCompact)
**File**: `src/providers/codex-hooks.ts`
**Behaviors** (from `pi-mono-extension.ts:561-583`):

20. **Goal reminder** — Codex does not emit a notification before auto-compacting context. Two options:
    - **Option A (pragmatic)**: Skip this behavior — Codex manages its own context window. The `developer_instructions` in `thread/start` settings already contain the task goal.
    - **Option B (if needed later)**: The adapter could monitor for increasing token counts in `turn/completed` usage and proactively call `thread/compact/start` itself, injecting a goal reminder as a `turn/steer` message before compaction.

    **Decision**: Go with Option A for MVP. The `developer_instructions` persist across compaction in Codex, so the model retains the goal. If agents lose track of goals in practice, add Option B as a follow-up.

#### 8. Adapter Integration
**File**: `src/providers/codex-adapter.ts`
**Changes**: Wire `CodexHooks` into the adapter's notification handler:

```typescript
// In CodexSession constructor:
this.hooks = new CodexHooks({
  apiUrl: config.apiUrl,
  apiKey: config.apiKey,
  agentId: config.agentId,
  taskId: config.taskId,
  isLead: config.role === "lead",
});

// In notification handler:
case "thread/started":
  await this.hooks.onSessionStart();
  break;
case "item/started":
  if (isToolItem(params.type)) {
    const { abort, reason } = await this.hooks.onToolStart(toolName, toolInput);
    if (abort) { await this.abort(); /* emit reason as raw_log */ }
  }
  break;
case "item/completed":
  if (isToolItem(params.type)) {
    await this.hooks.onToolEnd(toolName, toolInput, result);
  }
  break;

// In process cleanup (after waitForCompletion resolves):
await this.hooks.onSessionEnd(config.logFile);
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test src/tests/codex-adapter.test.ts` (add hook-equivalent tests)
- [ ] Unit tests for hooks: `bun test src/tests/codex-hooks.test.ts`

#### Manual Verification:
- [ ] Cancel a running Codex task via API — verify the worker interrupts the turn and reports back
- [ ] Heartbeat: Long-running task doesn't get marked as stale (check `lastHeartbeat` in DB)
- [ ] Activity timestamp: Agent shows recent activity in dashboard
- [ ] Loop detection: Create a task that would loop — verify it gets detected and turn is interrupted
- [ ] Identity file sync: Write to SOUL.md during task — verify it syncs to agent profile
- [ ] Memory auto-index: Write to memory dir — verify it appears in memory search
- [ ] Agent offline: After task completes, agent shows offline status
- [ ] Session summarization: After task completes, check memory for session summary entry
- [ ] Store-progress reminders appear in session logs

**Implementation Note**: After completing this phase, pause for manual confirmation. The adapter now has full behavioral parity with pi-mono's extension system.

---

## Phase 5: Docker Integration

### Overview

Add Codex CLI to the Docker worker image and configure the entrypoint for Codex provider selection — auth validation, `config.toml` generation, and AGENTS.md handling.

### Changes Required:

#### 1. Dockerfile — CLI Installation
**File**: `Dockerfile.worker`
**Changes**: After the pi-mono install block (line ~85), add:

```dockerfile
# Install Codex CLI (alternative harness, selected via HARNESS_PROVIDER=codex)
RUN npm install -g @openai/codex@0.111.0
```

Pin version for reproducibility (same pattern as pi-mono).

#### 2. Docker Entrypoint — Auth Validation
**File**: `docker-entrypoint.sh`
**Changes**: Add a `codex` case to the auth validation block (lines 7-19):

```bash
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Error: OPENAI_API_KEY environment variable is required for codex provider"
        exit 1
    fi
```

#### 3. Docker Entrypoint — Config Generation
**File**: `docker-entrypoint.sh`
**Changes**: Add config.toml generation in the provider-specific setup section (near the MCP config writing for Claude/pi-mono):

```bash
if [ "$HARNESS_PROVIDER" = "codex" ]; then
    mkdir -p /home/worker/.codex
    cat > /home/worker/.codex/config.toml <<TOML
model = "${MODEL:-o3}"
approval_policy = "never"
sandbox_mode = "danger-full-access"
project_doc_fallback_filenames = ["AGENTS.md", "CLAUDE.md"]

[history]
persistence = "none"

[mcp_servers.agent-swarm]
type = "http"
url = "${MCP_BASE_URL}/mcp"
bearer_token_env_var = "API_KEY"
env_http_headers = { "X-Agent-ID" = "AGENT_ID" }
TOML
fi
```

Note: `project_doc_fallback_filenames` includes `CLAUDE.md`, so no `AGENTS.md -> CLAUDE.md` symlink is needed (simpler than pi-mono's approach).

#### 4. Environment Variables Documentation
**File**: `CONTRIBUTING.md` or `CLAUDE.md`
**Changes**: Document new env vars:
- `OPENAI_API_KEY` — Required when `HARNESS_PROVIDER=codex`
- `MODEL` — Codex model override (default: `o3`)

### Success Criteria:

#### Automated Verification:
- [ ] Docker image builds: `docker build -f Dockerfile.worker .`
- [ ] Codex CLI is accessible: `docker run --rm <image> codex --version`
- [ ] Entrypoint validates auth: `docker run --rm -e HARNESS_PROVIDER=codex <image>` exits with error about missing `OPENAI_API_KEY`
- [ ] Config.toml generated: `docker run --rm -e HARNESS_PROVIDER=codex -e OPENAI_API_KEY=test -e API_KEY=test -e MCP_BASE_URL=http://test <image> cat /home/worker/.codex/config.toml`

#### Manual Verification:
- [ ] Full Docker worker startup with `HARNESS_PROVIDER=codex` — connects to API, polls for tasks
- [ ] Config.toml has correct MCP server config with agent-swarm endpoint
- [ ] `CLAUDE.md` is read by Codex without needing a symlink (verify via Codex logs)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: Unit Tests

### Overview

Write unit tests for the JSON-RPC client and adapter, following the project's testing patterns (isolated SQLite DBs, unique ports, cleanup in afterAll).

### Changes Required:

#### 1. JSON-RPC Client Tests
**File**: `src/tests/codex-jsonrpc.test.ts` (new)
**Changes**:
- Test request/response correlation (send request, mock response, verify promise resolves)
- Test notification routing (mock server notification, verify listener called)
- Test server-initiated requests (mock approval request, verify response sent)
- Test partial line buffering (split a JSONL message across two chunks)
- Test error response handling (JSON-RPC error codes)
- Test `close()` cleanup
- Use mock subprocess (pipe pair) rather than spawning real `codex app-server`

#### 2. Adapter Tests
**File**: `src/tests/codex-adapter.test.ts` (new)
**Changes**:
- Test event mapping: Mock item notifications → verify correct ProviderEvent types emitted
- Test `raw_log` format: Verify Claude-compatible JSON structure for each item type
- Test deduplication: Same message text emitted twice → only one `raw_log` event
- Test MCP tool name normalization: `mcp__agent-swarm__join-swarm` → `join-swarm`
- Test cost calculation: Token counts → USD cost
- Test resume logic: Config with `resumeSessionId` → sends `thread/resume`
- Test stale session fallback: `thread/resume` error → falls back to `thread/start`
- Test approval auto-accept: `requestApproval` → responds with `{ decision: "accept" }`

Mock the `Bun.spawn` call to use pipe pairs instead of real processes.

#### 3. Hooks Tests
**File**: `src/tests/codex-hooks.test.ts` (new)
**Changes**:
- Test `onSessionStart()`: Verify server ping, tool history clear, concurrent context (mock API responses)
- Test `onToolStart()` cancellation: Mock cancelled task → verify returns `{ abort: true }`
- Test `onToolStart()` loop detection: Feed repeated tool calls → verify detection triggers
- Test `onToolStart()` poll-task blocking: Mock polling limit reached → verify abort
- Test `onToolEnd()` heartbeat: Verify heartbeat PUT is called
- Test `onToolEnd()` activity timestamp: Verify activity PUT is called
- Test `onToolEnd()` identity file sync: Mock file write to SOUL.md → verify sync API call
- Test `onToolEnd()` memory auto-index: Mock file write to memory dir → verify index API call
- Test `onIterationStart()` cancellation: Mock cancelled task → verify returns `{ abort: true }`
- Test `onSessionEnd()`: Verify identity sync, setup sync, offline marking
- Test tool name normalization: `mcp__agent-swarm__join-swarm` → `join-swarm` in hook checks

Mock all API calls using `Bun.serve()` on a test port or `globalThis.fetch` mock.

### Success Criteria:

#### Automated Verification:
- [ ] All tests pass: `bun test src/tests/codex-jsonrpc.test.ts src/tests/codex-adapter.test.ts src/tests/codex-hooks.test.ts`
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Tests cover the critical paths identified in research (event mapping, resume, approval, cost)
- [ ] No flaky tests (run 3x)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 7: End-to-End Verification

### Overview

Full E2E test with a real Codex worker in Docker against a local API server. This is the final verification phase.

### Changes Required:

No code changes — this is a testing/verification phase.

### E2E Test Flow:

```bash
# 1. Check port availability
lsof -i :3013

# 2. Start API server (use .env PORT if different)
bun run start:http &
API_PID=$!

# 3. Build Docker image with Codex support
docker build -f Dockerfile.worker -t agent-swarm-worker:codex-test .

# 4. Start Codex worker
docker run --rm -d \
  --name codex-e2e-test \
  --env-file .env.docker \
  -e HARNESS_PROVIDER=codex \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e MCP_BASE_URL=http://host.docker.internal:3013 \
  -e MAX_CONCURRENT_TASKS=1 \
  -e MODEL=o3 \
  -p 3204:3000 \
  agent-swarm-worker:codex-test

# 5. Create a trivial task
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"title":"Codex E2E test","description":"Say hello and create a file called /tmp/codex-test.txt with the text: codex works","source":"api"}'

# 6. Poll task status (should go pending -> in_progress -> completed)
curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/tasks | jq '.[0] | {id, status, claudeSessionId}'

# 7. Check session logs appear in dashboard
# Open http://localhost:5274 and navigate to the task

# 8. Test cancellation
# Create another task, then cancel it:
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/tasks \
  -d '{"title":"Cancel test","description":"Write a very long story about a dragon","source":"api"}'
# ... cancel via API or dashboard while in progress

# 9. Cleanup
docker stop codex-e2e-test
kill $API_PID
```

### Success Criteria:

#### Automated Verification:
- [ ] Pre-PR checks pass: `bun run lint:fix && bun run tsc:check && bun test`
- [ ] Docker builds: `docker build -f Dockerfile.worker .`

#### Manual Verification:
- [ ] Task executes successfully with Codex
- [ ] `claudeSessionId` is populated (thread ID saved)
- [ ] Session logs render in dashboard with text, tool use, and tool result bubbles
- [ ] Cost data appears (non-zero USD amount)
- [ ] Cancellation works — task transitions to cancelled, worker stops the turn
- [ ] No orphaned `codex app-server` processes in the container after task completion
- [ ] Worker picks up another task after the first one completes (process cleanup is clean)

**Implementation Note**: This is the final manual review point before the PR is ready.

---

## Testing Strategy

### Unit Tests
- `src/tests/codex-jsonrpc.test.ts` — JSON-RPC client transport layer
- `src/tests/codex-adapter.test.ts` — Adapter event mapping, resume, approval, cost
- `src/tests/codex-hooks.test.ts` — Hook-equivalent behaviors (cancellation, heartbeat, loop detection, identity sync, memory index, session summarization)

### Integration Tests
- Docker E2E flow (Phase 7) — Full lifecycle with real Codex

### Manual Testing
- Dashboard session log rendering
- Cancellation flow
- Process cleanup verification
- Cost tracking accuracy
- Agent online/offline status transitions
- Identity file sync and memory indexing
- Session summarization in memory

## References

- Research: `thoughts/taras/research/2026-03-11-codex-native-support-feasibility.md`
- Deep reference: `thoughts/taras/research/2026-03-11-codex-adapter-deep-reference.md`
- GitHub issue: https://github.com/desplega-ai/agent-swarm/issues/100
- Codex App Server docs: https://developers.openai.com/codex/app-server/
- Pi-mono adapter (template): `src/providers/pi-mono-adapter.ts`
- Pi-mono plan (template): `thoughts/taras/plans/2026-03-08-pi-mono-provider-implementation.md`
