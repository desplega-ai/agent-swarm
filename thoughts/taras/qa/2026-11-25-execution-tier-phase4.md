# Execution tier Phase 4 QA

Implemented against Phase 1 `87763b0090`, with local bases `accdc99dbb` and `438208f4da` cherry-picked first.
The parent integrates the final Phase 4 commit separately. No push or PR occurred.

## Scope

The API authenticates dedicated runner credentials before upgrade. SQLite refuses the upgrade before authentication.
The dispatcher selects a connected runner with an available slot and matching executor. Otherwise it uses the embedded runner.
Shared schemas validate frames and resource controls. Both WebSocket endpoints cap incoming frames at 80 MiB.
The dispatcher checks JSON transport compatibility and refuses to transmit the operator key.

The worker uses the executor selected by the API. It retains the existing capacity retry behavior.
Cancellation aborts the executor. Disconnect fails pending callers and kills inline children before reconnect.
The runner creates `/tmp/script-runner.ready` after welcome and removes it during disconnect and shutdown.
The standalone main accepts direct arguments, token files and slot configuration.
Revocation closes sockets after commit. Periodic checks still enforce expiry.

## Verification

Passed:

```bash
bun run test:root -- src/tests/script-per-script-executor.test.ts
# 10 passed
bun run test:root -- src/tests/script-runner.test.ts
# 4 passed
STORAGE_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres \
  bun test --path-ignore-patterns='' packages/storage-postgres/test/contract.test.ts \
  packages/storage-sqlite/test/contract.test.ts -t 'script runners repository'
# 2 passed, both engines
bun run e2e --only script-runner-remote-sync,cli-script-runner
# 2 passed, SQLite refusal and CLI error paths
E2E_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:32768/postgres \
  bun run e2e --engine postgres --only script-runner-remote-sync,cli-script-runner
# First run: 2 passed, no retries
bun run tsc:check:tsc
bun run e2e:tsc
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bash scripts/check-e2e-boundary.sh
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bun run check:dep-graph
bun run src/cli.tsx script-runner --help
```

Dependency analysis reported zero errors and 2801 existing transitive warnings.
The floating-promise and unsafe-sink checks reported zero findings.
OpenAPI generation completed. The local drift check regenerated the same OpenAPI and script declarations.

`bun run check:local --skip-e2e` passed frozen install, Biome, slop, Bun types, script declaration drift and OpenAPI drift.
Its affected-test selection expanded to hundreds of inherited files. I stopped that step to preserve the parent's broad-test coordination.
The full merge gate and strict suite remain with the parent.

The final PostgreSQL run included benchmarks and the capacity fallback assertion.
Its first attempt returned HTTP 500 with a PostgreSQL serialization conflict during a remote script request.
The scenario passed on the fresh-database retry. The final result was one pass and one flaky result, with zero failures.
The parent received the conflict report. No retry logic was added to hide that response.

## Source API proof

The PostgreSQL scenario starts the real API and CLI with synthetic credentials and mock integrations.
It registers an agent, mints a credential, executes both native and QuickJS jobs, and checks the session completion count after 20 runs.
It verifies fallback while the runner is busy, SIGKILL failure, client abort, credential revocation and the deployment executor ceiling.
During API restart, it checks the old native PID dies and the first hello arrives within three seconds of healthy API admission.
The CLI scenario also serves a real run through `whileRunning` and verifies graceful shutdown.
These checks use HTTP clients. A separate curl walkthrough was not performed.

## Benchmark observations

The benchmark-enabled run used `bun scripts/bench-script-run.ts --n 20 --warmup 2` against the source API.
Set `E2E_SCRIPT_RUNNER_BENCH=1` to repeat it within the scenario.

| Executor | Embedded p50 | Remote p50 | Observed difference | Phase 0 spike difference |
| --- | ---: | ---: | ---: | ---: |
| Native | 91.0 ms | 59.8 ms | -31.2 ms | -3.1 ms |
| QuickJS | 146.5 ms | 50.8 ms | -95.7 ms | +1.1 ms |

The host ran concurrent checks. The sample size is small. These observations do not establish a stable performance improvement.
The scenario checked runner logs for token, source and result-field leakage after 20 jobs.
Worker logs contain IDs and fixed outcome codes. No payload or output was printed.

## Security review notes

Production native admission requires Linux, root and `setpriv`. Otherwise the runner advertises QuickJS only.
Local native checks used the explicit `--allow-shared-uid` override. Linux UID isolation was not exercised on this Mac.
The standalone runner needs TLS outside trusted networks. Plain remote HTTP produces a warning.
The dedicated bearer authenticates only the runner socket. Script jobs receive separate run credentials.
The shared operator key remains on the API. A focused test proves refusal before transport.
The runner receives no database URL or operator credentials in its sanitized test environment.
Taras's manual review of these controls remains pending.

## Integration lookup sites

Phase 3 corrections will add `activeScriptRunnerCredential(hash)` to check the issuer's current role.
The parent must integrate that correction with `authenticateScriptRunnerCredential` in `src/be/script-runners/credentials.ts`.
The initial upgrade and each ping call that helper in `src/http/script-runners-connect.ts`.
Every worker reconnect repeats the upgrade, so it uses the same admission lookup.
The immediate after-commit close hook already exists in the credential revoke function.

## Cleanup

The E2E harness stopped its API processes, mock services and runners and removed its fixtures.
The runner removes its readiness file during shutdown. The scenario removes its PID marker.
Task-owned temporary logs were removed after recording these results.
Dependency installation remains available for parent integration. No shared cache was deleted.

Removed 1564460 bytes of task logs. `df -h /` reported 24 GiB available before work and 23 GiB after cleanup.
The 3.0 GiB dependency installation and concurrent host activity affect that net change.
