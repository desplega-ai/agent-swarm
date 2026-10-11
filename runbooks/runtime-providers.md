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

## Docker

`DOCKER_HOST` defaults to `unix:///var/run/docker.sock`. Only Unix sockets are supported.
`DOCKER_NETWORK` selects a network. `DOCKER_EXTRA_HOSTS` adds comma-separated `host:address` entries.
The adapter always includes `host.docker.internal:host-gateway`.
Requests can set memory in MiB and CPU count through `resources`.

When creation returns 404 with `No such image`, the adapter pulls the requested image and retries creation once.
It consumes the pull response to completion and rejects errors embedded in the response stream.
A missing container reports `exited`. Other lookup errors report `unknown`.
Adapter errors pass through `scrubSecrets`. Provisioned environment values register with the scrubber before Docker receives them.

## E2B

`E2B_API_KEY` is required. `E2B_API_BASE` selects a custom endpoint.
Images must name an E2B worker template. Template construction belongs to the controller layer.
The default lease is 900 seconds. `renew` uses `setSandboxTimeout` and returns the expiry that E2B actually applied.

`E2B_MAX_CONTINUOUS_SEC` sets the continuous runtime trait. It defaults to 3600 seconds for Hobby.
Pro deployments can set 86400 seconds. Pass this target to the factory when constructing the adapter.
The SDK enforces the account limit. The trait does not increase that limit.

Status uses one `Sandbox.getInfo` lookup. It preserves paused state because `Sandbox.connect` would resume the sandbox.
A sandbox lookup that reports absence returns `exited`. Authentication and transport failures remain errors.
Pause uses `Sandbox.betaPause`. Resume uses `Sandbox.connect`.
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
