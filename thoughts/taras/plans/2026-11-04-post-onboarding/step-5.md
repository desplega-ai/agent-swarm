---
id: step-5
name: Sidebar WORK/AUTOMATE/CONNECT/BUILD + Connect page shells + redirects
track: C
depends_on: [step-16]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-5
claimed_at: 2026-11-04T15:11:02Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Sidebar WORK/AUTOMATE/CONNECT/BUILD + Connect page shells + redirects

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r3-sidebar.html` (Variant 2) and `r4-connect.html` for the Connect page shells. Decisions: `root.md § Design decisions (step-16)`.

## Overview
The dashboard gets its new information architecture in one change: an inset sidebar with groups WORK / AUTOMATE / CONNECT / BUILD and Settings + Usage in the footer, three Connect pages (`/integrations/channels`, `/integrations/tools`, `/integrations/ai`) whose bodies re-mount today's page components, Settings › Advanced for the rarely used config pages, stable scrollbar gutters, and redirects for every moved route that keep query, hash and ids. The fleet benchmark card moves from Home to Usage. This is the **only** step that edits `app-sidebar.tsx` and `routes.tsx` (step-4 adds one route line later, step-15 one badge entry). After this step, a user who opens `/connections?tab=oauth-apps` lands on `/integrations/tools?tab=oauth-apps` with that tab open.

## Changes Required:

#### 1. Sidebar groups and inset style
**File**: `apps/ui/src/components/layout/app-sidebar.tsx:71-221, 599-644, 670-731`
**Changes**:
- `NavGroup` gains `defaultOpen?: boolean`. `navGroups`:
  - **WORK** `[Home, Sessions, Files (requires comb), Pages, Apps]`. Apps drops `adminOnly` (the page keeps its own create/edit gating; server RBAC is the real gate).
  - **AUTOMATE** `[Schedules, Workflows]`.
  - **CONNECT** (adminOnly items) `[Channels → /integrations/channels, Tools → /integrations/tools, AI providers → /integrations/ai]`. AI providers shows a warning dot when any pooled key is rate-limited or failing (`useApiKeyStatuses`, gated like the other badges on `gates["1.82.0"]`).
  - **BUILD** (`defaultOpen: false`) `[Agents, Tasks, Skills, Memory, Scripts]`.
  - Approvals and Templates leave the groups (Approvals stays at `/approvals` and surfaces through Home's Needs you in step-15; Templates moves to Settings › Advanced). People leaves the groups; its users-count badge (`:630-632`) moves to the Settings flyout entry.
- Pass `group.defaultOpen ?? true` to `CollapsibleSection` (`:670-674`). New group ids (`work`, `automate`, `connect`, `build`) so stale localStorage state does not pin BUILD open.
- Inset look: use the shadcn sidebar `variant="inset"` (or the equivalent class set the component library exposes) so the sidebar and main panel sit a few px from the window edge with ~10px rounded top and bottom corners and a hairline border, as in `r3-sidebar.html`. Phone sheet unchanged.
- `isActive` uses `startsWith` (`:678-681`); `/integrations/tools` must not match `/integrations/ai`, which `startsWith` already guarantees.

#### 2. Settings flyout, rail and Advanced
**Files**: `app-sidebar.tsx` `footerNav` (`:193-221`), `apps/ui/src/pages/settings/settings-layout.tsx:46-63`, `apps/ui/src/pages/settings/connections-page.tsx`
**Changes**: Settings flyout and `SETTINGS_NAV` list the same entries, in this order: Servers (`/settings/connections`, renamed from "Connections", keeps `everyone: true`), People (`/people`, admin), Appearance, Configuration, Extensions, Runtime pools, Repos, Debug, then an **Advanced** subgroup: Secrets (`/settings/secrets`), Templates (`/templates`, route unchanged), Connection playground (`/settings/connection-playground`, new route mounting `apps/ui/src/pages/connections/playground-panel.tsx`), Raw fetch credentials (`/settings/fetch-credentials`, new route mounting the bindings tab body of `pages/connections/page.tsx`, extracted into its own component). Remove Provider keys and Integrations entries. Update `settings-layout.test.tsx:65-70`.

#### 3. Connect page shells
**Files**: `apps/ui/src/pages/connect-pages/channels-page.tsx`, `tools-page.tsx`, `ai-page.tsx` (new), `apps/ui/src/app/routes.tsx`
**Changes**: Three routes, each `admin(...)` wrapped, no in-page title on desktop (the breadcrumb `Connect › Channels` carries the name; a compact title on phone), and one top row: search on the left, primary action on the right. In this step each page mounts existing components, filtered by catalog category (`apps/ui/src/lib/integrations-catalog.ts`):
- `/integrations/channels`: `IntegrationCard`s for `comm` (`slack`, `chat-sdk`, `kapso`).
- `/integrations/tools`: a tab row `?tab=tools|connections|oauth-apps|mcp` with the search inside the tab row and an "Advanced" link at its end (to Settings › Advanced). `tools` = cards for `issues | crm | observability | email | other`; `connections` = the script connections list from `pages/connections/page.tsx`; `oauth-apps` = its OAuth apps tab; `mcp` = `pages/mcp-servers/page.tsx` body. Keep the `pages/connections/page.tsx` module and its exports (`KindBadge`, `normalizeScriptSlug`, ...); only the route moves.
- `/integrations/ai`: cards for `llm` plus the Provider keys page body (`pages/api-keys/page.tsx`).
- `/integrations` itself redirects to `/integrations/tools`.
- Detail routes: `/integrations/:id` (integration detail, was `/settings/integrations/:id`; static segments `channels|tools|ai` win over `:id` in react-router), `/integrations/tools/connections/:id`, `/integrations/tools/oauth-apps/:id`, `/integrations/tools/mcp-servers/:id`.
- Remove the old route defs for `/connections*`, `/mcp-servers*`, `/settings/api-keys`, `/settings/integrations*`.
- Route handles per `routes.test.tsx:22-29`: `nav({ title: "Channels" | "Tools" | "AI providers", icon, adminOnly, parent: "Connect" })`, entity lists keep `search: ["mcp-servers", "connections"]` or `searchOptOut`.
- Palette provider path for MCP servers (`apps/ui/src/components/command-palette/providers.tsx:339`) → `/integrations/tools/mcp-servers/${id}`.

#### 4. Redirects that keep search and hash
**Files**: `apps/ui/src/app/route-redirect.tsx`, `apps/ui/src/app/routes.tsx:140-165, 570`
**Changes**: `RouteRedirect` takes `to: string | ((params, location) => string)` and appends `location.search` + `location.hash` unless the target already sets them. Entries:
- `/connections` → `/integrations/tools?tab=<old tab: connections|oauth-apps>`; old `?tab=playground` → `/settings/connection-playground`; old `?tab=bindings` → `/settings/fetch-credentials`. Merge `?search`, `?kind`, `?scope`, `?new`.
- `/connections/:id` → `/integrations/tools/connections/:id`; `/connections/oauth-apps/:id` → `/integrations/tools/oauth-apps/:id`.
- `/settings/integrations` → by `?category`: `comm` → `/integrations/channels`, `llm` → `/integrations/ai`, else `/integrations/tools` (keep `?search`).
- `/settings/integrations/:id` → `/integrations/:id`.
- `/mcp-servers` → `/integrations/tools?tab=mcp` (keep `?new=1&name=&url=&transport=`); `/mcp-servers/:id` → `/integrations/tools/mcp-servers/:id` (keep `?oauth=`, `?tab=`, `?error*`).
- `/settings/api-keys` → `/integrations/ai`.
- The legacy `integrations` → `/settings/integrations` entry is removed (Connect owns `/integrations`). Each redirect route keeps the `REDIRECT` handle (`:153`).

#### 5. Stable scrollbar gutters
**Files**: `apps/ui/src/styles/globals.css`, the sidebar content container in `app-sidebar.tsx`, `apps/ui/src/components/shared/collapsible-section.tsx` consumers that scroll
**Changes**: `scrollbar-gutter: stable` on the sidebar scroll area and the main scroll containers, and a transparent scrollbar track (today the track paints a background-colored strip over the sidebar in dark mode, noted in round 3). No width change when a scrollbar appears.

#### 6. Inbound links
**Files** (from the research, § Q4): `pages/connections/oauth-apps/[id]/page.tsx:145,161,199,211,222`; `pages/connections/[id]/page.tsx:92,127,237,245`; `pages/connections/page.tsx:966,2221,2538,3380`; `pages/setup/steps/integrations/business-panes.tsx:107`; `components/layout/breadcrumbs.tsx:91` (+ `routeLabels` for `integrations`, `channels`, `tools`, `ai`); `lib/page-context.ts:46,49` (`ENTITY_ROUTES`); `pages/mcp-servers/page.tsx:85,321`; `pages/mcp-servers/[id]/page.tsx:118,130`; `components/integrations/integration-card.tsx:103`; `pages/integrations/[id]/page.tsx:150,365`; `pages/setup/steps/step-integrations.tsx:176`; `pages/setup/steps/step-ai.tsx:246`; `pages/setup/steps/step-memory.tsx:806`; `pages/usage/subscriptions-card.tsx:220`; `pages/tasks/[id]/task-details-rail.tsx:753`; `pages/home/unified-home.tsx:97`; `pages/connect/page.tsx:515`; `pages/setup/page.tsx:700`; `components/layout/swarm-switcher.tsx:135`.
**Server**: `src/be/automation-preflight.ts:137-145` → `/integrations/<id>` (+ `src/be/automation-preflight.test.ts:73-134`); `src/http/mcp-oauth.ts:53-55` → `/integrations/tools/mcp-servers/<id>?oauth=success`.
**Tests**: `components/dashboard/automation-setup-rows.test.tsx:22-40`, `components/automations/needs-setup-badge.test.tsx:21`, `lib/integrations-catalog.test.tsx:24`, `lib/page-context.test.ts:31,34,55`.
**Docs**: `docs-site/content/docs/(documentation)/ui/configuration.mdx:421,427,440`, `ui/index.mdx:26`, `integrations/chat-sdk.mdx:30,291`, `integrations/serply.mdx:10`, `architecture/memory.mdx:21`, `guides/script-connections.mdx:48`, `guides/provider-auth/codex-oauth.mdx:193`, `guides/harness-configuration.mdx:734`: "Settings → Integrations" becomes "Connect → Channels / Tools / AI providers".

#### 7. Fleet benchmark card to Usage
**Files**: `apps/ui/src/pages/home/unified-home.tsx:25,54`, `apps/ui/src/pages/usage/usage-content.tsx`
**Changes**: Remove the import and mount from Home. Mount `<FleetBenchmarkCard />` at the top of `UsageContent` (above `SubscriptionsCard`, `:299`). The card uses `isAdminLike`; Usage is admin-only in the sidebar, so no visibility change. The Slack Connect perk inside the card moves with it.

#### 8. UI E2E
**Files**: `packages/ui-e2e/specs/routes.ts`, new `packages/ui-e2e/specs/redirects.spec.ts`
**Changes**: Replace `/connections`, `/settings/api-keys`, `/settings/integrations`, `/mcp-servers` smoke entries with `/integrations/channels`, `/integrations/tools`, `/integrations/tools?tab=oauth-apps`, `/integrations/tools?tab=mcp`, `/integrations/ai`, `/settings/connection-playground`, `/settings/fetch-credentials`. `redirects.spec.ts` (`@smoke`): for each old URL with params, `page.goto(old)` then `expect(page).toHaveURL(new)` with the params preserved; also asserts BUILD is collapsed by default, AUTOMATE holds Schedules and Workflows, and People, Templates and Secrets sit in the Settings flyout.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b && bun run test`
- [x] `bun run test:root -- src/be/automation-preflight.test.ts` plus the MCP OAuth test that covers `defaultFinalRedirect` (`rg -l defaultFinalRedirect src/tests`)
- [x] `bun run check:local && bun run tsc:check:tsc`
- [x] `bun run e2e:ui -- --grep "@smoke"` (includes `redirects.spec.ts` and the new Connect routes)
- [x] `rg -n '"/connections|/settings/integrations|/mcp-servers|/settings/api-keys' apps/ui/src src --glob '!**/routes.tsx' --glob '!**/*.test.*'` returns only redirect-table entries

#### Automated QA:
- [x] `AGENT_BROWSER_SESSION=po-step5` against `apps/ui` dev + API: screenshots of the inset sidebar expanded (BUILD collapsed), BUILD expanded, icon-collapsed, phone sheet, the Settings flyout with Advanced, and each Connect page (`/tmp/po-step5-*.png`). Compare side by side with `mockups/post-onboarding/shots/r3-sidebar-1440-light.png`.
- [x] Scrollbar check: expand BUILD until the sidebar scrolls; `agent-browser` eval of a nav row's `getBoundingClientRect().width` is equal with and without the scrollbar.
- [x] Redirect walk with recording: `/connections?tab=oauth-apps`, `/connections?tab=playground`, `/settings/integrations/slack?search=x`, `/settings/integrations?category=llm`, `/mcp-servers?new=1&name=foo&url=https://x`, `/mcp-servers/<id>?oauth=success`, `/settings/api-keys`; assert each final URL via `agent-browser` eval of `location.href`.
- [x] Home no longer shows the fleet benchmark card; Usage shows it at the top. Screenshots of both.
- [x] Cmd+K: "Channels", "Tools", "AI providers", "MCP servers", "Templates" resolve to the new paths. Screenshot of the palette.

#### Manual Verification:
- [ ] Taras compares the built sidebar and Connect shells with the approved mockups once in the dev server.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI implementation routes to Opus per `desplega:delegate-work`. After completing this step, pause for manual confirmation. Commit as `[step-5] Sidebar WORK/AUTOMATE/CONNECT/BUILD + Connect page shells + redirects` after verification passes. Frontend PR: screenshots and the redirect recording in `## Before / after`.

## Implementation notes

Commit `b8d0691a1` on `po/step-5` (2026-11-04).

- **Verification box 1 stays unticked**: `apps/ui` has no `test` script, so the literal command fails at `bun run test`. The equivalent passed: `bun run lint` and `bunx tsc -b` in `apps/ui`, and `bun test apps/ui/src --parallel=4` (2529 pass, 0 fail). `check:local` ran the frozen install.
- **`rg` box**: every hit is an API path (`/api/mcp-servers`), a module import (`./mcp-servers`), or a new `/integrations/tools/mcp-servers` route. No old dashboard route is left outside `routes.tsx`.
- **Full UI E2E** (not only `@smoke`): 143 pass, 28 skipped. `home.spec.ts` and `invites.spec.ts` now check the `Home` link, because Tasks moved into the collapsed BUILD group.
- **Inset**: `Sidebar variant="floating"` (the inner panel is now `rounded-xl`, has the `border` color and no shadow) plus `md:my-2 md:mr-2 rounded-xl border shadow-xs` on `SidebarInset`. A new token `--color-canvas` sits in `globals.css` (light `oklch(0.955 0.003 286)`, dark `oklch(0.105 0.004 286)`). It is not in `BASE_SCOPE_VARS`, because no preset overrides it.
- **Scrollbar**: the base layer already gave `scrollbar-gutter: stable` to `overflow-y-auto`. Sidebar groups drop their right padding (`pr-0`, the gutter is the inset). The icon rail keeps `pr-2`. The track is transparent and the thumb uses `muted-foreground` at 40%, as in the r3 kit. `main` gets `max-lg:[scrollbar-gutter:stable]`. Firefox on macOS uses overlay scrollbars (gutter 0), so there the rows touch the right edge by 8px less. This is a known trade-off of the mockup's gutter-as-padding rule.
- **Icons**: vendored lucide-animated `message-circle` (Channels), `wrench` (Tools) and `cpu` (AI providers) into `components/icons/`.
- **Settings rail** keeps the **Setup** entry (rail only, shown while `/api/onboarding` answers), so `/setup` stays reachable. The flyout has no Setup entry, as before. People has no `1.80.0` version gate in the flyout or the rail. People's users count moved to its flyout entry.
- **Cmd+K**: the static routes `/integrations/tools/{connections,oauth-apps,mcp-servers}` redirect to the matching `?tab=` and carry palette entries ("Script connections", "OAuth apps", "MCP servers", parent "Connect"). "MCP servers" keeps the `mcp-servers` search provider. Apps dropped `adminOnly` in the palette too.
- **Redirects**: `RouteRedirect` merges per key. Target params win, incoming params fill the rest, and the incoming hash is used when the target has none. A `drop` list removes replaced params (`tab` on `/connections`, `category` on `/settings/integrations`). The redirect table lives in `routes.tsx`. The settings-nested redirects (`api-keys`, `integrations`, `integrations/:id`) sit in `settingsRedirectRoutes`. `connectPagePath(category)` (in `lib/integrations-catalog.ts`) maps a category to its Connect page. The redirect and the integration detail back link use it.
- **Shells**: shared helpers live in `pages/connect-pages/connect-shell.tsx` (`IntegrationCardGrid`, `ConnectSearch`, `AddIntegrationMenu`, `ConnectPhoneTitle`). The primary action is an "Add channel / tool / provider" dropdown that links to `/integrations/<id>`. `ScriptConnectionsPanel` (was the default `ConnectionsPage`), `McpServersPanel` and `ProviderKeysPanel` are named exports that take `leading` / `trailing` toolbar nodes, so the Tools tab strip and the search share one row. `pages/integrations/page.tsx` (the old list with its legend) is deleted. On the Script connections tab at 1440px, the filters wrap to a second row because the tabs, search, two selects, the columns menu, + and Advanced do not fit in one row. step-6 rebuilds that tab.
- **Fleet benchmark**: moved to the top of `UsageContent` (above the toolbar). The card still hides its "telemetry off" state while the Home telemetry banner would ask (`bannerAsks`). The banner (`DashboardNudges`) stays on Home. With telemetry off and the banner up, Usage shows only the Slack Connect perk. step-15 may want to drop that coupling now that they are on different pages.
- **Not visually verified**: the AI providers warning dot. The seed has no rate-limited or rejected key. The code reads `useApiKeyStatuses` (new `enabled` option), gated on `1.82.0` and admin.

Manual verification pending: Taras compares the sidebar and the Connect shells with the mockups.
