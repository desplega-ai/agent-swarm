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

## Merge-queue DB timing failure

C15 passed its PR checks. Merge-group run 44123585250 failed Run Tests (2/8).
The unchanged db-client-busy-retry test required executionMs below 300ms. The run measured 371.386837ms.
Production includes each synchronous SQLite attempt in execution time. Its final attempt can spin for 250ms.
The fixed ceiling therefore cannot protect the accounting contract under load.
Keep real SQLite contention and verify that execution time includes failed attempts but excludes backoff.
C22 first passed 53 affected checks and two mutation controls with clock and timer spies.
Independent review rejected the added maintenance cost. The later real-clock version appears in the final C22 checkpoint below.
C10 also failed this unchanged guard in merge-group run 44125275220, measuring 364.037399ms.
GitHub check annotations identify the exact failure at db-client-busy-retry.test.ts:102.
PR #3277 later merged a zero-spin fixture with a 200ms ceiling as 7d5ad4e75d396bebb57e460f40f7c72432531a6d.
C15 and C10 returned to queue validation after that change. C15 merged.
C10 run 44131652948 failed the zero-spin guard: executionMs 201.530818ms against the new 200ms ceiling.
Check 134210204331 identifies db-client-busy-retry.test.ts:113. No retry was requested before the later C22 repair.
The C22 candidate targets an additional contract: failed BUSY attempts contribute to executionMs, which controls retention batch sizing.
Its first real-clock revision passed 53 affected checks and rejected both accounting mutants.
It also rejected omitted failed-attempt cost when 80ms of successful-attempt overhead masked the simpler proposed assertion.
A caller pause of 250ms still masked the backoff-inclusion mutant. The evidence does not claim universal accounting precision.
That first candidate predates PR #3277. The final C22 checkpoint below records its rebase, fresh controls, and renewed review.

## Slack readiness repair

C20 avoids repeated renderer config writes. Required changes restart the API and explicitly await a Slack socket.
The reaction override uses the same readiness barrier during setup and cleanup.
All 35 affected scenarios passed check:local: zero failures, skips, or flaky results, with 553 HTTP calls.
Paired runs passed before and after a two-second reconnect delay. Removing override barriers failed both existing runner attempts.
Legacy and first-writer scenarios passed. All 16 legacy PNGs remained valid, including 11 transition frames.
The workflow-approvals ECONNRESET remains unexplained. A skip path cannot drain an unrelated earlier config reload.

## Cancellation consolidation

C21 reduced the affected Codex suites from 126 to 123 tests. Parent check:local passed in 12 seconds.
Seven controls failed retained guards. Missing poll abort still times out, and afterEach restores console.log.
Removing name-only AbortError classification survives both versions because both explicitly call abort. This remains a coverage limit.
Scoped test typechecking reports 13 unchanged baseline errors. The configured root typecheck passes.

## Codex pool consolidation

C23 removes the copied selection algorithm and exercises the exported resolver instead.
Baseline 17 tests passed. Candidate 13 tests passed, with seven detected regression controls.
The baseline missed exhaustion, refresh-token leakage, missing credential files, and incorrect file contents.
Parent check:local passed. Five unchanged filesystem cases also passed with 16 assertions.
Scoped type diagnostics decreased from ten to four existing errors. Configured root typechecking passed.
The candidate retains nonzero-slot persistence forwarding and uses task-owned credential homes.
Availability results containing only unconfigured slots, failed fetches, and non-ok responses remain uncovered branches.

## C22 and C24 parent coverage checkpoint

C22 PR #3293 changes one existing test, +48/-26 lines. Baseline affected checks passed 53 cases.
The candidate busy suite passed 18 cases. Its combined implementation run had 52 passes and one unchanged sibling timing failure.
The sibling timer-gap assertion received 218.9ms against a 150ms ceiling. An isolated diagnostic pass does not make the combined run green.
Fresh controls reject backoff inclusion and omitted failed-attempt costs, including successful-overhead masking.
Parent check:local passed 18 selected cases after sequential fixture execution.
An earlier parent overlap between coverage and ordinary tests caused seven fixture-lock failures. Both overlapping runs were discarded.

C24 PR #3294 changes one test file, +9/-241 lines. Baseline 43 cases and candidate 33 cases passed.
Receipt, creation-time, malformed-array, and multiline-regex controls failed at the retained assertions.
Parent check:local passed with 33 cases and configured root typechecking.

Paired production line coverage, on identical source within each pair:

| Slice | Covered before | Covered after | Instrumented lines | Lost covered lines |
| --- | ---: | ---: | ---: | ---: |
| C22 | 10033 | 10216 | 31196 | 0 |
| C24 | 24544 | 24544 | 113518 | 0 |

C22 increases come from timing-dependent logging. C24 preserves the exact covered source locations.
Both pairs ran on macOS with Bun 1.4.4. Neither proves branch coverage, Linux behavior, or whole-repository coverage.
See the measurements document for source bases, scopes, historical coverage, and timing limitations.

## Approval-card consolidation and new inventory audits

C25 card PR #3299 changes one existing test file, +2/-17 lines, with no production change.
Six affected suites passed sequentially: 151 baseline cases and 149 candidate cases.
The changed suite passed 20 cases and 86 assertions. Parent check:local passed against main at 7be110da2c.
Formatting, lint, configured root typechecking, boundaries, secret scanning, and pre-push affected tests passed.
Independent review found no lost behavior guard or correctness blocker.
Wrong channel, unwanted reply, incorrect rejection icon, and missing operator fallback controls each failed a retained assertion.
Paired coverage measured 224 production files and 40097 lines, with zero lost covered source locations.
Relevant notification, storage, and DM coverage matched exactly. Seven incidental scrubber hits are not a claimed improvement.
Neither version tests a channel target with messageTs but no channelId. Line coverage does not establish branch equivalence.
The full repository suite and live Slack were not run locally. PR #3299 passed required validation and merged as 2204b5c8fa41ec45a9bac915c5abe40b527598d3.

The initial six-file approval audit ran no tests or controls. Subsequent slice validation follows below.
PR #3301 implements the copied HTTP replacement: +43/-208 lines, with 87 cases retained.
Parent check:local passed after rebase onto main at 498e8d3542. The implementation also passed 18 credential-resolution cases.
Five controls failed. Parent paired coverage measured 751 files and 114917 fixed line locations, with 29 gained and zero lost production lines.
Independent review found no lost guards. Full-server admission remains outside these handler harnesses.
A baseline 404 instead of 409 remains unexplained. Subsequent passes do not establish a repair.
PR #3301 merged as 5a79d5be5594563fe5434084351884aea7c7266d.
The executor fixture and copied fallback slices passed their scoped checks and controls.
Independent review accepted the fallback deletion. The parent removed repeated executor assertions and duplicated setup before publication.
PR #3304 merged as f9a8fc75b0bfdf629f76f16d5397a646921936ba: -30 lines and one case.
Its retained MCP scenario detects disabled fallback. Paired approval-suite coverage loses no production lines.
PR #3305 merged as ae4bcaab8cfd30a9856041109c0f79dfa6bdb485: +50/-49 lines and one consolidated case.
All four executor controls fail the refined candidate. Cancelled creation and incorrect correlation pass on the baseline.
Its paired coverage gains eight production lines and loses none. Rebased check:local passed with 86 cases and 275 assertions.
Both patches also passed a combined run with 85 cases and 274 assertions.
PR #3306 merged as c4ab35afe10f324b4f15ecb103499d53ab1a62db: +8/-19 lines, with the same migration case retained.
The wrong index column, wrong status filter, missing expiry filter, and overwritten-title controls all survive the baseline and fail the candidate.
Independent review found no blocker. Parent check:local passed. Both migration cases passed with 12 assertions.
The exact normalized DDL assertion can reject equivalent SQL spelling. Migration SQL itself has no LCOV instrumentation.
The paired loaded production scope has 153 files and 31215 locations, with identical 9554 covered locations.
These handler, executor, and migration fixtures do not establish live Slack, full-server admission, workflow resumption, or reopen durability.

The follow-up candidate uses main c4ab35afe10f324b4f15ecb103499d53ab1a62db and changes only approval-requests.test.ts.
After review, it reuses HTTP and workflow fixtures: +44/-64 lines, with 85 cases reduced to 84.
Baseline and candidate pass with 274 and 275 assertions. Both pass 55 adjacent cases with 176 assertions.
Eight behavior controls fail the candidate. Five pass on the baseline. The redundant source-free early guard survives both.
Current-main LCOV gains two handler lines and loses none across 752 files and 114945 locations.
An earlier candidate pair lost six timing-dependent logging locations. Those logs remain part of the evidence.
The later pair follows actual test refinements and a changed baseline. It is not a coverage retry.
Parent check:local passed in 22 seconds, including root typechecking and all 84 affected cases. E2E skipped because no executable path changed.
The allowlist and whitespace checks passed. Production remains unchanged. PR #3307 merged as 9a61e25bbd125a9bc10c622a58382430478cb0f2.
Notification synchronization is documented below as PR #3308.
The initial dashboard audit ran no tests. Its subsequent C26 implementation and validation appear below.

Two new main files remain unchanged after audit. The pre-push selector passed four cases and 39 assertions.
Saved UI configuration passed 25 cases and 110 assertions with deployment settings explicitly cleared.
These two checks ran without mutation controls. No browser or complete UI subsystem validation ran.

C10 merged as 7be110da2c264e6ba3e68879818f7ad0d168c5bd after C22 removed the reproduced timing ceiling.
C24 merged as 5ee2b27ad8ffc9d089a7f59ffce89396a95b2673. The coverage checkpoint merged through PR #3295 as 36a09fbd30ed871c2b47627942441324b8aae323.

## C25 notification synchronization and list/expiry review

PR #3308 retains six cases and all old assertions. Its test diff is +41/-27 lines.
Parent check:local passed. Four behavior controls fail, and the delayed unwanted-email control catches a baseline false pass.
Coverage matches across 778 production files and 116221 locations. Independent review found no blockers.
PR checks passed, but merge-queue run 44161166221 failed job 134315202045 on the unchanged link-preview-sheet test.
The Re-run button did not render before line 146. No toast behavior assertion ran.
After external PR #3312 repaired that fixture on main, the parent requested fresh queue validation.
PR #3308 merged as 531c9fb1f9c97cb2740a21deebf3388b4db28b05 on November 18 at 00:06 BCN.
Response latency and dispatch hangs remain separate limits.

PR #3310 deletes 18 lines and two cases. Both affected suites passed: 114 baseline and 112 candidate cases.
Three controls fail on both versions. The NULL control fails twice on baseline and once on candidate.
The deleted expiry loop detects that regression, but the retained sweep guard also detects it.
Requests alone lose six selector lines. The two-suite union retains all 26274 covered locations out of 115005 across 753 production files.
Independent review approved the deletion. Current-main composition passed 111 affected cases and check:local.
PR #3310 merged as 503dfe00995a4fd05ecbf2c1a0fef652d6038498.

## C26 dashboard and C27 rating checkpoint

C26 #3311 changes two test files, +2/-7 lines. Seven isolated files pass 58 baseline and 57 candidate cases.
Three controls fail both versions. Paired dashboard coverage matches across 49 files and 6258 locations.
Independent review approved the patch. Parent root and UI TypeScript checks, check:local, allowlist, and whitespace checks pass.
The standalone baseline log lacks an exit code, but each baseline coverage process records exit 0.
Browser claims rely on parent observation and retained screenshots, not a complete command transcript.
The screenshots show the same unchanged production source. No approval or external submission occurred. Owned services stopped.

C27 #3313 changes one test file, +33/-149 lines. Its canonical parent pair passes 63 baseline and 61 candidate cases.
Parent verification uses a checkout-local frozen installation and blocks external network access during the pair.
The original request-task and request-model controls failed to parse. Independent review rejected those results.
Valid replacements now fail the selected test at toEqual. Other reviewed controls remain recorded separately.
Paired LCOV matches across 744 files and 113212 locations, excluding the API child.
Parent check:local, allowlist, whitespace, and pre-push checks pass. The existing disabled-hook gap remains unresolved.
Neither slice changes production code or establishes full-suite CI savings. Both now contribute to merged totals.
PR #3311 merged as bcc13793189670179ad39a2e32419c6576a73544. PR #3313 merged as 52452f001f69fff9106b276ce127f641b46339ba.

## C28 preview readiness and superseded alternative

A controlled pending import reproduced the missing-button guard. This does not establish the historical CI cause.
The unpublished preload alternative passed 47 baseline and candidate cases. Delayed module evaluation failed baseline and passed candidate.
Pointer and navigation controls failed their original behavior assertions. Production coverage retained identical locations and hits across 36 files.
Independent review found no blockers. Parent check:local passed. Screenshots show the shared phone preview body, not the Radix sheet.
Fetched main then contained external repair #3312. The parent retired the alternative and verified the merged target case: one pass, four assertions.
The evidence remains at /tmp/test-cleanup-preview-validation/report.md. Neither alternative nor external repair contributes to campaign deletion totals.

## C29 scheduling review and refinement

The static audit covers six scheduling test files. Transitive production boundaries remain partial, and the audit itself ran no controls.
The initial candidate removed three cases. Independent review rejected deletion of the target-only fixture.
The comprehensive fixture uses the same target and creator, so it cannot detect assignment from the wrong field.
The parent restored the original case and removed the status transfer. The final patch is +2/-44 lines, with two removed cases.
Fresh baseline and candidate passed 33/128 and 31/121 cases/assertions respectively. The restored candidate also passed after all controls.
Five fresh controls failed retained assertions: missing insertion, missing manual timestamp, forced cadence, wrong mapped type, and creator-as-target assignment.
All temporary production changes were restored. The final patch changes only scheduled-tasks.test.ts.
Earlier adjacent runs passed 72 cases, including real scripts. These preceded restoration of the target-only case and were not repeated afterward.
The refined coverage pair has identical loaded src locations and hit sets. Selected scheduling scopes retain 360 covered locations out of 829.
The HTTP handler is not loaded. Child scripts, branches, and full-repository coverage remain unmeasured.
Parent check:local and pre-push checks passed. PR #3318 merged as `2a851add58`.
Refined evidence: /tmp/test-cleanup-scheduling-refined/report.md. The earlier three-case report remains historical evidence only.
No owned service remains. The refinement preserves evidence and claims no reclaimed disk space.

## Eval dependencies and benchmark mapping

At main `02cb3bae9a`, the scheduler filter change had merged as `6f7de0e7d1`, followed by the scenario registry change as `02cb3bae9a`.

PR #3326 reduced the registry suite from 70 to 64 cases. Eight independent controls failed their intended retained assertions.
The eval package passed 1,187 cases and skipped the opt-in Turso test. Package typechecking and the root local checks passed.
The coverage pair retained every covered line across its 47 measured files. Execution counts differed.

PR #3327 reduced the combined mapping and catalog suites from 27 to 24 cases. Both versions detected all 13 controls.
Twelve controls failed assertions. The missing TSV source row failed during import.
The eval package passed 1,187 cases and skipped the opt-in Turso test on its separate base. Package typechecking and the root local checks passed.
The root affected-test selector selected zero files for both PRs. The direct package commands exercised the changed suites.

## Outcome normalization and baseline comparison

The dependency and benchmark mapping PRs merged as `0a81244e84` and `3d9cba7de0`. PR #3329 merged as `9534b518f5`.
The normalization and scoring suites passed 38 baseline cases and 37 candidate cases. Independent review confirmed the retained assertions catch an added gate, reversed checks and in-place renaming.
An explicit empty dimension list now exercises precedence over the legacy judge. The corresponding regression passed on the baseline and failed on the candidate.
The full eval package passed 1,183 cases with one opt-in skip on the candidate base.

PR #3330 preserves 18 cases and 28 assertions. Rejecting failed attempts, accepting errored attempts, or counting missing shared scores each failed the revised comparison.
Ignoring output, cache-read or cache-write tokens also failed it. All six regressions survived on the baseline.
The package passed 1,181 cases with one opt-in skip on its separate base. Package typechecking and root local checks passed.
An initial mutation driver failed to load a root import. Only the corrected driver supplied control evidence. Independent review was pending at this checkpoint.
