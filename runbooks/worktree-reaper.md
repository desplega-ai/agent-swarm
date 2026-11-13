# Worktree reaper

Workers remove the linked git worktrees agents leave behind. Code: `src/commands/worktree-reaper.ts`, wired in `src/commands/runner.ts`. Config: [configuration.mdx § Worktree reaper](../docs-site/content/docs/(documentation)/ui/configuration.mdx).

## When it runs

- **Observe**: at task spawn and resume, and every 60 s while a task runs. It lists `git worktree list --porcelain` for every repo under `/workspace/personal` (depth 3), each active task's repo and `WORKTREE_REAPER_EXTRA_ROOTS`. A new worktree is attributed to the tasks active when it first appears. Worktrees found by the very first scan have no owner.
- **Task end**: decides on that task's worktrees, fire-and-forget.
- **Sweep**: at boot and every `WORKTREE_SWEEP_INTERVAL_MINUTES`, over every known worktree.

Ledger: `/workspace/personal/.swarm/worktree-ledger.json`. A corrupt ledger is renamed to `*.corrupt-<ms>` and every worktree becomes unowned. Providers with no local filesystem, and hosts without `/workspace/personal`, run with the reaper off.

## Decision order

The first match wins.

| # | Condition | Result |
|---|---|---|
| 1 | Main worktree, or any worktree of a bare repo | never listed |
| 2 | `locked` | `skip:locked` |
| 3 | Inside an active task's working dir (either way), or a process cwd inside it | `skip:in-use` |
| 4 | `.git` file missing | finish our own interrupted removal, else `skip:broken` |
| 5 | Tracked changes (`status --untracked-files=no`) | held `dirty` |
| 6 | Commits on no remote ref | held `unpushed` |
| 7 | An owner task not terminal, or its status unknown | `skip:owner-active` |
| 8 | Branch with an upstream other than the default branch, younger than TTL | `keep:pushed-branch` |
| 9 | No owner, younger than TTL | `keep:young` |
| 10 | Otherwise | `git worktree remove --force`, then `git worktree prune` |

Age is the newest of the last owner's end and the mtimes of the worktree's git `HEAD`, `index` and `logs/HEAD`. In a sweep, a held worktree past the TTL loses each `node_modules` directory that `git check-ignore` confirms is ignored.

## Logs

One JSON line per action: `{"event":"worktree-reaper","action","reason","path","repoRoot","taskIds","ageHours"}`. Actions: `remove`, `slim`, `finish-remove`, `error`, and in dry-run `would-remove`, `would-slim`, `would-finish-remove`. Task-end decisions also log their `skip`/`keep` lines. Each sweep logs `action:"sweep-summary"` with counts, every held path, and free bytes before and after.

```bash
docker logs <worker> 2>&1 | grep '"event":"worktree-reaper"' | grep -E 'would-|sweep-summary'
```
