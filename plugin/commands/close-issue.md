---
description: Close a GitHub or GitLab issue with a summary comment
argument-hint: <issue-number-or-url>
---

# Close Issue

Close a GitHub or GitLab issue with an appropriate closing comment summarizing the resolution.

**Provider detection:** Check the URL or remote to determine the VCS provider:
- If GitHub → use `gh issue close` / `gh issue comment`
- If GitLab → use `glab issue close` / `glab issue note`

## Arguments

- `issue-number-or-url`: Either an issue number (e.g., `123`) or a full issue URL

## Workflow

1. **Parse the input** — if given a URL, extract owner, repo, and issue number. If just a number, use the current repo context.
2. **Ensure repo is cloned** to `/workspace/personal/<repo-name>` (clone with `gh repo clone` if needed).
3. **Get issue details** — read the issue title, body, comments, and check for related PRs.
4. **Generate closing comment** — summarize what was done, reference related PRs/commits, note any follow-ups.
5. **Post comment and close:**
   ```bash
   gh issue close <issue-number> --comment "Your closing comment" --reason completed
   ```

## Closing Reasons

- `completed` — The issue was resolved
- `not_planned` — Won't fix / out of scope / duplicate

## Tips

- Always explain why the issue is being closed
- Reference specific PRs or commits when applicable
- If closing as "not planned", explain the reasoning
