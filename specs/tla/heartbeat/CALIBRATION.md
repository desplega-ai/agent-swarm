# Calibration

Before trusting the model on current code, each historical fix below was removed from `Heartbeat.tla` (constant set to `FALSE`, all proposed fixes on so nothing else fires) and TLC had to find the bug the fix closed. Reproduce with `./trace.sh Heartbeat Heartbeat.cfg <KIND> <PROP> <overrides>`.

| # | Historical fix | Guard removed | Property violated | TLC trace |
|---|---|---|---|---|
| C1 | `370d63b1` fix: make task pool claiming atomic to prevent race conditions (#83) | `G_CLAIM_STATUS=FALSE` (`claimTask` loses `AND status='unassigned'`) | `OneRunner` | `ClaimRead(w1) → AutoAssign(w2) → PollStart(w2) → ClaimWrite(w1)`: two workers execute one task. 5 states. |
| C2 | `8ecb7c47` DES-292 idempotency guards on completeTask/failTask (#397); race covered by `9fd0fa37` (#637) | `G_TERMINAL_CAS=FALSE` (supersede/fail/complete lose `AND status NOT IN terminal`) | `TerminalAbsorbing` | `AutoAssign → PollStart → Age → HbRead → Complete → HbWrite`: the heartbeat overwrites a task the worker just completed. This is the exact scenario of the existing test "worker completes between read and supersede". 7 states. |

Result: **2 of 2 calibrations found**, both at the shortest possible depth.

## Drift check

| # | Candidate | Model result | Code | Verdict |
|---|---|---|---|---|
| D1 | `acceptTask` checks `offeredTo` in JS only (design doc §1) | With `HYPO_REOFFER=TRUE`: `AcceptRead(w1) → Reject → ReOffer(w2) → AcceptWrite(w1)` violates `AcceptOwnOffer`. With the real action set it holds. | No code path changes `offeredTo` on a task that stays or becomes `offered` again: it is set only at creation, and `reviewing → offered` keeps it. | **Not a bug today** (false positive of the naive model). Adding `AND offeredTo = ?` is still cheap hardening, and the simple design does it. |

## Commands

```bash
F="FIX_STALL_CAS=TRUE FIX_ORPHAN_REPAIR=TRUE FIX_NO_REBOOT=TRUE"
./trace.sh Heartbeat Heartbeat.cfg INVARIANT OneRunner G_CLAIM_STATUS=FALSE $F
./trace.sh Heartbeat Heartbeat.cfg PROPERTY TerminalAbsorbing G_TERMINAL_CAS=FALSE $F
./trace.sh Heartbeat Heartbeat.cfg INVARIANT AcceptOwnOffer HYPO_REOFFER=TRUE $F
```
