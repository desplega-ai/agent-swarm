---
id: step-11
name: "Favorite a use case (key favorite type)"
track: D
depends_on: []
status: done
completed_at: 2026-11-04
assignee: po-orch-step-11
claimed_at: 2026-11-04T15:11:02Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-11: Favorite a use case (`key` favorite type)

## Overview
Users can star a Sessions group (a use case). `user_favorites` gains the `key` item type (the `itemId` is the group key string), the favorites API accepts it, and a star appears in the group title row of `/sessions?view=<key>` and in the sidebar group node's hover actions. Home lists these favorites in step-15. After this step, `PUT /api/favorites {itemType:"key", itemId:"shared/competitor-research/", favorite:true}` works and the star in the group view reflects it.

## Changes Required:

#### 1. Migration 283
**File**: `src/be/migrations/283_favorites_key_type.sql` (new)
**Changes**: Rebuild `user_favorites` as in `192_favorites_agent_fs_path.sql:6-17` with `CHECK (itemType IN ('page','workflow','schedule','agent-fs-path','key'))`, copying rows and recreating the three indexes and the UNIQUE. Re-check the ordinal with `scripts/check-migration-conflicts.sh`.

#### 2. Type enumerations
**Files**: `src/types.ts:1224` (`FavoriteItemTypeSchema`), `src/http/favorites.ts:16,39,48`, `apps/ui/src/api/types.ts:1006`, `apps/ui/src/api/hooks/use-favorites.ts:13-19` (`ENTITY_QUERY_KEYS` gets `key: []`), `apps/ui/src/api/client.ts:4194,4208`
**Changes**: Add `"key"`. `setFavorite` (`src/be/db.ts:12939-12970`) validates `itemId` with `normalizeAssetKey` when `itemType === "key"`. `bun run docs:openapi` (the enum is in the OpenAPI output).

#### 3. Keep favorites in step with renames
**File**: `src/http/sessions.ts:721-737` (`/api/session-moves/prefix`)
**Changes**: Inside the same transaction, `UPDATE user_favorites SET itemId = <new prefix> || substr(itemId, length(<old prefix>)+1) WHERE itemType='key' AND itemId LIKE <old prefix>||'%'`.

#### 4. Stars in the UI
**Files**: `apps/ui/src/components/sessions-v2/group-tab.tsx:274-288` (title row), `apps/ui/src/components/sessions-v2/sidebar/group-node.tsx` (hover action), `apps/ui/src/components/shared/favorite-button.tsx`
**Changes**: `useFavorites("key", [groupKey])` + `useFavoriteToggle("key")` behind a `FavoriteButton` with labels "Star this use case" / "Unstar". Hidden for section tabs (inbox, later, done, no group) and for read-only source groups (`src/assets/source-key.ts:76`) is fine to star too; keep it simple: show for every real group key.

#### 5. Tests
**Files**: `src/tests/favorites*.test.ts` (extend `favorites-agent-fs-path.test.ts` pattern), `scripts/e2e/scenarios/core-preferences.ts` (add a `key` case), `apps/ui/src/components/sessions-v2/group-tab.test.tsx` (new), `packages/ui-e2e/specs/favorites.spec.ts`
**Changes**: PUT/GET round trip for `key`; invalid key rejected 400; rename moves the favorite; star toggles in the group view (Playwright: open a seeded group, click the star, reload, star still on).

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/favorites*.test.ts src/tests/sessions-move.test.ts`
- [x] `bun run e2e --strict`
- [x] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- group-tab favorites`
- [x] `bun run e2e:ui -- --grep "favorites"`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json`
- [x] `bash scripts/check-migration-conflicts.sh && bash scripts/check-audit-columns.sh && bun run check:local && bun run tsc:check:tsc`
- [x] Existing DB upgrade keeps rows: copy a pre-plan DB, boot, `sqlite3 <db> "select count(*) from user_favorites"` unchanged.

#### Automated QA:
- [x] `curl -X PUT -H "Authorization: Bearer <aswt_>" -d '{"itemType":"key","itemId":"shared/po-qa/","favorite":true}' <api>/api/favorites` then `GET /api/favorites?itemType=key` lists it.
- [x] `AGENT_BROWSER_SESSION=po-step11`: open `/sessions?view=shared/po-qa/`, click the star, reload: still starred. Screenshot `/tmp/po-step11-star.png`.
- [x] Rename the group via the UI (or `POST /api/session-moves/prefix`): `GET /api/favorites?itemType=key` shows the new key.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice, QA-able on its own. Backend to Codex `gpt-6.1-sol` (medium), star UI to Opus. After completing this step, pause for manual confirmation. Commit as `[step-11] Favorite a use case (key favorite type)` after verification passes. Frontend PR: screenshot in `## Before / after`.

## Implementation notes

- Commit `37edb723e` on `po/step-11`. All done by Opus, no Codex round (small step).
- `setFavorite` normalizes a `key` item id (`normalizeAssetKey`). The PUT handler normalizes first and answers 400 with the `AssetKeyError` message, and echoes the normalized id (`Shared/X` is stored as `shared/x/`).
- Rename hook: `moveSessionChains` runs one transaction per root, so there is no single "same transaction". `moveKeyFavorites` (`src/be/db/session-moves.ts`) runs its own transaction after the moves, only when `to` is not null and at least one root moved. It uses `UPDATE OR IGNORE` + `DELETE` so a principal who already starred the new key keeps one row. It moves favorites of every scope (the group key is shared). A group delete (`to: null`) leaves the stars in place (step-15: Home may show a starred key with no sessions).
- UI: `useKeyFavorite(groupKey)` in `use-favorites.ts` reads one shared `useFavorites("key")` list (no `itemIds`), so the sidebar rows and the tab share one request. The star shows the pending state of an in-flight toggle and toasts on failure. Title row star lives in `group-tab-star.tsx` (outside the `h2`, so the heading name stays the group name). Sidebar: star hover action on every `group` row (also read-only source groups and threads), before the menu and "+".
- `cd apps/ui && bun run test -- ...` does not work: apps/ui has no `test` script (bun runs the shell `test` builtin). Ran `cd apps/ui && bun test group-tab favorites` instead (12 pass). The UI test file is `group-tab-star.test.tsx` (SSR render of `GroupTabStar`), not `group-tab.test.tsx`: `GroupTab` pulls ag-grid and many aliased modules.
- `src/tests/script-connections.test.ts` (migration-112 fixture) needed 283 in its skip list, the same as 192 and 205.
- QA used the operator API key with the picked user, not an `aswt_` token. The UI stores the star under `user:<id>`, verified with `X-Swarm-User-Id`.

