---
id: step-1
name: File link target + Comb out of beta
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: File link target + Comb out of beta

## Overview

Add one operator env, `AGENT_FS_LINK_TARGET=dashboard|live`, and one resolver that every people-facing file link reads: the agent base prompt and task attachment links. Unset keeps today's behavior on every surface. Remove the "beta" label from Comb. When done, `AGENT_FS_LINK_TARGET=dashboard` makes agents give `<APP_URL>/file/~/<org>/<drive>/<path>` links, and Settings > Configuration has the toggle.

Today (main `4b88368b5`):
- The prompt never interpolates a URL. Template `system.agent.outputs` (`src/prompts/session-templates.ts:193-208`, `variables: []`) tells the agent to expand `${AGENT_FS_LIVE_URL}` in its own shell (lines 204-205). `src/tests/base-prompt.test.ts:493` pins that sentence.
- Attachments already prefer the dashboard: `taskAttachmentDisplayUrl` (`src/utils/task-attachment-links.ts:32-46`) returns `buildCombFileUrl(file) ?? buildAgentFsLiveUrl(file)`. `buildCombFileUrl` (`src/utils/constants.ts:177-181`) needs `isCombEnabled()` and an explicit `APP_URL`/`DASHBOARD_URL`. `opts.comb === false` forces live (citations and the context preamble rely on it).
- The worker builds the prompt (`src/prompts/base-prompt.ts:225-235`). Worker `process.env` gets only `RELOADABLE_ENV_KEYS` from config rows (`src/commands/runner.ts:1231-1259`).

## Changes Required:

#### 1. Resolver
**File**: `src/utils/constants.ts` (next to `getAgentFsLiveUrl`, lines 81-90)
**Changes**:
- `export type AgentFsLinkTarget = "dashboard" | "live"`.
- `export function readAgentFsLinkTarget(): AgentFsLinkTarget | null`: trim and lowercase `process.env.AGENT_FS_LINK_TARGET`. Return `null` for unset, blank or invalid.
- `export function resolveAgentFsLinkBase(surface: "prompt" | "attachment"): string | null`:
  - target `live`: `getAgentFsLiveUrl()`.
  - target `dashboard`: `getAppUrl()` when `getConfiguredAppUrls().length > 0`. For `surface === "attachment"` also require `isCombEnabled()`. Else fall back to `getAgentFsLiveUrl()`.
  - target `null`: return `null`. Callers keep their current code path.
- The prompt surface does not check `isCombEnabled()`: workers have no `COMB_ENABLED`. An explicit `dashboard` is the operator's choice.

#### 2. Attachments
**File**: `src/utils/task-attachment-links.ts` (lines 40-45)
**Changes**: When `opts.comb !== false` and `readAgentFsLinkTarget()` is not null, build `${resolveAgentFsLinkBase("attachment")}/file/~/${agentFsFileRoute(file)}`. Keep the current code for the null target. Keep `opts.comb === false` forcing live. Reuse `agentFsFileRoute` (`constants.ts:114-141`) so encoding and dot-segment rules stay the same. It returns `null` for a bad path (`constants.ts:128`): fall back to `agent-fs:<path>`, as line 44 does today.

#### 3. Prompt
**Files**: `src/prompts/session-templates.ts:193-208`, `src/prompts/base-prompt.ts:225-235`
**Changes**:
- Add one variable, `fileLinkBase`, to the existing `system.agent.outputs` template (declare it in `variables`, using the registry's normal syntax). Replace the literal `${AGENT_FS_LIVE_URL}` in the link sentence with `{{fileLinkBase}}`.
- In `getBasePrompt`, pass `fileLinkBase = resolveAgentFsLinkBase("prompt") ?? "${AGENT_FS_LIVE_URL}"`. Unset env therefore renders the same bytes as today. Operator overrides of the template keep working (an override without the variable ignores it).
- Do not hard-code prompt text in the call site (repo rule: prompt text goes through `src/prompts/`).
- If a test or catalog pins the template's variable list, update it: `src/tests/prompt-template-session.test.ts:21-40,114` and `src/be/seed-scripts/catalog/ops-catalog-audit.ts:41` (plus its `.inline.ts`).

#### 4. Worker env
**File**: `src/commands/runner.ts:1231` (`RELOADABLE_ENV_KEYS`) and its doc comment (1195-1229)
**Changes**: Add `AGENT_FS_LINK_TARGET` so a Settings change reaches the worker prompt at the next poll. Do not add `APP_URL` or `COMB_ENABLED` (other worker code reads them). Step-4 writes `APP_URL` into each agent's compose env for new installs.

#### 5. Config validation, catalog and docs
**Files**:
- `src/be/swarm-config-guard.ts`: add `...enumValidator("AGENT_FS_LINK_TARGET", ["dashboard", "live", ""])` next to the `AGENT_FS_PUBLIC_URL` validator (lines 407-412). Copy the enum pattern at lines 197-206 and 323.
- `apps/ui/src/lib/configuration-catalog.ts`: entry after `COMB_ENABLED` (about line 1364), group `integrations`, `kind: "enum"`, options `live` and `dashboard`, no default display of `live` (unset means "automatic, as before"), `docsUrl` to `ui/comb#links-to-agent-fs-files`. Description: "Where agents and task attachments link people for files. dashboard opens Comb at APP_URL and needs Comb on. Workers need APP_URL in their own environment (a saved APP_URL does not reach them). live opens the agent-fs live app. Unset keeps the automatic choice."
- Docs: `docs-site/content/docs/(documentation)/ui/comb.mdx` ("Links to agent-fs files", lines 229-243), `ui/configuration.mdx` (Comb section, line 390, and the Integrations key table, line 79), `reference/environment-variables.mdx` (agent-fs table, lines 530-540).
- `src/tests/preload.ts` (lines 30-44) and `src/tests/preload-env.test.ts` (lines 11-24): add `AGENT_FS_LINK_TARGET`.

#### 6. Comb out of beta
**Files**: `apps/ui/src/components/layout/app-sidebar.tsx:149` (remove the `beta` entry on the Comb item; keep `BetaTag` for other items), `apps/ui/src/lib/configuration-catalog.ts:1365` (label "Comb"), `docs-site/content/docs/(documentation)/ui/comb.mdx:2` and `:35`, `ui/configuration.mdx:390`.
**Changes**: Label and badge text only. No behavior change.

### Success Criteria:

#### Automated Verification:
- [x] Link tests: `bun run test:root -- src/tests/comb-links.test.ts src/tests/agent-fs-live-url.test.ts` (add a `describe("AGENT_FS_LINK_TARGET")` with cases unset, `live` on a Comb + APP_URL install, `dashboard` with and without Comb, invalid value, `comb: false` still live)
- [x] Prompt tests: `bun run test:root -- src/tests/base-prompt.test.ts src/tests/prompt-template-session.test.ts` (unset gives the exact old sentence; `dashboard` with `APP_URL` gives `<APP_URL>/file/~/`; `dashboard` without `APP_URL` gives the live base)
- [x] Validator: `bun run test:root -- src/tests/comb-config-guard.test.ts` (accepts `dashboard`, `live`, blank; rejects `Dashboard2`)
- [x] Preload lists: `bun run test:root -- src/tests/preload-env.test.ts`
- [x] Catalog sanity: `bun run test:root -- apps/ui/src/lib/configuration-values.test.tsx`
- [ ] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] Settings round trip with the Playwright template: `bun run e2e:ui -- --no-build specs/configuration.spec.ts` after adding a case that sets `AGENT_FS_LINK_TARGET` to `dashboard`, reloads, and reads it back through `GET /api/config?scope=global`
- [x] Template check on a booted API (fresh worktree, no `.env`, `DATABASE_PATH` in `/tmp/afo-step-1/`): `POST /api/prompt-templates/render` (`src/http/prompt-templates.ts:135`, read its body schema) renders `system.agent.outputs` with `fileLinkBase=http://localhost:5274`, and the text contains `http://localhost:5274/file/~/`. `PUT /api/config` with `{"scope":"global","key":"AGENT_FS_LINK_TARGET","value":"Dashboard2"}` returns 400.
- [x] agent-browser screenshot of Settings > Configuration showing the new row and the Comb label without "beta" (`AGENT_BROWSER_SESSION=afo-step-1`)

#### Manual Verification:
- [ ] Taras reads the new prompt sentence once and accepts the wording

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-1] file link target and Comb out of beta` after verification passes.
