---
date: 2026-03-30
author: Claude
topic: "GitHub Event Safety Defaults — Quick Win"
tags: [plan, github, events, safety, auto-merge]
status: draft
autonomy: autopilot
brainstorm: thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md
---

# GitHub Event Safety Defaults — Implementation Plan

## Overview

Restrict the default GitHub event handling to only create agent tasks for explicit human actions: @mention, reviewer/assignee assignment, and configurable labels. All other events (CI status, PR lifecycle, review submissions) are info-logged and dropped. This is the "quick win" from the [PR Auto-Merge Safety brainstorm](../brainstorms/2026-03-28-pr-auto-merge-safety.md).

**Why:** Users report that swarm agents auto-merge PRs too aggressively. The root cause is that GitHub events cascade (PR created → CI passes → review submitted → agent merges) and every event creates a new task. By only triggering on explicit human actions, agents can't act unless a human asks them to.

## Current State Analysis

### How GitHub events flow today

```
GitHub webhook → POST /api/github/webhook (src/http/webhooks.ts:99)
  → signature verification
  → switch(eventType) → handler function (src/github/handlers.ts)
    → handler creates task via createTask()
  → workflowEventBus.emit() for workflow triggers
```

### Handler behavior (7 handlers, all in `src/github/handlers.ts`)

| Handler | Actions that create tasks | Gate condition |
|---------|--------------------------|----------------|
| `handlePullRequest` | `assigned`, `review_requested` | `isBotAssignee()` ✅ explicit |
| `handlePullRequest` | `opened`, `edited` | `detectMention()` in title/body ✅ explicit |
| `handlePullRequest` | `closed` | Existing task found ❌ cascade |
| `handlePullRequest` | `synchronize` | Existing task found ❌ cascade |
| `handleIssue` | `assigned` | `isBotAssignee()` ✅ explicit |
| `handleIssue` | `opened`, `edited` | `detectMention()` in title/body ✅ explicit |
| `handleComment` | `created` | `detectMention()` in comment body ✅ explicit |
| `handlePullRequestReview` | `submitted` | Bot is PR creator OR existing task ❌ cascade |
| `handleCheckRun` | `completed` + failure | Existing task found ❌ cascade |
| `handleCheckSuite` | `completed` + failure | Existing task found ❌ cascade |
| `handleWorkflowRun` | `completed` + failure | Existing task found ❌ cascade |

Cleanup actions (`unassigned`, `review_request_removed`) cancel tasks — these are safe and should stay.

### Key files

- `src/github/handlers.ts` — All 7 handler functions (~1150 lines)
- `src/http/webhooks.ts` — Webhook dispatcher + workflowEventBus emission
- `src/github/mentions.ts` — `detectMention()`, `isBotAssignee()`, bot name config
- `src/github/types.ts` — TypeScript interfaces for webhook payloads
- `src/github/templates.ts` — 14 registered prompt templates for GitHub events
- `src/prompts/resolver.ts:206-207` — Existing `skip_event` rule system (template resolver)

### Key Discoveries:
- `src/github/handlers.ts:319-379` — PR `closed` handler creates notification tasks whenever an existing task is found. This is a cascade trigger.
- `src/github/handlers.ts:382-432` — PR `synchronize` handler creates notification tasks for new commits. Another cascade trigger.
- `src/github/handlers.ts:770-870` — Review handler creates tasks when bot is PR creator (`isBotAssignee(pr.user.login)`) — this means any review on a bot-created PR triggers agent action.
- `src/github/handlers.ts:877-1151` — All three CI handlers (check_run, check_suite, workflow_run) only trigger on failure with existing tasks — cascade notifications.
- `src/http/webhooks.ts:174-219` — workflowEventBus already emits normalized events for `pull_request`, `issues`, `issue_comment`, `pull_request_review`. These continue to emit regardless of handler suppression (important for future workflow triggers).
- `src/github/mentions.ts:2,8` — `GITHUB_BOT_NAME` and `GITHUB_BOT_ALIASES` env vars already exist for bot detection.

## Desired End State

After implementation, the GitHub webhook handler only creates tasks for:

1. **@mention** — Agent mentioned in a comment, PR body/title, or issue body/title
2. **Assignment** — Agent assigned to PR (as reviewer) or issue (as assignee)
3. **Label** — Configurable label(s) added to PR or issue (default: `swarm-review`)
4. **Cleanup** — Unassignment/review removal still cancels existing tasks (not creating new ones)

All other events are info-logged with a `[GitHub:suppressed]` prefix and dropped. The `workflowEventBus` emission in `webhooks.ts` continues for ALL events (future workflow triggers need them).

### Verification:
- Send a `check_run.completed` webhook → no task created, info log emitted
- Send an `issue_comment.created` with @bot-mention → task created as before
- Send a `pull_request.labeled` with `swarm-review` label → task created
- Send a `pull_request.labeled` with random label → no task created
- `GITHUB_EVENT_LABELS=custom-label` env var → only `custom-label` triggers

## Quick Verification Reference

```bash
bun run tsc:check            # TypeScript
bun run lint:fix              # Biome
bun test src/tests/github*    # GitHub-related tests
```

Key files to check:
- `src/github/handlers.ts` — Main changes
- `src/github/mentions.ts` — Label config addition
- `src/tests/` — New/updated test files

## What We're NOT Doing

- **No merge policy config system** — No toggles, presets, or per-repo config
- **No action-level gating** — We're not intercepting merge API calls
- **No workflow event triggers** — That's the follow-up feature (separate plan)
- **No changes to workflowEventBus emission** — All events still emit for future use
- **No changes to the template/skip_event system** — Existing template resolver stays as-is
- **No changes to GitHub token permissions** — Out of scope for quick win

## Implementation Approach

The change is surgical: modify each handler function to check whether its event type is "explicit" or "cascade", and return early with an info log for cascade events. Add label handling as a new case in the PR and issue handlers. One new env var for label configuration.

No new modules or abstractions — the filtering logic lives directly in the handler functions where the decisions are made. This keeps the diff small and reviewable.

---

## Phase 1: Label Configuration + Label Handler

### Overview
Add the `GITHUB_EVENT_LABELS` env var and implement label-based triggering for PRs and issues. This is net-new functionality that doesn't change existing behavior yet.

### Changes Required:

#### 1. Label configuration
**File**: `src/github/mentions.ts`
**Changes**: Add label config alongside existing bot name config.

```typescript
// After the existing GITHUB_BOT_ALIASES definition (~line 8)
const GITHUB_EVENT_LABELS_RAW = process.env.GITHUB_EVENT_LABELS || "swarm-review";
export const GITHUB_EVENT_LABELS: string[] = GITHUB_EVENT_LABELS_RAW
  .split(",")
  .map((l) => l.trim().toLowerCase())
  .filter(Boolean);

export function isSwarmLabel(label: string): boolean {
  return GITHUB_EVENT_LABELS.includes(label.toLowerCase());
}
```

#### 2. Label handler in handlePullRequest
**File**: `src/github/handlers.ts`
**Changes**: Add `labeled` action case in the `handlePullRequest` switch/if chain, after the existing `opened`/`edited` case (around line 435). The handler should:
- Extract the label from `event.label?.name`
- Check `isSwarmLabel(label)`
- If match: resolve template, create task with type `github-pr`, add reaction
- If no match: return `{ created: false }`
- Dedup key: `pr-labeled:{repo}:{number}:{label}`

#### 3. Label handler in handleIssue
**File**: `src/github/handlers.ts`
**Changes**: Add `labeled` action case in `handleIssue`, after the existing `opened`/`edited` case (around line 598). Same pattern as PR label handler but with type `github-issue`.
- Dedup key: `issue-labeled:{repo}:{number}:{label}`

#### 4. GitHub event templates for labels
**File**: `src/github/templates.ts`
**Changes**: Register two new templates:
- `github.pull_request.labeled` — Template for PR label triggers
- `github.issue.labeled` — Template for issue label triggers

These follow the exact same pattern as the existing `github.pull_request.assigned` and `github.issue.assigned` templates.

#### 5. workflowEventBus emission for labeled events
**File**: `src/http/webhooks.ts`
**Changes**: The existing `pull_request` case (line 176) already emits `github.pull_request.${action}`, which will naturally emit `github.pull_request.labeled`. Same for issues. No change needed here — just verify it works.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`
- [ ] `isSwarmLabel("swarm-review")` returns true
- [ ] `isSwarmLabel("unrelated")` returns false

#### Manual Verification:
- [ ] Start API server, send a mock `pull_request.labeled` webhook with `label.name: "swarm-review"` → task created
- [ ] Send same webhook with `label.name: "bug"` → no task created
- [ ] Set `GITHUB_EVENT_LABELS=custom-label` env var, restart, send webhook with `custom-label` → task created
- [ ] Existing @mention and assignment handlers still work unchanged

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Suppress Cascade Events

### Overview
Modify the cascade handlers to info-log and return early instead of creating tasks. This is the core safety change — after this phase, agents only receive tasks from explicit human actions.

### Changes Required:

#### 1. Suppress PR lifecycle events (closed, synchronize)
**File**: `src/github/handlers.ts`
**Changes**: In `handlePullRequest()`, modify the `closed` case (line 319) and `synchronize` case (line 382) to log and return early:

```typescript
// At the top of the "closed" case (line 319)
case "closed": {
  console.log(`[GitHub:suppressed] pull_request.closed on ${repo}#${pr.number} — lifecycle events disabled by default`);
  return { created: false };
}
```

Same pattern for `synchronize`. The existing task lookup and notification task creation code stays in place (just unreachable in the default path). This makes it easy to re-enable via workflow triggers later.

#### 2. Suppress pull_request_review events
**File**: `src/github/handlers.ts`
**Changes**: In `handlePullRequestReview()` (line 770), add early return at the top of the function (after the `action !== "submitted"` check):

```typescript
// After line 779 (action !== "submitted" check)
console.log(`[GitHub:suppressed] pull_request_review.${action} on ${repo}#${pr.number} — review events disabled by default`);
return { created: false };
```

#### 3. Suppress check_run events
**File**: `src/github/handlers.ts`
**Changes**: In `handleCheckRun()` (line 877), add early return after the action/conclusion checks:

```typescript
// After line 892 (conclusion check)
console.log(`[GitHub:suppressed] check_run.${action} (${conclusion}) on ${repo} — CI events disabled by default`);
return { created: false };
```

#### 4. Suppress check_suite events
**File**: `src/github/handlers.ts`
**Changes**: In `handleCheckSuite()` (line 972), same pattern:

```typescript
// After line 986 (conclusion check)
console.log(`[GitHub:suppressed] check_suite.${action} (${conclusion}) on ${repo} — CI events disabled by default`);
return { created: false };
```

#### 5. Suppress workflow_run events
**File**: `src/github/handlers.ts`
**Changes**: In `handleWorkflowRun()` (line 1065), same pattern:

```typescript
// After line 1079 (conclusion check)
console.log(`[GitHub:suppressed] workflow_run.${action} (${conclusion}) on ${repo} — CI events disabled by default`);
return { created: false };
```

#### 6. Keep workflowEventBus emission untouched
**File**: `src/http/webhooks.ts`
**Changes**: None. The `workflowEventBus.emit()` block (lines 174-219) runs AFTER the handler returns, so suppressed handlers don't affect event bus emission. Verify this is the case by reading the control flow — the handler call and the event bus emission are sequential, not conditional on handler result.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`

#### Manual Verification:
- [ ] Start API server, send `pull_request_review.submitted` webhook → no task created, log shows `[GitHub:suppressed]`
- [ ] Send `check_run.completed` with `conclusion: "failure"` → no task created, log shows `[GitHub:suppressed]`
- [ ] Send `pull_request.closed` with `merged: true` → no task created, log shows `[GitHub:suppressed]`
- [ ] Send `pull_request.synchronize` → no task created, log shows `[GitHub:suppressed]`
- [ ] Send `issue_comment.created` with @bot-name mention → task STILL created (explicit action preserved)
- [ ] Send `pull_request.review_requested` with bot as reviewer → task STILL created
- [ ] Send `pull_request.assigned` with bot as assignee → task STILL created

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the breaking change — verify all explicit triggers still work.

---

## Phase 3: Tests

### Overview
Add unit tests covering the new event filtering behavior. Test both the positive cases (explicit actions create tasks) and the negative cases (cascade events are suppressed).

### Changes Required:

#### 1. Label configuration tests
**File**: `src/tests/github-event-labels.test.ts` (new)
**Changes**: Test `isSwarmLabel()`:
- Default label `swarm-review` matches
- Custom labels via env var work
- Case-insensitive matching
- Non-matching labels return false
- Comma-separated multiple labels

#### 2. Event suppression tests
**File**: `src/tests/github-event-filter.test.ts` (new)
**Changes**: Test that suppressed handlers return `{ created: false }`:
- `handlePullRequestReview` with `submitted` action → `{ created: false }`
- `handleCheckRun` with `completed` + `failure` → `{ created: false }`
- `handleCheckSuite` with `completed` + `failure` → `{ created: false }`
- `handleWorkflowRun` with `completed` + `failure` → `{ created: false }`
- `handlePullRequest` with `closed` → `{ created: false }`
- `handlePullRequest` with `synchronize` → `{ created: false }`

Note: These tests will need to mock the DB functions (`findTaskByVcs`, `createTask`, `getAllAgents`, etc.) since the handlers import from `src/be/db`. Follow the existing test patterns for GitHub handler tests.

#### 3. Explicit action tests (regression)
**File**: `src/tests/github-event-filter.test.ts` (same file)
**Changes**: Test that explicit actions still work:
- `handleComment` with @mention → task created
- `handlePullRequest` with `review_requested` + bot as reviewer → task created
- `handlePullRequest` with `assigned` + bot as assignee → task created
- `handlePullRequest` with `labeled` + matching label → task created
- `handlePullRequest` with `labeled` + non-matching label → no task
- `handleIssue` with `labeled` + matching label → task created

### Success Criteria:

#### Automated Verification:
- [ ] New tests pass: `bun test src/tests/github-event-labels.test.ts`
- [ ] New tests pass: `bun test src/tests/github-event-filter.test.ts`
- [ ] All existing tests still pass: `bun test`
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review test coverage — all suppressed event types have a test
- [ ] Review test coverage — all explicit action types have a regression test

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 4: Documentation + Changelog

### Overview
Document the breaking change and update relevant docs.

### Changes Required:

#### 1. Changelog entry
**File**: `CHANGELOG.md` (or wherever changelog is maintained)
**Changes**: Add entry:

```markdown
## [Breaking] Restrict default GitHub event handling

GitHub webhook events now only trigger agent tasks for explicit human actions:
- **@mention** — Agent mentioned in comment, PR body/title, or issue body/title
- **Assignment** — Agent assigned as PR reviewer or issue assignee
- **Labels** — Configurable label(s) added to PR/issue (default: `swarm-review`, configure via `GITHUB_EVENT_LABELS` env var)

Previously, CI status events (check failures), PR lifecycle events (closed, new commits), and review submissions would also create agent tasks, leading to event cascades where agents could merge PRs without meaningful human review.

**Migration:** If you relied on CI failure notifications or PR lifecycle events, these now require explicit human action (e.g., @mention the agent). In the future, workflow event triggers will provide a way to opt in to automation for specific event types.
```

#### 2. Update .env.example (if exists)
**File**: `.env` or `.env.example`
**Changes**: Add documentation for the new env var:

```
# Comma-separated labels that trigger agent action on PR/issue label events
# Default: swarm-review
# GITHUB_EVENT_LABELS=swarm-review,agent-review
```

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint:fix`
- [ ] No broken links in docs

#### Manual Verification:
- [ ] Changelog entry is clear and accurate
- [ ] Env var is documented
- [ ] Breaking change migration path is documented

**Implementation Note**: After completing this phase, the feature is ready for PR.

---

## Manual E2E Verification

After all phases, run a full end-to-end test:

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Wait for startup
sleep 3

# 3. Get webhook secret from env
source .env

# 4. Test: suppressed event (check_run failure) — should NOT create task
curl -s -X POST http://localhost:3013/api/github/webhook \
  -H "Content-Type: application/json" \
  -H "x-github-event: check_run" \
  -H "x-hub-signature-256: sha256=$(echo -n '{"action":"completed","check_run":{"conclusion":"failure","pull_requests":[{"number":1}]},"repository":{"full_name":"test/repo"},"sender":{"login":"user"}}' | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')" \
  -d '{"action":"completed","check_run":{"conclusion":"failure","pull_requests":[{"number":1}]},"repository":{"full_name":"test/repo"},"sender":{"login":"user"}}'
# Expected: {"created":false} + [GitHub:suppressed] in server logs

# 5. Test: explicit event (comment with @mention) — SHOULD create task
# (construct payload with detectMention-matching body)

# 6. Test: label event (PR labeled with swarm-review) — SHOULD create task
# (construct payload with label.name: "swarm-review")

# 7. Verify server logs show [GitHub:suppressed] for suppressed events
# and normal task creation for explicit events

# 8. Cleanup
kill $(lsof -ti :3013)
```

## Testing Strategy

- **Unit tests** (Phase 3): Mock DB, test each handler function directly with different event payloads
- **Manual webhook tests** (Phase 2 + E2E): Send curl requests with real-format payloads to running API server
- **Regression**: Ensure all existing @mention and assignment flows work unchanged

## References

- Brainstorm: `thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md`
- Handler analysis: `src/github/handlers.ts` (1150 lines, 7 handler functions)
- Event bus: `src/workflows/event-bus.ts` (workflowEventBus — unaffected by this change)
- Existing trigger patterns: `src/workflows/triggers.ts` (schedule + webhook triggers — model for future event triggers)
