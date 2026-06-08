# Weekly Dependency Triage

Review dependency update PRs, group safe patches, and flag risky upgrades.

## Schedule

```json
{
  "cron": "40 3 * * 0",
  "timezone": "UTC",
  "agentRole": "lead",
  "enabled": true
}
```

## Scheduled Task

This is a reusable starting prompt. Before enabling it, replace the repository, paths, branch names, reviewers, and notification target with values for your project.

Task Type: Weekly Dependency Triage

Repository: `owner/repo`
Important paths: `path-one`, `path-two`

## Instructions

1. List all open dependency-update PRs in the configured repository using `gh pr list`.
2. Separate PRs by the paths they touch. Close or ignore PRs outside the configured path list only if that is your team's policy.
3. Do not touch non-dependency PRs.
4. For each configured path, create one unified PR that combines compatible dependency bumps:
   - Branch name format: `YYYY-MM-DD-dependencies-<path-name>`
   - Base the branch on latest `main`
   - Include the dependency bumps for that path
   - Leave incompatible or conflicting upgrades as separate PRs with notes
5. After creating a unified PR, close only the individual dependency PRs that were incorporated.
6. Return the final PR URLs and call out any skipped PRs with a reason.
7. If there are no open dependency PRs, report that and complete.

## Approach

- Clone or update the repo, checkout `main`, and pull latest
- Create a branch per path group
- Cherry-pick, merge, or manually apply each dependency update as appropriate
- Run the repo's required dependency checks before pushing
- Push, open PRs, request the configured reviewers, and notify the configured channel or thread

## Completion

Call `store-progress` with status `completed` and an output summary listing unified PR URLs, closed source PRs, skipped PRs, and failed checks if any.
