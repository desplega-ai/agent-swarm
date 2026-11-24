# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers are against `main` @ `a896cfd28` (after #3485, #3494, #3562). Since #3562 the SQL of the workflow guards lives in the storage repositories: `storage/workflows.ts` is `packages/storage/src/repositories/workflows.ts` (shared by both engines) and `storage-sqlite/workflows.ts` is `packages/storage-sqlite/src/repositories/workflows.ts` (the SQLite copy of a scan that reads `rowid`). A DB transaction is one atomic action. Every
`await` outside a transaction is an action boundary: other actors interleave there, and a crash
can land there.

Since #3562 every transaction goes through `getStorage().transaction`. On SQLite (the default, and the engine the model checks) it is the same FIFO-locked `BEGIN IMMEDIATE` client as before, moved to `packages/storage-sqlite/src/client.ts` (`runTransactionAttempt` `:405`). A callback may now run more than once (a Postgres serialization retry, the test-only `--tx-replay`): the process-local marks a claim sets inside it, `executingSteps` (`claimExecutingStep` `engine.ts:426-429`) and the successor hold (`successor-routing.ts:100`), are given back on each rolled-back attempt (`onAttemptRollback`), so a committed attempt is still one atomic action and a rolled-back one leaves no state. On Postgres (`DATABASE_URL`, SERIALIZABLE with retry) the database serializes the row writes, but the process-local reads inside a transaction (`hasOwedSuccessors`, `executingSteps`) are outside that serialization; the model assumes them atomic with their transaction, as on SQLite.

Where a fix flag is noted (F1..F13), the row describes the code with the fix, which is current
behavior on `main` for every flag except F2 (see "Fix flags" below). The `.tla` keeps the pre-fix
branch of each action for the `Ctl-*` and calibration configs.

## State

| Variable | Code |
|---|---|
| `run` | `workflow_runs.status` (`none` before the INSERT) |
| `steps[i]` | one `workflow_run_steps` row: `node`=nodeId, `st`=status, `rc`=retryCount, `nra`=`nextRetryAt IS NOT NULL`, `task`=state of the agent task bound to the row (`none` when detached), `tg`=task generation, +1 per dispatch (F7: a retry binds a fresh task to the same row) |
| `active` | `activeWalks.get(runId)` (`engine.ts:413`, process-local), taken by `walkGraph` and `holdWorkflowRun` (`engine.ts:471`) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |
| `thr[Ev(i, g)]` | the bus handler for the `g`-th task bound to row `i` (`Bound(i, g)` = that task is still the one bound, `isTaskBoundToStep` `task-step-routing.ts:67`) |
| `Owned` (derived) | F3: `executingSteps` (`engine.ts:418`, process-local, cleared by a crash) |
| `Owed` (derived) | F11 (#2966, #2974): `hasOwedSuccessors` (`successor-routing.ts:22-24`) over the process-local `owed` map (`:14`, cleared by a crash), true while any thread's `dh` is set. `dh`: this thread's walk holds the run, from `Call` until it releases just before its finalizer or in its `finally` |
| `TreeLive` (derived) | F9 (#2377): `getRunLineageBlock` (`workflow-runs.ts:164-183`, SQL `listRunLineage` `storage/workflows.ts:815-828`) finds no cancelled run in the lineage. The model has one root run, so it is `run # "cancelled"` |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:490` (F10/F11 pin) | `activeWalks` +1 via `holdWorkflowRun` (no DB guard). F11: `holdSuccessorRouting` (`engine.ts:503`, `successor-routing.ts:64-70`) before the first await sets `dh`: it takes over the hold of the claim this walk routes (`successorDebt`) or takes a new one. Every claim the model fuses with its `Call` (`E2`, `H8`, `EC`, `HC`, `H11`) takes that hold inside its own transaction (`claimAndOweWalk`, `successor-routing.ts:86-110`, wrapping `completeTaskStepAndResolveSuccessors` `task-step-routing.ts:307` and `checkpointPortStepAndResolveSuccessors` `:149`) and the caller hands it to `walkGraph` (`resume.ts:301`, `:1210`, `recovery.ts:350`), so the fusion is exact: no finalizer sees the completed row without the hold. `P6` has no claim hold; #2974 notes no await between `checkpointStep` and the walk's hold (`retry-poller.ts:257-264`), so its fused `Call` is exact too |
| `WStart` | `engine.ts:524-606`: rehydrate completed steps `:551`, `loadCompletedStepRouting` `:555`, active edges from `waiting` steps `:577-583`, seed filter `:592-606` | Seed filter = `GuardConvergeSeed`. F6: a predecessor in `awaitedNodeIds` (`:585`, `engine.ts:795`) also holds the node. F12 (#3019): so does one whose latest row is pending its retry (`isRetryPending`, `foreach-join.ts:36-38`), which is not in the rehydrated completed set. Reads only, no transaction. |
| `WPick` | `engine.ts:624` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `executeStep` `engine.ts:891`, `claimStep` `:906` run in one transaction `:992-993` | `run.status IN (running, waiting)` else halted (`:907-910`, returned as completed `:995`). F3: `getCurrentStepForNode` (`:922`, `db.ts:6489-6501`, SQL `lastInsertedStepForNode` `storage/workflows.ts:1361-1365` and `hasCompletedStepInsertedAfter` `storage-sqlite/workflows.ts:139-150`) memoizes a node whose latest row is completed, waiting, or running and owned by this process (`executingSteps`, `:925`), with no newer predecessor completion; a live one pauses the walk (`:996-1002`). Otherwise `iteration = COUNT(*)` (`:945`, `getStepCountForNode` `db.ts:6470`) and INSERT. F9 (#2377): the claim also halts while `getRunLineageBlock` (`:913`) blocks, implied by the run-status check for a root run. F8 + `ChildRunResume`: a `sub-workflow` node whose latest row is `running` and not owned (orphaned by a crash) is re-claimed (`:933-941`): same row, same `retryCount`, now owned; `XChild` reconnects to that attempt's child or starts it. F13 (#3215): an `agent-task` row is re-claimed by the same branch (`:933`); `XChild` runs `TaskStart`. With F13 every branch is an agent-task step (`AgentTaskBranches`), as `ChildRunResume` makes every branch a sub-workflow step; any other node type still gets a new row, and the F13-off configs keep checking that path |
| `XRun` | `executor.run` via `runWithNodeDeadline` `engine.ts:1141` (in `runClaimedStep` `:1044`) | none (process-local). Async: the agent-task executor inserts the step's task (`createTaskExtended`, `executors/agent-task.ts:172`; the test-only crash point after it, `:181`, `:199-203`, fires only under `NODE_ENV=test` and is the `Crash` the model already places at that await). F9 (#2377): the INSERT's transaction refuses unless the step is `running` in a `running`/`waiting` run with no cancelled lineage (`getStepExecutionBlock` `db.ts:2381-2384`, `workflow-runs.ts:391-399`); the executor throws, and the catch (`engine.ts:1146`) goes to the fenced `XFail`. Pre-F9 a cancel between the claim and the dispatch left a running task on a cancelled row. F8 + `ChildRunResume`: the async branch is `ChildStart` (below). The step watchdog (`startStepDeadline` `node-timeout.ts:39-52`, raced per executor call in `runWithNodeDeadline` `node-timeout.ts:55-69` since #3349) is the `fail` outcome: on expiry it rejects, then since #2441 aborts `meta.signal`, so an executor that forwards it (swarm-script) stops instead of running on past the `XFail`. The agent-task executor ignores the signal; its dispatch stays fenced by F9 as above |
| `XChild` | F8 + `ChildRunResume`, or F13: `executor.run` of a re-claimed row | `ChildStart`: `SubWorkflowExecutor.execute` (`sub-workflow.ts:86-155`) reads the attempt (`retryCount`) and reuses that attempt's child (`getChildWorkflowRunId(stepId, attempt)`, `workflow-runs.ts:365-370`): running parks, finished is a sync result. With none, the executor may refuse before the start with a failed result (`sub-workflow.ts:101-127`: depth, recursion, a missing or disabled child workflow, and since #3494 a refused run principal, `resolveWorkflowRunPrincipal` `run-principal.ts:38`); with `"fail"` in `BranchOutcomes`, `ChildStart` may go to the fenced `XFail`, which on a first call duplicates the `fail` outcome `XRun` / `P5` pick and on a re-claimed row is the only way to reach it. Otherwise `createRunWithInitialState` (`engine.ts:337-399`) inserts the child in one transaction only while the attempt still runs (`isParentStepAttemptCurrent` `workflow-runs.ts:378-384`, SQL `getLiveStepAttemptRunId` `storage/workflows.ts:908-916`, same predicate as `Fence`; since #2377 also no cancelled lineage) and returns a child another call of the attempt started (unique `(parentStepId, parentStepAttempt)`, migration 240). Not current: `ParentStepNotCurrentError`, the executor fails, and the fenced `XFail` writes nothing. F13 (#3215), no `ChildRunResume`: `TaskStart`, `AgentTaskExecutor.execute` (`executors/agent-task.ts:70-97`) reads the task bound to the step (`getTaskByWorkflowRunStepId` `db.ts:6456-6459`): completed is a sync success (`XCkOk`), any other status parks (`XCkWait`; a failed or cancelled task's event was dropped while the step ran, so the waiting-run sweep settles it). With none it goes to `XTaskIns`: `createTaskExtended` (`:172`), refused (F9) unless the step runs in a live run. The read and the insert are separate awaits, and `agent_tasks.workflowRunStepId` has no unique index (migration 254 indexes it without `UNIQUE`), so a second executor call of the same attempt that also read none binds a second task to the row (`dup`) |
| `XCkOk` | `checkpointStep` `engine.ts:1281` -> `checkpoint.ts:41-72` | transaction, `UPDATE step SET status='completed'`. F8 (#2364): fenced (`holdsFence` `checkpoint.ts:16-19`, SQL `holdsStepFence` `storage/workflows.ts:977-986`): only while the step is `running` with the claimed `retryCount` and the run is `running`/`waiting` (since #2377 also no cancelled lineage, `:18`, implied for a root run); else nothing is written and `executeStep` returns `failed` (`engine.ts:1056`, `:1281`), so `WBatchEnd` re-reads the run and skips the node's successors |
| `XFail` | `checkpointStepFailure` `engine.ts:1152` / `:1177` / `:1260` -> `checkpoint.ts:79-135` | `UPDATE step SET status='failed', retryCount+1, nextRetryAt`, fenced as `XCkOk` since #2364 (F8; stale returns `failed`, `:1161`, `:1185`, `:1268`); `executeStep` returns `completed` with no successors (`:1166`, `:1190`, `:1269`), so the walk adds the node to `completedNodeIds` (`engine.ts:654`). **The F2 edge is not kept.** F12 (#3019): the batch gate no longer counts such a node while its latest row is pending the retry (see `WBatchEnd`); once the poller claims the row (`running`), the gate counts it again (CX8, open). The System One guards (#1715: `systemOneRetryViolations` `:1063`, `strictUnresolved` `:1107`) fail the step with no retry before `executor.run`: an `XFail` whose retry budget is already spent. F8: with the budget spent (reachable in the model only through a re-claimed row), the step and the run (while `running`/`waiting`) fail in one transaction (`checkpoint.ts:112-131`) and the walk sees `failed`. Since #2290 they cover both `system-one-decision` and `system-one-extraction` nodes (`isSystemOneNodeType`); the model does not distinguish node types, so this `XFail` already covers both. The executable-source interpolation guard (`scriptBodyUnresolved` `:1100-1104`; `retry-poller.ts:103-113`, a `P7` with no retry policy) is the same no-retry fail before `executor.run`. Since #3476 it covers `code-match` code and string `wait` filters as well as `script` bodies (`EXECUTABLE_SOURCE_FIELDS` `engine.ts:1403-1407`); only the error text differs per node type, so this `XFail` already covers every such node. |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:1211` -> `checkpoint.ts:144-162` | CAS (not fenced on `retryCount`) `WHERE status='running'`, run `IN (running, waiting)` (`parkRunningStep` `storage/workflows.ts:988-999`); since #2377 also no cancelled lineage (`checkpoint.ts:151`), implied for a root run. The `keepRunStatus` option (#2314) is passed only by the foreach park, which the model does not have |
| `WBatchEnd` | `engine.ts:636-703` in-walk convergence (F10/F11 pin) | in-memory `completedNodeIds` / `activeEdges`. F6: re-reads the steps (`:673-675`): a predecessor whose latest row completed elsewhere is rehydrated (`:680-685`), one in `awaitedNodeIds` holds the join (`:687-696`). F12 (#3019): `awaitedNodeIds` (`:795-808`) also returns a node whose latest row is pending its retry, and the gate (`:693-696`) treats it as not completed even though this walk added it to `completedNodeIds` at `XFail`. A branch the poller already claimed (`running`) is in `completedNodeIds` and is not retry-pending, so the join still fires (CX8, open). F10 (#2957, #2966): a `waiting` outcome (a parked step, or an F3 memoized live node) pauses only its own branch (`:651`, `continue`); the walk routes its siblings' successors and ends in `WFinal`. Pre-F10 the batch returned with no finalizer (`if (hasWaiting) return`), dropping those successors. The release of `dh` on the way to `WFinal` is `routed()` `:714` |
| `WFinal` | `engine.ts:715-776` finalization transaction (F10/F11 pin) | `run.status = 'running'` (since #2377 also no cancelled lineage, `:719`, implied for a root run); F6: returns while any node's latest row is `running` (`hasRunningStep` `:724`, `engine.ts:811-816`); F11: also while another walk holds the run (`hasOwedSuccessors` `:724`; this walk released its own hold at `:714`). #2966 also folds the stored run context into the walker's copy before the write (`adoptStoredContext` `:725`, `checkpoint.ts:27-35`, also in `checkpointStep`, `checkpointStepWaiting`, `completeIfSettled`, `completeRunIfSettled`); not modelled: the model has no run context; `waiting` steps -> waiting; pending retries -> stay running; else completed/failed. A `pending` row is not counted (CX10). Since #2314 foreach item rows are left out of the failed/completed tallies (`engine.ts:732-743`); the model has no foreach items, so the guard is unchanged for it. |
| `WRet` | `engine.ts:518-521` `finally` (F10/F11 pin) | `activeWalks` -1. F11: `routed()` (`:519`, idempotent) drops a hold still held, after an early stop (`WBatchEnd` on a failed run, an unreadable read) |

## Trigger (`engine.ts:126-399`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createRunWithInitialState` `engine.ts:217` -> `:337-399` commits `running` with the initial context in one transaction | none. Since #2364 `holdWorkflowRun` (`:215`) is taken before the commit and released after the walk (`:260`), so `isWorkflowRunActive` is true from the commit on. #2380 runs the caller's `accept` hook (the HTTP trigger's `Idempotency-Key` record) last in the same transaction (`:396`, setup-failure path `:161-173`); a throw rolls the run back. Not modelled: the model has one trigger, and the hook adds no run or step write. #2441 adds `detach` (`trigger-workflow` `wait: false`, `:252-255`): the start returns after the commit and the walk runs on, as a child run does. `walkGraph` takes its own hold before its first await, so the start hold's release (`:260`) leaves `isWorkflowRunActive` true; the model's `IStart` then `Call` order is unchanged. #2572 rechecks the cooldown inside this transaction (`:364-369`): when another run of the workflow committed inside the window, the run commits as `skipped` with no step and the start returns before the walk (`:230`). Not modelled: the check reads other runs of the same workflow, and the model has one run and one trigger, so the recheck never fires and `IStart` is exact. #2727 pins the definition in the same transaction (`pinWorkflowDefinition` `:370`, an `INSERT OR IGNORE` into `workflow_run_definitions` keyed by content hash, stored as the run's `definitionHash`). Not modelled separately: it writes no run or step state, and `IStart` already covers the commit. Every resume path (`P2`, `H2`, `H6`, `H16`, `E1`, `U1`, `resumeFromChildRun`) now reads the graph through `getRunWorkflow` (`db/workflow-run-definitions.ts:91-94`), the pinned snapshot merged over the live row, so an edit mid-run no longer changes the graph a run resumes on. The model's graph is fixed, so this makes that assumption exact instead of changing a guard. #3494 decides the run's principal from the same pinned read (`decideWorkflowRunPrincipal` `:373`, `run-principal.ts:16-32`) and stores it as one more column of the same run INSERT (`principal`, migration 367, `:384`). Not modelled: it adds no run or step write, and its only reader, the `swarm-script` and `sub-workflow` executors (`resolveWorkflowRunPrincipal` `run-principal.ts:38-51`), turns a blocked principal into a `failed` executor result before any side effect, which is the `fail` outcome `XRun` already picks nondeterministically before the fenced `XFail` |
| `IWalk` | pre-#2364 only (`InputAwait`): `resolveRenderedWorkflowInputs` awaited after the INSERT and before `walkGraph` | none; F3 covers the recovery walk that lands in this window (CX6). On `main` the inputs resolve in `buildInitialRunState` (`engine.ts:285-326`, `:315`) before the row exists and the hold covers the commit-to-walk gap, so `InputAwait = TRUE` models older code only |

Not modelled: the readiness preflight (#1715, `findWorkflowReadinessProblems` `engine.ts:293`). Since #2364 it runs before the run row exists, and a run that cannot start commits directly as `failed` (with a cooldown, `skipped`). The model assumes every executor is ready, so that branch is unreachable.

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:49` -> `db.ts:6446-6450` (SQL `listDueRetrySteps` `storage/workflows.ts:1336-1345`) | `status='failed' AND nextRetryAt <= now`. F1: `AND run.status IN (running, waiting, failed)`. A foreach child row is re-queued to `pending` for the foreach driver instead (`retry-poller.ts:60-71`, `claimRetry` `requeueForeachChild`, #2370); not modelled (no foreach node) |
| `P2` | `getWorkflowRun` `retry-poller.ts:54` | read |
| `P3` | pre-F1: blind `run -> running` if the snapshot said `failed` | F1: removed; the revive moved into `claimRetry` (`P4`) |
| `P4` | `holdWorkflowRun` `retry-poller.ts:83`, `claimRetry` `:88` -> `:319-346` | F1: one transaction; `UPDATE step SET status='running', nextRetryAt=NULL WHERE status='failed' AND nextRetryAt IS NOT NULL` (`claimStepRetry` `storage/workflows.ts:1024-1034`), only while the run is `running`/`waiting`/`failed`; revives a `failed` run. F9 (#2377): a run with a cancelled lineage is not claimed and its queued retries are dropped (`:327-329`); for a root run the status check already excludes `cancelled`. F4: the hold makes `isWorkflowRunActive` true for recovery |
| `P5` | `executor.run` via `runWithNodeDeadline` `retry-poller.ts:128` | none. Since #3349 a retried attempt gets the same step watchdog as `XRun`; on expiry it rejects into the catch (`:276`) and takes the fenced `P7`. The model's `P5` already picks `fail` for that, and an attempt that hangs is a `P5` that never fires, so the guard is unchanged. Before #3349 a hung retry held the run (`P4`'s hold) until the executor returned (F8 + `ChildRunResume`: F8 + `ChildRunResume`: `ChildStart`, a retried attempt has no child yet and starts one). A retried foreach parent parks and drives its items (`:149-178`, #2314); not modelled (no foreach node) |
| `P5i` | F13 (#3215): the poller's executor runs the same `AgentTaskExecutor.execute`, so `P5` first reads the task bound to the step (`agent-task.ts:78`) and `P5i` inserts after a `none` read | as `XTaskIns`: F9 refusal goes to the fenced `P7`. A walk that re-claimed the poller's row (the poller does not add to `executingSteps`) races it here |
| `P6` | `checkpointStep` `retry-poller.ts:257`, then `walkGraph(successors)` `:264` (F10/F11 pin) | step write; F8: fenced on the claim (`fence` `:91`, the snapshot's `retryCount`), stale skips the row (`:257-258`). F11: the walk's own hold (see `Call`) |
| `P9` | no successors: `completeRunIfSettled` `retry-poller.ts:273` -> `:353-373` (F10/F11 pin) | F1: one transaction, only while the run is `running`/`waiting` (since #2377 with no cancelled lineage) and no step is running, waiting, or pending retry; F11: and no walk holds the run (`:365`) |
| `P7` | `checkpointStepFailure` `retry-poller.ts:141` / `:281` | step write; F8: fenced, stale skips the row. Retries exhausted: the step and the run (only while `running`/`waiting`) fail in the same transaction (`checkpoint.ts:112-131`), so `P10` is pre-F8 only. #2999: a retried attempt whose output fails `node.outputSchema` (`validateOutputSchema` `validation.ts:7-12`, checked at `retry-poller.ts:195-206` before step validation and the checkpoint) takes this fenced write with no retry policy, so the step and the run fail: a `P7` whose retry budget is already spent, as the System One guards are for `XFail`. The model's `P5` picks `fail` for it; with `MaxRetries = 1` every poller attempt has spent its budget, so the fit is exact there. Before #2999 that output was checkpointed (`P6`) and routed |
| `P10` | pre-F8: retries exhausted, `run -> failed` as a separate transaction after the step write | F1: only while the run is `running`/`waiting` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:186` | CAS (as `XCkWait`). F8 + `ChildRunResume`: a parked sub-workflow step calls `resumeFromChildRun` inline (`:187-193`), re-delivering to `E1` as `XCkWait` does |
| `PRel` | end of one row, `finally` `retry-poller.ts:288-289` | F4: releases the `holdWorkflowRun` taken at `P4` |

Not modelled: the poller's stop (#2963, `stopRetryPoller` `retry-poller.ts:380-386`, the `pollerGeneration` check on the reschedule `:297`). It decides only whether another tick is scheduled after a stop; the model's poller never stops, and a tick's row writes are unchanged.

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:103`, `isWorkflowRunActive` `:108` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:109`, completed steps, routing, `findReadyNodes` `:135` | `findReadyNodes` excludes only nodes with a **completed** step. F4: also drops nodes with a retry-pending row (`retryPendingNodeIds` `:132-137`, `:218`). Since #2364 a child run with no stored context fails here (`:114-117`); the model's run is never a child |
| `H3` | second `isWorkflowRunActive` `:139`, then complete or `walkGraph` `:146` | `GuardActiveWalk` |
| `H4` | `recovery.ts:140-143` `readyNodes.length === 0` | F4: `completeIfSettled` `recovery.ts:232-254` (F10/F11 pin), one transaction, only while `running` (since #2377 with no cancelled lineage) with no retry-pending row and no live latest row; F11: and no walk holds the run (`:238`) |
| `H5` | `getStuckWorkflowRuns` `recovery.ts:267` -> `db.ts:6430-6432` (SQL `listStuckRuns` `storage-sqlite/workflows.ts:116-136`) (waiting steps whose task is `completed`, `failed`, `cancelled` or, since #2571, `skipped`); snapshot `<<step, task generation, task status>>` | `run.status = 'waiting'`. `TaskEndNoRetry`: a `cancelled`/`skipped` task is the `nr` outcome |
| `H6` | per stuck row, re-read run `recovery.ts:272-274` | `run.status = 'waiting'`. `failed` goes to `H7R` (F7), `nr` (`cancelled`/`skipped`, `:295`) to `H7` with no retry, `completed` to `H8` |
| `H7R` | F7: failed task only, `scheduleTaskStepRetry` `recovery.ts:277-294` -> `task-step-routing.ts:237-280` | one transaction: step `waiting` AND the snapshot's task still bound AND (F9, `task-step-routing.ts:271`) `TreeLive`, else not-claimed (skip the row). `retryCount < maxRetries`: detach the task, `checkpointStepFailure` (failed, retryCount+1, nextRetryAt), skip the row. Since #2892 the same transaction also moves the detached task `failed -> superseded` when it failed with `superseded_workflow_task` (`markWorkflowStepTaskSuperseded` `:277`, `db/tasks/write.ts:996-1010`, no bus event); not modelled: `RetryRow` already sets `task` to `none`, so the detached task leaves the model and its status feeds no guard. Exhausted: not-eligible, fall through to `H7` |
| `H7` | `failStepAndRunIfWaiting` `recovery.ts:295-312` -> `task-step-routing.ts:86-120` | CAS on `step.status='waiting'`; F7: `ownerTaskId` fence, the snapshot's task must still be bound. The fail-fast test is `stepFailureMode` (#2316), which is the workflow's `onNodeFailure` for every non-foreach step |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:324-333` -> `task-step-routing.ts:294-364`, then `walkGraph(successors)` `:342` | CAS on `step.status='waiting'` inside the transaction (F7: plus the `ownerTaskId` fence; F9: plus `TreeLive`, `task-step-routing.ts:315`); sets `run -> running`. #2932 adds a task write to this transaction on its `failureReason` call; see "Absorbed failures" below |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — `ok` / `fail`, plus `nr` with `TaskEndNoRetry`: a task cancelled outside a run cancel, or (#2571) skipped by `skipTask` (`db/tasks/write.ts:826-888`, emits `task.skipped`) |
| `E1` | `resumeFromTaskCompletionUnguarded` `resume.ts:236-266` / `handleTaskFailureUnguarded` `:371-386` pre-checks | reads, outside any transaction: run `waiting`/`running`, step `waiting`, `isStaleTaskEvent` (`:485-489`, another task is bound). Since #2316 a run that is not `waiting`/`running` goes to `recordLateForeachOutcome` (`:253-259`, `:373-379`, `:457-476`), which writes only a foreach item of a `failed` run; for every modelled row it returns with no write |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:271` (CAS on the step only), then `walkGraph(successors)` `:293` | step CAS; F9 (#2377): `TreeLive` (`task-step-routing.ts:315`). A `failed` run is not re-checked. In the model a cancel cancels every open step in the same transaction, so no `waiting` row survives in a cancelled run and the new check changes no state. #2932: see "Absorbed failures" below |
| `EFin` | `finalizeOrWait` `resume.ts:312-344` (F10/F11 pin) | transaction. F9 (#2377, closes CX13): returns unless the run is `running`/`waiting` with no cancelled lineage; pre-F9 there was no run-status guard. F6: while any node's latest row is `running` (`:326`), only `waiting -> running` and return, leaving the run to the live walk's finalizer. F11: the same while a walk holds the run (`hasOwedSuccessors` `:326`). F7: a retry-pending row (`failed` with `nextRetryAt`) keeps the run `waiting` (`:331-333`) |
| `ER` | F7: `task.failed` only (`retryable: true`, `resume.ts:129`; `task.cancelled` `:137-145` and, since #2571, `task.skipped` `:150-163` pass `retryable: false`, so `nr` goes from `E1` straight to `EF`), `scheduleTaskStepRetry` `resume.ts:388-403` | same transaction as `H7R` (F9: not-claimed when not `TreeLive`; #2892: the detached supersede-cut task moves to `superseded`, not modelled, as `H7R`). scheduled or not-claimed: stop. not-eligible: `EF` |
| `EF` | `markRunFailed` `resume.ts:410` -> `:497-511` `failStepAndRunIfWaiting` | step CAS (no `ownerTaskId` on the live path). The fail-fast test is `stepFailureMode` (`:407`, #2316), the workflow's `onNodeFailure` for every non-foreach step |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:795` -> `cancelWorkflowRunRows` `:728-783` | one transaction (`:753-782`). Cancels every non-terminal step (`cancelOpenWorkflowTreeSteps` `:772`). F9 (#2377): also cancels every open task of the run, current and earlier attempts (`:763-771`; since #3303 `cancelTask` also records `statusKind = 'workflow'`, a column no modelled guard reads), drops the queued retry of every `failed` row (`disarmWorkflowTreeRetries` `:773`, `nra` FALSE), and walks the child tree (`getWorkflowRunTreeIds` `:759`). An already `cancelled` run is swept again (`:754-757`), after a read-only check that finds open work (`:739-747`). Pre-F9: terminal rows were skipped, **including `failed` rows that still carried `nextRetryAt`** (F1 kept the poller from claiming them). The model has one canceller and no child runs |
| `U1` | `retryFailedRun` reads `resume.ts:516-557` (`findReadyNodes` `:612`) | reads outside the transaction. Since #2316 the failed step is the first node, in order of its first row, whose **latest** row is `failed` (`latestStepPerNode` `:525-527`, `:634-638`); an older failed row of a node with a newer row is not picked. F5: drops nodes with any `running` or `waiting` row (`liveNodeIds` `:609-614`). **Retry-pending nodes are not dropped (open, CX9).** |
| `U2` | claim transaction `resume.ts:563-602`, then `walkGraph(nodesToRun)` `:623` | `run.status = 'failed'` (since #2377 a cancelled lineage throws, `:568-569`; never for a root run); resets the failed row to `pending` (orphaned: the walk inserts a new row). The foreach attempt rows and step-cap refusal (`:570-599`, #2316) add nothing for a run without foreach items |

Retry eligibility (#2262, `scheduleTaskStepRetry` `task-step-routing.ts:244-257`, before the claim transaction): a node's own `retry` wins; a node without one gets `SUPERSEDE_RETRY_POLICY` (`:205-210`, one retry) when its task failed with `superseded_workflow_task` (`isSupersedeCut` `:282-286`), else not-eligible. Since #2370 a foreach child (`<foreachId>#<key>`) takes its parent's `retry` and is queued only while the run is live (`:266-269`); not modelled (no foreach node). Not modelled separately: every model branch already has a retry policy with `MaxRetries >= 1`, so `ER` and `H7R` already retry any failed task, which over-approximates the supersede-only policy. The claim transaction's guards are unchanged.

Absorbed failures (#2932, `completeTaskStepAndResolveSuccessors` `task-step-routing.ts:317-322`, `:359-361`): when the call carries a `failureReason`, the claim transaction also moves the step's task `failed -> superseded` if it failed with `superseded_workflow_task` (`markWorkflowStepTaskSuperseded`, same guarded `UPDATE` as #2892, no bus event), once the step is claimed and the run has not failed. The task is `ownerTaskId` on the sweep path and the task bound to the step on the live path. Only two callers pass a `failureReason`: `handleTaskFailureUnguarded` (`resume.ts:415-429`) and the sweep's absorb path (`recovery.ts:314-333`), both after `stepFailureMode` did not return `fail`, that is under `onNodeFailure: "continue"` or a collect-outcomes foreach. Not modelled: the model's failure path is fail-fast (`EF`, `H7`), so it never takes this call. The transaction is the claim `E2` and `H8` already model, with the same guards (step `waiting`, the `ownerTaskId` fence in `H8`, `TreeLive`) and the same step and run writes; the new write changes only the status of the task on the row that transaction completes. No modelled guard reads `task` on a `completed` row: `Bound` tests `task # "none"`, `H5` selects `waiting` rows (and `getStuckWorkflowRuns` does not select a `superseded` task), `Cancel` and `AtMostOneExecuting` look only at `task = "run"`.

Not modelled: `retryFailedRun` refuses before the claim when a node still to run is not ready (#1715, `resume.ts:535-541`). It is a read with no write, and the model's executors are always ready.

## Unreadable replay state (#1926, `ReplayUnreadable`)

Run and step reads default to the replay view, which opens the sealed `context_replay` /
`output_replay` copy lazily, on first property access (`defineWorkflowPayload`
`workflow-replay.ts:43-77`). When the copy cannot be opened (missing or rotated key, corrupt
ciphertext) the read throws `WorkflowReplayStateError`, and `failRunOnUnreadableReplay`
(`engine.ts:437-455`) fails the claimed step, then the run. Both writes go through
`updateWorkflowRunStep` / `updateWorkflowRun` (`db.ts:6369`, `:6223`), whose `UPDATE` is
`WHERE id = ?` only (`updateStepColumns` `storage/workflows.ts:1308`, `updateRunColumns` `:1233`), and they are separate awaits. With `ReplayUnreadable`, each read site below may
throw instead of the action that performs the read.

| Action | Code | Guard |
|---|---|---|
| `WStartUnreadable` | `rehydrateCompletedStepOutputs` `engine.ts:551` opens each completed step's output; `walkGraph` catch `:516-517` | enabled only when a completed row exists. Run write only (no step id); the walk then releases `activeWalks` (`WRet`) |
| `XDedupUnreadable` | F3: a memoized completed node opens its stored output after the dedup transaction (`engine.ts:1000`, `:1007`); `.catch` `:626` | run write only; the node reports `failed`. `WBatchEnd` then re-reads the run and stops the walk if it is `failed` (`engine.ts:641-648`), else skips the node's successors |
| `P5Unreadable` | `run.context` in `rebuildNodeExecutionInput` (`retry-poller.ts:102` -> `step-input.ts:42`), after `claimRetry`; catch `:276-278` / `:285-286` | step write on the claimed row, then run write; `PRel` releases the hold |
| `H2Unreadable` | `run.context` `recovery.ts:123`, after the `running` re-check `:110`; catch `:157` | run write only; the sweep moves on to the waiting runs (`H5`) |
| `H8Unreadable` | completed task: `run.context` `recovery.ts:314`, before the claim; catch `:354` | run write only; the sweep moves on to the next stuck row (`H6`) |
| `E2Unreadable` | `run.context` `resume.ts:269`, after the `E1` checks, before the claim; `failClosedOnUnreadableReplay` `resume.ts:203-213`. With `ChildRunResume` also from `eF` (see Sub-workflow steps) | step write on the event's row, then run write |
| `RFStep` | `updateWorkflowRunStep(stepId, failed, nextRetryAt null)` `engine.ts:446-451` | **none** (`WHERE id = ?`) |
| `RFRun` | `updateWorkflowRun(runId, failed)` `engine.ts:453` | **none** (`WHERE id = ?`); a completed or cancelled run becomes `failed` (open, CX14) |

Not modelled: `runClaimedStep`'s catch (`engine.ts:1029`). The ctx it renders from was already
opened by `WStart`'s rehydration or by the caller's `run.context` read, and the model's executors
read no other replay state. The approval and wait-state sweeps (`recovery.ts:458`, `:492`) and
resumes (`resume.ts:898`, `:1029`, `:1045`; since #3485 the approval resume routes on the stored request bound to the step, `resume.ts:916-934`, not on the event payload), and `handleTaskFailure`'s `onNodeFailure: "continue"` read
(`resume.ts:415`), belong to node kinds and policies the model does not have. `retryFailedRun`
reads `run.context` (`resume.ts:562`) before its claim and throws to the caller with no write.
The wait-state sweep's replay of a wait resolved before a crash (#2257, `recoverResolvedWaitState`
`resume.ts:1035-1048`) is the same unmodelled node kind. So is the wait bus listener cleanup
(#2928, `processBusEvent` `resume.ts:1400-1407`): it drops an event's listener only when the
emptied wait set is still that event's current set. It touches process-local wait bookkeeping and
writes no run or step.

## Sub-workflow steps (#2030, `ChildRunResume`; #2364, F8)

A `sub-workflow` step starts a child run (`executors/sub-workflow.ts`) and parks `waiting` until
the child is terminal. With `ChildRunResume`, every async branch is such a step: the bound
"task" is the child run of the row's current attempt, `TaskFinish` is that child reaching a
terminal status (completed: `ok`; failed: `fail`), and every resume path runs `resumeFromChildRun`
(`resume.ts:1127-1217`). It reads the step outside any transaction (`:1131-1132`), then the run
(`:1136-1137`) and `run.context` (`:1141`) inside `failClosedOnUnreadableReplay`. Since #2364 (F8)
one transaction (`:1145-1188`) re-reads the step, picks the child of its current attempt
(`getChildWorkflowRunId(stepId, retryCount)`), and settles: a failed child with retries left
schedules a retry (`checkpointStepFailure`, `:1160-1166`; the poller re-executes the step under
the next attempt, which starts a new child), any other failure fails the step and the run, and a
completed child claims with the step CAS plus a run-status check (#2257). The current attempt is
the generation fence: an older attempt's child never settles the row. Before #2364 (F8 off) the
outcome was read outside the transaction, there was no retry, and a failed child failed the
step and the run.

| Action | Code | Guard |
|---|---|---|
| `E1` | `workflow.child.finished` listener `resume.ts:177-185` -> `resumeFromChildRun` pre-checks `:1131-1137` | step `waiting`, run `waiting`/`running`. No `isStaleTaskEvent`. F8: goes to `EC`; pre-F8: child terminal, a failed child goes to `EF` (no `ER`) |
| `EC` | F8: claim transaction `resume.ts:1145-1188`, then `walkGraph` `:1202` or `finalizeOrWait` `:1213` | `ChildClaim`: step `waiting` and the current attempt's child terminal (F9: and `TreeLive`, `resume.ts:1149`), else nothing. Failed with `retryCount < maxRetries`: `RetryRow` (as `ER`). Failed, exhausted: `failStepAndRunIfWaiting` (`:1169-1177`, step CAS). Completed: `checkpointPortStepAndResolveSuccessors` (`task-step-routing.ts:139-184`): step CAS AND run `waiting`/`running` (#2257), `run -> running` |
| `E2` / `E2Unreadable` / `EFin` / `EF` | pre-F8 claim (`E2`, `EF`); `run.context` `resume.ts:1141`; `finalizeOrWait` `:1213` | as the agent-task rows, except the `E2` claim: step CAS AND run `waiting`/`running` in the same transaction (#2257, `task-step-routing.ts:150-155`). No run guard in `finalizeOrWait`. The `run.context` read precedes every branch, so `E2Unreadable` is enabled from `eC` (F8) and `eF` as well as `e2` |
| `XCkWait` (re-arm) | `runClaimedStep` `engine.ts:1211-1216`: a parked step calls `resumeFromChildRun` inline | a child that finished before the park had its event dropped (`E1` saw the step `running`). Modelled as re-entering the row's event thread at `E1`. The walker blocks on the real call and then reports `waiting`, so letting it run on concurrently only adds interleavings. F8: `P8` re-arms the same way (`retry-poller.ts:187-193`) |
| `H9` | Case 5 `recovery.ts:74-81` -> `getSettledChildRunParentSteps` `workflow-runs.ts:436-438` (SQL `storage-sqlite/workflows.ts:56-66`) | waiting sub-workflow rows whose current attempt's child is terminal (joined on `parentStepAttempt = retryCount` since #2364). **No run-status filter**, unlike `H5` |
| `H10` | `resumeFromChildRun` pre-checks `resume.ts:1131-1137` | as `E1`; F8 goes to `HC` |
| `HC` | F8: claim transaction `resume.ts:1145-1188` | as `EC`, then `walkGraph(successors)` back to `H10`, or `H13` |
| `H11` / `H11Unreadable` | pre-F8 claim / `run.context` `resume.ts:1141` (before `H12` and `HC` too) | step CAS AND run `waiting`/`running` (#2257), `run -> running`, then `walkGraph(successors)` back to `H10`, or `H13` |
| `H12` | pre-F8 `failStepAndRunIfWaiting` `resume.ts:1169-1177` | step CAS (no `ownerTaskId`) |
| `H13` | `finalizeOrWait` `resume.ts:1213` | as `EFin` (run-status guard only with F9) |
| `H14` | F8 Case 7 `recovery.ts:86-87` -> `getRunningSubWorkflowSteps` `workflow-runs.ts:406-410` (SQL `storage-sqlite/workflows.ts:42-54`) | each node's latest `sub-workflow` row that is `running`, in a `running`/`waiting` run |
| `H15` | `recoverOrphanedSubWorkflowSteps` `recovery.ts:191` | skip when `isWorkflowRunActive` (`GuardActiveWalk`) or `isStepExecuting` (`Owned`) |
| `H16` | `getWorkflowRun` `recovery.ts:192-193` | run `running`/`waiting` |
| `H17` / `H17Unreadable` | second `isWorkflowRunActive` `recovery.ts:198`, then `walkGraph([node])` `:199-207`; `run.context` `:202`, catch `:209` | `GuardActiveWalk`; the walk's `XDedup` re-claims the row while it is still `running`. **The row's status is not re-checked: a row that parked and was queued for retry since `H14` gets a second row (open, CX15)**. Unreadable: run write only |

With `ChildRunResume`, `H5` finds no row: `getStuckWorkflowRuns` joins `agent_tasks`, and a
sub-workflow step has none. F8 makes every sub-workflow executor call `ChildStart` (see `XChild`):
it reuses the current attempt's child or starts one only while the attempt still runs, so one
attempt never has two children, and a retry (a new attempt) starts a new child. Since #2364 a
child that cannot be retried (cancelled or skipped: `retryable: false`, `childRunOutcome` `sub-workflow.ts:44-60`)
skips the retry policy on the executor path (`engine.ts:1173`, `retry-poller.ts:139-140`); the
model's failed child is always a retryable `failed` end. Not modelled: a deleted child
(`wakeParentsOfDeletedRuns`, `workflow-runs.ts:444-447`) fails the step like an exhausted
failed child. Since #2433 a child deleted between its start and the executor's read back fails
the step with `retryable: false` (`sub-workflow.ts:147-153`): an `XFail` whose retry budget is
already spent, as the System One guards are (the model has no workflow delete); the child run's own walk (one run in the model); a child of a different workflow
under a recovered step (`settle` conflict check, `sub-workflow.ts:157-180`), which fails the
step like `XFail`; and the alert dedup of a child that needs setup
(`automation-preflight.ts`).

Port routing (#1706, `resolveValidationPort` at `engine.ts:1278` and `retry-poller.ts:254`) is not modelled: the graph has no ports, and every node's successors are fixed.

## Crash

`Crash` drops process-local state (`activeWalks`, `executingSteps`, executor calls, undelivered
bus events) and grants one extra heartbeat sweep (boot recovery). DB rows survive. A `running`
row it orphans is re-walked by `H1`-`H3` or, for a sub-workflow row with F8, by Case 7 (`H14`-`H17`);
a sub-workflow row (F8) and, since #3215, an agent-task row (F13) are re-claimed; any other node
gets a new row. Case 7 still selects only sub-workflow rows, so an orphaned agent-task row waits
for the running-run pass (`H1`-`H3`) to walk its run.

## Invariants (design doc §5)

| Invariant | Kind | Meaning |
|---|---|---|
| `TerminalRunStaysQuiet` | action property | Inv1: a terminal run never gains a running/pending step; a completed or cancelled run never changes status |
| `TerminalNeverFails` | action property | Inv1b (#1926): a completed or cancelled run never becomes `failed`. Narrower than Inv1, so CX13 (cancelled -> completed) does not mask it. Checked by `Probe-replay-unreadable*.cfg` |
| `AtMostOneExecuting` | state | Inv2: at most one live execution per node (executor call or dispatched task). With F8 and `ChildRunResume` a branch's executor call is not counted: it only starts or reconnects its attempt's child, which is unique per attempt (`ChildStart`), so the child is the execution. With F8 and F13 the same holds for an agent-task call, which reuses the task bound to its row; a row with a second task (`dup`) counts twice |
| `ExecutesOnce` | state | Inv3: every node completes at most once |
| `JoinWaitsForAll` | action property | Inv3b: the join row is only created after every branch completed. Not a property of `main` since #1673: a terminally failed branch still joins (partial failure) |
| `JoinWaitsForBranches` | action property | Inv3c (#1673): the join row is only created once every branch has a row and none is running, waiting, or `pending` |
| `JoinWaitsForRetry` | action property | Inv3e (F12, #3019): the join row is not created while a branch's latest row is pending its retry (`failed`, `nextRetryAt` set). Checked by `Probe-join-retry*.cfg` |
| `CompletedRunRouted` | state | Inv3d (F10, F11): a completed run has a row for every node one of whose predecessors' latest row completed, so no routed successor was dropped. Checked by `Probe-successor-debt*.cfg` |
| `CompletedRunQuiescent` | state | Inv4 (bf12ab53): a completed run has no live step |
| `EventuallySettles` | liveness | Inv5: defined, not checked in the pilot configs (see FINDINGS.md) |

## Fix flags

`Fix*` constants model the fixes in FINDINGS.md. `Workflows.cfg` and `Long.cfg` model current
`main`: F1 `FixPollerRunGuard` (#1666), F3 `FixConcurrentJoin` and F5 `FixUserRetryLive` (#1675),
F4 `FixRecoveryRetry` (#1678), F6 `FixJoinWaitsLive` (#1673), F7 `FixTaskRetry` (#1832), F8 `FixStepFence` (#2364),
F9 `FixCancelTree` (#2377), F10 `FixParkSiblings` (#2957, #2966), F11 `FixSuccessorDebt` (#2966, #2974) and
F12 `FixJoinRetryPending` (#3019) and F13 `FixTaskReclaim` (#3215) are `TRUE`. F2 `FixPendingRetryGate` is `FALSE`: no merged PR keeps a
retry-pending predecessor's edge active or treats a poller-claimed branch as unfinished.

F7 `FixTaskRetry` (#1832) adds `ER` and `H7R`, the `ownerTaskId` fence on `H7`/`H8`, the
retry-pending clause in `EFin`, and per-generation handler threads. With it off, `tg` never
exceeds 1 and every pre-existing `Fix-*` config gives the same distinct-state count as before.
`TaskGenBound` is a model-sanity invariant: every task generation has a handler thread.

F8 `FixStepFence` (#2364) fences `XCkOk`, `XFail`, `P6` and `P7` on the claim (`Fence`), writes an
exhausted failure's step and run in one transaction (`XFail`, `P7`; `P10` is pre-F8 only), and,
with `ChildRunResume`, adds `ChildStart` / `XChild`, the re-claim in `XDedup`, `ChildClaim`
(`EC`, `HC`), the `P8` re-arm, and Case 7 (`H14`-`H17`). It is `TRUE` in the configs that model
current `main` (`Workflows`, `Long`, `Probe-child-run*` except the crash control,
`Probe-orphan-sweep`, `Probe-replay-unreadable*`, `Probe-task-retry`, `Probe-task-skip*`) and `FALSE` in the calibration, `Fix-*`, `Ctl-*`, `Probe-cancel-finalize` and
`Probe-input-await` configs, which keep their verdicts and state spaces. `Probe-child-run-crash-control.cfg`
is `Probe-child-run-crash.cfg` with it off. `Probe-child-run-refusal.cfg` (#3494) is `Probe-child-run-crash.cfg` with
`"fail"` in `BranchOutcomes`, so a re-claimed sub-workflow row may refuse before the child start.

F9 `FixCancelTree` (#2377) gives `FinalizeOrWait` (`EFin`, `H13`) its run-status guard (closes
CX13), makes `Cancel` cancel a terminal row's open task and drop every queued retry, refuses the
agent-task dispatch in `XRun` unless the step runs in a live run, and adds `TreeLive` to the
`E2`, `H8`, `ER`, `H7R` and `ChildClaim` claims. Every other `getRunLineageBlock` check #2377
adds (`XDedup`, `Fence`, `XCkWait`, `WFinal`, `P4`, `P9`, `H4`, `U2`, the child-run insert) sits
next to a run-status check that already excludes `cancelled`, and the model's run has no parent,
so those actions are unchanged. The cascade to child runs, approvals and the per-process
in-flight cancel dedup are not modelled (one run, one canceller). F9 has the same `TRUE`/`FALSE`
split as F8, except that `Probe-child-run-crash-control.cfg` keeps it `TRUE`. `Fix-CX13.cfg` is
`Probe-cancel-finalize.cfg` with it on.

F10 `FixParkSiblings` (#2957, #2966) lets `WBatchEnd` route past a `waiting` outcome and run
`WFinal` instead of returning. F11 `FixSuccessorDebt` (#2966, #2974) gives every walk a hold on
its run (`dh`, from `Call` to `WFinal` or `WRet`) and adds `~Owed` to every run finalizer: `WFinal`,
`FinalizeOrWait` (`EFin`, `H13`), `H4` and `P9`. Both have the same `TRUE`/`FALSE` split as F8, plus
`TRUE` in `Probe-child-run-crash-control.cfg`, so the calibration, `Fix-*`, `Ctl-*`,
`Probe-cancel-finalize` and `Probe-input-await` configs keep their verdicts and state spaces.
`Probe-successor-debt.cfg` checks the new `CompletedRunRouted` with both on;
`Probe-successor-debt-control.cfg` turns F11 off. Not modelled from these PRs: the foreach drive's
hold (#2974, `driveForeach`, no foreach node), the release on an outer rollback, a failed COMMIT or (since #3562) a retried attempt
(#2974, `onAttemptRollback` `successor-routing.ts:100`, the model's transactions always commit), and the context
merge (`adoptStoredContext`, no run context in the model).

F12 `FixJoinRetryPending` (#3019) adds the nodes whose latest row is pending its retry
(`LatestRetry`) to `Awaited` (the F6 `awaitedNodeIds`, read by `WStart`'s seed filter and by
`WBatchEnd`), and removes them from the completed set `WBatchEnd` checks. It differs from F2: the
walk still adds a branch it failed with a retry pending to its `done` set at `XFail`, so once the
poller claims the row (`P4`, `running`) the gate counts the branch as completed again and the
join fires (CX8 stays open on `Workflows.cfg`). F12 has the same `TRUE`/`FALSE` split as F11, plus
`TRUE` in `Probe-successor-debt-control.cfg`. `Probe-join-retry.cfg` checks the new
`JoinWaitsForRetry` with it on, no sweep and no user retry; `Probe-join-retry-control.cfg` turns it
off. `Probe-join-retry-sweep.cfg` (one sweep) and `Probe-join-retry-user.cfg` (user retry) keep it on
and find CX18 and CX17 (FINDINGS.md), older gaps that F12 does not cover.

F13 `FixTaskReclaim` (#3215) extends the F8 re-claim in `XDedup` to agent-task rows (no
`ChildRunResume`), adds `TaskStart` / `XTaskIns` to `XChild`, splits the poller's agent-task
dispatch into the bound-task read (`P5`) and the insert (`P5i`), and stops counting a branch's
executor call in `AtMostOneExecuting` (a second task on one row counts instead). It has an effect only with F8 and without
`ChildRunResume`, and is `TRUE` in every config with F8 `TRUE`, `FALSE` elsewhere, so the
calibration, `Fix-*`, `Ctl-*`, `Probe-cancel-finalize` and `Probe-input-await` configs, and the
`ChildRunResume` configs, keep their verdicts and state spaces. `Probe-child-run-control.cfg`
(agent-task branches) now reaches CX12 as two tasks on one row (FINDINGS.md). `Probe-task-crash.cfg` is `Probe-child-run-crash.cfg`
with agent-task branches (holds); `Probe-task-crash-control.cfg` turns F13 off and finds the
pre-#3215 second task (`AtMostOneExecuting`).

`ChildRunResume` (#2030) is a node-kind constant, not a fix flag: `TRUE` makes every async branch
a `sub-workflow` step. It is `FALSE` in every config except `Probe-child-run*.cfg` (the `-control`
variant sets it `FALSE`), so the other configs keep their verdicts and state spaces.

`ReplayUnreadable` is an environment constant, not a fix flag: `TRUE` lets every read site in
"Unreadable replay state" throw. It is `FALSE` in every config except `Probe-replay-unreadable.cfg`
and `Probe-child-run-unreadable.cfg`, so those configs keep their verdicts and state spaces.

`TaskEndNoRetry` is an environment constant, not a fix flag: `TRUE` lets an agent task end `nr`,
cancelled outside a run cancel or (#2571) skipped. Its `task.cancelled` / `task.skipped` handler
passes `retryable: false`, so `E1` goes to `EF` with retries left, and the sweep routes the row
from `H6` to `H7`, never `H7R`. Agent tasks only: it adds nothing with `ChildRunResume`. It is
`FALSE` in every config except `Probe-task-skip.cfg` (no sweeps, holds) and
`Probe-task-skip-sweep.cfg` (one sweep, reaches the open CX12), so the other configs keep their
verdicts and state spaces.

## Not modelled: foreach fan-outs (#2314, #2316)

The graph has no `foreach` node, so none of the foreach paths are reachable: the parent park and
item drive (`parkAndDriveForeach`, `engine.ts:1195-1210`, `retry-poller.ts:149-178`), the
heartbeat Case 6 re-drive of queued or orphaned items (`recoverForeachFanouts`,
`recovery.ts:510-542`, which selects only `#`-suffixed item rows), item settlement through
`settleForeachChild` in `failStepAndRunIfWaiting`, `checkpointPortStepAndResolveSuccessors` and
`completeTaskStepAndResolveSuccessors`, the per-fan-out failure policy (`stepFailureMode`), late
outcomes of a failed run's items (`recordLateForeachOutcome`), and the attempt rows a run retry
adds per failed item (`createForeachAttemptSteps`). For every non-foreach step these helpers take
the pre-existing branch, so the modelled guards are unchanged.
