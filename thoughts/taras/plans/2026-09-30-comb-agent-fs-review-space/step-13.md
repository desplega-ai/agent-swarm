---
id: step-13
name: Links stay in-app
depends_on: [step-5]
status: done
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
- [x] Tests pass: `bun run test:root -- src/tests/comb-links.test.ts src/tests/memory-link-resolver.test.ts apps/ui/src/lib/comb/links.test.ts`
- [x] Typecheck: `bun run tsc:check`
- [x] DB boundary (worker-side files touched): `bash scripts/check-db-boundary.sh`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] UI E2E smoke still green (task pages render attachment links): `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [x] Local Comb loop with `APP_URL=http://localhost:5274`. Create a task with an agent-fs attachment pointing at `comb-qa/notes.md` (through `store-progress` attachments, or the task attachments upload route). `agent-browser` opens the task page and clicks the attachment: the URL becomes `/file/~/.../comb-qa/notes.md` on the dashboard origin, same tab.
- [x] Disconnect Comb and click again: it opens `live/` in a new tab (check the `href` and `target` with `agent-browser eval`).
- [x] A task description containing a `https://live.agent-fs.dev/file/~/<org>/<drive>/comb-qa/notes.md` markdown link opens Comb when connected.
- [x] Server: with the flag on, `bun -e` calling `taskAttachmentDisplayUrl` on a sample attachment prints the `APP_URL/file/~/...` URL. With the flag off it prints the live URL.

#### Manual Verification:
- [ ] After rollout, Taras checks one Slack message with an agent-fs attachment and confirms the link opens Comb.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `5e8223eb1` on `comb/s13-links` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s13`, based on step-5 `7fefd492d`). Evidence in `/tmp/comb-run/step-13/` (11 screenshots, `links-flow.webm`, `server-display-url.txt`, E2E logs).

Verification notes:
- QA ran with `APP_URL=http://localhost:3331` (this worktree's dashboard port), not 5274.
- The `comb-qa/notes.md` attachment row was inserted into the scratch DB with sqlite (store-progress needs a worker agent-fs credential). A second attachment came through the real upload route (`POST /api/fs/tasks/{id}/files`). That row has no org/drive ids, and it now links through the swarm-drive fallback.
- The harness blocks `agent-browser eval`, so `href` and `target` were read with `agent-browser get attr`. Disconnected: `target=_blank`, live `href`, and the click opened a second tab on live.agent-fs.dev. Connected: no `target`, a `/file/~/...` `href`, and the click stayed in the same tab.
- UI E2E smoke: 33 passed, 17 skipped, 1 flaky (the known first-boot `POST /api/config/reload` 500 in the seed, passed on retry). `specs/prompt-attachments.spec.ts` also passed (it checks the attachment pill labels and targets).
- Also ran: the 4 memory test files, `task-attachments-section.test.tsx`, `agent-fs-live-url.test.ts`, `rehype-source-lines.test.tsx`, root `bun run lint` (it ran, no stack overflow), `check:dep-graph` (0 errors), floating-promise and promise-sink checks.

Decisions and deviations:
- `buildCombFileUrl` lives in `src/utils/constants.ts` as planned. To avoid an import cycle with `src/comb/config.ts`, the enabled rule moved to `isCombEnabled()` in constants. `getCombConfig().enabled` now calls it (same rule: `COMB_ENABLED` plus `AGENT_FS_API_URL`). Live and Comb URLs share one private `agentFsFileRoute()` (ids, defaults, `%HH` encoding).
- `context-preamble.ts` keeps the live URL (`taskAttachmentDisplayUrl(att, { comb: false })`). The runner applies only `RELOADABLE_ENV_KEYS` from swarm_config to its own env, so `COMB_ENABLED` and `APP_URL` there can differ from the API. The other four call sites pick up the Comb URL without edits.
- `links.ts` imports only `./paths` (and a type). It exports `fileUrlToDrivePath` (the parser, for tests), `liveUrlToCombPath`, `appUrlToCombPath`, `combPathForLink`, `isCombNavigable`. Org and drive ids must match `^[\w-]+$`. The URL parser resolves `.`, `..`, and `%2e` segments like a browser, so a link that climbs out of its drive lands on another id slot or route and returns null. A segment that decodes to "/" or ".." also returns null.
- `appUrlToCombPath` also accepts a root-relative `/file/~/...` href (it resolves against the dashboard origin).
- Added `useOptionalAgentFs()` (context) and `hooks/use-comb-links.ts` (`useCombLinks()` returns `href => combRoute | null`, null unless `ready`). Shared components use the optional hook because `/setup` renders outside `AgentFsProvider`.
- Comb's own markdown: `CombLiveUrlContext` (exported from `comb-markdown.tsx`) carries `liveUrl`. `markdown-viewer.tsx` provides it. `CombMarkdown`'s signature did not change. Comb renders a file only while connected, so `CombLink` maps live links without a state check.
- Extra (not in the plan): citations (`task-citations-section.tsx`) route through the same mapper, and the Connect card now shows "Open in agent-fs" for the file in the route. The plan said the second was already true after step-4/5. It was not.
- The attachment card and pill show a separate "Open in agent-fs" icon button while Comb is navigable. The pill drops its inline external-link icon then.
- Not changed: session logs, `task-outcome`, `task-detail-sheet`, chat, and memory pages render links with Streamdown's default `a` (link-safety modal). Overriding it there would drop that modal for every link. Follow-up if wanted.

Known dependency:
- A file literally named `a%20b.md`: `links.ts` decodes its live URL once to `/a%20b.md` (unit test). On this branch `combPath` still keeps `%HH`, so the route becomes `.../a%20b.md` and opens `a b.md`. The step-5 review fix (plain `encodeURIComponent` in `combPath`) makes it `.../a%2520b.md`. No change in `links.ts` is needed. (Superseded by the review fixes below: `links.ts` no longer uses `combPath`.)

### Review fixes

Commit `1bd6231c0` on `comb/s13-links`, on top of `5e8223eb1`. Evidence in `/tmp/comb-run/step-13/fix-*.png` and `fix-*.log`.

What changed:
1. Link containment (`lib/comb/links.ts`). The module builds Comb routes itself and does not use `combPath`. Each path segment is decoded once, checked, and encoded with plain `encodeURIComponent`. A link returns null when the raw path has a dot segment (`.`, `..`, any `%2e` spelling, split on `/` or `\`), when a decoded segment is `.` or `..` or holds `/` or `\`, or when a second decode would produce one of those (`%252e%252e`, `%252F`, `%255C`). A live link `a%2520b.md` maps to the route segment `a%2520b.md`. The old "resolve dot segments like a browser" rule is gone: `a/../b.md` now returns null.
2. Server `agentFsFileRoute` (`src/utils/constants.ts`) returns null for a `.` or `..` segment, raw or `%2e`-encoded. `buildAgentFsLiveUrl`, `buildCombFileUrl`, and `taskAttachmentDisplayUrl` then fall back to `agent-fs:<path>`. The UI attachment builder (`task-attachment-link.tsx`) mirrors the rule.
3. Flag-off parity. `agentFsAttachmentLinks(row, agentFs)` (`task-attachment-link.tsx`) returns `{href, combTo}`. A row without ids uses the swarm drive only while `agentFs.endpoint` is set (Comb on). With Comb off, the row renders as on `main`. `task-attachments-section.test.tsx` renders `TaskPromptAttachments` and `TaskAttachmentsSection` (with `mock.module` for the `@/` graph) and pins that output.
4. Rollback path. `pages/comb/page.tsx` renders `RouteOpenInAgentFs` also in `disabled` and `unreachable`. `OpenInAgentFsButton` (`components/comb/file-actions.tsx`) builds its URL with `drivePathToLiveUrl` (same rules as fix 1) and hides for an unsafe path. This also fixes the file-header button for a literal `a%20b.md` on this branch.
5. Citations. `buildCitationUrl` (`src/be/task-citations.ts`) stores the live URL (`comb: false`). The dashboard maps it to Comb at render time.
6. `combLinkFor(state, liveUrl, appOrigin, href)` is pure and backs `useCombLinks`.
7. Memory link resolver: `(?<![\w.-])` before the hosts and the `i` flag.
8. `CombMarkdown` takes an optional `liveUrl` prop and provides `CombLiveUrlContext` itself. The context is no longer exported.
9. The `AgentFsProvider` value is memoized. `deriveAgentFsState` is memoized too, so `error` keeps its identity between renders.
10. `AttachmentRow` builds its Comb route from the row ids (`encodedPathToCombPath`), not by parsing a built live URL. This also fixes a gap: before, a Comb link needed the status `live_url` to match the host that built the href.
11. `InAppOrExternalLink` (`components/shared/in-app-or-external-link.tsx`, no `@/` imports) serves `AttachmentName`, the prompt pill, `MarkdownLink`, and citations.
12. `appUrlToCombPath` accepts only an href that starts with `/` or with `<appOrigin>/`.

Deviations:
- Fix 1 asked to reject any segment that still matches `%HH` after one decode. That rule also rejects the required `a%2520b.md` case (a file named `a%20b.md`). The check tests what a second decode yields instead, so `a%2520b.md` passes and `%252e%252e`, `%252F`, `%255C` fail.
- Fix 11: `CombLink` in `comb-markdown.tsx` keeps its own `Link` inside the step-13 block. The step-5 review fix (`3db4b19de`) rewrites the rest of that function, so a refactor there would conflict.
- Fix 5 consequence: Slack answers render citations from the stored URL (`render-v2.ts` reads `getTaskCitations`), so Slack citation links are live URLs now. Slack attachment links keep the Comb URL.
- The UI builder dot-segment rule (fix 2 mirror) was not requested. It keeps the UI and the server on one rule.

Verification:
- `bun run test:root -- src/tests/comb-links.test.ts src/tests/memory-link-resolver.test.ts src/tests/agent-fs-live-url.test.ts src/tests/task-citations.test.ts apps/ui/src/lib/comb/links.test.ts apps/ui/src/components/shared/task-attachments-section.test.tsx`: 100 pass.
- Memory files (`memory-reranker`, `memory-store`, `memory`, `memory-e2e`) plus `rehype-source-lines.test.tsx` and `paths.test.ts`: 145 pass.
- `bun run tsc:check`, `bash scripts/check-db-boundary.sh`, root `bun run lint` (it ran, no stack overflow), `check-floating-promises` (0), `check-promise-sinks` (0): pass.
- `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`: pass.
- `bun run e2e:ui -- --grep @smoke`: the first run had 8 failures, all from the known seed `POST /api/config/reload` 500 on one worker. Retry: 34 passed, 17 skipped, 0 failed. `specs/prompt-attachments.spec.ts`: the same seed flake once, then 1 passed.
- Browser QA (API 3330, UI 3331, agent-fs 7413, reused scratch DB and agent-fs home, a new identity registered in the browser): connected, the `QA notes` name has no `target` and a click opens `/file/~/.../comb-qa/notes.md` in the same tab (one tab). The id-less upload links to Comb with a live "Open in agent-fs". The task description link `a%2520b.md` maps to route `a%2520b.md`. With `COMB_ENABLED=false`: the id-less rows show a plain name, no Open button, and the in-dashboard preview works. The id row keeps its live link with `target=_blank`. `/file/~/.../comb-qa/notes.md` shows "Comb is off" plus "Open in agent-fs". `/file/~/.../%252e%252e/%252e%252e/settings` shows "Comb is off" with no "Open in agent-fs".

Merge notes (for the orchestrator):
- The step-5 review fix (`3db4b19de`) edits `task-attachments-section.tsx` (adds `import { formatBytes } from "@/lib/format-bytes"` and drops `formatSize` right after `resolveLinks`) and `comb-markdown.tsx` (the tail of `CombLink`, `CombImage`). Expect textual conflicts. After the merge, `task-attachments-section.test.tsx` needs `mock.module("@/lib/format-bytes", () => require("../../lib/format-bytes"));`, or the file fails at import.
- The step-5 fix also drops dot segments in `parseCombSplat` and switches `combPath` to plain `encodeURIComponent`. Both are compatible with these fixes.
