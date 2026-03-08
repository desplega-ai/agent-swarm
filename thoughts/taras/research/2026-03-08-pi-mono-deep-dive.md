---
date: 2026-03-08T00:00:00Z
researcher: Claude (claude-opus-4-6)
git_commit: 94b35ac22ee9f35581f18281a6e69751d90ebad6
branch: main
repository: agent-swarm
topic: "Deep-dive: pi-mono integration — MCP wiring, adapter typing, prompts, hooks, auth, and extensions"
tags: [research, codebase, provider, pi-mono, mcp, adapter, prompts, extensions, sdk, hooks, auth]
status: complete
autonomy: critical
last_updated: 2026-03-08
last_updated_by: Claude (claude-opus-4-6)
---

# Research: Deep-dive into pi-mono Integration — MCP Wiring, Adapter Typing, Prompts, Hooks, Auth, and Extensions

**Date**: 2026-03-08
**Researcher**: Claude (claude-opus-4-6)
**Git Commit**: 94b35ac22ee9f35581f18281a6e69751d90ebad6
**Branch**: main

## Research Question

Building on the previous pi-mono provider research (`thoughts/taras/research/2026-03-05-pi-mono-provider-research.md`), this deep-dive addresses gaps identified during review:

1. How will the core swarm MCP tools be exposed to pi-mono sessions?
2. How should the pi adapter be typed to ensure type safety?
3. How will prompts (base, system, skills, harness instructions) be passed to pi-mono?
4. How could the integration support extensions and custom tools?
5. **How will Claude hook behavior achieve 100% compatibility in the pi adapter?**
6. **How will auth/provider/model selection work for the pi adapter?**

## Summary

The current agent-swarm exposes MCP tools to Claude CLI via a Streamable HTTP server discovered through `.mcp.json`. For pi-mono, the recommended approach is using the `pi-mcp-adapter` extension to connect to the existing swarm MCP server — this is cleaner, avoids major refactors, and scales to other MCP-supporting harnesses. The system prompt is reusable across adapters via `getBasePrompt()`, with pi-mono receiving it through `ResourceLoader.getAppendSystemPrompt()`. Pi-mono natively supports `AGENTS.md` (equivalent to `CLAUDE.md`) and has its own skills system at `.pi/skills/`. The adapter's core event types should be defined as a provider-agnostic contract that both Claude and pi adapters implement, enabling future expansion. Hook compatibility is achievable: pi-mono's `tool_call` event supports `{ block: true, reason }` return values for blocking (with error messages sent back to the LLM), and all other hook behaviors map cleanly to pi extension events. Auth supports Anthropic, OpenRouter, OpenAI, and Codex via pi-mono's `AuthStorage` + `ModelRegistry` system.

---

## Detailed Findings

### 1. Core Swarm MCP Tool Handling

#### How it works today (Claude CLI path)

The runner spawns Claude CLI without any `--mcp-server` flags (`src/commands/runner.ts:1090-1103`). Instead, Claude CLI discovers the MCP server through a `.mcp.json` file in its working directory:

- **Docker workers**: `docker-entrypoint.sh:114-134` generates `/workspace/.mcp.json` at container startup with the swarm's Streamable HTTP endpoint, auth headers, and agent ID.
- **Local dev**: `src/commands/setup.tsx:374-401` writes `.mcp.json` during setup.

The `.mcp.json` structure:
```json
{
  "mcpServers": {
    "agent-swarm": {
      "type": "http",
      "url": "<MCP_BASE_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>",
        "X-Agent-ID": "<AGENT_ID>"
      }
    }
  }
}
```

Each MCP session gets its own `McpServer` instance (`src/http/mcp.ts:29-47`). Tools are registered via `createServer()` in `src/server.ts:98-216`, gated by the `CAPABILITIES` env var. The `createToolRegistrar` wrapper (`src/tools/utils.ts:86-115`) extracts `X-Agent-ID` from request headers and injects it as `RequestInfo` into every tool callback.

#### How it should work for pi-mono (recommended: pi-mcp-adapter)

Pi-mono does not natively support MCP servers, but the `pi-mcp-adapter` extension provides MCP connectivity. This is the recommended approach because:

- It reuses the existing MCP server infrastructure without modification
- Other harnesses (Codex, Gemini CLI) also support MCP, making this approach scalable
- No need to maintain 58 tool wrapper conversions (Zod → TypeBox schema translation)
- Cleaner separation — the swarm MCP server remains the single source of truth for tool definitions

**Configuration**: The adapter generates an MCP config pointing at the swarm server, identical to the current `.mcp.json` approach:
```json
{
  "mcpServers": {
    "agent-swarm": {
      "type": "http",
      "url": "<MCP_BASE_URL>/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>", "X-Agent-ID": "<AGENT_ID>" },
      "lifecycle": "eager"
    }
  }
}
```

The `pi-mcp-adapter` uses a proxy tool pattern (~200 tokens) where the agent discovers MCP tool capabilities on-demand. Setting `lifecycle: "eager"` ensures the MCP connection is established at session startup, not lazily on first tool call.

**Alternative considered but not recommended: Native `ToolDefinition` conversion**

Converting each swarm MCP tool into a pi-mono `ToolDefinition` with HTTP API calls would give tighter control (custom `promptSnippet` per tool, no proxy indirection), but requires:
- A Zod-to-TypeBox schema translation layer for 58 tools
- Maintaining dual registration paths
- More adapter code to maintain

This is not worth the complexity given that the MCP adapter approach works and scales to future harnesses.

#### Tool registration details

Regardless of approach, the adapter must:
1. Generate MCP config with correct `MCP_BASE_URL`, `API_KEY`, and `AGENT_ID`
2. Ensure `lifecycle: "eager"` so tools are available immediately
3. The existing capability gating (`src/server.ts:84-92`) applies server-side — the adapter doesn't need to filter tools

---

### 2. Adapter Typing

#### Current agent-swarm types (from `src/types.ts` and `src/commands/runner.ts`)

**Task lifecycle**: `AgentTaskStatusSchema` — `"backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled"` (`src/types.ts:4-15`)

**Session types**:
- `SessionLogSchema` (`src/types.ts:324-335`): `{ sessionId, taskId?, iteration, cli, content, lineNumber }`
- `SessionCostSchema` (`src/types.ts:338-355`): `{ sessionId, taskId?, agentId, totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, numTurns, model, isError }`
- `ActiveSessionSchema` (`src/types.ts:528-539`): `{ agentId, taskId?, triggerType, startedAt, lastHeartbeatAt }`

**Runner interfaces** (in `src/commands/runner.ts`):
- `RunClaudeIterationOptions` (lines 517-531): `{ prompt, logFile, systemPrompt?, additionalArgs?, role, apiUrl?, apiKey?, agentId?, sessionId?, iteration?, taskId?, model? }`
- `RunningTask` (lines 534-542): `{ taskId, process, logFile, startTime, promise, triggerType? }`
- `CostData` (lines 610-623): mirror of `SessionCost` minus `id`/`createdAt`

**Claude stream events** — **no formal TypeScript types exist**. The runner duck-types JSON via `JSON.parse` + field checks:
- `{ type: "system", subtype: "init", session_id: string }` — session identity
- `{ type: "result", total_cost_usd, duration_ms, num_turns, is_error, usage: { input_tokens?, output_tokens?, cache_read_input_tokens?, cache_creation_input_tokens? } }` — completion/cost

**Error tracking**: `ErrorSignal` in `src/utils/error-tracker.ts:6-11` and `SessionErrorTracker` class.

**Existing provider abstraction**: `LlmProvider` in `src/workflows/llm-provider.ts` — used only by the workflow engine, not the runner. Interface: `{ query<T>(input: string, schema: ZodSchema<T>): Promise<T> }`.

#### Pi-mono types (from `@mariozechner/pi-coding-agent` and `@mariozechner/pi-agent-core`)

**Session types**:
- `CreateAgentSessionOptions`: `{ cwd?, agentDir?, authStorage?, modelRegistry?, model?, thinkingLevel?, scopedModels?, tools?: Tool[], customTools?: ToolDefinition[], sessionManager, resourceLoader? }`
- `CreateAgentSessionResult`: `{ session: AgentSession, extensionsResult, modelFallbackMessage? }`
- `AgentSession`: methods `prompt()`, `subscribe()`, `steer()`, `followUp()`, `setModel()`, `cycleModel()`, `setThinkingLevel()`; properties `sessionFile`, `sessionId`, `agent`

**Tool types**:
- `AgentTool<T>` (from pi-agent-core): `{ name, label, description, parameters: T, execute: (toolCallId, params, signal, onUpdate) => Promise<{ content, details? }> }`
- `ToolDefinition` (from pi-coding-agent): extends `AgentTool` with `{ promptSnippet?, promptGuidelines? }`

**Event types**:
- Session-level: `message_start`, `message_update`, `message_end`, `agent_start`, `turn_start`, `turn_end`, `agent_end`
- Extension-level (via `pi.on()`): `session_start`, `input`, `before_agent_start`, `agent_start`, `turn_start`, `context`, `before_provider_request`, `model_select`, `tool_call`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_result`, `turn_end`, `agent_end`

**Schema system**: TypeBox (`@sinclair/typebox`) via `Type` re-export from `@mariozechner/pi-ai`, not Zod.

**Cost tracking**: Each `AssistantMessage` includes a `usage` object with `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, and cost fields (`input`, `output`, `cacheRead`, `cacheWrite`, `total`). Session-level aggregates available via `get_session_stats` RPC command returning `{ tokens: { input, output, cacheRead, cacheWrite, total }, cost: number }`.

#### Proposed adapter interfaces

These are the core types that both Claude and pi adapters would implement. Designed to be extensible for future providers and custom events.

```typescript
// --- Provider adapter interface ---

/** Normalized event emitted by any provider adapter */
type ProviderEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "message"; role: "assistant" | "user"; content: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown }
  | { type: "result"; cost: CostData; output?: string; isError: boolean; errorCategory?: string }
  | { type: "error"; message: string; category?: string }
  | { type: "raw_log"; content: string }
  // Extensible: add custom event types here for provider-specific behaviors
  | { type: "custom"; name: string; data: unknown };

/** Configuration for creating a provider session */
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
  additionalArgs?: string[];   // Claude-specific, ignored by pi
}

/** A running provider session */
interface ProviderSession {
  readonly sessionId: string | undefined;
  /** Subscribe to normalized events */
  onEvent(listener: (event: ProviderEvent) => void): void;
  /** Wait for the session to complete */
  waitForCompletion(): Promise<ProviderResult>;
  /** Abort the session */
  abort(): Promise<void>;
  // Future: pause/steer capabilities (not needed for v1)
  // pause(): Promise<void>;
  // steer(message: string): Promise<void>;
}

/** Result of a completed session */
interface ProviderResult {
  exitCode: number;
  sessionId?: string;
  cost?: CostData;
  output?: string;
  isError: boolean;
  errorCategory?: string;
}

/** Provider adapter contract */
interface ProviderAdapter {
  readonly name: string;  // "claude" | "pi" | future providers
  createSession(config: ProviderSessionConfig): Promise<ProviderSession>;
  canResume(sessionId: string): Promise<boolean>;
}
```

**Future extensibility notes:**
- `pause()` and `steer()` on `ProviderSession` are commented out — pi-mono supports `session.steer()` and `session.followUp()` natively, Claude CLI does not. These can be added when needed.
- The `{ type: "custom" }` event variant allows provider-specific events without breaking the core contract.

**Key type mapping decisions:**

| Concern | Current (Claude) | Pi-mono | Adapter strategy |
|---------|-----------------|---------|-----------------|
| Stream events | Duck-typed JSON | Typed `AgentSessionEvent` | Both normalize to `ProviderEvent` union |
| Session identity | `claudeSessionId` string | `session.sessionId` + `.jsonl` file path | Store both; DB field becomes `providerSessionId` with `provider` discriminant |
| Cost/usage | `{ total_cost_usd, usage: { input_tokens, ... } }` | Per-message `usage` object + `get_session_stats` RPC | Both normalize to `CostData` |
| Resume | `--resume <sessionId>` CLI arg | `SessionManager.open(path)` or `SessionManager.continueRecent()` | Adapter-specific resume logic behind `canResume()` |
| Error signals | `SessionErrorTracker` parsing stderr/events | Pi extension `agent_end` event + error state | Both feed into `ProviderResult.errorCategory` |
| MCP tools | `.mcp.json` auto-discovery by Claude CLI | `pi-mcp-adapter` extension with same config | Same MCP server, different client-side discovery |

---

### 3. Prompt Handling

#### Current prompt assembly (Claude CLI path)

The system prompt is built by `getBasePrompt()` at `src/prompts/base-prompt.ts:373-484` and concatenated with any additional system prompt. It has these layers:

1. **Role header** (line 376): Template with `{role}` and `{agentId}` placeholders
2. **Identity section** (lines 379-394): Agent name, description, SOUL.md, IDENTITY.md
3. **Repo context** (lines 397-412): Per-task GitHub repo CLAUDE.md with scoping notice
4. **Agent CLAUDE.md** (lines 456-466): Under `## Agent Instructions` header
5. **TOOLS.md** (lines 469-479): Under `## Your Tools & Capabilities` header
6. **Static suffix** (lines 415-448): Always included — registration instructions, role-specific guidance (lead/worker), filesystem layout, self-awareness, context-mode, guidelines, system packages, services, artifacts, capabilities list

**Truncation**: Individual sections capped at `BOOTSTRAP_MAX_CHARS` = 20,000 chars. Total injectable content capped at `BOOTSTRAP_TOTAL_MAX_CHARS` = 150,000 chars minus protected content.

**Delivery mechanisms**:
- System prompt → `--append-system-prompt` CLI arg (`src/commands/runner.ts:1110, 1292`)
- Task prompt → `-p` CLI arg (`src/commands/runner.ts:1098, 1280`)
- Agent CLAUDE.md → also written to `~/.claude/CLAUDE.md` by the hook at session start (`src/hooks/hook.ts:661-673`)

#### Pi-mono prompt mechanisms

Pi-mono offers three system prompt customization paths:

1. **`DefaultResourceLoader` with `systemPromptOverride`**: Complete system prompt replacement via a callback function.
2. **`getAppendSystemPrompt()`**: Append-only, adds to default system prompt (equivalent to `--append-system-prompt`).
3. **File-based**: `SYSTEM.md` at `.pi/SYSTEM.md` (project) or `~/.pi/agent/SYSTEM.md` (global).

User messages are sent via `session.prompt(text, options?)`.

#### AGENTS.md — pi-mono's equivalent of CLAUDE.md

Pi-mono natively supports `AGENTS.md` files (its equivalent of Claude's `CLAUDE.md`):
- Pi walks up from the current working directory, loading every `AGENTS.md` it finds
- Also loads a global `~/.pi/agent/AGENTS.md`
- These are injected as context at startup automatically
- The startup header shows which AGENTS.md files were loaded

**Recommended adapter approach**: The adapter should generate an `AGENTS.md` file in the workspace (or create a symlink from `AGENTS.md` → `CLAUDE.md`) so that pi-mono natively discovers the agent's instructions without relying solely on system prompt injection. This gives both native discovery AND system prompt injection as a belt-and-suspenders approach.

Additionally, pi-mono supports `APPEND_SYSTEM.md` for appending to the system prompt without replacing it (added in PR #716).

#### Proposed prompt mapping for pi adapter

```
                 Claude CLI path                     Pi-mono path
                 ──────────────                      ────────────
System prompt    --append-system-prompt              ResourceLoader.getAppendSystemPrompt()
                 (getBasePrompt() output)            (same getBasePrompt() output, reused as-is)

Task prompt      -p "task instruction"               session.prompt("task instruction")

CLAUDE.md        Hook writes ~/.claude/CLAUDE.md     1. System prompt injection (via getBasePrompt())
                 (native Claude Code reads it)       2. AGENTS.md symlink in workspace (native pi discovery)

Repo CLAUDE.md   Injected into system prompt         Same — already in getBasePrompt() output
                 by getBasePrompt()

Skills           plugin/commands/*.md installed       .pi/skills/ directory with SKILL.md files
                 to ~/.claude/commands/              (see Skills section below)
```

**Key insight**: The existing `getBasePrompt()` function is almost entirely reusable across adapters. It produces a plain text system prompt that can be passed to pi-mono via `ResourceLoader.getAppendSystemPrompt()` without modification. The only harness-specific elements are:
- References to `--resume` and Claude CLI features in `BASE_PROMPT_SELF_AWARENESS` — these would need pi-equivalent text
- References to `~/.claude/CLAUDE.md` in `BASE_PROMPT_FILESYSTEM` — pi uses `~/.pi/agent/`
- The hook's `~/.claude/CLAUDE.md` write — replaced by AGENTS.md symlink approach

A small adapter-specific prompt section could be appended by the adapter to replace Claude-specific references, keeping `getBasePrompt()` itself unchanged.

**Concrete implementation**:
```typescript
// In PiMonoAdapter.createSession():
const resourceLoader = new DefaultResourceLoader({
  // getAppendSystemPrompt returns text that's appended to pi's minimal default prompt
  getAppendSystemPrompt: () => config.systemPrompt,  // This is getBasePrompt() output
});

const { session } = await createAgentSession({
  cwd: config.cwd,
  model: resolvedModel,
  sessionManager: SessionManager.create(config.cwd),
  resourceLoader,
});

// Send the task instruction
await session.prompt(config.prompt);
```

**Pi-mono's default system prompt is minimal** (~1000 tokens including tool definitions). The swarm's `getBasePrompt()` output will significantly expand this, but pi-mono doesn't impose hard limits on system prompt size.

#### Skills mapping

**Current agent-swarm skills** (Claude Code-specific):
- Defined as `.md` files in `plugin/commands/` (slash commands) and `plugin/skills/`
- Installed to `~/.claude/commands/` and `~/.claude/skills/` via Docker build (`Dockerfile.worker:119-122`)
- Local dev setup (`src/commands/setup.tsx`) only configures hooks and MCP — it does NOT install commands/skills
- Currently Claude Code-only; no multi-harness skill installation exists

**Pi-mono's native skills system**:
- Skills are directories with a `SKILL.md` file (YAML frontmatter for name/description + instructions)
- Discovered from: `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, `.agents/skills/`, and npm packages
- Triggered as `/skill:name` slash commands
- Progressive disclosure: only descriptions in context, full SKILL.md loaded on-demand

**Adapter-specific skill installation**: For pi-mono workers, the Dockerfile/entrypoint would need to:
1. Convert `plugin/commands/*.md` to `SKILL.md` format under `.pi/skills/`
2. Or create a shared format that both harnesses can consume (`.agents/skills/` is supported by pi-mono)
3. The `plugin/agents/*.md` definitions would map to pi-mono's extensions or custom tools

---

### 4. Extensions and Custom Tools

#### Current extensibility in agent-swarm

Agent-swarm's tool set is static — all tools are registered at server creation time in `src/server.ts:98-216`. The `CAPABILITIES` env var provides coarse-grained feature gating, but there's no mechanism for agents to register custom tools or for users to add extensions.

The agent profile includes `toolsMd` (max 64KB) which is text guidance about tools, but it doesn't register actual executable tools.

#### Pi-mono's extension system

Pi-mono has a rich extension system via the `ExtensionAPI` interface:

```typescript
export default function(pi: ExtensionAPI) {
  // Register tools
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    parameters: Type.Object({ input: Type.String() }),
    execute: async (toolCallId, params, signal) => {
      return { content: "result" };
    },
  });

  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    // Can block tool execution
    if (shouldBlock(event)) {
      return { block: true, reason: "Blocked: reason here" };
    }
  });

  pi.on("session_start", async (event, ctx) => { /* init state */ });
  pi.on("input", async (event, ctx) => {
    return { type: "transform", text: event.text.toUpperCase() };
  });

  // Register slash commands
  pi.registerCommand("/mycommand", async (args, ctx) => { /* ... */ });
}
```

**Extension loading paths**:
- CLI flag: `--extension path/to/ext.ts`
- Auto-discovery: `.pi/extensions/` directory in project or global agent dir
- SDK: Via `DefaultResourceLoader` which can provide extension paths
- npm/git: Extensions can be published as npm packages

#### How custom tools/extensions work with the pi adapter

**Layer 1: Swarm MCP tools via pi-mcp-adapter (core)**

The adapter configures `pi-mcp-adapter` to connect to the existing swarm MCP server. All 58 tools are available via the proxy pattern without any conversion.

**Layer 2: Swarm hook behavior as a pi extension (core)**

The adapter registers a built-in extension implementing hook behavior (see Section 5 for the complete mapping).

**Layer 3: Agent-defined custom tools (future)**

The agent profile could gain a `customTools` field or extension paths. These would be loaded via `.pi/extensions/` auto-discovery or explicitly via `DefaultResourceLoader`.

**Layer 4: User-defined extensions (transparent)**

Pi-mono's native extension auto-discovery from `.pi/extensions/` works without adapter changes. For swarm-wide extensions:
```
HARNESS_EXTENSIONS=/path/to/ext1.ts,/path/to/ext2.ts
```

---

### 5. Hook Compatibility — Claude to Pi-mono (100% Parity)

This section maps every current hook behavior to its pi-mono equivalent, ensuring full compatibility.

#### Architecture difference

**Claude CLI**: Hooks are external processes. Claude CLI invokes `agent-swarm hook` as a subprocess, sends a JSON message on stdin, reads stdout for responses. Each hook event is a separate process invocation.

**Pi-mono**: Hooks are in-process extension event handlers registered via `pi.on()`. They run in the same process as the agent session, with direct access to session state.

**Key implication**: The pi-mono approach is faster (no subprocess overhead) and has richer access to session state, but the hook logic must be adapted from a standalone script to an extension module.

#### Common preamble (runs for ALL events)

**Current behavior** (`src/hooks/hook.ts:176-657`):
1. Read `.mcp.json` for API base URL + auth headers
2. Parse stdin JSON (`HookMessage`)
3. `POST /ping` — heartbeat (fire-and-forget)
4. `GET /me?include=inbox` — fetch agent info
5. Output agent status + system tray to stdout

**Pi-mono equivalent**:
- API config is captured at extension registration time (closed over from adapter config)
- No stdin parsing needed — event data comes as typed function parameters
- Ping and agent info fetch remain identical HTTP calls
- Status output uses pi-mono's context injection mechanism instead of stdout

#### Event-by-event mapping

##### SessionStart → `session_start`

| Current behavior | Pi-mono equivalent |
|---|---|
| Write agent's `claudeMd` to `~/.claude/CLAUDE.md` (line 665-673) | Not needed — prompt injected via `ResourceLoader.getAppendSystemPrompt()` + `AGENTS.md` symlink |
| Backup existing CLAUDE.md (line 667) | Not needed — no file override |
| Lead: fetch concurrent context via `GET /api/concurrent-context` (line 293) and output as `=== CONCURRENT SESSION AWARENESS ===` block (lines 693-727) | Same HTTP call; inject context via the `context` extension event or return context from `session_start` handler |
| Clear tool loop history file `/tmp/agent-swarm-tool-history/{taskId}.json` (lines 729-735) | Same file cleanup (extension runs in same container with same filesystem access) |

##### PreToolUse → `tool_call`

This is the most critical mapping. Three sequential checks, any of which can block:

**Check 1: Task cancellation** (`hook.ts:766-770`)

| Current | Pi-mono |
|---|---|
| Call `GET /cancelled-tasks?taskId={taskId}` (line 465) | Same HTTP call from `tool_call` handler |
| If cancelled, output `{"decision":"block","reason":"🛑 TASK CANCELLED: ..."}` | Return `{ block: true, reason: "🛑 TASK CANCELLED: ..." }` — pi-mono sends the reason string back to the LLM as a tool error, so the agent knows why |
| Early return after block | Same — return from handler stops further checks |

**Check 2: Tool loop detection** (`hook.ts:772-795`)

| Current | Pi-mono |
|---|---|
| Call `checkToolLoop()` from `src/hooks/tool-loop-detection.ts` | Same function, imported into extension module |
| Append tool call to `/tmp/agent-swarm-tool-history/{taskId}.json` | Same file-based history (same filesystem) |
| If blocked: output `{"decision":"block","reason":"LOOP DETECTED: ..."}` | Return `{ block: true, reason: "LOOP DETECTED: ..." }` |
| If warning: output plain text warning | Inject warning text via context/message (pi-mono doesn't have a warning-only stdout equivalent, but the reason in `block: false` response or injected message achieves the same) |

**Check 3: Poll-task blocking** (`hook.ts:798-807`)

| Current | Pi-mono |
|---|---|
| Check if `tool_name` ends with `"poll-task"` | Check `event.toolName` in handler |
| Call `GET /me`, check `shouldBlockPolling` field (line 550) | Same HTTP call |
| If true: output `{"decision":"block","reason":"🛑 POLLING LIMIT REACHED: ..."}` | Return `{ block: true, reason: "🛑 POLLING LIMIT REACHED: ..." }` |

**Pi-mono blocking semantics (verified)**: A `tool_call` event handler can return `{ block: true, reason: "..." }` to prevent tool execution. The `reason` string is sent back to the LLM as a tool error response, so the agent receives the blocking reason and can adjust. If a handler throws an error, the tool is also blocked (fail-safe) and the error message is sent to the LLM. This provides equivalent or better behavior compared to Claude's `{"decision":"block","reason":"..."}` stdout JSON.

##### PostToolUse → `tool_execution_end` / `tool_result`

All PostToolUse actions are non-blocking (fire-and-forget). Map to `tool_result` event:

| Current behavior | Pi-mono equivalent |
|---|---|
| `PUT /api/active-sessions/heartbeat/{taskId}` (line 816) — session heartbeat | Same HTTP call, fire-and-forget |
| `PUT /api/agents/{id}/activity` (line 825) — activity timestamp | Same HTTP call, fire-and-forget |
| Check if Write/Edit tool wrote to workspace identity files (SOUL.md, IDENTITY.md, TOOLS.md) and sync via `PUT /api/agents/{id}/profile` (lines 833-857) | Check `event.toolName` and `event.params` for file paths, same sync logic. Pi-mono tools have different names (e.g., `write_file` vs `Write`) — the extension checks for pi-mono tool names |
| Check if Write/Edit to `/workspace/start-up*` and sync setup script (lines 848-857) | Same path check and sync |
| Auto-index files written to `/workspace/personal/memory/` or `/workspace/shared/memory/` via `POST /api/memory/index` (lines 859-892) | Same path check and index call |
| Lead agents: stdout reminder after `send-task` (line 894-898) | Inject reminder via message/context mechanism |
| Worker agents: stdout reminder to call `store-progress` (lines 900-906) | Same injection |

##### PreCompact → `context`

| Current | Pi-mono |
|---|---|
| Read task file for `taskId` (line 740) | Task ID available from adapter config (closed over) |
| `GET /api/tasks/{taskId}` (line 123) — fetch task details | Same HTTP call |
| Output `=== GOAL REMINDER ===` block with task ID, description, progress (lines 742-758) | Return context string from `context` event handler — pi injects this before compaction |

##### UserPromptSubmit → `input`

| Current | Pi-mono |
|---|---|
| Check task cancellation via `checkAndBlockIfCancelled(true)` (lines 913-917) | Check cancellation in `input` event handler |
| If cancelled: output `{"decision":"block","reason":"🛑 TASK CANCELLED: ..."}` | Return `{ type: "handled", response: "🛑 TASK CANCELLED: ..." }` to prevent the prompt from being processed |

##### Stop → `agent_end`

| Current | Pi-mono |
|---|---|
| Clean up PM2 artifact tunnels (lines 923-939) | Same `pm2 jlist` + `pm2 delete` calls |
| `pm2 save` (lines 941-946) | Same |
| Sync CLAUDE.md to server via `PUT /api/agents/{id}/profile` (line 949) | Sync AGENTS.md instead (or whatever file was used) |
| Sync identity files (SOUL.md, IDENTITY.md, TOOLS.md) to server (line 950) | Same sync logic |
| Sync setup script to server (line 951) | Same |
| Restore CLAUDE.md backup (line 954) | Not needed — no file was overridden |
| Session summarization via Claude Haiku subprocess (lines 960-1063): read transcript, generate summary prompt, spawn `claude -p --model haiku`, parse result, index as memory | **Adaptation needed**: pi-mono doesn't produce a transcript file the same way. Options: (a) use `session.sessionFile` to read the `.jsonl` session log, (b) capture messages during the session and summarize at end, (c) spawn a separate summarization process (Haiku via API or CLI). The summary indexing via `POST /api/memory/index` remains identical |
| `POST /close` — mark agent offline (line 1066) | Same HTTP call |

#### Complete pi-mono extension implementation (pseudocode)

```typescript
function swarmHooksExtension(config: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  taskId?: string;
  isLead: boolean;
}) {
  return function(pi: ExtensionAPI) {
    const headers = {
      "Authorization": `Bearer ${config.apiKey}`,
      "X-Agent-ID": config.agentId,
    };

    // --- SessionStart equivalent ---
    pi.on("session_start", async (event, ctx) => {
      // Ping + fetch agent info
      void fetch(`${config.apiUrl}/ping`, { method: "POST", headers }).catch(() => {});
      const agentInfo = await fetch(`${config.apiUrl}/me?include=inbox`, { headers })
        .then(r => r.json()).catch(() => null);

      // Lead: concurrent context injection
      if (config.isLead && agentInfo) {
        const context = await fetch(`${config.apiUrl}/api/concurrent-context`, { headers })
          .then(r => r.json()).catch(() => null);
        if (context) {
          // Inject via context event or steer
        }
      }

      // Clear tool loop history
      if (config.taskId) {
        try { await unlink(`/tmp/agent-swarm-tool-history/${config.taskId}.json`); } catch {}
      }
    });

    // --- PreToolUse equivalent ---
    pi.on("tool_call", async (event, ctx) => {
      // Check 1: Task cancellation
      if (!config.isLead && config.taskId) {
        const resp = await fetch(
          `${config.apiUrl}/cancelled-tasks?taskId=${config.taskId}`,
          { headers }
        );
        const data = await resp.json();
        if (data.cancelled) {
          return { block: true, reason: `🛑 TASK CANCELLED: ${data.reason}` };
        }
      }

      // Check 2: Tool loop detection
      if (!config.isLead && config.taskId) {
        const loopResult = checkToolLoop(config.taskId, event.toolName, event.params);
        if (loopResult?.severity === "blocked") {
          return { block: true, reason: loopResult.reason };
        }
      }

      // Check 3: Poll-task blocking
      if (event.toolName.endsWith("poll-task")) {
        const me = await fetch(`${config.apiUrl}/me`, { headers }).then(r => r.json());
        if (me.shouldBlockPolling) {
          return { block: true, reason: "🛑 POLLING LIMIT REACHED" };
        }
      }
    });

    // --- PostToolUse equivalent ---
    pi.on("tool_result", async (event, ctx) => {
      // Heartbeat
      if (config.taskId) {
        void fetch(`${config.apiUrl}/api/active-sessions/heartbeat/${config.taskId}`,
          { method: "PUT", headers }).catch(() => {});
      }
      // Activity timestamp
      void fetch(`${config.apiUrl}/api/agents/${config.agentId}/activity`,
        { method: "PUT", headers }).catch(() => {});

      // File sync and memory indexing (check event.toolName and file paths)
      // ... same logic as hook.ts:833-892
    });

    // --- PreCompact equivalent ---
    pi.on("context", async (event, ctx) => {
      if (config.taskId) {
        const task = await fetch(`${config.apiUrl}/api/tasks/${config.taskId}`,
          { headers: { "Authorization": `Bearer ${config.apiKey}` } }).then(r => r.json());
        return `=== GOAL REMINDER ===\nTask: ${task.task}\nProgress: ${task.progress || "none"}\n===`;
      }
    });

    // --- Stop equivalent ---
    pi.on("agent_end", async (event, ctx) => {
      // Sync files, summarize session, mark offline
      // ... same logic as hook.ts:921-1076
      void fetch(`${config.apiUrl}/close`, { method: "POST", headers }).catch(() => {});
    });
  };
}
```

#### Parity gaps and mitigations

| Gap | Severity | Mitigation |
|-----|----------|------------|
| **Session transcript for summarization**: Claude produces a transcript file; pi-mono uses `.jsonl` session files | Medium | Read `session.sessionFile` (`.jsonl`) and parse messages for summarization input. Different format but same information. |
| **Warning-only output**: Claude hooks can output plain text warnings that don't block. Pi-mono `tool_call` can only block or not block. | Low | For warnings, inject a message via `session.steer()` or `session.followUp()` to notify the agent without blocking the tool call. |
| **File write tool names**: Claude uses `Write`/`Edit`; pi-mono uses `write_file`/`edit_file` | Low | Extension checks for both naming conventions, or uses pi-mono tool names. |
| **PM2 artifact tunnels**: Specific to current Docker setup | Low | Same PM2 commands work in pi-mono containers if PM2 is available. |

---

### 6. Auth, Provider, and Model Configuration

#### Pi-mono's auth system

**Auth storage**: Credentials stored in `~/.pi/agent/auth.json` (0600 permissions). Managed by `AuthStorage` class. Auth file credentials take priority over environment variables.

**Credential resolution order**:
1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable

**Supported providers**: Anthropic, OpenAI, OpenRouter, Azure OpenAI, Google, and any OpenAI-compatible endpoint.

#### Required auth configuration for the pi adapter

| Provider | Required env vars | Optional env vars | Notes |
|----------|------------------|-------------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | Closest parity with current Claude auth |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | Good for provider/model switching |
| OpenAI / Codex | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_ORG_ID` | Supports Codex/OpenAI auth |
| Codex subscription | OAuth via `pi login` | — | Uses `auth.json` with OAuth token, no env var needed |
| Local (Ollama) | — | `OLLAMA_BASE_URL` | No API key required |

#### Model selection

**Current agent-swarm model resolution** (`src/commands/runner.ts:1088`): `task.model → MODEL_OVERRIDE env → "opus"` (default)

**Pi-mono model selection for the adapter**:
```typescript
// Model resolution in PiMonoAdapter
const modelName = task.model || process.env.MODEL_OVERRIDE || "opus";

// Map swarm model names to pi-mono model references
const modelMap: Record<string, string> = {
  "haiku": "claude-haiku-4-5",
  "sonnet": "claude-sonnet-4-6",
  "opus": "claude-opus-4-6",
  // OpenRouter/OpenAI models use their native identifiers
};

const model = modelRegistry.getModel(modelMap[modelName] || modelName);

const { session } = await createAgentSession({
  model,
  modelRegistry,
  authStorage,
  // ...
});
```

**Key points**:
- `ModelRegistry` handles model-to-provider mapping automatically
- The adapter can use `HARNESS_MODEL` env var (or reuse `MODEL_OVERRIDE`) to specify the exact model identifier when swarm's `haiku/sonnet/opus` shortnames don't suffice
- For OpenRouter: model names like `google/gemini-2.0-flash-001` pass through directly
- `AuthStorage.create()` auto-discovers credentials from `auth.json` and env vars

#### Bootstrap flow in the adapter

1. Resolve `HARNESS_PROVIDER`; branch to pi adapter only when set to `pi`
2. Create `AuthStorage` (auto-discovers from `auth.json` + env)
3. Create `ModelRegistry` with auth storage
4. Resolve model from task/env/default
5. Validate required auth before session creation — fail fast with actionable error
6. Create session with resolved model, auth, and tools
7. **Do not silently fallback** from pi to Claude on auth errors — only fallback on unknown `HARNESS_PROVIDER` values

#### Docker/compose persistence

For compose deployments, the pi-mono config directory (`~/.pi/agent/`) must persist across container restarts to maintain:
- `auth.json` — credentials
- Session `.jsonl` files — for resume capability
- `models.json` — custom model configurations

**Volume mount needed**: `~/.pi/agent/` should be mounted as a persistent volume in Docker Compose, similar to how `/workspace/` is currently mounted.

---

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/commands/runner.ts` | 1090-1103 | Claude CLI spawn — no `--mcp-server` flags |
| `src/commands/runner.ts` | 1110, 1292 | `--append-system-prompt` argument construction |
| `src/commands/runner.ts` | 517-531 | `RunClaudeIterationOptions` interface |
| `src/commands/runner.ts` | 534-542 | `RunningTask` interface |
| `src/commands/runner.ts` | 610-623 | `CostData` interface |
| `src/commands/runner.ts` | 1088 | Model resolution chain |
| `src/commands/runner.ts` | 1158-1161 | Claude init event duck-typing for session ID |
| `src/commands/runner.ts` | 1369-1399 | Claude result event duck-typing for cost/usage |
| `src/commands/runner.ts` | 1689-1880 | `buildSystemPrompt()` closure and profile fetch |
| `src/commands/runner.ts` | 866-1037 | `buildPromptForTrigger()` — trigger-specific prompts |
| `src/prompts/base-prompt.ts` | 373-484 | `getBasePrompt()` — system prompt assembly |
| `src/prompts/base-prompt.ts` | 456-466 | Agent CLAUDE.md injection section |
| `src/prompts/base-prompt.ts` | 346 | Truncation constants |
| `src/server.ts` | 98-216 | `createServer()` — MCP server construction and tool registration |
| `src/server.ts` | 84-92 | `CAPABILITIES` env var parsing and `hasCapability()` |
| `src/tools/utils.ts` | 86-115 | `createToolRegistrar` — agent ID extraction wrapper |
| `src/tools/utils.ts` | 23-37 | `getRequestInfo` — X-Agent-ID header extraction |
| `src/tools/tool-config.ts` | 13-38 | `CORE_TOOLS` — 16 always-in-context tools |
| `src/tools/tool-config.ts` | 41-105 | `DEFERRED_TOOLS` — 42 on-demand tools |
| `src/http/mcp.ts` | 29-47 | Per-session `McpServer` creation for Streamable HTTP |
| `src/types.ts` | 4-15 | `AgentTaskStatusSchema` — task lifecycle states |
| `src/types.ts` | 68-137 | `AgentTaskSchema` — central task type with `claudeSessionId` |
| `src/types.ts` | 324-335 | `SessionLogSchema` |
| `src/types.ts` | 338-355 | `SessionCostSchema` |
| `src/types.ts` | 528-539 | `ActiveSessionSchema` |
| `src/utils/error-tracker.ts` | 6-11 | `ErrorSignal` interface |
| `src/hooks/hook.ts` | 661-673 | SessionStart hook — writes CLAUDE.md to `~/.claude/` |
| `src/hooks/hook.ts` | 763-808 | PreToolUse — cancellation check, loop detection, poll blocking |
| `src/hooks/hook.ts` | 811-908 | PostToolUse — heartbeat, file sync, memory index |
| `src/hooks/hook.ts` | 738-761 | PreCompact — goal reminder injection |
| `src/hooks/hook.ts` | 921-1076 | Stop — cleanup, summarize, sync, close |
| `src/hooks/tool-loop-detection.ts` | — | Loop detection logic with file-based history |
| `src/workflows/llm-provider.ts` | 1-56 | `LlmProvider` interface (workflow-only) |
| `docker-entrypoint.sh` | 114-134 | `.mcp.json` generation for Docker workers |
| `Dockerfile.worker` | 119-122 | Plugin commands/agents/skills installation |
| `plugin/` | — | All plugin content (commands, agents, skills) |
| `src/commands/setup.tsx` | 56-76 | Hook config generation (Claude Code-only) |

## Architecture Documentation

### Current architecture

The runner (`runAgent` in `src/commands/runner.ts`) is a monolithic orchestrator that:
1. Polls for tasks via HTTP (`GET /api/poll`)
2. Builds prompts per trigger type (`buildPromptForTrigger`)
3. Assembles system prompt (`getBasePrompt` + additional)
4. Spawns Claude CLI as a subprocess (`Bun.spawn`)
5. Parses stdout stream-json events inline (no formal types)
6. Persists session data via HTTP API calls

The MCP server runs as part of the HTTP server process, not the runner. Claude CLI connects to it independently via `.mcp.json` discovery.

### Proposed architecture with provider adapter

```
                    ┌──────────────────────┐
                    │   Runner (runAgent)   │
                    │                      │
                    │  1. Poll for tasks    │
                    │  2. Build prompts     │  ← getBasePrompt() reused across adapters
                    │  3. Select provider   │  ← HARNESS_PROVIDER env var
                    │  4. Create session    │  ← ProviderAdapter.createSession()
                    │  5. Listen to events  │  ← ProviderEvent (normalized)
                    │  6. Persist data      │  ← Same HTTP API calls
                    └──────┬───────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼─────────┐    ┌─────────▼─────────┐
    │   ClaudeAdapter    │    │   PiMonoAdapter    │
    │                    │    │                    │
    │ Bun.spawn("claude")│    │ createAgentSession │
    │ Parse stream-json  │    │ Subscribe events   │
    │ --resume for cont. │    │ SessionManager for │
    │                    │    │   resume           │
    │ MCP via .mcp.json  │    │ MCP via            │
    │ (Claude discovers) │    │   pi-mcp-adapter   │
    │                    │    │                    │
    │ Hooks via external │    │ Hooks via built-in │
    │   process (stdin/  │    │   extension (pi.on │
    │   stdout JSON)     │    │   event handlers)  │
    └────────────────────┘    └────────────────────┘
              │                         │
              │    Both emit            │
              └────────┬───────────────┘
                       │
                       ▼
              ProviderEvent stream
                       │
                       ▼
              ┌────────────────────┐
              │  Shared pipeline   │
              │  - Session logs    │
              │  - Session costs   │
              │  - Task finish     │
              │  - Active sessions │
              └────────────────────┘
```

### Hook API calls summary (identical across adapters)

| Event | Endpoint | Method | Purpose |
|-------|----------|--------|---------|
| **All** | `/ping` | POST | Heartbeat |
| **All** | `/me?include=inbox` | GET | Agent info + inbox |
| session_start | `/api/concurrent-context` | GET | Lead-only context |
| tool_call | `/cancelled-tasks[?taskId=]` | GET | Cancellation check |
| tool_call | `/me` | GET | Poll limit check |
| tool_result | `/api/active-sessions/heartbeat/{taskId}` | PUT | Session heartbeat |
| tool_result | `/api/agents/{id}/activity` | PUT | Activity timestamp |
| tool_result | `/api/agents/{id}/profile` | PUT | File sync (self_edit) |
| tool_result | `/api/memory/index` | POST | Memory auto-index |
| context | `/api/tasks/{id}` | GET | Goal reminder |
| agent_end | `/api/agents/{id}/profile` | PUT | File sync (session_sync) |
| agent_end | `/api/memory/index` | POST | Session summary index |
| agent_end | `/close` | POST | Mark offline |

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — Previous research covering the general adapter architecture, Claude-to-pi control flow mapping, auth/env contracts, hook mapping table, and implementation decomposition. This document builds on that with concrete API details.
- `thoughts/swarm-researcher/research/2026-02-23-openclaw-vs-agent-swarm-comparison.md` — OpenClaw vs agent-swarm lifecycle comparisons, including session continuity patterns.
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` — Runner loop and trigger architecture baseline.

## Related Research

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — General pi-mono provider integration research (predecessor to this document)
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` — Runner loop architecture baseline

## Resolved Questions

These were originally open questions from the first draft, now answered through follow-up research:

- **Schema translation strategy**: ~~Resolved~~ — Not needed. The MCP adapter approach (Approach B) avoids Zod-to-TypeBox conversion entirely. If Approach A is ever revisited, JSON Schema bridge is the simplest path (both libraries support JSON Schema output).
- **Cost tracking aggregation**: ~~Resolved~~ — Per-message `usage` objects available on each `AssistantMessage` with fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, plus cost breakdown. Session-level aggregates via `get_session_stats` RPC. Adapter aggregates from `agent_end` event messages to populate `CostData`.
- **Extension sandboxing**: ~~Resolved~~ — Docker containers provide sufficient isolation. Extension code runs with full process permissions inside the container, which is acceptable.
- **`tool_call` blocking semantics**: ~~Resolved~~ — Pi-mono `tool_call` handlers return `{ block: true, reason: "..." }` and the reason string is sent back to the LLM as a tool error. Throwing also blocks (fail-safe). Full parity with Claude's `{"decision":"block","reason":"..."}` stdout JSON.

## Remaining Items to Verify During Implementation

- **Session resume persistence in compose**: Pi-mono session files (`.jsonl`) live under `~/.pi/agent/` by default. For Docker Compose deployments, this directory needs a persistent volume mount. Confirm exact path structure and whether `SessionManager` supports custom storage paths.
- **Session summarization transcript format**: The Stop hook reads a Claude transcript file. For pi-mono, read `session.sessionFile` (`.jsonl` format) instead — different structure, needs a parser adapter.
- **Skill format convergence**: Both harnesses use markdown-based skills but with different layouts. A shared format via `.agents/skills/` (supported by pi-mono) could enable single-source definitions. Decide during implementation.
- **pi-mcp-adapter HTTP support maturity**: The adapter primarily targets stdio-based MCP servers. Verify its HTTP MCP support against the swarm's Streamable HTTP implementation early in Phase 1. If incomplete, contribute upstream or fall back to Approach A.
