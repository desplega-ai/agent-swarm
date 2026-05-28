# Daily Workflow Health Audit

A morning audit that catches failing, stale, or noisy automation before it becomes a real problem. Runs at 8:15am weekdays (slightly after the blocker digest to give a sequential view of the day).

## What It Does

The lead agent inspects recent scheduled task and workflow runs, then identifies and categorizes issues:
- **Failing:** runs that errored or were halted
- **Stale:** schedules that should have fired but haven't recently
- **Duplicated:** the same schedule firing multiple overlapping runs
- **Noisy:** automation producing low-signal or empty output repeatedly

For each issue, the agent includes impact, likely cause, and a recommended action (retry, disable, fix, or escalate).

## Configuration

```json
{
  "name": "Daily workflow health audit",
  "cron": "15 8 * * 1-5",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "lead",
  "enabled": true,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Inspect recent scheduled task and workflow runs. Flag failing, stale, duplicated, or noisy automation. For each issue, include impact, likely cause, and whether to retry, disable, fix, or escalate."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel for audit posts.

## Customization Notes

- **Pair with the blocker digest:** The blocker digest runs at 9am; this audit at 8:15am. The lead sees automation health first, then task blockers.
- **Add a lookback window:** `"runs from the last 24 hours"` in the task prompt scopes the audit and avoids reviewing old history.
- **Escalation path:** Add `"if you find a critically failing schedule, post to {{OPS_CHANNEL_ID}} separately"` to route urgent issues to a different channel.
- **Frequency:** Daily is right for active swarms. For lighter usage, change to `"0 9 * * 1"` (Monday only).

## When to Use

Enable this from day one when you have more than 3 scheduled tasks. Without it, a failing schedule can silently miss runs for weeks before anyone notices.

## Trade-offs

**False positives:** The agent may flag one-off failures as "stale" if they're within the lookback window. Tune the task prompt to distinguish "failed once" (acceptable) from "failed 3+ times in a row" (needs action).

**Lead-only:** Full workflow run history is only visible to the lead. Worker agents cannot run this effectively.
