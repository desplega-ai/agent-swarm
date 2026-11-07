# Modernize PR

Decide what an aging open PR should become, then do only that. Modernize the idea, not just the branch: a clean rebase does not prove that the PR still belongs. The base moved while the PR sat, and it may have solved the same problem, removed the code the PR edits, or changed the rules the PR relies on.

## Guardrails

- Fetch the base branch and the PR head before you start. Judge the remote state, not a local branch you assume is current.
- Leave a dirty or busy working tree alone. Do the rebase in a fresh worktree.
- This skill allows a rebase and a push to the PR branch. It never merges, closes, retargets the base or widens the scope.
- `main` and `master` are never force-pushed. On the PR branch, never push with a bare `--force`: use `--force-with-lease=<branch>:<pre-rebase head sha>`.
- When the repo's rules forbid rewriting a PR branch, merge the base into it instead of rebasing, and push without force.
- When you cannot push to the head branch (a fork PR that does not allow maintainer edits), return the verdict and stop.
- A contributor's PR (the author is neither a member of the base repo's org nor one of its bots) or a draft PR is verdict-only, even when `maintainerCanModify` is true. Do not push to its branch without a human's yes.
- Age alone is not evidence. An old PR is not obsolete for being old, and it is not current because Git reports no conflicts.

## 1. Establish the PR's goal

Record the PR's URL, state, draft flag, base branch, head repository and branch, head SHA, author, maintainer-edit permission, mergeability, CI state and review state:

```bash
gh pr view <n> --json url,state,isDraft,baseRefName,headRefName,headRepositoryOwner,isCrossRepository,maintainerCanModify,headRefOid,author,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision
```

Read the title, body, linked issues, commits, review threads and the full diff. Then write the PR's goal in one sentence: the smallest coherent change it set out to make. Judge everything that follows against that sentence, not against the current implementation.

## 2. Read what landed since it diverged

```bash
git fetch origin <base> "pull/<n>/head"
OLD_HEAD=<head sha from step 1>
MERGE_BASE=$(git merge-base "origin/<base>" "$OLD_HEAD")
git log --oneline "$MERGE_BASE..origin/<base>"
git diff --stat "$MERGE_BASE..origin/<base>"
```

Read the base commits that touch the PR's files or the behavior it changes, not only the lines that overlap. Search merged and open PRs for the same problem (`gh pr list --state all --search "<keywords>"`). Then answer each question:

- Has the base already solved the same problem another way?
- Did an API, type, schema, dependency or module boundary the PR relies on change?
- Was the code the PR edits deleted, moved or simplified on purpose?
- Would landing the PR restore an old behavior, or add a second way to do one thing?
- Is the benefit still worth the cost of carrying the change?

Probe for conflicts without rebasing. `git merge-tree` exits 1 on a conflict and lists the conflicted files:

```bash
git merge-tree --write-tree --name-only "origin/<base>" "$OLD_HEAD"
```

Read each conflict against the base commit that caused it. A text clash is rebase work. A clash with code the base rewrote on purpose is evidence for REWORK or CLOSE.

## 3. Return one verdict

- **MODERNIZE**: the goal is still useful and the implementation is still the right shape. Go to step 4.
- **REWORK**: the goal is still useful, but a mechanical rebase would keep the wrong implementation. Describe the smallest rewrite that fits today's base: the files, the approach and what to drop. Then stop. Do not push.
- **CLOSE**: the PR is superseded, obsolete, pointed the wrong way, or no longer worth its cost. Cite the evidence: the commit or PR that replaced it, the removed code path, the decision that changed. Ask a human before closing. Never close it yourself.

An open CHANGES_REQUESTED review with unaddressed blocking findings rules out MODERNIZE: a rebase carries the rejected implementation forward. The verdict is at most REWORK until those findings are addressed. List the open ones in the rewrite.

Do not rebase a PR you would close. Sunk effort is not a reason to keep a PR alive.

## 4. MODERNIZE: rebase without losing intent

1. Create a worktree at the recorded head: `git worktree add -b modernize-<n> <dir> "$OLD_HEAD"`.
2. Rebase onto the fresh base: `git rebase "origin/<base>"`. Resolve each conflict toward the PR's goal and the base's newer rules. A conflict that is a product or design disagreement, not a text clash, means the verdict was wrong: run `git rebase --abort` and return REWORK.
3. Compare the old and new series: `git range-diff "$MERGE_BASE..$OLD_HEAD" "origin/<base>..HEAD"`. Confirm that no intended change disappeared and that nothing the base already landed came back. Then read the final diff, `git diff "origin/<base>...HEAD"`.
4. Run the repo's checks for the touched area. Tell real failures apart from failures that also happen on the base.
5. Push with a lease on the old head: `git push --force-with-lease="<head-branch>:$OLD_HEAD" <remote> "HEAD:<head-branch>"`. A rejected lease means someone pushed in the meantime: fetch and restart from step 1. Never retry with a bare `--force`.

Do not merge the PR.

## 5. Report

Lead with the verdict and a one-sentence reason. Then give:

- the goal sentence from step 1;
- the base changes that matter, or "none found";
- MODERNIZE: the old and new head SHAs, what `git range-diff` showed, and the checks you ran with their results;
- REWORK: the rewrite you propose;
- CLOSE: the evidence, and the question for the human who decides.

Keep observed facts apart from judgment. Say what you could not verify instead of guessing.

Adapted from the `modernize` skill in [t3dotgg/tstack](https://github.com/t3dotgg/tstack) (MIT).
