# Events → Tasks: Eliminate Inbox, Route Slack to Lead

_Status: completed | Implemented: 2026-03-12_

## Phase 1: Slack routing — all non-explicit messages to lead
- [x] `src/slack/router.ts`: Remove fuzzy name matching and thread follow-up routing. Keep `swarm#<uuid>` and `swarm#all`. Default to lead for everything else. Removed `COMMON_WORDS`, `isMatchableWord`, `escapeRegex`, `ThreadContext`, `getAgentWorkingOnThread` import (all dead code).
- [x] `src/slack/handlers.ts`: Replace all `createInboxMessage()` calls with `createTaskExtended()`. Removed `structuredContent` format — tasks use `fullTaskDescription` uniformly. Removed `routingThreadContext` (router no longer needs it).
- **Verify**: `bun run tsc:check` — PASS

## Phase 2: AgentMail — inbox messages become tasks
- [x] `src/agentmail/handlers.ts`: Replace `createInboxMessage()` calls with `createTaskExtended()`, passing `source: "agentmail"`, `taskType: "agentmail-message"`, and agentmail metadata fields (`agentmailInboxId`, `agentmailMessageId`, `agentmailThreadId`). Simplified return type (removed `inboxMessageId`).
- **Verify**: `bun run tsc:check` — PASS

## Phase 3: Lead can poll for tasks
- [x] `src/tools/poll-task.ts`: Remove the lead-agent block. Leads poll just like workers.
- **Verify**: `bun run tsc:check` — PASS

## Phase 4: send-task inherits Slack/AgentMail metadata from parent
- [x] `src/be/db.ts` in `createTaskExtended()`: When `parentTaskId` is provided and parent has `slackChannelId`/`slackThreadTs`/`slackUserId` or `agentmailInboxId`/`agentmailThreadId`, auto-inherit to child task (unless explicitly overridden). This replaces `inbox-delegate`'s metadata forwarding.
- **Verify**: `bun run tsc:check` — PASS

## Phase 5: Deprecate inbox tools
- [x] `src/tools/tool-config.ts`: Remove `"inbox-delegate"` and `"get-inbox-message"` from deferred tools list. Keep `"register-agentmail-inbox"`.
- [x] `src/tools/inbox-delegate.ts`: Deleted
- [x] `src/tools/get-inbox-message.ts`: Deleted
- [x] `src/server.ts`: Remove inbox tool imports and registrations
- **Verify**: `bun run tsc:check` — PASS

## Phase 6: Update tests
- [x] `src/tests/slack-queue-offline.test.ts`: Rewritten to expect tasks instead of inbox messages
- [x] `src/tests/get-inbox-message.test.ts`: Deleted (tool deleted)
- [x] `src/tests/trigger-claiming.test.ts`: No inbox references, no changes needed
- [x] `src/tests/tool-annotations.test.ts`: Removed `get-inbox-message` from read-only expectations
- **Verify**: `bun test` — PASS (1329 tests, 0 failures)

## Phase 7: Version bump
- [x] `package.json`: Bump version from `1.41.9` → `1.42.0` (minor bump — breaking change to inbox/routing behavior)

## Phase 8: Consuming-side cleanup (post-review critical fixes)

These were identified during review — the original plan covered the routing layer but not the consuming side.

- [x] `src/http/poll.ts`: Removed `claimInboxMessages` import and the `slack_inbox_message` trigger block. Leads now get Slack messages via `task_assigned` trigger.
- [x] `src/commands/runner.ts`: Removed `slack_inbox_message` from Trigger type union, removed the case handler that referenced deleted tools (`inbox-delegate`, `get-inbox-message`), removed `inboxMessageId` from session registration.
- [x] `src/prompts/base-prompt.ts`: Replaced "Slack Inbox" section with "Slack Messages" describing task-based routing. Removed `inbox-delegate` references from task delegation tools section.
- **Verify**: `bun run tsc:check && bun test` — PASS

## E2E verification
- [x] `bun run lint:fix && bun run tsc:check && bun test` — all pass
- [x] Full-stack Slack test: Started API with Slack enabled, sent bot mention in Slack, verified:
  - Task created: `fc46aab1` with `source=slack`, `status=pending`
  - Assigned to lead: `docker-lead`
  - Slack metadata present: `channelId`, `threadTs`, `userId`
  - Zero new `inbox_messages` rows
  - Bot replied with `:satellite: Task assigned to: *docker-lead*`

## Deferred items (backwards-compatible, not blocking)

- [ ] `slack-reply.ts`, `slack-read.ts`, `slack-upload-file.ts` still accept `inboxMessageId` parameter — works for legacy inbox messages in DB, but `taskId` should become the primary lookup path
- [ ] `src/be/db.ts` inbox functions still exported (`createInboxMessage`, `getInboxMessageById`, `claimInboxMessages`, `getInboxSummary`, `markInboxMessageResponded`, `markInboxMessageDelegated`) — can be removed once slack tools drop `inboxMessageId` param
- [ ] `agentmailMessageId` not inherited from parent in Phase 4 — intentional (each message has its own ID), confirm if needed
