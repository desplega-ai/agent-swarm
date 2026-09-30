# TLA+ model: heartbeat and task lifecycle

- `HeartbeatSimple.tla` / `HeartbeatSimple.cfg`: the server heartbeat (`src/heartbeat/heartbeat.ts`) as implemented. Two heartbeat actions: `Reclaim` (stalled task back to `pending` on the same row) and `Unpin` (unclaimed pin back to the pool).
- `Heartbeat.tla` / `Heartbeat.cfg`: the "before" model, the supersede + resume + reboot-sweep heartbeat as it was before Reclaim landed. Kept for its calibration runs; it no longer describes the code. `G_*` constants remove historical guards (see `CALIBRATION.md`); `FIX_*` constants switch on proposed fixes.
- `ACTIONS.md`: every TLA+ action → file:line and the SQL guard it models.
- `CALIBRATION.md`: historical bugs the model finds when their guard is removed, and one drift case.

## Run

TLC needs Java 21 and `tla2tools.jar` (no root: Temurin JRE tarball + the jar in `$TLC_HOME`).

```bash
export TLC_HOME=/path/with/jre-and-jar
./run-props.sh HeartbeatSimple HeartbeatSimple.cfg     # current code: one TLC run per property
./run-props.sh Heartbeat Heartbeat.cfg                 # before model
./run-props.sh Heartbeat Heartbeat.cfg FIX_NO_REBOOT=TRUE
./trace.sh Heartbeat Heartbeat.cfg INVARIANT NoLiveKill   # action names of a counterexample
./long-run.sh                                          # larger constants + -simulate
```

A green run proves the model, not the code. When a file named in `ACTIONS.md` changes, re-check that its row is still true.
