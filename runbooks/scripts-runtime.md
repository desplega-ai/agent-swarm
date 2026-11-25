# Scripts runtime runbook

Read this before you change `src/scripts-runtime/*`, `src/be/scripts/*`, `src/tools/script-*.ts` or `src/http/scripts.ts`.
The root `CLAUDE.md` keeps only the rules that cause damage when missed. This file has the full contract.

## Architecture

API server owns the `scripts` + `script_versions` tables. Workers + the runtime invoke via HTTP. The runtime evaluates user-supplied TS in a `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, launched as `bun --no-orphans` (the harness dies with the API and SIGKILLs its whole descendant tree on exit; added by `buildSandboxedCommand` in `src/utils/sandboxed-process.ts`), a wall-clock AbortController (30s default; up to 5m where exposed), and a 1 MB stdout cap.

Synchronous runs use the dispatcher. With PostgreSQL, a connected script runner with capacity can execute the job.
Otherwise the embedded runner executes it if capacity permits. Excess runs wait in the API sync queue. See [script-runners.md](./script-runners.md) for credentials, UID isolation and lifecycle.

## Config injection

The API passes the agent identity, bearer and API address in JSON on subprocess stdin. Guest code uses the SDK. The runtime keeps credentials out of the environment. API callers use `runScriptWithRunCredential`. Each inline run gets a short-lived credential for its authorized agent, user or operator. The API revokes it when the run ends. An unknown agent cannot acquire a credential. User runs receive no agent connections, filesystem credentials or deployment egress secrets.

Durable runs store the launch principal in `script_runs.executionPrincipal`. A broker receives its own credential. It can finish after the inline parent exits. A launch from a worker, runtime or task session keeps that session's authority and expiry. Revocation of the original session also ends broker access. The API revokes each broker credential during cleanup.

Older durable rows recorded the owner and journal but omitted the launch session. The owner must still exist. The broker can replay recorded steps and update that run's journal and status. A new external step needs a fresh authorized launch. User and operator credentials carry run provenance into audit writes.

## FS modes

 `'none'` = per-run tmpdir (v1 only); `'workspace-rw'` returns 501 in v1 (worker dispatch is v2).

## `ctx.fs` / `ctx.sh` (`src/scripts-runtime/script-fs.ts`)

Just-bash over a `MountableFs`. `/afs` is the invoking agent's default agent-fs drive. It mounts only with the agent's own agent-scoped `AGENT_FS_API_KEY` (never a global or repo row, never `API_AGENT_FS_API_KEY`), and the key rides as a credential-broker placeholder. Every other path is `InMemoryFs`. Both executors run this host-side (under quickjs, that is the API process), so keep its limits: `SCRIPT_FS_MAX_BYTES` (scratch bodies, each shell command, each drive response) and `ScratchFs` in `scratch-fs.ts` (metadata budget, name limits, and `/afs` reserved in scratch, also through symlinks and cp / mv). just-bash and the adapter stay out of the native harness bundle: lazy import plus the Dockerfile externals. Durable script workflows and extensions do not get it.

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
The launch still starts a background run directly. A repeated delivery uses the supervisor guard.
A deferred launch records its originating API boot in the event.
That boot acknowledges the event without starting a guest.
A new boot can start the guest from a delivery left pending by a crash.
The ordinary supervisor scan still recovers deferred runs.

The table backend claims deliveries with SERIALIZABLE transactions and `FOR UPDATE SKIP LOCKED`.
It executes handlers outside those transactions and fences acknowledgements with a unique claim token.
A failed handler waits for the next sweep. A claim expires after 60 seconds.
After-commit wakes and a 15-second sweep trigger delivery. A boot starts delivery before reconciliation.
The supervisor still reads active run rows for recovery.

The API owns the bus and its database connection. A script runner never accesses bus tables.
SQLite uses the existing supervisor path and has no execution bus tables.
Existing realtime and workflow event subscribers retain their current delivery behavior.
See `runbooks/db-retention.md` for the internal queue retention policy.
