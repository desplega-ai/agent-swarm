# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers are against `main` @ `ace735ed8` (after #2370, #2377, #2380). A DB transaction is one atomic action. Every
`await` outside a transaction is an action boundary: other actors interleave there, and a crash
can land there.

Where a fix flag is noted (F1..F9), the row describes the code with the fix, which is current
behavior on `main` for every flag except F2 (see "Fix flags" below). The `.tla` keeps the pre-fix
branch of each action for the `Ctl-*` and calibration configs.

## State

| Variable | Code |
|---|---|
| `run` | `workflow_runs.status` (`none` before the INSERT) |
| `steps[i]` | one `workflow_run_steps` row: `node`=nodeId, `st`=status, `rc`=retryCount, `nra`=`nextRetryAt IS NOT NULL`, `task`=state of the agent task bound to the row (`none` when detached), `tg`=task generation, +1 per dispatch (F7: a retry binds a fresh task to the same row) |
| `active` | `activeWalks.get(runId)` (`engine.ts:350`, process-local), taken by `walkGraph` and `holdWorkflowRun` (`engine.ts:397`) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |
| `thr[Ev(i, g)]` | the bus handler for the `g`-th task bound to row `i` (`Bound(i, g)` = that task is still the one bound, `isTaskBoundToStep` `task-step-routing.ts:62`) |
| `Owned` (derived) | F3: `executingSteps` (`engine.ts:355`, process-local, cleared by a crash) |
| `TreeLive` (derived) | F9 (#2377): `getRunLineageBlock` (`workflow-runs.ts:56-92`) finds no cancelled run in the lineage. The model has one root run, so it is `run # "cancelled"` |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:416` | `activeWalks` +1 via `holdWorkflowRun` (no DB guard) |
| `WStart` | `engine.ts:447-517`: rehydrate completed steps `:462`, `loadCompletedStepRouting` `:466`, active edges from `waiting` steps `:482-494`, seed filter `:503-517` | Seed filter = `GuardConvergeSeed`. F6: a predecessor in `awaitedNodeIds` (`:496`, `engine.ts:700`) also holds the node. Reads only, no transaction. |
| `WPick` | `engine.ts:535` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `executeStep` `engine.ts:794`, claim transaction `:898` | `run.status IN (running, waiting)` else halted (`:811-814`, returned as completed `:904`). F3: `getCurrentStepForNode` (`:826`, `db.ts:8416`) memoizes a node whose latest row is completed, waiting, or running and owned by this process (`executingSteps`), with no newer predecessor completion; a live one pauses the walk (`:905-911`). Otherwise `iteration = COUNT(*)` (`:849`, `getStepCountForNode` `db.ts:8390`) and INSERT. F9 (#2377): the claim also halts while `getRunLineageBlock` (`:817`) blocks, implied by the run-status check for a root run. F8 + `ChildRunResume`: a `sub-workflow` node whose latest row is `running` and not owned (orphaned by a crash) is re-claimed (`:836-845`): same row, same `retryCount`, now owned; `XChild` reconnects to that attempt's child or starts it. |
| `XRun` | `executor.run` `engine.ts:1053` (in `runClaimedStep` `:953`) | none (process-local). Async: the agent-task executor inserts the step's task (`createTaskExtended`, `executors/agent-task.ts:149`). F9 (#2377): the INSERT's transaction refuses unless the step is `running` in a `running`/`waiting` run with no cancelled lineage (`getStepExecutionBlock` `db.ts:2864-2871`, `workflow-runs.ts:341-359`); the executor throws, and the catch (`engine.ts:1060`) goes to the fenced `XFail`. Pre-F9 a cancel between the claim and the dispatch left a running task on a cancelled row. F8 + `ChildRunResume`: the async branch is `ChildStart` (below) |
| `XChild` | F8 + `ChildRunResume`: `executor.run` of a re-claimed row | `ChildStart`: `SubWorkflowExecutor.execute` (`sub-workflow.ts:85-163`) reads the attempt (`retryCount`) and reuses that attempt's child (`getChildWorkflowRunId(stepId, attempt)`, `workflow-runs.ts:304-313`): running parks, finished is a sync result. With none, `createRunWithInitialState` (`engine.ts:297-339`) inserts the child in one transaction only while the attempt still runs (`isParentStepAttemptCurrent` `workflow-runs.ts:321-334`, same predicate as `Fence`; since #2377 also no cancelled lineage) and returns a child another call of the attempt started (unique `(parentStepId, parentStepAttempt)`, migration 240). Not current: `ParentStepNotCurrentError`, the executor fails, and the fenced `XFail` writes nothing |
| `XCkOk` | `checkpointStep` `engine.ts:1192` -> `checkpoint.ts:31-55` | transaction, `UPDATE step SET status='completed'`. F8 (#2364): fenced (`holdsFence` `checkpoint.ts:15-25`): only while the step is `running` with the claimed `retryCount` and the run is `running`/`waiting` (since #2377 also no cancelled lineage, `:24`, implied for a root run); else nothing is written and `executeStep` returns `failed` (`engine.ts:965`, `:1192`), so `WBatchEnd` re-reads the run and skips the node's successors |
| `XFail` | `checkpointStepFailure` `engine.ts:1066` / `:1089` / `:1171` -> `checkpoint.ts:72-103` | `UPDATE step SET status='failed', retryCount+1, nextRetryAt`, fenced as `XCkOk` since #2364 (F8; stale returns `failed`, `:1075`, `:1099`, `:1179`); `executeStep` returns `completed` with no successors (`:1080`, `:1104`, `:1180`), so the walk adds the node to `completedNodeIds` (`engine.ts:567`). **The F2 edge is not kept (open, CX8).** The System One guards (#1715: `systemOneRetryViolations` `:972`, `strictUnresolved` `:1016`) fail the step with no retry before `executor.run`: an `XFail` whose retry budget is already spent. F8: with the budget spent (reachable in the model only through a re-claimed row), the step and the run (while `running`/`waiting`) fail in one transaction (`checkpoint.ts:93-116`) and the walk sees `failed`. Since #2290 they cover both `system-one-decision` and `system-one-extraction` nodes (`isSystemOneNodeType`); the model does not distinguish node types, so this `XFail` already covers both. |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:1123` -> `checkpoint.ts:127-154` | CAS (not fenced on `retryCount`) `WHERE status='running'`, run `IN (running, waiting)`; since #2377 also no cancelled lineage (`checkpoint.ts:134`), implied for a root run. The `keepRunStatus` option (#2314) is passed only by the foreach park, which the model does not have |
| `WBatchEnd` | `engine.ts:547-613` in-walk convergence | in-memory `completedNodeIds` / `activeEdges`. F6: re-reads the steps (`:588-590`): a predecessor whose latest row completed elsewhere is rehydrated (`:595-601`), one in `awaitedNodeIds` holds the join (`:602-604`) |
| `WFinal` | `engine.ts:623-681` finalization transaction | `run.status = 'running'` (since #2377 also no cancelled lineage, `:627`, implied for a root run); F6: returns while any node's latest row is `running` (`hasRunningStep` `:631`, `engine.ts:714`); `waiting` steps -> waiting; pending retries -> stay running; else completed/failed. A `pending` row is not counted (CX10). Since #2314 foreach item rows are left out of the failed/completed tallies (`:636-649`); the model has no foreach items, so the guard is unchanged for it. |
| `WRet` | `engine.ts:432` `release()` | `activeWalks` -1 |

## Trigger (`engine.ts:114-308`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createRunWithInitialState` `engine.ts:181` -> `:297-339` commits `running` with the initial context in one transaction | none. Since #2364 `holdWorkflowRun` (`:179`) is taken before the commit and released after the walk (`:220`), so `isWorkflowRunActive` is true from the commit on. #2380 runs the caller's `accept` hook (the HTTP trigger's `Idempotency-Key` record) last in the same transaction (`:333`, setup-failure path `:126-137`); a throw rolls the run back. Not modelled: the model has one trigger, and the hook adds no run or step write |
| `IWalk` | pre-#2364 only (`InputAwait`): `resolveRenderedWorkflowInputs` awaited after the INSERT and before `walkGraph` | none; F3 covers the recovery walk that lands in this window (CX6). On `main` the inputs resolve in `buildInitialRunState` (`engine.ts:245-286`, `:275`) before the row exists and the hold covers the commit-to-walk gap, so `InputAwait = TRUE` models older code only |

Not modelled: the readiness preflight (#1715, `findWorkflowReadinessProblems` `engine.ts:253-260`). Since #2364 it runs before the run row exists, and a run that cannot start commits directly as `failed` (with a cooldown, `skipped`). The model assumes every executor is ready, so that branch is unreachable.

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:39` -> `db.ts:8346-8359` | `status='failed' AND nextRetryAt <= now`. F1: `AND run.status IN (running, waiting, failed)`. A foreach child row is re-queued to `pending` for the foreach driver instead (`:49-60`, `claimRetry` `requeueForeachChild`, #2370); not modelled (no foreach node) |
| `P2` | `getWorkflowRun` `retry-poller.ts:44` | read |
| `P3` | pre-F1: blind `run -> running` if the snapshot said `failed` | F1: removed; the revive moved into `claimRetry` (`P4`) |
| `P4` | `holdWorkflowRun` `retry-poller.ts:73`, `claimRetry` `:78` -> `:294-329` | F1: one transaction; `UPDATE step SET status='running', nextRetryAt=NULL WHERE status='failed' AND nextRetryAt IS NOT NULL`, only while the run is `running`/`waiting`/`failed`; revives a `failed` run. F9 (#2377): a run with a cancelled lineage is not claimed and its queued retries are dropped (`:302-305`); for a root run the status check already excludes `cancelled`. F4: the hold makes `isWorkflowRunActive` true for recovery |
| `P5` | `executor.run` `retry-poller.ts:118` | none (F8 + `ChildRunResume`: `ChildStart`, a retried attempt has no child yet and starts one). A retried foreach parent parks and drives its items (`:140-166`, #2314); not modelled (no foreach node) |
| `P6` | `checkpointStep` `retry-poller.ts:232`, then `walkGraph(successors)` `:239` | step write; F8: fenced on the claim (`fence` `:81`, the snapshot's `retryCount`), stale skips the row (`:232-234`) |
| `P9` | no successors: `completeRunIfSettled` `retry-poller.ts:248` -> `:337-356` | F1: one transaction, only while the run is `running`/`waiting` (since #2377 with no cancelled lineage, `:341`) and no step is running, waiting, or pending retry |
| `P7` | `checkpointStepFailure` `retry-poller.ts:131` / `:256` | step write; F8: fenced, stale skips the row. Retries exhausted: the step and the run (only while `running`/`waiting`) fail in the same transaction (`checkpoint.ts:93-116`), so `P10` is pre-F8 only |
| `P10` | pre-F8: retries exhausted, `run -> failed` as a separate transaction after the step write | F1: only while the run is `running`/`waiting` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:174` | CAS (as `XCkWait`). F8 + `ChildRunResume`: a parked sub-workflow step calls `resumeFromChildRun` inline (`:176-181`), re-delivering to `E1` as `XCkWait` does |
| `PRel` | end of one row, `finally` `retry-poller.ts:263-264` | F4: releases the `holdWorkflowRun` taken at `P4` |

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:101`, `isWorkflowRunActive` `:106` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:107`, completed steps, routing, `findReadyNodes` `:133` | `findReadyNodes` excludes only nodes with a **completed** step. F4: also drops nodes with a retry-pending row (`retryPendingNodeIds` `:132-135`, `:216`). Since #2364 a child run with no stored context fails here (`:112-115`); the model's run is never a child |
| `H3` | second `isWorkflowRunActive` `:137`, then complete or `walkGraph` `:144` | `GuardActiveWalk` |
| `H4` | `recovery.ts:138-141` `readyNodes.length === 0` | F4: `completeIfSettled` `recovery.ts:230-251`, one transaction, only while `running` (since #2377 with no cancelled lineage, `:234`) with no retry-pending row and no live latest row |
| `H5` | `getStuckWorkflowRuns` `recovery.ts:258` (waiting steps whose task is terminal); snapshot `<<step, task generation, task status>>` | `run.status = 'waiting'` |
| `H6` | per stuck row, re-read run `:263-265` | `run.status = 'waiting'` |
| `H7R` | F7: failed task only, `scheduleTaskStepRetry` `recovery.ts:268-285` -> `task-step-routing.ts:231-271` | one transaction: step `waiting` AND the snapshot's task still bound AND (F9, `task-step-routing.ts:265`) `TreeLive`, else not-claimed (skip the row). `retryCount < maxRetries`: detach the task, `checkpointStepFailure` (failed, retryCount+1, nextRetryAt), skip the row. Exhausted: not-eligible, fall through to `H7` |
| `H7` | `failStepAndRunIfWaiting` `recovery.ts:286-304` -> `task-step-routing.ts:81-115` | CAS on `step.status='waiting'`; F7: `ownerTaskId` fence, the snapshot's task must still be bound. The fail-fast test is `stepFailureMode` (#2316), which is the workflow's `onNodeFailure` for every non-foreach step |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:317-326` -> `task-step-routing.ts:283-336`, then `walkGraph(successors)` `:335` | CAS on `step.status='waiting'` inside the transaction (F7: plus the `ownerTaskId` fence; F9: plus `TreeLive`, `task-step-routing.ts:304`); sets `run -> running` |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — |
| `E1` | `resumeFromTaskCompletionUnguarded` `resume.ts:216-246` / `handleTaskFailureUnguarded` `:349-364` pre-checks | reads, outside any transaction: run `waiting`/`running`, step `waiting`, `isStaleTaskEvent` (`:462-466`, another task is bound). Since #2316 a run that is not `waiting`/`running` goes to `recordLateForeachOutcome` (`:233-239`, `:351-357`, `:434-453`), which writes only a foreach item of a `failed` run; for every modelled row it returns with no write |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:251` (CAS on the step only), then `walkGraph(successors)` `:273` | step CAS; F9 (#2377): `TreeLive` (`task-step-routing.ts:304`). A `failed` run is not re-checked. In the model a cancel cancels every open step in the same transaction, so no `waiting` row survives in a cancelled run and the new check changes no state |
| `EFin` | `finalizeOrWait` `resume.ts:291-322` | transaction. F9 (#2377, closes CX13): returns unless the run is `running`/`waiting` with no cancelled lineage (`:298-300`); pre-F9 there was no run-status guard. F6: while any node's latest row is `running` (`:304`), only `waiting -> running` and return, leaving the run to the live walk's finalizer. F7: a retry-pending row (`failed` with `nextRetryAt`) keeps the run `waiting` (`:309-311`) |
| `ER` | F7: `task.failed` only (`retryable: true`, `resume.ts:128`; `task.cancelled` skips it), `scheduleTaskStepRetry` `resume.ts:366-381` | same transaction as `H7R` (F9: not-claimed when not `TreeLive`). scheduled or not-claimed: stop. not-eligible: `EF` |
| `EF` | `markRunFailed` `resume.ts:388` -> `:474-488` `failStepAndRunIfWaiting` | step CAS (no `ownerTaskId` on the live path). The fail-fast test is `stepFailureMode` (`:385`, #2316), the workflow's `onNodeFailure` for every non-foreach step |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:769` -> `cancelWorkflowRunRows` `:705-757` | one transaction (`:728-756`). Cancels every non-terminal step (`cancelOpenWorkflowTreeSteps` `:746`). F9 (#2377): also cancels every open task of the run, current and earlier attempts (`:740-745`), drops the queued retry of every `failed` row (`disarmWorkflowTreeRetries` `:747`, `nra` FALSE), and walks the child tree (`getWorkflowRunTreeIds` `:736`). An already `cancelled` run is swept again (`:731-734`), after a read-only check that finds open work (`:717-724`). Pre-F9: terminal rows were skipped, **including `failed` rows that still carried `nextRetryAt`** (F1 kept the poller from claiming them). The model has one canceller and no child runs |
| `U1` | `retryFailedRun` reads `resume.ts:493-534` (`findReadyNodes` `:589`) | reads outside the transaction. Since #2316 the failed step is the first node, in order of its first row, whose **latest** row is `failed` (`latestStepPerNode` `:502-505`, `:611-615`); an older failed row of a node with a newer row is not picked. F5: drops nodes with any `running` or `waiting` row (`liveNodeIds` `:586-591`). **Retry-pending nodes are not dropped (open, CX9).** |
| `U2` | claim transaction `resume.ts:540-579`, then `walkGraph(nodesToRun)` `:600` | `run.status = 'failed'` (since #2377 a cancelled lineage throws, `:545-546`; never for a root run); resets the failed row to `pending` (orphaned: the walk inserts a new row). The foreach attempt rows and step-cap refusal (`:551-576`, #2316) add nothing for a run without foreach items |

Retry eligibility (#2262, `scheduleTaskStepRetry` `task-step-routing.ts:238-251`, before the claim transaction): a node's own `retry` wins; a node without one gets `SUPERSEDE_RETRY_POLICY` (`:200-205`, one retry) when its task failed with `superseded_workflow_task` (`isSupersedeCut` `:273-277`), else not-eligible. Since #2370 a foreach child (`<foreachId>#<key>`) takes its parent's `retry` and is queued only while the run is live (`:258-261`); not modelled (no foreach node). Not modelled separately: every model branch already has a retry policy with `MaxRetries >= 1`, so `ER` and `H7R` already retry any failed task, which over-approximates the supersede-only policy. The claim transaction is unchanged.

Not modelled: `retryFailedRun` refuses before the claim when a node still to run is not ready (#1715, `resume.ts:512-518`). It is a read with no write, and the model's executors are always ready.

## Unreadable replay state (#1926, `ReplayUnreadable`)

Run and step reads default to the replay view, which opens the sealed `context_replay` /
`output_replay` copy lazily, on first property access (`defineWorkflowPayload`
`workflow-replay.ts:43-77`). When the copy cannot be opened (missing or rotated key, corrupt
ciphertext) the read throws `WorkflowReplayStateError`, and `failRunOnUnreadableReplay`
(`engine.ts:363-381`) fails the claimed step, then the run. Both writes go through
`updateWorkflowRunStep` / `updateWorkflowRun` (`db.ts:8208`, `:7970`), whose `UPDATE` is
`WHERE id = ?` only, and they are separate awaits. With `ReplayUnreadable`, each read site below may
throw instead of the action that performs the read.

| Action | Code | Guard |
|---|---|---|
| `WStartUnreadable` | `rehydrateCompletedStepOutputs` `engine.ts:462` opens each completed step's output; `walkGraph` catch `:430` | enabled only when a completed row exists. Run write only (no step id); the walk then releases `activeWalks` (`WRet`) |
| `XDedupUnreadable` | F3: a memoized completed node opens its stored output after the dedup transaction (`engine.ts:909`, `:916`); `.catch` `:540` | run write only; the node reports `failed`. `WBatchEnd` then re-reads the run and stops the walk if it is `failed` (`engine.ts:553-559`), else skips the node's successors |
| `P5Unreadable` | `run.context` in `rebuildNodeExecutionInput` (`retry-poller.ts:92` -> `step-input.ts:42`), after `claimRetry`; catch `:251` / `:260` | step write on the claimed row, then run write; `PRel` releases the hold |
| `H2Unreadable` | `run.context` `recovery.ts:121`, after the `running` re-check `:108`; catch `:156` | run write only; the sweep moves on to the waiting runs (`H5`) |
| `H8Unreadable` | completed task: `run.context` `recovery.ts:306`, before the claim; catch `:347` | run write only; the sweep moves on to the next stuck row (`H6`) |
| `E2Unreadable` | `run.context` `resume.ts:249`, after the `E1` checks, before the claim; `failClosedOnUnreadableReplay` `resume.ts:183-193`. With `ChildRunResume` also from `eF` (see Sub-workflow steps) | step write on the event's row, then run write |
| `RFStep` | `updateWorkflowRunStep(stepId, failed, nextRetryAt null)` `engine.ts:372-377` | **none** (`WHERE id = ?`) |
| `RFRun` | `updateWorkflowRun(runId, failed)` `engine.ts:379` | **none** (`WHERE id = ?`); a completed or cancelled run becomes `failed` (open, CX14) |

Not modelled: `runClaimedStep`'s catch (`engine.ts:938`). The ctx it renders from was already
opened by `WStart`'s rehydration or by the caller's `run.context` read, and the model's executors
read no other replay state. The approval and wait-state sweeps (`recovery.ts:450`, `:484`) and
resumes (`resume.ts:902`, `:988`, `:1004`), and `handleTaskFailure`'s `onNodeFailure: "continue"` read
(`resume.ts:393`), belong to node kinds and policies the model does not have. `retryFailedRun`
reads `run.context` (`resume.ts:539`) before its claim and throws to the caller with no write.
The wait-state sweep's replay of a wait resolved before a crash (#2257, `recoverResolvedWaitState`
`resume.ts:994-1007`) is the same unmodelled node kind.

## Sub-workflow steps (#2030, `ChildRunResume`; #2364, F8)

A `sub-workflow` step starts a child run (`executors/sub-workflow.ts`) and parks `waiting` until
the child is terminal. With `ChildRunResume`, every async branch is such a step: the bound
"task" is the child run of the row's current attempt, `TaskFinish` is that child reaching a
terminal status (completed: `ok`; failed: `fail`), and every resume path runs `resumeFromChildRun`
(`resume.ts:1085-1174`). It reads the step outside any transaction (`:1089-1090`), then the run
(`:1094-1095`) and `run.context` (`:1099`) inside `failClosedOnUnreadableReplay`. Since #2364 (F8)
one transaction (`:1103-1146`) re-reads the step, picks the child of its current attempt
(`getChildWorkflowRunId(stepId, retryCount)`), and settles: a failed child with retries left
schedules a retry (`checkpointStepFailure`, `:1118-1124`; the poller re-executes the step under
the next attempt, which starts a new child), any other failure fails the step and the run, and a
completed child claims with the step CAS plus a run-status check (#2257). The current attempt is
the generation fence: an older attempt's child never settles the row. Before #2364 (F8 off) the
outcome was read outside the transaction, there was no retry, and a failed child failed the
step and the run.

| Action | Code | Guard |
|---|---|---|
| `E1` | `workflow.child.finished` listener `resume.ts:158-167` -> `resumeFromChildRun` pre-checks `:1089-1095` | step `waiting`, run `waiting`/`running`. No `isStaleTaskEvent`. F8: goes to `EC`; pre-F8: child terminal, a failed child goes to `EF` (no `ER`) |
| `EC` | F8: claim transaction `resume.ts:1103-1146`, then `walkGraph` `:1160` or `finalizeOrWait` `:1170` | `ChildClaim`: step `waiting` and the current attempt's child terminal (F9: and `TreeLive`, `resume.ts:1107`), else nothing. Failed with `retryCount < maxRetries`: `RetryRow` (as `ER`). Failed, exhausted: `failStepAndRunIfWaiting` (`:1128-1135`, step CAS). Completed: `checkpointPortStepAndResolveSuccessors` (`task-step-routing.ts:134-179`): step CAS AND run `waiting`/`running` (#2257), `run -> running` |
| `E2` / `E2Unreadable` / `EFin` / `EF` | pre-F8 claim (`E2`, `EF`); `run.context` `resume.ts:1099`; `finalizeOrWait` `:1170` | as the agent-task rows, except the `E2` claim: step CAS AND run `waiting`/`running` in the same transaction (#2257, `task-step-routing.ts:147-150`). No run guard in `finalizeOrWait`. The `run.context` read precedes every branch, so `E2Unreadable` is enabled from `eC` (F8) and `eF` as well as `e2` |
| `XCkWait` (re-arm) | `runClaimedStep` `engine.ts:1123-1128`: a parked step calls `resumeFromChildRun` inline | a child that finished before the park had its event dropped (`E1` saw the step `running`). Modelled as re-entering the row's event thread at `E1`. The walker blocks on the real call and then reports `waiting`, so letting it run on concurrently only adds interleavings. F8: `P8` re-arms the same way (`retry-poller.ts:176-181`) |
| `H9` | Case 5 `recovery.ts:72-79` -> `getSettledChildRunParentSteps` `workflow-runs.ts:426-436` | waiting sub-workflow rows whose current attempt's child is terminal (joined on `parentStepAttempt = retryCount` since #2364). **No run-status filter**, unlike `H5` |
| `H10` | `resumeFromChildRun` pre-checks `resume.ts:1089-1095` | as `E1`; F8 goes to `HC` |
| `HC` | F8: claim transaction `resume.ts:1103-1146` | as `EC`, then `walkGraph(successors)` back to `H10`, or `H13` |
| `H11` / `H11Unreadable` | pre-F8 claim / `run.context` `resume.ts:1099` (before `H12` and `HC` too) | step CAS AND run `waiting`/`running` (#2257), `run -> running`, then `walkGraph(successors)` back to `H10`, or `H13` |
| `H12` | pre-F8 `failStepAndRunIfWaiting` `resume.ts:1128-1135` | step CAS (no `ownerTaskId`) |
| `H13` | `finalizeOrWait` `resume.ts:1170` | as `EFin` (run-status guard only with F9) |
| `H14` | F8 Case 7 `recovery.ts:84-85` -> `getRunningSubWorkflowSteps` `workflow-runs.ts:366-380` | each node's latest `sub-workflow` row that is `running`, in a `running`/`waiting` run |
| `H15` | `recoverOrphanedSubWorkflowSteps` `recovery.ts:189` | skip when `isWorkflowRunActive` (`GuardActiveWalk`) or `isStepExecuting` (`Owned`) |
| `H16` | `getWorkflowRun` `recovery.ts:190-191` | run `running`/`waiting` |
| `H17` / `H17Unreadable` | second `isWorkflowRunActive` `recovery.ts:196`, then `walkGraph([node])` `:197-205`; `run.context` `:200`, catch `:208` | `GuardActiveWalk`; the walk's `XDedup` re-claims the row while it is still `running`. **The row's status is not re-checked: a row that parked and was queued for retry since `H14` gets a second row (open, CX15)**. Unreadable: run write only |

With `ChildRunResume`, `H5` finds no row: `getStuckWorkflowRuns` joins `agent_tasks`, and a
sub-workflow step has none. F8 makes every sub-workflow executor call `ChildStart` (see `XChild`):
it reuses the current attempt's child or starts one only while the attempt still runs, so one
attempt never has two children, and a retry (a new attempt) starts a new child. Since #2364 a
child that cannot be retried (cancelled or skipped: `retryable: false`, `childRunOutcome` `sub-workflow.ts:43-61`)
skips the retry policy on the executor path (`engine.ts:1087`, `retry-poller.ts:129-130`); the
model's failed child is always a retryable `failed` end. Not modelled: a deleted child
(`wakeParentsOfDeletedRuns`, `workflow-runs.ts:442-448`) fails the step like an exhausted
failed child; the child run's own walk (one run in the model); a child of a different workflow
under a recovered step (`settle` conflict check, `sub-workflow.ts:140-163`), which fails the
step like `XFail`; and the alert dedup of a child that needs setup
(`automation-preflight.ts`).

Port routing (#1706, `resolveValidationPort` at `engine.ts:1189` and `retry-poller.ts:229`) is not modelled: the graph has no ports, and every node's successors are fixed.

## Crash

`Crash` drops process-local state (`activeWalks`, `executingSteps`, executor calls, undelivered
bus events) and grants one extra heartbeat sweep (boot recovery). DB rows survive. A `running`
row it orphans is re-walked by `H1`-`H3` or, for a sub-workflow row with F8, by Case 7 (`H14`-`H17`);
only a sub-workflow row is re-claimed, any other node gets a new row.

## Invariants (design doc §5)

| Invariant | Kind | Meaning |
|---|---|---|
| `TerminalRunStaysQuiet` | action property | Inv1: a terminal run never gains a running/pending step; a completed or cancelled run never changes status |
| `TerminalNeverFails` | action property | Inv1b (#1926): a completed or cancelled run never becomes `failed`. Narrower than Inv1, so CX13 (cancelled -> completed) does not mask it. Checked by `Probe-replay-unreadable*.cfg` |
| `AtMostOneExecuting` | state | Inv2: at most one live execution per node (executor call or dispatched task). With F8 and `ChildRunResume` a branch's executor call is not counted: it only starts or reconnects its attempt's child, which is unique per attempt (`ChildStart`), so the child is the execution |
| `ExecutesOnce` | state | Inv3: every node completes at most once |
| `JoinWaitsForAll` | action property | Inv3b: the join row is only created after every branch completed. Not a property of `main` since #1673: a terminally failed branch still joins (partial failure) |
| `JoinWaitsForBranches` | action property | Inv3c (#1673): the join row is only created once every branch has a row and none is running, waiting, or `pending` |
| `CompletedRunQuiescent` | state | Inv4 (bf12ab53): a completed run has no live step |
| `EventuallySettles` | liveness | Inv5: defined, not checked in the pilot configs (see FINDINGS.md) |

## Fix flags

`Fix*` constants model the fixes in FINDINGS.md. `Workflows.cfg` and `Long.cfg` model current
`main`: F1 `FixPollerRunGuard` (#1666), F3 `FixConcurrentJoin` and F5 `FixUserRetryLive` (#1675),
F4 `FixRecoveryRetry` (#1678), F6 `FixJoinWaitsLive` (#1673), F7 `FixTaskRetry` (#1832), F8 `FixStepFence` (#2364),
and F9 `FixCancelTree` (#2377) are `TRUE`. F2
`FixPendingRetryGate` is `FALSE`: no merged PR keeps a retry-pending predecessor's edge active.

F7 `FixTaskRetry` (#1832) adds `ER` and `H7R`, the `ownerTaskId` fence on `H7`/`H8`, the
retry-pending clause in `EFin`, and per-generation handler threads. With it off, `tg` never
exceeds 1 and every pre-existing `Fix-*` config gives the same distinct-state count as before.
`TaskGenBound` is a model-sanity invariant: every task generation has a handler thread.

F8 `FixStepFence` (#2364) fences `XCkOk`, `XFail`, `P6` and `P7` on the claim (`Fence`), writes an
exhausted failure's step and run in one transaction (`XFail`, `P7`; `P10` is pre-F8 only), and,
with `ChildRunResume`, adds `ChildStart` / `XChild`, the re-claim in `XDedup`, `ChildClaim`
(`EC`, `HC`), the `P8` re-arm, and Case 7 (`H14`-`H17`). It is `TRUE` in the configs that model
current `main` (`Workflows`, `Long`, `Probe-child-run*` except the crash control,
`Probe-orphan-sweep`, `Probe-replay-unreadable*`, `Probe-task-retry`) and `FALSE` in the calibration, `Fix-*`, `Ctl-*`, `Probe-cancel-finalize` and
`Probe-input-await` configs, which keep their verdicts and state spaces. `Probe-child-run-crash-control.cfg`
is `Probe-child-run-crash.cfg` with it off.

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

`ChildRunResume` (#2030) is a node-kind constant, not a fix flag: `TRUE` makes every async branch
a `sub-workflow` step. It is `FALSE` in every config except `Probe-child-run*.cfg` (the `-control`
variant sets it `FALSE`), so the other configs keep their verdicts and state spaces.

`ReplayUnreadable` is an environment constant, not a fix flag: `TRUE` lets every read site in
"Unreadable replay state" throw. It is `FALSE` in every config except `Probe-replay-unreadable.cfg`
and `Probe-child-run-unreadable.cfg`, so those configs keep their verdicts and state spaces.

## Not modelled: foreach fan-outs (#2314, #2316)

The graph has no `foreach` node, so none of the foreach paths are reachable: the parent park and
item drive (`parkAndDriveForeach`, `engine.ts:1109-1122`, `retry-poller.ts:140-166`), the
heartbeat Case 6 re-drive of queued or orphaned items (`recoverForeachFanouts`,
`recovery.ts:501-545`, which selects only `#`-suffixed item rows), item settlement through
`settleForeachChild` in `failStepAndRunIfWaiting`, `checkpointPortStepAndResolveSuccessors` and
`completeTaskStepAndResolveSuccessors`, the per-fan-out failure policy (`stepFailureMode`), late
outcomes of a failed run's items (`recordLateForeachOutcome`), and the attempt rows a run retry
adds per failed item (`createForeachAttemptSteps`). For every non-foreach step these helpers take
the pre-existing branch, so the modelled guards are unchanged.
