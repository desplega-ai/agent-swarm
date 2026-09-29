# Calibration

Before trusting a new counterexample, the model must rediscover two historical bugs when the
guard each fix added is removed. Result: **2/2 found.**

Each calibration config narrows the actors to the historical scenario, so the only bug left to
find is the one under test. Every config also has a control with the guard on.

| Bug | Config | Guard removed | Result | Control (guard on) |
|---|---|---|---|---|
| **bf12ab53 / #1584**: heartbeat recovery re-walks a run whose graph walk is still live | `Cal-bf12ab53.cfg` (instant branches, one sweep) | `GuardActiveWalk` | `AtMostOneExecuting` violated, depth 19, 371 distinct states, <1 s | `Cal-bf12ab53-control.cfg`: **no error**, 160 distinct states |
| **d4753302**: parallel completions create duplicate convergence steps | `Cal-d4753302.cfg` (async branches, no heartbeat) | `GuardConvergeSeed` | `ExecutesOnce` violated on `M` (two `M` rows), depth 33, 4,375 distinct states, 1 s | `Cal-d4753302-control.cfg`: **still violated**, depth 33 |

## bf12ab53 trace (guard removed)

Initial walk is executing branch `A` (`activeWalks` = 1). The sweep does not check
`isWorkflowRunActive`, sees `A` without a completed step in `findReadyNodes`, and re-walks it:
two `A` executions in flight. This is the #1584 shape (the regression test there checks the
in-flight script is not re-run and its successor runs once).

## d4753302 trace (guard removed), and why the control also fails

Without the seed gate, each branch completion walks `M` directly, so `M` runs once per branch.

The control keeps today's seed gate and still fails: both task handlers commit their claim
(`completeTaskStepAndResolveSuccessors`) before either walk reads the steps, so both walks see
`A` and `B` completed, both pass the gate, and both INSERT an `M` row (the iteration key is the
row count, so the second key is new). d4753302 originally fixed this with a per-run
`resumeQueues` promise chain; `e256c72bd` ("remove resumeQueues — convergence gate in walkGraph
is sufficient") removed it. The model shows the gate is not sufficient. This is counterexample
CX4 in FINDINGS.md, confirmed by a failing test.

#1675 fixed CX4 (F3, `FixConcurrentJoin`). The calibration configs keep F3 off so they still
model the code each historical fix was written against, and `Cal-d4753302-control.cfg` still
finds CX4. The same control with `FixConcurrentJoin = TRUE` holds (3,554 distinct states,
depth 38, re-checked on `main` @ `795526ca3`).

## Commands

```bash
tlc Workflows.tla -config Cal-bf12ab53.cfg
tlc Workflows.tla -config Cal-bf12ab53-control.cfg
tlc Workflows.tla -config Cal-d4753302.cfg
tlc Workflows.tla -config Cal-d4753302-control.cfg
```

`tlc` = `java -cp tla2tools.jar tlc2.TLC -workers auto` (Temurin JRE 21, tla2tools 1.8).
