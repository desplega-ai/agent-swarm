# Weekly GTM Metrics Review

A Friday afternoon schedule that compiles a GTM (go-to-market) metrics review from available analytics sources and posts it to a Slack channel. Surfaces top wins, regressions, and three recommended actions for the following week.

## What It Does

An analyst agent pulls available metrics (web analytics, CRM exports, sales data) and compiles a weekly review covering:
- Top wins: significant positive changes vs the prior week
- Regressions: metrics that declined and need attention
- Anomalous changes: unexpected spikes or drops requiring investigation
- Three recommended next actions based on the data

## Configuration

```json
{
  "name": "Weekly GTM metrics review",
  "cron": "0 14 * * 5",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "analyst",
  "enabled": false,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Prepare a weekly GTM review from the available analytics sources. Include top wins, regressions, anomalous changes, and three recommended next actions. Use placeholders or skip sections when data sources are not configured."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel for weekly reviews.

## Customization Notes

- **`enabled: false`** — keep disabled until data sources are configured. The agent will produce a placeholder report without live data, which isn't useful for recurring delivery.
- **Wire up data sources:** Add specific data access instructions to the task prompt. Examples:
  - `"Pull GSC data using the gsc-analytics skill for site:yourdomain.com"`
  - `"Fetch the weekly CRM export from agent-fs at docs/crm-weekly.csv"`
  - `"Use the PostHog API at {{POSTHOG_API_URL}} to pull weekly session and conversion metrics"`
- **Cron time:** `"0 14 * * 5"` = 2pm Fridays. Shift to your team's end-of-week rhythm — many teams prefer Thursday EOD to have time to act on insights before the weekend.
- **Analyst role:** Needs access to whatever data sources you configure. If those require Lead-only secrets, use `"agentRole": "lead"` or wire secrets via swarm config.

## When to Use

Enable this after your first two weeks with the swarm, once you have baseline metrics to compare against. Week 1 without a baseline produces an incomplete review.

## Trade-offs

**Data source dependency:** This schedule is only as good as its configured data sources. Without concrete access to analytics or CRM, it produces generic placeholder output. Invest time upfront to wire the actual data connections.

**Analyst vs researcher role:** "Analyst" is a role designation that maps to an agent with data-analysis capabilities. If your swarm doesn't have a dedicated analyst, `"agentRole": "researcher"` or `"lead"` works.
