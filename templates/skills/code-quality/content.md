# Code quality

This skill covers the moment code leaves your machine: a push, a pull request, a merge, a review.

## Pick the CLI

The task's `vcsProvider` field or the remote URL tells you the provider.

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|---|---|---|
| Clone | `gh repo clone` | `glab repo clone` |
| Create PR or MR | `gh pr create` | `glab mr create` |
| View | `gh pr view` | `glab mr view` |
| CI status | `gh pr checks` | `glab mr view --json pipelines` |
| Review | `gh pr review` | `glab mr approve`, `glab mr note` |
| Comment on an issue | `gh issue comment` | `glab issue note` |

## Before you push

1. Run every command in the Repository Guidelines section "PR Checks" of your system prompt, one after the other. When no guidelines exist, run the checklist in the repo's CLAUDE.md. When neither exists, ask the lead before you push.
2. A failing check: fix the cause and run the check again. Push only when every check passes.
3. Git hooks stay on. `--no-verify` and any other bypass flag are out.
4. `main` and `master` are never force-pushed.
5. One logical change per PR. Conventional commit titles when the repo uses them.

## After you open a PR

1. Wait about 30 seconds, then read CI: `gh pr checks <number>` or `glab mr view --json pipelines`.
2. Red CI: read the failing job, fix, push, read CI again. Repeat until green.
3. Put the PR URL and the CI status in your task output.

## Merge policy

The Repository Guidelines carry `allowMerge` and `mergeChecks`.

- `allowMerge` false (the default): review and approve. Do not merge.
- `allowMerge` true: run every `mergeChecks` entry first, then merge.

## Review a PR

1. CI status first. Failing CI is a REQUEST_CHANGES. Name the failing checks in the review.
2. Tests second. A code change without new or updated tests is a REQUEST_CHANGES. Name the tests you expect. Exceptions: documentation-only, configuration-only, and dependency-bump PRs.
3. Apply the "Review Guidance" entries from the Repository Guidelines.
4. Read the diff for security (injection, secrets in code), logic (null handling, off-by-one, edge cases), performance (N+1, leaks), and code shape (naming, duplication, error handling). Run the test suite and the type check locally when you can.
5. Post the review with the verdict first. One finding per comment, with file and line, and what to change.

## GitHub review-reply provenance

Before an automated reply to an inline review thread:

1. `gh api user --jq .login` must equal `${GITHUB_BOT_NAME:-agent-swarm-bot}`.
2. Post through the `GITHUB_TOKEN`-backed `gh api` path.
3. Append `<!-- agent-swarm:review-ack -->` to the reply body.

A user-OAuth GitHub connector (for example `codex_apps`) must not author swarm review replies. When the login does not match, do not post. Report the mismatch in your task output.

## Related skills

- `tackle-gh-comments`: working through every review thread on a PR.
- `engineering-standards`: the code-shape bar a reviewer holds the diff to.
- `code-reviewing`: the two-axis review (standards and spec) for a phase or a branch.
