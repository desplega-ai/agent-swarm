---
date: 2026-04-21
researcher: taras
git_commit: 5e550e857e07e1110bf1d576d500857793924f49
branch: main
repository: agent-swarm
topic: "Integrate Jira as a first-class tracker (Linear-equivalent basic integration)"
tags: [research, integrations, jira, linear, oauth, webhooks, trackers]
status: complete
last_updated: 2026-04-22
last_updated_by: taras
---

# Jira Integration Research

## Research Question

We want to add Jira Cloud as a first-class citizen integration to the swarm, with roughly the same shape as the existing Linear integration (OAuth 2.0 connect flow, webhook-driven task creation, outbound comments back to Jira, MCP/tracker tables reuse). What patterns already exist, what pieces are reusable, what new pieces are needed, and what are the Jira-specific gotchas?

Scope: **simple/basic** integration. Not Forge/Connect app ecosystem. Single-workspace-per-swarm-install is acceptable for v1 (matches Linear's current posture).

## Summary

A Jira integration fits cleanly onto the existing tracker scaffolding. Every reusable building block Linear uses is already provider-keyed:

- `src/oauth/wrapper.ts` — generic PKCE-S256 authorization URL + code exchange
- `src/oauth/ensure-token.ts` / `src/oauth/keepalive.ts` — refresh + proactive keepalive
- `src/be/db-queries/oauth.ts` + tables `oauth_apps`, `oauth_tokens` (provider-keyed)
- `src/tracker/types.ts` + tables `tracker_sync`, `tracker_agent_mapping` (provider-keyed)
- `src/http/route-def.ts` + `src/http/trackers/` (one file per provider)
- Prompt-template registry (`registerTemplate`) — same pattern for `jira.issue.*`
- Task source enum (`AgentTaskSourceSchema`) + SQL CHECK — additive migration to add `"jira"`

The work is mostly **replicate-Linear-structure + swap API client + handle Jira-specific quirks**. Main Jira-specific frictions vs Linear are:

1. **cloudId per tenant** — every Jira REST call is `https://api.atlassian.com/ex/jira/{cloudId}/...`. After OAuth, must call `/oauth/token/accessible-resources` to resolve cloudId and store it in `oauth_tokens.scope` or in `oauth_apps.metadata` per install.
2. **Rotating refresh tokens** (90-day inactivity window) — already compatible with the existing `storeOAuthTokens()` update-on-refresh flow, but token exchange responses replace both access AND refresh tokens.
3. **ADF (Atlassian Document Format)** required for comments via REST v3 — need a small plaintext↔ADF converter (or use REST v2 for comment posting as a shortcut).
4. **Webhooks expire after 30 days** — requires a keepalive/refresh loop (`PUT /rest/api/3/webhook/refresh`), or admin-managed webhooks that don't expire but also aren't scoped to the OAuth app.
5. **JQL filter required** on issue/comment webhooks — not "subscribe to everything"; must filter by project.
6. **HMAC signature is opt-in** (Feb 2024 addition via `X-Hub-Signature: sha256=...`) — we should always pass `secret` at webhook registration and verify (same pattern as GitHub/Linear).

No breaking changes are required in existing code. All extension points are additive.

## Detailed Findings

### 1. The Linear integration — blueprint to mirror

**File layout** (`src/linear/`):

| File | Purpose | Jira equivalent? |
|---|---|---|
| `app.ts` | `isLinearEnabled()`, `initLinear()` calls `upsertOAuthApp("linear", {...})` with hardcoded authorize/token URLs + scopes. Also starts outbound sync. (`src/linear/app.ts:19-48`) | **Yes** — same shape, hardcode `https://auth.atlassian.com/authorize` + `https://auth.atlassian.com/oauth/token` + Jira scopes. |
| `oauth.ts` | Wraps `buildAuthorizationUrl` / `exchangeCode` from `src/oauth/wrapper.ts`; `getLinearOAuthConfig()` pulls app row by provider. | **Yes** — mirror, but after token exchange must fetch `/oauth/token/accessible-resources` and persist cloudId. |
| `client.ts` | Singleton `LinearClient` (from `@linear/sdk`) created with bearer token from `getOAuthTokens("linear")`. | **Partial** — no Atlassian SDK in use. Build a small typed `fetch` wrapper with cloudId-scoped base URL and Bearer auth. |
| `webhook.ts` | HMAC-SHA256 verify over raw body using `LINEAR_SIGNING_SECRET`; dedup via `Linear-Delivery` header (in-memory `Map`, 5-min TTL); dispatches to handlers. | **Yes** — identical HMAC pattern. Dedup key = Atlassian `webhookEvent` + `timestamp` + `issue.id` (no single "delivery id" header; synthesize one). |
| `sync.ts` | Event → task: calls `createTaskExtended(..., { source: "linear" })` and inserts into `tracker_sync` keyed by `(provider, entityType, externalId)`. | **Yes** — mirror with `source: "jira"`. |
| `outbound.ts` | Listens to swarm event bus (`task.created/progress/completed/...`) and posts Linear `agentActivityCreate` GraphQL mutations back. 5-second loop-prevention window via `lastSyncOrigin` in `tracker_sync`. | **Yes** — pattern maps 1:1. On Jira side we post **issue comments** (`POST /rest/api/3/issue/{key}/comment`) and optionally transitions. |
| `templates.ts` | Registers `linear.issue.assigned`, `linear.issue.reassigned`, `linear.issue.followup` via `registerTemplate()`. | **Yes** — `jira.issue.assigned`, `jira.issue.commented`, `jira.issue.followup`. |
| `types.ts` | `LinearTokenResponse` interface + domain types. | **Yes** — `JiraTokenResponse`, `JiraAccessibleResource`, webhook payload types. |
| `index.ts` | Public re-exports. | **Yes**. |

**HTTP routes** (`src/http/trackers/linear.ts:12-68`) — four `route()` definitions, all with `auth: { apiKey: false }` for webhook/OAuth endpoints:

- `GET  /api/trackers/linear/authorize` → 302 to Linear consent
- `GET  /api/trackers/linear/callback?code=&state=` → exchanges, stores tokens
- `GET  /api/trackers/linear/status` → connection status, webhook URL
- `POST /api/trackers/linear/webhook` → signature-verified event receiver

Dispatch is chained through `src/http/trackers/index.ts` — currently a single call to `handleLinearTracker`. Adding Jira means adding one line and one handler file.

### 2. Generic OAuth wrapper (already done for Jira shape)

`src/oauth/wrapper.ts` (lines 1-77) provides:

- `buildAuthorizationUrl(config: OAuthProviderConfig)` — PKCE-S256, stores `{codeVerifier, config}` keyed by `state` in-memory (10-min TTL), supports `extraParams` (Linear uses `{ actor: "app" }`; Jira needs `{ audience: "api.atlassian.com", prompt: "consent" }`).
- `exchangeCode(state, code)` — verifies state, exchanges code, persists via `storeOAuthTokens(provider, response)`.
- Under the hood uses `oauth4webapi` (the standards-compliant lib). **PKCE is always on** — safe to use with Jira 3LO even though Jira doesn't mandate PKCE.

**Gotcha to handle in Jira adapter:** after `exchangeCode` returns tokens, we need to call `/oauth/token/accessible-resources` to get `cloudId`. Two shapes are possible:

- Add a post-exchange hook in `oauth.ts` (Jira-specific) that calls the resources endpoint and stores cloudId in `oauth_apps.metadata` (JSON string already supports extensibility — Linear uses `{"actor":"app"}`).
- Or store per-install `{cloudId, siteUrl, accountId}` in `tracker_agent_mapping` or `oauth_tokens.scope` piggyback. Cleanest: extend `OAuthApp.metadata` (already JSON) to hold `{ cloudId, siteUrl }`.

### 3. DB schema — reuse, one additive migration

Existing provider-keyed tables (`src/be/migrations/009_tracker_integration.sql`):

- `oauth_apps(provider UNIQUE, clientId, clientSecret, authorizeUrl, tokenUrl, redirectUri, scopes, metadata)`
- `oauth_tokens(provider UNIQUE FK, accessToken, refreshToken, expiresAt, scope)`
- `tracker_sync(provider, entityType, swarmId, externalId, externalIdentifier, externalUrl, syncDirection, lastSyncOrigin, lastDeliveryId)`
- `tracker_agent_mapping(provider, agentId, externalUserId, agentName)`
- `agent_tasks.source` CHECK constraint — currently includes `'linear'` (migration 009 line 90)

**One new migration needed** (e.g. `046_jira_source.sql`):

- Add `'jira'` to the CHECK constraint on `agent_tasks.source`. SQLite doesn't ALTER CHECK — will need the standard table-rebuild pattern already used elsewhere (see how migration 009 added `'linear'`).
- Also add `'jira'` to `AgentTaskSourceSchema` enum in `src/types.ts:56-67`.
- `TrackerProvider` type in `src/tracker/types.ts:1` currently is `"linear"` only → change to `"linear" | "jira"`.

No new tables needed for v1. cloudId lives in `oauth_apps.metadata`.

### 4. MCP tracker tools — already provider-agnostic

`src/tools/tracker/*.ts` already accept `provider` as a parameter:

- `tracker-link-task.ts` — `createTrackerSync()` (bidirectional)
- `tracker-sync-status.ts` — queries `tracker_sync` filtered by provider
- `tracker-map-agent.ts` — agent ↔ external user mapping
- `tracker-unlink.ts` — remove sync row
- `tracker-status.ts` — connection/token status

Adding `"jira"` as a valid provider in Zod schemas is the only change. No new MCP tools required for v1.

### 5. Webhook signature / verification parity

| Integration | Header | Algorithm | Dedup |
|---|---|---|---|
| GitHub | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 over raw body, timing-safe compare | In-memory 60s TTL |
| GitLab | `X-Gitlab-Token` (plain secret) | Timing-safe string compare | In-memory 60s TTL |
| Linear | HMAC header + `Linear-Delivery` | HMAC-SHA256 over raw body, timing-safe compare (`src/linear/webhook.ts:30-37`) | In-memory 5-min TTL keyed by delivery id |
| **Jira** (planned) | `X-Hub-Signature: sha256=<hex>` (same WebSub scheme as GitHub, added Feb 2024; opt-in via `secret` at registration) | HMAC-SHA256 over raw body | Synthesize `{webhookEvent}:{timestamp}:{issue.id}` as dedup key |

Jira's pattern is **closest to GitHub's**. We can lift GitHub's verification helper almost verbatim; signing secret stored in `JIRA_SIGNING_SECRET` env + optionally mirrored into `swarm_config`.

### 6. Webhook registration lifecycle — the Jira-specific bit

Linear webhook is configured once in Linear's console and lives forever. Jira is different:

- **Dynamic registration** (required for OAuth 3LO apps): `POST /rest/api/3/webhook` on the site (via `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/webhook`). Requires `manage:jira-webhook` scope.
- Body must include `jqlFilter` (required) and `events` array.
- **Webhooks expire after 30 days** — must call `PUT /rest/api/3/webhook/refresh` before expiry.
- Max 5 webhooks per app per user per tenant.

Implication: we need a **webhook lifecycle** component that (a) registers on first OAuth install (or on explicit "connect project" action), (b) stores the webhook id, (c) refreshes every ~25 days. This can live in `src/linear/../jira/webhook-lifecycle.ts` and be driven by a cron/timer similar to `src/oauth/keepalive.ts:*` (which already refreshes tokens on a 12-hour timer).

Store webhook id(s) in a new lightweight table, or piggyback `oauth_apps.metadata` JSON as `{ cloudId, siteUrl, webhookIds: [{id, expiresAt, jql}] }`.

Fallback v0: admin registers the webhook manually in Jira Cloud admin UI (same "click in a console" ergonomics as Linear's webhook). That ships faster but loses auto-install UX.

### 7. Comment format — ADF vs plaintext

Linear accepts plain markdown strings in `agentActivityCreate`. Jira v3 requires **ADF**:

```json
{ "body": { "version": 1, "type": "doc", "content": [
  { "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] }
]}}
```

Two viable paths for v1:

- **Simpler**: post comments via REST v2 (`/rest/api/2/issue/{key}/comment`) with `{ body: "plain text" }`. Still supported. Skips ADF entirely for outbound.
- **Future-proof**: a tiny `text → ADF paragraph[]` helper. For inbound, walk the ADF tree to extract text and `mention` nodes (`attrs.id` = accountId) for bot-mention detection.

Recommend v1 = v2 REST for outbound comments, ADF walker for inbound mention detection.

### 8. Documentation + UI

- Integration guide template: `docs-site/content/docs/(documentation)/guides/linear-integration.mdx` and `github-integration.mdx` — consistent sections (Features → Setup → Config → How It Works → MCP Tools → Architecture → Related). A new `jira-integration.mdx` follows this same template.
- Settings UI: single page `new-ui/src/pages/config/page.tsx`. OAuth flow is triggered by the UI hitting `/api/trackers/{provider}/authorize` and letting the browser redirect. Adding Jira to the UI is an additive change — one more provider card.

### 9. Testing parity

Expected test files (mirroring Linear/GitHub patterns):

- `src/tests/jira-webhook.test.ts` — HMAC verify, dedup, event parsing, status mapping
- `src/tests/jira-outbound-sync.test.ts` — comment posting, loop prevention

Unit tests use isolated SQLite DBs per `CLAUDE.md` testing rules.

## Code References

- `src/linear/app.ts:19-48` — init pattern (hardcoded OAuth URLs, `upsertOAuthApp`)
- `src/linear/oauth.ts` — thin wrapper over generic OAuth
- `src/linear/webhook.ts:30-37` — HMAC-SHA256 timing-safe verify
- `src/linear/sync.ts:332, 575` — webhook → `createTaskExtended({ source: "linear" })`
- `src/linear/outbound.ts` — event bus listener → GraphQL comment-back
- `src/linear/templates.ts` — three prompt templates registered at load
- `src/http/trackers/linear.ts:12-68` — four `route()` definitions (authorize / callback / status / webhook)
- `src/http/trackers/index.ts:1-10` — dispatch chain (extend here for Jira)
- `src/oauth/wrapper.ts:45-77` — PKCE-S256 URL builder (generic, already Jira-ready)
- `src/oauth/ensure-token.ts` — 5-min-buffer refresh
- `src/oauth/keepalive.ts` — 12-hour proactive token refresh timer (pattern for webhook lifecycle)
- `src/tracker/types.ts:1` — `TrackerProvider` union (extend with `"jira"`)
- `src/types.ts:56-67` — `AgentTaskSourceSchema` (add `"jira"`)
- `src/be/migrations/009_tracker_integration.sql` — baseline tracker schema + source CHECK (note: migration 009 added `'linear'` via table-rebuild)
- `src/be/db-queries/oauth.ts` — `upsertOAuthApp`, `getOAuthApp`, `storeOAuthTokens`, `getOAuthTokens`, `isTokenExpiringSoon`
- `src/tools/tracker/*.ts` — provider-agnostic MCP tools (accept `provider` arg)
- `docs-site/content/docs/(documentation)/guides/linear-integration.mdx` — doc template

## Jira Cloud API Essentials (for integration design)

**OAuth 2.0 (3LO)**:

- Authorize: `https://auth.atlassian.com/authorize` — params: `audience=api.atlassian.com`, `client_id`, `scope` (space-separated), `redirect_uri`, `state`, `response_type=code`, `prompt=consent`.
- Token: `https://auth.atlassian.com/oauth/token` — `authorization_code` + `refresh_token` grants. Access token TTL 1h. Refresh tokens rotate (enable in dev console); each use issues a new one, old one invalidates immediately. 90-day inactivity window.
- Post-auth: `GET https://api.atlassian.com/oauth/token/accessible-resources` → `[{ id: cloudId, url, scopes, avatarUrl, name }]`.
- Scopes for v1: `read:jira-work`, `write:jira-work`, `manage:jira-webhook`, `offline_access`, `read:me`.

**Webhooks**:

- `POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/webhook` — body `{ url, webhooks: [{ events, jqlFilter }] }`. Requires `manage:jira-webhook`.
- `PUT .../rest/api/3/webhook/refresh` — must call before 30-day expiry.
- Signature: pass `secret` at registration; Jira sends `X-Hub-Signature: sha256=<hex>`.
- Events: `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `comment_created`, `comment_updated`.
- Payload: `{ timestamp, webhookEvent, user, issue, changelog?, comment? }`. No retry guarantees — consumers must be idempotent.

**REST basics**:

- Base: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`
- `GET /issue/{key}` — fetch.
- `POST /issue/{key}/comment` — v3 needs ADF body; v2 accepts plain text.
- `POST /issue/{key}/transitions` — transition after `GET /issue/{key}/transitions` to list.
- `POST /search/jql` (new) or `GET /search` (legacy being deprecated).
- Rate limits: points-based; respect `429 Retry-After`.

**Auth alternative** for single-user scripts: email + API token (HTTP Basic). Not suitable for multi-install UX; mention in docs only.

## Proposed Integration Shape (Linear-equivalent, basic)

**Directory**: `src/jira/`

- `app.ts` — `isJiraEnabled()`, `initJira()` (upsert OAuth app with Atlassian URLs + scopes, start outbound sync + webhook refresh timer).
- `oauth.ts` — `getJiraAuthorizationUrl()`, `handleJiraCallback()` (calls generic wrapper, then `/accessible-resources` to resolve cloudId, stores into `oauth_apps.metadata`).
- `client.ts` — typed `fetch` wrapper with cloudId-scoped base URL, Bearer auth, token-refresh-on-401.
- `webhook.ts` — HMAC-SHA256 verify (clone GitHub verifier), dedup map, event dispatch to `handleIssueEvent` / `handleCommentEvent`.
- `webhook-lifecycle.ts` — register webhook on first install; refresh every 25 days (timer pattern from `src/oauth/keepalive.ts`).
- `sync.ts` — inbound: issue/comment → `createTaskExtended({ source: "jira" })` + `tracker_sync` row.
- `outbound.ts` — event bus listener → POST comment (v2 REST, plain text) back to Jira.
- `templates.ts` — `jira.issue.assigned`, `jira.issue.commented`, `jira.issue.followup`.
- `types.ts` — `JiraTokenResponse`, `JiraAccessibleResource`, webhook payload shapes.
- `index.ts` — `initJira`, `isJiraEnabled`, `resetJira`.

**HTTP routes** (`src/http/trackers/jira.ts`, 4 `route()` defs mirroring Linear):

- `GET  /api/trackers/jira/authorize`
- `GET  /api/trackers/jira/callback`
- `GET  /api/trackers/jira/status`
- `POST /api/trackers/jira/webhook`

Wire in via `src/http/trackers/index.ts` (one added call).

**DB**: one migration adding `'jira'` to `AgentTaskSourceSchema` enum and `agent_tasks.source` CHECK (SQLite table-rebuild pattern, see how 009 added `'linear'`).

**Env vars** (follow Linear convention):

- `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` — OAuth app (from Atlassian developer console).
- `JIRA_REDIRECT_URI` — defaults to `http://localhost:{PORT}/api/trackers/jira/callback`.
- `JIRA_SIGNING_SECRET` — webhook HMAC secret (passed to Jira at webhook registration and verified per delivery).
- `JIRA_DISABLE` / `JIRA_ENABLED` — feature flags.

**MCP tools**: no new tools. Extend provider enum in `src/tools/tracker/*.ts` Zod schemas to accept `"jira"`.

**Docs**: `docs-site/content/docs/(documentation)/guides/jira-integration.mdx` — same sections as Linear guide. Regenerate OpenAPI if new routes ship: `bun run docs:openapi`.

**Tests**: `src/tests/jira-webhook.test.ts`, `src/tests/jira-outbound-sync.test.ts`.

## Decisions for Planning Phase

These were open questions at research time; resolved by Taras via file-review.

- **Webhook registration UX — support both.** v1 ships both paths:
  - **Auto-register via API** on OAuth connect (requires `manage:jira-webhook` scope + ~25-day refresh timer using `PUT /rest/api/3/webhook/refresh`). Preferred Linear-equivalent UX.
  - **Manual admin-registered webhook** as a fallback for users who don't want to grant `manage:jira-webhook`, or for environments where dynamic registration isn't possible. The `POST /api/trackers/jira/webhook` endpoint and `JIRA_SIGNING_SECRET` verification path work identically for both.
  - Store registered webhook ids + expiries in `oauth_apps.metadata` JSON (alongside `cloudId`, `siteUrl`).
- **Comment format — v2 REST (plain text) for v1 outbound.** Skip ADF for outbound. Inbound still needs an ADF walker to extract text + detect bot mentions (`mention` nodes with `attrs.id` = bot's `accountId`).
- **Multi-workspace — single workspace per swarm install for v1.** One `cloudId` per install, stored in `oauth_apps.metadata.cloudId`. Mirrors Linear. Multi-workspace is a v2 concern.
- **Assignee / agent mapping — via `tracker_agent_mapping`.** Key `externalUserId` = Atlassian `accountId`. Inbound mention detection = walk ADF `mention` nodes on comment bodies.
- **Transitions — match Linear's behavior.** Linear's outbound sync posts `agentActivityCreate` GraphQL activities (thought/action/response/error) and ends the `AgentSession` on task completion; it does not transition the underlying Linear issue's workflow state. For Jira v1, mirror that — post comments back (including an end-of-task summary comment), but do not call `POST /transitions` on the Jira issue. If Linear later adds status transitions, Jira follows.

## Related Research

- `thoughts/taras/research/2026-03-18-linear-integration-finalization.md` — Linear integration finalization notes (most directly relevant prior art).
- `thoughts/taras/research/2026-03-16-route-wrapper-openapi.md` — how `route()` factory + OpenAPI generation works.
- `thoughts/taras/research/2026-03-16-openapi-docs-generation.md` — OpenAPI freshness workflow (important for any new HTTP route).
