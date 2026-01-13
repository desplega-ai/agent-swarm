# GitHub Assignment Handling Implementation Plan

## Overview

Extend the GitHub integration to handle PR/issue assignment events. When @desplega-bot is assigned to a PR or issue, a task will be created for the lead agent. When @desplega-bot is unassigned, the related task will be cancelled.

## Current State Analysis

### Existing Architecture
- **GitHub module**: `src/github/` handles webhooks via `POST /api/github/webhook`
- **Supported events**: `pull_request`, `issues`, `issue_comment`, `pull_request_review_comment`
- **Supported actions**: `opened`, `edited` for PRs/issues; `created` for comments
- **Trigger**: Only processes events containing @mention of `GITHUB_BOT_NAME` (default: `agent-swarm-bot`)
- **Bot name configured**: `GITHUB_BOT_NAME=desplega-bot` in environment

### Key Discoveries:
- `handlePullRequest()` and `handleIssue()` in `src/github/handlers.ts:66-183` only handle `opened`/`edited` actions
- GitHub sends assignment events with `action: "assigned"` or `action: "unassigned"` and includes an `assignee` field
- Types in `src/github/types.ts` do not include the `assignee` field
- No existing function to find tasks by `githubRepo` + `githubNumber` - needed for cancellation
- `failTask()` in `src/be/db.ts:1007-1024` can be used to cancel tasks

## Desired End State

1. When @desplega-bot is assigned to a PR or issue (without needing @mention):
   - A task is created for the lead agent (same flow as @mention)
   - An "eyes" reaction is added to acknowledge

2. When @desplega-bot is unassigned from a PR or issue:
   - The related task is found by `githubRepo` + `githubNumber`
   - The task is cancelled with reason "Unassigned from GitHub"

### Verification:
- Assign @desplega-bot to an issue -> Task appears in dashboard
- Unassign @desplega-bot from that issue -> Task status becomes "failed" with cancellation reason

## What We're NOT Doing

- No handling of other assignees (only @desplega-bot assignments)
- No cascading cancellation (if a task has subtasks, they remain active)
- No tracking of who unassigned (we just cancel the task)
- No notification to agents when task is cancelled (they'll see status change via poll)

---

## Phase 0: GitHub App Configuration

### Overview
Ensure the GitHub App is configured to receive assignment events.

### Changes Required:

#### 1. GitHub App Settings
**Location**: GitHub App settings page

**Steps**:
1. Navigate to your GitHub App settings: Settings > Developer settings > GitHub Apps > [Your App]
2. Go to "Permissions & events"
3. Under "Repository permissions":
   - Verify "Issues" is set to at least "Read-only" (should already be configured)
   - Verify "Pull requests" is set to at least "Read-only" (should already be configured)
4. Under "Subscribe to events":
   - Verify "Issues" checkbox is checked (should already be configured)
   - Verify "Pull requests" checkbox is checked (should already be configured)
5. Save changes if any were made

**Note**: The `assigned` and `unassigned` actions are part of the `issues` and `pull_request` event types, not separate events. If you're already receiving issue/PR events, you should receive assignment events too.

### Success Criteria:

#### Manual Verification:
- [ ] Assign @desplega-bot to a test issue/PR
- [ ] Check server logs for `[GitHub] Received issues event` or `[GitHub] Received pull_request event`
- [ ] Confirm the event is received (even if currently ignored with "Only handle opened/edited actions")

**Implementation Note**: Complete this verification before proceeding to code changes.

---

## Phase 1: Type Updates

### Overview
Add `assignee` field to event type interfaces.

### Changes Required:

#### 1. Update Event Types
**File**: `src/github/types.ts`
**Changes**: Add `assignee` field to `GitHubWebhookEvent`, `PullRequestEvent`, and `IssueEvent`

```typescript
// Line 1-6: Update GitHubWebhookEvent to include assignee
export interface GitHubWebhookEvent {
  action: string;
  sender: { login: string };
  repository: { full_name: string; html_url: string };
  installation?: { id: number };
  assignee?: { login: string; id: number };  // Added for assigned/unassigned events
}
```

The `assignee` field is sent by GitHub when `action` is `"assigned"` or `"unassigned"`, containing:
- `login`: The GitHub username of the assignee
- `id`: The GitHub user ID

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun tsc --noEmit`
- [x] Tests pass: `bun test`

---

## Phase 2: Database Query for GitHub Tasks

### Overview
Add a function to find tasks by GitHub repo and number, needed for cancellation.

### Changes Required:

#### 1. Add Query Function
**File**: `src/be/db.ts`
**Changes**: Add `findTaskByGitHub()` function after `getTaskById()` (around line 990)

```typescript
/**
 * Find a task by GitHub repo and issue/PR number
 * Returns the most recent non-completed/failed task for this GitHub entity
 */
export function findTaskByGitHub(
  githubRepo: string,
  githubNumber: number,
): AgentTask | null {
  const row = getDb()
    .prepare<AgentTaskRow, [string, number]>(
      `SELECT * FROM agent_tasks
       WHERE githubRepo = ? AND githubNumber = ?
       AND status NOT IN ('completed', 'failed')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(githubRepo, githubNumber);
  return row ? rowToAgentTask(row) : null;
}
```

#### 2. Export the Function
**File**: `src/be/db.ts`
**Changes**: Ensure the function is exported (it will be at module level)

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun tsc --noEmit`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Create a test task with GitHub metadata, verify `findTaskByGitHub()` returns it

---

## Phase 3: Assignment Handler Updates

### Overview
Update PR and issue handlers to process `assigned` events.

### Changes Required:

#### 1. Add Bot Name Matching Helper
**File**: `src/github/mentions.ts`
**Changes**: Add `isBotAssignee()` function

```typescript
/**
 * Check if the assignee matches our bot name (case-insensitive)
 */
export function isBotAssignee(assigneeLogin: string | undefined): boolean {
  if (!assigneeLogin) return false;
  return assigneeLogin.toLowerCase() === GITHUB_BOT_NAME.toLowerCase();
}
```

#### 2. Update handlePullRequest()
**File**: `src/github/handlers.ts`
**Changes**: Handle `assigned` action

```typescript
// Around line 71-74, update the action check:
export async function handlePullRequest(
  event: PullRequestEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, pull_request: pr, repository, sender, installation, assignee } = event;

  // Handle assigned action - bot was assigned to PR
  if (action === "assigned") {
    // Check if bot was assigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Deduplicate using assignment-specific key
    const eventKey = `pr-assigned:${repository.full_name}:${pr.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    // Same task creation flow as mention-based handling
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-pr");
    const taskDescription = `[GitHub PR #${pr.number}] ${pr.title}\n\nAssigned to: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nBranch: ${pr.head.ref} → ${pr.base.ref}\nURL: ${pr.html_url}\n\nContext:\n${pr.body || pr.title}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

    const task = createTaskExtended(taskDescription, {
      agentId: lead?.id ?? "",
      source: "github",
      taskType: "github-pr",
      githubRepo: repository.full_name,
      githubEventType: "pull_request",
      githubNumber: pr.number,
      githubAuthor: sender.login,
      githubUrl: pr.html_url,
    });

    if (lead) {
      console.log(`[GitHub] Created task ${task.id} for PR #${pr.number} (assigned) -> ${lead.name}`);
    } else {
      console.log(`[GitHub] Created unassigned task ${task.id} for PR #${pr.number} (assigned, no lead available)`);
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, pr.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Only handle opened/edited actions for mention-based flow
  if (action !== "opened" && action !== "edited") {
    return { created: false };
  }

  // ... rest of existing mention handling code
}
```

#### 3. Update handleIssue()
**File**: `src/github/handlers.ts`
**Changes**: Handle `assigned` action (same pattern as PR)

```typescript
// Around line 132-135, update the action check:
export async function handleIssue(
  event: IssueEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { action, issue, repository, sender, installation, assignee } = event;

  // Handle assigned action - bot was assigned to issue
  if (action === "assigned") {
    // Check if bot was assigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Deduplicate using assignment-specific key
    const eventKey = `issue-assigned:${repository.full_name}:${issue.number}`;
    if (isDuplicate(eventKey)) {
      return { created: false };
    }

    // Same task creation flow as mention-based handling
    const lead = findLeadAgent();
    const suggestions = getCommandSuggestions("github-issue");
    const taskDescription = `[GitHub Issue #${issue.number}] ${issue.title}\n\nAssigned to: @${GITHUB_BOT_NAME}\nFrom: ${sender.login}\nRepo: ${repository.full_name}\nURL: ${issue.html_url}\n\nContext:\n${issue.body || issue.title}\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`;

    const task = createTaskExtended(taskDescription, {
      agentId: lead?.id ?? "",
      source: "github",
      taskType: "github-issue",
      githubRepo: repository.full_name,
      githubEventType: "issues",
      githubNumber: issue.number,
      githubAuthor: sender.login,
      githubUrl: issue.html_url,
    });

    if (lead) {
      console.log(`[GitHub] Created task ${task.id} for issue #${issue.number} (assigned) -> ${lead.name}`);
    } else {
      console.log(`[GitHub] Created unassigned task ${task.id} for issue #${issue.number} (assigned, no lead available)`);
    }

    if (installation?.id) {
      addIssueReaction(repository.full_name, issue.number, "eyes", installation.id);
    }

    return { created: true, taskId: task.id };
  }

  // Only handle opened/edited actions for mention-based flow
  if (action !== "opened" && action !== "edited") {
    return { created: false };
  }

  // ... rest of existing mention handling code
}
```

#### 4. Update Imports
**File**: `src/github/handlers.ts`
**Changes**: Import the new helper

```typescript
// Line 2: Update imports
import { detectMention, extractMentionContext, isBotAssignee, GITHUB_BOT_NAME } from "./mentions";
```

#### 5. Export New Function
**File**: `src/github/index.ts`
**Changes**: Export `isBotAssignee`

```typescript
export { detectMention, extractMentionContext, isBotAssignee, GITHUB_BOT_NAME } from "./mentions";
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun tsc --noEmit`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Assign @desplega-bot to an issue -> Task created
- [ ] Assign @desplega-bot to a PR -> Task created
- [ ] "eyes" reaction added to acknowledge assignment

**Implementation Note**: After completing this phase, pause for manual testing before proceeding to unassignment handling.

---

## Phase 4: Unassignment Handler

### Overview
Handle `unassigned` events to cancel related tasks.

### Changes Required:

#### 1. Add Import
**File**: `src/github/handlers.ts`
**Changes**: Import `failTask` and `findTaskByGitHub`

```typescript
// Line 1: Update imports
import { createTaskExtended, getAllAgents, failTask, findTaskByGitHub } from "../be/db";
```

#### 2. Update handlePullRequest() for Unassignment
**File**: `src/github/handlers.ts`
**Changes**: Handle `unassigned` action

```typescript
// Add after the "assigned" handling block, before the opened/edited check:

  // Handle unassigned action - bot was removed from PR
  if (action === "unassigned") {
    // Check if bot was unassigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Find the related task
    const task = findTaskByGitHub(repository.full_name, pr.number);
    if (!task) {
      console.log(`[GitHub] No active task found for PR #${pr.number} to cancel`);
      return { created: false };
    }

    // Cancel the task
    const cancelledTask = failTask(task.id, `Unassigned from GitHub PR #${pr.number}`);
    if (cancelledTask) {
      console.log(`[GitHub] Cancelled task ${task.id} for PR #${pr.number} (unassigned)`);
      return { created: false, taskId: task.id };
    }

    return { created: false };
  }
```

#### 3. Update handleIssue() for Unassignment
**File**: `src/github/handlers.ts`
**Changes**: Handle `unassigned` action (same pattern)

```typescript
// Add after the "assigned" handling block, before the opened/edited check:

  // Handle unassigned action - bot was removed from issue
  if (action === "unassigned") {
    // Check if bot was unassigned
    if (!isBotAssignee(assignee?.login)) {
      return { created: false };
    }

    // Find the related task
    const task = findTaskByGitHub(repository.full_name, issue.number);
    if (!task) {
      console.log(`[GitHub] No active task found for issue #${issue.number} to cancel`);
      return { created: false };
    }

    // Cancel the task
    const cancelledTask = failTask(task.id, `Unassigned from GitHub issue #${issue.number}`);
    if (cancelledTask) {
      console.log(`[GitHub] Cancelled task ${task.id} for issue #${issue.number} (unassigned)`);
      return { created: false, taskId: task.id };
    }

    return { created: false };
  }
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun tsc --noEmit`
- [x] Tests pass: `bun test`

#### Manual Verification:
- [ ] Unassign @desplega-bot from an issue -> Task cancelled with reason
- [ ] Unassign @desplega-bot from a PR -> Task cancelled with reason
- [ ] Task status shows "failed" with appropriate failure reason in dashboard

---

## Phase 5: Unit Tests

### Overview
Add tests for the new assignment-related functionality.

### Changes Required:

#### 1. Update Mention Tests
**File**: `src/github/mentions.test.ts`
**Changes**: Add tests for `isBotAssignee()`

```typescript
import { describe, expect, test } from "bun:test";
import { detectMention, extractMentionContext, isBotAssignee, GITHUB_BOT_NAME } from "./mentions";

// ... existing tests ...

describe("isBotAssignee", () => {
  test("returns true for exact match", () => {
    expect(isBotAssignee(GITHUB_BOT_NAME)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isBotAssignee(GITHUB_BOT_NAME.toUpperCase())).toBe(true);
    expect(isBotAssignee(GITHUB_BOT_NAME.toLowerCase())).toBe(true);
  });

  test("returns false for different username", () => {
    expect(isBotAssignee("some-other-user")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isBotAssignee(undefined)).toBe(false);
  });

  test("returns false for partial match", () => {
    expect(isBotAssignee(GITHUB_BOT_NAME + "-extra")).toBe(false);
    expect(isBotAssignee("prefix-" + GITHUB_BOT_NAME)).toBe(false);
  });
});
```

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `bun test src/github/mentions.test.ts`
- [x] Full test suite passes: `bun test`

---

## Testing Strategy

### Unit Tests:
- `src/github/mentions.test.ts`: Test `isBotAssignee()` with various inputs

### Integration Tests:
- No new integration tests required (assignment handling follows existing patterns)

### Manual Testing Steps:
1. **Verify GitHub App Configuration** (Phase 0)
   - Assign @desplega-bot to a test issue
   - Check server logs for received event

2. **Test Assignment Handling** (Phase 3)
   - Assign @desplega-bot to an issue
   - Verify task appears in dashboard
   - Verify "eyes" reaction added
   - Repeat for PR

3. **Test Unassignment Handling** (Phase 4)
   - With an existing task from assignment, unassign @desplega-bot
   - Verify task status becomes "failed"
   - Verify failure reason mentions "Unassigned from GitHub"

4. **Edge Cases**
   - Assign then quickly unassign (test deduplication)
   - Unassign when no task exists (should be no-op)
   - Mix assignment with @mentions (both should work)

## Performance Considerations

- Deduplication uses assignment-specific keys (`pr-assigned:`, `issue-assigned:`) to avoid conflicts with mention-based deduplication
- `findTaskByGitHub()` query uses indexed columns and limits results

## Migration Notes

- No database migrations required (GitHub columns already exist)
- Existing tasks unaffected
- Feature is additive - existing @mention flow unchanged

## References

- GitHub App integration: `thoughts/shared/plans/2026-01-12-github-app-integration.md`
- Current handlers: `src/github/handlers.ts:66-252`
- Event types: `src/github/types.ts`
- Task failure: `src/be/db.ts:1007-1024`
- GitHub Webhook Docs: https://docs.github.com/en/webhooks/webhook-events-and-payloads
