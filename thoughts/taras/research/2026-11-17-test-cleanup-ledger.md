# Sustained test cleanup campaign

Status: active. Baseline: 20c45be1a9. No releases.

## Scope and completion rules

Audit every tracked test subsystem, plus its fixtures, mocks, helpers, and runner configuration.
Read production before judging tests. Preserve distinct platform and integration contracts.
Default changes affect tests, specs, fixtures, test helpers, and documentation.
Taras permits concrete production-defect exceptions when identified explicitly and isolated in separate PRs. C15 is the existing exception.
A completed row needs contract reasoning, validation evidence, and a landed PR or a precise blocker.
Pending inventory rows do not imply an audit. Reconcile this inventory against main after each merge.

## Measurements

Taras requested coverage and CI timing tracking alongside deletion totals.
See [campaign measurements](./2026-11-17-test-cleanup-metrics.md) for verified totals, forecasts, coverage references, and comparison rules.
The current checkpoint contains 2117 net test lines and 110 cases removed across 40 merged changes at `2c17d2c01c`.
The recorded C22 through C27 coverage pairs lost no covered production lines within their named final scopes.
C25 cards, HTTP, fallback, executor, index, and follow-up slices landed in PRs #3299, #3301, #3304, #3305, #3306, and #3307.
Complete post-cleanup coverage and controlled CI savings remain unmeasured.

## Budget

Taras requested a budget after the inventory found no existing policy.
Policy added to runbooks/testing.md: zero net growth by default for cleanup PRs.
Justify additions per named behavior contract or demonstrated flake repair.
Count fixtures, mocks, and helpers. Never fund growth by removing an independent contract.
Record additions and deletions separately for each slice.

## Current work

- Inventory and rule audit: complete. Taras requested a new budget. See runbooks/testing.md.
- Additional scope includes black-box scenarios, runner scripts, fixtures, shell checks, and chart tests. The scenarios directory has 164 tracked files at da88ba4a02, including helpers.
- Prioritize workflow, Slack, apps, memory, runtime, providers, task/session, extensions, authentication, and dashboard groups.
- Helper duplication candidates require behavioral review. Repeated names alone do not justify deletion.
- C01 merged through the queue as fddcc526172b9e751877817547da32c1f18718d2.
- C02 drain merged through PR #3253. Independent review and required queue checks passed.
- Budget policy merged as 7231929e6ba048748649dab814a07decde69f6ba through PR #3254.
- C03, C04, C05, and C07 merged after independent review and required queue checks.
- Organization website and profile guards: audited unchanged, 39 tests passed (C11).
- Enabled tools: removed two repeated registrations. All 17 tests, both mutation controls, and independent review pass (C12).

## Validation checkpoint

- Full root suite: 22548 passed, 43 skipped, 16 failed, 2 errors across 1498 files. 648.46 seconds. Log: /tmp/test-cleanup-root.log.
- Full API E2E: 174 passed, 1 failed. script-inline-run reports unexpected stderr on both attempts. Log: /tmp/test-cleanup-e2e.log.
- Full UI E2E: 283 passed, 74 skipped, 1 failed. OAuth redirect final URL differs from expected preserved query/hash. Baseline log recorded these results. The repaired redirects suite passed all 13 tests afterward.
- Root lint and TypeScript: passed. Local check loop: passed.
- Initial broad checks ended. Follow-up diagnoses and remaining risks appear below.
- Initial broad validation processes ended. Failure excerpts are in 2026-11-17-test-cleanup-validation.md.
- Removed owned temporary logs, UI build output, browser test artifacts, and e2e-results.json.
- Cleanup availability stayed 13 GiB at rounded df precision. Initial availability was 16 GiB. Dependencies and shared caches remain.
- Log paths identify completed runs. Scratch logs can be removed after evidence extraction.

## Validation and landing

Run affected tests and practical mutation controls before review.
Run check:local and required repository gates before push.
Use narrow PRs with the repository template, review, and merge queue.
The active GitHub ruleset requires Merge Gate and the merge queue.

## Candidate slices

### C01: Codex model resolution and pricing

State: landed. Commit cb38505790 passed independent review. PR https://github.com/desplega-ai/agent-swarm/pull/3248 merged as fddcc526172b9e751877817547da32c1f18718d2.
Diff: +0/-51 test lines. Removed ten cases and three repeated arithmetic assertions.
Production reviewed: codex-models, codex-adapter, reasoning-effort, runtime-model-catalog, models-catalog, seed-pricing, agent-runtime-models.

| Removed duplication | Retained contract |
|---|---|
| Three alias cases in adapter suite | Release suite pins opus, sonnet, and haiku to concrete model IDs |
| Seven named-model passthrough cases | Unknown future ID and uppercase inputs prove open-ended lowercase passthrough |
| Cost arithmetic repeated for three releases | Adapter suite checks mixed cached usage, zero usage, and negative-uncached clamp |
| No release metadata removed | Release suite retains prices, context, output limit, reasoning, seed rows, and UI selector visibility |

Validation: original 137 tests passed. Retained 127 tests passed, with 486 assertions.
Parent check:local passed in 39 seconds. It ran frozen install, Biome, anti-slop rules, Bun typecheck, and affected tests.
E2E scoping found no changed API or runner code. Required PR and queue gates passed. Whole-scope Biome and TypeScript checks passed. Boundary checks passed. Dependency graph reports 2613 warnings, zero errors.
Delegate mutation controls: lowercase removal caused four failures, alias corruption one, double billing five, clamp removal two, cache-price corruption nine, context corruption thirteen.
Production restoration: delegate reports byte-for-byte restoration. Parent observed no production diff.
Risk: deterministic adapter fixtures do not validate a live Codex CLI. Existing session and platform tests remain.


### C03: Workflow retries

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3258 as 0786d4e323e271752b9c04c9ad61bc7a6630ab23. Final independent review passed.
Final diff +42/-94 lines. One test deleted, no new test calls.
Removed duplicated initial success and three detached-listener waits. Corrected misleading validation labels.
Retired the due-time fixture before later pollers. Required one queued retry and exactly two executor calls before exhaustion.
Six-file suite: original 93 passed, 1 skipped, 472 assertions. Revised 92 passed, 1 skipped, 477 assertions. Repeat passed.
workflow-engine-control passed. Allowlist, scoped Biome, and diff checks passed.
Ten controls detected broken initial validation, retry validation, pass routing, retry limits, stop generation, task ownership, foreach cancellation, fixture isolation, and recovery.
Parent verification after review: 92 passed, 1 skipped, 478 assertions. Biome and diff checks passed.
Two new temporary controls dropped the validation retry policy and halted after the first retry. Both failed the exact retry-count assertion.
A forced fixture assertion failure left the subsequent exhaustion test passing, proving finally cleanup prevents cascading failures.
The restored temporary copy passed 18 tests. Shared production remained unchanged.
Foreach timing observations and the existing skipped watchdog remain unresolved risks.
Existing gap: poller validation halt after an executor retry lacks direct coverage. Initial validation halt is covered separately.
The original audit notes below explain the contract decisions. Suggested foreach sleep removal was not adopted.
Read executors/agent-task, foreach, sub-workflow, validation, checkpoint, retry-poller, task-step-routing, engine, resume, recovery, foreach-driver, foreach-join, step-input, and retry DB selectors.

- Candidate deletion: workflow-retry-validation lines 224-262 never starts a poller. Initial mandatory success remains in workflow-engine-v2 lines 717-744.
- Preserve the actual retry and pass-port test at retry-validation lines 264-306.
- Candidate removal: sleeps after awaited failTask with detached listeners at workflow-agent-task-retry lines 295, 432, 481.
- Rename initial validation halt test at retry-validation lines 308-340. It does not test a poller halt. Preserve failed run, failed step, and absent nextRetryAt.
- Inspect no-queued-retry observation sleeps in foreach-supersede-retry lines 196-197 and 306-309 before removal.
- Keep foreach ownership, concurrency, cancellation, and attempt history boundaries. No justified whole-test deletion found there.
- Risks: 50ms poller observations can pass without a tick. Preserve stop-generation and stale-event guards.
- Risk: retry-v2 due-time test leaves a retry queued in shared storage. Later pollers may execute it against shared counters.
- Candidate repair: retire that workflow after assertions. Require initial queued state and exactly one retry in the exhaustion case.

Verification when implemented:

    bun run test:root -- src/tests/workflow-retry-validation.test.ts src/tests/workflow-agent-task-retry.test.ts src/tests/workflow-retry-v2.test.ts src/tests/workflow-foreach-retry.test.ts src/tests/workflow-foreach-supersede-retry.test.ts src/tests/workflow-engine-v2.test.ts
    bun run e2e --only workflow-engine-control
    bun run check:unit-test-allowlist

### C02: API drain

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3253 as 8f7e326962c0ed6b05ec5a6256711c53f1c53d03. Independent review passed. +2/-19 lines.
Consolidated successful multi-task handoff with repeated-call assertions. Removed five artificial 5ms waits and one 2-second delay.
Retained all four suites and distinct API, worker, HTTP, MCP, transaction, SIGTERM, deadline, and default-off contracts.
Initial 36 tests passed. Revised API and runner suites: 29 passed. Worker suite: 2 passed. Four unchanged process tests passed.
Temporary-copy mutations caught repeated handoffs, bypassed HTTP admission, bypassed MCP admission, and an immediate deadline.
Production never changed. Parent read the implementation and diff. Independent review found no lost contracts.

### C04: Redirect race

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3255 as fcc4247d0e38fb3cf3651cc590e9d857153dd071.
Production deliberately consumes oauth=success and selects tab=auth. The old browser assertion raced that cleanup effect.
Changed the query to probe=keep, preserving the same query/hash redirect contract.
Existing route-redirect.test.tsx retains OAuth forwarding assertions. No dedicated UI OAuth completion guard was found.
Before: full UI suite failed this exact case. After: bun run e2e:ui -- --no-build specs/redirects.spec.ts passed 13 tests.
No production change or new test. Independent final diff review passed.

### Broad validation failures to diagnose

The following files failed during the initial broad run. Follow-up status appears in C05, C06, C08, C09, and the validation record.
- apps/ui/src/components/apps/app-shell.test.tsx
- src/tests/script-executor-quickjs-pool.test.ts
- src/tests/asset-key-migration.test.ts
- src/tests/entrypoint-chown-no-follow.test.ts
- src/tests/entrypoint-repo-clone-target.test.ts
- src/tests/workflow-swarm-script.test.ts
- src/tests/preload-env.test.ts
- src/tests/worktree-reaper.test.ts

API E2E: script-inline-run failed its clean-stderr check twice. Preserve that assertion until the stderr cause is understood.
UI E2E: redirect race repaired in C04. Full UI rerun is not needed without another relevant change.

### C05: Worktree reaper fixture portability

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3257 as 8b10ef25636aac900e14ed35d2a531ba08ecaa24. Independent review passed. +2/-2 test lines. All 21 cases retained.
Production read: src/commands/worktree-reaper.ts. The full test file was audited against ownership, dirtiness, remote refs, TTL, ignored dependencies, persistence, and damaged-worktree contracts.
Canonicalize the temporary fixture root with realpath, matching Git and kernel process paths on macOS.
Before: isolated run failed six cases, 15 passed. After: 21 passed, 66 assertions, 7.04 seconds. Biome passed.
Temporary-copy controls: disabling inUse fails the active-task assertion. Disabling only process cwd protection fails the process assertion.
Production files stayed unchanged.
Residual risk: a nonexistent workingDir under an aliased parent falls back to its raw spelling. This is distinct from existing supported worker cwd inputs.

### C06: Entrypoint platform guards, retained

Read real chown_no_follow and prepare_clone_target blocks and their seven tests. Preserve all guards.
Plain macOS PATH: 5 passed, 2 failed because BSD realpath lacks -m and mv lacks -T.
GNU PATH: all 7 passed, 23 assertions. Command:

    PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH bun run test:root -- src/tests/entrypoint-chown-no-follow.test.ts src/tests/entrypoint-repo-clone-target.test.ts

No test deletion or added mock. Symlink refusal and incomplete clone preservation protect separate safety boundaries.
Docker daemon is unavailable locally. This GNU-tool run does not claim Linux container validation.

### Isolated diagnosis of initial broad failures

Unchanged app-shell: 5 passed. QuickJS pool: 7 passed. Asset migrations: 8 passed. Preload environment: 2 passed.
These narrow runs did not reproduce the broad failures. Load sensitivity remains unresolved. No retries or timeout increases added.

### C07: Session log storage and HTTP consolidation

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3259 as fc2e952c22330f09f4ff21cc16987c22fca2665e. Independent review passed. Diff +59/-314 lines.
Read storage, numbering, reassociation, session routes, core authentication, session access, and pool claims before tests.
Removed copied HTTP routing, validation, and server lifecycle from session-logs.test.ts. All seven DB test bodies remain unchanged.
Moved missing-field errors, optional taskId, empty task logs, and error-field assertions to core-session-data against real HTTP.
Retained raw database redaction verification. Pool tests merge idempotency and active-session identity while retaining session isolation and late arrivals.
Unit files: 22 original tests become 10 retained tests, 50 assertions. Core E2E passed with 95 HTTP calls.
Allowlist, Biome, E2E typecheck, and diff check passed.
Temporary controls reset flush numbering, sorted legacy rows by line number, and removed the reassociation session filter. Each caused two failures.
Restored tests passed 10/10. Shared production remained unchanged. Delegate removed approximately 156 MiB of scratch copies.
Limits: pool tests call DB functions rather than the claim tool. Preloaded storage is in memory, so these cases do not prove reopen persistence.
Provider chunk framing, final flush delivery, upload failure, and actual user/agent-token authentication remain separate boundaries.
Reviewer observed the pre-push hook's temporary unstaged-change stash during review. Parent verified restoration with the exact +59/-314 diff.
The optional-taskId persistence check overlaps DB mapping coverage but also guards the production HTTP write path after authorization. Retain it.

### C08: Native script stderr diagnosis

State: landed through PR #3291 as b2ae0d76bf. Independent review passed. Diff +46/-78 lines. Cases decreased from 89 to 84, with no new calls.
The script returned exitCode 0 and Bash startup stderr from /Users/taras/.bashrc attempting to source /.turso/env.
The original inline sandbox used plain bash -c before env -i. Spawn mode already used --noprofile --norc -p.
A shell probe with open stdin reproduced the warning. The protective flags removed it.
Retain the clean-stderr assertion. This is a production environment-isolation defect, not obsolete test coverage.
C15 isolated and merged the inline-wrapper fix with controlled startup-file checks, outside this test-only slice.
Removed four fabricated executor cases and one repeated classifier case. All 15 distinct classifier inputs remain.
Corrected three child-process budgets. Scenario assertions compare fields and reject extra keys. The stderr guard now reports scrubbed evidence.
Affected units: 84 passed, 276 assertions. Nine classifier mutations failed. E2E typecheck, boundary checks, allowlist, Biome, and diff checks passed.
The original wrapper caused E2E failure during preparation. After C15 merged, parent validation passed 84 unit cases and script-inline-run with 30 HTTP calls.
Parent check:local and E2E typechecking passed before C08 landed. Paired C08 line coverage remains unmeasured.

### C09: QuickJS pool timing

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3266 as 42d7240cb2bf56258b40ca0e0bed62e55685847e. Final independent review passed. Parent read pool configuration, worker lifecycle, acquisition/release, execution, and pool tests first.
The failed heldPeak assertion follows a 10-second observation deadline. Slow worker boot can release the gate before every configured worker arrives.
Preserve configured concurrency, excess-job queuing, shared pool reuse, invalid-size refusal, and abort-during-boot boundaries.
Replaced polling with a promise resolved by actual worker requests. Existing child timeout remains 30 seconds. No retry or timeout increase.
Final diff +9/-7 lines. Two added lines repair the demonstrated readiness race in the same contract. No new test calls.
Peak concurrency now covers the full run. A race with settled jobs preserves diagnostics when worker boot fails.
Seven tests pass. Delaying worker readiness by 11 seconds made the original case fail with heldPeak 0 instead of 8.
The repaired case passed with that delay. Allowing one extra slot still failed with 9 workers instead of 8. Restored case passed.
Coverage limit: returning an existing busy slot instead of queuing survived both original and repaired probes. Do not claim that mutation is detected.
A temporary 10ms hold did not detect it either and was discarded. No new sleep remains.
Controlled worker boot failure now fails promptly with peak 0 instead of waiting for the child timeout.

### C10: Slack rendering

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3274 as 7be110da2c264e6ba3e68879818f7ad0d168c5bd.
Queue run 44125275220 failed the original 300ms DB ceiling at 364.037399ms.
Run 44131652948 failed the replacement 200ms ceiling from PR #3277 at 201.530818ms.
After C22 merged, queue run 44146720160 was cancelled. Run 44147151008 then passed required merge validation.
Independent review passed. Final diff +5/-148 lines. Three duplicate tests removed. No live Slack operations.
Candidates: three repeated delivery tests, substring checks following exact equality, and payload key lists that reject harmless additions.
Retain recovery stop-before-update order, native Markdown, truncation, child-before-conclusion delivery, visibility, caption limits, and stale UI-spec fixtures.
All five controls failed: answer replacement, finalized-child repetition, early conclusions, unwanted Markdown conversion, and missing recovery updates.
Validation: rendering 191 passed, delegation 2 passed, blocks 78 passed, caption 6 passed. Allowlist, Biome, and diff checks passed.
Shared production stayed unchanged. The delegate removed 59.2 MiB of temporary files.
Review retained a specific refusal of blocks on startStream. A sixth control adding blocks failed that assertion.
The removed exact key set no longer rejects harmless extra fields. Existing settlement checks retain conclusionKind complete.
The delegation suite remains separate because it covers the full rendering pipeline.
Unaudited sections: detailed give-up cases, optional-tree transitions, most deferral chains, query plans, session-status internals, and UI-spec conversion internals.
Mock risks: stopStream does not append markdown_text, and history mocks ignore pagination and oldest. Existing fallback cases prove outgoing payloads only.

### C11: Organization website and profile guards

State: audited and retained unchanged. Production read: org-website, company-profile, telemetry-context, and relevant swarm-config-guard dispatch and validators.
All 39 tests passed with 135 assertions.
Retained hostname normalization, non-public address refusal, credentials/scheme refusal, proxy-origin matching, and free-mail versus company suggestions.
Config acceptance and telemetry omission are distinct boundaries. Explicit unsupported-profile values retain a contract beyond loops over production enum constants.
No deletion justified. No mocks or fixtures require removal. This audit does not cover the rest of telemetry or general configuration.

### C12: MCP enabled-tool selection

State: landed through PR #3285 as 98ca0e707f3f1666801e7965fb3ce3d21bf583b4. Independent review passed. Removed two repeated server registrations, +0/-2 lines. All 17 tests pass with 26 assertions.
Read parser, server allowlist resolution and pruning, capability and scripts-only selection, MCP session option resolution, and configuration injection.
Retain parser formats, invalid config refusal, deployment fallback, capability override, scripts-only override, full-surface bypass, warnings, and per-agent session reload.
The HTTP helper delegates to real handleMcp. It does not copy routing logic. It omits core authentication, so it does not establish authentication coverage.
The private SDK registry helper exposes implementation structure, but current tests protect distinct server-selection paths not all covered by HTTP.
Removed repeated registrations for omitted versus explicit undefined options, and empty string versus whitespace/comma-only allowlist. Parser cases retain both emptiness forms.
Kept warning-deduplication's second registration, which protects a distinct observable contract.
Temporary server controls bypassed capability selection and changed empty allowlist behavior. Each failed its matching retained guard. Scoped Biome passed.

### C13: Model routing package

State: all three package test files audited and retained unchanged. All 48 tests passed with 110 assertions.
Read default-route, credential-status, scoped-fetch, environment/protocol helpers, types, and all seven provider definitions before their tests.
Preserve Claude and Codex credential isolation, cloud precedence, API key versus subscription behavior, free validation outcomes, and missing-key refusal before networking.
Provider validation fixtures protect different protocols and status semantics. They do not duplicate gateway selection or harness-compatibility guards.
Scoped fetch protects URL prefixes, absolute same-origin URLs, cross-origin refusal, explicit redirect refusal, and malformed base URLs.
Temporary origin-bypass and redirect-follow controls each failed the matching retained guard. Only recording fetches ran, with no live provider requests.
No unused fixtures or redundant mocks found. Network doubles are necessary to keep secret-routing checks local.
Limits: the tests do not prove live provider compatibility, and validateRoute timeout cancellation lacks a direct guard.

### C14: Model catalog package

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3271 as b27cd0917ff62aea52d87f5fff2fece7182114ef. Independent review passed. Final diff +17/-32 lines. One overlapping routing test consolidated.
Original suite: 66 passed, 285 assertions. Final suite: 65 passed, 282 assertions. Package TypeScript, Biome, and diff checks passed.
All 12 mutation controls failed. Original assertions missed shared wrong subscription results, empty picker output, and both dated-candidate controls.
Subscription routing now uses one row declaring only high effort, which differs from fallback levels. All three prefixes retain literal checks.
A thirteenth control substituted fallback levels and failed. Final review found no remaining findings.
Remove unused fixture rows and duplicated OpenCode max assertions. Preserve the negative max guard and distinct provider routing boundaries.
Repair subscription and picker assertions that compare production calls against one another. Literal expected values must detect empty output.
Make existing dated fixtures distinguish excluded models from eligible winners. Preserve fixed policy dates and data-specific model pins.
Existing defect: nearestReasoningLevel("medium", ["high", "low"]) returns "high", although its documented tie rule chooses the lower level.
Keep that production defect separate from test-only consolidation. No current guard is deleted to conceal it.
Remaining gaps include alias ties and missing dates, soak thresholds, namespace competitors, and validation of subscription mismatch diagnostics.
These gaps do not justify replacing the compact suite or deleting distinct routing contracts.

### C15: Sandbox startup isolation follow-up

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3269 as 6a41ba92ae243ba181b1f1253a4d0ac77f123abf. An earlier queue attempt failed the unrelated database timing fixture. PR #3277 repaired that fixture before the successful queue run. Independent review passed. Production diff +1/-0. Test/helper diff +31/-23.
Production and existing sandbox tests were read first. A controlled startup file confirms the C08 production defect independently.
With BASH_ENV pointing at a task-owned file that exits 37, inline mode executes it and exits 37. Spawn mode exits 0.
Adding --noprofile --norc -p to the inline command exits 0, forwards stdin, and produces no stderr.
Applied the existing spawn-mode startup protection to inline Bash mode.
Extended the existing startup-isolation test across both modes. It uses owned .bashrc and BASH_ENV fixtures. Prelude checks read the final argument.
runChild gained optional keepStdinOpen, retaining its timeout diagnostics and existing default behavior. The fixture child never waits for EOF.
Preserve Windows passthrough, interpreter resource floors, process containment, and explicit environment transport.
The extended startup guard fails on original production and passes with the fix. All 18 sandbox tests passed in the temporary copy.
The real script-inline-run scenario passed with 30 HTTP calls and no retries. Five affected files passed 138 tests, with two platform skips.
A PATH-only probe with open stdin reproduced the real .bashrc warning before the fix and empty stderr afterward. BASH_ENV was absent.
The final fixture independently fails when --norc or -p is removed. Restored sandbox and QuickJS helper checks passed 25 tests, 78 assertions.
Eight added test/helper lines protect this demonstrated startup-isolation defect. Linux socket-stdin behavior remains unverified locally.
Final isolated check:local passed in 546 seconds with GNU coreutils on PATH: 13368 root passes, 34 skips, and zero failures.
API scenarios: 172 first-attempt passes and three retry passes. The retries were slack-skipped-task-v2, workflow-approvals, and slack-approval-buttons.
The first timed out on reactions.add. The latter two reported ECONNRESET and absent Socket Mode. Diagnosis continues separately.
Default macOS tools reproduced the two known entrypoint platform failures. GNU tools preserved and passed those guards.
Keep this fix separate from C08 test-only consolidation.

### C16: Console and OTel contracts

State: landed through PR https://github.com/desplega-ai/agent-swarm/pull/3275 as 005f4b47f480822407ecf7029fa469363ab36034. Independent review passed. Two test files changed, +1/-47 lines. No new cases.
Read console formatting and fail-closed behavior, OTel implementation and facade, session-cost forwarding, and harness context injection.
Removed a fake facade no-op case. A temporary identity assertion proved its import was the test's own recordSessionCostSpy.
That case never executed the production facade. Its claimed disabled-telemetry guard was absent before this deletion and remains a coverage limit.
Removed a repeated configured-default service-name case. Literal custom-base assertions retain API/worker separation, and default-role guards remain.
Controls removing the API suffix and ignoring the configured base each fail retained guards.
Baseline: six OTel files passed 41 tests and 116 assertions. Final: 39 passed, 112 assertions. Console scrubber passed 8 tests and 53 assertions unchanged.
Retain console formatting, all methods, reinstall behavior, nested logging refusal, formatting failure, empty calls, and throughput.
Retain metric scrubbing, six token classes, zero-cost token emission, HTTP forwarding, drift, span kind, event-loop reset, and trace-context boundaries.
Console and OTel mocks record output at distinct egress boundaries. They are required for local checks without live telemetry.
Limits: the HTTP metrics module mock persists across files. Event-loop sampling still uses bounded sleeps. Live exporter behavior is not validated.

### Wave 4 validation

Local check loop passed in 507 seconds: frozen install, Biome, anti-slop, typecheck, 12733 affected tests, and 175 API scenarios.
The root run skipped 26 cases and failed none. API checks reported zero failures and zero flaky results.
Final review refinements passed their affected tests, Biome, root typecheck, allowlist, and diff checks separately.

### C17: Memory audit, storage slice landed

All 34 memory suites, openai-embedding-credentials, knowledge-memory, and script-memory-rate received complete static review.
Storage candidate: +89/-328 across memory, memory-store, and memory-e2e. Cases decrease from 89 to 69. No new test calls.
Seven controls detect deletion, whole-document deletion, embedding BLOB/model loss, unchanged access time, partial batch commit, and missing owner filtering.
Original timestamp and rollback guards missed their controls. The repaired guards detect them. Parent check:local passed all 69 cases.
Independent review passed with no lost guards. PR https://github.com/desplega-ai/agent-swarm/pull/3276 landed as f59cce3d8626b83991f1068747da5db97ca6161e. Other memory findings remain separate.
A separate production expiry defect was found: ISO expiresAt text compares incorrectly with SQLite datetime text on the same date.
Affected filters, purge, and statistics can retain an expired row until UTC midnight. Existing fixtures use SQLite-formatted dates and miss this boundary.
C17 preserves those fixtures and does not claim to repair expiry formatting.
Storage consolidation completed overlapping CRUD, dependent lifecycle, and repeated TTL cases. Remaining candidates include scalar fusion arithmetic, repeated ranking fixtures, and unused taskB.
C17 repaired persisted access time. Remaining repairs: timeout helpers must reject, and pending gates must release in finally.
Several list assertions accept unrelated owners or are tautological. Retain exact fixture identities across owners.
C17 repaired batch rollback by inserting a valid first row before its conflicting second row. The original first-row rejection proved no rollback.
Memory-edit clears embedding credentials without restoring the provider state. Preserve link pruning while repairing isolation.
Preserve real sqlite-vec, worker-reader parity, FTS races, provider recovery, rating rollback, key-path entry points, and separate MCP/HTTP edit authorization.
The preload uses in-memory SQLite despite database filenames. No audited basic case proves close-and-reopen durability.
The second pass completed all remaining memory suites and both scenarios. Static audit completion does not establish runtime verification.
Additional candidates: remove simulated hook gates, repeated positive rating flows, registry-only handshake, fixture arithmetic, repeated reference propagation, and duplicate defaults.
Preserve graph visibility, capped organic ranking, raw-score expansion, prompt eligibility, strict recall thresholds, and the 128-chunk widening regression.
Keep real MCP transport, caller ownership, complete-document deletion, rating persistence, provider request shape, and both script executors.
Risks: semantic-list identity coverage is operator-only. Missing bearer, bound-token identity, user-token, and guest-session coverage remains unproven here.
Module mocks and embedding-provider caches can contaminate later tests. Several subprocess fixtures inherit credentials while setting only the legacy key.
The re-embed scenario proves acceptance, not completion. Its edit marker does not identify the edited version. Script reference forwarding lacks an edge assertion.
Usefulness fixture deletion needs finally. Scenario setup and sequential session cleanup can leak resources after failures.
Read-order exception: migration 200 was inspected after its dependency appeared in memory-injection-outcome. No deletion relied on that premature read.
Adjacent task-completion-memory-chunking, scripts-embeddings, and full hook/provider/authentication suites remain unaudited. No whole subsystem is complete.

### C18: Apps audit, migration slice landed

The initial pass covered apps-rbac and both table migration suites. Later passes completed every apps test body.
Both original migration tests copied applyMergePatch. C18 replaced both copies with production applyAppDefinitionPatch.
Candidate consolidation must keep selection, filtering, model equality, removed toolbar nodes, bulk actions, and search reset.
The sync script's source-text method check overlaps behavioral invocation. Verify a method-renaming control before removing it.
Timing risks: drift tests do not observe pull entry, lock tests use short sleeps, and a two-pair case cannot prove queuing under a three-pass limit.
Preserve chunk-level transaction failure, snapshot failure at each HTTP/MCP entry point, managed-field refusal, and verified identity boundaries.
All nine inspected fixtures have consumers. None is an unused-file candidate.
All 31 apps test files now have complete static audits after three passes. Runtime validation remains separate.
All 57 components and ten actions match production generator output. Existing drift assertions omit slots.
Additional candidates: duplicate CardGrid positive, repeated feedback fixture parsing, and redundant chart-shell compatibility validation.
Repair weak negatives that also omit rowId. Use exact authenticated requester identity and a different child session key for ancestry inheritance.
Declaration ordering needs opposing insertion and lexical order. Preserve expansion budgets and issue caps without machine-speed assumptions.
Nine fixtures received semantic and consumer review. None is unused, and dashboard consumers remain distinct.
The final pass completed sync, engine, all spike suites, and element assembly. No partial apps test sections remain.
Additional candidates: repeated assembly default substitution, legacy-page rejection, atomic connector replacement, and unreferenced-script deletion.
Before deletion, script checks must observe actual persistence. Keep each blocked-deletion boundary.
Risks: negative sandbox egress can pass without a successful pull. Failed rollback compares an unchanged name instead of distinct definitions.
Attribution fixtures use the same actor for creation and patch. Strict syncedAt increase relies on wall-clock movement.
Owner-specific connection access and mixed requester/operator history need discriminating observations.
The ideas-app seed has two consumers and remains necessary.
The isolated migration implementation consolidates 11 cases to six and removes the selection test file: +44/-120 lines.
Retained assertions now call production applyAppDefinitionPatch. Assertion executions increased from 27 to 28. All fixtures remain.
Atomic replacement and removed mqBtn deletion controls failed as expected. Baseline, revised, formatting, allowlist, and patch checks passed.
Independent review passed. PR https://github.com/desplega-ai/agent-swarm/pull/3272 landed as e3d3c4117c88d94b4301e2151c34c4951a652d9c. Parent check:local passed. Script stand-ins establish definition validity, not execution or authorization.
The static audit ran only in-memory comparisons and focused definition probes. The later migration implementation ran suites and controls as recorded above.

### C19: Extension audit, example slice landed

All 26 extension suites now have complete static assertion reviews. Native tool-hooks HTTP and four extension scenarios also received full review.
Confirmed candidates: example-heartbeat-remediate repeats extensions-heartbeat. Example-rewrite-and-suppress repeats pre-task guards, including the no-op interaction.
Keep both fixtures. All 25 fixture bundles and their 50 hook/manifest files have consumers. load.ts and the with-assets echo script were also inspected.
Retain lifecycle snapshots, ownership, edited-asset preservation, rollback, automatic disable, HTTP/MCP boundaries, and loader traversal separately.
Recursion guards protect origin bypass, identity verification, creator skipping, and delivery to other extensions through distinct paths.
The lifecycle after-commit title lacks an enclosing-transaction assertion. Preserve it while strengthening timing evidence in a later slice.
Negative post and origin assertions rely on short sleeps. Policy timeout and Slack mute settlement observations remain timing risks.
The comms SQL emulator does not validate SQL against real schema. Current lifecycle tests do not prove restart persistence.
The second pass confirmed simultaneous activation coverage in the retained Slack metadata case: a later no-op preserves the earlier priority modification.
The isolated implementation deletes both example suites: +0/-139 lines and two test cases. All 31 retained cases passed.
Four controls detected fail-to-record removal, lost priority rewriting, lost no-op preservation, and ignored follow-up suppression. All mutants were restored.
All 52 fixture/helper files remain. Independent review passed. PR https://github.com/desplega-ai/agent-swarm/pull/3273 merged as 74726a3e00dbdd6ecb0752d1257ccad2523d018c. Parent retained-suite runs passed nine and 22 cases. Broader extension scenarios have not run for this patch.
Catalog invariant consolidation remains a separate candidate. Retain each entry validation and timeout budget.
Native HTTP scrubbing, redaction refusal, clean rewrites, and MCP-only filtering remain distinct.
Neighboring native-tool-hooks, extension-agent-visibility, requester-comms, live harness execution, multiple replicas, and reopen durability remain unaudited.
No runtime controls ran during the static audit.

### C20: Slack readiness repair

A config write schedules reload after 250ms. Persistent activation rows can satisfy setup before the socket reconnects.
The first failed reaction may have crossed this window. Logs do not prove that exact timing or explain the separate ECONNRESET.
Candidate skips redundant flag writes and restarts after required config changes, then explicitly waits for a socket connection.
Final diff +33/-22, net +11, all for dispatch readiness. Existing skipped-task assertions remain unchanged. No retry was added.
Paired baseline, revised, delayed-socket, and restored runs passed without reruns. Removing override barriers under delayed reconnect failed both existing attempts.
Independent review found no correctness blocker. Legacy caller and first full-shard writer passed without retries. All 16 legacy PNGs remained valid.
Parent check:local passed all 35 affected scenarios: zero failures, skips, or flaky results, with 553 HTTP calls.
PR #3278 merged as ae52a1c0a487516c9b923cf1179f90c5ea194696.
Earlier unrelated config writes can still leave a reload pending on the helper skip path. This limitation predates the repair.

### C21: Remaining Codex provider audit

Thirty-four files and three named Codex fixtures received production-first static review. Four files retain surrounding-production limits.
Full Codex implementations were inspected for adapter, app-server, OAuth, pool, rate limits, rollout, steering, cancellation, and cost contracts.
Partial surrounding scope: release catalog, other auth-chain harnesses, full container entrypoint, and other MCP authorization paths.
Candidates: copied slot-selection algorithm, repeated cancellation cases, local regex tests, repeated filesystem scaffolding, duplicate rate-limit/public-client-ID assertions, and duplicate failed refresh calls.
Preserve transport, subprocess, SQLite locking, device lease, storage recovery, caller identity, historical pricing, and jq execution boundaries.
Weak guards: last-call-wins checks only defined values, PKCE omits SHA256 relation, refresh overlap uses sleep, and app-server shutdown asserts a one-second ceiling.
Unexpected auth/network resolution and copied ratings conversion remain fixture risks. No live provider or runtime audit evidence yet.
Cancellation cleanup changes only codex-adapter and codex-swarm-events: final +14/-104 lines, 126 to 123 cases.
PR #3281 merged as 5bd1ab40da5449f1278e367df2a8b3ed815a2ab7.
Parent check:local passed in 12 seconds, including all 123 affected cases.
Seven controls failed. Removing name-only AbortError classification survived both original and candidate, because explicit abort state covers that branch.
Independent review found no lost guard. A refinement restores console.log from afterEach even when the abort event never arrives.
Scoped test typechecking reports the same 13 errors on baseline and candidate. The configured root typecheck passes.

### C22: DB timing ceilings and failed-attempt accounting

C15 merge-group run 44123585250 failed only Run Tests (2/8). The unchanged db-client-busy-retry guard measured executionMs 371.386837 against a 300ms ceiling.
PR checks passed. The merge queue removed that attempt for failed_checks. C15 landed later.
An isolated repair must preserve real contention and detect backoff incorrectly included in execution time. Merely raising the ceiling or adding retries is not acceptable.
The first candidate added 71 and removed 15 lines, with three spies. Its two accounting mutants failed, and 53 affected checks passed.
Independent review found no correctness defect, but rejected the maintenance cost of global clock and timer spies.
A smaller real-clock candidate added 48 and removed 15 lines against the old fixture.
It detects complete omission of failed-attempt costs, including when successful-attempt overhead masks the simpler comparison.
It has no global clock or timer spies. A caller pause can still mask backoff inclusion, and partial undercounts remain unproven.
Independent review then identified base drift. PR #3277 already replaced the old fixture with a zero-spin client and a 200ms ceiling.
That PR merged as 7d5ad4e75d396bebb57e460f40f7c72432531a6d and removed the original nonzero-spin fixture.
C15 and C10 returned to normal queue validation after that merge. C15 subsequently landed.
C10 run 44131652948 failed the new zero-spin test: executionMs 201.530818ms against its 200ms ceiling.
Check 134210204331 identifies db-client-busy-retry.test.ts:113. This directly reproduces the remaining ceiling flake.
The final candidate targets d67d322570, which includes PR #3277. PR #3293 contains only the existing busy-retry test file.
Its diff is +48/-26 lines, net +22. All 18 existing test calls remain. Independent review found no blockers.
Fresh baseline checks passed 53 cases. The candidate busy suite passed 18 cases.
The combined candidate run had 52 passes and one unrelated db-client.test.ts timer-gap failure at 218.9ms against 150ms.
Its isolated diagnostic passed, but the combined run remains recorded as failed. No sibling test changed.
Controls rejected included backoff and omitted failed-attempt costs, including an 80ms successful-overhead masking variant.
Correct accounting with that overhead passed. Parent check:local subsequently passed all 18 selected cases.
Paired coverage lost no source lines. Timing-dependent warning and scrubber coverage increased, without a claim of new regression coverage.
A parent overlap between two fixture consumers caused invalid lock failures. Sequential reruns passed, as recorded in the measurements document.
A caller pause can hide backoff inclusion. Partial undercounts and the recorder dependency remain limits.
PR #3293 merged as bbbc5b029192574bd4b2c145acb8f1b0a8b71534. Its required merge validation completed before landing.
C10 passed queue validation after this repair reached main and merged as 7be110da2c264e6ba3e68879818f7ad0d168c5bd.
Its justification is removal of the reproduced timing ceiling, counted failed-attempt cost, and observed contention.
The retention batch sizer consumes executionMs. Omitted failed-attempt cost can therefore understate event-loop blocking.

### C23: Codex pool selection

PR #3286 merged as 048178fb7407778046bd8d23750d91f3db8569b1. Diff +40/-232 lines, net -192, across two existing test files.
Removed the copied slot-selection algorithm and its scenarios. Existing resolver cases now read actual credential files.
Retained guards cover exhaustion, availability, sparse slot identity, selected metadata, blank refresh tokens, and nonzero-slot persistence forwarding.
Baseline 17 cases passed. The candidate passed 13 cases, with no new test call sites. All seven controls failed.
The baseline missed exhaustion, refresh-token leakage, missing files, and incorrect file contents. Those controls justify resolver growth.
Independent review found no blockers. Parent check:local passed, and five unchanged filesystem cases passed with 16 assertions.
Scoped type diagnostics decreased from ten to four existing errors. Configured root typechecking passed.
Availability with only unconfigured IDs, failed fetches, and non-ok responses remain uncovered branches. No live provider ran.

### C24: Heartbeat audit and obsolete checklist parsing

All 13 heartbeat-prefixed suites received complete static assertion review, plus extensions-heartbeat and the core-session-data scenario.
Production review covered sweep orchestration, receipts, gate execution, expiry, recovery, rerouting, and probe cancellation.
Some auxiliary production reads followed the initial test read. Transitive broker, runtime, workflow, and database implementations remain partial.
The strongest candidate removes historical previous-checklist prompt-parser variants. Production reads receipts containing full task IDs instead.
Preserve current multiline failure titles, receipt validation, and actual SQL selection of previous checklists.
PR #3294 changes only heartbeat-jev-gate.test.ts: +9/-241 lines, net -232.
It merged as 5ee2b27ad8ffc9d089a7f59ffce89396a95b2673.
It removes 11 executed cases: nine historical variants and two hollow or redundant cases, plus unused fixture plumbing.
One mixed-array row adds an executed case to an existing parameter table. No new test call site was added.
The case count is 43 - 11 + 1 = 33. All 33 final cases, formatting, allowlist, and patch checks passed.
Ignoring receipts caused four failures. Suppression by creation time caused seven failures.
Malformed-array acceptance initially survived. A mixed string/number row in the existing table now detects it with one failure.
All original malformed-input cases remain. A single-line regex control failed the retained multiline total assertion.
Final independent review found no blockers. Parent check:local passed with 33 cases and configured root typechecking.
Paired coverage retained every covered source location across 744 loaded production files, with a fixed 113518-line denominator.
The pair does not establish branch coverage or full-suite coverage. The full suite and separate producer suite were not run locally.
The failure-query mock still copies filtering. Competing completed-checklist selection and shared-prefix ID collisions remain unproven.
Further candidates include repeated basic stall cases, checklist rendering, and reboot task-type exclusions.
Preserve full-sweep dispatch, workflow ownership, tracker ownership, live-session protection, boot epochs, and interrupted-write recovery separately.
The concurrency case uses nested awaits and proves sequential idempotency, not overlapping sweeps.
The startup timer remains active after heartbeat stops. It can reach a closed or replaced database in lifecycle tests.
Gate setup can await an unresolved readiness signal after its deadline. The fake gate context also reproduces SQL filtering.
Reroute rollback and actual process-restart recovery remain unproven. No unused external fixture was found.

### C25: Approval audit and card consolidation

The complete approval-card-resolution test received review against notification rendering, dispatch, and relevant database production paths.
PR #3299 removes the final stored-channel case and the separate rejected/operator header case: +2/-17 lines, net -15.
It moves the zero-post assertion into the first approved case and requires outcome icons throughout the existing operator matrix.
Six affected suites passed: 151 baseline cases and 149 candidate cases. The changed suite decreases from 22 to 20 cases.
Four temporary controls detected a wrong channel, an unwanted reply, a wrong rejection icon, and a missing operator fallback.
Parent check:local passed on main at 7be110da2c, including 20 card cases, formatting, lint, and configured root typechecking.
Independent review found no lost behavior guard or correctness blocker. PR #3299 merged as 2204b5c8fa41ec45a9bac915c5abe40b527598d3.
Paired coverage lost no covered source locations across 224 measured production files and a fixed 40097-line denominator.
The four relevant production files retain identical covered lines. Seven incidental scrubber hits do not establish stronger coverage.
The retained late-resolution and legacy-DM cases still exercise null votes with an operator responder.
Neither version tests a stored channel target without channelId. The wrong-channel control does not prove that fallback.
Preserve cancellation entry points, failed-delivery claim release, deduplication, quorum silence, late delivery, and legacy versus current DM routing.
Fixed negative waits and call-recording readiness do not prove completion of persistence work.
The run-cancellation fixture contains one request despite its broader title. The DM message fake persists between cases.
The config-question helper and all 702 lines of its test now have a complete read.
The helper, HTTP normalization and answer transaction, MCP creation, and HITL executor were compared with the assertions.
Supporting authentication, config storage, workflow resume, and notification internals remain partial. This is not a complete subsystem audit.
No whole-test deletion is justified in the config-question suite. The three creation entry points protect separate normalization wiring.
Retain secret downgrade refusal, API-only key hiding, plain option validation, rejection without writes, and the user/agent authorization checks.
Retain standalone secret scanning, its positive text control, and workflow output/context scanning as separate boundaries.
The metadata test claims envPath preservation but sets and checks only description. Rename it or supply a discriminating envPath fixture.
The keep test checks the unchanged timestamp, not the stored value or write count. Same-tick rewrites could evade that check.
The reload spy proves one invocation, not post-commit ordering. No injected failure proves rollback after an earlier config write.
No case removes a kept key between validation and the transaction, or resolves the request after a config write begins.
The scanner skips unreadable columns. Its positive control proves two important paths, but not exhaustive scanning of every possible column.
The local HTTP server resolves credentials and calls the handler. It does not exercise every full-server admission layer.
The event listener and Slack module mock remain installed for the file's process. Workflow readiness uses a bounded polling loop.
No tests or controls ran during this static continuation. No production or test source changed.

The six remaining approval suites now have complete assertion reviews against their direct production paths.
These are approval-respond-auth, approval-requests, approval-requests-notifications, approval-sweeps, and both approval cancellation migration suites.
The audit ran no tests or controls. Full HTTP admission, token storage internals, workflow helpers, and migration interactions remain partial.
The copied HTTP handler in approval-requests implements obsolete body-derived identity and bypasses production quorum, deadlines, and follow-ups.
PR #3301 replaces that copy with the production handler and consolidates server lifecycle: +43/-208 lines, with all 87 cases retained.
Independent review found no lost guards. Parent check:local passed after rebasing onto main at 498e8d3542.
Paired parent coverage gained 29 production route lines and lost none across 751 files and 114917 fixed line locations.
Five failing controls cover filtering before limit, required and optional validation, and identity through both affected suites.
The approval harness uses an operator fallback without request authentication. The separate auth suite resolves credentials but bypasses full-server admission.
One baseline returned 404 instead of 409. Its response body and listener were not captured, so its cause remains an open observation.
Subsequent passes do not prove a repair. PR #3301 merged as 5a79d5be5594563fe5434084351884aea7c7266d.
Preserve filter-before-limit, text-only answers, rejection reasons, cancelled-request refusal, defaults, and optional-answer validation.
Other candidates include empty assertions, unused executor input, reconstructed follow-up predicates, and copied tool fallback logic.
Replace those simulations only after the real entry point preserves their meaningful behavior. Keep parent metadata inheritance separately.
The original executor creation fixtures omitted the workflow run and passed despite creating cancelled approval rows.
PR #3305 repairs those fixtures with a live run, a running step, pending status, and correlated request identity.
The review-requested refinement removes repeated assertions and reuses setup: +50/-49 lines, with 87 cases reduced to 86.
Four controls fail, and paired coverage gains eight lines with no losses. Parent check:local and composed fallback validation passed.
PR #3305 merged as ae4bcaab8cfd30a9856041109c0f79dfa6bdb485.
PR #3304 removes the copied source-task fallback case: -30 lines and one case, with unchanged measured production coverage.
The original case missed a disabled production fallback. The retained MCP scenario failed both attempts, then passed after restoration.
Its parent check:local passed. Independent review found no lost guards.
PR #3304 merged as f9a8fc75b0bfdf629f76f16d5397a646921936ba. Both slices now contribute to merged totals.
The fallback scenario depends on connectMcp omitting the source-task header. It does not prove header precedence.
PR #3306 strengthens migration 166's index definition and complete-row checks: +8/-19 lines, with the existing case retained.
All four controls survive the baseline and fail the candidate. Parent check:local and both migration tests passed.
Paired coverage is unchanged across 153 production files and 31215 locations. SQL itself is not instrumented.
Independent review approved the exact normalized DDL assertion. Equivalent SQL spelling can require an explicit assertion update.
PR #3306 merged as c4ab35afe10f324b4f15ecb103499d53ab1a62db.
The follow-up candidate now replaces copied predicates with accepted HTTP answers and a global task-set observation.
It reuses existing helpers after review: +44/-64 lines, with 85 current-main cases reduced to 84.
Eight behavior controls fail. The redundant source-free early guard survives because the later lookup also prevents creation.
The final current-main coverage pair gains two handler lines and loses none across 752 files and 114945 locations.
The earlier pair lost six timing-threshold logging lines. That result remains recorded and is not treated as a retry failure.
Independent review found no lost guards. The parent completed helper reuse and repeated all controls, coverage, and check:local.
PR #3307 merged as 9a61e25bbd125a9bc10c622a58382430478cb0f2 and contributes to merged totals.
Notification synchronization is published as PR #3308: +41/-27 lines, with all six cases and every existing assertion retained.
Independent review found no blockers. PR checks passed, but merge-queue run 44161166221 failed an unchanged mobile-preview test.
The failure at link-preview-sheet.test.ts:146 occurred before the toast assertions because Re-run did not render.
GitHub removed PR #3308 for failed_checks on November 17 at 20:48 BCN.
After PR #3312 repaired the preview fixture on main, the parent requested fresh queue validation.
PR #3308 merged as 531c9fb1f9c97cb2740a21deebf3388b4db28b05 on November 18 at 00:06 BCN.
The call-through spy observes dispatch completion and replaces silent polling and fixed sleeps.
Four behavior controls fail as expected. Delayed unwanted email posting passes the baseline but fails the candidate.
Paired coverage matches across 778 production files and 116221 locations. Parent check:local passed.
This slice does not establish that the HTTP response precedes Slack completion. A hung dispatch can still time out teardown.
A separate reviewed deletion candidate removes two list and expiry cases, with 18 deleted lines and no additions.
The retained sweep guard detects NULL-deadline inclusion. The removed loop also detects that mutation, so detection is redundant.
The request suite loses six selector lines, but the retained sweep suite covers them. Their union loses no covered location.
PR #3310 merged as 503dfe00995a4fd05ecbf2c1a0fef652d6038498 and contributes to merged totals.
Its composition with current main passed 111 affected cases. The request suite now has 82 cases.
Preserve authentication and quorum cases, stale-lease ownership, actionable-workflow conditions, cancellation triggers, and actual timeout recovery.
Preserve sweep rollback controls. Notification failures, request latency, and asynchronous dispatch completion need separate observations.
Polling helpers can silently expire. Token expiry, timeout tolerances, and environment restoration also need bounded repairs.
Migration 140 reconstructs a historical table while retaining later migration records. Migration 166 now checks its exact index predicate.
Keep migration reconstruction and additive-index behavior separate. Neither fixture proves a complete historical upgrade.

### C26: Approval dashboard audit

The initial audit reviewed all seven scoped files and 58 cases without executing them. Subsequent bounded implementation and validation follow.
The improvement test mounts a header component that was identified and read after the initial test read. This ordering limit remains explicit.
Candidates are one duplicate unmodified-Enter assertion and one repeated initial improvement render. Preserve both payload-privacy assertions when consolidating.
Retain display and response validation separately, inline eligibility, keyboard surface differences, identity restrictions, banners, and list layout tokens.
The mocks do not establish native focus, overlay discovery, responsive geometry, server authorization, or network failure behavior.
Module mocks and Happy DOM persist within the process. Exact expiry, retry arguments, and several banner branches lack discriminating guards.
No whole-file deletion or unused fixture is justified.
PR #3311 implements both consolidations: +2/-7 lines and one removed case. It merged as bcc13793189670179ad39a2e32419c6576a73544 and contributes to merged totals.
Baseline and candidate pass 58 and 57 cases across seven isolated files. All three controls fail retained assertions.
The typing-target matrix retains the exact Enter input. Both privacy assertions run before the retained approval click.
Paired dashboard coverage matches: 49 files, 6258 locations, 1478 covered locations on both sides.
Independent review found no blockers. Parent check:local, root and UI TypeScript, allowlist, and whitespace checks pass.
A local browser displayed the seeded pending draft. Captures use identical production source and do not claim a visual change.
No server authorization, native form behavior, branch coverage, or full-suite timing claim follows from these tests.

### C27: Memory rating consolidation

PR #3313 changes only memory-rater-llm.test.ts: +33/-149 lines, with 47 cases reduced to 45.
The two-file baseline and candidate pass 63 and 61 cases. Parent verification uses a checkout-local frozen installation.
Removed copied OpenRouter and disabled-hook predicates. The real empty-batch no-fetch guard remains.
The retained HTTP flow verifies persisted ratings. The forwarding case now pins task ID, optional model, request metadata, and exact events.
Independent review found no lost production guard but rejected two controls that failed to parse.
The parent replaced those mutations with valid empty spreads. Both selected tests fail at their event-array assertions.
The corrected evidence records 24 detected mutations and one existing disabled-hook gap. Invalid original probes remain excluded from behavioral evidence.
Forcing disabled-hook gating on still passes because the existing hook fixture has no nonempty ratings in that path.
Paired production LCOV retains 23056 covered locations out of 113212 across 744 files. The API child is not instrumented.
Parent check:local, allowlist, whitespace, and pre-push checks pass. No production file changes.
The initial shared dependency setup and failed loader probes remain documented. New parent baseline and candidate runs use the canonical wrapper.
No full repository suite, live credential transport, or branch-coverage claim is made. PR #3313 merged as 52452f001f69fff9106b276ce127f641b46339ba and contributes to merged totals.

### C28: Preview readiness diagnosis and superseded candidate

The failed #3308 queue run stopped before the original modal and toast assertions.
A controlled pending import reproduced the missing-button guard. The exact historical CI cause remains unconfirmed.
The parent prepared a preload alternative, with +2/-3 test lines and no changed cases or behavior assertions.
Baseline and candidate passed 47 cases. Delayed module evaluation failed the baseline and passed the candidate.
Pointer and navigation controls failed retained assertions. Target LCOV retained 901 covered locations out of 2839 across 36 production files.
Independent review found no blockers, and parent check:local passed.
Before publication, fetched main contained PR #3312 at 6e8e740354b689f8ad2e2a351962b5b98c884aab.
That separate repair waits for the rendered button. The parent retired the unpublished preload alternative and preserved its evidence.
No alternative diff enters campaign totals. PR #3312 is external work and also remains outside those totals.
The merged test passed locally. This does not establish full-shard reliability or the historical cause.
Screenshots show the shared task body on a phone preview screen, not the Radix sheet or browser hit testing.

### C29: Scheduling audit and bounded consolidation

All six scheduling test files received complete assertion inspection and direct production comparison.
Transitive authentication, workflow, provider, migration-history, and process boundaries remain partial.
The audit preserves occurrence claims, committed visibility, stale completion, recovery, cadence, migrations, profiles, and real script execution separately.
The refined candidate changes only scheduled-tasks.test.ts: +2/-44 lines, with two duplicate cases removed.
It retains task insertion, manual timestamps, and cadence-free one-time creation.
Independent review rejected the pinned-target deletion because its target-only fixture distinguishes assignment from creator attribution.
The parent restored that case and removed the redundant status transfer. A creator-as-target control now fails that retained case.
The removed success-only atomicity case did not prove atomicity. Manual dispatch and schedule updates remain separate operations.
Fresh baseline and refined candidate passed 33 and 31 cases. Earlier adjacent runs passed 72 cases, including three real script cases. Those runs preceded restoration of the target-only case.
Five fresh controls failed retained assertions after refinement: insertion, manual timestamp, cadence, mapped type, and creator-versus-target assignment.
The earlier eight-control record describes the rejected three-case candidate. Literal cadence rejection remains separate from assertion-level controls.
All mutations were restored.
Scoped production LCOV retains equal executable locations and covered lines. Child scripts and branches remain unmeasured.
Parent check:local and pre-push checks passed after refinement. Independent review accepted the two remaining deletions.
PR #3318 publishes the refined patch. Run 44197560217 passed eight root shards and four E2E Contract shards.
Three unchanged eval timestamp tests exceeded five seconds. The aggregate Merge Gate failed. PR #3320 repaired that fixture. On the updated #3318 head, all eight affected root shards and the eval package passed.
PR #3318 merged as `2a851add58`. Refined evidence is /tmp/test-cleanup-scheduling-refined/report.md.
PR #3323 repaired the empty-result and error-threshold fixtures. Profile clearing and deferral authorization still need review.
Existing sleeps, shared fixture state, manual atomicity, and cross-process claim coverage require separate assessment.
Audit: /tmp/test-cleanup-scheduling-audit.md. The original candidate report remains historical evidence at /tmp/test-cleanup-scheduling-duplicates/report.md.

PR #3323 changes three existing filter cases, adding 24 lines and deleting 16.
Enabled and disabled queries must each return the matching fixture. Every returned row must still have the requested flag.
A fixed two-error schedule must appear at a minimum of two and disappear at three.
A status-only HTTP request distinguishes a missing status parameter from a missing minimum. The database checks each predicate separately.
All 36 cases passed. Six of eight temporary regressions passed on the baseline. All eight failed assertions after the change.
Both coverage runs hit the same 24,709 of 115,377 executable lines across 783 production files.
The HTTP test uses the schedule handler and a local listener. Full-server authentication and branch coverage remain outside this measurement.

### Eval timestamp subprocess and Codex duplicate checks

PR #3320 gives each of four timestamp cases the shared subprocess budget. The helper drains both output streams. Each test rejects signal termination.
The test diff adds 47 lines and deletes 32. A six-second startup delay exceeded the original deadline and passed the revised test.
Four independent shell changes failed the prefix, unterminated-line, stderr, and exit assertions respectively.
The eval package passed 1,193 cases and skipped one. All 27 production LCOV records matched. Generated shell execution has no LCOV instrumentation.
A pipeline descendant can retain a pipe after the direct shell dies and cause the 35-second test deadline to expire.
The historical CI cause remains unknown. Independent review approved the patch. PR #3320 merged as `f2f126278b`.

PR #3321 removes two duplicate Codex cases and 13 test lines. The retained parser case uses the same message, clock, and expected reset time.
The retained OAuth constants case checks the same public client ID. The deleted case did not inspect source files for secrets.
Both suites passed, with 85 cases before removal and 83 after removal. Each retained assertion failed its respective production regression.
The paired scopes covered identical source locations. Independent review approved both deletions. PR #3321 merged as `62b976de6e`.

### Eval configuration and scenario catalog

The static audit covered two configuration suites and three scenario suites. The inventory records the contracts for each.
Benchmark parsing, model selection, version hashes, scenario grading, and recovery have independent failure modes.
A missing lead in the judge fixture can cause recovery grading to exit early. Seed row counts also depend on SQL formatting.
Keep the recovery rubric, independent answer values, both symlink rejection paths, and separate file and aggregate hash limits.

PR #3324 consolidates three catalog cases and removes 61 net test lines.
Exact registry membership catches missing and retired IDs. Source-array uniqueness catches duplicates hidden by the map.
A fourth control gave a bundled scenario version zero. Production registry loading rejected it during the retained test.
The affected suite went from 21 to 18 cases. Both runs covered 7,158 of 15,503 executable lines across 76 production files.
The eval package passed 1,190 cases and skipped the opt-in replica case. Live provider execution remains outside this scope.

### Eval engine audit

The audit compared all five suites below with their direct production modules. Supporting runner and storage paths received partial inspection.

| Suite | Retained contract | Remaining work |
| --- | --- | --- |
| Registry | Dependency bounds, transitive and forward references, duplicate references, self references and cycles. | PR #3326 landed and consolidated six cases. Some dimension-weight fixtures can fail on the aggregate weight alone. |
| Outcome normalization | Legacy judge fallback, explicit dimension precedence, and the default threshold. | PR #3329 established that an explicit empty list suppresses the legacy judge. |
| Baseline comparison | Shared quality dimensions, weighted results, empty sides, and scenario pairing. | PR #3330 separates error status from missing score and exercises four token components. |
| Scoring | Rubric scoring, efficiency decay, and normalization followed by score finalization. | PR #3332 removed manual examples. Two runner decisions remain unguarded: choosing the lower budget score and omitting unpriced efficiency. |
| Benchmark publication | Refusal rules, held-out cells and exclusion of private fields. | The environment fixture lacks a secret sentinel. Preserve database and publication checks separately. |

PR #3327 removes three benchmark mapping cases. The catalog partition, ID uniqueness, production TSV join and exact Gemini benchmark object retain their checks.
Both versions detected 13 regressions, including a missing source row that failed during module loading.

### Eval runner audit

The inventory records all 17 runner test files. The audit compared their assertions with seven runner implementation files.
Some direct dependencies outside that directory received inspection after the tests. These included polling, sandbox boot, server startup, validation and database helpers.
The inventory records partial audit status for this pass. It supplied no runtime or mutation evidence.

PR #3333 replaces two manual judge-error examples. The retained test reads the message, score and verdict that the retry handler wrote to SQLite.
The spawned-task merge and worker-failure selection fixtures also copy runner logic. Their tests can stay green when production diverges.
Preserve the direct origin classifier, actual scenario validation, database state transitions, startup wiring and rubric execution.
Runtime candidates include checking cancellation with an in-flight request and distinguishing configuration IDs when two scheduled attempts otherwise tie.

### Eval statistics and summaries

The audit covered every test body in the statistics, results and regression-summary suites. Each direct implementation received inspection before its tests.
The formatter also invokes the regression classifier. That supporting implementation received partial inspection after the tests.

- Retain independent and paired resampling, scenario weighting, rank spreads, Wilson intervals and pass-at-k estimators. The separate significance formula repeats production. A fractional rank for tied groups lacks an explicit assertion.
- Run-summary PR #3334 consolidates empty cells and compares fresh rows in reverse order. Its interval-width test now doubles the same score distribution. The pure statistics suite still varies both distribution and size.
- Retain the report formatting checks for pages, warnings, drift, cancellations and failed runs. Its requested scenario order matches discovery order. Metered and notional costs also share the same fixture values. Use distinct values and orders to test these contracts.

### Newly added main tests

The pre-push selector test received a full production-first audit. Its four cases passed with 39 assertions and remain unchanged.
Retain self/deleted selection, real repository integration, deterministic capped graph traversal, and migration fallback.
Child termination, inherited budgets, alias/index fallback, and the complete shell hook remain verification limits.
The saved UI configuration test received a complete assertion read, with some supporting production reads afterward.
Its 25 cases passed with 110 assertions under explicitly cleared deployment settings. No deletion is justified.
Retain malformed storage, field validation, active-ID repair, empty state, and legacy migration as distinct contracts.
Multiple-connection selection, malformed modern plus valid legacy storage, and the migrated persisted payload lack discriminating assertions.
Neither audit ran mutation controls. The UI audit did not run a browser or complete the surrounding configuration subsystem.

The object viewer audit retains both Board autosave cases. One saves without a view change. The other switches to Source before the save and checks the scene on return.
The transport mock counts requests. Persistence after reload and the request body remain unverified. Supporting BoardView and useObject reads followed the test read.
The new core-task-status-kind scenario remains outside the unit-file denominator and awaits separate scenario review.

## Resume order

1. Track merge validation for #3330, #3333 and #3334.
2. Check whether the report formatting suite detects exchanged cost fields and ignored scenario ordering.
3. Continue remaining approval and memory repairs. Reconcile inventory after merges.
4. Diagnose remaining load-sensitive baseline failures without removing useful guards.
5. Continue pending inventory rows. Audit fixtures with their callers. No releases.

## Completed slices

C01: PR #3248 merged. Removed 51 test lines and retained all mapped resolution and pricing contracts.
C02: PR #3253 merged. Test diff +2/-19. Drain integration and platform boundaries remain.
C03: PR #3258 merged. Test diff +42/-94. Exact retry limits and fixture isolation strengthened.
C04: PR #3255 merged. Test diff +1/-1. Browser query/hash forwarding retained without the OAuth race.
C05: PR #3257 merged. Test diff +2/-2. Canonical fixture paths preserve 21 reaper guards.
C07: PR #3259 merged. Test diff +59/-314. Copied HTTP layer removed after real-handler coverage retained its contracts.
C08: PR #3291 merged. Test diff +46/-78. Removed fabricated executor cases and duplicate classifiers while preserving 15 distinct inputs.
C09: PR #3266 merged. Test diff +9/-7. Actual request readiness replaces the premature cutoff. All seven guards remain.
C10: PR #3274 merged. Test diff +5/-148. Three duplicate rendering cases removed while retaining native Markdown and delivery boundaries.
C14: PR #3271 merged. Test diff +17/-32. Literal expectations and discriminating fixtures replace weak oracles.
C16: PR #3275 merged. Test diff +1/-47. Removed mock-only no-op and repeated service-name checks.
C17 storage slice: PR #3276 merged. Test diff +89/-328. Removed duplicate fixtures and repaired access-time and rollback guards.
C18 migration slice: PR #3272 merged. Test diff +44/-120. Replaced copied merge algorithms with production behavior.
C19: PR #3273 merged. Test diff +0/-139. Two duplicate example suites removed, with all fixtures retained.
C20: PR #3278 merged. Test diff +33/-22. Config changes now await restart and socket readiness before dispatch.
C21 cancellation slice: PR #3281 merged. Test diff +14/-104. Duplicate cancellation cases consolidated around explicit readiness and abort events.
C22: PR #3293 merged. Test diff +48/-26. Real contention replaces a timing ceiling and protects failed-attempt accounting.
C12: PR #3285 merged. Test diff +0/-2. Removed repeated server registrations while preserving parser and selection contracts.
C15: PR #3269 merged. Test/helper diff +31/-23, production +1/-0. Both sandbox modes now suppress Bash startup files.
C23: PR #3286 merged. Test diff +40/-232. Production resolver checks replace copied pool selection.
C24: PR #3294 merged. Test diff +9/-241. Removed obsolete prompt-parser cases while retaining receipt and multiline-title guards.
C25 cards: PR #3299 merged. Test diff +2/-17. Two duplicate cases consolidated with no measured production coverage loss.
C25 HTTP: PR #3301 merged. Test diff +43/-208. Production handler replaces copied logic, with all 87 cases retained.
C25 fallback: PR #3304 merged. Test diff +0/-30. Real MCP fallback coverage replaces the copied predicate case.
C25 executor: PR #3305 merged. Test diff +50/-49. Actionable fixtures detect cancelled creation and incorrect correlation.
C25 index: PR #3306 merged. Test diff +8/-19. Exact index and complete row checks detect four previously missed regressions.
C25 follow-up: PR #3307 merged. Test diff +44/-64. Real HTTP answers replace copied predicates and Slack metadata simulation.
C25 list/expiry: PR #3310 merged. Test diff +0/-18. Two duplicate cases removed, with selector coverage retained through the sweep suite.
C25 notifications: PR #3308 merged. Test diff +41/-27. Dispatch completion replaces premature observations.
C26: PR #3311 merged. Test diff +2/-7. Dashboard duplicate assertions consolidated.
C27: PR #3313 merged. Test diff +33/-149. Real behavior guards replace copied rating predicates.
Eval timestamps: #3320 merged, +47/-32. Four shell cases retain their original behavior checks.
Codex duplicates: #3321 merged, +0/-13. The retained cases detect both regressions.
Scheduling: #3318 merged (+2/-44, two cases removed). #3323 merged (+24/-16, same case count).
Scenario registry: #3324 merged (+3/-64, three cases removed).
Eval dependencies: #3326 merged (+7/-47, six cases removed).
Benchmark mapping: #3327 merged (+1/-22, three cases removed).
Outcome normalization: #3329 merged (+3/-13, one case removed). The retained test now detects a fallback from explicit empty dimensions to a legacy judge.
Scoring arithmetic: #3332 merged (+2/-52, four cases removed).
Budget policy: PR #3254 merged. Zero net growth by default, with contract-specific exceptions and no unrelated safety offsets.

## Risks and blockers

- Test-line policy merged in PR #3254. Initial ledger PR #3270 merged as 5243b1c93a6dcdde2680238256df8de70d8bfe1c.
- Ledger wave 5 merged through PR #3284 as cbd5f90e7ca96edefef0af7f07fe2bed6c6c7733.
- Ledger wave 6 merged through PR #3290 as 37d3a1bc856a45ca240fff1fb0163d6eefdc069f.
- Coverage checkpoint PR #3295 merged as 36a09fbd30ed871c2b47627942441324b8aae323.
- Approval checkpoint PR #3309 merged as e527abfb5aff164192762c30562a9ed36bf430a6.
- Dashboard and memory checkpoint PR #3314 merged as 1a2fcbb67a41b10999db88f447f65eb35ddf31d2.
- Live provider, Linux sandbox, Docker, and browser boundaries require distinct evidence.
- Broad app-shell failure did not reproduce alone. QuickJS readiness failure reproduced under controlled boot delay. Its repair merged in PR #3266.
- Reviewer noted an existing missing fable alias guard. This slice did not delete that contract.
- Initial inventory contained 1616 tracked test files. Three files were deleted through C18 and C19, and three appeared on main.
- The checkpoint contains 1616 current file rows and three historical removed rows. Package tests remain in scope.

## File audit inventory

Static audit means production comparison and test-body review. It does not imply execution.
Production partial means the direct test bodies were reviewed, but the surrounding production scope remains limited.
Landed marks the named slice only. Other findings in the same subsystem remain open.

| Test file | Status | Slice or evidence |
|---|---|---|
| apps/evals/configs/aa.test.ts | landed | #3327: benchmark row mappings, nulls, independent numeric pins and parser errors. |
| apps/evals/configs/index.test.ts | static audit complete | Provider prefixes, model catalog membership, default selection, and alias boundaries. |
| apps/evals/scenarios/capability-routing.test.ts | pending | |
| apps/evals/scenarios/delegation-probe.test.ts | pending | |
| apps/evals/scenarios/docs-suggestion.test.ts | pending | |
| apps/evals/scenarios/fanout-research.test.ts | pending | |
| apps/evals/scenarios/grader-validation.test.ts | pending | |
| apps/evals/scenarios/human-in-loop.test.ts | pending | |
| apps/evals/scenarios/implement-review.test.ts | pending | |
| apps/evals/scenarios/orchestration-scenarios.test.ts | pending | |
| apps/evals/scenarios/real-diff-agent-fs.test.ts | pending | |
| apps/evals/scenarios/scenarios.test.ts | landed | #3324: exact catalog membership and source uniqueness. Serialization and grading checks remain. |
| apps/evals/scenarios/versioning.test.ts | static audit complete | Suite pins, fixture hashing, symlink rejection, and independent byte limits. |
| apps/evals/scenarios/worker-recovery.test.ts | static audit complete | Independent answer pins, adversarial totals, scoring gates, and solo parity. |
| apps/evals/scripts/backfill-resolved-model.test.ts | pending | |
| apps/evals/scripts/calibration-report.test.ts | pending | |
| apps/evals/src/api/analytics-sql.test.ts | pending | |
| apps/evals/src/api/analytics.test.ts | pending | |
| apps/evals/src/api/attempt-tasks.test.ts | pending | |
| apps/evals/src/api/benchmark-routes.test.ts | pending | |
| apps/evals/src/api/configs-routes.test.ts | pending | |
| apps/evals/src/api/models-routes.test.ts | pending | |
| apps/evals/src/api/publish-bundle-route.test.ts | pending | |
| apps/evals/src/api/run-completion.test.ts | pending | |
| apps/evals/src/api/run-regression-route.test.ts | pending | |
| apps/evals/src/api/server-auth.test.ts | pending | |
| apps/evals/src/api/suite-analytics-http.test.ts | pending | |
| apps/evals/src/api/suite-analytics-routes.test.ts | pending | |
| apps/evals/src/api/suite-analytics.test.ts | pending | |
| apps/evals/src/baseline.test.ts | candidate validated | #3330 separates status and shared-score exclusions and tests token composition. |
| apps/evals/src/benchmark.test.ts | static audit complete | Publication refusal, held-out cells, private fields and serialization. |
| apps/evals/src/check-display.test.ts | pending | |
| apps/evals/src/cli-show.test.ts | pending | |
| apps/evals/src/cost/billing.test.ts | pending | |
| apps/evals/src/cost/catalog.test.ts | pending | |
| apps/evals/src/cost/effort.test.ts | pending | |
| apps/evals/src/cost/model-alias.test.ts | pending | |
| apps/evals/src/cost/pricing.test.ts | pending | |
| apps/evals/src/cost/recompute.test.ts | pending | |
| apps/evals/src/cost/resolve-alias.test.ts | pending | |
| apps/evals/src/db/client.test.ts | pending | |
| apps/evals/src/judge/agentic.test.ts | pending | |
| apps/evals/src/judge/openrouter.test.ts | pending | |
| apps/evals/src/judge/session-log-parse.test.ts | pending | |
| apps/evals/src/judge/trace.test.ts | pending | |
| apps/evals/src/live/attempt-progress.test.ts | pending | |
| apps/evals/src/logs-parser-ui.test.ts | pending | |
| apps/evals/src/normalize-outcome.test.ts | landed | #3329. Legacy fallback, explicit dimension precedence and default threshold. |
| apps/evals/src/registry.test.ts | landed | #3326 dependency consolidation. Weight validation and serialization risks remain. |
| apps/evals/src/regression-summary.test.ts | test audit complete, production partial | Alert and failure rendering. Order and cost fixtures need distinct inputs. |
| apps/evals/src/regression.test.ts | pending | |
| apps/evals/src/results.test.ts | candidate validated | #3334: empty metrics, finite totals, repeatable score intervals and interval width at fixed distribution. |
| apps/evals/src/runner/harness-crash.test.ts | partial audit | Crash signatures, retryability and clipped messages. No actual retry execution. |
| apps/evals/src/runner/human-input.test.ts | partial audit | Answer serialization and polling settlement. Approval HTTP validation is separate. |
| apps/evals/src/runner/hygiene.test.ts | partial audit | Database transitions, retry classification and cancellation. #3333 adds judge-error persistence checks with an injected executor. |
| apps/evals/src/runner/member-seeding.test.ts | partial audit | Strict profile failures, worker routing and command order. Shell execution is outside scope. |
| apps/evals/src/runner/orphaned-runs.test.ts | partial audit | Reaping, startup snapshot handoff and scheduled resume. No process restart. |
| apps/evals/src/runner/progress.test.ts | partial audit | Abort behavior for polling and sandbox boot. In-flight request cancellation needs verification. |
| apps/evals/src/runner/resolve-attempt-cost.test.ts | partial audit | Harness prices, recomputation and zero-token handling. Pricing inputs are injected. |
| apps/evals/src/runner/roster.test.ts | partial audit | Per-member configuration, matching and costs. Two fixtures construct similar sandbox handles. |
| apps/evals/src/runner/run-configs.test.ts | partial audit | Stored model pins and reuse. Concurrent insertion remains unverified. |
| apps/evals/src/runner/run-efforts.test.ts | partial audit | Override precedence, snapshot application, storage and legacy NULL. |
| apps/evals/src/runner/schedule.test.ts | partial audit | Public-first and attempt ordering. Config-ID tie breaking lacks a discriminating fixture. |
| apps/evals/src/runner/scoring.test.ts | partial audit | Dimension execution and persistence. #3333 removes manual judge-error cases and retains the producer test. |
| apps/evals/src/runner/seeding.test.ts | partial audit | SQL restrictions, serialized sandbox fields and expiry. Real import remains separate. |
| apps/evals/src/runner/spawned-tasks.test.ts | partial audit | Origin classification uses production. Local merge fixtures duplicate behavior. |
| apps/evals/src/runner/task-net.test.ts | partial audit | Cascade skip recognition and failure classification. Server cascades remain separate. |
| apps/evals/src/runner/topo.test.ts | partial audit | Deterministic ordering, invalid edges and cycle discovery. Persisted task order remains separate. |
| apps/evals/src/runner/worker-failures.test.ts | partial audit | Real validator acceptance. Local target-selection logic bypasses runner injection. |
| apps/evals/src/scoring.test.ts | landed | #3332: scoring and efficiency decay. Runner budget selection remains unverified. |
| apps/evals/src/stats.test.ts | static audit complete | Interval bounds, seed behavior, signed differences, rank and pass-at-k estimates. Exact ties lack a median-rank assertion. |
| apps/evals/src/swarm/api-extension.test.ts | pending | |
| apps/evals/src/swarm/client.test.ts | pending | |
| apps/evals/src/swarm/codex-auth.test.ts | pending | |
| apps/evals/src/swarm/cost-wait.test.ts | pending | |
| apps/evals/src/swarm/sandbox.test.ts | pending | |
| apps/evals/src/swarm/timestamps.test.ts | landed | #3320: four shell controls and a controlled startup delay |
| apps/evals/src/swarm/version.test.ts | pending | |
| apps/evals/src/ui-attempt-outcome.test.ts | pending | |
| apps/evals/src/ui-heatmap-reliability.test.ts | pending | |
| apps/evals/src/ui-model-resolve.test.ts | pending | |
| apps/evals/src/ui-pareto-frontier.test.ts | pending | |
| apps/evals/src/ui-suite-analytics.test.ts | pending | |
| apps/ui/src/api/access-rejection.test.ts | pending | |
| apps/ui/src/api/client.test.tsx | pending | |
| apps/ui/src/api/hooks/favorite-flag.test.ts | pending | |
| apps/ui/src/api/hooks/request-composition-query.test.ts | pending | |
| apps/ui/src/api/hooks/session-toast-placement.test.tsx | pending | |
| apps/ui/src/api/hooks/session-triage-cache.test.ts | pending | |
| apps/ui/src/api/hooks/use-favorites.test.ts | pending | |
| apps/ui/src/api/hooks/use-feature-gate.test.ts | pending | |
| apps/ui/src/api/hooks/use-feedback.test.ts | pending | |
| apps/ui/src/api/hooks/use-fleet-report.test.ts | pending | |
| apps/ui/src/api/hooks/use-integrations-meta.test.tsx | pending | |
| apps/ui/src/api/hooks/use-invites-support.test.ts | pending | |
| apps/ui/src/api/hooks/use-notification-events.test.ts | pending | |
| apps/ui/src/api/hooks/use-request-composition.test.tsx | pending | |
| apps/ui/src/api/hooks/use-session-moves.test.ts | pending | |
| apps/ui/src/api/hooks/use-status.test.tsx | pending | |
| apps/ui/src/api/hooks/use-tasks-all-users-scope.test.tsx | pending | |
| apps/ui/src/api/hooks/use-ui-telemetry.test.ts | pending | |
| apps/ui/src/api/hooks/use-workflows.test.tsx | pending | |
| apps/ui/src/api/hooks/visible-onboarding-steps.test.ts | pending | |
| apps/ui/src/app/query-persistence.test.ts | pending | |
| apps/ui/src/app/route-redirect.test.tsx | pending | |
| apps/ui/src/app/routes.test.tsx | pending | |
| apps/ui/src/components/apps/app-shell.test.tsx | pending | |
| apps/ui/src/components/apps/app-surface-scope.test.tsx | pending | |
| apps/ui/src/components/apps/query-slot.test.ts | pending | |
| apps/ui/src/components/automations/needs-setup-badge.test.tsx | pending | |
| apps/ui/src/components/checklist/post-onboarding-checklist-card.test.tsx | pending | |
| apps/ui/src/components/comb/auto-connect-attempts.test.ts | pending | |
| apps/ui/src/components/comb/comment-composer.test.tsx | pending | |
| apps/ui/src/components/comb/connect-flow.test.ts | pending | |
| apps/ui/src/components/comb/copy-file-button.test.tsx | pending | |
| apps/ui/src/components/comb/row-menus.test.tsx | pending | |
| apps/ui/src/components/comb/use-dom-text-space.test.ts | pending | |
| apps/ui/src/components/comb/viewers/comb-markdown-update.test.tsx | pending | |
| apps/ui/src/components/comb/viewers/comb-markdown.test.tsx | pending | |
| apps/ui/src/components/comb/viewers/object-viewer.test.tsx | test audit complete, production partial | Board autosave and Source-switch preservation retained. Static review only. |
| apps/ui/src/components/comb/viewers/text-viewer.test.tsx | pending | |
| apps/ui/src/components/configuration/configuration-row.test.tsx | pending | |
| apps/ui/src/components/configuration/improvements-row.test.tsx | pending | |
| apps/ui/src/components/configuration/used-by-consent-row.test.tsx | pending | |
| apps/ui/src/components/dashboard/add-to-ranking-button.lifecycle.test.tsx | pending | |
| apps/ui/src/components/dashboard/add-to-ranking-button.test.tsx | pending | |
| apps/ui/src/components/dashboard/automation-setup-rows.test.tsx | pending | |
| apps/ui/src/components/dashboard/dashboard-nudges.test.tsx | pending | |
| apps/ui/src/components/dashboard/fleet-benchmark-card.test.tsx | pending | |
| apps/ui/src/components/dashboard/fleet-benchmark-forms.test.tsx | pending | |
| apps/ui/src/components/dashboard/telemetry-benchmark-banner.test.tsx | pending | |
| apps/ui/src/components/feedback/feedback-dialog.test.tsx | pending | |
| apps/ui/src/components/home/favorites.test.tsx | pending | |
| apps/ui/src/components/home/needs-you.test.tsx | pending | |
| apps/ui/src/components/improvements/improvement-approval-list.test.tsx | landed | C26 #3311; privacy checks consolidated before approval, controls and scoped coverage pass |
| apps/ui/src/components/improvements/improvement-dialog.test.tsx | pending | |
| apps/ui/src/components/integrations/chat-sdk-section.test.tsx | pending | |
| apps/ui/src/components/integrations/chat-sdk-setup.test.tsx | pending | |
| apps/ui/src/components/integrations/claude-managed-section.test.tsx | pending | |
| apps/ui/src/components/integrations/integration-card.test.tsx | pending | |
| apps/ui/src/components/layout/access-ended-screen.test.tsx | pending | |
| apps/ui/src/components/layout/swarm-switcher.test.tsx | pending | |
| apps/ui/src/components/layout/task-trail.test.ts | pending | |
| apps/ui/src/components/layout/use-access-check.test.tsx | pending | |
| apps/ui/src/components/link-preview/link-preview-panel.test.tsx | pending | |
| apps/ui/src/components/link-preview/link-preview-sheet.test.tsx | audited, retained | C28: external repair #3312 supersedes unpublished preload candidate; modal and toast guards retained |
| apps/ui/src/components/link-preview/link-preview-state.test.tsx | pending | |
| apps/ui/src/components/notifications/notification-bell.test.tsx | pending | |
| apps/ui/src/components/notifications/slack-connect-invite-card.test.tsx | pending | |
| apps/ui/src/components/objects/object-embed.test.tsx | pending | |
| apps/ui/src/components/objects/sheet-model.test.ts | pending | |
| apps/ui/src/components/onboarding/autosave-secret-field.test.ts | pending | |
| apps/ui/src/components/onboarding/first-task-invite-prompt.test.tsx | pending | |
| apps/ui/src/components/onboarding/onboarding-redirect.test.tsx | pending | |
| apps/ui/src/components/providers/providers.test.tsx | pending | |
| apps/ui/src/components/session-panel/model.test.ts | pending | |
| apps/ui/src/components/session-panel/page-screenshot.test.ts | pending | |
| apps/ui/src/components/session-panel/session-panel.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/group-tab-star.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/overview/overview-widgets.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/pane/internal-line.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/pane/outcome-preview.test.ts | pending | |
| apps/ui/src/components/sessions-v2/pane/swarm-reply.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/pane/turn-timeline.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/pane/use-step-blocks.test.ts | pending | |
| apps/ui/src/components/sessions-v2/sidebar/snooze-times.test.ts | pending | |
| apps/ui/src/components/sessions-v2/sidebar/tree-rows.test.ts | pending | |
| apps/ui/src/components/sessions-v2/tabs/tab-strip.test.tsx | pending | |
| apps/ui/src/components/sessions-v2/use-list-keys.test.ts | pending | |
| apps/ui/src/components/sessions/audio-recorder-waveform.test.tsx | pending | |
| apps/ui/src/components/sessions/audio-recorder.test.tsx | pending | |
| apps/ui/src/components/sessions/review-ack.test.tsx | pending | |
| apps/ui/src/components/sessions/session-conversation.test.tsx | pending | |
| apps/ui/src/components/sessions/session-timeline.test.tsx | pending | |
| apps/ui/src/components/sessions/task-outcome.test.tsx | pending | |
| apps/ui/src/components/shared/agent-runtime-settings.test.tsx | pending | |
| apps/ui/src/components/shared/agent-slack-icon-field.test.tsx | pending | |
| apps/ui/src/components/shared/agent-status-badge.test.tsx | pending | |
| apps/ui/src/components/shared/border-beam.test.tsx | pending | |
| apps/ui/src/components/shared/command-menu.test.tsx | pending | |
| apps/ui/src/components/shared/data-grid.test.tsx | pending | |
| apps/ui/src/components/shared/inline-identifier-code.test.tsx | pending | |
| apps/ui/src/components/shared/json-tree.test.tsx | pending | |
| apps/ui/src/components/shared/list-pager.test.tsx | pending | |
| apps/ui/src/components/shared/list-view.test.tsx | pending | |
| apps/ui/src/components/shared/markdown-view.test.tsx | pending | |
| apps/ui/src/components/shared/media-icon-field.test.tsx | pending | |
| apps/ui/src/components/shared/model-combobox.test.tsx | pending | |
| apps/ui/src/components/shared/model-details-card.test.tsx | pending | |
| apps/ui/src/components/shared/organization-name-dialog.test.tsx | pending | |
| apps/ui/src/components/shared/page-actions.test.tsx | pending | |
| apps/ui/src/components/shared/question-flow.test.tsx | pending | |
| apps/ui/src/components/shared/questions/submit-bar.test.tsx | pending | |
| apps/ui/src/components/shared/section-tabs.test.tsx | pending | |
| apps/ui/src/components/shared/session-log-messages.test.ts | pending | |
| apps/ui/src/components/shared/session-log-viewer.test.tsx | pending | |
| apps/ui/src/components/shared/status-badge.test.tsx | pending | |
| apps/ui/src/components/shared/task-attachments-section.test.tsx | pending | |
| apps/ui/src/components/shared/task-composer.test.tsx | pending | |
| apps/ui/src/components/shared/task-status-icon.test.tsx | pending | |
| apps/ui/src/components/shared/task-ui-spec-view.test.tsx | pending | |
| apps/ui/src/components/shared/tasks-table.test.tsx | pending | |
| apps/ui/src/components/shared/transcript/message-text.test.tsx | pending | |
| apps/ui/src/components/shared/transcript/transcript-rows.test.ts | pending | |
| apps/ui/src/components/shared/transcript/transcript.test.tsx | pending | |
| apps/ui/src/components/shared/user-chip.test.tsx | pending | |
| apps/ui/src/components/shared/version-update-notice.test.tsx | pending | |
| apps/ui/src/components/steering/steer-composer.test.tsx | pending | |
| apps/ui/src/components/steering/steering-message-chips.test.tsx | pending | |
| apps/ui/src/components/ui/middle-truncation.test.tsx | pending | |
| apps/ui/src/components/workflows/foreach-step-group.test.tsx | pending | |
| apps/ui/src/components/workflows/node-summary.test.ts | pending | |
| apps/ui/src/components/workflows/step-card.test.tsx | pending | |
| apps/ui/src/embed/swarm-object-element.test.tsx | pending | |
| apps/ui/src/hooks/use-copy-to-clipboard.test.tsx | pending | |
| apps/ui/src/hooks/use-needs-you.test.tsx | pending | |
| apps/ui/src/hooks/use-sessions-view.test.tsx | pending | |
| apps/ui/src/hooks/use-swipe-row.test.ts | pending | |
| apps/ui/src/hooks/use-url-search-state.test.tsx | pending | |
| apps/ui/src/hooks/use-versioned-app-references.test.tsx | pending | |
| apps/ui/src/hooks/use-versioned-value.test.tsx | pending | |
| apps/ui/src/lib/activity-density.test.ts | pending | |
| apps/ui/src/lib/agent-fs/client.test.ts | pending | |
| apps/ui/src/lib/agent-fs/credential-store.test.ts | pending | |
| apps/ui/src/lib/agent-fs/invalidation.test.ts | pending | |
| apps/ui/src/lib/agent-fs/key-label.test.ts | pending | |
| apps/ui/src/lib/agent-fs/live-batcher.test.ts | pending | |
| apps/ui/src/lib/agent-fs/query.test.ts | pending | |
| apps/ui/src/lib/agent-fs/sse.test.ts | pending | |
| apps/ui/src/lib/agent-fs/state.test.ts | pending | |
| apps/ui/src/lib/agent-fs/stream-share.test.ts | pending | |
| apps/ui/src/lib/agent-fs/stream.test.ts | pending | |
| apps/ui/src/lib/agent-runtime-models.test.ts | pending | |
| apps/ui/src/lib/agent-saved-runtime.test.ts | pending | |
| apps/ui/src/lib/ai-providers.test.ts | pending | |
| apps/ui/src/lib/all-users-scope.test.ts | pending | |
| apps/ui/src/lib/app-version.test.ts | pending | |
| apps/ui/src/lib/approval-format.test.tsx | static audit complete | C26: retained after assertion review; included in seven-file validation and paired coverage, no file-specific mutation claim |
| apps/ui/src/lib/approval-inline.test.ts | static audit complete | C26: retained after assertion review; included in seven-file validation and paired coverage, no file-specific mutation claim |
| apps/ui/src/lib/approval-responses.test.tsx | static audit complete | C26: retained after assertion review; included in seven-file validation and paired coverage, no file-specific mutation claim |
| apps/ui/src/lib/approval-shortcuts.test.tsx | landed | C26 #3311; duplicate typing assertion removed, retained matrix detects the control |
| apps/ui/src/lib/auto-review.test.ts | pending | |
| apps/ui/src/lib/azure-embeddings.test.ts | pending | |
| apps/ui/src/lib/chat-sdk-form.test.ts | pending | |
| apps/ui/src/lib/comb/batch.test.ts | pending | |
| apps/ui/src/lib/comb/bulk.test.ts | pending | |
| apps/ui/src/lib/comb/code-language.test.ts | pending | |
| apps/ui/src/lib/comb/comment-anchor.test.ts | pending | |
| apps/ui/src/lib/comb/comment-edit.test.ts | pending | |
| apps/ui/src/lib/comb/comments.test.ts | pending | |
| apps/ui/src/lib/comb/copy-contents.test.ts | pending | |
| apps/ui/src/lib/comb/csv.test.ts | pending | |
| apps/ui/src/lib/comb/diff-lines.test.ts | pending | |
| apps/ui/src/lib/comb/dismissed.test.ts | pending | |
| apps/ui/src/lib/comb/dom-text-space.test.ts | pending | |
| apps/ui/src/lib/comb/drafts.test.ts | pending | |
| apps/ui/src/lib/comb/favorites.test.ts | pending | |
| apps/ui/src/lib/comb/file-icons.test.ts | pending | |
| apps/ui/src/lib/comb/file-kinds.test.ts | pending | |
| apps/ui/src/lib/comb/file-names.test.ts | pending | |
| apps/ui/src/lib/comb/folder-filter.test.ts | pending | |
| apps/ui/src/lib/comb/frontmatter.test.ts | pending | |
| apps/ui/src/lib/comb/html-view.test.ts | pending | |
| apps/ui/src/lib/comb/links.test.ts | pending | |
| apps/ui/src/lib/comb/markers.test.ts | pending | |
| apps/ui/src/lib/comb/media.test.ts | pending | |
| apps/ui/src/lib/comb/mentions.test.ts | pending | |
| apps/ui/src/lib/comb/outline.test.ts | pending | |
| apps/ui/src/lib/comb/panels.test.ts | pending | |
| apps/ui/src/lib/comb/paths.test.ts | pending | |
| apps/ui/src/lib/comb/presence-client.test.ts | pending | |
| apps/ui/src/lib/comb/presence.test.ts | pending | |
| apps/ui/src/lib/comb/recent.test.ts | pending | |
| apps/ui/src/lib/comb/rehype-source-lines.test.ts | pending | |
| apps/ui/src/lib/comb/review.test.ts | pending | |
| apps/ui/src/lib/comb/search.test.ts | pending | |
| apps/ui/src/lib/comb/share.test.ts | pending | |
| apps/ui/src/lib/comb/text-content.test.ts | pending | |
| apps/ui/src/lib/comb/text-lines.test.ts | pending | |
| apps/ui/src/lib/comb/thread-filter.test.ts | pending | |
| apps/ui/src/lib/comb/thread-status.test.ts | pending | |
| apps/ui/src/lib/comb/tree.test.ts | pending | |
| apps/ui/src/lib/comb/upload.test.ts | pending | |
| apps/ui/src/lib/command-palette/identity.test.ts | pending | |
| apps/ui/src/lib/command-palette/match.test.ts | pending | |
| apps/ui/src/lib/company-profile.test.ts | pending | |
| apps/ui/src/lib/composer-drafts.test.ts | pending | |
| apps/ui/src/lib/composer-mentions.test.ts | pending | |
| apps/ui/src/lib/composer-paste.test.ts | pending | |
| apps/ui/src/lib/config.test.tsx | test audit complete, production partial | New main file: 25 cases and 110 assertions pass, no justified deletion, limits recorded |
| apps/ui/src/lib/configuration-values.test.tsx | pending | |
| apps/ui/src/lib/connection-url-params.test.ts | pending | |
| apps/ui/src/lib/context-display.test.tsx | pending | |
| apps/ui/src/lib/deployment-config.test.tsx | pending | |
| apps/ui/src/lib/enter-submit.test.ts | pending | |
| apps/ui/src/lib/env-presence-batch.test.ts | pending | |
| apps/ui/src/lib/feedback-popup.test.tsx | pending | |
| apps/ui/src/lib/fleet-benchmark.test.ts | pending | |
| apps/ui/src/lib/github-star-nudge-toast.test.tsx | pending | |
| apps/ui/src/lib/grid-row-click.test.ts | pending | |
| apps/ui/src/lib/home-favorites.test.ts | pending | |
| apps/ui/src/lib/home-metrics.test.ts | pending | |
| apps/ui/src/lib/in-progress.test.ts | pending | |
| apps/ui/src/lib/integration-form-state.test.ts | pending | |
| apps/ui/src/lib/integrations-catalog.test.tsx | pending | |
| apps/ui/src/lib/integrations-status.test.ts | pending | |
| apps/ui/src/lib/json-output.test.ts | pending | |
| apps/ui/src/lib/json-render/accordion.test.tsx | pending | |
| apps/ui/src/lib/json-render/action-params.test.ts | pending | |
| apps/ui/src/lib/json-render/apply-template.test.ts | pending | |
| apps/ui/src/lib/json-render/approval.test.tsx | pending | |
| apps/ui/src/lib/json-render/card-grid-model.test.ts | pending | |
| apps/ui/src/lib/json-render/chain-halt-on-error.test.tsx | pending | |
| apps/ui/src/lib/json-render/chain-halt.test.ts | pending | |
| apps/ui/src/lib/json-render/chart-model.test.ts | pending | |
| apps/ui/src/lib/json-render/data-views.test.tsx | pending | |
| apps/ui/src/lib/json-render/drawer-split.test.tsx | pending | |
| apps/ui/src/lib/json-render/files.test.tsx | pending | |
| apps/ui/src/lib/json-render/form-chain-state.test.tsx | pending | |
| apps/ui/src/lib/json-render/form-file.test.tsx | pending | |
| apps/ui/src/lib/json-render/format-value.test.ts | pending | |
| apps/ui/src/lib/json-render/link-cell-model.test.ts | pending | |
| apps/ui/src/lib/json-render/number-input-value.test.ts | pending | |
| apps/ui/src/lib/json-render/page-frame.test.tsx | pending | |
| apps/ui/src/lib/json-render/primitives.test.tsx | pending | |
| apps/ui/src/lib/json-render/schema-form-model.test.ts | pending | |
| apps/ui/src/lib/json-render/schema-form.test.tsx | pending | |
| apps/ui/src/lib/json-render/select-default.test.tsx | pending | |
| apps/ui/src/lib/json-render/session-thread-model.test.ts | pending | |
| apps/ui/src/lib/json-render/session-thread.test.tsx | pending | |
| apps/ui/src/lib/json-render/swarm-call-endpoint.test.ts | pending | |
| apps/ui/src/lib/json-render/table-filters-ui.test.tsx | pending | |
| apps/ui/src/lib/json-render/table-filters.test.ts | pending | |
| apps/ui/src/lib/json-render/table-phone-card.test.tsx | pending | |
| apps/ui/src/lib/json-render/table-selection-ui.test.tsx | pending | |
| apps/ui/src/lib/json-render/table-selection.test.ts | pending | |
| apps/ui/src/lib/json-render/tree-model.test.ts | pending | |
| apps/ui/src/lib/json-render/tree.test.tsx | pending | |
| apps/ui/src/lib/json-value.test.ts | pending | |
| apps/ui/src/lib/link-preview-dock.test.ts | pending | |
| apps/ui/src/lib/link-preview.test.ts | pending | |
| apps/ui/src/lib/list-search.test.tsx | pending | |
| apps/ui/src/lib/local-network.test.ts | pending | |
| apps/ui/src/lib/markdown-images.test.ts | pending | |
| apps/ui/src/lib/markdown-preview.test.ts | pending | |
| apps/ui/src/lib/markdown/swarm-embed.test.ts | pending | |
| apps/ui/src/lib/memory-key-tree.test.ts | pending | |
| apps/ui/src/lib/model-catalog-drift.test.ts | pending | |
| apps/ui/src/lib/model-dial.test.ts | pending | |
| apps/ui/src/lib/model-vendor.test.ts | pending | |
| apps/ui/src/lib/needs-you.test.ts | pending | |
| apps/ui/src/lib/normalize-newlines.test.ts | pending | |
| apps/ui/src/lib/notifications/slack-connect-moment.test.ts | pending | |
| apps/ui/src/lib/notifications/unread.test.ts | pending | |
| apps/ui/src/lib/page-context.test.ts | pending | |
| apps/ui/src/lib/prompt-display.test.ts | pending | |
| apps/ui/src/lib/provider-quota.test.ts | pending | |
| apps/ui/src/lib/provider-status.test.ts | pending | |
| apps/ui/src/lib/recent-failures.test.tsx | pending | |
| apps/ui/src/lib/relative-time.test.ts | pending | |
| apps/ui/src/lib/reveal-text.test.ts | pending | |
| apps/ui/src/lib/runtime-instances.test.tsx | pending | |
| apps/ui/src/lib/runtime-pool-workspace.test.ts | pending | |
| apps/ui/src/lib/schedule-format.test.tsx | pending | |
| apps/ui/src/lib/session-groups.test.ts | pending | |
| apps/ui/src/lib/session-log-usage-details.test.ts | pending | |
| apps/ui/src/lib/session-presence.test.ts | pending | |
| apps/ui/src/lib/session-search.test.ts | pending | |
| apps/ui/src/lib/session-shares-mutation.test.ts | pending | |
| apps/ui/src/lib/session-sharing.test.ts | pending | |
| apps/ui/src/lib/session-status.test.tsx | pending | |
| apps/ui/src/lib/session-turns.test.ts | pending | |
| apps/ui/src/lib/sessions-show.test.ts | pending | |
| apps/ui/src/lib/sessions-v2.test.ts | pending | |
| apps/ui/src/lib/sha256.test.ts | pending | |
| apps/ui/src/lib/short-id.test.ts | pending | |
| apps/ui/src/lib/slack-text.test.ts | pending | |
| apps/ui/src/lib/subscription-savings.test.ts | pending | |
| apps/ui/src/lib/swarm-links.test.ts | pending | |
| apps/ui/src/lib/swarm-sdk.test.ts | pending | |
| apps/ui/src/lib/task-activity.test.tsx | pending | |
| apps/ui/src/lib/task-effort.test.ts | pending | |
| apps/ui/src/lib/task-links.test.ts | pending | |
| apps/ui/src/lib/task-model-resolution.test.tsx | pending | |
| apps/ui/src/lib/task-retry.test.ts | pending | |
| apps/ui/src/lib/task-steer.test.ts | pending | |
| apps/ui/src/lib/task-support.test.tsx | pending | |
| apps/ui/src/lib/task-title.test.tsx | pending | |
| apps/ui/src/lib/telemetry-banner.test.ts | pending | |
| apps/ui/src/lib/transcription-status.test.ts | pending | |
| apps/ui/src/lib/upload-media-icon.test.ts | pending | |
| apps/ui/src/lib/use-can.test.ts | pending | |
| apps/ui/src/lib/use-case-overview.test.ts | pending | |
| apps/ui/src/lib/uuid.test.ts | pending | |
| apps/ui/src/pages/agents/[id]/runtime-instances-section.test.tsx | pending | |
| apps/ui/src/pages/approval-requests/components/request-header.test.tsx | static audit complete | C26: retained after assertion review; included in seven-file validation and paired coverage, no file-specific mutation claim |
| apps/ui/src/pages/approval-requests/components/request-list.test.tsx | static audit complete | C26: retained after assertion review; included in seven-file validation and paired coverage, no file-specific mutation claim |
| apps/ui/src/pages/config/description-cell.test.ts | pending | |
| apps/ui/src/pages/connect-pages/ai-embeddings-tab.test.tsx | pending | |
| apps/ui/src/pages/connect-pages/ai-system-one-tab.test.tsx | pending | |
| apps/ui/src/pages/connect-pages/ai-transcription-tab.test.tsx | pending | |
| apps/ui/src/pages/connect-pages/channels-page.test.tsx | pending | |
| apps/ui/src/pages/connect-pages/tools-page.test.tsx | pending | |
| apps/ui/src/pages/connect/connect-flow.test.ts | pending | |
| apps/ui/src/pages/debug/filter-tables.test.ts | pending | |
| apps/ui/src/pages/debug/format-cell.test.ts | pending | |
| apps/ui/src/pages/fs-continue/page.test.tsx | pending | |
| apps/ui/src/pages/home/unified-home.test.tsx | pending | |
| apps/ui/src/pages/join/join-flow.test.ts | pending | |
| apps/ui/src/pages/join/page.test.tsx | pending | |
| apps/ui/src/pages/pages/[id]/page-header-summary.test.tsx | pending | |
| apps/ui/src/pages/people/invite-destination.test.ts | pending | |
| apps/ui/src/pages/settings/settings-layout.test.tsx | pending | |
| apps/ui/src/pages/setup/steps/agents/agent-models.test.tsx | pending | |
| apps/ui/src/pages/setup/steps/ai/harness-switch.test.tsx | pending | |
| apps/ui/src/pages/setup/steps/ai/model.test.ts | pending | |
| apps/ui/src/pages/setup/steps/first-task/starters.test.ts | pending | |
| apps/ui/src/pages/setup/steps/step-ai.test.tsx | pending | |
| apps/ui/src/pages/setup/steps/step-files.test.tsx | pending | |
| apps/ui/src/pages/setup/steps/step-memory.test.tsx | pending | |
| apps/ui/src/pages/tasks/[id]/lineage/lineage-tree.test.ts | pending | |
| apps/ui/src/pages/tasks/[id]/spawned-tasks.test.ts | pending | |
| apps/ui/src/pages/tasks/task-effort-field.test.tsx | pending | |
| apps/ui/src/pages/tasks/use-stale-page-correction.test.tsx | pending | |
| apps/ui/src/pages/usage/subscriptions-card-tips.test.tsx | pending | |
| apps/ui/src/pages/usage/subscriptions-card.test.tsx | pending | |
| apps/ui/src/pages/usage/usage-layout.test.tsx | pending | |
| apps/ui/tests/acp-logs-parser.test.ts | pending | |
| apps/ui/tests/amp-logs-parser.test.ts | pending | |
| apps/ui/tests/cursor-logs-parser.test.ts | pending | |
| apps/ui/tests/dsh-logs-parser.test.ts | pending | |
| apps/ui/tests/tool-result-images.test.ts | pending | |
| packages/model-catalog/src/chatgpt-subscription.test.ts | landed | C14: PR #3271, literal expectations and discriminating fixtures |
| packages/model-catalog/src/harness-models.test.ts | landed | C14: PR #3271, literal expectations and discriminating fixtures |
| packages/model-catalog/src/reasoning.test.ts | landed | C14: PR #3271, literal expectations and discriminating fixtures |
| packages/model-catalog/src/resolve-alias.test.ts | landed | C14: PR #3271, literal expectations and discriminating fixtures |
| packages/model-routing/src/credential-status.test.ts | audited, retained | C13. All 48 package tests passed. Origin and redirect controls detected regressions. |
| packages/model-routing/src/default-route.test.ts | audited, retained | C13. All 48 package tests passed. Origin and redirect controls detected regressions. |
| packages/model-routing/src/scoped-fetch.test.ts | audited, retained | C13. All 48 package tests passed. Origin and redirect controls detected regressions. |
| packages/ui-e2e/specs/app-drawer-width.spec.ts | pending | |
| packages/ui-e2e/specs/app-input-first-edit.spec.ts | pending | |
| packages/ui-e2e/specs/app-shell-scroll.spec.ts | pending | |
| packages/ui-e2e/specs/app-smart-links.spec.ts | pending | |
| packages/ui-e2e/specs/codex-logs.spec.ts | pending | |
| packages/ui-e2e/specs/comb.spec.ts | pending | |
| packages/ui-e2e/specs/composer-enter-key.spec.ts | pending | |
| packages/ui-e2e/specs/configuration.spec.ts | pending | |
| packages/ui-e2e/specs/connect.spec.ts | pending | |
| packages/ui-e2e/specs/create-task.spec.ts | pending | |
| packages/ui-e2e/specs/entity-refresh.spec.ts | pending | |
| packages/ui-e2e/specs/extensions.spec.ts | pending | |
| packages/ui-e2e/specs/favorites.spec.ts | pending | |
| packages/ui-e2e/specs/home.spec.ts | pending | |
| packages/ui-e2e/specs/invites.spec.ts | pending | |
| packages/ui-e2e/specs/link-preview.spec.ts | pending | |
| packages/ui-e2e/specs/object-embed.spec.ts | pending | |
| packages/ui-e2e/specs/organization-name.spec.ts | pending | |
| packages/ui-e2e/specs/overflow-desktop.spec.ts | pending | |
| packages/ui-e2e/specs/overflow-narrow.spec.ts | pending | |
| packages/ui-e2e/specs/overflow-phone.spec.ts | pending | |
| packages/ui-e2e/specs/overflow.spec.ts | pending | |
| packages/ui-e2e/specs/pages.spec.ts | pending | |
| packages/ui-e2e/specs/phone-header-health.spec.ts | pending | |
| packages/ui-e2e/specs/prompt-attachments.spec.ts | pending | |
| packages/ui-e2e/specs/provider-limits.spec.ts | pending | |
| packages/ui-e2e/specs/realtime-rooms.spec.ts | pending | |
| packages/ui-e2e/specs/redirects.spec.ts | pending | |
| packages/ui-e2e/specs/runtime-pools.spec.ts | pending | |
| packages/ui-e2e/specs/sessions-overview.spec.ts | pending | |
| packages/ui-e2e/specs/sessions-sidebar.spec.ts | pending | |
| packages/ui-e2e/specs/sessions-v2.spec.ts | pending | |
| packages/ui-e2e/specs/setup-session-transition.spec.ts | pending | |
| packages/ui-e2e/specs/smoke.spec.ts | pending | |
| packages/ui-e2e/specs/tasks.spec.ts | pending | |
| src/be/automation-preflight.test.ts | pending | |
| src/github/mentions-aliases.test.ts | pending | |
| src/github/mentions.test.ts | pending | |
| src/hooks/tool-loop-detection.test.ts | pending | |
| src/scheduler/scheduler.test.ts | pending | |
| src/slack/event-dedup.test.ts | pending | |
| src/slack/handlers.test.ts | pending | |
| src/slack/work-objects.test.ts | pending | |
| src/tests/acp-adapter.test.ts | pending | |
| src/tests/acp-dashboard-runtime.test.ts | pending | |
| src/tests/acp-session-token.test.ts | pending | |
| src/tests/acp-swarm-events.test.ts | pending | |
| src/tests/additive-buffer.test.ts | pending | |
| src/tests/additive-ingress.test.ts | pending | |
| src/tests/agent-avatar-resolution.test.ts | pending | |
| src/tests/agent-fs-provision-seeder.test.ts | pending | |
| src/tests/agent-fs-release-notes.test.ts | pending | |
| src/tests/agent-fs-user-keys.test.ts | pending | |
| src/tests/agent-history.test.ts | pending | |
| src/tests/agent-session-tokens.test.ts | pending | |
| src/tests/agent-slack-icon.test.ts | pending | |
| src/tests/agent-task-activity.test.ts | pending | |
| src/tests/agentfs-proxy.test.ts | pending | |
| src/tests/agentmail-filters.test.ts | pending | |
| src/tests/agentmail-handlers.test.ts | pending | |
| src/tests/agentmail-inbound-archive.test.ts | pending | |
| src/tests/agentmail-sending-skill.test.ts | pending | |
| src/tests/agents-harness-provider.test.ts | pending | |
| src/tests/agents-list-model-display.test.ts | pending | |
| src/tests/amp-adapter.test.ts | pending | |
| src/tests/amp-budget-export-failed.test.ts | pending | |
| src/tests/amp-pricing.test.ts | pending | |
| src/tests/api-drain-e2e.test.ts | audited and tested | C02. Final review and landing pending. |
| src/tests/api-drain-worker-e2e.test.ts | audited and tested | C02. Final review and landing pending. |
| src/tests/api-drain.test.ts | audited and tested | C02. Final review and landing pending. |
| src/tests/api-key-auth-failure-route.test.ts | pending | |
| src/tests/api-key-status-by-suffix.test.ts | pending | |
| src/tests/api-key-tracking.test.ts | pending | |
| src/tests/api-key.test.ts | pending | |
| src/tests/api-keys-status-model-limits.test.ts | pending | |
| src/tests/api-keys-validation.test.ts | pending | |
| src/tests/app-action-run-tool.test.ts | pending | |
| src/tests/app-row-tools.test.ts | pending | |
| src/tests/approval-auto-cancellation-migration.test.ts | landed | C25 PR #3306: +8/-19, four controls, selective replay and uninstrumented SQL limits |
| src/tests/approval-cancellation-migration.test.ts | test audit complete, production partial | C25: table reconstruction and field preservation, no runtime controls |
| src/tests/approval-card-resolution.test.ts | landed | C25 PR #3299: +2/-17, 20 cases, four controls, zero lost measured production lines |
| src/tests/approval-config-question.test.ts | test audit complete, production partial | C25: all 702 lines reviewed, direct normalization and answer paths compared, preserve separate secret and ingress contracts |
| src/tests/approval-requests-notifications.test.ts | landed | C25 #3308 landed after external preview repair #3312; dispatch and latency limits remain |
| src/tests/approval-requests.test.ts | test audit complete, production partial | C25 PRs #3301, #3304, #3305, #3307, #3310 landed; preserve transaction boundaries |
| src/tests/approval-respond-auth.test.ts | test audit complete, production partial | C25: preserve principals, attribution, quorum, and concurrency, full-server admission remains separate |
| src/tests/approval-sweeps.test.ts | test audit complete, production partial | C25: rollback and recovery retained; list/expiry controls and union coverage support #3310 |
| src/tests/apps-action-parent-task.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-card-grid.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-additions.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-drift.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-feedback.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-files.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-hitl.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-inputs.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-page-frame.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-catalog-table.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-chart-shell.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-element-assembly.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-elements.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-icon.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-json-column.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-kibo-blocks.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-rbac.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-schema-form.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-script-types.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-session-thread.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-smart-links.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-spike.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-spike2.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-spike4.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-spike5.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-sync-engine.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-sync.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-table-filters-migration.test.ts | landed | C18: PR #3272, real merge path and both migration stages |
| src/tests/apps-table-selection-migration.test.ts | removed | C18: PR #3272, guards consolidated into filters migration |
| src/tests/apps-tree.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/apps-user-config.test.ts | static audit complete | C18: controls and consolidation pending |
| src/tests/asset-key-api.test.ts | pending | |
| src/tests/asset-key-invariants.test.ts | pending | |
| src/tests/asset-key-mcp.test.ts | pending | |
| src/tests/asset-key-migration.test.ts | pending | |
| src/tests/asset-key-normalization.test.ts | pending | |
| src/tests/asyncdb-guard-races.test.ts | pending | |
| src/tests/audit-agent-person.test.ts | pending | |
| src/tests/audit-updated-by.test.ts | pending | |
| src/tests/audit-user.test.ts | pending | |
| src/tests/automation-preflight-alert.test.ts | pending | |
| src/tests/aws-error-classifier.test.ts | pending | |
| src/tests/azure-devops-auth.test.ts | pending | |
| src/tests/azure-devops-boards-sync.test.ts | pending | |
| src/tests/azure-devops-handlers.test.ts | pending | |
| src/tests/azure-devops-html.test.ts | pending | |
| src/tests/azure-devops-outbound.test.ts | pending | |
| src/tests/azure-devops-webhook-malformed.test.ts | pending | |
| src/tests/base-prompt.test.ts | pending | |
| src/tests/bedrock-model-groups.test.ts | pending | |
| src/tests/bitbucket-auth.test.ts | pending | |
| src/tests/bitbucket-handlers.test.ts | pending | |
| src/tests/bitbucket-webhook.test.ts | pending | |
| src/tests/boot-scrub-sweep.test.ts | pending | |
| src/tests/boot-seeds.test.ts | pending | |
| src/tests/budget-admission.test.ts | pending | |
| src/tests/budget-claim-gate.test.ts | pending | |
| src/tests/budget-refusal-notification.test.ts | pending | |
| src/tests/budget-user-scope.test.ts | pending | |
| src/tests/budgets-routes.test.ts | pending | |
| src/tests/build-pi-skills.test.ts | pending | |
| src/tests/bump-agent-fs.test.ts | pending | |
| src/tests/business-use-scrub.test.ts | pending | |
| src/tests/caller-session-group.test.ts | pending | |
| src/tests/cancel-approval-request-tool.test.ts | pending | |
| src/tests/chained-task-follow-up.test.ts | pending | |
| src/tests/channel-activity.test.ts | pending | |
| src/tests/chat-sdk-attachments-reply.test.ts | pending | |
| src/tests/chat-sdk-commands.test.ts | pending | |
| src/tests/chat-sdk-config.test.ts | pending | |
| src/tests/chat-sdk-discord-api.test.ts | pending | |
| src/tests/chat-sdk-discord-gateway.test.ts | pending | |
| src/tests/chat-sdk-discord-webhook.test.ts | pending | |
| src/tests/chat-sdk-fields-sync.test.ts | pending | |
| src/tests/chat-sdk-inbound.test.ts | pending | |
| src/tests/chat-sdk-mentions.test.ts | pending | |
| src/tests/chat-sdk-outbound-files.test.ts | pending | |
| src/tests/chat-sdk-relay.test.ts | pending | |
| src/tests/chat-sdk-reload.test.ts | pending | |
| src/tests/chat-sdk-rocketchat-vendored.test.ts | pending | |
| src/tests/chat-sdk-shutdown.test.ts | pending | |
| src/tests/chat-sdk-slack.test.ts | pending | |
| src/tests/chat-sdk-state.test.ts | pending | |
| src/tests/chat-sdk-status-route.test.ts | pending | |
| src/tests/chat-sdk-teams.test.ts | pending | |
| src/tests/chat-sdk-telegram-markdown.test.ts | pending | |
| src/tests/chat-sdk-telegram-token.test.ts | pending | |
| src/tests/chat-sdk-tools.test.ts | pending | |
| src/tests/chat-sdk-typing.test.ts | pending | |
| src/tests/chat-sdk-webhook-telegram.test.ts | pending | |
| src/tests/chatgpt-subscription-model-groups.test.ts | pending | |
| src/tests/chatgpt-subscription-pi.test.ts | pending | |
| src/tests/chatgpt-subscription-session-bench.test.ts | pending | |
| src/tests/check-playwright-version.test.ts | pending | |
| src/tests/check-pr-body.test.ts | pending | |
| src/tests/check-text-columns.test.ts | pending | |
| src/tests/check-unit-test-allowlist.test.ts | pending | |
| src/tests/checklist-nudge.test.ts | pending | |
| src/tests/checklist.test.ts | pending | |
| src/tests/ci-unit-test-report.test.ts | pending | |
| src/tests/claude-adapter-binary.test.ts | pending | |
| src/tests/claude-adapter-otel.test.ts | pending | |
| src/tests/claude-adapter.test.ts | pending | |
| src/tests/claude-artifacts-read-script.test.ts | pending | |
| src/tests/claude-background-keepalive-wiring.test.ts | pending | |
| src/tests/claude-background-keepalive.test.ts | pending | |
| src/tests/claude-default-route.test.ts | pending | |
| src/tests/claude-flag-settings.test.ts | pending | |
| src/tests/claude-hook-credentials.test.ts | pending | |
| src/tests/claude-hook-output.test.ts | pending | |
| src/tests/claude-managed-adapter.test.ts | pending | |
| src/tests/claude-managed-setup.test.ts | pending | |
| src/tests/claude-md-session.test.ts | pending | |
| src/tests/claude-prompt-body-once.test.ts | pending | |
| src/tests/claude-routes-e2e.test.ts | pending | |
| src/tests/claude-sdk-lifecycle.test.ts | pending | |
| src/tests/claude-sdk-live-lifecycle.test.ts | pending | |
| src/tests/claude-sdk-transport.test.ts | pending | |
| src/tests/claude-stop-hook.test.ts | pending | |
| src/tests/claude-thinking-tokens.test.ts | pending | |
| src/tests/claude-worker-parity.test.ts | pending | |
| src/tests/codex-adapter-otel.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-adapter-pool-auth-revalidate.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-adapter.test.ts | static audit complete | C21: cancellation landed through PR #3281 |
| src/tests/codex-app-server.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-auth-failure.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-credential-pools.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-gateway-route.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-gpt6-release.test.ts | test audit complete, production partial | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-login.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-accounts.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-adapter.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-auth-json-fs.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-auth-timestamps.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-credential-info.test.ts | landed | C23: PR #3286, production resolver and persistence contracts retained |
| src/tests/codex-oauth-device.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-env-keys.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-keep-warm.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-refresh-egress.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-refresh-lock.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth-storage.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-oauth.test.ts | landed | #3321: one exact duplicate removed. Retained assertion fails its control. |
| src/tests/codex-pool.test.ts | landed | C23: PR #3286, production resolver and persistence contracts retained |
| src/tests/codex-rate-limit-parse.test.ts | landed | #3321: one exact duplicate removed. Retained assertion fails its control. |
| src/tests/codex-rate-limits.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-rollouts.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-skill-resolver.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-steering-hook.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-subprocess-steering.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/codex-swarm-events.test.ts | static audit complete | C21: cancellation landed through PR #3281 |
| src/tests/comb-config-guard.test.ts | pending | |
| src/tests/comb-default.test.ts | pending | |
| src/tests/comb-links.test.ts | pending | |
| src/tests/comb-markers.test.ts | pending | |
| src/tests/comb-review-batch.test.ts | pending | |
| src/tests/comb-status.test.ts | pending | |
| src/tests/community-linear-delivery-loop.test.ts | pending | |
| src/tests/concurrency.test.ts | pending | |
| src/tests/config-api-only-keys.test.ts | pending | |
| src/tests/config-internal-keys.test.ts | pending | |
| src/tests/config-key-filter.test.ts | pending | |
| src/tests/config-pool-keys.test.ts | pending | |
| src/tests/config-refs.test.ts | pending | |
| src/tests/config-session-auth.test.ts | pending | |
| src/tests/connection-embedded-auth.test.ts | pending | |
| src/tests/console-scrub.test.ts | audited, retained | C16: 8 tests, 53 assertions |
| src/tests/context-bound-note.test.ts | pending | |
| src/tests/context-key-db.test.ts | pending | |
| src/tests/context-key.test.ts | pending | |
| src/tests/context-preamble-budget.test.ts | pending | |
| src/tests/context-snapshot.test.ts | pending | |
| src/tests/context-versioning.test.ts | pending | |
| src/tests/context-versions-retention.test.ts | pending | |
| src/tests/context-window.test.ts | pending | |
| src/tests/cors-allowlist.test.ts | pending | |
| src/tests/create-page-tool.test.ts | pending | |
| src/tests/create-schedule-key.test.ts | pending | |
| src/tests/create-task-validation.test.ts | pending | |
| src/tests/create-task-vcs-repo.test.ts | pending | |
| src/tests/credential-broker.test.ts | pending | |
| src/tests/credential-check.test.ts | pending | |
| src/tests/credential-exhaustion-policy.test.ts | pending | |
| src/tests/credential-outcome-report.test.ts | pending | |
| src/tests/credential-refresh.test.ts | pending | |
| src/tests/credential-status-api.test.ts | pending | |
| src/tests/credential-status-routing.test.ts | pending | |
| src/tests/credential-wait.test.ts | pending | |
| src/tests/credentials-allowlist.test.ts | pending | |
| src/tests/credentials.test.ts | pending | |
| src/tests/cursor-adapter.test.ts | pending | |
| src/tests/db-agents.test.ts | pending | |
| src/tests/db-capacity.test.ts | pending | |
| src/tests/db-client-busy-retry.test.ts | landed | C22 PR #3293: +48/-26, 18 cases, accounting controls detected, scoped coverage loses no lines |
| src/tests/db-client.test.ts | pending | |
| src/tests/db-extraction-contract.test.ts | pending | |
| src/tests/db-queries-oauth.test.ts | pending | |
| src/tests/db-queries-tracker.test.ts | pending | |
| src/tests/db-query-denylist.test.ts | pending | |
| src/tests/db-query.test.ts | pending | |
| src/tests/db-retention-defaults.test.ts | pending | |
| src/tests/db-retention-telemetry.test.ts | pending | |
| src/tests/db-retention.test.ts | pending | |
| src/tests/db-task-read-contract.test.ts | pending | |
| src/tests/db-task-write-contract.test.ts | pending | |
| src/tests/db-tasks-read.test.ts | pending | |
| src/tests/db-tasks-write.test.ts | pending | |
| src/tests/defer-task.test.ts | pending | |
| src/tests/deferred-schedule-reaper.test.ts | pending | |
| src/tests/deferred-task-wait-migration.test.ts | pending | |
| src/tests/deferred-task-wake.test.ts | pending | |
| src/tests/deferred-wake-follow-up.test.ts | pending | |
| src/tests/delete-page-tool.test.ts | pending | |
| src/tests/deploy-guard.test.ts | pending | |
| src/tests/deploy-one-box.test.ts | pending | |
| src/tests/deploy-release-dispatch.test.ts | pending | |
| src/tests/deploy-select.test.ts | pending | |
| src/tests/devin-adapter.test.ts | pending | |
| src/tests/devin-api.test.ts | pending | |
| src/tests/docker-isolation-config-guard.test.ts | pending | |
| src/tests/docs-index-footprint.test.js | pending | |
| src/tests/docs-index.test.ts | pending | |
| src/tests/dokploy-deploy.test.ts | pending | |
| src/tests/draft-task-dispatch-race.test.ts | pending | |
| src/tests/dreaming-gather-corrections.test.ts | pending | |
| src/tests/dreaming-gather-prev-run.test.ts | pending | |
| src/tests/dreaming-learnings.test.ts | pending | |
| src/tests/dreaming-owners.test.ts | pending | |
| src/tests/dreaming-preimage-scrub.test.ts | pending | |
| src/tests/dsh-adapter.test.ts | pending | |
| src/tests/dsh-usage.test.ts | pending | |
| src/tests/e2b-dispatch.test.ts | pending | |
| src/tests/e2b-stack-wizard.test.tsx | pending | |
| src/tests/e2e-claude-transport.test.ts | pending | |
| src/tests/e2e-codex-auth-chain.test.ts | test audit complete, production partial | C21: retained boundaries and remaining candidates recorded above |
| src/tests/e2e-coverage-contract.test.ts | pending | |
| src/tests/e2e-diff-coverage.test.ts | pending | |
| src/tests/e2e-nightly-report.test.ts | pending | |
| src/tests/e2e-redact.test.ts | pending | |
| src/tests/e2e-rerun-quarantine.test.ts | pending | |
| src/tests/e2e-runtime-pools.test.ts | pending | |
| src/tests/e2e-shards.test.ts | pending | |
| src/tests/e2e-tracker-ingest.test.ts | pending | |
| src/tests/e2e-visuals-comment.test.ts | pending | |
| src/tests/e2e-visuals-stage.test.ts | pending | |
| src/tests/e2e-visuals-verify-pr.test.ts | pending | |
| src/tests/egress-guard.test.ts | pending | |
| src/tests/empty-output-schema.test.ts | pending | |
| src/tests/enabled-tools.test.ts | landed | C12: PR #3285, two repeated registrations removed |
| src/tests/ensure-token.test.ts | pending | |
| src/tests/entrypoint-api-readiness.test.ts | pending | |
| src/tests/entrypoint-chown-no-follow.test.ts | audited, retained | C06. GNU tooling verified. Linux container boundary pending. |
| src/tests/entrypoint-codex-oauth-seed.test.ts | test audit complete, production partial | C21: retained boundaries and remaining candidates recorded above |
| src/tests/entrypoint-config-env-export.test.ts | pending | |
| src/tests/entrypoint-export-to-env.test.ts | pending | |
| src/tests/entrypoint-github-enterprise.test.ts | pending | |
| src/tests/entrypoint-gitlab-credential-helper.test.ts | pending | |
| src/tests/entrypoint-repo-autoclone-args.test.ts | pending | |
| src/tests/entrypoint-repo-clone-target.test.ts | audited, retained | C06. GNU tooling verified. Linux container boundary pending. |
| src/tests/env-flag.test.ts | pending | |
| src/tests/error-tracker.test.ts | pending | |
| src/tests/event-loop-lag.test.ts | pending | |
| src/tests/events-db.test.ts | pending | |
| src/tests/events-http.test.ts | pending | |
| src/tests/events-scrub.test.ts | pending | |
| src/tests/explicit-model-validation.test.ts | pending | |
| src/tests/extension-agent-visibility.test.ts | pending | |
| src/tests/extensions-assets.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-catalog.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-db.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-dispatcher.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-comms-adherence-gate.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-deploy-awareness.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-heartbeat-remediate.test.ts | removed | C19: PR #3273, stronger heartbeat and pre-task guards retained |
| src/tests/extensions-example-no-exclamation-marks.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-rewrite-and-suppress.test.ts | removed | C19: PR #3273, stronger heartbeat and pre-task guards retained |
| src/tests/extensions-example-route-chat-channel.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-route-slack-channel.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-slack-reply-gate.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-sql-admin-only.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-example-task-digest.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-heartbeat.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-http.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-lifecycle.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-loader.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-manifest-format.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-mcp-tools.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-post-bridge.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-pre-task.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-run-context.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-steering.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-tool-call.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/extensions-validate.test.ts | static audit complete | C19: controls and cleanup pending |
| src/tests/favorites-agent-fs-path.test.ts | pending | |
| src/tests/favorites.test.ts | pending | |
| src/tests/fetch-resolved-env.test.ts | pending | |
| src/tests/file-lock.test.ts | pending | |
| src/tests/fleet-benchmark.test.ts | pending | |
| src/tests/follow-up-config-inheritance.test.ts | pending | |
| src/tests/follow-up-gate-shadow.test.ts | pending | |
| src/tests/follow-up-redelivery-guard.test.ts | pending | |
| src/tests/fs-provider.test.ts | pending | |
| src/tests/fs-routes.test.ts | pending | |
| src/tests/fx-adapter.test.ts | pending | |
| src/tests/generate-default-claude-md.test.ts | pending | |
| src/tests/generate-identity-templates.test.ts | pending | |
| src/tests/generate-mcp-docs.test.ts | pending | |
| src/tests/github-app-worker-auth-helper.test.ts | pending | |
| src/tests/github-event-filter.test.ts | pending | |
| src/tests/github-ghes-mock.test.ts | pending | |
| src/tests/github-handlers-cancel-config.test.ts | pending | |
| src/tests/github-handlers-inline-comments.test.ts | pending | |
| src/tests/github-handlers-reactions.test.ts | pending | |
| src/tests/github-handlers.test.ts | pending | |
| src/tests/github-host.test.ts | pending | |
| src/tests/github-installation-token-route.test.ts | pending | |
| src/tests/github-reactions.test.ts | pending | |
| src/tests/github-sender-trust.test.ts | pending | |
| src/tests/github-webhook-early-ack.test.ts | pending | |
| src/tests/gitlab-auth.test.ts | pending | |
| src/tests/gitlab-handlers.test.ts | pending | |
| src/tests/gitlab-vcs-db.test.ts | pending | |
| src/tests/gitlab-workflow-event-names.test.ts | pending | |
| src/tests/gitleaks-download-retry.test.ts | pending | |
| src/tests/grok-adapter.test.ts | pending | |
| src/tests/hang-watchdog.test.ts | pending | |
| src/tests/harness-cli-version.test.ts | pending | |
| src/tests/harness-model-guard.test.ts | pending | |
| src/tests/harness-model-support.test.ts | pending | |
| src/tests/harness-provider-resolution.test.ts | pending | |
| src/tests/harness-version.test.ts | pending | |
| src/tests/heartbeat-checklist-config.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-checklist.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-expiry.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-jev-gate-credentials.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-jev-gate.test.ts | landed | C24 PR #3294: +9/-241, 33 cases, four controls, identical scoped source coverage |
| src/tests/heartbeat-orphan-resume.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-reboot-live.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-reroute-decision.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-script-runner-probe.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-stall-cas.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-stall-thresholds.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat-supersede-resume.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/heartbeat.test.ts | static audit complete | C24: candidates and risks recorded, runtime controls pending |
| src/tests/helper-credentials.test.ts | pending | |
| src/tests/hook-mcp-config.test.ts | pending | |
| src/tests/hook-ping-me-order.test.ts | pending | |
| src/tests/hook-registration-nudge.test.ts | pending | |
| src/tests/hook-runtime-close.test.ts | pending | |
| src/tests/http-api-integration.test.ts | pending | |
| src/tests/http-error-body-scrub.test.ts | pending | |
| src/tests/http-task-write-ownership.test.ts | pending | |
| src/tests/http-users.test.ts | pending | |
| src/tests/http/context-routes.test.ts | pending | |
| src/tests/human-free-flag.test.ts | pending | |
| src/tests/human-free-reclassify.test.ts | pending | |
| src/tests/human-thread-routing.test.ts | pending | |
| src/tests/identity-field-budget.test.ts | pending | |
| src/tests/identity-refresh.test.ts | pending | |
| src/tests/import-config.test.ts | pending | |
| src/tests/import.test.ts | pending | |
| src/tests/improvements-payload.test.ts | pending | |
| src/tests/improvements-route.test.ts | pending | |
| src/tests/install-sh-bind.test.ts | pending | |
| src/tests/install-sh-setup-url.test.ts | pending | |
| src/tests/install-sh-tunnel.test.ts | pending | |
| src/tests/integration-disable-flags.test.ts | pending | |
| src/tests/integrations-http.test.ts | pending | |
| src/tests/internal-ai/complete-structured.test.ts | pending | |
| src/tests/internal-ai/credentials.test.ts | pending | |
| src/tests/internal-ai/schema-parity.test.ts | pending | |
| src/tests/internal-ai/summarize-session.test.ts | pending | |
| src/tests/internal-ai/task-title.test.ts | pending | |
| src/tests/invites-http.test.ts | pending | |
| src/tests/jira-adf.test.ts | pending | |
| src/tests/jira-metadata.test.ts | pending | |
| src/tests/jira-oauth.test.ts | pending | |
| src/tests/jira-outbound-sync.test.ts | pending | |
| src/tests/jira-sync.test.ts | pending | |
| src/tests/jira-webhook-lifecycle.test.ts | pending | |
| src/tests/jira-webhook.test.ts | pending | |
| src/tests/k8s-pool-smoke.test.ts | pending | |
| src/tests/kapso-client.test.ts | pending | |
| src/tests/kapso-inbound.test.ts | pending | |
| src/tests/key-bootstrap.test.ts | pending | |
| src/tests/key-usage-selection.test.ts | pending | |
| src/tests/key-window-usage.test.ts | pending | |
| src/tests/kv-http.test.ts | pending | |
| src/tests/kv-namespace-resolution.test.ts | pending | |
| src/tests/kv-page-proxy.test.ts | pending | |
| src/tests/kv-storage.test.ts | pending | |
| src/tests/kv-tool.test.ts | pending | |
| src/tests/kv-view.test.ts | pending | |
| src/tests/latest-model-report.test.ts | pending | |
| src/tests/linear-outbound-sync.test.ts | pending | |
| src/tests/linear-sync-identity.test.ts | pending | |
| src/tests/linear-webhook.test.ts | pending | |
| src/tests/list-endpoint-slimming.test.ts | pending | |
| src/tests/list-search-params.test.ts | pending | |
| src/tests/literal-matcher.test.ts | pending | |
| src/tests/mcp-input-caps.test.ts | pending | |
| src/tests/mcp-input-ergonomics.test.ts | pending | |
| src/tests/mcp-loopback-proxy.test.ts | pending | |
| src/tests/mcp-oauth-dcr-reuse.test.ts | pending | |
| src/tests/mcp-oauth-ensure-token.test.ts | pending | |
| src/tests/mcp-oauth-manual-client.test.ts | pending | |
| src/tests/mcp-oauth-queries.test.ts | pending | |
| src/tests/mcp-oauth-resolve-secrets.test.ts | pending | |
| src/tests/mcp-oauth-wrapper.test.ts | pending | |
| src/tests/mcp-outbound-fetch-guard.test.ts | pending | |
| src/tests/mcp-overflow-sweep.test.ts | pending | |
| src/tests/mcp-server-codex-oauth-env.test.ts | test audit complete, production partial | C21: retained boundaries and remaining candidates recorded above |
| src/tests/mcp-server-resolved-env.test.ts | pending | |
| src/tests/mcp-server-ssrf.test.ts | pending | |
| src/tests/mcp-server-stdio-gate.test.ts | pending | |
| src/tests/mcp-tools-user.test.ts | pending | |
| src/tests/mcp-tools.test.ts | pending | |
| src/tests/mcp-transport-gc.test.ts | pending | |
| src/tests/mcp-user-events.test.ts | pending | |
| src/tests/mcp-user-route.test.ts | pending | |
| src/tests/memory-chunked-search-starvation.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-e2e.test.ts | landed | C17: PR #3276, storage consolidation and repaired guards |
| src/tests/memory-edges.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-edit-authorization.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-edit.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-embedding-input-cap.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-embedding-recovery.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-embedding-space.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-fts-populate.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-graph-expansion.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-graph-organic-route.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-http-recall-gating.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-hybrid.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-injection-outcome.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-key-paths.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-keys-endpoint.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-link-resolver.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-prompt-recall-crowdout.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rate-endpoint.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rate-tool.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rater-defaults.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rater-e2e.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rater-implicit-citation.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rater-llm-summarizer.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-rater-llm.test.ts | landed | C27 #3313; copied predicates removed, corrected controls and scoped coverage pass |
| src/tests/memory-rater-store.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-reranker.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-review-recall-filter.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-search-reader.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-search-stall.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-store-tool.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory-store.test.ts | landed | C17: PR #3276, storage consolidation and repaired guards |
| src/tests/memory-usefulness-endpoint.test.ts | static audit complete | C17: implementation and controls pending |
| src/tests/memory.test.ts | landed | C17: PR #3276, storage consolidation and repaired guards |
| src/tests/merge-gate-detect-changes.test.ts | pending | |
| src/tests/metrics-http.test.ts | pending | |
| src/tests/migration-046-budgets.test.ts | pending | |
| src/tests/migration-063-schema-relax.test.ts | pending | |
| src/tests/migration-206-runtime-pools.test.ts | pending | |
| src/tests/migration-207-runtime-session-tokens.test.ts | pending | |
| src/tests/migration-208-task-runtime-dispatch.test.ts | pending | |
| src/tests/migration-217-chat-sdk-state.test.ts | pending | |
| src/tests/migration-232-agent-session-tokens.test.ts | pending | |
| src/tests/migration-237-session-inbox-cleanup.test.ts | pending | |
| src/tests/migration-240-workflow-run-parent-step-attempt.test.ts | pending | |
| src/tests/migration-260-runtime-pool-cache.test.ts | pending | |
| src/tests/migration-283-workflow-run-definitions.test.ts | pending | |
| src/tests/migration-318-superseded-workflow-cut-backfill.test.ts | pending | |
| src/tests/migration-322-runtime-pool-workspace.test.ts | pending | |
| src/tests/migration-329-workflow-run-retention.test.ts | pending | |
| src/tests/migration-342-script-run-sources.test.ts | pending | |
| src/tests/migration-bunfs-compat.test.ts | pending | |
| src/tests/migration-failure.test.ts | pending | |
| src/tests/migration-runner-regressions.test.ts | pending | |
| src/tests/model-catalog-migration.test.ts | pending | |
| src/tests/model-catalog-table.test.ts | pending | |
| src/tests/model-catalog-write-access.test.ts | pending | |
| src/tests/model-control.test.ts | pending | |
| src/tests/model-groups-api.test.ts | pending | |
| src/tests/model-groups-live-catalog.test.ts | pending | |
| src/tests/model-profile-backcompat.test.ts | pending | |
| src/tests/model-profile-check.test.ts | pending | |
| src/tests/model-profile-fallbacks.test.ts | pending | |
| src/tests/model-profile-providers.test.ts | pending | |
| src/tests/model-profile-runtime-secrets.test.ts | pending | |
| src/tests/model-profiles-api.test.ts | pending | |
| src/tests/model-rate-limit-windows.test.ts | pending | |
| src/tests/model-tier-resolution.test.ts | pending | |
| src/tests/models-catalog.test.ts | pending | |
| src/tests/multi-runtime-registration.test.ts | pending | |
| src/tests/native-tool-hooks.test.ts | pending | |
| src/tests/node-env-runtime.test.ts | pending | |
| src/tests/oauth-access-token-tool.test.ts | pending | |
| src/tests/oauth-callback-flow.test.ts | pending | |
| src/tests/oauth-connection-fetch-guard.test.ts | pending | |
| src/tests/oauth-credential-bindings.test.ts | pending | |
| src/tests/oauth-keepalive.test.ts | pending | |
| src/tests/oauth-presets.test.ts | pending | |
| src/tests/oauth-refresh-failure.test.ts | pending | |
| src/tests/oauth-refresh-sweep.test.ts | pending | |
| src/tests/oauth-token-endpoint-fetch-guard.test.ts | pending | |
| src/tests/oauth-wrapper.test.ts | pending | |
| src/tests/onboard-compose.test.ts | pending | |
| src/tests/onboard-container-engine.test.ts | pending | |
| src/tests/onboard-dashboard-output.test.ts | pending | |
| src/tests/onboard-dashboard-url.test.ts | pending | |
| src/tests/onboard-env.test.ts | pending | |
| src/tests/onboard-manifest.test.ts | pending | |
| src/tests/onboard-non-interactive.test.ts | pending | |
| src/tests/onboard-tei-image.test.ts | pending | |
| src/tests/onboarding.test.ts | pending | |
| src/tests/openai-compatible-providers.test.ts | pending | |
| src/tests/openai-compatible-registry-extension.test.ts | pending | |
| src/tests/openai-embedding-credentials.test.ts | pending | |
| src/tests/openapi-response-contract.test.ts | pending | |
| src/tests/openapi-route-headers.test.ts | pending | |
| src/tests/opencode-adapter.test.ts | pending | |
| src/tests/opencode-billing.test.ts | pending | |
| src/tests/opencode-helmcode-sdk.test.ts | pending | |
| src/tests/opencode-mcp-admission-sdk.test.ts | pending | |
| src/tests/opencode-shell-env.test.ts | pending | |
| src/tests/opencode-swarm-plugin.test.ts | pending | |
| src/tests/openrouter-attribution-call-sites.test.ts | pending | |
| src/tests/openrouter-base-url.test.ts | pending | |
| src/tests/operator-granted-credentials.test.ts | pending | |
| src/tests/operator-granted-role-wire.test.ts | pending | |
| src/tests/opus-5-5-registry.test.ts | pending | |
| src/tests/org-website.test.ts | audited, retained | C11. All 39 tests passed. Distinct config and telemetry contracts retained. |
| src/tests/otel-abort-span.test.ts | pending | |
| src/tests/otel-env.test.ts | pending | |
| src/tests/otel-event-loop-and-logs.test.ts | audited, retained | C16: interval reset and log export boundaries |
| src/tests/otel-impl-secret-scrubbing.test.ts | audited, retained | C16: metric and span redaction |
| src/tests/otel-service-name.test.ts | landed | C16: PR #3275, configured-name duplication removed |
| src/tests/otel-session-cost-metrics.test.ts | landed | C16: PR #3275, fake facade assertion removed |
| src/tests/otel-span-kind.test.ts | audited, retained | C16: explicit server and default kinds |
| src/tests/outbound-listener-rejection.test.ts | pending | |
| src/tests/output-schema-inheritance.test.ts | pending | |
| src/tests/package-publish.test.ts | pending | |
| src/tests/page-guest-session.test.ts | pending | |
| src/tests/page-proxy-authed.test.ts | pending | |
| src/tests/page-proxy.test.ts | pending | |
| src/tests/page-session-dev-cookie.test.ts | pending | |
| src/tests/page-session.test.ts | pending | |
| src/tests/page-viewer-auth.test.ts | pending | |
| src/tests/pages-authed-mode.test.ts | pending | |
| src/tests/pages-complete-fetch.test.ts | pending | |
| src/tests/pages-feedback.test.ts | pending | |
| src/tests/pages-head-v2.test.ts | pending | |
| src/tests/pages-http.test.ts | pending | |
| src/tests/pages-password-hash.test.ts | pending | |
| src/tests/pages-storage.test.ts | pending | |
| src/tests/pages-svg-migration.test.ts | pending | |
| src/tests/pages-versioning.test.ts | pending | |
| src/tests/pagination-metrics.test.ts | pending | |
| src/tests/paused-tasks-requested-by.test.ts | pending | |
| src/tests/pi-codemode.test.ts | pending | |
| src/tests/pi-context-compaction.test.ts | pending | |
| src/tests/pi-custom-provider-fake-server.test.ts | pending | |
| src/tests/pi-mono-adapter.test.ts | pending | |
| src/tests/pi-mono-extension.test.ts | pending | |
| src/tests/pi-mono-session-cost-on-abort.test.ts | pending | |
| src/tests/pi-native-mcp.test.ts | pending | |
| src/tests/pi-provider-runtime-keys.test.ts | pending | |
| src/tests/pi-shell-env.test.ts | pending | |
| src/tests/pi-tool-exposure.test.ts | pending | |
| src/tests/poll-probe-readonly.test.ts | pending | |
| src/tests/pool-affinity.test.ts | pending | |
| src/tests/pool-session-logs.test.ts | audited and tested | C07. Idempotency consolidated, isolation and late arrivals retained. PR #3259. |
| src/tests/pr-body-leaks.test.ts | pending | |
| src/tests/pr-room-guard.test.ts | pending | |
| src/tests/pre-push-affected-tests.test.ts | audited, retained | New main file: production-first review, four cases and 39 assertions pass, no justified deletion |
| src/tests/preload-env.test.ts | pending | |
| src/tests/pricing-refresh.test.ts | pending | |
| src/tests/pricing-routes.test.ts | pending | |
| src/tests/primitives-boards.test.ts | pending | |
| src/tests/primitives-object-webhooks.test.ts | pending | |
| src/tests/primitives-objects.test.ts | pending | |
| src/tests/primitives-sheets-xlsx.test.ts | pending | |
| src/tests/probe-tool-schema-tokens.test.ts | pending | |
| src/tests/profile-claim.test.ts | pending | |
| src/tests/profile-default-refresh.test.ts | pending | |
| src/tests/profile-sync-stale-writeback.test.ts | pending | |
| src/tests/profile-sync-warning.test.ts | pending | |
| src/tests/profile-sync.test.ts | pending | |
| src/tests/profile-tier-alias.test.ts | pending | |
| src/tests/progress-dedup.test.ts | pending | |
| src/tests/promote-draft-task-route.test.ts | pending | |
| src/tests/prompt-template-github.test.ts | pending | |
| src/tests/prompt-template-remaining.test.ts | pending | |
| src/tests/prompt-template-resolver.test.ts | pending | |
| src/tests/prompt-template-session.test.ts | pending | |
| src/tests/provider-adapter.test.ts | pending | |
| src/tests/provider-command-format.test.ts | pending | |
| src/tests/provider-error-class.test.ts | pending | |
| src/tests/provider-key-probes.test.ts | pending | |
| src/tests/provider-process-group.test.ts | pending | |
| src/tests/provider-quota-persistence.test.ts | pending | |
| src/tests/provider-registration.test.ts | pending | |
| src/tests/provider-runtime-dependencies.test.ts | pending | |
| src/tests/provider-steering-capabilities.test.ts | pending | |
| src/tests/providers/codex-cost.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/providers/pi-cost.test.ts | pending | |
| src/tests/query-audit-plans.test.ts | pending | |
| src/tests/queue-stall-alarm.test.ts | pending | |
| src/tests/quickjs-compat.test.ts | pending | |
| src/tests/ranking-listing.test.ts | pending | |
| src/tests/ranking-route.test.ts | pending | |
| src/tests/ranking-usage.test.ts | pending | |
| src/tests/rate-limit-event.test.ts | pending | |
| src/tests/rate-limit-outcome.test.ts | pending | |
| src/tests/rbac-admission-e2e.test.ts | pending | |
| src/tests/rbac-admission.test.ts | pending | |
| src/tests/rbac-audit.test.ts | pending | |
| src/tests/rbac-charact-http.test.ts | pending | |
| src/tests/rbac-charact-misc-tools.test.ts | pending | |
| src/tests/rbac-charact-skills.test.ts | pending | |
| src/tests/rbac-charact-slack.test.ts | pending | |
| src/tests/rbac-e2e-helpers.test.ts | pending | |
| src/tests/rbac-lifecycle-e2e.test.ts | pending | |
| src/tests/rbac-mcp-admission-e2e.test.ts | pending | |
| src/tests/rbac-roles.test.ts | pending | |
| src/tests/rbac-wire-e2e.test.ts | pending | |
| src/tests/realtime-room-auth.test.ts | pending | |
| src/tests/realtime-room-surfaces.test.ts | pending | |
| src/tests/realtime-rooms.test.ts | pending | |
| src/tests/realtime-session-join-race.test.ts | pending | |
| src/tests/realtime-tickets.test.ts | pending | |
| src/tests/realtime-transport.test.ts | pending | |
| src/tests/reasoning-effort.test.ts | pending | |
| src/tests/reasoning-events.test.ts | pending | |
| src/tests/reasoning-kind-ui-parity.test.ts | pending | |
| src/tests/redacted.test.ts | pending | |
| src/tests/refresh-modelsdev-carryforward.test.ts | pending | |
| src/tests/reload-config.test.ts | pending | |
| src/tests/request-composition-derive.test.ts | pending | |
| src/tests/request-composition.test.ts | pending | |
| src/tests/requester-comms.test.ts | pending | |
| src/tests/rest-api.test.ts | pending | |
| src/tests/resume-session.test.ts | pending | |
| src/tests/routing-affinity-inventory.test.ts | pending | |
| src/tests/routing-decision-persistence.test.ts | pending | |
| src/tests/routing-reason-contract.test.ts | pending | |
| src/tests/routing-reason-inventory.test.ts | pending | |
| src/tests/routing-source.test.ts | pending | |
| src/tests/run-bun-tests.test.ts | pending | |
| src/tests/run-root-coverage.test.ts | pending | |
| src/tests/run-server-raters.test.ts | pending | |
| src/tests/runner-agent-fs-provision-retry.test.ts | pending | |
| src/tests/runner-api-drain.test.ts | audited and tested | C02. Final review and landing pending. |
| src/tests/runner-attachments-section.test.ts | pending | |
| src/tests/runner-bitbucket-vcs.test.ts | pending | |
| src/tests/runner-budget-refused.test.ts | pending | |
| src/tests/runner-context-preamble.test.ts | pending | |
| src/tests/runner-context-usage.test.ts | pending | |
| src/tests/runner-deployment-resume.test.ts | pending | |
| src/tests/runner-exit-after-tasks.test.ts | pending | |
| src/tests/runner-fallback-output.test.ts | pending | |
| src/tests/runner-fenced-json-output.test.ts | pending | |
| src/tests/runner-finish-retry.test.ts | pending | |
| src/tests/runner-harness-telemetry-env.test.ts | pending | |
| src/tests/runner-identity-refresh.test.ts | pending | |
| src/tests/runner-key-completion-outcome.test.ts | pending | |
| src/tests/runner-key-outcome-late-reset.test.ts | pending | |
| src/tests/runner-legacy-options.test.ts | pending | |
| src/tests/runner-legacy-resume-prompt.test.ts | pending | |
| src/tests/runner-max-concurrent.test.ts | pending | |
| src/tests/runner-missing-dependency.test.ts | pending | |
| src/tests/runner-polling-api.test.ts | pending | |
| src/tests/runner-profile-backup.test.ts | pending | |
| src/tests/runner-provider-fallback.test.ts | pending | |
| src/tests/runner-push-delivery.test.ts | pending | |
| src/tests/runner-registration-retry.test.ts | pending | |
| src/tests/runner-repo-autostash.test.ts | pending | |
| src/tests/runner-report-rate-limit-windows.test.ts | pending | |
| src/tests/runner-requester-profile.test.ts | pending | |
| src/tests/runner-session-outcome.test.ts | pending | |
| src/tests/runner-skills-refresh.test.ts | pending | |
| src/tests/runner-slot-reconcile.test.ts | pending | |
| src/tests/runner-task-start-reads.test.ts | pending | |
| src/tests/runner-terminal-window-report.test.ts | pending | |
| src/tests/runner-tool-spans.test.ts | pending | |
| src/tests/runtime-cache-cleanup.test.ts | pending | |
| src/tests/runtime-child-token-cleanup.test.ts | pending | |
| src/tests/runtime-controller-liveness.test.ts | pending | |
| src/tests/runtime-controller-token.test.ts | pending | |
| src/tests/runtime-demand.test.ts | pending | |
| src/tests/runtime-e2b-pools.test.ts | pending | |
| src/tests/runtime-k8s-pools.test.ts | pending | |
| src/tests/runtime-model-catalog.test.ts | pending | |
| src/tests/runtime-pool-reachability.test.ts | pending | |
| src/tests/runtime-pool-routing.test.ts | pending | |
| src/tests/runtime-pools-db.test.ts | pending | |
| src/tests/runtime-pools-http.test.ts | pending | |
| src/tests/runtime-pools-ownership-guards.test.ts | pending | |
| src/tests/runtime-pools-seed.test.ts | pending | |
| src/tests/runtime-provider-registration.test.ts | pending | |
| src/tests/runtime-providers-boxd.test.ts | pending | |
| src/tests/runtime-providers-docker.test.ts | pending | |
| src/tests/runtime-providers-e2b-transport.test.ts | pending | |
| src/tests/runtime-providers-e2b.test.ts | pending | |
| src/tests/runtime-providers-k8s.test.ts | pending | |
| src/tests/runtime-recovery.test.ts | pending | |
| src/tests/runtime-remote-controller.test.ts | pending | |
| src/tests/runtime-supervisor-failures.test.ts | pending | |
| src/tests/runtime-supervisor.test.ts | pending | |
| src/tests/runtime-token-auth.test.ts | pending | |
| src/tests/sandboxed-process.test.ts | landed | C15: PR #3269, startup isolation in both modes |
| src/tests/savings-calibration-api.test.ts | pending | |
| src/tests/savings-calibration.test.ts | pending | |
| src/tests/savings-compound.test.ts | pending | |
| src/tests/savings-compute.test.ts | pending | |
| src/tests/savings-fleet-latency.test.ts | pending | |
| src/tests/savings-fleet-read.test.ts | pending | |
| src/tests/savings-fleet-scale.test.ts | pending | |
| src/tests/savings-fleet-slices.test.ts | pending | |
| src/tests/savings-model.test.ts | pending | |
| src/tests/savings-read.test.ts | pending | |
| src/tests/savings-rollup.test.ts | pending | |
| src/tests/savings-scripts.test.ts | pending | |
| src/tests/schedule-http-triage-tools.test.ts | landed | C29 #3323: inclusive minimum, exclusion above the fixture count, and independent status forwarding. |
| src/tests/schedule-profile.test.ts | test audit complete, production partial | C29: direct contracts inspected; transitive limits and candidate controls recorded |
| src/tests/schedule-target-type.test.ts | test audit complete, production partial | C29: direct contracts inspected; transitive limits and candidate controls recorded |
| src/tests/scheduled-task-required-params-migration.test.ts | test audit complete, production partial | C29: direct contracts inspected; transitive limits and candidate controls recorded |
| src/tests/scheduled-tasks.test.ts | landed | C29 #3318 retains target-only routing. #3323 tests enabled membership, status, and the inclusive error threshold. |
| src/tests/scheduler-occurrence.test.ts | test audit complete, production partial | C29: direct contracts inspected; transitive limits and candidate controls recorded |
| src/tests/script-api-credential.test.ts | pending | |
| src/tests/script-apis-mcp.test.ts | pending | |
| src/tests/script-connections-http.test.ts | pending | |
| src/tests/script-connections-mcp.test.ts | pending | |
| src/tests/script-connections-sql.test.ts | pending | |
| src/tests/script-connections.test.ts | pending | |
| src/tests/script-executor-conformance.test.ts | landed | C08 PR #3291: real executors retained, fabricated cases removed, distinct classifier inputs retained |
| src/tests/script-executor-quickjs-pool.test.ts | landed | C09: PR #3266, readiness and full-run peak |
| src/tests/script-executor-quickjs.test.ts | pending | |
| src/tests/script-executor-registry.test.ts | pending | |
| src/tests/script-host-validated-args-native.test.ts | pending | |
| src/tests/script-native-sandbox-identity.test.ts | pending | |
| src/tests/script-native-startup.test.ts | landed | C08 PR #3291: duplicate classifier removed, budgets derived from executor limits |
| src/tests/script-native-unawaited-drain.test.ts | pending | |
| src/tests/script-per-script-executor.test.ts | pending | |
| src/tests/script-run-config-scope.test.ts | pending | |
| src/tests/script-runs-http.test.ts | pending | |
| src/tests/script-runs-retention.test.ts | pending | |
| src/tests/script-runs-scrub.test.ts | pending | |
| src/tests/script-workflow-capability-bridge.test.ts | pending | |
| src/tests/script-workflows-label-lint.test.ts | pending | |
| src/tests/script-workflows-runtime-e2e.test.ts | pending | |
| src/tests/scripts-boot-args-schema.test.ts | pending | |
| src/tests/scripts-boot-reembed.test.ts | pending | |
| src/tests/scripts-db.test.ts | pending | |
| src/tests/scripts-embeddings.test.ts | pending | |
| src/tests/scripts-external-api.test.ts | pending | |
| src/tests/scripts-fs.test.ts | pending | |
| src/tests/scripts-http.test.ts | pending | |
| src/tests/scripts-import-allowlist.test.ts | pending | |
| src/tests/scripts-mcp-e2e.test.ts | pending | |
| src/tests/scripts-namespaces.test.ts | pending | |
| src/tests/scripts-only-gating.test.ts | pending | |
| src/tests/scripts-retention.test.ts | pending | |
| src/tests/scripts-runtime-fetch.test.ts | pending | |
| src/tests/scripts-runtime-identity.test.ts | pending | |
| src/tests/scripts-runtime-secret-egress.test.ts | pending | |
| src/tests/scripts-runtime.test.ts | pending | |
| src/tests/scripts-typecheck.test.ts | pending | |
| src/tests/scrubbed-text-12e.test.ts | pending | |
| src/tests/sdk-allowlist.test.ts | pending | |
| src/tests/sdk-store-progress-skipped.test.ts | pending | |
| src/tests/sealed-key-guard.test.ts | pending | |
| src/tests/seat-mismatch-report.test.ts | pending | |
| src/tests/secret-canary-sweep.test.ts | pending | |
| src/tests/secret-registry.test.ts | pending | |
| src/tests/secret-rules.test.ts | pending | |
| src/tests/secret-scrub-gate.test.ts | pending | |
| src/tests/secret-scrubber-convex.test.ts | pending | |
| src/tests/secret-scrubber.test.ts | pending | |
| src/tests/secrets-cipher.test.ts | pending | |
| src/tests/seed-capabilities.test.ts | pending | |
| src/tests/seed-model-profiles.test.ts | pending | |
| src/tests/seed-registry.test.ts | pending | |
| src/tests/seed-schedules.test.ts | pending | |
| src/tests/seed-scripts.test.ts | pending | |
| src/tests/seed-skills-bundled-files.test.ts | pending | |
| src/tests/seed-skills-retire.test.ts | pending | |
| src/tests/seed-workflows.test.ts | pending | |
| src/tests/seed.test.ts | pending | |
| src/tests/seeded-swarm-telemetry-env.test.ts | pending | |
| src/tests/self-improvement.test.ts | pending | |
| src/tests/send-task-dispatched-by.test.ts | pending | |
| src/tests/send-task-output-schema.test.ts | pending | |
| src/tests/send-task-requested-by.test.ts | pending | |
| src/tests/send-task-requester-gate.test.ts | pending | |
| src/tests/send-task-self-send.test.ts | pending | |
| src/tests/send-task-slack-routing-guard.test.ts | pending | |
| src/tests/session-activity-liveness.test.ts | pending | |
| src/tests/session-attach.test.ts | pending | |
| src/tests/session-cost-attribution.test.ts | pending | |
| src/tests/session-cost-recompute-unit.test.ts | pending | |
| src/tests/session-costs-codex-recompute.test.ts | static audit complete | C21: retained boundaries and remaining candidates recorded above |
| src/tests/session-costs-golden.test.ts | pending | |
| src/tests/session-costs-model-key-normalize.test.ts | pending | |
| src/tests/session-costs-recompute-all-providers.test.ts | pending | |
| src/tests/session-costs.test.ts | pending | |
| src/tests/session-dispatched-tasks.test.ts | pending | |
| src/tests/session-logs.test.ts | audited and tested | C07. Seven DB bodies retained. HTTP cases now use the real scenario. PR #3259. |
| src/tests/session-route-posture.test.ts | pending | |
| src/tests/session-sharing-routes.test.ts | pending | |
| src/tests/session-sharing.test.ts | pending | |
| src/tests/session-source-backfill.test.ts | pending | |
| src/tests/session-source-keys.test.ts | pending | |
| src/tests/session-source-labels.test.ts | pending | |
| src/tests/session-summaries-plans.test.ts | pending | |
| src/tests/session-summaries.test.ts | pending | |
| src/tests/session-tokens.test.ts | pending | |
| src/tests/sessions-detail-batch.test.ts | pending | |
| src/tests/sessions-move.test.ts | pending | |
| src/tests/sessions-tree.test.ts | pending | |
| src/tests/sessions.test.ts | pending | |
| src/tests/sheet-engine.test.ts | pending | |
| src/tests/shutdown-error-scrubbing.test.ts | pending | |
| src/tests/sibling-awareness-db.test.ts | pending | |
| src/tests/sibling-block.test.ts | pending | |
| src/tests/skill-files.test.ts | pending | |
| src/tests/skill-fs-writer.test.ts | pending | |
| src/tests/skill-get-name-resolution.test.ts | pending | |
| src/tests/skill-invocations.test.ts | pending | |
| src/tests/skill-invoke.test.ts | pending | |
| src/tests/skill-parser.test.ts | pending | |
| src/tests/skill-search-long-content.test.ts | pending | |
| src/tests/skill-search.test.ts | pending | |
| src/tests/skill-sync.test.ts | pending | |
| src/tests/skill-usage-cohorts.test.ts | pending | |
| src/tests/skill-usage.test.ts | pending | |
| src/tests/skills-signature.test.ts | pending | |
| src/tests/slack-actions.test.ts | pending | |
| src/tests/slack-assistant-comention-production.test.ts | pending | |
| src/tests/slack-assistant.test.ts | pending | |
| src/tests/slack-attachments-block.test.ts | pending | |
| src/tests/slack-blocks.test.ts | pending | |
| src/tests/slack-bot-filter.test.ts | pending | |
| src/tests/slack-caption-block.test.ts | pending | |
| src/tests/slack-channel-join.test.ts | pending | |
| src/tests/slack-channel-lifecycle.test.ts | pending | |
| src/tests/slack-closure.test.ts | pending | |
| src/tests/slack-config.test.ts | pending | |
| src/tests/slack-dm-implicit-mention.test.ts | pending | |
| src/tests/slack-egress-scrub.test.ts | pending | |
| src/tests/slack-empty-icon-config.test.ts | pending | |
| src/tests/slack-external-channel-config.test.ts | pending | |
| src/tests/slack-external-channel-egress.test.ts | pending | |
| src/tests/slack-external-channel-guard.test.ts | pending | |
| src/tests/slack-external-channel-tools.test.ts | pending | |
| src/tests/slack-external-channel.test.ts | pending | |
| src/tests/slack-file-tools-attachments.test.ts | pending | |
| src/tests/slack-http-receiver.test.ts | pending | |
| src/tests/slack-identity-resolution.test.ts | pending | |
| src/tests/slack-inbound-files.test.ts | pending | |
| src/tests/slack-inbound-logging.test.ts | pending | |
| src/tests/slack-inbound-receipts.test.ts | pending | |
| src/tests/slack-inline-output.test.ts | pending | |
| src/tests/slack-leave-thread.test.ts | pending | |
| src/tests/slack-message-text.test.ts | pending | |
| src/tests/slack-metadata-inheritance.test.ts | pending | |
| src/tests/slack-mode-lifecycle.test.ts | pending | |
| src/tests/slack-queue-offline.test.ts | pending | |
| src/tests/slack-reaction-config.test.ts | pending | |
| src/tests/slack-read-boundaries.test.ts | pending | |
| src/tests/slack-relay-obligations.test.ts | pending | |
| src/tests/slack-render-v2-delegation.test.ts | pending | |
| src/tests/slack-render-v2-query-plans.test.ts | pending | |
| src/tests/slack-render-v2-reconcile.test.ts | pending | |
| src/tests/slack-render-v2.test.ts | partial audit, cleanup landed | C10 PR #3274: +5/-148, six controls, remaining sections listed above |
| src/tests/slack-router-require-mention.test.ts | pending | |
| src/tests/slack-router.test.ts | pending | |
| src/tests/slack-routing-guard.test.ts | pending | |
| src/tests/slack-session-status.test.ts | pending | |
| src/tests/slack-skip-reaction.test.ts | pending | |
| src/tests/slack-socket-ack.test.ts | pending | |
| src/tests/slack-socket-watchdog.test.ts | pending | |
| src/tests/slack-start-reload-race.test.ts | pending | |
| src/tests/slack-steering.test.ts | pending | |
| src/tests/slack-thread-buffer-context.test.ts | pending | |
| src/tests/slack-thread-buffer-fold.test.ts | pending | |
| src/tests/slack-thread-buffer-restore.test.ts | pending | |
| src/tests/slack-thread-buffer-startup-restore.test.ts | pending | |
| src/tests/slack-thread-buffer.test.ts | pending | |
| src/tests/slack-thread-followups.test.ts | pending | |
| src/tests/slack-thread-participants.test.ts | pending | |
| src/tests/slack-tool-blocks.test.ts | pending | |
| src/tests/slack-update.test.ts | pending | |
| src/tests/slack-upload-file.test.ts | pending | |
| src/tests/slack-user-dm.test.ts | pending | |
| src/tests/slack-watcher.test.ts | pending | |
| src/tests/slack-workspace-guard.test.ts | pending | |
| src/tests/sonnet-5-5-registry.test.ts | pending | |
| src/tests/spec-base-url.test.ts | pending | |
| src/tests/spend-cap-credentials.test.ts | pending | |
| src/tests/spend-cap-outcome.test.ts | pending | |
| src/tests/star-history-refresh.test.ts | pending | |
| src/tests/status-instance.test.ts | pending | |
| src/tests/status.test.ts | pending | |
| src/tests/steer-task-tool.test.ts | pending | |
| src/tests/steering-core.test.ts | pending | |
| src/tests/steering-delivery.test.ts | pending | |
| src/tests/steering-enabled.test.ts | pending | |
| src/tests/steering-promotion.test.ts | pending | |
| src/tests/steering-transport.test.ts | pending | |
| src/tests/stop-hook-task-resolution.test.ts | pending | |
| src/tests/store-progress-attachments-handler.test.ts | pending | |
| src/tests/store-progress-attachments.test.ts | pending | |
| src/tests/store-progress-blocked-waiting-gate.test.ts | pending | |
| src/tests/store-progress-cost.test.ts | pending | |
| src/tests/store-progress-learning.test.ts | pending | |
| src/tests/store-progress-ownership.test.ts | pending | |
| src/tests/store-progress-skipped.test.ts | pending | |
| src/tests/structured-output.test.ts | pending | |
| src/tests/submit-improvement-tool.test.ts | pending | |
| src/tests/subscription-first.test.ts | pending | |
| src/tests/subscription-plans.test.ts | pending | |
| src/tests/subscription-usage-migration.test.ts | pending | |
| src/tests/successor-steering.test.ts | pending | |
| src/tests/swarm-config-encryption.test.ts | pending | |
| src/tests/swarm-config-export-to-env.test.ts | pending | |
| src/tests/swarm-config-reserved-keys.test.ts | pending | |
| src/tests/swarm-config-schema.test.ts | pending | |
| src/tests/swarm-config.test.ts | pending | |
| src/tests/swarm-repos.test.ts | pending | |
| src/tests/swarm-tool-result-gate.test.ts | pending | |
| src/tests/swarm-x-tool.test.ts | pending | |
| src/tests/sync-ai-toolbox-skills.test.ts | pending | |
| src/tests/system-default-skills.test.ts | pending | |
| src/tests/system-one-decide-session-cost.test.ts | pending | |
| src/tests/system-one-hosts-ui-mirror.test.ts | pending | |
| src/tests/task-artifacts.test.ts | pending | |
| src/tests/task-attachments-schema.test.ts | pending | |
| src/tests/task-audio-transcription.test.ts | pending | |
| src/tests/task-auto-title-config-guard.test.ts | pending | |
| src/tests/task-auto-title-listener.test.ts | pending | |
| src/tests/task-cancellation.test.ts | pending | |
| src/tests/task-cascade-fail.test.ts | pending | |
| src/tests/task-citations.test.ts | pending | |
| src/tests/task-completion-idempotency.test.ts | pending | |
| src/tests/task-completion-memory-chunking.test.ts | pending | |
| src/tests/task-lifecycle-telemetry.test.ts | pending | |
| src/tests/task-lineage.test.ts | pending | |
| src/tests/task-model-effort-rerun.test.ts | pending | |
| src/tests/task-pause-resume.test.ts | pending | |
| src/tests/task-pull-request-backfill-migration.test.ts | pending | |
| src/tests/task-reactions.test.ts | pending | |
| src/tests/task-search-filter.test.ts | pending | |
| src/tests/task-search-fts.test.ts | pending | |
| src/tests/task-session-prompts.test.ts | pending | |
| src/tests/task-start-after-commit.test.ts | pending | |
| src/tests/task-supersede-resume.test.ts | pending | |
| src/tests/task-swarm-version.test.ts | pending | |
| src/tests/task-terminal-secret-scrub.test.ts | pending | |
| src/tests/task-title-route.test.ts | pending | |
| src/tests/task-tool-manifest.test.ts | pending | |
| src/tests/task-tool-preload-mcp.test.ts | pending | |
| src/tests/task-tools-ctx.test.ts | pending | |
| src/tests/task-tools-ownership.test.ts | pending | |
| src/tests/task-ui-action-route.test.ts | pending | |
| src/tests/task-ui-actions.test.ts | pending | |
| src/tests/task-ui-script-actions.test.ts | pending | |
| src/tests/task-ui-spec-fallback.test.ts | pending | |
| src/tests/task-ui-spec.test.ts | pending | |
| src/tests/task-working-dir.test.ts | pending | |
| src/tests/tasks-readable-row.test.ts | pending | |
| src/tests/tasks-requested-by-filter.test.ts | pending | |
| src/tests/tasks-workflow-run-filter.test.ts | pending | |
| src/tests/telemetry-context.test.ts | pending | |
| src/tests/telemetry-enable.test.ts | pending | |
| src/tests/telemetry-endpoint-override.test.ts | pending | |
| src/tests/telemetry-init.test.ts | pending | |
| src/tests/telemetry-snapshot.test.ts | pending | |
| src/tests/telemetry-trigger.test.ts | pending | |
| src/tests/telemetry-ui-route.test.ts | pending | |
| src/tests/template-recommendations.test.ts | pending | |
| src/tests/theme-import.test.ts | pending | |
| src/tests/themes-presets.test.ts | pending | |
| src/tests/tool-call-progress.test.ts | pending | |
| src/tests/tool-hooks-http.test.ts | static audit complete | C19: retain native HTTP scrubbing and origin boundaries |
| src/tests/tool-registrar-no-input.test.ts | pending | |
| src/tests/tracker-fold.test.ts | pending | |
| src/tests/tracker-oauth-authorize-auth.test.ts | pending | |
| src/tests/tracker-tools.test.ts | pending | |
| src/tests/transcription.test.ts | pending | |
| src/tests/trigger-claiming.test.ts | pending | |
| src/tests/ui-e2e-ingest-entrypoint.test.ts | pending | |
| src/tests/ui-e2e-ingest-payload.test.ts | pending | |
| src/tests/ui-e2e-ingest-post.test.ts | pending | |
| src/tests/ui-e2e-publish-plan.test.ts | pending | |
| src/tests/ui-followup-lead-delegation.test.ts | pending | |
| src/tests/ui-list-slim-projections.test.ts | pending | |
| src/tests/ui-logs-parser.test.ts | pending | |
| src/tests/ui-spec-script-actions-config.test.ts | pending | |
| src/tests/ui-swarm-sdk.test.ts | pending | |
| src/tests/unified-oauth-migration.test.ts | pending | |
| src/tests/update-profile-api.test.ts | pending | |
| src/tests/update-profile-auth.test.ts | pending | |
| src/tests/update-schedule-mcp-tool.test.ts | pending | |
| src/tests/usage-cache.test.ts | pending | |
| src/tests/use-dismissible-card.test.ts | pending | |
| src/tests/used-by-route.test.ts | pending | |
| src/tests/user-attribution-migration.test.ts | pending | |
| src/tests/user-delete-perf.test.ts | pending | |
| src/tests/user-identity.test.ts | pending | |
| src/tests/user-merge-jobs.test.ts | pending | |
| src/tests/user-roles-http.test.ts | pending | |
| src/tests/user-token-rest-auth.test.ts | pending | |
| src/tests/user-token-routes.test.ts | pending | |
| src/tests/validation-adapters.test.ts | pending | |
| src/tests/vcs-azure-devops.test.ts | pending | |
| src/tests/vcs-bitbucket.test.ts | pending | |
| src/tests/vcs-identity-inheritance.test.ts | pending | |
| src/tests/vcs-provider-isolation.test.ts | pending | |
| src/tests/vcs-provider.test.ts | pending | |
| src/tests/vcs-tracking.test.ts | pending | |
| src/tests/vendored-openapi.test.ts | pending | |
| src/tests/vercel-ai-gateway.test.ts | pending | |
| src/tests/webhook-filter.test.ts | pending | |
| src/tests/webhooks-task-blocked.test.ts | pending | |
| src/tests/window-stream-reporter.test.ts | pending | |
| src/tests/worker-nudges.test.ts | pending | |
| src/tests/worker-realtime-client.test.ts | pending | |
| src/tests/worker-token-cli.test.ts | pending | |
| src/tests/workflow-agent-task-retry.test.ts | audited and tested | C03. Three unnecessary waits removed. PR #3258. |
| src/tests/workflow-agent-task.test.ts | pending | |
| src/tests/workflow-approval-recovery.test.ts | pending | |
| src/tests/workflow-async-v2.test.ts | pending | |
| src/tests/workflow-cascade-cancel.test.ts | pending | |
| src/tests/workflow-convergence.test.ts | pending | |
| src/tests/workflow-ctx.test.ts | pending | |
| src/tests/workflow-definition-pinning-recovery.test.ts | pending | |
| src/tests/workflow-definition-pinning.test.ts | pending | |
| src/tests/workflow-definition-validation.test.ts | pending | |
| src/tests/workflow-e2e.test.ts | pending | |
| src/tests/workflow-engine-v2.test.ts | pending | |
| src/tests/workflow-executors.test.ts | pending | |
| src/tests/workflow-finalization-races.test.ts | pending | |
| src/tests/workflow-foreach-bodies.test.ts | pending | |
| src/tests/workflow-foreach-concurrency.test.ts | pending | |
| src/tests/workflow-foreach-retry.test.ts | audited, validation pending | C03. Preserve distinct races and ownership contracts. |
| src/tests/workflow-foreach-supersede-retry.test.ts | audited, validation pending | C03. Preserve distinct races and ownership contracts. |
| src/tests/workflow-foreach.test.ts | pending | |
| src/tests/workflow-hitl-dynamic-questions.test.ts | pending | |
| src/tests/workflow-hitl-routing.test.ts | pending | |
| src/tests/workflow-hitl-slack-card.test.ts | pending | |
| src/tests/workflow-http-v2.test.ts | pending | |
| src/tests/workflow-idempotency.test.ts | pending | |
| src/tests/workflow-input-redaction.test.ts | pending | |
| src/tests/workflow-integration-io.test.ts | pending | |
| src/tests/workflow-io-schemas.test.ts | pending | |
| src/tests/workflow-live-recovery.test.ts | pending | |
| src/tests/workflow-llm.test.ts | pending | |
| src/tests/workflow-mcp-trigger-schema.test.ts | pending | |
| src/tests/workflow-mcp-webhook-filter.test.ts | pending | |
| src/tests/workflow-notify-slack-ready.test.ts | pending | |
| src/tests/workflow-parallel-park.test.ts | pending | |
| src/tests/workflow-profile.test.ts | pending | |
| src/tests/workflow-registry.test.ts | pending | |
| src/tests/workflow-replay.test.ts | pending | |
| src/tests/workflow-retry-v2.test.ts | audited and tested | C03. Exact retry count and fixture retirement. PR #3258. |
| src/tests/workflow-retry-validation.test.ts | audited and tested | C03. Duplicate initial success removed, exact exhaustion retained. PR #3258. |
| src/tests/workflow-run-finished-event.test.ts | pending | |
| src/tests/workflow-runs-retention.test.ts | pending | |
| src/tests/workflow-script-principal.test.ts | pending | |
| src/tests/workflow-scrub.test.ts | pending | |
| src/tests/workflow-sub-workflow.test.ts | pending | |
| src/tests/workflow-swarm-script.test.ts | pending | |
| src/tests/workflow-system-one-decision-providers.test.ts | pending | |
| src/tests/workflow-system-one-decision-review.test.ts | pending | |
| src/tests/workflow-system-one-decision-save-warnings.test.ts | pending | |
| src/tests/workflow-system-one-decision.test.ts | pending | |
| src/tests/workflow-system-one-extraction.test.ts | pending | |
| src/tests/workflow-template-prompt-injection.test.ts | pending | |
| src/tests/workflow-template.test.ts | pending | |
| src/tests/workflow-tla-races.test.ts | pending | |
| src/tests/workflow-triggers-v2.test.ts | pending | |
| src/tests/workflow-validation-port-routing.test.ts | pending | |
| src/tests/workflow-wait-builtin-events.test.ts | pending | |
| src/tests/workflow-wait-event.test.ts | pending | |
| src/tests/workflow-wait-filter.test.ts | pending | |
| src/tests/workflow-wait-http.test.ts | pending | |
| src/tests/workflow-wait-poller.test.ts | pending | |
| src/tests/workflow-wait-recovery.test.ts | pending | |
| src/tests/workflow-wait-state-queries.test.ts | pending | |
| src/tests/workflow-wait-time.test.ts | pending | |
| src/tests/workflow-workspace.test.ts | pending | |
| src/tests/worktree-reaper.test.ts | audited and tested | C05. Canonical fixture, 21 tests and two controls. PR #3257. |
| src/tests/x-composio.test.ts | pending | |
| src/tests/x402-client.test.ts | pending | |
| src/tests/x402-config.test.ts | pending | |
| src/tests/x402-spending-tracker.test.ts | pending | |
| src/utils/credentials.test.ts | pending | |
| src/utils/mcp-server-fetcher.test.ts | pending | |

## Scenario and fixture inventory

Audit each fixture with its callers before deletion.

| Path | Status | Evidence |
|---|---|---|
| charts/agent-swarm/templates/tests/test-api-connection.yaml | pending | |
| claude-mod/tests/swarm.mod-test.ts | pending | |
| scripts/e2e/scenarios/audit-attribution.ts | pending | |
| scripts/e2e/scenarios/auth.ts | pending | |
| scripts/e2e/scenarios/cli.ts | pending | |
| scripts/e2e/scenarios/config-roundtrip.ts | pending | |
| scripts/e2e/scenarios/connector-handoff.ts | pending | |
| scripts/e2e/scenarios/core-agent-access.ts | pending | |
| scripts/e2e/scenarios/core-agent-lifecycle.ts | pending | |
| scripts/e2e/scenarios/core-agent-profile.ts | pending | |
| scripts/e2e/scenarios/core-agent-tools.ts | pending | |
| scripts/e2e/scenarios/core-budgets.ts | pending | |
| scripts/e2e/scenarios/core-helpers.ts | pending | |
| scripts/e2e/scenarios/core-improvements.ts | pending | |
| scripts/e2e/scenarios/core-messaging.ts | pending | |
| scripts/e2e/scenarios/core-org.ts | pending | |
| scripts/e2e/scenarios/core-preferences.ts | pending | |
| scripts/e2e/scenarios/core-session-data.ts | pending | |
| scripts/e2e/scenarios/core-sessions.ts | pending | |
| scripts/e2e/scenarios/core-steering.ts | pending | |
| scripts/e2e/scenarios/core-task-controls.ts | pending | |
| scripts/e2e/scenarios/core-task-tools.ts | pending | |
| scripts/e2e/scenarios/core-telemetry.ts | pending | |
| scripts/e2e/scenarios/core-terminal-task-fence.ts | pending | |
| scripts/e2e/scenarios/core-use-case-group.ts | pending | |
| scripts/e2e/scenarios/defer-wake-pr-merged.ts | pending | |
| scripts/e2e/scenarios/design-system.ts | pending | |
| scripts/e2e/scenarios/extensions.ts | static audit complete | C19: retain distinct process and transport boundaries |
| scripts/e2e/scenarios/github-installation-token-repos.ts | pending | |
| scripts/e2e/scenarios/health.ts | pending | |
| scripts/e2e/scenarios/invites.ts | pending | |
| scripts/e2e/scenarios/key-window-usage.ts | pending | |
| scripts/e2e/scenarios/knowledge-agentfs-edges.ts | pending | |
| scripts/e2e/scenarios/knowledge-apps-large-model.ts | pending | |
| scripts/e2e/scenarios/knowledge-apps-primitives.ts | pending | |
| scripts/e2e/scenarios/knowledge-apps.ts | pending | |
| scripts/e2e/scenarios/knowledge-assets.ts | pending | |
| scripts/e2e/scenarios/knowledge-boards.ts | pending | |
| scripts/e2e/scenarios/knowledge-helpers.ts | pending | |
| scripts/e2e/scenarios/knowledge-memory.ts | static audit complete | C17: retain transport and authorization contracts |
| scripts/e2e/scenarios/knowledge-objects-reindex-scope.ts | pending | |
| scripts/e2e/scenarios/knowledge-objects.ts | pending | |
| scripts/e2e/scenarios/knowledge-pages.ts | pending | |
| scripts/e2e/scenarios/knowledge-prompt-templates.ts | pending | |
| scripts/e2e/scenarios/knowledge-rooms.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-edges.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-limits.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-scripts.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-values.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-xlsx-scripts.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets-xlsx.ts | pending | |
| scripts/e2e/scenarios/knowledge-sheets.ts | pending | |
| scripts/e2e/scenarios/knowledge-skills.ts | pending | |
| scripts/e2e/scenarios/mcp-surface.ts | pending | |
| scripts/e2e/scenarios/mcp-user-code-mode.ts | pending | |
| scripts/e2e/scenarios/mcp-user-events.ts | pending | |
| scripts/e2e/scenarios/model-harness-guard.ts | pending | |
| scripts/e2e/scenarios/native-tool-hooks.ts | static audit complete | C19: retain distinct process and transport boundaries |
| scripts/e2e/scenarios/objects-http.ts | pending | |
| scripts/e2e/scenarios/platform-chat-sdk-rocketchat.ts | pending | |
| scripts/e2e/scenarios/platform-chat-sdk.ts | pending | |
| scripts/e2e/scenarios/platform-checklist.ts | pending | |
| scripts/e2e/scenarios/platform-config.ts | pending | |
| scripts/e2e/scenarios/platform-edge.ts | pending | |
| scripts/e2e/scenarios/platform-external-tools.ts | pending | |
| scripts/e2e/scenarios/platform-file-import.ts | pending | |
| scripts/e2e/scenarios/platform-helpers.ts | pending | |
| scripts/e2e/scenarios/platform-integrations.ts | pending | |
| scripts/e2e/scenarios/platform-keys.ts | pending | |
| scripts/e2e/scenarios/platform-lead-tools.ts | pending | |
| scripts/e2e/scenarios/platform-mcp.ts | pending | |
| scripts/e2e/scenarios/platform-oauth.ts | pending | |
| scripts/e2e/scenarios/platform-onboarding.ts | pending | |
| scripts/e2e/scenarios/platform-users.ts | pending | |
| scripts/e2e/scenarios/platform-webhooks.ts | pending | |
| scripts/e2e/scenarios/platformb-agentfs-proxy.ts | pending | |
| scripts/e2e/scenarios/platformb-extensions.ts | static audit complete | C19: retain distinct process and transport boundaries |
| scripts/e2e/scenarios/platformb-fs-continue.ts | pending | |
| scripts/e2e/scenarios/platformb-fs-keys.ts | pending | |
| scripts/e2e/scenarios/platformb-fs.ts | pending | |
| scripts/e2e/scenarios/platformb-helpers.ts | pending | |
| scripts/e2e/scenarios/platformb-model-groups.ts | pending | |
| scripts/e2e/scenarios/platformb-models.ts | pending | |
| scripts/e2e/scenarios/platformb-repo-merge-policy.ts | pending | |
| scripts/e2e/scenarios/platformb-repos.ts | pending | |
| scripts/e2e/scenarios/platformb-runtime.ts | pending | |
| scripts/e2e/scenarios/platformb-slack-tools.ts | pending | |
| scripts/e2e/scenarios/platformb-trackers.ts | pending | |
| scripts/e2e/scenarios/poll-concurrent-claim.ts | pending | |
| scripts/e2e/scenarios/realtime-rooms.ts | pending | |
| scripts/e2e/scenarios/registry.ts | pending | |
| scripts/e2e/scenarios/requester-hint.ts | pending | |
| scripts/e2e/scenarios/runtime-pools.ts | pending | |
| scripts/e2e/scenarios/schedule-target-owner.ts | pending | |
| scripts/e2e/scenarios/script-apis.ts | pending | |
| scripts/e2e/scenarios/script-connections.ts | pending | |
| scripts/e2e/scenarios/script-credential-bindings.ts | pending | |
| scripts/e2e/scenarios/script-helpers.ts | pending | |
| scripts/e2e/scenarios/script-inline-run.ts | landed | C08 PR #3291: field checks preserve shape, stderr guard retained, scenario passes after C15 |
| scripts/e2e/scenarios/script-kv.ts | pending | |
| scripts/e2e/scenarios/script-limits.ts | pending | |
| scripts/e2e/scenarios/script-memory-rate.ts | static audit complete | C17: retain transport and authorization contracts |
| scripts/e2e/scenarios/script-retry.ts | pending | |
| scripts/e2e/scenarios/script-run-storage.ts | pending | |
| scripts/e2e/scenarios/script-runs-durable.ts | pending | |
| scripts/e2e/scenarios/script-saved-lifecycle.ts | pending | |
| scripts/e2e/scenarios/script-sdk-calls.ts | pending | |
| scripts/e2e/scenarios/sheets-helpers.ts | pending | |
| scripts/e2e/scenarios/slack-approval-buttons.ts | pending | |
| scripts/e2e/scenarios/slack-assistant-file-share.ts | pending | |
| scripts/e2e/scenarios/slack-chat-sdk-command.ts | pending | |
| scripts/e2e/scenarios/slack-chat-sdk-interactivity.ts | pending | |
| scripts/e2e/scenarios/slack-chat-sdk-mention.ts | pending | |
| scripts/e2e/scenarios/slack-chat-sdk-signature.ts | pending | |
| scripts/e2e/scenarios/slack-defer-eta.ts | pending | |
| scripts/e2e/scenarios/slack-defer-wake.ts | pending | |
| scripts/e2e/scenarios/slack-delegation-child-result.ts | pending | |
| scripts/e2e/scenarios/slack-delegation-failed-child.ts | pending | |
| scripts/e2e/scenarios/slack-delegation-flag-off-repro.ts | pending | |
| scripts/e2e/scenarios/slack-delegation-late-child.ts | pending | |
| scripts/e2e/scenarios/slack-failed-task.ts | pending | |
| scripts/e2e/scenarios/slack-follow-up.ts | pending | |
| scripts/e2e/scenarios/slack-helpers.ts | landed | C20: PR #3278, 35 affected scenarios and delayed-reconnect control |
| scripts/e2e/scenarios/slack-http-command.ts | pending | |
| scripts/e2e/scenarios/slack-http-cross-team-identity.ts | pending | |
| scripts/e2e/scenarios/slack-http-helpers.ts | pending | |
| scripts/e2e/scenarios/slack-http-interactivity.ts | pending | |
| scripts/e2e/scenarios/slack-http-mention.ts | pending | |
| scripts/e2e/scenarios/slack-http-restart-redelivery.ts | pending | |
| scripts/e2e/scenarios/slack-http-signature-retry.ts | pending | |
| scripts/e2e/scenarios/slack-mention.ts | pending | |
| scripts/e2e/scenarios/slack-pre-task-create-block.ts | static audit complete | C19: retain distinct process and transport boundaries |
| scripts/e2e/scenarios/slack-reaction-override.ts | pending | |
| scripts/e2e/scenarios/slack-redefer.ts | pending | |
| scripts/e2e/scenarios/slack-relay-restart.ts | pending | |
| scripts/e2e/scenarios/slack-reply-card.ts | pending | |
| scripts/e2e/scenarios/slack-session-mirror.ts | pending | |
| scripts/e2e/scenarios/slack-skipped-task.ts | landed | C20: PR #3278, 35 affected scenarios and delayed-reconnect control |
| scripts/e2e/scenarios/slack-task-output-citations.ts | pending | |
| scripts/e2e/scenarios/slack-task-output-ui-spec.ts | pending | |
| scripts/e2e/scenarios/slack-task-tree-toggle.ts | pending | |
| scripts/e2e/scenarios/task-details-field-contract.ts | pending | |
| scripts/e2e/scenarios/task-details-fit.ts | pending | |
| scripts/e2e/scenarios/task-lifecycle.ts | pending | |
| scripts/e2e/scenarios/task-ui-actions.ts | pending | |
| scripts/e2e/scenarios/workflow-agent-task-crash-window.ts | pending | |
| scripts/e2e/scenarios/workflow-approvals.ts | pending | |
| scripts/e2e/scenarios/workflow-definitions.ts | pending | |
| scripts/e2e/scenarios/workflow-engine-async.ts | pending | |
| scripts/e2e/scenarios/workflow-engine-cancel.ts | pending | |
| scripts/e2e/scenarios/workflow-engine-control.ts | pending | |
| scripts/e2e/scenarios/workflow-engine-nodes.ts | pending | |
| scripts/e2e/scenarios/workflow-engine-system-one.ts | pending | |
| scripts/e2e/scenarios/workflow-helpers.ts | pending | |
| scripts/e2e/scenarios/workflow-input-refs.ts | pending | |
| scripts/e2e/scenarios/workflow-savings.ts | pending | |
| scripts/e2e/scenarios/workflow-schedules.ts | pending | |
| scripts/e2e/scenarios/workflow-script-node.ts | pending | |
| scripts/e2e/scenarios/workflow-wait-event-loop.ts | pending | |
| scripts/e2e/scenarios/workflow-webhook-filter.ts | pending | |
| scripts/e2e/scenarios/workflow-webhook-hmac-sha1.ts | pending | |
| src/tests/fixtures/app-shell-charts-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/azure-boards/workitem.commented.json | pending | |
| src/tests/fixtures/azure-boards/workitem.created.json | pending | |
| src/tests/fixtures/azure-boards/workitem.deleted.json | pending | |
| src/tests/fixtures/azure-boards/workitem.restored.json | pending | |
| src/tests/fixtures/azure-boards/workitem.updated.json | pending | |
| src/tests/fixtures/azure-devops/pull-request-commented.json | pending | |
| src/tests/fixtures/azure-devops/pull-request-created.json | pending | |
| src/tests/fixtures/base-prompt-baseline-cases.ts | pending | |
| src/tests/fixtures/base-prompt-baseline.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-comment-created-inline.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-comment-created.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-created-mention.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-created-reviewer.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-fulfilled.json | pending | |
| src/tests/fixtures/bitbucket/pullrequest-rejected.json | pending | |
| src/tests/fixtures/bookmarks-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/catalog-feedback-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/catalog-inputs-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/catalog-table-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/chat-sdk/telegram-private-text.json | pending | |
| src/tests/fixtures/codex-deferred-queue-runner.ts | audited, retained | C21: production-first Codex audit, process boundaries preserved |
| src/tests/fixtures/codex-session-runner.ts | audited, retained | C21: production-first Codex audit, process boundaries preserved |
| src/tests/fixtures/compiled-migrations-boot.ts | pending | |
| src/tests/fixtures/compiled-source-schema-boot.ts | pending | |
| src/tests/fixtures/deploy-stubs/bun | pending | |
| src/tests/fixtures/deploy-stubs/bunx | pending | |
| src/tests/fixtures/deploy-stubs/curl | pending | |
| src/tests/fixtures/deploy-stubs/docker | pending | |
| src/tests/fixtures/extensions/bad-import/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/bad-import/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/bad-return-shape/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/bad-return-shape/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/block-tasks-from-source/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/block-tasks-from-source/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/ignore-channel/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/ignore-channel/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/load.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/minimal/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/minimal/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/native-tool-recorder/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/native-tool-recorder/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/never-fail-long-tasks/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/never-fail-long-tasks/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/no-exclamation-marks/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/no-exclamation-marks/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/post-logger/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/post-logger/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/priority-a/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/priority-a/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/priority-b/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/priority-b/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-blocks/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-blocks/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-only-on-tag/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-only-on-tag/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-task-create/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/record-task-create/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/reserved-assets/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/reserved-assets/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/rewrite-progress-prefix/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/rewrite-progress-prefix/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/rewrite-task-priority/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/rewrite-task-priority/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/route-channel-to-agent/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/route-channel-to-agent/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/route-chat-channel-to-agent/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/route-chat-channel-to-agent/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/slow/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/slow/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/steering-policy/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/steering-policy/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/suppress-lead-follow-up/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/suppress-lead-follow-up/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/throws/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/throws/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/with-assets/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/with-assets/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/with-assets/scripts/echo.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/worker-runtime/hooks.ts | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/extensions/worker-runtime/manifest.json | audited, retained | C19: all 52 fixture/helper files remain used |
| src/tests/fixtures/fake-amp.ts | pending | |
| src/tests/fixtures/fake-claude-routes.ts | pending | |
| src/tests/fixtures/fake-codex-app-server.ts | audited, retained | C21: production-first Codex audit, process boundaries preserved |
| src/tests/fixtures/fake-fx.ts | pending | |
| src/tests/fixtures/file-lock-holder.ts | pending | |
| src/tests/fixtures/fx/acp-responses-recorded.json | pending | |
| src/tests/fixtures/fx/acp-updates-recorded.jsonl | pending | |
| src/tests/fixtures/grok/acp-updates-recorded.jsonl | pending | |
| src/tests/fixtures/grok/prompt-response-meta.json | pending | |
| src/tests/fixtures/held-template-render.ts | audited, retained | C21: production-first Codex audit, process boundaries preserved |
| src/tests/fixtures/hold-file-lock.ts | pending | |
| src/tests/fixtures/import-package.ts | pending | |
| src/tests/fixtures/kibo-blocks-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/onboard/baseline-states.ts | pending | |
| src/tests/fixtures/onboard/content.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/content.env.txt | pending | |
| src/tests/fixtures/onboard/dev.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/dev.env.txt | pending | |
| src/tests/fixtures/onboard/full-all.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/full-all.env.txt | pending | |
| src/tests/fixtures/onboard/full.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/full.env.txt | pending | |
| src/tests/fixtures/onboard/research.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/research.env.txt | pending | |
| src/tests/fixtures/onboard/solo.compose.yml.txt | pending | |
| src/tests/fixtures/onboard/solo.env.txt | pending | |
| src/tests/fixtures/openai-compatible-registry-extension.child.ts | pending | |
| src/tests/fixtures/pages/head-v1.html | pending | |
| src/tests/fixtures/prs-app-definition.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/prs-filters-migration.patch.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/prs-selection-migration.patch.json.txt | audited, retained | C18: semantic and consumer review, distinct fixture contracts preserved |
| src/tests/fixtures/runner-identity-refresh.ts | pending | |
| src/tests/fixtures/runner-legacy-resume-prompt.ts | pending | |
| src/tests/fixtures/runner-missing-dependency.ts | pending | |
| src/tests/fixtures/runner-task-start-reads.ts | pending | |
| src/tests/fixtures/sample-json-page.json | pending | |
| src/tests/fixtures/secret-corpus.ts | pending | |
| src/tests/fixtures/sheets/eocd-count-mismatch.xlsx | pending | |
| src/tests/fixtures/sheets/rich-budget.xlsx | pending | |
| src/tests/fixtures/sheets/tracker-export.xlsx | pending | |
| src/tests/fixtures/store-progress-malformed-output.json | pending | |
| src/tests/fixtures/ui-spec-slack/deploys.json | pending | |
| src/tests/fixtures/ui-spec-slack/incident.json | pending | |
| src/tests/fixtures/ui-spec-slack/three-charts-stale.json | pending | |
| src/tests/fixtures/ui-spec-slack/video-rejected-by-slack.json | pending | |
| src/tests/fixtures/ui-spec-slack/video.json | pending | |
| src/tests/fixtures/workflow-idempotency-trigger.child.ts | pending | |
| src/tests/mocks/mock-llm-rater-client.ts | pending | |
