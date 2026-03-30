---
description: Respond to a GitHub issue/PR or GitLab issue/MR
argument-hint: <issue-or-pr-number-or-url>
---

# Respond to VCS Issue/PR/MR

Post a response to a GitHub issue/PR or GitLab issue/MR.

**Provider detection:** Check the URL or remote:
- If GitHub → use `gh issue comment` / `gh pr comment`
- If GitLab → use `glab issue note` / `glab mr note`

## Arguments

- `issue-or-pr-number-or-url`: Either a number (e.g., `123`) or a full URL

## Workflow

1. **Parse the input** — if given a URL, extract owner, repo, type (issue/PR), and number. If just a number, determine type from current repo context.
2. **Ensure repo is cloned** to `/workspace/personal/<repo-name>` (clone with `gh repo clone` if needed).
3. **Get full context** — read the original description and all comments in the thread.
4. **Understand what's being asked** — if this is from `@agent-swarm`, focus on what was asked in that mention.
5. **Formulate and post your response** using `gh issue comment` / `gh pr comment` (or `glab` equivalents).

## Decision Framework

- What specific question or request needs addressing?
- Do you need to provide code examples?
- Should you ask clarifying questions?
- Is this something you can resolve, or do you need human input?

## Tips

- Check if there's already a PR addressing an issue before responding
- For complex requests, acknowledge receipt and outline your plan
- If you've completed work, link to the relevant PR or commit
