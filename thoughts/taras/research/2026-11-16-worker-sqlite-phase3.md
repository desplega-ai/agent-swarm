# Worker SQLite Phase 3 evidence

Status: implementation, parent review corrections, and final verification completed. Parent accepts the Phase 3 automated gate.
Initial verification passed before independent reviews found the issues below. Fresh verification of the corrected source appears at the end.
Manual protocol review remains unconfirmed. Parent owns Git publication and the remaining Phase 4 work.

Base HEAD: `556461bfc0e2249991eab35df5c606ed5813ad1f`.
Branch: `t3/research-async-database-options`.
Only Phase 3 changed. No plan edits, subagents, commits, publication, containers, or Phase 4 work.

## Review corrections, 2026-11-16

Both independent reviews examined patch `7e9c1086334989e17f3809853321cbe4329346fbee1fac55dbb47e2aa9b9fecc`.

### Standards

Initial verdict: changes required, with two Important findings and one Minor finding.
Shutdown could wait indefinitely for store work after client closure timed out.
Related health counts lacked a consistent snapshot.
The readiness probe accepted fulfilled operations after its gate rejected.

### Spec

Initial verdict: fail, with two Important findings and one Minor finding.
FTS synchronization swallowed write failures, so source edits could commit with stale index content.
Schema validation accepted an ordinary table with the expected columns.
The Spec review also reproduced inconsistent health counts, including negative missing-vector counts.

### Parent resolution

FTS synchronization now propagates its original error. The enclosing transaction rolls back source, version, and index changes together.
Schema readiness requires a virtual table and executes an FTS5 query using MATCH and rank.
The health method reads its schema and related counts within one read-only transaction.
Stopping a store rejects queued readiness immediately.
Runtime shutdown joins store work after successful client closure. It preserves the client's timeout when closure fails.
The readiness probe now fails explicitly if an operation fulfills after readiness rejects.

The durable acceptance probe adds failed store, edit, and scrub writes, ordinary-table rejection, a competing health mutation, and forced shutdown.
Both drivers passed the corrected probe with 20,000 embeddings and 19 individual readiness gates.
They also passed optional-vector absence checks.
A temporary mutation swallowed a readiness error. The corrected assertion rejected that mutation at the intended check.

| Driver | First search ms | Population interval ms | Maximum main-thread delay ms | Vector batch transactions |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 72.64 | 954.12 | 32.74 | 41 |
| worker | 136.17 | 1623.04 | 20.50 | 41 |

These measurements are single-run acceptance evidence, not production performance approval.
The corrected memory suites passed 254 tests and 1,429 assertions.
Direct probe typechecking, both promise checks, Biome, whitespace, and patch reverse-apply validation passed.
No production behavior changed outside these corrections. Best-effort embedding updates remain unchanged.
These are parent resolutions, not claims of independent approval after the edits.

The parent used the synthetic environment and local metadata fixture documented below.
Focused commands:

```sh
DB_DRIVER=sqlite bun --no-env-file scripts/probe-memory-worker.ts
DB_DRIVER=worker bun --no-env-file scripts/probe-memory-worker.ts
DB_DRIVER=sqlite bun --no-env-file scripts/probe-memory-worker.ts --optional-vec
DB_DRIVER=worker bun --no-env-file scripts/probe-memory-worker.ts --optional-vec
bun x --no-install tsc --noEmit -p <owned-temporary-directory>/tsconfig.json
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bun run test:root -- src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-search-stall.test.ts src/tests/memory-fts-populate.test.ts src/tests/memory-key-paths.test.ts src/tests/memory-embedding-space.test.ts
bunx --no-install biome check src/be/memory/providers/sqlite-store.ts src/be/db/runtime.ts scripts/probe-memory-worker.ts
git diff --check
git apply --reverse --check thoughts/taras/research/2026-11-16-worker-sqlite-phase3.patch
```

Final source SHA-256 values for subsequent verification:

```text
341bb5fbff14fd8bfa7db9974c62e8e85ac188f6957b4b1e283ec88355011bb6  src/be/memory/providers/sqlite-store.ts
8073e21f2d584ea50066d8a9cec62349cecce9d4550bd72a1d18cd0004ca0284  src/be/db/runtime.ts
fa5fd841b7d79fd07bbbef210d5c42d0b51aa1a9add4af225df21ebbf303daa0  scripts/probe-memory-worker.ts
```

The current incremental patch includes the corrections and still covers 35 paths.
Current patch SHA-256: `4e137863ef9eb8f9a686ec7dc69a8ba757496e7311b1cd4368553b2a61d3a83d`.
Current patch size: 102,148 bytes. Earlier patch metadata below records the original implementation reviewed by both agents.
Parent cleanup removed 872 KiB of owned logs, baseline copies, mutation fixtures, and temporary configuration.
Available space increased from 14,940,660 KiB to 14,941,484 KiB, an observed increase of 824 KiB.
Probe databases removed themselves. No owned process remains. OrbStack stayed stopped and shared caches remained unchanged.

## Contracts

- Construction performs no SQL. Public database methods await schema readiness. Population has separate vector and FTS promises.
- Readiness rejects inside transactions, including initialization already pending behind the caller's lock.
- Existing commit hooks start initialization outside transaction context. Startup and transaction-dependent service callers await readiness.
- Both populations yield. Each vector batch reads current source rows and writes index rows within one transaction, with at most 500 source rows.
- Runtime writes maintain indexes while cursors advance. FTS mutations remain atomic with source mutations.
- Incomplete vector indexes use source fallback. Keyword-only search awaits FTS completion.
- Schema failures reject readiness with the original error. Readiness validates required FTS columns because SQLite accepts incompatible views with `IF NOT EXISTS`.
- Optional vector absence degrades retrieval. Independent population failures appear in health and retain their original errors.
- Stores and cached health belong to actual connection/client identities. Closure cancels future batches and drains admitted work before closure completes.
- Reopen creates a fresh singleton. Stale stores cannot acquire the reopened connection, including stores constructed before closure without initialization.
- Existing embedding updates retain their best-effort behavior. The transaction contract, static ownership enforcement, transport guarantees, and default `DB_DRIVER=sqlite` remain unchanged.

## Automated verification

Required memory command:

```bash
bun run test:root -- src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-search-stall.test.ts src/tests/memory-fts-populate.test.ts src/tests/memory-key-paths.test.ts src/tests/memory-embedding-space.test.ts
```

Result: 254 passed, zero failures, 1,429 assertions, eight files, 2.53 seconds.

`bun run test:root -- --parallel=4`: 22,277 passed, 43 skipped, zero failures, 116,595 assertions, 1,468 files, 306.03 seconds.
This final run includes the malformed-schema readiness validation.

Lifecycle command:

```bash
bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/api-drain.test.ts src/tests/api-drain-e2e.test.ts src/tests/api-drain-worker-e2e.test.ts src/tests/runner-api-drain.test.ts src/tests/runtime-cache-cleanup.test.ts
```

Result: 190 passed, zero failures, 933 assertions, eight files, 91.05 seconds.
This covers admission, caught errors, pending work, transport loss, uncertain COMMIT, stale clients, and shutdown.

`bun run check:local`: passed frozen install, changed-file Biome, anti-slop, Bun type checking, and affected tests.
Affected tests: 14,869 passed, 29 skipped, zero failures, 80,407 assertions, 835 files, 191.72 seconds.

| Final check | Result |
| --- | --- |
| `bun run tsc:check:tsc` | Passed |
| `bun run lint` | Passed, five existing warnings and four existing informational findings |
| `bash scripts/check-async-db-seam.sh` | Passed without the sqlite-store exemption |
| `bun scripts/check-floating-promises.ts` | Zero findings |
| `bun scripts/check-promise-sinks.ts` | Zero findings |
| `bun run check:unit-test-allowlist` | Passed, no new unit tests |
| `git diff --check` | Passed |
| Literal `getDb()` count in `sqlite-store.ts` | Zero |
| Direct probe TypeScript and Biome checks | Passed |

The standalone probe typecheck extends the repository configuration with explicit Bun type roots and includes ambient template/SDK declarations.
Commands: `bun tsc --noEmit --project /private/tmp/worker-sqlite-phase3/probe-tsconfig.json` and `bunx --no-install biome check scripts/probe-memory-worker.ts`.
Lint findings occur in unchanged codex-skill-resolver tests, page fixtures, and seed-script tests.

Black-box commands:

```bash
bun run e2e --only knowledge-memory --sut-env DB_DRIVER=sqlite --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-phase3/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-phase3/target-sqlite.json
bun run e2e --only knowledge-memory --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-phase3/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-phase3/target-worker.json
bun run e2e --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-phase3/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-phase3/e2e-worker.json
```

| Driver and scope | Result | API calls | p50 / p95 |
| --- | --- | ---: | ---: |
| sqlite, knowledge-memory | One scenario passed, zero failures/skips/flakes | 97 | 2.73 / 7.32 ms |
| worker, knowledge-memory | One scenario passed, zero failures/skips/flakes | 97 | 4.53 / 31.86 ms |
| worker, full suite | 155 scenarios passed, zero failures/skips/flakes | 4,856 | 0.66 / 10.81 ms |

Wall durations: sqlite target 7.317 seconds, Worker target 7.784 seconds, full Worker suite 409.865 seconds.
The full runner reports routes 505/505, MCP tools 192/192, workflow types 15/15, and CLI commands 14/20.
The updated public scenario asserts committed health counts, health freshness after deletion, and removal of deleted FTS rows.

All root and affected suites unset inherited `DESPLEGA_TELEMETRY_ENV`. Their harness controls boot tags.
Commands use GNU coreutils, `/private/tmp`, an empty business-use key, and a loopback telemetry endpoint.
Explicit test boots use `DESPLEGA_TELEMETRY_ENV=test`. Black-box SUTs retain their runner-owned telemetry sinks.
A temporary Bun preload intercepts only `models.dev` with a synthetic 503 response:

```typescript
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "models.dev") {
    return Promise.resolve(new Response("Phase 3 catalog fixture", { status: 503 }));
  }
  return originalFetch(input, init);
}, originalFetch);
```

Root checks use `BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-phase3/network-guard.ts`.
Black-box commands pass that option explicitly through `--sut-env`, alongside an empty business-use key and the test boot tag.

## Synthetic acceptance

Command prefix:

```bash
PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH \
TMPDIR=/private/tmp BUSINESS_USE_API_KEY= \
DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events \
DESPLEGA_TELEMETRY_ENV=test NODE_ENV=test DB_DRIVER=<sqlite|worker> \
bun --no-env-file scripts/probe-memory-worker.ts
```

Each driver uses real file databases without migration-template substitution. Each fixture has 20,000 synthetic, 512-dimensional embeddings.
The probe pauses vector population after its first batch and pauses FTS population during its first source scan.
First search returns the correct source fallback while both populations remain paused.
Concurrent changes include embedding replacement, content replacement, deletion, and a UUID insertion behind the vector cursor.
Final checks prove exact source/vector/FTS counts, unique FTS IDs, current FTS content, and vector equality with source embeddings.

| Driver | First search | Population interval | Maximum main-thread delay | Vector batch transactions |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 73.97 ms | 790.06 ms | 32.30 ms | 41 |
| worker | 139.40 ms | 1598.28 ms | 16.97 ms | 41 |

The interval includes paused population, search, and concurrent mutations. The final transaction observes the empty cursor.
These single-run measurements demonstrate responsiveness. They do not establish a production latency or memory budget.

Both drivers also pass schema failure identity, malformed schema, independent vector/FTS failure health, fallback, pending initialization, shutdown, and reopen checks.
Nineteen public operations each receive an individual readiness gate. Instrumentation proves zero database calls and no settlement before each gate releases.
After release, every operation returns the original gate error without database access. Aggregate completion alone supplies no ownership evidence.
Construction separately instruments all four client operation methods and proves zero calls.

`--optional-vec` passes on both drivers. It disables extension loading on both actual connections and verifies degraded health plus correct fallback.
The Worker probe asserts the effective driver and a maximum main-thread delay below 50 ms.

## Failed attempts and resolutions

- The first focused memory run passed 251 tests and failed three path assertions before FTS population completed. Explicit population waits fixed these assertions.
- Static analysis initially found five ownership findings around stored initialization/population promises. Existing commit hooks resolved ownership without checker exemptions or weaker rules.
- An initial UUID probe attempted a raw primary-key update and hit a version foreign-key constraint. The corrected probe uses public UUID insertions.
- That failed probe retained its paused population latch during cleanup. Cleanup now releases owned latches before closing the database.
- An initial sqlite probe could not load vectors through Apple's SQLite. The probe now selects the standard Homebrew SQLite library before opening connections.
- An early root run passed 22,261 tests, skipped 43, and failed 16. Keyword readiness, population-sensitive path assertions, and task-learning initialization required correction.
- An isolated instrumentation check missed transaction-bound FTS deletes. Instrumentation now wraps the transaction executor. All original assertions remain.
- One root run was intentionally cancelled to include the stale, never-initialized store guard. It supplies no passing evidence.
- A temporary probe typecheck lacked Bun type roots. Explicit repository type roots corrected that configuration.
- The final malformed-schema probe initially fulfilled readiness because SQLite accepted an existing view. Required-column validation now rejects the original database error.

Failed runs were isolated before broad suites repeated. Existing assertions, timeouts, and retries remain intact.

## Incremental patch and preserved work

Per-file baselines were captured before edits. The patch compares final files with those baselines, including shared files from earlier phases.
Actual reverse application in an isolated directory restored every baseline byte and removed the new probe.
`git apply --reverse --check thoughts/taras/research/2026-11-16-worker-sqlite-phase3.patch` also passed directly against the final workspace.

- Patch: `thoughts/taras/research/2026-11-16-worker-sqlite-phase3.patch`.
- Patch SHA-256: `7e9c1086334989e17f3809853321cbe4329346fbee1fac55dbb47e2aa9b9fecc`.
- Patch contains 35 files and 89,465 bytes. It excludes this evidence file and all earlier changes.
- Phase 2 patch remains `921589703d1a65af41b41145fe25f24430356770c7df713b86da38cba1182577`.

Exact changed implementation, documentation, scenario, probe, and test paths:

- `runbooks/memory-system.md`.
- `scripts/check-async-db-seam.sh`.
- `scripts/e2e/scenarios/knowledge-memory.ts`.
- `scripts/probe-memory-worker.ts`.
- `src/be/boot-scrub-sweep.ts`.
- `src/be/db/runtime.ts`.
- `src/be/memory/embedding-space.ts`.
- `src/be/memory/index.ts`.
- `src/be/memory/providers/sqlite-store.ts`.
- `src/be/memory/task-learning.ts`.
- `src/be/memory/types.ts`.
- `src/http/memory.ts`.
- `src/tests/memory-chunked-search-starvation.test.ts`.
- `src/tests/memory-e2e.test.ts`.
- `src/tests/memory-edges.test.ts`.
- `src/tests/memory-edit.test.ts`.
- `src/tests/memory-fts-populate.test.ts`.
- `src/tests/memory-graph-expansion.test.ts`.
- `src/tests/memory-graph-organic-route.test.ts`.
- `src/tests/memory-hybrid.test.ts`.
- `src/tests/memory-injection-outcome.test.ts`.
- `src/tests/memory-key-paths.test.ts`.
- `src/tests/memory-link-resolver.test.ts`.
- `src/tests/memory-prompt-recall-crowdout.test.ts`.
- `src/tests/memory-rate-endpoint.test.ts`.
- `src/tests/memory-rater-e2e.test.ts`.
- `src/tests/memory-rater-implicit-citation.test.ts`.
- `src/tests/memory-rater-llm.test.ts`.
- `src/tests/memory-rater-store.test.ts`.
- `src/tests/memory-search-stall.test.ts`.
- `src/tests/memory-store.test.ts`.
- `src/tests/memory-usefulness-endpoint.test.ts`.
- `src/tests/memory.test.ts`.
- `src/tests/scrubbed-text-12e.test.ts`.
- `src/tests/self-improvement.test.ts`.

## Cleanup and limits

Removed 336.17 MiB of owned temporary files across the task directory and two failed-probe directories.
Logs were deleted first. Baselines, databases, probe outputs, guards, and reverse-check copies were deleted after their results entered this note.
The black-box runner had already removed its reported SUT databases and logs. No owned process remains.

| Disk check | Before cleanup | After cleanup |
| --- | ---: | ---: |
| `df -h /`, available | 14 GiB | 15 GiB |
| `df -k /`, available | 14,963,452 KiB | 15,311,052 KiB |

Measured available space increased 339.45 MiB. Filesystem activity can affect this net measurement.
No containers, emulators, separate development servers, or watchers were started. OrbStack was not started.
Shared caches and `node_modules` were preserved.
QA Doc status: not applicable. This phase has no linked QA specification or manual verification item.
No independent review approval is claimed. Parent must run both review axes and decide the phase gate.
Phase 1's manual protocol review remains unconfirmed under autopilot.
Production rollout, default-driver changes, packaging repetition, and Phase 4 remain outside this task.


## Final verification after parent corrections, 2026-11-16

Result: completed. All requested verification commands exited zero on corrected source.
This section records fresh integration results. Earlier results and review history remain separate above.
The parent retains phase closure, manual protocol review, Phase 4, and PR ownership.
The verifier read the parent corrections first, then the plan and all four required runbooks.
HEAD remained `556461bfc0e2249991eab35df5c606ed5813ad1f` before and after verification.
The incremental Phase 3 patch defines scope. The cumulative dirty tree was not treated as Phase 3.

### Exact environment and sequential commands

```sh
export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
export TMPDIR=/private/tmp
export BUSINESS_USE_API_KEY=
export DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events
unset DESPLEGA_TELEMETRY_ENV
export BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-final/network-guard.ts
bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/api-drain.test.ts src/tests/api-drain-e2e.test.ts src/tests/api-drain-worker-e2e.test.ts src/tests/runner-api-drain.test.ts src/tests/runtime-cache-cleanup.test.ts
tsc bun run tsc:check:tsc
lint bun run lint
seam bash scripts/check-async-db-seam.sh
allowlist bun run check:unit-test-allowlist
local bun run check:local
root bun run test:root -- --parallel=4
target-sqlite bun run e2e --only knowledge-memory --sut-env DB_DRIVER=sqlite --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-final/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-final/target-sqlite.json
target-worker bun run e2e --only knowledge-memory --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-final/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-final/target-worker.json
e2e-worker bun run e2e --sut-env DB_DRIVER=worker --sut-env BUN_OPTIONS=--preload=/private/tmp/worker-sqlite-final/network-guard.ts --sut-env BUSINESS_USE_API_KEY= --sut-env DESPLEGA_TELEMETRY_ENV=test --json /private/tmp/worker-sqlite-final/e2e-worker.json
```

The preload used the synthetic models.dev 503 fixture documented above.
Black-box SUTs retained their runner-owned loopback telemetry endpoint and received the preload explicitly.
Only existing synthetic fixtures, temporary databases, and local mocks ran. No real harness leg ran.

| Check | Fresh result |
| --- | --- |
| Focused driver and lifecycle tests | 190 passed, zero failures, 933 assertions, eight files, 91.36 seconds |
| TypeScript 5 | Passed |
| Lint | Passed, five warnings and four informational findings, no fixes applied |
| Async DB seam | Passed |
| Unit test allowlist | Passed, 626 changed test files checked against base |
| Local check loop | Passed frozen install, Biome, anti-slop, Bun typecheck, and affected tests |
| Affected tests | 14,869 passed, 29 skipped, zero failures, 80,402 assertions, 835 files, 192.79 seconds |
| Full root suite | 22,277 passed, 43 skipped, zero failures, 116,597 assertions, 1,468 files, 305.68 seconds |
| sqlite knowledge-memory | One passed, zero failures/skips/flakes, 97 calls, 6.835 seconds |
| worker knowledge-memory | One passed, zero failures/skips/flakes, 97 calls, 7.818 seconds |
| Full worker black-box | 155 passed, zero failures/skips/flakes, 4,857 calls, 411.218 seconds |

Full black-box coverage: routes 505/505, MCP tools 192/192, workflow types 15/15, CLI commands 14/20.
Strict coverage mode was not requested. Existing optional root skips remain limitations.
No verification command failed or required repetition.
A progress counter matched `(fail)` inside a passing test name. Inspection confirmed zero failed tests.
The verifier did not separately repeat accepted probes, mutation checks, promise checks, packaging checks, or the 254 memory tests.
Affected and full suites included their normal memory coverage.
No implementation, test, assertion, dependency, runtime configuration, or plan edit occurred.
No Docker build, container start, commit, publication, production access, external telemetry, or Phase 4 work occurred.

### Integrity and cleanup

All requested SHA-256 values matched before and after verification:

```text
341bb5fbff14fd8bfa7db9974c62e8e85ac188f6957b4b1e283ec88355011bb6  src/be/memory/providers/sqlite-store.ts
8073e21f2d584ea50066d8a9cec62349cecce9d4550bd72a1d18cd0004ca0284  src/be/db/runtime.ts
fa5fd841b7d79fd07bbbef210d5c42d0b51aa1a9add4af225df21ebbf303daa0  scripts/probe-memory-worker.ts
4e137863ef9eb8f9a686ec7dc69a8ba757496e7311b1cd4368553b2a61d3a83d  thoughts/taras/research/2026-11-16-worker-sqlite-phase3.patch
```

Cleanup measured 9,476 KiB of owned temporary logs, fixtures, wrappers, and JSON results.
Process inspection found no remaining owned API or black-box runner. No build outputs were created.
OrbStack remained stopped. Shared caches and node_modules remained intact.
Initial disk availability: 14,940,336 KiB. Availability immediately before cleanup: 14,369,328 KiB.
The shell rejected the first combined evidence-write and removal command before execution.
Its automatic review prohibited rm-style removal. A scoped Python removal replaced that command.
Availability after cleanup: 14,397,716 KiB (14 GiB in df -h).
Observed availability increased by 28,388 KiB during cleanup. Concurrent disk activity can affect this measurement.
The complete verification session reduced available space by 542,620 KiB, including activity outside owned temporary files.
No shared cache was deleted to recover that difference.
