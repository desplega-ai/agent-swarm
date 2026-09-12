---
id: step-5
name: pre.heartbeat.remediate
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: pre.heartbeat.remediate

## Overview
After this step an enabled extension sees every stalled task the heartbeat sweep classified, can change the proposed action (supersede-and-resume, fail, or record only), or block remediation for that task this sweep. Motivating example 3 passes as a fixture. The event fires only for tasks already classified as stalled; thresholds and classification are out of scope (brainstorm Key Decisions). `runbooks/heartbeat-crash-recovery.md` is updated in this step because it must stay true in the same PR.

## Changes Required:

#### 1. Classification struct
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Introduce `type StallClassification = "no-session" | "stale-session" | "fresh-stalled"` and `type RemediationAction = "supersede-resume" | "fail" | "record"`. In `detectAndRemediateStalledTasks` (352-415) compute `classification` for Case A (380), B (392), C (407) instead of branching straight into calls, and compute `proposedAction` the way `remediateCrashedWorkerTask` (427) would decide it today: `record` for Case C; for A/B, `fail` when `task.workflowRunStepId != null`, or `skipAutoResume || alreadyResumed`, or the resume budget is exhausted (lift those three checks into a pure `decideRemediation(task, findings)` helper that returns `{ action, reason }` so the existing behavior is unchanged); otherwise `supersede-resume`.

#### 2. Dispatch and apply
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: Per candidate, after classification and before any write, call `dispatchPre("pre.heartbeat.remediate", { task, session, classification, proposedAction, reason, taskAgeMs, sessionHeartbeatAgeMs })`.
- `block`: push the task to `findings.stalledTasks` with no action, add `findings.extensionSkipped: Array<{ taskId, extension, reason }>` (new field on `HeartbeatFindings`, 207-239) and continue the loop.
- `modify`: replace `proposedAction` (validate it is one of the three values; otherwise warn and keep the original).
- Then execute: `record` → push to `stalledTasks`; `fail` → the existing `failTask` branch inside `remediateCrashedWorkerTask`; `supersede-resume` → the existing supersede path. Achieve this by passing the decided action into `remediateCrashedWorkerTask(findings, task, opts, decided)` so its internal checks become a no-op when `decided` is present. Case C with a `modify` to `supersede-resume` is allowed (an extension may escalate a fresh-heartbeat stall); the pinned-resume and cleanup semantics are unchanged.
- The sweep is not inside a transaction (verified), so the `isInTransaction()` guard passes.

#### 3. Runbook
**File**: `runbooks/heartbeat-crash-recovery.md`
**Changes**: Add the classification and proposed-action step and the `pre.heartbeat.remediate` hook point to the stalled-task classifier diagram and pseudocode. Current behavior only, no history.

#### 4. Fixtures and tests
**File**: `src/tests/extensions-heartbeat.test.ts` (new), `src/tests/fixtures/extensions/{never-fail-long-tasks,record-only-on-tag}.ts`, `src/tests/extensions-examples.test.ts`
**Changes**: Copy the stall setup from `src/tests/heartbeat.test.ts` and `heartbeat-supersede-resume.test.ts` (backdate `lastUpdatedAt`, no session row for Case A, stale `lastHeartbeatAt` for Case B). Cases: with no extension the findings match today's suites; `never-fail-long-tasks` changes a `fail` proposal on a workflow-step task to `record` and the task stays `in_progress`; `record-only-on-tag` blocks remediation for tasks tagged `manual` and `findings.extensionSkipped` lists them; a modify with an invalid action keeps the original; a modify escalating Case C to `supersede-resume` creates a resume follow-up. Add example 3 to `extensions-examples.test.ts`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-heartbeat.test.ts src/tests/extensions-examples.test.ts`
- [ ] `bun run test:root -- src/tests/heartbeat.test.ts src/tests/heartbeat-supersede-resume.test.ts src/tests/heartbeat-reroute-decision.test.ts` (existing behavior unchanged with no extension enabled)
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] `git diff --stat runbooks/heartbeat-crash-recovery.md` shows the runbook changed

#### Automated QA:
- [ ] Boot on a scratch DB with `HEARTBEAT_STALL_NO_SESSION_MIN=0.05 HEARTBEAT_INTERVAL_MS=5000` (fractional minutes are accepted, see memory: heartbeat E2E gotchas), create a task, claim it over MCP with a UUID agent id, never send progress, wait for a sweep, and confirm: with `record-only-on-tag` enabled and the task tagged `manual`, `GET /api/tasks/{id}` is still `in_progress` and the extension run log shows a `block`; with it disabled the sweep supersedes the task.

#### Manual Verification:
- [ ] Taras reads the runbook diff and confirms the diagram matches the new flow.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
