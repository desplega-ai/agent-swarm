---
id: step-12
name: Integration E2E + docs
depends_on: [step-4, step-6, step-8, step-9, step-10, step-11]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-12: Integration E2E + docs

## Overview

Stitch the slices together and prove the whole model: lead on a `static` pool with `poll`, coders on a `docker` pool with `push` and `per-task`, a pool task routed and woken, crash recovery, and the flag-off no-op. Add a black-box E2E scenario for the API-only parts, the operator docs, and reconcile shared files the parallel steps touched. Done = the root plan's Global Verification and Manual E2E pass on one branch.

## Changes Required:

#### 1. Reconcile shared surfaces
**File**: `src/types.ts`, `src/http/all-routes.ts`, `src/server.ts`, `src/rbac/*`, `apps/ui/src/lib/configuration-catalog.ts`, `runbooks/heartbeat-crash-recovery.md`, `runbooks/runtime-providers.md`, `openapi.json`
**Changes**: dedupe anything two steps added twice (for example the `RuntimeProviderKindSchema`, catalog entries, runbook sections), make sure every env var introduced by steps 1-10 is in the configuration catalog (operator-tunable ones) and the env knobs table, regenerate `bun run docs:openapi`, `bun run build:script-types` if the SDK allowlist changed.

#### 2. Cross-slice gaps
**File**: as found
**Changes**: wire anything a step feature-detected because its dependency had not merged: step-6's socket-grace listener on step-7's event, step-4's circuit check, step-11's registration-test exemption removal. Each gets a test.

#### 3. Black-box scenario
**File**: `scripts/e2e/scenarios/runtime-pools.ts` (new, unique `order`, group `runtime-pools`)
**Changes**: API-only (no Docker, no LLM). The default SUT runs with the flag off and `MULTI_RUNTIME_ENABLED=false` (`scripts/e2e/sut.ts:145`), shared by every scenario. So the scenario branches on `/status`: flag off → assert pool routes return 404 and nothing else changes; flag on → pool + controller CRUD, pool create-agent, tier-2 routing after grace, runtime token mint + spoof 403 + revoke 401, `worker:` nudge subscribe/deny via ws, `deliveryMode` in the register response, supervisor status. The flag-on leg runs as its own invocation with the existing `--sut-env` option (`scripts/e2e/report.ts:164`), so other scenarios keep their env. Seed through the API only.

#### 3b. Remote-controller token dialog (UI)
**File**: `apps/ui/src/pages/settings/runtime-controllers-page.tsx`, `apps/ui/src/api/client.ts`
**Changes**: moved here from step-11 because it needs step-10's `POST /api/runtime-controllers/{id}/token`: dialog shows the plaintext once with a copy button and the `agent-swarm controller …` command. Operator/user only. Screenshot it with `agent-browser` for the PR.

#### 4. Operator docs
**File**: `docs-site/content/docs/(documentation)/guides/runtime-pools.mdx` (new, add to `meta.json`), `docs-site/content/docs/(documentation)/ui/configuration.mdx`, `docs-site/content/docs/(documentation)/guides/multi-runtime-agents.mdx` (cross-link), `MCP.md` (new tools), `CLAUDE.md` (`<important if>` block for runtime-provider / supervisor code pointing at `runbooks/runtime-providers.md`, if step-3 did not add it)
**Changes**: concepts (agent, pool, controller, runtime), the recommended topology (lead static + poll, coders on-demand), push vs poll, lifecycles, caps, E2B limits and leases, remote controller, BETA status and the flag, troubleshooting (registration timeout, circuit open, `WORKER_API_URL` reachability).

### Success Criteria:

#### Automated Verification:
- [x] Flag-off leg: `bun run e2e --only runtime-pools` passes
- [x] Flag-on leg: `bun run e2e --only runtime-pools --sut-env RUNTIME_POOLS_ENABLED=true --sut-env MULTI_RUNTIME_ENABLED=true --sut-env RUNTIME_WAKE_GRACE_SEC=2` passes
- [x] `cd apps/ui && bun run lint && bunx tsc -b` pass (token dialog)
- [x] Full gate from root `## Global Verification` passes, starting with `bun run check && bun run tsc:check:tsc && bun run test:root -- --parallel=4`

#### Automated QA:
- [x] Run the root plan's `## Manual E2E` scenarios 1-5 with Docker as an agent (all commands are scriptable). Save a short QA log with timings and container/runtime/task states to `thoughts/taras/qa/2026-10-10-push-based-workers.md`.
- [x] Stress test (Taras, 2026-10-11): root plan `## Manual E2E` scenario 7, one lead + one pool worker, the lead sends 100 ping-pong tasks to that worker. Run the docker leg first, then the E2B leg once step-9 is merged (costs money: confirm with Taras right before the E2B leg if he is reachable, otherwise run it, the expected spend is small). Record the results table from scenario 7 in the QA log and the PR body.

#### Manual Verification:
- [ ] Taras runs Manual E2E scenario 6 (E2B) if step-9's automated run was skipped.
- [ ] Taras reads the docs page once for tone and accuracy.

**Implementation Note**: This step is the integration slice. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-12] integration e2e + docs`.
