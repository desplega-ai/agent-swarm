# Weekly Dependency Triage

Review dependency update PRs, group safe patches, and flag risky upgrades.

## Schedule

```json
{
  "cron": "40 3 * * 0",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is the full task prompt the schedule runs on each fire — including the accumulated operational learnings baked into it. Adapt the swarm-specific references (channel IDs, agent names, repo paths) to your environment before enabling.

Triage dependabot PRs from https://github.com/desplega-ai/desplega.ai/pulls

## Instructions

1. **List all open dependabot PRs** in desplega-ai/desplega.ai using `gh pr list`
2. **Only paths we care about**: `/be` and `/new-fe`. Close all other dependabot PRs (ones that don't touch these paths).
3. **DO NOT touch non-dependabot PRs** — leave them as-is.
4. **Create two unified PRs** that merge all dependabot bumps into one PR each:
   - One for `/be` changes — branch name format: `YYYY-MM-DD-dependabot-be` (use today's date)
   - One for `/new-fe` changes — branch name format: `YYYY-MM-DD-dependabot-fe` (use today's date)
   - Each unified PR should be based on latest `main` and include all the dependency bumps from the individual dependabot PRs for that path.
   - After creating the unified PRs, close the individual dependabot PRs that were merged into them.
5. **Return the URLs** of the two final unified PRs.
6. If there are no open dependabot PRs, just report that and complete.

## Approach

- Clone the repo, checkout main, pull latest
- For each path (be, new-fe): create a branch, cherry-pick or merge the dependabot changes, push, create PR
- Close individual dependabot PRs after unifying
- Be careful: some dependabot PRs may have conflicts — handle gracefully

## Important
- The PR title should be descriptive, e.g. "chore(be): consolidate dependabot bumps YYYY-MM-DD"
- Add @tarasyarema as reviewer on both PRs
- Post the final PR URLs back to Slack
