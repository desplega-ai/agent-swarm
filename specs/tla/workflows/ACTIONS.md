# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers are against `main` @ `92fc18110` (after #2314 and #2316). A DB transaction is one atomic action. Every
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
| `active` | `activeWalks.get(runId)` (`engine.ts:236`, process-local), taken by `walkGraph` and `holdWorkflowRun` (`engine.ts:278`) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |
| `thr[Ev(i, g)]` | the bus handler for the `g`-th task bound to row `i` (`Bound(i, g)` = that task is still the one bound, `isTaskBoundToStep` `task-step-routing.ts:60`) |
| `Owned` (derived) | F3: `executingSteps` (`engine.ts:241`, process-local, cleared by a crash) |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:297` | `activeWalks` +1 via `holdWorkflowRun` (no DB guard) |
| `WStart` | `engine.ts:328-398`: rehydrate completed steps `:343`, `loadCompletedStepRouting` `:347`, active edges from `waiting` steps `:363-375`, seed filter `:384-398` | Seed filter = `GuardConvergeSeed`. F6: a predecessor in `awaitedNodeIds` (`:377`, `engine.ts:579`) also holds the node. Reads only, no transaction. |
| `WPick` | `engine.ts:416` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `executeStep` `engine.ts:673`, claim transaction `:754` | `run.status IN (running, waiting)` else halted (`:690-693`, returned as completed `:760`). F3: `getCurrentStepForNode` (`:702`, `db.ts:8408`) memoizes a node whose latest row is completed, waiting, or running and owned by this process (`executingSteps`), with no newer predecessor completion; a live one pauses the walk (`:761-767`). Otherwise `iteration = COUNT(*)` (`:711`, `getStepCountForNode` `db.ts:8382`) and INSERT. |
| `XRun` | `executor.run` `engine.ts:895` (in `runClaimedStep` `:804`) | none (process-local) |
| `XCkOk` | `checkpointStep` `engine.ts:1023` -> `checkpoint.ts:7-28` | transaction, blind `UPDATE step SET status='completed'` |
| `XFail` | `checkpointStepFailure` `engine.ts:908` / `:927` / `:1004` -> `checkpoint.ts:43-55` | blind `UPDATE step SET status='failed', retryCount+1, nextRetryAt`; `executeStep` returns `completed` with no successors (`:920`, `:943`, `:1011`), so the walk adds the node to `completedNodeIds` (`engine.ts:448`). **The F2 edge is not kept (open, CX8).** The System One guards (#1715: `systemOneRetryViolations` `:821`, `strictUnresolved` `:860`) fail the step with no retry before `executor.run`: an `XFail` whose retry budget is already spent. Since #2290 they cover both `system-one-decision` and `system-one-extraction` nodes (`isSystemOneNodeType`); the model does not distinguish node types, so this `XFail` already covers both. |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:962` -> `checkpoint.ts:91-117` | CAS `WHERE status='running'`, run `IN (running, waiting)`. The `keepRunStatus` option (#2314) is passed only by the foreach park, which the model does not have |
| `WBatchEnd` | `engine.ts:428-494` in-walk convergence | in-memory `completedNodeIds` / `activeEdges`. F6: re-reads the steps (`:469-471`): a predecessor whose latest row completed elsewhere is rehydrated (`:476-482`), one in `awaitedNodeIds` holds the join (`:483-485`) |
| `WFinal` | `engine.ts:504-560` finalization transaction | `run.status = 'running'`; F6: returns while any node's latest row is `running` (`hasRunningStep` `:510`, `engine.ts:593`); `waiting` steps -> waiting; pending retries -> stay running; else completed/failed. A `pending` row is not counted (CX10). Since #2314 foreach item rows are left out of the failed/completed tallies (`:515-528`); the model has no foreach items, so the guard is unchanged for it. |
| `WRet` | `engine.ts:313` `release()` | `activeWalks` -1 |

## Trigger (`engine.ts:96-221`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createWorkflowRun` `engine.ts:134` / `:151` commits `running` | none |
| `IWalk` | `resolveRenderedWorkflowInputs` `engine.ts:190` awaits before `walkGraph` `:204` (only when `InputAwait`) | none; F3 covers the recovery walk that lands in this window (CX6) |

Not modelled: the readiness preflight (#1715, `findWorkflowReadinessProblems` `engine.ts:167-175`) runs after `IStart` and before `IWalk`. When an executor cannot run, it writes `run -> failed` with no guard and returns without walking. The model assumes every executor is ready, so that branch is unreachable. Its `await` also opens the CX6 window when `InputAwait` is off; F3 still covers a recovery walk that lands there.

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:37` -> `db.ts:8338-8351` | `status='failed' AND nextRetryAt <= now`. F1: `AND run.status IN (running, waiting, failed)` |
| `P2` | `getWorkflowRun` `retry-poller.ts:42` | read |
| `P3` | pre-F1: blind `run -> running` if the snapshot said `failed` | F1: removed; the revive moved into `claimRetry` (`P4`) |
| `P4` | `holdWorkflowRun` `retry-poller.ts:58`, `claimRetry` `:63` -> `:247-264` | F1: one transaction; `UPDATE step SET status='running', nextRetryAt=NULL WHERE status='failed' AND nextRetryAt IS NOT NULL`, only while the run is `running`/`waiting`/`failed`; revives a `failed` run. F4: the hold makes `isWorkflowRunActive` true for recovery |
| `P5` | `executor.run` `retry-poller.ts:98` | none. A retried foreach parent parks and drives its items (`:117-143`, #2314); not modelled (no foreach node) |
| `P6` | `checkpointStep` `retry-poller.ts:200`, then `walkGraph(successors)` `:205` | blind step write |
| `P9` | no successors: `completeRunIfSettled` `retry-poller.ts:214` -> `:271-289` | F1: one transaction, only while the run is `running`/`waiting` and no step is running, waiting, or pending retry |
| `P7` | `checkpointStepFailure` `retry-poller.ts:109` | blind step write |
| `P10` | `checkpoint.ts:57-81` retries exhausted | F1: `run -> failed` in a transaction, only while the run is `running`/`waiting` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:151` | CAS (as `XCkWait`) |
| `PRel` | end of one row, `finally` `retry-poller.ts:227-228` | F4: releases the `holdWorkflowRun` taken at `P4` |

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:93`, `isWorkflowRunActive` `:98` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:99`, completed steps, routing, `findReadyNodes` `:118` | `findReadyNodes` excludes only nodes with a **completed** step. F4: also drops nodes with a retry-pending row (`retryPendingNodeIds` `:117-120`, `:150`) |
| `H3` | second `isWorkflowRunActive` `:122`, then complete or `walkGraph` `:129` | `GuardActiveWalk` |
| `H4` | `recovery.ts:123-126` `readyNodes.length === 0` | F4: `completeIfSettled` `recovery.ts:164-184`, one transaction, only while `running` with no retry-pending row and no live latest row |
| `H5` | `getStuckWorkflowRuns` `recovery.ts:191` (waiting steps whose task is terminal); snapshot `<<step, task generation, task status>>` | `run.status = 'waiting'` |
| `H6` | per stuck row, re-read run `:196-198` | `run.status = 'waiting'` |
| `H7R` | F7: failed task only, `scheduleTaskStepRetry` `recovery.ts:201-218` -> `task-step-routing.ts:223-251` | one transaction: step `waiting` AND the snapshot's task still bound, else not-claimed (skip the row). `retryCount < maxRetries`: detach the task, `checkpointStepFailure` (failed, retryCount+1, nextRetryAt), skip the row. Exhausted: not-eligible, fall through to `H7` |
| `H7` | `failStepAndRunIfWaiting` `recovery.ts:219-237` -> `task-step-routing.ts:79-113` | CAS on `step.status='waiting'`; F7: `ownerTaskId` fence, the snapshot's task must still be bound. The fail-fast test is `stepFailureMode` (#2316), which is the workflow's `onNodeFailure` for every non-foreach step |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:250-259` -> `task-step-routing.ts:263-314`, then `walkGraph(successors)` `:268` | CAS on `step.status='waiting'` inside the transaction (F7: plus the `ownerTaskId` fence); sets `run -> running` |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — |
| `E1` | `resumeFromTaskCompletionUnguarded` `resume.ts:198-228` / `handleTaskFailureUnguarded` `:327-342` pre-checks | reads, outside any transaction: run `waiting`/`running`, step `waiting`, `isStaleTaskEvent` (`:440-444`, another task is bound). Since #2316 a run that is not `waiting`/`running` goes to `recordLateForeachOutcome` (`:215-221`, `:329-335`, `:412-431`), which writes only a foreach item of a `failed` run; for every modelled row it returns with no write |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:233` (CAS on the step only), then `walkGraph(successors)` `:255` | step CAS; run status is not re-checked |
| `EFin` | `finalizeOrWait` `resume.ts:273-300` | transaction; **no run-status guard (open, CX13)**. F6: while any node's latest row is `running` (`:281`), only `waiting -> running` and return, leaving the run to the live walk's finalizer. F7: a retry-pending row (`failed` with `nextRetryAt`) keeps the run `waiting` (`:287-289`) |
| `ER` | F7: `task.failed` only (`retryable: true`, `resume.ts:110`; `task.cancelled` skips it), `scheduleTaskStepRetry` `resume.ts:344-359` | same transaction as `H7R`. scheduled or not-claimed: stop. not-eligible: `EF` |
| `EF` | `markRunFailed` `resume.ts:366` -> `:452-466` `failStepAndRunIfWaiting` | step CAS (no `ownerTaskId` on the live path). The fail-fast test is `stepFailureMode` (`:363`, #2316), the workflow's `onNodeFailure` for every non-foreach step |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:690` -> `cancelWorkflowRunRows` `:644-684` | one transaction; skips steps whose status is terminal, **including `failed` rows that still carry `nextRetryAt`**. F1 keeps the poller from claiming those rows. |
| `U1` | `retryFailedRun` reads `resume.ts:471-512` (`findReadyNodes` `:556`) | reads outside the transaction. Since #2316 the failed step is the first node, in order of its first row, whose **latest** row is `failed` (`latestStepPerNode` `:480-483`, `:578-582`); an older failed row of a node with a newer row is not picked. F5: drops nodes with any `running` or `waiting` row (`liveNodeIds` `:553-558`). **Retry-pending nodes are not dropped (open, CX9).** |
| `U2` | claim transaction `resume.ts:518-546`, then `walkGraph(nodesToRun)` `:567` | `run.status = 'failed'`; resets the failed row to `pending` (orphaned: the walk inserts a new row). The foreach attempt rows and step-cap refusal (`:525-543`, #2316) add nothing for a run without foreach items |

Retry eligibility (#2262, `scheduleTaskStepRetry` `task-step-routing.ts:230-240`, before the claim transaction): a node's own `retry` wins; a node without one gets `SUPERSEDE_RETRY_POLICY` (`:197-202`, one retry) when its task failed with `superseded_workflow_task` (`isSupersedeCut` `:253-257`), else not-eligible. Not modelled separately: every model branch already has a retry policy with `MaxRetries >= 1`, so `ER` and `H7R` already retry any failed task, which over-approximates the supersede-only policy. The claim transaction is unchanged.

Not modelled: `retryFailedRun` refuses before the claim when a node still to run is not ready (#1715, `resume.ts:490-496`). It is a read with no write, and the model's executors are always ready.

## Unreadable replay state (#1926, `ReplayUnreadable`)

Run and step reads default to the replay view, which opens the sealed `context_replay` /
`output_replay` copy lazily, on first property access (`defineWorkflowPayload`
`workflow-replay.ts:43-77`). When the copy cannot be opened (missing or rotated key, corrupt
ciphertext) the read throws `WorkflowReplayStateError`, and `failRunOnUnreadableReplay`
(`engine.ts:249-267`) fails the claimed step, then the run. Both writes go through
`updateWorkflowRunStep` / `updateWorkflowRun` (`db.ts:8200`, `:7963`), whose `UPDATE` is
`WHERE id = ?` only, and they are separate awaits. With `ReplayUnreadable`, each read site below may
throw instead of the action that performs the read.

| Action | Code | Guard |
|---|---|---|
| `WStartUnreadable` | `rehydrateCompletedStepOutputs` `engine.ts:343` opens each completed step's output; `walkGraph` catch `:311` | enabled only when a completed row exists. Run write only (no step id); the walk then releases `activeWalks` (`WRet`) |
| `XDedupUnreadable` | F3: a memoized completed node opens its stored output after the dedup transaction (`engine.ts:765`, `:772`); `.catch` `:421` | run write only; the node reports `failed`. `WBatchEnd` then re-reads the run and stops the walk if it is `failed` (`engine.ts:434-440`), else skips the node's successors |
| `P5Unreadable` | `run.context` in `rebuildNodeExecutionInput` (`retry-poller.ts:74` -> `step-input.ts:42`), after `claimRetry`; catch `:217` / `:224` | step write on the claimed row, then run write; `PRel` releases the hold |
| `H2Unreadable` | `run.context` `recovery.ts:106`, after the `running` re-check `:100`; catch `:141` | run write only; the sweep moves on to the waiting runs (`H5`) |
| `H8Unreadable` | completed task: `run.context` `recovery.ts:239`, before the claim; catch `:280` | run write only; the sweep moves on to the next stuck row (`H6`) |
| `E2Unreadable` | `run.context` `resume.ts:231`, after the `E1` checks, before the claim; `failClosedOnUnreadableReplay` `resume.ts:165-175`. With `ChildRunResume` also from `eF` (see Sub-workflow steps) | step write on the event's row, then run write |
| `RFStep` | `updateWorkflowRunStep(stepId, failed, nextRetryAt null)` `engine.ts:258-263` | **none** (`WHERE id = ?`) |
| `RFRun` | `updateWorkflowRun(runId, failed)` `engine.ts:265` | **none** (`WHERE id = ?`); a completed or cancelled run becomes `failed` (open, CX14) |

Not modelled: `runClaimedStep`'s catch (`engine.ts:793`). The ctx it renders from was already
opened by `WStart`'s rehydration or by the caller's `run.context` read, and the model's executors
read no other replay state. The approval and wait-state sweeps (`recovery.ts:383`, `:417`) and
resumes (`resume.ts:789`, `:875`, `:891`), and `handleTaskFailure`'s `onNodeFailure: "continue"` read
(`resume.ts:371`), belong to node kinds and policies the model does not have. `retryFailedRun`
reads `run.context` (`resume.ts:517`) before its claim and throws to the caller with no write.
The wait-state sweep's replay of a wait resolved before a crash (#2257, `recoverResolvedWaitState`
`resume.ts:881-894`) is the same unmodelled node kind.

## Sub-workflow steps (#2030, `ChildRunResume`)

A `sub-workflow` step starts a child run (`executors/sub-workflow.ts`) and parks `waiting` until
the child is terminal. With `ChildRunResume`, every async branch is such a step: the bound
"task" is the child run, `TaskFinish` is the child reaching a terminal status (completed: `ok`;
failed, cancelled, or skipped: `fail`), and every resume path runs `resumeFromChildRun`
(`resume.ts:971-1037`). It reads the step and the child outside any transaction, then the run and
(since #2314, before both the success and the failure branch) `run.context` inside
`failClosedOnUnreadableReplay`, then claims with the same step CAS as the agent-task path plus a run-status check (#2257). It has no task-generation fence and no
retry policy, and a failed child fails the step and the run.

| Action | Code | Guard |
|---|---|---|
| `E1` | `workflow.child.finished` listener `resume.ts:140-149` -> `resumeFromChildRun` pre-checks `:974-988` | step `waiting`, child terminal, run `waiting`/`running`. No `isStaleTaskEvent`; a failed child goes to `EF` (no `ER`) |
| `E2` / `E2Unreadable` / `EFin` / `EF` | `checkpointPortStepAndResolveSuccessors` `resume.ts:1005-1014` -> `task-step-routing.ts:132-176`, then `walkGraph` `:1023` or `finalizeOrWait` `:1033`; `run.context` `:992`; `failStepAndRunIfWaiting` `:997-1004` | as the agent-task rows, except the `E2` claim: step CAS AND run `waiting`/`running` in the same transaction (#2257, `task-step-routing.ts:145-148`), else not claimed; then `run -> running`. No run guard in `finalizeOrWait`. Since #2314 the `run.context` read precedes the failure branch too, so `E2Unreadable` is enabled from `eF` as well as `e2` |
| `XCkWait` (re-arm) | `runClaimedStep` `engine.ts:962-967`: a parked step calls `resumeFromChildRun` inline | a child that finished before the park had its event dropped (`E1` saw the step `running`). Modelled as re-entering the row's event thread at `E1`. The walker blocks on the real call and then reports `waiting`, so letting it run on concurrently only adds interleavings |
| `H9` | Case 5 `recovery.ts:67-74` -> `getSettledChildRunParentSteps` `workflow-runs.ts:69-79` | waiting sub-workflow rows whose child is terminal. **No run-status filter**, unlike `H5` |
| `H10` | `resumeFromChildRun` pre-checks `resume.ts:974-988` | as `E1` |
| `H11` / `H11Unreadable` | claim `resume.ts:1005-1014` / `run.context` `:992` (also before `H12` since #2314) | step CAS AND run `waiting`/`running` (#2257), `run -> running`, then `walkGraph(successors)` back to `H10`, or `H13` |
| `H12` | `failStepAndRunIfWaiting` `resume.ts:997-1004` | step CAS (no `ownerTaskId`) |
| `H13` | `finalizeOrWait` `resume.ts:1033` | as `EFin` (no run-status guard) |

With `ChildRunResume`, `H5` finds no row: `getStuckWorkflowRuns` joins `agent_tasks`, and a
sub-workflow step has none. Not modelled: a deleted child (`wakeParentsOfDeletedRuns`,
`workflow-runs.ts:84-90`) fails the step like a failed child (`EF` / `H12`); the child run's
own walk (one run in the model); and a retried sub-workflow step reconnecting to its existing
child (`sub-workflow.ts:85-87`), which the model over-approximates by dispatching a fresh child.

Port routing (#1706, `resolveValidationPort` at `engine.ts:1020` and `retry-poller.ts:197`) is not modelled: the graph has no ports, and every node's successors are fixed.

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

`ChildRunResume` (#2030) is a node-kind constant, not a fix flag: `TRUE` makes every async branch
a `sub-workflow` step. It is `FALSE` in every config except `Probe-child-run*.cfg`, so those configs
keep their verdicts and state spaces.

`ReplayUnreadable` is an environment constant, not a fix flag: `TRUE` lets every read site in
"Unreadable replay state" throw. It is `FALSE` in every config except `Probe-replay-unreadable.cfg`
and `Probe-child-run-unreadable.cfg`, so those configs keep their verdicts and state spaces.

## Not modelled: foreach fan-outs (#2314, #2316)

The graph has no `foreach` node, so none of the foreach paths are reachable: the parent park and
item drive (`parkAndDriveForeach`, `engine.ts:948-961`, `retry-poller.ts:117-143`), the
heartbeat Case 6 re-drive of queued or orphaned items (`recoverForeachFanouts`,
`recovery.ts:434-478`, which selects only `#`-suffixed item rows), item settlement through
`settleForeachChild` in `failStepAndRunIfWaiting`, `checkpointPortStepAndResolveSuccessors` and
`completeTaskStepAndResolveSuccessors`, the per-fan-out failure policy (`stepFailureMode`), late
outcomes of a failed run's items (`recordLateForeachOutcome`), and the attempt rows a run retry
adds per failed item (`createForeachAttemptSteps`). For every non-foreach step these helpers take
the pre-existing branch, so the modelled guards are unchanged.
