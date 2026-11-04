---
id: step-14
name: "Lead nudges from checklist (one-shot)"
track: E
depends_on: [step-13]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-14: Lead nudges from checklist (one-shot)

## Overview
The Lead proposes the next open checklist item to the requester at a natural moment: once per item, in the task prompt of a user-requested task, never in the system prompt (cache stability). The server picks the first open, not-yet-nudged item for the task's requester when the Lead polls the task, marks it nudged, and ships it in the poll trigger payload. The worker renders it through a registered task-lifecycle template. A static line also tells the Lead to point at `/integrations?tab=tools` when a task needed a tool that is not connected. After this step, the first UI task after setup contains one nudge paragraph, the second contains none for the same item, and the heartbeat has no nudge at all.

## Changes Required:

#### 1. Poll payload
**File**: `src/http/poll.ts:97-114` (`TaskRequestedBySchema` or a sibling trigger field), `:640` (`buildTaskRequestedBy`)
**Changes**: Add optional `checklistNudge: { itemId, kind, label, href }`. Populate only when the task has `requestedByUserId`, `source` is `ui | slack | chat | comb` (a human asked), and the assignee is the lead. Call `firstOpenItem(requesterId)` then `markNudged(itemId)` inside the same transaction that hands out the task (one-shot even if the worker crashes afterwards; a lost nudge is acceptable, a repeated one is not). Typed schema flows into OpenAPI (`bun run docs:openapi`).

#### 2. Template
**File**: `src/prompts/session-templates.ts` (category `task_lifecycle`, next to `task.requester.profile` at `:617-640`)
**Changes**: `task.checklist.nudge` with variables `label`, `href`, `kind`. Body: one short paragraph. "The requester has not finished setting up: <label>. If it fits the conversation, offer it once, with the link <href>. Do not repeat the offer if they decline." Plus a static sentence (always present in the lead system contract, `system.agent.lead`): when a task needs GitHub, Linear, Jira, Gmail or another tool that is not connected, say so and point to `{{appUrl}}/integrations?tab=tools` instead of working around it.

#### 3. Runner
**File**: `src/commands/runner.ts:3499-3527` (`buildTaskSessionPrompts`)
**Changes**: When `trigger.checklistNudge` is present, append `await resolveTemplateAsync("task.checklist.nudge", {...})` after the requester profile block. Worker-side only; no DB import.

#### 4. Tests
**Files**: `src/tests/http-api-integration.test.ts` (poll), `src/tests/runner-push-delivery.test.ts`, `src/tests/task-session-prompts.test.ts`, `src/tests/checklist.test.ts`, `scripts/e2e/scenarios/platform-checklist.ts` (extend)
**Changes**: Poll returns the nudge once, then null for the same item; no nudge for `source: "schedule"` or heartbeat tasks; no nudge when all items done or removed; the rendered task prompt contains the paragraph once; the system prompt never contains it. E2E: agent-sim lead polls two tasks from the same requester and sees one nudge.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/http-api-integration.test.ts src/tests/task-session-prompts.test.ts src/tests/checklist.test.ts`
- [ ] `bun run e2e --strict`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] `bash scripts/check-db-boundary.sh` (runner and prompts stay DB-free)
- [ ] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [ ] Local API + e2e agent-sim (see `scripts/e2e/README.md`): create two UI tasks as the owner; the first poll response carries `checklistNudge` for "Connect a chat channel", the second carries `checklistNudge` for the next item or nothing; `GET /api/checklist` shows `nudgedAt` set.
- [ ] Host-run lead: start one task from the UI; the session log's task prompt contains the nudge paragraph once; `grep -c "has not finished setting up" <system prompt dump>` is 0.
- [ ] Remove the item on Home, create a new task: no nudge for it.

#### Manual Verification:
- [ ] Taras reads one real lead reply that carries the nudge and judges whether it feels natural or naggy.

**Implementation Note**: This step is a vertical slice, QA-able on its own. Backend to Codex `gpt-6.1-sol` (medium); the template text stays in Claude. After completing this step, pause for manual confirmation. Commit as `[step-14] Lead nudges from checklist (one-shot)` after verification passes.
