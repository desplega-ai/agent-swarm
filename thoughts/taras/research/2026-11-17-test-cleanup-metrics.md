# Test cleanup measurements

Taras requested deletion, coverage, and CI timing tracking on 2026-11-17.
Keep forecasts separate from measurements. Do not use a deletion target to justify removing a useful guard.

## Deletions

The current checkpoint includes 40 merged cleanup changes, verified through GitHub.
Merge status checkpoint: main `2c17d2c01c`, 2026-11-18 at 01:37 BCN.
It excludes ledger documents, the budget policy, and the production line added in PR #3269.
Counts include test helpers and E2E scenarios. Cases count executed examples, including parameterized examples, rather than assertion calls.

| Checkpoint | Added test lines | Deleted test lines | Net lines removed | Cases removed or consolidated | Files removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 40 merged changes | 804 | 2921 | 2117 | 110 | 3 |
| Including open PRs #3330, #3333 and #3334 | 847 | 3032 | 2185 | 114 | 3 |

Merged PRs: #3248, #3253, #3258, #3255, #3257, #3259, #3266, #3271, #3275, #3276, #3272, #3273, #3278, #3281, #3285, #3286, #3269, #3291, #3293, #3274, #3294, #3299, #3301, #3304, #3305, #3306, #3307, #3310, #3308, #3311, #3313, #3320, #3321, #3318, #3323, #3324, #3326, #3327, #3329, #3332.
PRs #3320 and #3321 added 47 lines, deleted 45, and removed two cases since the 31-change checkpoint.
Scheduling and scenario registry PRs #3318, #3323 and #3324 added 29 lines, deleted 124, and removed five cases since the 33-change checkpoint.
The unpublished preview alternative and the external repair #3312 also remain outside campaign totals.
The net reduction decreased by 22 lines when C22 landed. Its justified accounting guard growth remains included in the total.

## Forecast, not an acceptance target

The reconciled inventory has 1616 current test files. Of these, 227 received at least partial audit work (14.0%) and 1389 remain pending.
Three files appeared on main after the initial inventory. All three have recorded audits. The object viewer received a static audit, and the existing eval timestamp suite received runtime verification.
Three deleted rows remain as historical records.
The initial 17-PR checkpoint extrapolated to about 10900 net lines and 575 cases removed across the whole campaign.
This extrapolation is weak. The inspected files are not a random sample, and partial audits are not completed cleanup.

Planning ranges for the complete campaign, including work already merged:

- Net test lines removed: 5000 to 15000.
- Test cases removed or consolidated: 300 to 800.
- Root test execution reduction: 5% to 15%, with low confidence until paired measurements exist.
- Complete CI wall-time reduction: 0% to 5%, with low confidence. UI, build, and setup jobs can remain the critical path.

Fewer failed queue attempts could save more elapsed time than shorter successful runs. No numerical forecast exists for that benefit yet.
Revise these ranges after another substantial subsystem batch. Do not report them as achieved savings.

## Coverage reference

The last successful available nightly root coverage run is [43803169864](https://github.com/desplega-ai/agent-swarm/actions/runs/43803169864).
It started on 2026-11-16 at 05:17 BCN, at commit `fbc96bd0fc523a3cc1a72d117c9828799702edbc`.
Its artifact is `root-src-coverage-fbc96bd0fc523a3cc1a72d117c9828799702edbc`.
The parent downloaded its LCOV and calculated the production-only figures below.

| Scope | Covered lines | Instrumented lines | Line coverage | Hit functions | Instrumented functions | Function coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing root summary, all `src/` | 178820 | 203581 | 87.84% | 11175 | 14409 | 77.56% |
| Root production, excluding `src/tests/` | 177387 | 202097 | 87.77% | 11021 | 14245 | 77.37% |

These denominators contain instrumented files, not every production file in the repository. Unloaded files can be absent.
The existing summary includes some test helpers. Use the production-only scope for cleanup comparisons.
Bun's merged function hits are a conservative lower bound because its LCOV lacks function identities.
This artifact has no branch records. Branch coverage is unavailable, not zero and not proven unchanged.
Root, package, API E2E, and UI E2E coverage remain separate until their source scopes and instrumentation can be reconciled.

The next nightly run, [44016125613](https://github.com/desplega-ai/agent-swarm/actions/runs/44016125613), failed its test step.
It started on 2026-11-17 at 05:17 BCN. Do not treat any partial artifact from it as a successful replacement baseline.
No complete post-cleanup coverage comparison exists yet. The historical reference predates unrelated production changes too.

## Paired coverage checkpoint, 2026-11-17

The published-slice pairs ran sequentially on macOS with Bun 1.4.4 and the same production source for each pair.
The scope excludes tests. Each pair names its test selection.
Each pair records its configuration and preload. Newer pairs add network isolation, and their coverage scopes remain separate.

| Slice | Source base | Cases before / after | Loaded production files | Covered lines before / after | Instrumented lines | Lost covered lines |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| C22, PR #3293 | 37d3a1bc85 | 18 / 18 | 152 | 10033 / 10216 | 31196 | 0 |
| C24, PR #3294 | b2ae0d76bf | 43 / 33 | 744 | 24544 / 24544 | 113518 | 0 |
| C25 cards, PR #3299 | 4731627d06 | 22 / 20 | 224 | 11733 / 11740 | 40097 | 0 |
| C25 HTTP, PR #3301 | 36a09fbd30 | 87 / 87 | 751 | 25302 / 25331 | 114917 | 0 |
| C25 fallback, PR #3304 | 498e8d3542 | 87 / 86 | 751 | 25302 / 25302 | 114917 | 0 |
| C25 executor, PR #3305 | 36a09fbd30 | 87 / 86 | 777 | 25739 / 25747 | 116193 | 0 |
| C25 index, PR #3306 | 43e3e5027b | 2 / 2 | 153 | 9554 / 9554 | 31215 | 0 |
| C25 follow-up, PR #3307 | c4ab35afe1 | 85 / 84 | 752 | 25357 / 25359 | 114945 | 0 |
| C25 list/expiry, PR #3310, two-suite union | c4ab35afe1 | 114 / 112 | 753 | 26274 / 26274 | 115005 | 0 |
| C25 notifications, PR #3308 | c4ab35afe1 | 6 / 6 | 778 | 23923 / 23923 | 116221 | 0 |
| C26 dashboard, PR #3311 | 9a61e25bbd | 58 / 57 | 49 | 1478 / 1478 | 6258 | 0 |
| C27 rating, PR #3313 | 9a61e25bbd | 47 / 45 | 744 | 23056 / 23056 | 113212 | 0 |

The comparisons also checked source locations. No pair changed its instrumented line total or loaded production file set.
C24 retained every covered source location. Its four regression controls also failed as expected.
C22 gained nine slow-statement warning lines and 174 scrubber lines because logging depends on timing.
Do not count those 183 lines as new regression coverage. Its accounting controls provide the behavioral evidence.
C25 preserves coverage in approval notifications, both measured storage modules, and Slack DM resolution.
Its seven additional scrubber hits are incidental and do not establish stronger regression coverage.
Four controls failed retained assertions. The absent-channelId fallback remains untested before and after consolidation.
C25 HTTP gains 29 lines in the real approval route. Its five controls provide behavior evidence beyond those line counts.
The fallback pair uses the approval suite. Its real MCP control runs separately through workflow-approvals.
The executor scope includes packages and uses a different denominator, so do not sum these coverage counts.
Executor gains cover actionable creation and the normal async return path. All four controls fail after removing repeated assertions.
The index pair runs both approval migration tests. SQL is not instrumented, so four migration controls provide the useful evidence.
The index definition and complete row assertions detect all four regressions that the baseline missed.
The list/expiry request suite alone loses six selector lines. The retained sweep suite covers all six, so the two-suite union loses none.
C26 measures dashboard source only. C27 measures the test process and excludes its API child. Do not sum these denominators.
Two original C27 controls failed to parse. Valid replacements now fail their intended event-array assertions.
The artifacts contain no branch records. These scoped results do not establish repository-wide coverage equality.
Coverage-instrumented durations are not performance measurements.

One parent C22 attempt overlapped coverage and ordinary tests against the same fixture database.
That ordinary run produced seven lock failures. Both overlapping runs were discarded.
Sequential coverage and check:local runs then passed. Never run these fixture consumers concurrently.
The earlier implementation run also had one unrelated sibling timing failure, recorded in the validation ledger.

## Scheduling coverage checkpoint, 2026-11-18

C29 PR #3318 merged as `2a851add58`. Its refined pair passes 33 baseline and 31 candidate cases.
Loaded src production locations and hit sets match. Five controls fail retained assertions, including the restored target-only guard.
The selected scheduling scopes contain 360 covered locations out of 829 on each side:

| Scope | Instrumented locations | Covered before / after | Lost covered locations |
| --- | ---: | ---: | ---: |
| db.ts lines 5981 through 6525 | 290 | 201 / 201 | 0 |
| scheduler.ts | 448 | 108 / 108 | 0 |
| schedule-task.ts | 65 | 43 / 43 | 0 |
| schedules/validate.ts | 26 | 8 / 8 | 0 |

The HTTP schedule handler is not loaded by this pair. Child scripts, branches, and full scheduling coverage remain unmeasured.
Do not sum these selected scopes with earlier pairs. Evidence: /tmp/test-cleanup-scheduling-refined/report.md and coverage-summary.json.
The earlier adjacent runs passed 72 cases before the target-only case was restored. They are not fresh runs of the final candidate.

The superseded C28 preview pair retained 901 covered locations out of 2839 across 36 production files.
That unpublished alternative contributes no merged lines or cases. The external repair #3312 superseded it.

## Recent measurements at main `2c17d2c01c`

| Change | Added / deleted test lines | Cases before / after in the affected suites | Paired production coverage |
| --- | ---: | ---: | --- |
| Eval timestamp fixture, #3320 | +47 / -32 | 4 / 4 | All 27 loaded production records match. Generated shell code is outside LCOV. |
| Duplicate Codex cases, #3321 | +0 / -13 | 85 / 83 | 10,408 of 33,347 locations on both sides across 183 files. No lost locations. |
| Scheduling filters, #3323 | +24 / -16 | 36 / 36 | 24,709 of 115,377 locations on both sides across 783 files. No lost locations. |
| Eval scenario catalog, #3324 | +3 / -64 | 21 / 18 | 7,158 of 15,503 locations on both sides across 76 files. No lost locations. |
| Eval dependencies, #3326 | +7 / -47 | 70 / 64 | Both runs covered 4,066 of 7,455 lines across 47 files. |
| Benchmark mapping and catalog, #3327 | +1 / -22 | 27 / 24 | All 12 files retained their covered lines. The mapping module covered 361 of 364 lines and all six functions. |
| Outcome normalization, #3329 | +3 / -13 | 38 / 37 | Both runs covered all 45 instrumented lines across the two production modules. |
| Baseline comparison, #3330 | +16 / -8 | 18 / 18 | Both runs covered the same 3,773 of 7,263 lines across 45 files. |
| Scoring examples, #3332 | +2 / -52 | 44 / 40 | Same 3,633 of 10,262 lines across 56 files. |
| Judge-error persistence, #3333 | +5 / -66 | 35 / 33 | Same 4,146 of 10,512 lines across 58 files. |
| Run summary intervals, #3334 | +22 / -37 | 54 / 52 | Same 614 of 707 lines across four files. |

PRs #3330, #3333 and #3334 remained open at this checkpoint. Each coverage pair has its own denominator.

## CI timing reference

Times below come from successful GitHub test steps. They exclude installation, runner allocation, and artifact upload.

| Run | Revision | Root test steps summed | Slowest root test step | Interpretation |
| --- | --- | ---: | ---: | --- |
| [44004815986](https://github.com/desplega-ai/agent-swarm/actions/runs/44004815986), nightly CI | `dc0409908b8015331ef32a6f0052a87bc8826899` | 639 seconds | 110 seconds | Historical reference |
| [44141635547](https://github.com/desplega-ai/agent-swarm/actions/runs/44141635547), merge queue | `6f596897de8b864a6ebe80616657cb88327fd425` | 662 seconds | 96 seconds | Observational checkpoint only |

The sum increased while the slowest shard decreased. This does not establish a cleanup speed improvement.
These runs differ in workflow, revision, runner load, and cached shard weights. They are not a controlled benchmark.
The later run's longest job was UI E2E shard 5 at 286 seconds, including that job's setup and reporting.
Do not convert root test savings directly into total CI savings.

The affected-test jobs on #3318 and #3323 passed on all eight shards.
Their slowest shards took 2.2 and 3.2 seconds respectively.
Those jobs select changed tests. Campaign-wide CI savings still need a controlled full-suite comparison.
See [#3318 timings](https://github.com/desplega-ai/agent-swarm/actions/runs/44201948622) and [#3323 timings](https://github.com/desplega-ai/agent-swarm/actions/runs/44202106462).

## Tracking protocol

For each cleanup slice, record base and candidate revisions, test selection, runtime version, runner platform, and pass, fail, skip, and retry counts.
Record added and deleted lines separately, removed cases, retained contracts, and detected or surviving regression controls.

For changed test scopes, compare production coverage on the same source revision with baseline and candidate tests.
Use existing `bunfig.coverage.toml` and `scripts/run-root-coverage.ts` for root coverage.
The ordinary Bun config disables coverage, and Bun parallel test mode does not emit LCOV. Do not infer coverage from a passing parallel run.
Record covered and instrumented line counts plus newly uncovered source locations, not only the percentage.
Keep the source denominator fixed. A removed test, mock, generated file, or unloaded module must not make production coverage appear better.
If coverage cannot measure the affected path, record the limitation and retain a direct behavior check and practical regression control.
Explain any coverage decrease before accepting the slice. Coverage equality alone does not prove assertion strength.

Use existing API E2E LCOV, route/tool/workflow/CLI coverage, and UI E2E LCOV artifacts for their respective boundaries.
Do not add exclusions, skips, or retries to improve the reported numbers.

Measure timing without coverage instrumentation. For a performance claim, alternate baseline and candidate runs on the same runner and configuration.
Use at least three runs per version and report the median, range, and failures. Do not discard slow or failing runs.
Compare total test-step seconds and the slowest shard. Track complete workflow duration and queue failures separately.
Use GitHub timing and result artifacts instead of a second reporting service.
Compare full-suite runs with full-suite runs. PR jobs can select only affected tests, so their comparison against nightly main can exaggerate gains.
For example, PR #3291 reports a 51% root wall-time reduction against main while running only affected tests. That is not campaign savings.

After each merged batch, append a dated checkpoint with PRs, cumulative reductions, coverage artifacts, timing samples, and unresolved limitations.
Keep missing coverage or timing evidence explicitly unmeasured. The campaign is not complete while its coverage comparison remains unresolved.

## Local validation selection

PR #3287 changes local pre-push and check:local selection. It selects nearby tests and lints changed files.
PR #3292 documents that behavior. Both are present in the parent branch based on main at 59e73f06a1.
The reported 427-to-39-second comparison belongs to #3287's hook change, not this cleanup campaign.
Merge-queue CI still runs the full suite. Keep local selection savings separate from cleanup timing comparisons.
Use PRE_PUSH_FULL=1 when full local validation is required. Coverage comparisons must name their actual test selection.

## Paired artifact identity

Local LCOV artifacts use /tmp/test-cleanup-c22-coverage and /tmp/test-cleanup-c24-coverage, with before and after subdirectories.
These hashes identify the compared files. Temporary paths are not durable download links.

| Artifact | SHA-256 |
| --- | --- |
| C22 before | 24b97445becf22ad5eba31673dd57005f5759f5f6ea1cde5d77f6b3df79d7258 |
| C22 after | b16aa6b59c7e2f94c406a243c01ca72f4d9b5939c6671e588e41286d0e76d074 |
| C24 before | 6bbdfac58f86f51737fc6cbb0f1634f39a69eaa73b8c9d9d7043bbd9afbca659 |
| C24 after | eeb11d60ed09fea2f27e4434ec69265c043b659906d346c56fbceef4d3a648c4 |

Each run uses bun test with a copy of bunfig.coverage.toml, an absolute preload path, and a separate coverageDir.
The environment contains PATH, DESPLEGA_TELEMETRY_ENV=test, and SWARM_TEST_TEMPLATE_CACHE=0. Run each fixture consumer sequentially.
The selected files are src/tests/db-client-busy-retry.test.ts and src/tests/heartbeat-jev-gate.test.ts, respectively.
