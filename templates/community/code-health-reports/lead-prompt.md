# Lead Kickoff Prompt

Copy this into your agent-swarm Lead to bootstrap the recurring report.

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
