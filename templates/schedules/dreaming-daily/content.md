# Dreaming Daily Trigger

Trigger the `dreaming` workflow once a day. It replaces the Daily Evolution schedule (`daily-compounding-reflection`), which now seeds disabled.

This is a workflow schedule: each fire starts a `dreaming` run directly, with no agent task in between. A seeded schedule has no creator, so the run acts as the swarm's lead, resolved when it fires; with no lead the fire fails. It runs after the Daily Blocker Digest (02:05 UTC), whose digest the workflow reads.

The `dreaming` workflow carries the double-run guard as a 20-hour cooldown: a run that would start within 20 hours of another `dreaming` run start (any status, manual runs included) is recorded as skipped. Dreaming runs share KV state, so they must never run twice in a day.

## Schedule

```json
{
  "cron": "30 3 * * *",
  "timezone": "UTC",
  "enabled": true,
  "targetType": "workflow",
  "workflow": "dreaming"
}
```
