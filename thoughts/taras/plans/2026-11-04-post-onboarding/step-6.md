---
id: step-6
name: "Connect › Tools: one card per provider, tabs, search"
track: C
depends_on: [step-5, step-16]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-6
claimed_at: 2026-11-04T15:54:22Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Connect › Tools: one card per provider, tabs, search

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r4-connect.html` (Tools states). Decisions: `root.md § Design decisions (step-16)`, rounds 3 and 4.

## Overview
`/integrations/tools` becomes the one place for work tools. The tab row holds Tools | Script connections | OAuth apps | MCP servers, the search field and a quiet "Advanced" link (to Settings › Advanced). The Tools tab shows one card per provider that merges every storage family at the UI level: `swarm_config` keys (today's Integrations cards), `oauth_apps` + `oauth_authorizations` presence and, for Linear and Jira, both. The Linear and Jira presets leave the Script connections "add" catalog, so each provider has one canonical flow. No backend merge. After this step, a swarm with Linear configured through `/setup` shows a single Linear card that reads "Connected · OAuth authorized" and links to `/integrations/linear`.

## Changes Required:

#### 1. Merged provider status
**Files**: `apps/ui/src/lib/integrations-status.ts` (extend `deriveIntegrationStatus`), `apps/ui/src/lib/provider-status.ts` (new)
**Changes**: `deriveProviderStatus(def, { configs, presence, oauthApps, oauthAuthorizations, scriptConnections })` returns `{ configured, oauth: "none"|"app"|"authorized", scriptConnections: number }`. Inputs come from existing hooks `useConfigs({scope:"global"})`, `useEnvPresence`, `useOAuthApps`, `useScriptConnections` (client methods at `apps/ui/src/api/client.ts:2169-2405`). Catalog ids `linear`, `jira`, `slack`, `github` map to the same-named OAuth preset provider; presets `google` (Gmail) and `microsoft` (MS365) become cards using `oauth_*` presence only.

#### 2. Tools tab
**Files**: `apps/ui/src/pages/connect-pages/tools-page.tsx` (from step-5), `apps/ui/src/components/integrations/integration-card.tsx`
**Changes**: Card anatomy as in the mockup: icon, name, one-line purpose, status chip, outline action button, "N script connections" link to `?tab=connections&search=<provider>`. Grid order: core (`slack` is NOT here, it lives on Channels; `github`, `gitlab`, `bitbucket`, `linear`, `jira`), then Gmail and MS365, then "More tools" (`attio`, `sentry`, `agentmail`, `composio`, `serply`, `gsc`, `agentfs`, `business-use`). `automation-preflight` links to `agentmail`, `gsc`, `agentfs` detail pages, so those ids keep resolving at `/integrations/:id`. The search in the tab row filters the active tab's list (cards, connections, OAuth apps or MCP servers) client-side.

#### 3. OAuth apps and MCP servers tabs
**Files**: `apps/ui/src/pages/connections/page.tsx` (extract the OAuth apps tab body into `components/connections/oauth-apps-list.tsx`), `apps/ui/src/pages/mcp-servers/page.tsx`
**Changes**: OAuth apps tab lists apps with provider, status, scopes count and connected-accounts count, as in the mockup. MCP servers tab lists servers with transport, status and installed-on count; the "new server" deep link (`?tab=mcp&new=1&name=&url=&transport=`) still opens the create form prefilled.

#### 4. One canonical flow for Linear and Jira
**Files**: `src/oauth/presets.ts:154,172`, the add dialog in `apps/ui/src/pages/connections/page.tsx`, `src/http/script-connections.ts`
**Changes**: Add `hiddenInCatalog: true` to the `linear` and `jira` presets (existing rows keep resolving). The add dialog filters hidden presets. The Linear and Jira detail pages (`apps/ui/src/pages/integrations/[id]/page.tsx`, special flows `linear-oauth` / `jira-oauth`) show the OAuth authorization status from `oauth_*`, so the user never needs the preset. `GET /api/oauth-presets` response schema gains the optional field (`bun run docs:openapi`).

#### 5. Tests
**Files**: `apps/ui/src/lib/provider-status.test.ts` (new), `apps/ui/src/pages/connect-pages/tools-page.test.tsx` (new), the presets test in `src/tests/` (`rg -l oauth-presets src/tests`)
**Changes**: Status derivation for Linear (keys only; keys + app; keys + app + authorization), Gmail with an authorization, GitHub with `GITHUB_TOKEN` presence. Hidden presets excluded from the catalog list but returned by id. Search filters each tab.

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- tools-page provider-status`
- [x] `bun run test:root -- $(rg -l "oauth-presets|script-connections" src/tests | tr '\n' ' ')`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [x] `bun run e2e:ui -- --grep "@smoke"`

#### Automated QA:
- [x] Seed through the API: `PUT /api/config` with `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET`, and `POST /api/oauth-apps` with a `google` preset. `AGENT_BROWSER_SESSION=po-step6`: `/integrations/tools` shows Linear "Configured · OAuth app" and Gmail "OAuth app"; screenshot next to `mockups/post-onboarding/shots/r4-connect-1440-light.png`.
- [x] The Script connections add dialog lists no Linear or Jira preset (snapshot). `GET /api/oauth-presets` still returns them with `hiddenInCatalog: true`.
- [x] `/integrations/tools?tab=mcp&new=1&name=demo&url=https://example.test/mcp` opens the MCP create form prefilled. Screenshot.
- [x] Typing in the tab-row search filters the OAuth apps tab. Screenshot.

#### Manual Verification:
- [ ] Taras compares the Tools page with the approved mockup.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-6] Connect › Tools` after verification passes. Frontend PR: screenshots in `## Before / after`.

## Implementation notes

Commit `1470eedbb` on `po/step-6`.

- `check:local` is red only on `src/tests/docs-index-footprint.test.js` (expects 472 operations, the spec has 474). The same test fails on the base `e93c39161` in the orchestrator worktree, so it is pre-existing (wave 1 added the routes). `tsc:check:tsc` passes. Box left unticked.
- apps/ui has no `test` script: ran `bun test tools-page provider-status` (12 pass). Full `bun test` in apps/ui: 111 fail on this branch vs 112 on the base (pre-existing alias/mock-order failures).
- Status merge lives in `apps/ui/src/lib/provider-status.ts`. `deriveIntegrationStatus` needed no change. `configured` is the `IntegrationStatus` (not a boolean), plus `accounts` (active authorizations). OAuth "authorized" means an active authorization; revoked or expired ones read as "app".
- Gmail and Microsoft 365 are local defs (`OAUTH_ONLY_TOOLS`, ids `gmail`, `microsoft-365`), not catalog entries. Their action opens the OAuth app detail page, or the Add OAuth app dialog prefilled from the preset (`?tab=oauth-apps&new=oauth-app&preset=<provider>`, new `initialPresetId` prop on `OAuthAppDialog`).
- Card chip: "Connected" when an account is authorized (new optional `connected` prop on `IntegrationStatusBadge`), else the integration status. Footer: "OAuth app" / "OAuth authorized" / "OAuth · N accounts", then the "N script connections" link to `?tab=connections&search=<term>` (term = host word, for example `atlassian` for Jira). `IntegrationCard` gains optional `meta`, `href`, `actionLabel`, `connected`; Channels and AI pages render unchanged.
- "More tools" in use (any storage family set) join the grid; the rest sit behind "Show N more". A search shows every match.
- Tab search is client-side per tab (`apps/ui/src/lib/tools-search.ts`). Script connections, OAuth apps and MCP servers pre-filter rows instead of AG Grid `quickFilterText`, so the card count and the linked list agree.
- One-row toolbar at 1440px: Kind/Scope and Transport/Scope selects moved into `FiltersPopover`; `DataGridColumnsMenu` got an optional `compact` icon trigger (shared file `components/shared/columns-menu.tsx`, additive). Add actions are labelled ("Add connection", "Add OAuth app", "Add server"); the Tools tab Add opens a menu (Script connection, OAuth app, MCP server) as in the mockup.
- OAuth apps list extracted to `apps/ui/src/pages/connections/components/oauth-apps-list.tsx` (next to `catalog-browser.tsx`, which already imports from the page). Columns: App (+ source tag, legacy-callback warning), Status, Scopes, Connected accounts, Client ID, actions. Redirect URI column dropped (still on the detail page). The mockup footnote "GitHub, Linear and Jira ... not in this list" is not shown: Linear and Jira apps are real `oauth_apps` rows and stay listed.
- MCP "Installed on" needed data the list lacked: `GET /api/mcp-servers` now returns optional `installCount` per server (`src/be/db-queries/mcp-servers.ts`, not `db.ts`: the db.ts facade is frozen by `db-task-read-contract.test.ts`). Assertions added to the `platform-mcp-servers` e2e scenario (`bun run e2e --only platform-mcp-servers` passes).
- Phone (below md): OAuth apps and MCP servers render `MobileListRow`s. Script connections keeps its DataGrid (body unchanged). The phone tab row scrolls; search and Add sit on the next row (not pinned right of the tabs as in the mockup).
- Linear and Jira detail pages already show the OAuth status from `oauth_*` (`/api/trackers/<provider>/status` reads `getOAuthTokens`, which reads `oauth_authorizations`). No change needed; verified "Connected to Linear" after seeding an authorization.
- Hidden presets are filtered in three pickers: the Script connections catalog (blessed entries with a hidden `presetId`), the Add OAuth app preset select, and the inline OAuth connect preset select (a selected hidden preset stays visible for edits).
- QA seeded `LINEAR_SIGNING_SECRET` too: with only ID and secret the chip reads "Partial", which is correct per the catalog's required fields.
- Pre-existing bug found (not fixed, shared hook): URL-bound search inputs (`useUrlSearchState`, also on Channels from step-5) drop characters when keys arrive faster than a render (`agent-browser keyboard type "telegram"` gave `tegram`). Human-speed typing works.

