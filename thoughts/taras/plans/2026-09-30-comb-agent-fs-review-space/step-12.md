---
id: step-12
name: Sidebar pins
depends_on: [step-5]
status: ready
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
- [ ] Tests pass: `bun run test:root -- src/tests/favorites-agent-fs-path.test.ts src/tests/favorites.test.ts apps/ui/src/lib/comb/paths.test.ts`
- [ ] Fresh DB boots: start `DATABASE_PATH=/tmp/comb-pins.sqlite PORT=3913 bun run start:http` in the background on a removed file, wait for `GET http://localhost:3913/health` to answer 200, then stop the process (startup applies 184 without errors)
- [ ] Migration checks: `bash scripts/check-migration-conflicts.sh && bash scripts/check-audit-columns.sh`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] OpenAPI (the favorites enum changes): `bun run docs:openapi && git diff --exit-code openapi.json`

#### Automated QA:
- [ ] Existing DB: copy the local dev DB (`cp agent-swarm-db.sqlite /tmp/comb-pins-existing.sqlite`), boot the API on the copy with `DATABASE_PATH`, and confirm existing page favorites still list (`GET /api/favorites?itemType=page`).
- [ ] Local Comb loop: `agent-browser` stars `comb-qa/` (folder) and `comb-qa/notes.md`. The sidebar shows both under Comb. Reload: still there. A second browser profile with the same swarm identity shows them. Unpin from the tree rail: gone from the sidebar.
- [ ] Screenshot of the sidebar with pins, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] None beyond review.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Remember the dev-DB hazard: never run a branch with migration 184 against the shared `./agent-swarm-db.sqlite` by accident (memory "Dev-DB fallback hazard"); always set `DATABASE_PATH` for QA.
