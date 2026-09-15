# Daily Agent-Swarm Update Check

Zero-config auto-update watchdog: compares the swarm's own running version against the latest published GitHub release of `desplega-ai/agent-swarm`, and flags the operator when an upgrade is available. No placeholders and no integration required — every install gets this by default.

## Schedule

```json
{"cron":"0 9 * * *","timezone":"UTC","agentRole":"lead","enabled":true}
```

## Scheduled Task

This schedule runs by default. It needs no repository clone and no integration — it only reads its own task metadata and calls the public GitHub API.

Task Type: Daily Agent-Swarm Update Check

You are Lead. Determine whether a newer `desplega-ai/agent-swarm` release is published than the version currently running on this install, and tell the operator if so.

## Phase 1 — Determine the running version

Call `get-task-details` for THIS task's own id and read `task.swarmVersion` — the API server stamps every task with the `package.json` version it was running at task-creation time, so this is the version currently deployed on this install.

If `swarmVersion` is missing or empty (an older install, or the field predates this schedule), complete with `output`: `"Unable to determine running version — swarmVersion not set on this task."` and stop. Do not guess a version.

## Phase 2 — Fetch the latest published release

```bash
curl -fsSL https://api.github.com/repos/desplega-ai/agent-swarm/releases/latest
```

Read `.tag_name` (strip a leading `v` if present) and `.html_url`. If the request fails (network, rate limit, non-200), complete with `output`: `"Could not reach GitHub releases API: <error>"` and stop — do not retry in a loop.

## Phase 3 — Compare and act

Compare the two versions as dotted numeric triples (major.minor.patch) — never as plain strings (`"1.9.0" < "1.10.0"` is false as strings).

- **Latest <= running:** complete with `output`: `"Up to date: running <running>, latest published <latest>."` No further action.
- **Latest > running:** raise it for the operator:
  1. Post a short message to your configured admin delivery channel (or the in-app fallback if none is configured) naming the running version, the new version, and the release URL.
  2. Complete `store-progress` with `status: "completed"` and `output`: `"Update available: running <running>, latest <latest> — <releaseUrl>"`.

Do not attempt the upgrade yourself — this schedule only detects and reports. `weekly-harness-upgrade-check` is the separate routine that bumps pinned harness versions inside the repo; this schedule is about the agent-swarm release itself.

## Anti-patterns

- ❌ Cloning the repo or reading `package.json` from disk — this schedule must work on any install, including ones where the API pod has no repo checkout.
- ❌ String-comparing versions.
- ❌ Treating a missing `swarmVersion` as "no update available" — it's "unknown", say so explicitly.
- ❌ Retrying a failed GitHub API call in a loop.
