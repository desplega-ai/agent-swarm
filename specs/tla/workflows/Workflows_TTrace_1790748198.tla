---- MODULE Workflows_TTrace_1790748198 ----
EXTENDS Sequences, TLCExt, Workflows, Toolbox, Naturals, TLC

_expression ==
    LET Workflows_TEExpression == INSTANCE Workflows_TEExpression
    IN Workflows_TEExpression!expression
----

_trace ==
    LET Workflows_TETrace == INSTANCE Workflows_TETrace
    IN Workflows_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        hbLeft = (0)
        /\
        active = (2)
        /\
        run = ("running")
        /\
        crashes = (0)
        /\
        steps = (<<[rc |-> 0, node |-> "T", st |-> "running", nra |-> FALSE, task |-> "none"], [rc |-> 0, node |-> "T", st |-> "running", nra |-> FALSE, task |-> "none"]>>)
        /\
        okCount = ([A |-> 0, B |-> 0, T |-> 0, M |-> 0])
        /\
        execLive = ([A |-> 0, B |-> 0, T |-> 2, M |-> 0])
        /\
        thr = ((1 :> [pc |-> "xRun", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 1, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "xRun", ret |-> "h5", pend |-> {}, cur |-> "T", sid |-> 2, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0]))
    )
----

_init ==
    /\ active = _TETrace[1].active
    /\ steps = _TETrace[1].steps
    /\ hbLeft = _TETrace[1].hbLeft
    /\ okCount = _TETrace[1].okCount
    /\ crashes = _TETrace[1].crashes
    /\ thr = _TETrace[1].thr
    /\ run = _TETrace[1].run
    /\ execLive = _TETrace[1].execLive
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ active  = _TETrace[i].active
        /\ active' = _TETrace[j].active
        /\ steps  = _TETrace[i].steps
        /\ steps' = _TETrace[j].steps
        /\ hbLeft  = _TETrace[i].hbLeft
        /\ hbLeft' = _TETrace[j].hbLeft
        /\ okCount  = _TETrace[i].okCount
        /\ okCount' = _TETrace[j].okCount
        /\ crashes  = _TETrace[i].crashes
        /\ crashes' = _TETrace[j].crashes
        /\ thr  = _TETrace[i].thr
        /\ thr' = _TETrace[j].thr
        /\ run  = _TETrace[i].run
        /\ run' = _TETrace[j].run
        /\ execLive  = _TETrace[i].execLive
        /\ execLive' = _TETrace[j].execLive

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("Workflows_TTrace_1790748198.json", _TETrace)

=============================================================================

 Note that you can extract this module `Workflows_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `Workflows_TEExpression.tla` file takes precedence 
  over the module `Workflows_TEExpression` below).

---- MODULE Workflows_TEExpression ----
EXTENDS Sequences, TLCExt, Workflows, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `Workflows` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        active |-> active
        ,steps |-> steps
        ,hbLeft |-> hbLeft
        ,okCount |-> okCount
        ,crashes |-> crashes
        ,thr |-> thr
        ,run |-> run
        ,execLive |-> execLive
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_activeUnchanged |-> active = active'
        
        \* Format the `active` variable as Json value.
        \* ,_activeJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(active)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_activeModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].active # _TETrace[s-1].active
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE Workflows_TETrace ----
\*EXTENDS IOUtils, Workflows, TLC
\*
\*trace == IODeserialize("Workflows_TTrace_1790748198.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE Workflows_TETrace ----
EXTENDS Workflows, TLC

trace == 
    <<
    ([hbLeft |-> 1,active |-> 0,run |-> "none",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "iStart", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "hIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 1,active |-> 0,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "iWalk", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "hIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 0,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "iWalk", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "h2", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 0,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "iWalk", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "h3", ret |-> "idle", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 1,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "iWalk", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "wStart", ret |-> "h5", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "wStart", ret |-> "iDone", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "wStart", ret |-> "h5", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "wPick", ret |-> "iDone", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "wStart", ret |-> "h5", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "xDedup", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "wStart", ret |-> "h5", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "xDedup", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "wPick", ret |-> "h5", pend |-> {"T"}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],thr |-> (1 :> [pc |-> "xDedup", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "xDedup", ret |-> "h5", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<[rc |-> 0, node |-> "T", st |-> "running", nra |-> FALSE, task |-> "none"]>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 1, M |-> 0],thr |-> (1 :> [pc |-> "xRun", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 1, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "xDedup", ret |-> "h5", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])]),
    ([hbLeft |-> 0,active |-> 2,run |-> "running",crashes |-> 0,steps |-> <<[rc |-> 0, node |-> "T", st |-> "running", nra |-> FALSE, task |-> "none"], [rc |-> 0, node |-> "T", st |-> "running", nra |-> FALSE, task |-> "none"]>>,okCount |-> [A |-> 0, B |-> 0, T |-> 0, M |-> 0],execLive |-> [A |-> 0, B |-> 0, T |-> 2, M |-> 0],thr |-> (1 :> [pc |-> "xRun", ret |-> "iDone", pend |-> {}, cur |-> "T", sid |-> 1, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 2 :> [pc |-> "pIdle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 3 :> [pc |-> "xRun", ret |-> "h5", pend |-> {}, cur |-> "T", sid |-> 2, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 4 :> [pc |-> "cDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 5 :> [pc |-> "uDone", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 11 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 12 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 13 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 14 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 15 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0] @@ 16 :> [pc |-> "idle", ret |-> "idle", pend |-> {}, cur |-> "T", sid |-> 0, done |-> {}, edges |-> {}, nxt |-> {}, ex |-> {}, hasW |-> FALSE, R |-> {}, rs |-> "running", rc |-> 0])])
    >>
----


=============================================================================

---- CONFIG Workflows_TTrace_1790748198 ----
CONSTANTS
    Branches = { "A" , "B" }
    Converge = TRUE
    BranchOutcomes = { "ok" }
    MaxRetries = 1
    MaxSteps = 6
    MaxSweeps = 1
    MaxCrashes = 0
    UserCancel = FALSE
    UserRetry = FALSE
    InputAwait = TRUE
    GuardActiveWalk = TRUE
    GuardConvergeSeed = TRUE
    FixPollerRunGuard = FALSE
    FixPendingRetryGate = FALSE
    FixConcurrentJoin = FALSE
    FixRecoveryRetry = FALSE
    FixUserRetryLive = FALSE
    FixJoinWaitsLive = FALSE

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
\* Generated on Wed Sep 30 06:03:20 UTC 2026