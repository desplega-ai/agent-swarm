---
id: step-6
name: "Connect › Tools: one card per provider, tabs, search"
track: C
depends_on: [step-5, step-16]
status: ready
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
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- tools-page provider-status`
- [ ] `bun run test:root -- $(rg -l "oauth-presets|script-connections" src/tests | tr '\n' ' ')`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `bun run e2e:ui -- --grep "@smoke"`

#### Automated QA:
- [ ] Seed through the API: `PUT /api/config` with `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET`, and `POST /api/oauth-apps` with a `google` preset. `AGENT_BROWSER_SESSION=po-step6`: `/integrations/tools` shows Linear "Configured · OAuth app" and Gmail "OAuth app"; screenshot next to `mockups/post-onboarding/shots/r4-connect-1440-light.png`.
- [ ] The Script connections add dialog lists no Linear or Jira preset (snapshot). `GET /api/oauth-presets` still returns them with `hiddenInCatalog: true`.
- [ ] `/integrations/tools?tab=mcp&new=1&name=demo&url=https://example.test/mcp` opens the MCP create form prefilled. Screenshot.
- [ ] Typing in the tab-row search filters the OAuth apps tab. Screenshot.

#### Manual Verification:
- [ ] Taras compares the Tools page with the approved mockup.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-6] Connect › Tools` after verification passes. Frontend PR: screenshots in `## Before / after`.
