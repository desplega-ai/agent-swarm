---
description: Respond to a GitHub issue or pull request
argument-hint: <issue-or-pr-number-or-url>
---

# Respond to GitHub

Post a response to a GitHub issue or pull request.

## Arguments

- `issue-or-pr-number-or-url`: Either a number (e.g., `123`) or a full GitHub URL (e.g., `https://github.com/owner/repo/issues/123` or `https://github.com/owner/repo/pull/123`)

## Workflow

### 1. Parse the Input

If given a URL, extract:
- Owner and repo
- Whether it's an issue or PR (from the URL path)
- The number

If given just a number, use the current repository context and check if it's an issue or PR.

### 2. Ensure Repository is Cloned Locally

Make sure the repository is available in your personal workspace:

```bash
REPO_PATH=/workspace/personal/<repo-name>

if [ ! -d "$REPO_PATH" ]; then
  gh repo clone <owner>/<repo> "$REPO_PATH"
fi

cd "$REPO_PATH"
```

### 3. Get Full Context

For issues:
```bash
gh issue view <number> --json title,body,author,labels,comments,state
```

For PRs:
```bash
gh pr view <number> --json title,body,author,comments,state,reviews
```

### 4. Understand What's Being Asked

Read through:
- The original issue/PR description
- All comments in the thread
- Any specific questions or requests

If this is a task from agent-swarm with `@agent-swarm` mention, focus on what was asked in that mention.

### 5. Formulate Your Response

Consider:
- What specific question or request needs addressing?
- Do you need to provide code examples?
- Should you ask clarifying questions?
- Is this something you can resolve, or do you need human input?

### 6. Post the Response

For issues:
```bash
gh issue comment <number> --body "Your response"
```

For PRs:
```bash
gh pr comment <number> --body "Your response"
```

## Response Guidelines

- Be helpful and constructive
- If you don't know something, say so
- Provide code examples when relevant
- Use markdown formatting for readability
- Keep responses focused and concise
- If you've completed work, link to the relevant PR or commit

## Tips

- Check if there's already a PR addressing an issue before responding
- If asked to implement something, consider whether to respond first or just do it
- For complex requests, acknowledge receipt and outline your plan
- Tag relevant people with `@username` if needed
