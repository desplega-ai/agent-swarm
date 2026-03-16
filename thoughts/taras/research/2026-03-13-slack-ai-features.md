---
date: 2026-03-13
researcher: claude
git_commit: 3df5660
git_branch: main
tags: [slack, ai, integration, streaming, assistant-threads, block-kit]
status: complete
last_updated: 2026-03-13
---

# Research: Slack AI Features & Richer Task Notifications

## Research Question

How can we improve the current Slack integration to use native Slack AI features? Specifically: pushing more detailed info from task logs to chat, leveraging assistant threads, streaming, and rich messaging.

## Summary

The current Slack integration uses a simple polling watcher that posts plain-text completion/progress messages to threads. Slack's platform has evolved significantly with AI-native features that could dramatically improve the agent-swarm UX. The three highest-impact opportunities are:

1. **Assistant Threads** — gives agent-swarm a native AI container in Slack's sidebar with status indicators, suggested prompts, and conversation history
2. **Chat Streaming** — stream LLM responses token-by-token instead of waiting for full completion
3. **Richer Block Kit messages** — structured progress updates with expandable sections, feedback buttons, and task metadata

---

## Detailed Findings

### 1. Current Slack Integration Architecture

#### Entry Point & Lifecycle
- `src/slack/app.ts` — Initializes `@slack/bolt` App in **Socket Mode**, registers handlers, starts task watcher
- `src/slack/index.ts` — Barrel export for all Slack modules

#### Inbound Flow (Slack → Swarm)
- `src/slack/handlers.ts:316` — `registerMessageHandler()` listens to `app.event("message")`
- Handles: user filtering, deduplication, rate limiting, bot mention detection
- `src/slack/router.ts:17` — `routeMessage()` routes messages by priority: `swarm#<uuid>` → `swarm#all` → thread follow-up → lead fallback
- `src/slack/thread-buffer.ts` — Additive buffer for non-mention thread replies (feature flag: `ADDITIVE_SLACK=true`), debounces 10s, creates batched follow-up tasks with dependency chaining
- `src/slack/commands.ts` — Slash commands: `/agent-swarm-status`, `/agent-swarm-help`

#### Outbound Flow (Swarm → Slack)
- `src/slack/watcher.ts:24` — `startTaskWatcher()` polls DB every 3 seconds
  - Checks `getInProgressSlackTasks()` for progress changes → `sendProgressUpdate()`
  - Checks `getCompletedSlackTasks()` for completions → `sendTaskResponse()`
  - Throttling: 1s minimum between sends per task, dedup via `sentProgress` map
- `src/slack/responses.ts:57` — `sendTaskResponse()` posts completion/failure with agent persona (custom username + emoji via `chat:write.customize` scope)
- `src/slack/responses.ts:110` — `sendProgressUpdate()` posts progress with hourglass emoji
- Both use a single `section` block with `mrkdwn` text — no rich blocks, no updates, no streaming

#### MCP Tools (Agent → Slack)
- `src/tools/slack-post.ts` — Post new channel message (lead-only)
- `src/tools/slack-reply.ts` — Reply to thread (by inbox message or task ID)
- `src/tools/slack-read.ts` — Read channel messages
- `src/tools/slack-upload-file.ts` — Upload files to channels/threads
- `src/tools/store-progress.ts` — Stores progress + creates follow-up tasks for lead on completion; this is where the watcher picks up changes

#### Current Manifest Scopes
```json
"bot": [
  "app_mentions:read", "channels:history", "channels:read",
  "chat:write", "chat:write.customize", "chat:write.public",
  "commands", "files:read", "files:write",
  "groups:history", "groups:read", "im:history", "im:read", "im:write",
  "mpim:history", "mpim:read", "mpim:write",
  "reactions:write", "users:read"
]
```

#### Current Event Subscriptions
```json
"bot_events": ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"]
```

---

### 2. Slack AI Platform Features (Available to Third-Party Apps)

#### 2a. Agents & AI Apps Feature

**What it is:** A Slack platform feature that gives your app a dedicated AI container in Slack's sidebar. Users can start threads with the app directly (not just @mention in channels).

**Key capabilities:**
- Dedicated split-view surface in Slack UI
- Loading/thinking status indicators
- Suggested prompts for user guidance
- Conversation history tab
- Thread context awareness (knows which channel the user is viewing)

**Events:**
- `assistant_thread_started` — fired when user opens a new conversation with your app
- `assistant_thread_context_changed` — fired when user switches channels while container is open

**API Methods:**
| Method | Description | Scope Required |
|--------|-------------|----------------|
| `assistant.threads.setStatus` | Show loading/thinking indicator | `chat:write` (or `assistant:write`) |
| `assistant.threads.setTitle` | Set thread title for history | `chat:write` (or `assistant:write`) |
| `assistant.threads.setSuggestedPrompts` | Show suggested prompts | `chat:write` (or `assistant:write`) |

**Manifest changes needed:**
- Enable "Agents & AI Apps" in app settings
- Subscribe to `assistant_thread_started` and `assistant_thread_context_changed` events
- Add `assistant:write` scope (or just use existing `chat:write`)

**Bolt.js integration:** The `Assistant` class in `@slack/bolt` handles these events natively with `threadStarted`, `threadContextChanged`, and `userMessage` handlers.

**Source:** [Slack AI Assistant Tutorial (Bolt.js)](https://docs.slack.dev/tools/bolt-js/tutorials/ai-assistant/), [Developing AI Apps](https://docs.slack.dev/ai/developing-ai-apps/)

#### 2b. Chat Streaming

**What it is:** Three new API methods that let apps stream text responses token-by-token, providing a ChatGPT-like experience in Slack.

**API Methods:**
| Method | Description |
|--------|-------------|
| `chat.startStream` | Begin a text stream in a thread |
| `chat.appendStream` | Append text chunks to the stream |
| `chat.stopStream` | End the stream, finalize the message |

**Bolt.js helper:** `client.chatStream()` returns a streamer object with `.append()` and `.stop()` methods.

**Additional feature:** `feedback_buttons` block element lets users rate AI responses (thumbs up/down), sending a `block_action` event to your app.

**Source:** [Chat Streaming Changelog](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)

#### 2c. Slack MCP Server (GA)

**What it is:** Slack's official MCP server lets AI agents use Slack tools (search, messaging, canvases) via the Model Context Protocol.

**Relevance:** This is the inverse of what we do — we bring Slack into agent-swarm via `@slack/bolt`, while Slack's MCP server brings Slack into standalone AI agents. Not directly useful for our integration but worth knowing about.

**Source:** [Slack MCP Server](https://docs.slack.dev/ai/slack-mcp-server/)

#### 2d. Message Metadata API

**What it is:** Invisible structured data payloads attached to messages via a `metadata` field containing `event_type` and `event_payload`.

**Structure:**
```json
{
  "metadata": {
    "event_type": "task_completed",
    "event_payload": {
      "task_id": "abc-123",
      "agent_name": "Alpha",
      "status": "completed",
      "duration_ms": "45000"
    }
  }
}
```

**Key properties:**
- Not visible to users in the message UI
- Can be read by other apps/automations via `include_all_metadata=true`
- Can trigger Workflow Builder automations
- Flat key-value structure only (no nested objects)

**Source:** [Message Metadata](https://api.slack.com/metadata), [Metadata Schema](https://api.slack.com/reference/metadata)

---

### 3. Slack Rich Messaging Capabilities

#### 3a. Block Kit Limits & Capabilities

| Constraint | Limit |
|------------|-------|
| Max blocks per message | 50 |
| Section text max chars | ~3,000 |
| Markdown block max chars | ~12,000 |
| Max message text (fallback) | 40,000 chars |

**Block types relevant for task info:**
- `header` — Large bold text (task title)
- `section` — Text with optional accessory (button, overflow menu)
- `context` — Small gray metadata text (agent name, task ID, duration)
- `divider` — Horizontal line
- `actions` — Interactive buttons, select menus
- `rich_text` — Rich text with code blocks, lists, quotes

**Missing:** No native collapsible/expandable sections in Block Kit. Workaround: post summary in thread root, details in thread reply.

#### 3b. Message Updates (`chat.update`)

**Rate limits:**
- Same as `chat.postMessage`: ~1 message/second per channel (Tier 3)
- Can update any message posted by your app
- Blocks, text, and attachments can all be updated

**Use case:** Post a "task assigned" message, then update it as progress comes in — avoids thread spam.

#### 3c. File Uploads

Currently supported via `src/slack/files.ts` using `filesUploadV2`. Can share logs, diffs, or artifacts as threaded file attachments.

---

### 4. Current Integration Gaps

| Area | Current State | What's Available |
|------|--------------|-----------------|
| Task status display | Plain text `:hourglass:` progress messages | Block Kit with structured sections, context blocks, action buttons |
| Response delivery | Full text dump on completion | Chat streaming (token-by-token) |
| Progress updates | New message per update (thread spam) | `chat.update` on a single pinned progress message |
| AI container | Only works via @mentions in channels | Assistant Threads with dedicated sidebar UI |
| Loading indicators | None | `assistant.threads.setStatus` |
| Suggested prompts | None | `assistant.threads.setSuggestedPrompts` |
| Conversation history | Users must scroll threads | Assistant thread history tab |
| User feedback | None | `feedback_buttons` block element |
| Structured metadata | None | Message Metadata API for automation triggers |
| Log detail | Link to dashboard only | Expandable rich text blocks, file uploads for logs |

---

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/slack/app.ts` | 1-75 | App init, socket mode, handler registration, watcher start |
| `src/slack/handlers.ts` | 316-588 | Message event handler, routing, additive buffer integration |
| `src/slack/router.ts` | 17-71 | Message routing logic (swarm#id → swarm#all → thread → lead) |
| `src/slack/watcher.ts` | 1-120 | 3s polling loop for progress/completion → Slack notifications |
| `src/slack/responses.ts` | 1-184 | `sendTaskResponse()`, `sendProgressUpdate()`, persona logic |
| `src/slack/thread-buffer.ts` | 1-213 | Additive buffer with debounce, dependency chaining, !now |
| `src/slack/commands.ts` | 1-102 | Slash commands (/status, /help) |
| `src/slack/files.ts` | 1-303 | File upload/download via Slack API |
| `src/slack/types.ts` | 1-20 | Shared types (SlackMessageContext, AgentMatch, SlackConfig) |
| `src/slack/HEURISTICS.md` | 1-106 | Documentation of routing & buffering heuristics |
| `src/tools/slack-post.ts` | 1-105 | MCP tool: post to channel (lead-only) |
| `src/tools/slack-reply.ts` | 1-144 | MCP tool: reply to thread |
| `src/tools/store-progress.ts` | 1-317 | MCP tool: store progress, complete/fail tasks, create follow-ups |
| `slack-manifest.json` | 1-72 | App manifest: scopes, events, slash commands |

---

## Key Terminology

| Term | Definition |
|------|-----------|
| **Assistant Thread** | Slack's native AI conversation container in the sidebar, separate from channel threads |
| **Chat Streaming** | Token-by-token message delivery via `chat.startStream/appendStream/stopStream` |
| **Message Metadata** | Invisible structured payload (`event_type` + `event_payload`) on messages |
| **Agents & AI Apps** | Slack platform feature that enables assistant threads, status, and suggested prompts |
| **Block Kit** | Slack's UI framework for rich message layouts |
| **Additive Buffer** | agent-swarm's debounce system for batching non-mention thread replies into tasks |
| **Task Watcher** | 3s polling loop in `watcher.ts` that bridges DB task changes to Slack messages |

---

## Decisions (from review)

1. **Assistant Threads vs Channel Threads** — **Support both.** Assistant threads for 1:1 agent conversations, channel threads for team visibility. The implementation should be backward-compatible (works even if Agents & AI Apps feature isn't enabled in the Slack app).
2. **Streaming granularity** — **Stream full task output.** No need to truncate or summarize.
3. **chat.update vs new messages** — **Use chat.update** to update a single progress message instead of posting new ones.
4. **Manifest migration** — Already enabled manually. Implementation should be backward-compatible so it works even without the feature toggle.
5. **Custom buttons** — Yes, Slack supports custom interactive buttons via Block Kit `actions` blocks with `button` elements. They fire `block_action` events to your app. Additionally, the Agents & AI Apps feature provides a dedicated `feedback_buttons` block element for thumbs up/down AI response ratings. Both approaches work — standard buttons for custom actions (e.g., "View Full Logs", "Retry Task", "Cancel"), and `feedback_buttons` for AI response quality feedback. Destination TBD.
