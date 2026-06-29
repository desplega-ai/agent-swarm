# DORA Metrics for Your Codebase, on Autopilot

An Agent-Swarm playbook template for running recurring DORA metrics reports on any Git repository that has a reliable deployment tag signal.

## What You Get

This setup gives your swarm a stable DORA report page for one repository:

- Deployment Frequency: release throughput over a configurable window.
- Lead Time for Changes: median time from commit to the release tag that deployed it.
- Change Failure Rate: proxy estimate from revert/hotfix-style remediation signals.
- Failed Deployment Recovery Time: proxy estimate from the failed-release tag to the fixing tag.
- A weekly refresh that updates the same page in place, so the URL does not change.

The key caveat is part of the product: Deployment Frequency and Lead Time for Changes are exact when release tags map to production deployments. Change Failure Rate and Failed Deployment Recovery Time are proxy estimates until you connect a formal incident source.

## Template Files

The community template lives in `templates/community/dora-metrics/` and contains:

- `PLAYBOOK.md`: this playbook.
- `run.sh`: the parameterized runner.
- `report.mjs`: the static report generator.
- `lead-prompt.md`: the copy-paste Lead kickoff prompt.

Install shape:

```bash
mkdir -p /workspace/dora-metrics
cp templates/community/dora-metrics/run.sh /workspace/dora-metrics/
cp templates/community/dora-metrics/report.mjs /workspace/dora-metrics/
cp templates/community/dora-metrics/lead-prompt.md /workspace/dora-metrics/
chmod +x /workspace/dora-metrics/run.sh
```

Parameterize each run with environment variables:

```bash
BASE_DIR=/workspace/dora-metrics \
REPO_NAME=my-repo \
REPO_URL=https://github.com/OWNER/REPO.git \
BRANCH=main \
TAG_PATTERN='v*' \
WINDOW_DAYS=90 \
bash /workspace/dora-metrics/run.sh
```

## Libraries and Runtime Shape

The workflow uses:

- Git tags: the canonical deployment event, when `TAG_PATTERN` maps 1:1 to production releases.
- Git commit history: exact commit timestamps used for lead time.
- GitHub CLI: optional but preferred for merged PR title metadata when identifying hotfix/revert signals.
- jq: required utility dependency for predictable JSON handling in the runner environment.
- Node.js: runs `report.mjs`, which computes metrics and writes static `report.html` plus `summary.json`.

The generated HTML is static. The only network fetch at view time is D3:

```html
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
```

## Template Directory Structure

Use a workspace outside the target repository so report artifacts do not pollute the codebase:

```text
/workspace/dora-metrics/
  run.sh
  report.mjs
  lead-prompt.md
  repos/
    <repo-name>/             # scratch clone, push URL disabled
  out/
    <repo-name>/
      <YYYY-MM-DD>/
        tags.tsv
        recent-commits.tsv
        remediation-commits.tsv
        prs.json
        revision.txt
        revision-summary.txt
        summary.json
        report.html
        latest-pointer.json
      latest.json
      latest.html
      latest-pointer.json
```

## First-Run Behavior

`run.sh` does the following:

- Installs `git`, `jq`, and `nodejs` if missing.
- Clones the target repository into a scratch directory.
- Disables the scratch clone push URL so the scheduled job cannot push accidentally.
- Fetches the configured branch and release tags matching `TAG_PATTERN`.
- Writes release tag, recent commit, remediation commit, and optional PR metadata.
- Runs `report.mjs`.
- Copies the latest artifacts to stable `latest.html`, `latest.json`, and `latest-pointer.json` paths.

## Runner Parameters

Set these variables before calling `run.sh`:

```bash
BASE_DIR=/workspace/dora-metrics
REPO_NAME=my-repo
REPO_URL=https://github.com/OWNER/REPO.git
BRANCH=main
TAG_PATTERN='v*'
WINDOW_DAYS=90
HOTFIX_WINDOW_HOURS=24
LOCAL_SOURCE=              # optional local git clone seed
RUN_DATE=2026-06-26        # optional, defaults to current UTC date
```

The runner extracts release tags with:

```bash
git -C "$REPO_DIR" for-each-ref "refs/tags/$TAG_PATTERN" --sort=creatordate --format='%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(creatordate:unix)'
```

It extracts remediation signals with:

```bash
git -C "$REPO_DIR" log "origin/$BRANCH" --since="$WINDOW_DAYS days ago" --grep='revert' --grep='rollback' --grep='hotfix' --grep='fix-forward' --regexp-ignore-case
```

When authenticated, it also asks `gh pr list` for merged PR titles so hotfix-style PRs can contribute to the proxy stability keys.

## Metric Definitions and Bands

The report uses the four DORA keys and 2024 performance bands as configurable constants in `report.mjs`.

| Metric | Source | Quality | Band logic |
|---|---|---|---|
| Deployment Frequency | `TAG_PATTERN` release tags in the window | EXACT | Elite: at least daily. High: daily to weekly. Medium: weekly to monthly. Low: slower. |
| Lead Time for Changes | Commit timestamp to containing release tag timestamp | EXACT | Elite: under 1 day. High: 1 day to 1 week. Medium: 1 week to 1 month. Low: slower. |
| Change Failure Rate | Releases paired to revert, rollback, hotfix, or fix-forward signals | PROXY | 2024 cluster thresholds: ~5%, ~20%, ~10%, ~40%. Medium's lower CFR than High is a known 2024 cluster anomaly. |
| Failed Deployment Recovery Time | Failed-release proxy tag to fixing tag | PROXY | Elite: under 1 hour. High/Medium: under 1 day. Low: slower. |

The stability keys are intentionally labeled as proxy/estimated because a release tag plus commit/PR title heuristic is not an incident tracker. It can undercount fix-forward/manual incidents and overcount ordinary fixes.

## Report Generator

`report.mjs` parses the runner outputs, computes the four metrics, and embeds the final data in a static HTML file.

The generator interface:

```bash
node /workspace/dora-metrics/report.mjs \
  /workspace/dora-metrics/out/<repo-name>/<YYYY-MM-DD> \
  /workspace/dora-metrics/repos/<repo-name> \
  <repo-name> \
  <YYYY-MM-DD> \
  <BRANCH> \
  <WINDOW_DAYS> \
  <HOTFIX_WINDOW_HOURS> \
  <TAG_PATTERN>
```

The generated report includes:

- Four DORA metric cards.
- `EXACT` / `PROXY` quality labels.
- Deployment and lead-time charts.
- Recent deployments table.
   - Proxy remediation signal table.
- D3 v7 loaded from CDN at view time.

## Step-by-Step Playbook

1. Confirm the deployment signal.

   The default assumes `v*` tags map 1:1 to production releases. If your repository tags packages without deploying them, stop and configure a better deployment signal before using this template.

2. Install the template.

   Copy `run.sh`, `report.mjs`, and `lead-prompt.md` from `templates/community/dora-metrics/` into `/workspace/dora-metrics`, then make the runner executable.

3. Run it once manually.

   ```bash
   BASE_DIR=/workspace/dora-metrics \
   REPO_NAME=my-repo \
   REPO_URL=https://github.com/OWNER/REPO.git \
   BRANCH=main \
   TAG_PATTERN='v*' \
   WINDOW_DAYS=90 \
   bash /workspace/dora-metrics/run.sh
   ```

4. Review local output.

   ```bash
   ls /workspace/dora-metrics/out/my-repo/latest.html
   ls /workspace/dora-metrics/out/my-repo/latest.json
   ```

5. Publish the HTML to your swarm page system.

   Create the page once, then store the returned stable page ID somewhere your scheduled task can read it. On later runs, update that same page by ID instead of creating a new page.

   ```text
   First run:
     create page from /workspace/dora-metrics/out/my-repo/latest.html
     save PAGE_ID=<stable-page-id>

   Later runs:
     update page PAGE_ID with /workspace/dora-metrics/out/my-repo/latest.html
   ```

6. Wire a weekly schedule.

   Use a code-capable worker because this job may need to repair the script when upstream repo conventions, branch names, tag patterns, or page APIs change.

   ```yaml
   name: weekly-dora-metrics
   cadence:
     cron: "0 22 * * 0"
     timezone: "UTC"
   target:
     worker: "<code-capable-worker>"
   env:
     BASE_DIR: "/workspace/dora-metrics"
     REPO_NAME: "my-repo"
     REPO_URL: "https://github.com/OWNER/REPO.git"
     BRANCH: "main"
     TAG_PATTERN: "v*"
     WINDOW_DAYS: "90"
     HOTFIX_WINDOW_HOURS: "24"
     PAGE_ID: "<stable-page-id>"
   task:
     - run /workspace/dora-metrics/run.sh
     - update the existing page PAGE_ID in place with latest.html
     - verify D3 charts render and the exact/proxy labels are visible
     - if the run fails, diagnose and repair the runner/report generator before reporting failure
   ```

7. Keep the same page URL.

   The report should update in place. The page URL should not change between weekly runs.

## Copy-Paste Lead Prompt

The canonical copy lives in `lead-prompt.md` in the template and is also included below so this playbook can stand alone.

# Lead Kickoff Prompt

Copy this into your agent-swarm Lead to bootstrap the recurring report.

```text
Bootstrap a recurring DORA metrics report for my repository.

Parameters:
- Repository URL: <REPO_URL>
- Default branch: <BRANCH>
- Release tag pattern: <TAG_PATTERN, default v*>
- Report name/slug: <REPORT_NAME>
- Analysis window: <WINDOW_DAYS, default 90>
- Hotfix/revert matching window: <HOTFIX_WINDOW_HOURS, default 24>
- Cadence: weekly by default, cron "0 22 * * 0" in <TIMEZONE>
- Stable page behavior: create the page once, then update the same page ID in place on every run.

Requirements:
1. Work outside the target repository under /workspace/dora-metrics.
2. Install the community template files there: run.sh, report.mjs, and lead-prompt.md.
3. Clone the repository into /workspace/dora-metrics/repos/<REPORT_NAME>, disable its push URL, fetch the requested branch, and fetch release tags matching <TAG_PATTERN>.
4. Treat <TAG_PATTERN> tags as production deployments only if they map 1:1 to production releases.
5. Compute Deployment Frequency and Lead Time for Changes exactly from tags and commits.
6. Compute Change Failure Rate and Failed Deployment Recovery Time as proxy estimates from revert/hotfix signals.
7. Label CFR and recovery time as proxy/estimated everywhere. Do not present them as precise incident metrics unless a formal incident source is added.
8. Publish the first report as a swarm page and persist its stable page ID in the workflow configuration.
9. Create a weekly schedule that executes run.sh, updates the same page ID, verifies render, and self-repairs local runner/report failures.
10. Do not push any PR unless I explicitly ask for a versioned repository change.

Deliver back:
- The stable page URL.
- The workspace paths for run.sh, report.mjs, latest.html, and latest.json.
- The schedule name, cron, timezone, and how to change them.
- A one-line caveat naming which metrics are exact and which are proxy estimates.
- Any prerequisites or assumptions you could not satisfy automatically.
```

## References

- [DORA metrics guide](https://dora.dev/guides/dora-metrics/): official definitions for Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Failed Deployment Recovery Time.
- [2024 Accelerate State of DevOps Report](https://dora.dev/research/2024/dora-report/): 2024 performance bands and cluster-analysis context.
- [DORA research program](https://dora.dev/research/): background on the annual DORA reports and metric evolution.
- [GitHub CLI](https://cli.github.com/manual/): optional PR metadata source used to enrich hotfix/revert proxy detection.
- [D3.js](https://d3js.org): JavaScript library used for the browser-side charts.
