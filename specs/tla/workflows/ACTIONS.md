# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers are against `main` @ `795526ca3`. A DB transaction is one atomic action. Every
`await` outside a transaction is an action boundary: other actors interleave there, and a crash
can land there.

Where a fix flag is noted (F1..F6), the row describes the code with the fix, which is current
behavior on `main` for every flag except F2 (see "Fix flags" below). The `.tla` keeps the pre-fix
branch of each action for the `Ctl-*` and calibration configs.

## State

| Variable | Code |
|---|---|
| `run` | `workflow_runs.status` (`none` before the INSERT) |
| `steps[i]` | one `workflow_run_steps` row: `node`=nodeId, `st`=status, `rc`=retryCount, `nra`=`nextRetryAt IS NOT NULL`, `task`=linked agent task state |
| `active` | `activeWalks.get(runId)` (`engine.ts:204`, process-local), taken by `walkGraph` and `holdWorkflowRun` (`engine.ts:220`) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |
| `Owned` (derived) | F3: `executingSteps` (`engine.ts:209`, process-local, cleared by a crash) |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:239` | `activeWalks` +1 via `holdWorkflowRun` (no DB guard) |
| `WStart` | `engine.ts:268-339`: rehydrate completed steps `:283`, `loadCompletedStepRouting` `:287`, active edges from `waiting` steps `:303-316`, seed filter `:324-338` | Seed filter = `GuardConvergeSeed`. F6: a predecessor in `awaitedNodeIds` (`:317`, `engine.ts:513`) also holds the node. Reads only, no transaction. |
| `WPick` | `engine.ts:356` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `executeStep` `engine.ts:607`, claim transaction `:688` | `run.status IN (running, waiting)` else halted (`:624-627`, returned as completed `:694`). F3: `getCurrentStepForNode` (`:636`, `db.ts:8128`) memoizes a node whose latest row is completed, waiting, or running and owned by this process (`executingSteps`), with no newer predecessor completion; a live one pauses the walk (`:695-701`). Otherwise `iteration = COUNT(*)` (`:645`, `db.ts:8102`) and INSERT. |
| `XRun` | `executor.run` `engine.ts:814` (in `runClaimedStep` `:733`) | none (process-local) |
| `XCkOk` | `checkpointStep` `engine.ts:929` -> `checkpoint.ts:7-27` | transaction, blind `UPDATE step SET status='completed'` |
| `XFail` | `checkpointStepFailure` `engine.ts:827` / `:846` / `:904` -> `checkpoint.ts:43-55` | blind `UPDATE step SET status='failed', retryCount+1, nextRetryAt`; `executeStep` returns `completed` with no successors (`:839`, `:862`, `:911`), so the walk adds the node to `completedNodeIds` (`engine.ts:387`). **The F2 edge is not kept (open, CX8).** |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:867` -> `checkpoint.ts:87-110` | CAS `WHERE status='running'`, run `IN (running, waiting)` |
| `WBatchEnd` | `engine.ts:367-433` in-walk convergence | in-memory `completedNodeIds` / `activeEdges`. F6: re-reads the steps (`:408-410`): a predecessor whose latest row completed elsewhere is rehydrated (`:415-421`), one in `awaitedNodeIds` holds the join (`:422-425`) |
| `WFinal` | `engine.ts:443-490` finalization transaction | `run.status = 'running'`; F6: returns while any node's latest row is `running` (`hasRunningStep` `:449`, `engine.ts:527`); `waiting` steps -> waiting; pending retries -> stay running; else completed/failed. A `pending` row is not counted (CX10). |
| `WRet` | `engine.ts:253` `release()` | `activeWalks` -1 |

## Trigger (`engine.ts:85-186`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createWorkflowRun` `engine.ts:123` / `:139` commits `running` | none |
| `IWalk` | `resolveRenderedWorkflowInputs` `engine.ts:165` awaits before `walkGraph` `:179` (only when `InputAwait`) | none; F3 covers the recovery walk that lands in this window (CX6) |

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:37` -> `db.ts:8058-8071` | `status='failed' AND nextRetryAt <= now`. F1: `AND run.status IN (running, waiting, failed)` |
| `P2` | `getWorkflowRun` `retry-poller.ts:42` | read |
| `P3` | pre-F1: blind `run -> running` if the snapshot said `failed` | F1: removed; the revive moved into `claimRetry` (`P4`) |
| `P4` | `holdWorkflowRun` `retry-poller.ts:58`, `claimRetry` `:63` -> `:223-240` | F1: one transaction; `UPDATE step SET status='running', nextRetryAt=NULL WHERE status='failed' AND nextRetryAt IS NOT NULL`, only while the run is `running`/`waiting`/`failed`; revives a `failed` run. F4: the hold makes `isWorkflowRunActive` true for recovery |
| `P5` | `executor.run` `retry-poller.ts:110` | none |
| `P6` | `checkpointStep` `retry-poller.ts:178`, then `walkGraph(successors)` `:183` | blind step write |
| `P9` | no successors: `completeRunIfSettled` `retry-poller.ts:192` -> `:247-265` | F1: one transaction, only while the run is `running`/`waiting` and no step is running, waiting, or pending retry |
| `P7` | `checkpointStepFailure` `retry-poller.ts:121` | blind step write |
| `P10` | `checkpoint.ts:57-80` retries exhausted | F1: `run -> failed` in a transaction, only while the run is `running`/`waiting` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:135` | CAS (as `XCkWait`) |
| `PRel` | end of one row, `finally` `retry-poller.ts:203-204` | F4: releases the `holdWorkflowRun` taken at `P4` |

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:66`, `isWorkflowRunActive` `:71` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:72`, completed steps, routing, `findReadyNodes` `:91` | `findReadyNodes` excludes only nodes with a **completed** step. F4: also drops nodes with a retry-pending row (`retryPendingNodeIds` `:90-93`, `:122`) |
| `H3` | second `isWorkflowRunActive` `:95`, then complete or `walkGraph` `:102` | `GuardActiveWalk` |
| `H4` | `recovery.ts:96-99` `readyNodes.length === 0` | F4: `completeIfSettled` `recovery.ts:136-156`, one transaction, only while `running` with no retry-pending row and no live latest row |
| `H5` | `getStuckWorkflowRuns` `recovery.ts:163` (waiting steps whose task is terminal) | `run.status = 'waiting'` |
| `H6` | per stuck row, re-read run `:168-170` | `run.status = 'waiting'` |
| `H7` | `failStepAndRunIfWaiting` `recovery.ts:180` -> `task-step-routing.ts:24-46` | CAS on `step.status='waiting'` |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:197` -> `task-step-routing.ts:96-143`, then `walkGraph(successors)` `:213` | CAS on `step.status='waiting'` inside the transaction; sets `run -> running` |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — |
| `E1` | `resumeFromTaskCompletion` `resume.ts:138-142` / `handleTaskFailure` `:238-242` pre-checks | reads, outside any transaction |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:164` (CAS on the step only), then `walkGraph(successors)` `:183` | step CAS; run status is not re-checked |
| `EFin` | `finalizeOrWait` `resume.ts:201-224` | transaction; no run-status guard. F6: while any node's latest row is `running` (`:209`), only `waiting -> running` and return, leaving the run to the live walk's finalizer |
| `EF` | `markRunFailed` `resume.ts:308` -> `failStepAndRunIfWaiting` | step CAS |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:432` -> `cancelWorkflowRunRows` `:386-425` | one transaction; skips steps whose status is terminal, **including `failed` rows that still carry `nextRetryAt`**. F1 keeps the poller from claiming those rows. |
| `U1` | `retryFailedRun` reads `resume.ts:315-340` (`findReadyNodes` `:367`) | reads outside the transaction. F5: drops nodes whose step is `running` or `waiting` (`liveNodeIds` `:364-369`). **Retry-pending nodes are not dropped (open, CX9).** |
| `U2` | claim transaction `resume.ts:348-357`, then `walkGraph(nodesToRun)` `:378` | `run.status = 'failed'`; resets the failed row to `pending` (orphaned: the walk inserts a new row) |

## Crash

`Crash` drops process-local state (`activeWalks`, `executingSteps`, executor calls, undelivered
bus events) and grants one extra heartbeat sweep (boot recovery). DB rows survive.

## Invariants (design doc §5)

| Invariant | Kind | Meaning |
|---|---|---|
| `TerminalRunStaysQuiet` | action property | Inv1: a terminal run never gains a running/pending step; a completed or cancelled run never changes status |
| `AtMostOneExecuting` | state | Inv2: at most one live execution per node (executor call or dispatched task) |
| `ExecutesOnce` | state | Inv3: every node completes at most once |
| `JoinWaitsForAll` | action property | Inv3b: the join row is only created after every branch completed. Not a property of `main` since #1673: a terminally failed branch still joins (partial failure) |
| `JoinWaitsForBranches` | action property | Inv3c (#1673): the join row is only created once every branch has a row and none is running, waiting, or `pending` |
| `CompletedRunQuiescent` | state | Inv4 (bf12ab53): a completed run has no live step |
| `EventuallySettles` | liveness | Inv5: defined, not checked in the pilot configs (see FINDINGS.md) |

## Fix flags

`Fix*` constants model the fixes in FINDINGS.md. `Workflows.cfg` and `Long.cfg` model current
`main`: F1 `FixPollerRunGuard` (#1666), F3 `FixConcurrentJoin` and F5 `FixUserRetryLive` (#1675),
F4 `FixRecoveryRetry` (#1678), and F6 `FixJoinWaitsLive` (#1673) are `TRUE`. F2
`FixPendingRetryGate` is `FALSE`: no merged PR keeps a retry-pending predecessor's edge active.
