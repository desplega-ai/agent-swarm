# Heartbeat model: action map

Every TLA+ action maps to the code path it models and the SQL guard it relies on. Line numbers are for `main` @ `b5bc1b10`. A counterexample is only acted on if every step in its trace maps to a row here.

## Heartbeat.tla (current code)

| TLA+ action | Code | Guard modeled | Abstraction |
|---|---|---|---|
| `ClaimRead(w,t)` | `src/http/poll.ts` auto-claim → `getUnassignedTaskIdsForAgent` | none (read) | Worker holds one task at a time. |
| `ClaimWrite(w)` | `claimTask` `src/be/db.ts:2924` | `UPDATE … SET agentId=?, status='in_progress' WHERE id=? AND status='unassigned'` (`G_CLAIM_STATUS`) | Claim and start are one step, as in the poll path. |
| `AcceptRead(w,t)` | `acceptTask` `src/be/db.ts:3007`, JS check `task.offeredTo !== agentId` | JS only | |
| `AcceptWrite(w)` | `acceptTask` UPDATE | `WHERE id=? AND status IN ('offered','reviewing')`; `offeredTo` is not in the SQL | `reviewing` folded into `offered`. |
| `Reject(t)` | `rejectTask` `src/be/db.ts:3058`; `releaseStaleOfferedTasksForOfflineAgents` `src/be/db.ts:3269` | `WHERE status IN ('offered','reviewing')` / `WHERE status='offered' AND offeree offline` | Both writes are identical in effect; enabled without the offline check (over-approximation). |
| `ReOffer(t,w)` | **no code path** | — | `HYPO_REOFFER` only. `offeredTo` is set at creation only, so it never changes while a task is `offered`. |
| `PollStart(w,t)` | `src/http/poll.ts:450` → `startTask` `src/be/db/tasks/write.ts:245` | `WHERE status='pending'` | |
| `RegisterSession(w,t)` | `src/commands/runner.ts` POST `/api/active-sessions` → `insertActiveSession` `src/be/db.ts:6927` | `UNIQUE(taskId)` | Before provider spawn. |
| `SessionBeat(w,t)` | `src/hooks/hook.ts:1177` PostToolUse → `heartbeatActiveSession` `src/be/db.ts:6983` | none | Tool activity only; no wall-clock ping. |
| `Progress(w,t)` | `store-progress` → `updateTaskProgress` `src/be/db/tasks/write.ts:1063` | **none**: `CASE WHEN status IN terminal THEN status ELSE 'in_progress'`, always bumps `lastUpdatedAt` | `ver` counts `lastUpdatedAt` writes. |
| `Complete(w,t)` | `completeTask` `src/be/db/tasks/write.ts:338` + session delete | `WHERE status NOT IN terminal` (`G_TERMINAL_CAS`) | Fail-by-worker behaves the same and is folded in. |
| `AbortCancelled(w,t)` | `src/http/core.ts:536` `/cancelled-tasks` polled by the hook | returns only `status='cancelled'` | A superseded or failed task is **not** aborted. |
| `WorkerCrash(w)` / `WorkerRestart(w)` | SIGKILL / container restart | — | A hard crash never sets the agent `offline` (runbook §1). |
| `Age(t)` | wall-clock time | — | `stale[t]` = `lastUpdatedAt` older than the stall threshold. |
| `HbRead(t)` | `detectAndRemediateStalledTasks` `src/heartbeat/heartbeat.ts:413`, `getStalledInProgressTasks` `src/be/db.ts:7057`, `decideRemediation` `:592` | `SELECT … WHERE status='in_progress' AND lastUpdatedAt < ?` | Case A (no session) and B (stale session) only; Case C only records. Steering grace and the extension hook are not modeled (they only skip). |
| `HbWrite` | `supersedeTask` `src/be/db/tasks/write.ts:699` (via `heartbeat.ts:668`) or `failTask` `:458` (via `heartbeat.ts:647`) | `WHERE id=? AND status NOT IN terminal` (`G_TERMINAL_CAS`) `AND (? IS NULL OR lastUpdatedAt = ?)` with `expectedLastUpdatedAt` = the value `HbRead` saw (`G_STALL_CAS`, #1668) | Separate statement from `HbRead`. A progress write in between cancels the remediation until the next sweep. |
| `HbResume` | `createResumeFollowUp` `src/tasks/worker-follow-up.ts:407` (via `heartbeat.ts:690`) | none; separate autocommit write | Pinned to the original agent (crash pin, not offline). |
| `HbRepair(t)` | `repairSupersededWithoutResume` `src/heartbeat/heartbeat.ts:549` (step 1.5 of `codeLevelTriage`, `:391`) → `getSupersededTasksWithoutResume` `src/be/db/tasks/read.ts:455` → `createResumeFollowUp` (#1670, `G_ORPHAN_REPAIR`) | `WHERE status='superseded' AND workflowRunStepId IS NULL AND finishedAt` between now-24 h and now-1 min `AND NOT EXISTS (child with taskType='resume')`; JS skips when the next generation exceeds `maxResumeGenerations()` | Runs only when no classifier step is in flight (`hb.pc = "idle"`, the 1 min floor). "No resume child" is "no child": a superseded task's only children in the model are resumes. The 24 h cap and the `POST /api/tasks/:id/supersede` path are not modeled. Dependents are not modeled: #1713 has `supersedeTask` defer them, `backfillSupersedeTaskResumeTaskId` / `settleSupersededTaskDependents` (`src/be/db/tasks/write.ts:793`) re-point never-started ones to the resume, and the same sweep settles a crash between resume and backfill via `getSupersededTasksWithUnsettledDependents` (`read.ts:491`) or cascade-fails them when no resume is created. |
| `AutoAssign(t,w)` | `autoAssignPoolTasks` `src/heartbeat/heartbeat.ts:1099` → `assignUnassignedTaskPending` | `WHERE id=? AND status='unassigned'`, in a transaction | Affinity, capacity and harness-model compatibility (`poolTaskRunsOnHarness`, #1764) abstracted to "idle worker"; the same filter gates `ClaimRead` via `getUnassignedTaskIdsForAgent`'s `accept` callback. |
| `Reaper(s)` | `escalateUnreclaimedResumes` `src/heartbeat/heartbeat.ts:1186` | `WHERE id=? AND status='pending'`, in a transaction with the reroute decision | Lead re-delegation collapsed into one new pending row. |
| `CleanupSession(t)` | `cleanupStaleSessions` via `cleanupStaleResources` `src/heartbeat/heartbeat.ts:1347` | `DELETE … WHERE lastHeartbeatAt < 30 min` | |
| `ApiCrash` / `ApiBoot` | API process restart; `__runId` boot epoch | — | In-flight heartbeat and HTTP steps are lost; worker processes keep running. At boot every `live` session becomes `prelive` (last heartbeat before boot). |
| `RebootFail(t)` | `runRebootSweep` `src/heartbeat/heartbeat.ts:775` | skip if `lastUpdatedAt >= bootEpoch-5s` (`G_REBOOT_TOUCHED`), session heartbeat `>= bootEpoch-5s`, or session heartbeat younger than `stallThresholdStaleHeartbeatMin()` (15 min, `heartbeat.ts:839`, `G_REBOOT_HB_AGE`, #1669); else `failTask(…, { cascadeDependents: false })` (no CAS, `heartbeat.ts:851`) | Read and write collapsed into one step (window is milliseconds). Session age is chosen per step (`hbOld`), constrained to `hbOld => stale[t]` because worker `lastUpdatedAt` writes come with a tool-call heartbeat. A task with no session row is still failed. `FIX_NO_REBOOT` removes the sweep. |
| `RebootRetry` | `runRebootSweep` retry child `src/heartbeat/heartbeat.ts:929` | none; separate write | Generation restarts at 0 (retry children carry no `resume-generation` tag). Dependents are not modeled: #1664 re-points never-started dependents to the retry child, then cascade-fails the rest in a `finally` (`heartbeat.ts:969`). |

## HeartbeatSimple.tla (proposed, not implemented)

| TLA+ action | Replaces | Proposed SQL |
|---|---|---|
| `ClaimRead`/`ClaimWrite`, `AcceptRead`/`AcceptWrite`, `Reject`, `PollStart`, `RegisterSession` | same as above | `acceptTask` adds `AND offeredTo = ?` to its WHERE. |
| `Progress`, `Complete` | `updateTaskProgress`, `completeTask`, `failTask` (worker) | `WHERE id=? AND status='in_progress' AND agentId=? AND attempt=?` (fence). |
| `AbortStale(w,t,g)` | `/cancelled-tasks` polling | Any fenced write that matches 0 rows tells the worker to stop. |
| `Reclaim(t)` | `HbRead`, `HbWrite`, `HbResume`, `HbRepair`, `RebootFail`, `RebootRetry`, `CleanupSession` | One transaction: `UPDATE agent_tasks SET status='pending', attempt=attempt+1 WHERE id=? AND status='in_progress' AND attempt=? AND lastUpdatedAt < :cutoff AND NOT EXISTS (fresh session)` + `DELETE FROM active_sessions WHERE taskId=?`; `status='failed'` once the attempt budget is spent. The same shape already exists worker-side as `resetOrphanedInProgressTasksForAgent` (`src/be/db/tasks/write.ts:992`). |
| `Unpin(t)` | `Reaper`, `AutoAssign`, `releaseStaleOfferedTasksForOfflineAgents` | `UPDATE … SET status='unassigned', agentId=NULL, offeredTo=NULL WHERE id=? AND status IN ('pending','offered') AND lastUpdatedAt < :pinGrace`. The pool stays affinity-gated, so a role-mismatched worker still cannot claim it. |
