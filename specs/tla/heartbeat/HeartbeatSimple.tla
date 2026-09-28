------------------------- MODULE HeartbeatSimple -------------------------
(***************************************************************************)
(* The heartbeat as implemented (Reclaim + Unpin). ACTIONS.md maps each    *)
(* action to code and lists where the code deviates from this model.     *)
(*                                                                         *)
(* One idea replaces supersede + resume child + backfill + reaper + reboot *)
(* sweep + pool auto-assign: a stalled task is re-queued IN PLACE by one   *)
(* compare-and-swap, and every worker write is fenced: it lands only while *)
(* the row is in_progress on the runtime that started the current attempt *)
(* (`attemptRuntimeId`). A stale worker's writes then fail and it aborts.  *)
(*                                                                         *)
(*   Reclaim:  UPDATE agent_tasks SET status='pending', attempt=attempt+1  *)
(*             WHERE id=? AND status='in_progress' AND attempt=?           *)
(*               AND lastUpdatedAt < :cutoff                               *)
(*               AND NOT EXISTS (fresh active_sessions row)                *)
(*             (+ DELETE active_sessions row, same transaction)            *)
(*             attempt + 1 > MaxGen  ->  status='failed' instead,          *)
(*             attempt unchanged                                           *)
(*   Unpin:    UPDATE ... SET status='unassigned' WHERE status='pending'   *)
(*               AND attempt=? AND lastUpdatedAt < :pinGrace               *)
(*   Start:    ... SET status='in_progress', attemptRuntimeId=:runtime     *)
(*   Worker writes (progress/complete/defer/finish), same transaction:     *)
(*             reject unless status='in_progress' AND agentId=:agent       *)
(*               AND attemptRuntimeId=:runtime                             *)
(* A Worker here is one runtime (worker process); `own` is the runtime     *)
(* that started the current attempt, i.e. `attemptRuntimeId`.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, NTasks, MaxVer, MaxGen, MaxWorkerCrashes, MaxApiCrashes,
    GoneWorkers,  \* workers that never come back after a crash
    FENCE,        \* ablation: worker writes check the attempt's runtime (TRUE = code)
    UNPIN,        \* ablation: expired pins return to the pool (TRUE = code)
    RECLAIM_CAS,  \* ablation: Reclaim re-checks staleness in its WHERE
    UNPIN_OFFERED \* Unpin also returns stale offers (FALSE = code: offers keep
                  \* the offline-offeree release, modeled here by Reject)

None == "none"
Tasks == 1..NTasks
Terminal == {"completed", "failed", "cancelled"}
Active   == {"unassigned", "offered", "pending", "in_progress"}

VARIABLES
    st, own, offTo,
    att,      \* agent_tasks.attempt (fencing token; replaces resume-generation)
    ver, stale, sess,
    running,  \* worker-local: set of <<task, attempt>> being executed
    alive, cl, acc, apiUp, wc, ac, liveKill, badAcc,
    zw        \* history: a stale attempt wrote the row

vars == <<st, own, offTo, att, ver, stale, sess, running, alive, cl, acc,
          apiUp, wc, ac, liveKill, badAcc, zw>>

Runs(t) == {w \in Workers : \E g \in 0..MaxGen : <<t, g>> \in running[w]}
Current(w, t) == <<t, att[t]>> \in running[w]
LiveNow(t) == own[t] # None /\ alive[own[t]] /\ Current(own[t], t) /\ ~stale[t]
Busy(w) == running[w] # {}

Init ==
    /\ st \in {[t \in Tasks |-> x] : x \in {"unassigned", "offered"}}
    /\ own = [t \in Tasks |-> None]
    /\ offTo \in {[t \in Tasks |-> IF st[t] = "offered" THEN w ELSE None] : w \in Workers}
    /\ att = [t \in Tasks |-> 0]
    /\ ver = [t \in Tasks |-> 0]
    /\ stale = [t \in Tasks |-> FALSE]
    /\ sess = [t \in Tasks |-> "none"]
    /\ running = [w \in Workers |-> {}]
    /\ alive = [w \in Workers |-> TRUE]
    /\ cl = [w \in Workers |-> 0]
    /\ acc = [w \in Workers |-> 0]
    /\ apiUp = TRUE /\ wc = 0 /\ ac = 0
    /\ liveKill = FALSE /\ badAcc = FALSE /\ zw = FALSE

\* A runtime handed a task it still runs (reclaimed while unresponsive) keeps
\* that process and does not start a second one (runner `activeTasks`
\* keep-branch): the running copy becomes the current attempt.
Start(w, t) ==
    /\ st' = [st EXCEPT ![t] = "in_progress"]
    /\ own' = [own EXCEPT ![t] = w]
    /\ running' = [running EXCEPT ![w] = {r \in @ : r[1] # t} \cup {<<t, att[t]>>}]
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ stale' = [stale EXCEPT ![t] = FALSE]

---------------------------------------------------------------------------
(* Worker side: unchanged except for the attempt fence.                   *)

\* Free for t: idle, or its only work is an earlier copy of t (the reclaimed
\* row's capacity slot is free once it is back to pending/unassigned).
FreeFor(w, t) == \A r \in running[w] : r[1] = t

ClaimRead(w, t) ==
    /\ apiUp /\ alive[w] /\ cl[w] = 0 /\ FreeFor(w, t) /\ st[t] = "unassigned"
    /\ cl' = [cl EXCEPT ![w] = t]
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, running, alive, acc,
                   apiUp, wc, ac, liveKill, badAcc, zw>>

ClaimWrite(w) ==
    LET t == cl[w] IN
    /\ apiUp /\ alive[w] /\ t # 0
    /\ cl' = [cl EXCEPT ![w] = 0]
    /\ IF st[t] = "unassigned" THEN Start(w, t)
                               ELSE UNCHANGED <<st, own, running, sess, stale>>
    /\ UNCHANGED <<offTo, att, ver, alive, acc, apiUp, wc, ac, liveKill, badAcc, zw>>

AcceptRead(w, t) ==
    /\ apiUp /\ alive[w] /\ acc[w] = 0 /\ st[t] = "offered" /\ offTo[t] = w
    /\ acc' = [acc EXCEPT ![w] = t]
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, running, alive, cl,
                   apiUp, wc, ac, liveKill, badAcc, zw>>

\* offeredTo moved into the SQL guard.
AcceptWrite(w) ==
    LET t == acc[w] IN
    /\ apiUp /\ alive[w] /\ t # 0
    /\ acc' = [acc EXCEPT ![w] = 0]
    /\ IF st[t] = "offered" /\ offTo[t] = w
         THEN /\ st' = [st EXCEPT ![t] = "pending"]
              /\ own' = [own EXCEPT ![t] = w]
         ELSE UNCHANGED <<st, own>>
    /\ UNCHANGED <<offTo, att, ver, stale, sess, running, alive, cl, apiUp, wc, ac,
                   liveKill, badAcc, zw>>

Reject(t) ==
    /\ apiUp /\ st[t] = "offered"
    /\ st' = [st EXCEPT ![t] = "unassigned"]
    /\ offTo' = [offTo EXCEPT ![t] = None]
    /\ UNCHANGED <<own, att, ver, stale, sess, running, alive, cl, acc, apiUp, wc,
                   ac, liveKill, badAcc, zw>>

PollStart(w, t) ==
    /\ apiUp /\ alive[w] /\ FreeFor(w, t) /\ st[t] = "pending" /\ own[t] = w
    /\ Start(w, t)
    /\ UNCHANGED <<offTo, att, ver, alive, cl, acc, apiUp, wc, ac, liveKill, badAcc, zw>>

RegisterSession(w, t) ==
    /\ apiUp /\ alive[w] /\ Current(w, t) /\ st[t] = "in_progress" /\ sess[t] = "none"
    /\ sess' = [sess EXCEPT ![t] = "live"]
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, running, alive, cl, acc, apiUp,
                   wc, ac, liveKill, badAcc, zw>>

\* The code does not know which attempt a process holds, only which runtime
\* sent the write. NoZombieWrite checks that this runtime fence still keeps
\* every stale attempt out.
Holds(w, t) == \E g \in 0..MaxGen : <<t, g>> \in running[w]
Fenced(w, t) ==
    IF FENCE THEN Holds(w, t) /\ st[t] = "in_progress" /\ own[t] = w
             ELSE Holds(w, t) /\ st[t] \notin Terminal

\* Fenced: status='in_progress' AND agentId=:agent AND attemptRuntimeId=:runtime
Progress(w, t) ==
    /\ apiUp /\ alive[w] /\ Fenced(w, t)
    /\ ver[t] < MaxVer
    /\ ver' = [ver EXCEPT ![t] = @ + 1]
    /\ stale' = [stale EXCEPT ![t] = FALSE]
    /\ sess' = [sess EXCEPT ![t] = "live"]
    /\ zw' = (zw \/ ~Current(w, t))
    /\ UNCHANGED <<st, own, offTo, att, running, alive, cl, acc, apiUp, wc, ac,
                   liveKill, badAcc>>

Complete(w, t) ==
    /\ apiUp /\ alive[w] /\ Fenced(w, t)
    /\ st' = [st EXCEPT ![t] = "completed"]
    /\ running' = [running EXCEPT ![w] = {r \in @ : r[1] # t}]
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ zw' = (zw \/ ~Current(w, t))
    /\ UNCHANGED <<own, offTo, att, ver, stale, alive, cl, acc, apiUp, wc, ac,
                   liveKill, badAcc>>

\* Any fenced write that matches 0 rows tells the worker to stop.
AbortStale(w, t, g) ==
    /\ apiUp /\ alive[w] /\ <<t, g>> \in running[w]
    /\ IF FENCE THEN (st[t] # "in_progress" \/ own[t] # w)
                ELSE st[t] \in Terminal
    /\ running' = [running EXCEPT ![w] = @ \ {<<t, g>>}]
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, alive, cl, acc, apiUp,
                   wc, ac, liveKill, badAcc, zw>>

WorkerCrash(w) ==
    /\ alive[w] /\ wc < MaxWorkerCrashes
    /\ alive' = [alive EXCEPT ![w] = FALSE]
    /\ sess' = [t \in Tasks |-> IF w \in Runs(t) /\ sess[t] = "live" THEN "dead" ELSE sess[t]]
    /\ running' = [running EXCEPT ![w] = {}]
    /\ cl' = [cl EXCEPT ![w] = 0]
    /\ acc' = [acc EXCEPT ![w] = 0]
    /\ wc' = wc + 1
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, apiUp, ac, liveKill, badAcc, zw>>

WorkerRestart(w) ==
    /\ ~alive[w] /\ w \notin GoneWorkers
    /\ alive' = [alive EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, running, cl, acc, apiUp,
                   wc, ac, liveKill, badAcc, zw>>

Age(t) ==
    /\ st[t] \in {"in_progress", "pending", "offered"} /\ ~stale[t]
    /\ stale' = [stale EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<st, own, offTo, att, ver, sess, running, alive, cl, acc, apiUp,
                   wc, ac, liveKill, badAcc, zw>>

\* The API crashing no longer needs a sweep: nothing is half-written.
ApiCrash ==
    /\ apiUp /\ ac < MaxApiCrashes
    /\ apiUp' = FALSE
    /\ cl' = [w \in Workers |-> 0]
    /\ acc' = [w \in Workers |-> 0]
    /\ ac' = ac + 1
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, running, alive, wc,
                   liveKill, badAcc, zw>>

ApiBoot ==
    /\ ~apiUp /\ apiUp' = TRUE
    /\ UNCHANGED <<st, own, offTo, att, ver, stale, sess, running, alive, cl, acc,
                   wc, ac, liveKill, badAcc, zw>>

---------------------------------------------------------------------------
(* Heartbeat: two single-statement CAS actions.                           *)

\* RECLAIM_CAS = FALSE models the current read-then-write shape: the
\* classifier saw a stale row earlier, the write no longer re-checks it.
Reclaim(t) ==
    /\ apiUp /\ st[t] = "in_progress" /\ (RECLAIM_CAS => (stale[t] /\ sess[t] # "live"))
    /\ liveKill' = (liveKill \/ LiveNow(t))
    /\ st' = [st EXCEPT ![t] = IF att[t] + 1 > MaxGen THEN "failed" ELSE "pending"]
    /\ att' = [att EXCEPT ![t] = IF att[t] + 1 > MaxGen THEN @ ELSE @ + 1]
    /\ stale' = [stale EXCEPT ![t] = FALSE]
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ UNCHANGED <<own, offTo, ver, running, alive, cl, acc, apiUp, wc, ac, badAcc, zw>>

\* A pin or offer nobody picked up goes back to the (affinity-gated) pool.
\* Time-based, so it also covers a hard-crashed worker that never goes offline.
Unpin(t) ==
    /\ UNPIN /\ apiUp /\ stale[t]
    /\ \/ st[t] = "pending" /\ own[t] # None
       \/ UNPIN_OFFERED /\ st[t] = "offered"
    /\ st' = [st EXCEPT ![t] = "unassigned"]
    /\ own' = [own EXCEPT ![t] = None]
    /\ offTo' = [offTo EXCEPT ![t] = None]
    /\ stale' = [stale EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<att, ver, sess, running, alive, cl, acc, apiUp, wc, ac,
                   liveKill, badAcc, zw>>

---------------------------------------------------------------------------
Next ==
    \/ \E w \in Workers, t \in Tasks :
         ClaimRead(w, t) \/ AcceptRead(w, t) \/ PollStart(w, t) \/ RegisterSession(w, t)
         \/ Progress(w, t) \/ Complete(w, t)
         \/ \E g \in 0..MaxGen : AbortStale(w, t, g)
    \/ \E w \in Workers : ClaimWrite(w) \/ AcceptWrite(w) \/ WorkerCrash(w) \/ WorkerRestart(w)
    \/ \E t \in Tasks : Reject(t) \/ Age(t) \/ Reclaim(t) \/ Unpin(t)
    \/ ApiCrash \/ ApiBoot

Fairness ==
    /\ \A w \in Workers :
         /\ WF_vars(ClaimWrite(w)) /\ WF_vars(AcceptWrite(w)) /\ WF_vars(WorkerRestart(w))
         /\ \A t \in Tasks :
              /\ WF_vars(PollStart(w, t)) /\ WF_vars(Complete(w, t))
              /\ WF_vars(RegisterSession(w, t)) /\ WF_vars(ClaimRead(w, t))
              /\ WF_vars(AcceptRead(w, t))
              /\ \A g \in 0..MaxGen : WF_vars(AbortStale(w, t, g))
    /\ \A t \in Tasks : WF_vars(Age(t)) /\ WF_vars(Reclaim(t)) /\ WF_vars(Unpin(t))
    /\ WF_vars(ApiBoot)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
TypeOK == st \in [Tasks -> Terminal \cup Active] /\ att \in [Tasks -> 0..MaxGen]

\* S1': at most one worker executes the CURRENT attempt of a task.
OneRunner == \A t \in Tasks : Cardinality({w \in Workers : Current(w, t)}) <= 1
\* S1'': a stale attempt never writes the row (fence).
NoZombieWrite == ~zw
\* L2: a stale-attempt runner eventually stops.
ZombiesStop == \A w \in Workers, t \in Tasks, g \in 0..MaxGen :
    (<<t, g>> \in running[w] /\ g # att[t]) ~> (<<t, g>> \notin running[w])
OneActive == TRUE   \* one row per unit of work by construction
NoLiveKill == ~liveKill
SupersededHasResume == TRUE  \* no supersede state exists
AcceptOwnOffer == ~badAcc
TerminalAbsorbing == [][\A t \in Tasks : st[t] \in Terminal => st'[t] = st[t]]_vars

Finished == \A t \in Tasks : st[t] \in {"completed", "failed"}
EventuallyFinished == <>Finished
SupersededGetsResume == TRUE
=============================================================================
