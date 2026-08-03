---
date: 2026-08-03T20:20:00+02:00
author: taras
topic: "Swarm Apps next iterations: legacy page removal, reusable elements, per-user app configuration"
tags: [brainstorm, swarm-apps, spike, app-definition, ui-runtime]
status: in-progress
exploration_type: idea
last_updated: 2026-08-03
last_updated_by: taras
---

# Swarm Apps next iterations — Brainstorm

## Context

Swarm Apps spikes 1–5 are validated on `spike/swarm-apps` (PR #1066, DO NOT MERGE). The spike stack currently runs locally from the `2026-08-03-swarm-apps` worktree (API :3113, UI :5375, DB `/tmp/apps-spike-e2e.sqlite` with 7 live apps). Spike-5 lifecycle research (versioning/backward-compat/rollback) is done; the spec is being frozen.

Taras's TLDR for the next iterations:

1. **Drop legacy singular `page`** — keep canonical `pages` + `defaultPage` only. The read/write normalization shim goes away; local dev DB rows can be migrated by hand.
2. **Reusable elements across apps** — some form of `elements` array/registry in (or beyond) the page for cross-app reusable components. Known implication: the UI ctx (state) management needs a rethink — it should be global and able to support elements that are reused in multiple places.
3. **Per-user configuration on apps** — a place (possibly inside the app itself) for per-user config, enabling automatically-added auditability fields + per-user UI configurations, etc.

Relevant current-state facts:
- Element ids and Form/UI ids are page-local; state paths like `/ui/<id>/value` are shared within a page (just demonstrated: two SearchInputs with the same `id: "shared"` pass validation and share `/ui/shared/value`).
- Definition shape today: `models` (1–10 required), `queries`, `actions`, `pages.<name>.{root, elements}`, `defaultPage`; legacy `page` is normalized in memory to `pages.main`.
- Spike-5 froze an app-lifecycle contract (app_versions, backward-compat schema evolution, rollback) that any new definition surface must play nicely with.

## Exploration

### Q: Spike-6 or start productionizing?
Taras (counter-question): "do you think the current is not there?" — his instinct: the current spike is close; what he'd do now is **revert/remove the connections part** (spike-3 sources/sync layer) and do it in a next iteration.

**Insights:** The mode question dissolves into a scope question — take the spike as the base, cut the connections/sync layer out of v1, defer it. Claude's assessment: the core contract (models/queries/actions/pages + patch-iteration loop + router) survived four spikes essentially unchanged and is "there"; the sync/sources layer is the highest-complexity, highest-operational-risk surface (script execution identity, credential bindings, reconciliation semantics, ownerless catalog scripts) and the least exercised end-to-end — cutting it shrinks v1 surface dramatically and it layers back cleanly later since source-bound columns are additive to the column contract.

### Q: Is spike-5 lifecycle in this iteration, or deferred with connections?
**Lifecycle in.** Iteration = current spike − connections + lifecycle + the 3 TLDR items.

**Insights:** Reusable elements (item 2) and per-user config (item 3) both change the definition contract; building them on top of app_versions means they're born with an evolution/rollback story. It also forces the cross-app component question to confront versioning immediately (a shared component referenced by a versioned app is an external dependency — pin or float?).

### Q: Where do reusable components live — global registry, app-as-library, or copy-on-use?
**App-as-library.** A new top-level definition field `elements` on the app; other apps reference those elements from outside (exact reference mechanism open). Taras flags the implication: json-render state needs special namespacing — something like `/apps/<id>/...` — i.e., the UI ctx becomes a global tree with per-app mounts instead of one flat per-page state.

**Insights:** No new entity type — the app is the unit of sharing/curation, and app-level `elements` also gives *within-app* reuse across pages for free. Open sub-forks this creates: (a) parameterization contract (props/slots vs literal include), (b) whose namespace an instance's state mounts under — consuming app (instance-scoped, each usage independent) vs defining app (state shared across all consumers — surprising but would enable cross-app live widgets), (c) whether an element can close over its defining app's queries/actions (⇒ cross-app data/action execution) or is purely presentational, (d) version pinning of cross-app refs under the lifecycle contract.

### Q: What can an element carry — just UI, or the defining app's data/behavior?
**Both, declared per element.** Two modes: **pure** (parameterized subtree, consumer supplies data/action bindings via props) and **bound** (element references its defining app's queries/actions — "data ref is key!"). Taras values the pure ones too, but bound is the point.

**Insights:** Bound elements = embedded live windows into another app (micro-frontend-ish). This drags in two hard follow-ups: identity/permissions for executing app A's queries/actions from inside app B (viewer's identity? app A's owner's?), and the state-plane split — A's data state vs the instance's interaction state.

### Q: Where does a bound element's state live in the global UI ctx?
**Split planes.** Data plane keys by *defining* app (`/apps/A/queries/<q>/data` — single fetch/cache, all consumers share liveness). Interaction plane keys by *instance* in the *consuming* app (`/apps/B/pages/<p>/instances/<key>/ui/<id>/value` — instances never collide). Pure elements only have the instance plane.

**Insights:** This fixes today's page-local flat `/ui/<id>/value` collision behavior (two same-id inputs silently share state — verified earlier today) by making instance scoping structural. The global ctx tree becomes: `/apps/<appId>/{queries,actions,pages/<page>/{route,ui,instances}}`. Cross-page-warm state (current behavior keeps polled data warm across page navs) generalizes to cross-app-warm within one browser session.

### Q: Whose identity executes A's queries/actions from an embed in B?
**Viewer identity + explicit export.** Elements are private by default; the defining app marks exported ones. The viewing user must have permission on app A for the bound element to render/act inside B — embedding never launders privileges.

**Insights:** Exported elements become the app's public API surface, which scopes the lifecycle/back-compat obligation: only exported elements need version discipline; private ones can churn freely.

### Q: Do cross-app element refs pin a version or float?
**Float + compat gate.** Refs track the defining app's latest version; the spike-5 backward-compat rules extend to exported elements — breaking an exported element's props/state contract requires a new element name (or an explicit major-style break), so floating stays safe by construction. "Fix once, fixed everywhere" is preserved.

**Insights:** This slots exported elements into the same evolution machinery as hidden-columns/schema evolution from the spike-5 contract — one compat framework, two surfaces (models, exported elements).

### Q: Where does per-user config live?
**Separate per-(app,user) rows with an app-declared schema.** The definition declares a `userConfig` schema (typed fields + defaults); values are stored outside the definition. Definition stays single-authored/versionable; user values survive edits and rollbacks.

**Insights:** The schema-in-definition / values-outside split mirrors the models/rows split the app system already uses — same mental model. Values should surface in the global UI ctx read-only-ish at something like `/apps/<id>/user/<field>` so elements can bind to them.

### Q: What does "automatically auditability fields" mean concretely?
**Auto row provenance.** System-managed `createdBy` / `updatedBy` (user or agent identity) + timestamps on every model row, populated from the acting identity on writes — no per-app declaration needed, rendered via ordinary columns. Per-user config therefore carries UI preferences (density, default page, visible columns, saved filters), not audit data.

**Insights:** Provenance belongs to the model layer (system columns like `id`/`createdAt`, which queries can already filter on), not to userConfig — the two features touch different layers and only meet in the UI.

## Synthesis

### Key Decisions
- **Iteration scope**: current spike − connections/sync (spike-3 layer reverted, redone in a later iteration) + spike-5 lifecycle implementation + the three TLDR items. This is the productionization base, not another throwaway.
- **Legacy `page` removed**: canonical `pages` + `defaultPage` only; the in-memory normalization shim is deleted; the 7 local dev apps get migrated by hand (or a one-off script) in the dev DB.
- **Reusable elements = app-as-library**: new top-level `elements` field on the app definition; usable across the app's own pages and referenceable from other apps. No separate component-registry entity.
- **Two element modes, declared per element**: *pure* (parameterized subtree; consumer supplies data/action bindings via props) and *bound* (element references its defining app's queries/actions — the key capability).
- **Split state planes in a global UI ctx**: data plane keyed by defining app (`/apps/A/queries/…`, shared cache + liveness across consumers); interaction plane keyed by instance in the consuming app (`/apps/B/pages/<p>/instances/<key>/ui/…`). Replaces the flat page-local `/ui/<id>/value` model (whose duplicate-id collision behavior was verified today).
- **Viewer identity + explicit export**: elements are private unless exported; bound elements execute A's queries/actions as the *viewing user*, who must have permission on app A — embedding never launders privileges. Exported elements are the app's public API surface.
- **Float + compat gate for cross-app refs**: refs track the defining app's latest version; spike-5 backward-compat rules extend to exported elements (breaking contract change ⇒ new element name / explicit break). One compat framework, two surfaces (models, exported elements).
- **Per-user config = schema in definition, values outside**: `userConfig` schema (typed fields + defaults) declared in the app; per-(app,user) values stored separately, surfaced read-only in the ctx (e.g. `/apps/<id>/user/<field>`). Survives app edits/rollbacks.
- **Auditability = auto row provenance**: system-managed `createdBy`/`updatedBy` + timestamps on model rows from the acting identity; userConfig carries UI prefs only.
- Deferred: **cross-app reference syntax** (e.g. `{ "$element": "<appId>/<name>" }` vs a `Ref` component type) — defaulting to a dedicated element-ref node resolved at render time; decide in the plan.
- Deferred: **element parameterization contract details** — defaulting to typed props declaration (same kind vocabulary as columns/params) + optional `children` slot for pure elements; decide in the plan.

### Open Questions
- ~~How is the json-render UI ctx implemented today?~~ **ANSWERED** — see "Ironed facts".
- ~~Where is the viewing user's identity available today?~~ **ANSWERED** — see "Ironed facts".
- ~~What exactly did the spike-5 frozen contract fix?~~ **ANSWERED** — see "Ironed facts" below.
- ~~How do row writes currently learn the acting identity, and do system columns support filtering?~~ **ANSWERED** — see "Ironed facts".
- ~~What does reverting the connections/sync layer touch?~~ **ANSWERED** — see "Ironed facts".

### Ironed facts (codebase/spec research, 2026-08-03)

**Spike-5 frozen contract** (spec `thoughts/taras/plans/2026-08-03-swarm-apps-spike5-lifecycle-spec.md`):
- `app_versions`: `UNIQUE(appId, version)`, head = MAX(version), snapshot `{name, description, definition}` captured as-stored; `snapshotApp()` runs before every definition-mutating write and is **fail-closed** (failed snapshot aborts the write — deliberate deviation from workflows/pages). Rollback = snapshot current, then **forward-migrate** the target snapshot through the normal §3 write engine (no inverse modeling); lossy restores 400 with the exact `migration` directives needed.
- Evolution rules: hide-don't-delete for columns (metadata-only, protobuf-style deprecation); hidden columns are validator-invisible (queries/pages/writes treat as nonexistent — agent co-migrates via issues[] loop); name reuse blocked while hidden; lossy ops (kind change, enum narrow with nonconforming rows, purge, required-no-default) need explicit `migration` directives (`set`/`from,map`/`coerce`/`purge`) else fail-loud with row counts. Source/joinKey rename forbidden outright.
- Separate `schemaVersion` **format-upgrade registry** (`src/apps/format-upgrades.ts`, lazy at read, tolerant `decodeApp` returning `definitionError` instead of throwing). **Upgrade #1 is already `page` → `pages.main`** — so TLDR item 1 (remove legacy `page`) = ship that upgrade + drop the write-path/zod acceptance of `page`; the shim removal Taras wants is literally the spec's first registered upgrade.
- Implications adopted for this brainstorm: exported-element compat slots into the same breaking/compatible classifier + issues[] loop (one framework, now three surfaces: columns, exported elements, userConfig schema); `elements` and `userConfig` must be covered by snapshots + atomic merge-patch subtrees (`elements.<name>`, `userConfig.<field>`) like `pages.<p>.elements.<id>` already is.

**UI ctx today** (`apps/ui/src/pages/apps/[id]/page.tsx` + `@json-render/core|react` v0.19.0):
- One plain `StateStore` (JSON-Pointer paths, `useSyncExternalStore`) **per mounted app** — `AppRuntime` is keyed by `app.id` only, so in-app page navs keep the store warm and app switches discard it. Not per-page, not global.
- Flat roots: `/route`, `/queries/<q>` (mirrored from react-query), `/actions/<a>` (incl. task polling), `/forms/<id>/<field>`, `/ui/<id>/{value,tab}`. Interactive components (SearchInput debounce, Select, Form, Tabs, Drawer) write these paths **directly via `useStateStore()`** — the library's `$bindState`/bindings channel is unused. `watch` is a per-element renderer capability.
- **Key implication**: stored definitions embed unprefixed paths (`/queries/x/data`). Going global should keep definition paths *app-relative* and mount them under `/apps/<id>/…` at runtime (store registry keyed by appId, or one store with per-app roots) — a bound element resolves its data plane against its *defining* app's mount and its interaction plane against its *instance* mount. That avoids a definition-breaking path rename (no format upgrade needed for existing apps) and is exactly what makes elements portable.

**Viewer identity today** (`src/http/auth.ts`, `src/http/apps.ts:302-326`, `src/http/pages.ts`):
- Bearer-only: swarm API key → `operator` principal (key fingerprint, **no per-human identity**); `aswt_…` token → `user` principal with real `userId` + `User` row; agents via `X-Agent-ID` → `agentId` (no userId; indirect via task `requestedByUserId`).
- The dashboard runs on the operator key by default — the Apps UI has no flow to mint/store an `aswt_` token. Pages' `authed` mode is page-scoped cookie trust, **no viewer identity** — not reusable for this.
- `app.manage` is granted `anyAuthenticated` with `resource: {kind:"none"}` (no per-app scoping); GET routes are entirely ungated. The principal is discarded after the `can()` check.
- **Implications**: (a) "viewer has permission on app A" needs a per-app RBAC resource (new resource kind + verb like `app.use`/`app.view`) — the verb vocabulary exists but resource scoping must be added; (b) per-user config and provenance should follow the **favorites precedent** (`src/http/favorite-owner.ts`): scope `user:<userId>` for user principals, one shared `operator` scope (with fingerprint as audit actor) for operator-key sessions — accepting that operator-key deployments get "per-deployment" rather than per-human config until user tokens are adopted in the dashboard.

**Row writes & provenance today** (`src/apps/row-store.ts`, `src/http/apps.ts`):
- Rows live in KV (`apps:<appId>` namespace, `<model>/row/<id>` keys + per-indexed-column idx entries); all writes funnel through `row-store.ts` under a per-(app,model) in-process mutation lock; callers are the HTTP row CRUD routes and the sync engine only (MCP tools only touch definitions).
- Identity **is** resolved at the HTTP layer for the RBAC check (`authorizeAppWrite` builds operator/user/agent principal) but **discarded** — never threaded into row-store. Auto `createdBy`/`updatedBy` = thread the principal one hop + add two system columns.
- System columns already exist and are query-filterable: `SYSTEM_COLUMN_KINDS` = id/createdAt/updatedAt/source/syncedAt/stale (`src/apps/definition.ts:128-135`); named-query filters accept them (spike-4 test-verified); sort whitelist is only createdAt/updatedAt/syncedAt; ad-hoc REST `filter.<col>` params do NOT fall back to system columns. Adding `createdBy`/`updatedBy` to `SYSTEM_COLUMN_KINDS` gets filtering nearly for free.

**Connections/sync revert scope** (spike-3 commits 76d1a13b, 9db67996, 0a8d0017, d10fda55):
- **Surgical removal, not `git revert`** — spike-4 built on top of the shared files (definition.ts got pages/router/$param in the same regions; SYSTEM_COLUMN_KINDS mixes spike-3 keys `source`/`syncedAt`/`stale` with spike-4 keys `id`/`createdAt`/`updatedAt`; skill prose is interleaved).
- Clean deletes: `src/apps/sync.ts`, `src/tools/app-sync.ts` (+`app-query.ts` re-export shim can stay), `src/be/seed-scripts/catalog/github-issues-pull.ts`, `scripts/dev/{app-sync-cron,pm-digest}.script.ts`, `src/tests/apps-spike3.test.ts`.
- Hand-edits: `src/apps/definition.ts` (sources schema, `ColumnDef.source`, `sync` action kind, sources atomic-patch entry, spike-3 system columns), `src/apps/row-store.ts` (`allowSourceManaged` branches; **keep** `skipUpdatedAt` — lifecycle migration writes use it), `src/http/apps.ts` (sync route, sync action branch, `syncedAt` sort allowlists), `templates/skills/apps/content.md` (prose surgery), plus `src/tests/apps-spike4.test.ts`'s `stale`-filter test. Regenerate `sdk-allowlist` types + `openapi.json`.
- **Keep `app-query`/`applyQuery`/named-query route** — the query engine is generic (not sync-gated; spike-4 test filters system columns on a source-less model).
- Live-DB consequence: stored definitions with `models.*.sources` (PM Inbox etc.) become invalid on removal → ship a format upgrade that strips `sources`/`source`-bindings (replacing the spec's planned upgrade #2, which is moot without connectors), relying on spike-5's tolerant `decodeApp` in the interim.

### Constraints Identified
- Lifecycle (app_versions, backward-compat, rollback) is in scope, so every new definition surface (`elements`, `userConfig`) must be born versionable (snapshots + atomic merge-patch subtrees + compat classification).
- Viewer-identity execution requires per-request user identity in the app runtime — bound elements are gated on auth plumbing, not just renderer work. **Today the dashboard runs on the operator key (no per-human identity)**: per-user features must use the favorites scope pattern (`user:<userId>` | shared `operator` scope) and degrade gracefully; "viewer has permission on app A" needs a new per-app RBAC resource kind (today `app.manage` is unscoped, GETs ungated).
- Definition `$state` paths must stay **app-relative**; the global ctx mounts them under `/apps/<id>/…` at runtime — avoids a breaking path rename across all stored apps and is what makes elements portable.
- Rollback must not revert per-user values (hence values outside the definition).
- Removing connections invalidates stored definitions that declare `sources` — needs a strip-sources format upgrade (replaces the spec's moot upgrade #2) + tolerant `decodeApp`.
- The 1–10 models validator currently forbids schema-less apps (hit today); pure-UI utility apps may warrant relaxing the lower bound to 0 — flag for the plan.

### Core Requirements
1. Remove legacy singular `page` (write + read paths, validator, normalization shim); hand-migrate local dev DB rows.
2. Surgically remove the connections & sync layer (sources schema, sync engine, app-sync tool, sync action kind, source-managed system columns) — keep the generic query engine (`app-query`/`applyQuery`) and `skipUpdatedAt`; ship a strip-sources format upgrade for stored defs. Preserved in git history for a later iteration.
3. Implement the spike-5 lifecycle contract (app_versions, compat gates, rollback).
4. `elements` field: definitions, pure/bound modes, export flags, cross-app refs (float + compat gate), validator coverage.
5. Global UI ctx: `/apps/<id>/…` namespacing, split data/interaction planes, per-instance state keys.
6. `userConfig` schema + per-(app,user) value storage + ctx exposure + settings UI surface.
7. Auto row provenance columns populated from acting identity.

## Next Steps

- **Execution (decided 2026-08-03):** one-shot the *shrink* first — surgical connections/sync removal + legacy `page` removal (format upgrade #1 + drop write-path acceptance) + auto `createdBy`/`updatedBy` provenance columns — on `spike/swarm-apps` in the `2026-08-03-swarm-apps` worktree. Then `/create-plan` for the heavy rest (lifecycle implementation, `elements` + global ctx, `userConfig`).
- **Branch strategy (decided):** stay on the spike branch for this iteration; port to a fresh branch off main (renumbered migrations, clean PR series) once validated.
