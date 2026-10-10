---
id: step-12
name: Sidebar pins
depends_on: [step-5]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-12: Sidebar pins

**Repo:** agent-swarm. Uses the step-5 file/folder header and tree rail, and the step-4 Comb nav item. Works against agent-fs v0.14.0.

## Overview

Any Comb file or folder can be pinned. Pins are the brainstorm's "spaces" (Q7/Q8): no space object, just a pinned path. They reuse `user_favorites` with a new item type `agent-fs-path`. Pinned paths show as children of the Comb nav item (expanded sidebar) and in a "Pinned" section at the top of the Comb tree rail.

When done: a user stars `comb-qa/` and `comb-qa/notes.md`, and both appear in the sidebar under Comb and survive a reload and a new browser.

## Changes Required:

#### 1. Schema
**File**: `src/be/migrations/184_favorites_agent_fs_path.sql` (new; re-check the ordinal against `origin/main` and open PRs before creating it)
**Changes**: rebuild `user_favorites` exactly like `116_favorite_principal_scope.sql` (same columns, defaults, `UNIQUE (favoriteScope, itemType, itemId)`, the three indexes), with `CHECK (itemType IN ('page','workflow','schedule','agent-fs-path'))`. Copy every row with all columns unchanged (no scope rewrite this time). `user_favorites` is only touched by migrations 105 and 116, so 116 is the current shape. The runner turns foreign keys off around migrations (`src/be/migrations/runner.ts:270-313`), so the drop/rename is safe.

**File**: `src/types.ts` (`FavoriteItemTypeSchema`, :1022)
**Changes**: add `"agent-fs-path"`.

**File**: `apps/ui/src/api/types.ts` (`FavoriteItemType`) and `apps/ui/src/api/hooks/use-favorites.ts` (`ENTITY_QUERY_KEYS`, :5-9)
**Changes**: add the type. `ENTITY_QUERY_KEYS["agent-fs-path"] = []` (no entity list to refresh).

Item id format: `<orgId>/<driveId>/<path>`, where a folder path ends with `/`. Build and parse it with helpers in `apps/ui/src/lib/comb/paths.ts` (step-5 file): `pinIdFor({orgId, driveId, path})`, `parsePinId(id)`.

#### 2. UI
**File**: `apps/ui/src/components/comb/file-header.tsx` and the folder header in `folder-view.tsx`
**Changes**: `FavoriteButton` (`apps/ui/src/components/shared/favorite-button.tsx`) wired to `useFavoriteToggle("agent-fs-path")`. One small, marked change in each file.

**File**: `apps/ui/src/components/comb/pinned-list.tsx` (new), rendered at the top of `tree-rail.tsx`
**Changes**: `useFavorites("agent-fs-path")`, filtered to the current `orgId/driveId`. Label = last path segment (folder with a trailing `/`), full path in a tooltip. Click navigates. Unpin from a row menu.

**File**: `apps/ui/src/components/layout/app-sidebar.tsx`
**Changes**: build the Comb item's `children` at render time from `useFavorites("agent-fs-path")` for the swarm drive (`status.agent_fs.comb.org_id/drive_id`), max 10, sorted by label, each `{title, path: "/file/~/" + id}`. Only when the Comb item is visible (step-4 `requires: "comb"`). Children render only in the expanded list (existing behavior at :479-498).

#### 3. Tests
**File**: `src/tests/favorites-agent-fs-path.test.ts` (new)
**Changes**:
- Fresh DB (`initDb` on a new temp file): `PUT /api/favorites {itemType: "agent-fs-path", itemId: "org/drive/comb-qa/"}` succeeds and lists back.
- Existing DB: build a DB migrated to 183, insert page/workflow/schedule favorites for a user scope and the operator scope, run migrations, and assert every row survives with identical columns and the three indexes exist (`PRAGMA index_list(user_favorites)`).
- An unknown item type is still rejected.

**File**: `src/tests/favorites.test.ts`
**Changes**: keep passing. Add one case for the new type if the file already enumerates types.

**File**: `apps/ui/src/lib/comb/paths.test.ts`
**Changes**: `pinIdFor` / `parsePinId` round trip, including paths with spaces and `%`.

### Success Criteria:

#### Automated Verification:
- [x] Tests pass: `bun run test:root -- src/tests/favorites-agent-fs-path.test.ts src/tests/favorites.test.ts apps/ui/src/lib/comb/paths.test.ts`
- [x] Fresh DB boots: start `DATABASE_PATH=/tmp/comb-pins.sqlite PORT=3913 bun run start:http` in the background on a removed file, wait for `GET http://localhost:3913/health` to answer 200, then stop the process (startup applies 184 without errors)
- [x] Migration checks: `bash scripts/check-migration-conflicts.sh && bash scripts/check-audit-columns.sh`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] OpenAPI (the favorites enum changes): `bun run docs:openapi && git diff --exit-code openapi.json`

#### Automated QA:
- [x] Existing DB: copy the local dev DB (`cp agent-swarm-db.sqlite /tmp/comb-pins-existing.sqlite`), boot the API on the copy with `DATABASE_PATH`, and confirm existing page favorites still list (`GET /api/favorites?itemType=page`).
- [x] Local Comb loop: `agent-browser` stars `comb-qa/` (folder) and `comb-qa/notes.md`. The sidebar shows both under Comb. Reload: still there. A second browser profile with the same swarm identity shows them. Unpin from the tree rail: gone from the sidebar.
- [ ] Screenshot of the sidebar with pins, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] None beyond review.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Remember the dev-DB hazard: never run a branch with migration 184 against the shared `./agent-swarm-db.sqlite` by accident (memory "Dev-DB fallback hazard"); always set `DATABASE_PATH` for QA.

## Implementation Notes

Commit `aabc62b3f` on `comb/s12-pins` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s12`, based on step-5 tip `7fefd492d`). Evidence in `/tmp/comb-run/step-12/` (9 screenshots, `pins-flow.webm`). The screenshot box stays open until the orchestrator uploads the evidence.

Verification notes:
- Migration number is **188** (`188_favorites_agent_fs_path.sql`): `origin/main` ends at 184, open PRs claim 185, 186 (#1682) and 187 (#1606). `check-migration-conflicts.sh` passes (it skips the immutability check because the branch does not contain the newest `origin/main`).
- Fresh DB boot ran on my port (3320) and `/tmp/comb-run/step-12/pins-fresh.sqlite`: 188 applied, `/health` 200.
- Existing DB: the dev DB copy was at migration 140 with no favorites. I inserted an operator page and workflow favorite into the copy first. After boot, `SELECT * FROM user_favorites` was byte-identical, the three indexes exist, and `GET /api/favorites?itemType=page` returned `["qa-page-1"]`. The copy's encrypted `swarm_config` rows had to be deleted, because the API refuses to boot without the dev `SECRETS_ENCRYPTION_KEY` (unrelated to this step).
- The unit test rolls a fully migrated DB back to the 116 shape by running `116_favorite_principal_scope.sql` on the empty table, then deletes the 188 `_migrations` row.
- Browser loop: pinned `comb-qa/`, `comb-qa/notes.md`, and `comb-qa/Q3 plan 100%.md`. All showed under Comb, survived a reload, and showed in a second browser profile (fresh context, swarm key only, no agent-fs key). A sidebar pin with a space and `%` opens the right file. Unpin from the rail row menu removed the sidebar entry.
- The recording ends on `/setup`: a reload on a fresh swarm DB redirects there (known QA gotcha), not a pin bug.

Decisions and deviations:
- The root folder has no pin button: the Comb nav item already opens it.
- Sidebar children link with `combPath(pin)`, not the literal `"/file/~/" + id` from the spec, so spaces, `%`, `#`, and `?` in paths stay safe.
- Sidebar: the newest 10 pins (the API lists newest first), then sorted by label. Every new pin shows, even past 10.
- Sidebar child links match exactly (`end`), so a folder pin does not light up on its files. No other nav item has children today. Children also got `truncate` and a `title`.
- `FavoriteButton` got an optional `labels` prop. Comb says "Pin to sidebar" / "Unpin".
- `useFavoriteToggle` now returns the favorites invalidation from `onSuccess`, so the mutation stays pending until the list is fresh (no star flicker). `useFavorites` got an optional `{enabled}`.
- `PinButton` renders nothing when the favorites list fails (an older API rejects the new item type).
- `parsePinId` rejects `.` and `..` segments, matching the step-5 fix to `parseCombSplat`.
- `tree-rail.tsx`: the old component is now the private `DriveTree` (one changed line) and a new exported `TreeRail` wrapper at the end of the file renders `<PinnedList>` on top. This avoids re-indenting the tree JSX, so the step-5 review fix merges cleanly.
- Pin helpers are at the end of `lib/comb/paths.ts`, their tests at the end of `paths.test.ts`.

Notes for later steps:
- `lib/comb/paths.ts`: `pinIdFor(DrivePath)` → `"<org>/<drive>/<path without leading />"`, `parsePinId(id)` → `DrivePath | null`, `pinLabel(path)` (folder gets a trailing "/"), `drivePins(ids, {orgId, driveId}, limit?)`.
- Components: `components/comb/pin-button.tsx` (`PinButton({target})`), `components/comb/pinned-list.tsx` (`PinnedList({location, onNavigate})`).
- Query key `["favorites", "agent-fs-path", undefined]` is shared by the header star, the rail list, and the sidebar. It persists to the localStorage query cache (paths only, no content).
- Pins are per swarm principal: the operator key uses scope `operator`, a user token uses `user:<id>`. The dashboard identity picker does not change the scope.

### Review fixes

- `parsePinId` now decodes each segment (falling back to the raw segment on a bad escape) and rejects any that decodes to `.`, `..`, or contains `/` or `\`. Covers `%2e%2e`, `.%2e`, `%2E%2e`, `a%2Fb`.
- `PinButton` hides only when the favorites query failed and has no data, so a poll failure no longer hides the star.
- `use-favorites.ts` comment scoped: the awaited invalidation keeps pin stars steady; entity stars are unchanged.
- Sidebar pin children got an optional `tooltip` (the full drive path) used as the link `title`. The visible label is unchanged.
- New test in `src/tests/favorites-agent-fs-path.test.ts` sets distinct `lastUpdatedAt` values and asserts newest-first order without sorting.
