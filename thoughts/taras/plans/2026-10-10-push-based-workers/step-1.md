---
id: step-1
name: Runtime pools + controllers entity
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Runtime pools + controllers entity

## Overview

An operator can create, read, update and delete runtime pools and controllers, and bind agents to a pool, through REST and MCP, behind the `RUNTIME_POOLS_ENABLED` flag. The API seeds one built-in controller per provider kind it can host, plus a default `static` pool. This step only stores configuration. Nothing provisions yet (step-5). Done = the schema, DB module, routes, tools, RBAC verbs, flag and boot seed exist and are covered by tests.

Model (from the brainstorm): agent → bound to → pool → placed on → controller → starts → runtime (`runtime_instances` row).

## Changes Required:

#### 1. Feature flag
**File**: `src/utils/runtime-pools-flag.ts` (new), `src/http/status.ts`
**Changes**:
- `isRuntimePoolsEnabled(env = process.env)` via `isEnvFlagEnabled("RUNTIME_POOLS_ENABLED", false)` (`src/utils/env-flag.ts:49`).
- Expose `runtime_pools: { enabled: boolean }` on `/status` (pattern: Comb, `src/http/status.ts:151`, `:724-735`), with a Zod schema so the UI (step-11) can gate on it.
- Register `RUNTIME_POOLS_ENABLED` in `apps/ui/src/lib/configuration-catalog.ts` (group Workers or Harness, `kind: "boolean"`, `defaultValue: false`, `restartRequired: true`, label "Runtime pools (beta)").

#### 2. Migration `206_runtime_pools.sql`
**File**: `src/be/migrations/206_runtime_pools.sql` (new). Re-check `main`'s tail and open PRs before merging (`bash scripts/check-migration-conflicts.sh`).
**Changes**:
- `runtime_controllers`: `id TEXT PK`, `name TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL` (provider kind), `placement TEXT NOT NULL CHECK (placement IN ('builtin','remote'))`, `config TEXT NOT NULL DEFAULT '{}'` (plain target config JSON, e.g. `DOCKER_HOST`, `DOCKER_NETWORK`), `secret_config TEXT` (target-config secrets such as `E2B_API_KEY`, stored as one JSON object encrypted with `encryptSecret`, `src/be/crypto/secrets-cipher.ts:34`; never returned by any route, the API shape only lists the key names). Controller secrets deliberately do NOT live in `swarm_config`: the entrypoint exports every resolved config key into each worker's env (`docker-entrypoint.sh:543-575`), so a global `e2b_api_key` row would leak to every runtime. `status TEXT NOT NULL DEFAULT 'unknown'` (`online|offline|unknown`), `last_seen_at`, `last_error TEXT`, `last_error_at`, audit columns `created_by`/`updated_by`, `created_at`/`updated_at`.
- `runtime_pools`: `id TEXT PK`, `name TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL`, `placements TEXT NOT NULL DEFAULT '[]'` (JSON array of controller ids, exactly one entry enforced in code in v1), `image TEXT`, `lifecycle TEXT NOT NULL CHECK (lifecycle IN ('idle','per-task'))`, `idle_minutes INTEGER` (NULL = never), `slots_per_runtime INTEGER NOT NULL DEFAULT 1`, `max_runtimes INTEGER`, `min_runtimes INTEGER NOT NULL DEFAULT 0`, `delivery TEXT CHECK (delivery IN ('poll','push'))` (NULL = deployment default), `env TEXT NOT NULL DEFAULT '{}'` (plain worker env), `resources TEXT` (JSON `{cpu, memoryMb}`), `ttl_sec INTEGER`, `resolved_image TEXT` (provider artifact cache, e.g. the E2B template built from a `docker://` image, step-9), `enabled INTEGER NOT NULL DEFAULT 1`, health columns for step-6 (`consecutive_failures INTEGER NOT NULL DEFAULT 0`, `circuit_open_until TEXT`, `last_error TEXT`, `last_error_at TEXT`), audit + timestamp columns.
- `ALTER TABLE agents ADD COLUMN runtime_pool_id TEXT REFERENCES runtime_pools(id) ON DELETE SET NULL` + index. NULL = unbound (today's behavior).
- `ALTER TABLE runtime_instances ADD COLUMN pool_id TEXT`, `controller_id TEXT`, `external_handle TEXT` (JSON `RuntimeHandle`), `provision_attempts INTEGER NOT NULL DEFAULT 0`, `provision_error TEXT`, `provision_requested_at TEXT`, `draining INTEGER NOT NULL DEFAULT 0`, `idle_since TEXT` (supervisor idle tracking), `lease_expires_at TEXT` (E2B lease, step-9), `task_id TEXT` (first task a per-task runtime ran) + index on `pool_id`.
- No other step adds a migration except step-2 (`207`). Every column the later steps need is here.

#### 3. Types
**File**: `src/types.ts`
**Changes**:
- `RuntimeProviderKindSchema = z.enum(["static","docker","e2b","k8s"])` (k8s kept, unsupported: write paths reject it with 400 "k8s provider not implemented").
- `RuntimeControllerSchema`, `RuntimePoolSchema` (camelCase API shape; `secretConfigKeys: string[]` only, write input accepts `secretConfig: Record<string,string>` and merges, `null` value deletes a key), create/update input schemas, `DeliveryModeSchema = z.enum(["poll","push"])`, `PoolLifecycleSchema`.
- Extend `RuntimeInstanceStatusSchema` (`src/types.ts:1967`) with `provisioning` and add the new optional runtime fields to `RuntimeInstanceSchema`. Do NOT change any liveness helper here (step-5 owns that).
- Add `runtimePoolId` to the agent schema.

#### 4. DB module
**File**: `src/be/runtime-pools/db.ts` (new). Pattern: `src/be/extensions/db.ts`.
**Changes**: `getDbClient()` only. CRUD for controllers and pools, `bindAgentToPool(agentId, poolId | null)`, `listAgentsForPool(poolId)`, `getPoolForAgent(agentId)`. Validation: pool kind must equal its controller's kind; `placements.length === 1`; `slotsPerRuntime >= 1`; `minRuntimes <= maxRuntimes` when both set; `kind = static` forces `lifecycle='idle'`, `idle_minutes=NULL`; delete of a pool with bound agents returns 409 unless `force` (then unbinds). Audit columns from the actor.

#### 5. Boot seed
**File**: `src/be/runtime-pools/seed.ts` (new), wired in `src/http/index.ts:611-660` next to the other seeders.
**Changes**: Only when the flag is on. Idempotent, user edits preserved:
- Built-in controllers `builtin-static` (always), `builtin-docker` (when `/var/run/docker.sock` or `RUNTIME_DOCKER_HOST` exists), `builtin-e2b` (always; on first seed copy `E2B_API_KEY` from the API env into `secret_config` if set; status reflects whether the key is present).
- Default pool `default-static` (`kind static`, `builtin-static`, `delivery NULL`). Agents stay unbound unless an operator binds them.
- Env `RUNTIME_DEFAULT_DELIVERY` (`poll|push`, default `poll`) is the deployment default for pools with `delivery NULL`. Register it in the configuration catalog.

#### 6. REST routes
**File**: `src/http/runtime-pools.ts` (new), import in `src/http/all-routes.ts`, dispatcher chained in `src/http/index.ts` (next to `handleExtensions`, `:392`).
**Changes**: `route()` factory with response `schema` on every 2xx.
- `GET/POST /api/runtime-pools`, `GET/PATCH/DELETE /api/runtime-pools/{id}`, `GET /api/runtime-pools/{id}/runtimes` (rows from `runtime_instances` by `pool_id`).
- `GET/POST /api/runtime-controllers`, `GET/PATCH/DELETE /api/runtime-controllers/{id}`.
- `PUT /api/agents/{id}/runtime-pool` body `{poolId: string | null}`.
- `POST /api/runtime-pools/{id}/agents` body `{name, isLead?, harnessProvider?, maxTasks?, templateId?}`: creates an agent row bound to the pool, with `status='offline'` and no runtime. Today no route creates an agent without a booting runtime (`createAgent` is only called from register, `src/http/agents.ts:715`, and `join-swarm`, `src/tools/join-swarm.ts:110`), so an on-demand agent that never booted would have no row to bind or route to. Enforce the single-lead rule here (same check as `src/tools/join-swarm.ts:104`). A `templateId` is stored into the pool-agent env as `TEMPLATE_ID` at provision time (step-5), not applied server-side.
- All return 404 `{error:"runtime pools are disabled"}` when the flag is off.
- Errors through `jsonError(res, scrubSecrets(msg), status)`.

#### 7. RBAC
**File**: `src/rbac/permissions.ts`, `src/rbac/legacy-policy.ts`, `src/rbac/types.ts`
**Changes**: `runtime_pool.write` mapped to `leadOrOperatorOrUser` (same rule as `extension.install.inline`, decided with Taras). `runtime_controller.write` (and the controller token mint in step-10) is operator or user only: no agent, lead included, because controller config holds infra credentials and Docker host settings (`DOCKER_NETWORK=host`, extra hosts) that a prompt-injected lead must not change. Reads ungated. Resource kinds `runtime_pool`, `runtime_controller`. `bun run check:rbac-coverage` must pass.

#### 8. MCP tools
**File**: `src/tools/runtime-pool-list.ts`, `runtime-pool-upsert.ts`, `runtime-pool-delete.ts`, `runtime-pool-bind-agent.ts`, `runtime-pool-create-agent.ts`, `runtime-controller-list.ts` (new), registered in `src/server.ts` and `ALL_TOOLS`.
**Changes**: proxy to REST (pattern `src/tools/extension-common.ts`), return `toolOk`/`toolErr`, loose `swarmToolOutputSchema`. Add each name to `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) or `EXCLUDED_TOOLS` with a reason. Run `bun run build:script-types` if the allowlist changes.

#### 9. Docs + OpenAPI
**File**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: `bun run docs:openapi`, commit output.

### Success Criteria:

#### Automated Verification:
- [x] New tests pass: `bun run test:root -- src/tests/runtime-pools-db.test.ts src/tests/runtime-pools-http.test.ts src/tests/runtime-pools-seed.test.ts`
- [x] `bun run test:root -- src/tests/runtime-pools-http.test.ts` cases cover: CRUD, kind/controller mismatch 400, `k8s` 400, delete-with-bound-agents 409, flag-off 404, pool create-agent (row offline + bound, second lead → 409), seed idempotency + user-edit preservation, `RUNTIME_DEFAULT_DELIVERY` resolution, RBAC (pool: non-lead agent write 403, lead write 200; controller: lead write 403, user/operator 200), controller `secret_config` values never appear in any response or log
- [x] Migration applies on a fresh DB and on a DB at ordinal 205 with existing agents and runtime rows (pattern `src/tests/migration-063-schema-relax.test.ts`): `bun run test:root -- src/tests/migration-206-runtime-pools.test.ts`
- [x] `bash scripts/check-migration-conflicts.sh` passes
- [x] `bash scripts/check-audit-columns.sh` passes
- [x] `bun run check:rbac-coverage && bun run check:openapi-response-coverage` pass
- [x] `bun scripts/check-sdk-tool-registration.ts` passes
- [x] `bash scripts/check-async-db-seam.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts` pass
- [x] `bun run lint && bun run tsc:check:tsc` pass
- [x] `bun run docs:openapi` leaves no diff after commit

#### Automated QA:
- [x] Boot the API on a temp DB with `RUNTIME_POOLS_ENABLED=true` (`DATABASE_PATH=/tmp/rp-qa.sqlite PORT=<free> bun run start:http`). With curl: list controllers (seeded rows present), create a `docker` pool on `builtin-docker`, bind an agent, read it back via `GET /api/agents/{id}`, delete with bound agent (409), then `force`.
- [x] Same boot with the flag off: `GET /api/runtime-pools` returns 404 and `/status` reports `runtime_pools.enabled=false`.
- [x] Call `runtime-pool-list` and `runtime-pool-upsert` through the MCP endpoint (`/mcp`) with a lead agent id and confirm both channels of the tool result.

#### Manual Verification:
- [ ] Taras reviews the column set in `206_runtime_pools.sql` once more (forward-only migration, cannot be edited after merge).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-1] runtime pools + controllers entity`.
