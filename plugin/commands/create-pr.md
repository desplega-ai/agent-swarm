---
description: Create a pull request (GitHub) or merge request (GitLab) from the current branch
argument-hint: [base-branch]
---

# Create Pull Request / Merge Request

Create a PR (GitHub) or MR (GitLab) from the current branch with an auto-generated title and description.

**Provider detection:** Check the remote URL:
- If `github.com` → use `gh` CLI
- If `gitlab.com` or `gitlab.` → use `glab` CLI

## Arguments

- `base-branch` (optional): Branch to merge into (defaults to `main` or repo default)

## Prerequisites

You should be working in a repository cloned to `/workspace/personal/<repo-name>`.

## Workflow

1. **Verify state** — confirm you're in a git repo, not on main/master, and have commits to push.
2. **Push the branch** — `git push -u origin HEAD`
3. **Gather context** — review commit messages and changed files since diverging from base.
4. **Generate title and description:**
   - **Title**: Concise summary (conventional commit style if the repo uses it)
   - **Description**: Summary of changes, notable items, testing done, related issues
5. **Create the PR/MR** using `gh pr create` or `glab mr create`.
6. **Report** the PR/MR URL.

## Tips

- Link related issues using `Fixes #123` or `Closes #123` in the description
- Keep PRs focused — one logical change per PR
- If the branch has many commits, summarize the overall change rather than listing each commit
