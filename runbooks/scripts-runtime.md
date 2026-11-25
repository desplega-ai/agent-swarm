# Scripts runtime runbook

Read this before you change `src/scripts-runtime/*`, `src/be/scripts/*`, `src/tools/script-*.ts` or `src/http/scripts.ts`.
The root `CLAUDE.md` keeps only the rules that cause damage when missed. This file has the full contract.

## Architecture

The API owns the `scripts` and `script_versions` tables. Workers and the runtime invoke the API through HTTP.
Native execution uses a sandboxed `Bun.spawn` subprocess on the selected executor host.
`buildSandboxedCommand` launches `bun --no-orphans` with `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`.
An embedded child belongs to the API host. A remote child belongs to its script runner.
The wall-clock limit defaults to 30 seconds and allows five minutes where exposed. Stdout has a 1 MB cap.
QuickJS uses a worker pool on the selected executor host.

Synchronous runs use the dispatcher. With PostgreSQL, a connected script runner with capacity can execute the job.
Otherwise the embedded runner executes it if capacity permits. Excess runs wait in the API sync queue. See [script-runners.md](./script-runners.md) for credentials, UID isolation and lifecycle.

## Config injection

The API passes the agent identity, bearer and API address in JSON on subprocess stdin. Guest code uses the SDK. The runtime keeps credentials out of the environment. API callers use `runScriptWithRunCredential`. Each inline run gets a short-lived credential for its authorized agent, user or operator. The API revokes it when the run ends. An unknown agent cannot acquire a credential. User runs receive no agent connections, filesystem credentials or deployment egress secrets.

Durable runs store the launch principal in `script_runs.executionPrincipal`. A broker receives its own credential. It can finish after the inline parent exits. A launch from a worker, runtime or task session keeps that session's authority and expiry. Revocation of the original session also ends broker access. The API revokes each broker credential during cleanup.

Older durable rows recorded the owner and journal but omitted the launch session. The owner must still exist. The broker can replay recorded steps and update that run's journal and status. A new external step needs a fresh authorized launch. User and operator credentials carry run provenance into audit writes.

## FS modes

 `'none'` = per-run tmpdir (v1 only); `'workspace-rw'` returns 501 in v1 (worker dispatch is v2).

## `ctx.fs` / `ctx.sh` (`src/scripts-runtime/script-fs.ts`)

Just-bash uses a `MountableFs`. `/afs` is the invoking agent's default agent-fs drive.
It mounts only with the agent's own agent-scoped `AGENT_FS_API_KEY` through a credential-broker placeholder.
Global, repository and `API_AGENT_FS_API_KEY` values cannot mount it. Every other path uses `InMemoryFs`.
Both executors run these adapters on the selected executor host. QuickJS uses the API process or remote runner process.
Preserve `SCRIPT_FS_MAX_BYTES` for scratch bodies, shell commands and drive responses.
Preserve the metadata budget, name limits and `/afs` protections in `scratch-fs.ts`, including symlinks and `cp` or `mv`.
Just-bash and its adapter stay outside the native harness bundle through lazy imports and Dockerfile externals.
Durable script workflows and extensions do not receive these adapters.

## SDK surface

Derived from MCP tool registry at build time via `scripts/bundle-script-types.ts`. Curated allowlist in `src/scripts-runtime/sdk-allowlist.ts`.

## Typecheck

 `script_upsert` runs `tsc --noEmit` against the generated `.d.ts`; rejects on diagnostics. Inline `script_run` skips typecheck (scratch hot path). The ambient `.d.ts` is assembled per call from a static base plus N **type contributors** (`src/be/scripts/type-contributors.ts`, connections API, MCP tools, per-app types); adding one is a parameter on `scriptSdkTypesWithGeneratedApis` / `scriptStdlibTypesWithGeneratedApis`, never a compiler-host change. Staleness posture: stored scripts are **not** re-typechecked when an app or connection changes.

## Boundaries

 `src/scripts-runtime/` is on both `check-db-boundary.sh` (no `src/be/db` imports) and `check-api-key-boundary.sh` (must use `getApiKey()`) allowlists.

## Tests

 `bun run test:root -- src/tests/scripts-*.test.ts` runs the existing units. Sandbox + timeout + abort + stdin-config + env-hygiene paths are the highest-risk surfaces, keep coverage tight, with new cases as e2e scenarios (`scripts/e2e/scenarios/script-*.ts`), not new unit tests.

## New MCP tools

When adding a tool, register it in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) to expose it to scripts, or add it to `EXCLUDED_TOOLS` in `scripts/check-sdk-tool-registration.ts` with a reason. Enforced by CI.

## Durable placement

On PostgreSQL, durable runs reserve shared capacity before acquiring a broker credential.
They can wait as unowned rows when embedded slots are disabled or capacity is full.
The API retains the broker and capability session. Only the guest runs remotely.
SQLite retains local execution and leaves ownership columns NULL.
See [script-runners.md](./script-runners.md#durable-runs) for lease, replay and drain behavior.

## Durable launch bus on PostgreSQL

The API writes `script.job.requested` with the durable run in one transaction.
The `script-dispatcher` consumer group exists in the topic catalog, even before a consumer starts.
Every producer and consumer uses the same durable group catalog.
The backend rejects a durable subscription when its group is absent from that catalog.
Tests can supply a fixture catalog through the storage-neutral `BusDurableGroups` contract.
Publication creates deliveries for declared groups only. Local subscribers cannot add implicit durable groups.
The launch still starts a background run directly. A repeated delivery uses the supervisor guard.
A deferred launch records its originating API boot in the event.
That boot acknowledges the event without starting a guest.
A new boot can start the guest from a delivery left pending by a crash.
The ordinary supervisor scan still recovers deferred runs.
With `SCRIPT_RUN_SUPERVISOR_DISABLE=true`, launches retain their run rows but create no bus events.
After the supervisor is enabled, reconciliation recovers those rows.

The table backend claims deliveries with SERIALIZABLE transactions and `FOR UPDATE SKIP LOCKED`.
It executes handlers outside those transactions and fences acknowledgements with a unique claim token.
A failed handler returns its delivery to pending. Retry delays double from 15 seconds to a five-minute maximum.
The bus retries indefinitely. It never discards an undelivered event because of its attempt count.
A claim expires after 60 seconds. An expired claim can repeat a handler that still executes.
After-commit wakes and a 15-second sweep trigger delivery. A boot starts delivery before reconciliation.
The supervisor still reads active run rows for recovery.

Each backend instance runs one serial pump across its local subscriptions.
Each pass claims at most 100 deliveries per subscription, then continues if that batch was full.
Slow handlers delay other local subscriptions. Other API instances can claim concurrently.
Claims prefer the earliest availability time, then the event ID. This does not guarantee publication order.
Later events can precede a failed event during its retry delay. Handlers must tolerate repeated delivery.
Stopping the bus suppresses pending wake callbacks, including callbacks from transactions that commit after a restart.
The API logs the failed operation, topic, group and event ID when available.
The API scrubs the complete diagnostic before it reaches stderr.

The API owns the bus and its database connection. A script runner never accesses bus tables.
SQLite uses the existing supervisor path and has no execution bus tables.
Existing realtime and workflow event subscribers retain their current delivery behavior.
See `runbooks/db-retention.md` for the internal queue retention policy.
