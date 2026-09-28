---------------------------- MODULE Workflows ----------------------------
(***************************************************************************)
(* Workflow engine run/step lifecycle: one run, a trigger node T fanning   *)
(* out to parallel branches that (optionally) converge on node M.          *)
(*                                                                         *)
(* Actors: the initial walk, the retry poller, the heartbeat recovery      *)
(* sweep, one task-event handler per async step, a user cancel, a user     *)
(* retry, and a process crash.                                             *)
(*                                                                         *)
(* Granularity rule: a DB transaction is ONE action. Every `await` outside *)
(* a transaction is an action boundary, so other actors interleave there   *)
(* and a crash can land there. Every action is mapped to file:line in      *)
(* ACTIONS.md. Guard flags let CALIBRATION.md remove historical fixes, and *)
(* Fix flags model the fixes proposed for the bugs this model found.       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Branches,          \* parallel branch node ids, e.g. {"A","B"}
  Converge,          \* TRUE: branches converge on "M"; FALSE: branches are leaves
  BranchOutcomes,    \* executor outcomes a branch may produce: subset of {"ok","fail","async"}
  MaxRetries,        \* retry policy maxRetries for branch nodes (>= 1)
  MaxSteps,          \* state constraint: max workflow_run_steps rows
  MaxSweeps,         \* heartbeat recovery sweeps
  MaxCrashes,        \* process crashes
  UserCancel,        \* TRUE: the user may cancel the run once
  UserRetry,         \* TRUE: the user may retry a failed run once
  InputAwait,        \* TRUE: workflow.input resolution awaits between run INSERT and walkGraph
  \* --- historical guards (CALIBRATION.md removes them) ---
  GuardActiveWalk,   \* bf12ab53 / #1584: recovery skips runs with a live walk
  GuardConvergeSeed, \* d4753302 lineage: walkGraph gates start nodes on predecessors
  \* --- fixes for the bugs found by this model (FINDINGS.md) ---
  FixPollerRunGuard, \* F1: retry poller claims the step only while the run is live
  FixPendingRetryGate, \* F2: a predecessor that is still running or pending retry keeps its edge active
  FixConcurrentJoin, \* F3: convergence step creation is keyed per iteration, not per row count
  FixUserRetryLive,  \* F5: user retry does not re-walk a node whose step is still live
  FixRecoveryRetry   \* F4: recovery does not re-walk a node that is pending retry / held by the poller

ASSUME MaxRetries >= 1 /\ BranchOutcomes \subseteq {"ok", "fail", "async"}

Nodes == {"T"} \cup Branches \cup (IF Converge THEN {"M"} ELSE {})
Succ(n) == IF n = "T" THEN Branches
           ELSE IF n \in Branches /\ Converge THEN {"M"}
           ELSE {}
Preds(n) == {p \in Nodes : n \in Succ(p)}
Outcomes(n) == IF n \in Branches THEN BranchOutcomes ELSE {"ok"}
Edges(S) == {e \in Nodes \X Nodes : e[1] \in S /\ e[2] \in Succ(e[1])}

RunTerminal == {"completed", "failed", "cancelled"}
StepTerminal == {"completed", "failed", "cancelled"}

\* Thread ids. Events: one handler thread per step row that owns a task.
TInit == 1
TPoll == 2
THb == 3
TCancel == 4
TRetry == 5
Ev(i) == 10 + i
Threads == {TInit, TPoll, THb, TCancel, TRetry} \cup {Ev(i) : i \in 1..MaxSteps}

VARIABLES
  run,       \* workflow_runs.status
  steps,     \* workflow_run_steps rows: [node, st, rc, nra, task]
  thr,       \* per-thread program counter + locals
  active,    \* activeWalks.get(runId) (process-local, engine.ts:203)
  execLive,  \* executor.run calls in flight per node (process-local)
  okCount,   \* successful completions per node (ghost, for Inv3)
  hbLeft,    \* heartbeat sweeps left
  crashes    \* crashes left

vars == <<run, steps, thr, active, execLive, okCount, hbLeft, crashes>>

Idle == [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0,
         done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE,
         R |-> {}, rs |-> "running", rc |-> 0]

StepIds == DOMAIN steps
NodesWith(s) == {steps[i].node : i \in {j \in StepIds : steps[j].st = s}}
\* Retry-pending rows: status failed with nextRetryAt set.
PendingRetry(i) == steps[i].st = "failed" /\ steps[i].nra
RetryNodes == {steps[i].node : i \in {j \in StepIds : PendingRetry(j)}}
\* F2: a join also waits for a predecessor that was routed to (active
\* incoming edge) or that has a live / retry-pending step, even though that
\* predecessor has not produced its own outgoing edge yet.
Awaited(p, edges) ==
  FixPendingRetryGate /\
  \/ \E q \in Nodes : <<q, p>> \in edges
  \/ p \in NodesWith("running") \cup NodesWith("pending") \cup NodesWith("waiting") \cup RetryNodes

\* The node the retry poller currently holds (step flipped to running, not yet checkpointed).
PollerHeld == IF thr[TPoll].pc \in {"p5", "p6", "p7", "p8", "p9", "p10"}
              THEN {thr[TPoll].cur} ELSE {}

Init ==
  /\ run = "none"     \* no workflow_runs row until startWorkflowExecution inserts it
  /\ steps = << >>
  /\ thr = [t \in Threads |->
              IF t = TInit THEN [Idle EXCEPT !.pc = "iStart"]
              ELSE IF t = TPoll THEN [Idle EXCEPT !.pc = "pIdle"]
              ELSE IF t = THb THEN [Idle EXCEPT !.pc = "hIdle"]
              ELSE IF t = TCancel THEN [Idle EXCEPT !.pc = IF UserCancel THEN "cIdle" ELSE "cDone"]
              ELSE IF t = TRetry THEN [Idle EXCEPT !.pc = IF UserRetry THEN "uIdle" ELSE "uDone"]
              ELSE Idle]
  /\ active = 0
  /\ execLive = [n \in Nodes |-> 0]
  /\ okCount = [n \in Nodes |-> 0]
  /\ hbLeft = MaxSweeps
  /\ crashes = MaxCrashes

SetT(t, r) == thr' = [thr EXCEPT ![t] = r]

\* walkGraph(startNodes): enter the walk, returning to `ret` afterwards.
Call(t, starts, ret) ==
  /\ SetT(t, [thr[t] EXCEPT !.pc = "wStart", !.ret = ret, !.pend = starts])
  /\ active' = active + 1

----------------------------------------------------------------------------
(* walkGraph / executeStep (engine.ts)                                     *)

\* W1 engine.ts:262-313 — rehydrate completed steps, rebuild active edges
\* (completed routing + waiting steps), seed-filter the start nodes.
WStart(t) ==
  /\ thr[t].pc = "wStart"
  /\ LET done == NodesWith("completed")
         live == NodesWith("waiting")
                 \cup (IF FixPendingRetryGate THEN NodesWith("running") \cup NodesWith("pending") \cup RetryNodes
                    ELSE {})
         edges == Edges(done) \cup Edges(live)
         ok(n) == IF Preds(n) = {} THEN n \notin done
                  ELSE IF ~GuardConvergeSeed THEN TRUE
                  ELSE LET ap == {p \in Preds(n) : <<p, n>> \in edges \/ Awaited(p, edges)}
                       IN (IF ap # {} THEN ap ELSE Preds(n)) \subseteq done
     IN SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.pend = {n \in thr[t].pend : ok(n)},
                  !.done = done, !.edges = edges, !.nxt = {}, !.ex = {}, !.hasW = FALSE])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* W2 engine.ts:331 — Promise.all over the batch; each node's executeStep
\* is a sequence of awaits, so batch members are explored in every order.
WPick(t) ==
  /\ thr[t].pc = "wPick"
  /\ thr[t].pend # {}
  /\ \E n \in thr[t].pend :
       SetT(t, [thr[t] EXCEPT !.pc = "xDedup", !.cur = n, !.pend = @ \ {n}])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* X1 engine.ts:544-588 — dedup transaction: run-status guard, iteration =
\* COUNT(steps for node), idempotency key includes that count, INSERT.
XDedup(t) ==
  /\ thr[t].pc = "xDedup"
  /\ LET n == thr[t].cur IN
     IF run \notin {"running", "waiting"}
     THEN \* halted -> reported as completed with no successors
          /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.done = @ \cup {n}, !.ex = @ \cup {n}])
          /\ UNCHANGED <<steps, execLive>>
     ELSE IF FixConcurrentJoin /\ n \in NodesWith("completed") \cup NodesWith("waiting")
                                         \cup NodesWith("running")
     THEN \* F3: the iteration key is already taken by a live/finished row -> memoized
          /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.ex = @ \cup {n},
                       !.hasW = @ \/ n \in NodesWith("waiting") \cup NodesWith("running")])
          /\ UNCHANGED <<steps, execLive>>
     ELSE /\ steps' = Append(steps, [node |-> n, st |-> "running", rc |-> 0,
                                      nra |-> FALSE, task |-> "none"])
          /\ execLive' = [execLive EXCEPT ![n] = @ + 1]
          /\ SetT(t, [thr[t] EXCEPT !.pc = "xRun", !.sid = Len(steps) + 1])
  /\ UNCHANGED <<run, active, okCount, hbLeft, crashes>>

\* X2 engine.ts:676-683 — executor.run returns (ok / failed / async dispatch).
XRun(t) ==
  /\ thr[t].pc = "xRun"
  /\ LET n == thr[t].cur IN
     /\ execLive' = [execLive EXCEPT ![n] = @ - 1]
     /\ \E o \in Outcomes(n) :
          CASE o = "ok" -> SetT(t, [thr[t] EXCEPT !.pc = "xCkOk"]) /\ UNCHANGED steps
            [] o = "fail" -> SetT(t, [thr[t] EXCEPT !.pc = "xFail"]) /\ UNCHANGED steps
            [] o = "async" ->
                 /\ steps' = [steps EXCEPT ![thr[t].sid].task = "run"]
                 /\ SetT(t, [thr[t] EXCEPT !.pc = "xCkWait"])
  /\ UNCHANGED <<run, active, okCount, hbLeft, crashes>>

\* X3 engine.ts:792 + checkpoint.ts:14-27 — checkpointStep (transaction, blind
\* step write), then in-memory successor routing engine.ts:360-368.
XCkOk(t) ==
  /\ thr[t].pc = "xCkOk"
  /\ LET n == thr[t].cur IN
     /\ steps' = [steps EXCEPT ![thr[t].sid].st = "completed"]
     /\ okCount' = [okCount EXCEPT ![n] = @ + 1]
     /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.done = @ \cup {n}, !.ex = @ \cup {n},
                  !.edges = @ \cup Edges({n}), !.nxt = @ \cup Succ(n)])
  /\ UNCHANGED <<run, active, execLive, hbLeft, crashes>>

\* X4 engine.ts:706-725 + checkpoint.ts:43-55 — failed with retries left:
\* one blind step write (failed, retryCount+1, nextRetryAt). executeStep
\* returns outcome "completed" with no successors, so walkGraph adds the
\* node to its in-memory completed set (engine.ts:362).
XFail(t) ==
  /\ thr[t].pc = "xFail"
  /\ LET n == thr[t].cur IN
     /\ steps' = [steps EXCEPT ![thr[t].sid].st = "failed", ![thr[t].sid].rc = 1,
                               ![thr[t].sid].nra = TRUE]
     /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick",
                  !.done = IF FixPendingRetryGate THEN @ ELSE @ \cup {n},
                  !.edges = IF FixPendingRetryGate THEN @ \cup Edges({n}) ELSE @,
                  !.ex = @ \cup {n}])
  /\ UNCHANGED <<run, active, execLive, okCount, hbLeft, crashes>>

\* X5 engine.ts:729-732 + checkpoint.ts:82-104 — checkpointStepWaiting CAS.
XCkWait(t) ==
  /\ thr[t].pc = "xCkWait"
  /\ LET i == thr[t].sid
         n == thr[t].cur IN
     IF steps[i].st = "running" /\ run \in {"running", "waiting"}
     THEN /\ steps' = [steps EXCEPT ![i].st = "waiting"]
          /\ run' = "waiting"
          /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.hasW = TRUE])
     ELSE /\ SetT(t, [thr[t] EXCEPT !.pc = "wPick", !.done = @ \cup {n}, !.ex = @ \cup {n}])
          /\ UNCHANGED <<steps, run>>
  /\ UNCHANGED <<active, execLive, okCount, hbLeft, crashes>>

\* W3 engine.ts:371-392 — end of batch: pause on waiting, else in-walk
\* convergence check over the in-memory completed set.
WBatchEnd(t) ==
  /\ thr[t].pc = "wPick"
  /\ thr[t].pend = {}
  /\ IF thr[t].hasW
     THEN SetT(t, [thr[t] EXCEPT !.pc = "wRet"])
     ELSE LET w == thr[t]
              rn == {n \in w.nxt : n \notin w.ex
                        /\ {p \in Preds(n) : <<p, n>> \in w.edges \/ Awaited(p, w.edges)}
                             \subseteq w.done}
          IN IF rn # {}
             THEN SetT(t, [thr[t] EXCEPT !.pend = rn, !.nxt = {}])
             ELSE SetT(t, [thr[t] EXCEPT !.pc = "wFinal"])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* W4 engine.ts:403-453 — finalization transaction (guarded on running).
WFinal(t) ==
  /\ thr[t].pc = "wFinal"
  /\ IF run = "running"
     THEN LET hasW == \E i \in StepIds : steps[i].st = "waiting"
                        \/ (FixPendingRetryGate /\ steps[i].st \in {"running", "pending"})
              hasPR == \E i \in StepIds : PendingRetry(i)
              failedS == \E i \in StepIds : steps[i].st = "failed" /\ ~steps[i].nra
              hasC == \E i \in StepIds : steps[i].st = "completed" /\ steps[i].node # "T"
          IN run' = IF hasW THEN "waiting"
                    ELSE IF hasPR THEN "running"
                    ELSE IF failedS /\ ~hasC THEN "failed"
                    ELSE "completed"
     ELSE UNCHANGED run
  /\ SetT(t, [thr[t] EXCEPT !.pc = "wRet"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* W5 engine.ts:229-233 — leave the walk (activeWalks decrement).
WRet(t) ==
  /\ thr[t].pc = "wRet"
  /\ active' = active - 1
  /\ SetT(t, [thr[t] EXCEPT !.pc = thr[t].ret])
  /\ UNCHANGED <<run, steps, execLive, okCount, hbLeft, crashes>>

Walk(t) == WStart(t) \/ WPick(t) \/ XDedup(t) \/ XRun(t) \/ XCkOk(t) \/ XFail(t)
           \/ XCkWait(t) \/ WBatchEnd(t) \/ WFinal(t) \/ WRet(t)

----------------------------------------------------------------------------
(* Initial trigger: startWorkflowExecution -> walkGraph([T])               *)
\* engine.ts:136-186: createWorkflowRun commits `running`; with workflow.input
\* set, resolveRenderedWorkflowInputs awaits before walkGraph registers the walk.
IStart ==
  /\ thr[TInit].pc = "iStart"
  /\ run' = "running"
  /\ IF InputAwait
     THEN SetT(TInit, [thr[TInit] EXCEPT !.pc = "iWalk"]) /\ UNCHANGED active
     ELSE Call(TInit, {"T"}, "iDone")
  /\ UNCHANGED <<steps, execLive, okCount, hbLeft, crashes>>

IWalk ==
  /\ thr[TInit].pc = "iWalk"
  /\ Call(TInit, {"T"}, "iDone")
  /\ UNCHANGED <<run, steps, execLive, okCount, hbLeft, crashes>>

----------------------------------------------------------------------------
(* Retry poller (retry-poller.ts)                                          *)

\* P1 retry-poller.ts:35 / db.ts getRetryableSteps — snapshot, no run filter.
P1 ==
  /\ thr[TPoll].pc = "pIdle"
  /\ \E i \in StepIds : PendingRetry(i)
  /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p2", !.R = {i \in StepIds : PendingRetry(i)}])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* P2 retry-poller.ts:37-39 — next row; getWorkflowRun.
P2 ==
  /\ thr[TPoll].pc = "p2"
  /\ IF thr[TPoll].R = {}
     THEN SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "pIdle"])
     ELSE \E i \in thr[TPoll].R :
            SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p3", !.R = @ \ {i}, !.sid = i,
                          !.cur = steps[i].node, !.rc = steps[i].rc, !.rs = run])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* P3 retry-poller.ts:54-59 — failed run set back to running (blind).
\* F1: skip the row unless the run is live and the row is still retry-pending.
P3 ==
  /\ thr[TPoll].pc = "p3"
  /\ IF FixPollerRunGuard
     THEN SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p4"]) /\ UNCHANGED run
     ELSE /\ run' = IF thr[TPoll].rs = "failed" THEN "running" ELSE run
          /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p4"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* P4 retry-poller.ts:62-66 — step -> running, nextRetryAt cleared (blind).
\* F1: one transaction, conditional on the row still being retry-pending
\* and the run being running/waiting/failed-by-this-step.
P4 ==
  /\ thr[TPoll].pc = "p4"
  /\ LET i == thr[TPoll].sid IN
     IF FixPollerRunGuard /\ ~(PendingRetry(i) /\ run \in {"running", "waiting", "failed"})
     THEN /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p2"])
          /\ UNCHANGED <<steps, execLive, run, active>>
     ELSE /\ steps' = [steps EXCEPT ![i].st = "running", ![i].nra = FALSE]
          /\ execLive' = [execLive EXCEPT ![thr[TPoll].cur] = @ + 1]
          /\ run' = IF FixPollerRunGuard /\ run = "failed" THEN "running" ELSE run
          /\ active' = IF FixRecoveryRetry THEN active + 1 ELSE active
          /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p5"])
  /\ UNCHANGED <<okCount, hbLeft, crashes>>

\* P5 retry-poller.ts:113-117 — executor.run.
P5 ==
  /\ thr[TPoll].pc = "p5"
  /\ execLive' = [execLive EXCEPT ![thr[TPoll].cur] = @ - 1]
  /\ \E o \in Outcomes(thr[TPoll].cur) :
       CASE o = "ok" -> SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p6"]) /\ UNCHANGED steps
         [] o = "fail" -> SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p7"]) /\ UNCHANGED steps
         [] o = "async" ->
              /\ steps' = [steps EXCEPT ![thr[TPoll].sid].task = "run"]
              /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p8"])
  /\ UNCHANGED <<run, active, okCount, hbLeft, crashes>>

\* P6 retry-poller.ts:181-193 — checkpointStep, then walkGraph(successors).
P6 ==
  /\ thr[TPoll].pc = "p6"
  /\ LET n == thr[TPoll].cur IN
     /\ steps' = [steps EXCEPT ![thr[TPoll].sid].st = "completed"]
     /\ okCount' = [okCount EXCEPT ![n] = @ + 1]
     /\ IF Succ(n) # {}
        THEN Call(TPoll, Succ(n), "pRel")
        ELSE SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p9"]) /\ UNCHANGED active
  /\ UNCHANGED <<run, execLive, hbLeft, crashes>>

\* P9 retry-poller.ts:196-200 — no successors: run -> completed (blind).
\* F1: finalize through the guarded finalizeOrWait-shaped transaction.
P9 ==
  /\ thr[TPoll].pc = "p9"
  /\ run' = IF FixPollerRunGuard
            THEN IF run \notin {"running", "waiting"} THEN run
                 ELSE IF \E i \in StepIds : steps[i].st = "waiting" \/ steps[i].st = "running"
                                            \/ PendingRetry(i)
                      THEN run ELSE "completed"
            ELSE "completed"
  /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "pRel"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* P7 retry-poller.ts:124-130 + checkpoint.ts:43-65 — re-failed.
P7 ==
  /\ thr[TPoll].pc = "p7"
  /\ LET i == thr[TPoll].sid IN
     IF thr[TPoll].rc < MaxRetries
     THEN /\ steps' = [steps EXCEPT ![i].st = "failed", ![i].rc = thr[TPoll].rc + 1,
                                    ![i].nra = TRUE]
          /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "pRel"])
     ELSE /\ steps' = [steps EXCEPT ![i].st = "failed", ![i].nra = FALSE]
          /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p10"])
  /\ UNCHANGED <<run, active, execLive, okCount, hbLeft, crashes>>

\* P10 checkpoint.ts:67-74 — retries exhausted: run -> failed (separate write).
P10 ==
  /\ thr[TPoll].pc = "p10"
  /\ run' = IF FixPollerRunGuard /\ run \notin {"running", "waiting"} THEN run ELSE "failed"
  /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "pRel"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* P8 retry-poller.ts:138 — checkpointStepWaiting CAS.
P8 ==
  /\ thr[TPoll].pc = "p8"
  /\ LET i == thr[TPoll].sid IN
     IF steps[i].st = "running" /\ run \in {"running", "waiting"}
     THEN steps' = [steps EXCEPT ![i].st = "waiting"] /\ run' = "waiting"
     ELSE UNCHANGED <<steps, run>>
  /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "pRel"])
  /\ UNCHANGED <<active, execLive, okCount, hbLeft, crashes>>

\* End of one poller row. F4: the poller holds activeWalks for the row it
\* executes, so recovery's existing isWorkflowRunActive guard covers it.
PRel ==
  /\ thr[TPoll].pc = "pRel"
  /\ active' = IF FixRecoveryRetry THEN active - 1 ELSE active
  /\ SetT(TPoll, [thr[TPoll] EXCEPT !.pc = "p2"])
  /\ UNCHANGED <<run, steps, execLive, okCount, hbLeft, crashes>>

Poller == P1 \/ P2 \/ P3 \/ P4 \/ P5 \/ P6 \/ P7 \/ P8 \/ P9 \/ P10 \/ PRel \/ Walk(TPoll)

----------------------------------------------------------------------------
(* Heartbeat recoverIncompleteRuns (recovery.ts)                          *)

Ready(done, edges) ==
  {n \in Nodes : /\ n \notin done
                 /\ \/ Preds(n) = {}
                    \/ LET ap == {p \in Preds(n) : <<p, n>> \in edges}
                       IN ap # {} /\ ap \subseteq done
                 \* F4: a node pending retry belongs to the retry poller.
                 /\ (FixRecoveryRetry => n \notin RetryNodes)}

\* H1 recovery.ts:63-68 — running run ids; activeWalks check.
H1 ==
  /\ thr[THb].pc = "hIdle"
  /\ hbLeft > 0
  /\ hbLeft' = hbLeft - 1
  /\ SetT(THb, [thr[THb] EXCEPT !.pc = IF run = "running" /\ ~(GuardActiveWalk /\ active > 0)
                                      THEN "h2" ELSE "h5"])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, crashes>>

\* H2 recovery.ts:69-85 — re-read run, completed steps, routing; findReadyNodes.
H2 ==
  /\ thr[THb].pc = "h2"
  /\ IF run # "running"
     THEN SetT(THb, [thr[THb] EXCEPT !.pc = "h5"])
     ELSE LET done == NodesWith("completed")
          IN SetT(THb, [thr[THb] EXCEPT !.pc = "h3", !.done = done,
                         !.pend = Ready(done, Edges(done))])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* H3 recovery.ts:87-106 — activeWalks re-check; complete or re-walk.
H3 ==
  /\ thr[THb].pc = "h3"
  /\ IF GuardActiveWalk /\ active > 0
     THEN SetT(THb, [thr[THb] EXCEPT !.pc = "h5"]) /\ UNCHANGED active
     ELSE IF thr[THb].pend = {} /\ FixRecoveryRetry /\ RetryNodes # {}
          THEN SetT(THb, [thr[THb] EXCEPT !.pc = "h5"]) /\ UNCHANGED active
     ELSE IF thr[THb].pend = {}
          THEN SetT(THb, [thr[THb] EXCEPT !.pc = "h4"]) /\ UNCHANGED active
          ELSE Call(THb, thr[THb].pend, "h5")
  /\ UNCHANGED <<run, steps, execLive, okCount, hbLeft, crashes>>

\* H4 recovery.ts:88-94 — run -> completed (blind write, no transaction).
\* F4: finalize in one transaction, only while the run is still running and
\* no step is live or pending retry.
H4 ==
  /\ thr[THb].pc = "h4"
  /\ run' = IF FixRecoveryRetry
            THEN IF run = "running" /\ ~\E i \in StepIds :
                      steps[i].st \in {"waiting", "running", "pending"} \/ PendingRetry(i)
                 THEN "completed" ELSE run
            ELSE "completed"
  /\ SetT(THb, [thr[THb] EXCEPT !.pc = "h5"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* H5 recovery.ts:121 getStuckWorkflowRuns — waiting steps whose task is terminal.
H5 ==
  /\ thr[THb].pc = "h5"
  /\ SetT(THb, [thr[THb] EXCEPT !.pc = "h6",
                 !.R = IF run = "waiting"
                       THEN {i \in StepIds : steps[i].st = "waiting" /\ steps[i].task \in {"ok", "fail"}}
                       ELSE {}])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* H6 recovery.ts:124-128 — next stuck row; getWorkflowRun must be waiting.
H6 ==
  /\ thr[THb].pc = "h6"
  /\ IF thr[THb].R = {}
     THEN SetT(THb, [thr[THb] EXCEPT !.pc = "hIdle"])
     ELSE \E i \in thr[THb].R :
            SetT(THb, [thr[THb] EXCEPT !.R = @ \ {i}, !.sid = i, !.cur = steps[i].node,
                        !.pc = IF run # "waiting" THEN "h6"
                               ELSE IF steps[i].task = "fail" THEN "h7" ELSE "h8"])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* H7 recovery.ts:138 -> task-step-routing.ts:24-45 failStepAndRunIfWaiting.
H7 ==
  /\ thr[THb].pc = "h7"
  /\ LET i == thr[THb].sid IN
     IF steps[i].st = "waiting"
     THEN steps' = [steps EXCEPT ![i].st = "failed"] /\ run' = "failed"
     ELSE UNCHANGED <<steps, run>>
  /\ SetT(THb, [thr[THb] EXCEPT !.pc = "h6"])
  /\ UNCHANGED <<active, execLive, okCount, hbLeft, crashes>>

\* H8 recovery.ts:155-179 — claim (completeTaskStepAndResolveSuccessors),
\* then always walkGraph(successors), even when empty.
H8 ==
  /\ thr[THb].pc = "h8"
  /\ LET i == thr[THb].sid
         n == thr[THb].cur IN
     IF steps[i].st = "waiting"
     THEN /\ steps' = [steps EXCEPT ![i].st = "completed"]
          /\ okCount' = [okCount EXCEPT ![n] = @ + 1]
          /\ run' = "running"
          /\ Call(THb, Succ(n), "h6")
     ELSE /\ SetT(THb, [thr[THb] EXCEPT !.pc = "h6"])
          /\ UNCHANGED <<steps, okCount, run, active>>
  /\ UNCHANGED <<execLive, hbLeft, crashes>>

Heartbeat == H1 \/ H2 \/ H3 \/ H4 \/ H5 \/ H6 \/ H7 \/ H8 \/ Walk(THb)

----------------------------------------------------------------------------
(* Agent tasks and the task-event handlers (resume.ts)                     *)

\* Task reaches a terminal state; its after-commit bus event is queued.
TaskFinish(i) ==
  /\ i \in StepIds
  /\ steps[i].task = "run"
  /\ \E r \in {"ok", "fail"} : steps' = [steps EXCEPT ![i].task = r]
  /\ SetT(Ev(i), [Idle EXCEPT !.pc = "e1", !.sid = i, !.cur = steps[i].node])
  /\ UNCHANGED <<run, active, execLive, okCount, hbLeft, crashes>>

\* E1 resume.ts:137-145 / 230-238 — pre-checks outside any transaction.
E1(t) ==
  /\ thr[t].pc = "e1"
  /\ LET i == thr[t].sid IN
     SetT(t, [thr[t] EXCEPT !.pc =
                IF run \notin {"waiting", "running"} \/ steps[i].st # "waiting" THEN "eDone"
                ELSE IF steps[i].task = "ok" THEN "e2" ELSE "eF"])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* E2 resume.ts:164-191 -> task-step-routing.ts:96-143 — claim transaction
\* (re-reads the STEP only), then walkGraph(successors) or finalizeOrWait.
E2(t) ==
  /\ thr[t].pc = "e2"
  /\ LET i == thr[t].sid
         n == thr[t].cur IN
     IF steps[i].st = "waiting"
     THEN /\ steps' = [steps EXCEPT ![i].st = "completed"]
          /\ okCount' = [okCount EXCEPT ![n] = @ + 1]
          /\ run' = "running"
          /\ IF Succ(n) # {}
             THEN Call(t, Succ(n), "eDone")
             ELSE SetT(t, [thr[t] EXCEPT !.pc = "eFin"]) /\ UNCHANGED active
     ELSE /\ SetT(t, [thr[t] EXCEPT !.pc = "eDone"])
          /\ UNCHANGED <<steps, okCount, run, active>>
  /\ UNCHANGED <<execLive, hbLeft, crashes>>

\* E3 resume.ts:201-218 finalizeOrWait — transaction, but no run-status guard.
EFin(t) ==
  /\ thr[t].pc = "eFin"
  /\ run' = IF \E j \in StepIds : steps[j].st = "waiting"
                 \/ (FixPendingRetryGate /\ steps[j].st \in {"running", "pending"})
            THEN "waiting" ELSE "completed"
  /\ SetT(t, [thr[t] EXCEPT !.pc = "eDone"])
  /\ UNCHANGED <<steps, active, execLive, okCount, hbLeft, crashes>>

\* E4 resume.ts:242-244 -> failStepAndRunIfWaiting (onNodeFailure "fail").
EF(t) ==
  /\ thr[t].pc = "eF"
  /\ LET i == thr[t].sid IN
     IF steps[i].st = "waiting"
     THEN steps' = [steps EXCEPT ![i].st = "failed"] /\ run' = "failed"
     ELSE UNCHANGED <<steps, run>>
  /\ SetT(t, [thr[t] EXCEPT !.pc = "eDone"])
  /\ UNCHANGED <<active, execLive, okCount, hbLeft, crashes>>

Event(t) == E1(t) \/ E2(t) \/ EFin(t) \/ EF(t) \/ Walk(t)

----------------------------------------------------------------------------
(* User actions (resume.ts)                                                *)

\* C1 resume.ts:370-418 cancelWorkflowRun — one transaction. Steps already
\* `failed` count as terminal and are skipped, nextRetryAt included.
Cancel ==
  /\ thr[TCancel].pc = "cIdle"
  /\ run # "none"
  /\ IF run \notin RunTerminal
     THEN /\ steps' = [i \in StepIds |->
                        IF steps[i].st \in StepTerminal THEN steps[i]
                        ELSE [steps[i] EXCEPT !.st = "cancelled",
                                              !.task = IF @ = "run" THEN "cancelled" ELSE @]]
          /\ run' = "cancelled"
     ELSE UNCHANGED <<steps, run>>
  /\ SetT(TCancel, [thr[TCancel] EXCEPT !.pc = "cDone"])
  /\ UNCHANGED <<active, execLive, okCount, hbLeft, crashes>>

\* U1 resume.ts:308-335 retryFailedRun — reads outside the transaction.
U1 ==
  /\ thr[TRetry].pc = "uIdle"
  /\ run = "failed"
  /\ \E i \in StepIds : steps[i].st = "failed"
  /\ LET fs == CHOOSE i \in StepIds : steps[i].st = "failed"
                        /\ \A j \in StepIds : j < i => steps[j].st # "failed"
         done == NodesWith("completed")
     IN SetT(TRetry, [thr[TRetry] EXCEPT !.pc = "u2", !.sid = fs, !.cur = steps[fs].node,
                       !.pend = {n \in Ready(done, Edges(done)) :
                                   FixUserRetryLive => n \notin NodesWith("running") \cup NodesWith("waiting")}
                                \cup {steps[fs].node}])
  /\ UNCHANGED <<run, steps, active, execLive, okCount, hbLeft, crashes>>

\* U2 resume.ts:341-363 — claim transaction, then walkGraph.
U2 ==
  /\ thr[TRetry].pc = "u2"
  /\ IF run = "failed" /\ ~(FixUserRetryLive /\ active > 0)
     THEN /\ steps' = [steps EXCEPT ![thr[TRetry].sid].st = "pending"]
          /\ run' = "running"
          /\ Call(TRetry, thr[TRetry].pend, "uDone")
     ELSE /\ SetT(TRetry, [thr[TRetry] EXCEPT !.pc = "uDone"])
          /\ UNCHANGED <<steps, run, active>>
  /\ UNCHANGED <<execLive, okCount, hbLeft, crashes>>

User == Cancel \/ U1 \/ U2 \/ Walk(TRetry)

----------------------------------------------------------------------------
(* Process crash: in-memory state is lost (activeWalks, executor calls,    *)
(* undelivered bus events). Boot runs recovery once and restarts the poller.*)
Crash ==
  /\ crashes > 0
  /\ crashes' = crashes - 1
  /\ thr' = [t \in Threads |->
               IF t = TPoll THEN [Idle EXCEPT !.pc = "pIdle"]
               ELSE IF t = THb THEN [Idle EXCEPT !.pc = "hIdle"]
               ELSE IF t = TCancel THEN [Idle EXCEPT !.pc = IF thr[t].pc = "cIdle" THEN "cIdle" ELSE "cDone"]
               ELSE IF t = TRetry THEN [Idle EXCEPT !.pc = IF thr[t].pc = "uIdle" THEN "uIdle" ELSE "uDone"]
               ELSE [Idle EXCEPT !.pc = "dead"]]
  /\ active' = 0
  /\ execLive' = [n \in Nodes |-> 0]
  /\ hbLeft' = hbLeft + 1
  /\ UNCHANGED <<run, steps, okCount>>

Next ==
  \/ IStart \/ IWalk \/ Walk(TInit)
  \/ Poller
  \/ Heartbeat
  \/ \E i \in 1..MaxSteps : TaskFinish(i)
  \/ \E i \in 1..MaxSteps : Event(Ev(i))
  \/ User
  \/ Crash

Spec == Init /\ [][Next]_vars

StateBound == Len(steps) <= MaxSteps

----------------------------------------------------------------------------
(* Invariants (design doc section 5)                                       *)

\* Inv1: a terminal run never gains a running/pending step, and completed /
\* cancelled runs never change status.
TerminalRunStaysQuiet ==
  [][ /\ (run \in {"completed", "cancelled"} => run' = run)
      /\ (run \in RunTerminal /\ run' \in RunTerminal =>
            \A i \in DOMAIN steps' :
              steps'[i].st \in {"running", "pending"} =>
                (i \in StepIds /\ steps[i].st = steps'[i].st)) ]_vars

\* Inv2: at most one live execution per node (non-loop graph: iteration 0).
AtMostOneExecuting ==
  \A n \in Nodes :
    execLive[n] + Cardinality({i \in StepIds : steps[i].node = n /\ steps[i].task = "run"}) <= 1

\* Inv3: every node (in particular the convergence node) completes at most once.
ExecutesOnce == \A n \in Nodes : okCount[n] <= 1

\* Inv4: a completed run has no non-terminal step (bf12ab53).
CompletedRunQuiescent ==
  run = "completed" =>
    \A i \in StepIds : steps[i].st \in {"completed", "cancelled"}
                       \/ (steps[i].st = "failed" /\ ~steps[i].nra)

\* Inv3b: the convergence node is only created once every branch completed
\* (every branch is always reached in this graph).
JoinWaitsForAll ==
  [][ Len(steps') > Len(steps) /\ steps'[Len(steps')].node = "M"
        => Branches \subseteq NodesWith("completed") ]_vars

\* Inv5 (liveness): the run eventually leaves running/waiting.
EventuallySettles == <>[](run \in RunTerminal)
=============================================================================
