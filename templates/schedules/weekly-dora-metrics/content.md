# Weekly DORA Metrics

Run a recurring DORA metrics report for a repository and update the same stable report page in place.

This schedule is the templates gallery entry point for the community package in `templates/community/dora-metrics/`. The package itself is intentionally not an agent-template config; it is a runnable playbook bundle (`PLAYBOOK.md`, `run.sh`, `report.mjs`, and `lead-prompt.md`) used by this schedule.

## Schedule

```json
{
  "cron": "0 22 * * 0",
  "timezone": "UTC",
  "agentRole": "worker",
  "enabled": true
}
```

## Scheduled Task

This is a reusable starting prompt. Before enabling it, replace the repository, branch, release tag pattern, report name, page ID, timezone, and worker targeting details with values for your project.

Task Type: Weekly DORA Metrics

Repository: `https://github.com/OWNER/REPO.git`
Default branch: `main`
Release tag pattern: `v*`
Report name: `my-repo`
Stable page ID: `<PAGE_ID>`

## Instructions

1. Use the community template in `templates/community/dora-metrics/`. See the docs playbook at `https://docs.agent-swarm.dev/docs/playbooks/dora-metrics` for the full setup, metric-definition notes, and proxy caveats.
2. Install or update the runner workspace under `/workspace/dora-metrics`:
   - `run.sh`
   - `report.mjs`
   - `lead-prompt.md`
3. Run the report with project-specific parameters:

   ```bash
   BASE_DIR=/workspace/dora-metrics \
   REPO_NAME=my-repo \
   REPO_URL=https://github.com/OWNER/REPO.git \
   BRANCH=main \
   TAG_PATTERN='v*' \
   WINDOW_DAYS=90 \
   bash /workspace/dora-metrics/run.sh
   ```

4. Publish `/workspace/dora-metrics/out/my-repo/latest.html` to the existing stable page ID. Do not create a new page for routine refreshes.
5. Verify the rendered page loads, D3 charts are not blank, and the exact/proxy labels are visible.
6. If the run fails because of a local runner, dependency, branch, tag-pattern, or report-generator issue, diagnose and fix it before reporting failure.

## Cadence

The default cron is `0 22 * * 0`, weekly on Sunday at 22:00 UTC. Change the `cron` field to adjust when the report refreshes, and change `timezone` if the cron should be interpreted in a different zone.

The cadence is separate from page identity. Keep updating the same page ID so the report URL remains stable.

## Completion

Call `store-progress` with status `completed` and an output summary that includes the stable page URL, report workspace path, commit analyzed, generated timestamp, and the data-source caveat: Deployment Frequency and Lead Time are exact from release tags/commits; Change Failure Rate and Failed Deployment Recovery Time are proxy estimates from revert/hotfix-style remediation signals.
