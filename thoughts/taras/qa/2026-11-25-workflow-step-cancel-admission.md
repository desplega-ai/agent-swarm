# Workflow step cancellation admission repair

Base: frozen integrated `d0c9373107`.
Repair: `44f994b78c`.
Only disposable local PostgreSQL databases and synthetic scripts were used.
PostgreSQL endpoint: `127.0.0.1:32768`.

## Root cause

Cancellation revokes the credential and releases the API reservation immediately.
The worker still counts its cancelled step until the guest finishes cleanup.
A replacement can arrive during that interval.
The worker previously rejected it with `executor_error` because its single slot remained occupied.
The API then settled that replacement as failed before its script could start.

The unfixed standalone public scenario failed twice at `replay fixture starts`.
Safe diagnostics showed a cancelled original row and a failed replacement row.
The replacement error was `swarm-script: script exited with code 1 (executor_error)`.
The worker log recorded the original guest as killed.

The client and step dispatcher match the earlier Phase 9 source at `a43bc31e29`.
The earlier successful run therefore did not establish correct cancellation admission under this message ordering.

## Repair

New `job` and `durable-job` messages wait for cancelled step cleanup before admission.
The worker then rechecks the current socket, stop state, capacity and capabilities.
Lease, cancellation and acknowledgement frames continue through independent message callbacks.
Guest completion does not wait for API acknowledgement, so this wait has no acknowledgement dependency.
Credential revocation and owner cleanup retain their existing timing and generation guards.
The public scenario keeps the same assertion and timeout.

## Regression

The worker test uses a real native guest and a real WebSocket connection.
A local HTTP callback confirms that the first guest has started.
The fixture sends cancellation followed immediately by a replacement on a runner with one slot.
The unfixed test fails because the replacement returns no result value.
The repaired test completes the replacement with result 42 after the cancellation result.
Its focused run passed in 385 ms.

One attempted repaired test could not establish its WebSocket connection and timed out before welcome.
The subsequent focused test established its connection and passed.

Commands:

```bash
bun run test:root -- src/tests/script-runner.test.ts --test-name-pattern 'step cancellation cleans'
bun run test:root -- src/tests/script-runner.test.ts
bun run tsc:check:tsc
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres bun run e2e --engine postgres --only workflow-script-park-restart
```

## Frozen repair results

All source files stayed unchanged during these runs on `44f994b78c`.
The harness retained its committed 60-second startup budget.

- Full worker file: 18 passed, 0 failed, 58 assertions, 63.54 seconds.
- TypeScript 5: passed.
- Floating promise check: zero findings.
- Promise sink check: passed.
- Standalone PostgreSQL scenario: 1 passed, 0 failed, 0 flaky, first attempt, 178.7 seconds.

The public scenario emitted this synthetic evidence:

```json
{"fixture":"workflow-script-park-restart","executions":{"running":1,"queued":1,"cancel":1,"replay":2,"stopped":2},"cancelledJobs":1,"liveCancelledCredentials":0,"replayOwnerChanged":true,"stoppedOwnerChanged":true}
```

Both scripts survived the API restart with one execution each.
Cancellation persisted one cancelled job and left zero live credentials.
SIGKILL and SIGSTOP each caused exactly two executions and changed the stored claim owner.
The unchanged failure, retry and secret-redaction assertions also passed.
The disposable databases and runner processes were removed by the harness.
No push or pull request was created.
