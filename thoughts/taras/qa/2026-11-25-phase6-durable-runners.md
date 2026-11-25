# Phase 6 verification

Revision: `6f583bf3c6`, following `e2539682c5`, `940dbc5fb4` and `c75bd50d20`.
Branch: `t3/durable-capability-session`.
All infrastructure used disposable local databases and synthetic data. PostgreSQL used port 32768.
Migration 380 was applied only to this task's disposable databases. No production database was accessed.

## Implementation

The API retains broker credentials and verified launch authority. It mints credentials after placement and claim.
Historical runs retain journal-only authority. The runner guest receives neither the broker bearer nor the swarm key.

Remote ownership binds the credential ID and instance UUID through SHA-256. Public instance UUIDs still identify sessions and capacity.
The storage methods fence claims, renewal, settlement and release. Journal writes and agent-task creation check ownership inside their committing transactions.
Capability dispatch checks ownership after the eight-request limiter. Reconnect reuses pending requests before admission counters increase.
Delivery acknowledgements evict cached capability responses. Each session bounds retained responses to 64 requests and 64 MiB.

Guests start after API-confirmed lease renewal. Deadlines use monotonic heartbeat send timestamps.
An unacknowledged heartbeat never extends a deadline. Expiry stops the guest process group while disconnected.
Cancellation retains capacity until cleanup confirmation. The fallback excludes the session before releasing capacity.
Drain announcement precedes refusal of new jobs. Both pickers exclude draining sessions.

Embedded ownership has no lease expiry. The existing PostgreSQL process lock and write fence protect database takeover.
The owner fence checks the lock session before writes. A new process waits for transactions from the previous owner.
Explicit embedded slots remain authoritative. Unset embedded slots preserve unlimited fallback, including long runs.

Phase 9 hooks remain available for heartbeat, result and reconnect. Confirmed hook renewals enter the common lease reply.
Phase 10 can extend the job union and runtime filter through the shared synchronous reservation API.
Phase 8 must publish completion through the transaction that calls `settleOwnedScriptRun`.

## Passing checks

| Check | Result |
| --- | --- |
| `bun run test:root -- src/tests/script-runner.test.ts` | 13 passed, 44 assertions. Real guest environment and temp JSON exclude the synthetic runner credential. |
| Durable HTTP, scrub and runtime files | 75 passed, 1 skipped, 395 assertions. The skipped process-limit test requires the supported sandbox environment. |
| SQLite storage contract selection | 4 passed, 60 assertions. Includes owner guard, renewal and settlement checks. |
| PostgreSQL storage contract selection | 4 passed, 51 assertions. |
| `bun run e2e --only script-runner-durable` | Passed SQLite refusal through the public API. |
| Root `bun check` | Passed, 1,564 files. |
| `bun run tsc:check:tsc` | Passed after the credential-bound owner change. |
| E2E `bun check -p scripts/e2e/tsconfig.json` | Passed, 393 files. |
| Floating promises and promise sinks | Zero findings. |
| Database boundary | Passed. |
| Unit-test allowlist | Passed. |
| Schema parity | Passed, zero unexplained differences and 166 allowlisted differences. |
| Migration ordinal and TEXT column checks | Passed. |

The final stable-source lifecycle scenario failed twice before the shutdown repair.
The first attempt missed the SIGSTOP completion deadline while its remaining steps committed near that deadline.
The retry passed all interruption cases, then left the durable run running after API restart.
The parent diagnosed a shutdown admission race and supplied `82e0ef397f`, applied locally as `6f583bf3c6`.
The repair preserves the upgrade handler during shutdown and returns retryable 503 instead of the ordinary HTTP authentication response.
The focused restart proof passed with that repair.
A remote run slept for 20 seconds between journal steps. After API SIGTERM and restart, it completed with exactly two journal rows.
A lead-authorized synthetic config secret appeared in guest stderr and was redacted in the stored error.
Receipt: [2026-11-25-phase6-restart-proof.json](./2026-11-25-phase6-restart-proof.json).

The benchmark reused the Phase 0 guest against the shipped transport, with 200 samples per operation.
Raw results: [2026-11-25-phase6-durable-bench.json](./2026-11-25-phase6-durable-bench.json).

| Operation | Embedded p50 | Remote p50 |
| --- | --- | --- |
| New journal step | 186.71 ms | 40.03 ms |
| Replayed journal step | 17.05 ms | 3.00 ms |
| Swarm call | 41.15 ms | 5.67 ms |

Both legs completed, including 32 concurrent swarm calls.
The embedded leg ran under heavier machine load. These sequential measurements do not isolate tunnel overhead.
They cannot establish agreement with the Phase 0 increment of 1.35 ms p50.
A repeatable overhead comparison requires a quiet machine and interleaved measurements.

## Failed attempts and limits

The first complete PostgreSQL lifecycle run passed in 344.6 seconds before the final review repairs.
It covered SIGTERM, SIGKILL, SIGSTOP, cancellation, long-lane capacity and the 40-second embedded run.

A later run failed the new API-restart assertion while implementation revisions changed during its restarts.
Its retry used cached scenario code with the old owner assertion against the new credential-bound owner.
The earlier mixed-revision run cannot establish the current restart behavior.

The ordinary 60-second health deadline failed under concurrent machine load.
The parent authorized a temporary 180-second local deadline for diagnosis.
The committed harness retains its original 60-second deadline.

`bun run check:local -- --skip-e2e` completed with 8,088 passes and 34 failures.
Some HTTP fixtures lack `res.once` after the Phase 5 abort listener change.
A migration 112 fixture fails at migration 377 because its synthetic database has no `script_runs` table.
Several workflow cascade and restart tests timed out or failed shared fixture expectations.
One identity test loaded the earlier cached sessions module while source edits continued.
The pure helper now has its own module, and the focused worker suite passes.
The parent owns integrated fixture repairs and broad verification.

The complete storage suite, the four existing public durable scenarios and `e2e --strict` remain integration gates.
The focused checks do not replace those gates.
The focused remote secret-stderr proof passed. Existing scrub tests also pass.
External side effects that begin before lease loss cannot be rolled back.
Taras's manual security review and long-lane default confirmation remain open.

## Commits

- `d4e7a14779`: transport repair from `0b9ec541a1`.
- `e9e3961cae`: ownership migration, repository methods, capability session and durable guest.
- `3a96a83af0`: durable transport, supervisor and reservations.
- `b5746a6493`: integrated Phase 5 capacity commit. Avoid applying its original equivalent twice.
- `086f4e8952`: shared capacity hooks, metrics and documentation.
- `e7536396aa`: interruption coverage, timestamp precision and generated OpenAPI.
- `c75bd50d20`: capability fences, confirmed leases, cancellation and drain review repairs.
- `940dbc5fb4`: credential-bound persisted owner and shared lease confirmation.
- `e2539682c5`: capability failure cleanup and guest credential absence checks.
- `6f583bf3c6`: parent shutdown repair, equivalent to `82e0ef397f`. Avoid applying both.

## Cleanup

The original 60-second health deadline was restored before the final documentation commit.
The owned test harnesses stopped their API and runner processes and deleted their disposable databases and test directories.
Task-local benchmark helpers and logs were removed after these receipts were saved.
No shared caches or dependency directories were deleted.
Removed 61 owned temporary files, totaling 2,637,824 allocated bytes.
Available disk space changed from 15,908,688 KiB to 15,914,448 KiB during cleanup.
Other sessions remained active, so the system-wide change also includes their activity.
