---
date: 2026-11-12
planner: Claude
author: Claude
topic: "Worker-backed SQLite DbClient behind the existing async seam, with DB_DRIVER staged rollout"
tags: [plan, db, sqlite, worker, event-loop, db-client]
status: in-progress
autonomy: autopilot
base_commit: 556461bfc0e2249991eab35df5c606ed5813ad1f
last_updated: 2026-11-16
last_updated_by: Codex
review_mode: autopilot
---

# Worker-backed SQLite DbClient Implementation Plan

## Overview

Move `bun:sqlite` execution off the API's main thread by implementing the existing `DbClient` seam (`src/be/db-client.ts`) over a Worker thread, behind a `DB_DRIVER` flag for staged rollout.

**Execution direction, 2026-11-16:** Taras requested Codex subagents for all remaining work.
After implementation and verification, commit the scoped changes, push the branch, and create a pull request.
This authorization does not include merging the pull request or production rollout.

**Upstream integration, 2026-11-16:** `origin/main` advanced to `974d8c0cca` after the original implementation base.
It adds separate memory read Workers and cached health refreshes. Preserve those features alongside this plan's readiness and transaction guarantees.
The complete API topology therefore includes those readers in addition to the boot connection and selected runtime driver.
Repeat final verification after integration. Earlier phase results describe their recorded source snapshots.

- **Motivation**: synchronous SQLite execution blocks the API event loop. The research reports a 770 ms Worker query with 1 ms main-thread lag. Phase 0 must reproduce this result on the pinned Bun version. It is not production acceptance evidence.
- **Related**: [research](../research/2026-11-12-async-db-and-query-engine-abstraction.md) and [dialect plan](2026-11-12-sql-dialect-lint-and-helpers.md).

## Current State Analysis

References describe base commit `556461bfc0e2249991eab35df5c606ed5813ad1f`, which remains this checkout's HEAD.
The original research counts are estimates. Recount callers before implementation.

- **Client contract**: `src/be/db-client.ts:72` exposes async queries, transactions, timing, and commit/rollback hooks.
- **Transaction ownership**: `src/be/db-client.ts:412` owns the FIFO lock, AsyncLocalStorage context, savepoints, BUSY retries, and slicing.
- **Change counts**: `src/be/db-client.ts:446` runs `SELECT changes()` for `runTimed`. Ordinary `run` uses the driver's change count.
- **Connection lifecycle**: `src/be/db/runtime.ts:355` currently closes synchronously. The cached client resolves `getDb()` for each operation.
- **Boot**: `src/be/db/runtime.ts:85` opens the file, applies migrations, seeds data, and configures prompt resolution synchronously.
- **Connection settings**: `src/be/db/runtime.ts:149` configures WAL, busy timeout, foreign keys, synchronous mode, cache, mmap, and temporary storage.
- **Test shortcut**: `src/be/db/runtime.ts:98` deserializes `__testMigrationTemplate` when present. This bypasses the supplied filename.
- **Vector extension**: `src/be/db/runtime.ts:65` loads sqlite-vec per connection. The main connection's status cannot prove Worker availability.
- **Worker precedents**: `src/be/primitives/sheets/engine.ts:19` and `src/scripts-runtime/executors/quickjs.ts:34` handle source and compiled Worker specifiers.
- **Compiled packaging**: `Dockerfile:106` lists the API and two Workers explicitly. The database Worker needs a fourth entrypoint.
- **Seam tests**: `src/tests/db-client.test.ts` covers ordering, transactions, hooks, and slicing.
- **Contention tests**: `src/tests/db-client-busy-retry.test.ts` inspects per-attempt timeout changes on a real file.
- **Template resolution**: `src/be/db.ts:9645` and `src/prompts/resolver.ts:169` still perform synchronous DB resolution.
- **Template mutation**: `src/be/db.ts:9362`, `:9416`, and `:9567` implement synchronous listing, upsert, and reset.
- **Shared boot callers**: `src/be/seed-prompt-templates.ts:11` imports those same functions. Runtime conversion needs separate synchronous boot loaders.
- **Script types**: `src/be/scripts/typecheck.ts:937` uses synchronous default expressions. Async connection listing already exists in `src/be/script-connections.ts:596`.
- **Asset audits**: `src/be/asset-key-audit.ts:105` serves synchronous boot and runtime transaction callers. Runtime reads must move onto the transaction's connection.
- **Memory bootstrap**: `src/be/memory/providers/sqlite-store.ts:214` performs synchronous initialization. FTS population already has an asynchronous background path.
- **Memory lifecycle**: `src/be/memory/index.ts:27` caches a singleton. Health caches currently track raw connection identity.
- **Explorer isolation**: `src/http/db-query-shared.ts:97` opens a separate readonly connection or serializes an in-memory snapshot.
- **Remaining synchronous execution**: `src/http/metrics.ts:67` and `:156` call that reader synchronously. They do not exercise the proposed client.
- **E2E environment**: `scripts/e2e/sut.ts:54` copies only selected environment variables. Pass driver selection with `--sut-env`.
- **Public health**: `src/http/core.ts:490` forbids exposing configuration. Authenticated stats have a schema in `src/http/stats.ts:148`.
- **Reserved configuration**: `src/be/swarm-config-guard.ts:67` rejects reserved keys from stored configuration. Editable catalog entries cannot represent this flag.


## Desired End State

- `DB_DRIVER=worker` runs every `DbClient` operation on a Worker thread that owns its own `bun:sqlite` connection to the same file. The main thread keeps its boot connection (`getDb()`) for migrations, seeders, the identified residual sync paths until conversion, and tests. `DB_DRIVER=sqlite` (default until the rollout PR flips it) preserves current public semantics, with asynchronous lifecycle changes documented below.
- `BunSqliteClient` keeps its lock, transaction routing, savepoints, BUSY retry, hooks and tests. Both implementations share the driver interface. Lifecycle, timing, and readiness changes must preserve transaction behavior.
- No `resolveTemplate`, `listScriptConnections` or `auditAssetKeys` call runs synchronous SQL at request time. `SqliteMemoryStore` never runs SQL in its constructor.
- The black-box e2e suite passes with `DB_DRIVER=worker` in CI, and the 53 seam tests pass against both drivers on a file DB.
- Verify responsiveness through the production `DbClient` in `scripts/bench-db-worker.ts --driver worker --assert`. The explorer endpoint uses a separate executor and cannot prove this change.

## What We're NOT Doing

- Postgres or any second SQL engine (research step 4).
- Dialect lint and SQL helpers (sibling plan).
- Changing migrations, triggers, FTS5 or sqlite-vec schema.
- Eliminating every synchronous query in the API. Metrics currently bypass this client through `executeReadOnlyQuery`. The explorer also permits an explicit synchronous fallback.
- Automatic Worker recovery or query replay. Process restart is the recovery mechanism for this first implementation.

## Implementation Approach

- Keep one Worker-owned connection for runtime queries and the main connection for synchronous boot.
- Preserve FIFO ownership, transaction routing, savepoints, BUSY retries, and hooks in the client.
- Send one message per operation. The protocol carries SQL, parameters, timeout settings, and commit deadlines.
- Return result values and execution timing separately. Preserve failure codes and failed-attempt timing.
- Apply every connection PRAGMA, including `synchronous=NORMAL`. Verify WAL mode.
- Keep `DB_DRIVER` env-only, with `sqlite` as the default. Production Worker mode requires a real file.
- Permit in-memory fallback only for tests. Explicitly report the effective driver through authenticated stats.
- Retain synchronous-driver assertions and add narrowly justified Worker transport coverage.
- Pass `--sut-env DB_DRIVER=worker` in every Worker E2E run.
- Convert runtime prompt reads and writes, script-type loading, and asset audits to the async client.
- Separate memory schema readiness from background population and enforce lifecycle ownership.
- Keep Phase 0 as the capability and performance gate. Keep production rollout separate.
- The interface serves two implementations in this plan. Do not add a generic backend registry or new dependencies.

## Quick Verification Reference

- `bun run check:local`
- `bun run test:root -- src/tests/db-client*.test.ts`
- `bun run tsc:check:tsc`
- `bash scripts/check-async-db-seam.sh`
- `bun run e2e`

---

## Phase 0: Spike, transfer cost on production-shaped rows

### Overview

A benchmark script and a one-page result that say whether a Worker driver is acceptable for the heavy result paths, and whether sqlite-vec and the darwin `setCustomSQLite` hook work inside a Worker. Go/no-go for the rest of the plan.

### Changes Required:

#### 1. Benchmark script
**File**: `scripts/bench-db-worker.ts` (new)
**Changes**: Owns a unique temporary directory and seeds a file DB with `scripts/bench-sessions.ts`-shaped data (reuse the fixture shapes, not the benchmark module, which executes at import time), then runs the same statements through (a) `bun:sqlite` in-process and (b) a throwaway Worker that posts rows back, for: `session_logs` page read (200 rows with JSON columns), task list (100 rows), `agent_memory` search rows with `embedding` BLOBs (50 rows using the current `EMBEDDING_DIMENSIONS` and matching Float32 BLOB size), a 20k-row `kv_entries` window, one 1 s recursive-CTE query. Report warmup settings, repeated-run p50/p95, absolute overhead, worker execution time, round-trip time, main-thread lag, transferred bytes, and RSS. Start the lag probe before submitting work. Measure deserialization and repeated small statements as well as single large results. Also asserts inside the Worker: `loadExtension(resolveSqliteVecExtensionPath())` succeeds and `vec_version()` answers; on darwin, configure the same SQLite library path before any connection opens. Record the pinned Bun version and require successful vector queries. A thrown configuration call alone is not success.

#### 2. Result note
**File**: `thoughts/taras/plans/2026-11-12-worker-sqlite-db-client.md` (Appendix, "Phase 0 results")
**Changes**: Paste the table. Mark go/no-go. Run on macOS and the compiled Linux image. A local pass alone does not clear the gate. Treat a ratio above 3x as a review trigger, with absolute overhead alongside it. Reject missing vector support or main-thread lag above 50 ms during the calibrated one-second query. Phase 0 must establish acceptable transfer and memory costs before implementation proceeds.

### Verification and Success Criteria:

#### Automated Verification:
- [x] Script runs clean: `bun scripts/bench-db-worker.ts --json > /tmp/bench-db-worker.json`
- [x] Lint passes: `bun run lint`
- [x] Type check passes: `bun run tsc:check:tsc`

#### Automated QA:
- [x] The JSON contains all five cases and capability results. Record the measurements and platform-specific results in the Appendix.

#### Manual Verification:
- [ ] Taras reads the table and confirms go/no-go.

**Implementation Note**: Follow the implementation session's autonomy setting. Autopilot may proceed after checks pass. Stop on a failed Phase 0 gate. Commit only when authorized.

---

## Phase 1: `SqliteDriver` seam, Worker executor, `DB_DRIVER` flag

### Overview

`BunSqliteClient` runs over a `SqliteDriver` interface; a Worker-backed driver exists behind `DB_DRIVER=worker`; the seam test suites pass against both drivers.

**Autopilot sequencing adjustment, 2026-11-15:** Worker black-box verification exposed two synchronous prompt mutations inside client transactions.
The Worker owns the write lock, so the main connection fails with `database is locked`.
Move runtime `upsertPromptTemplate` and `resetPromptTemplateToDefault` conversion into Phase 1, including required awaits and separate synchronous boot helpers.
This dependency is necessary for the Phase 1 Worker suite. Preserve mutation/history atomicity on the transaction connection.
All remaining prompt listing, resolution, script connections, and asset audits remain in Phase 2.
Phase 2 must treat these completed mutation conversions as prior work and verify their integration.

**Approved contract adjustment, 2026-11-15:** Taras selected "Preserve caught errors + stricter static checks".
Preserve native caught-error behavior. A rejected transaction callback causes rollback. A caught statement error alone does not prevent commit.
Keep operation ordering, stable draining, savepoint isolation, deadline checks, and transport safeguards.
Require DB operations and DB-bearing helpers to be awaited, returned, or joined before their transaction scope ends.
Static checks must reject unsupported promise lifetimes, including discarded chains, abandoned promises, and detached callbacks that use the transaction.
This replaces universal runtime detection of floating failures. Native Promises do not expose the required downstream handling information to the seam.
Document the supported static subset and its limits. Do not claim complete analysis of arbitrary JavaScript.
See [the contract report](../research/2026-11-15-worker-sqlite-error-contract.md) for the counterexample and the earlier diagnostic results.
The runtime correction and static enforcement passed final verification on 2026-11-16. Phase 2 may proceed under autopilot.

**Review status, 2026-11-16:** independent Standards and Spec reviews completed.
The parent corrected their findings, including their shared final conditional-closure finding, and verified the exact counterexamples.
The checker corpus passes 96 cases. Final Phase 1 automated verification passed on the reviewed source hashes.
The semantic probe passed 24 checks. The final full suite passed 22,277 tests after an initial timeout passed in isolation.
Both drivers passed 155 black-box scenarios. Compiled arm64 and emulated x64 smokes passed.
Worker main-thread lag measured 2.55 ms. Parent review accepts the Phase 1 automated gate.
Taras's protocol review remains unconfirmed. Autopilot permits Phase 2 to proceed.
See [the current evidence](../research/2026-11-15-worker-sqlite-phase1.md).

### Changes Required:

#### 1. Driver interface and sync driver
**File**: `src/be/db-client.ts`
**Changes**:
- Define one internal driver interface with `blocksEventLoop`, `all`, `get`, `run`, `runTimed`, `exec`, and asynchronous `close`.
- Preserve the distinction between `run().changes` and `runTimed().changes`. The latter reports SQLite `changes()` without foreign-key action counts.
- Execute the timed write and `SELECT changes()` atomically in one Worker request. Include both operations in the execution timer.
- Return `{ value, executionMs }` for every operation. Preserve `null`, row arrays, and `{ changes }` as their public values.
- Preserve failed-attempt timing too. `runTimed` must include BUSY attempts without counting lock waits, message transfer, or backoff.
- Extract current synchronous operations into `createSyncSqliteDriver`. Keep `createBunSqliteClient(getDatabase, busyRetry?)` as the compatibility factory.
- Add `createDbClient(driver, busyRetry?)`. Await each driver operation before releasing the FIFO lock.
- Keep `AsyncLocalStorage`, savepoint ownership, retry policy, hooks, and deadline checks in the client.
- Apply and restore `busy_timeout` within each driver operation, including failed BEGIN and COMMIT attempts.
- Serialize transaction operations before any readiness await. Drain submitted operations before COMMIT or ROLLBACK.
- Roll back when the transaction callback rejects. Preserve commit after a statement error that the callback catches.
- Drain admitted operations before settlement without treating every recorded statement rejection as fatal.
- Enforce structured consumption of transaction promises through static checks. Unsupported floating work has no universal runtime rollback guarantee.
- Pass `deadlineAt` with COMMIT. Recheck it inside the Worker immediately before execution, since message delay can cross the deadline.
- Preserve expired-executor checks after closure. Do not permit a transaction executor to reach a new connection.
- Keep slicing for the synchronous driver. Worker replies already yield to the event loop.
- Update `src/be/event-loop-lag.ts` integration: Worker execution time is query cost, not main-thread blocking time.
- Do not feed Worker execution duration into synchronous `db_ms` stall attribution. Report driver and execution duration separately.
- Preserve secret scrubbing for diagnostic SQL and errors. Never log bound parameters.

**Invariant to preserve**: one client lock owns one connection. Only confirmed SQLITE_BUSY responses enter existing retry paths.
Transport failures must never replay a statement or a transaction callback. A lost COMMIT reply has an unknown outcome.

#### 2. Worker entry
**File**: `src/be/db/db-worker.ts` (new)
**Changes**: `declare const self: Worker`. On `{ type: "open", filename, vecExtensionPath, pragmas }`: `new Database(filename)`, apply pragmas, `loadExtension(vecExtensionPath)` when set, reply `{ type: "ready", sqliteVec: boolean }` or `{ type: "fatal", message }`. On `{ id, op, sql, params, spinMs }`: optional `PRAGMA busy_timeout = spinMs` set/restore, run the statement with `db.query(sql)`, measure `performance.now()`, reply rows/changes/`executionMs`; on error reply `{ id, error: { message, code, name } }` where `code` is the bun:sqlite `SQLITE_*` code so `isSqliteBusy` keeps working on the host. On `{ type: "close" }`: `db.close()`, reply, exit. Header comment: "The compiled API binary must list this file as an extra entrypoint (see Dockerfile)." Export `DbWorkerRequest` / `DbWorkerMessage` types. Open the existing file with `create: false`. Include the verified macOS SQLite library path in startup configuration. Apply `synchronous=NORMAL` with the other connection PRAGMAs. Report the Worker connection's actual vector capability. Distinguish optional extension absence from a required extension that failed to load. Before COMMIT, enforce the transmitted deadline.

#### 3. Worker driver (host side)
**File**: `src/be/db/worker-driver.ts` (new)
**Changes**: Use the existing compiled `workerSpecifier()` pattern and a 10-second ready timeout.
Install message, error, and close handlers before sending the open request.
Keep numeric request IDs and a pending map.
Serialize Worker statement execution and reject protocol errors.
On startup failure or Worker loss, reject pending calls and queued operations with a typed transport error.
Mark this client unusable until process restart. Do not silently respawn, fall back, or replay.
Distinguish a database error reply from transport loss after a possible write.
Reject new calls after close starts. Drain admitted operations and hooks before closing the connection.
Bound the close wait, then terminate if required. Surface forced termination as a failed shutdown.
Keep the Worker referenced during startup and outstanding requests. Unref only while idle.
Clone rows and parameters without detaching caller-owned buffers. Test BLOB and bigint behavior against the synchronous driver's actual SQLite options.

#### 4. Driver selection and lifecycle
**File**: `src/be/db/runtime.ts`
**Changes**:
- Parse `DB_DRIVER` as `sqlite | worker`, with `sqlite` as the default. Reject unknown values at startup.
- Keep `getDbClient()` synchronous. Its client methods await the shared Worker-ready promise.
- Await Worker readiness before the server accepts requests or starts schedulers. Keep migrations and seeders synchronous.
- Permit the documented in-memory fallback only in tests. Fail startup for an unsupported production in-memory Worker configuration.
- File-backed tests must unset `globalThis.__testMigrationTemplate`. Merely passing a filename does not bypass deserialization.
- Keep requested driver and effective driver distinct. Report the effective driver through authenticated `/api/stats` in Phase 1.
- Make `closeDb()` awaitable. Await it in shutdown handlers, stdio, scripts, and test hooks before deleting or reopening a file.
- Keep admission closed until shutdown completes. Do not create a second client while the old client drains.
- Reset `dbClientInstance` and capability state only after closure. Calls through stale clients must fail.
- Report vector availability from the active query connection. The boot connection's successful extension load is insufficient.
- Audit raw-handle access across all allowlisted files. Move a raw read inside a client transaction onto its bound executor.
- Keep Worker mode experimental until Phases 2 and 3 remove the identified runtime exceptions.

**Files**: `src/http/stats.ts`, its `DashboardStatsSchema`, and generated OpenAPI files.
Add `dbDriver` to authenticated `/api/stats` so tests detect silent fallback. Extend `scripts/e2e/scenarios/core-telemetry.ts` with this assertion. Include it in the targeted Worker CI run.
Keep `/health` free of server configuration, as required by `src/http/core.ts:490`.
Worker startup failure must fail readiness, not report a healthy synchronous substitute.

#### 5. Compiled binary and boundaries
**File**: `Dockerfile`
**Changes**: Add `./src/be/db/db-worker.ts` as a fourth positional entrypoint on the `bun build --compile` line (104-108).
**File**: `scripts/check-async-db-seam.sh`
**Changes**: Allowlist the Worker entrypoint because it owns a SQLite connection. Use type-only imports in the host driver. Those imports already pass the seam checker without an exemption.
**File**: `scripts/e2e/coverage-exemptions.txt`
**Changes**: Exempt `src/be/db/db-worker.ts` like the sheet worker ("Runs in a Bun Worker thread; only the API main thread is instrumented").

#### 6. Config surface
**File**: `src/be/swarm-config-guard.ts`
Reserve `DB_DRIVER` from stored configuration. Validate it in the runtime's startup parser.
Confirm legacy stored rows cannot override the deployment environment.
**Files**: environment-variable documentation and configuration documentation.
Document the env-only flag, restart requirement, default, and rollback command.
Do not add an editable catalog entry. The catalog persists global configuration rows, which reserved keys reject.

#### 7. Tests
**File**: `src/tests/db-client.test.ts`, `src/tests/db-client-busy-retry.test.ts`
**Changes**: Parameterize existing cases over both drivers using real temporary files.
Keep synchronous-driver spy assertions. Add Worker-specific observation where needed without weakening timeout or retry coverage.
Await readiness and shutdown in hooks. Restore template globals after file-backed cases.
Retain all transaction, savepoint, hook, FIFO, deadline, and slicing expectations.
Use reasoned exemptions only for transport behavior that HTTP scenarios cannot exercise directly.
Any new `test(` in the seam suites needs a matching allowlist reason too.

**Files**: `scripts/probe-db-transaction-errors.ts`, `scripts/check-floating-promises.ts`, and the checker corpus.
Verify caught errors and callback rejection through direct calls, async helpers, ambient routing, promise chains, and nested transactions on both drivers.
Preserve best-effort workflow snapshots and embedding updates. Verify successful admitted work drains before commit.
Replace obsolete floating-failure rollback expectations explicitly under the approved contract, with static rejection cases for the unsupported source patterns.
Cover discarded `void` calls and chains, stored promises without a join, detached callbacks, DB-bearing helpers, and nested transaction calls.
Include accepted awaited, returned, and joined forms. Document conservative rejections and analysis limits.

**File**: `src/tests/db-worker-driver.test.ts` (new, narrowly exempted).
Cover startup failure, Worker loss before and after writes, lost COMMIT replies, queued calls, close during work, and stale clients after reopen.
Cover SQLITE_BUSY code preservation, timeout restoration, BLOBs, and bigint according to connection options.
Cover an expired COMMIT in the Worker and a pending transaction statement followed by rollback.
Do not claim that `unref` proves termination. Assert shutdown acknowledgement and child-process exit.

**File**: `scripts/bench-db-worker.ts`.
Extend the Phase 0 script with `--driver sqlite|worker --assert` using production `getDbClient()` after Phase 1.
Measure a calibrated long query through that client while a timer or lightweight HTTP probe runs in the same main process.
Own and clean the temporary DB, Worker, and optional free-port probe server.
Do not create a diagnostic production API endpoint.

**Files**: existing black-box scenarios for health, tasks, sessions, prompts, scripts, and memory.
Use HTTP and MCP for behavior coverage. Pass the driver explicitly with `--sut-env`.
Assert the authenticated stats response's effective driver in each run.


**File**: `src/tests/preload.ts`
**Changes**: Add `be/db-client.ts`, `be/db/worker-driver.ts`, `be/db/db-worker.ts` to the template cache-key `inputs` (`:183-206`).

### Verification and Success Criteria:

#### Automated Verification:
- [x] Seam suites pass on both drivers: `bun run test:root -- src/tests/db-client.test.ts src/tests/db-client-busy-retry.test.ts src/tests/db-worker-driver.test.ts src/tests/event-loop-lag.test.ts src/tests/task-start-after-commit.test.ts`
- [x] Affected tests pass: `bun run check:local`
- [x] Full unit suite passes (sync default): `bun run test:root -- --parallel=4`
- [x] Type check: `bun run tsc:check:tsc`
- [x] Lint: `bun run lint && bun run lint:slop`
- [x] Boundaries: `bash scripts/check-async-db-seam.sh && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:unit-test-allowlist`
- [x] Black-box suite on both drivers: `bun run e2e` and `bun run e2e --sut-env DB_DRIVER=worker`
- [x] Compiled binary boots with the worker and performs a write/read plus vector query. Use the owned-container recipe in Manual E2E.
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] The updated transaction error probe passes on both drivers with telemetry restricted to loopback.
- [x] Static checker corpus passes: `bun run test:root -- src/tests/db-promise-analysis.test.ts`.
- [x] `bun run docs:openapi` and inspect the stats schema diff.

#### Automated QA:
- [x] `bun scripts/bench-db-worker.ts --driver sqlite --assert` records the blocking baseline.
- [x] `bun scripts/bench-db-worker.ts --driver worker --assert` verifies main-thread lag below 50 ms during a calibrated one-second query.
- [x] Compare query duration, transfer overhead, and main-thread lag separately.
- [x] Verify Worker query duration does not appear as synchronous `db_ms` attribution.

#### Manual Verification:
- [ ] Taras reviews the `DbWorkerRequest`/`DbWorkerMessage` protocol types once.

**Implementation Note**: Follow the implementation session's autonomy setting. Autopilot may proceed after checks pass. Stop on a failed Phase 0 gate. Commit only when authorized.

---

## Phase 2: Residual runtime sync paths go async

### Overview

Remove the following request-time synchronous paths: prompt-template resolution, script-connection type generation and the asset-key audit all go through `getDbClient()`. The seam allowlist loses `src/be/script-connections.ts`, and `src/be/db.ts` must retain raw SQL only in clearly identified boot helpers.

**Phase 2 closure, 2026-11-16:** all automated checks passed. Independent Spec review passed without findings.
Standards review passed with one Minor probe finding. The parent corrected it and verified both driver variants reject the bypass reproduction.
The full suite passed 22,277 tests. Both drivers passed 155 black-box scenarios and the three targeted scenarios.
Generated types remained byte-identical. The parent accepted the gate and proceeded to Phase 3 under autopilot.
See [Phase 2 evidence](../research/2026-11-16-worker-sqlite-phase2.md) for results and limits.

### Changes Required:

#### 1. Prompt templates
**Files**: `src/be/db.ts`, `src/be/seed-prompt-templates.ts`, prompt-template HTTP routes, and prompt-template MCP tools.
Convert runtime `getPromptTemplates`, `upsertPromptTemplate`, `resetPromptTemplateToDefault`, and `resolvePromptTemplate` to the async client.
Await every runtime caller. Preserve scope precedence, wildcard order, skip state, versioning, and history.
Keep each mutation and its history insertion within the same client transaction.
Split boot-only synchronous helpers from public runtime functions. Boot seeders use only the boot variants.
Share SQL constants and pure row mapping without introducing promise-polymorphic loaders.
Test listing, mutation, reset, and resolution while another Worker transaction holds the write lock.
No runtime prompt write may use the main connection. Audit other raw writes before declaring the runtime conversion complete.
**File**: `src/prompts/resolver.ts`
**Changes**: `DbResolverFn` becomes async; `resolveTemplateViaDb` and `expandTemplateRefs` become async (`for` loop with `await` per `{{@template[id]}}` token, depth and cycle guards unchanged). `resolveTemplateAsync` awaits them. `resolveTemplate` remains a code-default-only synchronous fallback. It cannot perform HTTP I/O. Preserve callers that intentionally request code defaults. Require `resolveTemplateAsync` for DB or HTTP overrides.
**Files**: the 52 call sites (`src/github/handlers.ts` 9, `src/agentmail/handlers.ts` 6, `src/tasks/worker-follow-up.ts` 5, `src/gitlab/handlers.ts` 4, `src/heartbeat/heartbeat.ts` 3, two each in `src/azure-devops/handlers.ts`, `src/bitbucket/handlers.ts`, `src/comb/review-batch.ts`, `src/http/prompt-templates.ts`, `src/integrations/chat-sdk/inbound.ts`, `src/jira/sync.ts`, `src/linear/sync.ts`, `src/slack/assistant.ts`, `src/slack/thread-participants.ts`, `src/workflows/approval-notifications.ts`, one each in `src/apps/action-runner.ts`, `src/azure-devops/boards-sync.ts`, `src/be/budget-refusal-notify.ts`, `src/http/pages.ts`, `src/integrations/kapso/inbound.ts`, `src/server.ts`, `src/slack/inbound-files.ts`)
**Changes**: `resolveTemplate(` → `await resolveTemplateAsync(`. All are inside async functions (verified in research). `src/http/prompt-templates.ts:293` awaits `resolvePromptTemplate` directly. Run `bun scripts/check-floating-promises.ts` and `bun scripts/check-promise-sinks.ts` after the sweep.
**Tests**: Convert DB-resolution cases to async. Preserve tests for intentional synchronous code defaults and HTTP fallback behavior. Keep reference expansion local to each call after adding awaits. A shared global-regex cursor must not cross concurrent renders.

#### 2. Script connections
**File**: `src/be/scripts/typecheck.ts` (`:937-941`, `:1013-1017`)
**Changes**: Make `apiTypes` and `mcpTypes` optional parameters and compute `apiTypes ?? (await getScriptApiTypesAsync(context))` inside the body.
**File**: `src/be/script-connections.ts`
**Changes**: Add `getScriptApiTypesAsync` / `getScriptMcpTypesAsync` / descriptor twins over `listScriptConnectionsAsync` (`:596`); switch the sync callers (`src/tools/script-connections/tool.ts` ~12 sites, `src/http/script-connections.ts:1327,1906`, `src/apps/sync.ts:274`, `src/apps/definition.ts:905`, descriptor callers in `src/be/scripts/run-saved.ts`, `src/scheduler/scheduler.ts`, `src/workflows/executors/swarm-script.ts`, `src/http/x.ts`, `src/http/scripts.ts`) to the async twins; delete `listScriptConnections` and the sync type/descriptor functions; update `scripts/bundle-script-types.ts:45`. Remove the file from the seam allowlist.

#### 3. Asset-key audit
**File**: `src/be/asset-key-audit.ts`
**Changes**: Share SQL constants and pure row-validation functions.
Keep separate synchronous boot loading and asynchronous runtime loading.
Do not use a single promise-returning body for a synchronous boot API.
Runtime callers use the supplied transaction executor for every read, including personal-user existence checks.
Remove `src/http/assets.ts` from the seam allowlist. Retain the boot audit exemption.
Compare both loaders' results on the same fixture. Prove that runtime audits see writes within their transaction.

### Verification and Success Criteria:

#### Automated Verification:
- [x] `bun run check:local`
- [x] `bun run test:root -- --parallel=4`
- [x] `bun run tsc:check:tsc && bun run lint && bun run lint:slop`
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] `bash scripts/check-async-db-seam.sh` passes with `src/be/script-connections.ts` and `src/http/assets.ts` removed from the allowlist
- [x] `grep -rn "resolveTemplate(" src --include=*.ts | grep -v tests | grep -v "resolveTemplateAsync\|function resolveTemplate\|//"` returns only the HTTP-mode worker callers (expected: none in `src/be`, `src/http`, `src/slack`, `src/*/handlers.ts`)
- [x] `bun run build:script-types` produces no diff in `src/scripts-runtime/types/*.d.ts`
- [x] `bun run e2e` and `bun run e2e --sut-env DB_DRIVER=worker`

#### Automated QA:
- [x] `bun run e2e --only knowledge-prompt-templates,script-connections,core-sessions --sut-env DB_DRIVER=sqlite`
- [x] `bun run e2e --only knowledge-prompt-templates,script-connections,core-sessions --sut-env DB_DRIVER=worker`
- [x] Session movement uses `/api/session-moves` and `/api/session-moves/prefix`, as exercised by `core-sessions`.
- [x] Verify stored template overrides, script type generation, and audit visibility within transactions.
- [x] Use source checks and driver instrumentation to prove the call path. Absence of slow logs is not sufficient evidence.

#### Manual Verification:
- [ ] None.

**Implementation Note**: Follow the implementation session's autonomy setting. Autopilot may proceed after checks pass. Stop on a failed Phase 0 gate. Commit only when authorized.

---

## Phase 3: `SqliteMemoryStore` lazy async init

### Overview

The memory store constructor runs no SQL. Vec and FTS bootstrap run once, asynchronously, in yielding batches, and every public method awaits readiness. `getHealth()` becomes async. The file leaves the seam allowlist.

**Review status, 2026-11-16:** independent Standards and Spec reviews completed and found five distinct issues.
The parent corrected FTS failure propagation, schema validation, health snapshots, shutdown bounds, and the readiness probe assertion.
Both corrected 20,000-embedding probes and the 254 focused memory tests passed.
Final verification passed on unchanged source hashes: 190 lifecycle tests, 14,869 affected tests, and 22,277 root tests.
Both memory scenarios and all 155 Worker black-box scenarios passed. Static checks passed.
Parent review accepts the Phase 3 automated gate. Phase 4 may proceed under autopilot.
See [Phase 3 evidence](../research/2026-11-16-worker-sqlite-phase3.md).

### Changes Required:

#### 1. Store initialization
**File**: `src/be/memory/providers/sqlite-store.ts`
**Changes**:
- Keep the constructor free of SQL. Store a nullable initialization promise and start it from `whenReady()`.
- Bootstrap schema through `getDbClient()`. Separate schema readiness from vector and FTS population promises.
- Complete schema readiness before starting background population. Internal bootstrap methods must not await their own readiness promise.
- Start population outside transaction context. Preserve existing FTS population behavior and fallback search while indexes remain incomplete.
- Public methods await schema readiness. Only operations that require a complete index await its population promise.
- Prevent readiness deadlocks when the caller already owns the client transaction lock. Initialize before transaction-dependent service work begins.
- If initialization has not started inside a transaction, fail with an actionable error instead of waiting on work queued behind that transaction.
- Make health queries asynchronous. Keep vector and FTS failure state separate.
- Degrade on optional extension absence. Propagate database, transport, and schema failures instead of resolving readiness as healthy.
- Populate vectors in batches of 500 with one transaction per batch. Yield between batches.
- Re-read source rows and write vector rows within each batch transaction. Preserve concurrent updates and deletes without duplicate or stale vectors.
- Do not treat concurrent UUID insertion as monotonic. New writes must maintain indexes directly while backfill advances its cursor.
- Use connection/client identity to invalidate cached health after reopen. A counter changed only during initial construction cannot detect a DB swap.
- Drain or cancel owned population work before closing the database. Do not reopen through background work after shutdown starts.

**File**: `src/be/memory/index.ts` and lifecycle call sites.
Reset the singleton and health cache on a database lifecycle change.
Expose `whenReady()` consistently for internal bootstrap and tests. Do not declare it private and then call it from tests.

**File**: `src/be/memory/types.ts:89`
**Changes**: `getHealth(): Promise<MemoryHealth>`.
**File**: `src/http/memory.ts:1327`
**Changes**: `await getMemoryStore().getHealth()`.
**Files**: 24 test files constructing `new SqliteMemoryStore()` (list in research spike: `memory-search-stall`, `memory-fts-populate`, `memory-store`, ...)
**Changes**: Await schema readiness and asynchronous health. Use explicit population completion where a test checks final index counts. Retain the stall regression and adapt it to the driver boundary. Add behavior coverage for initialization failure, concurrent writes, reopen, and shutdown. A zero raw-prepare count alone does not prove correct search behavior.
**File**: `scripts/check-async-db-seam.sh`
**Changes**: Remove `src/be/memory/providers/sqlite-store.ts`.

### Verification and Success Criteria:

#### Automated Verification:
- [x] Required memory suites and affected stall/population regressions pass: `bun run test:root -- src/tests/memory-reranker.test.ts src/tests/memory-store.test.ts src/tests/memory.test.ts src/tests/memory-e2e.test.ts src/tests/memory-search-stall.test.ts src/tests/memory-fts-populate.test.ts src/tests/memory-key-paths.test.ts src/tests/memory-embedding-space.test.ts`
- [x] `bun run test:root -- --parallel=4`
- [x] `bun run check:local && bun run tsc:check:tsc && bun run lint`
- [x] `bash scripts/check-async-db-seam.sh` passes without the sqlite-store entry
- [x] `grep -c "getDb()" src/be/memory/providers/sqlite-store.ts` prints `0`
- [x] `bun run e2e --only knowledge-memory` and `bun run e2e --sut-env DB_DRIVER=worker`

#### Automated QA:
- [x] Use synthetic memory fixtures with at least 20,000 embeddings. Do not copy production data.
- [x] Verify that first search completes correctly during population and that the main-thread probe remains responsive.
- [x] Verify final vector and FTS contents after concurrent updates, deletes, and inserts.
- [x] Verify population failures appear in health and that fallback search remains correct.

#### Manual Verification:
- [ ] None.

**Implementation Note**: Follow the implementation session's autonomy setting. Autopilot may proceed after checks pass. Stop on a failed Phase 0 gate. Commit only when authorized.

---

## Phase 4: CI coverage, docs, rollout

### Overview

CI covers both drivers. Runbooks describe their lifecycle and limits. A separate rollout PR requires staging evidence and explicit approval.

**Review status, 2026-11-16:** independent Standards and Spec reviews accepted the CI and documentation changes.
The parent corrected one Minor timing description to distinguish FIFO waits from SQLite BUSY spin.
Both reviews passed nine report tests and checked artifact isolation and failure propagation.
Full acceptance verification remains pending after upstream integration. Published PR checks remain a separate final gate.
See [Phase 4 evidence](../research/2026-11-16-worker-sqlite-phase4.md).

### Changes Required:

#### 1. CI
**File**: `.github/workflows/merge-gate.yml`
**Changes**: Keep the three existing SQLite shards unchanged.
Add one Worker job for the targeted scenario group, using `--sut-env DB_DRIVER=worker`.
Assert `dbDriver: worker` and use unique artifact names. Do not merge Worker results into the three SQLite shard files.
Make the required E2E aggregate depend on the Worker job and fail when it fails.
**File**: `.github/workflows/nightly-e2e.yml`.
Add a complete Worker contract run with separate results and reporting. Update the nightly report's expected inputs.
A partial PR job is smoke coverage. Only the full Worker run establishes full contract coverage.

#### 2. Docs and invariants
**File**: `runbooks/local-development.md`, `runbooks/ci.md`, `CLAUDE.md` (the async-seam `<important>` block)
**Changes**: Describe `DB_DRIVER`, the two-connection model, the "boot stays on the main thread" rule, and that `getDb()` is boot-only. In CLAUDE.md replace "even though the bun:sqlite implementation resolves synchronously under the hood" guidance with the driver note. `runbooks/heartbeat-crash-recovery.md` is untouched (no routing change).
**File**: `.asyncdb/residual-sync-allowlist.json`
**Changes**: Rewrite with current line numbers and the remaining boot-only entries, or delete it and point the seam script header at this plan.

#### 3. Observability
The effective driver field in authenticated stats ships in Phase 1. Verify it still reports the active connection.
Keep Worker execution, message round-trip latency, queue waits, and event-loop delay distinct.
Keep metrics and explicit explorer fallback listed as remaining synchronous paths.

#### 4. Flip (separate PR)
**File**: `Dockerfile:174` area, `charts/agent-swarm/values.yaml`, `docker-compose.example.yml`
**Changes**: Require one week of staging evidence before proposing a default change. Compare errors, throughput, tail latency, memory, BUSY behavior, and event-loop delay. Missing stall logs alone are insufficient. Rollback sets `DB_DRIVER=sqlite` and restarts the API against the same database. No schema rollback is required. Document startup and shutdown checks in the rollout PR.

Phase 0 review condition: measure sustained RSS without forced collection under `DB_DRIVER=worker` before proposing the default change.
Use the real boot-plus-Worker connection topology. Compare retained memory and transient peaks against `DB_DRIVER=sqlite`.
Phase 0's forced-collection samples do not establish production memory acceptance.

### Verification and Success Criteria:

#### Automated Verification:
- [ ] `bun run e2e --strict` and `bun run e2e --sut-env DB_DRIVER=worker --strict`
- [ ] `bun run docs:openapi` committed with no further diff: `git diff --exit-code openapi.json`
- [ ] `bun run check:local && bun run lint && bun run tsc:check:tsc`
- [ ] Merge-gate green on the PR with the new matrix entry: `gh pr checks <PR_NUMBER>`

#### Automated QA:
- [ ] Compare repeated runs with `bun run e2e:bench /tmp/e2e-sqlite.json /tmp/e2e-worker.json`. This command reports differences but does not enforce thresholds. Investigate scenarios above 1.5x and record absolute latency changes.

#### Manual Verification:
- [ ] Taras decides the flip date after reading the staging stall lines.

**Implementation Note**: Follow the implementation session's autonomy setting. Autopilot may proceed after checks pass. Stop on a failed Phase 0 gate. Commit only when authorized.

---

## Appendix

- **Follow-up plans**: `thoughts/taras/plans/2026-11-12-sql-dialect-lint-and-helpers.md`
- **Derail notes**:
  - `populateVecTable` today is unbatched and untransacted (one autocommit per row); fixed in Phase 3 as a side effect.
  - `src/http/metrics.ts:67,156` call the sync `executeReadOnlyQuery` and bypass the bounded explorer budget.
  - `.asyncdb/residual-sync-allowlist.json` line numbers are stale; `txn-analysis.json` referenced by the seam script header never existed.
  - Step 2 of the research (read-only worker pool for `readOnly` transactions) is a natural follow-up once this plan ships.
- **Phase 0 results**: PASS for default-off Phase 1. The parent accepted measured transfer and memory costs after both reviews.
- **References**:
  - Research: `thoughts/taras/research/2026-11-12-async-db-and-query-engine-abstraction.md`

### Phase 0 results

Evidence version 2 supersedes the initial measurements.
Full tables, commands, and limitations: [result note](../research/2026-11-15-worker-sqlite-phase0.md).
Raw evidence: [JSON](../research/2026-11-15-worker-sqlite-phase0.json).

Both platforms used pinned Bun 1.4.4 and native arm64. Linux ran an embedded Worker in a compiled Debian image.
Every measured connection passed sqlite-vec insert and nearest-neighbor queries with 512-dimensional Float32 vectors.
Fixtures match all 92 task columns and 27 memory columns. Each driver and case runs in a fresh process.
Two rounds counterbalance driver order. Serialization experiments run separately from memory measurements.
Ordinary cases have 20 samples. Calibrated long queries have six samples.

All timing values below use milliseconds. Each pair shows macOS / compiled Linux.

| Case | SQLite RTT p50 | Worker RTT p50 | Worker RTT p95 | Added RTT p50 | Worker transport lag max |
|---|---:|---:|---:|---:|---:|
| session_logs, 200 rows | 0.672 / 1.163 | 2.274 / 3.649 | 2.944 / 5.781 | 1.602 / 2.486 | 2.038 / 2.743 |
| agent_tasks, 100 rows | 1.414 / 2.753 | 2.785 / 5.419 | 3.441 / 7.949 | 1.371 / 2.666 | 1.831 / 4.283 |
| agent_memory, 50 BLOB rows | 0.374 / 0.704 | 0.673 / 1.415 | 0.864 / 2.630 | 0.299 / 0.711 | 2.448 / 3.736 |
| kv_entries, 20,000 rows | 16.385 / 20.585 | 46.408 / 53.723 | 48.264 / 58.672 | 30.023 / 33.138 | 9.803 / 10.270 |
| Recursive CTE | 966.503 / 996.392 | 1000.926 / 993.571 | 1009.098 / 1021.036 | n/a | 2.923 / 4.060 |
| 100 small statements | 0.063 / 0.109 | 2.113 / 4.105 | 2.860 / 8.628 | 2.050 / 3.996 | 1.834 / 3.790 |

The long-query lag limit is 50 ms. Both platforms pass.
Each long query calibrates independently. Its RTT difference receives no transport-savings credit.
Session logs and small statements exceed 3x. Their absolute costs support acceptance for the default-off implementation.
KV adds 30 to 33 ms RTT while reducing maximum main-thread transport lag from 22.0 / 27.9 ms to 9.8 / 10.3 ms.

Initial baseline-adjusted KV measurements showed about 100 MiB additional sampled peak RSS.
Some macOS baseline samples crossed measurement stages, shifting adjusted differences by up to 4.6 MiB.
The sampler now rejects those samples. Gate acceptance uses absolute peaks and paired post-collection readings.
Absolute KV sampled peaks reached 194.3 to 195.7 MiB for SQLite and 297.7 to 298.3 MiB for Worker on macOS.
Linux absolute peaks reached 175.7 to 176.6 MiB for SQLite and 266.2 to 285.2 MiB for Worker.
After collection, paired Worker RSS exceeds SQLite by 102.0 to 104.0 MiB on macOS and 8.5 to 14.8 MiB on Linux.
RSS samples are lower bounds. Forced collection limits their applicability to sustained production workloads.
Native allocation causes remain unresolved. Linux x64 and the production two-connection topology remain Phase 1 verification items.

Repository lint, root TypeScript, direct benchmark lint, and benchmark TypeScript checks pass.
Negative checks reject missing extensions on the Worker and reject invalid driver selection.
Owned benchmark products and temporary files were removed. OrbStack returned to its original stopped state.
The correction recovered 4.085 GiB during cleanup. Its net disk usage increased 1.148 GiB for an unresolved reason.

**Gate verdict: PASS for Phase 1 with `sqlite` still the default.**
Both review axes passed without critical findings. The parent corrected the sampler boundary and clarified forced-GC bias.
Final macOS benchmark, direct typechecking, and repository lint passed after those changes.
The final macOS report is preserved separately in the JSON. Compiled Linux capability and timing evidence remains from version 2.
The parent accepts the transfer overhead, transient Linux memory increase, and measured post-collection retention for experimental implementation.
This is an engineering acceptance decision, rather than proof against an unspecified production memory budget.
Linux x64, the production connection topology, and sustained memory behavior remain explicit verification obligations.
No production rollout or default change is approved. Taras's manual-review checkbox remains unchecked under autopilot.

## Review Errata

_Reviewed: 2026-11-15 by Codex. Autopilot documentation fixes only._

### Applied

- [x] Critical: replace the explorer benchmark with a production-client benchmark.
- [x] Critical: forward the driver through the E2E runner and assert the effective driver.
- [x] Critical: define transaction ordering, commit deadlines, and uncertain outcomes after transport loss.
- [x] Critical: include runtime prompt-template listing, mutations, and reset alongside resolution.
- [x] Important: define startup, shutdown, file-backed tests, and vector capability ownership.
- [x] Important: preserve `runTimed` own-change semantics on the Worker connection.
- [x] Important: remove the editable UI entry for an env-only reserved flag.
- [x] Important: report driver selection through authenticated stats, preserving public health privacy.
- [x] Important: separate memory readiness from population and prevent lifecycle deadlocks.
- [x] Important: retain synchronous boot auditing without a false sync/async shared-body contract.
- [x] Important: separate Worker query duration from main-thread stall attribution.
- [x] Important: fix CI artifact isolation, scenario names, memory suites, and benchmark expectations.
- [x] Minor: add planner metadata, phase verification headings, portable commands, and bounded cleanup.

### Evidence and limits

Review checked source at the recorded base commit. Implementation and performance validation remain pending.
Document validation checked required sections, package commands, existing scenario names, referenced test files, and Bash syntax.
The review could not execute `bun run e2e --list` because the checkout lacks `xlsx`. Scenario names were checked against source exports.
Phase 0 remains the go/no-go gate. These edits do not approve production rollout.

External API checks: [Bun Workers](https://bun.sh/docs/runtime/workers), [Bun SQLite](https://bun.sh/docs/runtime/sqlite), and [compiled Worker entrypoints](https://bun.sh/docs/compiler/executables).

Bun requires explicit compiled Worker entrypoints. Verify macOS custom-SQLite initialization on the pinned runtime before accepting vector support.

## Manual E2E

These commands run after implementation. The E2E runner creates a real API, isolated database, free port, and mocked external services.
Do not use the explorer to measure the client driver. Its isolated query executor is a different path.

```bash
# Existing command forms from LOCAL_TESTING.md, with explicit SUT overrides.
bun run e2e --list
bun run e2e --sut-env DB_DRIVER=sqlite --json /tmp/db-worker-e2e-sqlite.json
bun run e2e --sut-env DB_DRIVER=worker --json /tmp/db-worker-e2e-worker.json
bun run e2e:bench /tmp/db-worker-e2e-sqlite.json /tmp/db-worker-e2e-worker.json

# Planned benchmark command. It must use the production client after Phase 1.
bun scripts/bench-db-worker.ts --driver sqlite --assert
bun scripts/bench-db-worker.ts --driver worker --assert
```

Compiled image smoke test, run in Bash. The container publishes an available port and owns its temporary database.

```bash
set -euo pipefail
df -h /
review_image="agent-swarm-api:db-worker-$(date +%s)"
review_container="db-worker-$(uuidgen | tr '[:upper:]' '[:lower:]')"
cleanup() {
  docker rm -f "$review_container" >/dev/null 2>&1 || true
  docker image rm "$review_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker build -f Dockerfile -t "$review_image" .
docker run --rm -d --name "$review_container" \
  -e DB_DRIVER=worker -e DESPLEGA_TELEMETRY_ENV=test \
  -e AGENT_SWARM_API_KEY=db-worker-local-test \
  -e DATABASE_PATH=/tmp/db-worker.sqlite \
  -p 127.0.0.1::3013 "$review_image"
review_port=$(docker port "$review_container" 3013/tcp | awk -F: '{print $NF}')
curl --fail --retry 30 --retry-connrefused --retry-delay 1 \
  "http://127.0.0.1:$review_port/health"
curl --fail -H "Authorization: Bearer db-worker-local-test" \
  "http://127.0.0.1:$review_port/api/stats"
# Require dbDriver=worker in this authenticated response. Use the MCP recipe in LOCAL_TESTING.md
# against this URL: join-swarm, send-task, get-task-details, store-progress, memory-search.
# Use a UUID agent ID and the isolated test credential configured for this container.
# Assert persisted task data and vector capability, not only successful boot.
cleanup
trap - EXIT INT TERM
rm -f /tmp/db-worker-e2e-sqlite.json /tmp/db-worker-e2e-worker.json
df -h /
```
