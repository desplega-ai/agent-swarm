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

## Tips

- Focus on substantive issues, not style nitpicks
- Be constructive and explain why something is a problem
- Acknowledge good work when you see it
- If changes look good, say so clearly
- Having the repo cloned allows you to run tests and verify changes work
