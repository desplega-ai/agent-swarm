# Worker SQLite Phase 1 evidence

Checkout: `t3-6b7c0548-f85e774a66b750fc`.
Branch: `t3/research-async-database-options`.
Base: `556461bfc0e2249991eab35df5c606ed5813ad1f`.
Runtime: Bun 1.4.4 (`38afee6c8`).
Scope: Phase 1, including Taras's authorized runtime prompt upsert and reset conversion.
The parent owns the plan and its checkboxes. This implementation did not edit the plan.

## Final review resolution, 2026-11-16

Both independent reviews accepted the earlier corrections and reported the same remaining Important finding.
Conditional expressions hid returned executor closures, including closures returned by async factories.
The parent accepted and corrected that finding directly.
Callable resolution now inspects both conditional branches and logical alternatives. It also unwraps `satisfies` expressions.
The corpus includes both reviewers' exact counterexamples, aliases, logical alternatives, and an accepted conditional plain value.

The final corpus passed 96 tests and 220 assertions in 3.21 seconds.
The repository ownership checker reports zero findings. Direct tooling typechecking and Biome passed.
The runtime files did not change during this last correction.

**Standards resolution:** all reported Critical and Important findings are corrected and verified.
**Spec resolution:** all reported Important findings are corrected and verified under Taras's approved contract.
These are the parent's resolutions of the findings, not claims of new independent approvals after the final edit.
Phase 1 remains open for final automated verification before Phase 2 begins.

Source SHA-256 values after this correction:

- Analyzer: `6a4bd0a729404da4bc7277fc4b48269e96de63deb1d3087ba64ae1626e8ed1f3`.
- Corpus: `21a1c3242a76f2a96d0169b8818dd01e6bb1102747cfb56a629f2fc73d6b9c03`.
- Client: `b38ac7f1e25e0db003fa94d0ec02f03b3bb5bcf7a8731a27e5f0b822f83e7f12`.
- Runtime: `ccc8b87d50073bf83eb5a9a73c2713534dc067b6be338cb7299865e12d27f8fd`.

## Spec corrections and ownership recheck, 2026-11-16

The Spec review found three Important defects. The Standards recheck found one remaining conditional-consumption defect.
The parent corrected all four. Independent reviews of these corrections remain pending.

- Commit hooks clear both `txContext` and `transactionScope`.
  A regression uses independent clients and holds one client's hook until the other client's savepoint closes.
  Fresh bound and ambient writes then succeed on both drivers.
- Contextual callback properties connect configured dependency implementations to the analysis graph.
  This covers property assignments and shorthand properties across source files.
  The real `cascadeFailDependents` mutation now produces the expected ownership diagnostic.
  The mutation exists only in the compiler's source view. No production source or database receives the injected statement.
- Callable resolution follows `await`, so returned executor closures and async factories cannot hide behind it.
- Stored-promise joins now require a known eager expression path.
  Destructuring defaults and assignment defaults cannot prove consumption. Conditional creation of returned work remains supported.

The initial configured-property analysis also traversed the DB seam's internal queue and rejected `ctx.tail.then(op)`.
The corrected graph treats DB methods as primitives while continuing to inspect their callers and transaction callbacks.
An explicit AST node annotation resolved a TypeScript inference error in the eager-path check.
Neither correction changes the approved native caught-error contract.

Fresh results:

- Six focused seam and checker files passed 229 tests, with 939 assertions and zero failures, in 59.88 seconds.
- That run included 78 corpus cases. Seven subsequent corpus cases passed in the final 85-case run, with 188 assertions.
- The final repository ownership checker reports zero findings. The promise-sink checker also reports zero findings.
- Direct analyzer typechecking and root typechecking passed.
- The semantic probe passed all 24 checks after the hook correction.
- Biome, whitespace, both database boundaries, and the unit-test allowlist passed.
- The production Worker benchmark passed with 960.609 ms execution and 5.431 ms main-thread lag.
  Round-trip time was 961.126 ms. Worker timing remained separate from synchronous `db_ms`.
- An in-memory compiler mutation inserted an ignored ambient write into `cascadeFailDependents`.
  Analysis reported `Await, return, or join transaction work. Detached work is unsupported.` at `src/be/db.ts`.

The focused command matches the six-file command below.
The final corpus command was `bun run test:root -- src/tests/db-promise-analysis.test.ts`.
Historical full-suite and compiled results predate these corrections. They do not establish final-tree verification.
The benchmark command was `bun scripts/bench-db-worker.ts --driver worker --assert`, with the same synthetic credentials and loopback environment as the probe.
The parent removed its temporary probes, compiler configuration, and logs after preserving these results.
Available disk space remained 20 GiB before and after cleanup, at `df -h` rounding.
No container or service was started.

## Standards corrections, 2026-11-16

The Codex Standards review found three defects after the approved-contract correction.
The parent accepted all three findings and corrected them directly.
Independent review of these corrections remains pending. Phase 1 remains open.

- Stored promises now require unconditional consumption within the containing statement.
  Short-circuit branches, ternary branches, conditional assignments, and optional calls cannot prove a join.
  Nine new rejection cases assert the specific ownership diagnostic. A positive case preserves conditional creation of returned work.
- Ambient and bound calls now share timing observation for successful and failed driver operations.
  A real SQLite trigger performs slow work before raising an error.
  The regression checks `query`, `get`, and `run` on both drivers, including parameter privacy and Worker attribution.
- Fatal Worker handling logs the scrubbed transport cause before exiting with code 1.
  Subprocess cases exercise a missing startup database, termination after readiness, and a synthetic transport error containing a registered secret.

The semantic probe passed all 24 checks after these changes.
The floating-promise and promise-sink checks report zero findings.
Root typechecking, direct analyzer typechecking, Biome, whitespace checks, and both database boundaries passed.
The unit-test allowlist check passed with the existing seam exemptions.

The first focused run stalled in the new Worker test's asynchronous `expect(...).rejects` assertion.
Its five-second timeout also interrupted cleanup while the transaction remained active.
The parent stopped that owned run and changed the assertion to await `Promise.allSettled` before inspecting the result.
This follows the existing suite's settlement approach. No timeout or production behavior changed for that test correction.
The focused repetition passed: 222 tests, zero failures, and 922 assertions across six files in 59.50 seconds.
This includes all 73 analyzer cases. Oxlint also passed.
Earlier full-suite and compiled results below predate these three fixes.

The focused command was:

```bash
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp \
BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events \
DESPLEGA_TELEMETRY_ENV=test bun run test:root -- \
src/tests/db-promise-analysis.test.ts src/tests/db-client.test.ts \
src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts \
src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts
```

The parent removed its temporary logs and tooling configuration after preserving these results.
It also removed the single owned seam directory left by the interrupted assertion.
Available disk space remained 20 GiB before and after cleanup, at `df -h` rounding.
This correction created no build output and started no container or service.

## Approved-contract correction, 2026-11-15

Status: implementation and automated verification completed. This section supersedes the historical contract status below.
Taras approved native caught-error semantics plus stricter static ownership checks.
The parent retains plan bookkeeping and independent Standards and Spec review.

### Current runtime contract

- Callback rejection causes rollback. A caught ordinary statement rejection permits commit.
- The fatal ledger now retains only Worker transport loss. Failed savepoint recovery also poisons the outer transaction.
- FIFO reservation, stable draining, deadlines, retry boundaries, and lifecycle guards remain.
- Bound savepoint executors expire when their scope ends. Outer executors retain their original scope.
- Lost COMMIT replies retain uncertain outcomes and suppress both hook groups.
- Routing-audit inserts use the existing executor. Their former tolerance-only savepoint is removed.
- Optional workflow snapshots and embedding metadata retain their existing catch behavior.
- The vector replacement probe starts with an obsolete vector. Failed insertion leaves that vector absent and commits updated metadata.
- Runtime code installs no rejection listener, Promise patch, observation heuristic, or error-tolerance API.

### Current static contract

The existing floating-promise gate invokes `scripts/db-promise-analysis.ts` through its TypeScript program.
The analysis starts at transaction callbacks and follows source-resolved helpers, callback parameters, ambient calls, and nested transactions.
It requires awaited, returned, or joined DB work before the scope ends.
It rejects discarded calls and chains, abandoned stored promises, detached callbacks, and unsupported executor or helper escapes.
It recognizes native Promise joins and Array maps through their library declarations.
Awaiting or returning an array does not count as a join. The corpus rejects those forms explicitly.
The analysis also follows helpers that only capture or store bound executors, even without a direct DB call.
It rejects transaction results that hide executor closures behind a source-resolved factory.
It rejects bound executor captures in transaction hooks.
The original general rules still permit unrelated intentional background work outside transaction scopes.

The supported subset and limits appear in `runbooks/async-db-promises.md`.
This analysis does not prove arbitrary JavaScript lifetimes.
It rejects unsupported dynamic forms conservatively and retains one documented dependency-injection exemption for the existing audit boundary.
Local stored promises require an unconditional join in the same block.
Lazy factories require source-resolved returned callables.
The checklist memoizer now returns its pending promise directly, which fits this supported form.
Room persistence timers now start through `afterCommit`, outside the caller's transaction context.

### Regression accounting

The revised semantic probe explicitly replaces universal floating-failure rollback cases with static rejection cases.
It preserves all six caught-error forms and both best-effort callers on both drivers.
It adds callback rollback, nested isolation, and obsolete-vector absence checks.
Its successful chained-admission case still tests stable runtime draining, although application code must join such chains.
The obsolete-vector check substitutes an owned table and an abort trigger after creating an initial vector.
The original sqlite-vec chunk corruption reproduction also remains.
These injected failures execute through the semantic probe and seam suites.
The public black-box suite uses normal fixtures and does not inject these two failures through HTTP.
The probe no longer installs a rejection listener.

The former seam test with `pending.catch(() => {})` now awaits the chain before expecting rollback.
The former outer floating-failure test now verifies caught outer and nested errors can commit.
The Worker sibling test joins all admitted operations before callback rejection.
A separate injected seam regression verifies caught transport loss and failed savepoint recovery cannot authorize commit.
No unrelated assertion, transport deadline, timeout budget, retry budget, or no-replay check was removed.

### Fresh verification

These are fresh results for the approved contract. Historical results below remain historical.

Focused commands use this environment:

```bash
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp \
BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events \
DESPLEGA_TELEMETRY_ENV=test
```

Root and affected suites use `env -u DESPLEGA_TELEMETRY_ENV` with the other values unchanged.
The harness tags its own server boots. The semantic probe validates loopback telemetry before database initialization.
The runtime is pinned Bun 1.4.4. All fixture credentials are synthetic.

| Command | Fresh result |
| --- | --- |
| `NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/probe-db-transaction-errors.ts` | PASS: 24 acceptance checks across both drivers. |
| `bun run test:root -- src/tests/db-promise-analysis.test.ts` | PASS: 63 cases, zero failures, 126 assertions. Final duration: 2.74 seconds. |
| `bun scripts/check-floating-promises.ts` | PASS: zero findings. |
| `bun scripts/check-promise-sinks.ts` | PASS: zero findings. |
| `bun tsc --noEmit -p /tmp/db-phase1-correction-tooling-tsconfig.json` | PASS: direct tooling and corpus typecheck. |
| `bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts src/tests/routing-decision-persistence.test.ts src/tests/workflow-http-v2.test.ts src/tests/memory*.test.ts src/tests/realtime-transport.test.ts src/tests/checklist.test.ts` | PASS: 846 tests across 42 files, zero failures, 3,856 assertions. Duration: 94.81 seconds. |
| `bun run test:root -- src/tests/db-worker-driver.test.ts` | PASS after the final sibling-join correction: 20 tests, zero failures, 56 assertions. |
| `bun run tsc:check:tsc` | PASS. |
| `bun run lint && bun run lint:slop` | PASS. Five existing warnings and four information messages remain. |
| `bash scripts/check-async-db-seam.sh && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:unit-test-allowlist` | PASS. Dependency analysis reports zero errors and 2,693 warnings. The existing seam exemptions remain. |
| `bun run docs:openapi` | PASS. The inspected schema diff retains only the earlier authenticated `dbDriver` addition. |
| `env -u DESPLEGA_TELEMETRY_ENV PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events bun run check:local` | Final source PASS: frozen install, changed-file lint, Oxlint, typecheck, 12,693 passed, 24 skipped, zero failed. Tests: 73,917 assertions across 746 files, 158.55 seconds. |
| `env -u DESPLEGA_TELEMETRY_ENV PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events bun run test:root -- --parallel=4` | PASS: 22,235 passed, 43 skipped, zero failed. Tests: 116,430 assertions across 1,468 files, 303.96 seconds. Includes the 58 corpus cases present then. |
| `bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-phase1-correction-e2e-sqlite.json` | PASS: 155 scenarios, zero failures, zero retries. p50/p95: 0.63/10.88 ms across 4,819 calls. |
| `bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-phase1-correction-e2e-worker.json` | PASS: 155 scenarios, zero failures, zero retries. p50/p95: 0.67/10.52 ms across 4,838 calls. |
| Compiled API smokes, native Linux arm64 and emulated Linux x64 | PASS on both platforms. Task write/read, active 512-dimension vectors, and indexed-memory retrieval through hybrid search. |

The first focused run exposed a missing executor parameter after removal of the routing savepoint.
Typechecking reported the same error. The parameter correction passed the complete focused repetition above.
The first affected run passed 12,676 tests, skipped 24, and failed one remote-controller connection wait.
That test exceeded its existing two-second budget. No timeout or test assertion changed.
The isolated controller and corpus repetition passed 72 tests and 230 assertions.
The final affected run above passed without another workload running beside it.
The first full root run passed 22,229 tests, skipped 43, and failed one attachment upload assertion.
That assertion received HTTP 404 instead of 201. Its isolated file passed 31 tests and 220 assertions.
The second full run passed 22,228 tests, skipped 43, and failed two checks in untouched test files.
One child-cleanup check still observed its child PID after ten seconds.
One controller connection check exceeded its existing two-second wait.
The combined isolated repetition passed all 58 tests and 359 assertions across those three files.
No assertion, timeout, retry option, or related implementation changed for these failures.
Their exact cause remains unproven. The third full run passed, as recorded above.
That full run preceded the final five static escape cases and their analyzer refinement.
The final corpus, checker, and tooling typecheck passed separately after that refinement.
The first affected repetition with all 63 corpus cases passed 12,690 tests, skipped 24, and failed three successor-steering checks.
Two checks received HTTP 404. One check observed no pending steering message.
The successor-steering file and final corpus passed together in isolation: 75 tests and 231 assertions.
This correction does not change that test file, its assertions, or its implementation paths.
The exact cause remains unproven. The final affected repetition passed, as recorded above.

Both production-client benchmarks passed:

| Driver | Execution ms | Round trip ms | Transport and scheduling ms | Main-thread lag ms |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 1140.104 | 1140.339 | 0.235 | 1139.009 |
| worker | 966.782 | 969.127 | 2.345 | 3.877 |

Commands: `NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/bench-db-worker.ts --driver sqlite --assert` and the equivalent `--driver worker --assert`.
They used the focused environment above.
The Worker attribution sample reported `db_ms=0 driver=worker worker_execution_ms=178`.
These results measure execution, transport, and main-thread lag separately.

The temporary tooling configuration extends the root configuration, enables its excluded tooling paths, and sets the repository's type roots.
It includes `scripts/db-promise-analysis.ts`, `scripts/check-floating-promises.ts`, and `src/tests/db-promise-analysis.test.ts`.
No dependency changed.

### Compiled verification

Verification continued on 2026-11-16 BCN. The host reports `arm64`.
Both images passed Worker selection, task write/read, active 512-dimension vectors, and hybrid memory retrieval.
Each owned mock received 44 embedding requests. Each memory vector count reached one before search.
The first smoke request supplied an assigned task without its required routing reason.
That fixture received HTTP 400. The corrected fixture creates an unassigned task, matching the historical smoke template.
No application code changed for that correction.

Commands use the focused environment above:

```bash
orb start
docker --context orbstack buildx create --name db-phase1-correction-owned --driver docker-container orbstack
docker --context orbstack buildx build --builder db-phase1-correction-owned --platform linux/arm64 --load -f Dockerfile -t agent-swarm-api:db-phase1-correction-arm64-owned .
bun /tmp/db-phase1-correction-compiled-smoke.ts agent-swarm-api:db-phase1-correction-arm64-owned linux/arm64
docker --context orbstack buildx build --builder db-phase1-correction-owned --platform linux/amd64 --load -f Dockerfile -t agent-swarm-api:db-phase1-correction-x64-owned .
bun /tmp/db-phase1-correction-compiled-smoke.ts agent-swarm-api:db-phase1-correction-x64-owned linux/amd64
```

The smoke follows the reproducible template below, with the correction prefix and agent-scoped manual memory.
It validates the loopback sink before boot. Containers also set `NODE_ENV=test`, synthetic encryption, and an empty business-use key.
The mock serves embeddings and synthetic inference responses locally. No volume or existing database enters the container.
Public health must omit `dbDriver`. Authenticated stats must report `worker`.
The final search must return the indexed memory through `vec` or `hybrid`, rather than through FTS alone.
The smoke removes its container and stops its mock in `finally`.

| Platform | Image ID | Bytes | Result |
| --- | --- | ---: | --- |
| Native Linux arm64 | `d981d601c15cfd7754bfbe774b2576cb7bb38c41e928f72f7722fac5fcf4692f` | 459939587 | PASS. |
| Emulated Linux x64 | `0d91c23ca7d4863c43d9db5ac6f75817dc0c867626f3e6b94a036a1299e5d5e0` | 435164995 | PASS. |

### Cleanup

The task removed its two images, its builder, and all 72 temporary files with the `db-phase1-correction-` prefix.
Logs and JSON files were deleted first. No matching temporary path remains.
Both smoke containers removed themselves. The final local checks found no matching container or builder volume.
OrbStack was stopped initially. `orb status` now reports `Stopped` again.
The project has no root clean command. No shared cache, `node_modules`, or preexisting artifact was deleted.

```bash
docker --context orbstack buildx rm db-phase1-correction-owned
docker --context orbstack image rm agent-swarm-api:db-phase1-correction-arm64-owned agent-swarm-api:db-phase1-correction-x64-owned
orb stop
orb status
df -h /
```

Initial availability was 19 GiB. It reached 20 GiB before the owned builds.
Immediately before cleanup, `df -h /` reported 11 GiB available. After cleanup, it reported 20 GiB.
The corresponding `df -k /` values were 12,028,320 and 20,704,900 KiB.
The observed cleanup increase was 8.27 GiB. Other system activity can affect this measurement.

Final whitespace validation passed. HEAD remains `556461bfc0e2249991eab35df5c606ed5813ad1f`.
The manifest matches all 680 current paths, with no missing file or stale entry.
The parent can now perform independent Standards and Spec reviews. Its protocol review remains pending.

### Scope and artifacts

This correction changes these implementation and tooling paths:

- `src/be/db-client.ts`
- `src/be/db.ts`
- `src/be/checklist.ts`
- `src/realtime/rooms.ts`
- `scripts/check-floating-promises.ts`
- `scripts/db-promise-analysis.ts`
- `scripts/probe-db-transaction-errors.ts`
- `src/tests/db-client.test.ts`
- `src/tests/db-worker-driver.test.ts`
- `src/tests/db-promise-analysis.test.ts`
- `runbooks/async-db-promises.md`
- This report, its cumulative manifest, and the historical contract's dated decision note.

The cumulative manifest now lists all 680 dirty or untracked paths, including preexisting parent research and plans.
All 674 initial status entries remain present. This correction does not claim ownership of those earlier changes.

QA Doc: n/a. No linked QA specification exists.
The protocol review remains a parent-owned manual item.
No later phase, dependency change, subagent, branch, commit, push, PR, production access, or external telemetry is authorized.

## Historical review correction status: blocked

This section supersedes earlier final-source claims in this report.
Earlier results describe the previous implementation, not the corrections below.
Phase 1 remains open. The implementation does not preserve handled statement failures.
The required rejection contract remains unchanged. Phase 1 needs a reliable implementation before acceptance.

### Open semantic contract

`enqueue` still records every rejected statement. The drain therefore rolls back after a caller catches a statement error.
The durable reproduction is `scripts/probe-db-transaction-errors.ts`.
It tests both real drivers with isolated files and synthetic values.
Six handled-error cases fail on each driver: native await, async wrapper, client wrapper, catch, finally followed by catch, and caught rethrow.
Both existing best-effort callers also fail: `snapshotOptional` and `SqliteMemoryStore.updateEmbedding`.
The probe injects a snapshot trigger failure and corrupts an owned vector fixture after initialization.
Successful chained statements drain correctly. Unhandled floating statement failures roll back correctly.
Floating native wrappers, then chains, and finally chains also roll back on both drivers.
The probe captures six native unhandled rejection events without attaching handlers to those promises.
This capture prevents the standalone probe from terminating before it records every case.
The probe currently exits 1. This failure is required evidence of the unresolved contract.

Simple observation tracking cannot fix this contract reliably.
On Bun 1.4.4, a caught native await and assimilation into a floating async wrapper call the tracked promise identically.
Both receive a native rejection callback: `function () { [native code] }`.
Marking that call observed misses the floating wrapper. Leaving it unobserved rejects the caught await.
Client wrappers and internal drain handlers introduce the same ambiguity.
`node:async_hooks.createHook` produces no promise lifecycle events on this runtime.
`node:v8.promiseHooks.createHook` throws `NotImplementedError: node:v8 createHook is not yet implemented in Bun.`
Global rejection listeners would change process handling and still require reliable ownership across native wrapper promises.
Production code does not install global listeners, patch Promise, or change the public client contract.
It does not claim that these experiments prove every possible runtime-specific solution impossible.
They establish why the suggested local observation wrapper is insufficient.

The routing savepoint workaround remains necessary while this general defect remains open.
Removing it now reproduces the routing-audit regression. No caller-specific workaround was added.

### Applied corrections

- Savepoints tag failures with scope identities. Rollback removes only failures owned by that scope or its descendants.
- Bound executors retain their original scope inside nested callbacks. An outer floating failure survives a caught nested failure.
- Fatal Worker transport loss terminates the API with exit code 1. Public health gains no configuration fields.
- Invalid clone parameters reject only their request. Later database operations remain usable.
- HTTP and stdio shutdown exit 1 when database closure rejects.
- Transport-name and failed-timing checks tolerate null and undefined thrown values.
- Hook admission expires when the hook settles. Detached continuations cannot retain admission during shutdown.
- Timeout restoration still reads the current timeout for every operation. A regression changes the ambient timeout between operations.
- Worker execution contributes only to Worker cost reporting. Synchronous top statements, path, path counts, and statement counts exclude it.
- Slow Worker statements receive separate execution warnings. Egress scrubs SQL before truncation and omits bound parameters.
- Runtime captures boot vector capability before clearing the active capability.
- Optional boot extension failure prevents the package path from becoming required Worker support.
- Worker startup independently verifies vector support. Optional Worker load failure reports unavailable support.
- An explicit `SQLITE_VEC_EXTENSION_PATH` remains required and fails startup when loading fails.
- macOS library resolution occurs once for Worker mode. The default driver retains its previous Bun library selection.
- Worker mode's Homebrew library selection is documented in `runbooks/local-development.md`.
- Durable black-box startup coverage checks invalid drivers, production in-memory rejection, and legacy encrypted-row exclusion.
- Transport coverage now loses a write reply after execution and loses a Worker during an open transaction. Both assert no replay.

### Correction verification

Focused and black-box commands use this prefix unless stated otherwise:

```bash
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp \
DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events DESPLEGA_TELEMETRY_ENV=test
```

Full root and affected checks use `env -u DESPLEGA_TELEMETRY_ENV` with the same PATH, TMPDIR, and endpoint.
Those commands set `BUSINESS_USE_API_KEY=`. The test runners already tag their API boots.
The endpoint is valid HTTP loopback. It cannot reach an external telemetry sink.
Black-box API boots use the runner's valid loopback mock endpoint.
New startup fixtures validate that endpoint before spawning their APIs.
The standalone behavior probe validates its loopback endpoint before database initialization.
New transport children use a minimal environment and synthetic encryption keys.

| Command | New correction result |
| --- | --- |
| `bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts` | PASS: 144 tests, 707 assertions. This preceded the additional optional-boot child regression. |
| `bun run e2e --only db-driver-startup --sut-env DB_DRIVER=worker --json /tmp/db-worker-review-startup-final.json` | PASS: one scenario, no retry. |
| `bun run test:root -- src/tests/db-worker-driver.test.ts` | PASS: 20 tests, 56 assertions, including optional boot failure and fatal loss after readiness. |
| `bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-worker-review-sqlite.json` | PASS: 155 scenarios, zero failures, zero retries. p50/p95: 0.69/11.31 ms. |
| `bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-worker-review-worker.json` | PASS: 155 scenarios, zero failures, zero retries. p50/p95: 0.90/13.97 ms. |
| `bun run lint && bun run lint:slop && bun run tsc:check:tsc` | PASS. Five existing lint warnings and four information messages remain. |
| `bash scripts/check-async-db-seam.sh && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:unit-test-allowlist` | PASS. Dependency checks report zero errors and 2,693 warnings. |
| `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bun run docs:openapi` | PASS. Both promise checks report zero findings. Generated schema changes remain the prior authenticated stats change. |
| `NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/probe-db-transaction-errors.ts` | FAIL: 16 handled-error or best-effort checks. Ten drain checks pass. Both drivers reproduce the same defect. |
| `env -u DESPLEGA_TELEMETRY_ENV PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events bun run test:root -- --parallel=4` | Final correction source PASS: 22,175 passed, 43 skipped, zero failures, 116,310 assertions across 1,467 files. Runtime: 322.37 seconds. |
| `env -u DESPLEGA_TELEMETRY_ENV PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events bun run check:local` | Final correction source PASS: frozen install, lint, type checking, 12,628 passed, 24 skipped, zero failures, 73,789 assertions across 745 files. Test runtime: 165.32 seconds. |
| `NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/bench-db-worker.ts --driver sqlite --assert` | PASS. Long statement: 1,006.02 ms execution, 1,005.49 ms event-loop lag, 0.23 ms transport and scheduling. |
| `NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/bench-db-worker.ts --driver worker --assert` | PASS. Long statement: 985.88 ms execution, 1.58 ms event-loop lag, 0.31 ms transport and scheduling. Worker timing remains separate from synchronous attribution. |

The first full correction run passed 22,167 tests, skipped 43, and failed seven checks.
Six installer snapshots inherited an extra `DESPLEGA_TELEMETRY_ENV=test` line from this command.
The seventh failure used an invalid explicit extension path to simulate optional absence.
That setup now mocks optional loading failure and preserves every behavior assertion.
The isolated correction passed 58 tests and 238 assertions across the installer and learning suites:
`env -u DESPLEGA_TELEMETRY_ENV PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp BUSINESS_USE_API_KEY= DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events bun run test:root -- src/tests/store-progress-learning.test.ts src/tests/onboard-env.test.ts`.

The first corrected focused run failed the new scope regression on both drivers.
An undefined bound scope inherited the nested scope through a default argument. Capturing a stable scope corrected it.
The first startup scenario failed while mutating a deserialized WAL snapshot.
The fixture now uses `VACUUM INTO` from a readonly source and mutates only its isolated copy.
These earlier failures are superseded by the passing runs above.

### Remaining correction limitations

The handled-error fix is blocked. No promise observation implementation was installed.
The standalone best-effort reproductions do not replace HTTP coverage for injected snapshot and vector failures.
Transport close failures have focused coverage. Running HTTP and stdio entrypoints did not receive injected `closeDb` failures in this pass.
Slow Worker warning formatting has no dedicated capture assertion. Existing scrubber tests and the full suite passed.
Taras has not manually reviewed the protocol types according to any evidence available to this implementation.
The parent still owns that manual item and the plan.
No later phase, commit, push, PR, production access, or delegated agent occurred.

Correction paths changed in this pass:

- `src/be/db-client.ts`
- `src/be/db/runtime.ts`
- `src/be/db/worker-driver.ts`
- `src/be/db/db-worker.ts`
- `src/be/event-loop-lag.ts`
- `src/http/index.ts`
- `src/stdio.ts`
- `src/tests/db-client.test.ts`
- `src/tests/db-worker-driver.test.ts`
- `src/tests/event-loop-lag.test.ts`
- `src/tests/store-progress-learning.test.ts`
- `scripts/unit-test-allowlist.txt`
- `scripts/e2e/db.ts`
- `scripts/e2e/scenarios/db-driver-startup.ts`
- `scripts/probe-db-transaction-errors.ts`
- `runbooks/local-development.md`
- This report and its changed-path manifest.

### Compiled correction verification

These runs follow every test suite and benchmark. No build ran concurrently with a test suite.
The task created one builder on the explicit local `orbstack` context.
The smoke script uses the reproducible recipe below, with container prefix `db-worker-review-compiled-`.
Both containers use valid container-loopback telemetry endpoints before API startup.
Their embedding requests use only the local mock and synthetic credentials.

```bash
orb start
docker --context orbstack buildx create --name db-worker-phase1-review-owned --driver docker-container orbstack
docker --context orbstack buildx build --builder db-worker-phase1-review-owned --platform linux/arm64 --load -f Dockerfile -t agent-swarm-api:db-worker-phase1-review-arm64-owned .
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events DESPLEGA_TELEMETRY_ENV=test bun /tmp/db-worker-review-compiled-smoke.ts agent-swarm-api:db-worker-phase1-review-arm64-owned linux/arm64
docker --context orbstack buildx build --builder db-worker-phase1-review-owned --platform linux/amd64 --load -f Dockerfile -t agent-swarm-api:db-worker-phase1-review-x64-owned .
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH TMPDIR=/private/tmp DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events DESPLEGA_TELEMETRY_ENV=test bun /tmp/db-worker-review-compiled-smoke.ts agent-swarm-api:db-worker-phase1-review-x64-owned linux/amd64
```

Both builds and smokes passed. ARM64 ran natively on this Mac. x64 ran under emulation.
Each smoke verified authenticated Worker selection, health privacy, task write/read, active vector support, vector population, and hybrid retrieval.
Each indexed one memory with a valid 512-dimensional vector and observed 44 requests to the local embedding mock.
These results independently verify active compiled Worker capability. Boot capability alone does not establish this result.
Startup budgets remain unchanged: 90 seconds for ARM64 and 600 seconds for emulated x64.

### Correction cleanup

OrbStack was stopped initially. It is stopped again after both compiled smokes.
Both smoke containers removed themselves. The final filtered container check returned no matching containers.
The task removed its builder and both image tags with these commands:

```bash
docker --context orbstack ps -a --filter name=db-worker-review-compiled- --format '{{.Names}}'
docker --context orbstack buildx rm db-worker-phase1-review-owned
docker --context orbstack image rm agent-swarm-api:db-worker-phase1-review-arm64-owned agent-swarm-api:db-worker-phase1-review-x64-owned
orb stop
orb status
df -h /
git diff --check
```

Cleanup deleted 27 owned temporary entries. It deleted 25 logs or JSON reports before the remaining scripts.
The final `/private/tmp/db-worker-review-*` inventory is empty.
No task server, Worker test process, watcher, or compiled smoke remains active.
There is no root clean script. Compiled outputs lived only in the removed images and dedicated builder.
No shared cache, dependency directory, or unrelated image was pruned.

Disk availability was 17 GiB at the initial check and 16 GiB before starting OrbStack.
It was 7.5 GiB immediately before cleanup and 16 GiB afterward, as reported by `df -h /`.
Cleanup increased observed availability by approximately 8.5 GiB. Other host activity can affect these rounded measurements.
The final diff whitespace check passed. All 664 cumulative manifest paths exist.
The correction changed 18 paths, including this report and its cumulative manifest.
The parent plan remains untouched. Phase 1 remains blocked by the unchanged rejection contract.

## Runtime decisions

- `DB_DRIVER=sqlite` remains the default. `worker` requires an explicit deployment environment variable and an API restart.
- Stored configuration cannot set this reserved key. Legacy rows are excluded before decryption and environment injection.
- Migrations and seeders retain synchronous access. The Worker opens the existing database file after boot.
- The Worker verifies WAL and its actual vector extension. Tests exercised macOS custom SQLite with the boot connection open.
- Client ownership retains FIFO serialization, transaction routing, savepoints, confirmed BUSY retries, deadlines, and post-transaction hooks.
- Transaction operations reserve their order before readiness waits. Failed floating statements prevent COMMIT.
- Transaction drain repeats until its statement tail remains unchanged. This also covers continuations that admit statements during drain.
- Each timed write and its `SELECT changes()` execute in one operation. Failed attempts contribute execution time without transport or backoff time.
- Worker execution appears as `worker_execution_ms`. It never contributes to synchronous `db_ms` stall attribution.
- Shutdown keeps the same client available to admitted transactions and hooks. Its admission guard rejects unrelated calls during drain.
- Shutdown requires an acknowledgement and a successful Worker exit. Forced termination reports failure.
- Transport failure never permits replay, fallback, or automatic recovery. A lost COMMIT reply preserves an unknown outcome and suppresses both hook groups.
- Runtime prompt mutations and history use one bound client transaction. Separate boot helpers remain synchronous.
- Other Phase 2 and Phase 3 conversions remain deferred. No dependencies, deployment defaults, commits, pushes, or PRs were added.

## Raw-access audit

| Allowlisted path | Classification and result |
| --- | --- |
| `src/be/db-client.ts` | The synchronous driver owns statement execution. Worker mode invokes it inside the Worker. |
| `src/be/db/db-worker.ts` | Owns the Worker connection. This is the new raw-access exemption. |
| `src/be/db/runtime.ts` | Synchronous boot, migration compatibility, seeding, extension loading, and raw-handle lifecycle remain. |
| `src/be/db.ts` | Raw prompt listing and resolution remain. Boot-only prompt mutations retain separate names. Plaintext encryption uses an immediate boot transaction. |
| `src/be/migrations/runner.ts` | Boot migrations retain synchronous execution and immediate transactions. |
| `src/be/oauth-encryption-backfill.ts` | Boot-only encryption now invokes its raw transaction with `.immediate()`. |
| `src/be/connection-bindings-blob-migration.ts` | Boot-only migration now invokes its raw transaction with `.immediate()`. |
| `src/be/seed-pricing.ts` | Boot seeding already uses `.immediate()`. |
| `src/be/rbac-roles.ts` | Boot seed synchronization already uses `.immediate()`. Runtime role operations use the async client. |
| `src/be/boot-seeds.ts` | Reads raw handle identity to guard boot work. It does not execute runtime transaction SQL. |
| `src/be/asset-key-audit.ts` | Retains the synchronous startup audit. Runtime audit reads now use the bound async executor. |
| `src/be/memory/providers/sqlite-store.ts` | Mutation schema reads now use their transaction executor. Constructor DDL, vector population, health, and search-health counts remain synchronous. |
| `src/be/script-connections.ts` | Synchronous connection listing and generated-type helpers remain deferred. Mutation transactions use the client. |
| `src/http/db-query.ts` | The explicit administrator explorer retains its separate read-only executor. It does not measure this client. |
| `src/http/db-query-shared.ts` | Introspection and the explicit in-process explorer fallback remain synchronous. |
| `src/http/db-query-bounded.ts` | The explorer subprocess owns its independent connection. The parent reads the boot connection's filename. |

`src/http/assets.ts` no longer needs its raw-access exemption.
Session moves and asset audit HTTP requests use the async audit on the bound transaction.
The audit found no remaining direct raw read in the converted mutation callbacks.
Deferred helpers still execute synchronous runtime SQL. Worker mode therefore remains experimental.

## Verification commands

All test identities used valid UUIDs. Servers and containers used assigned free host ports.
External integrations used local mocks. No production swarm API calls or deployment changes occurred.
Earlier compiled smokes selected the default telemetry sink because their HTTP Docker-host override was invalid.
Test-tagged telemetry may have reached that sink. No ingestion receipt was captured.
The final smoke uses a valid container-loopback telemetry URL. Embeddings still use the local host mock.

| Command | Result |
| --- | --- |
| `bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts` | PASS: 132 tests, 660 assertions, including shutdown and chained-statement regressions on both drivers. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run check:local` | Final-source PASS: frozen install, changed-file lint, Oxlint, type checking, 12,615 passed, 24 skipped, zero failures, 73,717 assertions. Runtime: 168.78 seconds. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- --parallel=4` | PASS on the final source: 22,162 passed, 43 skipped, zero failures, 116,258 assertions across 1,467 files. Runtime: 304.73 seconds. |
| `bun run tsc:check:tsc` | PASS. |
| `bun run lint && bun run lint:slop` | PASS. Biome reports five existing warnings and four information messages. |
| `bash scripts/check-async-db-seam.sh && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:unit-test-allowlist` | PASS. Dependency checks report zero errors and 2,693 existing warnings. |
| `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts` | PASS. Both report zero findings. |
| `bun run docs:openapi` | PASS. Inspected generated changes: authenticated stats adds the required `dbDriver` enum. |
| `bun run e2e --list` | PASS. |
| `bun run e2e --json /tmp/db-worker-e2e-sqlite.json` | PASS: 154 scenarios, zero failures, zero flaky results. This preceded the authorized prompt conversion. |
| `bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-worker-e2e-sqlite-final.json` | PASS: 153 scenarios plus one successful retry. The Slack delegation reaction exceeded its first wait. |
| `bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-worker-e2e-worker-final.json` | PASS: 154 scenarios, zero failures, zero flaky results. Authenticated stats asserts `worker`. |
| `bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-worker-e2e-sqlite-closure.json` | Final-source PASS: 154 scenarios, zero failures, zero flaky results. |
| `bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-worker-e2e-worker-closure.json` | Final-source PASS: 154 scenarios, zero failures, zero flaky results. Authenticated stats asserts `worker`. |
| `bun run e2e:bench /tmp/db-worker-e2e-sqlite-final.json /tmp/db-worker-e2e-worker-final.json` | PASS. SQLite p50/p95: 0.65/14.16 ms. Worker: 2.04/31.98 ms. These runs shared host load. |
| `bun run e2e:bench /tmp/db-worker-e2e-sqlite-closure.json /tmp/db-worker-e2e-worker-closure.json` | PASS. SQLite p50/p95: 0.62/10.11 ms. Worker: 0.70/12.35 ms. Both suites ran concurrently. |
| `bun scripts/bench-db-worker.ts --driver sqlite --assert` | PASS. Uses production `getDbClient()`. Final measurements appear below. |
| `bun scripts/bench-db-worker.ts --driver worker --assert` | PASS. Uses production `getDbClient()`, with the raw boot connection still open. |
| `bun tsc --noEmit -p scripts/bench-db-worker.tsconfig.json` | PASS. |
| `bun scripts/bench-db-worker.ts --driver worker --case small_statements --json` | PASS. The original raw measurement path remains available. |
| `bun build --compile --compile-exec-argv='--expose-gc' scripts/bench-db-worker.ts scripts/bench-db-worker-thread.ts --external sqlite-vec --outfile /tmp/db-worker-raw-bench` | PASS. |
| `/tmp/db-worker-raw-bench --driver worker --case small_statements --json` | PASS. Preserves the compiled Phase 0 path. |
| `bun run test:root -- src/tests/db-task-read-contract.test.ts src/tests/db-task-write-contract.test.ts src/tests/memory*.test.ts` | PASS: 600 tests across 35 files. |
| `bun run test:root -- src/tests/memory-key-paths.test.ts` | PASS: 86 tests. |
| `bun run test:root -- src/tests/session-source-backfill.test.ts src/tests/sessions-move.test.ts src/tests/routing-decision-persistence.test.ts src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts` | PASS: 178 tests, 1,078 assertions before the final shutdown regression. |
| `bun run test:root -- src/tests/helper-credentials.test.ts src/tests/rbac-roles.test.ts src/tests/sealed-key-guard.test.ts src/tests/db-tasks-write.test.ts src/tests/fleet-benchmark.test.ts src/tests/scheduler-occurrence.test.ts` | PASS: 87 tests. |
| `bun run test:root -- src/tests/db-worker-driver.test.ts` | PASS: 14 tests, 38 assertions, including the final runtime drain regression. |
| `bun run e2e --only health,core-telemetry,platform-config,knowledge-prompt-templates,slack-http-mention --sut-env DB_DRIVER=worker --json /tmp/db-worker-targeted-final.json` | PASS: five scenarios. |
| `bun /tmp/db-worker-selection.ts` | PASS on both drivers. Legacy encrypted driver rows cannot override selection. New drain admissions reject. Invalid and production in-memory Worker configurations reject. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/entrypoint-chown-no-follow.test.ts src/tests/entrypoint-repo-clone-target.test.ts` | PASS: seven tests, 23 assertions. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/jira-outbound-sync.test.ts src/tests/asset-key-migration.test.ts src/tests/rbac-mcp-admission-e2e.test.ts src/tests/realtime-transport.test.ts` | PASS: 32 tests, 242 assertions. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/kv-http.test.ts` | PASS: 19 tests, 58 assertions, 567 ms. Explicit connection cleanup also passed in 600 ms. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/kv-http.test.ts src/tests/promote-draft-task-route.test.ts` | PASS: 27 tests, 87 assertions, 591 ms. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/mcp-input-caps.test.ts` | PASS: eight tests, 30 assertions, 1,009 ms. The chunked-upload assertion took 4.33 ms. |
| `PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH" TMPDIR=/private/tmp bun run test:root -- src/tests/script-connections-mcp.test.ts` | PASS: 16 tests, 57 assertions, 698 ms. |

### Production-client benchmark

Without `--assert`, `--driver sqlite|worker` retains the raw Phase 0 comparisons.
With `--assert`, the same flag selects the production client. This resolves the existing flag-name collision without another mode flag.
Run production assertions from source. The production API binary has its separate container verification.

| Driver | Execution ms | Round trip ms | Transport and scheduling ms | Main-thread lag ms |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 1008.691 | 1008.951 | 0.260 | 1008.170 |
| worker | 996.317 | 996.508 | 0.191 | 1.828 |

The final Worker telemetry assertion observed `db_ms=0 driver=worker worker_execution_ms=126`.
The telemetry assertion uses a separate synthetic main-thread stall after query sampling.
This stall does not enter the reported query lag or round-trip time.

### Compiled production API

Build commands use the real `Dockerfile` and an owned builder:

```bash
orb start
docker --context orbstack buildx create --name db-worker-phase1-final-owned --driver docker-container orbstack
docker --context orbstack buildx build --builder db-worker-phase1-final-owned --platform linux/arm64 --load -f Dockerfile -t agent-swarm-api:db-worker-phase1-final-arm64-owned .
bun /tmp/db-worker-compiled-smoke.ts agent-swarm-api:db-worker-phase1-final-arm64-owned linux/arm64
docker --context orbstack buildx build --builder db-worker-phase1-final-owned --platform linux/amd64 --load -f Dockerfile -t agent-swarm-api:db-worker-phase1-final-x64-owned .
bun /tmp/db-worker-compiled-smoke.ts agent-swarm-api:db-worker-phase1-final-x64-owned linux/amd64
```

Both final-source builds and corrected smoke tests passed. Both searches used hybrid vector retrieval and made 44 requests to the embedding mock.
Linux x64 runs through OrbStack emulation on this arm64 Mac. Native x64 execution was unavailable.
Both images embed `db-worker.ts` as the fourth compiled entrypoint.
The smoke starts an isolated compiled API and a deterministic local embedding mock.
It asserts authenticated stats reports `worker`, then writes and reads a task through HTTP.
It indexes memory and checks a populated 512-dimensional cosine vector table.
The search must return that memory with `vec` or `hybrid` retrieval.
Public health must omit `dbDriver`. The smoke removes its container and stops its mock in `finally`.

| Platform | Image ID | Uncompressed bytes |
| --- | --- | ---: |
| Linux arm64 | `c7b5640f237e2ce6efc281bddf1ac65488683955b3c1fc0abba4e1f6e47c30a9` | 459874055 |
| Linux x64 | `37b2021c842037b9391ae52ce7a1236dc0d20c25703287676793498094df3366` | 435160899 |

Image history showed the compiled API at 177 MB and Bun at 107 MB on both architectures.
An earlier x64 cold start exceeded the initial 90-second smoke budget.
The repeated and final smokes used a maximum ten-minute startup budget and passed.
This emulation result does not establish native x64 startup performance. The production Worker readiness timeout remains ten seconds.

### Failures and limits

- Worker E2E initially exposed the two raw prompt mutations. Taras authorized their conversion, and the full Worker suite passed afterward.
- The stricter transaction drain exposed a caught routing-audit insert failure. A nested savepoint now preserves its existing best-effort behavior.
- Final review found a drain race on both drivers. A statement continuation could admit a failed statement after the captured tail resolved.
- Before the fix, the transaction fulfilled and retained its first insert. The failed continuation reported `no such table: missing`.
- Drain now repeats until the tail remains unchanged. The same reproduction rejects and retains zero rows on both drivers.
- The existing seam case verifies this behavior for outer transactions and savepoints. No existing assertions changed.
- The first full run after that fix passed 22,162 tests but exceeded one KV cleanup hook's five-second budget.
- All 19 KV assertions passed before the cleanup timeout. The isolated file then passed in 567 ms without changes.
- The same cleanup timeout repeated during a full run. KV teardown now closes its owned HTTP connections before awaiting server closure.
- The body-cap response can leave an upload connection open. This cleanup preserves every assertion and timeout.
- That second full run also recorded eight draft-route `ECONNRESET` failures. The isolated KV and draft files passed together afterward.
- A subsequent full run passed 22,161 tests and timed out after five seconds in the existing user MCP chunked-upload cap assertion.
- Its isolated repetition passed all eight tests. The affected assertion took 4.33 ms. Its assertions and timeout remain unchanged.
- The final full repetition passed all 22,162 tests with zero failures. This includes the drain fix and explicit KV connection cleanup.
- One affected-test run returned HTTP 404 instead of a mock's JSON-RPC error envelope. It passed 12,614 tests and failed that assertion.
- The isolated MCP discovery file passed all 16 tests without changes.
- That affected repetition timed out after ten seconds in the existing agent MCP chunked-upload cap assertion.
- It passed 12,614 tests and failed that single assertion. The same file passed in isolation and during the final full suite.
- A historical memory note from November 5 records the same MCP upload-cap timeout with an eight-test isolated pass.
- This historical note corroborates the baseline pattern. The current full-suite and isolation results above provide fresh evidence.
- The final idle affected check passed all 12,615 tests. Both upload-cap cases and the discovery envelope assertion passed unchanged.
- Existing asset audit spies needed the async audit entrypoint. Their call counts and failure assertions remain intact.
- Frozen export manifests now include readiness, effective-driver reporting, and the separate boot prompt helpers.
- A memory race test intercepted the client's internal transaction yield. Its interception now targets the intended boundary between purge batches.
- macOS `realpath` rejects the entrypoint's GNU `-m` option. The installed GNU tools and canonical temporary path made both unchanged test files pass.
- Concurrent builds coincided with failures in Jira's fixed 10 ms waits and a historical migration's five-second test budget.
- The loaded full run also recorded an RBAC audit count mismatch, a realtime server startup timeout, and a runner child timeout.
- The isolated Jira, migration, RBAC, and realtime repetition passed all 32 tests. The full repetition without concurrent builds passed all 22,162 tests.
- The new transport reopen test exceeded its default five-second setup budget under load. It now uses the existing 35-second subprocess test budget.
- That setup budget covers fresh file migrations and Worker startup. Transaction deadline checks and Worker transport timeouts remain unchanged.
- An early x64 build hit a BuildKit cache-reference error. A repeated owned build passed.
- One x64 startup exceeded the smoke's 90-second wait during heavy host load. Its repeated smoke passed before the final build.
- Existing dependency warnings and lint warnings remain. No assertions, retry budgets, savepoint tests, deadline tests, or hook checks were weakened.

## Review and cleanup

QA Doc: n/a. The plan has no linked QA specification.
Taras's one-time review of `DbWorkerRequest` and `DbWorkerMessage` remains a manual item.
The parent must record that review. This report does not claim that it occurred.

Exact changed paths: `2026-11-15-worker-sqlite-phase1-changed-paths.txt` beside this report.
Most test changes await asynchronous closure before cleanup or reopening.
Original untracked benchmark fixtures and thought files remain preserved.

Initial available space: 16 GiB from `df -h /`.
Only owned resources may be removed. Shared caches, `node_modules`, and unrelated services remain untouched.
The owned builder and two images were removed. OrbStack returned to its original stopped state.
The final build used a separate owned builder and explicit local Docker context. Its builder and images were also removed.
Available space changed from 8.0 GiB before this cleanup to 17 GiB afterward.
These are observed host values. Concurrent host work can also affect free space.
Cleanup queried configured builder statuses through `docker buildx ls`, which also listed a configured remote builder. No remote builder changes occurred.

Final cleanup removed 199 owned temporary entries, including the raw benchmark binary and seven stale seam fixture directories. No entries remain under those task prefixes.
Final temporary-file cleanup showed 17 GiB available before and after, at `df -h` rounding.
The parent shell's `HOME` and `CODEX_HOME` were not changed. The existing E2E runner removed its isolated child homes and credentials.
No shared cache, `node_modules`, original untracked source, or unrelated service was removed.

## Reproducible compiled smoke

Save this script as `/tmp/db-worker-compiled-smoke.ts` for the commands above.
It uses synthetic credentials and owns its mock, container, and database.

```typescript
const image = process.argv[2];
const platform = process.argv[3] ?? 'linux/arm64';
const container = `db-worker-compiled-${platform.endsWith('amd64') ? 'x64' : 'arm64'}-${crypto.randomUUID().slice(0, 8)}`;
let created = false;
const agentId = crypto.randomUUID();
const key = 'db-worker-local-test';
let embeddingRequests = 0;
const mock = Bun.serve({
  hostname: '0.0.0.0', port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== '/v1/embeddings') return Response.json({ok:true});
    embeddingRequests++;
    const body = await req.json() as {input:string|string[],model:string};
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({object:'list',model:body.model, data: inputs.map((_,index)=>({object:'embedding',index,embedding:[1,...Array(511).fill(0)]})),usage:{prompt_tokens:1,total_tokens:1}});
  }
});
async function docker(args:string[]) {
  const proc = Bun.spawn(['docker','--context','orbstack',...args], {stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if(code) throw new Error(`docker ${args[0]} failed (${code}): ${stderr}`);
  return stdout.trim();
}
try {
  await docker(['run','--platform',platform,'-d','--name',container,
    '-e','DB_DRIVER=worker','-e','DESPLEGA_TELEMETRY_ENV=test',
    '-e',`AGENT_SWARM_API_KEY=${key}`,'-e','DATABASE_PATH=/tmp/db-worker.sqlite',
    '-e','SLACK_DISABLE=true','-e','GITHUB_DISABLE=true','-e','JIRA_DISABLE=true','-e','LINEAR_DISABLE=true',
    '-e','AGENTMAIL_DISABLE=true','-e','MULTI_RUNTIME_ENABLED=false',
    '-e','EMBEDDING_API_KEY=db-worker-mock-key',
    '-e',`EMBEDDING_API_BASE_URL=http://host.docker.internal:${mock.port}/v1`,
    '-e',`DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:${mock.port}/telemetry`,
    '-p','127.0.0.1::3013',image]);
  created = true;
  const port = (await docker(['port',container,'3013/tcp'])).split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  async function api(path:string, body?:unknown, authenticated=true) {
    const response = await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{...(authenticated?{Authorization:`Bearer ${key}`,'X-Agent-ID':agentId}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result = await response.json();
    if(!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
    return result as any;
  }
  let healthy=false;
  const startupAttempts = platform === 'linux/amd64' ? 1200 : 180;
  for(let i=0;i<startupAttempts;i++) {
    try {await api('/health',undefined,false);healthy=true;break;} catch {await Bun.sleep(500);}
  }
  if(!healthy) throw new Error('compiled API did not become healthy');
  const stats = await api('/api/stats');
  if(stats.dbDriver!=='worker') throw new Error(`incorrect effective driver ${stats.dbDriver}`);
  const health = await api('/health',undefined,false);
  if('dbDriver' in health) throw new Error('public health leaks driver');
  await api('/api/agents',{name:`compiled-${platform.split('/')[1]}`,isLead:true});
  const task = await api('/api/tasks',{task:'Compiled Worker persistence smoke'});
  const read = await api(`/api/tasks/${task.id}`);
  if(read.task!==task.task || read.id!==task.id) throw new Error(`task read mismatch ${JSON.stringify(read)}`);
  const indexed = await api('/api/memory/index',{agentId,name:'Compiled Worker vector smoke',content:'Compiled Worker vector acceptance document with an isolated deterministic embedding.',scope:'swarm',source:'manual'});
  let memoryHealth:any;
  for(let i=0;i<120;i++) {
    memoryHealth=await api('/api/memory/health');
    if(memoryHealth.counts?.memoryVec>=1) break;
    await Bun.sleep(250);
  }
  if(memoryHealth.retrievalMode!=='vec' || memoryHealth.counts?.memoryVec<1) throw new Error(`vector population failed ${JSON.stringify(memoryHealth)}`);
  const search = await api('/api/memory/search',{query:'Compiled Worker vector acceptance document',scope:'swarm',limit:5});
  const found=search.results?.find((row:any)=>indexed.memoryIds.includes(row.id));
  if(!found || !['vec','hybrid'].includes(found.retrievalSource)) throw new Error(`vector retrieval failed ${JSON.stringify(search)}`);
  console.log(JSON.stringify({platform,image,dbDriver:stats.dbDriver,taskWriteRead:true,vector:memoryHealth,retrievalSource:found.retrievalSource,embeddingRequests},null,2));
} catch(error) {
  console.error(String(error));
  if (created) console.error((await docker(['logs',container]).catch(String)).slice(-12000));
  process.exitCode=1;
} finally {
  mock.stop(true);
  if (created) await docker(['rm','-f',container]).catch(()=>{});
}
```

## Final Phase 1 verification after review corrections, 2026-11-16 BCN

Status: automated verification completed. The parent owns plan checkboxes and Phase 1 closure.
This task performed verification only. It started no later phase and changed no implementation or assertion.
HEAD remained `556461bfc0e2249991eab35df5c606ed5813ad1f`.
All four supplied SHA-256 values matched before verification and after all workloads.

```text
6a4bd0a729404da4bc7277fc4b48269e96de63deb1d3087ba64ae1626e8ed1f3  scripts/db-promise-analysis.ts
21a1c3242a76f2a96d0169b8818dd01e6bb1102747cfb56a629f2fc73d6b9c03  src/tests/db-promise-analysis.test.ts
b38ac7f1e25e0db003fa94d0ec02f03b3bb5bcf7a8731a27e5f0b822f83e7f12  src/be/db-client.ts
ccc8b87d50073bf83eb5a9a73c2713534dc067b6be338cb7299865e12d27f8fd  src/be/db/runtime.ts
```

The task read the current report, Phase 1 plan, testing runbook, CI runbook, and LOCAL_TESTING.md.
The approved native caught-error contract remained unchanged.
Heavy suites, benchmarks, builds, and compiled smokes ran sequentially.
No raw Phase 0 benchmark ran. No subagent, commit, push, PR, production access, or production telemetry was used.

### Commands and environment

All commands used these values:

```bash
export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
export TMPDIR=/private/tmp
export BUSINESS_USE_API_KEY=
export DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events
export DESPLEGA_TELEMETRY_ENV=test
NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events DESPLEGA_TELEMETRY_ENV=test bun scripts/probe-db-transaction-errors.ts
```

The probe validated loopback telemetry before database initialization. Full and affected suites removed the inherited telemetry tag.
The commands below use `run <label> <command>` to capture output and stop on failure.
Labels identify evidence logs. They do not change the invoked command.

```bash
run corpus bun run test:root -- src/tests/db-promise-analysis.test.ts
run focused bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts src/tests/routing-decision-persistence.test.ts src/tests/workflow-http-v2.test.ts src/tests/memory*.test.ts src/tests/realtime-transport.test.ts src/tests/checklist.test.ts
run floating bun scripts/check-floating-promises.ts
run sinks bun scripts/check-promise-sinks.ts
run typecheck bun run tsc:check:tsc
run lint bun run lint
run oxlint bun run lint:slop
run seam bash scripts/check-async-db-seam.sh
run boundary bash scripts/check-db-boundary.sh
run api-key bash scripts/check-api-key-boundary.sh
run depgraph bun run check:dep-graph
run allowlist bun run check:unit-test-allowlist
run affected env -u DESPLEGA_TELEMETRY_ENV bun run check:local
run root env -u DESPLEGA_TELEMETRY_ENV bun run test:root -- --parallel=4
run e2e-sqlite bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-final-20261116/e2e-sqlite.json
run e2e-worker bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-final-20261116/e2e-worker.json
run compare bun run e2e:bench /tmp/db-final-20261116/e2e-sqlite.json /tmp/db-final-20261116/e2e-worker.json
run bench-sqlite env NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/bench-db-worker.ts --driver sqlite --assert
run bench-worker env NODE_ENV=test SECRETS_ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111 bun scripts/bench-db-worker.ts --driver worker --assert
```

Additional commands:

```bash
env -u DESPLEGA_TELEMETRY_ENV bun run test:root -- src/tests/mcp-input-caps.test.ts
env -u DESPLEGA_TELEMETRY_ENV bun run test:root -- --parallel=4
bun tsc --noEmit -p /tmp/db-final-20261116/tooling.json
bun run docs:openapi
git diff --check
```

The temporary tooling configuration extended the root tsconfig and enabled excluded tooling paths.
It included the analyzer, floating-promise checker, and analyzer corpus, with repository type roots.
No dependency or runtime configuration changed.

### Fresh results

| Check | Outcome |
| --- | --- |
| Semantic probe | PASS: 24 checks across both drivers. |
| Static corpus | PASS: 96 cases, 220 assertions, 3.16 seconds. |
| Focused runtime suite | PASS: 850 tests, 3,909 assertions across 42 files, 92.58 seconds. |
| Static checks | PASS: floating promises, promise sinks, both typechecks, Biome, Oxlint, seam, DB boundary, API-key boundary, dependency graph, and unit-test allowlist. |
| Existing static diagnostics | Biome retained five warnings. Dependency analysis retained 2,693 warnings and zero errors. |
| Affected checks | PASS: 12,730 passed, 24 skipped, zero failed, 74,068 assertions across 746 files, 161.07 seconds. |
| First full root run | 22,276 passed, 43 skipped, one failed, 116,584 assertions across 1,468 files, 304.94 seconds. |
| Isolated failure file | PASS: eight tests, 30 assertions, 617 ms. |
| Final full root run | PASS: 22,277 passed, 43 skipped, zero failed, 116,581 assertions across 1,468 files, 303.38 seconds. |
| SQLite black-box | PASS: 155 scenarios, zero failures, zero skips, zero flaky results. p50/p95 0.62/11.18 ms across 4,830 calls. |
| Worker black-box | PASS: 155 scenarios, zero failures, zero skips, zero flaky results. p50/p95 0.67/10.80 ms across 4,837 calls. |
| Black-box comparison | PASS. Both runs covered 505 routes, 192 MCP tools, and 15 workflow node types. |
| OpenAPI | PASS: generated files remained byte-identical. Existing diff adds authenticated stats dbDriver only. |
| Whitespace | PASS. |

The first root run timed out in `agent MCP input caps > a chunked body that crosses the cap gets 413`.
Its existing five-second limit expired. The isolated file then passed all eight tests.
Only after isolation did the task repeat the full suite. That repetition passed.
The exact timeout cause remains unproven. No test, assertion, timeout, retry setting, or implementation changed.

### Production-client benchmarks

| Driver | Execution ms | Round trip ms | Transport and scheduling ms | Main-thread lag ms |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 991.393375 | 991.577750 | 0.184375 | 991.004167 |
| worker | 997.878917 | 998.094125 | 0.215208 | 2.553833 |

Both assertion commands passed. Worker lag remained below 50 ms.
Worker attribution reported `db_ms=0 driver=worker worker_execution_ms=127` in its calibration sample.
SQLite attribution reported `db_ms=991` for the blocking statement.

### Compiled API verification

```bash
orb start
docker --context orbstack buildx create --name db-final-20261116-owned --driver docker-container orbstack
docker --context orbstack buildx build --builder db-final-20261116-owned --platform linux/arm64 --load -f Dockerfile -t agent-swarm-api:db-final-20261116-arm64-owned .
bun /tmp/db-final-20261116/smoke.ts agent-swarm-api:db-final-20261116-arm64-owned linux/arm64
docker --context orbstack buildx build --builder db-final-20261116-owned --platform linux/amd64 --load -f Dockerfile -t agent-swarm-api:db-final-20261116-amd64-owned .
bun /tmp/db-final-20261116/smoke.ts agent-swarm-api:db-final-20261116-amd64-owned linux/amd64
```

The smoke used the reproducible recipe in this report with the task prefix and agent-scoped manual memory.
It validated host-loopback telemetry before boot. Each container used container-loopback telemetry, NODE_ENV=test, synthetic encryption, and an empty business-use key.
Each identity used a UUID. The task fixture was unassigned and valid.
Both smokes passed Worker selection, task write/read, active 512-dimension vectors, and hybrid retrieval of the indexed memory.
Public health omitted dbDriver. Each smoke removed its container and stopped its mock in finally.
The native mock received 44 embedding requests. The emulated mock received 45.
No existing volume or database entered either container.

| Platform | Image SHA-256 | Bytes | Result |
| --- | --- | ---: | --- |
| Native Linux arm64 | f69142a0f22e9c08503f888f48e58c434c4980b44457cafc3f03de7585aa23f2 | 459939587 | PASS |
| Emulated Linux x64 | 13cad4cb354f37478e6bbc78d458f6c2e58d5aa4b8cf787b4527fc7a3642c3a0 | 435164995 | PASS |

The host is arm64. The x64 result covers emulation, not native x64 hardware.
These checks do not establish production deployment behavior or performance.

### Final cleanup and handoff

The task removed its builder and both images, then restored OrbStack to its initial stopped state.
Both smoke containers removed themselves. Their local mock servers stopped.
No configured remote builder was enumerated. No shared cache or dependency directory was deleted.
The root package has no clean command.

```bash
docker --context orbstack buildx rm db-final-20261116-owned
docker --context orbstack image rm agent-swarm-api:db-final-20261116-arm64-owned agent-swarm-api:db-final-20261116-amd64-owned
orb stop
orb status
df -h /
```

Initial `df -h /` availability was 20 GiB. Before container startup, availability was 18 GiB.
Immediately before cleanup, availability was 9.6 GiB. After cleanup, availability was 18 GiB.
The cleanup measurements were 10,093,712 and 18,704,004 KiB available.
The observed increase was 8.21 GiB. Other system activity can affect these measurements.
No shared-cache cleanup attempted to recover the difference from the initial reading.

The task deleted its `/tmp/db-final-20261116/` directory and `/tmp/db-final-read-runbooks.txt` after preserving this evidence.
That directory contained only owned logs, JSON results, temporary scripts, and tooling configuration.
The cumulative manifest matches all 680 actual current paths. It contains no stale or missing path.
The manifest retains the parent's existing changes and does not assign their ownership to this task.
The only task-owned durable edit is this appended evidence section. The refreshed manifest retains the same path set.
Generated OpenAPI files remained byte-identical. Final whitespace validation passed.
The parent retains the protocol review, plan bookkeeping, Phase 1 closure decision, and eventual PR work.
