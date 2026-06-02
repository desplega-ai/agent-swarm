# Scheduled Task Resilience

When writing, retrying, or running a scheduled/cron task that polls or waits on a long-running operation, follow these hard rules. Multiple confirmed heartbeat-kill incidents (Apr 24, Apr 25, May 1, May 3, May 26, 2026) prove they matter.

## Rule 1 — NEVER `ScheduleWakeup` with `delaySeconds >= 300`

**Why:** The runtime's heartbeat staleness threshold sits near the same window as the Anthropic prompt-cache TTL (~5 min). Sleeping 300s+ in `ScheduleWakeup` mode looks identical to a dead worker — the heartbeat sweep kills your task mid-poll.

**Confirmed incidents:**
- `e2892d4a` (daily-docs Apr 24 02:58 UTC) — polling CI for PR #366
- `c7790626` (daily HN briefing Apr 25 02:53 UTC) — polling browser scrape

**Do this instead:**
- For polls under 4 minutes, use `Bash` with a short `sleep` loop (≤270s per iteration), then re-check.
- For genuinely long waits (CI builds, releases, deploys), prefer the workflow scheduler (`patch-workflow`) over `ScheduleWakeup`.
- 270s is the sweet spot: it stays in the prompt cache *and* under the heartbeat ceiling.

```bash
# Good — short sleep, frequent re-check
for i in 1 2 3 4 5; do
  status=$(gh pr checks "$PR" --json state --jq '.[0].state')
  [ "$status" = "SUCCESS" ] && break
  sleep 240
done
```

## Rule 2 — Tag retry tasks with `reboot-retry`

**Why:** Apr 22 reboot-loss `f2260faa` (Zynap investigation) was re-delegated manually because it lacked the `reboot-retry` tag. Boot-sweep missed it. Cost: ~4h of investigation re-work.

**Do this:**
- Any task auto-retried after a session loss MUST have `reboot-retry` in its tags.
- If you re-create a lost task manually, add the tag yourself so the next boot-sweep treats it correctly.

## Rule 3 — Long polls must `store-progress` every 2-3 minutes

**Why:** The heartbeat sweep marks tasks "stale" after ~5 min without an update. Workers polling silently look like dead workers.

**Do this:**
- Inside any polling block, call `store-progress` with a status string like `"polling CI status (attempt 3/10)"`.
- Even if nothing has changed, the heartbeat update keeps the runtime confident.

## Rule 4 — When a scheduled task fails, check the failure mode before retrying

**Why:** Two instant failures with the same reason (`worker session heartbeat is stale`) = infrastructure problem, not transient. Don't re-create a 3rd instance — escalate.

**Do this:**
- Lead-level: if a scheduled task fails 2× with the same reason, post a #swarmillo escalation; do NOT re-create.
- Worker-level: if you see repeated heartbeat-kill on your own retries, swarm-chat the lead instead of re-spawning yourself.

## Rule 5 — Pre-flight check for duplicate scheduled posts

**Why:** Concurrent sessions sometimes pick up the same scheduled task. Without a check, you double-post to Slack/email.

**Do this:**
- Before posting any scheduled output (Slack, email, blog), call `get-tasks` and search Slack history for the same schedule tag in the last hour.
- If a recent completion already happened, abort with `store-progress` noting the duplicate detection.

## Rule 6 — Post-shipping: do NOT `ScheduleWakeup` after the deliverable lands. Complete and exit.

**Why:** Even at the safe ≤270s window, if your last meaningful work was a shipping verb ("📤 PR #N pushed", "✅ Committed", "📌 Review posted") and you `ScheduleWakeup` to "wait for CI" or "monitor merge", the heartbeat reaper still treats your suspended session as dead. The task auto-fails with `failureReason: "Auto-failed by heartbeat: worker session not found (no active session for task)"` even though your work shipped.

**Confirmed incidents (2026-05-03):**
- `aa8a8eb7` Picateclas (PR #415 db-query) — `📤 PR #415 pushed` at 11:20:53 UTC, reaped at 11:31:57 UTC after 4.5min wakeup. Task auto-failed; PR was already pushed, reviewed, merged.
- `48460149` and `6d684da4` (May 1, bump-pr workflow) — both reaped during ScheduleWakeup post-rebase poll.
- Reviewer review-pr tasks `8d1320a6`/`6a17ff00` — same reaper pattern, but legitimate (mid-review, not post-shipping).

**Do this instead — choose ONE based on context:**

1. **Workflow-driven tasks (workflowRunId is set):** Call `store-progress` with `status: "completed"` and the deliverable info, then exit. The workflow's next node will pick up CI/merge state on its own poll cadence. Do NOT keep the worker session alive to babysit it.

2. **Slack-driven tasks needing CI confirmation:** Reply to the Slack thread with the PR URL + "CI in flight, will update if red" and complete the task. Lead will spawn a follow-up if CI goes red. Do NOT wait in-process.

3. **If you genuinely must wait in-process** (rare): use `sleep 240` in Bash with `store-progress` every iteration, NOT `ScheduleWakeup`. ScheduleWakeup suspends the session; Bash sleep keeps it active.

**The mental model:** ScheduleWakeup is for "I'm in the middle of work and need to wait briefly." It is NOT for "I'm done shipping but want to confirm downstream state." Once you've shipped, exit.

**Memory reference:** `heartbeat-reaper-after-shipping-pattern-2026-05-04`.

## Rule 7 — External async-API jobs (Enginy actions, Browser-Use, large lead pulls): fire-then-followup, never block one session for 30+ min

**Why:** A worker session is not a durable job runner. Holding it open to poll a slow external async API for tens of minutes looks like a stalled worker — the heartbeat reaper kills it even when credits/work are in flight. This is the same reaper as Rules 1/3/6, but the trigger is a *regular* (often Slack/MCP-originated) task with a long foreground OR background poll loop, not a ScheduleWakeup.

**Confirmed incident (2026-05-26):** Enginy founder-pull (Researcher, `9a6e5e96`, source:mcp) auto-failed at ~41 min — `failureReason: "Auto-failed by heartbeat: worker session heartbeat is stale (likely crashed)"`. 15 credits spent, 369 companies queued across 3 actions, a "guarded background poll" running — but the session died before collect+filter+deliver, so the spend produced no delivered artifact. Two sibling Enginy pulls (`7e90ca44`, `19670e93`) died the same way the same day.

**Do this instead:**
1. Fire the async actions (Enginy `actions`, Browser-Use tasks, etc.).
2. `store-progress` the action/task IDs + destination list IDs + a one-line resume recipe.
3. Persist the same to agent-fs (or a memory file) so it survives a crash.
4. Complete, or let Lead schedule a follow-up that picks up the IDs and does the (cheap, idempotent) collect+filter+dedup+deliver in a fresh session. The collect/filter steps are free and re-runnable.

**Lead routing implication:** when delegating a task with a >20-min external poll, split it into a "fire" task + a "collect+deliver" follow-up, or instruct the worker to use fire-then-followup. Don't dispatch one long blocking task and expect a single session to survive the wait.

**Memory reference:** `long-running-external-poll-session-crash-2026-05-27`, `enginy-search-leads-no-keyword-filter-gotcha-2026-05-27`.

