# Daily Agent-Swarm Update Check

Zero-config auto-update watchdog: compares the swarm's own running version against the latest published GitHub release of `desplega-ai/agent-swarm`, and flags the operator when an upgrade is available. No placeholders and no integration required — every install gets this by default.

This is a script schedule: each fire runs the global `swarm-update-check` script directly, with no agent task in between. The script:

1. Reads the running version from the API server's own `/health` route.
2. Fetches `https://api.github.com/repos/desplega-ai/agent-swarm/releases/latest` once and reads `tag_name` and `html_url`.
3. Compares the two as numeric `major.minor.patch`, never as strings (`"1.9.0" < "1.10.0"` is false as strings).
4. Only when the latest release is newer, sends the lead one task to post the notice to its configured admin delivery channel (the in-app fallback if none is configured).

Up to date, a missing running version (reported as `unknown`, never as up to date) and an unreachable GitHub API all end the run without any agent task. A failed GitHub call is reported once and never retried in a loop. The check never attempts the upgrade; `weekly-harness-upgrade-check` is the separate routine that bumps pinned harness versions inside the repo.

## Schedule

```json
{
  "cron": "0 9 * * *",
  "timezone": "UTC",
  "enabled": true,
  "targetType": "script",
  "scriptName": "swarm-update-check",
  "scriptArgs": {}
}
```
