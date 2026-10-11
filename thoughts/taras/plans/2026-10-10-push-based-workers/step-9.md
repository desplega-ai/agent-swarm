---
id: step-9
name: E2B pools
depends_on: [step-5, step-6]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: E2B pools

## Overview

`e2b` pools work end to end under the supervisor, with E2B's limits handled on purpose. Sandboxes start on a short lease that the supervisor renews while the runtime is wanted, so nothing leaks if the API dies. Runtimes rotate before E2B's continuous-run limit. An unplanned pause is detected and resolved. A pool can name a Docker image that extends the worker base image, and the supervisor builds and caches the E2B template on first use. Done = an `e2b` pool wakes a sandbox for a pending task, renews it, reaps it, and rotates it near the limit (tested with a fake clock), plus one real E2B run.

## Changes Required:

#### 1. Lease renewal
**File**: `src/be/runtime-pools/supervisor.ts`, `src/runtime-providers/e2b.ts`
**Changes**: provision with `ttlSec` = pool `ttl_sec` ?? 900, store `lease_expires_at`. Each tick, a wanted runtime (active or provisioning, not reaped) whose lease ends within `RUNTIME_LEASE_RENEW_BEFORE_SEC` (default 300) → `controller.renew(handle, ttl)`, store the clamped `endAt`. A renew failure counts as a status check (gone → `recoverRuntime`, step-6).

#### 2. Planned rotation
**File**: `src/be/runtime-pools/supervisor.ts`
**Changes**: trait `maxContinuousSec` (target config `E2B_MAX_CONTINUOUS_SEC`; 3600 Hobby, 86400 Pro). When a runtime's age reaches `maxContinuousSec - RUNTIME_ROTATE_BEFORE_SEC` (default 600): idle → terminate (demand re-provisions); busy → `draining=1`, let demand provision a replacement, terminate when its task ends. Never pause a busy runtime. Reuses the drain path from step-6's token rotation.

#### 3. Unplanned pause
**File**: `src/be/runtime-pools/recovery.ts`
**Changes**: status `paused` for a runtime the supervisor expects running: if still wanted and idle → `resume()` then continue; if it had active tasks (the pause broke the LLM stream) → `recoverRuntime` (tasks resume elsewhere) then terminate it; if not wanted → terminate.

#### 4. Custom image → template
**File**: `src/be/runtime-pools/e2b-images.ts` (new), `src/e2b/dispatch.ts:566` (reuse `buildImageTemplate`)
**Changes**: pool `image` with prefix `docker://` (for example `docker://ghcr.io/acme/worker:1.2`): on first provision, build a template with `buildImageTemplate` (name `swarm-<sha256(image).slice(0,12)>`), store it in `runtime_pools.resolved_image`, use it for later provisions. Rebuild when `image` changes (clear `resolved_image` on PATCH). A build failure counts as a provision failure (step-6 retries and circuit). The "image lacks the swarm runner" case surfaces through step-6's registration timeout message. Plain template ids pass through unchanged.

#### 5. Config checks
**File**: `src/runtime-providers/e2b.ts`, `src/be/runtime-pools/db.ts`
**Changes**: `checkConfig` requires `E2B_API_KEY` and an `https://` `WORKER_API_URL` (controller config or `RUNTIME_WORKER_API_URL` / `PUBLIC_MCP_BASE_URL`). The controller row shows the result as `status`/`last_error`. Pool create on an unready `builtin-e2b` returns a warning field, not an error (the key may be added later).

#### 6. Docs
**File**: `runbooks/runtime-providers.md` (E2B section), `runbooks/heartbeat-crash-recovery.md` §1a (unplanned pause → `recoverRuntime`, lease expiry as a death signal; same-PR rule)
**Changes**: lease model, rotation, tier limit config, `docker://` images (must `FROM ghcr.io/desplega-ai/agent-swarm-worker:slim` or full), cost note (per-task pools pay the boot sequence every time; see the 89-call boot finding and #2048).

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/runtime-e2b-pools.test.ts src/tests/runtime-providers-e2b.test.ts`
- [x] Fake provider + fake clock cover: renew before lease end; no renew for a reaped runtime; rotation idle vs busy (drain, replacement, terminate after task); unplanned pause idle → resume, busy → recover, unwanted → terminate; `docker://` build once, cache in `resolved_image`, rebuild after image PATCH, build failure → provision failure; `checkConfig` https rule
- [x] `bun run lint && bun run tsc:check:tsc` pass

#### Automated QA:
- [ ] (deferred to step-12 E2B legs) Only if `E2B_API_KEY` is available to the executor and an HTTPS tunnel can be opened (ngrok or cloudflared, random API key, closed afterwards): API on a temp DB with the flag on, `e2b` pool with the published worker template, `ttl_sec: 300`, `idle_minutes: 2`. Pin a "store-progress 'pong'" task (`modelTier: smol`) to its agent. The sandbox appears (`bun run src/cli.tsx e2b list`), the task completes, at least one renew is logged, the sandbox is gone after the idle window. If the key or tunnel is unavailable, record "skipped: no E2B credentials" and move this check to Manual.

#### Manual Verification:
- [ ] If the automated E2B run was skipped, Taras runs the same scenario (costs about one sandbox-hour or less).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-9] e2b pools`.
