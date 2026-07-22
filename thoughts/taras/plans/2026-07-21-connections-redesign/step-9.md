---
id: step-9
name: UI — OAuth apps & authorizations
depends_on: [step-4, step-6]
status: ready
---

# step-9: UI — OAuth apps & authorizations

## Overview
Rework the OAuth Apps surface in `apps/ui` for the 1:N model: the create/edit dialog shows the static redirect URL **before** creation (today it's absent from `OAuthAppDialog` entirely — only visible post-POST in the grid) plus a preset picker with setup hints; the app detail page lists authorizations with label, captured account identity, status badge (`active`/`refresh-failed`/`expired`/`revoked`), expiry, and per-authorization actions (authorize with a new label, re-authorize, refresh, revoke). Routing moves from `provider` to app id.

## Changes Required:

#### 1. API client + hooks
**Files**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/types.ts`, `apps/ui/src/api/hooks/` (extend the existing oauth-app hooks near `use-script-connections.ts:89-102`)
**Changes**: New/changed calls: `GET /api/oauth/redirect-uri`, `GET /api/oauth-presets`, id-keyed app CRUD, `GET /api/oauth-apps/{id}/authorizations`, `POST /api/oauth-apps/{id}/authorize-url` `{label}`, `POST /api/oauth-authorizations/{id}/refresh`, `DELETE /api/oauth-authorizations/{id}`. Types mirror the step-4 response shapes (no token material).

#### 2. OAuthAppDialog rework
**File**: `apps/ui/src/pages/connections/page.tsx` (`OAuthAppDialog`, `:2086-2368`)
**Changes**: Top of the form: copyable static redirect URI (from `GET /api/oauth/redirect-uri`) with helper text "register this in the provider console first". Preset `Select` (from `/api/oauth-presets`) → hydrates endpoint/quirk fields (left visible but collapsed under "Advanced"), renders `setupHints` as an info callout; "Discover from URL" box stays as the fallback path. Only `clientId` + `clientSecret` remain required for preset-based creation.

#### 3. App detail page → authorizations list
**Files**: `apps/ui/src/pages/connections/oauth-apps/[id]/page.tsx` (renamed from `[provider]`), `apps/ui/src/app/router.tsx:32-34,111-113` (route param change + redirect from old provider-keyed URLs for continuity), `apps/ui/src/pages/connections/page.tsx` (`OAuthAppsSection` grid `:1835+`: authorization-count + worst-status column replacing the single tokenStatus)
**Changes**: Detail page: app info (redirect URI, endpoints, source badge incl. `dcr`) + authorizations table — label, accountEmail, status badge, expiresAt, lastErrorMessage tooltip on `refresh-failed`, row actions (re-authorize opens authorize-url in new tab, refresh, revoke) — plus an "Authorize new account" button prompting for a label. Status badge colors consistent with the MCP OAuth panel's existing `OAuthStatusBadge` idiom (`apps/ui/src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx:57-69`).

#### 4. Dependent-connection badges
**Files**: `apps/ui/src/pages/connections/page.tsx` (connections list), `apps/ui/src/pages/connections/[id]/page.tsx`
**Changes**: Connections whose auth references a `refresh-failed`/`revoked` authorization show a warning badge with the authorization label (data comes from the connection `auth.status` field, step-7 — if step-7 hasn't landed yet at implementation time, derive from the binding status already returned today; keep the code path tolerant of both shapes).

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] Root gates: `bun run lint` && `bun run tsc:check` (shared types untouched or regenerated)

#### Automated QA:
- [ ] With the API + mock provider running and the UI dev server up: agent-browser walkthrough — open /connections → OAuth Apps tab → create app from `google` preset (redirect URI visible + copyable BEFORE submit, hints callout rendered) → open app page → authorize twice with labels `support`/`sales` (mock dance) → both rows listed with identity + `active` badges → force one to `refresh-failed` via the mock → badge + tooltip update; screenshot each state
- [ ] Old-style `/connections/oauth-apps/linear` URL redirects to the id-keyed page

#### Manual Verification:
- [ ] Taras visual pass on the reworked dialog + authorizations table (SPA is manually QA'd in this repo — no qa-use YAML)

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-9] UI oauth apps & authorizations` after verification passes.
