# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers in `engine.ts`, `recovery.ts`, `resume.ts`, and `retry-poller.ts` are against `main` @ `262770f33` (#1926). `db.ts` and `checkpoint.ts` lines are against `80949f9aa`, and `task-step-routing.ts` lines against `eaf5d0cc1` (#1832). A DB transaction is one atomic action. Every
`await` outside a transaction is an action boundary: other actors interleave there, and a crash
can land there.

Where a fix flag is noted (F1..F7), the row describes the code with the fix, which is current
behavior on `main` for every flag except F2 (see "Fix flags" below). The `.tla` keeps the pre-fix
branch of each action for the `Ctl-*` and calibration configs.

## State

| Variable | Code |
|---|---|
| `run` | `workflow_runs.status` (`none` before the INSERT) |
| `steps[i]` | one `workflow_run_steps` row: `node`=nodeId, `st`=status, `rc`=retryCount, `nra`=`nextRetryAt IS NOT NULL`, `task`=state of the agent task bound to the row (`none` when detached), `tg`=task generation, +1 per dispatch (F7: a retry binds a fresh task to the same row) |
| `active` | `activeWalks.get(runId)` (`engine.ts:223`, process-local), taken by `walkGraph` and `holdWorkflowRun` (`engine.ts:265`) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |
| `thr[Ev(i, g)]` | the bus handler for the `g`-th task bound to row `i` (`Bound(i, g)` = that task is still the one bound, `isTaskBoundToStep` `task-step-routing.ts:31`) |
| `Owned` (derived) | F3: `executingSteps` (`engine.ts:228`, process-local, cleared by a crash) |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:284` | `activeWalks` +1 via `holdWorkflowRun` (no DB guard) |
| `WStart` | `engine.ts:315-386`: rehydrate completed steps `:330`, `loadCompletedStepRouting` `:334`, active edges from `waiting` steps `:350-363`, seed filter `:371-385` | Seed filter = `GuardConvergeSeed`. F6: a predecessor in `awaitedNodeIds` (`:364`, `engine.ts:561`) also holds the node. Reads only, no transaction. |
| `WPick` | `engine.ts:403` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `executeStep` `engine.ts:655`, claim transaction `:736` | `run.status IN (running, waiting)` else halted (`:672-675`, returned as completed `:742`). F3: `getCurrentStepForNode` (`:684`, `db.ts:8061`) memoizes a node whose latest row is completed, waiting, or running and owned by this process (`executingSteps`), with no newer predecessor completion; a live one pauses the walk (`:743-749`). Otherwise `iteration = COUNT(*)` (`:693`, `db.ts:8035`) and INSERT. |
| `XRun` | `executor.run` `engine.ts:888` (in `runClaimedStep` `:786`) | none (process-local) |
| `XCkOk` | `checkpointStep` `engine.ts:997` -> `checkpoint.ts:7-27` | transaction, blind `UPDATE step SET status='completed'` |
| `XFail` | `checkpointStepFailure` `engine.ts:901` / `:920` / `:978` -> `checkpoint.ts:43-55` | blind `UPDATE step SET status='failed', retryCount+1, nextRetryAt`; `executeStep` returns `completed` with no successors (`:913`, `:936`, `:985`), so the walk adds the node to `completedNodeIds` (`engine.ts:435`). **The F2 edge is not kept (open, CX8).** The system-one-decision guards (#1715: `systemOneRetryViolations` `:803`, `strictUnresolved` `:842`) fail the step with no retry before `executor.run`: an `XFail` whose retry budget is already spent. |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:941` -> `checkpoint.ts:87-110` | CAS `WHERE status='running'`, run `IN (running, waiting)` |
| `WBatchEnd` | `engine.ts:415-481` in-walk convergence | in-memory `completedNodeIds` / `activeEdges`. F6: re-reads the steps (`:456-458`): a predecessor whose latest row completed elsewhere is rehydrated (`:463-469`), one in `awaitedNodeIds` holds the join (`:470-473`) |
| `WFinal` | `engine.ts:491-538` finalization transaction | `run.status = 'running'`; F6: returns while any node's latest row is `running` (`hasRunningStep` `:497`, `engine.ts:575`); `waiting` steps -> waiting; pending retries -> stay running; else completed/failed. A `pending` row is not counted (CX10). |
| `WRet` | `engine.ts:300` `release()` | `activeWalks` -1 |

## Trigger (`engine.ts:92-205`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createWorkflowRun` `engine.ts:130` / `:146` commits `running` | none |
| `IWalk` | `resolveRenderedWorkflowInputs` `engine.ts:184` awaits before `walkGraph` `:198` (only when `InputAwait`) | none; F3 covers the recovery walk that lands in this window (CX6) |

Not modelled: the readiness preflight (#1715, `findWorkflowReadinessProblems` `engine.ts:161-169`) runs after `IStart` and before `IWalk`. When an executor cannot run, it writes `run -> failed` with no guard and returns without walking. The model assumes every executor is ready, so that branch is unreachable. Its `await` also opens the CX6 window when `InputAwait` is off; F3 still covers a recovery walk that lands there.

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:38` -> `db.ts:7991-8004` | `status='failed' AND nextRetryAt <= now`. F1: `AND run.status IN (running, waiting, failed)` |
| `P2` | `getWorkflowRun` `retry-poller.ts:43` | read |
| `P3` | pre-F1: blind `run -> running` if the snapshot said `failed` | F1: removed; the revive moved into `claimRetry` (`P4`) |
| `P4` | `holdWorkflowRun` `retry-poller.ts:59`, `claimRetry` `:64` -> `:232-249` | F1: one transaction; `UPDATE step SET status='running', nextRetryAt=NULL WHERE status='failed' AND nextRetryAt IS NOT NULL`, only while the run is `running`/`waiting`/`failed`; revives a `failed` run. F4: the hold makes `isWorkflowRunActive` true for recovery |
| `P5` | `executor.run` `retry-poller.ts:111` | none |
| `P6` | `checkpointStep` `retry-poller.ts:185`, then `walkGraph(successors)` `:190` | blind step write |
| `P9` | no successors: `completeRunIfSettled` `retry-poller.ts:199` -> `:256-274` | F1: one transaction, only while the run is `running`/`waiting` and no step is running, waiting, or pending retry |
| `P7` | `checkpointStepFailure` `retry-poller.ts:122` | blind step write |
| `P10` | `checkpoint.ts:57-80` retries exhausted | F1: `run -> failed` in a transaction, only while the run is `running`/`waiting` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:136` | CAS (as `XCkWait`) |
| `PRel` | end of one row, `finally` `retry-poller.ts:212-213` | F4: releases the `holdWorkflowRun` taken at `P4` |

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:73`, `isWorkflowRunActive` `:78` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:79`, completed steps, routing, `findReadyNodes` `:98` | `findReadyNodes` excludes only nodes with a **completed** step. F4: also drops nodes with a retry-pending row (`retryPendingNodeIds` `:97-100`, `:130`) |
| `H3` | second `isWorkflowRunActive` `:102`, then complete or `walkGraph` `:109` | `GuardActiveWalk` |
| `H4` | `recovery.ts:103-106` `readyNodes.length === 0` | F4: `completeIfSettled` `recovery.ts:144-164`, one transaction, only while `running` with no retry-pending row and no live latest row |
| `H5` | `getStuckWorkflowRuns` `recovery.ts:171` (waiting steps whose task is terminal); snapshot `<<step, task generation, task status>>` | `run.status = 'waiting'` |
| `H6` | per stuck row, re-read run `:176-178` | `run.status = 'waiting'` |
| `H7R` | F7: failed task only, `scheduleTaskStepRetry` `recovery.ts:181-198` -> `task-step-routing.ts:118-140` | one transaction: step `waiting` AND the snapshot's task still bound, else not-claimed (skip the row). `retryCount < maxRetries`: detach the task, `checkpointStepFailure` (failed, retryCount+1, nextRetryAt), skip the row. Exhausted: not-eligible, fall through to `H7` |
| `H7` | `failStepAndRunIfWaiting` `recovery.ts:206-212` -> `task-step-routing.ts:44-67` | CAS on `step.status='waiting'`; F7: `ownerTaskId` fence, the snapshot's task must still be bound |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:228-236` -> `task-step-routing.ts:166-216`, then `walkGraph(successors)` `:245` | CAS on `step.status='waiting'` inside the transaction (F7: plus the `ownerTaskId` fence); sets `run -> running` |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — |
| `E1` | `resumeFromTaskCompletionUnguarded` `resume.ts:169-174` / `handleTaskFailureUnguarded` `:287-292` pre-checks | reads, outside any transaction: run `waiting`/`running`, step `waiting`, `isStaleTaskEvent` (`:363-367`, another task is bound) |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:196` (CAS on the step only), then `walkGraph(successors)` `:215` | step CAS; run status is not re-checked |
| `EFin` | `finalizeOrWait` `resume.ts:233-260` | transaction; **no run-status guard (open, CX13)**. F6: while any node's latest row is `running` (`:241`), only `waiting -> running` and return, leaving the run to the live walk's finalizer. F7: a retry-pending row (`failed` with `nextRetryAt`) keeps the run `waiting` (`:247-249`) |
| `ER` | F7: `task.failed` only (`retryable: true`, `resume.ts:93`; `task.cancelled` skips it), `scheduleTaskStepRetry` `resume.ts:297-312` | same transaction as `H7R`. scheduled or not-claimed: stop. not-eligible: `EF` |
| `EF` | `markRunFailed` `resume.ts:317` -> `:375-377` `failStepAndRunIfWaiting` | step CAS (no `ownerTaskId` on the live path) |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:511` -> `cancelWorkflowRunRows` `:465-504` | one transaction; skips steps whose status is terminal, **including `failed` rows that still carry `nextRetryAt`**. F1 keeps the poller from claiming those rows. |
| `U1` | `retryFailedRun` reads `resume.ts:382-422` (`findReadyNodes` `:446`) | reads outside the transaction. F5: drops nodes whose step is `running` or `waiting` (`liveNodeIds` `:443-447`). **Retry-pending nodes are not dropped (open, CX9).** |
| `U2` | claim transaction `resume.ts:427-436`, then `walkGraph(nodesToRun)` `:457` | `run.status = 'failed'`; resets the failed row to `pending` (orphaned: the walk inserts a new row) |

Not modelled: `retryFailedRun` refuses before the claim when a node still to run is not ready (#1715, `resume.ts:399-405`). It is a read with no write, and the model's executors are always ready.

## Unreadable replay state (#1926, `ReplayUnreadable`)

Run and step reads default to the replay view, which opens the sealed `context_replay` /
`output_replay` copy lazily, on first property access (`defineWorkflowPayload`
`workflow-replay.ts:43-77`). When the copy cannot be opened (missing or rotated key, corrupt
ciphertext) the read throws `WorkflowReplayStateError`, and `failRunOnUnreadableReplay`
(`engine.ts:236-254`) fails the claimed step, then the run. Both writes go through
`updateWorkflowRunStep` / `updateWorkflowRun` (`db.ts:7994`, `:7758`), whose `UPDATE` is
`WHERE id = ?` only, and they are separate awaits. With `ReplayUnreadable`, each read site below may
throw instead of the action that performs the read.

| Action | Code | Guard |
|---|---|---|
| `WStartUnreadable` | `rehydrateCompletedStepOutputs` `engine.ts:330` opens each completed step's output; `walkGraph` catch `:298` | enabled only when a completed row exists. Run write only (no step id); the walk then releases `activeWalks` (`WRet`) |
| `XDedupUnreadable` | F3: a memoized completed node opens its stored output after the dedup transaction (`engine.ts:747`, `:754`); `.catch` `:408` | run write only; the node reports `failed`. `WBatchEnd` then re-reads the run and stops the walk if it is `failed` (`engine.ts:421-427`), else skips the node's successors |
| `P5Unreadable` | `run.context` `retry-poller.ts:66`, after `claimRetry`; catch `:204` / `:210` | step write on the claimed row, then run write; `PRel` releases the hold |
| `H2Unreadable` | `run.context` `recovery.ts:86`, after the `running` re-check `:80`; catch `:121` | run write only; the sweep moves on to the waiting runs (`H5`) |
| `H8Unreadable` | completed task: `run.context` `recovery.ts:217`, before the claim; catch `:257` | run write only; the sweep moves on to the next stuck row (`H6`) |
| `E2Unreadable` | `run.context` `resume.ts:180`, after the `E1` checks, before the claim; `failClosedOnUnreadableReplay` `resume.ts:136-146` | step write on the event's row, then run write |
| `RFStep` | `updateWorkflowRunStep(stepId, failed, nextRetryAt null)` `engine.ts:243-250` | **none** (`WHERE id = ?`) |
| `RFRun` | `updateWorkflowRun(runId, failed)` `engine.ts:252` | **none** (`WHERE id = ?`); a completed or cancelled run becomes `failed` (open, CX14) |

Not modelled: `runClaimedStep`'s catch (`engine.ts:776`). The ctx it renders from was already
opened by `WStart`'s rehydration or by the caller's `run.context` read, and the model's executors
read no other replay state. The approval and wait-state sweeps (`recovery.ts:359`, `:402`) and
resumes (`resume.ts:583`, `:695`), and `handleTaskFailure`'s `onNodeFailure: "continue"` read
(`resume.ts:322`), belong to node kinds and policies the model does not have. `retryFailedRun`
reads `run.context` (`resume.ts:426`) before its claim and throws to the caller with no write.

Port routing (#1706, `resolveValidationPort` at `engine.ts:994` and `retry-poller.ts:182`) is not modelled: the graph has no ports, and every node's successors are fixed.

## Crash

`Crash` drops process-local state (`activeWalks`, `executingSteps`, executor calls, undelivered
bus events) and grants one extra heartbeat sweep (boot recovery). DB rows survive.

## Invariants (design doc §5)

| Invariant | Kind | Meaning |
|---|---|---|
| `TerminalRunStaysQuiet` | action property | Inv1: a terminal run never gains a running/pending step; a completed or cancelled run never changes status |
| `TerminalNeverFails` | action property | Inv1b (#1926): a completed or cancelled run never becomes `failed`. Narrower than Inv1, so CX13 (cancelled -> completed) does not mask it. Checked by `Probe-replay-unreadable*.cfg` |
| `AtMostOneExecuting` | state | Inv2: at most one live execution per node (executor call or dispatched task) |
| `ExecutesOnce` | state | Inv3: every node completes at most once |
| `JoinWaitsForAll` | action property | Inv3b: the join row is only created after every branch completed. Not a property of `main` since #1673: a terminally failed branch still joins (partial failure) |
| `JoinWaitsForBranches` | action property | Inv3c (#1673): the join row is only created once every branch has a row and none is running, waiting, or `pending` |
| `CompletedRunQuiescent` | state | Inv4 (bf12ab53): a completed run has no live step |
| `EventuallySettles` | liveness | Inv5: defined, not checked in the pilot configs (see FINDINGS.md) |

## Fix flags

`Fix*` constants model the fixes in FINDINGS.md. `Workflows.cfg` and `Long.cfg` model current
`main`: F1 `FixPollerRunGuard` (#1666), F3 `FixConcurrentJoin` and F5 `FixUserRetryLive` (#1675),
F4 `FixRecoveryRetry` (#1678), F6 `FixJoinWaitsLive` (#1673), and F7 `FixTaskRetry` (#1832) are `TRUE`. F2
`FixPendingRetryGate` is `FALSE`: no merged PR keeps a retry-pending predecessor's edge active.

F7 `FixTaskRetry` (#1832) adds `ER` and `H7R`, the `ownerTaskId` fence on `H7`/`H8`, the
retry-pending clause in `EFin`, and per-generation handler threads. With it off, `tg` never
exceeds 1 and every pre-existing `Fix-*` config gives the same distinct-state count as before.
`TaskGenBound` is a model-sanity invariant: every task generation has a handler thread.

`ReplayUnreadable` is an environment constant, not a fix flag: `TRUE` lets every read site in
"Unreadable replay state" throw. It is `FALSE` in every config except `Probe-replay-unreadable.cfg`,
so those configs keep their verdicts and state spaces.
