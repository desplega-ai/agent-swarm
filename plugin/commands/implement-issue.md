---
description: Implement a GitHub issue or GitLab issue and create a PR/MR
argument-hint: <issue-number-or-url>
---

# Implement Issue

Read a GitHub or GitLab issue, implement the requested changes, and create a PR/MR.

**Provider detection:** Check the URL or remote:
- If GitHub → use `gh issue view` / `gh pr create`
- If GitLab → use `glab issue view` / `glab mr create`

## Arguments

- `issue-number-or-url`: Either an issue number (e.g., `123`) or a full URL

## Workflow

### 1. Parse and Fetch

If given a URL, extract owner, repo, and issue number. Fetch issue details (title, body, labels, comments). Understand what's being requested, acceptance criteria, and any technical constraints.

### 2. Setup

- Ensure repo is cloned to `/workspace/personal/<repo-name>` (clone with `gh repo clone` if needed)
- Fetch origin, checkout main, pull latest
- Create a feature branch: `fix/issue-<number>-<short-description>`

### 3. Implement

1. **Understand the codebase** — explore relevant files and existing patterns
2. **Plan your approach** — consider using `/desplega:create-plan` for complex changes
3. **Write the code** — implement the requested functionality
4. **Test your changes** — run existing tests, add new tests if appropriate
5. **Verify it works** — manual verification where possible

Keep changes focused on what the issue requests. Avoid scope creep.

### 4. Quality Checks, Commit, and Push

1. **Run PR checks (MANDATORY)** — Run ALL checks from the "PR Checks" section of your Repository Guidelines. Fix any failures before proceeding. If no guidelines are defined, check the project's CLAUDE.md for a pre-PR checklist.
2. **Commit** with a message referencing the issue (e.g., `Fix #123: <description>`). Use conventional commit style if the repo uses it.
3. **Push** with `git push -u origin HEAD`.

### 5. Create the PR

Create the PR with a descriptive title and body including: summary of changes, key changes list, testing done, and `Fixes #<issue-number>` to auto-close the issue on merge.

After creating the PR, check CI status with `gh pr checks` (GitHub) or `glab mr view --json pipelines` (GitLab). If CI fails, fix the issues, push, and re-check until green.

### 6. Report Back

Provide the PR URL, summary of changes, and any caveats. Optionally comment on the original issue linking the PR.

## Tips

- Read the issue thoroughly before starting — misunderstanding wastes time
- Check for related issues or existing PRs
- One issue = one PR
- If the issue is too large, break it into smaller PRs
- If unclear, use `/respond-github` to ask for clarification
