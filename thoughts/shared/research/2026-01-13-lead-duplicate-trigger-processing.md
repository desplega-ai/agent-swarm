---
date: 2026-01-13T10:30:00-08:00
researcher: Claude
git_commit: 3302f5c8a785cfb1bc1c213df9db2bddffbc7762
branch: main
repository: agent-swarm
topic: "Lead agent picking up triggers multiple times with concurrency"
tags: [research, codebase, concurrency, polling, triggers, lead-agent, inbox-messages, slack, deduplication]
status: complete
last_updated: 2026-01-13
last_updated_by: Claude
---

# Research: Lead Agent Duplicate Trigger Processing with Concurrency

**Date**: 2026-01-13T10:30:00-08:00
**Researcher**: Claude
**Git Commit**: 3302f5c8a785cfb1bc1c213df9db2bddffbc7762
**Branch**: main
**Repository**: agent-swarm

## Research Question

With concurrency enabled, the lead agent picks up triggers (like messages from chat, Slack, etc.) multiple times instead of only once. How does this happen?

## Summary

The lead agent can process the same triggers multiple times due to a lack of atomic "claim" mechanisms for certain trigger types. When `MAX_CONCURRENT_TASKS > 1`, the runner can spawn multiple Claude processes concurrently. Each poll request to `/api/poll` can return the same unread inbox messages or mentions because these triggers are not marked as "claimed" when returned - they remain in their original state until explicitly processed by the agent.

This contrasts with `task_assigned` triggers, which use an atomic `startTask()` call to immediately mark tasks as `in_progress`, preventing duplicate pickup.

## Detailed Findings

### Polling Architecture

#### Client-Side Polling Loop
- **File**: `src/commands/runner.ts:823-911`
- The main loop polls for triggers when the agent has capacity (`activeTasks.size < maxConcurrent`)
- With `MAX_CONCURRENT_TASKS > 1`, the loop can spawn multiple Claude processes concurrently
- Each process operates independently without knowledge of other running processes

#### Poll Endpoint
- **File**: `src/http.ts:344-453`
- Returns triggers in priority order within a transaction
- Transaction provides read consistency within a single poll, not across multiple polls

### Trigger Types and Their State Management

| Trigger Type | State Change on Poll | Prevents Duplicates |
|--------------|---------------------|---------------------|
| `task_offered` | None | **No** |
| `task_assigned` | `startTask()` → `in_progress` | **Yes** |
| `slack_inbox_message` | None | **No** |
| `unread_mentions` | None | **No** |
| `tasks_finished` | None (uses `since` param) | **Partial** |
| `pool_tasks_available` | None | **No** |

### Affected Trigger: `slack_inbox_message`

**Location**: `src/http.ts:396-406`

```typescript
const unreadInbox = getUnreadInboxMessages(myAgentId);
if (unreadInbox.length > 0) {
  return {
    trigger: {
      type: "slack_inbox_message",
      count: unreadInbox.length,
      messages: unreadInbox.slice(0, 5),
    },
  };
}
```

The `getUnreadInboxMessages()` function (`src/be/db.ts:2377-2384`) simply queries:
```sql
SELECT * FROM inbox_messages WHERE agentId = ? AND status = 'unread' ORDER BY createdAt ASC
```

Messages remain `unread` until explicitly marked via:
- `markInboxMessageResponded()` - called by `slack-reply` tool
- `markInboxMessageDelegated()` - called by `inbox-delegate` tool
- `markInboxMessageRead()` - defined but **never called** in the codebase

### Affected Trigger: `unread_mentions`

**Location**: `src/http.ts:408-417`

```typescript
const inbox = getInboxSummary(myAgentId);
if (inbox.mentionsCount > 0) {
  return {
    trigger: {
      type: "unread_mentions",
      mentionsCount: inbox.mentionsCount,
    },
  };
}
```

The `getInboxSummary()` function (`src/be/db.ts:1858-1885`) counts mentions in unread messages. There's no mechanism to mark mentions as processed.

### Protected Trigger: `task_assigned`

**Location**: `src/http.ts:376-391`

```typescript
if (hasCapacity(myAgentId)) {
  const pendingTask = getPendingTaskForAgent(myAgentId);
  if (pendingTask) {
    // Mark task as in_progress immediately to prevent duplicate polling
    startTask(pendingTask.id);
    return {
      trigger: {
        type: "task_assigned",
        taskId: pendingTask.id,
        task: { ...pendingTask, status: "in_progress" },
      },
    };
  }
}
```

The `startTask()` call (`src/be/db.ts:779-799`) atomically transitions the task to `in_progress`:
```sql
UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = ... WHERE id = ? RETURNING *
```

This prevents subsequent polls from returning the same task since `getPendingTaskForAgent()` only queries `status = 'pending'`.

### Existing Deduplication Mechanisms (Not Related to Polling)

#### Slack Event Deduplication
- **File**: `src/slack/handlers.ts:106-118`
- Uses a `Set<string>` with 60s TTL to prevent duplicate Slack events
- Key format: `${channel}:${timestamp}`
- **Purpose**: Prevents Slack's own duplicate event delivery
- **Does not**: Prevent duplicate polling returns

#### GitHub Event Deduplication
- **File**: `src/github/handlers.ts:7-48`
- Uses a `Map<string, number>` with 60s TTL
- Key formats: `pr:${repo}:${number}:${action}`, `issue:${repo}:${number}:${action}`, `comment:${repo}:${commentId}`
- **Purpose**: Prevents GitHub webhook duplicate delivery
- **Does not**: Prevent duplicate polling returns

### Concurrency Flow with Duplicates

1. Lead agent has `MAX_CONCURRENT_TASKS = 2`
2. Poll #1 returns `slack_inbox_message` with messages A, B, C
3. Claude process #1 spawns to handle messages A, B, C
4. Before process #1 processes messages, poll #2 occurs
5. Poll #2 returns same `slack_inbox_message` with messages A, B, C (still `unread`)
6. Claude process #2 spawns to handle same messages A, B, C
7. Both processes attempt to respond to or delegate the same messages

## Code References

- `src/commands/runner.ts:823-911` - Main polling loop
- `src/commands/runner.ts:786` - `MAX_CONCURRENT_TASKS` environment variable
- `src/commands/runner.ts:831` - Capacity check: `state.activeTasks.size < state.maxConcurrent`
- `src/http.ts:344-453` - Poll endpoint
- `src/http.ts:396-406` - Inbox message trigger (no state change)
- `src/http.ts:381-388` - Task assigned trigger (with `startTask()`)
- `src/be/db.ts:2377-2384` - `getUnreadInboxMessages()` query
- `src/be/db.ts:2386-2394` - `markInboxMessageRead()` (unused)
- `src/be/db.ts:779-799` - `startTask()` atomic status update
- `src/slack/handlers.ts:106-118` - Slack event deduplication (separate concern)

## Architecture Documentation

### Polling State Machine

```
               No Trigger                    Has Capacity
   ┌─────────────────────────────────────────────────────────┐
   │                                                         │
   ▼                                                         │
┌────────┐    Poll Timeout     ┌─────────────┐    Trigger   │
│  Idle  │ ◀───────────────── │   Polling   │ ─────────────▶│
└────────┘                     └─────────────┘               │
   │                                │                        │
   │         At Capacity            │                        │
   │       (sleep 1 sec)            ▼                        │
   │                         ┌─────────────┐                 │
   └───────────────────────▶ │  Spawning   │ ────────────────┘
                             │   Claude    │
                             └─────────────┘
```

### Trigger State Protection Matrix

```
┌────────────────────┬─────────────────────────────────────────┐
│   Trigger Type     │           State Protection              │
├────────────────────┼─────────────────────────────────────────┤
│ task_assigned      │ startTask() → in_progress (PROTECTED)   │
├────────────────────┼─────────────────────────────────────────┤
│ task_offered       │ None (VULNERABLE)                       │
├────────────────────┼─────────────────────────────────────────┤
│ slack_inbox_msg    │ None (VULNERABLE)                       │
├────────────────────┼─────────────────────────────────────────┤
│ unread_mentions    │ None (VULNERABLE)                       │
├────────────────────┼─────────────────────────────────────────┤
│ tasks_finished     │ since param (PARTIALLY PROTECTED)       │
├────────────────────┼─────────────────────────────────────────┤
│ pool_tasks_avail   │ None (VULNERABLE but informational)     │
└────────────────────┴─────────────────────────────────────────┘
```

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-01-13-agent-concurrency.md` - Main concurrency implementation plan
- `thoughts/shared/plans/2026-01-12-lead-inbox-model.md` - Lead inbox model design
- `thoughts/shared/plans/2025-12-23-runner-level-polling.md` - Runner polling architecture
- `thoughts/shared/research/2025-12-22-runner-loop-architecture.md` - Runner loop research

## Open Questions

1. Should `slack_inbox_message` triggers use an atomic "claim" mechanism similar to `task_assigned`?
2. Should there be a new intermediate status like `processing` for inbox messages?
3. How should `unread_mentions` be protected from duplicate processing?
4. Should the runner maintain a set of in-flight trigger IDs to prevent respawning for the same trigger?
