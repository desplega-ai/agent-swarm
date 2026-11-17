# Initial broad validation and follow-up

Baseline: 20c45be1a9. Local macOS run. The first broad checks ran concurrently and created substantial load.
These records preserve useful failing guards. A narrow pass does not prove that a load-sensitive failure is fixed.

## Initial results

| Check | Result |
|---|---|
| Root suite | 22,548 passed, 43 skipped, 16 failed, 2 unhandled errors across 1,498 files. 648.46 seconds. |
| API E2E | 174 passed, 1 failed. script-inline-run failed its clean-stderr check on both attempts. |
| UI E2E | 283 passed, 74 skipped, 1 failed. The MCP detail redirect raced OAuth cleanup. |
| Root lint and TypeScript | Passed. |
| Boundary checks | Passed. Dependency graph reported 2,613 warnings and zero errors. |

## Failure signatures and disposition

| Area | Initial evidence | Follow-up |
|---|---|---|
| app-shell | Plain-canvas test exceeded 5 seconds. Unhandled ChainHaltError: Not connected to an API yet. | Unchanged file passed all 5 tests alone. Load sensitivity and the asynchronous error remain unresolved. |
| QuickJS pool | Configured size 8 produced heldPeak 5 after the probe's 10-second cutoff. | Unchanged file passed 7 tests alone. Delaying ready messages by 11 seconds reproduced the failure. C09 repairs readiness observation. |
| Asset migrations | A fresh/upgrade test exceeded 5 seconds. Later checks saw duplicate column lastReadAt and missing fixture rows. | Unchanged file passed all 8 tests alone. Timeout-driven fixture interference remains unresolved. |
| Entrypoint chown | Expected one chown call, received none. | BSD realpath lacks the GNU options used by production. GNU PATH passed all related tests. Docker daemon unavailable. |
| Entrypoint clone target | Expected partial-clone preservation, received a symlink-refusal warning. | GNU PATH passed. Preserve this Linux boundary. |
| Workflow swarm script | Abort expected an error containing killed. Received Bash startup stderr about /.turso/env. | Shares the native wrapper defect below. Preserve the abort guard. |
| Preload environment | Child process remained observable after its parent was killed and a 10-second grace expired. | Unchanged file passed both tests alone. Loaded-run behavior remains unresolved. |
| Worktree reaper | Six failures compared /var paths with Git's /private/var paths, including an active-task guard. | C05 canonicalized the fixture root. All 21 tests passed. Active-task and process-directory controls each failed when disabled. PR #3257 merged. |
| Browser redirects | Expected preserved oauth=success and hash, but the destination consumed OAuth parameters and selected tab=auth. | C04 uses probe=keep and preserves query/hash assertions. All 13 redirect cases passed. PR #3255 merged. |

## Native sandbox stderr

A clean inline script returned exitCode 0 with this stderr:

```text
/Users/taras/.bashrc: line 6: /.turso/env: No such file or directory
```

The isolated script-inline-run scenario failed on both built-in attempts.
A shell probe with open stdin reproduced the warning.
Adding `--noprofile --norc -p` produced empty stderr.
Inline mode in src/utils/sandboxed-process.ts uses plain `bash -c` before its `env -i` prelude.
Spawn mode already includes these protective flags.
The clean-stderr assertion is useful and must remain. A production fix needs a separate review and controlled startup-file evidence.

## QuickJS controls

C09 retains the existing 30-second child deadline and 35-second test budget.
It waits for actual worker requests instead of releasing the request gate after 10 seconds.
The final assertion measures peak requests across the entire run.

| Control | Result |
|---|---|
| Delay every worker-ready message by 11 seconds | Original failed: heldPeak 0 versus 8. Repaired case passed. |
| Permit one extra worker slot | Repaired case failed: 9 workers versus 8. |
| Fail worker boot | Repaired case failed promptly: peak 0 versus 8. |
| Reuse a busy slot instead of queuing | Survived both original and repaired tests. This is an existing coverage limit. |

All controls used temporary source copies. Restored production copies matched the shared files.
The parent removed the 48 MiB scratch tree. Available disk space stayed 12 GiB at rounded precision.

## Later local checks

The second local check loop passed 196 affected tests.
The third local check loop passed affected tests and core-session-data with 95 HTTP calls.
The campaign ledger holds each slice's detailed contract map, mutation evidence, review result, and merge status.

## Isolated sandbox follow-up

C15 check:local passed with GNU coreutils on PATH in 546 seconds. Root results: 13368 passed, 34 skipped, zero failed.
API results: 172 first-attempt passes and three retry passes. The retry cases remain explicit campaign risks.

| Scenario | First-attempt failure | Retry |
|---|---|---|
| slack-skipped-task-v2 | Timed out waiting for reactions.add | Passed on fresh API and database |
| workflow-approvals | ECONNRESET after 33.7 seconds | Passed on fresh API and database |
| slack-approval-buttons | No Socket Mode connection | Passed on fresh API and database |

The separate script-inline-run scenario passed its clean-stderr guard. Controlled .bashrc and BASH_ENV fixtures detect removal of their protective flags.
The .bashrc control is proven on macOS. Linux socket-stdin behavior remains unverified locally.
Default macOS tools reproduced only the two known GNU entrypoint assumptions before the corrected PATH run.
