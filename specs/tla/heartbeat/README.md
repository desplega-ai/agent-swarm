# TLA+ model: heartbeat and task lifecycle

- `Heartbeat.tla` / `Heartbeat.cfg`: the server heartbeat (`src/heartbeat/heartbeat.ts`) and the lifecycle writes it races with, as on `main`. `G_*` constants remove historical guards (see `CALIBRATION.md`); `FIX_*` constants switch on proposed fixes.
- `HeartbeatSimple.tla` / `HeartbeatSimple.cfg`: a proposed replacement with two heartbeat actions. Not implemented.
- `ACTIONS.md`: every TLA+ action → file:line and the SQL guard it models.
- `CALIBRATION.md`: historical bugs the model finds when their guard is removed, and one drift case.

## Run

TLC needs Java 21 and `tla2tools.jar` (no root: Temurin JRE tarball + the jar in `$TLC_HOME`).

```bash
export TLC_HOME=/path/with/jre-and-jar
./run-props.sh Heartbeat Heartbeat.cfg                 # current code: one TLC run per property
./run-props.sh Heartbeat Heartbeat.cfg FIX_NO_REBOOT=TRUE
./run-props.sh HeartbeatSimple HeartbeatSimple.cfg
./trace.sh Heartbeat Heartbeat.cfg INVARIANT NoLiveKill   # action names of a counterexample
./long-run.sh                                          # larger constants + -simulate
```

A green run proves the model, not the code. When a file named in `ACTIONS.md` changes, re-check that its row is still true.
