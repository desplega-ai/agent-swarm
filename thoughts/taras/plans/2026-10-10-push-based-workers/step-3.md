---
id: step-3
name: Runtime providers productionized
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: Runtime providers productionized

## Overview

Turn the spike in `src/runtime-providers/` into the supported, DB-free provider layer that the supervisor (step-5), the E2B work (step-9) and the remote controller (step-10) call. Done = `static`, `docker` and `e2b` adapters behind `createRuntimeProvider(kind)`, an owner label so two swarms sharing one Docker host or E2B team never touch each other's runtimes, optional lease/pause hooks, a registration test that mirrors the harness-provider one, and `runbooks/runtime-providers.md`. QA-able with the smoke script against local Docker.

## Changes Required:

#### 1. Interface
**File**: `src/runtime-providers/types.ts`
**Changes**:
- Remove the SPIKE markers. Keep `RuntimeProviderKind = "static" | "docker" | "e2b" | "k8s"` aligned with `RuntimeProviderKindSchema` from step-1. If step-1 has not merged yet, define the schema here in `src/types.ts` and let step-1 reuse it (whichever lands second deduplicates).
- Add `RUNTIME_LABELS.owner = "swarm.owner"`. `ProvisionRequest` gains `ownerId: string`. `list(target, ownerId)` returns only runtimes with that owner label.
- Add `RuntimeHandle.controllerId?: string` (set by the controller layer in step-5, not by adapters).
- Optional methods: `renew?(target, handle, ttlSec): Promise<{endAt: string}>`, `pause?(target, handle)`, `resume?(target, handle)`. Trait `maxContinuousSec?: number` (E2B: from target config `E2B_MAX_CONTINUOUS_SEC`, default 3600, since it depends on the E2B tier: 86400 Pro, 3600 Hobby).
- `RuntimeStatus` adds `"paused"`.

#### 2. Factory
**File**: `src/runtime-providers/index.ts`
**Changes**: lazy switch over all four kinds. `static` → `StaticRuntimeProvider`. `k8s` → throws `Unknown runtime provider: "k8s" (not implemented). Supported: static, docker, e2b`. Default error lists `Supported: static, docker, e2b` (parsed by the registration test, same as `src/providers/index.ts`).

#### 3. Static adapter
**File**: `src/runtime-providers/static.ts` (new)
**Changes**: `traits.canProvision = false`. `checkConfig` → ready. `provision`/`terminate` throw `static pools are operator-managed`. `status` → `"unknown"`. `list` → `[]`.

#### 4. Docker adapter hardening
**File**: `src/runtime-providers/docker.ts`
**Changes**:
- Pull the image when create returns 404 "No such image" (`POST /images/create?fromImage=…`, wait for the stream to end), then retry create once.
- Stamp `swarm.owner`. `list` filters on both `swarm.runtime-id` and `swarm.owner=<ownerId>`.
- `status` on 404 returns `"exited"` (container gone), not `"unknown"`.
- Host config: keep `ExtraHosts`. Support `DOCKER_NETWORK` and a `DOCKER_EXTRA_HOSTS` comma list. Keep unix-socket only.
- Errors pass through `scrubSecrets` before they leave the adapter message (env values may echo back in Docker errors).

#### 5. E2B adapter hardening
**File**: `src/runtime-providers/e2b.ts`, `src/e2b/dispatch.ts` (reuse only)
**Changes**:
- Stamp `swarm.owner` in metadata. `list` filters on owner.
- `status` uses one sandbox lookup (connect/getInfo via the SDK helper used by `setSandboxTimeout`, `dispatch.ts:286`), maps paused to `"paused"`, missing to `"exited"`.
- `renew` wraps `setSandboxTimeout` and returns the clamped `endAt`. `pause`/`resume` wrap the SDK (`Sandbox.betaPause` / `Sandbox.connect`). Check the installed `e2b` SDK version's exact method names with Context7 before writing.
- Default `ttlSec` when the request has none: 900 (short lease; the supervisor renews in step-9).

#### 6. Registration test
**File**: `src/tests/runtime-provider-registration.test.ts` (new). Pattern: `src/tests/provider-registration.test.ts:67-173`.
**Changes**: loop `RuntimeProviderKindSchema.options` over touch points: factory "Supported:" list, adapter file exists, `runbooks/runtime-providers.md` mentions the kind, UI kind list (`apps/ui/src/lib/runtime-pools.ts` `RUNTIME_PROVIDER_KINDS`, exempt with reason "UI lands in step-11" until step-11 removes the exemption). `k8s` exempt everywhere with reason "adapter not implemented". Stale exemptions fail.

#### 7. Unit tests
**File**: `src/tests/runtime-providers-docker.test.ts`, `src/tests/runtime-providers-e2b.test.ts` (new)
**Changes**: Docker: a fake Engine API on a temp unix socket (`Bun.serve({unix})`) checks create/pull-retry/start/labels/owner-filtered list/status mapping/404 handling. E2B: mock the dispatch helpers (`mock.module` only inside the file, mind the process-wide leak noted in `runbooks/testing.md`), check metadata, owner filtering, status mapping, renew.

#### 8. Smoke script + runbook
**File**: `scripts/spike-runtime-providers.ts` → rename to `scripts/runtime-provider-smoke.ts`; `runbooks/runtime-providers.md` (new); `CLAUDE.md` (one `<important if>` block pointing at the runbook, like harness providers)
**Changes**: smoke script passes `ownerId`. Runbook: concept (agent → pool → controller → runtime), adapter contract, owner labels, "adding a provider" checklist (types, factory, adapter, registration test, UI list, docs), same-PR doc rule.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-provider-registration.test.ts src/tests/runtime-providers-docker.test.ts src/tests/runtime-providers-e2b.test.ts`
- [x] `bash scripts/check-db-boundary.sh` passes (`src/runtime-providers/` stays DB-free)
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [x] Docker smoke against local Docker/OrbStack with a local API on a temp DB: `bun scripts/runtime-provider-smoke.ts --provider docker --api http://localhost:<port> --worker-api http://host.docker.internal:<port> --image ghcr.io/desplega-ai/agent-swarm-worker:slim --api-key <key>`. The task completes, `terminate` runs, owner-filtered `list` is empty.
- [x] Owner isolation: start one container by hand with `swarm.runtime-id` but a different `swarm.owner` label. `list(target, ownerId)` does not return it. Remove it afterwards.
- [x] Image pull: `docker rmi` the worker image (or use a small tagged copy), run the smoke again, confirm the pull path.

#### Manual Verification:
- [ ] Optional E2B smoke (costs a sandbox): `bun scripts/runtime-provider-smoke.ts --provider e2b --api http://localhost:<port> --worker-api https://<tunnel-host> --image <e2b-template>` behind an HTTPS tunnel, if Taras wants it before step-9.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-3] runtime providers productionized`.
