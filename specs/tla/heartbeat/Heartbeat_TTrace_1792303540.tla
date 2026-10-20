---- MODULE Heartbeat_TTrace_1792303540 ----
EXTENDS Sequences, TLCExt, Toolbox, Heartbeat, Naturals, TLC, Heartbeat_TEConstants

_expression ==
    LET Heartbeat_TEExpression == INSTANCE Heartbeat_TEExpression
    IN Heartbeat_TEExpression!expression
----

_trace ==
    LET Heartbeat_TETrace == INSTANCE Heartbeat_TETrace
    IN Heartbeat_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        par = (<<0, 0, 0>>)
        /\
        acc = ((w1 :> 0 @@ w2 :> 0))
        /\
        st = (<<"failed", "free", "free">>)
        /\
        ac = (1)
        /\
        ver = (<<1, 0, 0>>)
        /\
        touched = (<<FALSE, FALSE, FALSE>>)
        /\
        alive = ((w1 :> TRUE @@ w2 :> TRUE))
        /\
        offTo = (<<w1, "none", "none">>)
        /\
        sess = (<<"none", "none", "none">>)
        /\
        own = (<<w1, "none", "none">>)
        /\
        cl = ((w1 :> 0 @@ w2 :> 0))
        /\
        wc = (0)
        /\
        running = ((w1 :> {1} @@ w2 :> {}))
        /\
        rb = ([t |-> 1, pc |-> "retry", todo |-> {}])
        /\
        gen = (<<0, 0, 0>>)
        /\
        bt = ([armed |-> TRUE, hit |-> TRUE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE])
        /\
        stale = (<<FALSE, FALSE, FALSE>>)
        /\
        pin = (<<FALSE, FALSE, FALSE>>)
        /\
        liveKill = (TRUE)
        /\
        hb = ([t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"])
        /\
        badAcc = (FALSE)
        /\
        apiUp = (TRUE)
    )
----

_init ==
    /\ sess = _TETrace[1].sess
    /\ ac = _TETrace[1].ac
    /\ liveKill = _TETrace[1].liveKill
    /\ par = _TETrace[1].par
    /\ offTo = _TETrace[1].offTo
    /\ running = _TETrace[1].running
    /\ alive = _TETrace[1].alive
    /\ bt = _TETrace[1].bt
    /\ cl = _TETrace[1].cl
    /\ own = _TETrace[1].own
    /\ rb = _TETrace[1].rb
    /\ ver = _TETrace[1].ver
    /\ st = _TETrace[1].st
    /\ acc = _TETrace[1].acc
    /\ hb = _TETrace[1].hb
    /\ stale = _TETrace[1].stale
    /\ apiUp = _TETrace[1].apiUp
    /\ badAcc = _TETrace[1].badAcc
    /\ pin = _TETrace[1].pin
    /\ wc = _TETrace[1].wc
    /\ gen = _TETrace[1].gen
    /\ touched = _TETrace[1].touched
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ sess  = _TETrace[i].sess
        /\ sess' = _TETrace[j].sess
        /\ ac  = _TETrace[i].ac
        /\ ac' = _TETrace[j].ac
        /\ liveKill  = _TETrace[i].liveKill
        /\ liveKill' = _TETrace[j].liveKill
        /\ par  = _TETrace[i].par
        /\ par' = _TETrace[j].par
        /\ offTo  = _TETrace[i].offTo
        /\ offTo' = _TETrace[j].offTo
        /\ running  = _TETrace[i].running
        /\ running' = _TETrace[j].running
        /\ alive  = _TETrace[i].alive
        /\ alive' = _TETrace[j].alive
        /\ bt  = _TETrace[i].bt
        /\ bt' = _TETrace[j].bt
        /\ cl  = _TETrace[i].cl
        /\ cl' = _TETrace[j].cl
        /\ own  = _TETrace[i].own
        /\ own' = _TETrace[j].own
        /\ rb  = _TETrace[i].rb
        /\ rb' = _TETrace[j].rb
        /\ ver  = _TETrace[i].ver
        /\ ver' = _TETrace[j].ver
        /\ st  = _TETrace[i].st
        /\ st' = _TETrace[j].st
        /\ acc  = _TETrace[i].acc
        /\ acc' = _TETrace[j].acc
        /\ hb  = _TETrace[i].hb
        /\ hb' = _TETrace[j].hb
        /\ stale  = _TETrace[i].stale
        /\ stale' = _TETrace[j].stale
        /\ apiUp  = _TETrace[i].apiUp
        /\ apiUp' = _TETrace[j].apiUp
        /\ badAcc  = _TETrace[i].badAcc
        /\ badAcc' = _TETrace[j].badAcc
        /\ pin  = _TETrace[i].pin
        /\ pin' = _TETrace[j].pin
        /\ wc  = _TETrace[i].wc
        /\ wc' = _TETrace[j].wc
        /\ gen  = _TETrace[i].gen
        /\ gen' = _TETrace[j].gen
        /\ touched  = _TETrace[i].touched
        /\ touched' = _TETrace[j].touched

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("Heartbeat_TTrace_1792303540.json", _TETrace)

=============================================================================

 Note that you can extract this module `Heartbeat_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `Heartbeat_TEExpression.tla` file takes precedence 
  over the module `Heartbeat_TEExpression` below).

---- MODULE Heartbeat_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, Heartbeat, Naturals, TLC, Heartbeat_TEConstants

expression == 
    [
        \* To hide variables of the `Heartbeat` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        sess |-> sess
        ,ac |-> ac
        ,liveKill |-> liveKill
        ,par |-> par
        ,offTo |-> offTo
        ,running |-> running
        ,alive |-> alive
        ,bt |-> bt
        ,cl |-> cl
        ,own |-> own
        ,rb |-> rb
        ,ver |-> ver
        ,st |-> st
        ,acc |-> acc
        ,hb |-> hb
        ,stale |-> stale
        ,apiUp |-> apiUp
        ,badAcc |-> badAcc
        ,pin |-> pin
        ,wc |-> wc
        ,gen |-> gen
        ,touched |-> touched
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_sessUnchanged |-> sess = sess'
        
        \* Format the `sess` variable as Json value.
        \* ,_sessJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(sess)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_sessModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].sess # _TETrace[s-1].sess
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE Heartbeat_TETrace ----
\*EXTENDS IOUtils, Heartbeat, TLC, Heartbeat_TEConstants
\*
\*trace == IODeserialize("Heartbeat_TTrace_1792303540.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE Heartbeat_TETrace ----
EXTENDS Heartbeat, TLC, Heartbeat_TEConstants

trace == 
    <<
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"offered", "free", "free">>,ac |-> 0,ver |-> <<0, 0, 0>>,touched |-> <<FALSE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<"none", "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 1 @@ w2 :> 0),st |-> <<"offered", "free", "free">>,ac |-> 0,ver |-> <<0, 0, 0>>,touched |-> <<FALSE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<"none", "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"pending", "free", "free">>,ac |-> 0,ver |-> <<0, 0, 0>>,touched |-> <<FALSE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"in_progress", "free", "free">>,ac |-> 0,ver |-> <<0, 0, 0>>,touched |-> <<TRUE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {1} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"in_progress", "free", "free">>,ac |-> 0,ver |-> <<1, 0, 0>>,touched |-> <<TRUE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {1} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"in_progress", "free", "free">>,ac |-> 1,ver |-> <<1, 0, 0>>,touched |-> <<TRUE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {1} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> FALSE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> FALSE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"in_progress", "free", "free">>,ac |-> 1,ver |-> <<1, 0, 0>>,touched |-> <<FALSE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {1} @@ w2 :> {}),rb |-> [t |-> 0, pc |-> "idle", todo |-> {1}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> TRUE, hit |-> FALSE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> FALSE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE]),
    ([par |-> <<0, 0, 0>>,acc |-> (w1 :> 0 @@ w2 :> 0),st |-> <<"failed", "free", "free">>,ac |-> 1,ver |-> <<1, 0, 0>>,touched |-> <<FALSE, FALSE, FALSE>>,alive |-> (w1 :> TRUE @@ w2 :> TRUE),offTo |-> <<w1, "none", "none">>,sess |-> <<"none", "none", "none">>,own |-> <<w1, "none", "none">>,cl |-> (w1 :> 0 @@ w2 :> 0),wc |-> 0,running |-> (w1 :> {1} @@ w2 :> {}),rb |-> [t |-> 1, pc |-> "retry", todo |-> {}],gen |-> <<0, 0, 0>>,bt |-> [armed |-> TRUE, hit |-> TRUE, fired |-> FALSE, dirty |-> FALSE, created |-> FALSE],stale |-> <<FALSE, FALSE, FALSE>>,pin |-> <<FALSE, FALSE, FALSE>>,liveKill |-> TRUE,hb |-> [t |-> 0, pc |-> "idle", snap |-> 0, act |-> "none"],badAcc |-> FALSE,apiUp |-> TRUE])
    >>
----


=============================================================================

---- MODULE Heartbeat_TEConstants ----
EXTENDS Heartbeat

CONSTANTS w1, w2

=============================================================================

---- CONFIG Heartbeat_TTrace_1792303540 ----
CONSTANTS
    Workers = { w1 , w2 }
    NTasks = 3
    MaxVer = 1
    MaxGen = 2
    MaxWorkerCrashes = 1
    MaxApiCrashes = 1
    G_CLAIM_STATUS = TRUE
    G_TERMINAL_CAS = TRUE
    G_REBOOT_TOUCHED = TRUE
    G_STALL_CAS = TRUE
    G_REBOOT_HB_AGE = TRUE
    G_ORPHAN_REPAIR = TRUE
    FIX_NO_REBOOT = FALSE
    DRAIN_HANDOFF = TRUE
    HYPO_REOFFER = FALSE
    BOOT_TRIAGE_ALWAYS = FALSE
    G_STATUS_FALLBACK = TRUE
    TIMER_RACE = FALSE
    RUNTIME_POOLS = FALSE
    w1 = w1
    w2 = w2

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Sun Oct 18 06:05:40 UTC 2026