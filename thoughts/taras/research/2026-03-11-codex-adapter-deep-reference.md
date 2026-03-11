---
date: 2026-03-11T14:00:00-07:00
researcher: Claude
git_commit: 593fd82
branch: feat/codex-support
repository: agent-swarm
topic: "Codex App Server adapter implementation reference"
tags: [research, codex, app-server, adapter, json-rpc, mcp, config]
status: complete
autonomy: autopilot
last_updated: 2026-03-11
last_updated_by: Claude
---

# Codex Adapter Deep Reference

Concrete implementation details for building a Codex `ProviderAdapter`. Everything a developer needs to know to write `codex-adapter.ts`.

## 1. Config File Paths

| Path | Purpose |
|------|---------|
| `~/.codex/config.toml` | Global config |
| `.codex/config.toml` | Project config (trusted dirs only) |
| `~/.codex/auth.json` | Auth credentials |
| `~/.codex/sessions/` | Thread persistence |
| `$CODEX_HOME/` | Override for `~/.codex/` |

Project config merges over global. CLI `--config key=value` overrides both.

### Key config.toml fields

```toml
model = "o3"                        # Default model
model_provider = "openai"           # Provider (openai, azure, custom)
approval_policy = "never"           # "on-request" | "untrusted" | "never"
sandbox_mode = "danger-full-access" # "read-only" | "workspace-write" | "danger-full-access"
personality = ""                    # Model personality string

# Instructions
developer_instructions = "You are a swarm worker agent..."
model_instructions_file = "./custom-instructions.md"
project_doc_fallback_filenames = ["AGENTS.md", "CLAUDE.md", "COPILOT.md"]

# History
[history]
persistence = "none"                # "none" | "local" | "remote"
max_entries = 500

# Model providers (custom endpoints)
[model_providers.custom]
base_url = "https://api.example.com/v1"
api_key_env_var = "CUSTOM_API_KEY"
```

Ref: [Config Reference](https://developers.openai.com/codex/config-reference/), [Config Basics](https://developers.openai.com/codex/config-basic/)

## 2. Instructions System (AGENTS.md)

### File discovery order (per directory, root to CWD)

1. `AGENTS.override.md` — highest priority, not checked into git
2. `AGENTS.md` — standard project instructions
3. Fallback filenames from `project_doc_fallback_filenames` config

Combined content across all directories capped at **32 KiB**.

### Three instruction layers

| Layer | Source | Role in prompt |
|-------|--------|---------------|
| System | Built-in Codex prompt | system message |
| Developer | `developer_instructions` config field | developer message |
| AGENTS.md | File on disk | user-role context |

### Programmatic injection via App Server

```jsonc
// In thread/start params -> settings
{
  "id": 1,
  "method": "thread/start",
  "params": {
    "settings": {
      "developer_instructions": "You are agent-swarm worker ID abc-123...",
      "model": "o3"
    }
  }
}
```

**For our adapter**: Use `developer_instructions` in `thread/start` for the system prompt (equivalent to Claude's `--append-system-prompt`). Also symlink `AGENTS.md -> CLAUDE.md` like pi-mono does.

Ref: [AGENTS.md Guide](https://developers.openai.com/codex/guides/agents-md/)

## 3. MCP Server Configuration

### config.toml format

**Stdio transport:**
```toml
[mcp_servers.my-server]
command = "node"
args = ["server.js"]
env = { API_KEY = "secret" }
cwd = "/path/to/server"
```

**HTTP transport:**
```toml
[mcp_servers.agent-swarm]
type = "http"
url = "http://host.docker.internal:3013/mcp"
bearer_token_env_var = "API_KEY"          # Reads env var, sends as Bearer token
# OR explicit headers:
http_headers = { "X-Custom" = "value" }
env_http_headers = { "Authorization" = "API_KEY" }  # Header value from env var
```

### Tool naming scheme

Tools prefixed as `mcp__{server_name}__{tool_name}`. Names sanitized to `[a-zA-Z0-9_-]`, max 64 chars total. If exceeded, uses SHA-1 hash truncation.

### Allow/deny lists

```toml
[mcp_servers.agent-swarm]
url = "..."
enabled_tools = ["join-swarm", "my-agent-info", "get-task"]  # allowlist
# OR
disabled_tools = ["dangerous-tool"]  # denylist
```

### Runtime MCP changes

**Not supported.** MCP servers loaded from config.toml at thread/session start. Cannot add/remove via App Server protocol at runtime.

### Known HTTP transport issues

6+ open issues: [#4707](https://github.com/openai/codex/issues/4707), [#5208](https://github.com/openai/codex/issues/5208), [#5619](https://github.com/openai/codex/issues/5619), [#6540](https://github.com/openai/codex/issues/6540), [#11284](https://github.com/openai/codex/issues/11284), [#12869](https://github.com/openai/codex/issues/12869), [#13138](https://github.com/openai/codex/issues/13138)

**Mitigation**: Test thoroughly. SSE transport may be more reliable as fallback if available.

Ref: [MCP Docs](https://developers.openai.com/codex/mcp/), [Config Reference](https://developers.openai.com/codex/config-reference/)

## 4. Approval/Permissions System

### approval_policy values

| Value | Behavior |
|-------|----------|
| `"on-request"` | Model decides when to ask (default) |
| `"untrusted"` | Only safe read-only commands auto-run |
| `"never"` | Never prompt for approval — **use this for autonomous agents** |
| `{ reject = { ... } }` | Granular: reject specific tools/patterns |

### sandbox_mode values

| Value | Allows |
|-------|--------|
| `"read-only"` | Read filesystem, no writes, no network |
| `"workspace-write"` | Read/write within project dir |
| `"danger-full-access"` | Full system access — **use this for autonomous agents** |

**GOTCHA**: TOML uses kebab-case (`danger-full-access`), App Server API uses camelCase (`dangerFullAccess`).

### CLI flag mapping

| Flag | Equivalent config |
|------|------------------|
| `--full-auto` | `sandbox_mode = "workspace-write"` + `approval_policy = "on-request"` |
| `--yolo` / `--dangerously-bypass-approvals-and-sandbox` | `sandbox_mode = "danger-full-access"` + `approval_policy = "never"` |

### App Server approval handling

Approvals arrive as **server-initiated JSON-RPC requests** (with `id` field — they expect a response):

```jsonc
// Server -> Client (approval request)
{
  "id": "approval-123",
  "method": "requestApproval",
  "params": {
    "tool_name": "Bash",
    "command": "rm -rf /tmp/test",
    "working_directory": "/workspace"
  }
}

// Client -> Server (auto-approve response)
{
  "id": "approval-123",
  "result": {
    "decision": "accept"  // "accept" | "decline" | "cancel"
  }
}
```

**For our adapter**: Set `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` in config, AND implement a fallback handler that auto-accepts any `requestApproval` messages (belt and suspenders).

Ref: [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing/), [Security](https://developers.openai.com/codex/security/)

## 5. App Server JSON-RPC Protocol

### Protocol format: "JSON-RPC lite"

Same as JSON-RPC 2.0 but **omits the `"jsonrpc":"2.0"` field**. JSONL framed over stdio (one JSON object per line).

### Handshake sequence

```jsonc
// 1. Client -> Server: initialize
{"id": 1, "method": "initialize", "params": {"capabilities": {}}}

// 2. Server -> Client: initialize response
{"id": 1, "result": {"protocolVersion": "codex-app-server/0.1", "capabilities": {...}, "serverInfo": {...}}}

// 3. Client -> Server: initialized notification (no id = notification)
{"method": "initialized"}
```

### Authentication (after handshake)

```jsonc
// 4. Client -> Server: login with API key
{"id": 2, "method": "account/login/start", "params": {"type": "apiKey", "apiKey": "sk-..."}}

// 5. Server -> Client: login response
{"id": 2, "result": {}}

// 6. Server -> Client: account updated notification
{"method": "account/updated", "params": {"account": {"email": "...", "status": "active"}}}
```

### Thread lifecycle

```jsonc
// Start new thread
{"id": 3, "method": "thread/start", "params": {
  "settings": {
    "model": "o3",
    "developer_instructions": "You are a swarm worker...",
    "approval_policy": "never",
    "sandbox_permissions": "dangerFullAccess"
  }
}}

// Server notification: thread started
{"method": "thread/started", "params": {"threadId": "thread_abc123"}}

// Resume existing thread
{"id": 3, "method": "thread/resume", "params": {"threadId": "thread_abc123"}}

// List threads
{"id": 4, "method": "thread/list"}

// Compact context
{"id": 5, "method": "thread/compact/start", "params": {"threadId": "thread_abc123"}}

// Fork thread (branch history)
{"id": 6, "method": "thread/fork", "params": {"threadId": "thread_abc123"}}

// Rollback (undo turns)
{"id": 7, "method": "thread/rollback", "params": {"threadId": "thread_abc123", "count": 1}}
```

### Turn lifecycle

```jsonc
// Start turn (submit work)
{"id": 10, "method": "turn/start", "params": {
  "input": [{"type": "text", "text": "Fix the failing test in src/utils.ts"}]
}}

// Server notification: turn started
{"method": "turn/started", "params": {"turnId": "turn_xyz"}}

// Mid-turn steering (inject guidance without new turn)
{"id": 11, "method": "turn/steer", "params": {
  "input": [{"type": "text", "text": "Focus on the null check, not the type error"}]
}}

// Cancel turn
{"id": 12, "method": "turn/interrupt"}

// Server notification: turn completed
{"method": "turn/completed", "params": {
  "turnId": "turn_xyz",
  "status": "completed",  // "completed" | "interrupted" | "failed"
  "usage": {
    "input_tokens": 5432,
    "cached_input_tokens": 1200,
    "output_tokens": 890
  }
}}
```

**Note**: `turn/completed` includes `usage` with token counts but **no cost field**. Cost must be calculated from tokens + model pricing.

### Item notifications (event stream)

```jsonc
// Item started
{"method": "item/started", "params": {
  "itemId": "item_001",
  "type": "commandExecution",  // see item types below
  "data": {"command": "bun test src/utils.test.ts"}
}}

// Item delta (streaming content)
{"method": "item/agentMessage/delta", "params": {
  "itemId": "item_002",
  "delta": {"text": "I'll fix the "}
}}

// Item completed
{"method": "item/completed", "params": {
  "itemId": "item_001",
  "type": "commandExecution",
  "data": {"command": "bun test", "exitCode": 0, "stdout": "...", "stderr": "..."}
}}
```

### Item types

| Type | Description | Maps to ProviderEvent |
|------|-------------|----------------------|
| `userMessage` | User input | (internal) |
| `agentMessage` | Model text response | `message` |
| `plan` | Planning step | `raw_log` |
| `reasoning` | Chain-of-thought | `raw_log` |
| `commandExecution` | Shell command | `tool_start` / `tool_end` |
| `fileChange` | File write/edit | `tool_start` / `tool_end` |
| `mcpToolCall` | MCP tool invocation | `tool_start` / `tool_end` |
| `dynamicToolCall` | Dynamic tool | `tool_start` / `tool_end` |

### Error responses

```jsonc
{"id": 3, "error": {"code": -32600, "message": "Invalid request"}}
{"id": 3, "error": {"code": -32601, "message": "Method not found"}}
{"id": 3, "error": {"code": -32000, "message": "Thread not found"}}
```

Ref: [App Server Docs](https://developers.openai.com/codex/app-server/), [GitHub README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## 6. Process Lifecycle

### Spawning

```typescript
const proc = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: {
    ...process.env,
    OPENAI_API_KEY: config.auth.key,
  },
  cwd: config.cwd,
});
```

### Signal handling

As of [PR #13594](https://github.com/openai/codex/pull/13594) (March 5, 2026): SIGTERM = SIGINT (graceful shutdown). The process:
1. Interrupts any in-flight turn
2. Saves thread state
3. Exits cleanly

### Graceful shutdown sequence

```
1. Send turn/interrupt (if turn in progress)
2. Wait for turn/completed notification
3. Close stdin pipe
4. Wait for process exit (with timeout)
5. SIGTERM if timeout exceeded
```

### Thread multiplexing

One `codex app-server` process can handle multiple threads sequentially. For our adapter, two options:

- **One process per task** (simpler): Spawn app-server, run one thread, kill process
- **Long-lived process** (efficient): Keep app-server running, create new threads per task

Recommendation: Start with one-per-task for simplicity, optimize later.

### Thread persistence

Threads stored in `~/.codex/sessions/`. Set `[history] persistence = "none"` for ephemeral workers, or `"local"` to enable resume.

## 7. Authentication

### API key (recommended for Docker workers)

Three options, in order of preference:

**Option A: App Server RPC (cleanest)**
```jsonc
{"id": 2, "method": "account/login/start", "params": {"type": "apiKey", "apiKey": "sk-..."}}
```

**Option B: Environment variable**
```bash
OPENAI_API_KEY=sk-... codex app-server --listen stdio://
```
May auto-auth without explicit RPC call.

**Option C: Pre-login in entrypoint**
```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```
Stores in `~/.codex/auth.json`.

### Cost model

API key auth = **pay-per-token** at standard OpenAI API rates. No subscription credits.

Ref: [Authentication](https://developers.openai.com/codex/auth/), [CI/CD Auth](https://developers.openai.com/codex/auth/ci-cd-auth)

## 8. CLI Installation

### npm (recommended for Docker)

```bash
npm install -g @openai/codex@0.111.0  # Pin version
```

Binary installed as `codex` in npm bin path. Requires Node.js 18+ for install (binary itself is native Rust).

### Homebrew (macOS)

```bash
brew install --cask codex
```

### Docker snippet

```dockerfile
# Install Codex CLI (pin version for reproducibility)
RUN npm install -g @openai/codex@0.111.0
```

Ref: [npm @openai/codex](https://www.npmjs.com/package/@openai/codex)

## 9. Critical Gotchas for Adapter Implementation

| Gotcha | Detail | Impact |
|--------|--------|--------|
| **JSON-RPC lite** | No `"jsonrpc":"2.0"` field in messages | JSON-RPC client must omit it |
| **TOML vs API casing** | Config: `danger-full-access`, API: `dangerFullAccess` | Use correct casing per context |
| **AGENTS.md not CLAUDE.md** | Codex reads AGENTS.md | Symlink like pi-mono does |
| **No cost in usage** | Only token counts in `turn/completed` | Calculate cost from tokens + model pricing |
| **Tool name prefix** | `mcp__agent-swarm__join-swarm` not `join-swarm` | Adjust hook-equivalent tool name checks |
| **64-char tool name limit** | Long names get SHA-1 hash truncation | May affect tool matching logic |
| **`codex exec --json` vs App Server** | exec uses `snake_case` (`agent_message`), App Server uses `camelCase` (`agentMessage`) | Use App Server casing |
| **Approval requests need response** | Server-initiated requests with `id` expect `result` back | Must implement response handler |
| **MCP loaded at start only** | No runtime add/remove | Config must be written before spawning |
| **32 KiB AGENTS.md limit** | Combined content across all directories | Keep instructions concise |

## 10. SDK Decision: Raw App Server > @openai/codex-sdk

The TypeScript SDK (`@openai/codex-sdk` v0.112.0) was evaluated and rejected for our adapter:

- **Missing `turn/interrupt`** — no abort capability ([Issue #5494](https://github.com/openai/codex/issues/5494))
- **Missing `turn/steer`** — no mid-turn guidance ([Issue #12329](https://github.com/openai/codex/issues/12329))
- **Node.js 18+ requirement** — we run on Bun
- **Less control** — abstracts away process lifecycle
- **Fewer event types** — 7 vs full notification stream

OpenAI's own guidance: "Codex App Server will be the first-class integration method maintained moving forward."

## 11. Docker Entrypoint Template

```bash
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Error: OPENAI_API_KEY required for codex provider"
        exit 1
    fi

    # Write Codex config
    mkdir -p /home/worker/.codex
    cat > /home/worker/.codex/config.toml <<TOML
model = "${MODEL:-o3}"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[history]
persistence = "none"

[mcp_servers.agent-swarm]
type = "http"
url = "${MCP_BASE_URL}/mcp"
bearer_token_env_var = "API_KEY"
TOML

    # Symlink AGENTS.md -> CLAUDE.md if CLAUDE.md exists
    if [ -f "/workspace/CLAUDE.md" ] && [ ! -f "/workspace/AGENTS.md" ]; then
        ln -sf CLAUDE.md /workspace/AGENTS.md
    fi
fi
```

## Sources

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [GitHub: app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Config Reference](https://developers.openai.com/codex/config-reference/)
- [Config Basics](https://developers.openai.com/codex/config-basic/)
- [Advanced Configuration](https://developers.openai.com/codex/config-advanced/)
- [MCP Docs](https://developers.openai.com/codex/mcp/)
- [Authentication](https://developers.openai.com/codex/auth/)
- [CI/CD Auth](https://developers.openai.com/codex/auth/ci-cd-auth)
- [AGENTS.md Guide](https://developers.openai.com/codex/guides/agents-md/)
- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing/)
- [CLI Reference](https://developers.openai.com/codex/cli/reference)
- [npm: @openai/codex](https://www.npmjs.com/package/@openai/codex)
- [npm: @openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk)
- [SIGTERM PR #13594](https://github.com/openai/codex/pull/13594)
- [MCP HTTP issues](https://github.com/openai/codex/issues/4707)
- [Sandbox bypass #14068](https://github.com/openai/codex/issues/14068)
- [SDK abort #5494](https://github.com/openai/codex/issues/5494)
- [SDK steer #12329](https://github.com/openai/codex/issues/12329)

## Review Errata

_Reviewed: 2026-03-11 by Claude_

### Important

- [ ] **Docker entrypoint missing X-Agent-ID header**: Section 11 template only has `bearer_token_env_var = "API_KEY"` for auth. Missing the swarm-required `X-Agent-ID` header. Add: `env_http_headers = { "X-Agent-ID" = "AGENT_ID" }` under `[mcp_servers.agent-swarm]` and ensure `AGENT_ID` env var is set in the container.
- [ ] **AGENTS.md symlink may be unnecessary**: Section 1 documents `project_doc_fallback_filenames = ["AGENTS.md", "CLAUDE.md", "COPILOT.md"]` as a config option. If Codex is configured with this fallback list (which appears to be the default), it will read `CLAUDE.md` directly without needing the symlink. This simplification should be verified and called out — it's cleaner than the pi-mono approach.
- [ ] **No fallback strategy documented**: If the App Server approach hits issues (6+ open MCP HTTP bugs, approval RPC gap), `codex exec --json` could serve as a simpler but less capable fallback. Worth documenting as Plan B.
- [ ] **Missing github_issue in frontmatter**: Add `github_issue: https://github.com/desplega-ai/agent-swarm/issues/100` for traceability.

### Resolved

- (no minor auto-fixes needed)
