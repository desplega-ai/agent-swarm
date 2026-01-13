---
description: Implement a GitHub issue and create a pull request
argument-hint: <issue-number-or-url>
---

# Implement Issue

Read a GitHub issue, implement the requested changes, and create a pull request.

## Arguments

- `issue-number-or-url`: Either an issue number (e.g., `123`) or a full GitHub issue URL (e.g., `https://github.com/owner/repo/issues/123`)

## Workflow

### 1. Parse the Input

If given a URL, extract the owner, repo, and issue number. If given just a number, use the current repository context.

### 2. Fetch Issue Details

```bash
gh issue view <issue-number> --json number,title,body,labels,comments
```

Read and understand:
- What is being requested?
- Are there acceptance criteria?
- Any technical details or constraints mentioned?
- Check comments for additional context or clarifications

### 3. Ensure Repository is Cloned

Clone the repository to your personal workspace if not already present:

```bash
REPO_PATH=/workspace/personal/<repo-name>

if [ ! -d "$REPO_PATH" ]; then
  gh repo clone <owner>/<repo> "$REPO_PATH"
fi

cd "$REPO_PATH"
git fetch origin
git checkout main
git pull origin main
```

### 4. Create a Feature Branch

```bash
# Use a descriptive branch name based on the issue
git checkout -b fix/issue-<number>-<short-description>

# Examples:
# git checkout -b fix/issue-123-add-dark-mode
# git checkout -b fix/issue-456-fix-login-redirect
```

### 5. Implement the Changes

This is the core work. Based on the issue:

1. **Understand the codebase** - Explore relevant files, understand existing patterns
2. **Plan your approach** - Consider using `/desplega:create-plan` for complex changes
3. **Write the code** - Implement the requested functionality
4. **Test your changes** - Run existing tests, add new tests if appropriate
5. **Verify it works** - Manual verification where possible

Keep changes focused on what the issue requests. Avoid scope creep.

### 6. Commit Your Changes

```bash
# Stage your changes
git add -A

# Commit with a message referencing the issue
git commit -m "Fix #<issue-number>: <short description>

<longer description if needed>"
```

Use conventional commit style if the repo uses it (e.g., `feat:`, `fix:`, `docs:`).

### 7. Push the Branch

```bash
git push -u origin HEAD
```

### 8. Create the Pull Request

```bash
gh pr create \
  --title "<descriptive title>" \
  --body "## Summary
<Brief description of what this PR does>

## Changes
- <List key changes>

## Testing
- <How you tested the changes>

Fixes #<issue-number>"
```

The `Fixes #<number>` syntax will auto-close the issue when the PR is merged.

### 9. Report Back

Provide the user with:
- PR URL
- Summary of changes made
- Any notes or caveats

Optionally, comment on the original issue:

```bash
gh issue comment <issue-number> --body "I've created a PR to address this: <PR-URL>"
```

## Tips

- Read the issue thoroughly before starting - misunderstanding wastes time
- Check if there are related issues or existing PRs
- Keep PRs focused - one issue = one PR
- If the issue is too large, consider breaking it into smaller PRs
- If you get stuck or the issue is unclear, use `/respond-github` to ask for clarification
- Run linters and tests before creating the PR
