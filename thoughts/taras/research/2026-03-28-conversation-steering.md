---
date: 2026-03-28T14:45:00Z
researcher: Claude
git_commit: bee85bc
branch: main
repository: agent-swarm
topic: "Conversation Steering in the Agent Swarm"
tags: [research, providers, claude-adapter, pi-mono, stream-json, multi-turn, steering]
status: complete
autonomy: verbose
last_updated: 2026-03-28
last_updated_by: Claude
---

# Research: Conversation Steering in the Agent Swarm

**Date**: 2026-03-28
**Researcher**: Claude
**Git Commit**: bee85bc
**Branch**: main

## Research Question

How can the agent swarm send follow-up user messages to already-running provider sessions? Pi-mono already supports this via `steer()`/`followUp()`. Claude Code supports it via `--input-format stream-json`. What does each provider support, how do they compare, and what changes are needed in the runner/adapter layer?

## Summary

Both providers support multi-turn conversation steering, but through different mechanisms. **Pi-mono** has an explicit, programmatic API with three delivery modes: `steer()` (interrupt mid-tool), `followUp()` (queue for after completion), and `prompt()` with `streamingBehavior` option. **Claude Code** supports the equivalent via `--input-format stream-json`, where user messages sent to stdin during processing are queued and delivered between tool calls, and a `control_request` with `subtype: "interrupt"` can stop the current turn entirely. Agent Swarm currently uses **neither** — both adapters run in single-turn, fire-and-forget mode. The runner spawns a process, waits for completion, and has no mechanism to inject messages mid-session.

The key changes needed are: (1) add `stdin: "pipe"` to the Claude spawn config + switch to `--input-format stream-json` mode, (2) add a `sendMessage()` method to the `ProviderSession` interface, (3) implement the delivery logic in each adapter, and (4) add a runner-side mechanism to poll for and deliver pending steering messages.

## Detailed Findings

### 1. Pi-Mono Conversation Steering API

Pi-mono's `AgentSession` (from `@mariozechner/pi-coding-agent`) provides a rich multi-turn API:

#### 1.1 `prompt(text, options?)` — Primary Entry Point (`agent-session.d.ts:279`)

```typescript
prompt(text: string, options?: PromptOptions): Promise<void>;
```

`PromptOptions` includes:
- `streamingBehavior?: "steer" | "followUp"` — **required** if the session is currently streaming
- `images?: ImageContent[]`
- `source?: "interactive" | "rpc" | "extension"`

Behavior:
- **Not streaming**: sends directly to the underlying `Agent.prompt()`
- **Streaming**: routes to `steer()` or `followUp()` based on `streamingBehavior`. Throws if `streamingBehavior` is not specified while streaming.

#### 1.2 `steer(text)` — Mid-Stream Interruption (`agent-session.d.ts:294`)

```typescript
steer(text: string, images?: ImageContent[]): Promise<void>;
```

- Delivered **after current tool execution completes**, skips remaining queued tool calls
- Queued in `Agent.steeringQueue`; the agent loop calls `getSteeringMessages()` after each tool execution
- If messages found: remaining tool calls skipped, messages injected into context, next LLM call starts

#### 1.3 `followUp(text)` — Post-Completion Queue (`agent-session.d.ts:302`)

```typescript
followUp(text: string, images?: ImageContent[]): Promise<void>;
```

- Delivered **after the agent finishes its current run** (no more tool calls AND no steering messages)
- Queued in `Agent.followUpQueue`; the loop calls `getFollowUpMessages()` when it would otherwise stop
- If messages found: injected into context and the loop continues

#### 1.4 `sendUserMessage(content, options?)` — Programmatic User Message (`agent-session.d.ts:332`)

```typescript
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp";
}): Promise<void>;
```

Always triggers a turn. When streaming, uses `deliverAs` to determine queuing. Exposed to extensions via `pi.sendUserMessage()`.

#### 1.5 Queue Management

- `steeringMode` / `followUpMode`: `"all"` (send all at once) or `"one-at-a-time"` (`agent-session.d.ts:246-248`)
- `clearQueue()`: clears all queued messages, returns them
- `pendingMessageCount`: total pending (steering + follow-up)
- `getSteeringMessages()` / `getFollowUpMessages()`: read-only views

#### 1.6 RPC Mode — External Multi-Turn Protocol (`rpc-types.d.ts`)

Pi-mono's RPC mode provides a headless JSON-lines protocol with three command types mapping 1:1 to session methods:
- `prompt` — with optional `streamingBehavior: "steer" | "followUp"`
- `steer` — direct steering message
- `follow_up` — direct follow-up message

#### 1.7 Current Agent Swarm Usage

Agent Swarm uses `AgentSession` in **single-turn mode only** (`pi-mono-adapter.ts`):
- Creates session at line 514 via `createAgentSession()`
- Calls `session.prompt()` exactly once at line 285 with `{ source: "rpc" }`
- Waits for idle via `agent_end` event subscription (lines 327-343)
- Calls `session.dispose()` after completion, `session.abort()` for cancellation
- **Does NOT use**: `steer()`, `followUp()`, `sendUserMessage()`, or `sendCustomMessage()`

---

### 2. Claude Code Stream-JSON Protocol

Claude Code supports bidirectional NDJSON communication via `--input-format stream-json`. Full details in the companion research doc: `thoughts/taras/research/2026-03-28-claude-code-input-format-stream-json.md`.

#### 2.1 CLI Flags

```bash
claude -p "" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  [--replay-user-messages] \
  [--include-partial-messages]
```

Key: `-p ""` (empty prompt) because the actual prompt is sent via stdin after initialization.

#### 2.2 Input Message Types (stdin -> CLI)

Three primary message types can be sent via stdin as NDJSON (one JSON object per line):

**User Message** (`type: "user"`):
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Do X"}]},"parent_tool_use_id":null,"session_id":""}
```

**Control Request** (`type: "control_request"`):
```json
{"type":"control_request","request_id":"int_1","request":{"subtype":"interrupt"}}
```

**Control Response** (`type: "control_response"`) — for permission/hook callbacks:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"perm_abc","response":{"behavior":"allow"}}}
```

#### 2.3 Interrupt — The "Steer" Equivalent

```json
{"type":"control_request","request_id":"int_1","request":{"subtype":"interrupt"}}
```

Stops the current turn. You can then send a new user message. This is analogous to pi-mono's `steer()` but more coarse-grained: it stops the entire turn rather than waiting for the current tool to complete.

#### 2.4 Multi-Turn — Experimentally Verified

Tested with FIFO pipe — sending two sequential user messages:

```
Message 1: "What is 2+2?" → Response: "4"
Message 2: "Multiply that by 3" → Response: "12"
```

Same session ID, full conversation context maintained, `turns=1` per message (each is its own turn cycle).

#### 2.5 Mid-Stream Injection — Experimentally Verified

Sent a follow-up message **while Claude was still processing** a tool call:

```
Message 1: "List the files using Bash tool" → Claude starts tool use
Message 2 (mid-stream): "Actually, stop. Just say done." → Claude processes it
Response: "Done." (turns=2)
```

Claude queued the second user message and delivered it between turns, effectively steering the conversation. This is analogous to pi-mono's `steer()` behavior.

#### 2.6 End of Input

- **Close stdin** (EOF): CLI finishes in-progress work and exits
- **`end_session` control request**: Graceful shutdown
  ```json
  {"type":"control_request","request_id":"req_end","request":{"subtype":"end_session"}}
  ```

#### 2.7 Full Lifecycle (from SDK)

1. Start CLI with `--input-format stream-json --output-format stream-json`
2. Send `initialize` control request (optional but SDK does it)
3. Send user message(s) via stdin
4. Read streaming NDJSON output on stdout
5. Handle `control_request` from CLI (permissions, hooks) by sending `control_response`
6. Close stdin or send `end_session` when done

#### 2.8 Current Agent Swarm Usage

Agent Swarm's `ClaudeSession` (`claude-adapter.ts`) currently:
- Passes prompt via `-p <prompt>` as a one-shot command (line 224-254: `buildCommand()`)
- Uses `--output-format stream-json` but **NOT** `--input-format stream-json`
- Spawns with `Bun.spawn()` at line 211 **without `stdin: "pipe"`** — no writable stdin handle
- Has no mechanism to write to the running process

---

### 3. Runner Integration Points

The runner (`src/commands/runner.ts`) manages provider sessions in a polling loop:

#### 3.1 ProviderSession Interface (`types.ts:63-68`)

```typescript
export interface ProviderSession {
  readonly sessionId: string | undefined;
  onEvent(listener: (event: ProviderEvent) => void): void;
  waitForCompletion(): Promise<ProviderResult>;
  abort(): Promise<void>;
}
```

**No `sendMessage()` method** — the interface is purely observational plus a kill switch.

#### 3.2 Session Lifecycle in Runner

1. Runner polls for trigger → `pollForTrigger()` (line 2806)
2. Prompt built → `buildPromptForTrigger()` (line 2839)
3. Session created → `spawnProviderProcess()` → `adapter.createSession()` (line 1574)
4. Event listeners registered → `session.onEvent()` (line 1635)
5. Completion promise stored → `session.waitForCompletion()` (line 1803)
6. `RunningTask` with session ref → `state.activeTasks.set()` (line 3082)
7. Each iteration: `checkCompletedProcesses()` checks `task.result !== null`
8. Cancellation: polls API for cancelled tasks → `session.abort()` (line 2787)

#### 3.3 Task File Sidecar — Existing Out-of-Band Communication

The task file at `/tmp/agent-swarm-task-{pid}.json` is the current bridge between runner and hooks:
- Runner writes it at session creation with `{ taskId, agentId, startedAt }`
- Hooks read it via `readTaskFile()` using `TASK_FILE` env var
- This pattern could be extended for steering messages, but stdin is more direct

#### 3.4 Active Sessions Tracking (`http/active-sessions.ts`)

Already tracks which agent is running which task with which `runnerSessionId`. This provides the lookup infrastructure needed to route a steering message to the correct running session.

---

### 4. Comparison: Pi-Mono vs Claude Code Steering

| Capability | Pi-Mono | Claude Code (stream-json) |
|---|---|---|
| **Send follow-up after turn** | `prompt()` or `followUp()` | Send `{"type":"user",...}` after `result` event |
| **Interrupt mid-tool** | `steer()` — waits for current tool, skips remaining | `interrupt` control request — stops current turn entirely |
| **Queue for after completion** | `followUp()` — explicit queue | Send user message mid-stream — queued between turns |
| **Message priority** | `steeringMode` / `followUpMode` (all vs one-at-a-time) | No built-in priority — messages processed FIFO |
| **Programmatic message types** | `sendUserMessage()`, `sendCustomMessage()` | Only user messages and control requests |
| **Queue inspection** | `getSteeringMessages()`, `getFollowUpMessages()`, `pendingMessageCount` | No queue inspection — fire and forget |
| **Clear pending** | `clearQueue()` | No equivalent (can `interrupt` then start fresh) |
| **End session** | `session.dispose()` | Close stdin or `end_session` control request |
| **Kill session** | `session.abort()` | `SIGTERM` on process |
| **Multi-turn context** | Maintained via `SessionManager` (JSONL tree) | Maintained by CLI process (in-memory) |
| **Session resume** | `SessionManager.open(path)` / `continueRecent()` | `--resume` flag on new process spawn |

### 5. Known Bugs and Risks with `--input-format stream-json`

| Issue | Description | Impact |
|---|---|---|
| [#3187](https://github.com/anthropics/claude-code/issues/3187) | Hangs when sending a second user message | Multi-turn reliability — need timeout/watchdog logic |
| [#25629](https://github.com/anthropics/claude-code/issues/25629) | CLI hangs indefinitely after `result` event | Must watch for `result` and be prepared to kill process |
| [#5034](https://github.com/anthropics/claude-code/issues/5034) | Duplicate entries in session `.jsonl` files | May affect `--resume` reliability |
| [#25670](https://github.com/anthropics/claude-code/issues/25670) | stdout flush issues when piped | Could cause delayed/lost events |
| [#16712](https://github.com/anthropics/claude-code/issues/16712) | Resuming with pending `tool_use` injects synthetic message | Breaks tool result chain on session resume |

Our local experiments worked cleanly, but these issues suggest edge cases at scale. The runner should include timeouts and health checks.

---

### 6. External References

#### 6.1 The-Vibe-Company/companion

Open-source Web/Mobile UI for Claude Code. **Uses hidden `--sdk-url ws://` WebSocket flag** (not `--input-format stream-json`), but the NDJSON message format is identical. Proves long-lived bidirectional communication with Claude Code is production-viable.

#### 6.2 Official Claude Agent SDKs

TypeScript (`@anthropic-ai/claude-agent-sdk`), Python (`claude-agent-sdk-python`), Go (`partio-io/claude-agent-sdk-go`), and Elixir (`nshkrdotcom/claude_agent_sdk`) SDKs all use `--input-format stream-json` for multi-turn sessions. The TypeScript SDK's `sdk.d.ts` is the authoritative type source.

#### 6.3 Documentation Gap

No official Anthropic documentation for the raw protocol exists. See [GitHub issue #24594](https://github.com/anthropics/claude-code/issues/24594). Information assembled from SDK types and community reverse-engineering.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/providers/types.ts` | 63-68 | `ProviderSession` interface (no `sendMessage()`) |
| `src/providers/claude-adapter.ts` | 185 | `ClaudeSession` class |
| `src/providers/claude-adapter.ts` | 211 | `Bun.spawn()` — no `stdin: "pipe"` |
| `src/providers/claude-adapter.ts` | 224-254 | `buildCommand()` — uses `-p <prompt>`, not `--input-format stream-json` |
| `src/providers/claude-adapter.ts` | 539 | `abort()` — `proc.kill("SIGTERM")` |
| `src/providers/pi-mono-adapter.ts` | 285 | Single `session.prompt()` call |
| `src/providers/pi-mono-adapter.ts` | 381 | `session.abort()` for cancellation |
| `src/providers/pi-mono-adapter.ts` | 514 | `createAgentSession()` |
| `src/commands/runner.ts` | 770-784 | `RunningTask` type — holds session reference |
| `src/commands/runner.ts` | 1574 | `adapter.createSession()` call |
| `src/commands/runner.ts` | 2766-2794 | Cancellation polling — model for steering message polling |
| `src/hooks/hook.ts` | 788-849 | `PreToolUse` hook — indirect session influence |
| `src/http/active-sessions.ts` | — | Active session tracking (agent → task → session mapping) |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` | 279 | `AgentSession.prompt()` |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` | 294 | `AgentSession.steer()` |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` | 302 | `AgentSession.followUp()` |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` | 332 | `AgentSession.sendUserMessage()` |
| `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` | 131 | `Agent.steer()` — steering queue |
| `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts` | 136 | `Agent.followUp()` — follow-up queue |

## Architecture Documentation

### Current Pattern: Fire-and-Forget Sessions

```
Runner → adapter.createSession(prompt) → ProviderSession
  │                                          │
  ├─ onEvent() ← streaming telemetry ───────┘
  │
  ├─ waitForCompletion() → Promise<ProviderResult>
  │
  └─ abort() → kill the process (only intervention available)
```

### Proposed Pattern: Steerable Sessions

```
Runner → adapter.createSession(prompt) → SteerableSession extends ProviderSession
  │                                          │
  ├─ onEvent() ← streaming telemetry ───────┘
  │
  ├─ sendMessage(text) → write to stdin / call steer()
  │       (queued, delivered between turns — session stays alive)
  │
  ├─ interrupt() → control_request:interrupt / abort current tool
  │       (stops current turn, session stays alive, can send new message after)
  │
  ├─ waitForCompletion() → Promise<ProviderResult>
  │
  └─ abort() → kill the process (SIGTERM, session dies)
```

**Note on `interrupt()` vs `abort()`**: `interrupt()` stops the current *turn* but keeps the session alive — the process continues running and you can send a new user message. `abort()` kills the process entirely (SIGTERM). Think of interrupt as "stop what you're doing and listen" vs abort as "you're fired".

### Delivery at Provider Level

| Method | Claude Implementation | Pi-Mono Implementation |
|---|---|---|
| `sendMessage(text)` | Write `{"type":"user",...}\n` to `proc.stdin` | Call `session.steer(text)` or `session.followUp(text)` |
| `interrupt()` | Write `{"type":"control_request","request":{"subtype":"interrupt"}}\n` to stdin | Call `session.abort()` then re-prompt |
| `endSession()` | Write `end_session` control request, or close stdin | Call `session.dispose()` |

## Related Research

- `thoughts/taras/research/2026-03-28-claude-code-input-format-stream-json.md` — Companion doc: detailed protocol reference for Claude Code's stream-json format, including all SDK types, message formats, control requests, and multi-turn patterns. Status: draft.

## Resolved Questions (from review)

1. **Message priority for Claude** → **Implement both steer and followUp.** Claude adapter maps: `steer(text)` = `interrupt` control request + send user message; `followUp(text)` = plain user message (FIFO, delivered after current turn). More complete, more control.

2. **Session initialization** → **Not needed.** Our experiments work without the `initialize` control request. The CLI already works without it when using `--dangerously-skip-permissions`. Skip for now, add later if needed.

3. **Permission handling** → **Keep bypass mode.** Already using `--dangerously-skip-permissions` + `--permission-mode bypassPermissions` (`claude-adapter.ts:232-234`). No need to implement permission handling via stdin/stdout.

4. **Session resume** → **Already implemented.** The runner resolves `--resume` via `additionalArgs` (`runner.ts:2610-2620`). Task’s `claudeSessionId` is stored in the DB after `session_init` event. On task retry or child tasks, `--resume <sessionId>` is appended. Stale sessions are handled with a retry-without-resume fallback (`claude-adapter.ts:484-536`). This continues working with `--input-format stream-json` — the `--resume` flag is compatible.

5. **Concurrency** → **Send and forget.** Don’t overthink it. Write messages to stdin, Claude processes them FIFO. No queue management needed on our side.

6. **Empty initial prompt** → **Resolved.** Clarification: when using `--input-format stream-json`, we’d change from `-p "actual task prompt"` to `-p "" --input-format stream-json` and then send the prompt as the first stdin message. This is a `buildCommand()` change, not a behavioral one. The prompt content is the same, just delivered via a different channel (stdin instead of CLI arg). This is necessary because `-p <prompt>` doesn’t accept further stdin messages.

7. **Architecture for steering message delivery** → **Worker polls API, new DB table.** Since workers run in Docker and the Claude process is spawned inside the container, the stdin pipe is directly available to the worker process (no Docker exec needed — the worker’s runner spawns Claude as a child process with `Bun.spawn`). The flow:

   ```
   API Server                          Worker (Docker)
   ┌─────────────────┐                ┌──────────────────────────┐
   │ steering_messages│                │ Runner polling loop       │
   │ table:           │  GET /api/     │                          │
   │  taskId          │◄──────────────│  poll for pending msgs    │
   │  message         │  tasks/:id/    │         │                │
   │  createdAt       │  steer         │         ▼                │
   │  deliveredAt     │                │  session.sendMessage()   │
   └─────────────────┘                │         │                │
                                      │         ▼                │
                                      │  proc.stdin.write(NDJSON)│
                                      └──────────────────────────┘
   ```

   New table: `steering_messages(id, taskId, message, priority, createdAt, deliveredAt)`
   New endpoint: `GET /api/tasks/:id/steer` (poll) + `POST /api/tasks/:id/steer` (send)
   Worker runner adds a check in the poll loop (similar to cancellation check at `runner.ts:2766-2794`).

## Remaining Open Questions

1. **Hang risk**: Known issues [#3187](https://github.com/anthropics/claude-code/issues/3187) and [#25629](https://github.com/anthropics/claude-code/issues/25629) report hangs with multi-turn stream-json. Need timeout/watchdog logic. What’s our recovery strategy — kill + retry with `--resume`?

2. **Pi-mono parity**: Should the pi-mono adapter also use the new polling-based steering, or keep using the direct `steer()`/`followUp()` API? Direct API is cleaner, but polling gives us uniform behavior across providers.

## Review Errata

_Reviewed: 2026-03-28 by Claude_

### Important

- [ ] **Inconsistent `steer()` mapping for Claude adapter.** The comparison table (Section 4) maps Claude's equivalent of pi-mono's mid-stream injection to "Send user message mid-stream — queued between turns" (passive FIFO). But Resolved Question #1 maps `steer(text)` to `interrupt` control request + send user message (active interrupt). These are two different behaviors: passive queue-and-wait vs active interrupt-and-redirect. The document should pick one as the canonical mapping, or define both as separate methods (e.g., `steer()` = interrupt+resend, `followUp()` = passive FIFO).

- [ ] **No error handling discussion for stdin writes.** Neither Section 2 nor the proposed architecture addresses what happens when `proc.stdin.write()` fails — broken pipe (process exited), backpressure, or write errors. The runner needs a guard: check `proc.exitCode !== null` before writing, and handle write failures gracefully (mark message as undeliverable, trigger abort+retry).

- [ ] **Open Question #2 is a design decision, not a research question.** The findings already show pi-mono's direct API is superior (richer queue management, priority modes, inspection). The polling approach only adds value for uniformity. Consider resolving this: "Use direct API for pi-mono, polling for Claude — the adapter abstraction already handles the difference."

### Minor

- [x] **Duplicate references to companion doc.** Both "Historical Context" and "Related Research" sections reference the same `2026-03-28-claude-code-input-format-stream-json.md` document — consolidated into one.

### Notes

- Code references verified against codebase at `bee85bc`: 18 of 21 references are accurate or shifted by ≤2 lines. The `abort()` method signature starts at line 538 (not 539, but 539 is where `SIGTERM` is called — acceptable). Cancellation polling ends at line 2795 (not 2794). All descriptions are substantively correct.
- Sections 2.4-2.5 ("Experimentally Verified") would benefit from linking to test scripts or session logs, but this is minor since the research is self-contained.
