# Calibration

Before trusting the model on current code, each historical fix below was removed from `Heartbeat.tla` (constant set to `FALSE`, all proposed fixes on so nothing else fires) and TLC had to find the bug the fix closed. Reproduce with `./trace.sh Heartbeat Heartbeat.cfg <KIND> <PROP> <overrides>`.

| # | Historical fix | Guard removed | Property violated | TLC trace |
|---|---|---|---|---|
| C1 | `370d63b1` fix: make task pool claiming atomic to prevent race conditions (#83) | `G_CLAIM_STATUS=FALSE` (`claimTask` loses `AND status='unassigned'`) | `OneRunner` | `ClaimRead(w1) → AutoAssign(w2) → PollStart(w2) → ClaimWrite(w1)`: two workers execute one task. 5 states. |
| C2 | `8ecb7c47` DES-292 idempotency guards on completeTask/failTask (#397); race covered by `9fd0fa37` (#637) | `G_TERMINAL_CAS=FALSE` (supersede/fail/complete lose `AND status NOT IN terminal`) | `TerminalAbsorbing` | `AutoAssign → PollStart → Age → HbRead → Complete → HbWrite`: the heartbeat overwrites a task the worker just completed. This is the exact scenario of the existing test "worker completes between read and supersede". 7 states. |
| C3 | #1668 fix(heartbeat): compare-and-swap stall remediation on observed lastUpdatedAt | `G_STALL_CAS=FALSE` (supersede/fail lose `AND lastUpdatedAt = <observed>`) | `NoLiveKill` | `AutoAssign → PollStart → Age → HbRead → Progress → HbWrite`: a progress write between the candidate read and the supersede is overwritten. 7 states. |
| C4 | #1669 fix(heartbeat): reboot sweep keeps tasks whose session heartbeat is recent | `G_REBOOT_HB_AGE=FALSE` (a pre-boot session heartbeat counts as dead) | `NoLiveKill` | `AutoAssign → PollStart → RegisterSession → ApiCrash → ApiBoot → RebootFail`: a live worker with a registered session is failed at boot. 7 states. Found with `liveKill` restricted to tasks that have a session row, because the shorter no-session trace below hits first; with the guard on, that restricted check passes. |
| C5 | #1670 fix(heartbeat): create the missing resume for a task superseded without one | `G_ORPHAN_REPAIR=FALSE` (no `repairSupersededWithoutResume` sweep) | `SupersededGetsResume` | `ClaimRead → ClaimWrite → WorkerCrash → Age → WorkerRestart → HbRead → HbWrite → ApiCrash → ApiBoot → stutter`: the API dies between supersede and resume, and the task stays superseded with no resume forever. 10 states. With the sweep on, `SupersededGetsResume` and `EventuallyFinished` hold; the safety form `SupersededHasResume` still fails, because the two writes are still not one transaction. |

Result: **5 of 5 calibrations found**; the safety ones (C1 to C4) at the shortest possible depth.

## Still open on current code

`NoLiveKill` fails on `Heartbeat.cfg` through `AutoAssign → PollStart → ApiCrash → ApiBoot → RebootFail` (6 states): the task was started before boot and its session row is not registered yet, so the reboot sweep fails it. #1669 left this case unchanged on purpose; `FIX_NO_REBOOT` closes it.

## Drift check

| # | Candidate | Model result | Code | Verdict |
|---|---|---|---|---|
| D1 | `acceptTask` checks `offeredTo` in JS only (design doc §1) | With `HYPO_REOFFER=TRUE`: `AcceptRead(w1) → Reject → ReOffer(w2) → AcceptWrite(w1)` violates `AcceptOwnOffer`. With the real action set it holds. | No code path changes `offeredTo` on a task that stays or becomes `offered` again: it is set only at creation, and `reviewing → offered` keeps it. | **Not a bug today** (false positive of the naive model). Adding `AND offeredTo = ?` is still cheap hardening, and the simple design does it. |

## Commands

```bash
F="FIX_NO_REBOOT=TRUE"
./trace.sh Heartbeat Heartbeat.cfg INVARIANT OneRunner G_CLAIM_STATUS=FALSE $F
./trace.sh Heartbeat Heartbeat.cfg PROPERTY TerminalAbsorbing G_TERMINAL_CAS=FALSE $F
./trace.sh Heartbeat Heartbeat.cfg INVARIANT AcceptOwnOffer HYPO_REOFFER=TRUE $F
./trace.sh Heartbeat Heartbeat.cfg INVARIANT NoLiveKill G_STALL_CAS=FALSE $F
# C4 keeps the reboot sweep (no FIX_NO_REBOOT); first change RebootFail's
# liveKill' to `liveKill \/ (LiveNow(t) /\ sess[t] # "none")` in a scratch copy.
./trace.sh Heartbeat Heartbeat.cfg INVARIANT NoLiveKill G_REBOOT_HB_AGE=FALSE
./trace.sh Heartbeat Heartbeat.cfg PROPERTY SupersededGetsResume G_ORPHAN_REPAIR=FALSE $F
```
