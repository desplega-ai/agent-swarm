# Test cleanup measurements

Taras requested deletion, coverage, and CI timing tracking on 2026-11-17.
Keep forecasts separate from measurements. Do not use a deletion target to justify removing a useful guard.

## Deletions

The current checkpoint includes 27 merged cleanup changes, verified through GitHub.
Merge status checkpoint: 2026-11-17 at 20:39 BCN.
It excludes ledger documents, the budget policy, and the production line added in PR #3269.
Counts include test helpers and E2E scenarios. Cases count executed examples, including parameterized examples, rather than assertion calls.

| Checkpoint | Added test lines | Deleted test lines | Net lines removed | Cases removed or consolidated | Files removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 27 merged changes | 639 | 2417 | 1778 | 84 | 3 |

Merged PRs: #3248, #3253, #3258, #3255, #3257, #3259, #3266, #3271, #3275, #3276, #3272, #3273, #3278, #3281, #3285, #3286, #3269, #3291, #3293, #3274, #3294, #3299, #3301, #3304, #3305, #3306, #3307.
The latest five slices contribute +145/-370 lines and three removed cases.
Notification synchronization and the reviewed list/expiry candidate remain outside merged totals.
The net reduction decreased by 22 lines when C22 landed. Its justified accounting guard growth remains included in the total.

## Forecast, not an acceptance target

The reconciled inventory has 1615 current test files. Of these, 188 received at least partial audit work and 1427 remain pending.
Two files appeared on main after the initial inventory. Both now have recorded audits. Three deleted rows remain as historical records.
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
Newer pairs use a copy of the existing coverage configuration, the existing preload, and a network guard.

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
The artifacts contain no branch records. These scoped results do not establish repository-wide coverage equality.
Coverage-instrumented durations are not performance measurements.

One parent C22 attempt overlapped coverage and ordinary tests against the same fixture database.
That ordinary run produced seven lock failures. Both overlapping runs were discarded.
Sequential coverage and check:local runs then passed. Never run these fixture consumers concurrently.
The earlier implementation run also had one unrelated sibling timing failure, recorded in the validation ledger.

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
