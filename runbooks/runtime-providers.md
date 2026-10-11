# Runtime providers

An agent binds to a runtime pool. The pool chooses a controller that manages runtimes on an infrastructure target.
The API owns database rows. Adapters in `src/runtime-providers/` call infrastructure APIs and must remain DB-free.
Controllers can use the same adapters inside the API or in a separate process.

## Supported kinds

| Kind | Adapter | Behavior |
|------|---------|----------|
| `static` | `StaticRuntimeProvider` | Operators manage workers. Provision and terminate reject requests. Status is unknown and list is empty. |
| `docker` | `DockerRuntimeProvider` | Creates and starts worker containers through a local Unix socket. |
| `e2b` | `E2BRuntimeProvider` | Creates worker sandboxes and starts `/docker-entrypoint.sh` as a tracked background process. |

The schema reserves another kind for a future adapter. The factory rejects that kind until the adapter exists.

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
Builtin controllers record configuration readiness in `status` and `last_error`.
Creating a pool on an unready builtin E2B controller succeeds with a `warning` field.
Plain image values name an E2B worker template.
The default lease is 900 seconds. Target configuration `E2B_TTL_SEC` overrides that default.
An explicit provision request `ttlSec` takes precedence. `renew` uses its explicit `ttlSec` and returns the expiry that E2B actually applied.

`E2B_MAX_CONTINUOUS_SEC` sets the continuous runtime trait. It defaults to 3600 seconds for Hobby.
Pro deployments can set 86400 seconds. Pass this target to the factory when constructing the adapter.
The SDK enforces the account limit. The trait does not increase that limit.

The supervisor provisions with pool `ttlSec` or 900 seconds, bounded by provider limits.
It stores the lease expiry and renews active or provisioning runtimes within `RUNTIME_LEASE_RENEW_BEFORE_SEC` seconds of expiry.
This window defaults to 300 seconds. Reaped runtimes receive no renewals.
Renewal stores the expiry E2B actually applied. A failed renewal triggers a provider check.
Confirmed absence triggers task recovery. Transport errors do not prove death.
If the API stops, lease expiry bounds sandbox lifetime without a cleanup request.

Within `RUNTIME_ROTATE_BEFORE_SEC` seconds of the continuous limit, the supervisor drains the runtime.
This window defaults to 600 seconds. A later tick terminates an idle runtime after another activity check.
Busy runtimes finish their tasks while draining. Demand can provision replacements within the pool cap.
The supervisor never pauses a busy runtime. Tasks longer than the continuous limit can still require crash recovery.

For `docker://ghcr.io/acme/worker:1.2`, the API calls `buildImageTemplate` on first provision.
The template name is `swarm-<sha256(image).slice(0,12)>`, using the image reference without `docker://`.
The pool stores this name in `resolved_image`. Later provisions reuse it.
Changing `image` clears the cache. An image change during construction prevents storing the obsolete result.
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
A pause during active work triggers `recoverRuntime`, then terminates the sandbox because the pause interrupted the model stream.
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
A per-task lifecycle injects `SWARM_EXIT_AFTER_TASKS=1`. The runner closes after its task finishes.
The supervisor removes exited runtimes and owner-filtered orphans, marks rows offline, and revokes runtime tokens.
Provider list handles can include `createdAt` as an ISO timestamp from infrastructure metadata.
The supervisor gives newly created orphans two minutes before termination to permit database registration.
Disabled pools stop provisioning but retain runtime cleanup.
Provision failures retire the row and store a scrubbed error. Retry policy and crash recovery belong to the failure supervisor.
E2B pools use the same supervisor with the lease and rotation rules above.
