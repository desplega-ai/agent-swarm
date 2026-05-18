---
date: 2026-05-12T00:00:00Z
author: Taras
topic: "DB-backed pages — simplified static artifact alternative"
tags: [brainstorm, artifacts, pages, ui, mcp]
status: parked
exploration_type: idea
last_updated: 2026-05-12
last_updated_by: Claude
---

# DB-backed pages — Brainstorm

## Context

Taras wants a **lighter-weight alternative to the existing artifact servers** (`src/artifact-sdk/`, `src/commands/artifact.ts`, `plugin/skills/artifacts/skill.md`). Current artifacts spin up a Bun+Hono process per artifact, allocate a port, open a localtunnel to `lt.desplega.ai`, and register a row in the `services` registry. Great for live apps with backend logic; massive overkill for the ~80% case of "agent emits a rendered report or status JSON."

Proposal: agents emit **HTML or JSON blobs** that the API stores in a single SQLite table and serves directly. No PM2, no tunnel, no port allocation, no service registry row. Two delivery surfaces:

1. **Raw API** (`/p/:id`) — serves the body directly with its `Content-Type`.
2. **UI-routed** (`/artifacts/:id` in the `ui/` SPA) — fetches metadata and renders:
   - `text/html` → sandboxed iframe.
   - `application/json` → declarative renderer (json-render.dev-style component tree).

### Decisions already locked

- **Name**: `pages`.
- **Auth modes**: `public` / `authed` (reuse UI auth) / `password`.
- **DB-backed**: single SQLite table, no PM2, no service registry, no tunnel.
- **Schema sketch**: `id` (ulid), `slug`, `agent_id`, `content_type`, `body`, `auth_mode`, `password_hash`, timestamps.
- **Routes**: `POST/PUT/GET/DELETE /api/pages` + public `GET /p/:id` + `GET /p/:id.json` for the UI renderer.
- **MCP tool**: `create_page` — worker → HTTP, never imports `bun:sqlite` (architecture invariant holds).

### Open items flagged for this brainstorm

1. UI auth mechanics — how does `ui/` actually authenticate today?
2. json-render.dev schema — vendor / fork / invent?
3. HTML sandbox policy — `sandbox="allow-scripts"` default vs stricter?
4. Password UX — `?key=<pw>` query param vs form + signed cookie?
5. Naming the table — `pages` vs namespaced.
6. Update semantics — overwrite-by-slug, versioning, history?
7. Size cap / quota.
8. JSON renderer ↔ API interaction — does the renderer get the user's session passed through?
9. Cleanup / TTL / agent lifecycle — when an agent dies, do pages survive?
10. Listing UX in the UI — per-agent inbox, swarm-wide gallery, or both?
11. Slack share link experience — link shape, recipient view.

### Recon findings (added by Claude before exploration)

- `ui/` is **Vite + React + react-router** (SPA), NOT Next.js. Confirmed via `vite.config.ts`, `index.html`, `tsconfig.app.json`, `react-router@7` in lock.
- Auth pattern: user enters `apiUrl + apiKey` into the SPA. `apiKey` is stored in `localStorage` (deployment-namespaced via `use-config.ts`, `current-user-context.tsx`). Every request to the API sends `Authorization: Bearer ${apiKey}`.
- **No shared session cookie** between UI and API. There is no `getServerSession`-equivalent server context — the API only knows bearer tokens. This breaks the earlier sketch's "reuse UI session cookie" assumption for the `/p/:id` `authed` mode.
- Implication: an `authed` page can only be served via the UI route (where the SPA has the apiKey in localStorage to attach). A direct request to `/p/:id` from a browser opened from Slack will have NO credentials. So `authed` effectively means *"must go through the UI shell which holds the bearer"*.

## Exploration

### Q1: Given the UI is a SPA holding the apiKey in localStorage (no API-side session cookie), how should the `authed` mode actually work?

**Taras**: "Yeah we could do 1 [UI-shell-only], for the html rendering we could just do an iframe tbh."

**Insights:**
- `authed` mode = the SPA `/artifacts/:id` route is the only entry point. Direct `/p/:id` returns 401 for non-public pages. The SPA attaches the bearer from localStorage when fetching `/p/:id.json`.
- HTML inside the UI is rendered as an **iframe** (Taras confirmed). Open sub-question: does the iframe use `src="/p/:id"` (requires the iframe context to attach credentials — only viable for `public` pages) or `srcdoc="<html string>"` (SPA fetches body first, then injects)? Likely **always-srcdoc for `authed`/`password`** and `src` is fine for `public`.
- For Slack share links: `authed` link points at `https://<ui-host>/artifacts/<id>`. If the recipient has the SPA configured (apiKey in localStorage), it renders. Otherwise the SPA shows its connection-setup flow first. Acceptable.

### Q2: Scope of interactivity for JSON pages?

**Taras**: "Display + declared actions (buttons / simple forms that call swarm API)."

**Insights:**
- JSON pages get to declare interactive elements (buttons, forms) that the renderer wires up to the swarm API using the user's bearer.
- HTML pages remain the fully-flexible escape hatch (iframe + agent's own JS).
- This locks the JSON renderer's responsibilities: render components + dispatch declared actions. Non-trivial but bounded.
- Cascade decisions: action schema, allowlist of callable endpoints, post-action feedback (toast / refresh / result block), form validation, CSRF/cross-origin gating.

### Q3: What API surface should JSON page actions be allowed to hit?

**Taras**: "Mix of 1 and 2 tbh — as far as it's authed it could interact w the API, or it could ask for credentials (swarm would need to offer a way to add those). Check https://thariqs.github.io/html-effectiveness/"

**Insights:**
- Action surface model:
  - **Authed pages**: actions can hit any `/api/*` endpoint with the user's bearer. Trust model = the agent who created the page is trusted enough that we let them act as the viewer. Mirrors what agents can already do via direct MCP calls.
  - **Public pages or third-party APIs**: page can declare `needs_credentials: [...]`, swarm UI provides a capture flow, renderer attaches them.
- JSON action shape: inline `{method, endpoint, body}` (option 2), no server-side named action registry needed for v1. Simpler MCP tool contract.
- **New surface to design**: page-declared credential capture. Where do these credentials live (page-local? user-global? swarm-wide credential pool?), what UX for capture, what storage. Likely v1.x or v2 unless we keep it minimal.
- Linked ref: `thariqs.github.io/html-effectiveness` — argument for HTML-as-LLM-UI. Reinforces "HTML+iframe is the escape hatch" decision.
- Risk note: if the agent is compromised, an authed page can embed destructive actions. Accepted — same blast radius as the agent already has via MCP. Worth a one-paragraph warning in the skill doc.

### Q4: How should pages relate to the creating agent and its tasks over time?

**Taras**: "We should do 1 with versioning (like the workflows)."

**Insights:**
- **Object-like with versioning**, mirroring the existing workflows model (`Workflow` + `WorkflowVersion` types are referenced in `ui/src/api/client.ts`).
- Two-table schema:
  - `pages` table holds the stable identity: `id` (ulid, the public URL token), `agent_id`, `slug`, `head_version`, timestamps. `UNIQUE (agent_id, slug)`.
  - `page_versions` table holds content per version: `id` (ulid), `page_id`, `version` (int), `content_type`, `body`, `auth_mode`, `password_hash`, `created_at`.
  - `UNIQUE (page_id, version)`.
- `create_page` with same `(agent_id, slug)` creates a new version, bumps `head_version`.
- Public URL: `/p/:id` serves head; `/p/:id?v=N` serves a specific version.
- Slugs are agent-scoped (not globally unique). The public ulid keeps URLs collision-free and avoids leaking slug semantics.
- Cleanup: pages survive agent death. Manual delete via UI / MCP tool. No TTL in v1.
- Storage growth: every overwrite stores a new full copy. Add a size cap (later question) to bound abuse.

### Q5: What metadata should agents provide when creating a page?

**Taras**: "Explicit `title` (required) + optional `description` columns."

**Insights:**
- Schema gains `title` (NOT NULL) and `description` (nullable) on `page_versions` (so they're versioned alongside body).
- Title is shown in listings, browser tab, Slack-link preview (if we add OG tags later).
- Description is the listing subtitle — one-liner. Agents may leave it null.
- Listing UX is in v1 (implied — these columns wouldn't exist if there were no listing UI).
- No tags / icons / OG image / cover columns in v1. YAGNI.
- Title MAY also serve as a fallback `<title>` for the iframe srcdoc HTML when the agent didn't include one.

### Q6: HTML pages render in an iframe. Can they call the swarm API — and if so, how?

**Taras**: "Note the HTML contains the SDK from the artifacts by default, so they can. They will be hosted from the API, you know?"

**Insights — important architectural correction:**
- Pages are **hosted from the API itself** at `/p/:id` (no tunnel, no separate origin). For HTML pages, the API injects the existing **Browser SDK** (`src/artifact-sdk/browser-sdk.ts`, `BROWSER_SDK_JS`) into the served HTML — same pattern artifacts use, minus the localtunnel/proxy hop.
- Reuses the existing `SwarmSDK` interface (`createTask`, `getTasks`, `postMessage`, `getSwarm`, `listServices`, etc.). Agents already know this API surface; no new SDK to learn.
- Iframe is now `<iframe src="/p/:id">` (NOT srcdoc), pointing at the API. The iframe context is the API origin.
- **Open detail (plan-time)**: how the user's bearer reaches the SDK inside the iframe for `authed` pages. Candidates:
  - Short-lived signed session cookie issued by `POST /api/pages/:id/launch` (SPA calls with bearer → API sets `Set-Cookie page_session=<jwt>; HttpOnly; SameSite=Strict; Max-Age=3600`). SDK calls to `/api/*` ride the cookie. Same-origin requirement: page host and API host must match.
  - Token-in-URL: `/p/:id?_token=<signed>` — SDK reads from query/fragment. Simpler, but token visible in iframe URL bar / referrers.
  - postMessage handshake — SPA sends bearer to iframe after load. Cross-origin safe.
- For `public` pages: no bearer attached; SDK can only call public-marked endpoints (currently there are none — would need a curated subset, or the SDK silently 401s on calls that need auth).
- For `password` pages: a page-session cookie is set after password verification; SDK uses it like the authed case but scoped to that page.
- Co-hosting requirement: if `/p/:id` lives on the API host (e.g. `api.agent-swarm.dev`) and the SPA on `cloud.agent-swarm.dev`, the SPA-to-page session-cookie handoff still works via the launch endpoint, but bearer-in-localStorage isn't directly accessible from the iframe.
- Bonus: same SDK injection works for the JSON renderer too — when the renderer dispatches a declared action, it can use the SDK's helpers instead of a raw fetch.

### Q7: Password mode UX — how does a recipient unlock a password-protected page?

**Taras**: "We should do 2 [`?key=<password>` query param], and if it's not present then the default dialog [HTTP Basic auth]."

**Insights:**
- The `/p/:id` route, for `auth_mode='password'`, accepts EITHER:
  1. `?key=<password>` in the URL → verify against `password_hash` → serve.
  2. No `?key=` → respond `401 WWW-Authenticate: Basic realm="page <id>"` → browser shows native Basic auth dialog → re-request with `Authorization: Basic`. The username sent is ignored; the password header value is verified against `password_hash`.
- Both paths share one backend code path (extract password from query OR Basic header → hash-compare).
- On successful verification, set a short-lived `Set-Cookie: page_session=<signed>; HttpOnly; Path=/p/:id; SameSite=Strict; Max-Age=3600` so subsequent loads and SDK calls (`/api/*` from the page) don't re-prompt.
- Reuses the existing Basic-auth UX users know from artifacts. No new prompt UI required.
- Failure modes: wrong password → 401 again (Basic dialog re-prompts up to browser's retry limit). Locked-out UX is the browser's default.

### Q8: Credential capture scope for v1?

**Taras**: "I guess I would do 2 [per-page browser-local], but note that for iframes in the app / redirects we could re-use the app credentials (localStorage)."

**Insights — two-tier credential model:**
- **Tier A — SPA-attached (when page is rendered inside the SPA shell at `/artifacts/:id`)**:
  - SPA already holds apiKey + connection config in its own localStorage.
  - SPA can hand off auth (session cookie per Q6) AND share existing credentials with the iframe — likely via a `postMessage` API: iframe requests `{type: 'credential', name: 'github_token'}`, SPA looks up in its own store, returns the value (or "ask user" prompt).
  - User benefit: no re-entry of creds they've already configured in the swarm UI.
- **Tier B — Page-local prompt (when page is opened directly outside the SPA, or SPA doesn't have a requested cred)**:
  - JSON page declares `needs_credentials: [{name, description}]`.
  - Renderer prompts user → stores answer in browser localStorage keyed by page id.
  - Renderer attaches the credential to actions that reference it (e.g. `{action: {endpoint, body, headers: {Authorization: "Bearer ${cred:github_token}"}}}` template).
- **Tier C — Deferred**: server-side credential vault. Not in v1.
- Security note: SPA-to-iframe credential sharing must be **scoped and user-consented** — only share credentials the user has explicitly granted to that page (or to the agent that authored it). Default deny; user confirms once per (page, credential) pair, consent recorded in SPA localStorage. Otherwise a malicious agent's HTML iframe could siphon credentials by spamming postMessage requests.
- v1.5 / v2: integrate with the existing credential pool referenced by `src/utils/secret-scrubber.ts` so creds stored once can serve multiple pages.

### Q9: Slack share UX — single URL or split by content type?

**Taras**: "It should support both, for HTML both should work, for JSON only app."

**Insights — URL routing by content_type:**
- **`/p/:id` (API origin)** behavior depends on `content_type`:
  - `text/html` → serve HTML directly with the Browser SDK injected (auth checks per `auth_mode`).
  - `application/json` → 302 redirect to `https://<ui-host>/artifacts/:id`. Rationale: the JSON renderer lives in the SPA; the API can't render JSON pages standalone.
- **`/artifacts/:id` (SPA route)** always works:
  - Fetches `/p/:id.json` metadata wrapper (includes content_type + body + auth context).
  - `text/html` → renders inside an iframe pointing at `/p/:id`.
  - `application/json` → in-process renderer (with declared actions wired up).
- `create_page` returns BOTH URLs: `{ api_url, app_url }`. Agents can share whichever fits the audience:
  - HTML reports for unauthenticated users → share `api_url` (works without SPA setup).
  - JSON dashboards / anything needing rendered components → share `app_url`.
  - Default recommendation in the MCP tool docs: prefer `app_url` (always works); use `api_url` when you specifically want a no-SPA-required link.
- Slack OG/preview unfurl: each route should emit `<meta og:title>`/`<meta og:description>` from the `title`/`description` columns so links unfurl with a nice preview.

### Q10: JSON renderer source-of-truth?

**Taras**: "Vendor json-render.dev — install/embed its renderer + schema verbatim."

**Insights:**
- The SPA embeds json-render.dev as a renderer dependency. Agents emit JSON in its native schema.
- Declared actions (per Q2/Q3) need to layer on top. Three sub-options for plan-time:
  - If json-render.dev supports plugin node types or render slots → add a swarm `action` node type.
  - Otherwise → wrap: agents emit a swarm envelope `{ ui: <json-render.dev body>, actions: { name: {method, endpoint, body} } }` and our SPA shell renders the body via json-render and walks the tree to wire up nodes that reference action names.
- **Plan-mode prerequisite**: investigate json-render.dev's actual package shape (is it shipped as a library? license? extension hooks?). If it's not installable, this answer needs to revisit.
- Visual style: json-render.dev's look, not shadcn/ui. Acceptable trade for v1 (fast ship); could re-skin or replace later if look-mismatch is jarring.

### Q11: Iframe bearer-transport mechanism for authed pages?

**Taras**: "Launch cookie — SPA POSTs /api/pages/:id/launch with bearer, API issues HttpOnly page-session cookie, iframe loads with cookie attached."

**Insights:**
- Flow:
  1. SPA needs to render an authed page → calls `POST /api/pages/:id/launch` with `Authorization: Bearer ${apiKey}`.
  2. API verifies bearer, looks up the page, returns `204 No Content` with `Set-Cookie: page_session_<id>=<signed-jwt>; HttpOnly; Secure; Path=/p/<id>; SameSite=Strict; Max-Age=3600`.
  3. SPA renders `<iframe src="https://<api>/p/:id">` — cookie is automatically attached on the iframe's GET request.
  4. API serves HTML with `BROWSER_SDK_JS` injected.
  5. SDK calls `/@swarm/api/*` from the iframe (same origin as iframe), API proxy reads cookie, forwards to real `/api/*` as the user.
- Same flow for password pages, except the cookie is issued by the `?key=` / Basic-auth check, not by `/api/pages/:id/launch`.
- Public pages: no cookie. SDK calls go through `/@swarm/api/*` proxy as anonymous; only endpoints flagged public succeed (need to define which — initially likely none).
- **Same-origin requirement**: the iframe URL and the proxy URL must share an origin for the cookie to flow. In local dev (API on `:3013`, SPA on `:5274`), this means the SPA renders the iframe pointing at `:3013` (different origin from SPA, but cookie is set on `:3013` for `:3013` requests — works). The iframe's `/@swarm/api/*` calls are same-origin to itself.
- JWT contents: `{ user_id, page_id, exp }`. Refresh strategy: TBD plan-time (probably none; cookie expires, SPA re-launches).
- Logout: a `DELETE /api/pages/:id/launch` endpoint or just let cookies expire.

## Synthesis

### Key Decisions

1. **Name**: feature is `pages`. Two tables: `pages` (stable identity, head pointer) + `page_versions` (immutable content per version), mirroring the workflows pattern.
2. **Delivery surfaces**:
   - `/p/:id` (API origin) — serves HTML directly with the Browser SDK injected. JSON content redirects to the SPA route.
   - `/artifacts/:id` (SPA route) — always works; renders HTML in an iframe pointing at `/p/:id`, renders JSON with the in-SPA renderer.
3. **Auth modes**: `public` / `authed` / `password`.
   - `authed` → SPA-shell only entry. SPA `POST /api/pages/:id/launch` (bearer) → API sets HttpOnly page-session cookie → iframe loads from API with cookie attached.
   - `password` → `?key=<password>` query param, falls back to HTTP Basic auth dialog if missing. Cookie issued post-verification (same shape as authed).
   - `public` → directly accessible; SDK calls only succeed for public-flagged endpoints.
4. **SDK reuse**: Browser SDK is the existing `BROWSER_SDK_JS` from `src/artifact-sdk/browser-sdk.ts` — injected into HTML pages. Calls go through `/@swarm/api/*` proxy on the API, which resolves the user via the session cookie.
5. **JSON rendering**: vendor **json-render.dev** as the renderer in the SPA. Layer swarm-extension nodes (or wrap-envelope) for declared actions.
6. **JSON interactivity**: display + declared actions. Actions are inline `{method, endpoint, body}` shapes that the renderer dispatches with the viewer's auth attached. Trust model = same blast radius as the user already has.
7. **Lifecycle**: object-like upsert by `(agent_id, slug)`, full versioning. Each create bumps `head_version` and appends to `page_versions`. Pages survive agent death. Manual delete via MCP/UI.
8. **Metadata**: explicit `title` (NOT NULL) and `description` (nullable) on `page_versions`. Used by listing UX and Slack OG unfurls.
9. **Credential capture**: two tiers in v1.
   - Tier A: SPA shares its existing localStorage credentials with iframes via consented postMessage protocol.
   - Tier B: per-page browser-local `localStorage` prompt for `needs_credentials: [...]` declarations.
   - Server-side credential vault deferred.
10. **URL contract**: `create_page` returns `{ id, app_url, api_url, version }`. HTML works on both URLs; JSON only on `app_url`.
11. **No PM2, no tunnel, no service registry row.** This is the entire point of the simplified variant.
12. **MCP tool**: `create_page` (worker → HTTP, never touches DB). Same architecture invariant as everything else worker-side.

### Open Questions (plan-time)

- **json-render.dev package shape** — confirm it's installable as a JS lib, what the schema looks like, what extension hooks exist for declared-action nodes. If not installable, this decision needs to revisit.
- **Bearer transport detail** — JWT payload shape, cookie scope (`Path=/p/<id>` vs `Path=/`), refresh strategy (probably none; SPA re-launches on expiry), logout endpoint.
- **HTML sanitization** — sanitize agent HTML server-side or rely entirely on iframe sandbox attrs? Probably sandbox-only; sanitization breaks legitimate use cases.
- **CSP headers** for `/p/:id` — what `script-src`, `connect-src`, `frame-src` are allowed. Default-restrictive.
- **Size cap** value (default ~1 MB suggested for body). Per-version vs per-page total quota.
- **Public-allowed endpoint set** — which `/api/*` calls succeed when the SDK runs in a public page with no session cookie. Likely zero in v1; need a decision.
- **UI listing UX** — per-agent inbox / swarm gallery / both, navigation surface in the dashboard.
- **OG meta tag generation** route — does `/p/:id` emit `<meta og:title>` for Slack/Twitter unfurl? Same for `/artifacts/:id` on the SPA.
- **Tier A consent UX** — exact postMessage protocol, how user grants/revokes per-(page, credential) consent.
- **SDK extension** — does the existing SDK need new methods (e.g. `submitForm`, `getCredential`) to support JSON declared actions cleanly?
- **`needs_credentials` schema** — exact shape and how the renderer prompts.

### Constraints Identified

- **Architecture invariant**: workers must NEVER import `src/be/db` or `bun:sqlite`. `create_page` must go through HTTP with `API_KEY` + `X-Agent-ID` headers.
- **Forward-only SQL migrations** (`src/be/migrations/NNN_*.sql`). New migrations: `pages` table + `page_versions` table. No down migrations.
- **Same-origin requirement** for launch cookie path. API + iframe page must share an origin (already true since the API serves both `/api/*` and `/p/:id`).
- **Existing Browser SDK reuse** — `BROWSER_SDK_JS` is the SDK; don't fork. The proxy prefix is `/@swarm/api/*`; the API needs to add this proxy at the page-serving routes.
- **`route()` factory required** for every new HTTP endpoint (per `CLAUDE.md`). After adding routes: update `scripts/generate-openapi.ts`, run `bun run docs:openapi`, commit.
- **Secret scrubbing**: page bodies may contain credentials or secrets in agent-generated content. Any logging path that emits page bodies must go through `scrubSecrets` (`src/utils/secret-scrubber.ts`).
- **MCP tool registration**: `create_page` needs a new tool definition in `src/tools/` and skill documentation under `plugin/skills/pages/skill.md` (similar pattern to `plugin/skills/artifacts/skill.md`).
- **Tests**: unit tests for create/update/get/delete + auth-mode branching + version retrieval + cookie issuance. Frontend touches `ui/` so a `qa-use` session with screenshots is required by the merge gate.

### Core Requirements

- **Agent UX**: a single MCP call `create_page({title, slug?, body, contentType, authMode, password?, description?, needsCredentials?})` → `{ id, app_url, api_url, version }`. Upserts by `(agent_id, slug)` if slug provided; auto-generates slug from title otherwise. Same call updates an existing page (bumps version).
- **Versioning**: every overwrite preserves the prior version in `page_versions`. URLs accept `?v=N` to load a specific version; default is head.
- **Auth modes**: all three work end-to-end. Slack-share scenarios:
  - Public HTML link works directly.
  - Authed link routes through SPA; user with apiKey in localStorage sees the page.
  - Password link works with `?key=` or Basic dialog.
- **JSON rendering**: pages with `contentType=application/json` render via json-render.dev in the SPA, with declared actions wired to the user's session.
- **HTML SDK access**: HTML pages have the Browser SDK injected and can call `/@swarm/api/*` per their auth mode.
- **Listing UI** in the dashboard: shows title, description, agent, updated_at, auth_mode for pages the viewer can see.
- **No PM2 / no tunnel / no service registry** for pages. Pure DB + API routes.
- **Skill docs**: `plugin/skills/pages/skill.md` describes the agent contract, examples, and security warnings (declared-action blast radius).
- **OpenAPI**: regenerated after adding the routes. `openapi.json` committed.

## Next Steps

**Parked on 2026-05-12.** Doc status set to `parked` in frontmatter.

When resuming, suggested first moves:
- `/desplega:research` to validate plan-time open questions before committing to a plan — especially:
  1. **json-render.dev** package shape (is there an installable library? what schema does it document? what extension hooks exist?).
  2. Existing API **auth middleware** patterns in `src/server.ts` / `src/http/` — what session/cookie infrastructure (if any) already exists; whether the `route()` factory supports cookie-based auth out of the box.
  3. **Deployment topology** for same-origin cookie path (local dev: API `:3013` vs SPA `:5274`; prod: any shared parent domain?).
- Or jump to `/desplega:create-plan` directly using this brainstorm as input context if confidence is high after a re-read.

File-review (`/file-review:file-review`) is also a good first step on resume to annotate anything Taras wants to correct or sharpen.
