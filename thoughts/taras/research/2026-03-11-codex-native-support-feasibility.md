---
date: 2026-03-11T12:00:00-07:00
researcher: Claude
git_commit: 593fd82
branch: feat/codex-support
repository: agent-swarm
topic: "How reasonable is native Codex support given the existing provider abstraction?"
tags: [research, codex, provider-abstraction, harness, openai, app-server]
status: complete
autonomy: autopilot
last_updated: 2026-03-11
last_updated_by: Claude
github_issue: https://github.com/desplega-ai/agent-swarm/issues/100
---

# Research: Native Codex Support Feasibility

**Date**: 2026-03-11
**Researcher**: Claude
**Git Commit**: 593fd82
**Branch**: feat/codex-support

## Research Question

Based on GitHub issue #100 and the recent pi-mono harness implementation, how reasonable would it be to support OpenAI Codex natively in agent-swarm?

## Summary

**Verdict: Highly feasible, moderate effort (~1-2 weeks for a senior dev).**

The original bot assessment on issue #100 estimated 5-6 weeks and described it as "high effort" — but that was written *before* the provider abstraction existed. Since then, PR #139 introduced a clean `ProviderAdapter`/`ProviderSession` interface with the pi-mono adapter as a second implementation. The runner (`src/commands/runner.ts`) is now fully provider-agnostic. Adding Codex is essentially: implement a third adapter following the pi-mono pattern.

The recommended integration path is the **Codex App Server** (not `codex exec` CLI). The App Server exposes a JSON-RPC protocol over stdio with thread/turn lifecycle management, rich event streaming, and programmatic auth — mapping cleanly to the existing `ProviderSession` interface. Hooks are unnecessary because the event stream provides all the signals the runner needs (same pattern pi-mono uses with its extension API).

Three blockers worth noting: (1) the App Server has known issues with sandbox bypass not working for tool child processes (issue #14068), (2) approval handling in strict protocol-only mode has an RPC gap (issue #14192), and (3) Codex's MCP streamable HTTP client has had reliability issues in the past. All are workable but need attention during implementation.

## Detailed Findings

### 1. Existing Provider Abstraction

The provider system lives in `src/providers/` with a clean interface hierarchy:

- **`ProviderAdapter`** (`types.ts:70`): Top-level factory — `name`, `createSession(config)`, `canResume(sessionId)`
- **`ProviderSession`** (`types.ts:50`): Running session — `sessionId`, `onEvent(listener)`, `waitForCompletion()`, `abort()`
- **`ProviderEvent`** (`types.ts:18`): Normalized event union — `session_init`, `message`, `tool_start`, `tool_end`, `result`, `error`, `raw_log`, `raw_stderr`, `custom`
- **`ProviderResult`** (`types.ts:58`): Completion — `exitCode`, `sessionId`, `cost`, `isError`, `failureReason`
- **`ProviderSessionConfig`** (`types.ts:30`): Input — prompt, systemPrompt, model, role, agentId, taskId, cwd, env, etc.

Factory in `src/providers/index.ts` selects adapter via `HARNESS_PROVIDER` env var. Runner at `runner.ts:1428` calls `createProviderAdapter()` once at startup and uses it throughout.

### 2. Two Existing Adapters as Templates

#### Claude Adapter (`claude-adapter.ts`) — Subprocess Pattern
- Spawns `claude` CLI via `Bun.spawn()` with `--output-format stream-json`
- Parses JSONL stdout for session IDs, cost data, errors
- Hooks are external processes invoked by Claude CLI's hook system
- MCP discovered via `.mcp.json` file on disk
- Resume via `--resume <sessionId>` flag
- Stale session auto-retry (strips `--resume` if session not found)

#### Pi-Mono Adapter (`pi-mono-adapter.ts`) — Library/Programmatic Pattern
- Uses `@mariozechner/pi-coding-agent` library in-process (no subprocess)
- MCP tools discovered programmatically via `McpHttpClient` (performs HTTP handshake, lists tools, wraps as pi-mono `ToolDefinition[]`)
- Hooks implemented as extension API handlers (`pi-mono-extension.ts:380`) — maps all 6 Claude hook events to pi-mono events
- Creates `AGENTS.md -> CLAUDE.md` symlink (pi-mono reads `AGENTS.md`)
- Model resolution maps shortnames to `provider/model-id` pairs

**The pi-mono adapter is the closer template for Codex** — both use programmatic session management rather than raw CLI invocation.

### 3. Codex App Server Protocol

The [App Server](https://developers.openai.com/codex/app-server/) is a Rust binary (`codex app-server --listen stdio://`) exposing JSON-RPC over stdio. Key primitives:

| Concept | Methods |
|---------|---------|
| **Thread** (durable conversation) | `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/list`, `thread/compact/start`, `thread/rollback` |
| **Turn** (single user->agent cycle) | `turn/start`, `turn/steer`, `turn/interrupt` |
| **Item** (atomic I/O unit) | Notifications: `item/started`, `item/*/delta`, `item/completed` |
| **Auth** | `account/login/start`, `account/read`, `account/logout` |

Item types: `userMessage`, `agentMessage`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`.

The protocol uses "JSON-RPC lite" — same structure as JSON-RPC 2.0 but omits the `"jsonrpc":"2.0"` field. Messages are JSONL-framed over stdio.

### 4. Mapping: App Server -> ProviderSession Interface

| ProviderSession | Codex App Server |
|-----------------|------------------|
| `createSession(config)` | Spawn `codex app-server`, send `initialize` + `initialized`, then `thread/start` + `turn/start` |
| `sessionId` | Thread ID from `thread/started` notification |
| `onEvent(listener)` | Monitor JSONL notifications, map `item/*` -> `ProviderEvent` |
| `waitForCompletion()` | Wait for `turn/completed` notification, extract token usage (no USD cost — calculate from tokens + model pricing) |
| `abort()` | Send `turn/interrupt` |
| `canResume(id)` | Send `thread/list`, check if thread ID exists |
| Resume | `thread/resume` + `turn/start` instead of `thread/start` |

Event mapping:

| Codex Notification | ProviderEvent |
|--------------------|---------------|
| `thread/started` | `session_init` (with thread ID) |
| `item/started` (type: `commandExecution` or `mcpToolCall`) | `tool_start` |
| `item/completed` (type: `commandExecution` or `mcpToolCall`) | `tool_end` |
| `item/completed` (type: `agentMessage`) | `message` |
| `turn/completed` | `result` (with token usage — `input_tokens`, `cached_input_tokens`, `output_tokens`; no USD cost) |
| Error responses | `error` |
| `item/*/delta` | `raw_log` (for streaming) |

### 5. Hooks Strategy: Event Stream Monitoring (No Hooks Needed)

Codex has no hook system — but this is not a blocker. The same approach pi-mono uses (in-process event monitoring) works for Codex via the event stream:

| Hook Behavior | Claude Implementation | Pi-Mono Implementation | Codex Implementation |
|--------------|----------------------|----------------------|---------------------|
| Task cancellation check | `PreToolUse` hook polls API | `tool_call` extension polls API | Monitor `item/started` (tool), poll API |
| Tool loop detection | `PostToolUse` hook tracks patterns | `tool_result` extension tracks patterns | Monitor `item/completed` (tool), track patterns |
| Heartbeat | `PreToolUse` hook pings API | `tool_call` extension pings API | Monitor any `item/*` event, ping API |
| Identity sync | `SessionStart` hook syncs files | `session_start` extension syncs files | On `thread/started`, sync files |
| Memory auto-index | `PostToolUse` hook checks file writes | `tool_result` extension checks writes | Monitor `item/completed` (fileChange), trigger index |
| Context preservation | `PreCompact` hook sends context | `context` extension sends context | On `thread/compact/start`, send context |
| Session summarization | `Stop` hook summarizes | `session_shutdown` extension summarizes | On process exit / `turn/completed` (final), summarize |
| Mid-task guidance | Not possible | Not possible | **Bonus: `turn/steer`** |

The runner's `onEvent()` handler can perform all these checks inline, similar to how the pi-mono extension works but using the JSONL event stream instead.

### 6. Event Mapping for UI Consumption

The dashboard renders session logs as chat bubbles. All log data flows through `raw_log` events → runner `LogBuffer` → API → `session_logs` DB table → UI polling.

**Critical requirement**: The `raw_log` `content` string must be Claude-compatible JSON. The UI parser (`new-ui/src/components/shared/session-log-viewer.tsx:46-125`) expects:

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "...", "name": "...", "input": {...} },
      { "type": "tool_result", "tool_use_id": "...", "content": "..." },
      { "type": "thinking", "thinking": "..." }
    ],
    "model": "model-name"
  }
}
```

**How pi-mono solved this** (`pi-mono-adapter.ts:183-247`): It constructs Claude-format JSON strings inside `raw_log` events — mapping `message_end` → `text` blocks, `tool_execution_start` → `tool_use` blocks, `tool_execution_end` → `tool_result` blocks. Also has deduplication via `lastEmittedMessage` to skip duplicate text across turns.

**What the Codex adapter must do**: Map App Server item notifications to the same format:

| Codex Item | Claude-format content block |
|------------|---------------------------|
| `item/completed` (type: `agentMessage`) | `{ "type": "text", "text": "..." }` |
| `item/started` (type: `commandExecution`) | `{ "type": "tool_use", "id": itemId, "name": "Bash", "input": { "command": "..." } }` |
| `item/completed` (type: `commandExecution`) | `{ "type": "tool_result", "tool_use_id": itemId, "content": "exit=0\nstdout..." }` |
| `item/started` (type: `mcpToolCall`) | `{ "type": "tool_use", "id": itemId, "name": toolName, "input": args }` |
| `item/completed` (type: `mcpToolCall`) | `{ "type": "tool_result", "tool_use_id": itemId, "content": result }` |
| `item/started` (type: `fileChange`) | `{ "type": "tool_use", "id": itemId, "name": "Edit"/"Write", "input": { "path": "..." } }` |
| `item/completed` (type: `reasoning`) | `{ "type": "thinking", "thinking": "..." }` |
| `item/*/delta` (type: `agentMessage`) | Accumulate text, emit on `item/completed` |

**Batching**: The runner's `LogBuffer` (`runner.ts:517-576`) already handles batching — 50 lines or 5s, whichever comes first. The Codex adapter just needs to emit `raw_log` events; the runner handles the rest. No adapter-level batching needed.

**Deduplication**: Like pi-mono, the Codex adapter should track the last emitted message text to avoid duplicates when the same content appears across turns.

### 7. MCP Integration

Codex natively supports MCP servers via `config.toml`:

```toml
[mcp_servers.agent-swarm]
type = "http"  # or "sse"
url = "http://host.docker.internal:3013/mcp"
bearer_token_env_var = "API_KEY"                     # Reads API_KEY env var, sends as Bearer token
env_http_headers = { "X-Agent-ID" = "AGENT_ID" }    # Reads AGENT_ID env var, sends as header value
```

Tool names are auto-prefixed as `mcp__agent-swarm__<tool>`. This means:
- **No custom MCP client needed** (unlike pi-mono which needed `McpHttpClient`)
- Docker entrypoint writes `config.toml` instead of `.mcp.json`
- Tool name format differs from Claude's (may need mapping in hook-equivalent logic)

Known caveat: Codex's streamable HTTP MCP client has had issues (#3324, #4707). The `sse` transport type may be more reliable as fallback.

### 7. Authentication for Docker Workers

Three auth strategies, with increasing capability:

#### Strategy A: API Key (simplest, recommended for MVP)

```bash
OPENAI_API_KEY=sk-...  # env var, or via App Server: account/login/start type: "apiKey"
```

- Simplest — just an env var, no token management
- Pay-per-token billing (codex-mini: $1.50/$6 per 1M in/out)
- **No fast mode**, 1x rate limits (vs 2x with subscription)

#### Strategy B: Pre-seeded auth.json (subscription benefits)

```bash
# 1. Login on a machine with browser: codex login
# 2. Copy ~/.codex/auth.json into container via volume mount or Docker secret
# 3. Set in config.toml: cli_auth_credentials_store = "file"
```

- Gets subscription rate limits (2x), fast mode, included credits
- **Critical**: Each worker needs its **own auth.json** — concurrent refresh from shared tokens causes race condition ([#10332](https://github.com/openai/codex/issues/10332)) since refresh tokens are single-use
- Access tokens last ~1 hour, auto-refresh; full bundle valid ~28 days
- Never overwrite auth.json on container restart (preserves refreshed tokens)

#### Strategy C: chatgptAuthTokens via App Server (ideal long-term)

```jsonc
// App Server RPC: account/login/start
{"id": 2, "method": "account/login/start", "params": {
  "type": "chatgptAuthTokens",
  "idToken": "<JWT>",
  "accessToken": "<JWT>"
}}
// When tokens expire, app-server sends: account/chatgptAuthTokens/refresh
// Host must respond with fresh tokens
```

- Agent-swarm API acts as centralized token manager
- Avoids the refresh race condition entirely (one token service, many workers)
- Gets all subscription benefits
- Requires implementing token lifecycle management in the swarm API
- Best for production multi-worker fleets

#### Subscription vs API Key Comparison

| Feature | ChatGPT Subscription | API Key |
|---------|---------------------|---------|
| Fast mode | Yes | No |
| Rate limits | 2x baseline | 1x baseline |
| Pricing | Subscription + credits | Pay-per-token |
| Docker simplicity | Complex (token management) | Simple (env var) |
| Multi-worker | Needs per-worker tokens | No issues |

**Recommendation**: Start with API key (Strategy A) for MVP. Add subscription auth (Strategy B or C) as a follow-up for operators who want fast mode and better rate limits.

Ref: [Codex Auth](https://developers.openai.com/codex/auth/), [CI/CD Auth](https://developers.openai.com/codex/auth/ci-cd-auth), [Pricing](https://developers.openai.com/codex/pricing/), [Race condition #10332](https://github.com/openai/codex/issues/10332)

### 8. Session Resume Across Tasks

The runner supports resuming a provider session when picking up paused tasks or when child tasks inherit parent context. This mechanism is currently Claude-specific and needs adapter-level changes for Codex.

#### How resume works today

1. **Session ID capture**: Provider emits `session_init` event → runner calls `PUT /api/tasks/:id/claude-session` → stored in `agent_tasks.claudeSessionId` column
2. **Resume trigger** (two paths):
   - **Paused tasks** (`runner.ts:1819-1832`): Runner finds task with `claudeSessionId`, adds `["--resume", id]` to `additionalArgs`
   - **Child tasks** (`runner.ts:2048-2065`): Runner fetches parent's `claudeSessionId`, adds `["--resume", parentSessionId]` to `additionalArgs`
3. **Resume delivery**: `--resume <id>` is passed through `additionalArgs` → only the Claude adapter's `buildCommand()` consumes it
4. **Stale session retry** (`claude-adapter.ts:266-319`): If Claude returns "session not found", adapter strips `--resume` and retries fresh

#### Current gaps

- **`ProviderSessionConfig.resumeSessionId`** exists (`types.ts:40`) but is **passive metadata** — no adapter reads it to drive behavior
- **`ProviderAdapter.canResume()`** exists (`types.ts:73`) but is **never called** by the runner — resume is always attempted optimistically
- **`additionalArgs` is Claude-specific**: Passing `--resume` as CLI args only works for the Claude adapter. Pi-mono ignores it. Codex would need `thread/resume` instead.
- **DB column name**: `claudeSessionId` is misleading — it stores any provider's session ID

#### What the Codex adapter needs

The Codex adapter must handle resume via `thread/resume` instead of `thread/start`:

```
CodexAdapter.createSession(config):
  if config.resumeSessionId OR "--resume" found in config.additionalArgs:
    -> send thread/resume { threadId: sessionId }
    -> on failure: fall back to thread/start (stale session retry)
  else:
    -> send thread/start { settings: {...} }
  then:
    -> send turn/start with prompt
```

**Recommended cleanup** (during implementation): Refactor the runner to use `config.resumeSessionId` instead of `additionalArgs` for resume. This makes the intent explicit and each adapter can translate it to their own mechanism:
- Claude: `--resume <id>` CLI flag
- Pi-mono: `SessionManager.resume(id)` (currently unused)
- Codex: `thread/resume { threadId: id }`

#### Thread persistence for Codex

Codex stores threads in `~/.codex/sessions/`. For resume to work in Docker:
- Set `[history] persistence = "local"` in config.toml (not `"none"`)
- Session files must survive container restarts (volume mount `~/.codex/sessions/`)
- Alternative: Codex's `thread/resume` may work with just the thread ID if the app-server process is long-lived (no disk persistence needed within a single process lifetime)

### 9. Docker Worker Changes

A `codex` case in docker-entrypoint.sh:

```bash
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Error: OPENAI_API_KEY required for codex provider"
        exit 1
    fi
    # Write config.toml for MCP
    mkdir -p /home/worker/.codex
    cat > /home/worker/.codex/config.toml <<TOML
model = "${MODEL:-o3}"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[mcp_servers.agent-swarm]
type = "http"
url = "${MCP_BASE_URL}/mcp"
bearer_token_env_var = "API_KEY"
env_http_headers = { "X-Agent-ID" = "AGENT_ID" }
TOML
fi
```

Dockerfile.worker needs: `npm install -g @openai/codex` (or curl install script). Both CLIs are already installed side-by-side (Claude + pi-mono), adding Codex follows the same pattern.

### 9. What Needs to Be Built

| Component | Effort | Description |
|-----------|--------|-------------|
| `src/providers/codex-adapter.ts` | Medium | Spawn app-server, JSON-RPC client, session lifecycle, event mapping |
| `src/providers/codex-jsonrpc-client.ts` | Medium | JSONL-over-stdio JSON-RPC client (spawn process, send/receive, handle notifications) |
| Update `src/providers/index.ts` | Trivial | Add `"codex"` case to factory |
| Docker entrypoint changes | Low | Auth validation, `config.toml` generation |
| Dockerfile.worker changes | Low | Install Codex CLI |
| Hook-equivalent logic in adapter | Medium | Event stream monitoring for cancellation, loop detection, heartbeats, memory indexing |
| Tests | Medium | Unit tests for adapter, E2E with Docker |

### 10. Known Blockers & Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| App Server sandbox bypass bug (#14068) | Medium | Use `danger-full-access` sandbox mode; monitor for fix |
| Approval RPC gap in protocol-only mode (#14192) | Medium | Use `approval_policy = "never"` + `danger-full-access` |
| MCP streamable HTTP reliability (#3324, #4707) | Medium | Fall back to SSE transport if HTTP fails; test thoroughly |
| No `setup-token` equivalent for long-lived auth | Low | API key auth doesn't expire — simpler than Claude |
| Cost model (pay-per-token vs subscription) | Info | Document for operators; may affect worker fleet economics |
| Tool name prefixing (`mcp__agent-swarm__*`) | Low | Adjust tool name checks in hook-equivalent logic |
| Generated TypeScript types may drift | Low | Pin to Codex version; regenerate on upgrade |

### 11. Comparison with Original Issue #100 Assessment

The bot's original assessment (Feb 27) estimated 5-6 weeks across 4 phases. Here's what changed:

| Original Concern | Current Status |
|-----------------|----------------|
| "Runner deeply coupled to Claude Code" | **Resolved.** Runner is now provider-agnostic via `ProviderAdapter` |
| "2200+ lines with Claude CLI assumptions" | **Resolved.** Claude-specific code extracted to `claude-adapter.ts` |
| "Need RuntimeProvider interface" | **Done.** `ProviderAdapter`/`ProviderSession` exist and are proven |
| "CRITICAL BLOCKER: No hooks in Codex" | **Mitigated.** Pi-mono proved event-stream-based hooks work; Codex App Server provides rich events |
| "Separate Dockerfile needed" | **Not needed.** Single Dockerfile already installs multiple CLIs |
| "5-6 weeks for a senior developer" | **~1-2 weeks** given existing abstraction and pi-mono as template |

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/providers/types.ts` | 18-70 | Provider contract interfaces (ProviderAdapter, ProviderSession, ProviderEvent, ProviderResult) |
| `src/providers/index.ts` | 15-24 | Factory function — add `"codex"` case here |
| `src/providers/claude-adapter.ts` | 50-318 | Claude adapter — subprocess spawn + JSONL parsing pattern |
| `src/providers/pi-mono-adapter.ts` | 137-432 | Pi-mono adapter — programmatic session + MCP client pattern (closer template) |
| `src/providers/pi-mono-extension.ts` | 380-619 | Hook-equivalent via event handlers (pattern to follow for Codex) |
| `src/providers/pi-mono-mcp-client.ts` | 1-119 | MCP HTTP client (Codex doesn't need this — native MCP support) |
| `src/commands/runner.ts` | 1098-1314 | Provider-agnostic spawn + iteration functions |
| `src/commands/runner.ts` | 1428 | Adapter instantiation point |
| `src/hooks/hook.ts` | 200-907 | Claude hook handler (Codex won't need this) |
| `docker-entrypoint.sh` | 5-19 | Per-provider auth validation |
| `docker-entrypoint.sh` | 172-192 | Claude MCP config writing (Codex needs `config.toml` equivalent) |
| `Dockerfile.worker` | 77-83 | CLI installation section (add Codex install here) |
| `Dockerfile.worker` | 103-117 | Claude hooks config (Codex doesn't need this) |
| `Dockerfile.worker` | 165 | `HARNESS_PROVIDER` default |

## Architecture Documentation

### Provider Abstraction Data Flow

```
Docker start
  -> docker-entrypoint.sh validates auth per HARNESS_PROVIDER
  -> exec agent-swarm worker
    -> runner.ts:1428 createProviderAdapter(HARNESS_PROVIDER)
    -> Poll loop gets task
    -> spawnProviderProcess() calls adapter.createSession(config)
      -> Claude: Bun.spawn("claude ..."), parse JSONL stdout
      -> Pi-mono: createAgentSession() in-process, subscribe events
      -> Codex (new): Bun.spawn("codex app-server"), JSON-RPC over stdio
    -> session.onEvent() streams logs + performs hook-equivalent checks
    -> session.waitForCompletion() returns cost + result
```

### Codex Adapter Architecture (Proposed)

```
CodexAdapter.createSession(config)
  1. Spawn `codex app-server --listen stdio://` via Bun.spawn()
  2. Send `initialize` request, wait for response
  3. Send `initialized` notification
  4. Send `account/login/start` with apiKey auth mode (must be before thread/start)
  5. If config.resumeSessionId: send `thread/resume` else `thread/start`
  6. Send `turn/start` with user prompt
  7. Return CodexSession

CodexSession
  - onEvent(): Parse JSONL notifications from stdout, map to ProviderEvent
  - waitForCompletion(): Wait for turn/completed notification
  - abort(): Send turn/interrupt
  - Hook equivalents: Inline in event handler
    - On item/started (tool): check cancellation, heartbeat, loop detection
    - On item/completed (fileChange): trigger memory auto-index
    - On turn/completed: session summarization
```

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — Initial research for adding pi-mono, includes provider comparison table mentioning Codex as future target
- `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — Deep dive into pi-mono architecture, lists Codex as future harness, mentions OpenAI/Codex env vars
- `thoughts/taras/plans/2026-03-08-pi-mono-provider-implementation.md` — Pi-mono implementation plan (template for Codex plan)
- GitHub issue #100 comments (Feb 27) — Bot's original research + Taras's feedback about App Server API + auth questions
- GitHub issue #100 comment (Mar 5) — Taras notes "#139 probably will cover this introducing pi adapter, so native codex might not be needed"

## Related Research

- `thoughts/taras/research/2026-03-11-codex-adapter-deep-reference.md` — **Codex adapter implementation reference** (config paths, AGENTS.md, MCP config, JSON-RPC protocol payloads, approval system, auth, process lifecycle, installation, gotchas)
- Codex TypeScript SDK analysis (concluded raw App Server is better; findings incorporated into deep reference doc Section 10)
- `thoughts/taras/research/2026-03-05-pi-mono-provider-research.md` — Pi-mono provider research (direct predecessor)
- `thoughts/taras/research/2026-03-08-pi-mono-deep-dive.md` — Pi-mono architecture deep dive

## Open Questions

1. **App Server lifecycle**: One long-lived `codex app-server` process per worker (multiple threads) or one per task? Long-lived is more efficient but adds complexity for cleanup.
2. **Auto-approval**: The `approval_policy = "never"` + `danger-full-access` sandbox should bypass all prompts, but issue #14068 suggests sandbox bypass may not work for tool child processes. Needs testing.
3. **Generated TypeScript types**: Should we use `codex app-server generate-ts` for type-safe JSON-RPC, or hand-write the subset we need? Generated types are version-pinned to the binary.
4. ~~**Strategic priority**~~: **Resolved** — Taras confirmed native Codex is desired. Different harnesses have different "vibes" and users familiar with Codex should have a native option.
5. **Cost tracking**: Does the App Server expose token/cost data in `turn/completed`? The bot's original research flagged this as uncertain.
6. **MCP transport reliability**: Should we default to SSE transport for Codex MCP instead of streamable HTTP given known issues?
7. **`turn/steer` for mid-task guidance**: This is a unique capability Codex has. Should the `ProviderSession` interface be extended with an optional `steer()` method?

## Sources

- [GitHub Issue #100](https://github.com/desplega-ai/agent-swarm/issues/100) — Original Codex support issue with bot research
- [Codex App Server Docs](https://developers.openai.com/codex/app-server/) — Official App Server API reference
- [Codex SDK Docs](https://developers.openai.com/codex/sdk/) — TypeScript SDK wrapping App Server
- [Codex Auth Docs](https://developers.openai.com/codex/auth/) — Authentication methods
- [Codex MCP Docs](https://developers.openai.com/codex/mcp/) — MCP integration configuration
- [Codex Config Reference](https://developers.openai.com/codex/config-reference/) — config.toml reference
- [Sandbox Bypass Issue #14068](https://github.com/openai/codex/issues/14068)
- [Approval RPC Gap Issue #14192](https://github.com/openai/codex/issues/14192)
- [MCP Streamable HTTP Issues #3324, #4707](https://github.com/openai/codex/issues/3324)

## Review Errata

_Reviewed: 2026-03-11 by Claude_

### Critical

- [x] **Open Question #4 is stale**: Resolved — Taras confirmed native Codex is desired.

### Important

- [x] **Section 8 wrong config field**: Fixed `sandbox` → `sandbox_mode`.
- [x] **Section 4 cost claim inaccurate**: Fixed — mapping table now says "token usage" not "cost data".
- [x] **Section 6 MCP config format wrong**: Fixed — now uses `bearer_token_env_var` + `env_http_headers`.
- [x] **Adapter architecture auth ordering**: Fixed — auth now step 4, before thread/start.
- [ ] **No fallback strategy**: If App Server has issues (6+ open MCP HTTP bugs), there's no documented fallback to `codex exec --json` as a simpler integration path. To be addressed in implementation plan.

### Resolved

- [x] ProviderSession line reference (49 → 50) — auto-fixed
- [x] Non-existent SDK deep-dive file reference — auto-fixed (reworded to inline note)
