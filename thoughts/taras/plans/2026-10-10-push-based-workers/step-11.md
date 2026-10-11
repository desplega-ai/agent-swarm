---
id: step-11
name: Dashboard UI for pools
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-11: Dashboard UI for pools

## Overview

Full CRUD in the dashboard for runtime pools and controllers, an agent-to-pool binding on the agent page, and a per-pool runtime list with state and the last provisioning error. The whole surface is hidden unless the API reports `runtime_pools.enabled` (`/status`) and the API version is at least `RUNTIME_POOLS_MIN_VERSION`, and it carries a BETA chip. Done = an operator can do everything step-1's API allows from the UI, with screenshots and a recording in the PR. Executor: Opus (UI work, per `delegate-work`). Read `apps/ui/CLAUDE.md`, `apps/ui/DESIGN.md` and use the `dashboard-ui` skill first.

## Changes Required:

#### 1. Gates
**File**: `apps/ui/src/lib/runtime-pools.ts` (new)
**Changes**: `RUNTIME_POOLS_MIN_VERSION = "1.169.0"` (the next release after `1.168.0`; the release PR must keep this equal to the shipped version). `RUNTIME_PROVIDER_KINDS` (`static`, `docker`, `e2b`, `k8s` shown disabled "coming soon"), kind labels, lifecycle labels. Remove the UI exemption from `src/tests/runtime-provider-registration.test.ts` if step-3 has merged. A `useRuntimePoolsGate()` hook = `useFeatureGate(RUNTIME_POOLS_MIN_VERSION)` AND `status.runtime_pools.enabled` (dev-mode bypass comes from `useFeatureGate`).

#### 2. API client + hooks
**File**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/types.ts`, `apps/ui/src/api/hooks/use-runtime-pools.ts` (new)
**Changes**: methods and react-query hooks for every step-1 route (pools, controllers, pool runtimes, agent binding, pool create-agent; controller `secretConfig` write-only), with an invalidator like `useExtensionInvalidator`. Types mirror `RuntimePoolSchema` / `RuntimeControllerSchema` / `RuntimeInstanceSchema`.

#### 3. Pages
**File**: `apps/ui/src/pages/settings/runtime-pools-page.tsx`, `runtime-pool-detail-page.tsx`, `runtime-controllers-page.tsx` (new); `apps/ui/src/app/router.tsx` (lazy routes near `:191`); `apps/ui/src/pages/settings/settings-layout.tsx:44` (nav item with BETA chip; add `beta` support to the settings nav if it lacks it, reusing `BetaTag` from `app-sidebar.tsx:205`)
**Changes**:
- Pools list: `DataGrid` (+ `MobileList` on phones): name, kind, controller, lifecycle, delivery, agents count, runtimes live/provisioning, health (circuit open, last error).
- Pool detail/edit (`DetailPageBody` + rail): all fields with validation mirroring the API (kind ↔ controller kind, `static` locks lifecycle, `minRuntimes ≤ maxRuntimes`), env as key/value editor, delete with `AlertDialog` (409 → offer force). Sections: bound agents (bind/unbind, "create agent on this pool"), runtimes table (state, agent, controller, external id, attempts, last error, age), health card.
- Controllers list: name, kind, placement, status/presence, last error, secret key names (never values), create/edit (operator/user only; hide write actions for agents). The remote-controller "mint token" dialog needs step-10's route, so it lands in step-12, not here.
- Hidden routes redirect to `/settings` when the gate is closed.

#### 4. Agent binding
**File**: `apps/ui/src/components/shared/agent-runtime-settings.tsx`
**Changes**: a "Runtime pool" select (gated), calling `PUT /api/agents/{id}/runtime-pool`, showing the pool's delivery mode and lifecycle.

#### 5. Live updates
**File**: hooks above
**Changes**: poll the runtimes query every 5 s while the pool detail page is open (no new realtime channel in v1).

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` pass
- [x] `bun run test:root -- src/tests/runtime-provider-registration.test.ts` passes (UI kind list registered)
- [x] UI E2E smoke if the suite covers settings pages: `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [x] `agent-browser` against `bun run dev:http` + the UI dev server with `RUNTIME_POOLS_ENABLED=true`: create a docker pool, edit it, bind an agent from the agent page, create an agent on the pool, view the runtimes table (seed one runtime row via the API or a step-5 run), delete the pool with force. Screenshots of list, detail, controllers, agent binding; one recording of the create → bind → delete flow.
- [x] With the flag off: no nav item, direct URL redirects. With an API version below the gate (stub `/health` version): surface hidden.
- [x] Upload screenshots and the recording with the `github-attach` skill for the PR's `## Before / after` section.

#### Manual Verification:
- [ ] Taras reviews the pages visually (layout, copy, BETA chip placement).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit after verification passes: `[step-11] dashboard UI for pools`.
