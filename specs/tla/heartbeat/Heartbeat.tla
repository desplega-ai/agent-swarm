---------------------------- MODULE Heartbeat ----------------------------
(***************************************************************************)
(* Server-side heartbeat + the task lifecycle it races with, as the code   *)
(* behaves on main @ eaf5d0cc. Every action maps to file:line and the SQL  *)
(* guard it models in ACTIONS.md. Time is abstracted: `stale[t]` means     *)
(* "lastUpdatedAt older than the stall threshold", and `Age` sets it.     *)
(*                                                                         *)
(* Guard flags let CALIBRATION.md remove historical fixes (G_ flags) and  *)
(* the bug hunt switch on proposed fixes (FIX_ flags).                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Workers,          \* worker agents (model values)
    NTasks,           \* task slots; slot 1 is the root, others are children
    MaxVer,           \* bound on progress writes per task
    MaxGen,           \* MAX_RESUME_GENERATIONS (scaled down)
    MaxWorkerCrashes, \* bound on worker SIGKILLs
    MaxApiCrashes,    \* bound on API process crashes
    G_CLAIM_STATUS,   \* claimTask:  WHERE status = 'unassigned'
    G_TERMINAL_CAS,   \* supersede/fail/complete: WHERE status NOT IN terminal
    G_REBOOT_TOUCHED, \* runRebootSweep: skip tasks claimed after boot
    G_STALL_CAS,      \* supersede/fail also WHERE lastUpdatedAt = observed (#1668)
    G_REBOOT_HB_AGE,  \* runRebootSweep: skip sessions younger than 15 min (#1669)
    G_ORPHAN_REPAIR,  \* sweep re-creates a missing resume (#1670)
    FIX_NO_REBOOT,    \* proposed: delete runRebootSweep, rely on the classifier
    DRAIN_HANDOFF,    \* API drain handoff (#1837), opt-in via API_DRAIN_MAX_MS > 0
    HYPO_REOFFER      \* hypothetical path that re-offers an unassigned task

None == "none"
Tasks == 1..NTasks
Terminal == {"completed", "failed", "cancelled", "superseded"}
Active   == {"unassigned", "offered", "pending", "in_progress"}
Status   == Terminal \cup Active \cup {"free"}

VARIABLES
    st,       \* agent_tasks.status ("free" = slot not yet created)
    own,      \* agent_tasks.agentId
    offTo,    \* agent_tasks.offeredTo
    par,      \* agent_tasks.parentTaskId (resume / retry / reroute child)
    gen,      \* resume-generation tag
    pin,      \* crash-recovery-pin / reboot-retry-pin tag
    ver,      \* lastUpdatedAt as a version counter (progress bumps it)
    stale,    \* lastUpdatedAt older than threshold
    sess,     \* active_sessions row: "none" | "live" | "prelive" (last heartbeat
              \* before this API boot, worker still alive) | "dead" (worker gone)
    touched,  \* lastUpdatedAt >= bootEpoch (written since the API booted)
    running,  \* worker-local: tasks the worker process is executing
    alive,    \* worker process up
    cl,       \* worker-local in-flight claim (read done, write pending)
    acc,      \* worker-local in-flight accept (JS offeredTo check done)
    hb,       \* stall classifier program counter
    rb,       \* reboot sweep state
    apiUp,    \* API process up
    wc, ac,   \* crash counters
    liveKill, \* history: a remediation killed a live, progressing task
    badAcc    \* history: an accept took a task offered to someone else

vars == <<st, own, offTo, par, gen, pin, ver, stale, sess, touched, running,
          alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

Free == {s \in Tasks : st[s] = "free"}

\* The owner is alive, executing t, and t has fresh progress.
LiveNow(t) == own[t] # None /\ alive[own[t]] /\ t \in running[own[t]] /\ ~stale[t]

HasActiveChild(t) == \E s \in Tasks : par[s] = t /\ st[s] \in Active

\* Create child slot s of parent p (createTaskExtended). Pinned => pending.
NewChild(s, p, o, g, isPin) ==
    /\ st'  = [st  EXCEPT ![s] = IF o # None THEN "pending" ELSE "unassigned"]
    /\ own' = [own EXCEPT ![s] = o]
    /\ par' = [par EXCEPT ![s] = p]
    /\ gen' = [gen EXCEPT ![s] = g]
    /\ pin' = [pin EXCEPT ![s] = isPin]

---------------------------------------------------------------------------
Init ==
    /\ st \in {[t \in Tasks |-> IF t = 1 THEN x ELSE "free"] : x \in {"unassigned", "offered"}}
    /\ own = [t \in Tasks |-> None]
    /\ offTo \in {[t \in Tasks |-> IF t = 1 /\ st[1] = "offered" THEN w ELSE None] : w \in Workers}
    /\ par = [t \in Tasks |-> 0]
    /\ gen = [t \in Tasks |-> 0]
    /\ pin = [t \in Tasks |-> FALSE]
    /\ ver = [t \in Tasks |-> 0]
    /\ stale = [t \in Tasks |-> FALSE]
    /\ sess = [t \in Tasks |-> "none"]
    /\ touched = [t \in Tasks |-> FALSE]
    /\ running = [w \in Workers |-> {}]
    /\ alive = [w \in Workers |-> TRUE]
    /\ cl = [w \in Workers |-> 0]
    /\ acc = [w \in Workers |-> 0]
    /\ hb = [pc |-> "idle", t |-> 0, snap |-> 0, act |-> "none"]
    /\ rb = [todo |-> {}, pc |-> "idle", t |-> 0]
    /\ apiUp = TRUE
    /\ wc = 0 /\ ac = 0
    /\ liveKill = FALSE /\ badAcc = FALSE

---------------------------------------------------------------------------
(* Worker-driven lifecycle (via HTTP: every step needs the API up).       *)

\* poll.ts auto-claim -> claimTask: read the pool ...
ClaimRead(w, t) ==
    /\ apiUp /\ alive[w] /\ cl[w] = 0 /\ running[w] = {}
    /\ st[t] = "unassigned"
    /\ cl' = [cl EXCEPT ![w] = t]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   running, alive, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* ... then UPDATE ... WHERE id = ? AND status = 'unassigned'
ClaimWrite(w) ==
    LET t == cl[w] IN
    /\ apiUp /\ alive[w] /\ t # 0
    /\ cl' = [cl EXCEPT ![w] = 0]
    /\ IF ~G_CLAIM_STATUS \/ st[t] = "unassigned"
         THEN /\ st' = [st EXCEPT ![t] = "in_progress"]
              /\ own' = [own EXCEPT ![t] = w]
              /\ running' = [running EXCEPT ![w] = @ \cup {t}]
              /\ sess' = [sess EXCEPT ![t] = "none"]
              /\ stale' = [stale EXCEPT ![t] = FALSE]
              /\ touched' = [touched EXCEPT ![t] = TRUE]
         ELSE UNCHANGED <<st, own, running, sess, stale, touched>>
    /\ UNCHANGED <<offTo, par, gen, pin, ver, alive, acc, hb, rb, apiUp, wc, ac,
                   liveKill, badAcc>>

\* acceptTask: JS check offeredTo = me ...
AcceptRead(w, t) ==
    /\ apiUp /\ alive[w] /\ acc[w] = 0
    /\ st[t] = "offered" /\ offTo[t] = w
    /\ acc' = [acc EXCEPT ![w] = t]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   running, alive, cl, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* ... then UPDATE SET agentId=?, status='pending' WHERE status IN ('offered','reviewing')
AcceptWrite(w) ==
    LET t == acc[w] IN
    /\ apiUp /\ alive[w] /\ t # 0
    /\ acc' = [acc EXCEPT ![w] = 0]
    /\ IF st[t] = "offered"
         THEN /\ st' = [st EXCEPT ![t] = "pending"]
              /\ own' = [own EXCEPT ![t] = w]
              /\ badAcc' = (badAcc \/ offTo[t] # w)
         ELSE UNCHANGED <<st, own, badAcc>>
    /\ UNCHANGED <<offTo, par, gen, pin, ver, stale, sess, touched, running,
                   alive, cl, hb, rb, apiUp, wc, ac, liveKill>>

\* rejectTask, and releaseStaleOfferedTasksForOfflineAgents (same write).
Reject(t) ==
    /\ apiUp /\ st[t] = "offered"
    /\ st' = [st EXCEPT ![t] = "unassigned"]
    /\ offTo' = [offTo EXCEPT ![t] = None]
    /\ UNCHANGED <<own, par, gen, pin, ver, stale, sess, touched, running, alive,
                   cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* No such path exists in the code; switched on only to show the drift.
ReOffer(t, w) ==
    /\ HYPO_REOFFER /\ apiUp /\ st[t] = "unassigned"
    /\ st' = [st EXCEPT ![t] = "offered"]
    /\ offTo' = [offTo EXCEPT ![t] = w]
    /\ UNCHANGED <<own, par, gen, pin, ver, stale, sess, touched, running, alive,
                   cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* poll.ts: pre-assigned pending -> in_progress (startTask, WHERE status='pending')
PollStart(w, t) ==
    /\ apiUp /\ alive[w] /\ running[w] = {}
    /\ st[t] = "pending" /\ own[t] = w
    /\ st' = [st EXCEPT ![t] = "in_progress"]
    /\ running' = [running EXCEPT ![w] = @ \cup {t}]
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ stale' = [stale EXCEPT ![t] = FALSE]
    /\ touched' = [touched EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<own, offTo, par, gen, pin, ver, alive, cl, acc, hb, rb, apiUp,
                   wc, ac, liveKill, badAcc>>

\* runner.ts POST /api/active-sessions (before provider spawn)
RegisterSession(w, t) ==
    /\ apiUp /\ alive[w] /\ t \in running[w] /\ sess[t] = "none"
    /\ st[t] \notin Terminal
    /\ sess' = [sess EXCEPT ![t] = "live"]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, touched, running,
                   alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* PostToolUse hook -> PUT /api/active-sessions/heartbeat (tool activity only)
SessionBeat(w, t) ==
    /\ apiUp /\ alive[w] /\ t \in running[w] /\ sess[t] = "prelive"
    /\ sess' = [sess EXCEPT ![t] = "live"]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, touched, running,
                   alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* updateTaskProgress: no status guard; bumps lastUpdatedAt unconditionally.
Progress(w, t) ==
    /\ apiUp /\ alive[w] /\ t \in running[w] /\ ver[t] < MaxVer
    /\ ver' = [ver EXCEPT ![t] = @ + 1]
    /\ stale' = [stale EXCEPT ![t] = FALSE]
    /\ touched' = [touched EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, sess, running, alive, cl, acc,
                   hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* completeTask: WHERE status NOT IN terminal; worker then drops the session.
Complete(w, t) ==
    /\ apiUp /\ alive[w] /\ t \in running[w]
    /\ st' = [st EXCEPT ![t] = IF ~G_TERMINAL_CAS \/ @ \notin Terminal THEN "completed" ELSE @]
    /\ running' = [running EXCEPT ![w] = @ \ {t}]
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ UNCHANGED <<own, offTo, par, gen, pin, ver, stale, touched, alive, cl, acc,
                   hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* The runner aborts any task the server holds as terminal (#1820,
\* reconcileActiveTasks, runner.ts:4872): cancelled on every poll via
\* /cancelled-tasks (core.ts:553), failed/superseded on a 30 s status read.
\* The 30 s interval and the 10 s abort grace are abstracted away.
AbortTerminal(w, t) ==
    /\ apiUp /\ alive[w] /\ t \in running[w] /\ st[t] \in Terminal
    /\ running' = [running EXCEPT ![w] = @ \ {t}]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* API drain handoff (#1837): a worker that sees X-Swarm-Draining on /ping or
\* /api/poll calls POST /api/tasks/:id/supersede for its own in-flight task
\* (handOffTasksForApiDrain). The API runs supersedeTask (WHERE status NOT IN
\* terminal, no stall CAS) and then createResumeFollowUp(graceful_shutdown),
\* pinned to the same agent. The two writes are collapsed into one step: a
\* hard crash between them is the HbWrite/HbResume gap, which HbRepair closes.
\* The runner then aborts the session (AbortTerminal frees the slot). Enabled
\* whenever the API is up, not only while draining (over-approximation); the
\* drain's refusal to dispatch only removes behaviors and is not modeled.
DrainHandoff(w, t) ==
    /\ DRAIN_HANDOFF /\ apiUp /\ alive[w] /\ t \in running[w]
    /\ st[t] = "in_progress" /\ own[t] = w
    /\ \E s \in Free :
         /\ st'  = [st  EXCEPT ![t] = "superseded", ![s] = "pending"]
         /\ own' = [own EXCEPT ![s] = w]
         /\ par' = [par EXCEPT ![s] = t]
         /\ gen' = [gen EXCEPT ![s] = gen[t] + 1]
         /\ pin' = [pin EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<offTo, ver, stale, sess, touched, running, alive, cl, acc, hb, rb,
                   apiUp, wc, ac, liveKill, badAcc>>

WorkerCrash(w) ==
    /\ alive[w] /\ wc < MaxWorkerCrashes
    /\ alive' = [alive EXCEPT ![w] = FALSE]
    /\ sess' = [t \in Tasks |-> IF t \in running[w] /\ sess[t] \in {"live", "prelive"} THEN "dead" ELSE sess[t]]
    /\ running' = [running EXCEPT ![w] = {}]
    /\ cl' = [cl EXCEPT ![w] = 0]
    /\ acc' = [acc EXCEPT ![w] = 0]
    /\ wc' = wc + 1
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, touched, hb, rb,
                   apiUp, ac, liveKill, badAcc>>

WorkerRestart(w) ==
    /\ ~alive[w]
    /\ alive' = [alive EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   running, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* Time passes without a lastUpdatedAt write.
Age(t) ==
    /\ st[t] = "in_progress" /\ ~stale[t]
    /\ stale' = [stale EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, sess, touched, running,
                   alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

---------------------------------------------------------------------------
(* Heartbeat sweep (API process).                                         *)

\* detectAndRemediateStalledTasks: candidate read + classify + decide.
\* Case C (live session) only records, so it never enters this action.
HbRead(t) ==
    /\ apiUp /\ hb.pc = "idle"
    /\ st[t] = "in_progress" /\ stale[t] /\ own[t] # None
    /\ sess[t] \in {"none", "dead"}
    /\ LET resume == ~HasActiveChild(t) /\ gen[t] < MaxGen /\ Free # {}
       IN hb' = [pc |-> "decided", t |-> t, snap |-> ver[t],
                 act |-> IF resume THEN "supersede" ELSE "fail"]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   running, alive, cl, acc, rb, apiUp, wc, ac, liveKill, badAcc>>

\* supersedeTask / failTask: WHERE id = ? AND status NOT IN terminal
\* AND lastUpdatedAt = <observed> (expectedLastUpdatedAt, #1668).
HbWrite ==
    LET t == hb.t IN
    /\ apiUp /\ hb.pc = "decided"
    /\ IF (~G_TERMINAL_CAS \/ st[t] \notin Terminal) /\ (G_STALL_CAS => ver[t] = hb.snap)
         THEN /\ st' = [st EXCEPT ![t] = IF hb.act = "fail" THEN "failed" ELSE "superseded"]
              /\ liveKill' = (liveKill \/ LiveNow(t))
              /\ sess' = [sess EXCEPT ![t] = IF @ = "dead" THEN "none" ELSE @]
              /\ hb' = [hb EXCEPT !.pc = IF hb.act = "supersede" THEN "resume" ELSE "idle"]
         ELSE /\ hb' = [hb EXCEPT !.pc = "idle"]
              /\ UNCHANGED <<st, liveKill, sess>>
    /\ UNCHANGED <<own, offTo, par, gen, pin, ver, stale, touched, running, alive,
                   cl, acc, rb, apiUp, wc, ac, badAcc>>

\* createResumeFollowUp(crash_recovery): pinned to the original agent
\* (a hard crash never marks it offline), separate write, no transaction.
HbResume ==
    LET t == hb.t IN
    /\ apiUp /\ hb.pc = "resume"
    /\ \E s \in Free : NewChild(s, t, own[t], gen[t] + 1, TRUE)
    /\ hb' = [hb EXCEPT !.pc = "idle"]
    /\ UNCHANGED <<offTo, ver, stale, sess, touched, running, alive, cl, acc, rb,
                   apiUp, wc, ac, liveKill, badAcc>>

\* repairSupersededWithoutResume (#1670), step 1.5 of the sweep: a superseded
\* parent with no resume child gets one, within the resume budget. The 1 min
\* floor keeps it off an in-flight supersede (hb.pc = "idle"); the 24 h cap is
\* not modeled (the sweep runs well inside it).
HbRepair(t) ==
    /\ G_ORPHAN_REPAIR /\ apiUp /\ hb.pc = "idle"
    /\ st[t] = "superseded" /\ gen[t] < MaxGen
    /\ ~\E s \in Tasks : par[s] = t
    /\ \E s \in Free : NewChild(s, t, own[t], gen[t] + 1, TRUE)
    /\ UNCHANGED <<offTo, ver, stale, sess, touched, running, alive, cl, acc, hb, rb,
                   apiUp, wc, ac, liveKill, badAcc>>

\* autoAssignPoolTasks: UPDATE SET agentId=?, status='pending' WHERE status='unassigned' (tx)
AutoAssign(t, w) ==
    /\ apiUp /\ alive[w] /\ running[w] = {} /\ st[t] = "unassigned"
    /\ st' = [st EXCEPT ![t] = "pending"]
    /\ own' = [own EXCEPT ![t] = w]
    /\ UNCHANGED <<offTo, par, gen, pin, ver, stale, sess, touched, running, alive,
                   cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

\* escalateUnreclaimedResumes: tx { cancel pending pin; Lead reroute ->
\* re-delegated to an explicit agent }. Over budget: fail the pin instead.
Reaper(s) ==
    /\ apiUp /\ st[s] = "pending" /\ pin[s]
    /\ IF gen[s] >= MaxGen \/ Free = {}
         THEN /\ st' = [st EXCEPT ![s] = "failed"]
              /\ UNCHANGED <<own, par, gen, pin>>
         ELSE \E n \in Free, w \in Workers :
                /\ st' = [st EXCEPT ![s] = "cancelled",
                                    ![n] = "pending"]
                /\ own' = [own EXCEPT ![n] = w]
                /\ par' = [par EXCEPT ![n] = s]
                /\ gen' = [gen EXCEPT ![n] = gen[s] + 1]
                /\ pin' = [pin EXCEPT ![n] = FALSE]
    /\ UNCHANGED <<offTo, ver, stale, sess, touched, running, alive, cl, acc, hb, rb,
                   apiUp, wc, ac, liveKill, badAcc>>

\* cleanupStaleResources: delete sessions whose heartbeat is > 30 min old.
CleanupSession(t) ==
    /\ apiUp /\ sess[t] = "dead"
    /\ sess' = [sess EXCEPT ![t] = "none"]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, touched, running,
                   alive, cl, acc, hb, rb, apiUp, wc, ac, liveKill, badAcc>>

---------------------------------------------------------------------------
(* API crash + boot + runRebootSweep.                                     *)

ApiCrash ==
    /\ apiUp /\ ac < MaxApiCrashes
    /\ apiUp' = FALSE
    /\ hb' = [pc |-> "idle", t |-> 0, snap |-> 0, act |-> "none"]
    /\ rb' = [todo |-> {}, pc |-> "idle", t |-> 0]
    /\ cl' = [w \in Workers |-> 0]
    /\ acc' = [w \in Workers |-> 0]
    /\ ac' = ac + 1
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, sess, touched,
                   running, alive, wc, liveKill, badAcc>>

ApiBoot ==
    /\ ~apiUp
    /\ apiUp' = TRUE
    /\ touched' = [t \in Tasks |-> FALSE]
    /\ sess' = [t \in Tasks |-> IF sess[t] = "live" THEN "prelive" ELSE sess[t]]
    /\ rb' = [todo |-> IF FIX_NO_REBOOT THEN {} ELSE {t \in Tasks : st[t] = "in_progress"},
              pc |-> "idle", t |-> 0]
    /\ UNCHANGED <<st, own, offTo, par, gen, pin, ver, stale, running,
                   alive, cl, acc, hb, wc, ac, liveKill, badAcc>>

\* runRebootSweep: skip if claimed after boot, if the session heartbeated
\* since boot, or (#1669) if its heartbeat is younger than the classifier's
\* 15 min stale-heartbeat threshold; else failTask. Session age is not a
\* variable: `hbOld` picks it per step. Worker lastUpdatedAt writes come with
\* a tool-call heartbeat, so an old heartbeat implies stale lastUpdatedAt
\* (hbOld => stale[t]); a stale task may still have a recent heartbeat.
RebootFail(t) ==
    /\ apiUp /\ rb.pc = "idle" /\ t \in rb.todo
    /\ \E hbOld \in {b \in BOOLEAN : b => stale[t]} :
       IF /\ st[t] = "in_progress" /\ ~(G_REBOOT_TOUCHED /\ touched[t])
          /\ \/ sess[t] = "none"
             \/ sess[t] \in {"prelive", "dead"} /\ (G_REBOOT_HB_AGE => hbOld)
       THEN /\ st' = [st EXCEPT ![t] = "failed"]
            /\ liveKill' = (liveKill \/ LiveNow(t))
            /\ rb' = [rb EXCEPT !.todo = @ \ {t}, !.pc = "retry", !.t = t]
       ELSE /\ rb' = [rb EXCEPT !.todo = @ \ {t}]
            /\ UNCHANGED <<st, liveKill>>
    /\ UNCHANGED <<own, offTo, par, gen, pin, ver, stale, sess, touched, running,
                   alive, cl, acc, hb, apiUp, wc, ac, badAcc>>

\* Reboot retry child: fresh task, generation tag restarts at 0.
RebootRetry ==
    /\ apiUp /\ rb.pc = "retry"
    /\ IF Free # {}
         THEN \E s \in Free : NewChild(s, rb.t, own[rb.t], 0, TRUE)
         ELSE UNCHANGED <<st, own, par, gen, pin>>
    /\ rb' = [rb EXCEPT !.pc = "idle"]
    /\ UNCHANGED <<offTo, ver, stale, sess, touched, running, alive, cl, acc, hb,
                   apiUp, wc, ac, liveKill, badAcc>>

---------------------------------------------------------------------------
Next ==
    \/ \E w \in Workers, t \in Tasks :
         ClaimRead(w, t) \/ AcceptRead(w, t) \/ PollStart(w, t) \/ RegisterSession(w, t)
         \/ SessionBeat(w, t) \/ Progress(w, t) \/ Complete(w, t) \/ AbortTerminal(w, t) \/ ReOffer(t, w)
         \/ AutoAssign(t, w) \/ DrainHandoff(w, t)
    \/ \E w \in Workers : ClaimWrite(w) \/ AcceptWrite(w) \/ WorkerCrash(w) \/ WorkerRestart(w)
    \/ \E t \in Tasks : Reject(t) \/ Age(t) \/ HbRead(t) \/ HbRepair(t) \/ Reaper(t)
         \/ CleanupSession(t) \/ RebootFail(t)
    \/ HbWrite \/ HbResume \/ RebootRetry \/ ApiCrash \/ ApiBoot

Fairness ==
    /\ \A w \in Workers :
         /\ WF_vars(ClaimWrite(w)) /\ WF_vars(AcceptWrite(w)) /\ WF_vars(WorkerRestart(w))
         /\ \A t \in Tasks : WF_vars(PollStart(w, t)) /\ WF_vars(Complete(w, t))
              /\ WF_vars(RegisterSession(w, t)) /\ WF_vars(AcceptRead(w, t))
    /\ \A t \in Tasks : WF_vars(Age(t)) /\ WF_vars(HbRead(t)) /\ WF_vars(HbRepair(t))
         /\ WF_vars(Reaper(t)) /\ WF_vars(RebootFail(t)) /\ WF_vars(CleanupSession(t))
         /\ WF_vars(\E w \in Workers : AutoAssign(t, w))
    /\ WF_vars(HbWrite) /\ WF_vars(HbResume) /\ WF_vars(RebootRetry) /\ WF_vars(ApiBoot)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Properties                                                             *)

TypeOK ==
    /\ st \in [Tasks -> Status]
    /\ ver \in [Tasks -> 0..MaxVer]
    /\ sess \in [Tasks -> {"none", "live", "prelive", "dead"}]

\* S1: at most one worker executes a given task row.
OneRunner == \A t \in Tasks : Cardinality({w \in Workers : t \in running[w]}) <= 1

\* S2: at most one active (non-terminal) row per lineage. One root => global.
OneActive == Cardinality({t \in Tasks : st[t] \in Active}) <= 1

\* S3: a live, progressing task is never superseded or failed by recovery.
NoLiveKill == ~liveKill

\* S4 (safety form, current design): every superseded task has a child
\* outside the in-flight resume step. An API crash between supersede and
\* resume still breaks it; L2 is the recovery form the repair sweep (#1670)
\* satisfies.
SupersededHasResume ==
    \A t \in Tasks :
        (st[t] = "superseded" /\ ~(hb.pc = "resume" /\ hb.t = t))
            => \E s \in Tasks : par[s] = t

\* S5: accept only takes an offer made to the accepting worker.
AcceptOwnOffer == ~badAcc

\* S6 (action): terminal is absorbing.
TerminalAbsorbing == [][\A t \in Tasks : st[t] \in Terminal => st'[t] = st[t]]_vars

\* L1: the work is eventually finished (completed or failed) or given up by
\* recovery with a recorded failure; a lineage never sits forever with no
\* active row and no finished row.
Finished == \E t \in Tasks : st[t] \in {"completed", "failed"}
EventuallyFinished == <>Finished
\* L2: a superseded task eventually has a resume.
SupersededGetsResume == \A t \in Tasks : (st[t] = "superseded") ~> (\E s \in Tasks : par[s] = t)
EventuallyQuiet    == <>[](\A t \in Tasks : st[t] \notin Active)
=============================================================================
