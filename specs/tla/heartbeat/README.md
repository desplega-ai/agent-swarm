# TLA+ model: heartbeat and task lifecycle

- `Heartbeat.tla` / `Heartbeat.cfg`: the server heartbeat (`src/heartbeat/heartbeat.ts`) and the lifecycle writes it races with, as on `main`, plus the boot-triage gate that decides whether a boot creates a Lead task (#1973) and, behind `RUNTIME_POOLS`, the runtime-pool routing and recovery writes (#2045). `G_*` constants remove historical guards (see `CALIBRATION.md`); `FIX_*` constants switch on proposed fixes.
- `HeartbeatSimple.tla` / `HeartbeatSimple.cfg`: a proposed replacement with two heartbeat actions. Not implemented.
- `ACTIONS.md`: every TLA+ action → file:line and the SQL guard it models.
- `CALIBRATION.md`: historical bugs the model finds when their guard is removed, and one drift case.

## Run

TLC needs Java 21 and `tla2tools.jar` (no root: Temurin JRE tarball + the jar in `$TLC_HOME`).

```bash
export TLC_HOME=/path/with/jre-and-jar
./run-props.sh Heartbeat Heartbeat.cfg                 # current code: one TLC run per property
./run-props.sh Heartbeat Heartbeat.cfg FIX_NO_REBOOT=TRUE
./run-props.sh Heartbeat Heartbeat.cfg RUNTIME_POOLS=TRUE   # runtime pools (#2045); liveness is slow at this size, NTasks=2 finishes in minutes
./run-props.sh HeartbeatSimple HeartbeatSimple.cfg
./trace.sh Heartbeat Heartbeat.cfg INVARIANT NoLiveKill   # action names of a counterexample
./long-run.sh                                          # larger constants + -simulate
```

TLC defaults to 4 workers, a 6 GiB JVM heap (`TLC_HEAP=6g`), and 4 GiB of direct memory (`TLC_DIRECT_MEMORY=4g`). These caps protect the shared host: three concurrent runs budget 30 GiB for heap and direct memory, leaving room for JVM/native overhead within roughly 40 GB. They are not a hard limit on total process RSS.

`TLC_WORKERS=auto` also uses 4 workers. Set an explicit number (for example `TLC_WORKERS=2`) to override it. Override `TLC_HEAP` and `TLC_DIRECT_MEMORY` only when the host has enough capacity; larger models may exhaust the default memory budget.

Run `bash ./test-tlc.sh` to check the launcher's caps and argument forwarding without starting Java.

A green run proves the model, not the code. When a file named in `ACTIONS.md` changes, re-check that its row is still true.
