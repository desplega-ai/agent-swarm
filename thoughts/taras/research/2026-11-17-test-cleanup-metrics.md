# Test cleanup measurements

Taras requested deletion, coverage, and CI timing tracking on 2026-11-17.
Keep forecasts separate from measurements. Do not use a deletion target to justify removing a useful guard.

## Deletions

The first checkpoint includes 17 merged cleanup changes, verified through GitHub.
It excludes ledger documents, the budget policy, and the production line added in PR #3269.
Counts include test helpers and E2E scenarios. Cases count executed examples, including parameterized examples, rather than assertion calls.

| Checkpoint | Added test lines | Deleted test lines | Net lines removed | Cases removed or consolidated | Files removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 17 merged changes | 384 | 1537 | 1153 | 61 | 3 |
| Pending C08, C10, C22, C24 only | 108 | 493 | 385 | 18 | 0 |
| Combined, if all four land unchanged | 492 | 2030 | 1538 | 79 | 3 |

Merged PRs: #3248, #3253, #3258, #3255, #3257, #3259, #3266, #3271, #3275, #3276, #3272, #3273, #3278, #3281, #3285, #3286, #3269.
Pending means implemented and reviewed, not merged. C08 is PR #3291. C10 is PR #3274.
C22 and C24 remain candidate patches at this checkpoint.

## Forecast, not an acceptance target

The inventory has 1613 current test files. Of these, 171 received at least partial audit work and 1442 remain pending.
Straight extrapolation from current reductions gives about 10900 net lines and 575 cases removed across the whole campaign.
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
