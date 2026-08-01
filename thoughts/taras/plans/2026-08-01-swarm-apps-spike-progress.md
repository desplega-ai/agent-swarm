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

## Finale results (2026-08-01, complete)

- Fix round: all 10 review findings fixed (codex), 15/15 tests, full suite green. Server slice
  committed 16cbf498; scroll-region fix committed after (apps/:id owns scroll per lg:overflow-hidden
  layout contract).
- **Agent-first test PASSED:** local worker (claude-opus-5) built the "Bookmarks" app
  (fe3f60c8-3408-41d4-994b-07d1d98c75cd) from a natural-language task via app-upsert —
  **first try, 1 tool call, 0 validation rejections**, ~$1.35 session. App fully functional in
  browser (form create, Mark-read row action, table poll refresh). The agent added its own polish
  (description copy, placeholders, an "Added" relative-time column).
- Attempt 1 failure worth remembering: a bare `bun src/cli.tsx worker` inherits the LOCAL user's
  ~/.claude config → no local swarm MCP, my prod agent-swarm-user MCP leaked in ($1.14 wasted,
  agent correctly reported blocker). Fix: write `.mcp.json` with the agent-swarm entry
  (url + Authorization + X-Agent-ID headers) into the worker cwd — runner merges it per-session.
- Verdict on the brainstorm's failure signal: building on-platform is FAR lighter than the
  kv-typed-store hand-rolled version — one definition JSON vs manual key layouts/index rewrites,
  and reads are native (no 300ms script startup anywhere in the read path).

## Running environment (leave up for Taras)

- API :3113 (nohup, log /tmp/apps-api.log), DB /tmp/apps-spike-e2e.sqlite
- UI  http://localhost:5375 (nohup vite, log /tmp/apps-vite.log), connected via ?config to :3113
- Worker (nohup, log /tmp/apps-worker.log, agent 43172bc2, cwd /tmp/apps-worker-ws)
- Apps: Ideas (789025c0), Notes Mini (bae5343b), Bookmarks (fe3f60c8)
- Cleanup: `pkill -f apps-spike-e2e; pkill -f 'port 5375'; pkill -f 'cli.tsx worker'` (or by log grep)

## Spike verdict — what the platform version needs that the spike exposed

1. App-authoring guidance must ship server-side (tool description / seeded skill): the worker
   succeeded because the task embedded a format primer; naked schema would've been format-guessing.
2. An `app-get`/`app-list` MCP tool (agent had no way to read back an app definition via MCP).
3. Scroll/layout: JSON-rendered pages need the layout contract handled by the runtime, not the
   definition (done in spike).
4. UI edit loop still missing (edit definition in dashboard) — expected, out of spike scope.

## Gotchas learned

- zsh `rm -f glob*` with no match aborts the whole command (broke a background boot once).
- Dashboard in a fresh browser profile needs Settings→Connections setup (API URL/key) + identity
  dialog before /apps/:id renders.
- MCP callTool 401 "Agent not found" until the X-Agent-ID exists — register via POST /api/agents.
- Dev servers on :3013/:5274 were left untouched on purpose (migration-124 pollution of dev DB).
