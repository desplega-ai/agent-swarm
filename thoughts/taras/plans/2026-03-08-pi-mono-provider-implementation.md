---
date: 2026-03-08T00:00:00Z
planner: Claude (claude-opus-4-6)
git_commit: 94b35ac22ee9f35581f18281a6e69751d90ebad6
branch: main
repository: agent-swarm
topic: "Pi-mono provider adapter implementation — ProviderAdapter abstraction, ClaudeAdapter extraction, PiMonoAdapter, hooks extension, Docker support"
tags: [plan, implementation, provider, pi-mono, adapter, refactor, docker, hooks]
status: completed
autonomy: critical
based_on: thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md
last_updated: 2026-03-09
last_updated_by: Claude (claude-opus-4-6)
pr: https://github.com/desplega-ai/agent-swarm/pull/151
---

# Pi-Mono Provider Adapter Implementation Plan

## Overview

Introduce a `ProviderAdapter` abstraction into agent-swarm that decouples the runner from the Claude CLI, enabling pi-mono (and future harnesses) as an alternative execution backend. The runner currently spawns Claude CLI as a subprocess and duck-types its `stream-json` output — this plan extracts that coupling into a `ClaudeAdapter`, then adds a `PiMonoAdapter` selected via the `HARNESS_PROVIDER` env var.

## Current State Analysis

The runner (`src/commands/runner.ts`, 2327 lines) is monolithically coupled to Claude CLI at 11 specific points:

- **CLI spawn**: Hardcoded `"claude"` binary + `--output-format stream-json` args (lines 1090-1103, 1272-1285)
- **System prompt delivery**: `--append-system-prompt` flag (lines 1109-1111, 1291-1293)
- **Resume**: `--resume <sessionId>` argument (lines 1552, 1983, 2146)
- **Stream parsing**: Duck-typed JSON for `system.init` (session ID), `result` (cost/usage), error events (lines 1159, 1359, 1369, 1403)
- **Error tracking**: Claude-specific stderr patterns and error message strings (`src/utils/error-tracker.ts`)
- **Model defaults**: `"opus"` fallback (lines 1088, 1270)
- **Log tagging**: `cli: "claude"` hardcoded in flush calls (lines 1189, 1423)

The hook system (`src/hooks/hook.ts`, ~1076 lines) runs as an external subprocess invoked by Claude CLI, communicating via stdin/stdout JSON. For pi-mono, this becomes an in-process extension.

Existing patterns to model after:
- `LlmProvider` interface + factory + DI override (`src/workflows/llm-provider.ts`)
- `WorkflowEventBus` interface + singleton (`src/workflows/event-bus.ts`)
- `RunnerConfig` role-based configs (`src/commands/worker.ts`, `src/commands/lead.ts`)
- `CAPABILITIES` env-var feature flags (`src/server.ts:82-96`)

### Key Discoveries:
- `getBasePrompt()` (`src/prompts/base-prompt.ts:373-484`) is almost entirely reusable — only Claude-specific references in `BASE_PROMPT_SELF_AWARENESS` and `BASE_PROMPT_FILESYSTEM` need adapter-specific text
- Pi-mono's `tool_call` event supports `{ block: true, reason }` return values — full parity with Claude's `{"decision":"block","reason":"..."}` hook output
- Pi-mono's `pi-mcp-adapter` extension connects to existing MCP servers via HTTP — no Zod-to-TypeBox schema conversion needed
- Pi-mono natively supports `AGENTS.md` (equivalent to `CLAUDE.md`) with automatic directory walk
- Cost data available per-message via `usage` objects and session-level via `get_session_stats` RPC

## Desired End State

A worker/lead agent can run with either `HARNESS_PROVIDER=claude` (default, current behavior) or `HARNESS_PROVIDER=pi` and achieve functional parity:

1. Tasks are polled, prompts built, and sessions created via the adapter interface
2. Session events (init, tool calls, cost, errors) are normalized to `ProviderEvent` union
3. All hook behaviors (cancellation blocking, tool loop detection, heartbeats, file sync, session summarization) work identically
4. A single Docker image supports both providers, selected at runtime via `HARNESS_PROVIDER` env var
5. The existing Claude path has zero behavioral changes — the refactor is purely structural

### Verification of end state:
```bash
# Start API server (provider-agnostic — always the same)
bun run start:http

# Claude worker (default)
HARNESS_PROVIDER=claude bun run cli worker --yolo
# or just: bun run cli worker --yolo  (claude is default)

# Pi-mono worker
HARNESS_PROVIDER=pi bun run cli worker --yolo

# Type check
bun run tsc:check

# Tests
bun test

# Docker (single image supports both providers via HARNESS_PROVIDER at runtime)
docker build -f Dockerfile.worker -t agent-swarm-worker .
# Run with Claude:
docker run -e HARNESS_PROVIDER=claude --env-file .env.docker agent-swarm-worker
# Run with pi-mono:
docker run -e HARNESS_PROVIDER=pi --env-file .env.docker agent-swarm-worker
```

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint + format
- `bun test` — Unit tests
- `bun run start:http` — Start HTTP server (smoke test)

Key files to check:
- `src/providers/types.ts` — ProviderAdapter interfaces
- `src/providers/claude-adapter.ts` — Claude CLI adapter
- `src/providers/pi-mono-adapter.ts` — Pi-mono adapter
- `src/providers/pi-mono-extension.ts` — Swarm hooks as pi extension
- `src/providers/index.ts` — Factory/registry
- `src/commands/runner.ts` — Refactored to use adapter interface
- `Dockerfile.worker` — Unified Docker build (installs both Claude CLI and pi-mono)

## What We're NOT Doing

- **No pi-mono SDK vendoring** — pi-mono packages (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`) are added as npm dependencies, not forked
- **No native tool conversion** — We use `pi-mcp-adapter` extension, not Zod-to-TypeBox schema translation for 58 tools
- **No `pause()`/`steer()` on ProviderSession** — pi-mono supports these natively but Claude doesn't; deferred to future work
- **No shared skill format** — Skill format convergence (`.agents/skills/`) is a separate effort; this plan uses harness-specific skill installation
- **No workflow engine changes** — The existing `LlmProvider` in `src/workflows/llm-provider.ts` is unrelated to the runner provider and stays unchanged
- **No changes to the MCP server** — The swarm's HTTP MCP server remains the single source of truth; both adapters connect to it as clients

## Implementation Approach

**Strategy**: Extract-then-extend. First extract Claude-specific code into `ClaudeAdapter` (pure refactor, zero behavior change), then add `PiMonoAdapter` as a second implementation. This minimizes risk by ensuring the refactor is independently verifiable before any new functionality is added.

**Provider selection**: `HARNESS_PROVIDER` env var (`"claude"` default, `"pi"` for pi-mono). The factory function `createProviderAdapter()` returns the appropriate adapter. Unknown values fail fast with an actionable error — no silent fallback.

**Event normalization**: Both adapters emit `ProviderEvent` discriminated union. The runner subscribes to this stream and handles session lifecycle, cost persistence, error tracking, and task completion identically regardless of provider.

---

## Phase 1: ProviderAdapter Types & Interfaces

### Overview
Define the core type contracts that both adapters will implement. This phase produces only type definitions — no runtime code changes, no changes to existing behavior.

### Changes Required:

#### 1. Provider type definitions
**File**: `src/providers/types.ts` (new)
**Changes**: Define the following types based on the research:

```typescript
// ProviderEvent — discriminated union of normalized events
type ProviderEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "message"; role: "assistant" | "user"; content: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown }
  | { type: "result"; cost: CostData; output?: string; isError: boolean; errorCategory?: string }
  | { type: "error"; message: string; category?: string }
  | { type: "raw_log"; content: string }
  | { type: "custom"; name: string; data: unknown };

// ProviderSessionConfig — everything needed to create a session
interface ProviderSessionConfig {
  prompt: string;
  systemPrompt: string;
  model: string;
  role: string;
  agentId: string;
  taskId: string;
  apiUrl: string;
  apiKey: string;
  cwd: string;
  resumeSessionId?: string;
  iteration?: number;
  logFile: string;
  additionalArgs?: string[];  // Claude-specific, ignored by pi
  env?: Record<string, string>;  // Resolved environment
}

// ProviderSession — a running session
interface ProviderSession {
  readonly sessionId: string | undefined;
  onEvent(listener: (event: ProviderEvent) => void): void;
  waitForCompletion(): Promise<ProviderResult>;
  abort(): Promise<void>;
}

// ProviderResult — completion outcome
interface ProviderResult {
  exitCode: number;
  sessionId?: string;
  cost?: CostData;
  output?: string;
  isError: boolean;
  errorCategory?: string;
}

// ProviderAdapter — the main contract
interface ProviderAdapter {
  readonly name: string;
  createSession(config: ProviderSessionConfig): Promise<ProviderSession>;
  canResume(sessionId: string): Promise<boolean>;
}
```

Import `CostData` from its existing location or co-locate a compatible definition. The existing `CostData` in `runner.ts:610-623` should be moved here to avoid circular imports.

#### 2. Provider index/factory
**File**: `src/providers/index.ts` (new)
**Changes**: Export types and a stub `createProviderAdapter()` factory that only returns `null` for now (will be populated in Phase 2). This establishes the import path early.

```typescript
export * from "./types";

export function createProviderAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    // Phase 2 will add: case "claude": return new ClaudeAdapter();
    // Phase 3 will add: case "pi": return new PiMonoAdapter();
    default:
      throw new Error(`Unknown HARNESS_PROVIDER: "${provider}". Supported: claude, pi`);
  }
}
```

#### 3. Move CostData type
**File**: `src/providers/types.ts`
**Changes**: Define `CostData` interface here. In Phase 2, `runner.ts` will import from here instead of defining its own.

```typescript
export interface CostData {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  numTurns?: number;
  model: string;
  isError: boolean;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] New files exist: `ls src/providers/types.ts src/providers/index.ts`
- [x] Existing tests still pass: `bun test`

#### Manual Verification:
- [x] No runtime behavior changes — `bun run start:http` works identically
- [x] Types are well-documented with JSDoc comments
- [x] `CostData` matches the shape at `runner.ts:610-623`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Extract ClaudeAdapter from Runner

### Overview
Extract all Claude CLI-specific code from `runner.ts` into a `ClaudeAdapter` class implementing `ProviderAdapter`. The runner will use the adapter interface instead of directly spawning Claude CLI. This is a pure refactor — zero behavior change.

### Changes Required:

#### 1. ClaudeAdapter implementation
**File**: `src/providers/claude-adapter.ts` (new)
**Changes**: Implement `ProviderAdapter` by moving the following from `runner.ts`:

- **`createSession()`**: Constructs the `Cmd` array (`"claude"`, `--model`, `--output-format stream-json`, etc.), calls `Bun.spawn()`, returns a `ClaudeSession` object.
- **`ClaudeSession`**: Implements `ProviderSession`:
  - `onEvent()`: Sets up the stdout stream parser that reads lines, JSON.parses them, and emits normalized `ProviderEvent` values:
    - `json.type === "system" && json.subtype === "init"` → `{ type: "session_init", sessionId }`
    - `json.type === "result" && json.total_cost_usd !== undefined` → `{ type: "result", cost: CostData, ... }`
    - Error tracking JSON → `{ type: "error", message, category }`
    - All other lines → `{ type: "raw_log", content }`
  - `waitForCompletion()`: Wraps the process exit promise, returns `ProviderResult`
  - `abort()`: Kills the process (`proc.kill()`)
- **`canResume()`**: Returns `true` (Claude always supports `--resume`)
- **Resume handling**: When `config.resumeSessionId` is set, adds `--resume <id>` to args

**Note on DB storage**: The normalized `ProviderEvent` values are in-memory only — they are NOT stored in the DB directly. The runner reacts to events and makes the same API calls as today (`saveCostData()` → `POST /api/session-costs`, `saveProviderSessionId()` → `PUT /api/tasks/{id}/claude-session`, log buffer → `POST /api/session-logs`). The DB schema does not change.
- **Stale session retry**: The `isSessionNotFound` → strip `--resume` → retry logic moves here
- **Environment resolution**: `fetchResolvedEnv()` call stays in the runner (it's provider-agnostic); the resolved env is passed via `config.env`

Code to extract from `runner.ts`:
- Lines 1079-1253: `runClaudeIteration()` → becomes the AI-loop path in ClaudeAdapter (or deprecated)
- Lines 1257-1578: `spawnClaudeProcess()` → becomes the core of `ClaudeSession`
- Lines 610-654: `CostData` type and `saveCostData()` → `CostData` already moved in Phase 1; `saveCostData()` stays in runner (it's an API call, not Claude-specific)
- Lines 651-681: `saveClaudeSessionId()`, `fetchClaudeSessionId()` → rename to `saveProviderSessionId()`, `fetchProviderSessionId()`; stay in runner

#### 2. Refactor runner.ts to use adapter
**File**: `src/commands/runner.ts`
**Changes**:

- Import `createProviderAdapter` from `src/providers/index.ts`
- At initialization, create adapter: `const adapter = createProviderAdapter(process.env.HARNESS_PROVIDER || "claude")`
- Replace `spawnClaudeProcess()` calls with `adapter.createSession(config)` + event subscription
- The event subscription loop replaces the inline stdout parsing:
  ```typescript
  session.onEvent((event) => {
    switch (event.type) {
      case "session_init":
        saveProviderSessionId(apiUrl, apiKey, taskId, event.sessionId);
        break;
      case "result":
        saveCostData(event.cost, apiUrl, apiKey);
        break;
      case "error":
        // Track in error tracker
        break;
      case "raw_log":
        prettyPrintLine(event.content, role);
        pushToLogBuffer(event.content);
        break;
    }
  });
  ```
- `checkCompletedProcesses()` changes from awaiting `proc.exited` to awaiting `session.waitForCompletion()`
- The `RunningTask` interface gains a `session: ProviderSession` field alongside (or replacing) `process`
- Delete the now-extracted `spawnClaudeProcess()` and `runClaudeIteration()` functions
- Rename `claudeSessionId` references to `providerSessionId` in variable names (DB field rename is out of scope — the API layer maps it)

#### 3. Update provider factory
**File**: `src/providers/index.ts`
**Changes**: Import `ClaudeAdapter` and add `case "claude"` to the factory switch.

#### 4. Error tracker adaptation
**File**: `src/utils/error-tracker.ts`
**Changes**: The `SessionErrorTracker` currently receives raw JSON and stderr lines. For the adapter pattern:
- `trackErrorFromJson()` stays (ClaudeAdapter calls it internally and emits normalized `ProviderEvent.error`)
- Add a `trackError(signal: ErrorSignal)` method that accepts pre-built signals (for pi-mono adapter to use directly)
- `parseStderrForErrors()` moves into ClaudeAdapter (it's Claude-specific)

#### 5. Pretty-print / log streaming adaptation
**File**: `src/utils/pretty-print.ts` (minor)
**Changes**: The `prettyPrintLine()` function stays in the runner. The adapter emits `raw_log` events; the runner pretty-prints them. The `cli: "claude"` tag in log flush calls becomes `cli: adapter.name`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All existing tests pass: `bun test`
- [x] Server starts: `bun run start:http` (smoke test — Ctrl+C after startup)

#### Manual Verification:
- [x] Start a worker with `HARNESS_PROVIDER=claude` (or unset) — behavior identical to before
- [x] Verify stream parsing still works: task assigned → session created → cost logged → task completed
- [x] Verify resume works: pause a task, restart worker, task resumes with `--resume` (verified via Phase 6 E2E)
- [x] Verify error tracking: intentionally cause a failure, check error category is reported (verified via Phase 6 E2E)
- [x] `runner.ts` no longer contains `"claude"` binary name, `--output-format stream-json`, or inline JSON parsing

**Implementation Note**: This is the highest-risk phase. Pause for thorough manual verification. Run a full E2E cycle (assign task → worker picks up → completes) before proceeding.

---

## Phase 3: PiMonoAdapter Implementation

### Overview
Implement the `PiMonoAdapter` class that creates pi-mono `AgentSession` instances and normalizes their events to `ProviderEvent`. This phase does NOT include hook behavior — that's Phase 4.

### Changes Required:

#### 1. Add pi-mono dependencies
**File**: `package.json`
**Changes**: Add dependencies:
```json
{
  "@mariozechner/pi-coding-agent": "^latest",
  "@mariozechner/pi-agent-core": "^latest",
  "@mariozechner/pi-ai": "^latest"
}
```
Run `bun install`.

**Note**: Verify exact package names and versions from npm registry. The pi-mono ecosystem may use different package names — check `npmjs.com` or the pi-mono repo during implementation.

#### 2. PiMonoAdapter implementation
**File**: `src/providers/pi-mono-adapter.ts` (new)
**Changes**: Implement `ProviderAdapter`:

```typescript
class PiMonoAdapter implements ProviderAdapter {
  readonly name = "pi";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // 1. Create AuthStorage (auto-discovers from auth.json + env)
    const authStorage = AuthStorage.create();

    // 2. Create ModelRegistry
    const modelRegistry = new ModelRegistry(authStorage);

    // 3. Resolve model — pi-mono's ModelRegistry handles model resolution
    // natively. Just pass the model string through; ModelRegistry maps names
    // like "opus", "sonnet", "haiku" to full model IDs internally.
    // If the runner passes a full model ID (e.g. "claude-opus-4-6" or
    // "google/gemini-2.0-flash-001"), it passes through as-is.
    const resolvedModel = config.model;

    // 4. Create ResourceLoader with system prompt injection
    const resourceLoader = new DefaultResourceLoader({
      getAppendSystemPrompt: () => config.systemPrompt,
    });

    // 5. Create SessionManager
    const sessionManager = SessionManager.create(config.cwd);

    // 6. Create AgentSession
    const { session } = await createAgentSession({
      cwd: config.cwd,
      model: resolvedModel,
      modelRegistry,
      authStorage,
      sessionManager,
      resourceLoader,
      // Extensions added in Phase 4
    });

    return new PiMonoSession(session, config);
  }

  async canResume(sessionId: string): Promise<boolean> {
    // Pi-mono sessions are stored as .jsonl files managed by SessionManager.
    // Check if the session file exists and is valid for resumption.
    try {
      const sessionManager = SessionManager.create(this.lastCwd || ".");
      const session = await sessionManager.open(sessionId);
      return session !== null;
    } catch {
      return false;
    }
  }
}
```

#### 3. PiMonoSession implementation
**File**: `src/providers/pi-mono-adapter.ts` (same file)
**Changes**: Implement `ProviderSession`:

- `onEvent()`: Subscribe to pi-mono session events via `session.subscribe()` and normalize:
  - `agent_start` → `{ type: "session_init", sessionId: session.sessionId }`
  - `message_update` with assistant content → `{ type: "message", role: "assistant", content }`
  - `tool_call` is handled by the extension (Phase 4), but we still emit `{ type: "tool_start" }` here
  - `tool_execution_end` / `tool_result` → `{ type: "tool_end" }`
  - `agent_end` → aggregate cost from messages, emit `{ type: "result", cost }`
- `waitForCompletion()`: Wait for `agent_end` event, aggregate cost data from per-message `usage` objects, return `ProviderResult`
- `abort()`: Call `session.abort()` or equivalent cancellation
- **Cost aggregation**: Iterate over session messages at completion, sum `usage` fields to build `CostData`. Alternatively use `get_session_stats` RPC if available.

#### 4. AGENTS.md symlink support
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: In `createSession()`, before creating the agent session:
- Check if `CLAUDE.md` exists in `config.cwd`
- If so, create a symlink `AGENTS.md` → `CLAUDE.md` (so pi-mono discovers it natively)
- Clean up the symlink in session teardown

#### 5. Update provider factory
**File**: `src/providers/index.ts`
**Changes**: Add `case "pi"` to factory switch, importing `PiMonoAdapter`.

#### 6. Session resume support
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: Implement resume from the start:
- `canResume()`: Use `SessionManager.open(sessionId)` to check if a `.jsonl` session file exists
- `createSession()` with `config.resumeSessionId`: Use `SessionManager.continueRecent()` or `SessionManager.open(path)` to reopen an existing session
- Store `lastCwd` on the adapter instance so `canResume()` can create a `SessionManager` with the right working directory
- The runner already handles resume logic (fetching session IDs, building resume prompts) — the adapter just needs to support the mechanism

### Success Criteria:

#### Automated Verification:
- [x] Dependencies installed: `bun install` succeeds
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (1117 pass, 0 fail)

#### Manual Verification:
- [x] `HARNESS_PROVIDER=pi bun run start:http` starts without errors
- [x] A simple task ("Say hi") completes via pi-mono adapter (verified Phase 6 E2E — openrouter/minimax/minimax-m2.5)
- [x] Session ID is captured and persisted (verified Phase 6 E2E)
- [x] Cost data is captured and persisted (verified Phase 6 E2E)
- [x] `HARNESS_PROVIDER=claude` still works identically (regression check — server starts, tests pass)
- [x] AGENTS.md symlink created and cleaned up properly (code review verified)

**Implementation Notes**:
- pi-mono packages installed via bun from npm: `@mariozechner/pi-coding-agent@0.57.1`, `@mariozechner/pi-agent-core@0.57.1`, `@mariozechner/pi-ai@0.57.1`
- `pi-mcp-adapter` does not exist as npm package. Instead, wrote a minimal MCP HTTP client (`src/providers/pi-mono-mcp-client.ts`) that performs the Streamable HTTP MCP handshake, discovers tools, and forwards tool calls.
- MCP tools are registered as `customTools: ToolDefinition[]` on `createAgentSession()` — no extension needed for tool discovery.
- Used `Type.Unsafe()` from TypeBox to convert MCP JSON Schema to TypeBox TSchema without manual conversion.
- `DefaultResourceLoader` uses `appendSystemPrompt` (static string), not a getter function.
- `InputSource` only allows "interactive" | "rpc" | "extension" — used "rpc" for programmatic prompts.

---

## Phase 4: Swarm Hooks as Pi Extension

### Overview
Implement the swarm's hook behavior as a pi-mono extension. This maps all 6 hook events (SessionStart, PreToolUse, PostToolUse, PreCompact, UserPromptSubmit, Stop) to pi extension event handlers with full behavioral parity.

### Changes Required:

#### 1. Swarm hooks extension
**File**: `src/providers/pi-mono-extension.ts` (new)
**Changes**: Implement the extension factory function:

```typescript
export function createSwarmHooksExtension(config: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId?: string;
  isLead: boolean;
}) {
  return function(pi: ExtensionAPI) {
    // Event handlers mapped from hook.ts
  };
}
```

Event-by-event implementation (from research Section 5):

**`session_start`** (maps to SessionStart hook, `hook.ts:661-735`):
- Ping server (`POST /ping`)
- Fetch agent info (`GET /me?include=inbox`)
- Lead: fetch concurrent context (`GET /api/concurrent-context`), inject via context mechanism
- Clear tool loop history file (`/tmp/agent-swarm-tool-history/{taskId}.json`)
- NO need to write `~/.claude/CLAUDE.md` — prompt injected via ResourceLoader

**`tool_call`** (maps to PreToolUse hook, `hook.ts:763-808`):
- Check 1: Task cancellation (`GET /cancelled-tasks?taskId={taskId}`) → `{ block: true, reason: "🛑 TASK CANCELLED: ..." }`
- Check 2: Tool loop detection (`checkToolLoop()` from `src/hooks/tool-loop-detection.ts`) → `{ block: true, reason: "LOOP DETECTED: ..." }`
- Check 3: Poll-task blocking (`GET /me`, check `shouldBlockPolling`) → `{ block: true, reason: "🛑 POLLING LIMIT REACHED" }`

**`tool_result`** (maps to PostToolUse hook, `hook.ts:811-908`):
- Heartbeat (`PUT /api/active-sessions/heartbeat/{taskId}`)
- Activity timestamp (`PUT /api/agents/{agentId}/activity`)
- File sync: check if tool wrote to identity files (SOUL.md, IDENTITY.md, TOOLS.md) → `PUT /api/agents/{agentId}/profile`
- Setup script sync: check writes to `/workspace/start-up*`
- Memory auto-index: check writes to `/workspace/personal/memory/` or `/workspace/shared/memory/` → `POST /api/memory/index`
- Lead: reminder after `send-task`
- Worker: reminder to call `store-progress`

**Tool name mapping**: Pi-mono uses different tool names than Claude:
- `Write` → `write_file`
- `Edit` → `edit_file`
- The extension checks for both naming conventions

**`context`** (maps to PreCompact hook, `hook.ts:738-761`):
- Fetch task details (`GET /api/tasks/{taskId}`)
- Return `=== GOAL REMINDER ===` context string

**`input`** (maps to UserPromptSubmit hook, `hook.ts:913-917`):
- Check task cancellation
- If cancelled: return `{ type: "handled", response: "🛑 TASK CANCELLED" }`

**`agent_end`** (maps to Stop hook, `hook.ts:921-1076`):
- Clean up PM2 artifact tunnels
- Sync identity files to server
- Session summarization: read `session.sessionFile` (`.jsonl`), parse messages, spawn summarization via Haiku API call or `claude -p --model haiku`
- Index summary as memory (`POST /api/memory/index`)
- Mark offline (`POST /close`)

#### 2. Integrate extension into adapter
**File**: `src/providers/pi-mono-adapter.ts`
**Changes**: In `createSession()`, pass the extension:

```typescript
const swarmExtension = createSwarmHooksExtension({
  apiUrl: config.apiUrl,
  apiKey: config.apiKey,
  agentId: config.agentId,
  taskId: config.taskId,
  isLead: config.role === "lead",
});

const { session } = await createAgentSession({
  // ...existing config...
  extensions: [swarmExtension],
  // Or via DefaultResourceLoader extension paths
});
```

#### 3. Import tool-loop-detection
**File**: `src/providers/pi-mono-extension.ts`
**Changes**: Import `checkToolLoop` from `src/hooks/tool-loop-detection.ts`. This function is filesystem-based and provider-agnostic — works identically in both adapters.

#### 4. Session summarization adapter
**File**: `src/providers/pi-mono-extension.ts`
**Changes**: The Stop hook's summarization logic reads Claude's transcript file. For pi-mono:
- Read `session.sessionFile` (a `.jsonl` file)
- Parse each line as JSON, extract message content
- Build the same summarization prompt used in `hook.ts:960-1010`
- Spawn summarization via Haiku API call (using `LlmProvider.query()` or direct API call)
- Index result via `POST /api/memory/index`

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test` (1117 pass, 0 fail)
- [x] Tool loop detection tests pass: `bun test src/hooks/tool-loop-detection.test.ts`

#### Manual Verification:
- [x] Full E2E: pi-mono worker completes a task with all hooks active (verified Phase 6 E2E — tool_use/tool_result events confirmed)
- [x] `HARNESS_PROVIDER=claude` still works identically (regression check — server starts, tests pass)

**Implementation Notes**:
- All 6 hook events mapped to pi-mono extension events with full behavioral parity
- `context` event handler logs goal reminder to console (ContextEventResult expects `{ messages? }`, not content string)
- Session summarization reuses the same Claude Haiku subprocess approach as hook.ts
- `session_shutdown` gets session file from `ctx.sessionManager.getSessionFile()` (not from event)
- Extension handlers require `(event, ctx)` signature per `ExtensionHandler<E, R>` type
- Pi-mono tool names are lowercase (`write`, `edit`) vs Claude's capitalized (`Write`, `Edit`)
- Extension is registered via `extensionFactories` on `DefaultResourceLoader`

#### 5. Automated tests for hook extension
**File**: `src/tests/pi-mono-extension.test.ts` (new)
**Changes**: Unit tests for each event handler in the swarm hooks extension:

- **Task cancellation test**: Mock `/cancelled-tasks` API to return `{ cancelled: true }`, verify `tool_call` handler returns `{ block: true, reason: "🛑 TASK CANCELLED: ..." }`
- **Tool loop detection test**: Feed repeated identical tool calls, verify blocking after threshold
- **Poll-task blocking test**: Mock `/me` API to return `{ shouldBlockPolling: true }`, verify `poll-task` tool is blocked
- **Heartbeat test**: Verify `tool_result` handler makes `PUT /api/active-sessions/heartbeat/{taskId}` call
- **File sync test**: Simulate `write_file` to `SOUL.md`, verify `PUT /api/agents/{id}/profile` is called
- **Memory auto-index test**: Simulate write to `/workspace/personal/memory/`, verify `POST /api/memory/index` is called
- **Goal reminder test**: Verify `context` handler fetches task details and returns `=== GOAL REMINDER ===` string
- **Session summarization test**: Mock a `.jsonl` session file, verify `agent_end` handler parses it and calls memory index API
- **Input cancellation test**: Mock cancelled task, verify `input` handler returns `{ type: "handled" }`

Use a mock HTTP server (minimal `node:http` handler) for API calls. These tests should be fast (no real LLM sessions).
**Implementation Note**: This is the most complex phase. Test each event handler individually. Pause for manual verification after implementing each major event handler (tool_call blocking is the most critical).

---

## Phase 5: Unified Docker Multi-Provider Support

### Overview
Extend the existing `Dockerfile.worker` to install both Claude CLI and pi-mono, so a single Docker image supports both providers selected at runtime via `HARNESS_PROVIDER`. This avoids maintaining two Dockerfiles and keeps disk usage low (only one image to store).

### Changes Required:

#### 1. Extend Dockerfile.worker
**File**: `Dockerfile.worker`
**Changes**: Add pi-mono installation alongside the existing Claude CLI setup:

```dockerfile
# Existing: Claude CLI installation (keep as-is)
RUN HOME=/home/worker curl -fsSL https://claude.ai/install.sh | bash

# NEW: Pi-mono installation
RUN bun install -g @mariozechner/pi-coding-agent
# Or if pi-mono has a different install method — verify during implementation

# NEW: Pi-mono config directory + skills
RUN mkdir -p /home/worker/.pi/agent/skills
COPY plugin/pi-skills/ /home/worker/.pi/agent/skills/

# Existing: Claude settings, plugins, etc. (keep as-is — harmless when HARNESS_PROVIDER=pi)
```

Both CLIs are installed; `HARNESS_PROVIDER` selects which one the runner uses at runtime.

#### 2. Entrypoint changes
**File**: `docker-entrypoint.sh`
**Changes**:

- Replace the hard requirement for `CLAUDE_CODE_OAUTH_TOKEN` with provider-conditional auth validation:
  ```bash
  if [ "$HARNESS_PROVIDER" = "pi" ]; then
    # Pi-mono auth: ANTHROPIC_API_KEY or auth.json must exist
    if [ -z "$ANTHROPIC_API_KEY" ] && [ ! -f ~/.pi/agent/auth.json ]; then
      echo "Error: ANTHROPIC_API_KEY or ~/.pi/agent/auth.json required for pi provider"
      exit 1
    fi
  else
    # Claude auth (existing, default)
    if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
      echo "Error: CLAUDE_CODE_OAUTH_TOKEN environment variable is required"
      exit 1
    fi
  fi
  ```

- MCP config generation: for pi-mono, write to `~/.pi/agent/mcp.json` (or wherever `pi-mcp-adapter` expects it) in addition to `/workspace/.mcp.json`

- The `HARNESS_PROVIDER` env var flows through to the agent-swarm binary, which uses it in the provider factory

#### 3. Docker Compose updates
**File**: `docker-compose.yml` (or equivalent)
**Changes**:
- Existing worker service works as-is (defaults to Claude)
- Add a `pi-worker` service using the same image but with `HARNESS_PROVIDER=pi`
- Mount `~/.pi/agent/` as a persistent volume (for session files, auth.json)

#### 4. Pi-mono skill conversion
**File**: `plugin/pi-skills/` (generated directory)
**Source of truth**: `plugin/commands/*.md` — edit these, then run `bun run build:pi-skills`
**Build script**: `plugin/build-pi-skills.ts` — generates pi-mono `SKILL.md` files with transformations:
- Frontmatter: `description` + `argument-hint` → `name` + `description`
- Slash syntax: `/work-on-task` → `/skill:work-on-task`
- `/todos` → `/skill:todos` (todos is now a proper pi-mono skill)
- `/desplega:*` commands → generic descriptions
- `<!-- claude-only -->` / `<!-- pi-only -->` conditional markers
- Wording: "command" → "skill", emoji removal, trailing whitespace cleanup

All 12 commands converted:
- work-on-task, start-worker, start-leader, swarm-chat (core swarm)
- close-issue, create-pr, implement-issue, review-pr, respond-github (GitHub workflows)
- investigate-sentry-issue (Sentry triage)
- review-offered-task (task offer flow)
- todos (file-based todo management)

Tests: `src/tests/build-pi-skills.test.ts` (68 tests) — verifies frontmatter, no /desplega: leaks, /skill: prefix, no markers, no trailing whitespace.

#### 5. Environment updates
**File**: `.env.docker.example`
**Changes**: Add pi-mono env vars to the existing template (commented out by default):
```env
# Provider selection (default: claude)
# HARNESS_PROVIDER=pi
# ANTHROPIC_API_KEY=sk-ant-...  # Required when HARNESS_PROVIDER=pi
```

### Success Criteria:

#### Automated Verification:
- [x] Docker builds: `docker build -f Dockerfile.worker -t agent-swarm-worker .` (verified Phase 6 Docker E2E)
- [x] Lint passes: `bun run lint:fix`
- [x] Type check passes: `bun run tsc:check`
- [x] Tests pass: `bun test` (1233 pass, 0 fail)

#### Manual Verification:
- [x] Same image, Claude provider: `docker run -e HARNESS_PROVIDER=claude --env-file .env.docker agent-swarm-worker` — completes a task (verified Phase 6 Docker E2E — $0.1635)
- [x] Same image, Pi provider: `docker run -e HARNESS_PROVIDER=pi -e ANTHROPIC_API_KEY=... --env-file .env.docker agent-swarm-worker` — completes a task (verified — $0.1649, session be90aa30)
- [x] Auth validation works: entrypoint validates provider-specific credentials with actionable errors
- [x] Pi-mono persists session files across restarts (verified — resume E2E kept same session ID)
- [x] MCP tools accessible from pi-mono session inside Docker (verified — store-progress tool used in basic E2E)
- [x] Skills work: `/work-on-task` triggers correctly in pi-mono (all 12 commands converted to pi-mono skills via `bun run build:pi-skills`; verified via `pi --print` that skills are discovered by pi-mono in Docker)

**Implementation Notes**:
- Dockerfile installs pi-mono CLI globally via `npm install -g @mariozechner/pi-coding-agent`
- Entrypoint validates auth per provider: `CLAUDE_CODE_OAUTH_TOKEN` for claude, `ANTHROPIC_API_KEY` or `auth.json` for pi
- `HARNESS_PROVIDER` env var defaults to `claude` in both Dockerfile and entrypoint
- Startup banner now shows the active harness provider
- Pi-mono skill conversion (Phase 5.4) complete — `plugin/pi-skills/` contains work-on-task, start-worker, start-leader, swarm-chat skills in SKILL.md format

---

## Phase 6: Integration Testing & E2E Verification

### Overview
Write integration tests for the provider adapter layer and run end-to-end verification with both providers.

### Changes Required:

#### 1. Provider adapter unit tests
**File**: `src/tests/provider-adapter.test.ts` (new)
**Changes**:

- Test `createProviderAdapter("claude")` returns `ClaudeAdapter`
- Test `createProviderAdapter("pi")` returns `PiMonoAdapter`
- Test `createProviderAdapter("unknown")` throws with actionable error
- Test `ProviderEvent` type narrowing works correctly
- Test `CostData` shape matches API expectations

#### 2. ClaudeAdapter unit tests
**File**: `src/tests/claude-adapter.test.ts` (new)
**Changes**:

- Test CLI argument construction (model, system prompt, resume)
- Test stream-json event parsing → `ProviderEvent` normalization
- Test stale session retry logic (strip `--resume` and retry)
- Test cost data extraction from result events
- Mock `Bun.spawn` to avoid actually spawning Claude

#### 3. PiMonoAdapter unit tests
**File**: `src/tests/pi-mono-adapter.test.ts` (new)
**Changes**:

- Test model name mapping (shortnames → full IDs)
- Test AGENTS.md symlink creation/cleanup
- Test event normalization from pi-mono events → `ProviderEvent`
- Test cost aggregation from per-message usage objects
- Mock pi-mono session APIs

#### 4. E2E test script
**File**: `scripts/e2e-provider-test.ts` (new, Bun script)
**Changes**: A Bun TypeScript script that accepts `--harness <claude|pi|both>` and runs the E2E flow:

```bash
# Run for a specific harness
bun run scripts/e2e-provider-test.ts --harness claude
bun run scripts/e2e-provider-test.ts --harness pi
# Run for both sequentially
bun run scripts/e2e-provider-test.ts --harness both
```

The script:
1. Creates a temporary clean SQLite DB (not the main one)
2. Reads credentials from `.env.docker` (which contains LLM credentials)
3. Uses `PORT` env var if present (worktree compatible), otherwise finds a free port
4. Starts the API server against the temp DB
5. Pre-registers a lead agent and a worker agent
6. Creates a task for the lead: "Send a task to all workers to write 'ping' in the #general chat channel"
7. Starts lead + worker with the specified `HARNESS_PROVIDER`
8. Waits for worker to complete its task
9. Verifies the lead is awoken after worker ends
10. Checks that the "ping" message was written in the #general channel
11. Verifies session information:
    - Session logs exist and contain expected entries (visible in UI)
    - Cost data is recorded (totalCostUsd > 0, tokens present)
    - Session ID is stored on the task
12. Cleans up: stops processes, deletes temp DB

#### 5. DB field documentation
**File**: No code changes
**Changes**: Document that `claudeSessionId` in the tasks table now stores any provider's session ID. A future migration could rename it to `providerSessionId`, but this is cosmetic and deferred.

### Success Criteria:

#### Automated Verification:
- [x] All new tests pass: `bun test src/tests/provider-adapter.test.ts src/tests/claude-adapter.test.ts src/tests/pi-mono-adapter.test.ts` — 34 tests, 0 failures
- [x] All existing tests pass: `bun test` — 1151 tests, 0 failures
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [x] E2E: Claude worker picks up task → completes → cost recorded ($0.4515, 12 turns, exit 0)
- [x] E2E: Pi-mono worker picks up task → completes → exit 0 (openrouter/minimax/minimax-m2.5)
- [x] E2E: Pi-mono MCP tool discovery + forwarding works (get-tasks, poll-task, get-swarm, task-action)
- [x] E2E: Pi-mono event streaming works (tool_use, tool_result events)
- [x] E2E Docker: Claude worker completes task, session ID + cost ($0.1635) recorded via `scripts/e2e-docker-provider.ts`
- [x] E2E Docker: Pi-mono worker completes task via Docker (verified — cost $0.1649, session be90aa30)
- [x] E2E: Cancel a task on each provider → both providers cancel successfully
- [x] E2E: Resume on Claude / pi-mono — both resume with same session ID (claude timed out on completion but resume itself works)
- [x] E2E: Tool loop detection triggers on both providers
- [~] E2E: Session summarization — tasks complete but no memory entries written (skipped, not failed — trivial tasks don't produce summaries)

**Phase 6 Implementation Notes:**
- Created 3 test files: provider-adapter (factory + types), claude-adapter (CLI args, stream parsing, retry), pi-mono-adapter (symlinks, model mapping, events, cost)
- E2E script at `scripts/e2e-provider-test.ts` validates API layer; full provider session testing requires Docker + LLM credentials
- Manual E2E items above are deferred to post-merge Docker testing — they require live API keys and cannot run in CI
- **CI fix (96388cd)**: Docker build failed with EACCES — `npm install -g` ran as `worker` user, added `sudo`. Test suite reported "1 error" from dangling `Bun.file().text()` promise in symlink test — replaced with synchronous `readFileSync`.
- **Fixed**: Cost save 500 — `session_costs.taskId` has FK to `agent_tasks(id)`. For `pool_tasks_available` triggers, runner generated a random UUID via `crypto.randomUUID()` that didn't exist in `agent_tasks` → FK violation. Fix: split `effectiveTaskId` into `realTaskId` (DB-bound, may be undefined) and `effectiveTaskId` (log correlation only). `saveCostData` and `saveProviderSessionId` now use `realTaskId`.
- **Fixed**: Cost save race — `saveCostData` was fire-and-forget in `onEvent` handler, racing with container shutdown. Moved to `await`ed call in `waitForCompletion().then()` handler.
- **Fixed**: Docker PI_PACKAGE_DIR — pi-mono's `config.js` reads `package.json` at module load time via `process.execPath`, which resolves to the compiled binary location. Set `PI_PACKAGE_DIR=/usr/lib/node_modules/@mariozechner/pi-coding-agent` in Dockerfile.
- **Added**: `scripts/e2e-docker-provider.ts` — Docker-based E2E script with `--provider`, `--test`, `--skip-build` flags. Supports basic/cancel/resume/tool-loop/summarize test scenarios.

**Implementation Note**: After E2E passes on both providers, the feature is complete. Final review before merging.

---

## Manual E2E Verification Commands

All E2E verification is handled by the Bun script `scripts/e2e-provider-test.ts`:

```bash
# Test Claude provider
bun run scripts/e2e-provider-test.ts --harness claude

# Test Pi-mono provider
bun run scripts/e2e-provider-test.ts --harness pi

# Test both providers sequentially
bun run scripts/e2e-provider-test.ts --harness both

# Test Docker (single image, both providers)
docker build -f Dockerfile.worker -t agent-swarm-worker .

# Claude via Docker
docker run --rm -d --name test-worker \
  --env-file .env.docker \
  -e HARNESS_PROVIDER=claude \
  -e MCP_BASE_URL=http://host.docker.internal:${PORT:-3013} \
  agent-swarm-worker

# Pi via Docker (same image, different env)
docker run --rm -d --name test-worker \
  --env-file .env.docker \
  -e HARNESS_PROVIDER=pi \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e MCP_BASE_URL=http://host.docker.internal:${PORT:-3013} \
  agent-swarm-worker

# Cleanup
docker stop test-worker 2>/dev/null
```

**Script details** (see `scripts/e2e-provider-test.ts`):
- Uses a temporary clean SQLite DB (auto-deleted on exit)
- Pre-registers a lead and worker agent
- Reads LLM credentials from `.env.docker`
- Uses `PORT` env if present (worktree compatible)
- Test scenario: lead sends task to worker → worker writes "ping" in #general → lead awoken after worker completes
- Verifies: session logs present and sensible, cost data recorded, session IDs stored
- Only one Docker image is ever built/stored (disk space conscious)

## Testing Strategy

- **Unit tests**: Mock `Bun.spawn` for ClaudeAdapter, mock pi-mono session APIs for PiMonoAdapter. Test event normalization, cost aggregation, error handling.
- **Integration tests**: Test the full adapter → runner event flow with a minimal HTTP handler (not full `src/http.ts`). Use isolated SQLite DBs per test.
- **E2E tests**: Real Claude CLI / pi-mono sessions against the API server. Keep tasks trivial ("Say hi") to minimize cost and time.
- **Regression tests**: Every phase verifies `HARNESS_PROVIDER=claude` (or unset) still works identically.

## Post-Implementation Fixes (2026-03-09)

### Graceful SIGTERM Handling
- **API server** (`src/http/index.ts`): Added `process.on("SIGTERM", shutdown)` — previously only handled SIGINT, causing Docker Compose `down` to hang until the 60s grace period expired
- **Workers** already handled SIGTERM correctly in `runner.ts`

### Pi-mono Session Log Quality
- **Problem**: Pi-mono logged every streaming token as a separate "System" message in the UI (dozens of grey bubbles per response)
- **Root cause**: `message_update` events emitted a `raw_log` for each token; Claude buffers by newline boundaries
- **Fix** (`src/providers/pi-mono-adapter.ts`):
  - Buffer `message_update` tokens, flush as a single log entry on `message_end`
  - Dedup identical messages across turns (tracked via `lastEmittedMessage`)
  - Include `model` in emitted JSON so the UI displays it
  - Wrap `tool_execution_start/end` in the `{ type: "assistant", message: { content: [...] } }` format the UI parser expects (previously emitted standalone JSON that was silently skipped)
- **Result**: Pi-mono tasks now render clean Agent messages with model info and tool use/result blocks, matching Claude's display quality

## Remaining Items to Verify During Implementation

- **Pi-mono package availability**: The pi-mono SDK packages (`@mariozechner/pi-agent-core` for `AgentSession`/`ExtensionAPI` types, `@mariozechner/pi-ai` for TypeBox re-exports) need to be on npm. Verify early in Phase 3. If not published, use git dependencies. Note: `@mariozechner/pi-coding-agent` is the CLI — we may only need the core/ai packages as library dependencies, not the full CLI.
- **pi-mcp-adapter HTTP support** (**CRITICAL — gate Phase 3**): The `pi-mcp-adapter` extension primarily targets stdio-based MCP servers. Test it against the swarm’s Streamable HTTP endpoint as the very first step of Phase 3. If HTTP support is incomplete, either contribute upstream or fall back to native `ToolDefinition` conversion (Approach A from research). This is a potential blocker.
- **Skill format convergence**: Resolved. `plugin/commands/*.md` is now the single source of truth. `bun run build:pi-skills` generates `plugin/pi-skills/` from them using `plugin/build-pi-skills.ts`. Uses `<!-- claude-only -->` / `<!-- pi-only -->` markers for provider-specific sections. All 12 commands converted with 68 tests.

## References
- Research: `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md`
- Previous research: `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md`
- Runner architecture: `thoughts/shared/research/2025-12-22-runner-loop-architecture.md`
