---
date: 2026-08-03
author: claude (orchestrator session)
topic: "Swarm Apps spike 4 — frozen contract: pages / router / SPA tier"
status: frozen
branch: spike/swarm-apps
---

# Spike 4 frozen contract — router-like flows (pages, detail views, sidepanels)

Source: progress doc `./2026-08-01-swarm-apps-spike-progress.md` § "Spike 4 candidate",
recon `/tmp/recon4-{1..6}-*.md`. Frozen contracts from spikes 2/2.5/3 remain in force;
everything not listed here is UNCHANGED. Everything below is additive.

Recon-driven calls baked into this spec (differences from the sketch):

- **`visible` equality is NOT built — it already exists.** @json-render/core 0.19.0
  ships `visible: { "$state": <path>, "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"not": <value> }`
  plus `{"$and": [...]}` / `{"$or": [...]}` arrays, evaluated in the renderer before
  mount. Spike work = document it in the skill + close the validator gap (the
  multi-key form's `$state` path is currently never captured/validated).
- **`{"$param": "<name>"}` lives ONLY in named-query filter values** (server-resolved).
  UI-side bindings reach route state via plain `{"$state": "/route/..."}` — reuses all
  existing prop/visible/filters machinery. No new client-side sentinel.
- **Catalog additions are part of the freeze commit** (spike-2 precedent): `Drawer`,
  `DetailList`, `app.navigate` are already in `apps/ui/src/lib/json-render/catalog.ts`
  + regenerated `src/apps/catalog.generated.json`, with typecheck-satisfying stubs in
  `components.tsx` / `page.tsx` / `json-page-renderer.tsx`. The slices implement them.
- **AMENDMENT-v2 lesson applied**: definitions with the legacy single `page` must keep
  parsing at READ time (normalize in-memory, never 500 on stored apps).

## 1. Definition: `page` → `pages` map (server slice)

```ts
// AppDefinition gains (page XOR pages — exactly one required):
pages?: Record<PageName, {
  root: string,
  elements: Record<string, Element>,   // same element shape as today
  title?: string,                      // display title (breadcrumb); default: page name
  params?: Record<ParamName, {
    kind?: "string" | "number" | "boolean",  // default "string"
    required?: boolean,                       // default false
  }>,
}>
defaultPage?: string   // required iff `pages` is used; must exist in `pages`
```

- `PageName` / `ParamName` reuse `AppNameSchema` (`/^[a-z][a-zA-Z0-9_]{0,39}$/`).
- **Reserved param names** (URL collisions): `mode`, `apiUrl`, `apiKey`, `email`,
  `name` → validation issue.
- **Normalization**: `parseAppDefinition` accepts either shape and returns the
  canonical `pages` form; legacy `page` becomes `pages: { main: <page> }`,
  `defaultPage: "main"`. Every WRITE (upsert/PUT/patch) stores the normalized form.
  READ of a stored legacy definition normalizes in-memory (no error). Supplying BOTH
  `page` and `pages` → validation issue.
- **Merge patch**: a patch containing top-level key `page` → validation issue
  ("definitions are normalized to the pages map — patch pages.<name> instead"; agents
  read normalized form via app-get, so only stale knowledge hits this, and issues[]
  self-corrects it). Atomicity generalizes the existing rules:
  - `pages.<name>` = `null` deletes the page (cannot delete `defaultPage` — issue).
  - `pages.<name>.elements.<id>` — per-entry ATOMIC (exactly like today's
    `page.elements.<id>`).
  - `pages.<name>.params.<param>` — per-entry ATOMIC (like `models.<m>.columns.<c>`).
  - `pages.<name>.root` / `.title`, `defaultPage` — plain merge.
  - The legacy `['page','elements']` atomic rule stays in code (harmless dead path
    behind the `page`-key rejection).

## 2. Router (UI slice)

- New route `apps/:id/p/:page` → same lazy `AppDetailPage` (flat leaf next to
  `apps/:id` in `router.tsx`). `/apps/:id` (no `/p/`) renders `defaultPage` — both
  URLs stay valid; no redirect.
- Page params ride the query string as plain keys (`?issueId=42&panel=x`), coexisting
  with `?mode=`. `app.navigate` preserves ONLY `mode` across navigations.
- **The route is mirrored into json-render state at `/route`** as
  `{ page: string, params: Record<string, string|number|boolean> }` — same mirror
  pattern as the `/queries/<name>` effect in `page.tsx:246-266`. Only DECLARED params
  are mirrored, each **coerced by its declared `kind`** (`number` → Number, `boolean` →
  `"true"/"1"` → true; failed number coercion mirrors as the raw string). Coercion is
  what makes `visible: { $state: "/route/params/x", eq: 2 }` work — URL params are
  strings and the renderer's `eq` is strict `===`.
- Unknown `:page` (not in `pages`) → inline error card with a link to the default
  page (component-side; no router loaders exist in this codebase).
- History: `app.navigate` = PUSH (browser Back returns across page/param changes).
  Drawer close = REPLACE (Back never reopens a dismissed drawer, and Back from an
  open drawer closes it).
- `AppRuntime` stays keyed by `app.id` ONLY — the StateStore, `/queries` poll cache,
  and `/ui` state deliberately survive page navigation (warm-data property; same as
  today's `?mode` switches). `useAppQueries` keeps polling ALL named queries
  regardless of active page (accepted for the spike; productization flag below).
- Scroll to top on page-name change (no ScrollRestoration exists; do it in
  AppRuntime).
- Breadcrumbs: `/p/<page>` segment renders the page `title` (fallback: name);
  minimal special-casing in `breadcrumbs.tsx`.
- The `app.navigate` handler MUST read router state via the existing mutable
  `ctxRef` pattern (recon: ActionProvider snapshots handlers at mount — a closure
  over `useNavigate()` goes stale). Do NOT wire `ActionProvider`'s built-in
  `navigate` prop / `onSuccess.navigate` convention — it stays unused and
  undocumented.

## 3. `app.navigate` action (frozen in catalog; UI slice implements)

`{ page: string, params?: Record<string, string|number|boolean> }` — params REPLACE
current route params wholesale (no merging); values may be `$row`/`$rowIndex`/`$form`
sentinels (resolved by the existing `action-params.ts` scope resolver before
dispatch). Row → detail is one rowAction:
`{ "action": "app.navigate", "params": { "page": "detail", "params": { "issueId": { "$row": "id" } } } }`.

## 4. Parameterized query filters — `{"$param": "<name>"}` (server slice)

The ONE query-language growth. A named query's `filter` value may be
`{"$param": "<name>"}` (exactly one key, string name). Everything else about the
query language (strict AND-of-equality, sort, limit) stays frozen.

- **Execution**: `applyQuery` resolves `$param` values from a caller-supplied
  `params` record before filtering. Supplied values are **coerced to the target
  COLUMN's kind** (number/boolean/date/string — reuse the existing per-kind branch).
  Any `$param` filter with NO supplied value → **400 / toolErr** listing the missing
  names (fail-loud; no silent all-rows).
- **HTTP**: `GET /api/apps/:id/queries/:name?param.<name>=<value>` (repeatable
  prefix keys, same idiom as the row-list `filter.<col>=`).
- **MCP**: `app-query` gains optional `params: Record<string, string|number|boolean>`
  input (flows to scripts' `ctx.swarm.app_query` automatically via the SDK map —
  autopilot can drive detail queries).
- **Client**: `runAppQuery(appId, name, params?)`; `useAppQueries` passes the current
  `/route` params to queries that contain `$param` filters. A `$param` query whose
  names aren't all present in the current route is NOT executed; its slot gets
  `{ data: [], loading: false, error: "missing route param(s): <names>" }`.
- **Validation** (cross-page pass, §6): for every page P and every query Q referenced
  from P's bindings (`/queries/<Q>`), each `$param` name in Q's filters must be
  declared in P's `params`. A `$param` query referenced by NO page is legal (callable
  via app-query with explicit params).

## 5. Catalog: `Drawer` + `DetailList` (frozen schemas; UI slice implements)

- **Drawer** `{ param, title?, description?, side?: right|left, size?: sm|md|lg|xl }`,
  slot `default`. Open ⟺ `/route/params/<param>` is set (declared param, any
  non-empty value). Built on the existing `Sheet` primitive (reference:
  `event-detail-sheet.tsx`); children mount ONLY while open (deliberately the
  opposite of Tabs' warm forceMount — a Table inside re-mounts per open; already
  0px-safe via `columnSizing="flex"`). Close button / overlay dismiss → clear the
  param via history REPLACE.
- **DetailList** `{ data (usually {"$state": "/queries/<q>/data/0"}), fields:
  [{ key, label?, kind?, tones? }], emptyMessage?, columns?: 1|2 }`. Built on
  `InfoRow`/`DefinitionList`; field kinds reuse Table's `formatCell`/badge-tone
  helpers (factor them into a shared helper — recon flagged the duplication), plus
  new `code` kind (monospace block for raw/JSON values).
- `visible` equality: no renderer work (see freeze notes); skill documents it.

## 6. Validator (server slice) — same issues[] contract

- Per-page: run today's `validatePage` walk once per `pages` entry; issue paths
  prefixed `pages.<name>.…`. `formIds`/`uiIds` stay PAGE-LOCAL (a binding to another
  page's form/ui id is invalid — matches URL-scoped page model).
- State-ref namespace regex gains `route`: valid refs are `/route/page` and
  `/route/params/<name>` where `<name>` is declared on the CURRENT page.
- **Close the visible-equality gap**: capture and validate `$state` refs inside
  multi-key condition objects (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`not`) and `$and`/
  `$or` arrays (currently walked as opaque `{}` — a typo'd path silently passes).
- `app.navigate` branch in `actionParams`: `params.page` must exist in `pages`;
  supplied param keys ⊆ target page's declared params; target's `required` params
  all supplied. Values may be action sentinels (existing allowance).
- Cross-page second pass (sibling of `sourceDefinitionIssues`, full-pages
  visibility): navigate-target checks above + the §4 `$param`-declared check +
  `Drawer.param` declared on its containing page + `defaultPage` exists.
- Reserved param names (§1) rejected.

## 7. Seeded `apps` skill (server slice)

Rewrite/extend `templates/skills/apps/content.md`: pages map + defaultPage + params
(+ the `page`→`pages.main` normalization note), router URL shape + shareable/deep-link
story, `/route` state root (+ the declared-kind coercion rule), `app.navigate`
(+ params-replace semantics), `$param` query filters (+ fail-loud missing-param
behavior + app-query `params` input), Drawer (route-param driven, mount-on-open),
DetailList, `visible` equality forms (library semantics, incl. `$and`/`$or`).
Update the patch-semantics atomic list (`pages.<name>.elements.<id>`,
`pages.<name>.params.<param>`) and the state-root list (`/route`). Also fold in the
two doc gaps recon found: named-query default limit 200; date filters compare raw ISO
strings.

## AMENDMENT (2026-08-03, during E2E): filters may target system columns

E2E step 2 exposed a gap the review missed: named-query filters rejected the
reserved system columns, but a detail query's only UNIVERSAL row identity is
`id` (CRUD apps declare no join-key column, and the finale agent will reach for
it). Amended: filter values — literal and `$param` — may target `id`,
`createdAt`, `updatedAt`, `source`, `syncedAt`, `stale`, with kinds
string/date/date/string/date/boolean (`SYSTEM_COLUMN_KINDS` in definition.ts;
coercion + validation reuse the same kind branches). Sort stays as it was
(createdAt/updatedAt/syncedAt + model columns). Skill updated in place.

## Out of scope (unchanged from the task)

repeat/$item lists; app versioning; per-app ACL; server-side query overrides beyond
`$param`; hooks; real-time (5s poll stays); multi-app navigation; chromeless-as-real
-route (stays a CSS overlay); ActionProvider's built-in navigate.

## Slices & fences

- **Freeze commit (orchestrator, done)**: this spec + catalog.ts additions +
  regenerated catalog.generated.json + typecheck stubs (Drawer/DetailList = null,
  app.navigate = no-op, pages-renderer inert stub).
- **UI slice (Opus workflow)** — `apps/ui/**` EXCEPT `catalog.ts` (frozen):
  `router.tsx`, `pages/apps/[id]/page.tsx`, `lib/json-render/{components.tsx,
  action-params.ts,index.ts}`, `api/{types.ts,client.ts,hooks/use-apps.ts}`,
  `components/layout/breadcrumbs.tsx`.
- **Server slice (Codex sol)** — `src/apps/{definition.ts,page-validator.ts}`,
  `src/http/apps.ts`, `src/tools/app-get.ts`, `src/tests/apps-spike4.test.ts`,
  `templates/skills/apps/content.md`. Reads (never writes) `catalog.generated.json`.
- No commits by executors; orchestrator commits after the two-lens review.

## Verification (each slice, before review)

```bash
bun run lint && bun run tsc:check
bun run test:root -- src/tests/apps-spike4.test.ts src/tests/apps-spike3.test.ts src/tests/apps-spike.test.ts
bash scripts/check-db-boundary.sh
cd apps/ui && bunx tsc -b && bun run lint && bun run check:tokens
cd apps/ui && bun run generate:catalog-schema && git diff --exit-code ../../src/apps/catalog.generated.json  # no drift
bun run check:skill-sources
```

## Manual E2E (isolated stack — API :3113, DB /tmp/apps-spike-e2e.sqlite, vite :5375)

```bash
# 0. restart API + hard-reload vite tab after slices land (code pickup)
kill $(lsof -t -iTCP:3113 -sTCP:LISTEN); nohup env DATABASE_PATH=/tmp/apps-spike-e2e.sqlite PORT=3113 \
  MCP_BASE_URL=http://localhost:3113 SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true \
  LINEAR_DISABLE=true bun --expose-gc src/http.ts >> /tmp/apps-api.log 2>&1 &

# 1. back-compat: every live app (PM Inbox 6f93f0ce…, Notes bae5343b…, Bookmarks fe3f60c8…)
#    still GETs 200 + renders at /apps/<id> (stored legacy `page` normalizes in-memory)
curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/apps/6f93f0ce-755c-4b4d-afed-bbb11bb1eed2 | jq '.app.definition | has("pages")'

# 2. multi-page upsert: POST a 2-page scratch app (list + detail w/ params {issueId: {kind:"number"}},
#    $param query, navigate rowAction, Drawer bound to ?panel) → 200; then negative battery:
#    navigate to unknown page / undeclared $param / reserved param name / patch key `page`
#    / delete defaultPage → each 400 with path-bearing issues[]
# 3. $param over HTTP: /queries/<name>?param.issueId=42 → 1 row; missing param → 400 listing names
# 4. app-query MCP with params:{issueId:42} via real MCP client (X-Agent-ID: 43172bc2…)
# 5. patch atomicity: app-patch replacing pages.detail.elements.<one id> only → other elements intact
# 6. browser (agent-browser, http://localhost:5375): row click → /apps/:id/p/detail?issueId=… without
#    reload; DetailList renders; deep-link that URL fresh-tab → renders; Back → list; ?panel= drawer
#    opens; F5 → drawer still open; close drawer → param gone; Back does NOT reopen it;
#    visible-eq badge flips with route param. Drive SearchInput by real keystrokes only.
```

## Finale (zero-shot, after E2E green)

Worker task (pin `agentId: 43172bc2-3887-402b-a111-be451a083e3a` — lead steals unpinned),
NO format primer: "add a detail view to PM Inbox: clicking a row opens a per-issue
page (or drawer) showing all fields incl. sync provenance, with Tackle available from
the detail view, and a shareable URL". Success bar: agent reaches it via app-get →
app-patch with only the seeded skill, ≤1 self-corrected validation rejection; then
browser-verify the four router properties (no-reload nav, deep link, Back, drawer
survives refresh).

## Productization flags (log, don't fix)

- All named queries poll every 5s regardless of active page → page-scoped polling.
- No CI freshness gate for catalog.generated.json (unlike openapi/pi-skills).
- Connector/schema enum changes can brick stored definitions at read time
  (AMENDMENT v2 lesson) → definitions need a migration path.
- No app versioning/snapshot before patch (standing since spike 2).
