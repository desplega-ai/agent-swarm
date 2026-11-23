# Postgres schema notes (M3: baseline, triggers, runner, parity)

Branch `m3/schema`. Inputs: the SQLite chain at ordinal 367, plus the boot-created
`trg_users_default_role`. Outputs: `src/be/migrations/postgres/column-types.json`,
`scripts/storage/generate-postgres-baseline.ts` (→ `367_baseline.sql`),
`src/be/migrations/postgres/parts/triggers.sql`, `packages/storage-postgres/src/migrations.ts`,
`bun run check:schema-parity`, `bun run check:no-new-triggers`, and the Postgres part of
`scripts/check-migration-conflicts.sh`.

## 1. Column classification

`column-types.json` lists every head-schema column that is not plain TEXT/REAL/BLOB, plus
every TEXT column that looked like a timestamp or JSON (by name, default, `json_valid` CHECK
or declared `JSONB`): 613 columns in 137 tables.

| Class | Columns |
|---|---|
| `timestamptz`, format `iso-ms-z` | 239 |
| `timestamptz`, format `space` | 16 |
| `epoch-ms` | 22 |
| `boolean` | 45 |
| `jsonb` | 83 |
| `bigint` | 136 |
| `text` (not proven; each has a `reason`) | 72 |

Method:

- Writer evidence: five parallel read-only passes over the code (`src/`, `packages/storage*`,
  every SQL migration), one per table chunk, each entry with a `path:line` and the writer form.
  Rules: a DEFAULT counts as a writer when some INSERT omits the column; a backfill or a
  legacy-copy migration counts; caller text stored without normalization counts as unproven.
- Overrides applied on top of the passes (conservative):
  - `jsonb` → `text` where code compares, hashes or CAS-keys the stored JSON text (jsonb
    reorders keys): `extensions.configJson`, `scripts.signatureJson`, `scripts.argsJsonSchema`,
    `model_catalog_overlay.reasoningOptions`, `mcp_event_subscriptions.argumentsJson`.
  - `timestamptz` → `text` where a writer stores a caller ISO string checked by
    `z.string().datetime()` but not normalized to milliseconds (Postgres could not return
    the same text): `agent_tasks.deferredUntil`, `inbox_item_state.snoozeUntil`,
    `inbox_item_state.readAt`, `inbox_item_state.lastReadAt`; and `script_runs.startedAt`
    (older rows were written with `datetime('now')`).
  - `bigint` → `boolean` for four nullable 0/1 flags whose NULL means "unknown"/"not
    captured" (Postgres boolean keeps NULL): `model_catalog.reasoning`,
    `model_catalog_overlay.reasoning`, `runtime_instances.credential_ready`,
    `extension_assets.enabledBefore`.
- Empirical cross-check: every value of every classified column in a full `bun run e2e --keep`
  SQLite database (236 scenarios) plus eight earlier e2e databases. 433 of the 613 columns
  had values; no value fell outside its class (format, 0/1, integer, parseable JSON).

The 72 `text` columns and their reasons are in the file. The main groups: mixed timestamp
formats (a `datetime('now')`/`CURRENT_TIMESTAMP` default that fires on insert plus ISO
updates, or legacy rows copied by migrations 030/117 or the legacy boot import), sealed
ciphertext (`sealed:v1:`), caller text stored as given, enum or prose text that matched a
JSON-ish name, and the five key-order cases above.

Hazards for the M3 codec and repositories found on the way (not schema changes):

- Text comparisons of timestamps in SQL and JS (`rateLimitedUntil`, `automation_savings_*.computedAt`,
  `task_ui_action_runs.locked_until`/`last_run_at`, `channel_read_state.lastReadAt` against
  `channel_messages.createdAt`, `scheduled_tasks.lastUpdatedAt` string CAS between two reads).
- Equality fences on timestamps (`runtime_cache_releases.updated_at = ?`,
  `runtime_pools.updated_at = ?`): millisecond round-trip needed (timestamptz keeps µs).
- `reconcile_cursors` byte-compare (jsonb only causes a redundant write).
- `agent_tasks.tags` matched with `LIKE '%"heartbeat"%'`; `dependsOn` read with `json_each`.

## 2. Parity allowlist (`scripts/storage-checks/schema-parity-allowlist.txt`)

`bun run check:schema-parity` exit 0: 0 unexplained differences, 159 allowlisted (26 FTS
entries plus 133 `_rowid` surrogates under one line). 27 allowlist lines:

- `rowid-surrogate`: one line that covers the `_rowid` pattern of section 3. The check emits
  this key once for each table whose surrogate has the exact shape (bigint identity BY
  DEFAULT, NOT NULL, unique index `<table>__rowid_key`, seeded `_rowid` equal to the SQLite
  rowid). A wrong or missing surrogate, or a `_rowid` on a table that must not have one,
  gets its own key (`rowid-surrogate-shape:<table>`, `column:<table>._rowid`), which is not
  allowlisted.

The other 26 entries are all full-text search, milestone M4:

- `table:agent_tasks_fts`, `table:skills_fts`, `table:skills_meta_fts`: FTS5 virtual tables.
- 14 FTS5 shadow tables: `agent_tasks_fts_{config,data,docsize,idx}`,
  `skills_fts_{config,content,data,docsize,idx}`, `skills_meta_fts_{config,content,data,docsize,idx}`.
- 9 FTS sync triggers: `agent_tasks_fts_{insert,update,delete}`, `skills_fts_{insert,update,delete}`,
  `skills_meta_fts_{insert,update,delete}`.

`agent_tasks_fts_state` (the backfill watermark table) is a plain table and is in the
baseline with its seed row. Normalizations built into the check (not allowlist entries):
a PRIMARY KEY column counts as NOT NULL on the SQLite side (SQLite accepts NULL in a
non-INTEGER PK; Postgres does not); a rowid-alias INTEGER PK equals an identity column;
defaults compare by meaning (clock, clock-as-text with its format, random 32-hex id, epoch-ms
clock, literal); seeded clock/random values compare by shape; jsonb values compare in
canonical key order; `_migrations` compares by column names (its rows differ by design).
A mutation run (one CHECK value, one default, one NOT NULL, one FK action, one index
predicate, one trigger, one seeded value) reported all seven.

## 3. rowid dependencies and the `_rowid` surrogate

**Decision (lead, M3):** every baseline table that has a SQLite rowid and no INTEGER PRIMARY
KEY alias gets `"_rowid" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL` as its last
column, plus `CREATE UNIQUE INDEX "<table>__rowid_key" ON <table> ("_rowid")`. That is 133
tables. Exceptions: `kv_entries` (WITHOUT ROWID), the FTS tables (not in the baseline), and
the 6 tables whose INTEGER PRIMARY KEY already is the rowid (`agent_tasks_fts_state`,
`chat_queue`, `human_free_reclassify_queue`, `model_alias_resolutions`, `model_catalog_meta`,
`slack_render_v2_state`; these get an identity on that key). Reasons: `session_logs` exposes
`rowid AS seq` in the API, `human_free_reclassify_queue.afterRowid` stores `agent_tasks`
rowids, and about 140 repository ORDER BYs tie-break on rowid. BY DEFAULT (not ALWAYS) lets
the data copy (D11) write each SQLite rowid into `_rowid`, so API values stay equal on both
engines; the copy must reset the sequences after it (D11 step 7). The generator emits the
column and index (`HeadTable.surrogateRowid` in `scripts/storage/sqlite-head.ts`). It
inserts each seeded row with its SQLite rowid in `_rowid` and runs `setval` after each seeded
table (the chain's seed rowids are checked to be the same across two runs). The Postgres
repositories still have to use `"_rowid"` wherever the SQLite SQL says `rowid`; that work is in
the repository port, not in the schema. A test in `packages/storage-postgres/test/baseline-triggers.test.ts`
proves insertion order, the unique index, the seeded values, and that the excepted tables have no
`_rowid`. A mutation run (a missing index, a non-identity `_rowid`, a wrong seeded rowid, a
`_rowid` on `kv_entries`) failed the parity check on all four.

Code relies on rowid in three ways (all now map to `_rowid`):

1. **rowid is the only order** (insertion order cannot be rebuilt from other columns):
   - `session_logs`: `ORDER BY rowid` and `SELECT rowid AS seq` (`src/be/db.ts:4871,4928-4948`,
     `src/be/seed-scripts/catalog/compound-insights{,.inline}.ts:577`). `seq` reaches callers.
   - `human_free_reclassify_queue.afterRowid` stores an `agent_tasks` rowid cursor
     (`src/be/db/tasks/human-free.ts:381-384`).
   - `agent_tasks_fts_state.indexedThrough` is an `agent_tasks` rowid watermark; the FTS
     triggers and the backfill page by rowid (`src/be/db/tasks/search-index.ts:99-183`).
   - Insertion-order lists with no other key: `packages/storage-sqlite/src/repositories/`
     `runtime-pools.ts` (11-124), `workflows.ts` (28-147, including `MAX(rowid)` and
     `rowid > (SELECT rowid ...)` step cursors), `users.ts` (15-138), `assets.ts` (21-55),
     `config.ts` (19-76), `oauth.ts` (12-69), `scripts.ts` (24-65), `slack.ts` (115-146),
     `mcp-servers.ts:14`; the base classes mark these methods abstract
     ("Insertion-order tiebreak differs per engine").
2. **rowid as the tiebreak after a timestamp** (`ORDER BY createdAt, rowid`): `agent_tasks`
   (`src/be/db.ts:1078,2465,3572,3641,3688,7307,12229`, `src/be/db/tasks/read.ts:531-2094`,
   `src/be/db/tasks/write.ts:1274,1294`, `src/be/db/session-tree.ts:911`), `task_attachments`
   (`src/be/db.ts:1973`, `src/be/db-queries/task-artifacts.ts:155`), `task_steering_messages`
   (`src/be/db.ts:2099-2133`), `session_shares` (`src/be/session-shares.ts:178,189,259`),
   `agents`, `agent_history`, `context_versions` (`packages/storage-sqlite/src/repositories/agents.ts`),
   `events`, `extensions`, `tracker_sync`, `tracker_agent_mapping`. Two writes in one
   millisecond tie on the timestamp, so these need a total order on Postgres too.
3. **rowid as a physical handle** (batch deletes and keyset pages): `src/be/db-retention.ts:384-417`
   (every retention table), `src/be/pricing-refresh.ts:95-99`, `src/http/memory.ts:1635`,
   `src/be/memory/providers/sqlite-store.ts:59-313` (memory_fts is outside the chain),
   `src/be/db/tasks/read.ts:1166-1172` (page by rowid then join), `src/be/db/users/references.ts:56`,
   `packages/storage-sqlite/src/boot/legacy.ts:68`. A primary key or `ctid` can replace these
   per site.

## 4. Defaults and CHECKs translated by rule

Every default, CHECK, index key and partial predicate goes through `scripts/storage/pg-translate.ts`;
the generator fails on anything without a rule. Rules that needed a choice:

- Clock defaults: `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, `datetime('now')`, `CURRENT_TIMESTAMP`
  → `statement_timestamp()` on a `timestamptz` column. On a column that stays `text`, the
  default keeps the SQLite text format of its own form: `to_char(statement_timestamp() AT TIME
  ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` (5 columns: `oauth_apps.createdAt/updatedAt`,
  `oauth_authorizations.createdAt/updatedAt`, `runtime_instances.created_at`) or
  `'YYYY-MM-DD HH24:MI:SS'` (20 columns, e.g. `users.createdAt`, `workflows.createdAt`,
  `pages.updatedAt`, `seed_state.seededAt`, `checklist_items.*`, `tracker_*`).
- `lower(hex(randomblob(16)))` → `replace(gen_random_uuid()::text, '-', '')` (18 columns;
  32 lowercase hex characters; a v4 UUID fixes 6 of its 128 bits).
- `CAST(unixepoch('subsec') * 1000 AS INTEGER)` → `(floor(extract(epoch FROM statement_timestamp()) * 1000))::bigint` (6 columns).
- 0/1 defaults on boolean columns → `false`/`true`; `'[]'`, `'{}'`, `'null'` on jsonb → `'…'::jsonb`.
- `INTEGER PRIMARY KEY` (rowid alias, 6 tables) → `bigint GENERATED BY DEFAULT AS IDENTITY`;
  the one seeded identity table (`agent_tasks_fts_state`) gets a `setval` after its seed.
- CHECK `flag IN (0, 1)` on boolean columns → `IN (false, true)` (7 CHECKs).
- `json_valid(x)` → `(x IS JSON)` on text; on jsonb `(x IS NOT NULL OR NULL::boolean)` (NULL
  stays NULL, as SQLite's `json_valid(NULL)`): `routing_decisions.worker_statuses`,
  `.continuity_candidates`, `runtime_cache_releases.runtime_ids`, `runtime_pools.cache`,
  `.workspace`, and the `idx_workflow_runs_context_requester` expression.
- `json_type(x) = 'array'|'object'` → `jsonb_typeof(x)` (only those two names, which agree).
- `json_extract(x, '$.a.b')` → `x #>> '{a,b}'` (text result; used only under `IS NOT NULL`
  in `idx_workflow_runs_context_requester`).
- `IS NOT <value>` → `IS DISTINCT FROM`; `GLOB 'p*'` → `LIKE 'p%'`; `LIKE` → `ILIKE` (C ctype
  folds ASCII only, like SQLite); `instr` → `strpos`; `substr` only with a literal positive start.
- The view `session_summary_recompute` is ported by hand (`SELECT NULL::text AS "rootId"`).
- Seeded rows: values that differ between two chain runs on different seconds (clock or
  randomblob) become the matching expression: `metrics.id` and `task_templates.id` (random
  hex), `channels.createdAt`, `metrics.createdAt` (timestamptz), `metrics.updatedAt`,
  `roles.*`, `role_permissions.createdAt`, `task_templates.createdAt` (clock as text/timestamptz
  by class). The output is byte-identical across runs (`--check`).

## 5. Trigger ports that needed judgment

56 of the 65 head triggers are ported (`parts/triggers.sql`); the 9 FTS sync triggers wait for
M4. The head has 65 triggers in total, `trg_users_default_role` included: migration 109
creates it and the boot code recreates it if missing (the brief's "65 plus" counts it twice).

- **Asset keys (14 validators)**: one shared `asset_key_is_invalid(text)` function, checked
  step by step, because Postgres does not promise left-to-right OR/AND evaluation and the
  `personal/<user>/` lookup must not run on a key that failed the shape checks.
  `instr(key, char(0)) > 0` has no port (Postgres text cannot hold a NUL byte; such a write
  fails earlier with 22021). `substr(key, -1, 1)` → `right(key, 1)`. `LIKE` → `ILIKE`.
- **`session_task_insert`**: `INSERT OR REPLACE` → `ON CONFLICT (pk) DO UPDATE` of every
  column (each statement lists every column, so the delete+insert of REPLACE is the same row).
  `openTaskCount + (status NOT IN (...))` → `(... )::int`. Scalar `MAX(a, b)` → a CASE around
  `GREATEST` that returns NULL when either side is NULL (both columns are NOT NULL today).
- **`session_summary_recompute_apply`**: `latestStatus` is `ORDER BY lastUpdatedAt DESC LIMIT 1`,
  kept as is: ties pick an unspecified row on both engines (the e2e scenario accepts any tied
  status). `lastHumanAt` is `MAX` over `agent_tasks.createdAt`, `task_steering_messages.created_at`
  and `approval_requests.createdAt`: SQLite compares text, Postgres compares instants. Equal
  while all three hold `iso-ms-z` (the classification evidence: every approval insert passes
  an ISO value even though the column default is `CURRENT_TIMESTAMP`).
- **Row-trigger timing**: SQLite runs an AFTER trigger after each row; Postgres queues AFTER
  ROW triggers to the end of the statement. For a multi-row UPDATE of `agent_tasks`, the
  recompute subqueries see the final state on Postgres. The session aggregates end equal
  (GREATEST is order-free, the recompute is idempotent).
- **Firing order**: Postgres fires triggers of one event in name order; SQLite in its own
  order. This matters only for which message wins when two BEFORE triggers would both refuse
  one write (for example an invalid key and a missing profile).
- **`reopen_slack_tree_after_outcome_update`**: its UPDATE of `slack_messages` fires it again
  on Postgres (SQLite does not recurse); the `kind = 'outcome'` test stops at the tree rows.
- **Clock values in trigger bodies** (`cancel_approval_request_after_workflow_step_cancel`,
  `detach_asset_key_mapping_before_attachment_delete`) → `statement_timestamp()`; the target
  columns are `timestamptz`.
- **Errors**: `RAISE EXCEPTION 'msg'` keeps the text; the SQLSTATE is P0001 where SQLite reports
  `SQLITE_CONSTRAINT_TRIGGER`. `errors.ts` does not map P0001 yet (M3 step 4).
- **`trg_users_default_role`** is in the baseline; the boot-time `CREATE TRIGGER IF NOT EXISTS`
  in `src/be/rbac-roles.ts` must stay SQLite-only.

## 6. Other findings

- `src/tests/preload.ts` hashed every entry of `src/be/migrations/` and crashed on the new
  `postgres/` directory (EISDIR), which would have failed every root unit test. Fixed to hash
  `.sql` files only.
- `scripts/check-migration-conflicts.sh`: git's `src/be/migrations/*.sql` pathspec also matches
  subdirectories, so `postgres/367_baseline.sql` was flagged as a duplicate of 367 and as not
  above the tail. The SQLite monotonicity check and the stale-PR commenter workflow now read
  top-level files only. The immutability check stays recursive, so once merged the Postgres
  baseline and `parts/triggers.sql` are immutable too.
- The Dockerfile copies only `src/be/migrations/*.sql`; the Postgres chain is not in the image
  yet (needed when the server boots on Postgres).
- `_migrations.applied_at` is `timestamptz` on Postgres (text ISO on SQLite).
- `packages/storage-postgres/test/*` run with the root preload (bunfig), which builds a SQLite
  test template first; harmless but slow (about 5 s).
