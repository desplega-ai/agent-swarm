---
id: step-3
name: In-app file links by default + files-first delivery prompt
track: A
depends_on: [step-2]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-3
claimed_at: 2026-11-04T16:59:57Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: In-app file links by default + files-first delivery prompt

## Overview
Agents link files to the dashboard by default whenever `APP_URL` (or `DASHBOARD_URL`) is set, instead of `live.agent-fs.dev`. The outputs prompt tells agents to deliver use-case results as markdown files under the task's asset key in the shared drive (drive path = key string), to link the in-app path, and to create a Page only when asked. After this step, a rendered lead prompt on a stack with `APP_URL` shows `https://<app>/file/~/...` as the link base and the files-first rule.

## Changes Required:

#### 1. Link target default
**File**: `src/utils/constants.ts:118-139`
**Changes**: `readAgentFsLinkTarget()` returns `"dashboard"` when unset and `getAppUrl()` is configured (not the hard-coded fallback). `resolveAgentFsLinkBase(surface)` therefore returns the app URL by default; it still returns the live URL when neither `APP_URL` nor `DASHBOARD_URL` is set, and `AGENT_FS_LINK_TARGET=live` still forces the live UI. Update `src/tests/comb-links.test.ts` (`:172-174` asserts the null return today) and `src/tests/agent-fs-live-url.test.ts`.

#### 2. `APP_URL` reaches workers through swarm config
**Files**: `src/commands/runner.ts:1239-1253` (`RELOADABLE_ENV_KEYS`), `apps/ui/src/lib/configuration-catalog.ts` (Branding group; today the `AGENT_FS_LINK_TARGET` entry at `:1462` says "a saved APP_URL does not reach them"), `src/be/swarm-config-guard.ts` (`VALIDATED_KEYS`), `docker-compose.example.yml`, `charts/agent-swarm/templates/pool-statefulset.yaml`, `charts/agent-swarm/values.yaml`
**Changes**: Add `APP_URL` to `RELOADABLE_ENV_KEYS` so a global `swarm_config` row reaches every worker on the next reload, the way `AGENT_FS_LINK_TARGET` does today. Register `APP_URL` in the configuration catalog (`kind: string`, https URL validator) and rewrite the `AGENT_FS_LINK_TARGET` description. The deployment env stays as the fallback: the compose example passes `APP_URL` to lead and workers, Helm passes `appUrl`. `fileLinkBase` is computed in the worker (`src/prompts/base-prompt.ts:252-260`), which is why the key must be in the reloadable set. Document in `runbooks/local-development.md`, `docs-site/content/docs/(documentation)/ui/configuration.mdx` and `guides/agent-fs-co-deployment.mdx`.

#### 3. Files-first delivery prompt
**File**: `src/prompts/session-templates.ts:208-229` (`system.agent.outputs`)
**Changes**: Replace the "live app link" sentence (`:219`) with: deliver results as files, not Pages, unless the requester asks for a Page or an app. Write use-case results under the task's asset key in the shared drive: the drive path equals the key string (`shared/<slug>/report-<YYYY-MM-DD>.md`), so later runs can read earlier reports in the same folder and compare. Link files as `{{fileLinkBase}}/file/~/<org>/<drive>/<path>`; this opens in the dashboard. Keep `system.agent.outputs.no_agent_fs` (`:231-`) unchanged apart from the Page rule. Prompt text is static (no per-task variables beyond `fileLinkBase`), so the system prompt stays cache-stable (`base-prompt.ts:13-20`).

#### 4. Skills that mention the live URL
**Files**: `templates/skills/agent-browser/content.md:68`, `templates/skills/work-on-task/content.md:11`, `templates/skills/qa/content.md:97`, `templates/workflows/dreaming/content.md:852`
**Changes**: Replace `${AGENT_FS_LIVE_URL}/file/~/...` with "the file link base from your system prompt (dashboard when configured)". Run `bun run build:skill-md` for any directory with a generated `SKILL.md`, then `bun run check:skill-md && bun run check:skill-sources`.

#### 5. Tests
**Files**: `src/tests/comb-links.test.ts`, `src/tests/prompt-template-session.test.ts`, `src/tests/base-prompt.test.ts`
**Changes**: Assert the default link base with `APP_URL` set, the live fallback without it, and that the rendered outputs template contains "drive path equals the key" and "Page only when asked" phrasing.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/comb-links.test.ts src/tests/agent-fs-live-url.test.ts` plus the prompt test file touched
- [x] `bun run check:local && bun run tsc:check:tsc`
- [x] `bun run build:skill-md && bun run check:skill-md && bun run check:skill-sources && git diff --exit-code templates/`
- [ ] `rg -n 'AGENT_FS_LIVE_URL\}/file' templates src/prompts` returns nothing

#### Automated QA:
- [x] Render the lead prompt in a one-off script: `APP_URL=https://app.example.test AGENT_FS_API_URL=http://localhost:7433 bun -e 'import {getBasePrompt} from "./src/prompts/base-prompt"; ...'` (follow the signature in `src/prompts/base-prompt.ts`) and assert the output contains `https://app.example.test/file/~/` and the files-first sentence, and does not contain `live.agent-fs.dev`.
- [x] Same render with `APP_URL` unset contains `live.agent-fs.dev`.
- [x] `docker compose -f docker-compose.example.yml config | rg -n APP_URL` shows the var on the lead and worker services.
- [x] `PUT /api/config` with a global `APP_URL`, then the resolved-env fetch a worker performs (harness in `src/tests/fetch-resolved-env.test.ts`) returns that value; a rendered worker prompt uses it as the link base.

#### Manual Verification:
- [ ] Taras reads the new outputs paragraph once for tone (STE rules: short sentences, no hedging).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. Commit as `[step-3] In-app file links by default + files-first delivery prompt` after verification passes.

## Implementation notes

- Commit `61e053a94` on `po/step-3`. Done by Claude alone (small backend, no Codex round).
- `readAgentFsLinkTarget()` never returns null now: explicit value, else `dashboard` with a configured `APP_URL` / `DASHBOARD_URL`, else `live`. `resolveAgentFsLinkBase()` always returns a base, so the prompt no longer carries the `${AGENT_FS_LIVE_URL}` shell literal (without `APP_URL` it shows the resolved live URL, `https://live.agent-fs.dev` by default). The prompt surface still skips the Comb check, as before.
- `buildCombFileUrl` was dead after the default flip (the attachment path always gets a base), so it is removed. Attachment output is unchanged for every old case; tests cover it.
- Track B input: new `agentFsFileLinkQuery(base)` adds `?apiUrl=<AGENT_FS_PUBLIC_URL>` to live-app links only (prompt link, `buildAgentFsLiveUrl`, attachment links incl. citations and the context preamble). Dashboard links never get it. Only `AGENT_FS_PUBLIC_URL` counts as "public": the proxy URL `<public API>/agentfs` sends no CORS grant to the live app origin, so it is not used. Workers see the query only when `AGENT_FS_PUBLIC_URL` is in their own env (it is not in the reloadable set). The memory link-resolver regex stops at `?`, and the UI `liveUrlToCombPath` parses with `URL`, so both ignore the query.
- Outputs template gets a second variable `fileLinkQuery`. Text is static per deployment (no per-task values), so the system prompt stays cache-stable. The task key pointer is `key` in `get-task-details` (the task prompt does not carry the key today; step-12 may add more).
- `APP_URL` validator accepts blank or a comma-separated list of http(s) URLs (no query or fragment), not https only: local stacks use `http://localhost:5274`, and the invite dialog already saves `window.location.origin` as a global `APP_URL`. The catalog entry sits in Branding & URLs next to `DASHBOARD_URL`, now labeled deprecated (a saved `DASHBOARD_URL` is not reloadable and does not reach workers).
- Helm: no template change needed. `config.appUrl` already reaches every pool through the shared `-config` configmap (`envFrom` in `pool-statefulset.yaml`). Only the values comment changed. `helm` is not installed here, so no `helm template` run.
- Compose example: `APP_URL=${APP_URL:-}` added to the lead and all 11 worker services.
- Skills: `agent-browser`, `work-on-task`, the showreel template (SKILL.md, PLAYBOOK.md and its docs page), and the dreaming workflow now say "the file link from the Outputs section of your system prompt (the dashboard when configured)". Not changed: `templates/skills/qa/content.md` is vendored from ai-toolbox and pinned by SHA-256 (`templates/ai-toolbox.manifest.json`), so a local edit fails `check:ai-toolbox-skills`. That is why the `rg` box stays unticked: its only hit is qa line 97. Fix belongs upstream in ai-toolbox, then a re-pin. Also not changed (out of the step's rg scope): `plugin/commands/create-pr.md` (Swarm provenance link convention).
- Verification evidence: touched tests 232 pass. `check:local` exit 0 (4724 tests pass). `tsc:check:tsc`, `lint`, `lint:slop`, apps/ui `lint` + `tsc -b`, `check:skill-md`, `check:skill-sources`, `check:seed-skill-files`, `check:ai-toolbox-skills` pass. `git diff --exit-code templates/` clean after the commit.
- QA: lead prompt render with `APP_URL=https://app.example.test`: 1 `https://app.example.test/file/~/`, 0 `live.agent-fs.dev`, `## Outputs` and the files-first sentences each exactly once. Without `APP_URL`: the live host. With `AGENT_FS_PUBLIC_URL` and no `APP_URL`: `...<path>?apiUrl=https%3A%2F%2Ffs.example.test`. Live API on a free port with a fresh DB: `PUT /api/config` global `APP_URL` 200 (an invalid value 400), real `fetchResolvedEnv` returned it, `applyResolvedEnvToProcessEnv` changed `APP_URL`, and the rendered worker prompt linked `https://app.example.test/file/~/...`. Compose config with `APP_URL` set shows it on api, lead and 11 workers.

