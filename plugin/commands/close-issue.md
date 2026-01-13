---
description: Close a GitHub issue with a summary comment
argument-hint: <issue-number-or-url>
---

# Close Issue

Close a GitHub issue with an appropriate closing comment summarizing the resolution.

## Arguments

- `issue-number-or-url`: Either an issue number (e.g., `123`) or a full GitHub issue URL (e.g., `https://github.com/owner/repo/issues/123`)

## Workflow

### 1. Parse the Input

If given a URL, extract the owner, repo, and issue number. If given just a number, use the current repository context.

### 2. Ensure Repository is Cloned Locally

Make sure the repository is available in your personal workspace:

```bash
REPO_PATH=/workspace/personal/<repo-name>

if [ ! -d "$REPO_PATH" ]; then
  gh repo clone <owner>/<repo> "$REPO_PATH"
fi

cd "$REPO_PATH"
```

### 3. Get Issue Details

```bash
gh issue view <issue-number> --json title,body,author,labels,comments
```

### 4. Understand the Context

Review:
- What was the original issue about?
- What work was done to resolve it?
- Were there any related PRs or commits?

Check for related PRs:

```bash
gh pr list --search "fixes #<issue-number>" --json number,title,state
```

### 5. Generate Closing Comment

Write a closing comment that includes:
- Brief summary of what was done
- Reference to any PRs that addressed the issue
- Any follow-up items or notes

### 6. Post Comment and Close

```bash
# Add the closing comment
gh issue comment <issue-number> --body "Your closing comment"

# Close the issue
gh issue close <issue-number>
```

Or combine with a reason:

```bash
gh issue close <issue-number> --comment "Your closing comment" --reason completed
```

## Closing Reasons

- `completed` - The issue was resolved
- `not_planned` - Won't fix / out of scope / duplicate

## Tips

- Always explain why the issue is being closed
- Reference specific PRs or commits when applicable
- If closing as "not planned", explain the reasoning
- Be respectful - someone took time to report the issue
