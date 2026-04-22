---
title: Integrations configuration UI (dashboard)
date: 2026-04-21
author: taras
status: completed
autonomy: critical
last_updated: 2026-04-22
last_updated_by: claude (phase-running agent, Phase 5)
---

# Integrations Configuration UI

## Overview

Add a curated, guided "Integrations" page to the `new-ui/` dashboard so humans can configure third-party integrations (Slack, GitHub, GitLab, Linear, Sentry, AgentMail, LLM providers, Codex OAuth, business-use) without reading docs or hand-editing `.env`. (x402/Openfort is explicitly out of scope for v1 — see "What We Are NOT Doing".)

The page is a **thin UX layer over the existing `/api/config` endpoints** — it does NOT introduce a new persistence model. A frontend-only catalog (static TS) describes each integration's fields, help text, and doc links. Integration cards show at-a-glance status; clicking opens a form that writes one `swarm_config` global row per field. Secrets remain encrypted at rest (AES-256-GCM) and are never sent to the UI unmasked.

## Current State

- Config API: `GET/PUT/DELETE /api/config` with scopes `global|agent|repo` (`src/http/config.ts:66-200`). Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) rejected by `src/be/swarm-config-guard.ts:14-25`. Secrets masked as `********` in responses unless `?includeSecrets=true` (`src/be/db.ts:4514-4516`).
- Runtime consumption: global rows are loaded into `process.env` on boot via `loadGlobalConfigsIntoEnv()` (`src/http/core.ts:28-38`). All integrations read `process.env.*`, NOT the DB directly. Exceptions: `codex_oauth` key read via HTTP by workers; Linear OAuth tokens stored in tracker tables (per-workspace).
- Existing UI: `new-ui/src/pages/config/page.tsx` is a raw CRUD over `swarm_config` rows (scope/scopeId/key/value/isSecret) — powerful but unlabeled; user has to know key names. Uses `useConfigs`/`useUpsertConfig`/`useDeleteConfig` from `new-ui/src/api/hooks/use-config-api.ts:10-46`.
- Stack confirmed: **Vite 7 + React 19 + react-router-dom v7** (NOT Next.js), `shadcn/ui` + Tailwind v4 + Radix, `@tanstack/react-query` v5, `sonner` toasts. No `react-hook-form`/`zod` — forms are `useState` + manual validation. No test runner installed in `new-ui/` (no vitest/jest, no `test` script in `new-ui/package.json`) — this plan treats unit tests as manual sanity checks, not automated CI.
- Inventory of integrations currently configured via env/docs:
  - **Slack**: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_ALLOWED_EMAIL_DOMAINS`, `SLACK_ALLOWED_USER_IDS`, `SLACK_DISABLE`, `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION`, `ADDITIVE_SLACK`, `ADDITIVE_SLACK_BUFFER_MS`, `SLACK_ALERTS_CHANNEL`.
  - **GitHub**: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_BOT_NAME`, `GITHUB_BOT_ALIASES`, `GITHUB_EVENT_LABELS`, `GITHUB_TOKEN`, `GITHUB_EMAIL`, `GITHUB_NAME`, `GITHUB_DISABLE`.
  - **GitLab**: `GITLAB_WEBHOOK_SECRET`, `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_BOT_NAME`, `GITLAB_EMAIL`, `GITLAB_NAME`, `GITLAB_DISABLE`.
  - **Linear** (OAuth-heavy): `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI`, `LINEAR_SIGNING_SECRET`, `LINEAR_DISABLE`/`LINEAR_ENABLED` + OAuth connection via `/api/trackers/linear/*`.
  - **Sentry**: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` (onboarding scaffold only; no runtime reads in `src/`, but useful for worker CLI access).
  - **AgentMail**: `AGENTMAIL_WEBHOOK_SECRET`, `AGENTMAIL_INBOX_DOMAIN_FILTER`, `AGENTMAIL_SENDER_DOMAIN_FILTER`, `AGENTMAIL_DISABLE`.
  - **LLM providers**: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` (credential-pool capable: comma-separated).
  - **Codex OAuth**: `codex_oauth` swarm_config key (encrypted); requires CLI flow (`bun run src/cli.tsx codex-login`).
  - **business-use**: `BUSINESS_USE_API_KEY`, `BUSINESS_USE_URL`.

  x402/Openfort is intentionally **out of scope for v1** — it has a large surface area (signer types, daily limits, wallet credentials) that deserves its own dedicated UX later.

## Desired End State

- New `/integrations` route with nav entry under a Settings-style group.
- Grid of integration cards (one per known integration) with status chips: **Not configured**, **Partially configured**, **Configured**, **Disabled**.
- Click card → detail panel/page with:
  - Description, short setup guide, link to external docs.
  - One form field per known env var with labels, placeholders, help text, `type` (text/password/textarea/select), required flag.
  - Secret values rendered as `••••••` with a "Replace" affordance; unknown/advanced keys grouped under "Advanced".
  - Per-integration "Save" (upserts all changed fields), "Disable" (sets `<PREFIX>_DISABLE=true`), "Reset" (deletes all keys in the integration).
  - Special flows:
    - **Linear**: "Connect workspace" button that redirects through OAuth + shows connected workspaces list.
    - **Codex OAuth**: card shows CLI instruction snippet (can't be done from UI) + status from `codex_oauth` entry.
    - **GitHub**: toggle between App mode (App ID + private key) vs PAT mode (worker token).
    - **LLM provider keys**: show "credential pool size" for comma-separated lists.
- A persistent hint: "Some changes require restarting the API server" with a link to the docs section.
- **No backend changes required** — reuses existing `/api/config` endpoints and guards. The catalog lives in the frontend only.

## What We Are NOT Doing

- No new backend endpoint, no new DB migration, no new tool.
- No OAuth flow changes for Linear (reusing existing `/api/trackers/linear/*`, including the existing `GET /api/trackers/linear/status` for connection info).
- No implementation of a Codex ChatGPT OAuth flow in the UI (that's CLI-only for now).
- No "test connection" probing of Slack/GitHub/Linear tokens (nice-to-have, deferred).
- No agent/repo-scoped integration overrides in v1 (global scope only).
- No multi-user/auth model changes. The existing `apiKey` bearer in localStorage still gates access.
- No bulk import from `.env`.
- **No x402/Openfort integration in v1** — deferred to a dedicated future UX.

## Architecture Notes

```
new-ui/src/
  lib/
    integrations-catalog.ts    # NEW: static typed catalog (Integration[])
    integrations-status.ts     # NEW: derive status from configs array
  pages/
    integrations/
      page.tsx                 # NEW: list/grid of integration cards
      [id]/
        page.tsx               # NEW: detail/edit page per integration
  components/integrations/     # NEW
    integration-card.tsx
    integration-status-badge.tsx
    field-renderer.tsx         # text/password/textarea/select + mask toggle
    linear-oauth-section.tsx   # special case
    codex-oauth-section.tsx    # special case
  api/hooks/
    use-config-api.ts          # extend: useUpsertConfigsBatch (sequential PUTs + aggregate toast)
  app/router.tsx               # add routes
  components/layout/app-sidebar.tsx  # add nav entry
```

Data model — each field in the catalog maps to one `swarm_config` row:

```ts
{ scope: "global", key: "SLACK_BOT_TOKEN", value: "...", isSecret: true,
  description: "Slack bot OAuth token (xoxb-...)", envPath: ".env" }
```

Status derivation:

- **Configured** — all `required: true` fields present AND `<PREFIX>_DISABLE` not set to truthy.
- **Partially configured** — at least one required field present but not all.
- **Disabled** — `<PREFIX>_DISABLE=true|1|yes` set.
- **Not configured** — no required fields present.

---

## Phase 1 — Integrations catalog & status lib

Define the single source of truth for the UI: a typed catalog listing all known integrations with their fields, plus a pure helper that derives status from a list of configs.

### Changes

1. Create `new-ui/src/lib/integrations-catalog.ts` exporting `INTEGRATIONS: IntegrationDef[]` and types:
   ```ts
   type IntegrationFieldType = "text" | "password" | "textarea" | "select" | "boolean";
   type IntegrationField = {
     key: string;                    // swarm_config key (e.g. "SLACK_BOT_TOKEN")
     label: string;
     type: IntegrationFieldType;
     required?: boolean;
     isSecret?: boolean;
     placeholder?: string;
     helpText?: string;
     options?: { value: string; label: string }[]; // for select
     advanced?: boolean;             // collapsed under Advanced by default
     default?: string;
     credentialPool?: boolean;       // comma-separated list hint
     affectsRestart?: boolean;       // shows restart hint
   };
   type IntegrationDef = {
     id: string;                     // slug, used in URL
     name: string;
     description: string;
     category: "comm" | "issues" | "llm" | "observability" | "payments" | "email" | "other";
     iconKey: string;                // maps to lucide-react icon
     docsUrl: string;                // external or in-repo docs path
     fields: IntegrationField[];
     disableKey?: string;            // e.g. "SLACK_DISABLE"
     restartRequired?: boolean;      // global hint
     specialFlow?: "linear-oauth" | "codex-cli";
   };
   ```
2. Seed the catalog with entries for: `slack`, `github`, `gitlab`, `linear`, `sentry`, `agentmail`, `anthropic`, `openrouter`, `openai`, `codex-oauth`, `business-use`. Use the env-var inventory from "Current State" above; mark API tokens `isSecret: true`, webhook secrets `isSecret: true`. Put `*_BOT_NAME`, allow-lists, buffer settings under `advanced: true`.
   For **GitHub**, default to PAT mode: required fields are `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_EMAIL`, `GITHUB_NAME`; App-mode fields (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_BOT_NAME`, `GITHUB_BOT_ALIASES`, `GITHUB_EVENT_LABELS`) go under `advanced: true`. No mode toggle — advanced users just expand Advanced. (Catalog is x402/Openfort-free by design.)
3. Create `new-ui/src/lib/integrations-status.ts` exporting:
   ```ts
   type IntegrationStatus = "configured" | "partial" | "disabled" | "none";
   export function deriveIntegrationStatus(def: IntegrationDef, configs: SwarmConfig[]): IntegrationStatus;
   export function findConfigForKey(configs: SwarmConfig[], key: string): SwarmConfig | undefined;
   ```
4. Instead of a unit test (no test runner is configured in `new-ui/`), add a short sanity-check script `new-ui/src/lib/integrations-status.sanity.ts` that constructs a handful of fake `SwarmConfig` arrays and `console.log`s the derived statuses for a given catalog entry. Runnable ad-hoc via `bun new-ui/src/lib/integrations-status.sanity.ts` during implementation. It covers: none / partial / full / disabled / reserved-key-skipped. Delete the file once the shape is stable, or keep as `.example.ts` for documentation — the PR reviewer's call.

   _If scope expands later to include a real test runner, a follow-up plan should add vitest + `@vitest/ui` and convert this into a proper `*.test.ts`._

### Success Criteria

#### Automated Verification:
- [x] Type-check passes: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`
- [x] New catalog file exists: `ls new-ui/src/lib/integrations-catalog.ts`
- [x] Every `IntegrationDef.id` is unique and kebab-case: `grep -oE "id: \"[a-z0-9-]+\"" new-ui/src/lib/integrations-catalog.ts | sort | uniq -d` returns empty.
- [x] No reserved key (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) appears in the catalog: `grep -iE "(API_KEY|SECRETS_ENCRYPTION_KEY)" new-ui/src/lib/integrations-catalog.ts` only matches in comments or not at all.

#### Manual Verification:
- [ ] Run the sanity-check script (`bun new-ui/src/lib/integrations-status.sanity.ts`) and eyeball outputs for none / partial / full / disabled / reserved-key-skipped.
- [ ] Skim catalog entries against `src/slack/app.ts`, `src/github/app.ts`, `src/gitlab/auth.ts`, `src/linear/app.ts`, `src/agentmail/app.ts` to confirm no required env var was missed.
- [ ] Help text is human-readable (not just a re-statement of the key name).

**Implementation Note**: Pause after this phase for review of the catalog — it's the contract the rest of the plan hangs on. No UI yet; only data.

---

## Phase 2 — Integrations list page + routing + nav

Surface the catalog as a cards grid with live status.

### Changes

1. Create `new-ui/src/pages/integrations/page.tsx`:
   - Layout: filter bar (search box, category chips) + responsive card grid (3 cols desktop, 1 col mobile).
   - Data fetch: `useConfigs({ scope: "global" })` (extend `use-config-api.ts` if the existing hook doesn't already accept filters — it does per research).
   - Per catalog entry, render `<IntegrationCard />`:
     - Icon, name, 1-line description, status badge, "Configure →" button linking to `/integrations/:id`.
   - Empty/loading/error states via existing `components/shared/empty-state`, `components/shared/page-skeleton`.
2. Create `new-ui/src/components/integrations/integration-card.tsx` and `integration-status-badge.tsx`.
3. Register routes in `new-ui/src/app/router.tsx` following the existing pattern (top-level `lazy()` declaration + JSX element passed to `element:`):
   ```tsx
   // top of file, alongside the other lazy declarations:
   const IntegrationsPage = lazy(() => import("@/pages/integrations/page"));
   const IntegrationDetailPage = lazy(() => import("@/pages/integrations/[id]/page"));

   // inside the `children` array, near the other System entries (after `config`):
   { path: "integrations", element: <IntegrationsPage /> },
   { path: "integrations/:id", element: <IntegrationDetailPage /> },
   ```
4. Add sidebar entry in `new-ui/src/components/layout/app-sidebar.tsx` in the **System** `navGroups` entry. Insert between `Repos` and `API Keys`: `{ title: "Integrations", path: "/integrations", icon: Plug }` (import `Plug` from `lucide-react`). Resulting System order: `Config → Repos → Integrations → API Keys → Debug`.
5. Placeholder `[id]/page.tsx` returning "Phase 3 — coming" so the route resolves.

### Success Criteria

#### Automated Verification:
- [x] Type-check: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint: `cd new-ui && pnpm lint`
- [x] Route file registers both routes: `grep -nE "integrations" new-ui/src/app/router.tsx` shows both paths.
- [x] Sidebar entry present: `grep -n "/integrations" new-ui/src/components/layout/app-sidebar.tsx` returns a match in a `navGroups` entry.
- [x] Build succeeds: `cd new-ui && pnpm build`.

#### Manual Verification:
- [ ] Start API + UI. Two supported workflows:
  - **Portless dev** (default): `bun run dev:http` + `cd new-ui && pnpm dev` (the `dev` script runs `portless ui.swarm vite`). UI at `https://ui.swarm.localhost:1355/integrations`, API at `https://api.swarm.localhost:1355`.
  - **PM2 (port-bound)**: `bun run pm2-start`. UI at `http://localhost:5274/integrations`, API at `http://localhost:3013`.
  Confirm cards for all catalog entries render.
- [ ] With a fresh DB (no configs), all cards show **Not configured**.
- [ ] Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` via the existing `/config` page → refresh → Slack card flips to **Configured**.
- [ ] Set `SLACK_DISABLE=true` → Slack card shows **Disabled**.
- [ ] Sidebar entry is clickable and highlights on active route.
- [ ] Search filter narrows cards by name; category chips filter by `category`.

### QA Spec (optional):
- **Scenario**: integrations list visibility and status derivation.
- **Given** a swarm with no `swarm_config` rows, **when** navigating to `/integrations`, **then** every catalog entry renders with status "Not configured".
- **Given** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` set globally, **then** Slack card = "Configured".
- **Given** `SLACK_DISABLE=true` is set, **then** Slack card = "Disabled" regardless of token presence.
- **Evidence**: 2 screenshots (empty + populated) captured via `qa-use` or browser, attached to the PR.

**Implementation Note**: Pause after this phase to confirm nav placement and card visual direction before investing in form UX.

---

## Phase 3 — Integration detail page + generic form

Turn each card into an editable, labeled form. This is the main UX delivery.

### Changes

1. Create `new-ui/src/pages/integrations/[id]/page.tsx`:
   - `const { id } = useParams();` find `def = INTEGRATIONS.find(i => i.id === id)`; 404 via `<NotFound />` if missing.
   - Header: icon + name + status badge + docs link button.
   - Action bar: **Save changes** (disabled when no dirty fields), **Disable/Enable** toggle (writes `disableKey`), **Reset integration** (opens confirm dialog → deletes every catalog key for this integration via `DELETE /api/config/:id`).
   - Body: two sections — "Required" fields and "Advanced" (collapsible, shadcn-free — use `<details>` or a simple toggle).
   - Restart hint banner if `def.restartRequired`: "Changes take effect after the API server restarts. See `bun run pm2-restart`." with a link to `CLAUDE.md` commands section.
2. Create `new-ui/src/components/integrations/field-renderer.tsx`:
   - Props: `field: IntegrationField`, `config?: SwarmConfig` (existing row, if any), `value`, `onChange`, `onMarkForReplace`.
   - For secrets: when a value already exists, render masked `••••••` + "Replace" button (click reveals an empty input; typing marks the field dirty).
   - For `select`: `<Select>` from shadcn.
   - For `textarea`: `<Textarea>` (multi-line, useful for `GITHUB_APP_PRIVATE_KEY`).
   - For `boolean`: `<Switch>` writing "true"/"false" strings.
   - `credentialPool`: show chip count ("3 keys in pool") when value contains commas.
3. Extend `new-ui/src/api/hooks/use-config-api.ts` with `useUpsertConfigsBatch()`:
   - Takes `Array<{ key, value, isSecret, description, envPath }>` all at `scope: "global"`.
   - Issues sequential `PUT /api/config` calls (the API has no bulk endpoint — see `src/http/config.ts:66-85`). Aggregates errors.
   - Invalidates the `configs` query and shows a single toast on completion: "Saved N values" / "Saved N, failed M".
4. Extend with `useDeleteConfigsBatch()` (same shape, by key): looks up each row via the existing `configs` query, calls `DELETE /api/config/:id`, aggregates.
5. Wire the detail page's Save button to `useUpsertConfigsBatch` with only dirty fields.
6. Wire "Reset integration" to `useDeleteConfigsBatch` with all of `def.fields.map(f => f.key)` plus `def.disableKey`.
7. Reserved-key safety: even though the catalog shouldn't contain reserved keys, add a client-side guard in `useUpsertConfigsBatch` that filters them out before sending (defense in depth — the server rejects with 400 anyway per `src/http/config.ts:161-164`).

### Success Criteria

#### Automated Verification:
- [x] Type-check: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint: `cd new-ui && pnpm lint`
- [x] Hook exports present: `grep -nE "useUpsertConfigsBatch|useDeleteConfigsBatch" new-ui/src/api/hooks/use-config-api.ts` returns both.
- [x] Reserved-key filter present: `grep -n "API_KEY\|SECRETS_ENCRYPTION_KEY" new-ui/src/api/hooks/use-config-api.ts` shows a filter/guard line.
- [x] Build succeeds: `cd new-ui && pnpm build`.

#### Manual Verification:
- [ ] Open `/integrations/slack`. Form shows `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` as required password fields; allow-list fields under Advanced.
- [ ] Enter tokens → Save → toast "Saved 2 values". Reload — status flips to **Configured**; secret fields show masked with Replace.
- [ ] Click Replace on a secret → input empties → type new value → Save → toast success. Confirm via CLI: `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global&includeSecrets=true" | jq '.configs[] | select(.key=="SLACK_BOT_TOKEN") | .value'` shows new value.
- [ ] Toggle "Disable Slack" → `SLACK_DISABLE=true` written; status flips to **Disabled**.
- [ ] "Reset integration" → confirm dialog → all Slack keys deleted (including `SLACK_DISABLE`); card returns to **Not configured**.
- [ ] Error path: stop API server, try to save → error toast surfaces the HTTP failure without crashing.
- [ ] Open `/integrations/github` → Advanced section toggles correctly; `GITHUB_APP_PRIVATE_KEY` renders as textarea.

### QA Spec (optional):
- **Scenario 1 — Happy path save**: configure Slack via UI only, restart the API (`bun run pm2-restart` or restart the dev process) so `loadGlobalConfigsIntoEnv()` picks up the new row, then confirm the value landed by filtering the existing list endpoint (the `/api/config/resolved` endpoint only accepts `agentId`/`repoId` — it does not filter by `key`):
  ```bash
  curl -s -H "Authorization: Bearer 123123" \
    "http://localhost:3013/api/config?scope=global&includeSecrets=true" \
    | jq '.configs[] | select(.key=="SLACK_BOT_TOKEN") | .value'
  ```
- **Scenario 2 — Secret masking**: `GET /api/config` without `includeSecrets` never leaks secret values to the UI — DevTools network inspection shows `"********"` only.
- **Scenario 3 — Reset integration**: after reset, `GET /api/config?scope=global` returns zero rows whose `key` is in the Slack catalog.
- **Scenario 4 — Reserved key defense**: add a temporary `API_KEY`-named field to the catalog (locally only), attempt save → UI filters it out pre-request (no 400 surfaced).
- **Evidence**: 4 screenshots via `qa-use`, attached to the PR per new-ui frontend requirement.

**Implementation Note**: Pause for QA-use session review before moving on.

---

## Phase 4 — Special flows (Linear OAuth, Codex CLI, GitHub App vs PAT)

Cover the integrations that don't fit the generic field-form pattern.

### Changes

1. **Linear** — create `new-ui/src/components/integrations/linear-oauth-section.tsx`:
   - Above the generic fields, show a "Connection" card driven by the existing `GET /api/trackers/linear/status` endpoint (returns connection status, token expiry, workspace info, expected webhook URL per `src/http/trackers/linear.ts:44-54`). No new backend route needed.
   - "Connect to Linear" button: `window.location.href = /api/trackers/linear/authorize` (handler already issues the 302 redirect, see `src/http/trackers/linear.ts` handler).
   - Disconnect: if the status endpoint exposes a disconnect-capable affordance, wire it; otherwise show a "Re-authenticate" button (re-runs authorize) and call out disconnect as a minor follow-up. Confirm the exact disconnect mechanism by reading the full `handleLinearTracker` function before implementing — do NOT invent an endpoint.
2. **Codex OAuth** — create `new-ui/src/components/integrations/codex-oauth-section.tsx`:
   - Status derived from presence of the `codex_oauth` global config key.
   - Body: explanatory text + copyable snippet `bun run src/cli.tsx codex-login --api-url <APP_URL>` (auto-fill current `APP_URL`). "Clear stored OAuth" button → `DELETE /api/config/:id` for the `codex_oauth` row (with confirm).
   - No form fields — the generic form is suppressed when `def.specialFlow === "codex-cli"`.
3. **GitHub** — no segmented toggle. The generic form handles it: PAT fields (`GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_EMAIL`, `GITHUB_NAME`) are shown by default; App-mode fields sit under **Advanced**. A short explainer paragraph at the top of the page notes: "PAT mode is the default and simpler path. For GitHub App integration (recommended for production), expand Advanced and fill `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`." No mode-persistence in localStorage required.
4. Update catalog entries for `linear` and `codex-oauth` to set `specialFlow` used by the detail page to render the right sub-component.

### Success Criteria

#### Automated Verification:
- [x] Type-check: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint: `cd new-ui && pnpm lint`
- [x] Linear OAuth section imported in detail page: `grep -n "LinearOAuthSection" new-ui/src/pages/integrations/\[id\]/page.tsx` returns a match.
- [x] No new backend routes introduced: `git diff src/http/ | grep -c "route("` is unchanged from main.

#### Manual Verification:
- [ ] Set `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET`/`LINEAR_SIGNING_SECRET` via the form → Save → restart API.
- [ ] Hit "Connect to Linear" — browser redirects to Linear OAuth; after callback, `GET /api/trackers/linear/status` returns connected info and the UI reflects it.
- [ ] Open `/integrations/codex-oauth` — no form fields; CLI snippet copyable; if `codex_oauth` row exists, "Clear stored OAuth" button visible and works.
- [ ] GitHub page: PAT fields visible by default; App fields hidden under a collapsed **Advanced** section.

### QA Spec (optional):
- **Linear OAuth e2e**: full authorize → `GET /api/trackers/linear/status` shows connected → screenshots at each step.
- **Codex CLI instruction**: copy snippet, paste in terminal, verify it runs (uses the UI's configured `apiUrl`).
- **GitHub**: saving a field inside **Advanced** (e.g. `GITHUB_APP_ID`) does NOT clear unrelated fields; collapse/expand of Advanced does not trigger a save.

**Implementation Note**: Standard pause before Phase 5. No new backend endpoint in this phase — Linear uses the existing `/api/trackers/linear/*` routes.

---

## Phase 5 — Polish, restart hints, QA pass

Tighten the UX and deliver a QA session suitable for PR merge.

### Changes

1. Global "changes require restart" hint bar on the integrations pages: dismissable per-session toast after a successful save when `def.restartRequired`.
2. Per-field affordances: copy-to-clipboard buttons for keys (useful for pasting into `.env` if preferred); inline validation for obvious formats (Slack bot token starts with `xoxb-`, GitHub App private key contains `BEGIN RSA PRIVATE KEY`) — non-blocking warnings only.
3. Empty-state polish: when no integrations are configured, surface the 3 most common (Slack, GitHub, Anthropic) as "Get started" suggestions.
4. Keyboard: `⌘/Ctrl+S` on detail page triggers Save (reuse existing `command-menu` hotkey infra if suitable; else local listener).
5. Accessibility: all form fields `<Label htmlFor>` linked; status badges use text not just color; focus outlines visible.
6. Screenshots and QA session per `qa-use` — save under `qa/2026-04-21-integrations/*` in the PR.
7. Update `new-ui/CLAUDE.md` if there's a pattern note worth adding (only if one genuinely emerges).

### Success Criteria

#### Automated Verification:
- [x] Full pre-PR checks pass at repo root: `bun run lint:fix && bun run tsc:check && bun test && bash scripts/check-db-boundary.sh`.
- [x] new-ui checks: `cd new-ui && pnpm lint && pnpm exec tsc --noEmit && pnpm build`.
- [ ] `qa-use` artifacts committed or attached to PR.
- [x] If any plugin commands changed: `bun run build:pi-skills` runs clean.

#### Manual Verification:
- [ ] Golden path from a fresh DB: configure Slack + GitHub + Anthropic entirely from the UI, restart API (`bun run pm2-restart`), confirm Slack handler wakes up and the worker/lead see the keys (`docker logs ...`).
- [ ] Keyboard save works on detail page.
- [ ] Screen reader reads status badges correctly (e.g. VoiceOver Quick Nav).

### QA Spec (optional):
- Full `qa-use:verify` session covering: list page empty state → configure Slack via form → card flips to Configured → set disable toggle → card flips to Disabled → reset integration → card back to Not configured.

**Implementation Note**: Create the PR from this phase; include the `qa-use` session per frontend-change policy in `CLAUDE.md`.

---

## Manual E2E (end of plan)

After all phases merged, verify end-to-end against a real Docker Compose stack:

```bash
# 0. Fresh DB + services
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run pm2-start
# Verify services up
bun run pm2-status
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/health

# 1. Open the UI and navigate to Integrations
# PM2 workflow (what pm2-start gives you):
open http://localhost:5274/integrations
# Portless dev workflow (if using `bun run dev:http` + `pnpm dev` instead):
# open https://ui.swarm.localhost:1355/integrations

# 2. Configure Slack via UI (paste real xoxb-/xapp- tokens), Save.
# 3. Verify values landed in swarm_config (encrypted at rest):
sqlite3 agent-swarm-db.sqlite "SELECT key, encrypted, isSecret FROM swarm_config WHERE key LIKE 'SLACK_%';"
# Expect: encrypted=1, isSecret=1 for token rows.

# 4. Verify API returns masked by default, real with includeSecrets:
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global" | jq '.configs[] | select(.key=="SLACK_BOT_TOKEN") | .value'
# Expect: "********"
curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/config?scope=global&includeSecrets=true" | jq '.configs[] | select(.key=="SLACK_BOT_TOKEN") | .value'
# Expect: real token.

# 5. Restart API so global configs load into process.env:
bun run pm2-restart
# Slack handler should initialize:
bun run pm2-logs | grep -iE "slack|Socket Mode"

# 6. Test Linear OAuth:
# Set LINEAR_CLIENT_ID/SECRET/SIGNING_SECRET via UI → Save → Connect workspace → complete OAuth → workspace shows in connected list.

# 7. Test Codex OAuth card:
bun run src/cli.tsx codex-login --api-url http://localhost:3013
# Reload /integrations/codex-oauth → shows "Clear stored OAuth" button (indicating codex_oauth is set).

# 8. Test Reset integration:
# Click Reset on Slack → confirm → verify
sqlite3 agent-swarm-db.sqlite "SELECT COUNT(*) FROM swarm_config WHERE key LIKE 'SLACK_%';"
# Expect: 0

# 9. Reserved key defense:
curl -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"scope":"global","key":"API_KEY","value":"bad"}' http://localhost:3013/api/config
# Expect: HTTP 400 with a reserved-key message.

# 10. Tear down:
bun run pm2-stop
```

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Catalog drifts from actual env-var usage in `src/` | In PR description, link to the inventory in this plan; add a follow-up ticket to periodically regenerate (future: a script that greps `process.env.*` and diffs against the catalog). |
| User sets tokens but forgets to restart the API, wonders why Slack doesn't connect | Restart hint banner after save + docs link in every detail page header. |
| Secrets leak to UI via accidentally including `includeSecrets=true` in hooks | Default `includeSecrets=false` everywhere; the detail page never requests decrypted secrets — it only needs to know "is this key set?" (presence). "Replace" flow sends new value but never reads the old one. |
| User pastes wrong-format token (e.g. Slack user token instead of bot token) | Non-blocking inline warnings on known prefixes; deferred test-connection button is the real fix. |
| `useUpsertConfigsBatch` sequential PUTs are slow for many fields | The catalog has at most ~10 fields per integration; latency acceptable. Parallelize only if it becomes visible. |
| Linear disconnect flow is fuzzy | Confirm the disconnect mechanism by reading `handleLinearTracker` in full before implementing Phase 4; if there's no dedicated disconnect handler, ship v1 with a "Re-authenticate" affordance and open a follow-up ticket for explicit disconnect. Do NOT invent an endpoint. |

---

## Review Errata

_Reviewed: 2026-04-22 by Claude (Auto-apply mode)._

### Applied

- [x] **C1 — No test runner in `new-ui/`**: Phase 1 automated verification used `pnpm test -- integrations-status`, but `new-ui/package.json` has no vitest/jest and no `test` script. Replaced with a manual ad-hoc sanity-check script (`integrations-status.sanity.ts`) runnable via `bun`. Added a note in Current State flagging the absence of a test runner. Deferred a real test harness to a follow-up plan.
- [x] **C2 — Wrong dev UI URL**: `pnpm dev` in `new-ui/` runs `portless ui.swarm vite`, which serves at `https://ui.swarm.localhost:1355`, not `http://localhost:5274`. `localhost:5274` is only valid when using `bun run pm2-start`. Phase 2 manual verification and the Manual E2E now document both workflows explicitly.
- [x] **C3 — `/api/config/resolved?key=...` is not a real query**: `getResolvedConfigRoute` in `src/http/config.ts:108-117` only accepts `agentId` and `repoId` — there's no `key` filter. QA Spec Scenario 1 rewritten to filter the list endpoint via `jq`.
- [x] **I1 — Sidebar placement ambiguity**: "after `Config`, before `Keys`" was ambiguous given the real System group (`Config → Repos → API Keys → Debug`). Clarified to "between `Repos` and `API Keys`" with the final order spelled out.
- [x] **I2 — Vite version drift**: Plan said Vite 6; `new-ui/package.json` now pins `vite ^7.3.1`. Updated to Vite 7.
- [x] **I3 — Router snippet drifted from existing pattern**: Existing `router.tsx` declares lazy components at module top-level and passes JSX to `element:`. Plan snippet inlined `lazy()` inside `element:`. Rewrote to match the established pattern.
- [x] **M1 — x402 contradiction in Overview**: Overview listed x402 among configurable integrations even though "NOT Doing" explicitly excludes it. Removed from the list and added a parenthetical cross-reference.
- [x] **M2 — Frontmatter autonomy**: Frontmatter said `autonomy: autopilot` but the plan contains multiple "Pause after this phase" gates. Changed to `critical` to match the phase-pause cadence.

### Remaining

_None — all Critical, Important, and Minor findings were auto-applied per user authorization._

### Not Evaluated / Follow-ups

- Catalog-vs-source drift (listed as a Risk in the plan): still a standing concern. Consider adding a `scripts/check-integrations-catalog.ts` grep-based audit as a future task.
- Accessibility review in Phase 5 relies on manual VoiceOver testing; no automated a11y check is specified. Low priority for v1.
