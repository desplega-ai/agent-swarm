# Script runners

Script runners execute synchronous scripts outside the API process. They require PostgreSQL.
The API keeps one connection registry per process. Multiple API replicas remain unsupported.
SQLite rejects the WebSocket upgrade with `409 script_runners_need_postgres` before authentication.

## Start a runner

Mint a credential through `POST /api/script-runners/credentials` with a name and future `expiresAt`.
Store the returned token in a file readable only by the runner UID.

```bash
SCRIPT_RUNNER_TOKEN_FILE=/run/secrets/script-runner SCRIPT_RUNNER_SLOTS=2 \
  bun run src/cli.tsx script-runner --api-url https://api.example.test
# The packaged executable accepts the same arguments and environment.
agent-swarm-script-runner --api-url https://api.example.test
```

`SCRIPT_RUNNER_TOKEN` is a development alternative. The file takes precedence.
The runner registers the token with the secret scrubber. Logs contain job IDs and outcome codes.
Use TLS outside a trusted network. A remote plain HTTP URL produces a warning.
The credential cannot authenticate ordinary HTTP or realtime requests.
Revocation closes connected sockets after commit. The API also checks expiry every 15 seconds.

Native jobs require Linux, root and `setpriv` so children run as UID 65534.
Otherwise the runner advertises QuickJS only. `--allow-shared-uid` permits native execution during local development and E2E.
Do not enable that override in production. Mount no operator secrets in the runner container.
The API sends a per-run bearer instead of its operator key. The dispatcher rejects the operator key before transmission.
The API selects the executor and enforces its deployment ceiling. The runner never selects from `SCRIPT_EXECUTOR`.

## Placement and lifecycle

A connected runner receives work when its matching executor has a free advertised slot.
Otherwise the embedded runner executes the job. This phase has no waiting queue.
`GET /api/script-runners` returns instance IDs, slots, jobs in flight and completed counts.
Access requires operator or user permission `script_runner.write`.

Messages use shared Zod schemas. The transport caps frames at 80 MiB and sends pings every 15 seconds.
An abort sends `cancel`. The slot stays occupied until the executor ends.
A socket close fails pending callers with `executor_error` and kills all inline children on the runner.
The runner kills children before reconnecting. It retries every second for 30 seconds, then uses exponential delay with jitter.
A policy close (1008) stops the process. Authentication and engine refusals also stop it.

After welcome, the runner creates `/tmp/script-runner.ready`. It removes the file before reconnect, on disconnect and during shutdown.
Run one runner process per container. Health probes can test that file.
