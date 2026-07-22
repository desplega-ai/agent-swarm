---
date: 2026-07-21T12:31:05+0200
author: taras
topic: "Connections feature redesign — unified OAuth, embedded auth, spec baseUrl extraction, curated integrations"
tags: [brainstorm, script-connections, oauth, credentials, security]
status: complete
exploration_type: problem
last_updated: 2026-07-21
last_updated_by: taras
---

# Connections Feature Redesign — Brainstorm

## Context

The script-connections MVP (PR #934, merged 2026-07-09, migrations 111/112) shipped with three pain points Taras identified from real usage:

1. **Spec baseUrl/paths not used** — the backend never reads the spec's own server declaration.
2. **OAuth apps poorly factored & tedious** — an app should be clientId + secret + config (encrypted); authorizations should be N-per-app, not hard-wired 1-1.
3. **connection ↔ binding ↔ credential triad is too tedious** to set up.

### Research findings (from three parallel codebase-analysis passes, 2026-07-21)

**baseUrl/paths (point 1):** Runtime URL joining is correct (`operationUrl` in `src/scripts-runtime/api-client.ts:72` preserves base-path prefixes; tested). The gap is upstream: `extractOperations()` (`src/be/script-connections.ts:487-598`) only reads `spec.paths` — never OpenAPI 3 `servers[].url` nor Swagger 2 `host`/`basePath`/`schemes`. Effective `baseUrl` is exclusively the user-typed field; only the apis.guru catalog UI flow auto-fills it (client-side). `refreshScriptConnection()` keeps the stale stored baseUrl even when a re-fetched spec's server URL changed. No test covers spec-declared servers.

**OAuth (point 2):** Script-connections OAuth reuses the Linear/Jira tracker tables from migration 009 (`oauth_apps` / `oauth_tokens`):
- `provider` is `UNIQUE` on **both** tables + FK → app→authorization is a hard 1-1 at DB level; a second authorization overwrites the first (`ON CONFLICT(provider) DO UPDATE`).
- `clientSecret` and tokens stored **plaintext** (`TODO(secrets-cipher)` in `src/be/db-queries/oauth.ts:116`).
- Pending PKCE state lives in an **in-memory map** (`src/oauth/wrapper.ts:56-67`) — lost on restart, broken multi-instance.
- Bindings reference apps via bare `oauth_provider` string — no FK, no existence check.
- Refresh: on-demand (5-min buffer) via `resolveOAuthBindingToken` + cross-process lock (`oauth_refresh_locks`, migration 077) + 15-min background sweep with 7-day keep-alive (`src/be/oauth-refresh-sweep.ts`).
- **Three separate OAuth stacks exist**: (a) generic tracker OAuth (009, reused by connections), (b) MCP OAuth (migration 041 — DCR, per-`(mcpServerId, userId)` rows, DB-persisted PKCE pending state, AES-256-GCM via `SECRETS_ENCRYPTION_KEY` — the healthiest), (c) Codex keep-warm (provider-specific, unrelated).

**Triad (point 3):** `script_connections` → nullable FK → `script_credential_bindings` (template rule: `[REDACTED:KEY]` placeholder, allowed hosts, header/query template) → secret material lives in a *third* place (`swarm_config` for `authKind:config`, `oauth_tokens` for oauth). OAuth setup today = up to 5 sequential calls (oauth-app-upsert → authorize-url → browser dance → binding upsert → connection upsert). Inline binding creation exists but keys off `configKey` presence, so OAuth bindings can't be inlined. `kind:mcp` connections accept binding fields in the schema but ignore them. Secret substitution happens in the sandbox's patched `fetch` (egress layer, host-scoped) — generated clients only ever embed the placeholder.

### Incorporated: curated-connections design doc (agent-fs)

Source: agent-fs `thoughts/16990304-76e4-4017-b991-f3e37b34cf73/plans/2026-07-21-curated-connections-design.md` (researcher proposal, 2026-07-21). Facts it adds that this brainstorm builds on:

- **An integrations catalog already exists** — `GET /api/integrations-catalog` is a live proxy to `https://integrations.sh/api.json` (1h TTL) with a per-domain `/surface` endpoint (spec URL, docs, auth mechanics, credential setup hints); `catalog-browser.tsx` already curation-boosts non-apis.guru entries. The "in-repo catalog" decision therefore means: an in-repo **blessed manifest** merged *into* the existing catalog response (tag `feeds:["blessed"]`, ranks top), with integrations.sh kept as long-tail discovery — not a new catalog system.
- **`.well-known` OAuth discovery already exists** (`POST /api/oauth-apps/discover`, RFC 8414 + OIDC) but can't fill API scopes (Google's OIDC config advertises `openid email profile`, not Gmail scopes) and fails for non-RFC-8414 providers → static presets are complementary, discovery stays the fallback.
- **OAuth presets** = `src/oauth/presets.ts` static table generalizing the hardcoded Jira/Linear builders: per provider `authorizeUrl/tokenUrl/scopes/scopeSeparator/tokenAuthStyle/tokenBodyFormat/extraParams` (Google: `access_type=offline`, `prompt=consent`), user supplies only their own `clientId`+`clientSecret`. PKCE is always-on; no preset field needed.
- **Vendored specs**: `openapi_spec_source_kind` has a reserved-but-inert `agent_fs` value; proposal adds a real `vendored` source + top-level `vendored-openapi/` dir (trimmed, git-pinned, code-reviewed specs) + `scripts/refresh-vendored-openapi.ts` (modelsdev-pricing pattern) + manifest.
- **Phase-0 bug**: the inline-binding path defaults an `Authorization: Bearer` header even when only a `queryTemplate` is given — query-only auth is impossible to register today.
- **Multi-tenant blocker it flags** — `oauth_apps.provider` global-UNIQUE prevents two customers registering `google-gmail` — is already solved by this redesign (apps keyed by id, no unique-per-provider, N authorizations).
- Its per-provider redirect URI (`/api/oauth/<provider>/callback`) is **superseded** by our single-static-callback decision.
- **Never ship a shared Desplega client secret** — customers always bring their own OAuth app credentials. Adopted as a decision.

## Exploration

### Q: Migration aggressiveness — prod usage is non-zero; restructure outright or maintain compat?
Restructure with a data-migration script that runs at start (repo already auto-applies forward-only migrations on startup; encrypting existing plaintext rows will need a TS-side backfill step since SQL migrations can't invoke the cipher).

**Insights:** Frees the schema design from compat constraints; old rows (apps, tokens, bindings) get carried into the new shape at boot.

### Q: Why multiple authorizations per app — what's the concrete use case?
Google OAuth app, two inboxes → two authorizations → two connections: `ctx.api.gmailSupport` and `ctx.api.gmailSales`.

**Insights:** Authorizations need identity: a label/slug, and ideally the granted account info (email from userinfo/id_token) so you can tell which inbox is which. Connections reference a *specific authorization*, not a provider string.

### Q: Scope of OAuth unification?
Single clean system for everything. Must also: (a) guarantee correct refresh behavior, (b) surface the redirect URL at app-creation time (today it's computed server-side and only visible after POST — but you need it *before*, to register the app in the provider's console).

**Insights:** Redirect-URL-before-creation pushes toward a single static callback URL (state-keyed) or a deterministic per-slug URL shown live in the UI.

### Q: Encrypt at rest?
Yes — reuse `secrets-cipher` (`SECRETS_ENCRYPTION_KEY`) as migration 041 already does.

### Q: Provider quirks (e.g. Google refresh tokens)?
Google needs extra authorize-URL params (`access_type=offline`, `prompt=consent`) to issue refresh tokens at all — this must be hinted via **curated integrations** so users don't discover it after their tokens stop refreshing. (Same bucket: Jira refresh-token rotation, per-provider `tokenAuthStyle`/`tokenBodyFormat` quirks already special-cased in `src/oauth/wrapper.ts`.)

### Q: Connection auth — embedded or separate credential entity?
**Embed on connection**: connection carries auth inline — `{type: bearer|header|query, secretRef}` or `{type: oauth, authorizationId}`. Header template + allowed hosts derived automatically from the auth type + baseUrl, with an escape hatch for weird APIs. Standalone host-scoped bindings survive only for raw `fetch()` scripts.

**Insights:** Happy path becomes: app → authorize (×N) → connection (×N). The binding object disappears from the user-facing model and becomes an internal egress-layer detail.

### Q: MCP OAuth (DCR stack, migration 041) — fold in now or follow-up?
**Fold in now** — one unified system in this redesign, all three stacks (generic/tracker, MCP-DCR, connections) on the same core.

**Insights:** Larger blast radius (DCR client registration, per-server tokens, pending-state table) but ends the three-stacks problem in one move. DCR-registered clients presumably become `oauth_apps` rows with a `source: dcr` marker; MCP servers' token resolution reads the unified authorizations table.

### Q: Where does access scoping live — connection, authorization, or ownership/RBAC?
Connection-only for now; user/role-level scopes are a likely future iteration, so the schema shouldn't preclude them.

**Insights:** Authorizations stay global lead-managed vault entries in v1. Leave room for a later owner/role column (nullable, unused now) rather than baking a second scoping layer in immediately. RBAC increment-5 (MCP tool admission) is a natural place to add verbs later.

### Q: Callback / redirect URL design?
**One static callback**: `${PUBLIC_MCP_BASE_URL}/api/oauth/callback` for all apps. Pending-authorization state moves to a DB table (like MCP OAuth's `mcp_oauth_pending`) mapping `state` → app + authorization label + PKCE verifier. The URL is a constant — displayable in UI/docs before any app exists, registered once per provider console, multi-instance safe.

**Insights:** This also fixes the in-memory PKCE map fragility as a side effect. Legacy `/api/oauth/{provider}/callback` routes can 301/keep-working during transition via the data migration.

### Q: Where do non-OAuth secrets live when auth is embedded on the connection?
Always in `swarm_config`, for consistency — with a derived key convention. Agreed shape: connection upsert *accepts* the secret inline (`{auth: {type: bearer, secret: "..."}}`) but persists it into swarm_config under `connection.<slug>.secret` (write-only, encrypted, scrubber-covered) and stores only the reference. Passing an explicit `configKey` remains supported for shared/rotated secrets. Both paths end in swarm_config.

**Insights:** One-call setup without a second secret store; rotation story stays centralized; the egress fetch-patch keeps resolving from swarm_config exactly as today.

### Q: Curated integrations catalog — delivery mechanism?
In-repo and version-controlled (typed source, bundled to JSON at build), **served by a swarm API route** (e.g. `GET /api/integrations/catalog`) so the UI and tools fetch it from the API. No DB table. `.well-known` discovery remains the fallback for uncatalogued providers.

**Insights:** Version-controlled + reviewable like option 1, but consumers have a single runtime source (the API) rather than importing the module — keeps apps/ui decoupled and lets MCP tools surface the same hints.

### Q: What are credential bindings actually useful for — do we need them?
They are two things fused: (a) the **security mechanism** — scripts only ever see the `[REDACTED:KEY]` placeholder; the patched fetch substitutes the real secret at egress and only toward `allowedHosts` (the exfiltration guard) — this stays, non-negotiable; (b) the **user-facing entity** — for connections it's fully derivable (hosts from baseUrl, template from auth type, key from the derived-key convention), so it disappears from the connection flow ("already handled in the bg").

**Resolution:** For spec-less cases Taras' framing is that no connection is possible ("a connection implies an OpenAPI/GraphQL/MCP spec"), so the standalone binding surface **stays, but only for raw `fetch()` egress** — an advanced/optional concept. Connections auto-manage their own substitution rules internally. (Note for the record: schema-wise a standalone binding and a spec-less "raw connection" are the same record — {hosts, secret ref, template}; this is a naming/product decision, not a data-model one. Claude preferred one concept; Taras kept bindings for the spec-less case.)

### Q: Remaining open calls (tackled at review time)
- **baseUrl precedence → provenance model.** Store whether `baseUrl` is spec-derived or user-set. Spec value prefills; explicit user value wins with a visible mismatch warning; `refresh` auto-updates only spec-derived values and never clobbers a user override.
- **Tracker fold-in → full fold.** Linear/Jira become curated presets on the unified core; `/api/trackers/*` OAuth routes become thin wrappers; the reserved-provider carve-out (`linear`/`jira`) disappears; tracker task-sync reads tokens from the unified store.
- **Self-serve → lead-only for v1.** Curated setup stays behind `script-connection.manage`; self-serve is revisited when user/role scoping lands.
- **Vendored specs → vendor + trim.** Blessed manifest authoritative and in-repo; specs vendored trimmed to the blessed operation set; refresh script + CI drift check; integrations.sh proxy stays for the long tail.

## Target model (converged)

- **`oauth_apps`** — clientId, clientSecret (encrypted), authorizeUrl/tokenUrl, scopes, extra authorize params, provider quirks, source (`manual | dcr | curated-prefill`). No UNIQUE-per-provider constraint.
- **`oauth_authorizations`** — N per app: id, appId FK, label (e.g. `support-inbox`), granted account identity (email from userinfo/id_token where available), accessToken/refreshToken (encrypted), expiresAt, scope, status (`active | refresh-failed | revoked`). Refresh locks + background sweep keyed by authorization id.
- **`oauth_pending`** — DB-persisted PKCE/state rows (replaces the in-memory map): state → appId + target authorization label + code verifier + TTL. Single static callback `${PUBLIC_MCP_BASE_URL}/api/oauth/callback`.
- **`script_connections`** — embeds auth inline: `{type: bearer|header|query, secret (inline, → swarm_config derived key) | configKey}` or `{type: oauth, authorizationId}`. Header template + allowedHosts derived from auth type + baseUrl, with escape-hatch overrides. `baseUrl` defaulted from spec `servers[]` / `host`+`basePath`, reconciled on refresh.
- **`script_credential_bindings`** — auto-managed for connections (internal); standalone user-facing surface retained only for spec-less raw `fetch()` egress.
- **Curated integrations catalog** — in-repo typed source bundled to JSON, served via API route (e.g. `GET /api/integrations/catalog`); presets for Google, Slack, GitHub, Jira, Linear, … with endpoints + quirk hints (Google `access_type=offline&prompt=consent`, Jira refresh-token rotation, tokenAuthStyle/tokenBodyFormat). `.well-known` discovery as fallback.
- **Startup data migration** — SQL migration + TS-side backfill (encryption needs the cipher): carries 009-era apps/tokens (→ app + one `default` authorization each), 041 MCP-DCR clients/tokens (→ apps with `source: dcr` + per-server authorizations), existing bindings (oauth_provider strings → authorizationIds); retires the legacy `SCRIPT_CREDENTIAL_BINDINGS` swarm-config JSON-blob store; keeps old per-provider callback routes working during transition.

## Synthesis

### Key Decisions
- **Restructure outright** — no compat dance; a startup data migration carries all existing rows (prod usage is non-zero but small).
- **App ↔ authorization is 1:N** — app = client credentials + endpoints + quirks; authorization = one granted account (label + identity + tokens). Connections reference an `authorizationId`, never a provider string. Gmail case: 1 app, 2 authorizations, 2 connections (`ctx.api.gmailSupport`, `ctx.api.gmailSales`).
- **One OAuth core for all three stacks** — generic/tracker (009), MCP-DCR (041), connections — folded in this redesign, not a follow-up.
- **Encrypted at rest everywhere** — client secrets, tokens, pending state — via `secrets-cipher` / `SECRETS_ENCRYPTION_KEY` (pattern already proven by migration 041).
- **Single static callback URL**, DB-persisted PKCE state; redirect URL displayable *before* app creation (fixes the register-in-provider-console-first chicken-and-egg).
- **Auth embedded on connection**; templates/hosts derived; binding entity vanishes from the connection flow.
- **Secrets always in swarm_config** — inline secret accepted at upsert but persisted under derived key `connection.<slug>.secret` (write-only, scrubber-covered); explicit `configKey` supported for shared/rotated secrets.
- **Standalone bindings survive only for spec-less raw fetch()** (advanced concept); auto-managed internally otherwise.
- **Curated catalog in-repo, API-served, no DB** — version-controlled JSON bundle behind a route.
- **Spec server extraction** — read OpenAPI 3 `servers[]` / Swagger 2 `host`+`basePath`+`schemes` at upsert and refresh; use as default `baseUrl`.
- **Scoping stays connection-level for v1**; schema leaves room for user/role-level scoping later (aligns with RBAC roadmap).
- **baseUrl provenance model** — spec-derived prefill, user override wins with warning, refresh only updates spec-derived values.
- **Full tracker fold** — Linear/Jira as curated presets on the unified core; carve-out removed.
- **Lead-only setup in v1** — self-serve deferred to user/role scoping.
- **Vendor + trim blessed specs** (`vendored-openapi/`, refresh script, CI drift check); integrations.sh proxy stays for long-tail discovery; blessed manifest merged into the existing catalog route.
- **Customers bring their own OAuth client credentials** — a shared Desplega client secret is never shipped.

### Resolved at review (2026-07-21)
- **baseUrl precedence:** provenance model — spec-derived vs user-set tracked; user override wins with warning; refresh updates only spec-derived values.
- **Tracker fold-in:** full fold — presets + thin wrapper routes, carve-out removed.
- **Self-serve:** lead-only for v1; revisit with user/role scoping.
- **Vendored specs:** vendor + trim blessed subset; integrations.sh stays long-tail.
- **MCP-DCR mapping (proposed):** DCR-registered clients become `oauth_apps` rows (`source: dcr`, one per MCP server); their tokens become `oauth_authorizations` preserving effective `(serverId, userId)` uniqueness via one authorization per server (userId dimension kept nullable for the future per-user extension). `mcp_servers` auth resolution reads the unified tables.
- **Account identity capture (proposed):** best-effort — curated presets may carry a `userinfo` endpoint hint; authorization stores whatever identity we can get (email/login), else just the label.
- **RBAC (proposed):** new `oauth-app.manage` + `oauth-authorization.manage` verbs (registered per the increment-3/5 machinery); connection/binding routes keep their existing verbs.
- **Refresh-failure semantics (proposed):** authorization `status` flips to `refresh-failed`; scripts get a typed, explicit error (not a silent missing-credential drop); UI badges the authorization and its dependent connections.

### Open Questions
- Is `integrations.sh` Desplega-owned? If yes, the blessed manifest could be *generated from* it (single source of truth) rather than hand-maintained.

### Constraints Identified
- SQL migrations can't invoke the cipher → encrypting existing plaintext rows needs a TS-side startup backfill step (one-shot, idempotent).
- Static callback depends on `PUBLIC_MCP_BASE_URL` being correct (URL env model from PR #643).
- SSRF checks on user-supplied authorize/token/base URLs must remain fail-closed.
- API server is sole DB owner; all worker/tool access over HTTP (CI-enforced boundary).
- All new/changed routes via `route()` factory with RBAC posture + `bun run docs:openapi` regen.
- The egress substitution + host-allowlist guard is security-critical and must survive the refactor unchanged in behavior (scripts never see raw secrets).
- Migration numbering starts at the next free slot (≥117; 113–116 already exist).

### Core Requirements
1. Spec-declared server URL extracted and used (upsert + refresh), with tests covering `servers[]` and `host`/`basePath` variants; provenance-tracked baseUrl.
2. `oauth_apps` / `oauth_authorizations` (1:N) with labels + account identity, per-authorization refresh locks/sweep/rotation, keep-alive preserved. **Everything secret encrypted at rest — explicitly including `clientSecret`** (plaintext today, `TODO(secrets-cipher)` in `src/be/db-queries/oauth.ts`), access/refresh tokens, and pending PKCE state.
3. Single static callback + DB pending state; redirect URL visible pre-creation in UI and via API.
4. Connection upsert embeds auth in one call (inline secret → derived swarm_config key, or configKey, or authorizationId); derived templates/hosts with overrides.
5. Curated integrations catalog: in-repo, bundled JSON, served by API route, consumed by UI picker / discover / MCP tools; carries Google offline-access params and other quirks.
6. All three OAuth stacks unified on one core; Linear/Jira and MCP-DCR run through it.
7. **Zero-manual-step upgrade**: the schema + data migration auto-runs at API start (forward-only SQL + idempotent TS backfill for encryption); every existing row (009 apps/tokens, 041 MCP tokens, bindings, legacy JSON-blob store) is carried over; old per-provider callback routes and the existing binding tool surface keep working during the transition — no operator action required.
8. Bindings auto-managed for connections; standalone surface only for raw fetch().
9. UI: single-flow connection creation; OAuth app page shows redirect URL upfront and lists authorizations with labels/accounts + status.
10. Curated layer per the agent-fs design doc: in-repo blessed manifest merged into the existing `/api/integrations-catalog` response; `vendored-openapi/` trimmed specs (new `vendored` source kind) + refresh script + CI drift check; `src/oauth/presets.ts` preset table hydrating oauth-app creation (user supplies only clientId/clientSecret; never ship a shared Desplega secret).
11. Fix the Phase-0 bug: query-only auth must not default an `Authorization: Bearer` header.

## Next Steps

- Review comments processed 2026-07-21 (agent-fs curated-connections doc incorporated; open questions resolved; backward-compat + clientSecret-encryption requirements made explicit).
- Parked 2026-07-21 — pick up with `/desplega:create-plan` using this doc as input; in-session research is captured above (file:line pointers), so a separate research pass is likely unnecessary.
