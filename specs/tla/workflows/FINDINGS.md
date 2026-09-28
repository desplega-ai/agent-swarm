# Findings: workflow run/step lifecycle model

Model: `Workflows.tla` (one run, trigger `T` fanning out to parallel branches that join on `M`,
retry `maxRetries = 1`, actors: initial walk, retry poller, heartbeat recovery, task-event
handlers, user cancel, user retry, crash). Code map: `ACTIONS.md`. Calibration: `CALIBRATION.md`
(2/2 historical bugs found).

## Summary

| | Count |
|---|---|
| Calibration bugs rediscovered | **2 / 2** (bf12ab53 / #1584, d4753302) |
| Counterexamples on current `main` | **7** |
| Confirmed by a bun test that fails on `main` | **7** |
| Dropped as model drift | **0** (false-positive rate 0 / 7) |

Every counterexample has a repro in `src/tests/workflow-tla-races.test.ts`. The tests call the
production functions in trace order against a temp SQLite DB; a barrier executor holds a node
"in flight" where the trace interleaves with a running executor. They are marked
`test.failing` so CI stays green while the bug exists; each fix PR flips its test to `test`.

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
  `run -> completed` when nothing is ready (`recovery.ts:88-94`). The fix must finalize through a
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

The long simulation on current `main` with 3 branches produced 1,456 violating traces: 1,438
`TerminalRunStaysQuiet`, 11 `JoinWaitsForAll`, 3 `ExecutesOnce`, 2 `AtMostOneExecuting`,
2 `CompletedRunQuiescent`. No new property failed. Individual simulation traces were not triaged
one by one; the BFS traces above are the ones mapped to code and tests.

Liveness (`EventuallySettles`, Inv5) is defined but not checked in these configs; the safety
bugs above make it moot until they are fixed.
