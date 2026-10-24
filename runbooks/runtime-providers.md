# Runtime providers

An agent binds to a runtime pool. The pool chooses a controller that manages runtimes on an infrastructure target.
The API owns database rows. Adapters in `src/runtime-providers/` call infrastructure APIs and must remain DB-free.
Controllers can use the same adapters inside the API or in a separate process.

## Remote controllers

Use a remote controller when the API cannot reach the infrastructure that starts workers.
Run the controller next to that infrastructure. It dials the API and needs no inbound port.
Enable `RUNTIME_POOLS_ENABLED=true` on the API.

Create a controller with `placement: "remote"` and the provider kind.
Set its public `WORKER_API_URL` to an API URL reachable by its workers.
Use that controller's ID as the pool's placement.

Mint a token with operator or authorized user credentials:

```bash
curl -s -X POST "$API/api/runtime-controllers/<controller-id>/token" \
  -H "Authorization: Bearer $AGENT_SWARM_API_KEY"
```

The response returns `plaintext`, `tokenId`, and `expiresAt`. Save the plaintext securely.
Minting revokes the previous token and closes its socket. Controller deletion also revokes its tokens.
Lead and worker credentials cannot mint controller tokens.
`RUNTIME_CONTROLLER_TOKEN_TTL_DAYS` defaults to 90 days and accepts 1 through 3650 whole days.
Its value applies to new tokens. Controller tokens authorize only `/api/controllers/connect`.
They cannot access worker routes, MCP, configuration, or `/api/realtime`.

Start the controller with its token in the environment:

```bash
export AGENT_SWARM_CONTROLLER_TOKEN=<controller-token>
bun run src/cli.tsx controller --api-url https://api.example.test --kind docker \
  --docker-host unix:///var/run/docker.sock --docker-network swarm-workers
```

The CLI reads its token only from `AGENT_SWARM_CONTROLLER_TOKEN`.
Docker flags override `DOCKER_HOST` and `DOCKER_NETWORK`.
`DOCKER_EXTRA_HOSTS` remains an environment setting.
Infrastructure credentials remain on the controller host. The CLI scrubs errors and never logs command payloads or tokens.

The API sends `welcome` with the controller ID before the client sends `hello`.
The hello declares the provider kind and protocol version 1. The API rejects a different kind or version.
Commands carry an ID, operation, and payload. Results carry the same ID and success or error.
Provision commands use `RUNTIME_PROVISION_TIMEOUT_SEC`, with a default of 300 seconds.
Other commands have a 60-second timeout. A timeout fails only that command and preserves the socket.
The remote protocol includes renewal, pause, and resume for E2B lease management.
The CLI accepts static, Docker, and E2B providers. It rejects the reserved `k8s` kind.
The API pings every 15 seconds and checks token validity.
The CLI client also pings every 15 seconds. It drops a socket that receives no frame (message, ping, or pong) for 45 seconds and reconnects, so a network cut is detected within 60 seconds.
A new authenticated session replaces the previous session for that controller.
Reconnect uses jittered exponential backoff between 1 and 30 seconds.
Auth close code 1008 stops the process with a non-zero exit and a token diagnostic.
The API uses 1008 for invalid or revoked credentials and a mismatched controller identity or kind.
Operational handshake failures, including list errors and timeouts, use 1011 and the normal reconnect backoff.
The API records the scrubbed error in the controller's `last_error` and `last_error_at` columns.
Operational failures send the fixed close reason `controller operation failed`.
Invalid protocol messages use close code 1002.
A replaced process waits five minutes before another connection attempt and reports that another process holds the token.

Before the controller becomes online, the API lists runtimes with its stable swarm owner ID.
Known handles remain. Ownership labels restore a provision handle whose result was lost during disconnect.
List requests do not wait for unfinished provisions.
The API retires provisioning rows with no handle when that list does not report them.
Retirement revokes their tokens and releases capacity without a provision failure or infrastructure termination.
If a late provision completes, its fenced runtime becomes an orphan on a subsequent list.
Owner-filtered orphans follow the supervisor's existing orphan grace. Other swarms' runtimes remain excluded.

Disconnect marks the controller offline. The API starts no runtimes through an offline controller.
`RUNTIME_CONTROLLER_GRACE_SEC` defaults to 120 seconds and accepts 0 through 86400 whole seconds.
The supervisor preserves runtime rows and credentials during this grace.
After grace expiry, `recoverRuntime` marks those rows offline, revokes their tokens, and remediates active tasks through heartbeat recovery.
Failed reconnect handshakes do not extend the original disconnect grace.
Controller offline errors and command timeouts preserve ambiguous provisions until reconciliation.
They do not increment provision failures, apply backoff, or change the pool circuit.

## Supported kinds

| Kind | Adapter | Behavior |
|------|---------|----------|
| `static` | `StaticRuntimeProvider` | Operators manage workers. Provision and terminate reject requests. Status is unknown and list is empty. |
| `docker` | `DockerRuntimeProvider` | Creates and starts worker containers through a local Unix socket. |
| `e2b` | `E2BRuntimeProvider` | Creates worker sandboxes and starts `/docker-entrypoint.sh` as a tracked background process. |

The schema reserves another kind for a future adapter. The factory rejects that kind until the adapter exists.

## Supervisor

`RUNTIME_POOLS_ENABLED=true` and `MULTI_RUNTIME_ENABLED=true` enable demand reconciliation.
The supervisor provisions within agent `maxTasks`, pool `maxRuntimes`, and budget admission.
`slotsPerRuntime` sets process capacity. `minRuntimes` keeps a warm floor for each bound agent.
Pool `maxRuntimes` limits all runtimes across its agents. Provisioning rows count toward the limit.
`RUNTIME_PROVISION_CONCURRENCY` bounds simultaneous provisions, with a default of 8.
Started requests reserve demand. Each new request checks budget admission, retry deadlines, and the pool circuit.
An expired circuit permits only one trial. A failure preserves sibling requests and stops further requests for that agent during the tick.
Each tick counts at most one failure per agent toward retry attempts and the pool circuit.
An agent with prior failures permits only one provision awaiting registration. Registration clears its retry state and restores concurrent provisioning.
With `lifecycle: "idle"`, `idleMinutes: null` keeps runtimes indefinitely.
A positive `idleMinutes` terminates idle runtimes after that interval, while preserving the warm floor.
With `lifecycle: "per-task"`, the worker exits after task completion. Use one slot for one task per runtime.
Task completion preserves the runtime, its sessions, and its token during post-task reporting.
The finished runtime still counts toward agent `maxTasks` and pool `maxRuntimes` throughout its exit grace.
Runner shutdown permits immediate teardown. Otherwise, teardown waits `RUNTIME_PER_TASK_EXIT_GRACE_SEC` seconds from task completion, with a default of 60.

Existing runtimes use their recorded `runtime_instances.controller_id` for provider listing, status, termination, and E2B renewal.
The pool's current placement selects the controller for new provisions.
Placement and provider-kind changes return 409 while any pool runtime is non-offline.
Disable the pool and wait for teardown before changing either field.
Pool deletion also returns 409 while any runtime is non-offline, including forced deletion.
Scale to zero or disable the pool and wait before deletion.
Force deletion only unbinds agents after all runtimes are offline.
Changing or removing an agent's binding returns 409 while that agent has non-offline pool runtimes.

Non-terminal task sessions keep a runtime busy. Finished task sessions do not.
Taskless `unread_mentions`, `pool_tasks_available`, and `channel_activity` sessions also keep a runtime busy while their session heartbeat remains fresh.
The supervisor uses `lastHeartbeatAt` and `HEARTBEAT_STALE_CLEANUP_MIN` (default 30 minutes) to bound taskless occupancy.
Fresh runtime pings do not extend this session deadline.
For idle lifecycles, cleanup deletes sessions for finished tasks, missing task executions, and stale taskless triggers.
Per-task runtimes retain their existing post-task reporting and exit grace.

The API inserts the provisioning row and mints a scoped runtime token before the infrastructure request.
Registration activates that row. Termination revokes its runtime and child tokens and reconciles agent liveness.
Registration timeouts and provision failures use persisted retry deadlines and a pool circuit breaker.
Provider death triggers heartbeat recovery for sessions and sessionless tasks dispatched to that runtime.
With runtime pools enabled, dispatch records each task's runtime in `agent_tasks.runtime_instance_id` within the claim transaction.
This record covers every slot before the worker's best-effort session registration.
Recovery also checks `runtime_instances.task_id` for earlier dispatches without that record.
Registered sessions determine ownership when they exist. Recovery preserves terminal tasks and prevents duplicate resumes through guarded state updates.
Runtime credentials can revoke their own ACP child tokens after completion or setup failure.
Revocation requires matching `agentId` and `parentRuntimeId`. Unrelated tokens receive 403.
Child revocation retains the parent runtime credential. With runtime pools disabled, revocation remains operator-only.
See [heartbeat and crash recovery](./heartbeat-crash-recovery.md#1a-runtime-liveness-multi_runtime_enabled-only) for recovery rules and environment settings.
See the [operator guide](../docs-site/content/docs/(documentation)/guides/runtime-pools.mdx) for setup and troubleshooting.

## Routing and offers

With both runtime flags enabled, warm routing requires an active, fresh runtime that accepts work.
Its pool must be enabled. The runtime must not drain or report unavailable credentials.
A null credential report remains eligible. Completed per-task runtimes remain excluded during their exit grace.
Routing counts occupied runtime slots and reserves slots for pending assignments, within the agent's logical capacity.
Warm assignment checks physical capacity again within its write transaction, so concurrent routers cannot reserve the same last slot.
An open pool circuit blocks new provisioning but permits warm routing to healthy runtimes.

Wakeable pools must support provisioning, allow at least one runtime, and have an image or resolved image.
An unlimited `maxRuntimes` remains wakeable. Zero capacity and missing images block tier-2 routing and sleeping-agent reachability.

The routing sweep examines current pool agents and agents whose runtime rows record a previous pool.
It releases unmarked pending assignments only when the agent has no eligible runtime, no provision in progress, and no wakeable pool.
Unbound agents and missing, disabled, or non-wakeable pools meet the last condition.
Sleeping agents in wakeable pools retain explicit assignments, including between per-task runtimes and during provision backoff.
The supervisor handles their pending demand and its existing attempt-limit failure path.
Busy eligible runtimes and provisions preserve these assignments.
Marked wake assignments retain their timeout and circuit rules. Human pins remain assigned.
The release checks pending status, recipient, wake marker, and human-pin exclusion, so a concurrent claim wins.

Heartbeat preserves offers to offline pool agents that can wake or have a provision in progress on an enabled pool.
An existing provision preserves reachability even when the pool circuit opens.
Heartbeat supplies the reachability predicate to the legacy reaper, which keeps the database layer independent of runtime pools.
The reaper still releases offers to deleted or unreachable offline recipients and preserves concurrent claims.
With `RUNTIME_POOLS_ENABLED=false`, routing and offer cleanup retain their legacy behavior.

## Adapter contract

`createRuntimeProvider(kind, target?)` imports adapters lazily. Pass the target when E2B traits must reflect a configured tier.
The provider-side kind type derives from `RuntimeProviderKindSchema` in `src/types.ts`.

- `checkConfig(target)` reports missing configuration.
- `provision(target, request)` returns an external handle when infrastructure accepts the runtime. Worker registration occurs separately.
- `terminate(target, handle, reason)` destroys the runtime.
- `status(target, handle)` reports starting, running, paused, exited, failed, or unknown.
- `list(target, ownerId)` returns only labeled runtimes owned by that swarm.
- Optional `renew(target, handle, ttlSec)` returns the actual expiry as `{ endAt }`.
- Optional `pause` and `resume` preserve a runtime when the provider supports them.

Traits describe provisioning, disk persistence, pause support, lease limits, and continuous runtime limits.
The controller sets `handle.controllerId`. Adapters never set it.

## Owner isolation

Controllers supply a stable `ownerId` for their swarm. Keep this value stable across restarts.
Adapters stamp `swarm.owner`, `swarm.runtime-id`, `swarm.pool-id`, and `swarm.agent-id` on every created runtime.
These labels override user labels. Docker uses container labels and E2B uses sandbox metadata.
Listing requires both the runtime label and the matching owner label. Runtimes without an owner label remain excluded.
Two swarms on one Docker host or E2B team must use different owner IDs.
Termination and status use explicit handles. Controllers must obtain those handles from their own records or owner-filtered lists.

## static

Operators start and stop static workers. The adapter cannot provision, terminate, pause, or resume them.
Its status is unknown and its list is empty. Static workers need no infrastructure configuration.

## docker

`DOCKER_HOST` defaults to `unix:///var/run/docker.sock`. Only Unix sockets are supported.
The first request to each socket negotiates the API version through an unversioned `GET /_ping`.
The adapter reads `Api-Version` and caps it at 1.47. A missing header selects unversioned paths.
The process caches the negotiated version per socket. Failed probes can retry on the next request.
A client-version rejection clears the cached version, negotiates again, and retries the request once.
On OrbStack Macs, set `DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"`.
`DOCKER_NETWORK` selects a network. `DOCKER_EXTRA_HOSTS` adds comma-separated `host:address` entries.
The adapter always includes `host.docker.internal:host-gateway`.
Requests can set memory in MiB and CPU count through `resources`.

When creation returns 404 with `No such image`, the adapter pulls the requested image and retries creation once.
Untagged references use `tag=latest`. Registry ports do not count as tags, and digest references remain unchanged.
It consumes the pull response to completion and rejects errors embedded in the response stream.
A missing container reports `exited`. Other lookup errors report `unknown`.
Adapter errors pass through `scrubSecrets`. Provision errors also redact sensitive values from the request environment locally.
The adapter does not register request environment values in the process-wide secret registry.
If container start fails, the adapter attempts forced deletion before it returns the original error.

## e2b

`E2B_API_KEY` is required. `E2B_API_BASE` selects a custom endpoint.
Worker URLs must use HTTPS. Resolution checks controller `WORKER_API_URL`, then `RUNTIME_WORKER_API_URL`, then `PUBLIC_MCP_BASE_URL`.
The public API resolver supplies the final fallback, including deployment `MCP_BASE_URL`.
Validation and worker injection use the same resolver.
Only the seeded `builtin-e2b` controller copies deployment `E2B_API_KEY`. Other controllers require their own stored key.
Builtin controllers update configuration readiness only when it changes.
Configuration errors use an `E2B configuration:` prefix. Readiness checks preserve provision errors in `last_error`.
Creating a pool on an unready builtin E2B controller succeeds with a `warning` field.
Plain image values name an E2B worker template.
The default lease is 900 seconds. Target configuration `E2B_TTL_SEC` overrides that default.
An explicit provision request `ttlSec` takes precedence. `renew` uses its explicit `ttlSec` and returns the expiry that E2B actually applied.

`E2B_MAX_CONTINUOUS_SEC` sets the continuous runtime trait. It defaults to 3600 seconds for Hobby.
Pro deployments can set 86400 seconds. Pass this target to the factory when constructing the adapter.
The SDK enforces the account limit. The trait does not increase that limit.

The supervisor provisions with pool `ttlSec` or 900 seconds, bounded by provider limits.
It raises short leases to the renewal window plus 60 seconds, within provider limits.
If a provider limit prevents that margin, the effective renewal window becomes shorter.
It stores the lease expiry and renews active or provisioning runtimes within `RUNTIME_LEASE_RENEW_BEFORE_SEC` seconds of expiry.
This window defaults to 300 seconds. Reaped runtimes receive no renewals.
Renewal stores the expiry E2B actually applied. A failed renewal waits for the next full reap to check provider status.
Confirmed absence triggers task recovery. Transport errors do not prove death.
If the API stops, lease expiry bounds sandbox lifetime without a cleanup request.

Within `RUNTIME_ROTATE_BEFORE_SEC` seconds of the continuous limit, the supervisor drains the runtime.
This window defaults to 600 seconds. Idle rotation uses two ticks: the first drains, and the next checks activity before termination.
Busy runtimes finish their tasks while draining. Demand can provision replacements within the pool cap.
The supervisor never pauses a busy runtime. Tasks longer than the continuous limit can still require crash recovery.

For `docker://ghcr.io/acme/worker:1.2`, the API starts a background template build when provisioning needs the image.
One build runs per pool and build input. Pending builds reserve no runtime and count no provision failure.
Other pools continue renewal and recovery while a build runs.
`RUNTIME_E2B_BUILD_TIMEOUT_SEC` bounds builds to 600 seconds by default. API shutdown aborts pending builds.
The template name hashes the JSON array `[image, cpu, memoryMb]`, using the image reference without `docker://`.
The name is `swarm-<sha256(inputs).slice(0,12)>`. CPU and memory defaults are 4 and 8192 MiB.
The pool stores this name in `resolved_image`. Later provisions reuse it.
Changing `image` or effective CPU or memory clears the cache. Changes during construction prevent storing the obsolete result.
Old templates remain in E2B. Template deletion requires a separate follow-up.
Custom images must extend `ghcr.io/desplega-ai/agent-swarm-worker:slim` or the full worker image.
Build failures use provision backoff and the circuit breaker. Missing runners surface through the registration timeout.
Template construction requires E2B credentials available to the API.

Per-task pools pay for the boot sequence each time they start a sandbox.
The spike measured 89 boot API calls. See [#2048](https://github.com/desplega-ai/agent-swarm/issues/2048) for boot bundle work.
Use an idle lifecycle or a warm floor when frequent tasks make this cost significant.

Status uses one `Sandbox.getInfo` lookup. It preserves paused state because `Sandbox.connect` would resume the sandbox.
A sandbox lookup that reports absence returns `exited`. Authentication and transport failures remain errors.
Pause uses `Sandbox.betaPause`. Resume uses `Sandbox.connect` with the configured lease or the 900-second default.
An unplanned pause resumes an idle runtime that remains wanted, then renews its lease.
A pause during active work terminates the sandbox, then triggers `recoverRuntime` because the pause interrupted the model stream.
Socket-grace checks and the reaper serialize actions per runtime and use the same rule for whether a runtime remains wanted.
An unwanted paused runtime terminates without resuming.
If the worker process fails during provision, the adapter attempts sandbox deletion before it returns the original error.
See [E2B dispatch](./e2b-dispatch.md) for templates and tracked process behavior.

## Adding a provider

1. Add the kind to `RuntimeProviderKindSchema` in `src/types.ts`.
2. Add a lazy factory branch and update the `Supported:` error list.
3. Add a DB-free adapter with owner labels and the required methods.
4. Update `src/tests/runtime-provider-registration.test.ts` and remove exemptions when support exists.
5. Update `RUNTIME_PROVIDER_KINDS` in `apps/ui/src/lib/runtime-pools.ts` when the runtime pool UI exists.
6. Document configuration, status mapping, limits, and ownership here in the same PR.
7. Add unit tests that mock infrastructure APIs. Test failures and owner isolation.

Any change to this contract requires a runbook update in the same PR.

## Verification

```bash
bun run test:root -- src/tests/runtime-provider-registration.test.ts src/tests/runtime-providers-docker.test.ts src/tests/runtime-providers-e2b.test.ts
bash scripts/check-db-boundary.sh
bun run lint
bun run tsc:check:tsc
```

Run the Docker smoke against a temporary API database with an available worker credential:

```bash
bun scripts/runtime-provider-smoke.ts --provider docker \
  --api http://localhost:<port> --worker-api http://host.docker.internal:<port> \
  --image ghcr.io/desplega-ai/agent-swarm-worker:slim --api-key <key> \
  --owner-id <unique-smoke-owner>
```

The script exits unsuccessfully unless the task completes and its runtime disappears after termination.
Omit `--owner-id` to generate an isolated owner. Use `--keep` to inspect the runtime after the task.
Optional E2B smoke uses `--provider e2b`, an E2B template, and an HTTPS URL reachable by the sandbox.

## Push delivery

`RUNTIME_POOLS_ENABLED=true` enables worker nudges through `/api/realtime`.
Workers authenticate with the operator key and `X-Agent-ID`.
Runtime tokens can supply the identity when runtime-token authentication is available.
Only the matching agent can subscribe or unsubscribe to namespace `worker:<agentId>`, channel `nudge`.
Clients cannot publish, join rooms, or modify state in this reserved namespace.

The server sends this envelope, without task content or configuration values:

```json
{"v":1,"kind":"work","taskId":"optional-task-id","at":"2026-10-11T12:00:00.000Z"}
```

Kinds are `work`, `cancel`, `steer`, and `config`.
Clients acknowledge each transport frame with `{"ack": <seq>}`.
The database is the source of truth. Push delivers a nudge.
Workers fetch current state through the existing poll, cancellation, steering, and configuration endpoints.
Nudges are ephemeral. Workers must fetch current state after reconnecting.

The registration response includes `deliveryMode`. With the feature flag off, the API returns `poll`.
With the flag on, the API selects the bound pool's `delivery`, then `RUNTIME_DEFAULT_DELIVERY`, then `poll`.
An unbound agent also uses that default. A pool change takes effect at the worker's next registration.
Workers register again when configuration drift changes agent-visible values or the five-minute capability refresh is due.

Worker environment:

| Variable | Default | Behavior |
| --- | --- | --- |
| `SWARM_DELIVERY_MODE` | Registration response | Worker override: `poll` or `push`. Invalid values use the registration response. |
| `RUNNER_PUSH_SAFETY_POLL_MS` | `30000` | Positive interval in milliseconds for safety fetches. Invalid values use the default. |

Push workers subscribe with Bun's WebSocket client and include `X-Runtime-Instance-ID`.
After subscription succeeds, synthetic `work` and `config` nudges fetch current state.
Reconnect uses exponential backoff with jitter, bounded between 1 and 30 seconds.
Backoff resets after a subscription stays connected for at least 30 seconds.
A socket unavailable for more than 60 seconds causes poll fallback and one warning.
A successful reconnect restores push delivery.

An idle push worker fetches work once per safety tick and on work nudges.
Cancellation and steering nudges fetch only the named task. Safety ticks check every active task.
Configuration nudges trigger reconciliation immediately. Task completion also permits another work fetch.
Workers send `/ping` at least every 30 seconds, independently of budget backoff.

A lead with `LEAD_MONITOR_CHANNELS=true` must use `poll` because channel activity is computed during polling.
The API forces poll delivery and returns `pollRequired` for that lead.
The runner warns and honors this restriction, including when a worker override requests push.

The runner logs `Delivery mode: poll` or `Delivery mode: push` at startup and whenever the mode changes.
The log identifies the register response, a valid `SWARM_DELIVERY_MODE` override, or an older API's default.
Temporary socket fallback and reconnect also log the active mode.

All write hooks publish through `getDbClient().afterCommit()`.
Rollback suppresses their nudges.

| Write | Kind | Recipient |
| --- | --- | --- |
| `task.created` event, including resume follow-ups | `work` | Pending assignee or offered recipient, read from the committed task |
| `acceptTask` | `work` | Assignee |
| `assignUnassignedTaskPending` | `work` | Assignee |
| `postMessage` | `work` | Each unique mentioned agent, including inherited reply mentions |
| `cancelTask` | `cancel` | Assignee and offered recipient, deduplicated |
| `createSteeringMessage` | `steer` | Task assignee |
| Configuration upsert or delete | `config` | Agent scope: that agent. Global or repo scope: every subscribed worker agent |

The transport tracks subscriptions separately for each socket.
One socket closing does not remove another runtime's subscription for the same agent.
The process bus publishes `worker.socket.connected` when a socket first subscribes to its worker channel.
It publishes `worker.socket.disconnected` when the socket unsubscribes or closes with that subscription.
Each subscription emits one connected event and one disconnected event.
Both events carry `{agentId, runtimeId?}`. The upgrade reads `runtimeId` from `X-Runtime-Instance-ID`.
An unsubscribe removes the socket from configuration broadcasts.
The feature flag disables new subscriptions and nudges.
An existing subscription still emits its disconnected event if the flag changes before it ends.

## Docker pools in compose

The API supervisor starts only with `RUNTIME_POOLS_ENABLED=true` and multi-runtime mode enabled.
`/status` reports `runtime_pools.supervisor`. It explains when multi-runtime mode disables the supervisor.
`RUNTIME_SUPERVISOR_INTERVAL_MS` defaults to 5000 milliseconds. Changes to the interval require an API restart.
Committed pending or offered tasks request a reconcile after a 250 millisecond debounce.

In `docker-compose.local.yml`, enable the commented Docker socket mount on the API service.
Set `RUNTIME_POOLS_ENABLED=true`, then start the stack:

```bash
docker compose -f docker-compose.local.yml up --build
```

The stack names its network `swarm-local` and sets `DOCKER_NETWORK` on the API.
Provisioned workers join this network and reach `RUNTIME_WORKER_API_URL=http://api:3013`.
Builtin Docker controllers use the API's Docker environment defaults. Controller configuration overrides these defaults.
The defaults are `DOCKER_HOST`, `DOCKER_NETWORK`, and `DOCKER_EXTRA_HOSTS` from the API process environment.
Stored global settings override deployment environment values after configuration reload.
Public controller configuration overrides the process environment. Encrypted controller configuration overrides public controller configuration.
Seeding selects `RUNTIME_DOCKER_HOST`, then `DOCKER_HOST`, then `unix:///var/run/docker.sock`.
An explicit `RUNTIME_DOCKER_HOST` seeds a controller even when Docker is offline and becomes controller configuration.
Otherwise, the selected host must identify an existing Unix socket.
The controller's public `WORKER_API_URL` selects a worker URL before `RUNTIME_WORKER_API_URL` and the public API URL.
Choose image `swarm-worker:local` for a pool after the compose worker image builds.
Store harness credentials as agent or global secrets. Workers receive these credentials through their scoped runtime token during boot.

The API stores a stable global `runtime_owner_id`. Every provision and infrastructure list uses that owner.
Controller credentials remain in encrypted controller configuration. The API registers their plaintext values for secret scrubbing.
Workers receive pool environment values plus API-owned identity, token, slots, delivery, and template values.
Pool environment values cannot replace those API-owned values.

Demand counts ready pending tasks, offered tasks, and unclaimed mention channels.
Provisioning rows reserve capacity until workers register with the injected runtime ID.
`slotsPerRuntime` and agent `maxTasks` bound each agent. `maxRuntimes` bounds the pool.
`minRuntimes` maintains a warm floor per agent, within those caps.
An idle lifecycle with no `idleMinutes` keeps runtimes indefinitely.
An idle timeout first drains the runtime. The next reconcile terminates it if it remains idle above its warm floor.
A per-task lifecycle injects `SWARM_EXIT_AFTER_TASKS=1`. The runner closes after it reports cost, removes sessions, and reports logs and context.
The supervisor waits for this shutdown close or the task's exit grace deadline before teardown.
Idle runtimes still discard sessions whose tasks are terminal or missing, so stale sessions cannot prevent idle teardown.
The supervisor removes exited runtimes and owner-filtered orphans, marks rows offline, and revokes runtime tokens.
Provider list handles can include `createdAt` as an ISO timestamp from infrastructure metadata.
The supervisor gives newly created orphans two minutes before termination to permit database registration.
Disabled pools stop provisioning but retain runtime cleanup.
Provision failures retire the row and store a scrubbed error. Retry policy and crash recovery belong to the failure supervisor.
E2B pools use the same supervisor with the lease and rotation rules above.
