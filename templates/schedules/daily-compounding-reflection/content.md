# Daily Compounding Reflection

An end-of-day schedule that converts the swarm's daily output into reusable knowledge. Runs at 5:30pm weekdays. The lead agent reviews what happened, identifies learnable patterns, and writes durable lessons to memory so future sessions don't repeat mistakes.

## What It Does

The lead agent reviews completed and failed tasks from the last 24 hours, then:
1. Identifies one reusable lesson (a pattern, anti-pattern, or technique that applied)
2. Flags one missing or stale skill that would have helped
3. Proposes one workflow improvement (a process change, not a code change)
4. Saves durable learnings to memory and posts a short summary with links

## Configuration

```json
{
  "name": "Daily compounding reflection",
  "cron": "30 17 * * 1-5",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "lead",
  "enabled": true,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Review completed and failed tasks from the last day. Identify one reusable lesson, one missing or stale skill, and one workflow improvement. Save durable learnings to memory and post a short summary with links."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel for reflection posts.

## Customization Notes

- **Time:** `"30 17 * * 1-5"` = 5:30pm weekdays. Shift to end-of-business in your timezone.
- **`agentRole: "lead"`** is required — the lead has full task history visibility.
- **Narrow the scope** by adding time windows to the task prompt: "tasks completed between 9am and 5pm today" prevents the agent from reviewing backlogged items.
- **Add skill creation** to the task: "If the missing skill gap is actionable, create a draft skill via `skill-create`." This turns reflections into automated skill authoring.

## When to Use

Enable this from day one. The compounding effect is real — after 30 days the swarm's memory will contain concrete lessons from real production incidents rather than generic guidelines.

## Trade-offs

**Discipline required:** This schedule works best when the swarm is actually doing real work. On quiet days the reflection will be thin. On very busy days it may surface too many lessons — cap to "top 1 of each" to keep posts scannable.

**Lead-only:** Only the lead can see the full task history and write to memory. Worker agents can't run this schedule effectively.
