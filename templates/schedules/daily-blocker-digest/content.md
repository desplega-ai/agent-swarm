# Daily Blocker Digest

A morning summary of what's stuck and what action unblocks it. Runs on weekdays and posts to a Slack channel. This is the "are we making progress?" sanity check that prevents stalled tasks from staying invisible for days.

## What It Does

The lead agent reviews active tasks, open PRs, and recent failures, then posts a concise digest covering:
- Which items are blocked and who owns them
- What the blocking condition is (missing decision, failing check, waiting on dependency)
- The single next action needed to unblock each item

## Configuration

```json
{
  "name": "Daily blocker digest",
  "cron": "0 9 * * 1-5",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "lead",
  "enabled": true,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Review active tasks, open PRs, and recent failures. Post a concise blocker digest with: blocked item, current owner, missing decision or failing check, and the next action needed today. Keep it generic and avoid private customer data."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone (e.g., `"America/New_York"`, `"Europe/Madrid"`). Determines when "9am" fires relative to UTC.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel ID (e.g., `C0XXXXXXXXX`) where the digest should post.

## Customization Notes

- **Change the cron time** to match your team's standup cadence. `"0 9 * * 1-5"` = 9am weekdays.
- **`agentRole: "lead"`** is required — the lead agent has visibility into all tasks and Slack posting privileges.
- **`enabled: true`** — enable by default since this is a high-value operational schedule.
- Add `"repoUrl": "{{REPO_URL}}"` to the task prompt if you want the agent to include PR status for a specific repo.

## When to Use

Start with this schedule from day one. It prevents the "I thought someone else was handling it" problem and gives you a daily audit trail of swarm health.

## Trade-offs

**Signal-to-noise:** If the swarm is mostly idle, the digest may post "nothing blocked today" which is still valuable. If the swarm is very active with many concurrent tasks, the digest can get long — consider tightening the task prompt to "top 3 blockers only."

**Lead-only:** This schedule requires the lead agent role. Do not assign it to a worker — workers don't have visibility into the full task graph or Slack posting privileges.
