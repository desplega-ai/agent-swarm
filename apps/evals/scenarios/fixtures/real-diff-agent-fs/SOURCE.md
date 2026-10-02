# Source of the real-diff-agent-fs fixture

A real merged fix from desplega-ai/agent-fs (MIT, https://github.com/desplega-ai/agent-fs,
LICENSE in the repo root). The fix landed after every model's training cutoff.

- Real change: PR #73, `fix(core): normalize file paths in every op and migrate
  bare-path rows at startup`, merged as `79cb0f982bc57839c25d8101543a0beb97832fa8`.
- Parent (what the agent starts from): `201a2ec778a0a06eeac7ce3dd16778b087e86e58`
  (agent-fs v0.15.0 plus #72). Nothing is vendored here: the scenario downloads
  the parent's tarball from GitHub at seed time and checks the resulting git
  commit id against a pinned value, so a drifted download fails the seed.
- Graded subset: the PR also ships a startup migration for rows already stored
  under bare paths. That part is out of scope (the issue says so) and none of its
  tests are used. The graded part is the op-level normalization, 18 op files.
- `hidden/`: the two test files the fix added or changed in `packages/core/src/ops/__tests__/`
  (`path-normalization.test.ts`, `comment.test.ts`). They stay out of the sandbox
  until grading, when they overwrite whatever the agent pushed at those paths.
  Two edits to the real tests, both in the `mv` and `cp` self-move tests. The fix asserts
  that both calls reject with the exact message "Source and destination are the same path",
  a string the maintainers chose and the issue cannot give, and that the destination
  `notes.md` and the source `/notes.md` are the same file. The copy here keeps the part that
  matters, that the source file survives, and lets the call reject or do nothing
  (`.catch(() => undefined)`). Both choices are fair readings of the issue; deleting the
  source (what a plain normalize-then-move does) is the bug. The first two pilots kept the
  exact message and every config lost the whole group; in one attempt opus-5.5 had added
  a self-move guard to `mv`, whose wording could not have matched. With the edit, the
  `cp` test passes on the parent too, so it moved to the keep group.
- `solution/ops.patch.txt`: the fix's non-test change under `packages/core/src/ops/`.
  The grader-validation fixture applies it as the reference agent.
- Files end in `.txt` so lint, tsc and `bun test` never pick them up.

## Validating the seed and the grader for real

CI simulates the sandbox shell (`scenarios/grader-fixtures/real-diff-agent-fs.ts`). To run the
real seed and the real grading commands on one machine (network, about 1.5 GB of disk):

    bun scripts/validate-real-diff-agent-fs.ts reference   # the real fix pushed: every check 1
    bun scripts/validate-real-diff-agent-fs.ts noop        # a README-only commit: correctness 0
    bun scripts/validate-real-diff-agent-fs.ts null        # nothing pushed: the push gate fails

Run it after any change to the seed or the grading commands. If the seed fails on the commit-id
check, the GitHub tarball for `201a2ec` no longer reproduces `SEED_SHA`: re-derive it, bump the
scenario version and pin the new hash.
