# Heartbeat & Boot Triage — Unified Assessment

## The Problem

Two issues observed in our deployed lead agent:

1. **HEARTBEAT.md is dead** — The lead never populates it, so the 30-minute periodic checklist system is permanently dormant. Zero standing orders = zero periodic tasks created.
2. **Boot triage is ineffective** — After re-deploy, the lead receives a boot-triage task listing stale in-progress tasks, but fails to triage them effectively (e.g., doesn't recognize they're stale from the previous deployment, doesn't re-create critical ones).

---

## Current Agent-Swarm Architecture

### What exists today

| Component | Status | Issue |
|-----------|--------|-------|
| Infrastructure heartbeat (Tier 1-2) | Working | Auto-fails tasks with no/stale sessions every 90s |
| Boot triage task | Working | Created 30s after restart with system status |
| HEARTBEAT.md checklist | Dormant | Ships empty, lead never populates it |
| Standing orders | Non-existent | No default standing orders, fully opt-in |

### Where it breaks

**HEARTBEAT.md:** Ships as all-comments template. `isEffectivelyEmpty()` returns true, so `checkHeartbeatChecklist()` silently skips. The lead's CLAUDE.md mentions it in passing ("Leave empty to disable at zero cost") — framing it as optional rather than essential.

**Boot triage:** The template says tasks "may have been auto-failed" (wishy-washy). `gatherSystemStatus()` dumps stalled tasks and recent failures into a generic list without distinguishing reboot-caused failures from normal ones. Tasks in `pending`/`offered` states are invisible to the triage. The lead sees noise, not actionable items.

---

## What Paperclip Does

### Heartbeat = Full execution cycle
Their "heartbeat" is a complete agent invocation, not a health ping. Each cycle: wake, check work, do something useful, exit. Every run creates a `heartbeat_runs` row with full audit trail (PID, sessions, tokens, exit code, context snapshot).

### Boot recovery: Reap → Retry → Resume
On startup:
1. `reapOrphanedRuns()` — finds all runs stuck in "running" with no in-memory handle
2. For local adapters: checks if PID is still alive → marks "detached" (don't kill)
3. If PID dead: fails with `errorCode: "process_lost"`, enqueues exactly ONE automatic retry
4. `resumeQueuedRuns()` — drives all queued runs forward

**Key insight:** The retry is automatic with exactly-once semantics (`processLossRetryCount < 1`). No lead intervention needed for recoverable failures.

### Standing orders: Routines system
Full-featured recurring task system with cron/webhook triggers, typed variables, interpolation, and two concurrency policies:
- `coalesce_if_active` — merge into existing if one is live
- `always_create` — always spawn new

Catch-up policy on restart: `skip_missed` (default) or `run_missed` (fire missed ticks up to 25).

### No special leader heartbeat
Uses a competitive checkout model (`POST /api/issues/{issueId}/checkout` → 409 if claimed). The CEO agent has a richer checklist but uses the same heartbeat infra. No leader-specific machinery.

### Transferable patterns
- **Wakeup request + run separation** — clean audit trail for dropped wakes
- **Process-loss retry with exactly-once** — practical auto-recovery
- **"Detached" process state** — don't kill alive processes the server lost handles to
- **Issue execution lock with deferred promotion** — prevents duplicate work

---

## What OpenClaw Does

### Heartbeat = "Does the AI have anything to say?"
Runs full LLM inference turns every 30 min. The agent reads `HEARTBEAT.md` and replies:
- `HEARTBEAT_OK` → silently suppressed (zero user noise)
- Actual text → surfaced as alert

**Key insight:** The response contract (`HEARTBEAT_OK` vs alert) makes the heartbeat self-triaging. Silent by default, loud only when needed.

### Wake coalescing with priority
Multiple triggers within 250ms are batched. Priority levels:
- retry (0) < interval (1) < default (2) < action (3)
- Higher priority replaces lower for same agent/session target
- Retry wakes are "sticky" (can't be preempted by normal wakes)

### Boot: Session snapshot/restore
`BOOT.md` runner:
1. Snapshots main session mapping
2. Runs boot agent turn in isolated session
3. Restores main session mapping

Prevents boot triage from polluting the main conversation context.

### Cron restart catch-up
On restart: scans for overdue cron jobs, runs up to 5 immediately (oldest first, 5s stagger), defers rest. Prevents thundering herd.

### Stale socket detection
Channel health monitor catches "half-dead WebSocket" — connected but no events for 30+ min. Multi-layer grace periods (startup, connect, busy) prevent false positives.

### Transferable patterns
- **HEARTBEAT_OK response contract** — self-triaging heartbeat with zero noise when healthy
- **Session snapshot/restore for boot** — isolated triage without side effects
- **Bounded restart catch-up with stagger** — prevent thundering herd
- **Stale socket detection** with grace periods

---

## Gap Analysis: Agent-Swarm vs Paperclip vs OpenClaw

| Capability | Agent-Swarm | Paperclip | OpenClaw |
|------------|-------------|-----------|----------|
| Heartbeat as execution cycle | Partial (checklist task) | Full (wake→work→exit) | Full (LLM inference turn) |
| Auto-recovery on restart | Auto-fail only | Reap → retry → resume | Boot.md + catch-up |
| Standing orders | Empty by default | Full routines system | Markdown + cron |
| Boot triage | Generic status dump | Automatic orphan recovery | Isolated session boot |
| Reboot-caused failure tracking | Not distinguished | `errorCode: "process_lost"` | N/A (different model) |
| Periodic self-check | Dormant (empty HEARTBEAT.md) | Per-agent interval tick | 30-min with HEARTBEAT_OK |
| Wake coalescing | Dedup by taskType | Full coalescing + deferral | Priority-based 250ms batch |
| Pending/offered task triage | Not covered | Issue lock release + promote | N/A |
| Response contract | None | Structured result | HEARTBEAT_OK / alert |

---

## Observed Lead Behavior (from production logs)

### Periodic heartbeat checklist — "All clear" despite reboot failures

The lead DOES have real standing orders. The checklist tasks ARE being created. But the lead dismisses reboot failures:

> "9 failures — 7 are 'worker session not found' from a restart **(expected, auto-cleanup)**"
> → Marks "System looks healthy. DONE."

The lead correctly identifies the failures as restart-related but concludes they're "expected" and need no action. It doesn't check what those 7 tasks actually were or whether the work needs to be re-created. The standing order "Check for failed tasks and determine if they need retry or escalation" is too vague — the lead interprets "auto-cleanup" as "the system handled it."

### Boot triage — timing gap makes stale tasks look healthy

Boot triage runs at **T+30s** after restart. But the infrastructure sweep auto-fails tasks at **T+5min** (no session) / **T+15min** (stale heartbeat). So at T+30s:

> Lead sees: "4 in-progress tasks... all looking healthy with recent progress"
> → Marks "Everything looks clean. DONE."

Those 4 tasks are actually stale — their workers died in the restart. But the sweep hasn't caught them yet, and the "recent progress" is from BEFORE the restart. The lead has no way to distinguish pre-restart vs post-restart activity.

### Root cause summary

| Issue | Root cause |
|-------|-----------|
| Checklist: dismisses reboot failures | No instruction that "session not found" failures = interrupted work needing re-creation |
| Boot triage: timing gap | Boot triage (T+30s) runs before sweep (T+5min+). In-progress tasks look healthy. |
| Boot triage: no restart context | `gatherSystemStatus()` doesn't mark which tasks existed before vs after restart |
| Both: "All clear" too easy | No guard rails preventing completion when reboot-affected items exist |

---

## Recommendations

### R1: Fix the timing gap — delay boot triage past the sweep threshold (critical)

The boot triage currently fires at T+30s, before the sweep's shortest threshold (T+5min). This means the lead sees stale tasks as healthy. Options:

- **Option A:** Delay boot triage to T+6min (after the no-session sweep runs)
- **Option B:** Run an immediate "reboot sweep" at T+5s that ignores thresholds — any `in_progress` task whose assigned worker has no active session is immediately suspect
- **Option C (recommended):** Both — run an aggressive reboot sweep at T+5s, then boot triage at T+90s with the sweep results

### R2: Add "Reboot-Interrupted Work" section to system status

`gatherSystemStatus()` should add a dedicated section when called for boot triage:

```markdown
## Reboot-Interrupted Work [auto-generated, ACTION REQUIRED]
The following tasks were in-progress before the restart and their workers are no longer active:
- [abc12345] "Implement DES-26 feature" — was assigned to worker-1, worker session NOT FOUND
- [def67890] "Review PR #287" — was assigned to worker-3, worker session NOT FOUND

**You MUST triage each task above:**
- Re-create it if the work is still needed
- Cancel it if it's no longer relevant
- Do NOT mark this boot triage as complete until all items are triaged
```

### R3: Auto-retry reboot-killed tasks (Paperclip pattern)

When the sweep auto-fails a task due to `worker session not found` or `worker session heartbeat is stale`:
- Automatically create a retry task with the same description, tags, and priority
- Track `rebootRetryCount` on the task — max 1 retry
- Only retry `in_progress` tasks (not `pending`/`offered`)
- Tag retry tasks with `reboot-retry` for visibility
- Include in the boot triage status: "Task X was auto-retried (attempt 1/1)"

This takes the most common recovery action out of the lead's hands entirely.

### R4: Include pending/offered tasks in boot triage

After a reboot, `pending` and `offered` tasks are equally orphaned — the worker that was supposed to handle them is dead. `gatherSystemStatus()` should include these with a note: "These tasks were assigned to workers that are no longer active."

### R5: Strengthen heartbeat checklist prompt for failure triage

Change the checklist template instructions to be explicit about reboot failures:

```
1. Review the system status above for anything that needs attention.
2. **CRITICAL: Failures with reason "worker session not found" or "worker session heartbeat is stale" 
   indicate tasks that were INTERRUPTED by a restart.** These are NOT "expected auto-cleanup" — 
   they represent lost work. For each one, check what the task was (via get-task-details) and 
   re-create it if the work is still needed.
3. Review your standing orders for any periodic checks or actions.
...
```

### R6: Adopt the HEARTBEAT_OK response contract (OpenClaw pattern)

Add a guard: the lead cannot mark a heartbeat task as "All clear" if there are:
- Reboot-caused failures in the last 6 hours that haven't been triaged
- In-progress tasks with no active worker session

This can be enforced in the prompt ("Do NOT complete with 'All clear' if any failures with reason 'session not found' exist in the last 6 hours") or in the `store-progress` validation.

### R7: Evolve HEARTBEAT.md as a living runbook

Make it a first-class instruction (not buried in #6): "After every heartbeat check, update your standing orders via `update-profile` with `heartbeatMd`. Add new patterns you noticed, remove resolved items. This is your operational runbook — keep it current."

---

## Priority & Effort

| Priority | Recommendation | Effort | Impact |
|----------|---------------|--------|--------|
| P0 | R1: Fix timing gap | Medium (code) | Fixes boot triage seeing stale tasks as healthy |
| P0 | R2: Reboot-interrupted section | Medium (code) | Makes boot triage actionable instead of generic |
| P0 | R5: Strengthen checklist prompt | Low (template) | Stops lead from dismissing reboot failures |
| P1 | R3: Auto-retry reboot-killed tasks | Medium (code) | Removes lead from the critical recovery path |
| P1 | R4: Include pending/offered in triage | Low (code) | Catches orphaned non-in-progress tasks |
| P2 | R6: Guard against premature "All clear" | Low (template) | Prevents lead from skipping triage |
| P2 | R7: Evolve HEARTBEAT.md instruction | Low (template) | Long-term operational improvement |

---

## Implementation Plan

See [thoughts/taras/plans/2026-04-03-heartbeat-boot-triage.md](../plans/2026-04-03-heartbeat-boot-triage.md)
