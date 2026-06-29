# DORA Metrics for Your Codebase, on Autopilot

Community template for running recurring DORA metrics reports from an agent-swarm instance.

Files:

- `PLAYBOOK.md`: end-to-end setup and weekly schedule playbook.
- `run.sh`: parameterized runner for any Git repository that uses release tags.
- `report.mjs`: static HTML + JSON report generator.
- `lead-prompt.md`: copy-paste prompt for your agent-swarm Lead.

Quick start:

```bash
mkdir -p /workspace/dora-metrics
cp run.sh report.mjs lead-prompt.md /workspace/dora-metrics/
chmod +x /workspace/dora-metrics/run.sh

BASE_DIR=/workspace/dora-metrics \
REPO_NAME=my-repo \
REPO_URL=https://github.com/OWNER/REPO.git \
BRANCH=main \
TAG_PATTERN='v*' \
WINDOW_DAYS=90 \
bash /workspace/dora-metrics/run.sh
```

Default weekly schedule cadence:

```yaml
cron: "0 22 * * 0"
timezone: "UTC"
```

Change the `cron` field to adjust when the report refreshes. Keep the same page ID when publishing refreshes so the report URL remains stable.

Deployment Frequency and Lead Time for Changes are exact when `TAG_PATTERN` maps 1:1 to production releases. Change Failure Rate and Failed Deployment Recovery Time are proxy estimates from revert/hotfix signals and are labeled that way in the generated report.

See `PLAYBOOK.md` for the full setup flow, references, and metric-definition notes.
