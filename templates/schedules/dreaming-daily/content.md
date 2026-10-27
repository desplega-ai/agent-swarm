# Dreaming Daily Trigger

Trigger the `dreaming` workflow once a day. It replaces the Daily Evolution schedule (`daily-compounding-reflection`), which now seeds disabled.

A seeded schedule cannot target a workflow directly, so this schedule creates one small pool task, and the worker that claims it triggers the workflow. It runs after the Daily Blocker Digest (02:05 UTC), whose digest the workflow reads.

## Schedule

```json
{
  "cron": "30 3 * * *",
  "timezone": "UTC",
  "enabled": true
}
```

## Scheduled Task

Task Type: Dreaming trigger

Trigger today's run of the `dreaming` workflow. Do nothing else: no report, no memory, no Slack.

1. Double-run guard. Run `db-query` with exactly this SQL:
   `SELECT w.name, r.id, r.status, r.startedAt FROM workflow_runs r JOIN workflows w ON w.id = r.workflowId WHERE w.name LIKE 'dreaming%' AND julianday(r.startedAt) >= julianday('now', '-20 hours') ORDER BY r.startedAt DESC LIMIT 5`
   If it returns any row, complete this task without triggering, with the output `skipped: workflow <name> run <id> started at <startedAt>, within 20 hours`. Dreaming workflows share KV state, so they must never run twice in a day. If the query fails, complete without triggering and give the error.
2. Find the workflow named exactly `dreaming` with `list-workflows`. If it is missing or disabled, complete with that reason and trigger nothing.
3. Call `trigger-workflow` with its id and no `triggerData`. Complete with the run id it returns.
