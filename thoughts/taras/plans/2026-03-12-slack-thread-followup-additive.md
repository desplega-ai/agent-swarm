---
date: 2026-03-12T00:00:00Z
topic: "Slack Thread Follow-up Routing + Additive Slack Buffer"
status: completed
autonomy: critical
---

# Plan: Slack Thread Follow-up Routing + Additive Slack Buffer

> **Cross-cutting: Logging** — All phases must include `console.log("[Slack]")` at key decision points: route matches, buffer add/append/flush, `/now` triggers, dependency chaining, and help command invocations. This enables E2E debugging via `bun run pm2-logs` or Docker logs.

**Date**: 2026-03-12
**Status**: Draft
**Research**: `thoughts/shared/research/2026-03-12-slack-thread-mention-followups.md`

## Summary

Restore thread follow-up routing (Option C) and add the `ADDITIVE_SLACK` feature flag for debounced thread message buffering.

**Two independent features:**
1. **Thread follow-up routing** — re-add the removed step that routes @mentions in threads to the worker already active in that thread (before falling back to lead)
2. **Additive Slack** (`ADDITIVE_SLACK=true`) — listen to ALL thread messages (no @mention required), buffer them with a 10s debounce, and persist as a single task for the lead

---

## Phase 1: Restore Thread Follow-up Routing

**Goal**: When someone @mentions the bot in a thread where a worker is already active, route directly to that worker instead of the lead.

### Changes

> **Note**: Tests for all Phase 1 changes are in Phase 3.2 (`src/tests/slack-router.test.ts`).

#### 1.1 `src/slack/router.ts` — Add `ThreadContext` + routing step

- Add `ThreadContext` interface (or import from `types.ts`)
- Add `threadContext?: ThreadContext` parameter to `routeMessage()`
- Add thread follow-up routing step between `swarm#all` (line 39) and lead fallback (line 42):

```typescript
interface ThreadContext {
  channelId: string;
  threadTs: string;
}

export function routeMessage(
  text: string,
  _botUserId: string,
  botMentioned: boolean,
  threadContext?: ThreadContext,    // NEW
): AgentMatch[] {
  // ... existing swarm#<uuid> and swarm#all logic ...

  // NEW: Thread follow-up — route to agent already working in this thread
  if (matches.length === 0 && threadContext) {
    const workingAgent = getAgentWorkingOnThread(threadContext.channelId, threadContext.threadTs);
    if (workingAgent && workingAgent.status !== "offline") {
      matches.push({ agent: workingAgent, matchedText: "thread follow-up" });
    }
  }

  // Default to lead for everything else
  if (matches.length === 0 && botMentioned) {
    // ...existing lead fallback...
  }

  return matches;
}
```

- Import `getAgentWorkingOnThread` from `../be/db`

#### 1.2 `src/slack/handlers.ts` — Pass thread context to router

- Construct `routingThreadContext` before the `routeMessage()` call:

```typescript
const routingThreadContext = msg.thread_ts
  ? { channelId: msg.channel, threadTs: msg.thread_ts }
  : undefined;

const matches = routeMessage(routingText, botUserId, botMentioned, routingThreadContext);
```

#### 1.3 `src/be/db.ts` — Update `getAgentWorkingOnThread()`

The function still references `inbox_messages` table (legacy). Clean up:
- Remove the `inbox_messages` fallback query (that table may not exist anymore or is deprecated)
- Keep only the `agent_tasks` query

### Verification

```bash
bun run tsc:check
bun run lint:fix
bun test
```

Manual: Start API, create a worker task in a thread, then @mention in same thread → should route to worker, not lead.

---

## Phase 2: Additive Slack — Thread Message Buffer

**Goal**: When `ADDITIVE_SLACK=true`, thread follow-ups (even without @mention) get buffered and batched into a single task.

### New file: `src/slack/thread-buffer.ts`

In-memory buffer keyed by `${channelId}:${threadTs}`. This is the core of the feature.

```typescript
interface BufferedThread {
  channelId: string;
  threadTs: string;
  messages: Array<{
    text: string;
    userId: string;
    ts: string;
  }>;
  timer: Timer;               // debounce timer
  initialTaskId: string | null; // the first task created in this thread (if any)
  slackUserId: string;         // original requester
}

const threadBuffers = new Map<string, BufferedThread>();

const BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_SLACK_BUFFER_MS) || 10_000; // configurable, default 10s
```

**Exports:**

- `bufferThreadMessage(channelId, threadTs, text, userId, ts): void` — adds message to buffer, resets 10s timer
- `isThreadBuffered(channelId, threadTs): boolean` — check if there's an active buffer
- `getBufferMessageCount(key): number` — for Slack feedback (first vs. append)

**Flow:**
1. First message hits buffer → creates entry, starts 10s timer
2. Subsequent messages within 10s → appends to `messages[]`, resets timer
3. Timer expires → calls `flushBuffer(key)`:
   - Concatenates all buffered messages into one task description
   - Checks if initial thread task is `in_progress` → create as `backlog`
   - Otherwise → create as `pending` for lead
   - Clears buffer entry
   - Posts Slack feedback

**Tradeoffs acknowledged (in-memory):**
- Buffer is lost on server restart (acceptable — 10s window is tiny)
- No persistence across process restarts
- No clustering support (single-process only)

### Changes

#### 2.1 `src/slack/thread-buffer.ts` — New file (described above)

Core buffer logic. ~80 lines.

#### 2.2 `src/slack/handlers.ts` — Integrate buffer for non-mention thread messages

In `registerMessageHandler`, **before** the existing `if (!botMentioned) return;` early exit (line 368), add the additive Slack check:

```typescript
// ADDITIVE_SLACK: Buffer non-mention thread messages
const additiveSlack = process.env.ADDITIVE_SLACK === "true";
if (additiveSlack && !botMentioned && msg.thread_ts) {
  // Check if this thread has any swarm activity (existing tasks)
  const hasSwarmActivity = getAgentWorkingOnThread(msg.channel, msg.thread_ts) !== null;

  if (hasSwarmActivity) {
    // Add to buffer
    bufferThreadMessage(msg.channel, msg.thread_ts, effectiveText, msg.user, msg.ts);

    // Slack feedback: react with :eyes: on first buffer, :heavy_plus_sign: on appends
    const threadKey = `${msg.channel}:${msg.thread_ts}`;
    const count = getBufferMessageCount(threadKey);
    try {
      await client.reactions.add({
        channel: msg.channel,
        name: count === 1 ? "eyes" : "heavy_plus_sign",
        timestamp: msg.ts,
      });
    } catch { /* ignore reaction failures */ }

    return; // Don't process further — buffer will flush
  }
}
```

**Key design decision**: Only buffer messages in threads where the swarm is already active (has existing tasks). Random thread messages in channels where the bot was never mentioned are ignored — this prevents noise.

#### 2.3 `src/slack/thread-buffer.ts` — `flushBuffer` implementation

Buffered tasks are always created as **pending** with `dependsOn` set to the latest active task in the thread. This ensures follow-ups are naturally sequenced after the current work completes.

```typescript
async function flushBuffer(key: string, immediate: boolean = false): Promise<void> {
  const buffer = threadBuffers.get(key);
  if (!buffer || buffer.messages.length === 0) {
    threadBuffers.delete(key);
    return;
  }

  // Build combined task description
  const combinedText = buffer.messages
    .map(m => m.text)
    .join("\n---\n");

  const description = `[Thread follow-up — ${buffer.messages.length} message(s) buffered]\n\n${combinedText}`;

  // Find the latest active task in this thread for dependency chaining
  const latestActiveTask = getLatestActiveTaskInThread(buffer.channelId, buffer.threadTs);

  const lead = getLeadAgent();

  // Thread context for the task
  const threadContext = await getThreadContextForBuffer(buffer.channelId, buffer.threadTs);
  const fullDescription = threadContext
    ? `<thread_context>\n${threadContext}\n</thread_context>\n\n${description}`
    : description;

  const task = createTaskExtended(fullDescription, {
    agentId: lead?.id,
    source: "slack",
    slackChannelId: buffer.channelId,
    slackThreadTs: buffer.threadTs,
    slackUserId: buffer.slackUserId,
    // Always pending. If /now was used (immediate=true), no dependency.
    // Otherwise, depend on the latest active task so it queues naturally.
    dependsOn: immediate ? undefined : latestActiveTask?.id,
  });

  // Slack feedback
  const app = getSlackApp();
  if (app) {
    const hasDep = !immediate && latestActiveTask;
    const statusText = hasDep
      ? `:satellite: _${buffer.messages.length} follow-up message(s) queued pending completion of current task_ (${getTaskLink(task.id)})`
      : `:satellite: _${buffer.messages.length} follow-up message(s) batched into task_ (${getTaskLink(task.id)})`;

    await app.client.chat.postMessage({
      channel: buffer.channelId,
      thread_ts: buffer.threadTs,
      text: statusText,
    });
  }

  threadBuffers.delete(key);
}
```

#### 2.4 `src/be/db.ts` — New query: `getLatestActiveTaskInThread()`

```typescript
export function getLatestActiveTaskInThread(channelId: string, threadTs: string): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `SELECT * FROM agent_tasks
       WHERE source = ‘slack’
       AND slackChannelId = ?
       AND slackThreadTs = ?
       AND status IN (‘in_progress’, ‘pending’)
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(channelId, threadTs);

  return row ? rowToAgentTask(row) : null;
}
```

#### 2.5 `/now` command — Instant flush without dependency

When a user types `/now <optional message>` in a thread with an active buffer:

- If there’s text after `/now`, append it to the buffer first
- Flush immediately with `immediate=true` (no `dependsOn`)
- This makes the task pick-uppable right away, bypassing the dependency chain

**Detection** in `handlers.ts`: Check if `effectiveText` starts with `/now` (after stripping bot mention):

```typescript
// Check for /now command in additive slack threads
if (additiveSlack && msg.thread_ts) {
  const stripped = effectiveText.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (stripped.startsWith("/now")) {
    const nowMessage = stripped.replace(/^\/now\s*/, "").trim();
    const threadKey = `${msg.channel}:${msg.thread_ts}`;

    if (nowMessage) {
      bufferThreadMessage(msg.channel, msg.thread_ts, nowMessage, msg.user, msg.ts);
    }

    // Instant flush — no dependency
    await instantFlush(threadKey);

    try {
      await client.reactions.add({ channel: msg.channel, name: "zap", timestamp: msg.ts });
    } catch { /* ignore */ }

    return;
  }
}
```

**`instantFlush(key)`** in `thread-buffer.ts`:
- Clears the debounce timer
- Calls `flushBuffer(key, true)` (immediate=true → no dependsOn)

#### 2.6 Thread context fetching for buffer

The buffer flush needs thread context via Slack API in a timer callback. Use `getSlackApp().client` — it's a global singleton already used throughout `src/slack/`. Coupling accepted.

#### 2.7 Slack feedback summary

| Event | Slack Feedback |
|-------|---------------|
| First non-mention message buffered | `:eyes:` reaction on the message |
| Additional message appended to buffer | `:heavy_plus_sign:` reaction on the message |
| `/now` command | `:zap:` reaction on the message |
| Buffer flushed (with dependency) | Post: "N follow-up message(s) queued pending completion of current task" |
| Buffer flushed (no dependency / `/now`) | Post: "N follow-up message(s) batched into task" |

### Verification

```bash
bun run tsc:check
bun run lint:fix
bun test
```

---

## Phase 2b: Slack Heuristics Documentation & Help

### 2b.1 New file: `src/slack/HEURISTICS.md`

Document all Slack routing/buffering heuristics in one place for maintainers:

- Thread follow-up routing rules (Phase 1)
- Additive Slack buffer behavior (Phase 2)
- `/now` command semantics
- Dependency chaining logic
- Feature flag reference (`ADDITIVE_SLACK`, `ADDITIVE_SLACK_BUFFER_MS`)
- Feedback reactions reference table

### 2b.2 Update existing `/agent-swarm-help` slash command

The command already exists in `src/slack/commands.ts:60`. Update the help text to include thread follow-up routing and additive Slack features:

```typescript
app.command("/agent-swarm-help", async ({ ack, respond }) => {
  await ack();
  console.log("[Slack] /agent-swarm-help command invoked");

  const additiveSlack = process.env.ADDITIVE_SLACK === "true";

  const sections = [
    `*How to assign tasks:*
• \`@bot <task>\` — Routes to lead agent (or active worker if in a thread)
• \`swarm#<uuid> <task>\` — Send task to specific agent
• \`swarm#all <task>\` — Broadcast to all workers
• Thread @mentions auto-route to the worker already active in that thread`,
  ];

  if (additiveSlack) {
    sections.push(`*Additive Slack (enabled):*
• Thread replies (no @mention needed) are buffered and batched
• \`/now <message>\` — Flush buffer immediately, skip dependency queue
• Follow-up tasks auto-depend on the active task in the thread`);
  }

  sections.push(`*Commands:*
• \`/agent-swarm-status\` — Show all agents and their current status
• \`/agent-swarm-help\` — Show this help message`);

  // ... respond with blocks using sections
});
```

No manifest changes needed — the slash command is already registered.

### Verification

```bash
bun run tsc:check
bun run lint:fix
```

---

## Phase 3: Unit Tests

### 3.1 `src/tests/slack-thread-buffer.test.ts`

Test the buffer module in isolation:
- Buffer creation and message appending
- Timer reset on new messages (debounce behavior)
- Flush creates correct task with combined description
- Flush sets `dependsOn` to latest active task in thread
- Flush without active task → no `dependsOn`
- `instantFlush()` → no `dependsOn` regardless of active tasks
- `/now` with message appends before flushing
- `/now` without message flushes existing buffer
- Buffer keyed by channelId:threadTs (no cross-thread)
- Buffer cleanup after flush
- Configurable timeout via `ADDITIVE_SLACK_BUFFER_MS`

### 3.2 `src/tests/slack-router.test.ts` — Add thread follow-up tests

- Message in thread with active worker → routes to worker
- Message in thread with no active worker → falls through to lead
- Message in thread with offline worker → falls through to lead
- Thread follow-up doesn't override explicit `swarm#<uuid>`

### Verification

```bash
bun test src/tests/slack-thread-buffer.test.ts
bun test src/tests/slack-router.test.ts
bun run tsc:check
```

---

## Phase 4: Integration & Manual E2E

### 4.1 Integration check

- Verify `getAgentWorkingOnThread()` no longer queries `inbox_messages`
- Verify feature flag isolation: `ADDITIVE_SLACK=false` (or unset) → zero behavioral change from Phase 1 alone
- Verify thread buffer doesn't interfere with explicit routing (`swarm#<uuid>`, `swarm#all`)

### 4.2 Manual E2E

```bash
# Start API
bun run start:http

# Test 1: Thread follow-up routing (Phase 1)
# 1. @mention bot in a Slack channel → creates task for lead
# 2. Lead delegates to worker → worker starts task
# 3. @mention bot again in same thread → should route to worker (not lead)

# Test 2: Additive Slack buffer (Phase 2)
# Set ADDITIVE_SLACK=true in .env, restart
# 1. @mention bot in a Slack channel → creates task for lead (instant, no buffer)
# 2. Send follow-up in thread WITHOUT @mention → :eyes: reaction
# 3. Send another follow-up within 10s → :heavy_plus_sign: reaction
# 4. Wait 10s → "2 follow-up message(s) queued pending completion" posted
# 5. Verify created task has dependsOn set to the active task ID

# Test 3: /now command
# 1. With active buffer in thread, type "/now urgent fix needed"
# 2. → :zap: reaction, instant flush
# 3. Verify created task has NO dependsOn (immediately pickable)

# Test 4: /swarm-help slash command
# 1. Type "/swarm-help" in any channel → ephemeral help text posted

# Test 5: No false positives
# 1. Send message in thread where bot was never mentioned → ignored
# 2. Send message in thread with ADDITIVE_SLACK=false → ignored
```

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `src/slack/router.ts` | Modify — add `ThreadContext` + thread follow-up step | 1 |
| `src/slack/handlers.ts` | Modify — pass thread context to router + additive buffer + `/now` + `-help` | 1, 2, 2b |
| `src/be/db.ts` | Modify — clean up `getAgentWorkingOnThread()`, add `getLatestActiveTaskInThread()` | 1, 2 |
| `src/slack/thread-buffer.ts` | **New** — in-memory debounced buffer with dependency chaining | 2 |
| `src/slack/HEURISTICS.md` | **New** — Slack routing/buffering heuristics documentation | 2b |
| `src/tests/slack-thread-buffer.test.ts` | **New** — buffer unit tests | 3 |
| `src/tests/slack-router.test.ts` | Modify — add thread follow-up test cases | 3 |

**No migration needed.** No schema changes. Feature flags: `ADDITIVE_SLACK`, `ADDITIVE_SLACK_BUFFER_MS`.

---

## Resolved Decisions

1. **Initial @mention message** → Always instant. Never buffered. Only subsequent non-mention thread messages enter the buffer.
2. **Buffer debounce** → Configurable via `ADDITIVE_SLACK_BUFFER_MS` env var (default 10s).
3. **Thread context coupling** → Accepted. Use `getSlackApp().client` singleton.
4. **Task status for buffered flushes** → Always `pending`. Use `dependsOn` to chain to the latest active task in the thread.
5. **`/now` command** → Instant flush, no dependency. Makes the task immediately pickable.
