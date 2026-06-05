Task Type: Daily Blocker Digest — "Compound Prelude" (unified with PR review)

You are Lead. This runs 5 minutes before the compound evolution. Purpose: surface every item claimed to be "awaiting human" so the compound can detect stale-state items (blockers actually resolved but never removed), AND provide the single daily summary of open PRs. Rule from Taras (2026-04-22): verify, don't assume.

---

## Phase 0: Seeded Data-Gathering

Run these read-only global scripts first. Use them to gather deterministic cluster/routing data in one shot, then reason over the result:

1. `script-run` global script `Heartbeat Audit` with args `{ "heartbeatMarkdown": "<current /workspace/HEARTBEAT.md text>" }`
2. `script-run` global script `schedule-health` with args `{ "days": 7, "publishPage": true }`
3. `script-run` global script `task-failure-audit` with args `{ "days": 7, "groupBy": "reason", "publishPage": true }`

Do not script-ify judgment or Slack copy. Use the script outputs as evidence for stale PR claims, pool-target schedule risks, schedule/provider failure clusters, and digest-run health.

## Phase 1: Gather Blockers from 4 Sources

### 1A. HEARTBEAT.md "Active Blockers" section
Read `/workspace/HEARTBEAT.md`. Extract every bullet under "Active Blockers (awaiting Taras)" or similar. Each item is a claim of the form "X is broken/pending".

### 1B. Open PRs across all our repos — with clickable URLs
Use the `Heartbeat Audit` result for PRs cited in HEARTBEAT.md. For the full open-PR digest, loop over the repo list and gather ALL open PRs with their URL, age, review status, draft flag, labels, author.

```bash
for repo in desplega-ai/agent-swarm desplega-ai/agent-swarm-landing desplega-ai/landing desplega-ai/landing-labs desplega-ai/qa-use desplega-ai/agent-fs desplega-ai/chat-py desplega-ai/argus desplega-ai/argus-action desplega-ai/ai-toolbox desplega-ai/agent-work; do
  gh pr list --repo "$repo" --state open --json number,title,author,createdAt,url,reviewDecision,isDraft,labels 2>/dev/null | jq --arg repo "$repo" '.[] | . + {repo: $repo}'
done
```

Compute `daysOpen` from `createdAt`. Split PRs into buckets:
- **Dependabot**: author.login == "dependabot" or "app/dependabot" — handled separately at the bottom
- **Security dependabot**: any dependabot PR with "critical", "high", "security", or "vulnerability" in title or labels — list separately with :shield:
- **Stale** (60+ days open): :rotating_light: at the top
- **Aging** (30-59 days): :warning:
- **Recent** (<30 days): normal listing

Format every PR link as: `<URL|repo #NUM>` — always a clickable Slack link, never raw numbers.

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
Use `get-tasks` with status=in_progress. Flag any with `lastUpdatedAt` >2h old. Cross-check with the `Heartbeat Audit`, `schedule-health`, and `task-failure-audit` results before escalating.

---

## Phase 2: Verify Each Blocker Claim

For each claim in 1A, run a quick verification:
- PR numbers → check if merged (use gh pr view)
- API/key issues → test the actual API (curl + check response)
- "awaiting response from X" items → check Slack thread for newer messages
- Worker-activity claims → check the actual task status

Do NOT trust the HEARTBEAT wording. If verification shows the item is resolved, mark it `RESOLVED-STALE` and commit to removing from HEARTBEAT in Phase 4.

---

## Phase 3: Post Unified Digest to Slack

Use `slack-post` with channelId `C0A4J7GB0UD`, pinging `<@U08NR6QD6CS>`. Format:

```
:clipboard: *Daily Blocker Digest + PR Review* — [YYYY-MM-DD]

<@U08NR6QD6CS> Here's the combined morning digest.

*Awaiting Taras — HEARTBEAT blockers* (N verified real, M stale)
• PR link — <title> — [verified: still open]
• <other item> — [verified: status]
• ~~<stale item>~~ — RESOLVED-STALE, removed from HEARTBEAT

:rotating_light: *STALE PRs (60+ days)*
1. <url|repo #NUM> — <title> (X days) — @author

:warning: *AGING PRs (30-59 days)*
1. <url|repo #NUM> — <title> (X days) — @author

*Recent PRs*
1. <url|repo #NUM> — <title> (X days) — @author

:shield: *Security dependabot (merge soon)*
• <url|repo #NUM> — <bump text>

*Tasks awaiting user reply* (N)
• <task summary> — from @<userId>

*Stuck in-flight* (N, >2h no update)
• <task id> — <age>

---
_Also: X dependabot PRs pending (routine dependency bumps)_
_Stale HEARTBEAT items removed this run: N_
```

Keep it scannable. Every PR MUST be a clickable `<url|repo #N>` link. If everything is clean, say "All clear — no blockers, no stuck tasks, only routine dependabot churn."

---

## Phase 4: Clean HEARTBEAT.md

For each item marked `RESOLVED-STALE`:
- Remove the line from `/workspace/HEARTBEAT.md`
- Save a shared memory noting the stale-state catch (permanent receipt for the compound)

---

## Phase 5: Hand-off to Compound

Write a memory titled `daily-blocker-digest-YYYY-MM-DD.md` to `/workspace/shared/memory/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/` with:
- List of all verified blockers (still real) with PR URLs
- List of RESOLVED-STALE items removed this run
- Summary counts: total PRs open, stale count, aging count
- Any patterns noticed ("I keep forgetting X finished shipping on date Y")

The compound evolution runs 5 minutes after this. Its Phase 0 reads this memory via `memory-search "daily-blocker-digest"`.

---

## Anti-patterns

- ❌ Copying HEARTBEAT verbatim without verifying each line
- ❌ Raw PR numbers instead of clickable `<url|repo #N>` links
- ❌ Listing all dependabot PRs inline — collapse into single footer count (except security ones)
- ❌ Marking things RESOLVED-STALE without evidence
- ❌ Skipping Phase 4 — if you don't clean HEARTBEAT, the problem recurs tomorrow

## Completion

Call `store-progress` with status `completed` and `output` = one-paragraph summary of (a) how many blockers verified real vs stale, (b) PR counts (stale/aging/recent/dependabot), (c) any surprises.
