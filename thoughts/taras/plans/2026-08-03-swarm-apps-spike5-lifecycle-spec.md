---
date: 2026-08-03
author: claude (orchestrator session)
topic: "Swarm Apps spike 5 — frozen contract: the lifecycle tier (schema evolution, versioning, rollback)"
status: frozen
branch: spike/swarm-apps
---

# Spike 5 frozen contract — the lifecycle tier

Source: progress doc `./2026-08-01-swarm-apps-spike-progress.md` § "Spike 5 candidate",
research `../research/2026-08-03-swarm-apps-spike5-lifecycle-research.md` (incl. the
"Resolved directions" ironed out with Taras). Frozen contracts from spikes 1–4 remain in
force; everything not listed here is UNCHANGED. Everything below is server-side —
**NO UI slice** (hidden columns are invisible to pages by validation, rows keep extra
fields the Table never renders; dashboard version-history UI is productization).

Research-driven calls baked into this spec:

- **Governing principle (Taras): backward-compat by default, destruction is explicit.**
  Column removal = mark `hidden` (metadata-only). Lossy ops fail loudly with per-value
  row counts unless the patch carries an explicit `migration` directive. Nothing
  destroys row data implicitly, ever.
- **app-rollback is the repo's FIRST server-side restore** — workflows/pages only list
  versions; scripts only pin-execute. Snapshot-before-write is therefore **fail-closed**
  here (a failed snapshot fails the write), deliberately deviating from the
  workflows/pages empty-catch: versioning IS the safety property this spike ships.
- **The brick point is `decodeApp`'s throwing `.parse`** (AMENDMENT-v2 lesson; PATCH
  reads before merging, so repair was self-blocking). Decode becomes tolerant: format
  upgrades + safeParse; PUT and rollback must work even when the stored definition no
  longer parses.
- **Migration row-writes do NOT bump `updatedAt`** (`skipUpdatedAt`, the spike-3
  freshness lesson — schema-driven rewrites must not reshuffle updatedAt sorts).
  `syncedAt` untouched. Idx keys ARE rebuilt for affected columns (write-side-only
  today, but the engine owns them for any future index-consuming reader).
- **Live data already has orphan fields** (PM Inbox `taskTags`/`taskVcsUrl`) — the
  engine meets undeclared fields on day one; they are preserved and reported, never
  silently dropped.

## 1. `app_versions` — snapshot on every definition write (mirror `workflow_versions`)

```sql
-- 125_app_versions.sql (spike-only; branch never merges)
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  appId TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,            -- head = MAX(version), no version col on apps
  snapshot TEXT NOT NULL,              -- JSON: { name, description, definition }  (definition AS STORED, incl. schemaVersion)
  changedByAgentId TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(appId, version)
);
```

- `snapshotApp(appId, changedByAgentId?)` (new `src/apps/version.ts`, mirrors
  `src/workflows/version.ts`) runs **before** every definition-mutating write: PUT,
  PATCH, rollback. POST create does not snapshot (pages precedent — nothing prior to
  save). **Fail-closed**: snapshot failure aborts the write (see freeze notes).
- Snapshot captures the definition **as stored** (raw JSON incl. its `schemaVersion`
  stamp — reading a snapshot applies format upgrades, §4). If the stored definition
  is unparseable, the snapshot still captures the raw JSON (recovery must not depend
  on parseability).
- HTTP (verb `app.manage`, same route-order gotcha as workflows — versions before
  `:id` wildcard): `GET /api/apps/:id/versions`,
  `GET /api/apps/:id/versions/:version`, `POST /api/apps/:id/rollback` body
  `{ version, migration? }`.
- No retention/pruning (matches every other *_versions table).

## 2. MCP tools: `app-history`, `app-diff`, `app-rollback` (+ `app-patch` grows `migration`)

- **app-history** `{ appId, limit? }` → toolOk with a table of
  `{version, createdAt, changedByAgentId}` + head version; details carry a one-line
  digest per version (model names + column counts) so an agent can pick a target
  without fetching each snapshot.
- **app-diff** `{ appId, from?, to? }` — version numbers; `to` defaults to CURRENT
  (live definition), `from` defaults to the newest snapshot. Output = unified diff of
  pretty-printed definition JSON via the `context-diff` precedent
  (`diff -u --label v<from> --label v<to>`, `Bun.spawn` — `src/tools/context-diff.ts:9-38`).
  No structural/JSON-patch diff in the spike.
- **app-rollback** `{ appId, version, migration? }` — **rollback = forward-migrate**:
  1. snapshot current state (rollback is itself undoable), 2. treat the target
  snapshot's definition as the incoming definition of a normal update and run the FULL
  §3 engine against live rows (same destructive-change detection, same directive
  vocabulary, same issues[]). Lossless restores (the common case under hide-not-delete:
  unhide + hide + drop added-but-empty columns) apply directly; a genuinely lossy
  restore (e.g. rolling back across a coercion) 400s/toolErrs with the exact
  `migration` entries needed — the agent re-invokes app-rollback with the directive.
- **app-patch** input gains optional `migration` (§3 vocabulary); PUT
  (`app-upsert` update path / HTTP PUT) gains the same optional field — the engine
  runs on the definition DIFF regardless of which write surface produced it. POST
  create never needs it (no rows).

## 3. The schema-change engine (`src/apps/schema-migrate.ts`)

Runs on every definition write against an app whose models hold rows. Pipeline (per
write): merge/validate definition exactly as today → diff old vs new models →
**dry-run scan** under the model mutex (classify every affected row, count every
would-be failure) → if anything destructive lacks a directive: 400/toolErr with
path-bearing, count-bearing issues, NOTHING written → else: snapshot → write pass
(rows + idx) → definition write, all inside `withMutationLock(appId, model)` per
affected model, models processed sequentially (purge-lock precedent,
`row-store.ts:385-403`). Row writes reuse `patchPreparedRowUnlocked`-style paths with
`allowSourceManaged: true` + `skipUpdatedAt: true`.

### 3a. Hidden columns (the backward-compat default)

`ColumnDefSchema` gains `hidden?: boolean`.

- **Hiding** (`hidden: true` via a normal column patch) is metadata-only: rows and idx
  entries untouched at hide time, but the column's idx entries stop being maintained
  and are dropped lazily by the engine (cheap cleanup, they're write-side-only). A
  hidden column is INVALID as a target for: queries (filter/sort), page bindings,
  `app.mutate` values, row writes, new source bindings — same validator treatment as
  a nonexistent column, so the agent fixes references in the same patch (resolved
  direction #8). Sync stops projecting a hidden source-bound column. `required` on a
  hidden column is ignored.
- **Constraints**: a source's `joinKey` column cannot be hidden while the source
  exists. Hidden columns still count toward the 40-column cap (explicitly: yes — the
  cap is a definition-size guard, and purge is the pressure valve).
- **Name reuse is BLOCKED**: adding a column whose name matches a hidden column →
  issue at `models.<m>.columns.<name>`: "name is held by hidden column — unhide it or
  purge its data first". Unhide (`hidden: false` / drop the flag) is metadata-only;
  existing row values were written under this column's kind and remain valid.
- **Hard delete** (`models.<m>.columns.<c> = null` in the merge patch): allowed iff
  (a) the dry-run finds ZERO rows carrying a value for the column, or (b) the
  `migration` directive says `{ "<c>": { "purge": true } }`. Otherwise → issue with
  the row count: "column holds values on N rows — hide it, or purge explicitly".
  Purge removes the field from every row + all its idx entries, then the def entry.
  Purge also works against an already-hidden column's name (delete def + purge data
  in one request, or purge data while keeping it hidden).

### 3b. `migration` directive — sibling field on the write, per-column vocabulary

```ts
migration?: Record<ColumnName,
  | { set: string | number | boolean }                       // constant backfill on all rows missing/holding the column
  | { from: ColumnName,                                      // derive: source may be a HIDDEN column (the flag→priority path)
      map?: Record<string, string | number | boolean>,       // value mapping (keys compared as String(value))
      else?: string | number | boolean | null }              // unmapped values → else; null only if column not required
  | { coerce: true, else?: string | number | boolean | null }// kind change: convert stored values to the NEW kind
  | { purge: true }                                          // destroy stored values (+idx) for this column name
>
```

- Directive entries are validated against the MERGED definition: target column must
  exist post-merge (except `purge`, which may target a removed/hidden name); `set`/
  `map`/`else` values must satisfy the target column's kind; `else: null` /
  unmapped-without-else on a `required` column → issue.
- **Kind change / enum narrowing**: changing `kind`, or narrowing `enum`, triggers the
  dry-run scan. Zero nonconforming stored values → allowed with no directive
  (metadata-only + idx rebuild). N nonconforming → issue carrying per-value counts
  (`"3 rows hold 'urgent', 1 row holds 'watch'"`) unless the directive supplies
  `coerce` (kind change; built-in conversions: number→string always, string→number
  via the DECIMAL pattern, boolean↔string literals, date↔string ISO — unconvertible
  values → `else`) or `from`/`map` (enum narrowing = map from itself).
- **Adding a column**: optional column → no row work. `required` column with a
  `default` → the default is **auto-backfilled** to existing rows (no directive
  needed — deterministic and non-destructive; keeps "required ⇒ has value" true).
  `required` without `default` and no `migration` entry → issue (today this is only
  enforced for source-carrying models; the engine now enforces it for any model WITH
  rows).
- **Index rebuild**: for every column whose def changed (kind, enum, index flag,
  hidden, purge), the engine deletes that column's idx entries and rewrites them per
  the merged def's `isIndexed` — inside the same lock span.
- **Migration report** (the preserve+report readout, on the HTTP response and toolOk
  `details`/`data`): `{ scanned, backfilled, coerced, mapped, elsed, purgedValues,
  idxRebuilt, orphanFields: string[] }` — `orphanFields` lists undeclared field names
  found on rows (PM Inbox's `taskTags` class), reported on EVERY migrating write,
  cleanable only via an explicit `{ purge: true }` entry.
- Out of vocabulary (rejected, log-don't-build): renaming columns in place (hide +
  add + `from` is the path), cross-model moves, `from` chains, computed expressions.

### 3c. Sync interactions (frozen per resolved directions)

- Source/joinKey **renames are forbidden** while rows from that source exist: changing
  a source entry's `joinKey`, or replacing `models.<m>.sources.<s>` with a different
  joinKey, or renaming the source key itself → issue naming the escape hatch
  (delete the source — rows keep values and go stale per existing semantics — then
  add the new one). Deleting a source is non-destructive (preserve+report; rows keep
  `source`/`syncedAt`/`stale` + projected values as plain data).
- Source-bound column edits: re-binding (`source.of`/`field`/`transform` change) is
  metadata-only (next sync re-projects; `changed` classification already handles it).
  Hiding stops projection (§3a).

## 4. Definition format versioning (the AMENDMENT-v2 class, killed)

- Stored definitions gain a top-level **`schemaVersion: number`** stamp (reserved key,
  server-managed: stripped from incoming writes, stamped to CURRENT on every store;
  exposed read-only in app-get/GET responses). Absent stamp ⇒ version 0.
- New `src/apps/format-upgrades.ts`: an ordered registry
  `[{ from: 0, to: 1, upgrade(raw) }, ...]` of pure-ish functions run stepwise on the
  RAW stored JSON before zod. `decodeApp` becomes: raw → apply upgrade chain →
  `safeParse` → on success return app; **on failure return the app with
  `definitionError: issues[]` + the raw definition instead of throwing** (GET 200s
  with the error surfaced; queries/sync/actions against a broken app 409
  `definition needs repair` with the issues). PUT (full replace) and app-rollback
  operate on such an app — the repair path is never self-blocking again.
- Upgrades apply lazily at every read (incl. snapshot reads) and persist on the next
  write (any write stores current-format + current stamp). No startup rewrite pass.
- **Shipping upgrades** (each proves a class):
  - **#1 (0→1): `page` → `pages.main`** — the existing zod `.transform()` logic moves
    into the registry (the transform itself stays in the schema as belt-and-braces
    for in-memory legacy input, but stored-format canonicalization is now the
    registry's job).
  - **#2 (1→2): `connector: "github-issues"` → `{ connector: "script", scriptId:
    <github-issues-pull>, args: <old config> }`** — re-implements AMENDMENT v2's
    sqlite surgery as a registered upgrade (proves upgrades can do lookups zod
    transforms can't: resolves the seed script id at upgrade time; if the seed script
    is missing, the upgrade yields the parse-failure → `definitionError` path, not a
    throw).

## 5. Seeded `apps` skill (same slice)

Extend `templates/skills/apps/content.md`: the backward-compat model ("prefer hiding
over deleting — hidden data survives rollback"), hidden-column semantics + name-reuse
rule, the `migration` directive vocabulary with a worked example (the flag→priority+
status restructure: add columns + `from`/`map` backfill + hide `flag` in ONE patch),
lossy-op fail-loud behavior (issues carry row counts — read them, then decide),
app-history/app-diff/app-rollback usage ("snapshot exists before every write; rollback
is forward-migration and may ask for directives"), the migration report + orphanFields,
and that `schemaVersion` is server-managed. Run `bun run check:skill-sources`.

## Out of scope (log, don't build)

Dashboard UI for history/diff/rollback; app_versions retention/pruning; row-level
history; column RENAME in place; cross-model data moves; computed/expression
backfills; auto-rewrite of dependent queries/pages (agent does it, issues[] loop);
source/joinKey rename migration (forbidden instead); multi-instance locking (in-process
mutex stays, standing flag); the future `{connection, entity}` connector transition
(becomes format upgrade #3 when it lands); startup rewrite pass.

## Slices & fences

- **Freeze commit (orchestrator)**: this spec only (no catalog/stub changes — no UI
  surface).
- **Server slice (Codex sol)** — `src/be/migrations/125_app_versions.sql`,
  `src/apps/{version.ts,schema-migrate.ts,format-upgrades.ts}` (new),
  `src/apps/{definition.ts,store.ts,row-store.ts}`, `src/http/apps.ts`,
  `src/tools/{app-patch.ts,app-upsert.ts}` (migration input),
  `src/tools/{app-history.ts,app-diff.ts,app-rollback.ts}` (new, + registrar +
  `SDK_TOOL_NAME_MAP` entries `app_history`/`app_diff`/`app_rollback`),
  `src/tests/apps-spike5.test.ts`, `templates/skills/apps/content.md`.
  Delegated-run mandate: isolated `DATABASE_PATH` + `BUN_OPTIONS=--no-env-file`
  (three dev-DB pollution incidents; applies to REVIEW/verify agents too).
- No commits by executors; orchestrator commits after the two-lens review.

## Verification (before review)

```bash
bun run lint && bun run tsc:check
bun run test:root -- src/tests/apps-spike5.test.ts src/tests/apps-spike4.test.ts \
  src/tests/apps-spike3.test.ts src/tests/apps-spike2.test.ts src/tests/apps-spike.test.ts
bash scripts/check-db-boundary.sh
bun run check:rbac-coverage && bun run docs:openapi   # new versions/rollback routes, verb app.manage
bun run check:skill-sources
bun run check:sdk-tool-registration 2>/dev/null || bun run scripts/check-sdk-tool-registration.ts
```

Test coverage floor (apps-spike5.test.ts): snapshot on PUT/PATCH/rollback + fail-closed
snapshot; hide/unhide metadata-only (rows byte-identical); name-reuse block; hard-delete
zero-rows vs count-bearing issue vs purge (rows + idx verified); kind-change dry-run
counts + coerce with else; enum-narrow map-from-self; required+default auto-backfill;
skipUpdatedAt on all migration writes; joinKey-rename rejection; rollback lossless
(unhide) + rollback-needs-directive; format upgrades #1/#2 (stored legacy shapes →
read OK → write persists stamped); unparseable-definition → `definitionError` (no
throw) + PUT/rollback still work; concurrency: migration vs concurrent row create
serialize under the mutex (barrier-gated, spike-3 precedent); orphan-field reporting.

## Manual E2E (isolated stack — API :3113, DB /tmp/apps-spike-e2e.sqlite, vite :5375)

```bash
# 0. restart API on new code (env mandate incl. MCP_BASE_URL — spike-3 ngrok lesson)
kill $(lsof -t -iTCP:3113 -sTCP:LISTEN); nohup env DATABASE_PATH=/tmp/apps-spike-e2e.sqlite PORT=3113 \
  MCP_BASE_URL=http://localhost:3113 SLACK_DISABLE=true GITHUB_DISABLE=true JIRA_DISABLE=true \
  LINEAR_DISABLE=true bun --expose-gc src/http.ts >> /tmp/apps-api.log 2>&1 &

# 1. migration 125 applies clean on the existing spike DB; all 7 live apps GET 200,
#    schemaVersion stamped on next write only
curl -s -H "Authorization: Bearer 123123" http://localhost:3113/api/apps | jq '.apps | length'

# 2. versioning: PATCH Notes Mini (bae5343b…) description → app_versions row 1 appears;
#    GET /versions + /versions/1; app-history + app-diff via real MCP client (X-Agent-ID 43172bc2…)
# 3. hidden columns on Spike3 Scratch PM (12218dfe…, 19 rows): columns.note=null → 400 w/ row count;
#    note.hidden=true → 200, sqlite shows rows untouched; add new column "note" → 400 name-held;
#    migration {note:{purge:true}} + columns.note=null → field gone from all rows (sqlite), idx clean
# 4. lossy: patch a string column to kind number on mixed values → 400 with per-value counts;
#    retry with migration {col:{coerce:true, else:null}} → 200, report shows coerced/elsed, idx rebuilt
# 5. required+default add → auto-backfill visible on existing rows without directive
# 6. rollback: app-rollback Spike3 Scratch to v1 → definition restored (hidden column back visible),
#    data intact; a NEW snapshot exists for the pre-rollback state; app-diff v1..current empty
# 7. format upgrades: sqlite-insert (ISOLATED DB) a scratch app with legacy `page` AND a
#    `connector:"github-issues"` source → GET 200 with pages.main + script source; one PATCH →
#    stored JSON now stamped + upgraded (sqlite check)
# 8. regression: PM Inbox full sync (app-sync all) green; browser (agent-browser, :5375):
#    PM Inbox main + detail render unchanged, zero console errors
```

## Finale (zero-shot, after E2E green)

Worker task (pin `agentId: 43172bc2-3887-402b-a111-be451a083e3a` — lead steals
unpinned), NO format primer:

> "Restructure PM Inbox's `flag` column into two separate columns: `priority`
> (none|low|high) and `status` (open|watching|done). Keep every existing annotation —
> currently-flagged rows must come out right (urgent→high priority, watch→watching,
> done→done). Update the app's views and queries to use the new columns. Don't destroy
> any data — I may want to undo this."

Success bar: agent reaches it via app-get (+ optionally app-history) → app-patch
carrying `migration` `from: "flag"` mappings + `hidden: true` on flag (the "don't
destroy" sentence steers hide over purge; the seeded skill says prefer hide) →
≤1 self-corrected validation rejection; sqlite verifies all 15 rows carry mapped
`priority`/`status` AND still carry `flag` values; the `urgent` query is
migrated/replaced by the agent in the same patch; browser-verify the app renders with
the new columns. **Then part 2**: "roll PM Inbox back to before the restructure" →
agent uses app-history + app-rollback; definition restored (flag visible again, new
columns gone), all 15 original annotations intact — the round-trip the hide-not-delete
model exists to make free.

## Productization flags (log, don't fix)

- Dry-run scan is a full model read per definition write on row-holding models —
  fine at spike scale, wants sampling/streaming at 100k rows.
- In-process mutex (single API instance) now also serializes migrations — standing
  flag since spike 1, unchanged.
- app_versions unbounded growth (no pruning — matches workflows/pages).
- `definitionError` apps render as an error card only via the generic GET-error path;
  a dedicated "app needs repair" dashboard state is UI work.
- Hidden columns count toward the 40-column cap — long-lived apps will want purge
  hygiene or a raised cap.
- The `{connection, entity}` connector transition is format upgrade #3 waiting to
  happen — write it when connections land on apps.
