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
2. **Run PR checks (MANDATORY)** — Run ALL checks listed in the "PR Checks" section of your Repository Guidelines. Run each command/task sequentially. If ANY check fails, fix the issue and re-run until all pass. If no guidelines are defined, check the project's CLAUDE.md for a pre-PR checklist and run those. Do NOT proceed until all checks pass.
3. **Push the branch** — `git push -u origin HEAD`
4. **Gather context** — review commit messages and changed files since diverging from base.
5. **Generate title and description.** Follow the conventions of the repository you are working in, not a fixed format:
   - **Title**: Concise summary (conventional commit style if the repo uses it)
   - **Description**: If the repo has a PR/MR template, use its headings as the structure and fill every section. GitHub looks for `pull_request_template.md` in `.github/`, `docs/`, or the repo root (plus an optional `PULL_REQUEST_TEMPLATE/` directory), and falls back to the org's `.github` repo. GitLab uses `.gitlab/merge_request_templates/`. Also follow any PR rules in the repo's `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md`. If the repo defines none, include: summary of changes, notable items, testing done, related issues.
   - **Show the change, do not narrate it.** Aim for about 250 prose words; code blocks, mermaid, tables and `<details>` do not count. No file-by-file changelog: that belongs in your task output.
   - **Review map**: build it from `git diff --stat <base>...HEAD`. One row per area, biggest risk first, with `(+N/-M)`, a depth (🔍 deep, 👀 skim, ⏭ skip for tests and generated files) and what could break.
   - **Change outline**: 1 or 2 views of the shape of the change. Pseudocode with `+`/`-` lines for logic, mermaid for flow, a tree with paths on the nodes for structure.
   - **Swarm provenance** (when you run in the swarm): fill it from your task context. Link the task (`$APP_URL/tasks/<taskId>`) and its tree (`$APP_URL/sessions/<rootTaskId>`), the Slack permalink of the ask if the task came from Slack, any workflow run, and the plan or research as an `agent-fs share-create` link plus its durable `live.agent-fs.dev` path. These auth-gated links go in this section only.
   - **Media**: images and mp4s as GitHub user attachments (`github-attach` skill), docs as `agent-fs share-create` links. Never a presigned agent-fs URL for docs or videos.
6. **Create the PR/MR** using `gh pr create` or `glab mr create`. `gh pr create --body` does not apply the repo template, so write the filled description to a file and pass it with `--body-file <file>`.
7. **Check CI status** — After creating the PR, wait ~30 seconds, then check CI with `gh pr checks <pr-number>` (GitHub) or `glab mr view --json pipelines` (GitLab). If any check is failing, investigate the failure, fix it, push the fix, and re-check. Repeat until CI is green.
8. **Report** the PR/MR URL and CI status.

## Tips

- Link related issues using `Fixes #123` or `Closes #123` in the description
- If the repo ships `scripts/check-pr-body.ts`, run it on the body file before creating the PR
- Keep PRs focused — one logical change per PR
- If the branch has many commits, summarize the overall change rather than listing each commit
