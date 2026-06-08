# Weekly GTM Metrics Review

Summarize product, marketing, or sales signals into an operator-friendly weekly review.

## Schedule

```json
{
  "cron": "20 3 * * 1",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is the full task prompt the schedule runs on each fire. Adapt the repositories, Search Console properties, report paths, and campaign goals to your environment before enabling.

Task Type: Research
Topic: Weekly GTM Metrics Review for your product

Goal: Check current GitHub stars, traffic, Google Search Console performance, and content metrics for the GTM campaign.

Instructions:
1. Check GitHub metrics: `gh api repos/owner/repo` (stars, forks, issues)
2. Check traffic: `gh api repos/owner/repo/traffic/views` and `/traffic/clones`
3. Check referrers: `gh api repos/owner/repo/traffic/popular/referrers`
4. Check popular content: `gh api repos/owner/repo/traffic/popular/paths`

5. **Pull Google Search Console data** using the `gsc-analytics` skill (already installed on this agent). Do NOT write Python auth code — use the `gsc` CLI at `/workspace/repos/agent-work/gsc/gsc`. The setup script already wires up `GOOGLE_APPLICATION_CREDENTIALS`, so no extra env setup needed.

   Pull the weekly snapshot for each configured site:
   ```bash
   GSC=/workspace/repos/agent-work/gsc/gsc
   for site in example.com docs.example.com; do
     echo "=== $site ==="
     $GSC analytics "sc-domain:$site" --top 20 --json > "/tmp/gsc-$site.json"
     jq '{current, previous, window, prior,
          top_queries: [.topQueries[:10][] | {q: .keys[0], c: .clicks, i: .impressions, ctr: .ctr, pos: .position}],
          top_pages:   [.topPages[:10][]   | {p: .keys[0], c: .clicks, i: .impressions, ctr: .ctr, pos: .position}]
         }' "/tmp/gsc-$site.json"
   done
   ```

   The `analytics` subcommand returns headline KPIs (clicks, impressions, CTR, avg position) PLUS a WoW comparison against the prior 7 days — this is what powers the "this week vs last week" section of the report.

6. Review the GTM plan at /workspace/shared/thoughts/shared/research/gtm-state-assessment.md
7. Compile a brief report with:
   - Current star count, weekly change
   - Top traffic sources
   - **GSC summary**: total clicks/impressions across all domains, top performing queries, queries with growth potential (high impressions, low CTR or position 5-20)
   - What's working, what to try next
   - **SEO opportunities**: queries where we're close to page 1, content gaps to fill

Save report to /workspace/shared/thoughts/shared/research/gtm-weekly-{date}.md

This is part of your team's GTM goal; update the goal statement before enabling the schedule.
