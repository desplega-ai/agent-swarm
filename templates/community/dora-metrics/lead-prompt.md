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
2. Install the community template files there:
   - run.sh
   - report.mjs
   - lead-prompt.md
3. On first run, install missing runtime dependencies:
   - git
   - jq
   - Node.js
   - GitHub CLI is optional but preferred for PR title metadata.
4. Clone the repository into /workspace/dora-metrics/repos/<REPORT_NAME>, disable its push URL, fetch the requested branch, and fetch release tags matching <TAG_PATTERN>.
5. Treat <TAG_PATTERN> tags as production deployments only if they map 1:1 to production releases. If they do not, stop and ask for the correct deployment signal.
6. Compute the four DORA keys:
   - Deployment Frequency: EXACT from release tags.
   - Lead Time for Changes: EXACT from commit timestamps to the containing release tag.
   - Change Failure Rate: PROXY from revert, rollback, hotfix, and fix-forward signals near release tags.
   - Failed Deployment Recovery Time: PROXY from failed-release proxy tag to fixing tag.
7. Label CFR and recovery time as proxy/estimated everywhere. Do not present them as precise incident metrics unless a formal incident source is added.
8. Generate a static report with:
   - Four DORA metric cards.
   - EXACT/PROXY quality labels.
   - Deployment and lead-time charts.
   - Recent deployments table.
   - Proxy remediation signal table.
9. Publish the first report as a swarm page and persist its stable page ID in the workflow configuration.
10. Create a schedule pinned to a code-capable worker:
    - Default cadence: weekly, cron "0 22 * * 0".
    - To change the cadence, edit the cron field and timezone only.
    - Each run executes run.sh, updates the same page ID in place, verifies the page renders, and self-repairs the runner/report if the failure is local and fixable.
11. Do not push any PR unless I explicitly ask for a versioned repository change.

Deliver back:
- The stable page URL.
- The workspace paths for run.sh, report.mjs, latest.html, and latest.json.
- The schedule name, cron, timezone, and how to change them.
- A one-line caveat naming which metrics are exact and which are proxy estimates.
- Any prerequisites or assumptions you could not satisfy automatically.
```
