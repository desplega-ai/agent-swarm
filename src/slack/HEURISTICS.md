# Slack Routing & Buffering Heuristics

This document covers all heuristics used by the Slack integration for message routing, buffering, and task creation.

## Thread Follow-up Routing

When someone @mentions the bot in a thread, the router checks whether a worker agent is already active in that thread before falling back to the lead agent.

**Routing priority (in order):**

1. `swarm#<uuid>` — explicit agent targeting (always wins)
2. `swarm#all` — broadcast to all workers
3. **Thread follow-up** — if in a thread and a worker is actively working there, route to that worker
4. **Lead fallback** — if the bot was @mentioned and no other match, route to lead agent

**Thread follow-up conditions:**
- Message must be in a thread (`thread_ts` present)
- An agent must have an active task (`in_progress` or `pending`) linked to that thread via `slackChannelId` + `slackThreadTs`
- The matched agent must not be `offline`

**Why this matters:** Without thread follow-up routing, every @mention in a thread goes to the lead, who then has to re-delegate. This shortcut sends the message directly to the worker already handling that conversation.

---

## Additive Slack Buffer

**Feature flag:** `ADDITIVE_SLACK=true` (disabled by default)

When enabled, thread replies that do NOT @mention the bot are captured, buffered, and batched into a single follow-up task. This allows humans to give multi-message feedback in a thread without needing to @mention the bot each time.

### How it works

1. A human sends a non-@mention message in a thread where the swarm is already active (has existing tasks)
2. The message enters an in-memory buffer keyed by `channelId:threadTs`
3. A debounce timer starts (default 10 seconds)
4. Additional messages within the window are appended to the buffer, resetting the timer each time
5. When the timer expires, all buffered messages are flushed into a single task

### Buffer flush behavior

- All buffered messages are concatenated with `---` separators
- The task is created as `pending` status
- If there is an active task in the thread, the new task gets `dependsOn` set to it (dependency chaining)
- If there is no active task, the new task has no dependency and is immediately pickable

### Important: Initial @mentions are never buffered

The first @mention in a thread always creates a task instantly. Only subsequent non-mention replies enter the buffer. This ensures responsiveness for explicit requests.

### In-memory tradeoffs

- Buffer is lost on server restart (acceptable since the 10s window is tiny)
- No persistence across process restarts
- Single-process only (no clustering support)

---

## `!now` Command

**Syntax:** `/now [optional message]`

Used inside a thread with an active buffer to flush immediately, bypassing the debounce timer and dependency chain.

**Behavior:**
- If text follows `!now`, it is appended to the buffer before flushing
- The buffer is flushed with `immediate=true`, meaning **no `dependsOn`** is set
- The resulting task is immediately pickable by any available agent
- Works only when `ADDITIVE_SLACK=true` and in a thread with swarm activity

**Use case:** When you have been adding context to a thread and want the swarm to pick it up right now, rather than waiting for the debounce or for the current task to finish.

---

## Dependency Chaining

When the additive buffer flushes normally (not via `!now`), the created task uses `dependsOn` to chain to the latest active task in the thread.

**Query:** Finds the most recent `in_progress` or `pending` task matching the thread's `slackChannelId` + `slackThreadTs`, ordered by `createdAt DESC`.

**Effect:** The follow-up task stays in `pending` until the depended-on task completes. This prevents workers from picking up follow-up context before the original task is done.

**`!now` override:** Using `!now` creates the task without any `dependsOn`, making it immediately available regardless of other active tasks.

---

## Feature Flags

| Flag | Default | Description |
|------|---------|-------------|
| `ADDITIVE_SLACK` | `false` | Enables non-mention thread message buffering and batching |
| `ADDITIVE_SLACK_BUFFER_MS` | `10000` (10s) | Debounce window in milliseconds for the thread buffer |

Both are read from environment variables. `ADDITIVE_SLACK` must be exactly `"true"` to enable. `ADDITIVE_SLACK_BUFFER_MS` is parsed as a number with fallback to 10000.

---

## Feedback Reactions Reference

| Event | Slack Feedback | Description |
|-------|---------------|-------------|
| First non-mention message buffered | :eyes: reaction | Acknowledges the message was captured |
| Additional message appended to buffer | :heavy_plus_sign: reaction | Indicates the message was added to existing buffer |
| `!now` command used | :zap: reaction | Confirms instant flush was triggered |
| Buffer flushed (with dependency) | :satellite: thread message | "N follow-up message(s) queued pending completion of current task" |
| Buffer flushed (no dependency / `!now`) | :satellite: thread message | "N follow-up message(s) batched into task" |
