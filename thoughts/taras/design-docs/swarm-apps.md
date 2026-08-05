---
system: swarm-apps
status: living
created: 2026-08-05
last_amended: 2026-08-05
owners: taras
---

# Swarm Apps — Design

> **State (2026-08-05):** all 8 productionization phases (versioned lifecycle, schema-change engine, reusable elements, embeddable UI, viewer RBAC, per-user config) implemented, QA'd, and ported to main as **PR #1066** — ready for review, CI green, awaiting merge (merge auto-deploys prod). Origin: spike on `spike/swarm-apps` (never merged) → brainstorm `thoughts/taras/brainstorms/2026-08-01-swarm-apps.md` → plan `thoughts/taras/plans/2026-08-04-swarm-apps-productionization.md` (per-phase evidence in its Appendix). Open items are in Boundaries below and the PR's Deferred list.

## Purpose

Swarm Apps lets agents build and iterate on schema-backed internal mini-apps as a first-class swarm primitive: an agent authors a complete app — data models, queries, actions, pages, reusable elements, a per-user config schema — as one versioned definition through MCP tools, and operators use the result live in the dashboard. It exists so recurring team workflows (inboxes, trackers, small dashboards) can be built, evolved, and repaired by agents without a deploy cycle, while the platform guarantees the data survives every schema change.

## Glossary

| Term | Meaning | Avoid |
|------|---------|-------|
| App | An agent-authored internal mini-app: models, queries, actions, pages, exported elements, and a user-config schema, used from the dashboard | "dashboard", "page" |
| Definition | The single versioned JSON document that fully describes an app; every change to it produces a new version | "manifest", "config" |
| Model | A named record type declared in the definition; its rows are the app's runtime data | "table", "collection" |
| Query | A named read over a model's rows, declared in the definition | — |
| Action | A named operation an app exposes: a script run or an observable agent task | — |
| Page | A renderable view tree of an app; the only place user-config fields may be data-bound | "screen" |
| Element | A reusable UI unit an app exports for other apps: pure (props-only) or bound (backed by the defining app's queries/actions) | "component" (reserved for render-catalog primitives) |
| ElementRef | A consumer app's reference to another app's element; which element and which app are fixed literals | "import", "embed" |
| Mirror | The consumer-local alias through which a consumed element's queries/actions are reached | "proxy" |
| Assembler | The client-side resolver that expands ElementRefs into a concrete render tree, isolating state per instance | — |
| Snapshot / version | The immutable pre-write copy of a definition kept on every change; the unit of history, diff, and rollback | "backup" |
| App-schema migration | A directive-driven change to models, their existing rows, and the definition, applied as one unit | bare "migration" (collides with SQL DB migrations) |
| Compat gate | The migrate-time check that rejects element changes that would break consumer apps | — |
| userConfig | Per-user values for an app, captured against a schema declared in the definition | "state", "settings" |
| app.use | Permission to use an app: read its data, invoke its actions (definition lifecycle is a separate concern) | — |

## Invariants

- **I1.** Every definition write is preceded by a fail-closed snapshot: if the snapshot cannot be taken, the write does not happen. No write surface may bypass this.
- **I2.** Version history is append-only; rollback is a forward restore (a new version created from a snapshot), never a destructive reset or history rewrite.
- **I3.** All definition read-modify-writes are serialized through the per-app definition lock. An app-schema migration acquires model locks in sorted order, dry-runs every directive against cloned rows, raises all issues before any write, and lands row writes + index rebuild + definition write in a single transaction — no partially-migrated app is ever observable.
- **I4.** Schema changes never silently destroy data: dropping a column hides it; actual data removal requires an explicit purge directive.
- **I5.** An invalid or stale definition degrades, never crashes: list/get surface a `definitionError`; stale-definition writes are rejected with a repairable conflict (409).
- **I6.** Cross-app reach is static and mediated: ElementRef target props are literal-only, consumed queries/actions go only through consumer-local mirrors, and the `$app` action param is assembler-owned (caller-supplied values rejected).
- **I7.** Definition validation is budget-bounded (memoized ElementRef expansion, issue budgets, 150-node cap) — no definition shape may drive validation super-linear.
- **I8.** A migrate that breaks a consumer's element contract (removed export, changed props) is rejected by the compat gate, not applied. Known gaps (enum narrowing, optional→required, slot removal) are tracked follow-ups, not accepted behavior.
- **I9.** `/user/<field>` bindings are pages-only; elements receive user config exclusively via props.
- **I10.** userConfig values are per-user-scoped and capped (16 KB stored, 64 KB preflight); userConfig schema changes must be always-compatible — no change may invalidate existing stored values.
- **I11.** Every app runtime surface enforces `app.use` through the central RBAC check with a 403-before-404 posture, and principal scoping never conflates an agent acting with the swarm key with the operator.

## Boundaries & Non-goals

- Dashboard-only: no public/guest URLs, no custom domains, no external user bases, no app store.
- **Rejected:** free-form generated React/HTML — the json-render catalog is the deliberate ceiling (inspectable, diffable, safely embeddable; expressiveness grows by growing the catalog).
- **Rejected (from v1 scope):** external connections / synced columns / source-bound traits — cut from productionization for credential + infrastructure weight; agent-mediated writes remain the line (no two-way sync engine).
- No hooks in v1: no before/veto interception anywhere; the brainstorm's after-write async hooks did not ship.
- Runtime rows live in the existing KV store by design; a real-table escape hatch (needed around ~50k rows, or when CAS/ACLs/managed indexes matter) is anticipated, not built.
- No per-app grant policy or UI — `app.use` ships as anyAuthenticated plumbing only. Viewer-bound script credentials likewise deferred.
- Pure elements are write-only w.r.t. their own controls — letting them read their own control state is a pending design decision, not an accident.
- Provenance columns on the app tables are deferred (tables registered non-audit; attribution rides the permission-audit trail).

## Interfaces / Seams

- **Agents** → MCP tools (`app-upsert` / `app-get` / `app-list` / `app-patch` / `app-history` / `app-diff` / `app-rollback`) plus the seeded `apps` skill — the sole agent authoring surface.
- **Dashboard** → HTTP app routes, partitioned definition-lifecycle vs runtime-data; `AppSurface` is the embeddable component (`/apps/:id` is a thin wrapper); app state lives in the dashboard-global store under per-app prefixes.
- **KV store** ← the apps engine owns row CRUD and index maintenance for model data; callers never hand-write raw KV for app rows.
- **Scripts runtime** ← script actions execute there with app context and merged args.
- **Tasks system** ← task actions spawn observable agent tasks.
- **RBAC** ← `app.use` verb on a per-app resource; app writes audited in the permission-audit trail.
- **API-owned storage** ← app definitions, version history, and user-config values are API-server-owned tables (repo DB-boundary rules apply).

## Decision log

### 2026-08-05 Single apps migration; provenance columns deferred
Porting to main collided with main's migration numbering and the new audit-columns CI gate. Decision: collapse the three spike migrations into one `126_apps.sql` (all `IF NOT EXISTS`) and register the three tables as non-audit rather than rush `created_by`/`updated_by` into a forward-only migration. Consequence: attribution rides the permission-audit trail until a dedicated provenance follow-up; spike-era local DBs need their `_migrations` rows cleared once (the runner keys applied migrations by numeric prefix).

### 2026-08-04 userConfig: schema versioned, values not
Per-user values must survive app iteration and rollback. Decision: declare the userConfig schema inside the definition (always-compatible changes only) but store values outside version history, per user. Consequence: rollbacks never clobber user data; the cost is that the config schema can only grow compatibly.

### 2026-08-04 RBAC plumbing before policy
Apps needed viewer identity and enforcement points, but per-app grant policy wasn't designed yet. Decision: introduce `app.use` on a per-app resource, enforced everywhere, granted anyAuthenticated. Consequence: tightening to real per-app grants is a policy change, not a plumbing retrofit; until then every authenticated principal can use every app.

### 2026-08-04 Elements are static references with mediated reach
Cross-app composition risked dynamic coupling and unbounded resolution. Decision: ElementRef targets are literal-only, consumed queries/actions go through consumer-local mirrors, `$app` is assembler-owned. Consequence: an element's consumers are statically enumerable — which is exactly what makes the compat gate and validation budgets possible.

### 2026-08-04 Rollback is a forward restore
Decision: rollback creates a new version from a snapshot; history is append-only. Consequence: every state ever written stays reachable, and "undo the undo" is trivial. (A destructive reset was never acceptable given agent-driven iteration.)

### 2026-08-04 One lock + one transaction for schema changes
Per-phase review found a definition read-modify-write lost-update race across write surfaces. Decision: serialize all definition writes through a per-app lock; migrations take sorted model locks, dry-run on cloned rows, then commit rows + indexes + definition atomically. Consequence: concurrent writers get clean conflicts instead of silent lost updates.

### 2026-08-03 Productionization scope: spike minus connections
The spike proved the primitive but bundled external-source connections. Decision: productionize lifecycle, elements, userConfig, and RBAC — and cut connections/synced columns entirely from v1. Consequence: v1 apps are self-contained over KV data; external sources return as a deliberate later phase, not scope creep.

### 2026-08-01 Rows in KV, definition as one document, server-native writes
Spike measurements: script-routed access costs 250–310 ms vs 3.9 ms native reads, and generated CRUD scripts had no CAS story. Decision: model rows live in the existing KV store with the API server owning row CRUD and index maintenance; the whole app is one JSON definition so versioning/diff/export stay one-row cheap. Consequence: interactive reads are fast and writes serialize in-process; accepted ceiling of roughly 10⁴ rows per hand-indexed model before the real-table escape hatch is needed.

### 2026-08-01 Dashboard-only, catalog-ceiling rendering
Free-form generated UI would maximize expressiveness and risk. Decision: pages and elements are json-render catalog trees rendered inside the dashboard only. Consequence: everything agents produce is inspectable, diffable, and embeddable; the catalog is the feature ceiling and grows deliberately.

## Amendment log

- 2026-08-05 Created — post-productionization exec summary. (Plan `2026-08-04-swarm-apps-productionization.md`; PR #1066 port session.)
