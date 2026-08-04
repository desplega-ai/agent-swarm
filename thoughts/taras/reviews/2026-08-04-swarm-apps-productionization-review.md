---
date: 2026-08-04
reviewer: claude
topic: "Review: Swarm Apps productionization plan (lifecycle, elements, global ctx, viewer RBAC, userConfig)"
tags: [review, plan, swarm-apps, json-render, rbac]
status: complete
branch: spike/swarm-apps
document_reviewed: thoughts/taras/plans/2026-08-04-swarm-apps-productionization.md
sources_checked:
  - thoughts/taras/brainstorms/2026-08-03-swarm-apps-next-iterations.md
  - thoughts/taras/plans/2026-08-03-swarm-apps-spike5-lifecycle-spec.md
codebase_verified_at: /Users/taras/worktrees/agent-swarm/2026-08-03-swarm-apps @ 22f724cc
---

# Review — Swarm Apps productionization plan

**Verdict: ready-with-fixes.**

Phases 1–4 are implementable essentially as written (Phases 1–3 are a high-fidelity
rendering of the frozen spec; Phase 4 needs one missing step). Phase 6's central
mechanism does not work against the actual `@json-render` contract and needs a design
fix before Phase 5 is committed, because Phase 5's store design is chosen to serve it.

Structural check: all required plan sections are present (Overview + Motivation/Related,
Current State Analysis, Desired End State, What We're NOT Doing, Implementation
Approach, Quick Verification Reference, 8 phases each with all three Success-Criteria
subsections, Manual E2E, Appendix with follow-ups/derail-notes/references). Frontmatter
is complete. No structural findings.

**Anchor accuracy: high.** Every `file:line` claim I sampled in Current State Analysis
is correct at HEAD `22f724cc` — `definition.ts:69-71/94-100/176-179/282-292/377-380`,
`store.ts:23-32`, `row-store.ts:131/274-280/337`, `http/apps.ts:287/830-831/898/930`,
`rbac/permissions.ts:204-207`, `rbac/legacy-policy.ts:192`, `rbac/types.ts:20-34`,
`check-rbac-coverage.ts:356` (the `if (def.method === "get") continue;` skip),
`favorite-owner.ts:18-39`, `components.tsx:408/470/534/747/984/1132`,
`page.tsx:296-359/435-441/504-539/740-744`, `use-apps.ts` hook names. Live DB confirmed:
8 apps with the cited ids, no `app_versions` table, none of the lifecycle files present.

---

## Critical

### C1. Phase 6's cross-app data plane cannot work as designed — `$state` never touches the store

The plan's load-bearing mechanism (Implementation Approach, Phase 5 §1, Phase 6 §1/§2)
is: one global `StateStore`, a per-app prefixing `StoreView`, and bound-element refs
rewritten to absolute `/apps/<definingAppId>/…` paths that "pass through the `StoreView`
escape."

The escape only exists on the imperative surface. Declarative binding resolution does
not go through the store at all:

- `node_modules/@json-render/core/dist/index.mjs:272-292` —
  `resolvePropValue` resolves `$state` / `$bindState` as
  `getByPath(ctx.stateModel, value.$state)`.
- `node_modules/@json-render/react/dist/index.mjs:79-83` — `stateModel` is the value
  from `useSyncExternalStore(store.subscribe, store.getSnapshot, …)`, i.e. **whatever
  object the view's `getSnapshot()` returns**.

Since Phase 5 §1 requires `getSnapshot()` to present the app's subtree as root (so
app-relative definitions keep resolving), an absolute `$state: "/apps/<defining>/queries/x/data"`
inside the consuming app's provider resolves as
`getByPath(consumingSubtree, "/apps/<defining>/queries/x/data")` → looks for
`/apps/<consuming>/apps/<defining>/…` → `undefined`, silently.

Worse, it is *asymmetric*: `resolveBindings` (core `index.d.ts:227`) hands the raw path
to the component, which writes it via `set()` → the view passes it through to the global
absolute location, while the read of the same path comes from the consuming subtree.
Writes and reads land in different places.

Two viable repairs, neither considered in the plan:

1. **Per-consumer mirror instead of absolute escape.** Mirror the defining app's query
   slots into a reserved root inside the consuming app's subtree
   (`/refs/<definingAppId>/queries/<q>`). The single-fetch/shared-liveness property the
   brainstorm asked for is preserved at the react-query layer (`appQueryKey` is already
   appId-keyed, `use-apps.ts:7`); only the store mirror duplicates, which is cheap.
2. **Nested provider + nested Renderer.** Register `ElementRef` as a real component
   whose props carry the pre-assembled sub-spec, and have it render
   `<StateProvider store={viewOf(definingApp)}><Renderer spec={sub} …/></StateProvider>`.
   `Renderer`'s `spec` is a plain prop (`react/dist/index.d.ts:394-407`) and providers
   nest, so this is stock-library.

Related: the Current State claim (plan:44) that "a render-time element-ref is not
expressible without forking the library" is **only true for child resolution**
(`react/dist/index.mjs:984-1007` looks children up as `spec.elements[childKey]` and
components never receive `spec`). It does not preclude option 2. That over-broad claim
is what drives the entire client-side-assembly decision, so it deserves re-checking
before locking the design.

### C2. Format upgrade #1 contradicts itself, the spec, and its own QA step

Phase 1 §3 says upgrade 0→1 "**strip** legacy `page` key and any `models.*.sources` /
column `source` bindings." The frozen spec §4 says upgrade #1 is
"`page` → `pages.main`" (convert). Phase 1's own Automated QA says
"sqlite-insert a scratch app with legacy `page` shape → GET 200 **with `pages.main`**".

`pages` is required (`definition.ts:152`), so *stripping* `page` from a legacy-only app
guarantees a parse failure → permanent `definitionError` — the exact brick class §4
exists to kill. Must read: **convert `page` → `pages.main` (+ `defaultPage`), strip
`sources`/`source`.**

Two supporting facts worth folding in:
- No live app in `/tmp/apps-spike-e2e.sqlite` has a top-level `page`
  (`json_extract(definition,'$.page')` is NULL on all 8) or `sources` — the dev DB was
  hand-migrated in the shrink. Upgrade #1 is purely defensive; the plan's framing
  ("canonicalization of pre-shrink shapes") implies live rows need it.
- `AppDefinitionSchema` is **not** `.strict()` (`definition.ts:147`), so `sources`/
  `source` are already dropped at parse and re-stored stripped on any write. The
  strip-sources half is close to a no-op; only the `page` conversion has teeth.

### C3. Phase 4 will be rejected by the validator — `ElementRef`/`Slot` are unknown component types, and the catalog is UI-generated

`src/apps/page-validator.ts:674-678` rejects any element whose `type` is not in
`catalog.componentTypes` with `unknown component type "<t>"`. The server catalog is
`src/apps/catalog.generated.json`, **generated from `apps/ui/src/lib/json-render/catalog.ts`**
by `apps/ui/scripts/generate-catalog-schema.ts` (`bun run generate:catalog-schema`,
output committed).

Phase 4's Changes Required lists only `definition.ts` + `page-validator.ts`. It is
missing `apps/ui/src/lib/json-render/catalog.ts`, the regenerated
`src/apps/catalog.generated.json`, and the regen command — and it directly contradicts
Phase 5's "Components (`components.tsx`) and `catalog.ts` stay **untouched**". This is a
real Phase 4 → apps/ui dependency the phase ordering claims doesn't exist.

Two adjacent points:
- The catalog **already has a `slots` concept** — `Stack`, `Grid`, `Split`, `Tabs`,
  `Container`, `Card`, `Drawer` each carry `slots` in `catalog.generated.json`. The
  plan's new `Slot` leaf node type needs reconciling with it (reuse or explicitly
  namespace apart); as written the two will confuse both agents and readers.
- There is **no CI drift check** for `catalog.generated.json` (nothing in
  `.github/workflows/` or `scripts/*.sh` references it), so a catalog.ts change without
  regeneration fails silently at runtime. Worth adding alongside C3's fix.

---

## Important

### I1. Phase 6 §2's data plumbing is a Rules-of-Hooks violation as written

"collect `ElementRef` targets from the definition → `useApp(definingAppId)` per
referenced app" — `useApp` is a single `useQuery` (`use-apps.ts:25-32`). Calling it once
per referenced app means the hook count varies with the definition and with which page
is mounted. Needs a `useQueries` over the resolved target list.

Likewise "extend `queryPlans`/`useAppQueries`" understates the work: `useAppQueries(appId, plans)`
hard-codes one `appId` into both the query key and `queryFn` (`use-apps.ts:54-65`). It
needs a `(appId, plan)[]` signature, not an extended plans array.

### I2. `StoreView` contract is incomplete and the snapshot must be cached

`StateStore` (core `store-utils-D98Czbil.d.ts:400-421`) requires
`get` / `set` / **`update`** / `getSnapshot` / `subscribe` (+ optional
`getServerSnapshot`). Phase 5 §1 lists only get/set/subscribe/snapshot — `update` is
missing and will fail `tsc -b`.

Additionally, `useSyncExternalStore` requires a **cached** snapshot. A view that computes
`getByPath(global.getSnapshot(), "/apps/" + id)` and falls back to a fresh `{}` when the
subtree does not exist yet will trip React's "The result of getSnapshot should be
cached" infinite loop. Memoize the fallback, or seed `/apps/<id> = {}` at mount.

Good news worth stating in the plan: `immutableSetByPath`
(core `chunk-AFLK3Q4T.mjs:558-587`) clones **only along the changed path**, so sibling
app subtrees keep referential identity and unrelated apps' providers bail out of
re-render. The subtree-snapshot design is sound on that axis; it is only the *absolute
escape* (C1) that breaks.

### I3. Phase 5 silently drops the first-paint `/route` seed

`page.tsx:430-441` constructs the store with `createStateStore({ route: {…} })`, and its
comment says explicitly this exists so a deep-linked page renders route-driven bits (a
Drawer, a `visible` condition) **on the first paint rather than a frame later**. Phase 5
replaces the constructor with `getAppStoreView(app.id)` and says nothing about seeding.
With a shared global store the seed must happen before first render *and* must not
clobber a warm store on re-entry — two competing requirements. No QA step covers it; add
"hard-reload a deep link that opens a Drawer via a route param → open on first paint".

### I4. Compat-gate failure modes (Phase 4 §2)

- **Unparseable consumers are invisible.** The plan asserts "scan is same-DB, so always
  reachable — no partial-failure mode". But a consumer app whose stored definition does
  not parse (the very `definitionError` class Phase 1 introduces) cannot be structurally
  scanned; if the scan skips it, the gate reports "no consumers" and lets a breaking
  change through. Specify a raw-JSON scan or an explicit "N apps unscannable" issue.
- **No escape hatch.** App A's owner is blocked by app B's reference, with no
  force/override directive. The brainstorm's rule (breaking ⇒ new element name) has no
  answer for an abandoned consumer.
- **Rollback interaction undefined.** Rollback = forward-migrate through the same
  engine, so rolling app A back across an element addition should trip the gate. The
  plan never says whether it does. This is a new rollback failure mode either way.
- **`DELETE /api/apps/{id}` is ungated** by the compat gate — consumers break silently.
  Defensible under the float model (error card), but state the asymmetry.
- **Cost**: full-JSON scan of every app per definition write, no index. Belongs in the
  productization flags list.

### I5. Phase 6's "break the float" QA step contradicts Phase 4's gate

"unexport the element in Notes Mini … (or delete the fixture element with `{purge…}`-free
force on a DB copy)". Unexporting a referenced exported element is *precisely* what the
Phase 4 compat gate rejects, and `purge` is column-migration vocabulary with no meaning
for elements. The only ways to reach the broken-float state are a direct sqlite mutation
or removing the consumer's ref first. Rewrite the step.

### I6. Phase 2 doesn't define "old models" when the stored definition is unparseable

Spec §4 requires PUT (and Phase 3 requires rollback) to work against a `definitionError`
app. Phase 2's engine "diffs old vs new models" — undefined when the old side does not
parse. Decide it explicitly (treat as empty-models ⇒ everything is an add? refuse the
migration engine and write straight through? scan rows for orphan fields only?). An
implementing agent will guess, and the guess is data-affecting.

### I7. Phase 2 omits `bun run docs:openapi`

Phase 2 adds an optional `migration` field to PUT/PATCH request bodies and a migration
report to their responses — both OpenAPI-visible. Phases 1, 3, 7, 8 all run
`docs:openapi`; Phase 2 does not. CI's OpenAPI freshness check will fail at the Phase 2
commit.

### I8. Unflagged spec deviation: §3c and the `joinKey`-rename coverage-floor item

Phase 3's Implementation Note claims "Phases 1–3 = the complete frozen spec" and the
Appendix flags exactly one deviation (upgrade #2). But spec §3c (source/joinKey rename
forbidden; source-bound column edits) and the coverage-floor entry "joinKey-rename
rejection" are dropped entirely. Correct post-shrink — sources no longer exist — but it
should be listed next to the upgrade-#2 deviation, along with the spec's
`allowSourceManaged: true` (also gone; Phase 2 correctly uses only `skipUpdatedAt`).

### I9. Viewer identity is plumbed but inert — Desired End State overstates it

Desired End State #3/#5 say bound elements "execute as the viewer" and RBAC "gates
rendering/queries/rows/actions". In this plan: Phase 6 ships rendering *before* Phase 7;
the dashboard calls `/api/apps/*` with the shared operator key (plan:46, verified in
`client.ts`); `app.use` maps to `anyAuthenticated`; and "Dashboard-wide `aswt_` login" is
explicitly out of scope. So the brainstorm's decision — "embedding never launders
privileges" — is **structurally prepared, not achieved**. The plan is honest about this
in scattered places (Phase 7's "behavioral no-op today", the NOT-doing list) but the
Desired End State reads as if the property lands. State the gap plainly in Phase 6 and
Phase 7, since it is the security-relevant decision in the brainstorm.

### I10. Non-strict definition schema makes the new surfaces fail silently

`AppDefinitionSchema` has no `.strict()` (`definition.ts:147`), so unknown top-level keys
are dropped by Zod on every write. An agent that writes `element:` or `userconfig:` gets
a **200 with its work silently discarded** — the worst failure mode for an agent-facing
surface, and it now applies to the two headline features. The plan should decide: add an
unknown-top-level-key issue, or document the strip. (This is also why C2's strip-sources
half is near-redundant.)

### I11. Phase 6 assembler under-specifies which node fields get rewritten

The rewrite list covers node ids, interaction ids (`props.id`), `/props/<p>`
substitution, and `/queries|/actions` refs. Not covered, but all carry ids or state
paths that the expansion must rewrite: the `children` key arrays and the element's own
`root`, `visible` / `$cond` conditions, `repeat.items` (+ `RepeatChildren`'s
`repeatBasePath` derivation), `watch` configs, and action `params`. `ELEMENT_KEYS`
(`page-validator.ts:31`) is the authoritative field list — enumerate against it.

### I12. Interaction-plane path shape deviates from the brainstorm decision

The brainstorm's decided shape is
`/apps/B/pages/<p>/instances/<key>/ui/<id>/value`; the plan rewrites to
`instances/<instanceKey>/<origId>` with no `pages/<p>` segment, so the same instanceKey
used on two pages of app B shares interaction state. Possibly intentional (cross-page
warm state is a deliberate property elsewhere), but it is an unflagged deviation from a
Key Decision. The plan *does* correctly flag the related, larger deviation (hand-authored
duplicate `/ui/<id>` still collide) in the derail notes.

### I13. Phase 8 leaves the agent principal undefined for `app_user_config`

`resolveHttpFavoriteOwner` returns `null` when the caller is an agent with no resolvable
audit userId (`favorite-owner.ts:18-39`). Phase 8 reuses that resolver but never says
what `GET/PUT /user-config` does for an agent: 403? shared scope? per-agent scope? Agents
are the primary writers in this system, so this will be hit immediately.

### I14. Phase 6's assembler test command targets a runner that does not exist

`apps/ui/package.json` has **no** vitest dependency and no `test` script (scripts:
dev/build/lint/lint:fix/format/check:tokens/generate:catalog-schema/preview). The plan
hedges with a parenthetical "if no vitest runner is wired… check `apps/ui/package.json`
first", which pushes a structural decision into mid-phase. Pre-decide: put the assembler
in a root-testable module and use `bun run test:root`. (Prior gotcha on record: direct
backend-test imports from `apps/ui/src/lib` have bitten before.)

---

## Minor

- **M1** — `app-diff`'s `from` default (spec §2: "newest snapshot") is not carried into
  Phase 3; only `to` defaults are stated.
- **M2** — Cross-phase QA state dependencies: Phase 3's QA asserts `app-history` shows
  "the Phase-2 QA writes"; Phase 6's QA uses "the Phase-4 fixtures". Restoring the DB
  from the Manual-E2E backup invalidates both. Also, Phase 4's "a second app" is never
  named or created — name an app id or add a create step.
- **M3** — `components.tsx` / `catalog.ts` are cited without paths; they live at
  `apps/ui/src/lib/json-render/`, not under `components/apps/` where the plan's new files
  go.
- **M4** — The locked directive "mountable outside the apps route" is satisfied
  structurally (module-level store + `AppSurface`) but never verified. Add one QA step
  mounting an `AppSurface` or exported element on a non-apps dashboard page — otherwise
  the directive is untested until a future iteration.
- **M5** — Phase 5 is titled "parity refactor / No new rendering features", but
  cross-app-warm state, a store that survives unmount with no eviction, and shared
  `/route` between two surfaces of the same app are all behavior changes. The plan
  acknowledges each inline; the framing should match.
- **M6** — No size cap on `app_user_config.values`.
- **M7** — Phase 7's "records the invoker actor on task-actions (requester metadata via
  existing task-creation params)" names no parameter.
- **M8** — `check:rbac-coverage`'s verb check is only a substring search for `"app.use"`
  anywhere under `src/` outside `src/rbac/` (`check-rbac-coverage.ts:191-206`), so the
  Phase 7 criterion "new verb has live call sites" passes trivially. The plan's own
  derail note about GET routes being unchecked already covers the substantive gap.

---

## What checks out (no action)

- **Spec fidelity, Phases 1–3**: `app_versions` DDL, fail-closed `snapshotApp` before
  PUT/PATCH/rollback with POST exempt, snapshot-as-stored including unparseable raw,
  versions routes before the `{id}` wildcard, `schemaVersion` server-managed, tolerant
  `decodeApp` → `definitionError` with 409 on queries/actions and PUT still working,
  lazy upgrades at read incl. snapshot reads with no startup pass, the full §3 pipeline
  (dry-run → fail-loud with counts → snapshot → write under the per-model mutex), every
  §3a hidden-column rule (metadata-only, validator-invisible, name reuse blocked,
  `required` ignored, lazy idx drop, hard-delete zero-rows-or-purge, 40-cap), the full
  §3b directive vocabulary + built-in coercions + auto-backfill + idx rebuild + the
  migration report with `orphanFields`, rollback-as-forward-migrate with lossy→400, the
  three MCP tools per §2, and the §5 skill content. The coverage floor is reproduced
  item-for-item except the (moot) joinKey entry — see I8.
- **Decision fidelity**: `elements` as a top-level definition field with no new DB column
  (locked directive) ✓; dashboard-global ctx via a module-level store registry + an
  embeddable `AppSurface` (locked directive) ✓; pure/bound modes ✓; export opt-in with
  private default ✓; float + compat gate ✓; userConfig schema-in-definition /
  values-outside with rollback-safe tolerant read ✓; provenance correctly excluded as
  already shipped ✓. Split state planes are honored in structure — see I12 for the path
  shape and C1 for the data plane.
- **Sequencing**: lifecycle-first so every later surface is born versionable is the right
  call, and Phase 4's Implementation Note (don't put `ElementRef`s in live apps' default
  pages until Phase 6) correctly handles the mid-stack render gap.
- **Phase independence**: 1→2→3 is a genuine chain; 4 is server-only and independent of
  5; 8 correctly declares its dependency on 5 and 7. The only broken independence claim
  is Phase 4 → apps/ui catalog (C3).
