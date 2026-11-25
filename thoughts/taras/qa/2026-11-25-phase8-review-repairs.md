# Phase 8 delivery review repairs

Base: `9f8f2d95ef`.
Branch: `fix/phase8-delivery-review`.

Disabled supervisors retain launch rows without creating permanently unconsumed events.
Reconciliation recovers those rows after the supervisor is enabled.
Stopping the bus suppresses pending wake callbacks, including callbacks from an earlier start.

Durable groups come only from the shared catalog.
The backend rejects undeclared groups. Storage-neutral fixtures supply their own catalog through `BusDurableGroups`.
Publication creates delivery rows before any subscriber exists.

Failed deliveries remain pending indefinitely.
Retry delays double from the sweep interval to a five-minute maximum.
An expired lease can repeat a handler. The claim token still fences acknowledgement.
The API records operation, topic, group and event ID when available.
It scrubs the complete error and context before writing stderr.

Retention deletes at most 500 events per transaction.
A full batch keeps retention due for the next wake or sweep.
A partial batch restores the hourly interval.
The runbook describes the serial pump, concurrent instances, ordering limits and retry policy.

## Verification

The PostgreSQL server was `127.0.0.1:32768`.
Each test created and removed its own database.

| Check | Result |
| --- | --- |
| Focused bus contract and PostgreSQL tests | 9 passed, 149 assertions |
| PostgreSQL public launch and recovery scenarios | 2 passed, 0 failed, 0 flaky |
| Root TypeScript authority check | Passed |
| E2E TypeScript check | Passed |
| Biome on changed TypeScript files | Passed |
| Storage, SQL portability, transaction callback and E2E boundaries | Passed |
| Floating promises and unsafe promise sinks | Zero findings |
| Unit test allowlist against the base | Passed |
| Diff whitespace | Passed |

Commands:

```bash
STORAGE_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres bun test --path-ignore-patterns='' packages/storage-postgres/test/bus.test.ts --timeout 30000
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres bun run e2e --engine postgres --only stress-bus-claim,bus-launch-recovery
bun run tsc:check:tsc
bun run e2e:tsc
bun run check:storage-boundary
bun run check:sql-portability
bun run check:tx-callbacks
bash scripts/check-e2e-boundary.sh
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bun scripts/check-unit-test-allowlist.ts --base 9f8f2d95ef
git diff --check
```

The public stress scenario completed 20 synthetic launches with 20 events, 20 deliveries and 20 attempts.
It restarted the API with a test-only zero retention horizon.
The normal pump removed those events and preserved all 20 run records.
The production retention horizon remains seven days.

The public recovery scenario proved disabled launch recovery, same-boot deferral, rollback and recovery after a crash following COMMIT.
The bus recovered the crash launch with reconciliation disabled.

The storage fixture added 1001 expired delivered events beside one pending event.
An explicit prune deleted exactly 500 events.
Subsequent pump passes deleted the remainder without waiting one hour and preserved the pending event.
The retry contract failed twelve times before success. A separate check retained a pending event after attempt 21.

The full focused run recorded eight retried claims among 104 claim transactions under shared machine load.
A separate contention-only run recorded four among 104 transactions (3.85%), with 20 retry attempts.
Both runs delivered all 100 events once successfully. SERIALIZABLE isolation remained unchanged.

## Test growth and limits

Coverage added 206 test lines and removed 15 test lines.
The original tests lacked shutdown suppression, group validation, retry cap and backlog recovery checks.
They also lacked public disabled-launch and retention checks.
The fixture replaces a timer sleep with an after-commit barrier.

No migration, push or pull request was required.
The full concurrent suite and merge gate were outside this task.
Phase 6 owns the database fence. The parent must integrate that fence with these launch hooks.
The focused tests establish behavior on this base, not the combined Phase 6 implementation.
The diagnostic test checks error context. It does not inject a secret into a live API error.
