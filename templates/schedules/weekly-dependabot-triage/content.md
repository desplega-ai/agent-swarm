# Weekly Dependency Triage

A Monday morning schedule that reviews dependency update PRs (Dependabot, Renovate, or equivalent) and posts a triage plan to Slack. Groups low-risk updates, calls out major upgrades requiring human review, and proposes a safe merge order.

## What It Does

The lead agent reviews open dependency update PRs for the target repository, then:
- Groups **patch/minor updates** as safe to batch-merge
- Flags **major version upgrades** with a note on breaking-change risk
- Checks for **security advisories** (critical ones get top priority)
- Proposes a merge order that minimizes conflict risk

**The agent does NOT merge.** It proposes — humans approve and merge.

## Configuration

```json
{
  "name": "Weekly dependency triage",
  "cron": "0 10 * * 1",
  "timezone": "{{TIMEZONE}}",
  "agentRole": "lead",
  "enabled": true,
  "slackChannelId": "{{SLACK_CHANNEL_ID}}",
  "task": "Review dependency update PRs for {{REPO_URL}}. Group low-risk patch/minor updates, call out major upgrades requiring human review, and propose a merge order. Do not merge unless explicitly authorized."
}
```

**Placeholders to configure:**
- `{{TIMEZONE}}` — Your local timezone.
- `{{SLACK_CHANNEL_ID}}` — The Slack channel for triage reports.
- `{{REPO_URL}}` — The GitHub/GitLab repo URL to triage (e.g., `"https://github.com/your-org/your-repo"`).

## Customization Notes

- **Multiple repos:** Duplicate the schedule with different `REPO_URL` values, or modify the task prompt to loop over a list: `"Review dependency update PRs for: {{REPO_URL_1}} and {{REPO_URL_2}}."`.
- **Authorization to merge:** If you trust the swarm to auto-merge patch updates, change the last sentence to `"Auto-merge patch and minor updates that pass CI. Flag major upgrades for human review."` — but only after the pattern has been validated on your stack.
- **Security PRs:** Add `"Prioritize any PRs tagged with security advisories — post them as urgent even if it's not Monday."` to get out-of-schedule security alerts.
- **Frequency:** Weekly is right for most repos. For fast-moving dependencies, `"0 10 * * 1,4"` (Monday + Thursday) reduces PR accumulation.

## When to Use

Enable this for any repo that has automated dependency updates enabled. Without triage, PRs accumulate and go stale, creating merge conflicts and missed security patches.

## Trade-offs

**Proposal only by default:** The agent proposes merges — humans approve. This is intentional; auto-merging dependencies has burned teams when CI passes but runtime behavior changes. Opt in to auto-merge only after establishing trust.

**GitHub-only:** The task uses `gh pr list` + `gh pr view`. For GitLab repos, modify the task prompt to use `glab mr list`.
