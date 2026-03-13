---
date: 2026-03-13
author: claude
status: draft
autonomy: critical
research: thoughts/taras/research/2026-03-13-slack-ai-features.md
tags: [slack, ai, block-kit, assistant-threads, interactivity]
commit_after_phase: false
---

# Plan: Slack AI Improvements — Rich Messages, Progress Updates, Assistant Threads

## Overview

Improve the Slack integration with four incremental phases: rich Block Kit layouts, `chat.update` progress tracking, interactive action buttons, and Slack Assistant thread support. Each phase is independently shippable and backward compatible.

## Current State

The Slack integration uses plain-text messages with a single `section` block for all outputs:

- **Inbound:** `handlers.ts` routes messages → creates tasks via DB
- **Outbound:** `watcher.ts` polls DB every 3s → `responses.ts` posts plain text via `chat.postMessage`
- **No interactivity:** Zero `app.action()` handlers, zero buttons, zero `chat.update`
- **No assistant threads:** Zero assistant-related code

**Key files:**
| File | Role |
|------|------|
| `src/slack/app.ts` | Init, handler registration, watcher start |
| `src/slack/handlers.ts` | Inbound message routing + task creation |
| `src/slack/watcher.ts` | 3s polling loop for progress/completion |
| `src/slack/responses.ts` | Message formatting + posting with agent persona |
| `src/slack/commands.ts` | Slash commands |
| `src/slack/thread-buffer.ts` | Additive buffer for non-mention thread replies |
| `src/tools/store-progress.ts` | MCP tool: agents store progress/complete tasks |
| `slack-manifest.json` | App manifest: scopes, events, features |

## Desired End State

1. Task notifications use structured Block Kit layouts with header, context metadata, and sections
2. Progress updates modify a single message via `chat.update` instead of posting new messages (no thread spam)
3. Action buttons allow users to retry, cancel, or view full logs directly from Slack
4. Users can interact with agents via Slack's native Assistant thread sidebar (when enabled)
5. All changes are backward compatible — channel @mention flow continues working, assistant threads are additive

## Constraints

- Must work without "Agents & AI Apps" Slack feature (backward compat for Phase 4)
- `@slack/bolt ^4.6.0` is already installed — Assistant class available
- Existing scopes (`chat:write`, `chat:write.customize`, `reactions:write`) cover Phases 1-3
- Phase 4 requires `assistant:write` scope + two new event subscriptions
- Max 50 blocks per message, ~3000 chars per section text

---

## Phase 1: Rich Block Kit Message Builder

**Goal:** Replace single-section plain text with structured Block Kit layouts for all outbound messages.

### 1.1 Create block builder utility

Create `src/slack/blocks.ts` with functions that construct Block Kit block arrays:

```typescript
// src/slack/blocks.ts

interface TaskBlocksOptions {
  title: string;           // e.g., "Task Completed" or "Task In Progress"
  emoji: string;           // e.g., ":white_check_mark:" or ":hourglass_flowing_sand:"
  body: string;            // Main content (mrkdwn formatted)
  agentName: string;       // Agent display name
  taskId: string;          // Full task UUID
  taskLink: string;        // Dashboard link or short ID
  status: string;          // "completed" | "failed" | "in_progress"
  duration?: string;       // Human-readable duration
  footer?: string;         // Optional footer text
}

function buildTaskBlocks(opts: TaskBlocksOptions): Block[];
function buildProgressBlocks(agentName: string, progress: string, taskLink: string): Block[];
function buildAssignedBlocks(agentName: string, taskSummary: string, taskLink: string): Block[];
function buildFailedBlocks(agentName: string, reason: string, taskLink: string): Block[];
```

**Block structure for completed task:**
```
┌──────────────────────────────────────┐
│ ✅ Task Completed                     │  ← header block
├──────────────────────────────────────┤
│ 🤖 Alpha · `a1b2c3d4` · 45s         │  ← context block (agent, ID, duration)
├──────────────────────────────────────┤
│ [task output in mrkdwn]              │  ← section block(s) — split if >3000 chars
├──────────────────────────────────────┤
│ View full logs at `a1b2c3d4`         │  ← context block (footer)
└──────────────────────────────────────┘
```

**Block structure for progress update (used with chat.update in Phase 2):**
```
┌──────────────────────────────────────┐
│ ⏳ Task In Progress                   │  ← header block
├──────────────────────────────────────┤
│ 🤖 Alpha · `a1b2c3d4`               │  ← context block
├──────────────────────────────────────┤
│ Analyzing codebase...                │  ← section block (progress text)
└──────────────────────────────────────┘
```

### 1.2 Refactor responses.ts

Update `sendTaskResponse()` and `sendProgressUpdate()` to use the new block builder:

- `sendTaskResponse()` calls `buildTaskBlocks()` or `buildFailedBlocks()` instead of raw text
- `sendProgressUpdate()` calls `buildProgressBlocks()` instead of raw text
- `sendWithPersona()` accepts a `blocks` array parameter instead of constructing its own
- Keep the `text` field as plain-text fallback for notifications (Slack requires it)

### 1.3 Update handlers.ts task assignment messages

Replace the plain-text `:satellite: Task assigned to:` messages with `buildAssignedBlocks()`:
```
┌──────────────────────────────────────┐
│ 📡 Task Assigned                      │  ← header block
├──────────────────────────────────────┤
│ Agent: Alpha · `a1b2c3d4`            │  ← context block
│ Status: Pending                      │
└──────────────────────────────────────┘
```

### 1.4 Update thread-buffer.ts flush messages

Replace plain-text buffer flush feedback with a context block showing message count + task link.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`
- [ ] New block builder unit tests pass: `bun test src/tests/slack-blocks.test.ts`

#### Manual Verification:
- [ ] @mention an agent in Slack → task assigned message shows rich block layout
- [ ] Wait for task completion → completion message shows header, context, structured body
- [ ] Failed task → failure message shows error in code block with context metadata
- [ ] Progress updates still appear (format will improve in Phase 2)
- [ ] Messages look correct in both desktop and mobile Slack clients

**Implementation Note**: Pause after this phase for Slack visual QA before continuing.

---

## Phase 2: chat.update Progress Tracking

**Goal:** Replace thread spam with a single updatable progress message per task.

### 2.1 Track progress message timestamps

Add an in-memory map in `watcher.ts` to store the initial progress message `ts` per task:

```typescript
// Map of taskId -> { channelId, threadTs, messageTs }
const progressMessages = new Map<string, {
  channelId: string;
  threadTs: string;
  messageTs: string;  // The ts of the message to update
}>();
```

### 2.2 Post initial progress message on first progress update

When `watcher.ts` sees a new in-progress task with progress text for the first time:
1. Call `chat.postMessage` with `buildProgressBlocks()` → get back `result.ts`
2. Store `{ channelId, threadTs, messageTs: result.ts }` in `progressMessages`

### 2.3 Update existing message on subsequent progress updates

When `watcher.ts` detects a progress change for a task that already has a `progressMessages` entry:
1. Call `chat.update` with `{ channel, ts: messageTs, blocks: buildProgressBlocks(...) }`
2. This modifies the existing message in-place — no new message in thread

### 2.4 Handle completion: post final message + clean up

When a task completes or fails:
1. If there's a `progressMessages` entry, update it one last time with a "completed" or "failed" status using `chat.update` and the rich completion blocks
2. **Additionally** post the full task output as a new thread reply (since the progress message is a compact card and completion may have a long output)
3. Clean up: delete from `progressMessages`

### 2.5 Handle edge cases

- **Server restart:** `progressMessages` is in-memory, so on restart we lose tracked messages. Fall back to posting new messages (same as current behavior). Acceptable since restarts are rare.
- **Rate limits:** `chat.update` shares the same rate limit as `chat.postMessage` (~1/sec/channel). Current 3s polling + 1s throttle already respects this.
- **No initial progress:** If a task completes without ever posting progress, skip update flow and post completion directly.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`
- [ ] Watcher tests pass (if added): `bun test src/tests/slack-watcher.test.ts`

#### Manual Verification:
- [ ] Assign a task via Slack → see "Task In Progress" card appear
- [ ] As agent reports progress → same card updates in-place (no new messages)
- [ ] On completion → card updates to "Completed" + full output posted as reply
- [ ] On failure → card updates to "Failed" with reason
- [ ] Restart server mid-task → next progress gracefully posts new message (no crash)

**Implementation Note**: Pause after this phase. Compare thread before/after — should see dramatically less spam.

---

## Phase 3: Action Buttons + Interactivity

**Goal:** Add interactive buttons to task messages for retry, cancel, and viewing full logs.

### 3.1 Add actions block to completion/failure messages

Extend `buildTaskBlocks()` and `buildFailedBlocks()` to include an `actions` block:

```typescript
{
  type: "actions",
  elements: [
    {
      type: "button",
      text: { type: "plain_text", text: "View Full Logs" },
      action_id: "view_task_logs",
      url: `${appUrl}?tab=tasks&task=${taskId}&expand=true`,  // External link button
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Retry Task" },
      action_id: "retry_task",
      value: taskId,
      style: "primary",
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Cancel" },
      action_id: "cancel_task",
      value: taskId,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Cancel task?" },
        text: { type: "mrkdwn", text: "This will cancel the task. Are you sure?" },
        confirm: { type: "plain_text", text: "Yes, cancel" },
        deny: { type: "plain_text", text: "Never mind" },
      },
    },
  ],
}
```

**Notes:**
- "View Full Logs" uses the `url` property → opens in browser, no handler needed
- "Retry" and "Cancel" trigger `block_action` events → need `app.action()` handlers
- "Cancel" includes a confirmation dialog
- Buttons only appear on completed/failed messages (not in-progress — cancel is handled differently for in-progress tasks)

### 3.2 Create interactivity handlers

Create `src/slack/actions.ts`:

```typescript
export function registerActionHandlers(app: App): void {
  app.action("retry_task", async ({ ack, action, client, body }) => {
    await ack();
    // Extract taskId from action.value
    // Get original task from DB
    // Create new task with same description, source, slack context
    // Post confirmation in thread
  });

  app.action("cancel_task", async ({ ack, action, client, body }) => {
    await ack();
    // Extract taskId from action.value
    // Call cancelTask() from DB
    // Update the message to reflect cancelled state
  });
}
```

### 3.3 Register handlers in app.ts

Update `initSlackApp()` to import and call `registerActionHandlers(app)`.

### 3.4 Add "Cancel" button to in-progress cards

Extend the Phase 2 progress card to include a "Cancel" button while the task is in progress. Remove it when the task completes (via `chat.update`).

### 3.5 Update manifest (if needed)

Check if interactivity is already enabled in the manifest. Currently `"interactivity": { "is_enabled": true }` exists — this should be sufficient for `app.action()` handlers in Socket Mode.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`
- [ ] Action handler tests pass: `bun test src/tests/slack-actions.test.ts`

#### Manual Verification:
- [ ] Completed task message shows "View Full Logs", "Retry Task" buttons
- [ ] Failed task message shows "View Full Logs", "Retry Task" buttons
- [ ] "View Full Logs" opens dashboard in browser
- [ ] "Retry Task" creates a new task and posts confirmation
- [ ] "Cancel" shows confirmation dialog, then cancels and updates message
- [ ] In-progress card shows "Cancel" button, removed on completion
- [ ] Buttons work in both desktop and mobile Slack

**Implementation Note**: Pause after this phase. Test all button interactions thoroughly — interactivity bugs are hard to debug.

---

## Phase 4: Assistant Threads (Backward Compatible)

**Goal:** Enable Slack's native AI assistant container so users can interact with agents via the sidebar.

### 4.1 Create assistant handler

Create `src/slack/assistant.ts`:

```typescript
import { Assistant } from "@slack/bolt";
import { getLeadAgent, createTaskExtended } from "../be/db";

export function createAssistant(): Assistant {
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
      await saveThreadContext();

      await say("Hi! I'm your Agent Swarm assistant. How can I help?");

      await setSuggestedPrompts({
        title: "Try these:",
        prompts: [
          { title: "Check status", message: "What's the current status of all agents?" },
          { title: "Assign a task", message: "Can you help me with..." },
          { title: "List recent tasks", message: "Show me the most recent tasks" },
        ],
      });
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      await saveThreadContext();
    },

    userMessage: async ({ message, say, setStatus, setTitle, getThreadContext }) => {
      // Set loading status
      await setStatus("Processing your request...");

      // Set thread title from first message
      if (message.text) {
        const title = message.text.length > 50
          ? message.text.slice(0, 47) + "..."
          : message.text;
        await setTitle(title);
      }

      // Route to lead agent as a task
      const lead = getLeadAgent();
      if (!lead) {
        await say("No lead agent is available right now. Please try again later.");
        return;
      }

      // Create task from assistant thread message
      const task = createTaskExtended(message.text || "No message text", {
        agentId: lead.id,
        source: "slack",
        slackChannelId: message.channel,
        slackThreadTs: message.thread_ts || message.ts,
        slackUserId: message.user,
      });

      // Acknowledge with task link
      const taskLink = getTaskLink(task.id);
      await say(`Task created and assigned to *${lead.name}* (${taskLink}). I'll update you here when it's done.`);
    },
  });
}
```

### 4.2 Register assistant in app.ts (conditionally)

Update `initSlackApp()` to register the assistant. The `app.assistant()` call should be safe even if the "Agents & AI Apps" feature isn't enabled in the Slack app — unmatched events are simply not delivered:

```typescript
// In initSlackApp(), after registering other handlers:
const { createAssistant } = await import("./assistant");
app.assistant(createAssistant());
```

### 4.3 Integrate with existing watcher for responses

The assistant thread messages create tasks with `slackChannelId` and `slackThreadTs` — the existing `watcher.ts` will automatically pick up completions and post responses back to the assistant thread. **No changes needed to watcher.ts.**

However, the watcher posts with `chat.postMessage` using persona (username/icon_emoji). In assistant threads, we should use `say()` or standard `chat.postMessage` without persona overrides, as the assistant container already shows the app identity. Add a check:

```typescript
// In responses.ts sendTaskResponse():
// Detect if the thread is an assistant thread (DM to bot)
// If so, skip persona overrides (username, icon_emoji)
```

This can be determined by checking if the channel is a DM channel (`im:*` type).

### 4.4 Update manifest

Update `slack-manifest.json` to add:

```json
{
  "features": {
    "assistant_view": {
      "assistant_description": "Your Agent Swarm — assign tasks, check status, and interact with your AI agents.",
      "suggested_commands": [
        {
          "title": "Check agent status",
          "description": "See which agents are online and what they're working on"
        },
        {
          "title": "Assign a task",
          "description": "Give a task to one of your agents"
        }
      ]
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "assistant:write",
        // ... existing scopes
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "assistant_thread_started",
        "assistant_thread_context_changed",
        // ... existing events
      ]
    }
  }
}
```

### 4.5 Handle context awareness

When `threadContextChanged` fires, save the new channel context. When creating tasks, optionally include the channel context as metadata so the agent knows which channel the user was viewing:

```typescript
userMessage: async ({ message, say, setStatus, getThreadContext }) => {
  const ctx = await getThreadContext();
  const channelContext = ctx.channel_id
    ? `\n\n[User is viewing channel <#${ctx.channel_id}>]`
    : "";

  const task = createTaskExtended(message.text + channelContext, { ... });
};
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`
- [ ] Assistant handler unit tests pass: `bun test src/tests/slack-assistant.test.ts`

#### Manual Verification:
- [ ] Open the agent-swarm app in Slack sidebar → assistant container appears
- [ ] Suggested prompts are shown on thread start
- [ ] Send a message → loading status shows → task is created → response posted in thread
- [ ] Thread title is set from the first message
- [ ] Switch channels while assistant is open → no errors
- [ ] Channel @mentions still work exactly as before (backward compat)
- [ ] If "Agents & AI Apps" is disabled → app works normally without assistant, no errors

**Implementation Note**: Pause after this phase. Verify backward compatibility thoroughly — existing channel @mention flow must be unaffected.

---

## Manual E2E Verification

After all phases are complete, run through this end-to-end flow:

```bash
# 1. Start API server
bun run start:http

# 2. Verify Slack connection (check logs)
# Look for: "[Slack] Bot connected via Socket Mode"

# 3. Channel @mention flow (existing behavior, should still work)
# In a Slack channel: @agent-swarm help me with something
# Expected: Rich "Task Assigned" card → progress updates in-place → rich "Completed" card with buttons

# 4. Thread follow-up flow
# Reply in the thread without @mention (with ADDITIVE_SLACK=true)
# Expected: :eyes: reaction → buffer flush → task queued message

# 5. Action buttons
# Click "View Full Logs" on a completed task → opens dashboard
# Click "Retry Task" on a failed task → new task created, confirmation posted
# Click "Cancel" on an in-progress task → confirmation dialog → task cancelled

# 6. Assistant thread flow
# Open agent-swarm in Slack sidebar → start new conversation
# Expected: Welcome message + suggested prompts
# Send "check status" → loading indicator → response posted
# Switch channels → no errors

# 7. Verify no thread spam
# Compare a task lifecycle thread before/after:
# Before: 1 assigned msg + N progress msgs + 1 completion msg
# After: 1 assigned msg → 1 progress card (updated in-place) → 1 completion card with buttons
```

---

## Files Created / Modified

| Phase | File | Action |
|-------|------|--------|
| 1 | `src/slack/blocks.ts` | **Create** — Block builder utility |
| 1 | `src/slack/responses.ts` | Modify — Use block builder |
| 1 | `src/slack/handlers.ts` | Modify — Rich assigned messages |
| 1 | `src/slack/thread-buffer.ts` | Modify — Rich flush messages |
| 1 | `src/tests/slack-blocks.test.ts` | **Create** — Block builder tests |
| 2 | `src/slack/watcher.ts` | Modify — chat.update logic |
| 2 | `src/tests/slack-watcher.test.ts` | **Create** — Watcher tests |
| 3 | `src/slack/actions.ts` | **Create** — Interactivity handlers |
| 3 | `src/slack/app.ts` | Modify — Register action handlers |
| 3 | `src/slack/blocks.ts` | Modify — Add action blocks |
| 3 | `src/tests/slack-actions.test.ts` | **Create** — Action handler tests |
| 4 | `src/slack/assistant.ts` | **Create** — Assistant thread handler |
| 4 | `src/slack/app.ts` | Modify — Register assistant |
| 4 | `src/slack/responses.ts` | Modify — Persona skip for DMs |
| 4 | `slack-manifest.json` | Modify — Add assistant config + events + scope |
| 4 | `src/tests/slack-assistant.test.ts` | **Create** — Assistant tests |

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `chat.update` rate limits | Already throttled at 1s/task in watcher; 3s poll interval |
| Breaking existing @mention flow | Phase 4 is fully additive; phases 1-3 only change message formatting |
| `progressMessages` lost on restart | Graceful fallback to posting new messages |
| Users without "Agents & AI Apps" enabled | Assistant registration is safe; events simply won't fire |
| Block size limits (50 blocks, 3000 chars/section) | Split long output across multiple section blocks |
