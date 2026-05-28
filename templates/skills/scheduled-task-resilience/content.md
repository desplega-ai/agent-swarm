# Scheduled Task Resilience

When writing, retrying, or running a scheduled/cron task that polls or waits on a long-running operation, follow these hard rules. Multiple confirmed heartbeat-kill incidents prove they matter.

## Rule 1 — NEVER `ScheduleWakeup` with `delaySeconds >= 300`

**Why:** The runtime's heartbeat staleness threshold sits near the Anthropic prompt-cache TTL (~5 min). Sleeping 300s+ looks identical to a dead worker — the heartbeat sweep kills your task mid-poll.

**Do this instead:**
- For polls under 4 minutes, use `Bash` with a short `sleep` loop (≤270s per iteration).
- For genuinely long waits (CI builds, deploys), prefer the workflow scheduler over `ScheduleWakeup`.
- **270s is the sweet spot:** stays in the prompt cache AND under the heartbeat ceiling.

```bash
# Good — short sleep, frequent re-check
for i in 1 2 3 4 5; do
  status=$(gh pr checks "$PR" --json state --jq '.[0].state')
  [ "$status" = "SUCCESS" ] && break
  sleep 240
done
```

## Rule 2 — Tag Retry Tasks with `reboot-retry`

Any task auto-retried after a session loss MUST have `reboot-retry` in its tags. If you re-create a lost task manually, add the tag yourself so the next boot-sweep treats it correctly.

## Rule 3 — Long Polls Must `store-progress` Every 2–3 Minutes

Inside any polling block, call `store-progress` with a status string like `"polling CI status (attempt 3/10)"`. Even if nothing has changed, the heartbeat update keeps the runtime confident.

## Rule 4 — When a Scheduled Task Fails, Check the Failure Mode Before Retrying

Two instant failures with the same reason (`worker session heartbeat is stale`) = infrastructure problem, not transient. Don't re-create a 3rd instance — escalate.

## Rule 5 — Pre-flight Check for Duplicate Scheduled Posts

Before posting any scheduled output (Slack, email, blog), call `get-tasks` and search Slack history for the same schedule tag in the last hour. If a recent completion already happened, abort with `store-progress` noting the duplicate detection.

## Rule 6 — Post-Shipping: Do NOT `ScheduleWakeup`. Complete and Exit.

If your last meaningful work was a shipping verb ("📤 PR #N pushed", "✅ Committed") and you `ScheduleWakeup` to "wait for CI", the heartbeat reaper treats your suspended session as dead.

**Do this instead:**
1. **Workflow-driven tasks:** Call `store-progress` with `status: "completed"` and exit. The workflow's next node handles CI polling.
2. **Slack-driven tasks:** Reply to the Slack thread with the PR URL + "CI in flight, will update if red" and complete the task.
3. **If you genuinely must wait in-process:** use `sleep 240` in Bash with `store-progress` every iteration, NOT `ScheduleWakeup`.

**Mental model:** `ScheduleWakeup` is for "I'm mid-work and need to wait briefly." It is NOT for "I'm done shipping but want to confirm downstream state." Once you've shipped, exit.

## Rule 7 — External Async APIs: Fire-then-Follow-up, Never Block One Session for 30+ min

For Browser-Use cloud tasks, Enginy actions, large lead/founder pulls — fire the async actions, persist the action IDs to `store-progress` and agent-fs, then complete. Let Lead schedule a follow-up that picks up the IDs and does the cheap collect+filter+deliver in a fresh session.

**Why:** A worker session held open for 30+ min polling a slow external API looks like a stalled worker — the heartbeat reaper kills it even when credits/work are in flight.

## Trade-offs

**`sleep 240` vs `ScheduleWakeup`:** Bash sleep keeps the session active (heartbeat continues); `ScheduleWakeup` suspends the session (heartbeat pauses and risks the 5-min stale threshold). Use Bash sleep for in-process waits.

**Fire-then-followup pattern:** Splits work across two sessions, adding latency. The alternative — one long session — risks losing all work to a heartbeat kill. The split is the right trade.
