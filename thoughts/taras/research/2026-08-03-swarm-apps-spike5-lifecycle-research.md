---
date: 2026-08-03T00:00:00+02:00
researcher: claude
git_commit: 226cee5dd9da3b000b6279c8f7baf6b6e833d00b
branch: spike/swarm-apps
repository: agent-swarm
topic: "Spike 5 lifecycle tier — schema evolution, versioning, rollback for Swarm Apps"
tags: [research, codebase, swarm-apps, apps, schema-evolution, versioning, rollback, row-store, sync]
status: complete
autonomy: critical
last_updated: 2026-08-03
last_updated_by: claude
---

# Research: Spike 5 lifecycle tier — schema evolution, versioning, rollback

**Date**: 2026-08-03
**Researcher**: claude
**Git Commit**: 226cee5d (spike/swarm-apps)

## Research Question

From the Spike 5 candidate section of `thoughts/taras/plans/2026-08-01-swarm-apps-spike-progress.md`: document everything relevant to "apps live long enough to change" — (1) the schema-change contract for apps that already hold rows (add/remove/kind-change/enum-narrowing, backfill, index rebuild, interaction with source-bound columns + join keys), (2) versioning (snapshot-on-write, history/diff/rollback tools, "mirror the workflows pattern"), (3) stored-definition format migration (the AMENDMENT-v2 read-time-brick class), (4) the concrete data the finale would operate on (PM Inbox's `flag` column).

This is a documentation of what exists; design happens at spike-5 contract-freeze time.

## Summary

**Apps have zero lifecycle machinery today.** The `apps` table (migration 124) is `id/name/description/definition/created_at/updated_at` — one mutable JSON blob, plain `UPDATE ... SET definition = ?` on every write (`src/apps/store.ts:84-106`), no version column, no history table, no snapshot call anywhere. Both definition-mutating routes carry the identical comment `// Spike limitation: schema updates do not migrate rows or rebuild KV indexes.` (`src/http/apps.ts:947`, `:979`). Rows live in the generic KV store under namespace `apps:<appId>` (`<model>/row/<rowId>` + presence-marker `<model>/idx/<col>/<encVal>/<rowId>` keys) and are validated only at *row*-write time against whatever `ModelDef` the caller passes — never re-validated, re-projected, or re-indexed when the *definition* changes. The live spike DB already exhibits the resulting drift: PM Inbox rows carry `taskTags`/`taskVcsUrl` fields that no longer exist in the declared column set.

**Every building block the spike-5 sketch names already has a working precedent elsewhere in the repo.** Versioning: `workflow_versions` (pre-update snapshot, no parent version column, `snapshotWorkflow()` before every PUT/PATCH with an empty-catch) is the canonical pattern, explicitly mirrored by `page_versions`; `script_versions` and `context_versions` are post-write full-copy variants, and `context-diff` is the repo's only diff surface (shells out to `diff -u`). Notably, **no subsystem has a rollback/restore endpoint or tool** — "restore" everywhere means fetch-old-snapshot-and-re-PUT manually, so app-rollback would be the repo's first. Bulk row rewriting under safety: the sync engine's reconcile (`runSyncPass`, `src/apps/sync.ts:251-363`) is the exact precedent — pull outside the lock, then a full scan + batched unlocked row writes inside one `withMutationLock(appId, model)` span, with concurrency regression tests. Format migration has two opposite precedents: the spike-4 `page`→`pages` change was absorbed losslessly by a zod `.transform()` normalizing on every read, while AMENDMENT v2's connector-enum removal bricked stored definitions at read time because `decodeApp` uses a throwing `AppDefinitionSchema.parse` — GET and PATCH both 500 before any repair patch can apply, forcing sqlite surgery.

**The concrete finale fixture is real and non-trivial.** PM Inbox (`6f93f0ce`, 15 rows from two sources) has `flag: {kind: "enum", enum: ["none","watch","urgent","done"], default: "none"}` with live per-row annotations (`urgent` set on real rows), an `urgent` query filtering on `flag`, and enum columns are always-indexed (`isIndexed`, `src/apps/row-store.ts:67-70`) so all 15 idx entries are on `flag` — a `flag`→`priority`+`status` restructure touches rows, idx keys, a dependent query, and (via full-definition re-validation) any page elements bound to the column.

## Detailed Findings

### 1. Current substrate — definition schema, storage, write pipeline

**AppDefinition** (`src/apps/definition.ts`):
- Columns (`ColumnDefSchema`, `definition.ts:40-84`): `kind: string|number|boolean|date|enum`, `required?`, `enum?` (required + unique iff kind=enum), `index?`, `default?` (type-checked against kind), `source?` (source binding). Models (`definition.ts:86-115`): 1–40 columns, ≤4 sources, reserved column names rejected: `id, createdAt, updatedAt, source, syncedAt, stale`.
- Top-level (`definition.ts:187-326`): `models` (1–10), `queries?`, `actions?` (≤20; `script`/`task`/`sync` kinds), `pages?`+`defaultPage` (XOR legacy `page`). Read-time normalization: `.transform()` at `definition.ts:320-326` converts legacy `page` → `{pages: {main}, defaultPage: "main"}` on **every parse** — stored legacy definitions are normalized in memory on read, rewritten to storage only on the next write.
- `parseAppDefinition` (`definition.ts:505-529`) = zod safeParse → per-page `validatePage` (against `src/apps/catalog.generated.json`) + cross-page checks + `sourceDefinitionIssues` + action-script existence. Uniform error contract: `AppValidationIssue { path, message }` (`definition.ts:338-341`); HTTP: `400 {error: "invalid app definition", issues}` (`src/http/apps.ts:328-330`).

**Storage** (`src/be/migrations/124_apps_spike.sql` — the only apps migration): one relational table for definitions; runtime rows in KV. `appsNamespace(appId) = "apps:${appId}"` (`row-store.ts:43-45`); row key `<model>/row/<rowId>`; index key `<model>/idx/<column>/<encodedValue>/<rowId>` with value `"1"` (`row-store.ts:47-65`). `encodedIndexValue` URI-encodes + truncates to 128 chars.

**Write pipeline** for definitions: POST/PUT run the wire payload wholesale through `parseAppDefinition`; PATCH (`src/http/apps.ts:926-959`) applies RFC 7396 merge patch via `applyAppDefinitionPatch` (`definition.ts:621-630`) then re-validates the **merged whole definition** with the same `parseAppDefinition` — nothing is written on failure (pinned by `apps-spike2.test.ts:331-345`). Atomic (whole-replace) subtrees (`entriesAreAtomic`, `definition.ts:593-599`): `actions.<name>`, `models.<m>.columns.<col>`, `models.<m>.sources.<src>`, `pages.<p>.elements.<id>`, `pages.<p>.params.<param>`. Patches containing a top-level `page` key are rejected with guidance (`definition.ts:568-573`); `__proto__`/`constructor`/`prototype` keys rejected anywhere (`definition.ts:546-562`); deleting the default page rejected (`definition.ts:575-584`).

A consequence worth noting for schema evolution: because PATCH re-validates the merged whole, a column-removing patch that would break a *page binding* or *query filter* referencing that column **is already caught today** (validator cross-checks `app.mutate` params and query filter/sort columns against the model). What is not caught is anything living outside the definition: existing row values, idx keys, and undeclared row fields.

### 2. Rows and indexes — what a definition change does (and doesn't do) today

- Row shape is flat: `AppRow = {id, createdAt, updatedAt, source?, syncedAt?, stale?} & Record<string, unknown>` (`row-store.ts:9-16`).
- Index derivation (`isIndexed`, `row-store.ts:67-70`): **enum columns are always indexed**; `string`/`boolean` only with `index: true`; `number`/`date` never. This resolves an apparent anomaly in the live DB: PM Inbox's `flag` has no `index: true` yet owns all 15 idx entries — because it is the model's only enum column.
- **Idx keys are write-side bookkeeping only**: no read path consults them. `applyQuery`/named queries do a full `listAppRows` scan (capped 100k, `row-store.ts:283-290`) and filter/sort in memory (`src/http/apps.ts:541-569`). Tests assert idx-key presence/absence directly (`apps-spike.test.ts:405-413`). So today, orphaned idx keys are cosmetic garbage, not query-correctness bugs — but any future index-consuming reader changes that calculus.
- Row values are validated only by `prepareValues` (`row-store.ts:92-179`) at row-write time against the `ModelDef` **the caller passes at that moment**; the row-store has no independent knowledge of the stored definition. Definition writes (`updateApp`) never touch the KV namespace (`store.ts:84-106`).
- The gap is documented in place: `// Spike limitation: schema updates do not migrate rows or rebuild KV indexes.` at `src/http/apps.ts:947` (PATCH) and `:979` (PUT).
- **Live evidence of the drift class** (read-only inspection of `/tmp/apps-spike-e2e.sqlite`): PM Inbox row `188e7801` carries `taskTags` and `taskVcsUrl` — fields absent from the current declared columns (left from an earlier iteration of the definition before it was patched down). System fields `source`/`syncedAt`/`stale` also live on rows without being declared columns (sync-managed, allowed via `allowSourceManaged`).

### 3. Concurrency machinery — the lock and the bulk-rewrite precedent

- `withMutationLock(appId, model, op)` (`row-store.ts:181-193`): in-process promise chain keyed `${appId}:${model}`; failures don't poison the chain. Guards row create/patch/delete and `purgeAppRows` (which sequentially acquires every model's lock; `row-store.ts:385-403`). `*Unlocked` variants exist for callers already holding the lock.
- **Sync reconcile is the precedent for "index rebuild + row backfill server-side under the model mutex"**: `runSyncPass` (`sync.ts:251-363`) awaits the pull *before* the lock (comment at `sync.ts:274`), then performs full-scan + per-record `patchAppRowUnlocked`/`createAppRowUnlocked` batches inside a single `withMutationLock` span. Concurrency pinned by `apps-spike3.test.ts:817-861` (barrier-gated double-sync produces no duplicates — the spike-3 CONFIRMED blocker's regression test) and `apps-spike.test.ts:416-429` (30 concurrent creates, 30 rows + 30 idx keys).
- Known limit (logged since spike 1, unresolved): the mutex is in-process — a single-API-instance assumption that any migration engine inheriting it also inherits.

### 4. Sources, join keys, and where migrations would intersect sync

- `SourceDef` post-AMENDMENT-v2 (`definition.ts:20-32`): discriminated union `{connector: "swarm-tasks", joinKey, config?}` | `{connector: "script", joinKey, scriptId, args?}`. Column-level `source: {of, field, transform?}` bindings project source fields into columns (transforms kind-checked: slug/lower/upper→string, cents→number, date-parse→date).
- Cross-field rules (`sourceDefinitionIssues`, `definition.ts:359-503`): join-key column must exist, be `kind: "string"`, not source-bound, not required, no default; script sources must resolve via `getScriptById`; source-bound columns must not be required / carry defaults; **if a model has sources, every required owned column must carry a default** (otherwise sync-created rows could never exist). These rules mean column-level migrations are entangled with source config: e.g. a kind change on a join-key column, or making a source-bound column required, is already impossible to *express*; but *removing* a source leaves its projected values and `source`/`syncedAt`/`stale` metadata sitting on rows.
- Read-only enforcement choke point: `prepareValues` rejects external writes to source-bound columns and join keys unless `allowSourceManaged: true` (`row-store.ts:113-133`) — the same flag a migration engine would need to rewrite synced rows.
- Sync semantics relevant to backfill design: per-source scoping via `row.source === sourceName` + `row[joinKey]` (`sync.ts:279-283`); no deletions ever — disappeared rows get `{stale: true}`; `syncedAt` bumps on every confirmed row while `updatedAt` bumps only on value change (`skipUpdatedAt`, `sync.ts:310-322`); pull failure = zero row churn because the reconcile block never runs (`apps-spike3.test.ts:714-754`); 500-record cap per pull, 100k row cap per model.
- A definition migration that renames a join-key column or a source name silently orphans the reconcile mapping: `mine` is keyed on the *current* definition's joinKey/source name, so previously-synced rows whose `source`/joinKey values no longer match would be treated as unmatched (left alone / eventually stale) while the next sync re-creates duplicates under the new mapping. Nothing tests or handles this today.

### 5. Versioning precedents — what "mirror the workflows pattern" concretely means

| Subsystem | History table | Parent `version` col | Snapshot direction | Rollback surface | MCP exposure |
|---|---|---|---|---|---|
| Workflows | `workflow_versions` (`008_workflow_redesign.sql:74-82`) | no (head = MAX) | **pre-update** snapshot | none (manual re-PUT) | none |
| Pages | `page_versions` (`060_page_versions.sql`, "Mirrors workflow_versions") | no | pre-update | none | via `create_page` writes only |
| Scripts | `script_versions` (`064_scripts.sql`) | yes | post-write full copy, same txn, hash-dedup | read-only `pinHash` execution in `swarm-script` executor (`src/workflows/executors/swarm-script.ts:131-194`) | none |
| Agent context | `context_versions` (`001_initial.sql:310-325`, linked list via `previousVersionId`) | n/a | post-update copy | diff-only | **`context-diff`** (`src/tools/context-diff.ts`) — the only diff tool in the repo (shells out to `diff -u`) |
| Skills | none — bare `skills.version` counter | yes | none | none | version number reported only |
| **Apps** | **none** | **none** | **none** | **none** | **none** |

- Workflows write path: `snapshotWorkflow(workflowId, changedByAgentId?)` (`src/workflows/version.ts:13-44`) computes `nextVersion = max+1`, stores a `WorkflowSnapshot` JSON; called **before** every mutating write from both HTTP (`src/http/workflows.ts:533-537`, `577-581`, `637-642`) and MCP tools (`src/tools/workflows/update-workflow.ts:115`, `patch-workflow.ts:100`, `patch-workflow-node.ts:50`), always in a try/catch whose failure never blocks the write. Reads: `GET /api/workflows/{id}/versions[/{version}]` (route-ordering gotcha: versions route must match before the `:id` wildcard).
- Pages: structurally identical (`src/pages/version.ts:18-44`; snapshot before PUT at `src/http/pages.ts:599-604` and before `create_page` upsert-update at `src/tools/create-page.ts:159-165` — first create skips; `pageEditCounter` = MAX+1 surfaces "edited N times" to the agent).
- Scripts differ: every content change inserts a **post-write** version row in the same transaction (`src/be/scripts/db.ts:~286-363`), content-hash dedup skips no-op versions, and `getScriptVersion` resolves by version *or* contentHash — consumed by the workflow executor's `pinHash` (run-an-old-version without mutating the live row).
- **Nothing in the repo restores an old version server-side.** app-rollback as sketched (restore definition + engine handles the row side) has no precedent to copy for the restore step itself — only for history storage and listing.
- Retention/pruning: none anywhere; `ON DELETE CASCADE` only.
- Confirmed absent for apps at both layers: no `app_versions` in any migration; the only `app_versions` mentions in the repo are planning prose in `thoughts/` (brainstorm Key Decision: "`app_versions` stores the resolved reference-graph bundle on meaningful change/on demand → rollback, iteration diffing, export/import from one mechanism").

### 6. Stored-definition format migration — the two existing precedents

The platform has handled "the definition schema itself changed" twice, with opposite outcomes:

1. **Graceful (spike 4, `page`→`pages`)**: zod `.transform()` normalization at parse time (`definition.ts:320-326`) — stored legacy shapes keep reading fine forever, get canonicalized on next write. Lossless, additive, no data touch.
2. **Brick (AMENDMENT v2, connector-enum removal)**: `github-issues` removed from the `SourceDef` union; `decodeApp` (`src/apps/store.ts:23-32`) uses **throwing** `AppDefinitionSchema.parse` on every read, so every handler calling `getApp()` 500s on a stored old-shape definition — including PATCH itself (`src/http/apps.ts:932` reads before merging), so **the normal repair path is self-blocking**. Recovery was direct sqlite `UPDATE apps SET definition=...` rewriting sources to `{connector: "script", scriptId: <github-issues-pull>, args: <old config>}`; post-migration syncs verified byte-identical projections (progress doc, AMENDMENT v2 section). The replacement seed script is `src/be/seed-scripts/catalog/github-issues-pull.ts`.

The generalization gap named by research question 3: shape-changes that a zod transform can express are already survivable; enum/field *removals* are not, and there is no stored-definition version stamp, no on-read fallback, and no startup/lazy rewrite pass for the `apps.definition` column. (For contrast, relational schema evolution has the file-based migration runner; `seed_state` (`070_seed_state.sql` + `src/be/seed/runner.ts:17-86`) solves a different problem — seeded-default drift vs user edits via content hashes, not recoverable history.)

### 7. The finale fixture — PM Inbox live data (read-only inspection, `/tmp/apps-spike-e2e.sqlite`)

- 7 apps in the DB; PM Inbox `6f93f0ce-755c-4b4d-afed-bbb11bb1eed2` (definition 24,127 bytes, updated 2026-08-03T13:01Z — includes the spike-4 finale's `detail` page).
- Single model `issue`, 20 declared columns: 2 join keys (`taskId`, `githubNumber` — per-source, unlike scratch app `12218dfe` which shares one `externalId` join key across both sources), 16 source-bound columns across `tasks` (swarm-tasks connector) and `github` (script connector → `github-issues-pull`, id `8bde3462`), 2 owned columns: `note` (string, default `""`) and **`flag` = `{kind: "enum", enum: ["none","watch","urgent","done"], default: "none"}`**.
- 15 rows (mixed sources), 15 idx entries — all on `flag` (enum ⇒ always indexed). Live annotations exist (e.g. row `5fe79ad3` = GH issue #1047 has `flag: "urgent"`), which is exactly what "keeping all existing annotations" must preserve.
- Dependent surfaces on `flag`: the `urgent` query (`filter: {flag: "urgent"}`), page elements (flag badges/row actions on main + detail pages). A restructure to `priority`+`status` therefore exercises: enum column removal + two additions, row value mapping, idx-key rebuild (drop 15 `idx/flag/*`, create new), query migration, and page re-validation (the merged-definition validator would reject a patch that leaves `urgent` filtering on a deleted column — forcing the agent to patch queries/pages in the same request or sequence).
- Rows also carry the drift artifacts (`taskTags`, `taskVcsUrl`, undeclared) noted in §2 — a migration engine meets pre-existing undeclared fields in real data on day one.

### 8. Mapping to the four research questions — exists vs. absent

| Sketch element (progress doc §Spike 5) | Exists today | Absent today |
|---|---|---|
| Add column (default/backfill) | `default` applied on row **create** only (`row-store.ts:140-151`); merge-patch can add the column def atomically | any backfill of existing rows; defaults never retro-applied |
| Remove column | patch removes def; merged-result validation catches broken page/query refs | row-field cleanup, idx-key cleanup (both stay orphaned) |
| Kind change / enum narrowing | patch replaces the column def atomically; new writes validated against new kind | any re-validation/coercion of existing row values; rows silently violate the new schema |
| Fail-loud destructive changes via issues[] | the issues[] contract + path convention, uniform across all write surfaces | any row-awareness in validation — definition writes never consult stored rows |
| Migration directive on the patch | — | no vocabulary for it (PATCH body is pure RFC 7396 definition content) |
| Index rebuild under model mutex | `withMutationLock` + sync's unlocked-batch pattern + `indexKeys()` derivation | any code path that rewrites idx keys on definition change |
| Source-bound/join-key interaction | validator rules constraining what's expressible; `allowSourceManaged` write path | handling for source/joinKey renames (silent re-create/duplicate risk, §4) |
| `app_versions` snapshot-on-write | `workflow_versions`/`page_versions` pattern ready to copy (incl. snapshot-before-write call-site discipline + empty-catch) | the table, the `snapshotApp()` call, tests |
| app-history / app-diff / app-rollback tools | `context-diff` (diff -u) as the sole diff precedent; versions list/get HTTP route shapes | all three tools; any rollback-restore anywhere in the repo |
| Stored-definition format migration | zod-transform normalization precedent (page→pages); seed-script replacement precedent (AMENDMENT v2) | definition version stamp; non-throwing read path (`decodeApp` uses `.parse`); any rewrite pass |

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/apps/store.ts` | 23-32 | `decodeApp` — throwing `AppDefinitionSchema.parse` on every read (the brick point) |
| `src/apps/store.ts` | 84-106 | `updateApp` — plain overwrite, no snapshot/version |
| `src/http/apps.ts` | 947, 979 | "Spike limitation: schema updates do not migrate rows or rebuild KV indexes." |
| `src/http/apps.ts` | 926-959 | PATCH handler: read → merge → re-validate merged whole → write |
| `src/apps/definition.ts` | 320-326 | Legacy `page`→`pages` read-time zod transform (graceful format-migration precedent) |
| `src/apps/definition.ts` | 593-599 | Atomic merge-patch subtrees (columns/sources/actions/elements/params) |
| `src/apps/definition.ts` | 359-503 | `sourceDefinitionIssues` — join-key/source-bound column constraints |
| `src/apps/row-store.ts` | 67-81 | `isIndexed` (enum always) + `indexKeys` derivation from the passed definition |
| `src/apps/row-store.ts` | 92-179 | `prepareValues` — row validation, `allowSourceManaged` gate, defaults on create only |
| `src/apps/row-store.ts` | 181-193 | `withMutationLock` — in-process per `appId:model` promise chain |
| `src/apps/sync.ts` | 251-363 | `runSyncPass` — pull outside lock, batched unlocked writes inside one lock span |
| `src/be/migrations/124_apps_spike.sql` | 1-10 | The whole apps schema (no version column, only migration) |
| `src/be/migrations/008_workflow_redesign.sql` | 74-82 | `workflow_versions` — the canonical snapshot table shape |
| `src/workflows/version.ts` | 13-44 | `snapshotWorkflow` — pre-update snapshot, max+1 |
| `src/http/workflows.ts` | 637-642 | snapshot-before-write call-site pattern (empty catch) |
| `src/pages/version.ts` | 18-44 | `snapshotPage` — the explicit mirror |
| `src/tools/create-page.ts` | 159-165 | snapshot on upsert-update only (skip first create) |
| `src/be/scripts/db.ts` | ~286-363 | scripts post-write versioning, hash dedup, same-txn |
| `src/workflows/executors/swarm-script.ts` | 131-194 | `pinHash` — run a historical version (read-only) |
| `src/tools/context-diff.ts` | 9-38 | the repo's only diff utility (`diff -u` via Bun.spawn) |
| `src/be/seed-scripts/catalog/github-issues-pull.ts` | 3-82 | AMENDMENT-v2 replacement script (byte-identical projection) |
| `src/tests/apps-spike3.test.ts` | 817-861 | reconcile concurrency regression (barrier-gated double sync) |
| `src/tests/apps-spike.test.ts` | 416-429 | 30 concurrent creates → 30 rows + 30 idx keys |

## Resolved directions (ironed out with Taras, 2026-08-03)

The former Open Questions were resolved interactively; these are the spike-5 contract directions to freeze against.

**Governing principle — backward-compat by default, destruction is explicit (Taras):** routine schema changes never destroy data. Column removal = mark `hidden` (metadata-only: data stays on rows, column disappears from pages/queries/writes, idx entries stop being maintained). Only genuinely lossy operations (kind change, enum narrowing, purging hidden data) require an explicit opt-in, and they fail loudly via issues[] without it. This also makes rollback nearly free for the common case (unhide) and matches protobuf-style field deprecation.

1. **Migration-directive surface**: sibling field on the patch — `app-patch`/PATCH body grows an optional `migration` field next to the RFC 7396 patch. One request stays atomic (validate merged definition + directives → snapshot → migrate rows under the model mutex). Under the backward-compat model the directive is only needed for transforms/backfills and explicit destruction, not routine deletes.
2. **Column removal**: hide, don't delete. **Name reuse while hidden is blocked** via issues[] — adding a column with a hidden column's name requires unhide or explicit purge first (keeps hide metadata-only, no row rewrite, no tombstone renames).
3. **Lossy ops (kind change, enum narrowing)**: fail loudly by default with per-value row counts in issues[]; the `migration` directive carries an explicit coercion/mapping (or null-out) that runs under the model mutex. Same directive vocabulary as the finale's `flag`→`priority`+`status` backfill-from-hidden-column mapping.
4. **Rollback = forward-migrate**: restoring an old version diffs current→snapshot and runs it through the same migration engine with the same rules. No inverse modeling; with hide-not-delete, most rollbacks are unhide + hide.
5. **Format migration (the AMENDMENT-v2 class)**: schemaVersion stamp on stored definitions + registered upgrade functions run lazily at read (tolerant, non-throwing decode) and persisted on next write — the SQL-migration-runner philosophy applied to the `definition` column; the `page`→`pages` transform becomes migration #1.
6. **Undeclared row fields**: preserve + report — never destroyed implicitly; surfaced in the migration/history report so an agent can clean them with an explicit directive.
7. **Source/joinKey renames**: forbidden via issues[] while rows from that source exist; escape hatch is remove-source (rows go stale per existing semantics) + add-new. Kills the silent orphan-and-duplicate class with zero new machinery.
8. **Query/page co-migration**: the agent fixes references in the same patch — merged-definition validation keeps rejecting until dependent queries/pages are consistent (the proven issues[]→self-correct loop). Hidden columns become invalid references exactly like removed ones; the engine does not edit pages.

Remaining minor notes for the spec (not blocking): the in-process mutex stays acceptable for the spike (single-API-instance assumption, logged since spike 1 — migrations inherit it like everything else); whether hidden columns count toward the 40-column cap is a spec detail to state explicitly.

## Appendix

- **Architecture notes**: definitions relational, rows in KV under a reserved (write-protected) `apps:*` namespace; all definition writes funnel through `parseAppDefinition` with one issues[] contract; idx keys are currently write-only bookkeeping (readers scan); "the validator must never reject what the runtime renders" is an explicit spike-2 principle with live-app fixtures as regression tests (`src/tests/fixtures/bookmarks-definition.json.txt`).
- **Historical context (from thoughts/)**: the brainstorm decided `app_versions` ("resolved reference-graph bundle... rollback, iteration diffing, export/import from one mechanism") back on 2026-08-01 but every spike listed versioning + row migration as Non-goals; the progress doc's Spike 5 section is the mandate (three cited incidents: stale-rows comment since spike 1, AMENDMENT-v2 sqlite surgery, no snapshot-before-patch since spike 2). Brainstorm open questions still unresolved and adjacent: cascade/orphan semantics on app delete; future `{connection, entity}` pair replacing the `connector` enum (a second format migration already on the horizon).
- **Related research**:
  - `thoughts/taras/plans/2026-08-01-swarm-apps-spike-progress.md` — the running spike log incl. the Spike 5 candidate scope
  - `thoughts/taras/brainstorms/2026-08-01-swarm-apps.md` — original vision incl. the `app_versions` decision
  - `thoughts/taras/plans/2026-08-02-swarm-apps-spike3-sync-spec.md` — AMENDMENT v2 (the read-time-brick incident)
