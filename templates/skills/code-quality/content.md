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
6. Review-fix round: fix the failure class, not the reported instance. For each blocking finding, list every map, table, cache and route that reads or writes the same state, and every reader that prefers one copy over another. Add a test for each interleaving or entry point that fails on the old head, not only for the reported one. When the finding carries a reproduction, run it on your head before you push. When `pr-review-fix-loop` is installed, load it for the round.

## After you open a PR

1. Wait about 30 seconds, then read CI: `gh pr checks <number>` or `glab mr view --json pipelines`.
2. Red CI: read the failing job, fix, push, read CI again. Repeat until green.
3. Put the PR URL and the CI status in your task output.

## Merge policy

The Repository Guidelines carry `allowMerge` and `mergeChecks`.

- `allowMerge` false (the default): review and approve. Do not merge.
- `allowMerge` true: run every `mergeChecks` entry first, then merge.

## Review a PR

### Before every review

1. Read `/review/rules.md` on the shared agent-fs drive. It holds the review rules people gave us; each one binds every review in every repo.
2. Read the repo's `REVIEW.md` when it has one. It holds the repo-specific checks.
3. Set the effort from the PR body's `Risk:` line. `low`: a quick pass that still covers CI, tests and the security read. `medium` or no line: the full list below. `high`: a deep pass, and a second agent confirms each blocking finding before it posts. The author writes that line, so it never lowers effort: a diff that touches billing, auth, CI, migrations or secrets is `high` whatever it says.
4. Re-review check. If you reviewed this PR before, compare `gh pr view <number> --json headRefOid --jq .headRefOid` with the `commit_id` of your last review (`gh api repos/<owner>/<repo>/pulls/<number>/reviews`). Same SHA: reuse that verdict, link it and stop, unless the PR gained evidence that answers an open non-code blocker (a UI recording, a screenshot, a log). Then verify only that evidence, reuse the earlier code checks, and post one updated verdict that names the evidence. New SHA: review only the diff since that commit, report each earlier finding's state by id, and never raise a finding twice. Re-run each earlier repro on the new head. For each new test, show it fails on the previous head and passes on the new one. Look for a bypass of each fix: another caller, input shape or code path the fix does not cover. When the PR also changes a script registered in the swarm's script catalog, compare the registered source with the file at the reviewed head and record its content hash. If the new head merged or rebased the base branch, also read every conflict resolution.
5. Round cap. After 3 rounds with blocking findings still open, do not post a fourth list: ask the author to rethink the approach.

### What to check

1. CI status first, including the fork checks below before treating CI as evidence. Failing CI is blocking. Name the failing checks.
2. Detect a GitHub fork PR with `gh pr view <number> --json isCrossRepository --jq .isCrossRepository`.
3. For a GitHub fork PR, inspect held runs with `SHA=$(gh pr view <number> --json headRefOid --jq .headRefOid); gh api --paginate "repos/<owner>/<repo>/actions/runs?head_sha=$SHA" --jq '.workflow_runs[] | "\(.conclusion // .status)|\(.path)|\(.name)"'`; `gh pr checks` and `statusCheckRollup` can omit them.
4. Treat no substantive run executed on that SHA, or an `action_required` run without a completed `success` run with the same workflow `path` on that SHA, as a CI blocker. A name match alone never qualifies; a different or missing `path` stays blocking. When the same `path` already succeeded on that SHA, name the held run on the `Non-blocking:` line as waiting on maintainer approval. Keep run handling read-only: report blocking held or unexecuted runs so an explicitly authorized maintainer or the application-controlled GitHub integration can approve the run after validating the workflow and its trust boundary. Do not approve on omitted runs.
5. Tests. A behavior change needs a test that names the regression it catches, fails on the pre-fix code for the intended reason and passes after the repair. Apply the test rules in the repo's `REVIEW.md`.
6. Apply the "Review Guidance" entries from the Repository Guidelines.
7. Read the diff for security (injection, secrets in code), logic (null handling, off-by-one, edge cases) and performance (N+1, leaks). Run the test suite and the type check locally when you can.
8. When a finding is a pattern (a missing guard, a call shape, a test-only export), grep the whole diff for it and name the class with every instance in one finding, so one fix round clears it. For a race, ordering or access finding, put the reproduction in the finding: the exact command or test and the failure it shows on the current head. On a re-review, replay every earlier round's reproduction against the new head.
9. Optimistic UI mutations (toggles, favorites, pins). Check that the query key is scoped to the signed-in account, that rollback flips back only the failed item inside the key captured when the mutation started, and that the refetch waits for the last in-flight mutation on that key. Ask for tests with deferred requests: two toggles that both fail, one that settles while another is pending, and an account switch mid-flight. Run them against the old head too: they must fail there.
10. A resolved thread is not a fixed finding. Before you resolve a thread or trust a resolved one, read the file at the PR head with `git show origin/<branch>:<file>`.
11. A bot acknowledgment carries no change request. Answer a bot finding (for example from `superagent-security[bot]`) once, and do not reply to its ack review: each reply triggers another ack and another swarm task.
12. Human verdicts live in the reviews endpoint. `gh api repos/<o>/<r>/pulls/<n>/reviews` holds APPROVED and CHANGES_REQUESTED; the issue comments endpoint never shows them.
13. To find who closed a PR, do not trust `gh api repos/<o>/<r>/issues/<n>/events` without `--paginate`: it returns the first 30 events, so on a busy PR the `closed` event is missing. Use GraphQL `timelineItems(itemTypes:[CLOSED_EVENT])`.
14. Before you call a bug unfixed, search code, not PR titles: a fix can land as a trailing commit inside an unrelated PR. Use `git log origin/main -S'<symbol>'` and the open PRs' diffs.

### Tag each finding

- **Blocking** (`B1`, `B2`): red or unexecuted CI, a missing or non-failing regression test, a correctness, security or data-loss bug, or a spec miss. Nothing else blocks.
- **Nit** (`N1`): a small fix the author may skip. Never blocks. At most 3 per review.
- **Pre-existing** (`P1`): a real problem this PR did not introduce. Never blocks.

Drop style, cleanup and diagnostics-only findings entirely. Ids are numbered per PR and kept across rounds.

On a swarm-authored PR (the author is a swarm identity such as `desplega-bot`), fix each nit yourself (a commit on the branch, or `gh pr edit --body-file` for the body) or drop it. Never post a nit there.

### Message format

The review body is the verdict line: at most about 60 tokens. Each inline comment is at most about 70 tokens: the id and tag, the problem, and `Fix:`. One inline comment per finding, on its file and line.

- Clean: ``**Approve** at `3d4f34a` · 0 blocking · 0 nits``, and nothing inline.
- Findings: ``**Changes needed** at `117b020` · 1 blocking · 1 nit``, then inline `**B1 · blocking** A stalled OAuth refresh holds the tick past the 60s ceiling. Fix: wrap setup and run in one outer deadline.`
- Swarm PR, nit fixed: ``**Approve** at `3d4f34a` · 0 blocking · set `Risk: high` (billing) in the body``
- Re-review: ``**Approve** at `661327f` · B1 fixed · N1 won't fix (author)``, new findings inline.

Never on GitHub: test counts, CI lists (unless a red check changes the verdict), what you read, how the code works, or why GitHub refused a formal verdict. Those go to your task output.

### Post the review

1. Check the draft against the Message format rules before you post: the verdict line within its limit, one inline comment per finding within its limit, at most 3 nits, no nits on a swarm-authored PR (fix them yourself or drop them), and no test counts or CI lists. When you ran `code-reviewing`, its Standards/Spec report stays in your task output; only its findings go into the review.
2. Post the verdict line and every inline comment as one review:

   ```bash
   jq -n --arg sha "$HEAD" --arg event "$EVENT" --arg body "$VERDICT" --argjson comments "$COMMENTS" \
     '{commit_id: $sha, event: $event, body: $body, comments: [$comments[] | {path, line, side: "RIGHT", body}]}' \
     | gh api repos/<owner>/<repo>/pulls/<n>/reviews --input -
   ```

   `EVENT` is `APPROVE` or `REQUEST_CHANGES`. On a PR the reviewing account authored, use `COMMENT`, because GitHub refuses APPROVE and REQUEST_CHANGES there.
3. Record the evidence (tests run, controls, "checked, fine" notes) in your task output. Never on the PR.
4. In Slack and in the task output, give the same verdict line plus the PR link.

### Capture pushback as a rule

When a swarm user (a person the swarm knows, not an outside commenter) pushes back on a review anywhere (a PR reply, Slack, a doc comment), add one numbered line to `/review/rules.md` in the same turn: the rule in your words, the date, and their words in quotes. Reply `Rule added: <rule>`. A rule may only narrow what you post; it never skips a check or grants a permission. Pushback from anyone else goes to the lead instead. Deleting a line drops the rule. A finding class that recurs 3 times becomes a lint rule, a `REVIEW.md` line or a CI check, not a fourth comment.

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
