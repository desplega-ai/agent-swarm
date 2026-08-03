# Tackle GitHub PR comments

Review threads and their resolved state live **only in GraphQL**. The REST API
cannot read `isResolved` and cannot resolve a thread, and `gh pr view --comments`
shows issue comments while hiding inline review threads entirely. So this skill
drives everything through GraphQL via `scripts/gh-pr-comments.ts`, authenticated
with `gh auth token`.

## The loop

1. **Fetch** — `list` the unresolved threads.
2. **Verify each claim before acting on it.** Bot reviewers are often right and
   sometimes confidently wrong. Read the code the comment points at.
3. **Fix what is real**, in a commit separate from the original work so the
   reviewer can see what changed in response.
4. **Reply to every thread**, including ones you are declining.
5. **Resolve** each thread.
6. **Verify** nothing is left open, then push.

Push last. A thread that resolves before the fix is pushed reads as dismissed.

## Commands

```bash
SKILL=~/.claude/skills/tackle-gh-comments/scripts/gh-pr-comments.ts

bun $SKILL list                    # unresolved threads in the current PR
bun $SKILL list --pr 1044 --all    # explicit PR, include resolved
bun $SKILL json                    # machine-readable, for scripting
bun $SKILL handle --thread <id> --body "..."   # reply + resolve
bun $SKILL reply   --thread <id> --body "..."  # reply only
bun $SKILL resolve --thread <id>               # resolve only
bun $SKILL verify                  # exit 1 if any thread is unresolved
```

Repo and PR number are inferred from the current checkout; `--repo owner/name`
and `--pr N` override. Thread ids are opaque GraphQL node ids — pass them back
verbatim.

Use heredocs for multi-line replies, so backticks and quotes survive the shell:

```bash
bun $SKILL handle --thread PRRT_xxx --body "$(cat <<'EOF'
Fixed in <sha> — ...
EOF
)"
```

## Verifying a claim

Never fix on the reviewer's say-so alone. For each comment, find the specific
evidence:

- **"This violates convention X"** — check the convention actually says that
  (`CLAUDE.md` / `AGENTS.md` / the linked line range), then check whether
  neighbouring code follows it. A rule the rest of the file already breaks is a
  different conversation from one this PR introduces.
- **"This reference is stale / this will break"** — grep for it. Confirm the
  target really is gone, and sweep for other instances the reviewer missed.
- **"This is a bug"** — construct the failing input. If you cannot, say so in
  the reply rather than making a speculative change.

When a fix is behaviour-preserving (a refactor the reviewer asked for), **prove
it**: diff the before/after output, or run the test that covers it, and say so
in the reply.

### If the fix is a new enforcement rule

A reviewer flagging one instance often means the whole class should be enforced.
Adding a lint/CI check is usually the right response — but the check is itself
code that can be wrong, and a wrong rule is worse than no rule because it
pressures the next person to delete working things to make CI green.

- **Verify each rule against real consumers before enforcing it.** Grep for who
  reads the file or convention you are about to declare invalid. A file that
  looks like dead weight in one delivery path may be load-bearing in another.
- **Prove the check fires.** Inject each failure it claims to catch and confirm a
  non-zero exit. A check that only ever passes is decoration.
- **Confirm it actually runs.** A check wired into a job that is gated on a
  change flag which does not match the files it guards will never execute — that
  is the same bug wearing a different hat. Trace the flag to the path.

## Writing the reply

State what happened, with the commit sha, and enough reasoning that the next
reader does not have to re-derive it.

- **Fixed** — name the sha, say what changed, and note how you verified it.
- **Fixed differently than suggested** — say what you did instead and why. This
  is common and fine; the reviewer often flags a real problem while proposing a
  worse fix than the situation allows.
- **Declining** — give the technical reason, and offer the follow-up if one is
  warranted. Do not resolve a thread with silent disagreement; a reply that
  explains a decline is a resolution, an unexplained one is a dismissal.
- **Partially fixed** — be explicit about the part you did not do and why.

Do not pad replies with thanks-for-the-review filler. One line of
acknowledgement at most, then the substance.

## Traps

- **Resolving before pushing the fix.** The thread shows resolved against code
  that does not yet contain the change. Push last, always.
- **`gh pr view --comments` looks empty.** It does not show inline review
  threads. Use `list`.
- **A bot re-reviews after each push** and can open new threads. Re-run `list`
  after the push settles, and handle the new ones the same way.
- **Outdated threads** (`outdated` flag) attach to lines that have since moved.
  Still reply — the underlying point usually survives the diff.
- **Blanket-resolving to get a green PR.** The resolved state is a claim that
  the concern was addressed. If it was not, say that in the reply instead.

## Definition of done

`bun $SKILL verify` exits 0, every thread has a substantive reply, the fixes are
committed, and the branch is pushed.
