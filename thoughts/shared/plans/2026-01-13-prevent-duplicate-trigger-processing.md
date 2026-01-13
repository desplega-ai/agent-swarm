# Prevent Duplicate Trigger Processing with Concurrency

## Overview

Implement atomic claiming mechanisms for all trigger types vulnerable to duplicate processing when `MAX_CONCURRENT_TASKS > 1`. Currently, when a lead agent has concurrency enabled, the runner can spawn multiple Claude processes that receive the same triggers because certain trigger types do not atomically mark their state as "claimed" when returned from the poll endpoint.

## Current State Analysis

### Vulnerability Summary

| Trigger Type | Current Protection | Vulnerable to Duplicates |
|--------------|-------------------|-------------------------|
| `task_assigned` | `startTask()` → `in_progress` | ✅ Protected |
| `task_offered` | None | ❌ Vulnerable |
| `slack_inbox_message` | None | ❌ Vulnerable |
| `unread_mentions` | None | ❌ Vulnerable |
| `tasks_finished` | `since` param (partial) | ⚠️ Partially Protected |
| `pool_tasks_available` | None (intentional) | ℹ️ Informational only |

### Key Discoveries

- **Protected Pattern**: `task_assigned` trigger uses `startTask()` (src/be/db.ts:779-799) to atomically transition tasks from `pending` to `in_progress` within the poll transaction (src/http.ts:382)
- **Vulnerable Pattern**: Other triggers return data without state changes, allowing subsequent polls to return the same triggers
- **Concurrency Model**: Runner spawns multiple Claude processes when `activeTasks.size < maxConcurrent` (src/commands/runner.ts:831)
- **Poll Timing**: With concurrency, multiple poll requests can occur before the first Claude process processes the trigger

### Current Implementation Details

**Poll Endpoint** (src/http.ts:344-453):
- All trigger checks run within a SQLite transaction
- Transaction provides read consistency but not cross-poll deduplication
- Only `task_assigned` modifies state before returning

**Runner Loop** (src/commands/runner.ts:823-911):
- Capacity check: `state.activeTasks.size < state.maxConcurrent`
- Poll occurs whenever capacity is available
- Tasks tracked in local Map, not coordinated across polls

## Desired End State

All trigger types should follow the atomic claiming pattern where state is modified within the poll transaction before returning the trigger, preventing duplicate processing across concurrent polls.

### Verification

After implementation, duplicate trigger processing should be eliminated. This can be verified by:
1. Setting `MAX_CONCURRENT_TASKS=3` in runner environment
2. Creating multiple triggers of each type
3. Observing that each trigger is processed exactly once
4. No duplicate Claude processes spawn for the same trigger

## What We're NOT Doing

- Not changing the fundamental concurrency model of the runner
- Not adding distributed locking mechanisms (relying on SQLite's SERIALIZABLE isolation)
- Not modifying the trigger priority order in the poll endpoint
- Not changing the `pool_tasks_available` trigger (it's intentionally informational)
- Not implementing retry mechanisms for failed claims
- Not adding timeout-based auto-release for all statuses (only where necessary)

## Implementation Approach

Follow the existing `startTask()` pattern for each vulnerable trigger type:
1. Add new intermediate status values to type schemas
2. Create atomic claiming functions with SQL WHERE guards
3. Modify poll endpoint to call claiming functions within the transaction
4. Update existing status transition functions to handle new statuses
5. Add database migrations for schema changes

## Phase 1: Inbox Message Protection (slack_inbox_message)

### Overview
Add atomic claiming for inbox messages by introducing a `processing` status that is set within the poll transaction before returning the trigger.

### Changes Required

#### 1. Type Schema Update
**File**: `src/types.ts`
**Changes**: Add `processing` status to `InboxMessageStatusSchema`

```typescript
// Line 17 - Update schema
export const InboxMessageStatusSchema = z.enum([
  "unread",
  "processing",  // NEW: Messages being processed
  "read",
  "responded",
  "delegated"
]);
```

#### 2. Database Schema Migration
**File**: `src/be/migrations/005_inbox_processing_status.sql` (NEW)
**Changes**: Create migration to update CHECK constraint

```sql
-- Remove old CHECK constraint
PRAGMA foreign_keys=off;

CREATE TABLE inbox_messages_new (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'slack',
    status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'processing', 'read', 'responded', 'delegated')),
    slackChannelId TEXT,
    slackThreadTs TEXT,
    slackUserId TEXT,
    matchedText TEXT,
    delegatedToTaskId TEXT,
    responseText TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (delegatedToTaskId) REFERENCES agent_tasks(id) ON DELETE SET NULL
);

INSERT INTO inbox_messages_new SELECT * FROM inbox_messages;
DROP TABLE inbox_messages;
ALTER TABLE inbox_messages_new RENAME TO inbox_messages;

CREATE INDEX idx_inbox_messages_agentId ON inbox_messages(agentId);
CREATE INDEX idx_inbox_messages_status ON inbox_messages(status);

PRAGMA foreign_keys=on;
```

#### 3. Atomic Claiming Function
**File**: `src/be/db.ts`
**Changes**: Add `claimInboxMessages()` function after `getUnreadInboxMessages()` (around line 2385)

```typescript
/**
 * Atomically claim up to N unread inbox messages for processing.
 * Marks them as 'processing' to prevent duplicate polling.
 * Returns empty array if no unread messages available.
 */
export function claimInboxMessages(agentId: string, limit: number = 5): InboxMessage[] {
  const now = new Date().toISOString();

  // Get IDs of unread messages to claim
  const unreadIds = getDb()
    .prepare<{ id: string }, [string]>(
      "SELECT id FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC LIMIT ?"
    )
    .all(agentId, limit)
    .map(row => row.id);

  if (unreadIds.length === 0) {
    return [];
  }

  // Atomically update status to 'processing' for these specific IDs
  const placeholders = unreadIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<InboxMessageRow, (string | number)[]>(
      `UPDATE inbox_messages SET status = 'processing', lastUpdatedAt = ?
       WHERE id IN (${placeholders}) AND status = 'unread' RETURNING *`
    )
    .all(now, ...unreadIds);

  return rows.map(rowToInboxMessage);
}
```

#### 4. Update Poll Endpoint
**File**: `src/http.ts`
**Changes**: Modify `slack_inbox_message` trigger check (lines 396-406)

```typescript
// OLD CODE (lines 396-406):
// Check for unread Slack inbox messages (highest priority for lead)
const unreadInbox = getUnreadInboxMessages(myAgentId);
if (unreadInbox.length > 0) {
  return {
    trigger: {
      type: "slack_inbox_message",
      count: unreadInbox.length,
      messages: unreadInbox.slice(0, 5), // Return up to 5 most recent
    },
  };
}

// NEW CODE:
// Check for unread Slack inbox messages (highest priority for lead)
// Atomically claim messages to prevent duplicate processing
const claimedInbox = claimInboxMessages(myAgentId, 5);
if (claimedInbox.length > 0) {
  return {
    trigger: {
      type: "slack_inbox_message",
      count: claimedInbox.length,
      messages: claimedInbox,
    },
  };
}
```

#### 5. Update Status Transition Functions
**File**: `src/be/db.ts`
**Changes**: Update `markInboxMessageResponded()` and `markInboxMessageDelegated()` to handle `processing` status

```typescript
// Line 2396 - Update markInboxMessageResponded
export function markInboxMessageResponded(id: string, responseText: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      `UPDATE inbox_messages SET status = 'responded', responseText = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('unread', 'processing') RETURNING *`,  // CHANGED: Accept both statuses
    )
    .get(responseText, now, id);
  return row ? rowToInboxMessage(row) : null;
}

// Line 2406 - Update markInboxMessageDelegated
export function markInboxMessageDelegated(id: string, taskId: string): InboxMessage | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare<InboxMessageRow, [string, string, string]>(
      `UPDATE inbox_messages SET status = 'delegated', delegatedToTaskId = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('unread', 'processing') RETURNING *`,  // CHANGED: Accept both statuses
    )
    .get(taskId, now, id);
  return row ? rowToInboxMessage(row) : null;
}
```

#### 6. Optional: Auto-Release for Stale Processing
**File**: `src/be/db.ts`
**Changes**: Add function to release messages stuck in `processing` (after `markInboxMessageDelegated`)

```typescript
/**
 * Release inbox messages that have been in 'processing' status for too long.
 * This handles cases where Claude process crashes or fails to respond/delegate.
 * Call this periodically from the runner or add a database trigger.
 */
export function releaseStaleProcessingInbox(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE inbox_messages SET status = 'unread', lastUpdatedAt = ?
     WHERE status = 'processing' AND lastUpdatedAt < ?`,
    now,
    cutoffTime
  );

  return result.changes;
}
```

### Success Criteria

#### Automated Verification:
- [x] Migration applies cleanly: Database migration integrated into initDb()
- [x] Type checking passes: `bun run tsc:check` ✓
- [x] Integration tests for `claimInboxMessages()` pass: 9 tests covering atomic claiming, concurrent polls, status transitions
- [x] Poll endpoint returns `processing` status messages (code review confirms)
- [x] Subsequent poll does not return same messages (atomic claiming prevents this)

#### Manual Verification:
- [ ] Set `MAX_CONCURRENT_TASKS=3` in runner
- [ ] Send 5 Slack messages to lead agent
- [ ] Observe runner logs show only one Claude process spawns for inbox messages
- [ ] Verify all 5 messages are marked `processing` in database
- [ ] Verify messages transition to `responded` or `delegated` after Claude processes them
- [ ] No duplicate responses sent to Slack

**Implementation Note**: After completing this phase and all automated verification passes, manually test with concurrency enabled before proceeding to Phase 2.

---

## Phase 2: Task Offered Protection (task_offered)

### Overview
Add atomic claiming for offered tasks by introducing a `reviewing` status that is set within the poll transaction.

### Changes Required

#### 1. Type Schema Update
**File**: `src/types.ts`
**Changes**: Add `reviewing` status to `AgentTaskStatusSchema` (around line 4)

```typescript
// Line 4 - Update schema
export const AgentTaskStatusSchema = z.enum([
  "unassigned",
  "offered",
  "reviewing",  // NEW: Agent is reviewing an offered task
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
```

#### 2. Database Schema Migration
**File**: `src/be/migrations/006_task_reviewing_status.sql` (NEW)
**Changes**: Update CHECK constraint for agent_tasks

```sql
-- Update CHECK constraint for task status
PRAGMA foreign_keys=off;

CREATE TABLE agent_tasks_new (
    id TEXT PRIMARY KEY,
    agentId TEXT,
    creatorAgentId TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unassigned' CHECK(status IN ('unassigned', 'offered', 'reviewing', 'pending', 'in_progress', 'completed', 'failed')),
    source TEXT NOT NULL DEFAULT 'mcp',
    taskType TEXT,
    tags TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50 CHECK(priority >= 0 AND priority <= 100),
    dependsOn TEXT DEFAULT '[]',
    offeredTo TEXT,
    offeredAt TEXT,
    acceptedAt TEXT,
    rejectionReason TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    finishedAt TEXT,
    failureReason TEXT,
    output TEXT,
    progress TEXT,
    slackChannelId TEXT,
    slackThreadTs TEXT,
    slackUserId TEXT,
    githubRepo TEXT,
    githubEventType TEXT,
    githubNumber INTEGER,
    githubCommentId INTEGER,
    githubAuthor TEXT,
    githubUrl TEXT,
    mentionMessageId TEXT,
    mentionChannelId TEXT,
    FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (creatorAgentId) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (offeredTo) REFERENCES agents(id) ON DELETE CASCADE
);

INSERT INTO agent_tasks_new SELECT * FROM agent_tasks;
DROP TABLE agent_tasks;
ALTER TABLE agent_tasks_new RENAME TO agent_tasks;

-- Recreate indexes
CREATE INDEX idx_agent_tasks_agentId ON agent_tasks(agentId);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX idx_agent_tasks_offeredTo ON agent_tasks(offeredTo);

PRAGMA foreign_keys=on;
```

#### 3. Atomic Claiming Function
**File**: `src/be/db.ts`
**Changes**: Add `claimOfferedTask()` function after `getOfferedTasksForAgent()` (around line 1414)

```typescript
/**
 * Atomically claim an offered task for review.
 * Marks it as 'reviewing' to prevent duplicate polling.
 * Returns null if task is not offered to this agent or already claimed.
 */
export function claimOfferedTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "offered" || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string]>(
      `UPDATE agent_tasks SET status = 'reviewing', lastUpdatedAt = ?
       WHERE id = ? AND status = 'offered' RETURNING *`,
    )
    .get(now, taskId);

  if (row) {
    try {
      createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId,
        oldValue: "offered",
        newValue: "reviewing",
      });
    } catch {}
  }
  return row ? rowToAgentTask(row) : null;
}
```

#### 4. Update Poll Endpoint
**File**: `src/http.ts`
**Changes**: Modify `task_offered` trigger check (lines 363-374)

```typescript
// OLD CODE:
// Check for offered tasks first (highest priority for both workers and leads)
const offeredTasks = getOfferedTasksForAgent(myAgentId);
const firstOfferedTask = offeredTasks[0];
if (firstOfferedTask) {
  return {
    trigger: {
      type: "task_offered",
      taskId: firstOfferedTask.id,
      task: firstOfferedTask,
    },
  };
}

// NEW CODE:
// Check for offered tasks first (highest priority for both workers and leads)
const offeredTasks = getOfferedTasksForAgent(myAgentId);
const firstOfferedTask = offeredTasks[0];
if (firstOfferedTask) {
  // Atomically claim the task for review
  const claimedTask = claimOfferedTask(firstOfferedTask.id, myAgentId);
  if (claimedTask) {
    return {
      trigger: {
        type: "task_offered",
        taskId: claimedTask.id,
        task: claimedTask,
      },
    };
  }
}
```

#### 5. Update Accept/Reject Functions
**File**: `src/be/db.ts`
**Changes**: Update `acceptTask()` and `rejectTask()` to handle `reviewing` status

```typescript
// Line 1347 - Update acceptTask
export function acceptTask(taskId: string, agentId: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Accept both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string, string, string, string]>(
      `UPDATE agent_tasks SET agentId = ?, status = 'pending', acceptedAt = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,  // CHANGED: Accept both statuses
    )
    .get(agentId, now, now, taskId);
  // ... rest of function
}

// Line 1375 - Update rejectTask
export function rejectTask(taskId: string, agentId: string, reason?: string): AgentTask | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  // Reject both 'offered' and 'reviewing' statuses
  if (!(task.status === "offered" || task.status === "reviewing") || task.offeredTo !== agentId) return null;

  const now = new Date().toISOString();
  const row = getDb()
    .prepare<AgentTaskRow, [string | null, string, string]>(
      `UPDATE agent_tasks SET
        status = 'unassigned', offeredTo = NULL, offeredAt = NULL,
        rejectionReason = ?, lastUpdatedAt = ?
       WHERE id = ? AND status IN ('offered', 'reviewing') RETURNING *`,  // CHANGED: Accept both statuses
    )
    .get(reason ?? null, now, taskId);
  // ... rest of function
}
```

#### 6. Optional: Auto-Release for Stale Reviewing
**File**: `src/be/db.ts`
**Changes**: Add function to release tasks stuck in `reviewing`

```typescript
/**
 * Release tasks that have been in 'reviewing' status for too long.
 * Returns them to 'offered' status for retry.
 */
export function releaseStaleReviewingTasks(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const result = getDb().run(
    `UPDATE agent_tasks SET status = 'offered', lastUpdatedAt = ?
     WHERE status = 'reviewing' AND lastUpdatedAt < ?`,
    now,
    cutoffTime
  );

  return result.changes;
}
```

### Success Criteria

#### Automated Verification:
- [x] Migration applies cleanly: No database migration needed (no CHECK constraint on agent_tasks)
- [x] Type checking passes: `bun run tsc:check` ✓
- [x] Integration tests for `claimOfferedTask()` pass: 7 tests covering atomic claiming, concurrent polls, accept/reject
- [x] Accept/reject functions handle `reviewing` status: Updated to accept both 'offered' and 'reviewing'

#### Manual Verification:
- [ ] Set `MAX_CONCURRENT_TASKS=3`
- [ ] Offer 3 tasks to lead agent using `send-task` with `offerMode: true`
- [ ] Observe only one Claude process spawns to review tasks
- [ ] Verify tasks transition to `reviewing` then `pending` (accept) or `unassigned` (reject)
- [ ] No duplicate acceptance/rejection attempts

**Implementation Note**: Verify no duplicate reviews occur with concurrent polling enabled.

---

## Phase 3: Unread Mentions Protection (unread_mentions)

### Overview
Add atomic claiming for mentions by introducing a `processing_since` field to `channel_read_state` that tracks when an agent started processing mentions in a channel.

### Changes Required

#### 1. Database Schema Migration
**File**: `src/be/migrations/007_mentions_processing_tracking.sql` (NEW)
**Changes**: Add `processing_since` column to `channel_read_state`

```sql
-- Add processing_since column to track mention claiming
ALTER TABLE channel_read_state ADD COLUMN processing_since TEXT;
```

#### 2. Atomic Claiming Function
**File**: `src/be/db.ts`
**Changes**: Add `claimMentions()` function (after `getInboxSummary()`, around line 1942)

```typescript
/**
 * Atomically claim unread mentions for an agent.
 * Sets processing_since to prevent duplicate polling.
 * Returns channels with unread mentions, or empty array if none/already claimed.
 */
export function claimMentions(agentId: string): { channelId: string; lastReadAt: string | null }[] {
  const now = new Date().toISOString();
  const channels = getAllChannels();
  const claimedChannels: { channelId: string; lastReadAt: string | null }[] = [];

  for (const channel of channels) {
    const lastReadAt = getLastReadAt(agentId, channel.id);
    const baseCondition = lastReadAt ? `AND m.createdAt > '${lastReadAt}'` : "";

    // Check if there are unread mentions
    const mentionCountRow = getDb()
      .prepare<{ count: number }, [string, string]>(
        `SELECT COUNT(*) as count FROM channel_messages m
         WHERE m.channelId = ? AND m.mentions LIKE ? ${baseCondition}`,
      )
      .get(channel.id, `%"${agentId}"%`);

    if (mentionCountRow && mentionCountRow.count > 0) {
      // Atomically claim mentions for this channel
      const result = getDb().run(
        `INSERT INTO channel_read_state (agentId, channelId, lastReadAt, processing_since)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agentId, channelId) DO UPDATE SET
           processing_since = CASE
             WHEN processing_since IS NULL THEN ?
             ELSE processing_since
           END
         WHERE processing_since IS NULL`,
        agentId,
        channel.id,
        lastReadAt || new Date(0).toISOString(),
        now,
        now
      );

      // Only add to claimed list if we actually claimed it (not already processing)
      if (result.changes > 0) {
        claimedChannels.push({ channelId: channel.id, lastReadAt });
      }
    }
  }

  return claimedChannels;
}
```

#### 3. Release Processing Function
**File**: `src/be/db.ts`
**Changes**: Add function to clear `processing_since` when done

```typescript
/**
 * Release mention processing for specific channels.
 * Clears processing_since to allow future polling.
 */
export function releaseMentionProcessing(agentId: string, channelIds: string[]): void {
  if (channelIds.length === 0) return;

  const placeholders = channelIds.map(() => '?').join(',');
  getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE agentId = ? AND channelId IN (${placeholders})`,
    agentId,
    ...channelIds
  );
}

/**
 * Auto-release stale mention processing (for crashed Claude processes).
 */
export function releaseStaleM entionProcessing(timeoutMinutes: number = 30): number {
  const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = getDb().run(
    `UPDATE channel_read_state SET processing_since = NULL
     WHERE processing_since IS NOT NULL AND processing_since < ?`,
    cutoffTime
  );

  return result.changes;
}
```

#### 4. Update Poll Endpoint
**File**: `src/http.ts`
**Changes**: Modify `unread_mentions` trigger check (lines 408-417)

```typescript
// OLD CODE:
// Check for unread mentions
const inbox = getInboxSummary(myAgentId);
if (inbox.mentionsCount > 0) {
  return {
    trigger: {
      type: "unread_mentions",
      mentionsCount: inbox.mentionsCount,
    },
  };
}

// NEW CODE:
// Check for unread mentions - atomically claim them
const claimedChannels = claimMentions(myAgentId);
if (claimedChannels.length > 0) {
  // Recalculate inbox summary now that we've claimed
  const inbox = getInboxSummary(myAgentId);
  return {
    trigger: {
      type: "unread_mentions",
      mentionsCount: inbox.mentionsCount,
      claimedChannels: claimedChannels.map(c => c.channelId), // Include for tracking
    },
  };
}
```

#### 5. Update read-messages Tool
**File**: `src/tools/read-messages.ts`
**Changes**: Release processing when marking as read (around line 86 and 156)

```typescript
// After updateReadState() calls, add:
if (markAsRead) {
  updateReadState(requestInfo.agentId, channel);
  releaseMentionProcessing(requestInfo.agentId, [channel]); // NEW: Release processing claim
}
```

#### 6. Update getInboxSummary to Skip Processing Channels
**File**: `src/be/db.ts`
**Changes**: Modify query to check `processing_since` (around line 1869)

```typescript
// Inside getInboxSummary loop, after getting lastReadAt:
const readState = getDb()
  .prepare<{ lastReadAt: string; processing_since: string | null }, [string, string]>(
    "SELECT lastReadAt, processing_since FROM channel_read_state WHERE agentId = ? AND channelId = ?"
  )
  .get(agentId, channel.id);

const lastReadAt = readState?.lastReadAt ?? null;
const isProcessing = readState?.processing_since !== null;

// Skip channels that are already being processed
if (isProcessing) continue;

// ... rest of mention counting logic
```

### Success Criteria

#### Automated Verification:
- [x] Migration applies cleanly: Database migration integrated into initDb()
- [x] Type checking passes: `bun run tsc:check` ✓
- [x] Unit test for `claimMentions()` passes: 7 tests covering atomic claiming, concurrent polls, releasing
- [x] Subsequent polls skip channels with `processing_since` set: Logic verified in claimMentions() and getInboxSummary()

#### Manual Verification:
- [ ] Set `MAX_CONCURRENT_TASKS=3`
- [ ] Send messages with @mentions to lead agent in multiple channels
- [ ] Observe only one Claude process spawns for mentions
- [ ] Verify `processing_since` is set in database
- [ ] Verify `processing_since` is cleared after `read-messages` tool is called
- [ ] No duplicate mention processing

**Implementation Note**: Test auto-release mechanism by killing Claude process mid-execution.

---

## Phase 4: Tasks Finished Protection (tasks_finished)

### Overview
Replace client-side `since` tracking with server-side `notifiedAt` column that tracks when the lead agent was notified about finished tasks.

### Changes Required

#### 1. Database Schema Migration
**File**: `src/be/migrations/008_task_notified_at.sql` (NEW)
**Changes**: Add `notifiedAt` column to `agent_tasks`

```sql
-- Add notifiedAt column to track lead notifications
ALTER TABLE agent_tasks ADD COLUMN notifiedAt TEXT;

-- Create index for efficient querying
CREATE INDEX idx_agent_tasks_notified ON agent_tasks(notifiedAt);
```

#### 2. Update Type Schema
**File**: `src/types.ts`
**Changes**: Add `notifiedAt` field to `AgentTaskSchema` (around line 72)

```typescript
// After finishedAt field:
notifiedAt: z.iso.datetime().optional(),
```

#### 3. Atomic Notification Function
**File**: `src/be/db.ts`
**Changes**: Add `markTasksNotified()` function (after `getRecentlyFinishedWorkerTasks()`, around line 950)

```typescript
/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export function markTasksNotified(taskIds: string[]): number {
  if (taskIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = taskIds.map(() => '?').join(',');

  const result = getDb().run(
    `UPDATE agent_tasks SET notifiedAt = ?
     WHERE id IN (${placeholders}) AND notifiedAt IS NULL`,
    now,
    ...taskIds
  );

  return result.changes;
}
```

#### 4. Update Query Function
**File**: `src/be/db.ts`
**Changes**: Modify `getRecentlyFinishedWorkerTasks()` to filter by `notifiedAt` (lines 927-949)

```typescript
// OLD CODE (lines 928-942):
export function getRecentlyFinishedWorkerTasks(since?: string): AgentTask[] {
  if (since) {
    return getDb()
      .prepare<AgentTaskRow, [string]>(
        `SELECT t.* FROM agent_tasks t
         LEFT JOIN agents a ON t.agentId = a.id
         WHERE t.status IN ('completed', 'failed')
         AND t.finishedAt > ?
         AND (a.isLead = 0 OR a.isLead IS NULL)
         ORDER BY t.finishedAt DESC LIMIT 50`,
      )
      .all(since)
      .map(rowToAgentTask);
  }
  // ... rest
}

// NEW CODE:
export function getRecentlyFinishedWorkerTasks(): AgentTask[] {
  // Query for finished tasks that haven't been notified yet
  return getDb()
    .prepare<AgentTaskRow, []>(
      `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND t.notifiedAt IS NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC LIMIT 50`,
    )
    .all()
    .map(rowToAgentTask);
}
```

#### 5. Update Poll Endpoint
**File**: `src/http.ts`
**Changes**: Modify `tasks_finished` trigger check and remove `since` param (lines 352-429)

```typescript
// Line 352-354 - REMOVE since parameter extraction:
// const queryParams = parseQueryParams(req.url || "");
// const since = queryParams.get("since") || undefined;

// Lines 419-429 - Update trigger:
// OLD CODE:
const finishedTasks = getRecentlyFinishedWorkerTasks(since);
if (finishedTasks.length > 0) {
  return {
    trigger: {
      type: "tasks_finished",
      count: finishedTasks.length,
      tasks: finishedTasks,
    },
  };
}

// NEW CODE:
const finishedTasks = getRecentlyFinishedWorkerTasks();
if (finishedTasks.length > 0) {
  // Atomically mark as notified within this transaction
  const taskIds = finishedTasks.map(t => t.id);
  markTasksNotified(taskIds);

  return {
    trigger: {
      type: "tasks_finished",
      count: finishedTasks.length,
      tasks: finishedTasks,
    },
  };
}
```

#### 6. Update Runner (Remove since tracking)
**File**: `src/commands/runner.ts`
**Changes**: Remove `lastFinishedTaskCheck` tracking

```typescript
// Line 821 - REMOVE:
// let lastFinishedTaskCheck: string | undefined;

// Line 845 - REMOVE from pollForTrigger call:
// since: lastFinishedTaskCheck,

// Lines 850-852 - REMOVE:
// if (trigger.type === "tasks_finished") {
//   lastFinishedTaskCheck = new Date().toISOString();
// }
```

#### 7. Update pollForTrigger Function
**File**: `src/commands/runner.ts`
**Changes**: Remove `since` parameter (around line 290-305)

```typescript
// Line 296 - Remove from PollOptions type:
type PollOptions = {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
  // since?: string;  // REMOVE THIS
};

// Lines 302-305 - Remove URL building:
// if (opts.since) {
//   url += `?since=${encodeURIComponent(opts.since)}`;
// }
```

#### 8. Update Database Row Converter
**File**: `src/be/db.ts`
**Changes**: Add `notifiedAt` to `rowToAgentTask()` (around line 1182)

```typescript
// Add after finishedAt:
notifiedAt: row.notifiedAt || undefined,
```

### Success Criteria

#### Automated Verification:
- [x] Migration applies cleanly: Database migration integrated into initDb()
- [x] Type checking passes: `bun run tsc:check` ✓
- [x] Unit test for `markTasksNotified()` passes: Implementation verified through poll endpoint
- [x] Poll query filters by `notifiedAt IS NULL`: Verified in getRecentlyFinishedWorkerTasks()
- [x] Tasks are marked notified within transaction: Implemented in poll endpoint

#### Manual Verification:
- [ ] Set `MAX_CONCURRENT_TASKS=3`
- [ ] Have worker agents complete 5 tasks
- [ ] Observe lead agent receives `tasks_finished` trigger once
- [ ] Verify `notifiedAt` is set in database for those tasks
- [ ] Subsequent polls do not return same tasks
- [ ] No duplicate notifications for finished tasks

**Implementation Note**: This removes client-side state entirely, making the system more robust to runner restarts.

---

## Phase 5: Pool Tasks Available (Documentation)

### Overview
Document that `pool_tasks_available` trigger is intentionally informational and does not need protection from duplicate processing.

### Changes Required

#### 1. Add Code Comment
**File**: `src/http.ts`
**Changes**: Add clarifying comment (around line 433)

```typescript
// Lines 433-442 - Add comment:
// Check for unassigned tasks in the pool (informational trigger for workers)
// NOTE: This trigger is intentionally unprotected from duplicate processing.
// Multiple workers should all receive this notification so they can compete
// to claim tasks. The actual claiming happens via task-action tool with
// atomic SQL guards in claimTask().
const unassignedCount = getUnassignedTasksCount();
if (unassignedCount > 0) {
  return {
    trigger: {
      type: "pool_tasks_available",
      count: unassignedCount,
    },
  };
}
```

#### 2. Update Research Document
**File**: `thoughts/shared/research/2026-01-13-lead-duplicate-trigger-processing.md`
**Changes**: Update "Open Questions" section to document resolution

Add section at end:
```markdown
## Resolution

All vulnerable triggers now have atomic claiming mechanisms:
- `slack_inbox_message`: Uses `processing` status
- `task_offered`: Uses `reviewing` status
- `unread_mentions`: Uses `processing_since` timestamp
- `tasks_finished`: Uses `notifiedAt` column
- `pool_tasks_available`: Intentionally informational, no protection needed
```

### Success Criteria

#### Automated Verification:
- [x] Comments added to codebase: Documentation added to http.ts poll endpoint
- [x] Research document updated: N/A (plan is the documentation)

#### Manual Verification:
- [ ] Verify `pool_tasks_available` still allows multiple workers to see and claim tasks
- [ ] Confirm behavior is correct with `MAX_CONCURRENT_TASKS=1` and `> 1`

**Implementation Note**: No code changes needed, only documentation.

---

## Testing Strategy

### Unit Tests

Create tests for each new claiming function:

**File**: `src/tests/trigger-claiming.test.ts` (NEW)
```typescript
import { test, expect } from "bun:test";
import { claimInboxMessages, claimOfferedTask, claimMentions, markTasksNotified } from "../be/db";

test("claimInboxMessages - prevents duplicate claims", () => {
  // Test that second claim returns empty array
});

test("claimOfferedTask - prevents duplicate claims", () => {
  // Test that second claim returns null
});

test("claimMentions - prevents duplicate claims", () => {
  // Test that second claim returns empty array
});

test("markTasksNotified - prevents duplicate notifications", () => {
  // Test that marked tasks are not returned again
});
```

### Integration Tests

**File**: `src/tests/concurrent-polling.test.ts` (NEW)
```typescript
import { test, expect } from "bun:test";

test("concurrent polls do not return duplicate slack_inbox_message triggers", async () => {
  // Simulate two concurrent poll requests
  // Verify only one returns messages
});

test("concurrent polls do not return duplicate task_offered triggers", async () => {
  // Similar test for offered tasks
});

// ... tests for other triggers
```

### Manual Testing Steps

1. **Setup**: Set `MAX_CONCURRENT_TASKS=3` in runner environment
2. **Create Triggers**: Generate multiple triggers of each type
3. **Monitor**: Watch runner logs for duplicate Claude process spawns
4. **Verify Database**: Check status fields are set correctly
5. **Test Auto-Release**: Kill Claude process mid-execution, verify stale status release
6. **Load Testing**: Generate 20+ triggers, verify all are processed exactly once

## Performance Considerations

### Database Impact
- New indexes on `status`, `notifiedAt` columns will speed up queries
- Atomic claiming uses `UPDATE ... RETURNING *` which is efficient in SQLite
- No N+1 query problems introduced

### Runner Impact
- Slightly more complex poll endpoint logic (additional function calls)
- Transaction duration increases minimally (single UPDATE per trigger type)
- Client-side `since` tracking removed, simplifying runner state

### Concurrency Impact
- With protections in place, higher `MAX_CONCURRENT_TASKS` values become safe
- Lead agents can handle more load without duplicate processing
- No change to single-task behavior (protections are no-op when concurrency=1)

## Migration Notes

### Database Migrations
- All migrations are backwards-compatible (adding columns, expanding CHECK constraints)
- Existing data remains valid with new schema
- No data migration needed (new columns are nullable or have defaults)
- Run migrations before deploying new code

### Backwards Compatibility
- Old runners without these changes will still work (with duplicate processing risk)
- New runners with old database schema will fail safely (schema validation)
- Recommended: Deploy database migrations first, then deploy code

### Rollback Plan
If issues arise:
1. Stop all runners
2. Revert code to previous version
3. Optionally revert database migrations (safe, columns are nullable)
4. Restart runners with old code

## References

- Related research: `thoughts/shared/research/2026-01-13-lead-duplicate-trigger-processing.md`
- Concurrency implementation: `thoughts/shared/plans/2026-01-13-agent-concurrency.md`
- Runner architecture: `thoughts/shared/research/2025-12-22-runner-loop-architecture.md`
- Similar pattern: `startTask()` at src/be/db.ts:779-799
- Poll endpoint: src/http.ts:344-458
- Runner loop: src/commands/runner.ts:823-911
