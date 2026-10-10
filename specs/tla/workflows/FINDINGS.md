# Findings: workflow run/step lifecycle model

Model: `Workflows.tla` (one run, trigger `T` fanning out to parallel branches that join on `M`,
retry `maxRetries = 1`, actors: initial walk, retry poller, heartbeat recovery, task-event
handlers, user cancel, user retry, crash). Code map: `ACTIONS.md`. Calibration: `CALIBRATION.md`
(2/2 historical bugs found).

## Summary

| | Count |
|---|---|
| Calibration bugs rediscovered | **2 / 2** (bf12ab53 / #1584, d4753302) |
| Counterexamples found on `main` @ `2180cd401` (CX1-CX7) | **7**, all fixed (#1666, #1675, #1678, #1673) |
| Confirmed by a bun test that failed on `main` | **7** (all now pass as plain `test`) |
| Open counterexamples on `main` @ `795526ca3` (CX8-CX10) | **3**, no repro test yet |
| Closed by #1832 (CX11) | **1** |
| Open counterexamples on `main` @ `eaf5d0cc1` (CX12 from #1832, CX13 pre-existing) | **2**, no repro test yet |
| Open counterexamples on `main` @ `7912fff73` (CX14 from #1926) | **1**, no repro test yet |
| Dropped as model drift | **0** (false-positive rate 0 / 7) |

CX1-CX7 each have a repro in `src/tests/workflow-tla-races.test.ts`. The tests call the
production functions in trace order against a temp SQLite DB; a barrier executor holds a node
"in flight" where the trace interleaves with a running executor. Each was marked `test.failing`
while the bug existed; each fix PR flipped its test to `test`. On `795526ca3` the file is
8 pass / 0 fail / 0 `test.failing`.

## Status on `main` @ `795526ca3`

| CX | Fix | Flag now current | Fix config (holds) | Control (still finds it) |
|---|---|---|---|---|
| CX1 | #1666 | F1 `FixPollerRunGuard` | `Fix-CX1.cfg` | `Workflows.cfg` before this sync |
| CX2 | #1675 | F3 `FixConcurrentJoin`, F5 `FixUserRetryLive` | `Fix-CX2.cfg` | `Ctl-CX2.cfg` |
| CX3 | #1673 | F6 `FixJoinWaitsLive` | `Fix-CX3.cfg` | `Ctl-CX3.cfg` |
| CX4 | #1675 | F3 | `Fix-CX4.cfg` | `Ctl-CX4.cfg` |
| CX5 | #1678 | F4 `FixRecoveryRetry` | `Fix-CX5.cfg` | `Ctl-CX5.cfg` |
| CX6 | #1675 | F3 | `Fix-CX6.cfg` | `Ctl-CX6.cfg`, `Probe-input-await.cfg` |
| CX7 | #1673 | F6 | `Fix-CX7.cfg` | `Ctl-CX7.cfg` |

`Workflows.cfg` and `Long.cfg` now model `main` with F1, F3, F4, F5, and F6 on (F2 is not
implemented). They check `JoinWaitsForBranches` instead of `JoinWaitsForAll`, because #1673
lets a terminally failed branch join (partial failure). With those flags, TLC finds CX8-CX10
below. Each trace was checked against the code by reading it; none has a bun repro yet.

### CX8: the join fires while a branch is waiting for, or running, its retry

`executeStep` reports a step that failed with a retry pending as `completed` with no successors,
so the walk adds the branch to `completedNodeIds` (`engine.ts:405` on `80949f9aa`). When a sibling branch
completes, the F6 batch gate sees that branch in `completedNodeIds` and runs `M`, even when the
retry poller has already claimed the branch and is executing it. `M` runs without the branch's
output. This is the gap F2 (`FixPendingRetryGate`) was proposed for.

- Property: `JoinWaitsForBranches` (Inv3c). 16,466 distinct states, 26-state trace, `Workflows.cfg`.
- Trace: `… XDedup (A) → XRun → XFail (A retry pending) → P1 → WPick → XDedup (B) → P2 → P3 → P4 (A running, poller) → XRun → XCkOk (B) → WBatchEnd → WPick → XDedup (M, A still running)`
- `JoinWaitsForAll` (not claimed on `main`) fails earlier on the same root, with the retry not yet claimed: 4,717 distinct states, depth 20.

### CX9: a user retry re-executes a branch that is pending its own retry

`A` fails with a retry pending; async branch `B`'s task fails and fails the run. The user retries.
`retryFailedRun` drops nodes whose step is `running` or `waiting` (F5), but not a node with a
retry-pending row, so it walks `A` and inserts a new `A` row. The poller then claims the old
`A` row (the run is `running` again): two executions of `A`.

- Invariant: `AtMostOneExecuting` (Inv2). 332,267 distinct states, 31-state trace, `Workflows.cfg`
  with `CompletedRunQuiescent`, `JoinWaitsForBranches` removed so TLC reaches it.
- Trace: `… XFail (A retry pending) → P1 → P2 → P3 → TaskFinish(B fail) → E1 → EF (run failed) → U1 → U2 → WStart → WPick → XDedup (new A) → P4 (old A running)`

### CX10: a stale walk's finalizer completes a run the user just retried

`A` exhausts its retry in the poller and fails the run before the initial walk dedups `B`, so
that dedup halts and the walk heads for its finalizer. The user
retries: `U2` resets the failed row to `pending` and sets the run `running`. The initial walk now
reaches its finalizer, which sees a `running` run with no waiting, running, or retry-pending row
(it does not count `pending`) and marks it `completed`. The retry walk then halts on the completed
run, so the user's retry never executes.

- Invariant: `CompletedRunQuiescent` (Inv4). 78,914 distinct states, 27-state trace, `Workflows.cfg`
  without `JoinWaitsForBranches`.
- Trace: `… P4 (A running) → P5 → P7 → P10 (run failed) → XDedup (B halted) → WBatchEnd → U1 → U2 (A pending, run running) → WFinal (run completed)`
- Related to the third fix-model gap below (the orphaned `pending` row).

A fourth trace needs a crash: `Long.cfg` (BFS, 19,342 distinct states, depth 21) finds
`AtMostOneExecuting` when the process crashes after an async executor dispatched its task but
before `checkpointStepWaiting`. F3 deliberately lets recovery re-run a `running` row nobody owns,
so the node dispatches a second task. This is at-least-once delivery at a crash, not a race
between live actors.

## Sync with #1832 (`main` @ `eaf5d0cc1`)

#1832 makes an agent-task step honor `node.retry` when its task fails. The `task.failed` handler
and the recovery sweep both call `scheduleTaskStepRetry`: one transaction that claims the step
while it is `waiting` and still bound to the failed task, detaches the task, and queues the row
for the retry poller. `finalizeOrWait` now counts a retry-pending row as live. The spec models
this as F7 `FixTaskRetry` (actions `ER`, `H7R`, the `ownerTaskId` fence on `H7`/`H8`, task
generations per row). F7 is on in `Workflows.cfg` and `Long.cfg`.

### CX11 (closed by #1832): finalizeOrWait completes a run while a sibling is pending retry

Leaf `A` is an agent task, sibling `B` fails in the walk with a retry pending. `A`'s task
completes; `finalizeOrWait` saw no `waiting` row and marked the run `completed`, stranding `B`'s
retry. #1832 counts a `failed` row with `nextRetryAt` as live.

- `Ctl-CX11.cfg` (F7 off): `CompletedRunQuiescent` violated. Trace: `… XCkWait (A waiting) → TaskFinish(A ok) → E1 → E2 → XFail (B retry pending) → EFin (run completed)`.
- `Fix-CX11.cfg` (F7 on, no sweeps): holds, 78,384 distinct states.

### CX12 (opened by #1832): recovery and the poller both execute an agent-task step whose task failed mid-sweep

`A` and `B` are agent tasks (leaves). `B`'s task completes; `E2` sets the run `running` and has
not finalized yet, and no walk is active. A heartbeat sweep reads the run: `A` is `waiting`, not
completed and not retry-pending, so `findReadyNodes` returns it. Before the walk dedups `A`,
`A`'s task fails and `task.failed` queues its retry (step `failed` + `nextRetryAt`).
`getCurrentStepForNode` memoizes only `running`/`waiting`/`completed` rows, so the recovery walk
inserts a new `A` row and executes it, and the poller claims the old row: two executions.
Before #1832 the failure failed the run, and the recovery walk's dedup halted.

- Invariant: `AtMostOneExecuting` (Inv2). `Probe-task-retry.cfg`, 630,500 distinct states, depth 36.
- Trace: `… XCkWait (A, B waiting) → WRet → TaskFinish(B ok) → TaskFinish(A fail) → E1 → E2 (run running) → H1 → H2 (A ready) → H3 → WStart → E1 → ER (A retry pending) → P1 → P2 → P3 → P4 (old A running) → WPick → XDedup (new A)`
- The same path reaches CX8 with converging branches: an async branch whose retry is queued by
  `task.failed` lets the join fire (`Workflows.cfg` with `BranchOutcomes = {"async"}`,
  `JoinWaitsForBranches`, 142,080 distinct states). Before #1832 only a sync `XFail` reached CX8.

### CX13 (pre-existing, found during this sync): finalizeOrWait completes a cancelled run

`finalizeOrWait` has no run-status guard. A leaf agent task completes, `E2` sets the run
`running`, the user cancels, then `finalizeOrWait` writes `completed` over `cancelled`. Not
introduced by #1832; no earlier config combined leaves, async branches, and cancel.

- Property: `TerminalRunStaysQuiet` (Inv1). `Probe-cancel-finalize.cfg`, 954 distinct states, depth 20.
- Trace: `… XCkWait (B waiting) → TaskFinish(B ok) → E1 → E2 (run running) → Cancel → EFin (run completed)`

## Sync with #1926 fail-closed write (`main` @ `7912fff73`)

#1926 seals the exact run context and step outputs into `*_replay` columns. Reads open them
lazily; when a sealed copy cannot be opened (missing or rotated `SECRETS_ENCRYPTION_KEY`,
corrupt ciphertext), `failRunOnUnreadableReplay` writes the claimed step `failed`, then the run
`failed`. Both writes are `WHERE id = ?` with no status guard, and they are separate awaits after
the read. The spec models this with the `ReplayUnreadable` constant and one alternative action
per read site (ACTIONS.md, "Unreadable replay state"). `ReplayUnreadable` is `FALSE` in every
earlier config, which keep their verdicts; every config that holds keeps its exact state count.

### CX14 (opened by #1926): the fail-closed write turns a cancelled or completed run into failed

Leaf `A` is an agent task. Its task completes, and the `task.completed` handler passes its
checks (run `waiting`, step `waiting`, task still bound). Its `run.context` read then throws.
Before `failRunOnUnreadableReplay` writes, the user cancels the run, which cancels `A`. The
handler then writes `A` `cancelled -> failed` (or `A` is already `failed` when the cancel lands
between the two writes) and the run `cancelled -> failed`. The cancel is lost: the run reads as
failed and is open to a user retry.

- Property: `TerminalNeverFails` (Inv1b). `Probe-replay-unreadable.cfg`, 1,408 distinct states, depth 20.
- Trace: `… XCkWait (A waiting) → TaskFinish(A ok) → E1 → E2Unreadable (context read throws) → Cancel (run cancelled) → RFStep (A failed) → RFRun (run failed)`
- Without cancel (same config, `UserCancel = FALSE`, 4,010 distinct states) the target is a
  completed run: `E2` claims `A` and sets the run `running`; with no successors it does not take
  `activeWalks`, so a sweep passes `H1`, and its `run.context` read throws (`H2Unreadable`);
  `EFin` completes the run; `RFRun` writes `completed -> failed`. Trace:
  `… XCkWait (A waiting) → TaskFinish(A ok) → E1 → WBatchEnd → WRet → E2 (run running) → H1 → H2Unreadable → EFin (run completed) → RFRun (run failed)`
- Control: `Probe-replay-unreadable-control.cfg` (`ReplayUnreadable = FALSE`) holds, 13,005
  distinct states. The violation needs the new path.
- A guard of the shape the other terminal writers use (`run.status IN (running, waiting)` on the
  run write, `status NOT IN (completed, cancelled)` on the step write, in one transaction) would
  close it. Not fixed here: this PR changes the spec only.

## Counterexamples

Traces are TLC's shortest (BFS) counterexample, as action names from `ACTIONS.md`. To surface the
next bug, each run after CX1 turned on the fix flags for the bugs already found.

### CX1: the retry poller re-executes a failed step of a cancelled run

`cancelWorkflowRun` treats a `failed` row as terminal and skips it, leaving its `nextRetryAt`.
`getRetryableSteps` has no run-status filter, and the poller flips the row to `running` and
re-runs the executor inside the cancelled run. When that step has no successors, the poller then
writes `completed` over `cancelled`.

- Invariant: `TerminalRunStaysQuiet` (Inv1). 1,665 distinct states, 18-state trace, config `Workflows.cfg`.
- Trace: `IStart → WStart → … → XFail (A failed, retry pending) → P1 → P2 → P3 → Cancel → P4 (A running in a cancelled run)`
- Test: `CX1: the retry poller does not re-execute a failed step of a cancelled run` (A runs twice on `main`). This is the §1 candidate from the design doc.

### CX2: a user retry re-executes a branch the live walk is still running

Branch `B` (async) fails while branch `A` is still executing in the initial walk. The user retries
the failed run. `retryFailedRun` builds its node list with `findReadyNodes`, which only excludes
nodes with a *completed* step, so `A` is walked again. The dedup transaction keys on the row
count, so the second `A` gets a new key and a second execution.

- Invariant: `AtMostOneExecuting` (Inv2). 21,082 distinct states, 23-state trace. Flags: `FixPollerRunGuard`.
- Trace: `… XCkWait (B waiting) → WPick → TaskFinish(B fail) → E1 → EF (run failed) → U1 → U2 (run running) → XDedup (A) → WStart → WPick → XDedup (second A)`
- Test: `CX2: a user retry does not re-execute a branch the live walk is still running`.

### CX3: the join fires, and the run completes, while a sibling branch is still executing

`B` is an agent task and finishes while `A` is still executing (or still dispatching its own
task). The completion handler walks `M`. The seed gate only waits for predecessors that have an
*active edge to `M`*, and `A` has not produced one yet (it is neither completed nor waiting), so
`M` runs with `A`'s output missing. The walk then finalizes the run as `completed` with `A` still
running.

- Invariant: `CompletedRunQuiescent` (Inv4) and `JoinWaitsForAll` (Inv3b). 34,817 distinct states, 27-state trace. Flags: `FixPollerRunGuard`, `FixUserRetryLive`.
- Trace: `… XCkWait (B waiting) → WPick → XDedup (A running) → TaskFinish(B ok) → E1 → E2 → WStart → WPick → XDedup (M) → XRun → XCkOk → WBatchEnd → WFinal (run completed, A running)`
- Also found by the d4753302 control config with async-only branches (A still dispatching).
- Test: `CX3: an async branch completing does not fire the join while a sibling branch is still executing`.

### CX4: two branch completions racing to the join execute it twice (d4753302 regression)

Both task handlers commit their claim before either walks `M`. Both walks see both branches
completed, both pass the seed gate, and both INSERT an `M` row. d4753302 fixed this with a
per-run `resumeQueues` chain; `e256c72bd` removed it on the grounds that the walkGraph gate is
sufficient. It is not: the gate is a read outside the dedup transaction.

- Invariant: `AtMostOneExecuting` / `ExecutesOnce` (Inv2/Inv3). 220,493 distinct states, 28-state trace.
- Trace: `… TaskFinish(A) → TaskFinish(B) → E1 → E1 → E2 → E2 → WStart → WPick → XDedup (M) → WStart → WPick → XDedup (second M)`
- Test: `CX4: two branch completions racing to the join execute it once`.

### CX5: heartbeat recovery re-walks a step that is waiting for its retry

`A` failed with a retry pending, `B` completed, the walk ended and left the run `running` (the
finalizer keeps it running for the pending retry). The next heartbeat sweep sees a running, idle
run; `findReadyNodes` returns `A` (not completed), so recovery executes `A` again. The poller
then retries the original row: three executions for one retry.

- Invariant: `AtMostOneExecuting` (Inv2). 338,137 distinct states, 29-state trace.
- Trace: `… XFail (A retry pending) → WBatchEnd → WFinal (run stays running) → WRet → H1 → H2 → P1 → P2 → H3 → WStart → WPick → XDedup (A) → P3 → P4 (original A running)`
- Test: `CX5: heartbeat recovery leaves a step that is pending retry to the retry poller`.

### CX6: heartbeat recovery walks a run whose trigger is still resolving inputs

`startWorkflowExecution` commits the run as `running`, then awaits
`resolveRenderedWorkflowInputs` before `walkGraph` registers the walk in `activeWalks`. A sweep
in that window sees a running run with no live walk and walks the trigger node; the trigger's
own walk then runs it again.

- Invariant: `AtMostOneExecuting` (Inv2). 543 distinct states, 12-state trace. Config
  `Probe-input-await.cfg` (`InputAwait = TRUE`, instant branches, no user actions).
- Trace: `IStart → H1 → H2 → H3 → IWalk → WStart → WStart → WPick → XDedup (T) → WPick → XDedup (second T)`
- Test: `CX6: heartbeat recovery does not walk a run whose trigger is still resolving inputs`.

### CX7: the walk finalizer completes a run while the retry poller is executing a step

Branch `A` fails with a retry pending while branch `B` is still executing. The poller claims `A`
(`running`, `nextRetryAt` cleared). `B` finishes and the walk's finalization transaction checks
only for `waiting` steps and retry-pending `failed` steps, so it marks the run `completed` with
`A` running. Found by TLC while checking the CX1 fix (`Fix-CX1.cfg` with the fix on).

- Invariant: `CompletedRunQuiescent` (Inv4). 1,015 distinct states, 22-state trace.
- Trace: `… XFail (A retry pending) → P1 → P2 → P3 → P4 (A running) → WPick → XDedup (B) → XRun → XCkOk → WBatchEnd → WFinal (run completed, A running)`
- Test: `CX7: the walk finalizer does not complete a run while the retry poller is executing a step`.

## Root causes

1. **Dead dedup.** `executeStep` keys the step on `COUNT(*)` of the node's rows, so the key is
   always new and the memo branch never fires. Any second walker that reaches a node creates a
   second row and a second execution (CX2, CX4, CX5, CX6).
2. **Guards that are process-local or read outside the write.** `activeWalks` does not cover the
   retry poller, the task handlers between claim and walk, or the trigger before `walkGraph`
   (CX5, CX6). The seed gate is a read outside the dedup transaction (CX4).
3. **"Not completed" used as "ready".** `findReadyNodes` and the seed gate ignore nodes that are
   running, waiting on a retry, or not yet reached (CX2, CX3, CX5).
4. **Retry-pending rows look terminal.** `failed` with `nextRetryAt` is terminal for cancel, live
   for the poller (CX1).
5. **Finalizers that ignore `running` rows.** The walkGraph finalizer and recovery treat a step
   the poller is executing as settled (CX7).

## Fix-model iterations (not bugs on main)

Checking the proposed fixes together surfaced three gaps in the *fixes*, each corrected in the
spec before the fix PRs:

- Excluding retry-pending nodes from recovery (`FixRecoveryRetry`) exposes recovery's blind
  `run -> completed` when nothing is ready (`recovery.ts:89-95`). The fix must finalize through a
  guarded transaction.
- Waiting on predecessors with a live step is not enough for CX3: a branch that was routed to
  but has not inserted its row yet must also hold the join (`Awaited` in the spec).
- `retryFailedRun` resets the failed row to `pending`, and the walk then inserts a *new* row, so
  the `pending` row is orphaned. A fix that treats `pending` as live parks the run in `waiting`
  forever. Any fix touching liveness must ignore or clean that row.

## Model checking runs

| Run | Config | Result | Distinct states | Depth | Wall |
|---|---|---|---|---|---|
| Current guards | `Workflows.cfg` | CX1 | 1,665 | 19 | 1 s |
| Calibration bf12ab53 | `Cal-bf12ab53.cfg` | found | 371 | 19 | <1 s |
| Calibration d4753302 | `Cal-d4753302.cfg` | found | 4,375 | 33 | 1 s |
| All proposed fixes, 2 branches | `Workflows.cfg` + all `Fix*` | fix-model gap (3rd bullet above) | 47,935,264 | 53 | 8 min 30 s |
| Long run, simulation | `Long.cfg` (3 branches, maxRetries 2, 2 sweeps, 1 crash), `-simulate -depth 120 -continue`, 16 workers | 1,456 violating traces | 310,647,742 states generated (simulation does not dedupe) | ≤120 | 19 min 30 s |
| Long run, BFS | `Long.cfg` | CX1 | 5,385 | 19 | 4 s |

Re-run on `main` @ `795526ca3` (tla2tools 1.8, BFS). Distinct states at a violation vary with `-workers`; a rerun at 4 workers found the `Workflows.cfg` and `Long.cfg` violations at 32,667 and 12,282.

| Config | Result | Distinct states | Depth |
|---|---|---|---|
| `Workflows.cfg` (current flags) | `JoinWaitsForBranches` violated (CX8) | 16,466 | 26 |
| `Long.cfg` (current flags) | `AtMostOneExecuting` violated (crash trace above) | 19,342 | 21 |
| `Cal-bf12ab53.cfg` / control | found / holds | 113 / 160 | 14 / 27 |
| `Cal-d4753302.cfg` / control | found / found (CX4, see CALIBRATION.md) | 4,292 / 2,856 | 32 / 32 |
| `Fix-CX1` .. `Fix-CX7` | all hold | 4,073 / 471,850 / 308,120 / 113,010 / 26,296 / 3,325 / 3,778 | 36-47 |
| `Ctl-CX2` .. `Ctl-CX7` | all find their CX | 809 / 2,055 / 29,904 / 6,466 / 116 / 965 | 12-29 |
| `Probe-input-await.cfg` | CX6 found | 119 | 12 |

Re-run on `main` @ `80949f9aa` (tla2tools 1.8, BFS, `-workers auto -deadlock`) after syncing with #1706 and #1715. Neither PR changes a modelled guard, so the `.tla` and `.cfg` files are unchanged and every config gives the same verdict as on `795526ca3`.

| Config | Result | Distinct states | Trace |
|---|---|---|---|
| `Workflows.cfg` | `JoinWaitsForBranches` violated (CX8) | 30,087 | 24 |
| `Long.cfg` | `AtMostOneExecuting` violated (crash trace) | 22,331 | 20 |
| `Cal-bf12ab53.cfg` / control | found / holds | 415 / 160 | 11 / - |
| `Cal-d4753302.cfg` / control | found / found | 4,266 / 3,165 | 32 / 32 |
| `Fix-CX1` .. `Fix-CX7` | all hold | 4,073 / 471,850 / 308,120 / 113,010 / 26,296 / 3,325 / 3,778 | - |
| `Ctl-CX2` .. `Ctl-CX7` | all find their CX | 2,073 / 2,451 / 23,232 / 9,507 / 506 / 1,326 | 22 / 21 / 28 / 29 / 12 / 27 |
| `Probe-input-await.cfg` | CX6 found | 791 | 12 |

The long simulation on `main` @ `2180cd401` with 3 branches produced 1,456 violating traces: 1,438
`TerminalRunStaysQuiet`, 11 `JoinWaitsForAll`, 3 `ExecutesOnce`, 2 `AtMostOneExecuting`,
2 `CompletedRunQuiescent`. No new property failed. Individual simulation traces were not triaged
one by one; the BFS traces above are the ones mapped to code and tests.

Liveness (`EventuallySettles`, Inv5) is defined but not checked in these configs; the safety
bugs above make it moot until they are fixed.

Re-run on `main` @ `eaf5d0cc1` (tla2tools 2.19, BFS, `-workers auto`) after syncing with #1832.
With F7 off, every `Fix-CX1` .. `Fix-CX7` config gives the same distinct-state count as before,
so the refactor (task generations, per-generation handler threads) is behavior-preserving.

| Config | Result | Distinct states | Trace |
|---|---|---|---|
| `Workflows.cfg` | `JoinWaitsForBranches` violated (CX8) | 29,695 | 24 |
| `Long.cfg` | `AtMostOneExecuting` violated (crash trace) | 9,698 | 19 |
| `Cal-bf12ab53.cfg` / control | found / holds | 413 / 160 | 18 / - |
| `Cal-d4753302.cfg` / control | found / found | 4,919 / 3,150 | 33 / 34 |
| `Fix-CX1` .. `Fix-CX7` | all hold | 4,073 / 471,850 / 308,120 / 113,010 / 26,296 / 3,325 / 3,778 | - |
| `Ctl-CX2` .. `Ctl-CX7` | all find their CX | 1,562 / 2,883 / 24,936 / 9,033 / 435 / 1,156 | 25 / 22 / 31 / 33 / 20 / 30 |
| `Fix-CX11` / `Ctl-CX11` | holds / found | 78,384 / 1,311 | - / 21 |
| `Probe-task-retry.cfg` | CX12 found | 630,500 | 36 |
| `Probe-cancel-finalize.cfg` | CX13 found | 954 | 20 |
| `Probe-input-await.cfg` | CX6 found | 458 | 20 |


Re-run on `main` @ `262770f33` (tla2tools 2.19, BFS, `-workers auto`) after syncing with #1926.
#1926 adds a fail-closed write path for an unreadable replay state, which the model does not
reach (see ACTIONS.md), so the `.tla` and `.cfg` files are unchanged and every config gives the
same verdict as on `eaf5d0cc1`. `src/tests/workflow-tla-races.test.ts`: 8 pass / 0 fail / 0 `test.failing`.

| Config | Result | Distinct states | Trace |
|---|---|---|---|
| `Workflows.cfg` | `JoinWaitsForBranches` violated (CX8) | 24,568 | 23 |
| `Long.cfg` | `AtMostOneExecuting` violated (crash trace) | 16,193 | 19 |
| `Cal-bf12ab53.cfg` / control | found / holds | 392 / 160 | 11 / - |
| `Cal-d4753302.cfg` / control | found / found | 4,463 / 3,033 | 32 / 32 |
| `Fix-CX1` .. `Fix-CX7` | all hold | 4,073 / 471,850 / 308,120 / 113,010 / 26,296 / 3,325 / 3,778 | - |
| `Ctl-CX2` .. `Ctl-CX7` | all find their CX | 1,169 / 2,541 / 19,565 / 6,037 / 384 / 1,147 | 22 / 19 / 30 / 32 / 12 / 27 |
| `Fix-CX11` / `Ctl-CX11` | holds / found | 78,384 / 1,162 | - / 20 |
| `Probe-task-retry.cfg` | CX12 found | 492,241 | 34 |
| `Probe-cancel-finalize.cfg` | CX13 found | 861 | 18 |
| `Probe-input-await.cfg` | CX6 found | 510 | 12 |

Re-run on `main` @ `7912fff73` (tla2tools 2.19, BFS, `-workers auto`) after modelling the #1926
fail-closed write. Every earlier config sets `ReplayUnreadable = FALSE` and gives the same
verdict as on `262770f33`; every config that holds has the same distinct-state count.
`src/tests/workflow-tla-races.test.ts`: 8 pass / 0 fail / 0 `test.failing`.

| Config | Result | Distinct states | Trace |
|---|---|---|---|
| `Workflows.cfg` | `JoinWaitsForBranches` violated (CX8) | 22,558 | 26 |
| `Long.cfg` | `AtMostOneExecuting` violated (crash trace) | 14,116 | 18 |
| `Cal-bf12ab53.cfg` / control | found / holds | 336 / 160 | 11 / - |
| `Cal-d4753302.cfg` / control | found / found | 4,881 / 2,512 | 32 / 32 |
| `Fix-CX1` .. `Fix-CX7` | all hold | 4,073 / 471,850 / 308,120 / 113,010 / 26,296 / 3,325 / 3,778 | - |
| `Ctl-CX2` .. `Ctl-CX7` | all find their CX | 2,307 / 2,634 / 30,220 / 7,710 / 533 / 947 | 22 / 19 / 29 / 32 / 12 / 27 |
| `Fix-CX11` / `Ctl-CX11` | holds / found | 78,384 / 1,415 | - / 20 |
| `Probe-task-retry.cfg` | CX12 found | 604,546 | 34 |
| `Probe-cancel-finalize.cfg` | CX13 found | 773 | 17 |
| `Probe-input-await.cfg` | CX6 found | 309 | 12 |
| `Probe-replay-unreadable.cfg` / control | CX14 found / holds | 1,408 / 13,005 | 20 / - |
