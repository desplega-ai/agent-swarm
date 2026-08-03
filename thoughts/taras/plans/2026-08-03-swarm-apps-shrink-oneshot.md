---
date: 2026-08-03T21:15:00+02:00
topic: "One-shot yolo plan: Swarm Apps shrink slice (connections removal, legacy page removal, provenance)"
author: claude
status: complete
tags: [plan, one-shot, swarm-apps]
---

# One-shot: Swarm Apps "shrink" slice

Branch `spike/swarm-apps`, worktree `2026-08-03-swarm-apps`. Source of truth: brainstorm `thoughts/taras/brainstorms/2026-08-03-swarm-apps-next-iterations.md` ("Ironed facts").

## Phase 1 — surgical connections/sync removal
- [x] Delete: `src/apps/sync.ts`, `src/tools/app-sync.ts`, `src/be/seed-scripts/catalog/github-issues-pull.ts` (+ its index entry), `scripts/dev/app-sync-cron.script.ts`, `scripts/dev/pm-digest.script.ts`, `src/tests/apps-spike3.test.ts`
- [x] `src/server.ts`: drop `registerAppSyncTool` import/registration (keep `registerAppQueryTool`)
- [x] `src/apps/definition.ts`: remove `sources` schema/`SourceDef`, `ColumnDef.source`, `sync` action kind, `models.*.sources.*` atomic-patch entry, `sourceDefinitionIssues`, and `source`/`syncedAt`/`stale` from `SYSTEM_COLUMN_KINDS` (keep id/createdAt/updatedAt)
- [x] `src/apps/row-store.ts`: remove `allowSourceManaged` + source-managed branches; KEEP `skipUpdatedAt`; drop `source`/`syncedAt`/`stale` from `AppRow`
- [x] `src/http/apps.ts`: remove sync route + dispatch, `sync` action branch, `syncedAt` sort allowlists
- [x] `templates/skills/apps/content.md`: excise Synced sources section + sync mentions (queries/patch-semantics lists keep spike-4 content)
- [x] `src/tests/apps-spike4.test.ts`: fix the `stale`-filter test (use a real column or createdAt)
- [x] `src/scripts-runtime/sdk-allowlist.ts`: drop `app_sync` (keep `app_query`) → `bun run build:script-types`
- [x] Stored defs: strip `models.*.sources` + column `source` bindings from live defs (dev-DB cleanup — one-off script or read-time strip)
- [x] `bun run docs:openapi`

## Phase 2 — remove legacy singular `page`
- [x] `src/apps/definition.ts`: drop the `page`→`pages.main` zod transform/acceptance; canonical `pages`+`defaultPage` required
- [x] Migrate any legacy-shaped stored defs in /tmp/apps-spike-e2e.sqlite (check first; spike-4 likely already normalized on write)
- [x] Fix tests still authoring `page` (spike-3 tests deleted; check spike/spike2 tests)

## Phase 3 — provenance columns
- [x] `src/apps/row-store.ts`: `createdBy`/`updatedBy` on `AppRow`; write on create, update `updatedBy` on patch; actor arg threaded in
- [x] `src/http/apps.ts`: derive actor id from request auth (user:<userId> / operator fingerprint pattern / agent:<agentId>) in row CRUD handlers, pass to row-store
- [x] `SYSTEM_COLUMN_KINDS` += createdBy/updatedBy (string) → filterable in named queries
- [x] Reserved-name guard: model columns may not declare createdBy/updatedBy

## Gates
- [x] `bun run lint` && `bun run tsc:check`
- [x] `bun run test:root -- src/tests/apps-*.test.ts`, then full `bun run test:root`
- [x] Restart :3113 API from worktree; 7 apps list; PM Inbox renders with sources stripped; row create carries createdBy
