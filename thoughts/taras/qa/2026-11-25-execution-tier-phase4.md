# Execution tier Phase 4 QA

This correction starts from integrated commit `2ef4461c2e`.
The parent owns `src/http/scripts.ts` and deployment manifests. This change preserves the capacity API signatures.
No push or PR occurred.

## Implemented contracts

- Credential lookup exceptions produce HTTP 503 before upgrade or WebSocket close 1011 after upgrade.
- Admission rechecks the bearer after registering revocation handling. Each ping retains the issuer's explicit permission check.
- Duplicate instance IDs receive retryable close 1011. Connections cannot replace sessions or adopt held jobs.
- RPC deadlines use the job's wall time plus five seconds. Unanswered cancellation terminates the socket after five seconds.
- Termination resolves pending calls. Send failures terminate sockets.
- Each outgoing job and result must fit the frame limit. Oversized results return a small executor error.
- A runner watchdog aborts inline work after 45 seconds without API pings.
- Readiness uses optional `SCRIPT_RUNNER_READY_FILE`. Its parent must be private and belong to the runner UID.
- Readiness publication creates an exclusive regular temporary file, then atomically renames it. Symlink paths are refused.
- Native startup tests UID 65534 with benign `setpriv`. A token file readable by that UID prevents startup.
- The shared UID override prints a warning and fails when `NODE_ENV=production`.

The packaged readiness path is `/run/agent-swarm-script-runner/ready`. The parent must prepare its directory with mode 0700.
Source runners can omit the readiness variable.
The operator runbook describes plaintext job configuration, resolved credentials, connection descriptors and results.

## Regression evidence

Synthetic peers test transient HTTP and socket failures, silent loss of API pings, and oversized-result isolation.
Readiness tests use an ordinary temporary directory and a symlink fixture.
The PostgreSQL scenario also covers duplicate IDs across two credentials, held-job refusal, missing results and unanswered cancellation.
These fixtures contain no intrusion examples.

New coverage protects transport behavior that the previous schema and dispatcher checks did not exercise.
The worker test file needs a narrow allowlist entry because public API calls cannot omit server pings or inspect worker result frames.
Added test code: 270 lines across the worker file and the E2E scenario. No independent checks were removed.

Passed:

```bash
bun install --frozen-lockfile
bun run test:root -- src/tests/script-runner.test.ts
# Eight checks passed before the final oversized-result check was added.
bun run test:root -- src/tests/script-runner.test.ts -t oversized
# The additional check passed, including a repeat after correcting its outcome log.
bun run tsc:check:tsc
bun run e2e:tsc
bun run e2e --only script-runner-remote-sync,cli-script-runner
# Two passed on SQLite. The remote scenario verifies SQLite refusal only.
bun run check:unit-test-allowlist
bun run docs:openapi
# Regenerated openapi.json and docs-site/public/openapi.d.ts.
```

The floating-promise check reported zero findings.
The promise-sink check reported zero findings. Database, API-key and E2E boundary checks passed.
Biome checked all seven changed TypeScript files without changes.

## Verification limits

```bash
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres \
  bun run e2e --engine postgres --only script-runner-remote-sync,cli-script-runner
```

The initial PostgreSQL attempt passed the CLI scenario and reached the new RPC deadline fixture.
Its ordinary API client timed out after 30 seconds, before the 35-second RPC deadline.
The fixture now uses a 45-second HTTP deadline. This correction does not alter production timeouts.
The automatic retry and two later invocations could not complete API startup within 60 seconds.
Logs reached PostgreSQL initialization and seed work, then reported event-loop stalls during concurrent host work.
The revised PostgreSQL scenario remains unverified. The parent should run it when startup can finish.
No shared database service was stopped or changed.

The combined worker and per-script suite reported 17 passes and one failure.
The failure occurred at `src/tests/script-per-script-executor.test.ts:364`, where workflow dispatch returned `failed` instead of `success`.
This correction does not modify that workflow path. Its cause remains unresolved.
The isolated worker suite passed afterward.

This Mac did not exercise the Linux UID probe or packaged container readiness directory.
No live database outage was injected into the shared PostgreSQL service.
The full merge gate remains with the parent.

## Cleanup

Worker fixtures removed their temporary directories and closed their synthetic sockets and servers.
The E2E harness stopped its processes and removed its database fixtures.
No shared dependency cache was deleted. Dependencies remain for parent integration.
Disk availability was 23 GiB before installation and 20 GiB after cleanup.
No task logs remained at the known temporary paths. No measurable disk space was freed.
Dependency installation and concurrent host work affect this net change.
