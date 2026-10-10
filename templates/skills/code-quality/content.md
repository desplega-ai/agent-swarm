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

0. Re-review check. If you reviewed this PR before, compare `gh pr view <number> --json headRefOid --jq .headRefOid` with the `commit_id` of your last review (`gh api repos/<owner>/<repo>/pulls/<number>/reviews`). Same SHA: reuse that verdict, link it and stop. New SHA: review the diff since that commit, then run the full list below. If the new head merged or rebased main, also read every conflict resolution (files both sides touched), check migration numbering and order against main, grep for stale migration numbers, and confirm CI is green at the exact head you review.
1. CI status first, including the fork checks below before treating CI as evidence. Failing CI is a REQUEST_CHANGES. Name the failing checks in the review.
2. Detect a GitHub fork PR with `gh pr view <number> --json isCrossRepository --jq .isCrossRepository`.
3. For a GitHub fork PR, inspect held runs with `SHA=$(gh pr view <number> --json headRefOid --jq .headRefOid); gh api --paginate "repos/<owner>/<repo>/actions/runs?head_sha=$SHA" --jq '.workflow_runs[] | "\(.conclusion // .status)|\(.name)"'`; `gh pr checks` and `statusCheckRollup` can omit them.
4. Treat any `action_required` run or no substantive run executed on that SHA as a CI blocker. Keep run handling read-only: REQUEST_CHANGES naming the held or unexecuted run, and report the blocker so an explicitly authorized maintainer or the application-controlled GitHub integration can approve the run after validating the workflow and its trust boundary. Do not APPROVE on omitted runs.
5. Tests second. This authoring gate applies to production changes and tests under root `src/` only; `apps/ui/` and `apps/evals/` are out of scope for now. For a behavior change in root `src/`, no new or updated test that names the regression it catches is a REQUEST_CHANGES. A test that fails the gate below is also a REQUEST_CHANGES. Documentation-only, configuration-only, and dependency-bump PRs are exempt.

   Before adding or changing a root `src/` test, answer all four questions:
   - What observable behavior, invariant, or independent contract does it protect?
   - What credible regression would make it fail?
   - Why would existing coverage miss that regression? Give each contract one primary test owner at its strongest boundary. Another layer needs a distinct risk the owner cannot reach. Prefer extending a table-driven case or shared fixture over a near-duplicate.
   - Does it need a production seam (export, flag, wrapper, or injection hook) that no production caller needs? If so, move the test to the real boundary.

   Reject tests that match these junk patterns:
   - Assertion-free coverage probes.
   - Self-comparisons and identity copiers.
   - Copied fixtures, inventories, manifests, or export lists.
   - Exact source, import, or string greps.
   - Private predicate or call-shape tests duplicated at real boundaries.
   - Duplicate invocations of the same contract.
   - Provider-local replays of shared helpers.
   - Tests whose only purpose is preserving test-only exports, globals, or wrappers.
   - Dead production code whose only callers are tests.
   - Expected values produced by the helper or renderer under test.
   - Mocks that implement the asserted behavior, or one identical mock standing in for different APIs.
   - Fixtures that supply the receipt, admission, or callback ordering the owner should produce, or persistence asserted against a store the path never writes.
   - Capability tests that restate declared flags instead of exercising the delivery or acknowledgement the flag promises.
   - Negative controls that pass for an unrelated reason, such as denial from a different guard or a rejection the production path never reaches.
   - Test names or fixtures that promise more than the input exercises.

   A regression test must fail on the pre-fix code for the intended reason and pass after the repair. A regression test that never demonstrably failed does not prove the fix.
6. Apply the "Review Guidance" entries from the Repository Guidelines.
7. Read the diff for security (injection, secrets in code), logic (null handling, off-by-one, edge cases), performance (N+1, leaks), and code shape (naming, duplication, error handling). Run the test suite and the type check locally when you can.
8. Post the review with the verdict first. One finding per comment, with file and line, and what to change.

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
