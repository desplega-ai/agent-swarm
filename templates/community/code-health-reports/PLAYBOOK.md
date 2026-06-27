# Code Health Reports for Your Codebase, on Autopilot

An Agent-Swarm playbook template for running recurring Code Maat + D3.js reports on any Git repository.

## What You Get

This setup gives your swarm a stable code-health report page for one repository:

- Hotspots: files with high change frequency and complexity.
- Temporal coupling: files that tend to change together.
- Code age: how recently parts of the codebase changed.
- Ownership and knowledge concentration: who has historically contributed the most to each file.
- A weekly refresh that updates the same page in place, so the URL does not change.

The first run installs or downloads what it needs. You do not pre-install Code Maat or D3.

## Template Files

The community template lives in `templates/community/code-health-reports/` and contains:

- `PLAYBOOK.md`: this playbook.
- `run.sh`: the parameterized runner.
- `report.mjs`: the static report generator.
- `lead-prompt.md`: the copy-paste Lead kickoff prompt.

Install shape:

```bash
mkdir -p /workspace/code-maat
cp templates/community/code-health-reports/run.sh /workspace/code-maat/
cp templates/community/code-health-reports/report.mjs /workspace/code-maat/
cp templates/community/code-health-reports/lead-prompt.md /workspace/code-maat/
chmod +x /workspace/code-maat/run.sh
```

Parameterize each run with environment variables:

```bash
BASE_DIR=/workspace/code-maat \
REPO_NAME=my-repo \
REPO_URL=https://github.com/OWNER/REPO.git \
BRANCH=main \
SCOPE_PATH=src \
bash /workspace/code-maat/run.sh
```

## Libraries and Runtime Shape

The workflow uses:

- [Code Maat](https://github.com/adamtornhill/code-maat): Adam Tornhill's command-line tool for mining version-control history.
- [D3.js](https://d3js.org): browser-side charts. The report loads D3 v7 from jsDelivr at render time, so there is no front-end build step.
- [Lizard](https://github.com/terryyin/lizard): cyclomatic complexity analyzer used to add a complexity axis to the history metrics.
- Node.js: runs `report.mjs`, which parses CSV outputs and writes static `report.html` plus `summary.json`.
- Git history: Code Maat works from a formatted `git log`.
- Java runtime: required to run the Code Maat standalone Clojure JAR.

The generated HTML is static. The only network fetch at view time is D3:

```html
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
```

## Template Directory Structure

Use a workspace outside the target repository so report artifacts and downloaded tools do not pollute the codebase:

```text
/workspace/code-maat/
  run.sh
  report.mjs
  lead-prompt.md
  code-maat.jar              # downloaded on first run
  repos/
    <repo-name>/             # scratch clone, push URL disabled
  out/
    <repo-name>/
      <YYYY-MM-DD>/
        git-src.log
        revisions.csv
        coupling.csv
        age.csv
        authors.csv
        entity-ownership.csv
        main-dev.csv
        abs-churn.csv
        entity-churn.csv
        lizard-functions.csv
        summary.json
        report.html
        latest-pointer.json
      latest.json
      latest.html
      latest-pointer.json
```

## First-Run Behavior

`run.sh` does the following:

- Installs `default-jre-headless` if `java` is missing.
- Installs `nodejs` if `node` is missing.
- Installs Python and `lizard` if Lizard is missing.
- Downloads Code Maat v1.0.4 standalone JAR into `BASE_DIR` if missing.
- Clones the target repository into a scratch directory.
- Disables the scratch clone push URL so the scheduled job cannot push accidentally.
- Generates Code Maat CSVs and a Lizard CSV.
- Runs `report.mjs`.
- Copies the latest artifacts to stable `latest.html`, `latest.json`, and `latest-pointer.json` paths.

## Runner Parameters

Set these variables before calling `run.sh`:

```bash
BASE_DIR=/workspace/code-maat
REPO_NAME=my-repo
REPO_URL=https://github.com/OWNER/REPO.git
BRANCH=main
SCOPE_PATH=src
LOCAL_SOURCE=              # optional local git clone seed
RUN_DATE=2026-06-26        # optional, defaults to current UTC date
```

The runner generates the git log with:

```bash
git -C "$REPO_DIR" log --all --numstat --date=short --pretty=format:'--%h--%ad--%aN' --no-renames -- "$SCOPE_PATH"
```

It runs these Code Maat analyses:

```text
summary
revisions
coupling
age
authors
entity-ownership
entity-effort
main-dev
main-dev-by-revs
abs-churn
author-churn
entity-churn
```

Then it runs Lizard over the scoped path and writes:

```text
OUT_DIR/lizard-functions.csv
OUT_DIR/summary.json
OUT_DIR/latest-pointer.json
OUT_DIR/report.html
```

## Report Generator

`report.mjs` parses the Code Maat and Lizard CSVs, joins historical metrics to current file LOC, computes a hotspot score, and embeds the final data in a static HTML file.

The generator interface:

```bash
node /workspace/code-maat/report.mjs \
  /workspace/code-maat/out/<repo-name>/<YYYY-MM-DD> \
  /workspace/code-maat/repos/<repo-name> \
  <repo-name> \
  <YYYY-MM-DD> \
  <SCOPE_PATH>
```

The default hotspot score is:

```text
risk score = revisions * log2(total cyclomatic complexity + 1)
```

The generated report includes:

- Hotspot bubble chart.
- Change-frequency x complexity scatter.
- Top hotspot table.
- Temporal coupling table.
- Code age distribution.
- D3 v7 loaded from CDN at view time.

## Step-by-Step Playbook

1. Choose a repository and scope.

   `src` is a good default for application code because it avoids docs, package metadata, generated files, and examples. For monorepos, use a narrower scope such as `apps/web/src` or `packages/core/src`.

2. Install the template.

   Copy `run.sh`, `report.mjs`, and `lead-prompt.md` from `templates/community/code-health-reports/` into `/workspace/code-maat`, then make the runner executable.

3. Run it once manually.

   ```bash
   BASE_DIR=/workspace/code-maat \
   REPO_NAME=my-repo \
   REPO_URL=https://github.com/OWNER/REPO.git \
   BRANCH=main \
   SCOPE_PATH=src \
   bash /workspace/code-maat/run.sh
   ```

4. Review local output.

   ```bash
   ls /workspace/code-maat/out/my-repo/latest.html
   ls /workspace/code-maat/out/my-repo/latest.json
   ```

5. Publish the HTML to your swarm page system.

   Create the page once, then store the returned stable page ID somewhere your scheduled task can read it. On later runs, update that same page by ID instead of creating a new page.

   ```text
   First run:
     create page from /workspace/code-maat/out/my-repo/latest.html
     save PAGE_ID=<stable-page-id>

   Later runs:
     update page PAGE_ID with /workspace/code-maat/out/my-repo/latest.html
   ```

6. Wire a weekly schedule.

   Use a code-capable worker because this job may need to repair the script when upstream dependencies, repo branches, or page APIs change.

   ```yaml
   name: code-maat-weekly
   cadence:
     cron: "0 21 * * 0"
     timezone: "UTC"
   target:
     worker: "<code-capable-worker>"
   env:
     BASE_DIR: "/workspace/code-maat"
     REPO_NAME: "my-repo"
     REPO_URL: "https://github.com/OWNER/REPO.git"
     BRANCH: "main"
     SCOPE_PATH: "src"
     PAGE_ID: "<stable-page-id>"
   task:
     - run /workspace/code-maat/run.sh
     - update the existing page PAGE_ID in place with latest.html
     - verify D3 charts render and the page has no console errors
     - if the run fails, diagnose and repair the runner/report generator before reporting failure
   ```

7. Keep the same page URL.

   The report should update in place. The page URL should not change between weekly runs.

## Copy-Paste Lead Prompt

The canonical copy lives in `lead-prompt.md` in the template and is also included below so this playbook can stand alone.

```text
Bootstrap a recurring Code Maat + D3 code-health report for my repository.

Parameters:
- Repository URL: <REPO_URL>
- Default branch: <BRANCH>
- Path scope to analyze: <SCOPE_PATH, e.g. src>
- Report name/slug: <REPORT_NAME>
- Cadence: weekly by default, cron "0 21 * * 0" in <TIMEZONE>
- Stable page behavior: create the page once, then update the same page ID in place on every run.

Requirements:
1. Work outside the target repository under /workspace/code-maat.
2. Install the community template files there:
   - run.sh
   - report.mjs
   - lead-prompt.md
3. On first run, install/download missing runtime dependencies:
   - Java runtime for the Code Maat standalone JAR.
   - Code Maat v1.0.4 standalone JAR from GitHub releases.
   - Lizard via Python user install if it is not available.
   - D3 v7 must be loaded from a CDN by the generated HTML; do not add a front-end build step.
4. Clone the repository into /workspace/code-maat/repos/<REPORT_NAME>, disable its push URL, fetch the requested branch, and analyze only <SCOPE_PATH>.
5. Generate the git log with:
   git log --all --numstat --date=short --pretty=format:'--%h--%ad--%aN' --no-renames -- <SCOPE_PATH>
6. Run Code Maat analyses:
   summary, revisions, coupling, age, authors, entity-ownership, entity-effort, main-dev, main-dev-by-revs, abs-churn, author-churn, entity-churn.
7. Run Lizard over <SCOPE_PATH> and save lizard-functions.csv.
8. Generate a static D3 report with:
   - Hotspot bubble chart.
   - Change-frequency x complexity scatter.
   - Temporal coupling table.
   - Ownership columns in the hotspot table.
   - Code age distribution.
   - Static detail tables.
9. Publish the first report as a swarm page and persist its stable page ID in the workflow configuration.
10. Create a schedule pinned to a code-capable worker:
    - Default cadence: weekly, cron "0 21 * * 0".
    - To change the cadence, edit the cron field and timezone only.
    - Each run executes run.sh, updates the same page ID in place, verifies the page renders, and self-repairs the runner/report if the failure is local and fixable.
11. Do not push any PR unless I explicitly ask for a versioned repository change.

Deliver back:
- The stable page URL.
- The workspace paths for run.sh, report.mjs, latest.html, and latest.json.
- The schedule name, cron, timezone, and how to change them.
- Any prerequisites or assumptions you could not satisfy automatically.
```

## Weekly Cadence and How To Change It

Default cadence:

```yaml
cron: "0 21 * * 0"
timezone: "UTC"
```

That means weekly on Sunday at 21:00 UTC. Change the `cron` field to adjust the refresh time, and change `timezone` if you want the cron interpreted in another zone:

```yaml
# Every Monday at 09:00 Europe/Madrid
cron: "0 9 * * 1"
timezone: "Europe/Madrid"
```

The cadence is separate from the page identity. Changing the cron only changes when the report refreshes. It should still update the same stable page ID in place.

## How To Read the Report

- Revisions/change frequency: how often a file changed in the scoped git history.
- Hotspot/risk score: a combined signal using change frequency and complexity.
- Temporal coupling: files that change together in the same revisions.
- Code age: how long it has been since each entity last changed. Code Maat's code-age analysis computes age in months relative to the report date.
- Ownership/main developer: the author with the largest share of historical additions for a file.
- Cyclomatic complexity: a static code metric from Lizard, aggregated per file and paired with Code Maat's revision counts.

## References

- [D3.js](https://d3js.org): JavaScript library used for the browser-side charts.
- [D3 getting started](https://d3js.org/getting-started): D3 documentation for loading and using the library.
- [Code Maat](https://github.com/adamtornhill/code-maat): Adam Tornhill's version-control mining tool used for revisions, coupling, age, and ownership metrics.
- [Code Maat analyses API index](https://cljdoc.org/d/code-maat/code-maat/1.0.1/api/code-maat.analysis): reference list for Code Maat analyses.
- [Code Maat distribution notes](https://adamtornhill.com/code/maatdistro.htm): upstream distribution page for standalone Code Maat usage.
- [Adam Tornhill](https://www.adamtornhill.com): creator of Code Maat and author of the behavioral-code-analysis framing used here.
- [Your Code as a Crime Scene](https://pragprog.com/titles/atcrime/your-code-as-a-crime-scene/): Adam Tornhill's book on hotspots, temporal coupling, code age, and social code analysis.
- [Maat D3 scripts](https://github.com/adamtornhill/maat-scripts): Adam Tornhill's D3 visualization scripts for Code Maat data, including the canonical enclosure diagram lineage.
- [Lizard](https://github.com/terryyin/lizard): complexity analyzer used here to add per-file cyclomatic complexity.
- [Code Maat GPLv3 license](https://github.com/adamtornhill/code-maat): Code Maat is GPLv3. This template does not vendor or redistribute Code Maat. It downloads the upstream standalone JAR at runtime on first run. If you choose to distribute the JAR yourself, follow GPLv3 distribution obligations, including source and license notice requirements.

## Licensing and Attribution Notes

This template invokes Code Maat as a separate command-line program and consumes its CSV outputs. Running a GPLv3 tool is unrestricted, and the generated metrics are not a derivative work of the tool. The important guardrail is distribution: do not vendor the Code Maat JAR into your own image, repo, or product bundle unless you are prepared to satisfy GPLv3 distribution terms. The template keeps Code Maat as a runtime-downloaded dependency.

D3.js and Lizard remain their own upstream projects with their own licenses. Keep their attribution links in any public version of this playbook.
