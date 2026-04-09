---
date: 2026-04-09T00:00:00Z
topic: "Slack Message Deduplication + Tree-Based Status Messages"
status: completed
autonomy: critical
research: thoughts/taras/brainstorms/2026-04-08-slack-message-deduplication.md
last_updated: 2026-04-09T00:00:00Z
last_updated_by: claude (phase 7)
---

# Plan: Slack Message Deduplication + Tree-Based Status Messages

> **Cross-cutting: Logging** — All phases must include `console.log("[Slack]")` at key decision points: tree renders, slackReplySent flag setting, child task discovery, DM tree posting. This enables E2E debugging via `bun run pm2-logs` or Docker logs.

**Date**: 2026-04-09
**Status**: Ready
**Brainstorm**: `thoughts/taras/brainstorms/2026-04-08-slack-message-deduplication.md`

## Overview

When a Slack-triggered task completes, the thread gets two overlapping messages: (1) the evolving message updated with `task.output`, and (2) the agent's actual `slack-reply`. This plan introduces a `slackReplySent` flag to suppress redundant outcome text, and replaces the flat evolving message with a tree-based status message showing the lead→worker delegation hierarchy with live updates.

## Current State Analysis

**Two independent message flows post to the same Slack thread:**

| Aspect | Evolving Message (Watcher) | slack-reply Tool |
|--------|---------------------------|--------------------|
| **Code** | `src/slack/watcher.ts` polls every 3s | `src/tools/slack-reply.ts` |
| **Method** | `chat.update` — transforms same message | `chat.postMessage` — always new message |
| **Lifecycle** | Assignment → Progress → Completion | Any time during execution |
| **Completion** | `buildCompletedBlocks()` with full `task.output` | Agent's actual detailed response |

**Current tracking:**
- `taskMessages: Map<taskId, {channelId, threadTs, messageTs}>` (`watcher.ts:28`)
- `registerTaskMessage()` called from `handlers.ts:621` after posting assignment summary
- Multiple tasks from same user message share the SAME messageTs (line 620-624)
- Worker child tasks (via `send-task`/`store-progress`) are NOT registered — they fall into the "untracked" path and get NEW completion messages via `sendTaskResponse()`

**No `slackReplySent` flag exists** — the `slack-reply` tool (`src/tools/slack-reply.ts`) posts messages with zero coordination with the watcher.

### Key Discoveries:
- `buildCompletedBlocks()` (`blocks.ts:137`) renders full body text — source of duplication
- `updateToFinal()` (`responses.ts:150`) updates evolving message to completion with full output
- `sendTaskResponse()` (`responses.ts:28`) posts NEW message for untracked/DM tasks
- `getChildTasksByParentId()` doesn't exist — no way to query children today
- `handlers.ts:620-624` registers all assigned tasks to same messageTs — already multi-task aware
- Child tasks inherit Slack metadata via `parentTaskId` in `createTaskExtended()` (`db.ts:1878`)
- DMs use `setAssistantStatus()` (`watcher.ts:53`) — completely separate code path

## Desired End State

1. **No duplicate content** — when an agent uses `slack-reply`, the tree shows `✅ + link` only (no outcome text)
2. **Tree-based status message** — one tree message per "round" (per user message) showing:
   ```
   ⏳ Lead (a1b2c3)
   ├ ⏳ Worker1 (e5f6g7)
   │   Researching Iterable API docs...
   └ ✅ Worker2 (i9j0k1) · 2m 14s
   ```
3. **All task IDs are clickable dashboard links** — `<APP_URL?tab=tasks&task=ID|shortId>`
4. **Live updates** — tree re-renders via `chat.update` as children change state
5. **Failures always show error** — `❌ Worker (link) · Error: ...` regardless of slackReplySent
6. **Cancelled tasks visible** — `🚫 Worker (link) — Cancelled`
7. **DMs get tree messages too** — unified code path, `setAssistantStatus` kept in parallel for typing indicator
8. **Max 8 children visible** — collapse with "and N more..." for large delegations

### Verification of end state:
```bash
bun run tsc:check
bun run lint:fix
bun test
bash scripts/check-db-boundary.sh
```

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — Type check
- `bun run lint:fix` — Lint & format
- `bun test` — Run all unit tests
- `bash scripts/check-db-boundary.sh` — DB boundary enforcement

Key files to check:
- `src/slack/watcher.ts` — Core watcher rewrite
- `src/slack/blocks.ts` — Tree block builder
- `src/slack/responses.ts` — Response functions
- `src/tools/slack-reply.ts` — slackReplySent flag setting
- `src/be/db.ts` — New DB queries
- `src/types.ts` — AgentTask schema update
- `src/be/migrations/034_slack_reply_sent.sql` — New migration

## What We're NOT Doing

- **Changing slack-reply behavior** — it continues posting standalone messages via `chat.postMessage`
- **Embedding reply content in the tree** — tree is status-only, slack-reply is content delivery
- ~~**Multi-level nesting**~~ — Updated: trees now flatten all descendants (grandchildren etc.) as children of the root. This was needed to handle "lead awakened on worker finish" review tasks.
- **Per-message tree** — follow-up user messages create new trees (no infinitely growing trees)
- **Slack app manifest changes** — existing permissions suffice

## Implementation Approach

Seven phases, each independently testable:
1. **slackReplySent flag** — DB + types foundation
2. **Conditional outcome** — dedup fix (ship-worthy on its own)
3. **Tree block builder** — rendering logic in blocks.ts
4. **Tree tracking infrastructure** — data structures + DB queries
5. **Tree-based watcher** — rewrite watcher to use trees
6. **DM unification** — remove DM-specific code path
7. **Assignment message as initial tree** — unified tree UX from first message

---

## Phase 1: `slackReplySent` Flag (Foundation)

### Overview
Add a boolean flag on tasks that tracks whether `slack-reply` was called during the task's lifecycle. This is the foundation for all subsequent deduplication logic.

### Changes Required:

#### 1. Database Migration
**File**: `src/be/migrations/034_slack_reply_sent.sql`
**Changes**: Add `slackReplySent` column to `agent_tasks` table.

```sql
ALTER TABLE agent_tasks ADD COLUMN slackReplySent INTEGER DEFAULT 0;

-- Index on parentTaskId for getChildTasks() query (Phase 4)
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parentTaskId ON agent_tasks(parentTaskId);
```

#### 2. AgentTask Schema
**File**: `src/types.ts`
**Changes**: Add `slackReplySent` field to `AgentTaskSchema` after the `slackUserId` field (around line 104).

```typescript
slackReplySent: z.boolean().default(false),
```

#### 3. Row-to-Task Mapping
**File**: `src/be/db.ts`
**Changes**: Update `rowToAgentTask()` to map the new column. The `AgentTaskRow` interface also needs updating. Add a `markTaskSlackReplySent()` function.

In `AgentTaskRow` interface (around line 728), add:
```typescript
slackReplySent: number; // SQLite boolean (0/1)
```

In `rowToAgentTask()` (around line 786), add:
```typescript
slackReplySent: !!row.slackReplySent,
```

New function:
```typescript
export function markTaskSlackReplySent(taskId: string): void {
  getDb().run(
    `UPDATE agent_tasks SET slackReplySent = 1 WHERE id = ?`,
    [taskId],
  );
}
```

#### 4. slack-reply Tool Update
**File**: `src/tools/slack-reply.ts`
**Changes**: After successfully posting the message (line 130, inside the try block after `postMessage`), call `markTaskSlackReplySent()` to set the flag. Only when `taskId` is provided (not `inboxMessageId`).

```typescript
// After successful postMessage, mark task as having a Slack reply
if (taskId) {
  markTaskSlackReplySent(taskId);
}
```

Import `markTaskSlackReplySent` from `@/be/db`.

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly: `rm -f agent-swarm-db.sqlite* && bun run start:http` (check startup logs)
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test`
- [x] DB boundary check passes: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Start server, create a task with Slack context, call slack-reply tool, verify `slackReplySent = 1` in DB:
  ```bash
  sqlite3 agent-swarm-db.sqlite "SELECT id, slackReplySent FROM agent_tasks ORDER BY createdAt DESC LIMIT 5;"
  ```
- [ ] Existing evolving message behavior unchanged (this phase doesn't change rendering)

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Conditional Outcome Display (Dedup Fix)

### Overview
Modify the completion rendering to suppress `task.output` body text when the agent already replied via `slack-reply`. This is the core deduplication fix and is valuable on its own.

### Changes Required:

#### 1. Minimal Completed Blocks
**File**: `src/slack/blocks.ts`
**Changes**: Add a `minimal` option to `buildCompletedBlocks()`. When `minimal: true`, render only the header line (no body sections).

```typescript
export function buildCompletedBlocks(opts: {
  agentName: string;
  taskId: string;
  body: string;
  duration?: string;
  minimal?: boolean; // NEW: true = suppress body (agent already replied via slack-reply)
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  let line = `✅ *${opts.agentName}* (${taskLink})`;
  if (opts.duration) line += ` · ${opts.duration}`;

  const blocks: SlackBlock[] = [sectionBlock(line)];

  // Only include body if not minimal (agent didn't reply via slack-reply)
  if (!opts.minimal) {
    for (const chunk of splitText(opts.body)) {
      blocks.push(sectionBlock(chunk));
    }
  }
  return blocks;
}
```

#### 2. Update `updateToFinal()`
**File**: `src/slack/responses.ts`
**Changes**: In the `task.status === "completed"` branch (line 161), pass `minimal: !!task.slackReplySent` to `buildCompletedBlocks()`. Also compute and pass `duration`.

```typescript
if (task.status === "completed") {
  const output = task.output || "Task completed.";
  const slackOutput = markdownToSlack(output);
  const duration = task.finishedAt && task.createdAt
    ? formatDuration(new Date(task.createdAt), new Date(task.finishedAt))
    : undefined;
  blocks = buildCompletedBlocks({
    agentName,
    taskId: task.id,
    body: slackOutput,
    duration,
    minimal: !!task.slackReplySent,
  });
  text = task.slackReplySent ? `✅ ${agentName} completed` : slackOutput;
}
```

#### 3. Update `sendTaskResponse()`
**File**: `src/slack/responses.ts`
**Changes**: Same treatment in the `task.status === "completed"` branch (line 49). Pass `minimal: !!task.slackReplySent`.

#### 4. Duration Helper
**File**: `src/slack/blocks.ts`
**Changes**: Add and export a `formatDuration()` utility. Note: `date-fns` is already a project dependency (used in `src/claude.ts`), but a simple custom helper avoids the import overhead and gives exact control over the compact format.

```typescript
export function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
```

#### 5. Tests
**File**: `src/tests/slack-blocks.test.ts`
**Changes**: Add tests for:
- `buildCompletedBlocks({ minimal: true })` → no body sections
- `buildCompletedBlocks({ minimal: false })` → body sections present
- `formatDuration()` → various time ranges

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] Blocks test specifically: `bun test src/tests/slack-blocks.test.ts`

#### Manual Verification:
- [ ] Start server, trigger a Slack task where the agent uses `slack-reply`. Verify the evolving message shows only `✅ AgentName (link) · duration` — no body text.
- [ ] Trigger a Slack task where the agent does NOT use `slack-reply` (e.g., a code task). Verify the evolving message still shows the full `task.output` body.
- [ ] Verify failed tasks still show error text regardless of `slackReplySent` (unchanged behavior).

**Implementation Note**: This phase alone solves the core deduplication problem. Pause for manual confirmation.

---

## Phase 3: Tree Block Builder

### Overview
Create the `buildTreeBlocks()` function in `blocks.ts` that renders a delegation tree using Slack mrkdwn. This is pure rendering logic — no watcher changes yet.

### Changes Required:

#### 1. Tree Node Types
**File**: `src/slack/blocks.ts`
**Changes**: Add types for tree rendering.

```typescript
export interface TreeNode {
  taskId: string;
  agentName: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  progress?: string;
  duration?: string;
  slackReplySent?: boolean;
  output?: string;        // Only used when !slackReplySent on completion
  failureReason?: string; // Always shown on failure
  children: TreeNode[];
}
```

#### 2. Tree Block Builder
**File**: `src/slack/blocks.ts`
**Changes**: New function `buildTreeBlocks()`.

Status icons:
- `pending` → `📡` (queued)
- `in_progress` → `⏳`
- `completed` → `✅`
- `failed` → `❌`
- `cancelled` → `🚫`

Tree structure:
- Root node: status + agent name + task link + duration
- Children: `├` / `└` prefix + status + agent name + task link + duration
- Per-child progress text indented under the child node
- Completed children: conditional outcome (body only if `!slackReplySent`)
- Failed children: always show error text
- Max 8 children visible; if more, show "and N more..." line

Output format (single mrkdwn text block):
```
⏳ *Lead* (<link|a1b2c3d4>)
├ ✅ *Worker1* (<link|e5f6g7h8>) · 2m 14s
├ ❌ *Worker2* (<link|i9j0k1l2>) · 45s
│   Error: API rate limit exceeded
└ ⏳ *Worker3* (<link|m3n4o5p6>)
    Setting up Cloud Function...
```

The function returns `SlackBlock[]` with a single `sectionBlock` containing the tree text, plus optionally a cancel action block for in-progress trees.

**Cancel button behavior**: When any task in the tree is in-progress, show a single cancel button. The button's `value` should be the **root task ID** (lead task). Cancelling the root triggers cascade cancellation of children via the existing `cancel-task` MCP tool. If the tree has multiple independent roots (multi-agent assignment), show one cancel button per root.

**Graceful degradation**: If `buildTreeBlocks()` throws (e.g., deleted task, missing agent), catch the error in the watcher and fall back to `buildCompletedBlocks()` / `buildProgressBlocks()` for individual tasks. Log the error as `[Slack] Tree render failed, falling back to flat message`.

#### 3. Tests
**File**: `src/tests/slack-blocks.test.ts`
**Changes**: Comprehensive tests for `buildTreeBlocks()`:
- Single root, no children
- Root + 2 completed children (one with slackReplySent, one without)
- Mixed states (completed, failed, cancelled, in_progress)
- Progress text rendering
- Max children collapse (9+ children → 8 shown + "and 1 more...")
- Error text always shown for failed nodes
- All task IDs are links (when APP_URL is set)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Blocks tests pass: `bun test src/tests/slack-blocks.test.ts`

#### Manual Verification:
- [ ] Review the rendered mrkdwn output in tests — verify tree chars (├ └ │) look correct
- [ ] Verify Slack mrkdwn links render correctly in output format

**Implementation Note**: This phase is pure rendering — no runtime behavior changes. Pause for manual confirmation.

---

## Phase 4: Tree Tracking Infrastructure + DB Queries

### Overview
Replace the flat `taskMessages` map with tree-aware data structures. Add a DB query to discover child tasks. Hook child task creation into tree registration.

### Changes Required:

#### 1. Child Task Query
**File**: `src/be/db.ts`
**Changes**: Add `getChildTasks()` function.

```typescript
export function getChildTasks(parentTaskId: string): AgentTask[] {
  return getDb()
    .prepare<AgentTaskRow, [string]>(
      `SELECT * FROM agent_tasks WHERE parentTaskId = ? ORDER BY createdAt ASC`,
    )
    .all(parentTaskId)
    .map(rowToAgentTask);
}
```

#### 2. Tree-Aware Tracking
**File**: `src/slack/watcher.ts`
**Changes**: Replace `taskMessages` with tree-aware data structures.

```typescript
// Per-round tree state (one tree message per user interaction round)
interface TreeMessageState {
  channelId: string;
  threadTs: string;
  messageTs: string;
  rootTaskIds: Set<string>; // Tasks directly assigned from this round
}

// messageTs → tree state
const treeMessages = new Map<string, TreeMessageState>();

// taskId → messageTs (reverse lookup — includes both root and discovered children)
const taskToTree = new Map<string, string>();
```

#### 3. Registration Functions
**File**: `src/slack/watcher.ts`
**Changes**: Replace `registerTaskMessage()` with `registerTreeMessage()`. Keep backward-compatible export.

```typescript
export function registerTreeMessage(
  taskId: string,
  channelId: string,
  threadTs: string,
  messageTs: string,
): void {
  let tree = treeMessages.get(messageTs);
  if (!tree) {
    tree = { channelId, threadTs, messageTs, rootTaskIds: new Set() };
    treeMessages.set(messageTs, tree);
  }
  tree.rootTaskIds.add(taskId);
  taskToTree.set(taskId, messageTs);
}

// Backward-compatible alias
export const registerTaskMessage = registerTreeMessage;
```

#### 4. Child Discovery in Watcher
**File**: `src/slack/watcher.ts`
**Changes**: Add a helper that, given a tree's root task IDs, fetches all tasks (roots + children) and returns `TreeNode[]` for rendering.

```typescript
function buildTreeNodes(tree: TreeMessageState): TreeNode[] {
  // For each root task, fetch it + its children
  // Returns TreeNode[] suitable for buildTreeBlocks()
}
```

This function:
- Calls `getTaskById()` for each root task ID
- Calls `getChildTasks()` for each root task
- Registers discovered children in `taskToTree` (so they're skipped in flat processing)
- Maps tasks to `TreeNode` objects
- Resolves agent names via `getAgentById()`

#### 5. Tests
**File**: `src/tests/slack-watcher.test.ts`
**Changes**: Add tests for:
- `registerTreeMessage()` — single task, multiple tasks same message
- `buildTreeNodes()` — root only, root + children, multiple roots
- Child discovery registers children in taskToTree

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Watcher tests: `bun test src/tests/slack-watcher.test.ts`

#### Manual Verification:
- [ ] Start server, verify existing evolving message behavior still works (backward compatibility via alias)
- [ ] Query `getChildTasks()` via sqlite3 for a known parent task

**Implementation Note**: Data structures are in place but watcher still uses old rendering. Pause for manual confirmation.

---

## Phase 5: Tree-Based Watcher

### Overview
Rewrite the watcher's polling loop to render tree messages instead of flat per-task messages. This is the core integration that brings all prior phases together.

### Changes Required:

#### 1. Tree Rendering Loop
**File**: `src/slack/watcher.ts`
**Changes**: Add a new `processTreeMessages()` function called from the main interval.

For each tree in `treeMessages`:
1. Call `buildTreeNodes(tree)` to get current state
2. Call `buildTreeBlocks(nodes)` to render
3. Call `chat.update` with the tree message's `messageTs`
4. Track last rendered state to avoid unnecessary updates (compare serialized tree)

#### 2. Skip Tree-Tracked Tasks in Flat Processing
**File**: `src/slack/watcher.ts`
**Changes**: In the existing in-progress and completed task loops, skip tasks that are tracked in `taskToTree`. These are rendered as part of their tree.

```typescript
// In the in-progress loop:
if (taskToTree.has(task.id)) continue; // Rendered in tree

// In the completed loop:
if (taskToTree.has(task.id)) {
  // Don't process individually — the tree handles this
  // But still mark as notified to prevent re-processing
  notifiedCompletions.set(task.id, now);
  continue;
}
```

#### 3. Tree Completion Detection
**File**: `src/slack/watcher.ts`
**Changes**: When ALL tasks in a tree are terminal (completed/failed/cancelled), clean up tracking:
- Remove from `treeMessages`
- Remove all task IDs from `taskToTree`
- Add to `notifiedCompletions`

#### 4. Rate Limiting for Tree Updates
**File**: `src/slack/watcher.ts`
**Changes**: Track last update time per tree message. Don't update more than once per second (reuse `MIN_SEND_INTERVAL`). Compare rendered output to avoid no-op updates.

#### 5. Update `updateToFinal()` Signature
**File**: `src/slack/responses.ts`
**Changes**: Export a new `updateTreeMessage()` function that takes blocks directly (the watcher builds them via `buildTreeBlocks`).

```typescript
export async function updateTreeMessage(
  channelId: string,
  messageTs: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<boolean> {
  const app = getSlackApp();
  if (!app) return false;

  try {
    await app.client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: fallbackText,
      blocks: blocks as any,
    });
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to update tree message:`, error);
    return false;
  }
}
```

#### 6. Tests
**File**: `src/tests/slack-watcher.test.ts`
**Changes**: Add integration tests for:
- Tree rendering triggers on poll cycle
- Child tasks skip flat processing when tracked in tree
- Tree cleanup on all-terminal state
- No-op update when tree state unchanged

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] Watcher tests: `bun test src/tests/slack-watcher.test.ts`

#### Manual Verification:
- [ ] Start server + Docker worker. Send a Slack message that triggers lead delegation to a worker.
- [ ] Verify the assignment message evolves into a tree showing the lead + worker status
- [ ] Verify the tree updates live as the worker progresses
- [ ] Verify on completion: tree shows ✅ for both lead and worker
- [ ] Verify when worker uses slack-reply: tree shows minimal completion (no body)
- [ ] Verify when worker doesn't use slack-reply: tree shows truncated output
- [ ] Verify failed tasks show error text in the tree
- [ ] Verify cancelled tasks show 🚫 in the tree

**Implementation Note**: This is the most complex phase. Pause for thorough manual testing before proceeding.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Lead delegates to 1 worker, worker uses slack-reply
  - Steps: 1. Send @bot message in Slack channel, 2. Watch assignment message evolve into tree, 3. Worker completes with slack-reply
  - Expected: Tree shows `✅ Lead · ✅ Worker` — no body text on worker node
- [ ] TC-2: Lead delegates to 1 worker, worker does NOT use slack-reply
  - Steps: 1. Send @bot a code task, 2. Worker completes without slack-reply
  - Expected: Tree shows worker node with truncated output + "View full response" link
- [ ] TC-3: Lead delegates to 2 workers, one fails
  - Steps: 1. Send @bot a multi-agent task, 2. One worker fails, one succeeds
  - Expected: Tree shows ✅ for success, ❌ + error for failure
- [ ] TC-4: Cancel a task via cancel button
  - Steps: 1. Send @bot message, 2. Click cancel button during execution
  - Expected: Tree shows 🚫 for cancelled task

---

## Phase 6: DM Unification

### Overview
Remove the DM-specific code path in the watcher. DMs get tree messages via `chat.postMessage` like channel threads. Keep `setAssistantStatus()` in parallel for the typing indicator UX.

### Changes Required:

#### 1. Remove DM Branch in Progress Loop
**File**: `src/slack/watcher.ts`
**Changes**: The current `isDM` branch (lines 102-123) uses `setAssistantStatus()` and skips `chat.update`. Remove this branch — DM tasks should go through the same tree rendering path as channel tasks.

**However**, keep `setAssistantStatus()` as a parallel call alongside tree updates for DMs. This gives users the "is typing..." indicator while the tree shows detailed progress.

#### 2. Post Initial Tree Message in DMs
**File**: `src/slack/watcher.ts`
**Changes**: When a DM task enters `in_progress` and has no tracked tree message, post an initial tree message via `chat.postMessage` and register it. This replaces the current `setAssistantStatus`-only behavior.

#### 3. DM Message Posting
**File**: `src/slack/responses.ts`
**Changes**: Ensure `sendWithPersona()` works for DM channels (it already skips persona overrides for DMs — line 206). No changes needed.

#### 4. Tests
**File**: `src/tests/slack-watcher.test.ts`
**Changes**: Add tests for:
- DM tasks get tree messages (not just assistant status)
- Assistant status still set in parallel for DMs
- DM tree updates work via chat.update

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] Watcher tests: `bun test src/tests/slack-watcher.test.ts`

#### Manual Verification:
- [ ] Send a DM to the bot. Verify a tree message appears in the DM thread.
- [ ] Verify the "is typing..." indicator still appears alongside the tree.
- [ ] Verify tree updates in DMs as the task progresses.
- [ ] Verify tree completion in DMs shows same format as channel threads.

**Implementation Note**: Test DMs carefully — they have different Slack API behavior (no persona overrides, assistant thread semantics).

---

## Phase 7: Assignment Message as Initial Tree

### Overview
Modify `handlers.ts` to use `buildTreeBlocks()` for the initial assignment message, so the tree starts in its initial state rather than as flat text that later transforms into a tree.

### Changes Required:

#### 1. Initial Tree Rendering
**File**: `src/slack/handlers.ts`
**Changes**: Replace `buildAssignmentSummaryBlocks(results)` (line 614) with `buildTreeBlocks()` using initial `TreeNode[]` with `pending`/`in_progress` status.

```typescript
// Build initial tree nodes from assignment results
const initialNodes: TreeNode[] = results.assigned.map(({ agentName, taskId }) => ({
  taskId,
  agentName,
  status: "in_progress" as const,
  children: [],
}));

// Add queued tasks
for (const q of results.queued) {
  initialNodes.push({
    taskId: q.taskId,
    agentName: q.agentName,
    status: "pending" as const,
    children: [],
  });
}

const blocks = buildTreeBlocks(initialNodes);
```

#### 2. Keep Failed Assignment Lines
**File**: `src/slack/handlers.ts`
**Changes**: If there are failed assignments (no agent found), append them as context text below the tree.

#### 3. Tests
**File**: `src/slack/handlers.test.ts`
**Changes**: Update existing handler tests to expect tree blocks instead of flat summary blocks.

**File**: `src/tests/slack-blocks.test.ts`
**Changes**: Update or remove the 3 existing `buildAssignmentSummaryBlocks` tests (lines 163-197) since the function is no longer used from handlers. Either:
- Remove tests if the function is deleted
- Keep tests if the function is retained for other potential callers (currently only used in `handlers.ts:614`)

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] Handler tests: `bun test src/slack/handlers.test.ts`
- [x] Block tests: `bun test src/tests/slack-blocks.test.ts`

#### Manual Verification:
- [ ] Send a Slack message. Verify the INITIAL response is already a tree (not flat text).
- [ ] Verify the tree smoothly transitions from initial state → progress → completion.
- [ ] Verify multi-agent assignment shows multiple nodes in initial tree.

**Implementation Note**: Pause for confirmation. After this phase, the full tree UX is complete.

---

## Testing Strategy

### Unit Tests (per phase)
- `src/tests/slack-blocks.test.ts` — `buildTreeBlocks()`, `buildCompletedBlocks({ minimal })`, `formatDuration()`
- `src/tests/slack-watcher.test.ts` — Tree tracking, tree rendering loop, DM unification
- `src/slack/handlers.test.ts` — Initial tree rendering in assignment messages

### Integration Tests
- Watcher integration: mock DB + Slack client, verify full poll-to-update cycle
- Tree lifecycle: assignment → progress → child creation → child completion → tree completion

### Manual E2E
```bash
# Start server
bun run start:http

# Build and start Docker workers
bun run docker:build:worker
docker run --rm -d --name e2e-lead --env-file .env.docker-lead -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:latest
docker run --rm -d --name e2e-worker --env-file .env.docker -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:latest

# Verify agents online
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | jq '.agents[] | {name, isLead, status}'

# Test scenarios in Slack:
# 1. @bot "What's 2+2?" — simple task, worker should use slack-reply → tree shows minimal completion
# 2. @bot "Create a PR that..." — code task, no slack-reply → tree shows output
# 3. @bot in existing thread — follow-up creates new tree
# 4. Cancel a task via button → tree shows 🚫
# 5. DM the bot → tree message appears in DM

# Cleanup
docker stop e2e-lead e2e-worker
kill $(lsof -ti :3013)
```

## References
- Brainstorm: `thoughts/taras/brainstorms/2026-04-08-slack-message-deduplication.md`
- Slack thread follow-up plan: `thoughts/taras/plans/2026-03-12-slack-thread-followup-additive.md`
- Original Slack integration: `thoughts/shared/plans/2025-12-18-slack-integration.md`

## Post-Plan Fixes (E2E Testing)

_Applied: 2026-04-09 during E2E testing_

- **Batching message reuse**: `thread-buffer.ts` now captures `postMessage` response and registers it as a tree message, so "📡 N follow-up batched" messages get updated in-place with tree status
- **Child nesting race condition**: Watcher in-progress/completed loops now walk up the `parentTaskId` chain to find ancestor trees, fixing tasks that complete before the 3s poll discovers them
- **`send-task` parentTaskId auto-default**: `send-task` tool now auto-sets `parentTaskId` from caller's `X-Source-Task-Id` header, ensuring delegated worker tasks are linked to their lead task
- **Direct assignment code path**: Fixed missed `parentTaskId` → `effectiveParentTaskId` in the direct assignment path (the one actually used by leads)
- **Descendant discovery**: `buildTreeNodes()` now recursively discovers all descendants (children, grandchildren) and flattens them as children of the root, keeping trees alive for "lead awakened on worker finish" review tasks
- **Output truncation**: Tree node output truncated to first sentence or 120 chars with ellipsis

## Review Errata

_Reviewed: 2026-04-09 by Claude_

### Applied
- [x] Fixed phase count: "Six phases" → "Seven phases" + added Phase 7 to implementation approach list
- [x] Fixed status text: body said "Draft" but frontmatter said "ready"
- [x] Added cancel button behavior spec: root task cancellation with cascade, per-root buttons for multi-agent trees
- [x] Added graceful degradation strategy: tree render failures fall back to flat messages with error logging
- [x] Added `buildAssignmentSummaryBlocks` test update note to Phase 7 (3 existing tests need updating)
- [x] Added `date-fns` availability note to `formatDuration` section (already a project dependency)
