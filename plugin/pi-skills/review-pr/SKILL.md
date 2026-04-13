---
name: review-pr
description: Review a pull request (GitHub) or merge request (GitLab) and provide detailed feedback
---

# Review Pull Request / Merge Request

Review a PR (GitHub) or MR (GitLab) by analyzing changes and providing structured feedback.

**Provider detection:** Check the remote URL or provided URL:
- If GitHub → use `gh pr` commands
- If GitLab → use `glab mr` commands

## Arguments

- `pr-number-or-url`: Either a PR number (e.g., `123`) or a full URL

## Workflow

### 1. Setup

- Ensure the repo is cloned to `/workspace/personal/<repo-name>` (clone with `gh repo clone` if needed)
- Fetch, checkout the PR branch, get PR details and diff

### 2. Check CI Status (MANDATORY)

Check CI with `gh pr checks <pr-number>` (or `glab mr view --json pipelines`).

**If CI checks are failing, this is an automatic REQUEST_CHANGES.** Do not approve a PR with failing CI. Include the failing check names and error details in your review.

### 2b. Review Repository Guidelines

Check the "Review Guidance" section of your Repository Guidelines for repo-specific review instructions (e.g., "check README.md", "enforce camelCase in specific directories"). Apply these instructions during your review below.

Also note the repo's **Merge Policy** — check `allowMerge` and `mergeChecks` before approving or merging. If `allowMerge` is false, do NOT merge — only review and approve/request changes.

### 3. Verify Tests Are Included (MANDATORY)

Check that the PR includes test changes. **If the PR modifies code but does not add or update tests, this is an automatic REQUEST_CHANGES.** Every code change must include corresponding tests.

Exceptions:
- Pure documentation changes (README, comments only)
- Configuration-only changes (CI config, linter config, env files)
- Dependency version bumps with no code changes

When requesting changes for missing tests, be specific about what tests are needed.

### 4. Analyze the Changes

Review the diff for:
- **Security issues**: SQL injection, XSS, command injection, secrets in code
- **Logic errors**: Off-by-one errors, null handling, edge cases
- **Performance concerns**: N+1 queries, unnecessary loops, memory leaks
- **Code quality**: Naming, complexity, duplication, missing error handling
- **Test coverage**: Are included tests sufficient? Do they cover edge cases?

Also consider running the test suite locally and checking for TypeScript errors.

### 5. Post the Review

Post your review with a verdict: APPROVE, REQUEST_CHANGES, or COMMENT.

```bash
gh pr review <pr-number> --approve --body "Review message"
gh pr review <pr-number> --request-changes --body "Review message"
gh pr review <pr-number> --comment --body "Review message"
```

### 6. Post Inline Comments on Specific Lines

For detailed feedback on specific lines, use the GitHub API:

```bash
# Get the commit SHA
COMMIT_SHA=$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')

# Post an inline comment
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments \
  --method POST \
  -f commit_id="$COMMIT_SHA" \
  -f path="src/path/to/file.ts" \
  -f line=42 \
  -f side="RIGHT" \
  -f body="Your inline comment here."
```

**Parameters:**
- `commit_id`: PR head commit SHA
- `path`: Relative file path
- `line`: Line number in the diff
- `side`: `"RIGHT"` for new code (additions), `"LEFT"` for removed code
- `body`: Comment text (supports markdown)

### 7. Re-reviewing After Changes

When the author pushes updates:

1. Fetch latest and re-checkout the PR
2. Check if previous concerns were addressed
3. Reply to existing comment threads:
   ```bash
   gh api repos/<owner>/<repo>/pulls/<pr-number>/comments/<comment-id>/replies \
     --method POST \
     -f body="Thanks, this looks good now!"
   ```
4. Update your review status (approve or request further changes)

## Tips

- Focus on substantive issues over style nitpicks
- Acknowledge good work when you see it
- Having the repo cloned allows you to run tests and verify changes locally
