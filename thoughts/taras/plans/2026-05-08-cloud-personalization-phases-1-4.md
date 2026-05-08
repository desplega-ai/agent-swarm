---
date: 2026-05-08T00:00:00Z
topic: "Cloud Personalization & Onboarding — Phases 1–4"
author: taras
status: in-progress
last_updated: 2026-05-08T00:00:00Z
last_updated_by: claude (phase 4 — per-user UX persistence via localStorage)
related:
  - thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md
  - thoughts/taras/research/2026-05-07-cloud-personalization-research.md
---

# Cloud Personalization & Onboarding — Phases 1–4 Implementation Plan

## Overview

Make agent-swarm feel like *your* deployment from the moment a user opens it. A new `GET /status` endpoint exposes identity + setup readiness + activity; a unified home page consumes it; a persistent health badge and cloud-aware affordances make state always-visible; smart empty states recommend templates from detected integrations; per-browser dismissibility persists UI state. Four shippable, separately-verifiable phases.

- **Motivation**: Cloud and self-hosted swarms today land on a generic dashboard. We need a single status contract the UI can lean on (server-driven), one home page that adapts to identity envs and live setup state, awareness primitives across the chrome, and per-user dismissibility — without inventing a server-side account model.
- **Related**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md`
  - Research: `thoughts/taras/research/2026-05-07-cloud-personalization-research.md`
  - Constraints: `CLAUDE.md` (DB-boundary, route() factory, OpenAPI freshness, ui/ stack), `runbooks/local-development.md`, `runbooks/ci.md`

## Decisions Resolved (autopilot)

These resolve the seven open questions surfaced in research/brainstorm. Rationale lives next to each so a reviewer can challenge per item.

1. **First-task milestone definition** — *Verified when there is ≥1 row in `agent_tasks` with `status = 'completed'`.*
   - **Rationale**: Brainstorm says "first task is binary" and the milestone label is "first task / template." Saving a workflow without running it isn't proof of value; a `completed` task is. Workflow runs (table: `workflow_runs`) are a future expansion if we want to count those too — kept out of MVP to avoid coupling to workflow internals.
   - **State machine**: only `unverified | verified` for this milestone (no `configured` — there is no "you can see how to issue a task" state distinct from worker readiness, which lives on the workers milestone). The shared `state` schema accepts all three values but this milestone never emits `configured`.
   - **Hint** (when `unverified`): "Issue your first task on the Tasks page, or kick off a workflow run."

2. **Stale Linear/Jira tokens** — *Option (c): accept "row exists in `oauth_tokens`" as `verified` with a documented caveat in the `hint` field.*
   - **Rationale**: Option (a) costs a migration purely for a UX nicety; option (b) requires a brittle log-reader. Today's keepalive (`src/oauth/keepalive.ts:16-20, 39-53`) already Slack-alerts on refresh failures, so operators have a real signal. We document the gap in `hint` and park option (a) as a follow-up if support tickets prove it warranted.
   - **Hint** (always emitted on Linear/Jira when `verified`): "Token row present; refresh-failure tracking will land in a future migration — check #swarm-alerts for keepalive errors."

3. **Home placement** — *`/` becomes `HomePage`. Demote existing `DashboardPage` to `/dashboard` and keep it as a power-user landing.*
   - **Rationale**: Brainstorm: "MVP is Phase 1 — /status API + home UI shipped together." Home is canonical. Existing `DashboardPage` (`ui/src/pages/dashboard/page.tsx`) stays one click away; sidebar gets a "Dashboard" item alongside "Home." No deep-links break because `/` continues to land somewhere sensible.
   - **Sidebar** (`ui/src/components/layout/app-sidebar.tsx:37-80`): "Home" inserted as the first item in the first nav group; "Dashboard" follows it.

4. **Identity overrides via `swarm_config`** — *Orchestrator-only for MVP (no `/config` UI to edit identity).*
   - **Rationale**: Brainstorm: "Identity is env-driven … orchestrator catches up after." Allowing admin override creates a write-then-stale-on-restart problem because `loadGlobalConfigsAndIntegrations` (`src/http/core.ts:148-163`) merges `swarm_config` into `process.env` only at boot/reload. We document that an admin *can* INSERT into `swarm_config` directly + call `POST /internal/reload-config`, but no UI exposes this in MVP. Park UI override.

5. **Phase 2 health-badge polling cadence** — *30 seconds.*
   - **Rationale**: `/status` is cheap (single SQL aggregate + env reads). 30s is the standard "always-on awareness" cadence: short enough that env-driven changes appear within a window, long enough that we're not pounding a single-tenant deployment. Implemented via `setInterval` in a top-level hook; pause when document is hidden (Page Visibility API).

6. **Phase 3 recommendation mapping** — *Confirm the original three plus a no-integration fallback. Mapping lives in `ui/src/lib/template-recommendations.ts`.*
   - Mappings (priority order):
     - `slack + github` → `pr-triage`
     - `linear + github` → `issue-to-pr`
     - `jira` → `bug-intake`
     - (fallback, none of the above) → `hello-world`
   - **Rationale**: Brainstorm asked us to confirm. Three explicit mappings cover the largest user shapes; the fallback prevents a literally-empty empty state. Slack-alone or GitHub-alone deliberately fall through to `hello-world` — promoting a template that requires the *other* integration is a usability trap. We can add finer-grained mappings as templates land in the registry.
   - **Verification source-of-truth**: `templates/` directory must contain matching template `id` values (or we ship a stub for `hello-world` if missing). The mapping module has a typed `TemplateId` union and a unit test that asserts every value resolves to an existing template.

7. **Phase 4 localStorage namespacing** — *Confirmed: scope by `apiUrl` from `useConfig()`.*
   - **Rationale**: The same UI bundle can be pointed at multiple swarm deployments via `?apiUrl=…` URL params (`ui/src/api/client.ts:121-127`). Without namespacing, dismissing the welcome card on swarm A would dismiss it on swarm B. Key format: `swarm:v1:${apiUrl}:${cardKey}`. The `v1` segment lets us bump format later. Hash the `apiUrl` only if browsers complain about long keys; for now we leave it readable for debugging.

## Current State Analysis

**Server (API-server-owned, `src/`):**
- `route()` factory at `src/http/route-def.ts:84-142` — required for all new routes; pushes to `routeRegistry`, validates Zod schemas, returns 400 on parse error. Existing minimal example: `src/http/api-keys.ts:80-96`.
- Hard-coded `GET /health` at `src/http/core.ts:100-113` returns `{status, version}` and is consumed by docker healthchecks — **must not change**.
- `loadGlobalConfigsAndIntegrations` (`src/http/core.ts:24-26, 148-163`) merges `swarm_config` table into `process.env` at boot and on `POST /internal/reload-config`.
- `HARNESS_PROVIDER` read at `src/commands/runner.ts:251, 563, 1349, 2299-2300, 2549`. Slack envs at `src/slack/app.ts:20-39`. GitHub envs at `src/github/app.ts:9-17, 42-64`.
- `ProviderAdapter` interface at `src/providers/types.ts:107-113` — has **no** health-check method today; `checkProviderCredentials` (`src/providers/credentials.ts:51-74`) is env-only and zero-network.
- Canonical providers at `src/types.ts:77-85`: claude, codex, pi, devin, claude-managed, opencode.
- `oauth_apps` + `oauth_tokens` tables: `src/be/migrations/009_tracker_integration.sql:11-23, 26-36`. Storage: `src/oauth/wrapper.ts:141-146`. Refresh: `src/oauth/wrapper.ts:160-204`. Linear/Jira keepalive: `src/oauth/keepalive.ts:16-20, 39-53`. Jira cloudId in `oauth_apps.metadata`: `src/jira/oauth.ts:65-91`.
- `agent_fs` "configured" probe: `src/prompts/base-prompt.ts:189` checks `process.env.AGENT_FS_API_URL`. No DB table, no helper.
- Last migration is `053_agent_waiting_for_credentials_status.sql` (`src/be/migrations/053_*`); **next number is 054** if any phase adds a migration.
- `src/be/db.ts:699-705` — `updateAgentActivity` writes `lastActivityAt` via `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. `src/be/db.ts:5368-5381` is the closest existing helper (`getIdleWorkersWithCapacity`) but does NOT consult `lastActivityAt`. Heartbeat throttle: `src/providers/swarm-events-shared.ts:48-49` (`ACTIVITY_THROTTLE_MS = 5_000`).
- `scripts/generate-openapi.ts:3-32` is where new route modules must be imported.

**UI (`ui/`, React + Vite + react-router-dom — NOT Next.js):**
- Root route: `ui/src/app/router.tsx:45` mounts `<DashboardPage />` at `/`.
- App shell: `ui/src/components/layout/root-layout.tsx` (`ConfigGuard`, `Sidebar`, `AppHeader`, `Suspense`).
- Sidebar nav: `ui/src/components/layout/app-sidebar.tsx:37-80` (`navGroups` array).
- Existing dashboard hooks (reusable on home): `ui/src/pages/dashboard/page.tsx:22-26` (`useStats`, `useHealth`, `useAgents`, `useTasks`, `useDashboardCosts`).
- Empty-state pattern: `ui/src/pages/integrations/page.tsx:49-61`.
- Reusable primitives: `ui/src/components/shared/empty-state.tsx` (`EmptyState`), `ui/src/components/shared/oauth-section.tsx` (`OAuthSection`, `OAuthStatusRow`, `OAuthSectionRow`), `ui/src/components/ui/page-header.tsx` (`PageHeader`).
- Integration catalog + status helpers: `ui/src/lib/integrations-catalog.ts` (slack:72, github:160, linear:318, jira:360, anthropic:482, openrouter:517, openai:541, claude-managed:578); `ui/src/lib/integrations-status.ts` (`deriveIntegrationStatus`, `findConfigForKey`).
- Runtime config (no `NEXT_PUBLIC_*`): `ui/src/api/client.ts:121-127, 308-318` (`useConfig`, `checkHealth`); api/key flow via `?apiUrl=…&apiKey=…` URL params.

**Constraints from CLAUDE.md:**
- API server is sole DB owner; `/status` lives in `src/http/`. Worker code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`) must not import `src/be/db` or `bun:sqlite`.
- All new routes use `route()`; OpenAPI must be regenerated and committed.
- Migrations are forward-only.
- Use Bun (`Bun.serve`, `bun:sqlite`, `Bun.file`, `Bun.$`); no dotenv.
- Frontend PRs require qa-use sessions with screenshots per merge-gate.

## Desired End State

After Phase 4:
- `GET /status` returns identity + 7 setup milestones + activity + agent_fs + (Phase 2-added) health, validated by Zod, registered in `openapi.json`.
- `/` renders the new `HomePage`; `/dashboard` renders the legacy `DashboardPage`. Sidebar lists both.
- `AppHeader` shows a persistent health badge polling `/status` every 30s (paused when tab hidden); click navigates to home setup section.
- Cloud-aware affordances: `is_cloud === true` shows user-menu items for docs/support/billing; otherwise (and `SWARM_HIDE_CLOUD_PROMO` unset) a footer marketing link uses `marketing_url`.
- Empty states across `/templates`, `/tasks`, `/workflows` consult detected integrations and surface ranked starter templates.
- Welcome card, per-milestone collapse, and "tour-completed" setup-section collapse persist in `localStorage` namespaced by deployment URL.

## What We're NOT Doing

Parked from brainstorm — explicitly out of scope for this plan:
- Per-run "files touched" agent-fs panel (needs task-side instrumentation).
- Onboarding telemetry.
- "Connect from CLI" deep-link.
- Server-side per-user state (would need an account model).
- Slack Socket Mode connection state in the verified column (Phase 2+ enhancement).
- GitHub App installation health beyond JIT validation.
- A migration for Linear/Jira `last_refresh_error_at` (decision 2 = option (c)).
- Admin UI for editing identity via `/config` (decision 4).
- File browser, attachments UI, agent-fs upload (only the home-card link).

## Implementation Approach

- One server contract (`/status`) shared by all four phases — define it once with a shared Zod schema in Phase 1, extend in Phase 2 only via additive fields (`health`).
- All four phases touch `ui/`; each ends with a qa-use session per the merge-gate rule.
- Setup checks are cheap and side-effect-free in the GET response. Live-test calls happen only via an explicit `POST /status/test-connection?provider=…` button (Phase 1).
- Identity envs are read on every `/status` request; orchestrator can inject envs via the standard env mechanism.
- Phase ordering: 1 (foundation) → 2 (always-on chrome) → 3 (smart empty states; depends on Phase 1 setup state) → 4 (UX polish; depends on Phase 1 home + Phase 2 affordances).
- Migration count gate: only Phase 1 may add a migration if needed (currently we believe none is needed — decision 2 lands on option (c)). Phases 2–4 are migration-free.

## Quick Verification Reference

Run from repo root unless noted.

| Command | When |
|---|---|
| `bun run tsc:check` | Every phase |
| `bun run lint` | Every phase (note: `lint`, not `lint:fix` — CI runs read-only) |
| `bun test` | Every phase (`bun test src/tests/<file>.test.ts` for one file) |
| `bun run docs:openapi` | Phase 1 + Phase 3 (any phase that adds/changes routes) |
| `bash scripts/check-db-boundary.sh` | Every phase that touches `src/be/db.ts` or `src/http/` |
| `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b` | Every phase touching `ui/` |
| `bun run start:http` then `curl http://localhost:3013/status -H "Authorization: Bearer 123123"` | Every phase touching `/status` |
| qa-use session with screenshots | Every phase touching `ui/` (merge-gate requirement) |

---

## Phase 1: Status API + Home UI (MVP foundation)

### Overview

Ship `GET /status` (identity + setup + activity + agent_fs) plus `POST /status/test-connection` (provider live-call), and the new `HomePage` that consumes them. End state: a fresh-DB swarm shows the user "here's what's configured, here's what's missing, here's how to fix it."

### Changes Required:

#### 1. Status route module
**File**: `src/http/status.ts` (new)
**Changes**: New module exporting two `route()` registrations:
  - `GET /status` (no body, returns the full status payload).
  - `POST /status/test-connection` (body: `{ provider: ProviderName }`; returns `{ ok: boolean, error?: string, latency_ms: number }`).
- Identity block reads `SWARM_CLOUD`, `SWARM_ORG_NAME`, `SWARM_ORG_LOGO_URL`, `SWARM_BRAND_COLOR`, `SWARM_MARKETING_URL`, `SWARM_HIDE_CLOUD_PROMO` from `process.env`. Defaults: name="Swarm", logo_url=null (UI falls back to bundled), brand_color=null, is_cloud=false, marketing_url=null.
- Setup block emits 7 milestones in this order: `harness`, `slack`, `github`, `linear`, `jira`, `workers`, `first_task`. Each `{ id, label, state, hint?, action_url? }` per the verification matrix below.
- Activity block calls `getInstanceActivity()` (new helper) for `agents_online`, `leads_online`, `recent_tasks_count`.
- agent_fs block: `{ configured: !!process.env.AGENT_FS_API_URL, base_url: process.env.AGENT_FS_API_URL ?? null }`.
- Use Zod schemas (export them so the UI can import via `openapi-typescript`-generated types or a shared types file).

#### 2. Verification matrix (encoded in `status.ts`)
**File**: `src/http/status.ts`

| Milestone | `configured` rule | `verified` rule | Hint when not verified |
|---|---|---|---|
| `harness` | `HARNESS_PROVIDER` set AND that provider's cred env present (delegate to `checkProviderCredentials`) | `verified_at` cached after a successful "Test connection" click in the last N (configurable via `SWARM_VERIFY_TTL_MS`, default 1h); cache lives in-memory, lost on restart | "Click *Test connection* to verify credentials." Action URL: `/integrations#harness` |
| `slack` | `SLACK_BOT_TOKEN` AND `SLACK_APP_TOKEN` present AND `!SLACK_DISABLE` | Same as configured (Socket Mode connection state not exposed today; documented Phase 2+ enhancement) | Action URL: `/integrations#slack` |
| `github` | `GITHUB_WEBHOOK_SECRET` AND `GITHUB_APP_ID` AND `GITHUB_APP_PRIVATE_KEY` present | Same as configured (App installations validated JIT) | Action URL: `/integrations#github` |
| `linear` | row in `oauth_tokens(provider='linear')` | Same as configured + hint about keepalive caveat (decision 2 = option (c)) | Action URL: `/integrations#linear` |
| `jira` | row in `oauth_tokens(provider='jira')` AND `oauth_apps.metadata.cloudId` set | Same as configured + same caveat | Action URL: `/integrations#jira` |
| `workers` | ≥1 row in `agents` | ≥1 lead with recent activity AND ≥1 worker with recent activity (helper below) | "Start a worker via PM2 (`bun run pm2-start`) or Docker compose." Action URL: `/agents` |
| `first_task` | (omitted — only emits `unverified | verified`) | ≥1 row in `agent_tasks` with `status = 'completed'` | "Issue your first task." Action URL: `/tasks` |

#### 3. DB helper for live agents
**File**: `src/be/db.ts`
**Changes**: Add `getLiveAgentCounts(minutes: number = 5): { leads_alive: number; workers_alive: number }` using:
```sql
SELECT
  SUM(CASE WHEN isLead = 1 THEN 1 ELSE 0 END) AS leads_alive,
  SUM(CASE WHEN isLead = 0 THEN 1 ELSE 0 END) AS workers_alive
FROM agents
WHERE lastActivityAt IS NOT NULL
  AND lastActivityAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' minutes')
  AND status != 'offline';
```
- N picked at **5 minutes** (matches a multiple of `ACTIVITY_THROTTLE_MS = 5_000` plus margin for missed heartbeats).
- Add `getInstanceActivity(): { agents_online, leads_online, recent_tasks_count }` calling the above + a `SELECT COUNT(*) FROM agent_tasks WHERE createdAt >= datetime('now','-24 hours')`.
- Add `hasFirstCompletedTask(): boolean` (`SELECT 1 FROM agent_tasks WHERE status='completed' LIMIT 1`).

#### 4. Provider live-test dispatcher
**File**: `src/providers/credentials.ts`
**Changes**: Add `validateProviderCredentials(provider: ProviderName): Promise<{ ok: boolean; error?: string; latency_ms: number }>`. Mirrors the shape of `checkProviderCredentials` but issues the cheapest live call per provider:
- `claude` → `GET https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`.
- `codex` → `GET https://api.openai.com/v1/models` with `Authorization: Bearer …`.
- `pi` / `opencode` → resolved per `MODEL_OVERRIDE` (or model prefix) per `pi-mono-adapter.ts:60-64` and `opencode-adapter.ts:35-45`.
- `devin` → `GET ${baseUrl()}/v3/organizations/${orgId}/sessions`.
- `claude-managed` → Anthropic `GET /v1/models` + managed-agents SDK probe for `MANAGED_AGENT_ID`.
- 5-second timeout per call (AbortController). Pure function — does NOT touch DB. Returns `{ok: true, latency_ms}` on 2xx, `{ok: false, error: <sanitized>, latency_ms}` otherwise. Errors run through `scrubSecrets` before return.
- Reason for parallel dispatcher (vs. adding `validate()` to `ProviderAdapter`): adapters are runtime-loaded by workers; this dispatcher lives next to `checkProviderCredentials` and is API-server-safe.

#### 5. Test-connection cache (in-memory)
**File**: `src/http/status.ts`
**Changes**: A small `Map<ProviderName, { ok: boolean; verifiedAt: number }>` cleared on restart; `POST /status/test-connection` updates the entry on success; `GET /status` reads it and emits `harness.state = 'verified'` if `verifiedAt + (SWARM_VERIFY_TTL_MS ?? 3600_000) > Date.now()` and `ok === true`. Otherwise `configured`.

#### 6. OpenAPI registration
**File**: `scripts/generate-openapi.ts`
**Changes**: Add `import './src/http/status'` (alphabetical position in the existing import list). Run `bun run docs:openapi` and commit the regenerated `openapi.json` and `docs-site/content/docs/api-reference/**`.

#### 7. UI — types and API client
**File**: `ui/src/api/types.ts` (or wherever Zod-mirror types live; check existing pattern)
**Changes**: Add `StatusResponse`, `SetupMilestone`, `SetupMilestoneState = "configured" | "unverified" | "verified"`, `MilestoneId` enum.

**File**: `ui/src/api/client.ts`
**Changes**: Add `useStatus()` hook (TanStack-query if that's the project's stack — match `useHealth` precedent at `:308-318`). Polling left at default; Phase 2 turns on the 30s interval.

#### 8. UI — HomePage
**File**: `ui/src/pages/home/page.tsx` (new)
**Changes**: New page composing:
  - `PageHeader` with org identity from `useStatus()` (logo, name, brand color accent).
  - "Setup checklist" section: 7 rows using `OAuthSectionRow` / `EmptyState` styling. Each row shows label, state pill, hint (if present), and an action button that navigates via `useNavigate(action_url)`.
  - "Activity" section: 3 stat cards (`agents_online`, `leads_online`, `recent_tasks_count`).
  - "First steps" placeholder block (Phase 3 fills it with the recommended template).
  - "Storage" placeholder (Phase 2 fills it with the agent-fs card).
- Defaults gracefully when identity envs unset (`name = "Swarm"`, bundled logo at `ui/src/assets/logo.svg`).

#### 9. UI — Router move
**File**: `ui/src/app/router.tsx`
**Changes**: At line 45, swap `<DashboardPage />` → `<HomePage />`. Add a sibling route `/dashboard` → `<DashboardPage />`. Lazy-load both via existing pattern.

**File**: `ui/src/components/layout/app-sidebar.tsx`
**Changes**: At `:37-80`, in the first nav group, prepend a "Home" item (`/`); keep "Dashboard" (`/dashboard`) as the second item.

#### 10. Test-connection button
**File**: `ui/src/pages/home/page.tsx` (or extracted component)
**Changes**: When `harness` row state is `configured` (not yet `verified`), show a "Test connection" button that POSTs to `/status/test-connection?provider=<harness>` and re-fetches `/status` on success. Toast on failure with sanitized error.

#### 11. Tests
**File**: `src/tests/status.test.ts` (new)
**Changes**: Unit tests for:
  - Identity defaults vs. all-envs-set.
  - Each milestone's state transitions across env permutations (Slack: bot+app+!disable; GitHub: webhook+id+key; Linear/Jira: row presence).
  - `getLiveAgentCounts` returns 0/0 on empty DB; correctly counts when rows are inserted with recent/old `lastActivityAt`.
  - `hasFirstCompletedTask` flips on first `status='completed'` insert.
  - `POST /status/test-connection` returns `ok:false` with sanitized error on 401 from upstream (mocked `fetch`).
  - `GET /status` reflects the cached `harness.verified` after a successful test-connection.

**File**: `ui/src/pages/home/page.test.tsx` (new, follow existing UI test pattern if present)
**Changes**: Render with mocked `useStatus` data — assert all 7 rows present, action URLs wired correctly.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] All tests pass: `bun test`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI regenerated and committed cleanly: `bun run docs:openapi` (no `git diff` after running)
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] New `/status` test file passes: `bun test src/tests/status.test.ts`
- [x] Existing `/health` is byte-identical: `curl -s http://localhost:3013/health` returns `{"status":"ok","version":"<pkg-version>"}` (regression). _(Verified by static inspection: `src/http/core.ts:100-113` is unchanged.)_
- [x] Vite dev proxy: `ui/vite.config.ts` proxies `/status` to the API. _(Caught during manual QA — root-level routes need explicit proxy entries; fixed by adding alongside the existing `/health` proxy.)_

#### Automated QA:
- [ ] qa-use session: open `/` on a fresh-DB swarm with no envs set; screenshot the empty-state checklist; click each "Set up X" deep-link; confirm router lands on `/integrations`, `/agents`, `/tasks`, `/templates` respectively (and `/integrations#<id>` anchors hit the right section).
- [ ] qa-use session: with `HARNESS_PROVIDER=claude` + `ANTHROPIC_API_KEY` set, click "Test connection" → confirm `harness` row flips to `verified` and badge color matches.
- [ ] qa-use session: with `SWARM_ORG_NAME="Acme"` + `SWARM_ORG_LOGO_URL=…` + `SWARM_BRAND_COLOR=#ff5500`, screenshot the page header — confirm name, logo, accent color all render.
- [ ] curl walkthrough captured in a script (`scripts/manual-status-walkthrough.sh`): runs `/status` with all envs unset, then with each setup permutation; asserts state transitions match the verification matrix.

#### Manual Verification:
- [ ] On a real Linear-connected swarm, the Linear milestone shows `verified` after a successful keepalive cycle; the documented caveat hint is visible.
- [ ] Test-connection latency shown in the toast feels reasonable (<5s typical) for the user's harness provider.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 1.5: Harness provider scoping (added mid-implementation)

### Overview

Two follow-ups to Phase 1, scoped during the Phase 1 review with Taras:

- **A — Typed provider field on the harness milestone.** The Phase 1 implementation worked around the missing `provider` field by encoding `HARNESS_PROVIDER=<name>` into the milestone's `hint` string and parsing it in the UI with a regex. This is brittle; replace it with an explicit optional schema field.
- **B — Per-agent harness provider as a first-class column.** Add `agents.harness_provider TEXT NULL`, have workers push their provider on registration, and expose a `PATCH /agents/:id/harness-provider` endpoint so an operator can re-assign without restarting. Worker boot path is **not** rewritten in this phase — that's the bigger Linear ticket [DES-359](https://linear.app/desplega-labs/issue/DES-359/) (full per-agent harness with dynamic adapter loading + swarm_config-driven creds).

### Changes Required:

#### 1. `provider?` field on `SetupMilestoneSchema`
**File**: `src/http/status.ts`
**Changes**:
- Add `provider: ProviderNameSchema.optional()` to `SetupMilestoneSchema` (only the harness milestone populates it).
- In `harnessMilestone()`, set `provider` on the returned object whenever `process.env.HARNESS_PROVIDER` is a known canonical provider; leave undefined when missing/unknown.
- Strip the `HARNESS_PROVIDER=<name>` and `provider=<name>` substrings from milestone hints — hints become purely human copy.

#### 2. UI: drop the regex, read the field
**File**: `ui/src/api/hooks/use-status.ts`, `ui/src/pages/home/page.tsx`
**Changes**: Replace the regex extraction with `setup.find(m => m.id === "harness")?.provider`. Pass it to the test-connection mutation directly.

#### 3. Migration `054_agent_harness_provider.sql`
**File**: `src/be/migrations/054_agent_harness_provider.sql` (new)
**Changes**:
```sql
ALTER TABLE agents ADD COLUMN harness_provider TEXT NULL;
```
- Forward-only. NULL default = backward-compat for already-registered agents.

#### 4. Worker registration pushes `harness_provider`
**File**: `src/cli.tsx` worker register path (or wherever worker registration happens — likely `src/commands/agent-register.ts` or similar; locate during implementation), and the matching API handler (`src/http/agents.ts` or wherever the existing register/upsert endpoint lives).
**Changes**:
- Worker reads `process.env.HARNESS_PROVIDER` and includes it in the registration payload.
- API handler accepts the new optional field, validates against the canonical provider list (`src/types.ts:77-85`), and writes to the new column.
- Existing agents (no column value) stay valid.

#### 5. `PATCH /agents/:id/harness-provider` endpoint
**File**: `src/http/agents.ts` (or new `src/http/agent-harness.ts` if cleaner)
**Changes**: New `route()` registration; body `{ harness_provider: ProviderName }`; updates the column. **Worker does not react in real-time** — picked up on next worker restart. Document this limitation in the route summary.

#### 6. DB helpers
**File**: `src/be/db.ts`
**Changes**: Add `setAgentHarnessProvider(agentId: string, provider: ProviderName | null)` and `getAgentHarnessProviders(): { provider: string; count: number }[]` (used by future fleet displays; not consumed in this phase).

#### 7. OpenAPI registration
**File**: `scripts/generate-openapi.ts`
**Changes**: Ensure the new route module is imported (alphabetical position); run `bun run docs:openapi` and commit regenerated `openapi.json` + `docs-site/content/docs/api-reference/**`.

#### 8. Tests
**File**: `src/tests/status.test.ts`
**Changes**:
- Assert `harness.provider === "claude"` when `HARNESS_PROVIDER=claude` set; undefined when unset.
- Assert hints no longer contain `HARNESS_PROVIDER=` or `provider=` substrings.

**File**: `src/tests/agents-harness-provider.test.ts` (new)
**Changes**:
- Migration applies cleanly to a fresh + existing DB.
- Worker registration with `harness_provider` writes the column.
- `PATCH /agents/:id/harness-provider` updates the column.
- Invalid provider names rejected with 400.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] All tests pass: `bun test`
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI regenerated cleanly: `bun run docs:openapi`
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] Migration applies on a fresh DB and on an existing DB (`rm agent-swarm-db.sqlite && bun run start:http`; then with the previously-running DB).

#### Automated QA (deferred):
- [ ] Phase 1 qa-use sessions still pass after the regex removal.

#### Manual Verification:
- [ ] Restart a worker with `HARNESS_PROVIDER=claude` → confirm DB row gets the column populated.
- [ ] `curl -X PATCH /agents/<id>/harness-provider -d '{"harness_provider":"codex"}'` → row updates; restart worker → next boot writes back to `claude` (env wins on register, by design — the PATCH is a planning/forecast mechanism today, not a live override; that's DES-359).

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 1.6: Iteration & polish (added during manual QA)

### Overview

Bugs caught + UX requests landed during the Phase 1 walk-through with Taras. None of these were anticipated by the plan; they're recorded here so a future reader can trace the actual shipped behavior.

### Changes Required:

#### 1. Vite dev proxy
**File**: `ui/vite.config.ts`
**Changes**: `/status` was missing from the dev proxy (only `/api` and `/health` were proxied), so `useStatus()` hit Vite's SPA fallback and got HTML back. Added `/status` alongside `/health`.

#### 2. Home page redesign
**File**: `ui/src/pages/home/page.tsx`
**Changes**:
- Identity (logo + name) **moved to sidebar header** (`ui/src/components/layout/app-sidebar.tsx`) — frees vertical space and makes branding persistent across routes.
- Layout reorder: **Activity** (top) → **Setup checklist** → **First Steps + Storage** (2-col grid on `md+`).
- Made the page scrollable (`overflow-y-auto` on outer container) — was clipped before.
- Setup checklist restructured into **groups**: Harness row, "Integrations" sub-section (Slack + GitHub) with "All integrations →" + "Docs ↗" links, Workers row, First task row. Linear/Jira are no longer on home — discoverable via the All-integrations link.
- Per-state CTA copy: `Connect` (Slack/GitHub/Linear/Jira `unverified`), `Read docs` (workers `unverified`), `Create task` (first_task `unverified`), `View` (`verified`), `Set up` (harness `unverified`).
- agent-fs unconfigured CTA links to `https://agent-fs.dev`.
- Docs URL: `https://docs.agent-swarm.dev/docs`.

#### 3. Sidebar identity + 404 fallback
**File**: `ui/src/components/layout/app-sidebar.tsx`
**Changes**:
- Sidebar header reads `identity.name` / `identity.logo_url` / `identity.brand_color` from `/status`. Falls back to `"Agent Swarm"` + bundled `/logo.png` when status is unavailable.
- Added `onError` handler on the logo `<img>` — if the configured URL fails to load, reverts to `/logo.png`.
- When `/status` returns 404 (older API), the sidebar **hides the "Home" nav item** and the header NavLink points to `/dashboard` instead.

#### 4. Graceful 404 / error fallback
**File**: `ui/src/api/client.ts`, `ui/src/pages/home/page.tsx`
**Changes**:
- `fetchStatus()` returns `null` on HTTP 404 (older API server) instead of throwing. Other errors still throw.
- `HomePage` redirects to `/dashboard` via `<Navigate replace>` when `status === null` OR when the query errors. Older deployments degrade gracefully.

#### 5. Integration `action_url` paths
**File**: `src/http/status.ts`
**Changes**: Anchor-based URLs (`/integrations#slack`, etc.) didn't match the actual UI routes. Replaced with sub-routes (`/integrations/slack`, `/integrations/github`, `/integrations/linear`, `/integrations/jira`) — the routes that the IntegrationDetailPage at `/integrations/:id` actually serves. The harness milestone now points to `/integrations` (list page) since no single integration corresponds to a harness.

#### 6. Server hint copy
**File**: `src/http/status.ts`
**Changes**:
- Workers: "Run a worker container via Docker compose. See docs for setup." (was "Start a worker via PM2 (`bun run pm2-start`) or Docker compose.").
- First task: "Send your first task to confirm the swarm runs end-to-end." (was "Issue your first task on the Tasks page, or kick off a workflow run.").
- First-task `action_url` → `/tasks?new=true` so home links auto-open the create dialog.

#### 7. Tasks page auto-open dialog
**File**: `ui/src/pages/tasks/page.tsx`
**Changes**: Added a `useEffect` that reads `?new=true` from the URL on mount, opens the create-task dialog, and strips the param so refresh doesn't re-trigger.

#### 8. Credential validation rewrite — OAuth-aware, harness-consistent
**File**: `src/providers/credentials.ts`
**Changes**: The Phase 1 `validateProviderCredentials` only accepted API keys per harness, even though the runtime adapters accept OAuth tokens too (Claude Pro/Max via `claude` CLI login → `CLAUDE_CODE_OAUTH_TOKEN`; Codex ChatGPT OAuth → `CODEX_OAUTH`). Rewritten to mirror each adapter's actual credential resolution:

| Harness | Accepted credentials (resolution order) | Validation |
|---|---|---|
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` | OAuth: presence check. API key: live `GET /v1/models` (`x-api-key`). |
| `claude-managed` | `ANTHROPIC_API_KEY` only | Live `GET /v1/models`. |
| `codex` | `CODEX_OAUTH` (parseable JSON with `.access`) → `OPENAI_API_KEY` | OAuth: presence check. API key: live `GET /v1/models` (Bearer). |
| `pi` | `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` | Live call to matching `/v1/models`. |
| `opencode` | same as `pi` | Live call to matching `/v1/models`. |
| `devin` | `DEVIN_API_KEY` (+ optional `DEVIN_API_BASE_URL`) | Live `GET ${baseUrl}/v1/sessions?limit=1` (Bearer). |

OAuth tokens get a presence check rather than a real upstream call — OAuth flows have their own refresh logic (handled at adapter boot) and the OAuth-bearer-with-`/v1/models` contract isn't a stable public surface.

**File**: `src/tests/status.test.ts`
**Changes**: Added `CODEX_OAUTH` to the env-reset list, updated the existing "missing creds" test to assert both env names are mentioned, and added 5 new tests covering: claude OAuth presence check, claude OAuth wins over API key, codex valid OAuth presence check, codex malformed OAuth falls back to API key, opencode resolves OPENROUTER first.

#### 9. Harness column on `/agents`
**File**: `ui/src/pages/agents/page.tsx`, `ui/src/api/types.ts`
**Changes**: Added `harnessProvider?: ProviderName | null` to the UI `Agent` type. New "Harness" column on the agents grid between Role and Status — renders the provider as an outline badge when present, em-dash placeholder when null/missing (legacy rows from before migration 054).

#### 10. Docs page
**File**: `docs-site/content/docs/(documentation)/guides/personalization.mdx` (new), `docs-site/content/docs/(documentation)/guides/meta.json` (added to sidebar)
**Changes**: New guide documenting all `SWARM_*` envs, the `/status` schema, the test-connection credential matrix, and the per-agent `harness_provider` mechanic (with DES-359 link). Also describes the `/status` 404 fallback behavior so operators understand graceful degradation.

#### 11. Demo seed script
**File**: `scripts/seed-demo-agents.ts` (new)
**Changes**: Creates 5 dummy agents covering all 4 statuses (`idle`, `busy`, `offline`, `waiting_for_credentials`) plus lead/worker mix and varied `harness_provider`. Uses the API for registration + credential-status; uses `bun:sqlite` directly to set non-default `status` and `lastActivityAt` (admin-only seed, not runtime code — DB-boundary rule unchanged).

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] All tests pass: `bun test` (3559 / 3559 — +5 OAuth-path tests vs Phase 1.5)
- [x] DB-boundary check passes: `bash scripts/check-db-boundary.sh`
- [x] OpenAPI regenerated: `bun run docs:openapi`
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`

#### Manual Verification:
- [x] Vite proxy fix verified by reload (was returning HTML doctype, now JSON).
- [x] Edge-case identity envs tested live: long org name truncates in sidebar; remote logo URL loads; brand color tints the name.
- [x] Seed script tested: `/status` reports `workers=verified`, `leads_online=1`, `agents_online=4`.
- [ ] OAuth-only test-connection (no `ANTHROPIC_API_KEY`, only `CLAUDE_CODE_OAUTH_TOKEN`) — flips harness milestone to verified without an upstream call.
- [ ] Phase 1 qa-use sessions still pass after the home redesign.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 2: Always-On Awareness + Cloud-Aware Affordances

### Overview

Make `/status` health visible everywhere via a persistent header badge that polls every 30s, expose cloud-vs-self-host affordances (user-menu items or footer marketing link), and surface the agent-fs storage card on home. Server change is additive: a `health` aggregate field on `/status`.

### Dependencies on Phase 1
- `/status` exists and emits the 7 milestones.
- `HomePage` exists (`/`); the agent-fs card slots into its "Storage" placeholder.

### Changes Required:

#### 1. `health` aggregate on `/status`
**File**: `src/http/status.ts`
**Changes**: Compute `health: "ok" | "degraded" | "broken"` after assembling milestones:
- `broken` if `harness.state !== 'verified'` AND `harness.state !== 'configured'` (i.e. `unverified` — meaning creds missing) **OR** `workers.state === 'unverified'` (no live workers ever).
- `degraded` if any of {linear, jira, slack, github} is `unverified`/`configured` while at least one is configured, OR `harness.state === 'configured'` (creds present but never tested).
- `ok` if all critical (`harness`, `workers`) are `verified` and no integration is in `configured` state without being `verified`.
- Add to Zod response schema. Bump nothing in OpenAPI semantics — this is additive.

#### 2. UI — useStatus polling
**File**: `ui/src/api/client.ts`
**Changes**: `useStatus()` accepts a `pollIntervalMs` option (default `30_000`). Use the Page Visibility API: pause when `document.hidden`, resume on `visibilitychange`. Store the latest snapshot in a context (`StatusContext`) so multiple consumers don't trigger duplicate fetches.

**File**: `ui/src/components/layout/root-layout.tsx`
**Changes**: Wrap the layout in a `<StatusProvider pollIntervalMs={30000}>`.

#### 3. Health badge in AppHeader
**File**: `ui/src/components/layout/app-header.tsx` (path inferred — verify in implementation)
**Changes**: Persistent green/yellow/red dot keyed off `health` from `StatusContext`. Click → `useNavigate('/#setup')` (anchor scrolls home page setup section into view). Tooltip: `health === 'ok'` → "All systems go", `degraded` → "Some integrations need attention", `broken` → "Setup required". Accessible: `role="status"` with `aria-label`.

#### 4. Cloud-aware nav items
**File**: `ui/src/components/layout/user-menu.tsx` (path inferred — locate the existing user-menu component)
**Changes**: When `identity.is_cloud === true`, append menu items: "Documentation" (target `https://swarm.desplega.ai/docs` — placeholder; configurable), "Support" (mailto or chat link — placeholder), "Billing" (link). When `false` and `SWARM_HIDE_CLOUD_PROMO` is unset (read via `identity` block), no user-menu additions; rendering happens in footer instead.

**File**: `ui/src/components/layout/app-footer.tsx` (new if missing)
**Changes**: Render a subtle marketing link "Don't want to self-host? Try hosted swarm →" → `identity.marketing_url` when:
- `identity.is_cloud === false` AND
- `identity.marketing_url` is present AND
- `SWARM_HIDE_CLOUD_PROMO` env is unset.
- Footer must be reachable but not aggressive — small, low-contrast, dismissible (Phase 4 wires the dismiss).

#### 5. agent-fs home card
**File**: `ui/src/pages/home/page.tsx`
**Changes**: Replace Phase 1's "Storage" placeholder with an `AgentFsCard` that reads `agent_fs` from `useStatus()`:
- Configured: "Storage: agent-fs configured ✓ → Open" — clicking opens `agent_fs.base_url` in a new tab.
- Not configured: "Storage: not configured → Set up" — clicking links to the agent-fs setup docs (URL placeholder; configurable via `SWARM_AGENT_FS_DOCS_URL` or hardcoded fallback).

#### 6. Tests
**File**: `src/tests/status.test.ts`
**Changes**: Extend with cases for all three `health` states (all-verified, partial-configured, harness-missing).

**File**: `ui/src/components/layout/app-header.test.tsx` (new)
**Changes**: Render header with mocked `StatusContext` for each `health` value; assert badge color and tooltip text.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] All tests pass: `bun test` (3566 / 3566 — +7 health rollup tests)
- [x] OpenAPI regenerated (additive `health` field) and committed: `bun run docs:openapi`
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] `/status` returns `health` ∈ {ok, degraded, broken} validated by unit tests covering all three states.

#### Automated QA:
- [ ] qa-use session: header health badge — green when all milestones verified, yellow when ≥1 unverified non-critical, red when harness or workers are missing; click navigates to `/#setup`.
- [ ] qa-use session: `SWARM_CLOUD=true` → user-menu shows Docs/Support/Billing; footer marketing link absent.
- [ ] qa-use session: `SWARM_CLOUD` unset, `SWARM_MARKETING_URL=https://swarm.desplega.ai`, `SWARM_HIDE_CLOUD_PROMO` unset → footer marketing link present, opens in new tab.
- [ ] qa-use session: `SWARM_HIDE_CLOUD_PROMO=true` → footer marketing link absent regardless of `is_cloud`.
- [ ] qa-use session: home agent-fs card — shows ✓ + Open when `AGENT_FS_API_URL` set, "Set up" CTA otherwise; "Open" actually navigates.
- [ ] Polling: open the home page; after 30s, network-tab shows a second `/status` request; navigate away (tab hidden) and confirm requests pause; return to tab and confirm they resume.

#### Manual Verification:
- [ ] Badge color updates within 30s after env-driven state change without page reload.
- [ ] Marketing link styling reads "subtle, OSS-tasteful" — not pushy.

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Phase 3: Smart Empty States & Template Recommendations

### Overview

Empty states across `/templates`, `/tasks`, `/workflows` recommend specific starter templates based on detected integrations from `/status`. Mapping is hardcoded in `ui/src/lib/template-recommendations.ts`. The home page "First steps" placeholder fills with the top recommendation.

### Dependencies on Phase 1+2
- `/status` setup state (Phase 1).
- `StatusContext` for cheap consumption (Phase 2).

### Changes Required:

#### 1. Recommendation mapping
**File**: `ui/src/lib/template-recommendations.ts` (new)
**Changes**:
```typescript
type DetectedIntegration = "slack" | "github" | "linear" | "jira";
type TemplateId = "pr-triage" | "issue-to-pr" | "bug-intake" | "hello-world";

export interface Recommendation { templateId: TemplateId; reason: string; }

// Priority order: first match wins.
const RULES: Array<{ requires: DetectedIntegration[]; templateId: TemplateId; reason: string }> = [
  { requires: ["slack", "github"], templateId: "pr-triage",
    reason: "You have Slack + GitHub — start with PR triage." },
  { requires: ["linear", "github"], templateId: "issue-to-pr",
    reason: "You have Linear + GitHub — start with the Issue → PR template." },
  { requires: ["jira"], templateId: "bug-intake",
    reason: "You have Jira — start with the Bug intake template." },
];

export function recommendTemplates(detected: Set<DetectedIntegration>): Recommendation[] {
  const matches = RULES.filter(r => r.requires.every(i => detected.has(i))).map(r => ({ templateId: r.templateId, reason: r.reason }));
  if (matches.length === 0) return [{ templateId: "hello-world", reason: "Start with a no-integration Hello World." }];
  return matches;
}
```
- Export `TemplateId` for typed consumption. Unit tests live next to it.

#### 2. Detected-integrations selector
**File**: `ui/src/lib/template-recommendations.ts` (same module)
**Changes**: Add `detectedFromStatus(status: StatusResponse): Set<DetectedIntegration>` — returns the subset of `{slack, github, linear, jira}` whose milestone state is `verified` OR `configured`.

#### 3. Empty-state upgrades
**File**: `ui/src/pages/templates/page.tsx`
**Changes**: When the templates list is empty (or as a "Featured" banner if non-empty), call `recommendTemplates` with `detectedFromStatus(useStatus())` and render the top result via the existing `EmptyState` primitive. Clicking lands on `/templates/<id>` (existing route).

**File**: `ui/src/pages/tasks/page.tsx`
**Changes**: Same idea — surface "Try this template to get going" in the empty state.

**File**: `ui/src/pages/workflows/page.tsx`
**Changes**: Same.

#### 4. Home "First steps" section
**File**: `ui/src/pages/home/page.tsx`
**Changes**: Replace Phase 1's "First steps" placeholder with a section that:
- Shows the top recommendation as a primary CTA card ("Start with **PR triage** — you have Slack + GitHub").
- Wires the `first_task` milestone's action URL through this CTA when state is `unverified`.
- When state is `verified` (user has completed a task), the section collapses to a small "Recommended templates" link to `/templates`.

#### 5. Template existence sanity test
**File**: `ui/src/lib/template-recommendations.test.ts` (new)
**Changes**:
- Unit tests for the four mappings + fallback.
- A "templates exist" sanity test: enumerate `TemplateId` values, assert each one resolves to a record in the templates registry (`templates/`). If `hello-world` is missing, ship a stub or pick a real default.

#### 6. (Server, only if needed) Templates recommended endpoint
**File**: `src/http/templates.ts` (likely already exists — extend; if not, new file)
**Changes**: **Skip unless required.** Per the brainstorm and research, the mapping is hardcoded and small enough to live UI-side. Only add `GET /api/templates/recommended` if a real reason emerges during implementation (e.g. server-side template ranking driven by data we don't want to ship to the browser). If added, also update `scripts/generate-openapi.ts` and run `bun run docs:openapi`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint`
- [x] All tests pass: `bun test` (3586 / 3586 — +20 template-recommendation tests vs Phase 2)
- [x] OpenAPI regenerated **only if** an endpoint was added: `bun run docs:openapi` _(Phase 3 added no endpoint; regen still ran clean — picked up a Phase 2 drift to `health` field, committed alongside.)_
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] Unit tests assert: `{slack+github}` → "pr-triage", `{linear+github}` → "issue-to-pr", `{jira}` → "bug-intake", `{}` → "hello-world", and that every `TemplateId` resolves to an existing template record.

#### Automated QA:
- [ ] qa-use session: with no integrations connected, `/templates`, `/tasks`, `/workflows` empty states show the "hello-world" recommendation.
- [ ] qa-use session: with Slack + GitHub connected (envs set), empty states promote the "pr-triage" template; clicking it lands on `/templates/pr-triage`.
- [ ] qa-use session: connect Linear + GitHub → recommendation switches to "issue-to-pr" without page reload (Phase 2's polling triggers the re-fetch).
- [ ] qa-use session: home "First steps" section reflects current top recommendation; milestone-4 (`first_task`) action button targets the same template.

#### Manual Verification:
- [ ] Recommendation copy reads naturally for at least 2 integration combinations — not robotic, not pushy.

**Implementation Notes**:
- Recommendation card click navigates to `/templates` (the prompt-templates list page), NOT `/templates/<id>` — the UI's `/templates/:id` route is for prompt templates, not the agent-template registry. Deep-linking would 404 today. Captured `data-template-id` on the action button so a future agent-template detail route can light up without a card refactor.
- Template stubs created in `templates/official/{pr-triage,issue-to-pr,bug-intake,hello-world}/` (config.json + CLAUDE.md only). They are agent-role templates; future iterations can flesh them out with real soulMd/identityMd/setup-script bodies.
- After this phase, pause for manual confirmation.

---

## Phase 4: Per-User UX Persistence (browser localStorage)

### Overview

UI polish layer: a reusable dismissible-card hook namespaced by deployment URL, applied to (1) welcome/intro card on home, (2) per-milestone collapse in the setup checklist, (3) "tour completion" entire setup-section collapse once all 4 milestones from the brainstorm (`harness`, `integrations` (any), `workers`, `first_task`) have each been `verified` at least once.

### Dependencies on Phase 1+2+3
- `HomePage` exists.
- `useStatus()` provides setup state.
- All four MVP milestones can flip to `verified`.

### Changes Required:

#### 1. `useDismissibleCard` hook
**File**: `ui/src/lib/use-dismissible-card.ts` (new)
**Changes**:
```typescript
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "../api/client"; // existing hook from Phase 1

const NAMESPACE_PREFIX = "swarm:v1";

export function useDismissibleCard(cardKey: string) {
  const { apiUrl } = useConfig();
  const storageKey = `${NAMESPACE_PREFIX}:${apiUrl}:${cardKey}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  const dismiss = useCallback(() => {
    try { localStorage.setItem(storageKey, "1"); } catch {}
    setDismissed(true);
  }, [storageKey]);
  const restore = useCallback(() => {
    try { localStorage.removeItem(storageKey); } catch {}
    setDismissed(false);
  }, [storageKey]);
  // Optional: cross-tab sync via the `storage` event.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === storageKey) setDismissed(e.newValue === "1");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);
  return { dismissed, dismiss, restore };
}
```
- Safe-guards `localStorage` access for environments without storage (e.g. SSR — though we're Vite-only, safe by default).

#### 2. Welcome / intro card on home
**File**: `ui/src/pages/home/page.tsx`
**Changes**: Add a `<WelcomeCard />` at the top of `HomePage`. Uses `useDismissibleCard("home-welcome")`. Renders org-aware copy ("Welcome to {identity.name}!") with a one-line orientation paragraph and a "Got it" close button. Hidden when `dismissed` is `true`.

#### 3. Per-milestone collapse in setup checklist
**File**: `ui/src/pages/home/setup-checklist.tsx` (new — extracted from Phase 1's inline implementation)
**Changes**: Each `verified` milestone row has a chevron — click toggles a per-row `useDismissibleCard("setup:row:<milestoneId>")`. When `dismissed` is `true`, only the label + check icon render (collapsed); other states stay always-expanded since the user needs to see the hint.

#### 4. Tour-completion full-section collapse
**File**: `ui/src/pages/home/setup-checklist.tsx`
**Changes**: A separate flag `useDismissibleCard("setup:tour-complete")` — when `true` AND all four MVP milestones (`harness`, any integration verified, `workers`, `first_task`) are `verified`, the entire setup section is collapsed by default with a "Show setup" toggle. The flag flips to `true` once-and-stays-true the first time the four-milestone condition is satisfied; user can manually toggle at will. Storing the flag (rather than recomputing) avoids the "re-expanded after a flake" UX bug.

#### 5. Tests
**File**: `ui/src/lib/use-dismissible-card.test.ts` (new)
**Changes**:
- Round-trip dismiss → reload simulation → restore.
- Namespace isolation: render two instances with different mocked `apiUrl` values, assert dismissing one does not affect the other.
- Cross-tab `storage` event handler updates state.
- localStorage failure (mock `setItem` to throw) does not crash; in-memory state still flips.

**File**: `ui/src/pages/home/setup-checklist.test.tsx` (new)
**Changes**: With all four milestones mocked `verified` AND `setup:tour-complete` set, asserts collapsed-by-default; "Show setup" toggle restores; subsequent re-render with stored flag preserves the new state.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] UI lint + typecheck: `cd ui && pnpm lint && pnpm exec tsc -b`
- [x] Unit tests for `useDismissibleCard` cover: namespace key derivation, dismiss/restore round-trip, namespace isolation across two `apiUrl` values, cross-tab sync via `storage` event, graceful failure when `localStorage` throws. _(Pure-logic tests at `src/tests/use-dismissible-card.test.ts` — `ui/` has no test runner. Cross-tab `storage` event handler tested in qa-use sessions instead — pure-logic can't meaningfully exercise `addEventListener("storage", …)`.)_

#### Automated QA:
- [ ] qa-use session: dismiss welcome card → reload → stays dismissed.
- [ ] qa-use session: collapse a verified milestone → reload → stays collapsed.
- [ ] qa-use session: with all 4 milestones verified once, the entire setup section collapses by default; "Show setup" toggle restores; choice persists across reload.
- [ ] qa-use session: open the same UI bundle pointed at two distinct API URLs (`?apiUrl=http://localhost:3013` vs. `?apiUrl=http://other.local:3013` — needs a second running swarm or a mocked endpoint); dismissing on A does not dismiss on B; verify the localStorage keys differ in DevTools.

#### Manual Verification:
- [ ] Dismiss-state survives across browser tabs of the same deployment (open two tabs, dismiss in one, second tab reflects on next visibilitychange or reload).
- [ ] Clearing site data resets all dismissible cards (sanity).

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Manual E2E (all four phases on a fresh DB)

Run from a clean repo state with `rm agent-swarm-db.sqlite` to exercise the empty path. Two browsers / two `apiUrl` values exercise the localStorage namespacing.

### Server prep — clean slate
```bash
# Fresh DB, no integrations, no identity envs
rm -f agent-swarm-db.sqlite
unset SWARM_CLOUD SWARM_ORG_NAME SWARM_ORG_LOGO_URL SWARM_BRAND_COLOR SWARM_MARKETING_URL SWARM_HIDE_CLOUD_PROMO
unset HARNESS_PROVIDER ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN GITHUB_WEBHOOK_SECRET GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY
unset AGENT_FS_API_URL
bun run start:http
```

### Phase 1 — empty-DB walkthrough

```bash
# 1. /health unchanged
curl -s http://localhost:3013/health
# Expect: {"status":"ok","version":"<pkg-version>"}

# 2. /status with nothing configured
curl -s http://localhost:3013/status -H "Authorization: Bearer ${API_KEY:-123123}" \
  | jq '{identity, setup: [.setup[] | {id, state}], activity, agent_fs}'
# Expect:
# - identity: name="Swarm", logo_url=null, brand_color=null, is_cloud=false, marketing_url=null
# - setup states: harness=unverified, slack=unverified, github=unverified, linear=unverified,
#   jira=unverified, workers=unverified, first_task=unverified
# - activity: { agents_online: 0, leads_online: 0, recent_tasks_count: 0 }
# - agent_fs: { configured: false, base_url: null }
```

Browser:
```bash
cd ui && pnpm dev
# Open http://localhost:5274/?apiUrl=http://localhost:3013&apiKey=123123
```
- Confirm `/` renders `HomePage` with default identity, all 7 setup milestones in `unverified` state with deep-links wired.
- Click each deep-link → router lands on `/integrations`, `/agents`, `/tasks`, `/templates` respectively.
- Visit `/dashboard` → confirms legacy `DashboardPage` still mounted there.

### Phase 1 — verify a harness
```bash
# Assume an Anthropic key is available in your shell
HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run start:http
```
Browser:
- `harness` row state shows `configured` with a "Test connection" button.
- Click → toast shows latency + "Verified"; row flips to `verified`.
- `curl /status` confirms `harness.state === "verified"`.

### Phase 2 — health badge + cloud awareness

```bash
# Self-hosted with marketing URL
SWARM_MARKETING_URL=https://swarm.desplega.ai HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run start:http
```
Browser:
- Header badge color matches `health` (degraded — workers not yet alive).
- Footer marketing link visible.

```bash
# Cloud mode
SWARM_CLOUD=true SWARM_MARKETING_URL=https://swarm.desplega.ai HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run start:http
```
Browser:
- User-menu shows Docs/Support/Billing items.
- Footer marketing link absent.

```bash
# Hide promo
SWARM_HIDE_CLOUD_PROMO=true SWARM_MARKETING_URL=https://swarm.desplega.ai HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run start:http
```
Browser:
- Footer marketing link absent regardless of `SWARM_CLOUD`.
- Click header badge → URL becomes `/#setup` and the setup section scrolls into view.
- Wait 30s with the tab focused → DevTools shows a second `/status` request.
- Switch tabs for 30s → no new requests; return → polling resumes.

### Phase 2 — agent-fs card
```bash
AGENT_FS_API_URL=http://localhost:7777 ... bun run start:http
```
Browser:
- Home "Storage" card shows ✓ and "Open" button → opens `http://localhost:7777` in new tab.

### Phase 3 — recommendation flow

```bash
# Connect Slack via existing /integrations OAuth flow OR set envs:
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run start:http

# Then GitHub envs too:
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
GITHUB_WEBHOOK_SECRET=… GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="…" \
HARNESS_PROVIDER=claude ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
bun run start:http

curl -s http://localhost:3013/status -H "Authorization: Bearer ${API_KEY:-123123}" \
  | jq '.setup[] | select(.id == "slack" or .id == "github") | {id, state}'
```
Browser:
- `/templates` empty state recommends "PR triage"; click → `/templates/pr-triage`.
- Disconnect GitHub envs (set Slack only) → empty state falls back to "hello-world".
- Connect Linear via OAuth flow → empty state shows "issue-to-pr" once `linear` milestone is `verified`.
- Home "First steps" CTA targets the top recommendation.
- `/workflows` empty state surfaces the same recommendation.

### Phase 4 — persistence + namespacing

Browser A — `?apiUrl=http://localhost:3013`:
- Dismiss welcome card → reload → stays dismissed.
- Collapse a verified milestone → reload → stays collapsed.
- Verify all four MVP milestones (harness via Test connection, an integration via OAuth/envs, workers via `bun run pm2-start`, first task via `/tasks` "Issue task" → completes) → reload → setup section collapsed by default → toggle "Show setup" → restores → reload → stays restored (or stays collapsed depending on last toggle).

Browser B — `?apiUrl=http://localhost:3013&dummy=1` (or a second swarm on a different port):
- Welcome card visible — not affected by Browser A's dismiss.
- DevTools → Application → localStorage shows two distinct keys: `swarm:v1:http://localhost:3013:home-welcome` and `swarm:v1:http://localhost:3013?dummy=1:home-welcome` (or two different `apiUrl` host entries).

### Cleanup
```bash
bun run pm2-stop || true
rm -f agent-swarm-db.sqlite
```

---

## Appendix

- **Follow-up plans** (parked):
  - Per-run "files touched" agent-fs panel (needs task-side instrumentation).
  - Onboarding telemetry.
  - "Connect from CLI" deep-link.
  - Server-side per-user state (would need an account model).
  - Migration adding `oauth_tokens.last_refresh_error_at` for honest Linear/Jira `verified` state.
  - Slack Socket Mode connection-state probe.
  - Admin UI for editing identity via `/config`.
- **Derail notes**:
  - GitHub App installation count could become a real `verified` signal in a future phase.
  - The Test-connection cache being in-memory means each API restart re-asks the user to verify; if this annoys, persist `last_verified_at` per provider in `swarm_config` (still no migration needed).
  - Recommendation mapping might want a "near-miss" hint (e.g. Slack alone → "Connect GitHub to unlock PR triage").
- **References**:
  - Research: `thoughts/taras/research/2026-05-07-cloud-personalization-research.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md`
  - `CLAUDE.md` (route() factory, DB-boundary, OpenAPI freshness, ui/ stack, Bun-only)
  - `runbooks/local-development.md`, `runbooks/ci.md`, `runbooks/testing.md`
  - `LOCAL_TESTING.md`
