# Daily Hacker News Briefing

A daily morning research digest that scrapes Hacker News and posts the most relevant stories to a Slack channel. Good as both a useful team resource and a demo that shows the swarm doing real research work on a predictable schedule.

## What It Does

A researcher agent visits Hacker News, identifies the top stories relevant to software engineering teams, and posts a short summary with links. Each brief covers why each story matters and whether it warrants further reading.

## Configuration

```json
{
  "name": "Daily HN briefing",
  "cron": "0 8 * * 1-5",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "researcher",
  "enabled": false,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Review current technology discussions on Hacker News. Summarize five items relevant to software teams, why they matter, and any follow-up reading. Keep it factual and include source links."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone (e.g., `"America/New_York"`, `"Europe/Madrid"`).
- `{{SLACK_CHANNEL_ID}}` — The Slack channel ID for briefing delivery.

## Customization Notes

- **`enabled: false`** — start disabled; flip to `true` when you're ready. The schedule fires on every container restart if enabled.
- **Researcher role:** this task needs WebFetch or browser scraping. Assign a researcher-capable agent.
- **Adjust the topic focus:** swap "software teams" for "AI infrastructure", "developer tools", or your team's specific domain. The agent will filter stories accordingly.
- **Change item count:** `"five items"` can be 3 (concise) or 10 (exhaustive). The Slack post gets long with more than 7.
- **HN access note:** Hacker News occasionally blocks datacenter IPs. If the researcher gets blocked, the `browser-use-cloud` skill is the fallback — but add that to the task prompt explicitly or the agent won't know to try it.

## When to Use

Use this as your first "show me the swarm works" demo for a new team. It produces real value (daily news briefing) with low risk (no write operations, no external state).

## Trade-offs

**Coverage vs noise:** 5 items is a good balance. Too few feels arbitrary; too many becomes a firehose. The researcher agent will vary in story selection between runs — that's expected.

**Scraping reliability:** HN is relatively stable HTML but occasionally the agent gets a different layout or bot-check. Expect occasional empty runs (the agent will post "no stories surfaced" rather than hallucinate).
