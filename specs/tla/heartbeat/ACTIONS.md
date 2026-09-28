# Heartbeat model: action map

Every TLA+ action maps to the code path it models and the SQL guard it relies on. Line numbers are for `main` @ `f031fa8e`. A counterexample is only acted on if every step in its trace maps to a row here.

## Heartbeat.tla (before model)

Line numbers are for `main` @ `f031fa8e`, before Reclaim replaced supersede/resume and the reboot sweep. Kept as the "before" model; these rows no longer describe the code.

| TLA+ action | Code | Guard modeled | Abstraction |
|---|---|---|---|
| `ClaimRead(w,t)` | `src/http/poll.ts` auto-claim → `getUnassignedTaskIdsForAgent` | none (read) | Worker holds one task at a time. |
| `ClaimWrite(w)` | `claimTask` `src/be/db.ts:2845` | `UPDATE … SET agentId=?, status='in_progress' WHERE id=? AND status='unassigned'` (`G_CLAIM_STATUS`) | Claim and start are one step, as in the poll path. |
| `AcceptRead(w,t)` | `acceptTask` `src/be/db.ts:2928`, JS check `task.offeredTo !== agentId` | JS only | |
| `AcceptWrite(w)` | `acceptTask` UPDATE | `WHERE id=? AND status IN ('offered','reviewing')`; `offeredTo` is not in the SQL | `reviewing` folded into `offered`. |
| `Reject(t)` | `rejectTask` `src/be/db.ts:2979`; `releaseStaleOfferedTasksForOfflineAgents` `src/be/db.ts:3190` | `WHERE status IN ('offered','reviewing')` / `WHERE status='offered' AND offeree offline` | Both writes are identical in effect; enabled without the offline check (over-approximation). |
| `ReOffer(t,w)` | **no code path** | — | `HYPO_REOFFER` only. `offeredTo` is set at creation only, so it never changes while a task is `offered`. |
| `PollStart(w,t)` | `src/http/poll.ts:411` → `startTask` `src/be/db/tasks/write.ts:233` | `WHERE status='pending'` | |
| `RegisterSession(w,t)` | `src/commands/runner.ts` POST `/api/active-sessions` → `insertActiveSession` `src/be/db.ts:6963` | `UNIQUE(taskId)` | Before provider spawn. |
| `SessionBeat(w,t)` | `src/hooks/hook.ts:1168` PostToolUse → `heartbeatActiveSession` `src/be/db.ts:7019` | none | Tool activity only; no wall-clock ping. |
| `Progress(w,t)` | `store-progress` → `updateTaskProgress` `src/be/db/tasks/write.ts:959` | **none**: `CASE WHEN status IN terminal THEN status ELSE 'in_progress'`, always bumps `lastUpdatedAt` | `ver` counts `lastUpdatedAt` writes. |
| `Complete(w,t)` | `completeTask` `src/be/db/tasks/write.ts:326` + session delete | `WHERE status NOT IN terminal` (`G_TERMINAL_CAS`) | Fail-by-worker behaves the same and is folded in. |
| `AbortCancelled(w,t)` | `src/http/core.ts:536` `/cancelled-tasks` polled by the hook | returns only `status='cancelled'` | A superseded or failed task is **not** aborted. |
| `WorkerCrash(w)` / `WorkerRestart(w)` | SIGKILL / container restart | — | A hard crash never sets the agent `offline` (runbook §1). |
| `Age(t)` | wall-clock time | — | `stale[t]` = `lastUpdatedAt` older than the stall threshold. |
| `HbRead(t)` | `detectAndRemediateStalledTasks` `src/heartbeat/heartbeat.ts:383`, `getStalledInProgressTasks` `src/be/db.ts:7093`, `decideRemediation` `:513` | `SELECT … WHERE status='in_progress' AND lastUpdatedAt < ?` | Case A (no session) and B (stale session) only; Case C only records. Steering grace and the extension hook are not modeled (they only skip). |
| `HbWrite` | `supersedeTask` `src/be/db/tasks/write.ts:672` (via `heartbeat.ts:589`) or `failTask` `:439` (via `heartbeat.ts:568`) | `WHERE id=? AND status NOT IN terminal` (`G_TERMINAL_CAS`) `AND (? IS NULL OR lastUpdatedAt = ?)` with `expectedLastUpdatedAt` = the value `HbRead` saw (`G_STALL_CAS`, #1668) | Separate statement from `HbRead`. A progress write in between cancels the remediation until the next sweep. |
| `HbResume` | `createResumeFollowUp` `src/tasks/worker-follow-up.ts:407` (via `heartbeat.ts:611`) | none; separate autocommit write | Pinned to the original agent (crash pin, not offline). |
| `HbRepair(t)` | **proposed** (`FIX_ORPHAN_REPAIR`) | `status='superseded'` and no `resume` child | PR: repair sweep. |
| `AutoAssign(t,w)` | `autoAssignPoolTasks` `src/heartbeat/heartbeat.ts:950` → `assignUnassignedTaskPending` | `WHERE id=? AND status='unassigned'`, in a transaction | Affinity and capacity checks abstracted to "idle worker". |
| `Reaper(s)` | `escalateUnreclaimedResumes` `src/heartbeat/heartbeat.ts:1035` | `WHERE id=? AND status='pending'`, in a transaction with the reroute decision | Lead re-delegation collapsed into one new pending row. |
| `CleanupSession(t)` | `cleanupStaleSessions` via `cleanupStaleResources` `src/heartbeat/heartbeat.ts:1186` | `DELETE … WHERE lastHeartbeatAt < 30 min` | |
| `ApiCrash` / `ApiBoot` | API process restart; `__runId` boot epoch | — | In-flight heartbeat and HTTP steps are lost; worker processes keep running. At boot every `live` session becomes `prelive` (last heartbeat before boot). |
| `RebootFail(t)` | `runRebootSweep` `src/heartbeat/heartbeat.ts:695` | skip if `lastUpdatedAt >= bootEpoch-5s` (`G_REBOOT_TOUCHED`), session heartbeat `>= bootEpoch-5s`, or session heartbeat younger than `STALL_THRESHOLD_STALE_HEARTBEAT_MIN` (15 min, `heartbeat.ts:759`, `G_REBOOT_HB_AGE`, #1669); else `failTask` (no CAS) | Read and write collapsed into one step (window is milliseconds). Session age is chosen per step (`hbOld`), constrained to `hbOld => stale[t]` because worker `lastUpdatedAt` writes come with a tool-call heartbeat. A task with no session row is still failed. `FIX_NO_REBOOT` removes the sweep. |
| `RebootRetry` | `runRebootSweep` retry child `src/heartbeat/heartbeat.ts:835` | none; separate write | Generation restarts at 0 (retry children carry no `resume-generation` tag). |

## HeartbeatSimple.tla (current code)

A model `Worker` is one runtime (worker process). `own[t]` is the runtime that started the current attempt: in code, the row's `agentId` plus `attemptRuntimeId`.

| TLA+ action | Code | Guard |
|---|---|---|
| `ClaimRead`/`ClaimWrite`, `AcceptRead`/`AcceptWrite`, `Reject` | unchanged, see the table above; `claimTask` also stamps `attemptRuntimeId` | unchanged |
| `PollStart(w,t)` / `Start` | `/api/poll` and `poll-task` → `startTask(id, { runtimeInstanceId })`; paused resume → `resumeTask`; pool claim → `claimTask` | Stamps `attemptRuntimeId` = caller's `X-Runtime-Instance-ID`. `FreeFor(w,t)`: a runtime whose only work is an earlier copy of `t` may start it; the runner then keeps that process (`src/commands/runner.ts` `activeTasks` keep-branch), which `Start` models by replacing the old `<<t, g>>`. |
| `RegisterSession` | runner POST `/api/active-sessions` before provider spawn | `UNIQUE(taskId)` |
| `Progress`, `Complete` (`Fenced`) | `staleAttemptWriteReason` `src/tasks/attempt-fence.ts`, called on a fresh read inside the write's transaction by `store-progress`, `defer-task`, `/finish`, `/pause`, `/supersede`, `task-action release` | Reject unless `status='in_progress'`, `agentId` = caller agent and `attemptRuntimeId` = caller runtime. On a reclaimed row (`attempt > 0`) any non-lead write that is not the `in_progress` holder's is rejected too. |
| `AbortStale(w,t,g)` | the refused writes above tell the process to stop | |
| `Complete` session delete | `DELETE /api/active-sessions/by-task/:id` → `deleteActiveSession(taskId, { agentId, runtimeInstanceId })` | Deletes only the caller's own row, never a replacement's. |
| `Reclaim(t)` | `reclaimStalledTasks` → `remediateStalledTask` `src/heartbeat/heartbeat.ts` → `reclaimTask` `src/be/db/tasks/write.ts` | One transaction: `UPDATE agent_tasks SET status='pending', attempt=attempt+1 WHERE id=? AND status='in_progress' AND attempt=? AND lastUpdatedAt=? AND NOT EXISTS (fresher active_sessions row)` + `DELETE FROM active_sessions WHERE taskId=?`. Budget spent (`attempt+1 > MAX_RESUME_GENERATIONS`) → `failTask` with the same guards, `attempt` unchanged (model: `att + 1 > MaxGen`). |
| `Unpin(t)` | `unpinUnclaimedTasks` `src/heartbeat/heartbeat.ts` → `getUnclaimedPins` + `unpinTask` | `UPDATE … SET status='unassigned', agentId=NULL, routingAffinity=COALESCE(routingAffinity, snapshot) WHERE id=? AND status='pending' AND lastUpdatedAt=?`, for reclaimed rows idle past `HEARTBEAT_RESUME_PIN_GRACE_MIN`. |
| `ApiCrash`/`ApiBoot` | API restart | No boot sweep. The normal sweep reclaims what the crash left. Graceful/context-limit/manual supersede writes `supersedeTask` + resume child + backfill in one transaction, so an API crash leaves no half-written supersede. |

TLC (`HeartbeatSimple.cfg`): every invariant and property holds. With `FENCE = FALSE`, `NoZombieWrite` is violated, so the runtime fence is what keeps stale attempts out.

### Deviations from the model

- **Fence by runtime, not attempt number.** A process never sends `attempt`; the fence compares the caller's runtime with `attemptRuntimeId`. This equals the model's `Current` check because a runtime runs at most one process per task id (`FreeFor` + `Start` above). A caller without `X-Runtime-Instance-ID` is refused on a reclaimed row a runtime restarted (fail closed). On a never-reclaimed row, and for an attempt started without a runtime id, the fence falls back to the status + agent check; with one attempt only there is no stale attempt to fence.
- **Unfenced worker writes outside the model:** the runner's `/api/tasks/:id/progress` and the session heartbeat. They can refresh progress text or `lastHeartbeatAt`, never status.
- **Unpin covers pins, not offers** (`UNPIN_OFFERED = FALSE`). Offers keep `releaseStaleOfferedTasksForOfflineAgents`, modeled by `Reject`. `acceptTask` still checks `offeredTo` in JS, not SQL.
- **Unpin skips Lead-held pins.** Not modeled (the model has no Lead).
- **Fail instead of Reclaim** for workflow steps (the workflow engine's retry owns them), control-plane task types, and an extension that proposes `fail`. This is Reclaim's budget branch taken early, so it adds no new state.
- **Extension override on a fresh session is NOT covered.** `pre.heartbeat.remediate` may modify a `fresh-stalled` classification to `supersede-resume` (tested in `extensions-heartbeat.test.ts`). That Reclaim runs while `sess = live`, which the model's `Reclaim` forbids, so `NoLiveKill` does not hold for an extension that chooses it. The default policy never does.
- **Other status writers kept outside the model:** `autoAssignPoolTasks` (`unassigned → pending`), `releaseStaleReviewingTasks`, `promoteAbandonedDraftTasks`, approval auto-cancel of linked workflow tasks, the steering grace (only skips), and worker-side `resetOrphanedInProgressTasksForAgent` (`in_progress → pending` at runner boot, without `attempt + 1`; the next start re-stamps `attemptRuntimeId`).
