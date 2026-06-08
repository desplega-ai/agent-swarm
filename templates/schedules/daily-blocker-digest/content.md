# Daily Blocker Digest

Ask the lead to summarize stuck work, failing checks, and owner decisions every weekday.

## Schedule

```json
{
  "cron": "5 2 * * *",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is a reusable starting prompt. Before enabling it, adapt the placeholder repo list, Slack channel, owner mentions, memory paths, and escalation rules to your swarm. As you learn from real incidents, expand this template with your own local runbook notes instead of assuming these defaults cover every environment.

Task Type: Daily Blocker Digest

You are Lead. Produce one concise daily digest of blockers, stale claims, open PRs, and stuck work. Verify current state before escalating anything.

---

## Phase 0: Seeded Data-Gathering

Run these read-only global scripts first. Use their outputs as evidence, then apply judgment:

1. `script-run` global script `Heartbeat Audit` with args `{ "heartbeatMarkdown": "<current /workspace/HEARTBEAT.md text>" }`
2. `script-run` global script `schedule-health` with args `{ "days": 7, "publishPage": true }`
3. `script-run` global script `task-failure-audit` with args `{ "days": 7, "groupBy": "reason", "publishPage": true }`

Do not script-ify judgment or notification copy. Use the script outputs to identify stale blocker claims, schedule risks, provider failure clusters, and digest-run health.

## Phase 1: Gather Blockers

### 1A. HEARTBEAT.md active blockers

Read `/workspace/HEARTBEAT.md`. Extract every bullet under "Active Blockers" or a similar section. Treat each item as a claim that must be verified, not as ground truth.

### 1B. Open PRs across tracked repositories

Replace the repo list below with repositories your team wants in the digest:

```bash
for repo in owner/repo-one owner/repo-two owner/repo-three; do
  gh pr list --repo "$repo" --state open --json number,title,author,createdAt,url,reviewDecision,isDraft,labels 2>/dev/null | jq --arg repo "$repo" '.[] | . + {repo: $repo}'
done
```

Compute `daysOpen` from `createdAt`. Split PRs into buckets:
- **Dependency updates**: author.login is `dependabot` or `app/dependabot`
- **Security dependency updates**: dependency PRs with "critical", "high", "security", or "vulnerability" in title or labels
- **Stale**: 60+ days open
- **Aging**: 30-59 days open
- **Recent**: fewer than 30 days open

Format every PR link as `<URL|repo #NUM>` so the digest is clickable.

### 1C. Tasks awaiting user reply

Use `db-query`:

```sql
SELECT id, task, slackUserId, createdAt
FROM agent_tasks
WHERE slackReplySent = 1
  AND status = 'completed'
  AND requestedByUserId IS NOT NULL
  AND datetime(createdAt) > datetime('now', '-7 days')
ORDER BY createdAt DESC
LIMIT 20
```

### 1D. Stuck in-flight tasks

Use `get-tasks` with `status=in_progress`. Flag any task with no update for more than 2 hours. Cross-check against the seeded script outputs before escalating.

---

## Phase 2: Verify Each Claim

For each blocker claim, run a quick verification:
- PR numbers: check whether the PR is still open or already merged
- API/key issues: test the actual API or check the current config status
- "Awaiting response" items: check the relevant thread for newer replies
- Worker-activity claims: check the current task status

Do not trust stale notes. If verification shows the item is resolved, mark it `RESOLVED-STALE` and remove it from the source note in Phase 4.

---

## Phase 3: Post One Digest

Post one message to your team's chosen channel. Replace `<OWNER_OR_TEAM_MENTION>` and `<CHANNEL_ID>` before enabling this schedule.

Template:

```text
:clipboard: *Daily Blocker Digest + PR Review* — [YYYY-MM-DD]

<OWNER_OR_TEAM_MENTION> Here's the daily digest.

*Active blockers* (N verified real, M stale)
• <PR or task link> — <title> — [verified: still open]
• ~~<stale item>~~ — RESOLVED-STALE, removed from source notes

*Stale PRs (60+ days)*
1. <url|repo #NUM> — <title> (X days) — @author

*Aging PRs (30-59 days)*
1. <url|repo #NUM> — <title> (X days) — @author

*Recent PRs*
1. <url|repo #NUM> — <title> (X days) — @author

*Security dependency updates*
• <url|repo #NUM> — <bump text>

*Tasks awaiting user reply* (N)
• <task summary> — from @<userId>

*Stuck in-flight* (N, >2h no update)
• <task id> — <age>

---
Dependency update PRs pending: X
Stale source-note items removed this run: Y
```

If everything is clean, say: "All clear — no blockers, no stuck tasks, only routine dependency-update churn."

---

## Phase 4: Clean Source Notes

For each item marked `RESOLVED-STALE`:
- Remove or update the stale line in the source note, such as `/workspace/HEARTBEAT.md`
- Save a memory noting how the stale state was detected, so future runs can catch the same pattern sooner

---

## Phase 5: Save a Receipt

Write a memory titled `daily-blocker-digest-YYYY-MM-DD.md` with:
- Verified blockers that are still real
- RESOLVED-STALE items removed
- Summary counts: total open PRs, stale count, aging count, dependency-update count
- Patterns noticed and template improvements worth adding

---

## Anti-patterns

- Copying HEARTBEAT or source notes verbatim without verifying each line
- Raw PR numbers instead of clickable `<url|repo #N>` links
- Listing all dependency-update PRs inline when a count is enough
- Marking things RESOLVED-STALE without evidence
- Skipping source-note cleanup

## Completion

Call `store-progress` with status `completed` and an output paragraph covering verified blockers, stale items removed, PR counts, and any follow-up needed.
