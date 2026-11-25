# Phase 9 workflow step jobs QA

Core revision: `e38dd8b62b`. Public scenarios and runbooks: `e5fb9f82d7`.
Scope: local synthetic scripts, the real API, real runner processes and PostgreSQL at `127.0.0.1:32768`.
No provider, production swarm, push or pull request was used.

## Implementation and ownership

Migration 382 creates reference-only job rows. Forward migration 383 aligns PostgreSQL types and copy identity.
The API reserves shared sync capacity before it claims a row.
Each stored owner combines the credential-bound runner identity and a unique claim generation.
Result, renewal, reconnect and cancellation paths check this owner.
The checkpoint preserves immutable script references for each attempt.
The API builds payloads and mints credentials only during dispatch.
Job rows contain no payload, credential or raw result.
The result transaction settles the checkpoint, revokes credentials and publishes the finished event before acknowledgement.
The worker retains unacknowledged results and repeats them on the existing heartbeat and after reconnect.
Confirmed leases bound execution during API outages.

## Focused checks

| Check | Result | Tested revision |
| --- | --- | --- |
| SQLite workflow job contract | 1 pass, 18 assertions | `6ce4ab7fa9` |
| PostgreSQL workflow job contract | 1 pass, 18 assertions | `6ce4ab7fa9` |
| Schema parity | 0 unexplained differences, 169 allowlisted | `6ce4ab7fa9` |
| PostgreSQL data-copy chain | 2 pass, 7 assertions | `6ce4ab7fa9` |
| Workflow units after shared foreach settlement | 65 pass, 1 skip, 197 assertions | `c8e00f1e25` |
| TypeScript 5 | Pass | `08be83eae1` |
| E2E fixture TypeScript | Pass | `08be83eae1` |
| Worker transport | 15 pass, 49 assertions | `e38dd8b62b` |
| Floating promises and promise sinks | Pass | `e38dd8b62b` |
| Restart public scenario | 1 pass, 0 flaky, first attempt, 214 seconds | See revision boundary below |
| Fanout public scenario | Pass, 8 bodies and 40 bodies | `c8e00f1e25` plus validation-input repair |

Commands:

```bash
bun run tsc:check:tsc
bun run e2e:tsc
bun run test:root -- src/tests/script-runner.test.ts
bun run test:root -- src/tests/workflow-*.test.ts
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres bun run e2e --engine postgres --only workflow-script-fanout,workflow-script-park-restart
STORAGE_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres bun run check:schema-parity
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
```

The fixture used a temporary 180-second startup budget under shared host contention.
The repository's 60-second budget remains unchanged in the committed harness.

## Public fanout evidence

Eight one-second bodies completed in 2,735 ms on two runners with two slots each.
The returned results preserved item order. Peak concurrency was four.
All eight job rows completed and contained no payload or result column.
Forty additional bodies completed on one slot without a capacity failure.
These are distinct checks. The forty-body check uses 20 ms bodies and has no five-second assertion.

## Benchmark and dashboard evidence

The benchmark used 40 bodies of 500 ms. Each remote runner advertised two slots.
The API disabled embedded slots for each remote comparison.
The sequential comparison used the ordinary awaited path without remote runners.

| Runners | Total milliseconds |
| --- | ---: |
| No remote runner | 23,560 |
| 1 | 15,326 |
| 2 | 20,896 |
| 4 | 11,553 |

All four runs reached completed status before these timings were recorded.
These measurements came from a temporary public-API fixture on `e38dd8b62b`.
The shared host ran other suites concurrently. Serialization conflicts affected the remote cases.
The measurements do not establish reliable scaling. In particular, the two-runner case was slower than the one-runner case.
The benchmark fixture later timed out while waiting for browser evidence.
A separate dashboard fixture passed after the capture completed.

The named browser session was `phase9-waiting`.
The screenshot shows the waiting run, the waiting foreach parent and waiting script bodies.
The API returned nine waiting steps: one parent and eight bodies.
The fixture disabled embedded slots and connected no runner to preserve this visible state.
It cancelled the run after capture.
The image is stored in agent-fs at `qa/agent-swarm/2026-11-25-phase9/workflow-waiting.png`.
The fixture used only synthetic identity and organization data.

## Restart and cancellation evidence

The focused Phase 9 fixture passed on its first attempt in 214 seconds.
It verified one running job and one queued job across API restart, with each KV effect occurring once.
Cancellation persisted one cancelled job and left no live per-step credential.
Real SIGKILL and SIGSTOP cases each executed the in-flight script twice and changed its stored owner.
The failure cases produced attempts zero and zero-plus-one, according to the retry policy.
All three failure rows retained `[REDACTED:config:...]` errors without the known secret.
The API process used `08be83eae1`.
The source gained heartbeat replay during the fixture, before replacement runners started.
This run therefore used mixed worker revisions. The parent must repeat it on the final integrated snapshot.
The final scenario adds nonempty-row and redaction-marker assertions against facts confirmed in this fixture database.


The parent ran the combined Phase 11 fixture on integrated `86412c6570` with shutdown repair `82e0ef397f`.
Its first attempt passed: 1 passed, 0 failed and 0 flaky.
API downtime was 10,905 ms. The runner completed hello 431 ms after health returned.
The fixture recorded 11 refused SDK requests.
The original workflow process survived with its original claim and attempt.
Two durable guest processes executed. The original durable process died.
Each journaled effect occurred once.
This evidence came from the Phase 11 agent, rather than a second local run here.

## Investigation record

An early fanout attempt exceeded five seconds during host contention.
A later focused run met the unchanged five-second assertion.
The initial restart fixture reused a workflow name. The fixture now assigns distinct names to each case.
A four-runner benchmark exposed a missing replay after PostgreSQL serialization failure on a healthy socket.
The worker retained the result but previously repeated it only after reconnect.
Commit `e38dd8b62b` repeats retained step results on the existing heartbeat.
Its worker fixture drops a result, observes retransmission, reconnects, then acknowledges it.

## Remaining integration gates

The parent owns the full check loop, broad engine suites and final integrated proof.
Local focused evidence does not replace those gates.
Taras still needs to confirm the documented trigger semantics at the plan's manual review point.

## Cleanup

The browser session and UI server stopped. Temporary fixture files and the retained database were removed.
Shared caches and dependency directories were preserved. Available disk space remained approximately 16 GiB.
