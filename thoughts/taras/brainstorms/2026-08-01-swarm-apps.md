---
date: 2026-08-01T00:00:00+02:00
author: taras
topic: "Swarm Apps — internal apps built on swarm primitives"
tags: [brainstorm, apps, kv, scripts, connections, workflows, ui]
status: parked
exploration_type: idea
last_updated: 2026-08-01
last_updated_by: taras
---

# Swarm Apps — Brainstorm

## Context

New bet feature: **"apps"** — letting swarm users build literal internal company apps (backoffice-style) on top of existing swarm primitives (kv, scripts, connections, workflows, schedules, hooks, auth, UI).

**Initial data-model sketch (Taras):**

- App: `id`, `name`, `description`
- **Data models** — kv-backed schemas
  - columns: name + **kind** ("traits" — a simplified type system, since kv is untyped; also relevant for sync)
  - relations between models
  - automated CRUD scripts + hooks generated per model
- **Actions**
  - queries (read-only, cacheable) — script
  - mutations — script
  - synchronization (between models, or with external sources) — script
- **Connections** (?)
- **Workflows** (related to the app / its schemas)
- **Schedules**
- **Hooks** (for actions, the RUD, etc.)
- **Auth** (not highest prio) — control who has access from swarm users; reuse existing primitives:
  - OAuth (we have the primitive + refresh)
  - tokens (swarm secrets)
  - permissions (script, or reuse RBAC, or something specific)
- **UI**
  - optional: user management (login/register), settings (app "configurations")
  - app tree: **pages** (not the swarm "pages" feature) — hard tree structure
  - each page: layout, components (similar to the JSON render impl), state, actions (from above)
  - reactive by default, clean, "real-time"

**Apps ≠ pages:** swarm pages are more like lightweight documents; apps are actual internal company apps users build to solve a problem — "build your backoffice."

**Motivating example:** a customer wanted a project-management-like tool. Technically implementable today with primitives rather than as a new primitive:
- SOT = Linear + swarm tasks + GitHub
- Define a custom "Issue" schema joining columns from multiple sources
- Build a view specific to YOUR needs (e.g., inbox), click "tackle" → triggers an agent task on the issue
- Potentially run on autopilot via a workflow on a nightly schedule

## Exploration

### Q: Who is the primary *builder* of an app?
Both, agent-first — "as the other things in the swarm." Agents scaffold the app end-to-end (schemas, scripts, pages) from a conversational/task description; a human-facing editor exists for tweaks and maintenance, but conversational authoring is the happy path.

**Insights:** This mirrors the existing swarm pattern (workflows, scripts, skills: agents author via MCP tools, humans edit in the UI). It means the app definition must be fully expressible through MCP tools / API — the UI editor is a second client over the same surface, not the source of truth. It also means validation and typecheck feedback loops (like `script_upsert`'s tsc gate) matter more than drag-and-drop polish: the agent needs machine-readable errors to iterate against.

### Q: Where does app data live — owned in kv vs synced from external SOT?
**Column-level choice** — "imagine like a data transformation in a data warehouse." A single model mixes provenances per column: e.g. the `Issue` model has `title` sourced from Linear, `pr_status` from GitHub, `agent_task` from swarm tasks, and `triage_state` owned locally in kv.

**Insights:** This reframes data models as *warehouse-style transformed views with local extensions*, not plain tables. Consequences:
- A column's **kind/trait** must carry provenance (source connection + field mapping + transform), not just a type. Traits = type + binding.
- The **row identity / join key** becomes a first-class concern: to merge Linear + GitHub + local columns into one row, each synced column binding needs a key mapping (e.g. Linear issue ID ↔ PR link ↔ local record ID). This is the classic entity-resolution problem — likely needs an explicit per-model `key` declaration and per-source join expressions.
- Sync granularity, freshness, and failure are per-column (or per-source-group), which suggests sync scripts operate per (model × source) pair rather than per model.
- dbt-like mental model may be a good UX anchor: sources → staging → model, with owned columns as the "app-local" layer on top.

### Q: What happens on write to a synced column?
Agent-mediated writes (option 1). Synced columns are **read-only projections**. Changing external state happens through **mutation actions** — "tackle" is essentially a mutation. No direct field write-back, no silent two-way sync.

**Insights:** This is the single biggest simplification available: it eliminates conflict resolution, write-back queues, and bidirectional consistency — the graveyard of sync engines. The model becomes: **sync = one-way inbound (source → kv projection); mutations = explicit scripts** that may call connections (e.g. Linear API via the connections primitive) or spawn agent tasks, after which the next sync pass reflects the result. Eventual consistency with a clear causality story. It also means mutations are auditable, nameable operations ("tackle", "close-issue") rather than anonymous field edits — which fits agents both authoring and *invoking* them.

### Q: Who are the end users of a built app?
Multi-select: **Swarm users only (v1)** + **internal + invited guests** + **agents as users too**. Not public-facing/own-user-base (login/register stays optional/later).

**Insights:** v1 apps live inside the dashboard behind existing swarm auth; a share path for named outsiders (magic link / token — swarm secrets primitive fits) comes next; and crucially **agents are first-class end users**: queries/mutations/actions must be invokable via MCP tools, not just from the UI. That last point is the differentiator vs Retool — the same app surface serves humans (UI) and agents (MCP), so an agent can operate the backoffice app it built (e.g. the nightly autopilot workflow calling the app's own queries/mutations).

### Q: How does the app runtime serve "reactive, real-time" queries when the script runtime is a cold sandboxed subprocess?
v1 = **scripts as-is, polling UI** (accept subprocess latency, no push invalidation yet). But: "if a model is queryable directly, it could be a direct query — it would be nice that this is done by default." I.e. **default reads are server-native**: when a query is just a direct read over a model (get by id, list, filter, sort), the API server serves it natively without spawning a script. Custom-logic queries fall back to the script runtime.

**Insights:** This is a two-tier read path: (1) auto-generated direct model queries — native, fast, and the default; (2) escape-hatch TS query scripts — sandboxed, slower, for joins/derivations the direct path can't express. Real-time push is deferred, but the Convex lesson below says reactivity later becomes cheap *only* for reads the server can dependency-track — i.e. the direct-query tier. Keeping most reads in tier 1 keeps the future reactive upgrade path open; anything that drops to a script is opaque to invalidation and will likely stay poll-based.

## Reference: How Convex structures the same primitives

(Researched 2026-08-01; full sources in the research agent report. Convex is the closest existing system to this sketch — "queries/mutations/actions + schedules + reactive by default" is literally their model.)

- **Schema**: `defineTable({...})` with `v.*` validators (`v.string()`, `v.id("otherTable")` for relations, `v.optional()`, unions, literals). Indexes declared per table (compound, search, vector). Schema validation enforced at write time (toggleable). Relations are typed ID references — no FK enforcement.
- **Function taxonomy** (hard contracts):
  - `query` — read-only, **deterministic**, no fetch/external calls → cacheable + subscribable.
  - `mutation` — transactional, serializable (OCC), deterministic, no network.
  - `action` — the escape hatch: non-deterministic, may call external APIs; touches the DB only via `ctx.runQuery`/`ctx.runMutation` (each its own transaction — no cross-call consistency).
  - **Public vs internal** (`internalQuery` etc.): visibility is a first-class function type — the generated client API surface is exactly the public set.
- **Reactivity**: each query execution records the index/document ranges it read (query journal); on mutation commit the server re-runs only overlapping subscribed queries and pushes over one websocket. Works *because* queries are deterministic read-only — reactivity is a derived property of the read/write contract, not a pub-sub system.
- **Scheduling**: `ctx.scheduler.runAfter/runAt` inside a mutation commits **atomically with the transaction** (no "wrote row, forgot to enqueue" bugs); crons in a separate registry; best practice schedules internal functions only.
- **HTTP/storage/auth**: HTTP endpoints are just actions with raw Request/Response; files are first-class storage IDs referenced from documents; auth = verified identity in ctx, row-level security is application-code convention, not a policy engine.
- **Components**: installable bundles of tables + functions in an isolated namespace, instantiable multiple times (agent memory, rate limiter, RAG). Their plugin mechanism — trades global schema simplicity for composability.
- **AI positioning**: they market "the backend your AI agents can't break" — pure-TS functions + hard contracts are easy for coding agents to generate correctly; ships agents.md guidance and an Agent component.

**Design lessons to steal:**
1. Determinism is the load-bearing boundary — it's what makes caching, reactive invalidation, and transactional scheduling provable. Our queries-vs-mutations-vs-sync split should adopt the same contract semantics, not just the names.
2. Public/internal visibility as a first-class property of actions (what agents/UI can call vs. app-internal orchestration).
3. Atomic co-scheduling of follow-up work with mutations.
4. Reactivity derived from the read contract — reinforces the two-tier read path decision above.
5. Components-style isolation is the shape an "app" itself could take inside the swarm: an app = namespaced bundle of models + actions + workflows.

## Reference: the `kv-typed-store-pattern` experiment (2026-07-31)

Taras ran an experiment with the swarm that produced a v4 skill for building typed CRUD collections on raw KV (`orders-crud-demo` script). It is effectively a **hand-rolled prototype of the apps data-model layer**, and its measurements ground several decisions:

- **Read/write split confirmed empirically:** native REST KV reads p50 **3.9 ms warm** vs script-runtime writes p50 **250–310 ms** (~297 ms is script startup, not KV). Exactly the two-tier read path chosen above — direct reads native, writes through one owning script.
- **What the swarm had to do manually** (= what apps should automate): explicit key layouts (`order/<id>`, `idx/name/<slug>/<id>`), zero-padded sortable index segments, hand-maintained secondary index rows rewritten on every create/update/delete, existence checks via `kv_getOrNull`, search routed per query type (prefix walk vs `db_query` JSON1 substring scan vs padded range scan).
- **KV constraints the skill documents as hard limits:**
  - **No CAS / no cross-key transactions** — concurrent read-modify-write loses updates; only `kv_incr` is atomic. Multi-writer document updates are unsafe.
  - **No per-namespace write ACL** — any authenticated caller writes any namespace; skill explicitly bans customer/tenant/sensitive data.
  - Manual indexes go stale on any missed rewrite; bulk-write fan-out caps (~≤36 chunks); expired rows never reclaimed; practical ceiling ~10^4 docs, "use a real table" beyond ~50k rows or when you need CAS/ACL/managed indexes.

**Insights:** The experiment proves the concept is buildable on today's primitives *and* enumerates precisely why it shouldn't stay hand-rolled: every listed constraint (manual index consistency, no atomicity, no ACL, per-query search routing) is a correctness bug an agent will eventually write. The apps feature is largely "productize this skill into the platform": declared traits → generated typed write path; declared indexes → server-maintained; direct queries → the native fast path the skill already routes reads through. It also sharpens the substrate question: the skill's own escape clause ("use a real table and migration instead when…") reads like the requirements list for app models.

### Q: Is KV actually the storage substrate, given the experiment's escape clause (CAS/ACL/managed indexes/>50k → real table)?
**Yes, KV.** "The goal is internal apps, and 50k seems like perfect. For ACLs and stuff it's not really that prio, even for v1."

**Insights:** Deliberate scope call: internal-tool scale means the KV ceiling is a feature, not a bug — it keeps the substrate to what already exists. The remaining sharp edge is **index consistency + concurrent writes** (no CAS): acceptable if the platform (generated CRUD scripts or server) is the *single* writer per model and index rewrites are generated rather than hand-written — the failure mode in the experiment was agents hand-rolling that machinery, not KV itself. Left open: whether index maintenance lives in generated scripts vs natively in the API server (the direct-query fast path suggests the server will at least need to *understand* index layouts).

### Q: What is the v1 UI model — component catalog vs generated code?
**Component catalog (JSON), rendered by the dashboard.** With two requirements: (1) **layout & organization primitives must be first-class and responsive** — "this will help other fronts in general" (i.e. the layout system is reusable beyond apps); (2) consider **reusing an existing lib** — research requested on the basic primitives such a system needs.

**Insights:** The catalog choice preserves the agent-first authoring loop (JSON is validatable — the agent gets machine-readable errors, like the script typecheck gate) and human editability (a visual editor can round-trip JSON; it can't round-trip generated React). The "helps other fronts" comment suggests the layout/component system should live as its own package, not buried inside the apps feature. Research spawned on: server-driven-UI / JSON-UI schema systems and the minimal primitive inventory (layout containers, data-bound components, state/binding model, action wiring, responsiveness).

### Q: How do synced columns refresh, and what freshness is acceptable?
Multi-select: **Scheduled pull (v1)** + **on-demand refresh**. Sync scripts per (model × source) run on the existing schedules primitive (minutes-level freshness), plus a user/page-triggered refresh path for when someone is actively working in the app. No webhooks, no post-mutation targeted re-sync in v1.

**Insights:** Both mechanisms are the same sync script invoked two ways — schedule and on-demand — so there's one code path. On-demand refresh from a page implies the UI can trigger a sync action and observe its completion (a "refreshing…" state), which the action-wiring layer should support from day one. A mutation like "tackle" followed by an on-demand refresh also covers most of what post-mutation re-sync would have given.

## Reference: existing `json-render` pages implementation (codebase scan)

The dashboard already ships a catalog-driven JSON renderer for pages (`apps/ui/src/pages/pages/[id]/json-page-renderer.tsx`), built on **`@json-render/core` + `@json-render/react` v0.19.0**:

- **Catalog today** (`swarmCatalog`, zod-validated props): `Container` (flex row/col + gap), `Card`, `Heading`, `Text`, `Button`, `Metric`, `Alert`. 
- **Action binding today**: `swarm.sdk` (invoke SwarmSDK methods in-SPA) and `swarm.call` (raw HTTP to `/api/*`), both using the viewer's bearer; wired via `on.press`.
- **Unused capacity**: `StateProvider` / `ActionProvider` / `VisibilityProvider` from `@json-render/react` exist but aren't surfaced; `needsCredentials` declared but ignored.
- Page schema: `src/types.ts` (`PageContentTypeSchema`), tool: `src/tools/create-page.ts`.

So the apps UI layer is an **extension of an existing stack**, not a green-field adoption: grow the catalog (table, list/inbox, form, detail, filter, tabs, modal, grid), surface state/visibility providers, and add data-binding to app queries.

## Reference: JSON-UI systems research (external survey, 2026-08-01)

- **Reuse candidates**: Puck (MIT, flat tree + zones, best editor+renderer pair), Craft.js (MIT, lower-level editor toolkit), JSON Forms / RJSF (forms from JSON Schema — the form primitive), Shopify Remote DOM (sandboxed component-tree pattern), DivKit (ships a JSON Schema of its own DSL — strongest validation story).
- **Study-only**: Appsmith/ToolJet/Budibase/Windmill (monolith-coupled DSLs), Grafana dashboard-spec (best example of *versioning* a UI schema), Beagle (slowed), Plasmic (AGPL editor), Mitosis (compiler, not runtime).
- **Converged primitive inventory** (internal-tools set): layout = stack/row/col, grid, split, tabs, card, modal/drawer, collapsible + spacing *tokens* (enums, not raw px); components = data-grid/table, list/inbox, detail view, form+fields, button, select/filter bar, stat, chart, markdown/text, badge; responsiveness = breakpoint-keyed prop overrides (`{base, sm, md}`) — container queries essentially absent from the space.
- **Bindings**: dominant pattern is `{{query.data.x}}` template strings with a JS-sandbox escape hatch; the survey's clear advice for LLM authoring is **restricted template/pointer bindings validatable against the data schema**, NOT a JS-eval sandbox (JSON-valid but runtime-broken code, no static check).
- **State/actions**: page state + component state + URL params; all mutation through **typed action chains as JSON arrays** (`[{type:"runQuery"...},{type:"openModal"...}]`) — never imperative code.
- **LLM-authoring design lessons**: (1) flat normalized trees beat deep nesting (edits = array splices); (2) separate data-schema from UI-schema (two small validatable schemas); (3) closed enumerable component/prop unions make self-validation + crisp retry feedback possible — exactly the property our zod catalog already has.

### Q: What *is* an app in the database — namespaced bundle vs references to shared primitives?
"App can be a table — it would be like the **ultimate meta primitive** which should contain all info defining it."

**Insights:** An `apps` table where the row *is* the app: a single definition containing (or anchoring) models, actions, pages, schedules, hook wiring — the composition layer over every other primitive. This echoes both the workflow pattern (a DAG definition in a row) and the Convex Components lesson (self-contained bundle). Open sub-question for research/plan: which parts are **embedded** in the definition (models, page tree, traits — likely yes) vs **referenced** (connections almost certainly referenced — they hold credentials and are infrastructure; scripts probably app-scoped rows referenced by ID so they stay individually versionable/typecheckable; schedules referenced). "Contains all info defining it" also implies export/import and versioning of the whole app definition should be cheap — one row → one JSON document → one diffable artifact.

### Q: What proves the bet — the v1 finish line?
**Two proof apps:** (1) the customer's **PM app** — Issue model over Linear + GitHub + swarm tasks, inbox view, "tackle" mutation spawning an agent task, nightly autopilot workflow; and (2) a **simple pure-KV app, e.g. an ideas tracker** — owned data only, no sync.

**Insights:** The two apps bracket the design space: the ideas tracker validates the core loop (agent scaffolds models → generated CRUD → direct queries → catalog UI) with zero sync machinery — it's the natural *first milestone* and would already exercise most of the platform; the PM app then adds exactly the hard parts (column-level source bindings, join keys, sync schedules, agent-mediated mutations, autopilot). If the ideas tracker feels heavier to build on-platform than the kv-typed-store skill made it by hand, that's an early failure signal worth watching.

### Q (ironing): Traits v1 — minimal kind set and richness?
**Scalar set + bindings.** Kinds: `string`, `number`, `boolean`, `date`, `enum`, `relation(model)`. Source-bound columns carry `{connection, entity, field, transform?}`; the **join key is declared once per (model × source)**, not per column; transforms limited to a **named allowlist** (slug, lower, cents, date-parse — extensible), not arbitrary expressions.

**Insights:** Per-source join keys keep entity resolution in one declared place; the transform allowlist keeps trait definitions statically validatable (same philosophy as the UI bindings — no eval). Semantic kinds (user/status/url) deferred — an enum + UI component mapping covers most of what they'd buy in v1.

### Q (ironing): Who owns writes + index maintenance — generated scripts or the server?
**Server-native CRUD.** The API server implements model CRUD + index rewrites natively (app-model endpoints); writes serialize per model in-process, dissolving the no-CAS problem. Scripts exist only for *custom* mutations and call these endpoints — single-writer preserved on every path.

**Insights:** This makes the generated-CRUD-scripts idea from the original sketch obsolete: CRUD isn't generated code, it's platform behavior driven by the model declaration (less to generate, nothing to regenerate on schema change). The kv-typed-store skill becomes purely a historical artifact for apps. A typed script-SDK wrapper (`ctx.app.models.issue.update(...)`) can layer over the endpoints later without changing the ownership story. Sync scripts should also write through these endpoints (or a bulk variant — the experiment's fan-out caps argue for a native bulk upsert).

### Q (ironing): App definition — embed vs reference?
**All referenced.** The app row is a thin manifest of IDs: models are their own table, pages/actions/schedules/connections all referenced. Everything is a first-class row; the app is the composition point.

**Insights:** This refines the "ultimate meta primitive" answer: *contains all info defining it* means **anchors the full graph**, not "one giant JSON blob." Wins: models as rows give the server-native CRUD a natural place to hang (and independent versioning); scripts keep their existing typecheck/versioning flow; parts are individually editable without definition-document merge conflicts (matters when agents iterate concurrently). Cost: export/import and "delete the app as a unit" need a bundler that walks the reference graph — and the build-time "iterate on this app" task now edits multiple rows, so app-level versioning (a coherent snapshot across parts) becomes its own question rather than falling out of one document. Cascade/orphan semantics (delete app → what happens to referenced-but-shared resources?) need defining: app-tagged ownership (`appId` on the row) vs pure reference likely decides it.

### Q (ironing): Hooks — what fires them, what runs?
**After-write, async.** Hooks fire after successful model writes (create/update/delete, including sync-originated deltas) and after named actions. Handler = a script **or an agent task**, run async with retries. No before/veto hooks in v1 — validation belongs to traits.

**Insights:** Sync-originated deltas firing the same after-write hooks is what makes autopilot compositional: "new Issue row appeared from Linear → hook spawns triage task" needs no special sync-hook machinery. Worth keeping the door open to implementing hook *delivery* on the workflow-trigger/eventing surface internally (option 4's shape) so there's one event system — but the contract exposed to app authors is simply "after-write hook."

### Q (ironing): Where do apps render?
**Dashboard only (v1)** — apps mount at `/apps/:id` inside the dashboard SPA behind swarm auth. Standalone/guest URLs deferred until the invited-guest story matters (pages' hosting + auth-mode machinery is the obvious reuse when it does).

### Q (ironing): App-level versioning?
**App snapshots.** An `app_versions` table stores the resolved bundle (walk the reference graph → one JSON) on meaningful change or on demand. Rollback, diffing agent iterations, and export/import fall out of the same mechanism. Per-part versioning (script_versions et al.) continues underneath.

### Reference: `@json-render` capability check (vercel-labs/json-render, Apache-2.0)

Background research on the lib our pages renderer uses (v0.19.0 is current, active — Vercel Labs, ~200 releases since Jan 2026 launch; no 1.x):

- **Bindings**: JSON Pointer state refs (`{"$state": "/user/name"}`), two-way `$bindState`, `$template` strings with `${/path}` + `$item`, computed expressions with pointer args, composable directives (`$format`/`$math`/`$cond`). Exactly the "restricted pointer bindings, no JS eval" model the survey recommended for LLM authoring.
- **State**: page-level singleton store (StateProvider), actions map (ActionProvider: setState/push/remove/validateForm + custom), VisibilityProvider conditions (eq/gt/AND/OR). No component-local state.
- **Native in spec**: list rendering (`repeat` over a state path with `$item`) and conditionals — the two things internal-tool UIs need most.
- **Not provided (host builds it)**: data/query layer (fetch, loading/error states — external injection only, `watch` fires on state change not mount), responsive breakpoint variants (catalog components must accept responsive props), action *chains*, multi-page routing, and the internal-tools catalog itself (data-grid, forms, filter bar).
- **Verdict**: no capability wall — the registry is fully extensible. The real work is the data/query layer + catalog, which we own anyway. No fork or replacement needed.

**Resolved by design:** the reactive-upgrade split (direct queries dependency-trackable, script queries poll-only) is accepted — v1 polls everywhere, and json-render's external-state-injection model means push invalidation later is a host-layer change (swap poll for push into StateProvider) with no spec change.

### Q: What is explicitly out of scope?
Multi-select: **not a code-gen app builder** (JSON catalog is the ceiling; no free-form React/HTML emission — custom components wait until the catalog demonstrably fails), **not two-way sync** (agent-mediated writes stay the line even when users ask to "just edit the Linear field inline"), **not a public app platform** (no external user bases, custom domains, or app store).

**Insights:** Notably *not* excluded: BI/analytics-lite — the stat/chart catalog components leave room for dashboard-ish apps, which is fine as long as it stays "catalog components over app models," not a query explorer. The three chosen non-goals each guard a decision made earlier: catalog-only guards the agent-authorable/validatable UI loop; no-two-way-sync guards the sync simplification; internal-only guards the KV/auth scope calls.

### Addendum (Taras, mid-session): tasks linked to apps — apps as agentic surfaces
"We should be able to link tasks to it too — e.g. if we have a UI, we could start a task to iterate on it, or add agenticity to it."

**Insights:** Two distinct capabilities hiding here, both reusing the tasks primitive:
1. **Build-time loop:** from an app (or its editor), spawn a swarm task scoped to *iterating on the app itself* ("make the inbox group by assignee") — the agent edits the app definition, the human sees the diff. The app definition being one JSON document (meta-primitive decision) is what makes this tractable: the task's deliverable is a definition change, validatable before apply. Mirrors how workflows/scripts are already agent-iterable.
2. **Run-time agenticity:** any app action can be backed by an agent task instead of a script — "tackle" generalized into a first-class action kind (`task` alongside `query`/`mutation`/`sync`), with task status observable from the app UI (the task-linkage makes the app a *surface* for agent work, not just a CRUD frontend).
This is the differentiator vs Retool restated concretely: the platform that builds the app is also the workforce inside it.

## Synthesis

### Key Decisions
- **Agent-first authoring, human-editable:** agents scaffold apps end-to-end via MCP/API; a UI editor is a second client over the same definition. The whole app must be expressible as validated data (machine-readable errors for the agent loop).
- **App = the ultimate meta primitive:** an `apps` table row anchoring one definition document that composes models, actions, pages, schedules, hooks; exportable/versionable/diffable as a unit. Composition layer over existing primitives, not a parallel stack.
- **Data models = warehouse-style views with local extensions:** column-level provenance — each column is either owned (KV) or a one-way projection from a source (Linear/GitHub/swarm tasks) with a transform; traits carry type + binding.
- **Synced columns are read-only; writes are agent-mediated:** no write-back, no two-way sync, no conflict resolution. External state changes only via named mutation actions (scripts calling connections, or agent tasks). Eventual consistency via next sync pass.
- **KV is the substrate:** internal-app scale (≤~50k rows) is the target; ACLs deprioritized even for v1. Platform-generated machinery (not hand-rolled agent code) owns key layout + index consistency; single-writer-per-model discipline mitigates no-CAS.
- **Two-tier read path:** direct model queries (get/list/filter/sort) served natively by the API server *by default*; custom TS query scripts as the escape hatch. v1 UI polls; real-time push deferred (Convex lesson: only the direct-query tier can ever be dependency-tracked for reactivity — keep most reads there).
- **Sync = scheduled pull + on-demand refresh** (same sync script, two triggers). Minutes-level freshness is fine. Webhook fast-path later.
- **UI = JSON component catalog** rendered by the dashboard, extending the existing `@json-render` pages stack (grow the catalog: table, list/inbox, form, detail, filter, tabs, modal, grid; surface state/visibility providers). Layout/organization primitives must be first-class, responsive (breakpoint-keyed overrides), and reusable beyond apps.
- **Bindings: restricted template/pointer expressions** validatable against the model schema — no JS-eval sandbox. Actions as typed JSON action chains.
- **Tasks are linked to apps** both at build time (spawn a task to iterate on the app definition) and run time (actions can be agent tasks with observable status — "tackle" as a first-class action kind).
- **Audience:** swarm users (v1) + invited guests (later, magic link/token) + **agents as first-class end users** (queries/mutations/actions invokable via MCP).
- **v1 proof = two apps:** a pure-KV ideas tracker (core loop, first milestone) + the customer PM app (sync, joins, agent mutations, nightly autopilot).
- **Non-goals:** no code-gen apps, no two-way sync, no public app platform.

**Ironed in follow-up Q&A (2026-08-01):**
- **Traits v1 = scalar set + bindings:** string/number/boolean/date/enum/relation(model); source-bound columns carry `{connection, entity, field, transform?}` with transforms from a named allowlist; join key declared once per (model × source). Semantic kinds deferred.
- **Server-native CRUD:** the API server owns model writes + index maintenance (no generated CRUD scripts); per-model in-process write serialization dissolves the no-CAS problem. Custom mutation/sync scripts write through the app-model endpoints (bulk upsert variant for sync).
- **App definition = all referenced:** thin manifest of IDs; models/pages/actions/schedules/connections are first-class rows, the app is the composition anchor. Ownership tagging (`appId`) + cascade semantics to be specced.
- **Hooks = after-write, async:** fire after successful model writes (including sync deltas) and named actions; handler is a script or agent task, async with retries. No before/veto hooks; validation lives in traits.
- **Rendering = dashboard only (v1)** at `/apps/:id`; standalone/guest URLs deferred (pages machinery is the later reuse).
- **Versioning = app snapshots:** `app_versions` stores the resolved reference-graph bundle on meaningful change/on demand → rollback, iteration diffing, export/import from one mechanism.
- **`@json-render` confirmed viable** (Vercel Labs, active, no capability wall): pointer bindings/repeat/conditionals native; we build the data/query layer, responsive catalog, action chains, routing. Reactive-later = swap poll for push into StateProvider, no spec change.

### Open Questions
- **Join-key/entity-resolution spec:** the per-(model × source) key declaration and mismatch handling (unmatched rows, duplicates) needs concrete design in research/plan.
- **Cascade/orphan semantics:** delete-app behavior for app-owned vs shared referenced resources.
- **Action chains + query layer on json-render:** exact shape of the host-built data layer (query registry, loading/error state paths, chain executor) — design work, not a decision blocker.
- **Guest sharing mechanics** (magic link/token via secrets) — deferred with the standalone-URL question.

### Constraints Identified
- KV: no CAS, no cross-key transactions, no per-namespace ACL, ~10^4–5×10^4 row practical ceiling, expired rows unreclaimed, bulk-write fan-out caps (kv-typed-store experiment, measured).
- Script runtime: ~250–310 ms per invocation (startup-dominated) — fine for writes/sync, wrong for interactive reads; native REST KV reads are 3.9 ms warm (measured).
- Existing json-render catalog is minimal (7 components, 2 action types, state providers unsurfaced) — the UI layer is real work even with the stack in place.
- Sync sources limited to existing connections/integrations surface (Linear, GitHub, swarm tasks first).
- Internal-tools trust model: app builders/users are inside the swarm trust boundary (no ACL v1); guest sharing must not leak swarm API keys to browsers (kv skill's warning stands).

### Core Requirements
1. `apps` meta-primitive: CRUD + definition document (models, actions, pages, schedules, hook wiring), MCP tools + API + UI editor over the same surface, export/version-able.
2. Models with traits: typed columns, owned or source-bound (column-level provenance with join-key declaration); auto-generated CRUD (create/update/delete mutations + direct queries) with platform-owned key/index machinery on KV.
3. Actions: `query` (direct/native by default, script escape hatch), `mutation` (script), `sync` (script; scheduled + on-demand), `task` (spawn agent task, observable status) — all invokable from UI *and* MCP; public/internal visibility flag (Convex lesson).
4. UI: page tree + JSON component catalog on the existing json-render stack; responsive layout primitives; template-pointer bindings to model queries; typed action chains; polling refresh v1.
5. Task linkage: build-time "iterate on this app" tasks + run-time task-backed actions.
6. Proof: ideas-tracker app (pure KV) then PM app (Linear+GitHub+tasks join, inbox, tackle, nightly autopilot workflow).

## Next Steps

- **Parked** (2026-08-01) after full exploration + open-question ironing. When picked up: run `/desplega:research` with this document as input to verify the reuse surfaces (kv REST, schedules, connections, json-render pages stack, workflow triggers) against the decided design, then `/desplega:create-plan` — ideas-tracker app as the first milestone, PM app second.
