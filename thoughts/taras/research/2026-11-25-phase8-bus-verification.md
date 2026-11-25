# Phase 8 execution bus verification

Base: `2ef4461c2e74686c919aa3cc9ec010c4a0e1bb93`.
Branch: `t3/durable-event-bus`.
PostgreSQL maintenance URL: `postgres://postgres:postgres@127.0.0.1:32768/postgres`.
Each storage fixture and API suite creates and removes its own database.

The bus lives in the API storage layer. Script runners never connect to the database.
Migration 381 creates PostgreSQL event and delivery tables. SQLite receives a parity stub.
The existing realtime and workflow subscribers retain their current behavior.

A launch writes its event in the same transaction as its run and principal.
The stable topic catalog reserves `script-dispatcher` before a consumer starts.
Each claim uses SERIALIZABLE isolation and `FOR UPDATE SKIP LOCKED`.
The handler runs after the claim commits. A unique claim token fences acknowledgement.
A failed handler retries after the sweep interval. An abandoned claim expires after 60 seconds.

Background launches still start directly. Deferred launches record the originating API boot in their event.
That boot acknowledges the event without starting a guest.
A different boot starts a run from an event left pending by a crash.
The ordinary supervisor scan still recovers deferred runs.
The existing durable scenario remains unchanged.

| Verification | Result |
| --- | --- |
| Reusable bus contract and PostgreSQL lease/retention tests | 6 passed |
| SQLite storage suite | 413 passed with a 30-second test timeout |
| PostgreSQL storage suite | 511 passed |
| Migration data-copy type contract after the bigint correction | Passed |
| Schema parity | Zero unexplained differences, 168 allowlisted, zero allowlist errors |
| Storage boundary, SQL portability, transaction callbacks, trigger and text-column checks | Passed |
| Migration numbering and monotonicity | Passed against origin/main tail 374 |
| TypeScript authority check | Passed |
| Dependency graph and driver imports | Zero errors; existing warnings remain |
| Existing SQLite durable and source-storage scenarios | Both passed |
| Existing PostgreSQL source-storage restart scenario | Passed |
| Unchanged PostgreSQL durable scenario with boot deferral | Passed in the final run |
| Final PostgreSQL deferral, rollback and crash recovery scenario | Passed; focused run 3/3 with no flaky retries |
| Public launch stress scenario | Passed on both engines |

The new PostgreSQL tables have no SQLite text columns.
Adding their names to `.text-columns.json` would create stale entries in its SQLite schema check.
Their bigint clocks require no timestamp decoder entries in `column-types.json`.
Schema parity explains both tables with explicit allowlist entries.

The public benchmark launches 20 durable runs without a remote script runner.
PostgreSQL stored 20 events and 20 deliveries. Delivery attempts totaled 20.
`STORAGE_TX_STATS_FILE` recorded 38 claim transactions, zero retried claims, and zero exhausted retries.
The measured claim retry rate was 0%, below the 5% threshold. Isolation remains SERIALIZABLE.
The benchmark passed with exit code zero on both engines.

The separate contention test used two consumers and 100 events.
It recorded 104 claim transactions, five retried claims, and 23 retry attempts.
That claim retry rate was 4.81%. All 100 events reached exactly one successful handler.

The retention fixture published 20 events through the bus before starting a consumer.
A replacement consumer delivered all 20 events. The test then aged their publication and delivery clocks.
Retention removed 20 events and their 20 deliveries in 1.98 ms.
It preserved a newly delivered event until its delivery horizon expired.
It also preserved an old event with a pending delivery.
These retention measurements use storage fixtures, separate from the 20 public launches.

The launch recovery scenario injects a rollback through the public launch route.
It checks that neither a run nor an orphan event survives.
It also exits the API after COMMIT and before delivery, then restarts with reconciliation disabled.
A pending event must start and complete the run through delivery alone.
The final execution passed same-boot deferral and the full crash sequence.
The focused PostgreSQL run passed all three scenarios without flaky reruns.

Phase 6 integration must retain these launch and supervisor hooks.
Its durable dispatcher must apply its owner fence before starting a run.
This branch starts from Phase 5 and cannot test the later ownership columns.

The broad local loop passed formatting, lint, root types, and generated-file drift checks.
Its affected tests exposed a response stub without `res.once` in `scripts-mcp-e2e.test.ts`.
The integrated inline handler at `src/http/scripts.ts:911` calls that method.
The loop also reported existing timer and gitleaks performance assertions under concurrent machine load.
No Phase 1 implementation or unrelated test files changed here.

Initial API boots sometimes exceeded the existing 60-second health deadline under concurrent suite load.
The focused public scenarios subsequently passed without changing that deadline.
The broad loop and full strict suite were still running when this record was drafted.
Their partial results do not establish a green full merge gate.
