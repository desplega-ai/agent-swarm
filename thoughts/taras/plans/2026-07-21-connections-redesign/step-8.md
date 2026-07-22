---
id: step-8
name: Tracker fold — Linear/Jira on the unified core
depends_on: [step-4, step-5]
status: ready
---

# step-8: Tracker fold — Linear/Jira on the unified core

## Overview
Fold the Linear/Jira tracker OAuth flows fully onto the unified core: `/api/trackers/*` OAuth routes become thin wrappers over the unified authorize/callback/refresh surface, the `RESERVED_OAUTH_PROVIDERS` carve-out disappears, boot-time seeding writes quirk columns directly, tracker clients read tokens via the authorization-keyed API (with the Linear SDK-cache invalidation preserved), and the remaining hardcoded Jira special-cases are deleted. Tracker behavior — webhooks, task-sync, keepalive alerting — is unchanged from the outside.

## Changes Required:

#### 1. Boot seeding on unified columns
**Files**: `src/jira/app.ts` / `src/linear/app.ts` (or wherever `initJira`/`initLinear` live — locate exactly at implementation time), `src/jira/oauth.ts`, `src/linear/oauth.ts`
**Changes**: Seeding upserts `oauth_apps` rows with quirk columns (`scopeSeparator=','` linear, `requiresRefreshTokenRotation=1` + `extraParamsJson={"audience":"api.atlassian.com"}` jira, `actor` stays in metadata) — `getJiraOAuthConfig`/`getLinearOAuthConfig` shrink to `oauthAppRowToProviderConfig` calls; delete the duplicated rotation/separator hardcoding (`src/jira/oauth.ts:18-34`, `src/linear/oauth.ts:8-23`). **Redirect-URI continuity**: existing provider-console registrations point at `/api/trackers/{provider}/callback` — those routes keep working as wrappers (step-4 handler), and seeding records the static callback as the going-forward URI; both remain valid during transition.

#### 2. Tracker routes as thin wrappers
**Files**: `src/http/trackers/linear.ts`, `src/http/trackers/jira.ts`
**Changes**: `authorize` → unified authorize-url for the seeded app (label `'default'`, `flow='tracker'`) + 302; `callback` → delegate into the unified state-keyed handler (Jira cloudId post-processing now lives in the `flow='tracker'` branch — verify it landed there in step-4, move if not); `refresh` → `forceRefreshAuthorizationOrThrow`; `status`/`disconnect` → unified reads/revoke (Jira keeps its no-remote-revoke manual note, Linear keeps best-effort revoke via `revocationUrl` column). Webhook routes untouched. Keep URLs + response shapes identical (UI/settings pages and any external bookmarks depend on them).

#### 3. Carve-out removal
**Files**: `src/oauth/app-validation.ts` (delete `RESERVED_OAUTH_PROVIDERS` + `assertOAuthProviderIsNotReserved`), call sites `src/http/script-connections.ts:1484`, `src/tools/credential-bindings/tool.ts:228`, `src/http/oauth-generic.ts` (linear-only 409 already dropped in step-4 — confirm)
**Changes**: `linear`/`jira` apps are now ordinary rows manageable from the generic surface. Guard against foot-guns: deleting an app that has `metadata.webhookIds` or is the seeded tracker app warns in the response (tracker integration would degrade) but is allowed.

#### 4. Tracker runtime reads on authorization keys
**Files**: `src/jira/client.ts` (`getJiraAccessToken` → ensure+read by the seeded app's default authorization), `src/linear/client.ts` + `src/linear/outbound.ts:97,147,196` (same; `resetLinearClient()` calls preserved after every refresh — additionally invoked from the unified refresh path via a small callback/subscription so sweep-driven refreshes also invalidate the cached SDK client, closing today's staleness gap), `src/tools/oauth-access-token.ts` (accepts provider or authorizationId)
**Changes**: 401-retry and 429 handling in `jiraFetch` unchanged.

#### 5. Tests
**Files**: `src/tests/tracker-fold.test.ts` (new), existing tracker/webhook tests updated only where imports moved
**Changes**: Seeding produces column-correct apps (rotation flag, separator, audience param); tracker authorize/callback wrapper completes a mock dance and lands tokens in the default authorization; refresh rotation strictness preserved (mock omits new refresh_token → throws); disconnect semantics per provider; carve-out gone (upserting a `linear` app via generic surface succeeds); sweep-driven refresh triggers Linear client reset (spy).

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/tracker-fold.test.ts src/tests/oauth-keepalive.test.ts src/tests/oauth-callback-flow.test.ts`
- [ ] Whole-repo gates: `bun run tsc:check` && `bun run lint` && `bun test` (tracker code is widely imported — full suite here)
- [ ] `bun run docs:openapi` — commit artifacts (tracker route descriptions changed)

#### Automated QA:
- [ ] Boot with `LINEAR_DISABLE`/`JIRA_DISABLE` unset + mock provider endpoints: drive `GET /api/trackers/linear/authorize` → mock dance → `GET /api/trackers/linear/status` shows connected; `POST /api/trackers/linear/refresh` works; repeat for jira incl. cloudId capture into metadata
- [ ] `GET /api/oauth-apps` now lists linear/jira rows alongside script-connection apps with correct source/quirks

#### Manual Verification:
- [ ] Real Linear (or Jira) dance against the dev workspace: connect, sync a task, confirm webhook + outbound still work with tokens served from the unified store

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-8] tracker fold onto unified core` after verification passes.
