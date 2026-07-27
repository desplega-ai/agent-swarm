---
id: step-2
name: Promotion on terminal + heartbeat stall guard
depends_on: [step-1]
status: done
completed_at: 2026-07-27
---

# step-2: Promotion on terminal status + heartbeat stall guard

## Overview

Guarantees no steering message is ever silently lost, and stops a task that is being steered from being reaped as stalled. Two halves of decision 10: (a) when a task reaches a terminal status or is crash-recovered, any still-`pending` steering is **promoted** into a follow-up task and folded into the resume context preamble; (b) a task with pending steering gets its stall thresholds extended so the heartbeat sweep doesn't remediate it mid-delivery.

Consumes the db helpers step-1 already shipped (`hasPendingSteering`, `getPendingSteeringForTask`, `markSteeringPromoted`). **Does not edit `src/be/db.ts` or `src/types.ts`** — step-1 owns those.

## Changes Required:

#### 1. Promotion on terminal status
**File**: `src/be/steering.ts` (extend step-1's module)
**Changes**: `promotePendingSteeringForTask(taskId, reason)` — called whenever a task transitions to a terminal status. For each `pending` row: create a follow-up task carrying the steering body, then `markSteeringPromoted(id, newTaskId)`.

Use `createResumeFollowUp` (`src/tasks/worker-follow-up.ts:248-389`) as the model, **not** `createWorkerTaskFollowUp` (`:119-197`) — the latter bails when `task.followUpConfig?.disabled` or `task.workflowRunId` is set, which would silently drop the steer. Either call `createTaskExtended` directly (parent inheritance of Slack/context/user fields is centralised there at `db.ts:3963-3975`) or extend `createResumeFollowUp` with a steering-bodies argument.

`dependsOn` is never auto-inherited from `parentTaskId` (`db.ts:4195,4215`) — set it explicitly only if the promoted task must wait on something.

**Call sites** — wire promotion into the terminal transitions:
- `cancelTask` (`src/be/db.ts:2551-2608`) — **do not edit db.ts**; instead hook from the HTTP/tool layer or from the existing `emitTaskLifecycleTelemetryAfterCommit` seam. If no clean seam exists, add the call in `src/be/steering.ts` and invoke it from the task-status-change handler in `src/http/tasks.ts`.
- The crash-recovery path (`remediateCrashedWorkerTask` in `src/heartbeat/heartbeat.ts`).

#### 2. Resume context preamble carries undelivered steers
**File**: `src/commands/context-preamble.ts`
**Changes**: In `buildResumeContextPreamble` (`:320-443`), add a fetch alongside `fetchSessionLogsForResume` (`:202-221`) hitting `GET /api/tasks/{id}/steering-messages?status=pending,promoted`, and push a new section mirroring the "### Artifacts In Flight" block (`:421-423`) before the final framing push (`:425-432`). Task ids come from `walkResumeChain` (`:298-318`).

⚠️ This file is **worker-side** — HTTP only, never `src/be/db`. Enforced by `scripts/check-db-boundary.sh:18-28`.

Budget: fold steering into the existing 4000-token resume budget; give it a small fixed share rather than expanding the total (current split is 40/35/15/10 at `:276-279, 344-346`).

#### 3. Heartbeat stall guard
**File**: `src/heartbeat/heartbeat.ts`
**Changes**: In `detectAndRemediateStalledTasks` (`:282-328`), after `taskAgeMs` (`:290`) and `sessionHeartbeatAgeMs` (`:304`) are computed, add a guard: if `hasPendingSteering(task.id)` **and** the pending row is younger than a new grace window, skip remediation for this sweep.

Existing thresholds to respect (do not change their defaults):

| Constant | Default | Env var |
|---|---|---|
| `STALL_THRESHOLD_NO_SESSION_MIN` | 5 | `HEARTBEAT_STALL_NO_SESSION_MIN` |
| `STALL_THRESHOLD_STALE_HEARTBEAT_MIN` | 15 | `HEARTBEAT_STALL_STALE_HB_MIN` |
| `STALL_THRESHOLD_MINUTES` | 30 | `HEARTBEAT_STALL_THRESHOLD_MIN` |

Add `STEERING_STALL_GRACE_MIN` (default 5, env `HEARTBEAT_STEERING_GRACE_MIN`) declared next to them (`:79-85`). The guard must be **bounded** — a permanently-undeliverable steer must not make a task un-reapable forever; once the pending row exceeds the grace window, remediation proceeds normally and promotion takes over.

#### 4. Runbook (same-PR rule)
**File**: `runbooks/heartbeat-crash-recovery.md`
**Changes**: Update the mermaid diagram and pseudocode for the stalled-task classifier to include the steering guard, and add `STEERING_STALL_GRACE_MIN` to the thresholds table (`:178-195`). The runbook stores current behavior only, no history — its own maintenance rule (`:3`) requires this in the same PR.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/steering-promotion.test.ts` (new — cover: pending→promoted on cancel/complete/fail, promoted task carries the body, `followUpConfig.disabled` does **not** suppress promotion, grace window expiry lets remediation proceed)
- [ ] Heartbeat tests still pass: `bun test src/tests/heartbeat.test.ts`
- [ ] Full suite green: `bun test`
- [ ] Worker-side boundary holds: `bash scripts/check-db-boundary.sh` (proves `context-preamble.ts` still imports no DB)

#### Automated QA:
- [ ] Agent creates a task, posts a steering message, cancels the task before delivery, and shows `GET /api/tasks/{id}/steering-messages` reports `status:"promoted"` with a non-null `promotedTaskId`, and that the promoted task's description contains the steering body
- [ ] Agent shows the same for a task that reaches `completed` and one that reaches `failed`
- [ ] Agent simulates a stalled task with a fresh pending steer and shows the heartbeat sweep skips remediation; then advances past `STEERING_STALL_GRACE_MIN` and shows remediation proceeds and the steer is promoted
- [ ] Agent shows the resume follow-up's preamble contains the steering section (inspect the dispatched prompt in session logs)

#### Manual Verification:
- [ ] Taras reviews the updated `runbooks/heartbeat-crash-recovery.md` diagram for accuracy

**Implementation Note**: Vertical slice — provable end-to-end with no worker or provider work. Commit `[step-2] promote undelivered steering on terminal status + heartbeat grace window`.
