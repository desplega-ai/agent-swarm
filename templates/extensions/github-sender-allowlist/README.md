# github-sender-allowlist

Blocks GitHub webhook tasks from senders outside the configured allowlists. Login matching is case-insensitive. Tasks from other sources pass through, and `github-review` tasks pass through by default for the PR fix loop.

Config:

```json
{
  "internal": ["tarasyarema", "harlequinetcie"],
  "external": ["fuvidani", "capchase-bot"],
  "exemptTaskTypes": ["github-review"]
}
```

Internal senders can create any GitHub task. External senders can create `github-comment` or `github-pr` tasks only when `vcsUrl` contains `/pull/`. The GitHub handler does not pass the action for `github-pr` tasks, so that rule also permits assignment and label events on pull requests.
