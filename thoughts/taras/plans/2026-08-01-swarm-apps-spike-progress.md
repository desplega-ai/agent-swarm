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

## Spike 2.5 results (2026-08-02, complete — layout + search catalog, spec ./2026-08-02-swarm-apps-spike25-catalog-spec.md)

- **Catalog grew the layout/interactivity tier** (frozen contract implemented exactly):
  Stack (primary layout; Container = legacy), responsive Grid, Split (positional children,
  collapse-below token), Divider, Tabs (positional children, inactive panels stay mounted →
  polling stays warm; active key at `/ui/<id>/tab`), SearchInput (debounced → `/ui/<id>/value`),
  Select (null-on-clear), Markdown (Streamdown); Table gained bindable `search` + `filters`
  (client-side; null/empty disables) — the exact "$state-bindable filters" the spike-2 finale
  worker asked for. Validator gained the `/ui/<id>` state root (ids from SearchInput/Select/Tabs).
  Skill updated (18-component catalog + layout guidance).
- **Notes Mini showcase built via `app-patch` over MCP** (dogfood): model rebuilt
  (title/content/tag/pinned; old `text` column + old element merge-deleted), intro Grid,
  Split (form + filters left, Tabs right: All/Pinned/About), live search + tag filter,
  markdown About tab, 7 seeded rows. Repro artifacts committed:
  `scripts/dev/notes-mini-showcase.{patch,seed}.json`. Browser QA: 8/8 PASS incl. 640px
  responsive collapse.
- **Real find during polish (shared DataGrid)**: `sizeColumnsToFit()` against a 0px-wide body
  (default-visible tab inside Split, pre-layout) hits AG Grid's `availablePixels <= 0` branch
  and pins every column to minWidth permanently. Fix: opt-in `columnSizing="flex"` on DataGrid
  (native flex sizing, timing-proof); also `cellDataType: false` (AG Grid 33 was substituting
  checkbox renderers for booleans over the documented yes/no), span-based `truncate` for real
  ellipsis (`.ag-cell` is flex → text-overflow never applied), content-hugging autoHeight ≤12
  rows, in-trigger Select clear. Dashboard grids unchanged (default preserved; /tasks
  regression-screenshotted).
- json-render gotcha for the platform version: `React.Children.toArray` DROPS null children
  (missing element ids) and silently shifts positional indices — positional components must use
  the raw children array.

## Spike 3 results (2026-08-02/03, complete — spec ./2026-08-02-swarm-apps-spike3-sync-spec.md)

Flow: recon workflow (6 Sonnet readers → /tmp/recon3-*.md) → task-0 action-loop browser
proof → freeze spec (76d1a13b) → Codex sol server slice → two-lens review workflow (Opus
core + Sonnet periphery + adversarial verify) → codex fix round → commit 9db67996 → E2E.
NO UI slice — recon-confirmed zero apps/ui changes needed and E2E bore that out.

- **Review headline (CONFIRMED blocker, empirically reproduced by the verifier):**
  concurrent sync passes duplicated every row — reconcile read happened outside the
  per-model mutex and all three entry doors (HTTP /sync, sync action, app-sync MCP) were
  unserialized; a Refresh double-click sufficed. Fix: pull() outside the lock, entire
  reconcile phase inside one withMutationLock span with unlocked row-writers + a
  barrier-gated concurrency regression test. Plus: GH timeout now spans the body read;
  repo "." / ".." segments rejected; app-query un-gated (read posture, registered in
  app-get.ts's allowlisted module); syncedAt bumps on every confirmed-present row WITHOUT
  bumping updatedAt (metadata-only patch option — otherwise freshness columns lie after
  no-op syncs / updatedAt sorts reshuffle every pass).
- **E2E (scratch app 12218dfe, all green):** read-only rejection with path-bearing issues
  (source-bound + join-key cols; owned cols writable); dual-source sync (6 swarm tasks +
  4 real GH issues from desplega-ai/agent-swarm); sync action returns script-kind shape
  (no taskId) so the untouched app.action runtime shows running→ok + refetch; stale
  round-trip via config narrowing (state all→open flags exactly the closed 2, widen
  clears); schedule targetType:'script' → app-sync-cron script → ctx.swarm.app_sync →
  rows refreshed, run-now endpoint fires immediately; app_query works from scripts.
- **PM-app finale (zero-shot) PASSED:** worker task with NO format primer built
  "PM Inbox" (6f93f0ce-755c-4b4d-afed-bbb11bb1eed2): issue model with TWO sources and
  per-source join-key columns (taskId / githubNumber), 18 source-bound columns with
  correct transforms (date-parse, lower), owned note + flag(enum) columns, scoped
  refresh actions (all/tasks/github), Tackle task-action whose rowAction carries
  {issue: {"$row": ""}} + a thoughtful prompt (incl. "if already completed, say so"),
  inbox/urgent queries, 37-element page using the full 2.5 layout tier. 12 synced rows
  from both sources, agent ran app-sync itself 3× to verify. **Exactly ONE validation
  rejection** (missing rowId in a form's update chain) — the page validator caught it
  and the agent self-corrected from issues[] in the next patch: the designed loop
  working as intended. $3.74, 36 turns, ~8.5 min.
- **Browser verify (PM Inbox): 6/6 PASS** (screenshots /tmp/spike3-pm-*.png): split
  layout + 4 tabs render both sources; Last-synced relative times; Refresh badge
  OK→RUNNING(+54ms)→OK(+377ms) with all rows flipping "just now"; search narrows to the
  CODEOWNERS row, Select source-filter works; Tackle confirm-dialog → real task with the
  full row JSON in the prompt, visible in the pool after refresh. Bonus: the stale flag
  fired ORGANICALLY mid-test — a GH issue fell out of the 100-item pull window and its
  Freshness badge flipped TRUE while others resynced. Catalog/runtime follow-ups logged:
  idle action badges render literal "UNDEFINED" (recurring from task 0); boolean cells
  render raw TRUE/FALSE (want badge labels); Select has no built-in reset option once
  chosen; wide-table column-width distribution + row-action overflow clipping; AG Grid
  #200 (CellStyleModule) seen once under HMR, clean after full reload; scripted E2E
  can't drive SearchInput via native setter+input event (state store not updated).
- **Stretch (autopilot) PASSED:** pm-nightly-digest workflow (swarm-script node) calls
  the agent-built app's own queries via app_query and publishes an HTML digest page
  (14ea4604, versioned on re-run); nightly cron schedule (0 6 * * *,
  targetType:'workflow') wired. "Agents are end-users of the app they built" — proven.
- **Env/ops incidents worth remembering:** (1) Codex's sandbox denies .env reads; its
  first stray test boot fell through to the DEFAULT ./agent-swarm-db.sqlite and applied
  migration 124 there — surgically undone (DROP apps + delete _migrations row; backup
  /tmp/agent-swarm-db.backup-pre-124-undo.sqlite); a review verifier repeated the
  pattern before its safety stop, end-state verified clean. Delegated prompts must
  mandate isolated DATABASE_PATH + BUN_OPTIONS=--no-env-file. (2) Schedules accept only
  GLOBAL-scope scripts and global script writes are lead-gated → e2e-probe promoted to
  lead in the isolated DB (side effect: lead auto-assignment stole the first finale
  task; recreate pinned to the worker). (3) page_create takes body/contentType, not
  content/kind.
- Isolated-stack state for pickup: apps incl. PM Inbox 6f93f0ce + scratch 12218dfe;
  schedules spike3-pm-sync (hourly script) + spike3-nightly-digest (cron workflow);
  global scripts app-sync-cron/pm-digest (sources committed in scripts/dev/); e2e-probe
  21bc3294 is lead; GH source repo desplega-ai/agent-swarm at limit 100 (window-relative
  staleness documented in the skill).

## AMENDMENT v2 shipped (2026-08-03): sources are dynamic / script-backed

- `SourceDef` is now a discriminated union: `swarm-tasks` (native) | `script`
  (`scriptId` + `args`, THE default kind). `github-issues` enum + hardcoded pull
  removed from sync.ts; logic moved to seed script `github-issues-pull`
  (src/be/seed-scripts/catalog/, global). Engine calls `runScript` outside the
  reconcile lock, validates `Array<{key, fields}>` (cap 500), zero row churn on
  script error. All gates green (tsc, lint, 37 tests across the two touched files,
  db-boundary, skill-sources).
- **Live-app migration (spec item 7) done by direct DB edit, not app-patch**: with
  the enum removed, stored `github-issues` definitions fail zod at READ time —
  GET/PATCH /api/apps/:id both 500 before any patch can apply. Platform lesson:
  connector-enum changes need a definition migration path; for the spike the two
  live apps (PM Inbox, scratch) were rewritten in sqlite to
  `{connector: "script", scriptId: <github-issues-pull>, args: <old config>}`.
- Post-migration sync verified identical: PM Inbox `github` + scratch `gh` pull 3
  real GH issues via the script source, all `unchanged` (projection byte-identical
  to the v1 connector); swarm-tasks passes untouched.

## Spike 4 candidate (Taras, 2026-08-03): router-like flows — the SPA tier

Vision: apps define router-like flows — detail pages, additional pages, sidepanels.
Today's runtime is a reactive single-page app (live state store, Tabs view-switching
with warm polling, instant client search/filter, truthy-only `visible`) but has NO
internal navigation: one page per app, no routes, no detail views, no drawers.

Sketch agreed in-session (all additive, no architecture change — Tabs + `/ui` proved
the state machinery carries view-switching):
1. `page` → `pages` map (same `{root, elements}` shape per entry; `defaultPage`;
   optional declared `params` per page; back-compat single `page` = one entry;
   `pages.<name>` atomic in merge patch like elements).
2. URL-synced router: `/apps/:id/p/:page?<params>` — shareable + chromeless-embeddable,
   browser back works; current route mirrored to state at `/route`.
3. New action kind `app.navigate {page, params}` — `$row` sentinels already resolve in
   action params, so row→detail is one rowAction chain.
4. Parameterized query filters `{"$param": "<name>"}` resolved from route params — the
   one query-language growth that's earned (detail pages need it).
5. Route-driven `Drawer`/`Modal` (`?panel=…` — deep-linkable, declarative) + `DetailList`
   component; equality semantics for `visible` (spike-2 worker's request).
6. Validator generalizes per pages-entry + cross-page checks (navigate targets exist,
   `$param` declared on target, param-bound filters resolve) — same issues[] contract,
   iteration loop unchanged.

## Spike 4 results (2026-08-03, complete — spec ./2026-08-03-swarm-apps-spike4-router-spec.md)

Flow: recon workflow (6 Sonnet readers → /tmp/recon4-*.md) → freeze 9dc4d3cd (spec +
catalog additions + typecheck stubs, spike-2 precedent) → Codex sol server slice ∥ Opus
workflow UI slice (disjoint fences, same tree) → two-lens review workflow (2 Opus core +
2 Sonnet periphery lenses, adversarial verify per finding) → fixes → commits e1555fe8 +
9c146046 → E2E → finale. Commits after: 03b6bcd1 (system columns), 0af70e18 (props
normalization), 0bd60198 (spike-2 test modernization), 8413e1cd (visible shapes).

- **Everything in scope shipped**: pages map + defaultPage + typed per-page params with
  legacy-`page` normalization (zod transform; read path normalizes in-memory — the
  AMENDMENT-v2 lesson applied); URL router /apps/:id/p/:page with /route state mirror
  (pre-paint, declared params only, kind-coerced); app.navigate (ctxRef, params replace,
  mode-only carry, push); $param query filters (column-kind coercion, fail-loud missing
  AND unknown params, HTTP ?param.<name>= + app-query params + script SDK types);
  Drawer (Sheet, open ⟺ route param, close = history replace, mount-on-open);
  DetailList (DefinitionList/InfoRow, shared formatValue, code kind); per-page +
  cross-page validator (route state root, navigate targets, $param declared-on-page,
  Drawer literal param, strict page schemas); skill rewritten (visible one-comparison-key
  rule + negation flag, row→detail worked example).
- **Recon headline that reshaped the freeze**: `visible` equality/comparison already
  existed in @json-render/core 0.19.0 (document + close validator capture gap, don't
  build); `{"$param"}` server-side only — UI binds `/route` via plain $state.
- **Review (15 findings, 15/15 CONFIRMED by adversarial verify, 0 refuted)**: 2 majors
  both on the agent-contract surface (skill claimed multi-comparison keys combine —
  library is first-match-wins; generated script SDK types missed app_query params).
  13 fixed, 2 accepted with rationale (silent drop of empty navigate params — the
  target page's parked-query error is the fail-loud signal; drawer-close blanking got a
  retain-last-rows fix instead).
- **E2E found 3 real gaps the review missed** (all fixed + regression-tested):
  (1) query filters rejected system columns — but `id` is the only universal detail-row
  identity (SYSTEM_COLUMN_KINDS amendment); (2) the renderer crashes the whole page on
  a propless container element — validator-accepted shape, runtime now normalizes
  props:{} per element; (3) post-finale: validator accepted `{"not": {$state}}` wrapper
  the renderer silently ignores (alert never hides) — now rejected with guidance, skill
  documents `not: true` negation flag + absent-record recipe.
- **HTTP/MCP battery green**: 6/6 stored apps normalize on read; negative battery (6
  rejection classes, path-bearing issues); $param coercion + missing/unknown 400s;
  patch atomicity at pages.<n>.elements/params entries; app-query MCP 3/3.
- **Browser E2E 10/10 PASS** (after props fix; screenshots /tmp/spike4-e2e-*-retry.png):
  SPA row→detail without reload, cold deep link, Back across pages, ?panel drawer
  surviving F5, close-is-replace (Back does not reopen), unknown-page card, PM Inbox
  legacy regression clean. Zero console errors.
- **Finale PASSED, zero-shot, ZERO validation rejections** (beats the ≤1 bar; spike-3's
  finale had 1): worker task with NO primer built the PM Inbox detail view — new
  `detail` page (37 elements, required typed issueId param), `issueDetail` query
  filtering on system `id` (the exact pattern the E2E amendment enabled hours earlier),
  2-1 Split with source-conditional sections (visible eq on source), sync-provenance
  card (syncedAt/stale/join keys + pull-window hint), share-URL card, Tackle from
  header (app.action with full row from $state) AND row action, Open row actions on
  all 4 inbox tables. Honest caveat: the worker leaned on its own persistent agent
  memory from spike-3 sessions (REST-vs-MCP tradeoffs, error formats) — no primer in
  the task, but not an amnesiac agent.
- **Finale browser verify 7/8 → 8/8 after the visible fix + live patch** (screenshots
  /tmp/spike4-finale-*.png): both source-conditional directions, deep link, Back,
  Tackle → real task created (a4763f25) with RUNNING badge, graceful bogus-id state.
  Remaining defect is the KNOWN wide-table issue (11-column GitHub tab drops the
  row-actions column — same class as the spike-2/3 "row-action overflow clipping"
  follow-up; not a spike-4 regression, still unfixed).
- **Ops notes**: a review verifier polluted the protected dev DB AGAIN (initDb() with
  no path; third occurrence) — surgically restored (backup
  /tmp/agent-swarm-db.backup-pre-124-undo-2.sqlite, verified 119 migrations); delegated
  prompts now also need the mandate for REVIEW/verify agents, not just implementers.
  Pre-push hook runs the FULL suite — apps-spike2.test.ts asserted the old contract and
  blocked the push until modernized; running the full suite with a shared DATABASE_PATH
  file breaks 200+ tests (isolation artifact, not real).
- Productization flags (new this spike): all queries poll regardless of active page;
  no CI freshness gate for catalog.generated.json; renderer's propless-element crash
  belongs upstream in @json-render (we normalize as a shim); wide-table row-action
  overflow now bites agent-built apps (11 columns) — promote from cosmetic to real;
  validator/runtime contract needs a single source of truth for `visible` shapes
  (we now hand-mirror library semantics).

## Spike 5 candidate (Taras + Claude, 2026-08-03): the lifecycle tier — RESEARCH FIRST (new session)

Agreed direction: schema evolution + versioning + rollback — "apps live long enough to
change". Research in a NEW session (`/desplega:research` over this doc + the brainstorm +
the spike specs) before freezing a spike-5 contract. Rationale: spikes 1-4 validated all
FEATURE clusters; the unproven dimension is an agent changing a model that already holds
real data — the risk class the spikes kept brushing against:
- "PUT schema change leaves stale rows / orphaned idx keys" logged since spike 1;
  both PATCH routes carry an explicit "does not migrate rows" comment.
- AMENDMENT v2 bricked stored definitions at READ time (enum removal); recovery was a
  hand-edit of sqlite — no migration path for anything stored.
- No versioning/snapshot before patch (flagged since spike 2) — one bad agent patch
  destroys the only copy of the definition.

Research questions / sketch to validate:
1. Schema-change contract: model/column patches against an app WITH rows — add column
   (default/backfill), remove column, kind change, enum narrowing; destructive changes
   fail loudly via issues[] unless the patch carries an explicit migration directive;
   index rebuild + row backfill server-side under the model mutex (sync machinery
   precedent). How do source-bound columns + join keys interact with migrations?
2. Versioning: snapshot on every definition write (app_versions, mirror the workflows
   pattern), agent-legible app-history/app-diff/app-rollback tools; rollback restores
   the definition and the schema engine handles the row side.
3. Stored-definition format migration (the read-time-brick class, generalized) — the
   platform must be able to evolve its own definition schema without sqlite surgery.
4. Finale shape: "restructure PM Inbox's flag column into priority + status, keeping
   all existing annotations" zero-shot, data intact, then app-rollback restores.

Deliberately ranked below this (machinery mostly proven or incremental): hooks
(after-write automation — actions/schedules/sync precedents), repeat/$item + catalog
growth, per-app ACL/sharing (pages precedent). After spike 5: stop spiking → /research
→ create-plan for the real referenced-rows implementation.

**Research DONE + spec frozen (2026-08-03, research session):** research doc
`../research/2026-08-03-swarm-apps-spike5-lifecycle-research.md` (Taras-reviewed; all
open questions resolved in its "Resolved directions" section — headline: backward-compat
by default, column delete = `hidden` flag, destruction always explicit via a `migration`
directive riding as a sibling field on the patch; rollback = forward-migrate;
schemaVersion + lazy upgrade fns for the format-brick class). Frozen contract:
`./2026-08-03-swarm-apps-spike5-lifecycle-spec.md` — server-only slice, no UI.
Execute in a NEW session: freeze commit → Codex sol server slice → two-lens review →
E2E → flag→priority+status finale + rollback part 2.

## Spike 3 log (2026-08-02, superseded by results above — spec ./2026-08-02-swarm-apps-spike3-sync-spec.md)

- **Task 0 (action-loop browser proof): PASS 3/3.** Saved script `notes-add-sample`
  (agent-scoped under e2e-probe 21bc3294) writes a note row via the app-model row
  endpoint using `ctx.stdlib.fetch` + `Redacted.value(ctx.swarm.config.{mcpBaseUrl,apiKey})`;
  wired as `addSample`/`failDemo` (script kind) + `tackleDemo` (task kind) on Notes Mini
  with status Badges bound to `/actions/<name>/...`. Browser: running→ok + refetch shows
  the new row; error path shows the thrown message; task action mirrored
  unassigned→in_progress→completed→ok in ~85s (worker picked it up from the pool).
  Screenshots /tmp/spike3-task0-*.png.
- **Env bug found by task 0**: repo `.env` carries `MCP_BASE_URL=https://taras-swarm.ngrok.dev`
  (dead tunnel); Bun auto-loads it and `runScript` falls back to `process.env.MCP_BASE_URL`,
  so scripts launched by the isolated API got the ngrok URL (script fetch → 404 HTML).
  Fix: the isolated API MUST be started with explicit `MCP_BASE_URL=http://localhost:3113`
  (done; keep on every restart).
- Cosmetic follow-ups (not spike-blocking): Badge renders literal "UNDEFINED" for unbound
  pre-click state (badge binding stringifies undefined); AG Grid console error #200
  (cellClass w/o CellStyleModule) on app tables; failDemo long error text wraps tall.
- Recon workflow (6 Sonnet readers) → /tmp/recon3-*.md. Load-bearing: schedules already
  do `targetType:'script'` in-process on :3113 (+ `POST /api/schedules/{id}/run` to fire
  now; schedule scripts run as the schedule's createdByAgentId — create schedules under
  a registered agent); no Linear creds anywhere in the isolated DB → source #2 =
  **GitHub public issues on desplega-ai/agent-swarm** (2 open real issues; `state`
  open↔all patching demos the stale flag); scripts have NO row-write surface (SDK has
  only definition-level app tools) → sync engine is server-side, exposed via new
  `app-sync`/`app-query` MCP tools; UI needs ZERO changes (sync action returns the
  script-kind response shape; freshness = date/badge columns).

## Gotchas learned

- zsh `rm -f glob*` with no match aborts the whole command (broke a background boot once).
- Dashboard in a fresh browser profile needs Settings→Connections setup (API URL/key) + identity
  dialog before /apps/:id renders.
- MCP callTool 401 "Agent not found" until the X-Agent-ID exists — register via POST /api/agents.
- Dev servers on :3013/:5274 were left untouched on purpose (migration-124 pollution of dev DB).
