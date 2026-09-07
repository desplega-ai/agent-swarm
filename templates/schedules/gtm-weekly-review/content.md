Template parameters: {{REPO_URL}}, {{GSC_PROPERTY}}

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

This is the full task prompt the schedule runs on each fire. It uses the declared repository and Search Console property.

Task Type: Research
Topic: Weekly GTM Metrics Review for your product

Goal: Check current GitHub stars, traffic, Google Search Console performance, and content metrics for the GTM campaign.

Instructions:
Before running commands, initialize the validated template values as quoted shell variables. Run the remaining commands in the same shell session, and use only quoted variable expansions.

Normalize the validated GitHub repository value once:
```bash
REPO_URL='{{REPO_URL}}'
GSC_PROPERTY='{{GSC_PROPERTY}}'
REPO_SLUG="${REPO_URL#https://github.com/}"
REPO_SLUG="${REPO_SLUG#git@github.com:}"
REPO_SLUG="${REPO_SLUG%/}"
REPO_SLUG="${REPO_SLUG%.git}"
```

1. Check GitHub metrics: `gh api "repos/$REPO_SLUG"` (stars, forks, issues)
2. Check traffic: `gh api "repos/$REPO_SLUG/traffic/views"` and `gh api "repos/$REPO_SLUG/traffic/clones"`
3. Check referrers: `gh api "repos/$REPO_SLUG/traffic/popular/referrers"`
4. Check popular content: `gh api "repos/$REPO_SLUG/traffic/popular/paths"`

5. **Pull Google Search Console data** using the configured `gsc` integration. Do not write credential-handling code.

   Pull the weekly snapshot for each configured site:
   ```bash
   GSC=gsc
   read -r -a gsc_properties <<< "$GSC_PROPERTY"
   for site in "${gsc_properties[@]}"; do
     echo "=== $site ==="
     case "$site" in
       sc-domain:*|https://*) property="$site" ;;
       *) property="sc-domain:$site" ;;
     esac
     safe_site=$(printf '%s' "$site" | tr -c 'A-Za-z0-9._-' '_')
     "$GSC" analytics "$property" --top 20 --json > "/tmp/gsc-$safe_site.json"
     jq '{current, previous, window, prior,
          top_queries: [.topQueries[:10][] | {q: .keys[0], c: .clicks, i: .impressions, ctr: .ctr, pos: .position}],
          top_pages:   [.topPages[:10][]   | {p: .keys[0], c: .clicks, i: .impressions, ctr: .ctr, pos: .position}]
         }' "/tmp/gsc-$safe_site.json"
   done
   ```

   The `analytics` subcommand returns headline KPIs (clicks, impressions, CTR, avg position) PLUS a WoW comparison against the prior 7 days — this is what powers the "this week vs last week" section of the report.

6. Review the installation's configured GTM plan or state artifact.
7. Compile a brief report with:
   - Current star count, weekly change
   - Top traffic sources
   - **GSC summary**: total clicks/impressions across all domains, top performing queries, queries with growth potential (high impressions, low CTR or position 5-20)
   - What's working, what to try next
   - **SEO opportunities**: queries where we're close to page 1, content gaps to fill

Post the final report through configured admin delivery channels, using the in-app fallback when no external channel is configured, and save it in the deployment's configured research workspace.

This is part of your team's GTM goal; update the goal statement before enabling the schedule.
