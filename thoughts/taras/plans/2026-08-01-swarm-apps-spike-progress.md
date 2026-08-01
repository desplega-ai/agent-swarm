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

## Spike 2 candidate scope (Taras + Claude, 2026-08-01 — pick up in a NEW session)

Theme: **the iteration loop** (spike 1 proved creation; agents maintaining apps is the product loop).

From the initial plan, what else fits here (Taras Q): **script-backed custom actions** fit spike 2 —
they exercise the action taxonomy beyond CRUD (a `mutation` kind referencing an existing swarm
script that writes through the app-model endpoints) and reuse a primitive we already have; a
**task-backed action** ("tackle" kind with observable status) is the differentiator and also needs
no sync machinery, so it's a strong stretch goal. **Workflows, schedules, and syncs stay spike 3** —
they're one cluster (the autopilot story) and share the join-key/freshness risk class, not the
iteration-loop machinery.

1. `app-get` / `app-list` / `app-patch` MCP tools (Taras: patch like the workflows tooling — app
   JSONs get big). Patch shape: JSON Merge Patch for shallow fields + whole-subtree replace for
   `page.elements.<id>` (agents are bad at RFC 6902 pointers); validate the PATCHED RESULT with the
   same zod, return the same issues[].
2. Seeded `apps` skill in templates/skills/apps/ (what apps are, definition format, catalog
   reference, $row/$form semantics, worked example) + prompt mention. Converts the spike's
   prompt-primer into platform surface — proven to be the 1-call vs flailing difference.
3. Dashboard polish (Taras): sidebar entry ABOVE Approvals w/ beta icon + tooltip; name-based
   breadcrumbs; detail page cleaner like pages; full/chromeless view mode, query-string compatible.
4. Proof task: worker gets "add a rating filter to Bookmarks" → app-get → app-patch → running app
   updates. End-to-end iteration demo.
5. Cheap safety fix to include: reserved-namespace guard for `apps:*` on the generic KV surface.
6. Script-backed custom actions (`mutation` kind → existing script, writes via app-model endpoints);
   stretch: task-backed action kind with observable status.
7. **Server-side page validator** (answers "what does renderable mean" — all statically checkable):
   tree connected (every element reachable from root, no orphan/cycle, children ids exist);
   component types ∈ catalog enum, props validate against per-component schema (shared/generated
   from the UI zod catalog — kills the two-sources-of-truth drift); `$state` bindings resolve to a
   declared query (`/queries/<name>`) or a `/forms/<formId>` whose Form element exists; action
   chains use known actions, `app.mutate` references an existing model, valid op, and update/delete
   carry a rowId binding. Reject at app-upsert/patch time with the same issues[] contract.

Deferred to spike 3: sync/PM app + schedules/workflows/autopilot (one cluster; different risk
class: join keys, freshness, entity resolution).

### UI catalog gaps (priority order, updated per Taras review)

1. **Layout primitives first (Taras: key):** Stack/Row/Col, Grid, Split, spacing via tokens (enums,
   not px), breakpoint-keyed responsive props — the brainstorm's JSON-UI survey already converged
   on this inventory; action item: audit 1–2 strong design systems / JSON-UI catalogs (e.g.
   shadcn's composition set, Puck/DivKit component inventories) to pin the EXACT primitive list
   before building.
2. **Multi-page apps / internal navigation (Taras):** the brainstorm's "app tree: pages — hard tree
   structure" — nav component + per-app routes (`/apps/:id/p/:page`), definition grows a `pages`
   tree instead of a single `page`. Candidate for spike 2's dashboard-polish item.
3. **Search / autocomplete (Taras: key):** SearchInput bound to query overrides + Combobox/
   Autocomplete field (Command primitive exists in the dashboard) for relation columns and filters.
4. Record detail modal/drawer + DetailList; user-driven filtering (Select/filter bar → query
   overrides); List/Inbox component; Tabs; Metric aggregates ({aggregate: count} queries);
   Markdown (Streamdown), EmptyState, field-level Form validation display, date picker.

### Risks/unknowns logged (from Q&A)
Catalog schema client-side only — addressed by the page validator, spike 2 item 7 (Taras confirmed
the validator direction: tree connectivity, state refs, action sanity are all statically checkable);
PUT schema change leaves stale rows/orphaned idx keys (migration-on-change is a design problem);
apps:* KV namespace writable via generic kv-set (bypasses traits+mutex) — spike 2 item 5;
in-process mutex assumes single API instance (the no-CAS answer breaks on replicas);
$row/$form invented semantics must live in the skill or agents will guess $item.

## Spike verdict — what the platform version needs that the spike exposed

1. App-authoring guidance must ship server-side (tool description / seeded skill): the worker
   succeeded because the task embedded a format primer; naked schema would've been format-guessing.
2. An `app-get`/`app-list` MCP tool (agent had no way to read back an app definition via MCP).
3. Scroll/layout: JSON-rendered pages need the layout contract handled by the runtime, not the
   definition (done in spike).
4. UI edit loop missing (edit definition in dashboard) — Taras: fine as long as the AGENT can edit
   it → app-get/app-patch (spike 2 item 1) is the edit loop; a human UI editor is not a priority.

## Spike 2 results (2026-08-01, complete — same session family, frozen spec ./2026-08-01-swarm-apps-spike2-spec.md)

Commits: `b4be8c07` contract freeze (spec + app.action catalog schema + generated
catalog artifact), `02c3bf73` UI slice, `5a8daf01` server slice. Flow: recon workflow
(6 Sonnet readers → /tmp/recon2-*.md) → freeze → Codex sol server slice ∥ Opus workflow
UI slice → two-lens review (Opus core + Sonnet periphery) → fix round (Codex resume +
orchestrator) → commits → E2E.

- **Everything in scope shipped**: app-get/app-list/app-patch (merge patch per spec:
  RFC 7396 + atomic `page.elements.*`/`actions.*`, null-clears, validate-merged-result);
  server-side page validator driven by `src/apps/catalog.generated.json` (generated from
  the UI zod catalog via `apps/ui/scripts/generate-catalog-schema.ts`); seeded `apps`
  skill (systemDefault) + `system.agent.apps` prompt block; dashboard polish (sidebar
  above Approvals w/ BETA tooltip, name breadcrumbs, pages-style chrome, ?mode=full,
  ?mode=chromeless); `apps:*` reserved-namespace guard at both generic KV write choke
  points; custom actions: `script` kind (runs under script owner — documented spike
  tradeoff) and `task` kind (observable via GET /api/tasks/:id + UI polling into
  `/actions/<name>` state).
- **Review headline (A1, caught pre-E2E)**: the validator initially hard-rejected the
  live Bookmarks app — its page mirrored MODEL column kinds (`"string"`) into Table
  column `kind` and used a bare-string `confirm`. Fix: catalog accepts the aliases +
  string-confirm shorthand. Lesson: **the validator must never reject what the runtime
  renders**; live app definitions are the regression fixtures that catch this
  (`src/tests/fixtures/bookmarks-definition.json.txt`).
- **Finale PASSED (the iteration loop, zero-shot)**: worker task "add a rating feature
  + filter by rating to Bookmarks", NO format primer. Agent: app-list → app-get →
  loaded the seeded `apps` Skill → ONE app-patch, **0 validation rejections**, $3.07.
  Added rating column, star row-actions (★1–5 + Clear), per-rating queries + tables +
  unrated section. The dashboard browser-verify agent caught the app updating LIVE
  between its screenshots. All 6 browser checks + 13 HTTP checks + MCP battery green.
- **Worker's own catalog verdict** (in its task result): static query filters forced a
  7-table layout; it explicitly asked for "$state-bindable query filters or implemented
  `visible` semantics with equality comparison" — confirms catalog gap №3/№4 (search /
  user-driven filtering via query overrides) as the top UI-catalog priority.
- Visual follow-ups from browser verify (not fixed, spike): duplicate "Bookmarks"
  heading (PageHeader + app's own H1); row-action cluster clipped in default/full mode
  (7+ actions overflow the grid column); hard cell truncation without ellipsis; dead
  space under short tables; "All apps" bare link inconsistent next to buttons.
- Productization flags: script actions need invoker-rights/invoker-brokered credentials
  (comment at the run-as site in src/http/apps.ts); no app versioning/snapshot before
  patch (unlike workflows); task-kind `agentId` is format-checked only.
- New env facts: stack restarted on new code — API :3113 pid via
  `lsof -iTCP:3113 -sTCP:LISTEN`, worker relaunched from /tmp/apps-worker-ws (env:
  MCP_BASE_URL/AGENT_SWARM_API_KEY/AGENT_ID + *_DISABLE=true). Scratch app
  d5968b96 "Spike2 Scratch" left in DB (used by the E2E battery). `codex exec resume
  --last` takes neither `-C` nor `-s` (only `-o`/`-c`/`-m`) — first two fix-round
  launches died instantly on that.

## Gotchas learned

- zsh `rm -f glob*` with no match aborts the whole command (broke a background boot once).
- Dashboard in a fresh browser profile needs Settings→Connections setup (API URL/key) + identity
  dialog before /apps/:id renders.
- MCP callTool 401 "Agent not found" until the X-Agent-ID exists — register via POST /api/agents.
- Dev servers on :3013/:5274 were left untouched on purpose (migration-124 pollution of dev DB).
