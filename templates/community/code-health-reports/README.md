# Code Health Reports for Your Codebase, on Autopilot

Community template for running recurring Code Maat + D3.js code-health reports from an agent-swarm instance.

Files:

- `PLAYBOOK.md`: end-to-end setup and weekly schedule playbook.
- `run.sh`: parameterized runner for any Git repository.
- `report.mjs`: static HTML + JSON report generator.
- `lead-prompt.md`: copy-paste prompt for your agent-swarm Lead.

Quick start:

```bash
mkdir -p /workspace/code-maat
cp run.sh report.mjs lead-prompt.md /workspace/code-maat/
chmod +x /workspace/code-maat/run.sh

BASE_DIR=/workspace/code-maat \
REPO_NAME=my-repo \
REPO_URL=https://github.com/OWNER/REPO.git \
BRANCH=main \
SCOPE_PATH=src \
bash /workspace/code-maat/run.sh
```

Default weekly schedule cadence:

```yaml
cron: "0 21 * * 0"
timezone: "UTC"
```

Change the `cron` field to adjust when the report refreshes. Keep the same page ID when publishing refreshes so the report URL remains stable.

Code Maat is GPLv3. This template does not vendor or redistribute Code Maat. It downloads the upstream standalone JAR at runtime on first run.

See `PLAYBOOK.md` for the full setup flow, references, and licensing notes.
