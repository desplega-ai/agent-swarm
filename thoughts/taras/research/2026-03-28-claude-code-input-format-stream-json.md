---
date: 2026-03-28T12:00:00Z
topic: "Claude Code --input-format stream-json Protocol"
status: draft
---

# Research: Claude Code `--input-format stream-json` Protocol

**Date**: 2026-03-28
**Status**: Draft
**Sources**: Claude Code CLI help, `@anthropic-ai/claude-agent-sdk` v0.2.86 TypeScript types, `claude-agent-sdk-python` source, `The-Vibe-Company/companion` reverse-engineering, GitHub issue anthropics/claude-code#24594

## Executive Summary

`--input-format stream-json` enables **bidirectional NDJSON communication** with a Claude Code CLI session over stdin/stdout. It is the mechanism used by both the official TypeScript and Python Agent SDKs for programmatic multi-turn conversations, permission handling, session control, and more. **There is no official documentation** for the raw protocol (confirmed by [GitHub issue #24594](https://github.com/anthropics/claude-code/issues/24594)), but the protocol is fully defined in the SDK types.

---

## 1. Protocol: NDJSON (Newline-Delimited JSON)

The transport is **NDJSON**: one JSON object per line, terminated by `\n`.

```
{"type":"user","message":{"role":"user","content":"Hello"},"parent_tool_use_id":null,"session_id":""}\n
```

Each line is a complete, self-contained JSON object. No framing, no length prefix, no delimiters beyond newline.

---

## 2. CLI Flags

```bash
claude -p "" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  [--include-partial-messages] \
  [--replay-user-messages]
```

| Flag | Purpose |
|------|---------|
| `--input-format stream-json` | Accept NDJSON on stdin (choices: `text`, `stream-json`) |
| `--output-format stream-json` | Emit NDJSON on stdout (choices: `text`, `json`, `stream-json`) |
| `--verbose` | Include system events, tool progress, etc. in output |
| `--include-partial-messages` | Include partial/streaming assistant message chunks |
| `--replay-user-messages` | Echo user messages back on stdout for acknowledgment |
| `-p ""` | Start in print mode with empty initial prompt (required when using stream-json input) |

**Key**: When using `--input-format stream-json`, you pass `-p ""` (empty prompt) because the actual prompt is sent via stdin after initialization.

---

## 3. Message Types You Can Send (stdin -> CLI)

There are **three top-level message types** that can be sent to the CLI via stdin:

### 3.1 User Message (`type: "user"`)

The primary message type for sending prompts and follow-up messages.

```typescript
// From @anthropic-ai/claude-agent-sdk SDKUserMessage
type SDKUserMessage = {
  type: "user";
  message: MessageParam;           // Anthropic API MessageParam (role + content)
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  timestamp?: string;              // ISO timestamp
  uuid?: string;
  session_id?: string;
};
```

**Minimal example (text only)**:
```json
{"type":"user","message":{"role":"user","content":"What is 2+2?"},"parent_tool_use_id":null,"session_id":""}
```

**With images**:
```json
{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"...base64..."}},{"type":"text","text":"Describe this image"}]},"parent_tool_use_id":null,"session_id":""}
```

**`content` field**: Can be a plain string OR an array of content blocks (text, image, tool_result) matching the Anthropic API `MessageParam.content` format.

### 3.2 Control Request (`type: "control_request"`)

For session management, permission responses, interrupts, and more.

```typescript
type SDKControlRequest = {
  type: "control_request";
  request_id: string;          // Unique ID (UUID or incrementing counter)
  request: SDKControlRequestInner;
};
```

**Available subtypes** (the `request.subtype` field):

| Subtype | Purpose | Direction |
|---------|---------|-----------|
| `initialize` | Initialize session, configure hooks, agents, MCP servers | SDK -> CLI |
| `interrupt` | Stop the currently running turn | SDK -> CLI |
| `can_use_tool` | Permission request (CLI asks, SDK responds) | CLI -> SDK |
| `set_model` | Change model mid-session | SDK -> CLI |
| `set_permission_mode` | Change permission mode | SDK -> CLI |
| `set_max_thinking_tokens` | Set thinking budget | SDK -> CLI |
| `mcp_status` | Get MCP server status | SDK -> CLI |
| `mcp_set_servers` | Configure MCP servers | SDK -> CLI |
| `mcp_toggle` | Enable/disable an MCP server | SDK -> CLI |
| `mcp_reconnect` | Reconnect an MCP server | SDK -> CLI |
| `mcp_message` | Send JSON-RPC to an MCP server | SDK -> CLI |
| `end_session` | Gracefully end the session | SDK -> CLI |
| `stop_task` | Stop a running background task | SDK -> CLI |
| `get_context_usage` | Get current context window usage | SDK -> CLI |
| `rewind_files` | Undo file changes since a message | SDK -> CLI |
| `seed_read_state` | Seed file read cache | SDK -> CLI |
| `reload_plugins` | Reload plugins | SDK -> CLI |
| `get_settings` | Get current settings | SDK -> CLI |
| `generate_session_title` | Generate a title for the session | SDK -> CLI |
| `hook_callback` | Hook callback response (CLI asks, SDK responds) | CLI -> SDK |
| `elicitation` | Elicitation request from CLI | CLI -> SDK |

### 3.3 Control Response (`type: "control_response"`)

Sent **in response to** a `control_request` from the CLI (e.g., permission requests, hook callbacks).

```typescript
type SDKControlResponse = {
  type: "control_response";
  response: ControlResponse | ControlErrorResponse;
};

type ControlResponse = {
  subtype: "success";
  request_id: string;       // Must match the control_request's request_id
  response?: Record<string, unknown>;
};

type ControlErrorResponse = {
  subtype: "error";
  request_id: string;
  error: string;
};
```

**Permission allow example**:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"req_123","response":{"behavior":"allow","updatedInput":{}}}}
```

**Permission deny example**:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"req_123","response":{"behavior":"deny","message":"Denied by user"}}}
```

### 3.4 Update Environment Variables (`type: "update_environment_variables"`)

```json
{"type":"update_environment_variables","variables":{"FOO":"bar","BAZ":"qux"}}
```

---

## 4. Full Session Lifecycle

### Step 1: Start the CLI

```bash
claude -p "" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose
```

### Step 2: Send Initialize Control Request

The SDK always sends an `initialize` control request first:

```json
{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize","hooks":null}}
```

The CLI responds with a `control_response` containing available commands, models, output style, etc. (`SDKControlInitializeResponse`).

### Step 3: Send First User Message

```json
{"type":"user","message":{"role":"user","content":"Hello, world!"},"parent_tool_use_id":null,"session_id":""}
```

### Step 4: Read Streaming Output

The CLI emits NDJSON lines on stdout. Key output message types:

| Output Type | Description |
|-------------|-------------|
| `system` (subtype `init`) | Session ID, tools, model, etc. |
| `system` (subtype `status`) | Compacting status |
| `system` (subtype `compact_boundary`) | Context compaction happened |
| `assistant` | Full assistant message with content blocks |
| `result` | Turn complete with cost, usage, duration |
| `control_request` (subtype `can_use_tool`) | Permission request from CLI |
| `control_request` (subtype `hook_callback`) | Hook callback from CLI |
| `control_cancel_request` | Cancels a pending permission request |
| `tool_progress` | Tool execution progress |
| `tool_use_summary` | Summary of tool uses |
| `stream_event` | Raw API stream events (partial tokens) |
| `keep_alive` | Heartbeat |
| `auth_status` | Authentication status |
| `rate_limit_event` | Rate limit info |

### Step 5: Handle Permission Requests (if not using `--dangerously-skip-permissions`)

When the CLI needs permission to use a tool, it sends:
```json
{"type":"control_request","request_id":"perm_abc","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"tu_123"}}
```

You respond with:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"perm_abc","response":{"behavior":"allow","updatedInput":{"command":"ls"}}}}
```

### Step 6: Send Follow-up Messages

Yes, you **can** send multiple user messages to create a multi-turn conversation:

```json
{"type":"user","message":{"role":"user","content":"Now do X"},"parent_tool_use_id":null,"session_id":""}
```

Wait for a `result` message before sending the next turn (the CLI processes one turn at a time).

### Step 7: Signal End of Input

**Close stdin** (EOF). The CLI will finish any in-progress work and exit. In code:
- Python: `process.stdin.close()` or `await stdin_stream.aclose()`
- Node/Bun: `process.stdin.end()`
- Shell: The pipe naturally closes when the writer exits

Alternatively, send an `end_session` control request for a graceful shutdown:
```json
{"type":"control_request","request_id":"req_end","request":{"subtype":"end_session"}}
```

---

## 5. Multi-Turn Conversation Pattern

From the Python SDK's `streaming_mode.py` example:

```python
async with ClaudeSDKClient() as client:
    # First turn
    await client.query("What's the capital of France?")
    async for msg in client.receive_response():
        handle(msg)

    # Second turn (follow-up, same session, full context)
    await client.query("What's the population of that city?")
    async for msg in client.receive_response():
        handle(msg)
```

Under the hood, each `query()` sends a `{"type":"user",...}` NDJSON line to stdin. The session maintains full conversation context between turns.

You can also send an `AsyncIterable` of user messages for queuing:

```python
async def message_stream():
    yield {"type":"user","message":{"role":"user","content":"Question 1"},"parent_tool_use_id":None,"session_id":""}
    yield {"type":"user","message":{"role":"user","content":"Question 2"},"parent_tool_use_id":None,"session_id":""}

await client.query(message_stream())
```

---

## 6. Interrupt

To interrupt a running turn:

```json
{"type":"control_request","request_id":"int_1","request":{"subtype":"interrupt"}}
```

The CLI will stop the current turn. You can then send a new user message.

---

## 7. What Agent Swarm Currently Uses

Agent Swarm's `claude-adapter.ts` uses `--output-format stream-json` but does **not** use `--input-format stream-json`. It passes the prompt via `-p <prompt>` as a one-shot command. Each task spawns a new CLI process with no multi-turn capability via stdin.

Relevant files:
- `/Users/taras/Documents/code/agent-swarm/src/providers/claude-adapter.ts` (line 224-254: `buildCommand()`)
- `/Users/taras/Documents/code/agent-swarm/src/claude.ts` (line 12-18: legacy headless path)

---

## 8. Documentation Gap

As of 2026-03-28, there is **no official Anthropic documentation** for the raw `--input-format stream-json` protocol. The information above was assembled from:

1. The TypeScript SDK types (`@anthropic-ai/claude-agent-sdk` v0.2.86 `sdk.d.ts`)
2. The Python SDK source (`claude-agent-sdk-python`, `query.py`, `subprocess_cli.py`, `streaming_mode.py`)
3. The Vibe Companion reverse-engineering (`claude-adapter.ts`, `session-types.ts`)
4. [GitHub issue #24594](https://github.com/anthropics/claude-code/issues/24594)

The SDKs are the authoritative source since they are maintained by Anthropic and directly spawn the CLI with these flags.

---

## 9. Quick Reference: Minimal Bidirectional Session

```bash
#!/bin/bash
# Start Claude with bidirectional streaming
claude -p "" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --allow-dangerously-skip-permissions &

CLI_PID=$!

# Initialize (optional but recommended - matches SDK behavior)
echo '{"type":"control_request","request_id":"init_1","request":{"subtype":"initialize","hooks":null}}' >&0

# Send first message
echo '{"type":"user","message":{"role":"user","content":"Say hello"},"parent_tool_use_id":null,"session_id":""}' >&0

# Read output lines (each is a JSON object)
# Wait for {"type":"result",...} to know the turn is complete

# Send follow-up
echo '{"type":"user","message":{"role":"user","content":"Now say goodbye"},"parent_tool_use_id":null,"session_id":""}' >&0

# Close stdin to signal done
exec 0>&-
wait $CLI_PID
```

---

## 10. Key Takeaways

1. **Protocol is NDJSON** -- one JSON object per line on stdin and stdout
2. **Three input message types**: `user`, `control_request`, `control_response` (plus `update_environment_variables`)
3. **Yes, you can send follow-up messages** -- each `{"type":"user",...}` line is a new turn in the same session
4. **End of input = close stdin** (EOF) or send `end_session` control request
5. **Initialize first** -- the SDK always sends a `control_request` with `subtype: "initialize"` before any user message
6. **Permission flow is bidirectional** -- CLI sends `control_request` with `can_use_tool`, you respond with `control_response`
7. **`MessageParam` is the Anthropic API format** -- `{role: "user", content: string | ContentBlock[]}`
