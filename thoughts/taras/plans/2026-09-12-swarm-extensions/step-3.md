---
id: step-3
name: pre.task.create + pre.task.followUp
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: pre.task.create + pre.task.followUp

## Overview
After this step an enabled extension can rewrite or block any task creation before it happens, and can suppress or rewrite the lead follow-up task that a worker completion normally produces. Motivating examples 4 (rewrite tasks) and 5 (suppress lead completion tasks) pass as fixtures. Dispatch happens at entry points, never inside a transaction.

## Changes Required:

#### 1. Shared apply helper
**File**: `src/extensions/apply-task-create.ts` (new)
**Changes**: `applyPreTaskCreate({ description, options, origin, requestInfo })` calls `dispatchPre("pre.task.create", ...)` and returns `{ kind: "blocked"; reason; extension } | { kind: "proceed"; description; options }`. On `modify`, copy only the input-only fields listed in the brainstorm's research facts (`agentId, creatorAgentId, source, taskType, tags, priority, dependsOn, offeredTo, description, vcs*, agentmail*, mention*, dir (when no parentTaskId), model, modelTier, effort, outputSchema, followUpConfig, bypassTrackerContextDedup`); for every other key present in `data`, drop it and `console.warn` with the extension name and key. Re-parse the merged options with `CreateTaskOptionsSchema` and treat a parse failure as `continue` with an `error` run row. Pass `opts.skipExtensionId` when `origin` starts with `extension:`.

#### 2. Entry points
**File**: `src/tasks/sibling-awareness.ts`, `src/tools/send-task.ts`, `src/tools/task-action.ts`, `src/http/tasks.ts`
**Changes**:
- `createTaskWithSiblingAwareness` (`sibling-awareness.ts:139`): call `applyPreTaskCreate` first; on `blocked` throw a typed `TaskCreationBlockedError(reason, extension)` (new, in `src/tasks/errors.ts`). This covers REST, Slack, schedules, workflows, webhooks, and follow-ups.
- `send-task.ts`: call `applyPreTaskCreate` once before the transaction at line 434 with the resolved locals (`effectiveAgentId`, `effectiveParentTaskId`, `normalizedModel`, `effectiveLeadOnly`, `effectiveVcsRepo`); on `blocked` return `toolErr(reason, { details })` the same way the dedup-guard path does (423-432); use the returned description/options in all three `createTaskExtended` calls.
- `task-action.ts`: for the agent `create` action, call `applyPreTaskCreate` after `assetKey` is resolved (269-282) and before the transaction at 284; on `blocked` return `taskActionResult({ success: false, message: reason }, agentId)`.
- `src/http/tasks.ts:823`: catch `TaskCreationBlockedError` and respond 422 with `{ error, extension }` (declare the 422 in the route def).
- Origin values: `rest`, `mcp`, `slack`, `schedule`, `workflow`, `webhook`, `followUp`, `extension:<name>`. Set `origin` at each caller; `createTaskWithSiblingAwareness` gains an optional third param `{ origin }` defaulting to `"rest"`, and the Slack, scheduler, workflow, and webhook callers pass theirs (a one-word change per caller).
- Extension-originated tasks: `ctx.swarm.tasks.send` in `src/extensions/ctx.ts` must set `origin: "extension:<name>"`; verify the in-process path reaches `send-task.ts` with that origin (add it to `RequestInfo` or thread it through the tool args, whichever `mcp-bridge` already supports).

#### 3. Follow-up boundary
**File**: `src/tasks/worker-follow-up.ts`
**Changes**: In `createWorkerTaskFollowUp` (151), after the existing early returns (159-166) and after `leadAgent` is known, call `dispatchPre("pre.task.followUp", { completedTask: task, status, output, failureReason, workerAgentId: taskAgent.id, leadAgentId: leadAgent.id, summary })`. `block` returns `null` (same as the existing skip path) and writes nothing else. `modify` may set `description`, `agentId`, `priority`, `followUpConfig` on the follow-up options before `createTaskExtended` at 220. The follow-up creation itself then also passes through `pre.task.create` with `origin: "followUp"`, which is intended.

#### 4. Fixtures and tests
**File**: `src/tests/extensions-pre-task.test.ts` (new), `src/tests/fixtures/extensions/{rewrite-task-priority,block-tasks-from-source,suppress-lead-follow-up}.ts`, `src/tests/extensions-examples.test.ts` (new; grows in steps 4-6)
**Changes**: Follow `src/tests/task-completion-idempotency.test.ts` for follow-up setup. Cover: REST create with `rewrite-task-priority` enabled yields `priority: 1` and a `modify` run row; `send-task` tool path (call the registered tool via a real `McpServer` like `src/tests/tool-registrar-no-input.test.ts`) gets `toolErr` when `block-tasks-from-source` blocks `source: "slack"`; a modify carrying `status` is dropped with a warning; no dispatch happens inside a transaction (spy on `isInTransaction` during the send-task path and assert it was false at dispatch time); `suppress-lead-follow-up` makes `createWorkerTaskFollowUp` return `null` for a Slack-sourced task and still creates the follow-up for a REST task; a follow-up created normally shows two run rows (`pre.task.followUp` then `pre.task.create` with `origin: "followUp"`). Add examples 4 and 5 to `extensions-examples.test.ts`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-pre-task.test.ts src/tests/extensions-examples.test.ts`
- [ ] `bun run test:root -- src/tests/task-completion-idempotency.test.ts src/tests/send-task-output-schema.test.ts src/tests/send-task-requested-by.test.ts src/tests/send-task-slack-routing-guard.test.ts` (existing suites unchanged)
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run check:openapi-response-coverage && bun run docs:openapi` (422 added to POST /api/tasks)
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Boot on a scratch DB, enable `block-tasks-from-source` configured for `source: "rest"`, `POST /api/tasks` returns 422 with the extension name; disable it and the same POST returns 200.
- [ ] Enable `suppress-lead-follow-up`, register a worker and a lead over MCP (UUID agent ids), complete a task as the worker via `store-progress`, and confirm `GET /api/tasks` shows no new task assigned to the lead; disable and repeat, confirm the follow-up appears.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
