---
description: Review a GitHub pull request and provide detailed feedback
argument-hint: <pr-number-or-url>
---

# Review Pull Request

Review a GitHub pull request by analyzing the changes and providing structured feedback.

## Arguments

- `pr-number-or-url`: Either a PR number (e.g., `123`) or a full GitHub PR URL (e.g., `https://github.com/owner/repo/pull/123`)

## Workflow

### 1. Parse the Input

If given a URL, extract the owner, repo, and PR number. If given just a number, use the current repository context.

### 2. Ensure Repository is Cloned Locally

Before reviewing, make sure the repository is cloned in your personal workspace:

```bash
# Clone to your personal workspace
REPO_PATH=/workspace/personal/<repo-name>

if [ ! -d "$REPO_PATH" ]; then
  gh repo clone <owner>/<repo> "$REPO_PATH"
fi

cd "$REPO_PATH"
git fetch origin
```

### 3. Checkout the PR Branch

```bash
gh pr checkout <pr-number>
```

### 4. Fetch PR Details

```bash
gh pr view <pr-number> --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles
```

### 5. Get the Diff

```bash
gh pr diff <pr-number>
```

### 6. Analyze the Changes

Review the diff for:
- **Security issues**: SQL injection, XSS, command injection, secrets in code
- **Logic errors**: Off-by-one errors, null handling, edge cases
- **Performance concerns**: N+1 queries, unnecessary loops, memory leaks
- **Code quality**: Naming, complexity, duplication, missing error handling
- **Test coverage**: Are changes adequately tested?

You can also:
- Run the test suite locally to verify tests pass
- Check for TypeScript errors with `bun tsc --noEmit` or equivalent
- Review the actual files in context, not just the diff

### 7. Provide Structured Feedback

Format your review as:

```markdown
## PR Review: <title>

### Summary
<Brief summary of what this PR does>

### Findings

#### Critical Issues
<List any blocking issues that must be fixed>

#### Suggestions
<Non-blocking improvements to consider>

#### Positive Notes
<Good patterns or practices observed>

### Verdict
<APPROVE | REQUEST_CHANGES | COMMENT>

<Overall recommendation>
```

### 8. Optionally Post the Review

If the user wants to post the review to GitHub:

```bash
gh pr review <pr-number> --approve --body "Your review message"
# or
gh pr review <pr-number> --request-changes --body "Your review message"
# or
gh pr review <pr-number> --comment --body "Your review message"
```

### 9. Post Inline Comments on Specific Lines

For more detailed feedback, you can post inline comments directly on specific lines of code using the GitHub API:

#### Get the Commit SHA

First, get the latest commit SHA for the PR head:

```bash
COMMIT_SHA=$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')
```

#### Post an Inline Comment

Use `gh api` to post a comment on a specific line:

```bash
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments \
  --method POST \
  -f commit_id="$COMMIT_SHA" \
  -f path="src/path/to/file.ts" \
  -f line=42 \
  -f side="RIGHT" \
  -f body="Your inline comment here explaining the issue or suggestion."
```

**Parameters:**
- `commit_id`: The SHA of the commit to comment on (use the PR head commit)
- `path`: The relative path to the file being commented on
- `line`: The line number in the diff to attach the comment to
- `side`: Use `"RIGHT"` for the new code (additions), `"LEFT"` for removed code
- `body`: The comment text (supports markdown)

#### Example: Multiple Inline Comments

```bash
# Get commit SHA once
COMMIT_SHA=$(gh pr view 123 --json headRefOid --jq '.headRefOid')

# Comment on a potential bug
gh api repos/owner/repo/pulls/123/comments \
  --method POST \
  -f commit_id="$COMMIT_SHA" \
  -f path="src/utils/validate.ts" \
  -f line=15 \
  -f side="RIGHT" \
  -f body="This could throw if \`input\` is undefined. Consider adding a null check."

# Comment on a security concern
gh api repos/owner/repo/pulls/123/comments \
  --method POST \
  -f commit_id="$COMMIT_SHA" \
  -f path="src/api/handler.ts" \
  -f line=28 \
  -f side="RIGHT" \
  -f body="⚠️ SQL injection risk: Use parameterized queries instead of string interpolation."
```

### 10. Re-reviewing and Resolving Comments

When the PR author makes changes in response to your review:

#### Re-review After Changes

Check for new commits and re-review the updated code:

```bash
# Fetch latest changes
git fetch origin
gh pr checkout <pr-number>

# View commits since your last review
gh pr view <pr-number> --json commits --jq '.commits[-3:]'

# See the full updated diff
gh pr diff <pr-number>
```

#### Follow Up on Previous Comments

When re-reviewing:
- Check if your previous concerns have been addressed
- Resolve comment threads that are now fixed
- Add follow-up comments if changes need further refinement

```bash
# View existing review comments on the PR
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments --jq '.[].body'

# Reply to a specific comment thread
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments/<comment-id>/replies \
  --method POST \
  -f body="Thanks, this looks good now!"
```

#### Resolve Conversations (via GitHub UI)

Comment threads are typically resolved through the GitHub web interface:
- Navigate to the PR's "Files changed" tab
- Click "Resolve conversation" on addressed comments
- This keeps the review history clean and shows progress

#### Update Your Review Status

After re-reviewing, update your overall review status:

```bash
# If all issues are addressed
gh pr review <pr-number> --approve --body "All feedback addressed. LGTM!"

# If some issues remain
gh pr review <pr-number> --request-changes --body "A few items still need attention - see comments."
```

## Tips

- Focus on substantive issues, not style nitpicks
- Be constructive and explain why something is a problem
- Acknowledge good work when you see it
- If changes look good, say so clearly
- Having the repo cloned allows you to run tests and verify changes work
