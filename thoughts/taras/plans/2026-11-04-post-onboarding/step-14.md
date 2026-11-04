---
id: step-14
name: "Lead nudges from checklist (one-shot)"
track: E
depends_on: [step-13]
status: claimed
assignee: po-orch-step-14
claimed_at: 2026-11-04T16:59:57Z
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
- [x] `bun run test:root -- src/tests/http-api-integration.test.ts src/tests/task-session-prompts.test.ts src/tests/checklist.test.ts`
- [x] `bun run e2e --strict`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json`
- [x] `bash scripts/check-db-boundary.sh` (runner and prompts stay DB-free)
- [x] `bun run check:local && bun run tsc:check:tsc`

#### Automated QA:
- [x] Local API + e2e agent-sim (see `scripts/e2e/README.md`): create two UI tasks as the owner; the first poll response carries `checklistNudge` for "Connect a chat channel", the second carries `checklistNudge` for the next item or nothing; `GET /api/checklist` shows `nudgedAt` set.
- [x] Host-run lead: start one task from the UI; the session log's task prompt contains the nudge paragraph once; `grep -c "has not finished setting up" <system prompt dump>` is 0.
- [x] Remove the item on Home, create a new task: no nudge for it.

#### Manual Verification:
- [ ] Taras reads one real lead reply that carries the nudge and judges whether it feels natural or naggy.

**Implementation Note**: This step is a vertical slice, QA-able on its own. Backend to Codex `gpt-6.1-sol` (medium); the template text stays in Claude. After completing this step, pause for manual confirmation. Commit as `[step-14] Lead nudges from checklist (one-shot)` after verification passes.

## Implementation notes

Commit `6682f383b` on `po/step-14` (2026-11-04). Server side by Codex gpt-6.1-sol (high), reviewed by Claude. Template, runner and prompt tests by Claude.

- **Swarm items go only to requesters who can edit them.** `firstOpenItem(userId, canEditSwarm)` now also requires `editable`. The poll derives `canEditSwarm` from `getUserGrant` (`grantsAll` or `config.write.any`), the same rule as `GET /api/checklist`. Reason: members cannot open the Connect pages, and `nudgedAt` on swarm items is global. Result: each swarm item is nudged once per swarm, to an admin. Members get only their own items.
- **Gate**: lead, `requestedByUserId` set, `source` in `ui | slack | chat | comb`, pending path (`task_assigned`) only. Heartbeat and follow-ups are `system`, schedule runs are `schedule`, so they never carry a nudge. The pool-claim and `task_offered` paths are not touched (leads do not claim from the pool).
- **Cost**: `listChecklist` runs only when a lead receives a human-sourced task with a requester, not per poll. It runs in a SAVEPOINT inside the poll transaction, with `markNudged`. A failure logs a scrubbed warning and hands out the task with no nudge.
- **href** is absolute when `APP_URL` resolves (`resolveAppUrl`), otherwise the in-app path.
- **Static line** in `system.agent.lead` points at `APP_URL` + `/integrations/tools` (step-13 routes, not `?tab=tools`). No template variable, so the system prompt stays per-agent. The fresh-lead size ceiling in `base-prompt.test.ts` moved from 6,100 to 6,250 (the line adds about 150 chars; the base was already near 6,100).
- **Tests**: the poll cases live in a new `src/tests/checklist-nudge.test.ts` (direct `handlePoll`, `listenOnFreePort`), not `http-api-integration.test.ts`. E2E extends `platform-checklist` with an agent-sim lead and two `ui` tasks from a member.
- **Docs**: row for `task.checklist.nudge` in the harness-providers per-task context table.
- **QA**: manual polls gave `swarm:channel`, then `swarm:tool`, with `nudgedAt` and `nudgedTaskId` set. After the use-case item was removed, no nudge. `schedule` and `system` tasks got none. A host-run lead task prompt had the paragraph once. The system prompt had it 0 times and the second task 0 times. Artifacts: `/tmp/po-step-14-task-prompt-with-nudge.txt`, `/tmp/po-step-14-lead-system-prompt.txt`.
- **No real lead reply yet**: CLIProxy answered `503 auth_unavailable` (Claude refresh token expired), so the manual check needs a working Claude auth.
- **Flake**: `claude-routes-e2e.test.ts` failed 1 of 3 local runs with `EPERM` from `kill()` in `src/utils/process-group.ts` (not touched here). It was not reproduced on the base in 4 runs. The final `check:local` was green.

