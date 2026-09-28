# Workflows.tla action map

Every TLA+ action, the code it models, and the SQL guard (or its absence) it encodes.
Line numbers are against `main` @ `2180cd401`. A DB transaction is one atomic action. Every
`await` outside a transaction is an action boundary: other actors interleave there, and a crash
can land there.

## State

| Variable | Code |
|---|---|
| `run` | `workflow_runs.status` (`none` before the INSERT) |
| `steps[i]` | one `workflow_run_steps` row: `node`=nodeId, `st`=status, `rc`=retryCount, `nra`=`nextRetryAt IS NOT NULL`, `task`=linked agent task state |
| `active` | `activeWalks.get(runId)` (`engine.ts:203`, process-local) |
| `execLive[n]` | `executor.run` calls in flight for node `n` (process-local) |
| `okCount[n]` | ghost: successful completions of node `n` (for Inv3) |

Graph: `T` fans out to `Branches`; with `Converge`, every branch has `next: "M"`.
All nodes are non-loop, so every node has one logical iteration.

## walkGraph / executeStep (`src/workflows/engine.ts`)

| Action | Code | Guard modelled |
|---|---|---|
| `Call` | `walkGraph` `engine.ts:226` | `activeWalks` +1 (no DB guard) |
| `WStart` | `engine.ts:262-313`: rehydrate completed steps, `loadCompletedStepRouting`, active edges from `waiting` steps, seed filter | Seed filter `engine.ts:301-313` = `GuardConvergeSeed`. Reads only, no transaction. |
| `WPick` | `engine.ts:331` `Promise.all` over the batch | Batch members interleave in any order |
| `XDedup` | `engine.ts:544-588` dedup transaction | `run.status IN (running, waiting)` else halted. `iteration = COUNT(*)` rows for the node (`db.ts:8099`), `idempotencyKey = runId:node:iteration`. Because the key uses the row count, the key never already exists, so the memo branch is dead and every call INSERTs a new row. |
| `XRun` | `executor.run` `engine.ts:677` | none (process-local) |
| `XCkOk` | `checkpointStep` `engine.ts:792` -> `checkpoint.ts:14-27` | transaction, blind `UPDATE step SET status='completed'` |
| `XFail` | `checkpointStepFailure` `engine.ts:709` -> `checkpoint.ts:43-55` | blind `UPDATE step SET status='failed', retryCount+1, nextRetryAt`; the walk treats the node as completed-with-no-successors (`engine.ts:362`) |
| `XCkWait` | `checkpointStepWaiting` `engine.ts:730` -> `checkpoint.ts:87-103` | CAS `WHERE status='running' AND run.status IN (running, waiting)` |
| `WBatchEnd` | `engine.ts:371-392` in-walk convergence | in-memory `completedNodeIds` / `activeEdges` only |
| `WFinal` | `engine.ts:403-453` finalization transaction | `run.status = 'running'`; `waiting` steps -> waiting; pending retries -> stay running; else completed/failed |
| `WRet` | `engine.ts:229-233` | `activeWalks` -1 |

## Trigger (`engine.ts:84-186`)

| Action | Code | Guard |
|---|---|---|
| `IStart` | `createWorkflowRun` `engine.ts:122` commits `running` | none |
| `IWalk` | `resolveRenderedWorkflowInputs` `engine.ts:164` awaits before `walkGraph` (only when `InputAwait`) | none |

## Retry poller (`src/workflows/retry-poller.ts`)

| Action | Code | Guard |
|---|---|---|
| `P1` | `getRetryableSteps` `retry-poller.ts:35` -> `db.ts:8057-8068` | `status='failed' AND nextRetryAt <= now`. **No run-status filter.** |
| `P2` | `getWorkflowRun` `retry-poller.ts:39` | read |
| `P3` | `retry-poller.ts:54-59` | blind `run -> running` if the snapshot said `failed` |
| `P4` | `retry-poller.ts:62-66` | blind `step -> running, nextRetryAt = NULL`. No transaction, no status guard. |
| `P5` | `executor.run` `retry-poller.ts:113` | none |
| `P6` | `checkpointStep` `retry-poller.ts:181`, then `walkGraph(successors)` `:186` | blind step write |
| `P9` | no successors `retry-poller.ts:196-200` | blind `run -> completed` |
| `P7` | `checkpointStepFailure` `retry-poller.ts:124-130` | blind step write |
| `P10` | `checkpoint.ts:67-74` retries exhausted | blind `run -> failed` |
| `P8` | `checkpointStepWaiting` `retry-poller.ts:138` | CAS (as `XCkWait`) |
| `PRel` | end of one row (loop continues) | — |

## Heartbeat `recoverIncompleteRuns` (`src/workflows/recovery.ts`)

| Action | Code | Guard |
|---|---|---|
| `H1` | `getRunIdsByStatus('running')` `recovery.ts:63`, `isWorkflowRunActive` `:68` | `GuardActiveWalk` (bf12ab53 / #1584) |
| `H2` | re-read run `:69`, completed steps, routing, `findReadyNodes` `:85` | `findReadyNodes` excludes only nodes with a **completed** step |
| `H3` | second `isWorkflowRunActive` `:87`, then complete or `walkGraph` | `GuardActiveWalk` |
| `H4` | `recovery.ts:88-94` `readyNodes.length === 0` | blind `run -> completed`, no transaction |
| `H5` | `getStuckWorkflowRuns` (waiting steps whose task is terminal) | `run.status = 'waiting'` |
| `H6` | per stuck row, re-read run | `run.status = 'waiting'` |
| `H7` | `failStepAndRunIfWaiting` `task-step-routing.ts:24-45` | CAS on `step.status='waiting'` |
| `H8` | `completeTaskStepAndResolveSuccessors` `recovery.ts:155` -> `task-step-routing.ts:96-143`, then `walkGraph(successors)` | CAS on `step.status='waiting'` inside the transaction; sets `run -> running` |

## Task events (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `TaskFinish` | agent task reaches a terminal state; the after-commit bus event is queued | — |
| `E1` | `resumeFromTaskCompletion` `resume.ts:137-142` / `handleTaskFailure` `:230-235` pre-checks | reads, outside any transaction |
| `E2` | `completeTaskStepAndResolveSuccessors` `resume.ts:164` (CAS on the step only), then `walkGraph(successors)` `:183` | step CAS; run status is not re-checked |
| `EFin` | `finalizeOrWait` `resume.ts:201-218` | transaction; **no run-status guard** |
| `EF` | `markRunFailed` -> `failStepAndRunIfWaiting` | step CAS |

## User actions (`src/workflows/resume.ts`)

| Action | Code | Guard |
|---|---|---|
| `Cancel` | `cancelWorkflowRun` `resume.ts:370-418` | one transaction; skips steps whose status is terminal, **including `failed` rows that still carry `nextRetryAt`** |
| `U1` | `retryFailedRun` reads `resume.ts:309-335` (`findReadyNodes` at `:354`) | reads outside the transaction |
| `U2` | claim transaction `resume.ts:341-350`, then `walkGraph(nodesToRun)` `:363` | `run.status = 'failed'`; no check for a live walk or live step |

## Crash

`Crash` drops process-local state (`activeWalks`, executor calls, undelivered bus events) and
grants one extra heartbeat sweep (boot recovery). DB rows survive.

## Invariants (design doc §5)

| Invariant | Kind | Meaning |
|---|---|---|
| `TerminalRunStaysQuiet` | action property | Inv1: a terminal run never gains a running/pending step; a completed or cancelled run never changes status |
| `AtMostOneExecuting` | state | Inv2: at most one live execution per node (executor call or dispatched task) |
| `ExecutesOnce` | state | Inv3: every node completes at most once |
| `JoinWaitsForAll` | action property | Inv3b: the join row is only created after every branch completed |
| `CompletedRunQuiescent` | state | Inv4 (bf12ab53): a completed run has no live step |
| `EventuallySettles` | liveness | Inv5: defined, not checked in the pilot configs (see FINDINGS.md) |

## Fix flags

`Fix*` constants model the fixes proposed in FINDINGS.md. They are `FALSE` in `Workflows.cfg`
(current `main`).
