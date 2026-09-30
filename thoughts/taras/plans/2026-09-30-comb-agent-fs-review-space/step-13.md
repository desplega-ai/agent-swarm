---
id: step-13
name: Links stay in-app
depends_on: [step-5]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-13: Links stay in-app

**Repo:** agent-swarm. Uses the step-4 `/status` comb block (`enabled`, `live_url`, `org_id`, `drive_id`), `useAgentFs()`, and the step-5 route `/file/~/<org>/<drive>/<path>` + `lib/comb/paths.ts`. Works against agent-fs v0.14.0.

## Overview

agent-fs links stop leaving the dashboard. In the dashboard, a link to an agent-fs file (task attachments, markdown links in tasks and sessions, citations) opens Comb in the same tab when Comb is enabled AND the user is connected. Otherwise it opens `live/` as today. On the server, Slack messages and agent prompts link to `APP_URL/file/~/...` when Comb is enabled and `APP_URL` is configured. A Comb page opened without a key shows the Connect card plus "Open in agent-fs" (already true from step-4/5). The live URL comes from one server setting (`AGENT_FS_LIVE_URL`, exposed as `status.agent_fs.comb.live_url`), which ends the UI/server env-name split (`VITE_AGENT_FS_LIVE_URL` stays only as a fallback).

When done: clicking an agent-fs attachment in a task opens the file in Comb, and a Slack attachment link points at the dashboard.

## Changes Required:

#### 1. Dashboard
**File**: `apps/ui/src/lib/comb/links.ts` (new)
**Changes**:
- `liveUrlToCombPath(href, liveUrl)`: `<liveUrl>/file/~/<org>/<drive>/<path>` and `<liveUrl>/detail/~/<org>/<drive>/<path>` → `/file/~/<org>/<drive>/<path>`. Keep query `?comment=` if present. Return null for anything else.
- `appUrlToCombPath(href, appOrigin)`: `<origin>/file/~/...` → the same path (for links the server wrote with `APP_URL`).
- `isCombNavigable(state)`: Comb `ready`.

**File**: `apps/ui/src/components/shared/task-attachment-link.tsx`
**Changes**: `buildAgentFsLiveUrl` uses `status.agent_fs.comb.live_url` first, then `VITE_AGENT_FS_LIVE_URL`, then the default. Fall back to `status.agent_fs.comb.org_id/drive_id` when the attachment row lacks ids (today the UI builder returns null then, `:8-28`). When Comb is navigable, render a router `Link` to the Comb path (same tab) and keep an "Open in agent-fs" secondary action.

**File**: `apps/ui/src/components/shared/markdown-view.tsx` (`a` override, :136-147)
**Changes**: when `liveUrlToCombPath` or `appUrlToCombPath` maps the href and Comb is navigable, render a router `Link`. Otherwise keep `target="_blank"`. `MarkdownView` must not import heavy Comb modules (keep `links.ts` dependency-free).

**File**: any other place that renders live links. Find them with `grep -rn "live.agent-fs.dev\|buildAgentFsLiveUrl\|/file/~/" apps/ui/src` and route them through the same helpers.

#### 2. Server
**File**: `src/utils/constants.ts`
**Changes**: `buildCombFileUrl({path, orgId?, driveId?})` → `${getAppUrl()}/file/~/<org>/<drive>/<encoded path>` only when `getCombConfig().enabled` (step-4) AND `getConfiguredAppUrls().length > 0` (an explicit `APP_URL`/`DASHBOARD_URL`, not the hosted default). Same id and encoding rules as `buildAgentFsLiveUrl` (:118-140). Otherwise null.

**File**: `src/utils/task-attachment-links.ts` (:26-46)
**Changes**: agent-fs branch: `buildCombFileUrl(...) ?? buildAgentFsLiveUrl(...) ?? "agent-fs:<path>"`. All five call sites (`src/slack/render-v2.ts:1103`, `src/slack/blocks.ts:215`, `src/be/task-citations.ts:59`, `src/tasks/worker-follow-up.ts:163`, `src/commands/context-preamble.ts:108`) pick this up without edits. `context-preamble.ts` runs worker-side: confirm it gets `COMB_ENABLED` and `APP_URL` through the same config path as other worker settings, or keep the live URL there (agents fetch with the CLI anyway) and note it in the code.

**File**: `src/be/memory/link-resolver.ts` (`AGENT_FS_PATH_RE`, :44-45)
**Changes**: also match `<configured app host>/file/~/<org>/<drive>/<path>` (build the pattern from `getConfiguredAppUrls()` hosts, plus `localhost:<port>`), producing the same `agent-fs-file` link as a live URL.

#### 3. Tests
**File**: `src/tests/comb-links.test.ts` (new)
**Changes**: `taskAttachmentDisplayUrl` for an agent-fs attachment: flag off → live URL. Flag on + `APP_URL` set → `APP_URL/file/~/...`. Flag on without `APP_URL` → live URL. Row ids override env ids. Encoding keeps `%HH`.

**File**: `src/tests/memory-link-resolver.test.ts`
**Changes**: an `APP_URL/file/~/...` link resolves to the same target as the live URL.

**File**: `apps/ui/src/lib/comb/links.test.ts` (new)
**Changes**: live `/file/~/` and `/detail/~/` mapping, a trailing slash on `liveUrl`, `?comment=` kept, foreign URLs untouched, app-origin URLs.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `bun run test:root -- src/tests/comb-links.test.ts src/tests/memory-link-resolver.test.ts apps/ui/src/lib/comb/links.test.ts`
- [ ] Typecheck: `bun run tsc:check`
- [ ] DB boundary (worker-side files touched): `bash scripts/check-db-boundary.sh`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] UI E2E smoke still green (task pages render attachment links): `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [ ] Local Comb loop with `APP_URL=http://localhost:5274`. Create a task with an agent-fs attachment pointing at `comb-qa/notes.md` (through `store-progress` attachments, or the task attachments upload route). `agent-browser` opens the task page and clicks the attachment: the URL becomes `/file/~/.../comb-qa/notes.md` on the dashboard origin, same tab.
- [ ] Disconnect Comb and click again: it opens `live/` in a new tab (check the `href` and `target` with `agent-browser eval`).
- [ ] A task description containing a `https://live.agent-fs.dev/file/~/<org>/<drive>/comb-qa/notes.md` markdown link opens Comb when connected.
- [ ] Server: with the flag on, `bun -e` calling `taskAttachmentDisplayUrl` on a sample attachment prints the `APP_URL/file/~/...` URL. With the flag off it prints the live URL.

#### Manual Verification:
- [ ] After rollout, Taras checks one Slack message with an agent-fs attachment and confirms the link opens Comb.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
