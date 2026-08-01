---
date: 2026-08-01
author: claude (orchestrator session)
topic: "Swarm Apps spike — progress / handoff"
status: in-progress
branch: spike/swarm-apps
---

# Swarm Apps spike — progress log

Source brainstorm: thoughts/taras/brainstorms/2026-08-01-swarm-apps.md
Frozen spec: ./2026-08-01-swarm-apps-spike-spec.md (copy of /tmp/swarm-apps-spike-spec.md)
Taras's calls: throwaway-lean (embedded-JSON definition, one `apps` table), hand-seed first / MCP tool second.
Branch: `spike/swarm-apps` off main@4a192581. **Never merge to main** (auto-deploys prod; migration 124 will collide).

## Done

- **UI slice — committed `4bd38885`** (Opus workflow: implement → Sonnet review → fix).
  Catalog extracted to `apps/ui/src/lib/json-render/`; new `Table` (DataGrid, confirm-on-destructive
  row actions by default), `Form` (`/forms/<id>` state), `Badge`; routes `/apps` + `/apps/:id`;
  `useAppQueries` 5s poll into `/queries/<name>` state; `app.mutate`/`app.refresh` actions;
  `apps/ui/APP_SEED.json` = ideas-tracker AppDefinition.
  Deviation that matters: `$row`/`$rowIndex`/`$form` sentinels instead of `$item` in rowActions
  (json-render resolves props eagerly outside RepeatScope — verified against compiled lib source).
- **Server slice — Codex gpt-5.6-sol, working tree (NOT yet committed).**
  Migration `124_apps_spike.sql`, `src/apps/{definition,row-store,store}.ts`, `src/http/apps.ts`
  (verb `app.manage`), `src/tools/app-upsert.ts` (registered + SDK map `app_upsert`),
  `scripts/dev/seed-ideas-app.ts` (reads APP_SEED.json), `src/tests/apps-spike.test.ts`.
  All gates passed pre-review (lint, tsc, full test:root, db-boundary, rbac-coverage, docs:openapi).
  Also 3 existing-test isolation fixes (rbac-engine additive verb, run-bun-tests RUNNER_TEMP,
  tracker-fold Linear/Jira singleton resets) — reviewed as genuine, keeping.
- **E2E all green** (isolated stack: API :3113 + DATABASE_PATH=/tmp/apps-spike-e2e.sqlite,
  vite :5375 with VITE_PROXY_TARGET): fresh-DB migration; seed; CRUD round-trip; machine-readable
  400 issues; 20 parallel creates no lost writes; idx rows verified in sqlite incl. cleanup-to-zero;
  browser: form create (+clear), Start→IN_PROGRESS badge, Delete AlertDialog w/ seed copy, row gone.
  `app-upsert` via real MCP client (register agent via POST /api/agents first, then X-Agent-ID):
  invalid → isError + issues[]; valid → appId + /apps/<id>. Screenshots /tmp/apps-spike-*.png.
- **Review (workflow, Opus core + Sonnet periphery): 0 blockers/majors, 5 minors + 6 nits.**
  Findings + dispositions: ./2026-08-01-swarm-apps-spike-review-findings.md (fix all except F6).

## In flight

- Codex fix round via `codex exec resume --last` (first attempt was killed mid-run; resumed with
  crash-recovery instructions). Report lands at /tmp/codex-fix-report.md.

## Remaining

1. Verify codex fixes (targeted re-checks + full gates), commit server slice.
2. Restart isolated stack (:3113/:5375 — commands above), quick re-smoke (null-clear, empty filter 400).
3. Agent-first finale: local worker (HARNESS_PROVIDER=claude, MCP_BASE_URL=http://localhost:3113)
   gets task "build a <something> tracker app" → must author via app-upsert and produce a working
   /apps/:id. This is the bet's real test.
4. Score the brainstorm's failure signal: was building the ideas tracker on-platform lighter than
   the kv-typed-store skill's hand-rolled version? (So far: yes by a wide margin — definition JSON
   + zero hand-written index code vs. the skill's manual key/index machinery.)

## Gotchas learned

- zsh `rm -f glob*` with no match aborts the whole command (broke a background boot once).
- Dashboard in a fresh browser profile needs Settings→Connections setup (API URL/key) + identity
  dialog before /apps/:id renders.
- MCP callTool 401 "Agent not found" until the X-Agent-ID exists — register via POST /api/agents.
- Dev servers on :3013/:5274 were left untouched on purpose (migration-124 pollution of dev DB).
