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
Revocation closes connected sockets after commit. The API revalidates the bearer after registering the revoke handler.
Every 15-second ping rechecks expiry and the issuer’s explicit `script_runner.write` grant.
A database exception returns HTTP 503 before upgrade or closes with WebSocket 1011 after upgrade.
Invalid credentials return HTTP 401. Revoked credentials receive policy close 1008.

Native jobs require Linux, root and a successful startup probe with `setpriv` as UID 65534.
The probe also checks that this UID cannot read `SCRIPT_RUNNER_TOKEN_FILE`. A readable token file stops startup.
Otherwise the runner advertises QuickJS only. `--allow-shared-uid` permits native execution during local development and E2E.
The override prints a development warning. Startup rejects it when `NODE_ENV=production`.
Mount no operator secrets in the runner container.
The API sends a per-run bearer instead of its operator key. The dispatcher rejects the operator key before transmission.
The API selects the executor and enforces its deployment ceiling. The runner never selects from `SCRIPT_EXECUTOR`.

## Placement and lifecycle

A connected runner receives work when its matching executor has a free advertised slot.
Otherwise the embedded runner executes the job if it has capacity. Excess jobs enter the sync queue.
`GET /api/script-runners` returns instance IDs, slots, jobs in flight and completed counts.
Access requires the operator key or user permission `script_runner.read`.

Messages use shared Zod schemas. The transport caps frames at 80 MiB and sends pings every 15 seconds.
Each outgoing job and result must fit the same byte limit. An oversized job fails before transmission.
An oversized result becomes a small `executor_error` result. Neither case disconnects other jobs.
An abort sends `cancel`. The slot stays occupied until the executor ends or the cleanup deadline expires.
The API terminates the socket after an unanswered abort plus five seconds.
Each RPC also has a deadline equal to its wall time plus five seconds.
Termination fails every pending caller and releases its slot. Send errors also terminate the socket.
The runner terminates a connection after 45 seconds without API pings and aborts its inline jobs.
A socket close fails pending callers with `executor_error` and kills all inline children on the runner.
The runner kills children before reconnecting. It retries every second for 30 seconds, then uses exponential delay with jitter.
A policy close (1008) stops the process. Authentication and engine refusals also stop it.
A duplicate instance ID receives retryable close 1011 until the old connection closes.
Connections never replace another session or adopt its jobs, regardless of credential.

Set `SCRIPT_RUNNER_READY_FILE=/run/agent-swarm-script-runner/ready` for packaged health probes.
Create the parent directory first. It must belong to the runner UID and have mode 0700.
The runner rejects symlink parents and symlink targets. It creates a unique regular file exclusively, then atomically renames it.
After welcome, the runner publishes readiness. It removes readiness before reconnect, on disconnect and during shutdown.
A source runner can omit this variable. It then creates no readiness file.
Run one runner process per container.

## Data visible to a runner

The job contains script source, arguments, the selected executor, resource limits, filesystem mode and network policy.
Its configuration contains system identity, the API URL and a short-lived bearer for that run.
It also carries resolved user configuration, secret bindings, egress credentials and failed-binding descriptions when applicable.
API and MCP connection descriptors, agent-fs descriptors, caller context and database dialect can accompany the job.
The runner rewrites the SDK and MCP addresses to its configured API address.
Results contain the return value, output streams, truncation flags, duration, exit status and optional runtime errors or durable state.

Treat the runner host as trusted infrastructure. Its process receives these plaintext values inside the authenticated TLS connection.
The dedicated runner credential authenticates only the runner connection. It differs from the per-run bearer inside a job.
The native child receives configuration through stdin. The runner retains its own credential outside that child.
QuickJS executes with host adapters in the runner process. Do not treat its process as separate from the runner's credentials.

## Capacity

PostgreSQL accepts `SCRIPT_EMBEDDED_RUNNER_SLOTS` (0 to 1024) and `SCRIPT_QUEUE_WAIT_SYNC_MS` (0 to 540000).
SQLite refuses either key through configuration writes and at API boot.
Unset embedded slots allow unlimited native runs. Zero disables the embedded runner.
The QuickJS pool remains inside the executor. `SCRIPT_QUICKJS_POOL_SIZE` still controls that pool.
`SCRIPT_RUN_CONCURRENCY_CAP` still controls durable script-workflow concurrency.
`SCRIPT_RUNNER_SLOTS` belongs to the runner environment, defaults to 2, and accepts 1 to 1024.

The API queues synchronous jobs in FIFO order when no matching slot is free.
The default queue wait is 30000 milliseconds. Expiry returns `capacity_exceeded` and names the sync queue.
A caller abort removes its queued job. An executing job retains its slot until its executor ends.
Execution wall time starts when the executor receives the job. The caller signal bounds queue and execution together.
The maximum queue wait is nine minutes. A five-minute run then leaves a minute for preparation within the credential lifetime.
A nested sync call needs a second compatible slot while its parent waits. If every compatible slot is busy, its queue deadline applies.
A configuration change sets the deadline for new calls. Jobs already in the queue retain their deadline.
Durable-object leases include queue wait, execution time and a 10-second commit allowance.

`GET /api/script-runners` requires `script_runner.read` for users or the operator key.
Its `lanes.sync` reports `queued`, `oldestWaitMs`, `inFlight` and `slots`.
`slots: null` means unlimited embedded capacity. Counters and waiters belong to this API process.

## Durable runs

PostgreSQL places durable script runs through shared slot reservations.
Each reservation consumes the same total capacity as an inline run.
`SCRIPT_RUNNER_LONG_LANE_SHARE` defaults to `0.5` and limits durable jobs on each remote runner.
The long lane always permits at least one slot. Unowned `running` rows form its queue without a timeout.
`lanes.long` reports queued rows, oldest wait and active owners.

The API claims the row before it mints the broker credential.
The broker retains the verified launch authority and its original expiry restrictions.
Historical runs retain journal-only credentials. The runner receives no broker bearer for a durable job.
The guest receives source, arguments, its run identity and a local capability socket.
The API applies the capability allowlist, dispatch limits and response limits.

Remote owners use the runner instance ID. Remote PIDs stay NULL.
A heartbeat renews each live lease every 10 seconds for 60 seconds.
Expired leases cannot renew. The supervisor clears expired owners and replays their journals.
Embedded owners use `embedded:<bootId>` without a lease expiry.
The supervisor never takes a live embedded run because of heartbeat age.

The API fences capabilities, heartbeats and settlement by owner and lease.
It scrubs output and error text before settlement. Settlement keeps the running guard.
The runner retains finished results until acknowledgement and resends them after reconnect.
Within one API process, capability request IDs reuse their original responses after reconnect.
The response cache has a 64 MiB limit per durable session.

A short disconnect retains durable guests and broker sessions.
After an API restart, the API cancels held guests and releases their rows for journal replay.
Guest code and swarm calls outside a journal step can execute again after a restart.
Use journal steps for work that needs replay protection.

SIGTERM stops admission, allows inline work five seconds, and stops durable guests.
The runner then closes with code 1000. The API releases its held rows immediately.
Pause, cancel and limits stop the remote guest through its owner session.

## Container contract

The API image includes `/usr/local/bin/agent-swarm-script-runner`.
`/script-runner-entrypoint.sh` executes this binary with `--api-url "$SCRIPT_RUNNER_API_URL"`.
The CLI also exposes `agent-swarm script-runner --api-url <url>`.

| Setting | Meaning |
|---|---|
| `SCRIPT_RUNNER_API_URL` | API base URL for the container entrypoint |
| `SCRIPT_RUNNER_TOKEN_FILE` | File with a minted runner credential |
| `SCRIPT_RUNNER_TOKEN` | Alternative token for development |
| `SCRIPT_RUNNER_SLOTS` | Concurrent job slots, chart default 4 |

The image runs as root. Native children run as uid 65534 and gid 65534 (`nobody:nogroup`).
Native execution requires root to start a child as uid 65534. Kubernetes namespaces that require restricted Pod Security reject this pod.

The image build checks `bash`, `python3`, `bun`, and `setpriv`.
It checks Bun execution and harness readability under the sandbox identity.
The runner shares the API image's bundled harnesses, libraries, and QuickJS worker entry.
Do not use `--allow-shared-uid` in a deployment.

The client creates `/run/agent-swarm-script-runner/ready` while connected and removes it after disconnection.
The chart and Compose use a file probe. They do not require `pgrep`.
SIGTERM starts drain. The chart and Compose allow 60 seconds before forced termination.
Durable runs replay their journal after ownership moves to another runner.
After an API restart, guest code outside journaled steps can execute again.

## Helm

Set `scriptRunner.enabled=true` and select PostgreSQL with `database.url` or `database.existingSecret`.
Create a Secret with key `SCRIPT_RUNNER_TOKEN` from a minted runner credential.
Set `scriptRunner.existingSecret` to its name. Inline `scriptRunner.token` is also supported.
The chart refuses missing PostgreSQL, missing credentials, zero replicas, zero slots, and a zero grace period.

```bash
helm upgrade --install swarm charts/agent-swarm \
  --reuse-values --set database.existingSecret=swarm-db \
  --set scriptRunner.enabled=true --set scriptRunner.existingSecret=swarm-runner \
  --set scriptRunner.replicas=2
```

`scriptRunner.apiUrl` overrides the internal API URL, including for KEDA.
Use an HTTP or HTTPS origin. Use HTTPS outside a trusted network.
The default URL includes the release namespace so the KEDA operator can resolve the API Service.
Enabling runners sets API `SCRIPT_EMBEDDED_RUNNER_SLOTS=0` unless `config.extraEnv` supplies a value.
A `swarm_config` row wins over this environment value. Check Settings, Configuration before rollout.
With embedded slots at zero and no connected runner, scripts wait and then fail.
This includes the heartbeat script probe.

### Optional KEDA

Install KEDA CRDs before enabling `scriptRunner.keda.enabled`.
Use a separate Secret with key `token` containing a user token with `script_runner.read`.
Set `scriptRunner.keda.existingSecret` to this Secret. Never use the operator key or the runner credential.
The chart rejects reuse of the auth Secret or runner Secret name.
The chart cannot inspect the contents of an existing Secret or verify its permissions.

The [metrics-api scaler](https://keda.sh/docs/2.18/scalers/metrics-api/) reads `lanes.sync.queued` from `GET /api/script-runners`.
The defaults target four queued jobs per replica, with one minimum replica and ten maximum replicas.
The chart requires positive bounds and rejects a maximum below the minimum.
KEDA owns the Deployment replica count when enabled.
This metric covers only the sync queue. It does not measure durable jobs or total CPU use.
Keep at least one replica to avoid a queue with no executor.

## Compose

Use the PostgreSQL overlay and the optional `script-runners` profile.
Store a minted runner credential in `./script_runner_token`, or set `SCRIPT_RUNNER_TOKEN_PATH`.
The service mounts this file through Compose secrets.
Local Compose can retain source permissions instead of applying the requested secret mode.
The entrypoint refuses token files readable by sandbox uid 65534. Keep the source file mode at `0600`.
Some Docker Desktop bind mounts allow reads despite the displayed file mode. The entrypoint refuses those mounts too.
It receives no API key or database credentials.

```bash
chmod 600 ./script_runner_token
docker compose -f docker-compose.example.yml -f docker-compose.postgres.yml \
  --profile script-runners config -q
docker compose -f docker-compose.example.yml -f docker-compose.postgres.yml \
  --profile script-runners up -d --scale script-runner=2
```

Compose preserves the API's embedded capacity unless the operator explicitly disables it.
To require remote execution, set API `SCRIPT_EMBEDDED_RUNNER_SLOTS=0` through Configuration after runners connect.
A Compose profile does not change environment values on another service.

## Packaging checks

```bash
helm lint charts/agent-swarm --set auth.apiKey=check
bash scripts/check-chart-postgres.sh
bun run check-chart-version
bun run check:agents-md-size
```

After integrating the runner runtime, build the API image with `bun run docker:build:api`.
Do not build on this Mac with less than 20 GB free disk.
Use CI or an approved build host when space is insufficient.

```bash
docker run --rm --entrypoint sh agent-swarm-api:latest \
  -c 'command -v bash python3 bun setpriv agent-swarm-script-runner'
docker run --rm --entrypoint setpriv agent-swarm-api:latest \
  --reuid=65534 --regid=65534 --clear-groups bun --version
```

Integrated QA must prove native and QuickJS execution from the built image.
Verify native uid 65534, two registered runner sessions, durable replay after pod deletion, and SIGTERM drain.
Use a disposable local cluster with its own kubeconfig. Never use a shared cluster for these checks.
