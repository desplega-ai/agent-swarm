---
name: scheduled-task-resilience
description: Guardrails for polling, scheduled jobs, and long-running external operations. Use whenever a task waits on CI, builds, deploys, browser jobs, or another asynchronous API so work survives heartbeat checks without duplicate delivery.
---

# Scheduled Task Resilience

Use these rules whenever a scheduled or regular task polls or waits on a long-running operation. They prevent heartbeat collisions, lost work, duplicate delivery, and sessions that fail after holding an external job open too long.

## Rule 1 — Never use `ScheduleWakeup` with `delaySeconds >= 300`

The runtime heartbeat staleness threshold may sit near the same window as the model prompt-cache TTL. Sleeping for five minutes or longer can therefore look like a dead worker and cause the heartbeat sweep to fail the task mid-poll.

Instead:

- For waits under four minutes, run **one** bounded sleep of at most 240 seconds followed by a **single** status check, as one shell call, then return control to the agent turn.
- **Never batch sleeps into a single shell invocation.** A loop of five 240-second sleeps blocks the session for twenty minutes with no opportunity to record progress — the same staleness failure `ScheduleWakeup` causes, just spelled differently.
- Between cycles, record progress as described in Rule 3, then start the next cycle in the next turn.
- For genuinely long waits such as CI builds, releases, or deploys, prefer a durable workflow or a follow-up task over `ScheduleWakeup`.

Aggregate **every** check run before you decide the poll is over. Reading a single row such as `.[0].state` reports one check and can look terminal while another required check is still pending or failing.

```bash
# ONE cycle per agent turn. Resolve PR_NUMBER from the current task or repository context.
sleep 240
if out=$(gh pr checks "$PR_NUMBER" --json name,state,bucket \
      --jq 'if   any(.[]; .bucket == "pending") then "PENDING"
            elif any(.[]; .bucket == "fail" or .bucket == "cancel") then "FAILING"
            else "PASSED" end' 2>&1); then
  echo "$out"
else
  case "$out" in
    *"no checks reported"*) echo "PENDING" ;;  # no check contexts yet — not a failure
    *) echo "$out" >&2; exit 1 ;;              # real gh error: auth, network, bad PR
  esac
fi
```

⚠️ Do not substitute the exit code for the aggregate here. Plain `gh pr checks <pr>` exits `8` while any check is pending and `1` on failure, but **`--json` suppresses that — it exits `0` even mid-run** (verified on gh 2.97.0). A cycle that adds `--json` and then reads `$?` reports success on a still-pending PR, which is the exact bug the aggregate exists to prevent.

⚠️ Treat `no checks reported` as `PENDING`, not as a failure. Right after a PR is opened or a new commit is pushed, GitHub can briefly report zero check contexts. In that window `gh pr checks` exits `1` and prints `no checks reported on the '<branch>' branch` **before** the `--json` exporter runs, so the aggregate never executes at all (verified on gh 2.97.0). A cycle that treats any non-zero exit as failure will stop polling — or report CI as broken — before the workflows have even appeared. That is why the sample branches on the error text instead of on the exit status alone.

Handle each aggregate distinctly: `PASSED` means polling is done. For `PENDING`, call `store-progress`, then run one more cycle in the next turn; cap the number of cycles and hand off to a follow-up task once the total wait approaches the heartbeat staleness threshold. For `FAILING`, stop polling immediately, inspect the failed checks with `gh pr checks <pr> --json name,state,bucket` and the run logs, then report or fix the failure — never sleep again on a failing aggregate.

## Rule 2 — Tag retry tasks with `reboot-retry`

Any task automatically retried after a session loss must include `reboot-retry` in its tags. If you recreate a lost task manually, add the same tag so the deployment's boot-sweep logic can identify it correctly.

Resolve the original task from the current task's parent or retry metadata. Do not copy a task ID from another incident or deployment.

## Rule 3 — Long polls must store progress every two to three minutes

Workers that poll silently can look stale to the heartbeat sweep.

After every poll cycle — that is, after each shell call that sleeps and checks once — call `store-progress` with a concrete progress message such as `polling CI status (attempt 3/10)`. Even when the remote state has not changed, the progress update records that the worker is still active. This is only possible because each cycle returns control to the agent turn, which is why Rule 1 forbids batching sleeps.

Resolve the active task ID from the current task context. Never embed an agent ID, task ID, organization ID, or other deployment-specific identifier in a reusable polling script.

## Rule 4 — Diagnose repeated scheduled-task failures before retrying

Two immediate failures with the same heartbeat-staleness reason usually indicate an infrastructure or lifecycle problem, not a transient job failure. Do not create a third identical attempt.

- A worker should use the swarm's escalation channel or task handoff mechanism to report repeated heartbeat termination.
- A lead should resolve the configured operator escalation destination from deployment or task metadata rather than hardcoding a Slack channel.
- Include the affected task IDs in the incident report by reading them from the failed task records at runtime.

## Rule 5 — Check for duplicate delivery before posting

Concurrent sessions can pick up equivalent scheduled work. Before sending scheduled output to Slack, email, a blog, or another external destination:

1. Query recent tasks using the current schedule ID or schedule tag.
2. Search the destination history for an equivalent delivery in the relevant time window.
3. If a recent completion already delivered the result, stop and record the duplicate detection with `store-progress`.

Derive the schedule ID, destination, and time window from the current task and schedule records. Do not reuse identifiers or recipient addresses copied from another task.

## Rule 6 — After the deliverable ships, complete and exit

Do not call `ScheduleWakeup` merely to watch CI, a merge, or another downstream state after the requested deliverable already exists. A suspended post-shipping session can still be reaped and mark successful work as failed.

Choose one path:

1. **Workflow-driven task:** call `store-progress` with `status: "completed"` and the deliverable details, then exit. Let the workflow's next node handle downstream state.
2. **Human-requested task needing later confirmation:** report the deliverable URL and current downstream status, complete the task, and let the lead or automation create a follow-up if the downstream check fails.
3. **Rare in-process wait:** use the single-cycle sleep-then-check pattern from Rule 1, storing progress between cycles. Do not suspend the session with `ScheduleWakeup`, and do not batch sleeps into one shell call.

The key distinction is whether work remains. `ScheduleWakeup` is only for a brief wait in the middle of active work; it is not a post-delivery monitoring mechanism.

## Rule 7 — Use fire-then-follow-up for slow external jobs

A worker session is not a durable job runner. Polling an external asynchronous API for tens of minutes can outlive the worker heartbeat even when the external job continues successfully.

For browser automation, large data pulls, media processing, or any other external job expected to exceed roughly 20 minutes:

1. Start the external actions.
2. Store the returned action or task IDs, destination IDs, and a one-line resume recipe with `store-progress`.
3. Persist the same recovery state in agent-fs, a durable workflow step, or another deployment-approved store.
4. Complete the fire step and run collection, filtering, deduplication, and delivery in a fresh follow-up task.

Resolve every identifier from the external API response and current task metadata. Never bake a prior run's IDs into the skill or follow-up template.

When historical incident detail is useful, search the deployment's memory registry for heartbeat-reaper and long-running external-poll records instead of depending on copied task IDs or worker names.
