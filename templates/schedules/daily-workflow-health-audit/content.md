# Daily Workflow Health Audit

Check scheduled jobs and workflows for repeated failures, stale runs, and silent drift.

## Schedule

```json
{
  "cron": "0 8 * * *",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is the full task prompt the schedule runs on each fire. Adapt the channel IDs, mentions, app URLs, and escalation rules to your environment before enabling. As you learn from real incidents, expand this prompt with your own local failure modes and recovery notes.

Task Type: Daily Workflow + Schedule Health Audit

You are Lead. Run this audit and post a single Slack digest. Cadence: daily at 08:00 UTC. Purpose: surface any workflow run or scheduled-task fire from the last 24h that hard-failed or silently failed (completed but produced nothing useful) so the team catches broken cron/workflow plumbing before it ages out.

---

## Phase 1 — Query the six failure modes

Use `db-query` for each.

### 1A. Hard-failed workflow runs (last 24h)

```sql
SELECT wr.id, w.name AS workflowName, wr.status,
       wr.finishedAt, wr.lastUpdatedAt,
       SUBSTR(COALESCE(wr.error, ''), 1, 220) AS errSnippet
FROM workflow_runs wr
JOIN workflows w ON w.id = wr.workflowId
WHERE wr.status = 'failed'
  AND datetime(COALESCE(wr.finishedAt, wr.lastUpdatedAt, wr.startedAt)) > datetime('now', '-24 hours')
ORDER BY wr.lastUpdatedAt DESC;
```

### 1B. Hard-failed schedule-spawned tasks (last 24h)

```sql
SELECT t.id, s.name AS scheduleName, t.status,
       SUBSTR(COALESCE(t.failureReason, ''), 1, 220) AS reasonSnippet,
       SUBSTR(COALESCE(t.output, ''), 1, 220) AS outSnippet,
       t.lastUpdatedAt
FROM agent_tasks t
LEFT JOIN scheduled_tasks s ON s.id = t.scheduleId
WHERE t.status = 'failed'
  AND t.scheduleId IS NOT NULL
  AND datetime(t.lastUpdatedAt) > datetime('now', '-24 hours')
ORDER BY t.lastUpdatedAt DESC;
```

### 1C. Halted >24h workflow runs (silent stuck)

```sql
SELECT wr.id, w.name AS workflowName, wr.status, wr.lastUpdatedAt
FROM workflow_runs wr
JOIN workflows w ON w.id = wr.workflowId
WHERE wr.status IN ('running', 'waiting')
  AND datetime(wr.lastUpdatedAt) < datetime('now', '-24 hours')
ORDER BY wr.lastUpdatedAt ASC;
```

### 1D. Silent: schedule-spawned task completed with empty/sentinel output

```sql
SELECT t.id, s.name AS scheduleName, t.status,
       SUBSTR(COALESCE(t.output, ''), 1, 220) AS outSnippet,
       LENGTH(TRIM(COALESCE(t.output, ''))) AS outLen,
       t.lastUpdatedAt
FROM agent_tasks t
LEFT JOIN scheduled_tasks s ON s.id = t.scheduleId
WHERE t.status = 'completed'
  AND t.scheduleId IS NOT NULL
  AND datetime(t.lastUpdatedAt) > datetime('now', '-24 hours')
  AND (
    t.output IS NULL
    OR TRIM(t.output) = ''
    OR TRIM(t.output) = '⚡ Running shell command'
    OR LENGTH(TRIM(t.output)) < 10
  )
ORDER BY t.lastUpdatedAt DESC;
```

### 1E. Cron didn't fire (nextRunAt in the past)

```sql
SELECT s.id, s.name, s.cronExpression, s.lastRunAt, s.nextRunAt, s.consecutiveErrors,
       SUBSTR(COALESCE(s.lastErrorMessage, ''), 1, 220) AS lastErrSnippet
FROM scheduled_tasks s
WHERE s.enabled = 1
  AND s.scheduleType = 'recurring'
  AND s.nextRunAt IS NOT NULL
  AND datetime(s.nextRunAt) < datetime('now', '-1 hour')
ORDER BY s.nextRunAt ASC;
```

### 1F. Schedules with consecutive errors (defensive)

```sql
SELECT s.id, s.name, s.cronExpression, s.consecutiveErrors, s.lastErrorAt,
       SUBSTR(COALESCE(s.lastErrorMessage, ''), 1, 220) AS lastErrSnippet
FROM scheduled_tasks s
WHERE s.enabled = 1
  AND s.consecutiveErrors >= 3
ORDER BY s.consecutiveErrors DESC;
```

### 1G. Totals (for the "all clear" denominator)

```sql
SELECT
  (SELECT COUNT(*) FROM workflow_runs WHERE datetime(lastUpdatedAt) > datetime('now','-24 hours')) AS workflowRuns24h,
  (SELECT COUNT(*) FROM agent_tasks WHERE scheduleId IS NOT NULL AND datetime(lastUpdatedAt) > datetime('now','-24 hours')) AS scheduledFires24h;
```

---

## Phase 2 — Render the digest

Each bullet must include a clickable URL.

- Workflow run URL: `https://app.agent-swarm.dev/workflow-runs/<id>` → Slack format: `<https://app.agent-swarm.dev/workflow-runs/<id>|workflow:<workflowName>>`
- Task URL: `https://app.agent-swarm.dev/tasks/<id>` → Slack format: `<https://app.agent-swarm.dev/tasks/<id>|schedule:<scheduleName>>`

Truncate error/output snippets to 200 chars + `…` if longer. Replace newlines with ` ⏎ `.

### Template

If TOTAL issues across 1A–1F is zero:

```
:white_check_mark: *Daily Workflow + Schedule Health Audit* — <YYYY-MM-DD>

<OWNER_OR_TEAM_MENTION> All clear — <workflowRuns24h> workflow runs + <scheduledFires24h> scheduled fires in the last 24h, all produced expected output.
```

Otherwise:

```
:stethoscope: *Daily Workflow + Schedule Health Audit* — <YYYY-MM-DD>

<OWNER_OR_TEAM_MENTION> Audit window: last 24h. Totals: <workflowRuns24h> workflow runs · <scheduledFires24h> scheduled fires · *<TOTAL_ISSUES> issues*

*Hard failures — workflow runs* (<N1A>)
• <url|workflow:name> — failed <relative-time>
  ↳ <errSnippet>

*Hard failures — scheduled tasks* (<N1B>)
• <url|schedule:name> — failed <relative-time>
  ↳ <reasonSnippet OR outSnippet OR "(no failureReason set)">

*Silent: halted >24h* (<N1C>)
• <url|workflow:name> — status=<status>, no progress since <timestamp>

*Silent: empty output* (<N1D>)
• <url|schedule:name> — completed, output=<"empty" | first-N-chars>

*Cron didn't fire on time* (<N1E>)
• schedule:<name> (cron `<expr>`) — nextRunAt=<past-timestamp>, lastRunAt=<timestamp or "never">

*Schedules with ≥3 consecutive errors* (<N1F>)
• schedule:<name> — consecutiveErrors=<n>, last error: <lastErrSnippet>
```

Omit any section whose count is 0. Cap message at 4000 chars (Slack limit) — if longer, keep top 5 per section and add `…and <K> more` lines.

---

## Phase 3 — Post to Slack and complete

1. Call `slack-post` with your configured channel ID and `message=<rendered digest>`. Prefer a top-level daily fire unless your team's convention is to thread recurring audit messages.
2. Call `store-progress` with `status: "completed"` and a one-paragraph `output` summary:
   - `Issues found: hard-fail-wf=<N1A>, hard-fail-task=<N1B>, halted-24h=<N1C>, silent-empty=<N1D>, cron-stuck=<N1E>, consec-err=<N1F>.`
   - `Totals: workflowRuns24h=<X>, scheduledFires24h=<Y>.`
   - `Slack message ts: <ts from slack-post response>.`

## Anti-patterns

- ❌ Posting a separate Slack message per failure mode — ONE digest.
- ❌ Raw IDs without clickable URLs.
- ❌ Dumping full `error` / `output` content — truncate to 220 chars per item.
- ❌ Threading the daily digest somewhere your team will not scan.
- ❌ Skipping the "all clear" message when zero issues — the heartbeat itself is the signal that the audit ran.
