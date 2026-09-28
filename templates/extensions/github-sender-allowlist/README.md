# github-sender-allowlist

Blocks GitHub webhook tasks from senders outside the configured allowlists. Login matching is case-insensitive. Tasks from other sources pass through. No task type is exempt by default.

Config:

```json
{
  "internal": ["tarasyarema", "harlequinetcie"],
  "external": ["fuvidani", "capchase-bot"],
  "reviewBots": [],
  "exemptTaskTypes": []
}
```

Internal senders can create any GitHub task, including reviews. Logins in `reviewBots` can create `github-review` tasks only. External senders can create `github-comment` or `github-pr` tasks on pull requests, and `github-review` tasks when `vcsUrl` contains `/pull/`. Choose any review-bot logins from the sender census in the [security audit](https://live.agent-fs.dev/file/~/648a5f3c-35c8-4f11-8673-b89de52cd6bd/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/thoughts/a09d19a4-bd35-4593-9b6f-c2ccafccead8/reviews/2026-09-28-github-sender-authorization-audit.md) when installing the extension; the template intentionally defaults to an empty list.

`exemptTaskTypes` is an optional operator override for explicitly exempting task types. It defaults to an empty list. The GitHub handler does not pass the action for `github-pr` tasks, so external `github-pr` access also permits assignment and label events on pull requests.
