# Worker SQLite integration evidence

This integration combines accepted Phase 3 behavior with the memory changes from current main.
The parent owns the Git merge, other conflicts, generated artifacts, Phase 4, and publication.
This task changed memory source, two existing memory tests, the durable probe, and database lifecycle integration.
The implementation subagent did not commit or publish. The parent committed the integrated source after review.

## Source and scope

- Original base: `556461bfc0e2249991eab35df5c606ed5813ad1f`.
- Local checkpoint: `86c40b81a0`.
- Upstream: `974d8c0cca3ba571f8adb7ef7633a9738c32dda3`.
- Memory changes: `294ccae645` and `411c1cdc5e`.
- Prior evidence: `thoughts/taras/research/2026-11-16-worker-sqlite-phase3.md`.

The integration preserves two read-only memory Workers and refreshes cached search health in the background.
It preserves lazy readiness, separate population gates, batches of 500 vectors, consistent health snapshots, and atomic FTS mutations.
Every memory method still awaits readiness.
Transaction reads use the bound client and observe its uncommitted writes.
Fallback reads use the effective database driver.
Each reader verifies its vector capability before the pool accepts it.
Optional vector absence still permits retrieval through the source embeddings.

The pool tracks both the client and the database lifecycle identity.
Its configuration getter awaits runtime readiness without SQL admission or connection creation.
It checks client identity before and after that wait.
An unrelated writer cannot prevent the first reader pool from starting.

Health counts from a reader use one statement, including the schema observation.
The public health method retains its asynchronous API and reads related values within one read-only transaction.
Transaction searches bypass shared health results.
Writes invalidate refresh generations immediately and after COMMIT.
Cached vector mode retains the upstream refresh policy.
Population failures remain separate from failures during runtime vector writes.
Successful repairs clear only the corresponding runtime write failure.

Shutdown cancels queued readiness, populations, health refreshes, and reader jobs.
Reader shutdown requests connection closure and awaits Worker exit.
A missing closure request causes a bounded error and forced termination.
The code does not report successful shutdown from `terminate()` alone.
The database client's original shutdown failure remains authoritative when its own bound expires.

Startup tracks Worker closure from construction.
Closure before readiness rejects startup promptly.
Closure after readiness, before its peer becomes ready, rejects pool creation.
The existing tests prove fallback completes for both cases.

## Preserved Phase 3 corrections

- FTS write failures retain their original errors and roll back source, version, and index changes together.
- Schema readiness requires an FTS5 virtual table and executes a MATCH query with rank.
- Related health counts cannot span competing database snapshots.
- Store closure rejects queued readiness and preserves bounded client shutdown failures.
- Each of the 19 readiness checks rejects fulfilled operations after its gate rejects.

## Final automated results

- Required memory suites and reader regressions: 260 passed, zero failures, 1,477 assertions, nine files, 5.89 seconds.
- Worker reader and stall suites: 15 passed, zero failures, 79 assertions, two files, 4.95 seconds.
- Lifecycle suites: 190 passed, zero failures, 933 assertions, eight files, 93.59 seconds.
- Root TypeScript checking passed.
- Direct probe TypeScript checking passed with explicit Bun type roots and ambient declarations.
- Both promise checks passed with zero findings.
- The asynchronous database seam check passed.
- The unit-test allowlist check passed. No new test call was added.
- Biome passed for all seven owned implementation and test files.
- `git diff --check` passed.

The lifecycle run preceded the final reader startup correction.
The corrected reader source passed both focused driver runs and the durable lifecycle probes afterward.
The root source check and both promise checks inspected the final production source.

The synthetic probe uses real files with 20,000 embeddings and disables migration-template substitution.
It preserves source, vector, and FTS equality checks during concurrent writes.
It also preserves all original schema, population failure, readiness, shutdown, and reopen checks.
New checks cover active and queued reader jobs, stale clients, reopened database contents, and a lost closure request.
Both optional-vector runs verify degraded health and correct retrieval.

| Driver | First search ms | Population interval ms | Maximum main-thread delay ms | Vector batch transactions |
| --- | ---: | ---: | ---: | ---: |
| sqlite | 155.94 | 1,094.83 | 34.38 | 41 |
| worker | 160.18 | 1,707.88 | 20.73 | 41 |

Both full probes passed all 19 individual readiness gates.
Both full probes rejected the lost closure request within 12 seconds.
Both optional-vector probes passed.
The final repetitions used the exact source hashes recorded below.
Only one performance probe ran at a time.
The parent deferred Phase 4 measurements during these runs.

## Exact commands and isolation

The root preload removes provider credentials and supplies synthetic encryption credentials.
The durable probe uses `--no-env-file` and a synthetic 32-byte encryption key.
No production data or real provider was used.
Telemetry targets a loopback endpoint.
The existing lifecycle tests allocate their own free ports and UUID identities.
No development server or external telemetry sink was started.

All commands used this environment prefix:

```sh
export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
export TMPDIR=/private/tmp
export BUSINESS_USE_API_KEY=
export DESPLEGA_TELEMETRY_ENDPOINT=http://127.0.0.1:1/v1/events
export BUN_OPTIONS=--preload=/private/tmp/memory-integration/network-guard.ts
```

The local metadata guard intercepted only `models.dev`:

```typescript
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "models.dev") {
    return Promise.resolve(new Response("Memory integration catalog fixture", { status: 503 }));
  }
  return originalFetch(input, init);
}, originalFetch);
```

Final commands:

```sh
env -u DESPLEGA_TELEMETRY_ENV bun run test:root -- src/tests/memory-search-reader.test.ts src/tests/memory-search-stall.test.ts src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-fts-populate.test.ts src/tests/memory-key-paths.test.ts src/tests/memory-embedding-space.test.ts
env -u DESPLEGA_TELEMETRY_ENV DB_DRIVER=worker bun run test:root -- src/tests/memory-search-reader.test.ts src/tests/memory-search-stall.test.ts
env -u DESPLEGA_TELEMETRY_ENV bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/api-drain.test.ts src/tests/api-drain-e2e.test.ts src/tests/api-drain-worker-e2e.test.ts src/tests/runner-api-drain.test.ts src/tests/runtime-cache-cleanup.test.ts
DESPLEGA_TELEMETRY_ENV=test NODE_ENV=test SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 DB_DRIVER=sqlite bun --no-env-file scripts/probe-memory-worker.ts
DESPLEGA_TELEMETRY_ENV=test NODE_ENV=test SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 DB_DRIVER=worker bun --no-env-file scripts/probe-memory-worker.ts
DESPLEGA_TELEMETRY_ENV=test NODE_ENV=test SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 DB_DRIVER=sqlite bun --no-env-file scripts/probe-memory-worker.ts --optional-vec
DESPLEGA_TELEMETRY_ENV=test NODE_ENV=test SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 DB_DRIVER=worker bun --no-env-file scripts/probe-memory-worker.ts --optional-vec
bun run tsc:check:tsc
bun x --no-install tsc --noEmit -p /private/tmp/memory-integration/probe-tsconfig.json
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bash scripts/check-async-db-seam.sh
bun run check:unit-test-allowlist
bunx --no-install biome check src/be/memory/providers/sqlite-store.ts src/be/memory/search-reader.ts src/be/memory/search-read-worker.ts src/be/db/runtime.ts scripts/probe-memory-worker.ts src/tests/memory-search-reader.test.ts src/tests/memory-search-stall.test.ts
git diff --check
```

The temporary probe configuration extends the repository TypeScript configuration.
It includes the probe, `src/templates.d.ts`, and the declarations under `src/scripts-runtime/types/`.
Its Bun type roots point to this checkout's `node_modules` and `node_modules/@types`.

## Failures and corrections

The first memory run passed 259 tests and failed one upstream refresh assertion.
A schema query delayed a health refresh behind the writer's lock.
The reader now obtains schema and counts in its single snapshot statement.
The existing assertion passed after the correction.

The first probe supplied an invalid synthetic encryption key and failed before acceptance checks began.
A valid 32-byte synthetic key corrected the fixture.

The first reader shutdown probe expected a close event after forced termination.
Bun did not provide that acknowledgement.
The explicit close protocol now verifies normal exit and rejects a lost closure request within its bound.

The promise-sink check rejected an inferred object containing a promise.
An explicit `SearchHealthRefresh` type resolved the ownership declaration without changing the checker.

Direct probe typechecking found an overload error in the lost-request wrapper.
An attempted annotation also referenced unavailable DOM type names.
The wrapper now accepts only the message argument used by this fixture.
Direct typechecking passed afterward.

Standards independently reproduced a Worker that closed after readiness while its peer still started.
The previous pool admitted its read and left it pending.
The corrected pool records early closure and returns fallback before the review fixture's 400 ms deadline.
The existing test also verifies closure before readiness.
No assertion was weakened to accept stale results.

## Independent review scope

Spec passed the integration before the final startup correction.
Standards independently checked the final startup correction and passed it.
Standards checked reader hash `250781a6dfa6ff7800ea25319e9cf5bdb4850b19436908c777c8456303335c10`.
Neither review left a Critical or Important finding.
The parent owns generated declarations and their separate regeneration evidence.

## Parent integration checks

The parent retained both database and memory Worker entrypoints in the compiled API.
The async seam retains the read Worker exemption and removes the obsolete host reader exemption.
It also preserves the earlier removal of converted runtime callers.
The test allowlist retains both sets of justified exceptions.

The OAuth merge preserves private-host environment cleanup and awaits database closure.
Two newly added upstream test files now await closure before database removal.
The three affected test files passed 15 tests and 57 assertions.

OpenAPI and script SDK regeneration passed without further drift from the merged index.
Extension generation initially failed because its compiler options selected browser Worker declarations.
The parent added `lib.esnext.d.ts`, matching the root Bun environment.
`bun run build:extension-types` then passed.
An AST comparison confirmed that generated extension declarations changed only in union member order.
Both generated extension files are committed with the compiler correction.

Generation used test tagging, empty business-use credentials, loopback telemetry, and the existing synthetic models.dev response.
The parent preserved the original research, sibling dialect plan, and incremental patch snapshots as local files.
The feature diff against current main contains no dashboard, dependency, or changelog changes.
Full acceptance checks remain pending after the merge commit.

## Final SHA-256 values

```text
f5345828e497dfe2d86c55381a7d4df140204551f2079091533fe409600e73cf  src/be/memory/providers/sqlite-store.ts
250781a6dfa6ff7800ea25319e9cf5bdb4850b19436908c777c8456303335c10  src/be/memory/search-reader.ts
7def36b0cb76f5bbe20a9f3e6d3e6088d87db071811c0c6310952b1fbc18eab0  src/be/memory/search-read-worker.ts
2d000bd56674c9d7351582560265e0d61fee13dbd497e69755243fe8a98922ff  src/be/db/runtime.ts
ce235dd1f6f5928b310446cd16c42b8a572433727007d63a61f7585ddbd38789  scripts/probe-memory-worker.ts
b3d24322a7781aef26375ba01d8673af45c81fbbce623182d94348f562fa3aa9  src/tests/memory-search-reader.test.ts
eab332781575bf0b610404312fdc100a373f9ad0a8eafe1764535447bb3aea70  src/tests/memory-search-stall.test.ts
```

## Cleanup and limits

Removed owned logs first, followed by the metadata guard, temporary configuration, and two temporary edit scripts.
`du -sk` measured 2,196 KiB across the removed files and directory.
The probe removed its database directories, and the existing test helpers removed their databases.
All owned process sessions exited. No owned Worker remains.
Cleanup preserved shared caches and `node_modules`.

| Disk check | Before cleanup | After cleanup |
| --- | ---: | ---: |
| `df -h /`, available | 11 GiB | 11 GiB |
| `df -k /`, available | 11,599,416 KiB | 11,594,040 KiB |

The initial task check reported 14 GiB available.
The net available space decreased 5,376 KiB during cleanup despite the owned file removal.
Concurrent filesystem activity prevents attributing this net change to cleanup.
The task created no container, emulator, simulator, watcher, or build output.
These synthetic measurements do not establish production latency budgets.
