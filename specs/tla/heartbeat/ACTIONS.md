# Heartbeat model: action map

Every TLA+ action maps to the code path it models and the SQL guard it relies on. Line numbers are for `main` @ `2180cd40`. A counterexample is only acted on if every step in its trace maps to a row here.

## Heartbeat.tla (current code)

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
| `Progress(w,t)` | `store-progress` → `updateTaskProgress` `src/be/db/tasks/write.ts:935` | **none**: `CASE WHEN status IN terminal THEN status ELSE 'in_progress'`, always bumps `lastUpdatedAt` | `ver` counts `lastUpdatedAt` writes. |
| `Complete(w,t)` | `completeTask` `src/be/db/tasks/write.ts:326` + session delete | `WHERE status NOT IN terminal` (`G_TERMINAL_CAS`) | Fail-by-worker behaves the same and is folded in. |
| `AbortCancelled(w,t)` | `src/http/core.ts:536` `/cancelled-tasks` polled by the hook | returns only `status='cancelled'` | A superseded or failed task is **not** aborted. |
| `WorkerCrash(w)` / `WorkerRestart(w)` | SIGKILL / container restart | — | A hard crash never sets the agent `offline` (runbook §1). |
| `Age(t)` | wall-clock time | — | `stale[t]` = `lastUpdatedAt` older than the stall threshold. |
| `HbRead(t)` | `detectAndRemediateStalledTasks` `src/heartbeat/heartbeat.ts:375`, `getStalledInProgressTasks` `src/be/db.ts:7093`, `decideRemediation` `:505` | `SELECT … WHERE status='in_progress' AND lastUpdatedAt < ?` | Case A (no session) and B (stale session) only; Case C only records. Steering grace and the extension hook are not modeled (they only skip). |
| `HbWrite` | `supersedeTask` `src/be/db/tasks/write.ts:654` (via `heartbeat.ts:578`) or `failTask` `:439` (via `heartbeat.ts:559`) | `WHERE id=? AND status NOT IN terminal` (`G_TERMINAL_CAS`); `FIX_STALL_CAS` adds `AND lastUpdatedAt = <observed>` | Separate statement from `HbRead`. |
| `HbResume` | `createResumeFollowUp` `src/tasks/worker-follow-up.ts:407` (via `heartbeat.ts:598`) | none; separate autocommit write | Pinned to the original agent (crash pin, not offline). |
| `HbRepair(t)` | **proposed** (`FIX_ORPHAN_REPAIR`) | `status='superseded'` and no `resume` child | PR: repair sweep. |
| `AutoAssign(t,w)` | `autoAssignPoolTasks` `src/heartbeat/heartbeat.ts:928` → `assignUnassignedTaskPending` | `WHERE id=? AND status='unassigned'`, in a transaction | Affinity and capacity checks abstracted to "idle worker". |
| `Reaper(s)` | `escalateUnreclaimedResumes` `src/heartbeat/heartbeat.ts:1013` | `WHERE id=? AND status='pending'`, in a transaction with the reroute decision | Lead re-delegation collapsed into one new pending row. |
| `CleanupSession(t)` | `cleanupStaleSessions` via `cleanupStaleResources` `src/heartbeat/heartbeat.ts:1164` | `DELETE … WHERE lastHeartbeatAt < 30 min` | |
| `ApiCrash` / `ApiBoot` | API process restart; `__runId` boot epoch | — | In-flight heartbeat and HTTP steps are lost; worker processes keep running. At boot every `live` session becomes `prelive` (last heartbeat before boot). |
| `RebootFail(t)` | `runRebootSweep` `src/heartbeat/heartbeat.ts:682` | skip if `lastUpdatedAt >= bootEpoch-5s` (`G_REBOOT_TOUCHED`) or session heartbeat `>= bootEpoch-5s`; else `failTask` | Read and write collapsed into one step (window is milliseconds). `FIX_NO_REBOOT` removes the sweep. |
| `RebootRetry` | `runRebootSweep` retry child `src/heartbeat/heartbeat.ts:825` | none; separate write | Generation restarts at 0 (retry children carry no `resume-generation` tag). |

## HeartbeatSimple.tla (proposed, not implemented)

| TLA+ action | Replaces | Proposed SQL |
|---|---|---|
| `ClaimRead`/`ClaimWrite`, `AcceptRead`/`AcceptWrite`, `Reject`, `PollStart`, `RegisterSession` | same as above | `acceptTask` adds `AND offeredTo = ?` to its WHERE. |
| `Progress`, `Complete` | `updateTaskProgress`, `completeTask`, `failTask` (worker) | `WHERE id=? AND status='in_progress' AND agentId=? AND attempt=?` (fence). |
| `AbortStale(w,t,g)` | `/cancelled-tasks` polling | Any fenced write that matches 0 rows tells the worker to stop. |
| `Reclaim(t)` | `HbRead`, `HbWrite`, `HbResume`, `HbRepair`, `RebootFail`, `RebootRetry`, `CleanupSession` | One transaction: `UPDATE agent_tasks SET status='pending', attempt=attempt+1 WHERE id=? AND status='in_progress' AND attempt=? AND lastUpdatedAt < :cutoff AND NOT EXISTS (fresh session)` + `DELETE FROM active_sessions WHERE taskId=?`; `status='failed'` once the attempt budget is spent. The same shape already exists worker-side as `resetOrphanedInProgressTasksForAgent` (`src/be/db/tasks/write.ts:873`). |
| `Unpin(t)` | `Reaper`, `AutoAssign`, `releaseStaleOfferedTasksForOfflineAgents` | `UPDATE … SET status='unassigned', agentId=NULL, offeredTo=NULL WHERE id=? AND status IN ('pending','offered') AND lastUpdatedAt < :pinGrace`. The pool stays affinity-gated, so a role-mismatched worker still cannot claim it. |
