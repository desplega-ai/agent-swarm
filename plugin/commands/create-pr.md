---
description: Create a GitHub pull request from the current branch
argument-hint: [base-branch]
---

# Create Pull Request

Create a GitHub pull request from the current branch with an auto-generated title and description.

## Arguments

- `base-branch` (optional): The branch to merge into (defaults to `main` or the repo's default branch)

## Prerequisites

You should be working in a repository cloned to `/workspace/personal/<repo-name>`.

## Workflow

### 1. Verify Working Directory

Ensure you're in a git repository:

```bash
git rev-parse --is-inside-work-tree
```

### 2. Check Branch Status

```bash
# Get current branch
git branch --show-current

# Ensure we're not on main/master
# Ensure there are commits to push
git log origin/main..HEAD --oneline
```

### 3. Push the Branch

```bash
git push -u origin HEAD
```

### 4. Gather Context for PR Description

```bash
# Get commit messages since diverging from base
git log origin/main..HEAD --pretty=format:"%s%n%b"

# Get changed files
git diff --stat origin/main..HEAD
```

### 5. Generate PR Title and Description

Based on the commits and changes:
- **Title**: Concise summary of the changes (use conventional commit style if the repo uses it)
- **Description**:
  - Summary of what changed and why
  - List of notable changes
  - Any testing done
  - Related issues (if applicable)

### 6. Create the PR

```bash
gh pr create \
  --title "Your generated title" \
  --body "Your generated description" \
  --base main
```

Or interactively if you want the user to review:

```bash
gh pr create --web
```

### 7. Report the PR URL

After creation, provide the PR URL to the user:

```bash
gh pr view --json url --jq '.url'
```

## Tips

- Link related issues using `Fixes #123` or `Closes #123` in the description
- Include a test plan if the changes are significant
- Keep PRs focused - one logical change per PR
- If the branch has many commits, consider summarizing the overall change rather than listing each commit
