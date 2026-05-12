---
date: 2026-05-07T00:00:00Z
researcher: Taras (via Claude)
git_commit: a2e86719892a82623f75d0885eb3996afb49cf83
branch: main
repository: agent-swarm
topic: "Cloud deployment personalization & onboarding — codebase audit for Phase 1 (status API + home UI)"
tags: [research, codebase, cloud, onboarding, ui, providers, oauth, agent-fs, heartbeat]
status: complete
autonomy: autopilot
last_updated: 2026-05-07
last_updated_by: Taras
---

# Research: Cloud deployment personalization & onboarding

**Date**: 2026-05-07
**Researcher**: Taras (via Claude)
**Git Commit**: a2e86719892a82623f75d0885eb3996afb49cf83
**Branch**: main

## Research Question

Audit the codebase to scope Phase 1 of the cloud-personalization + onboarding work brainstormed in [`thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md`](../brainstorms/2026-05-07-cloud-deployment-personalization.md). Specifically, answer 8 focus areas spanning UI routing, existing config screens, provider health-check feasibility, OAuth storage, worker heartbeats, env conventions, status-endpoint precedent, and agent-fs detection.

## Summary

The good news: **most of the surface area we want already exists in the codebase as primitives** — there are routes for integrations, agents, tasks, and templates; reusable React components for OAuth shells, status badges, empty states; a `route()` factory for new HTTP endpoints; a clean `agents.lastActivityAt` heartbeat column; and a non-conflicting `SWARM_*` env namespace. A new "home + setup" page can compose existing parts rather than build from scratch.

The corrections to the brainstorm: **(1) `ui/` is React + Vite + react-router, not Next.js** — affects routing, env-var consumption, and component conventions. **(2) The "OAuth row = verified" model only applies to Linear and Jira** — Slack and GitHub use env-vars only and have no OAuth user flow at all. **(3) Even for Linear/Jira, a stored token row only proves the *handshake* succeeded; refresh failures don't delete the row, so "row exists" can lie if a token has been revoked externally.** **(4) The `ProviderAdapter` interface has no health-check method**, and every existing `check<Provider>Credentials` function is env-presence-only with zero network calls — live "Test connection" is real new work per provider.

A `GET /health` route already exists but is hard-coded outside the `route()` factory and only returns `{ status, version }`. The new `GET /status` endpoint we proposed should be a fresh `route()`-registered handler so it lands in `openapi.json`; we leave `/health` alone since docker healthchecks depend on it. None of the proposed identity envs (`SWARM_CLOUD`, `SWARM_ORG_NAME`, `SWARM_ORG_LOGO_URL`, `SWARM_BRAND_COLOR`, `SWARM_MARKETING_URL`, `SWARM_HIDE_CLOUD_PROMO`) collide with anything already in the repo.

## Detailed Findings

### 1. UI home routing (`ui/`)

**Stack:** React + Vite + react-router-dom, **not Next.js app router**. Pages live at `ui/src/pages/<route>/page.tsx`, registered in `ui/src/app/router.tsx`. This breaks the brainstorm's assumption — no Next.js conventions apply.

**Current `/`:** Goes straight to `DashboardPage` (`ui/src/app/router.tsx:45`, file `ui/src/pages/dashboard/page.tsx`). Dashboard is a "Command Center" that already aggregates `useStats`, `useHealth`, `useLogs`, `useDashboardCosts`, `useAgents`, `useTasks` — meaning the activity-summary data sources we'd need are already wired.

**Recent `60bb0ea8 remove landing` commit:** All landing-page references in `ui/src` are gone. Only historical artifacts remain in `thoughts/taras/{plans,research}/2026-03-27-landing-page-cloud-redesign.md`. Route table jumps directly from `/` → Dashboard.

**Where a new home slots in:** Two clean options at `ui/src/app/router.tsx:40-80`:
- **Replace `/`** by swapping the `index: true` element on line 45 (turns Dashboard into a drill-down accessible from the new home).
- **Add `/home`** as a new sibling route + add to sidebar (`ui/src/components/layout/app-sidebar.tsx:37-80`, `Core` group).

**App shell:** `ui/src/components/layout/root-layout.tsx` wraps every route with `ConfigGuard`, `SidebarProvider`, `AppSidebar`, `AppHeader`, `ErrorBoundary`, `Suspense<PageSkeleton>`. New pages get all of this for free.

**Current top-level routes (full list):** `/`, `/agents`, `/tasks`, `/chat`, `/services`, `/schedules`, `/workflows`, `/workflow-runs/:id`, `/approval-requests`, `/usage`, `/budgets`, `/config`, `/integrations`, `/templates`, `/mcp-servers`, `/skills`, `/repos`, `/keys`, `/debug`, `/memory`, `*` (NotFound).

### 2. Existing config UI per setup milestone

| Milestone | Status | Route(s) | File(s) | Notes |
|---|---|---|---|---|
| **Harness provider + creds** | Partial — folded into Integrations | `/integrations?category=llm`, `/integrations/anthropic`, `/integrations/openrouter`, `/integrations/openai`, `/integrations/claude-managed` | `ui/src/pages/integrations/page.tsx`, `ui/src/pages/integrations/[id]/page.tsx`, `ui/src/lib/integrations-catalog.ts` (anthropic:482, openrouter:517, openai:541, claude-managed:578) | **No dedicated "harness provider picker" page.** `HARNESS_PROVIDER` itself only appears in `ui/src/api/types.ts`, `ui/src/pages/budgets/page.tsx`, `ui/src/lib/integrations-status.sanity.ts` — no UI to set it. Codex/Claude-managed have shared OAuth shells (`OAuthSection`, `OAuthStatusRow`). |
| **Integrations** (Slack/GitHub/Linear/Jira) | Exists | `/integrations`, `/integrations/:id` | `ui/src/pages/integrations/page.tsx`, `ui/src/pages/integrations/[id]/page.tsx` | Catalog-driven: slack (line 72), github (160), linear (318, OAuth flow), jira (360, OAuth flow). Backed by `useConfigs({scope:"global"})` + `useEnvPresence`. Empty-state at `page.tsx:49-61`. |
| **Workers / agents** | Exists | `/agents`, `/agents/:id` | `ui/src/pages/agents/page.tsx`, `ui/src/pages/agents/[id]/page.tsx` | AG Grid table over `useAgents()`. Columns: name (with `Crown` for `isLead`), role, status (`StatusBadge`), capacity. Dashboard already embeds an agent strip (`AgentRow` in `pages/dashboard/page.tsx:34-65`). |
| **First task / templates** | Exists, **but conceptually mismatched** | `/templates`, `/templates/:id`, `/templates/:id/history/:version`, `/tasks`, `/tasks/:id` | `ui/src/pages/templates/page.tsx`, `ui/src/pages/templates/[id]/page.tsx`, `ui/src/pages/tasks/page.tsx`, `ui/src/pages/tasks/[id]/page.tsx` | `/templates` is a **prompt-template** registry (`usePromptTemplates`), not workflow starter templates. **No first-task wizard exists.** The "first task" milestone has no purpose-built UI today. |

**Reusable primitives the home page can compose:**
- `EmptyState` (`ui/src/components/shared/empty-state.tsx`) — canonical icon+title+description+action.
- `OAuthSection`, `OAuthStatusRow`, `OAuthSectionRow` (`ui/src/components/shared/`) — already implements codex/linear/jira/claude-managed connection rows.
- `deriveIntegrationStatus`, `findConfigForKey` in `ui/src/lib/integrations-status.ts` — existing "is this integration configured?" derivation.
- `PageHeader` (`ui/src/components/ui/page-header.tsx`) — title + description + action.
- `DetailPageBody`, `DetailPageRail`, `QuickStats`, `Relationships`, `DangerZone` (`ui/src/components/ui/`) — standard layout primitives.

### 3. `/status` endpoint precedent + `route()` factory

**No top-level `/status` exists.** Substring matches are sub-resources: `GET /api/keys/status`, `GET /api/trackers/linear/status`, `GET /api/trackers/jira/status`, `GET /api/mcp-oauth/{mcpServerId}/status`. No `/info`, `/instance`, `/instance-info`, `/version`.

**`GET /health` does exist** at `src/http/core.ts:100-113` — but is **hard-coded inside `handleCore`, not registered via `route()`**, so it does NOT appear in `openapi.json`. Returns `{ status: "ok", version }` (version read from `package.json`). Consumed by:
- UI dashboard via `ApiClient.checkHealth()` (`ui/src/api/client.ts:308-318`).
- UI config page test-connection probes (`ui/src/pages/config/page.tsx:584,713,947`).
- Worker onboarding health step (`src/commands/onboard/steps/health-check.tsx:43`).
- Generated docker-compose healthchecks (`src/commands/onboard/compose-generator.ts:83`).
- Default agent `healthCheckPath` (`src/types.ts:377`, `src/be/migrations/001_initial.sql:154`, `src/be/db.ts:3262/3310/3460`).

**`POST /ping`** at `src/http/core.ts:255-294` — also hard-coded — is a separate worker heartbeat endpoint that updates the agent's status row. Not `lastActivityAt`. (See section 5.)

**`route()` factory pattern** (`src/http/route-def.ts:84-142`):
- Required: `method`, `path` (OpenAPI-style `{id}`), `pattern` (matchRoute slots), `summary`, `tags`, `responses`.
- Optional: `description`, `exact` (default `true`), `params`/`query`/`body` Zod schemas, `auth` (default api-key required).
- `route(def)` pushes into `routeRegistry` (line 91), returns handle with `match()` (line 96) + `parse()` (line 106).
- 400 emitted on Zod failure (line 130-137).

**Minimal GET example** (`src/http/api-keys.ts:80-96`):
```ts
const listStatuses = route({
  method: "get",
  path: "/api/keys/status",
  pattern: ["api", "keys", "status"],
  summary: "Get all API key status records",
  tags: ["API Keys"],
  query: z.object({ keyType: z.string().optional(), scope: z.string().optional() }),
  responses: { 200: { description: "..." }, 401: { description: "Unauthorized" } },
  auth: { apiKey: true },
});
```
Dispatch in same file's `handle*` function; module wired in `src/http/index.ts:109` (and similar imports).

**OpenAPI registration:** add an `import "../src/http/<file>"` line to `scripts/generate-openapi.ts:3-32`. Then `bun run docs:openapi` (per CLAUDE.md).

### 4. Env-var conventions + `SWARM_*` namespace

**Server-side reads:** Direct `process.env.FOO` everywhere. No helper wrapper. Bun auto-loads `.env`. Examples: `src/http/index.ts:61-62` (`PORT`, `API_KEY`), `:296,305` (`SCHEDULER_INTERVAL_MS`, `HEARTBEAT_INTERVAL_MS`), `src/http/openapi.ts:77` / `src/http/utils.ts:88,99` (`MCP_BASE_URL`).

**Global config bridge:** `loadGlobalConfigsAndIntegrations()` reads the `swarm_config` SQLite table and merges values into `process.env` (`src/http/core.ts:24-26,148-163`, exposed via `POST /internal/reload-config`). This means *DB-stored config* and *env vars* converge in `process.env` at runtime — relevant for how identity envs could be overridden.

**Existing `SWARM_*` envs (full list):**
- `SWARM_URL` — base service-discovery domain (`.env.example:31-32`, `src/tools/register-service.ts:7,78`, defaults to `localhost`).
- `SWARM_API_URL`, `SWARM_API_KEY`, `SWARM_AGENT_ID`, `SWARM_TASK_ID`, `SWARM_IS_LEAD` — set on Opencode child processes (`src/providers/opencode-adapter.ts:489-501`).
- `SWARM_DASHBOARD_URL` — Linear-sync dashboard link, falls back to `APP_URL` (`src/linear/sync.ts:431,506,748`).
- `LINEAR_SWARM_READY_LABEL` — Linear label override (`src/linear/gate.ts:54`).
- `OPENCODE_SWARM_PLUGIN_PATH` — Opencode plugin file location.
- `AGENT_SWARM_API_KEY` — referenced only in `deploy/DEPLOY.md:57` (Caddy reverse-proxy config, not read by app code).

**Collision check for the proposed identity contract:** ✅ Clean — none of `SWARM_CLOUD`, `SWARM_ORG_NAME`, `SWARM_ORG_LOGO_URL`, `SWARM_BRAND_COLOR`, `SWARM_MARKETING_URL`, `SWARM_HIDE_CLOUD_PROMO` exists anywhere in the repo.

**UI runtime config (Vite):**
- App code reads `import.meta.env.DEV` only (used in `ui/src/api/client.ts:123,311` and a few hooks).
- `process.env.VITE_PROXY_TARGET` is read in `ui/vite.config.ts:17,23` (dev proxy target).
- **No `NEXT_PUBLIC_*` injection.** Runtime config flows via `getConfig()` / `useConfig()` hooks (`ui/src/api/client.ts:111,122,309`) — sourced from in-app config panel (`ui/src/pages/config/page.tsx`) or `?apiUrl=...&apiKey=...` URL params (per `ui/CLAUDE.md`).
- **API base URL resolution** at `ui/src/api/client.ts:121-127`: returns `""` (same-origin → Vite proxy) when `import.meta.env.DEV && config.apiUrl === "http://localhost:3013"`; otherwise the configured `config.apiUrl`.
- **Precedent for "fetch identity on app load":** `ApiClient.checkHealth()` (`ui/src/api/client.ts:308-318`) hits `${baseUrl}/health`. The new `/status` UI consumer should follow the same pattern (a hook over the API client).

### 5. Worker heartbeats / liveness

**Schema** (`src/be/migrations/001_initial.sql:10-28`, latest rebuild `src/be/migrations/053_agent_waiting_for_credentials_status.sql:20-42`):
- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `isLead INTEGER NOT NULL DEFAULT 0` — **0 = worker, 1 = lead** (canonical discriminator; `role` is a free-text descriptor, not the lead/worker bit)
- `status TEXT CHECK(status IN ('idle','busy','offline','waiting_for_credentials'))`
- `lastActivityAt TEXT` — ISO-8601 UTC, written by `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
- `lastUpdatedAt TEXT NOT NULL`
- `emptyPollCount INTEGER DEFAULT 0`
- **No index on `lastActivityAt`** (or any other liveness column).

**Heartbeat write path:** `PUT /api/agents/{id}/activity` (`src/http/agents.ts:119-129`, dispatch `:393-400`) → `updateAgentActivity(id)` at `src/be/db.ts:699-705`:
```sql
UPDATE agents SET lastActivityAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
```

**Worker callsites (fire-and-forget):**
- `src/providers/swarm-events-shared.ts:159-166` (codex/claude-managed shared event stream)
- `src/providers/pi-mono-extension.ts:494` (pi/Anthropic stream extension)
- `src/hooks/hook.ts:893-901` (Claude `PostToolUse` hook — every tool invocation)

**Throttle:** `ACTIVITY_THROTTLE_MS = 5_000` (5 seconds, `src/providers/swarm-events-shared.ts:48-49`). Event-driven, bounded above 5s when the harness is producing events.

**`POST /ping`** (separate from `/activity`) updates `agents.status` row, not `lastActivityAt`. Worker callers: `src/hooks/hook.ts:253`, `src/commands/runner.ts:169`, `src/providers/pi-mono-extension.ts:391`.

**No "is alive" helper exists.** No `getActiveAgents`, `getOnlineAgents`, `liveAgents`, `aliveAgents`, `recentlyActive` in `src/be/db.ts`. `getIdleWorkersWithCapacity` (`src/be/db.ts:5368-5381`) filters on `status = 'idle' AND isLead = 0` only — does **not** consult `lastActivityAt`.

**Suggested SQL for the new helper:**
```sql
SELECT
  SUM(CASE WHEN isLead = 1 THEN 1 ELSE 0 END) AS leads_alive,
  SUM(CASE WHEN isLead = 0 THEN 1 ELSE 0 END) AS workers_alive
FROM agents
WHERE lastActivityAt IS NOT NULL
  AND lastActivityAt >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' minutes')
  AND status != 'offline';
```
Plus: agents in `status = 'waiting_for_credentials'` should be flagged as a *known* problem in the checklist (it's already a discrete state).

### 6. Provider test-connection feasibility

**Canonical providers** (`src/types.ts:77-85`): `claude`, `codex`, `pi`, `devin`, `claude-managed`, `opencode`. Factory at `src/providers/index.ts:27-46` (`createProviderAdapter`).

**`gemini`/`openrouter` are NOT standalone providers** — they appear only as model-prefix routes within `pi` and `opencode` (`pi-mono-adapter.ts:139-179`, `opencode-adapter.ts:40-44`).

**`ProviderAdapter` interface** (`src/providers/types.ts:107-113`):
```ts
interface ProviderAdapter {
  readonly name: string;
  readonly traits: ProviderTraits;
  createSession(config): Promise<ProviderSession>;
  canResume(sessionId): Promise<boolean>;
  formatCommand(commandName): string;
}
```
**No `validate()` / `ping()` / `healthCheck()` / `testConnection()` member.** Each adapter exports a free `check<Provider>Credentials(env, opts?) -> CredStatus` (`src/providers/types.ts:131-136`), dispatched through `checkProviderCredentials` in `src/providers/credentials.ts:51-74`. **All `check*Credentials` are pure env-presence / file-existence predicates — zero network calls.**

**Per-provider summary:**

| Provider | Adapter file | Cred-check (env-only) | Auth env vars | Cheapest live test call |
|---|---|---|---|---|
| claude | `src/providers/claude-adapter.ts` (`:27-36`) | env-only | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `GET https://api.anthropic.com/v1/models` w/ `x-api-key` + `anthropic-version` |
| codex | `src/providers/codex-adapter.ts` (`:103-126`) | env + `~/.codex/auth.json` probe | `OPENAI_API_KEY` or `CODEX_OAUTH` | `GET https://api.openai.com/v1/models` w/ `Authorization: Bearer …` |
| pi | `src/providers/pi-mono-adapter.ts` (`:75-107`) | env + `~/.pi/agent/auth.json` probe; key choice depends on `MODEL_OVERRIDE` (`modelToCredKey:60-64`) | one of `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | per key: anthropic `models`, openrouter `GET https://openrouter.ai/api/v1/models`, openai `models` |
| devin | `src/providers/devin-adapter.ts` (`:40-51`); REST client `devin-api.ts` | env-only | `DEVIN_API_KEY` + `DEVIN_ORG_ID` (override `DEVIN_API_BASE_URL`) | `GET ${baseUrl()}/v3/organizations/${orgId}/sessions` (no list endpoint exposed in helper) |
| claude-managed | `src/providers/claude-managed-adapter.ts` (`:80-96`) | env-only | `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MCP_BASE_URL` | Anthropic `GET /v1/models` + managed-agents SDK fetch for the configured `MANAGED_AGENT_ID` |
| opencode | `src/providers/opencode-adapter.ts` (`:56-87`) | env + `~/.local/share/opencode/auth.json` probe | one of `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (model-prefix-aware via `:35-45`) | same per-key endpoints as pi |

**OAuth-style providers** have a different validation model (token presence = valid, no network ping):
- **codex (ChatGPT OAuth):** flow at `src/providers/codex-oauth/flow.ts` (PKCE + loopback `:1455/auth/callback`); token URLs `auth.openai.com/oauth/{authorize,token}`. Storage in `src/providers/codex-oauth/storage.ts`, materialised to `~/.codex/auth.json` by docker-entrypoint. `checkCodexCredentials` returns `satisfiedBy: "side-effect-pending"` when only `CODEX_OAUTH`/`OPENAI_API_KEY` present.
- **claude (`CLAUDE_CODE_OAUTH_TOKEN`):** token from external `claude setup-token`. No in-repo OAuth flow. Presence = valid.
- **claude-managed:** uses `ANTHROPIC_API_KEY` (not OAuth) plus managed-agent IDs from `bun run src/cli.tsx claude-managed-setup`.

**Wiring:** `src/commands/runner.ts:2299-2300` constructs a single adapter per worker via `createProviderAdapter(process.env.HARNESS_PROVIDER || "claude")`. `HARNESS_PROVIDER` is the canonical selector; read at `:251`, `:563`, `:1349`, `:2549`. `ProviderAdapter` is the only interface the runner consumes — no second hook for health.

### 7. OAuth integration storage — *important correction to brainstorm*

The brainstorm assumed all four integrations (Slack/GitHub/Linear/Jira) use OAuth and store tokens in a row that proves successful handshake. **That's only true for Linear and Jira.** Slack and GitHub use env-var-only configuration with no OAuth user flow at all.

#### Slack
- **Token table:** None. Env vars only: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (`src/slack/app.ts:26-32`).
- **Connection model:** Socket Mode (`src/slack/app.ts:34-39`).
- **"Configured" signal:** envs present + `SLACK_DISABLE` not set (`src/slack/app.ts:20-32`).
- **No OAuth flow, no row to check, no refresh.**

#### GitHub
- **Token table:** None. Env vars: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (`src/github/app.ts:42-64`).
- **Connection model:** GitHub App. Per-installation tokens are JIT-minted and held in an in-memory `tokenCache` (`src/github/app.ts:7`).
- **"Configured" signal:** `isGitHubEnabled()` = `!!GITHUB_WEBHOOK_SECRET` (`src/github/app.ts:9-17`).
- **No OAuth user flow, no row to check.**

#### Linear
- **Token table:** `oauth_tokens` (`src/be/migrations/009_tracker_integration.sql:26-36`); app config in `oauth_apps` (`:11-23`).
- **OAuth handler:** `src/linear/oauth.ts`; HTTP routes `src/http/trackers/linear.ts:156-189` (callback), `:263-283` (disconnect).
- **Insertion point:** `storeOAuthTokens()` is called inside `exchangeCode()` at `src/oauth/wrapper.ts:141-146` — **after** successful HTTP 2xx token-endpoint response, **before** any whoami/identity probe. **No post-exchange identity check.**
- **Row = verified? With caveats.** Row presence proves the auth-code → access-token exchange succeeded, **not** that the token still works. Token can be expired (1h lifetime, `wrapper.ts:137-139`) or revoked externally without the row reflecting that.
- **Refresh:** `refreshAccessToken()` (`wrapper.ts:160-204`). Keepalive at `src/oauth/keepalive.ts:39-53` runs every 50 min for `["linear","jira"]`.
- **Failure handling:** Refresh failure throws; reactive `ensureToken()` swallows with `console.error` (`src/oauth/ensure-token.ts:38-47`); strict `ensureTokenOrThrow()` re-throws (`:57-71`); keepalive catches and posts a Slack alert (`keepalive.ts:45-51`). **No row delete, no error column** — refresh failure leaves the stale row in place.
- **Delete-on-revoke:** Manual via `DELETE /api/trackers/linear/disconnect` (`src/http/trackers/linear.ts:263-283`, calls `deleteOAuthTokens("linear")`).

#### Jira
- **Token table:** Same `oauth_tokens` (provider = `"jira"`); app row in `oauth_apps` (`src/jira/app.ts:49-64`).
- **OAuth handler:** `src/jira/oauth.ts` (callback `:51-98`); HTTP `src/http/trackers/jira.ts`.
- **Insertion point:** `exchangeCode()` persists tokens at `src/oauth/wrapper.ts:141`. `handleJiraCallback` (`src/jira/oauth.ts:65`) **then** calls `accessible-resources` (`:67-78`) to resolve `cloudId` and writes it via `updateJiraMetadata` (`:91`). **If `accessible-resources` throws, the token row stays inserted while the metadata update is skipped** — additional failure mode.
- **Row = verified? With caveats.** Same as Linear, plus the cloudId-missing case.
- **Refresh + failure:** Same path as Linear (`wrapper.ts:160-204`, keepalive, no auto-delete, no error column).
- **Delete-on-revoke:** Manual at `src/http/trackers/jira.ts:433` (`deleteOAuthTokens("jira")`).

#### Implication for the setup checklist

The four integrations have **four different validation models** — the "OAuth token = verified" simplification doesn't hold:

| Integration | "Configured" check | "Verified" check |
|---|---|---|
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` present, `SLACK_DISABLE` unset | Same as configured (Socket Mode connection state could be a richer signal but not currently exposed) |
| GitHub | `GITHUB_WEBHOOK_SECRET` + `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` present | Same as configured (per-installation tokens validated JIT on demand) |
| Linear | Row in `oauth_tokens` with `provider='linear'` | Row exists + most-recent `keepalive.ts` cycle did not error (or no row → unverified) |
| Jira | Row in `oauth_tokens` with `provider='jira'` AND `oauth_apps.metadata.cloudId` present | Same as Linear, additionally requires cloudId resolved |

### 8. agent-fs detection

- **Env vars:**
  - `AGENT_FS_API_URL` — global presence flag (`src/prompts/base-prompt.ts:189`, `docker-entrypoint.sh:364`).
  - `AGENT_FS_API_KEY` — per-agent key, scrubbed in logs (`src/utils/secret-scrubber.ts:43`).
  - `AGENT_FS_SHARED_ORG_ID` — propagated worker-side (`src/commands/runner.ts:1648-1651`).
- **Probe:** **None inside `src/`.** Boot-time `POST /auth/register` in `docker-entrypoint.sh:369` and lead-only `POST /orgs` at `:403` are the only network calls. **No HTTP GET / health check on the URL.**
- **DB tables:** **None.** agent-fs config is stored as `swarm_config` rows (global + agent-scoped) via `PUT /api/config` at `docker-entrypoint.sh:378-388` and `:413-422`. No dedicated metadata or run-link tables.
- **Helper function:** **None.** The only "configured?" check is the literal `if (process.env.AGENT_FS_API_URL)` at `src/prompts/base-prompt.ts:189`. No `{ configured, base_url }` accessor exists.
- **For Phase 2 home card:** straightforward to expose `agent_fs: { configured: !!process.env.AGENT_FS_API_URL, base_url: process.env.AGENT_FS_API_URL ?? null }` in the new `/status` response. No new probe needed for MVP.

## Code References

| File | Line | Description |
|------|------|-------------|
| `ui/src/app/router.tsx` | 45 | Root `/` route registers `<DashboardPage />` — where new home slots in |
| `ui/src/components/layout/root-layout.tsx` | — | App shell wrapping every route (sidebar, header, suspense) |
| `ui/src/components/layout/app-sidebar.tsx` | 37-80 | `navGroups` array — sidebar nav source |
| `ui/src/pages/dashboard/page.tsx` | 22-26 | Existing hooks (`useAgents`, `useTasks`, `useHealth`, etc.) — reusable |
| `ui/src/pages/integrations/page.tsx` | 49-61 | Empty-state detection pattern |
| `ui/src/lib/integrations-catalog.ts` | 72,160,318,360,482,517,541,578 | Slack/GitHub/Linear/Jira/Anthropic/OpenRouter/OpenAI/Claude-managed catalog rows |
| `ui/src/lib/integrations-status.ts` | — | `deriveIntegrationStatus`, `findConfigForKey` — reusable status logic |
| `ui/src/api/client.ts` | 308-318 | `checkHealth()` — precedent for "fetch instance info on load" |
| `src/http/route-def.ts` | 84-142 | `route()` factory definition |
| `src/http/api-keys.ts` | 80-96 | Minimal GET route example |
| `src/http/core.ts` | 100-113 | Existing hard-coded `GET /health` |
| `src/http/core.ts` | 24-26, 148-163 | `loadGlobalConfigsAndIntegrations()` + `POST /internal/reload-config` |
| `src/http/agents.ts` | 119-129, 393-400 | `PUT /api/agents/{id}/activity` heartbeat endpoint |
| `src/be/db.ts` | 699-705 | `updateAgentActivity()` — heartbeat write |
| `src/be/db.ts` | 5368-5381 | `getIdleWorkersWithCapacity()` — closest existing query |
| `src/be/migrations/053_agent_waiting_for_credentials_status.sql` | 20-42 | Latest agents-table rebuild — schema reference |
| `src/providers/types.ts` | 107-113 | `ProviderAdapter` interface (no health-check) |
| `src/providers/credentials.ts` | 51-74 | `checkProviderCredentials` dispatcher (env-only) |
| `src/providers/swarm-events-shared.ts` | 48-49 | `ACTIVITY_THROTTLE_MS = 5_000` |
| `src/oauth/wrapper.ts` | 141-146 | `storeOAuthTokens` insertion point — "row exists = handshake succeeded" |
| `src/oauth/keepalive.ts` | 16-20, 39-53 | Linear+Jira refresh keepalive (every 50 min) |
| `src/jira/oauth.ts` | 65-91 | Jira-specific cloudId metadata resolution |
| `src/be/migrations/009_tracker_integration.sql` | 11-36 | `oauth_apps` + `oauth_tokens` tables |
| `src/slack/app.ts` | 20-39 | Slack env-var configuration + Socket Mode |
| `src/github/app.ts` | 9-17, 42-64 | GitHub App env-var configuration |
| `src/prompts/base-prompt.ts` | 189 | Only "agent-fs configured?" check in src/ |
| `docker-entrypoint.sh` | 364, 369, 378-388, 403, 413-422 | agent-fs registration + config storage |
| `src/types.ts` | 77-85 | `ProviderNameSchema` (canonical 6 providers) |
| `src/commands/runner.ts` | 2299-2300 | `createProviderAdapter(HARNESS_PROVIDER)` dispatcher |
| `scripts/generate-openapi.ts` | 3-32 | Where to add new route module imports |

## Open Questions

- **First-task milestone bar.** No "first task wizard" UI exists today. Should "first task done" be: (a) at least one row in `tasks` with status `completed`; (b) at least one workflow run; (c) something else? The brainstorm flagged this as an open question; nothing in the codebase resolves it.
- **Slack/GitHub "verified" beyond env presence.** Slack Socket Mode is either connected or not — is that connection state exposed anywhere we could query for the checklist? Similarly, GitHub App installations could be listed — is there a "GitHub configured" → "GitHub installed on at least one repo" upgrade path worth showing?
- **Stale Linear/Jira tokens.** Refresh failure leaves the row in `oauth_tokens` untouched. The brainstorm's three-state model would degrade these from "verified" → "unverified" when keepalive fails — but there's no field to record that. Options: (a) add a `last_refresh_error_at` column via new migration, (b) read the most recent keepalive log via a new mechanism, (c) accept "row exists = verified" with the understanding it can lie. Picking is plan-phase work.
- **Existing `/health` vs new `/status`.** New `/status` doesn't replace `/health` (docker depends on it). Confirm the planner is OK with two routes (`/health` for liveness, `/status` for everything else).
- **identity overrides via `swarm_config`?** `loadGlobalConfigsAndIntegrations()` merges `swarm_config` into `process.env`. Does that mean an admin could set `SWARM_ORG_NAME` via the UI's `/config` page even on cloud, or do we want orchestrator-only? Worth a decision.
- **Identity envs in UI.** The Vite app has no NEXT_PUBLIC equivalent for build-time injection — identity must be fetched at runtime via `/status`. That's fine but means a brief "loading" state on app boot before the header logo paints.

## Appendix

### Architecture notes

- **API server is the sole DB owner** (per CLAUDE.md). All identity/setup checks consume DB through `src/be/db.ts` only via the API; the new `/status` route lives in `src/http/`.
- **`route()` factory + `scripts/generate-openapi.ts` import** is the canonical way to add HTTP routes. `/health` and `/ping` predate this convention and are hard-coded in `core.ts` — we don't want to add a third hard-coded route.
- **Vite + react-router-dom** for `ui/`, NOT Next.js. Pages auto-discovered through `ui/src/app/router.tsx`. Key reusable primitives are in `ui/src/components/{shared,ui}/` and `ui/src/lib/integrations-status.ts`.
- **Throttled fire-and-forget heartbeats** at 5s intervals, event-driven from harness. The 5s ceiling means a freshness threshold of e.g. 60s is safely "live"; 5min is conservatively "alive."
- **Env-vars + `swarm_config` table converge in `process.env`** at runtime via `loadGlobalConfigsAndIntegrations()`. So "read env" is the universal pattern even for DB-stored config.

### Historical context (from thoughts/)

- `thoughts/taras/brainstorms/2026-05-07-cloud-deployment-personalization.md` — source brainstorm that drove this research. Key resolutions: 3-state checklist, identity env contract spec'd in MVP, agent-fs scope reduced to home card.
- `thoughts/taras/research/2026-03-27-landing-page-cloud-redesign.md` — older landing-page research; the page itself was removed in commit `60bb0ea8`.
- `thoughts/taras/plans/2026-03-27-landing-page-cloud-redesign.md` — paired plan; outcomes superseded by current state.

### Related research

- `thoughts/taras/research/2026-03-27-landing-page-cloud-redesign.md` — predecessor landing-page redesign work (removed).
- See `runbooks/local-development.md` for env-var precedence and Claude-managed setup (used in the cloud-managed harness path).
- See `runbooks/secret-scrubbing.md` for how new identity envs (logo URL, brand color, marketing URL) should be handled if they ever flow through logs — none are secrets so this is mostly informational.
