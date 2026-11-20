---
date: 2026-11-20T11:06:01+0100
author: Taras
topic: "Postgres as a second storage engine"
tags: [brainstorm, database, postgres, sqlite, migrations, e2e, goal-prompt]
status: complete
exploration_type: idea
last_updated: 2026-11-20
last_updated_by: Claude
---

# Postgres as a second storage engine: Brainstorm

## Context

Taras wants a goal prompt for a long-running agent that adds Postgres as a storage engine next to SQLite. His starting shape:

1. Make the black-box e2e suite strong enough to prove that SQLite and Postgres are both supported 100% (backward compatibility).
2. Multi-engine migrations are acceptable if CI proves they stay in sync and valid.
3. A small custom ORM-like abstraction: a query repository for engine-specific queries, plus simpler handling for simple statements (SELECTs). Inspiration: the `storage` abstraction in Mastra.

Deliverable of this session: the goal prompt, not the implementation.

What we already know (verified 2026-11-20):

- `src/be/db.ts` is 14,749 lines. `src/be/db-client.ts` (807 lines) is the async seam (`query` / `get` / `run` / `transaction` / `afterCommit`). There are also `src/be/db/**` and `src/be/db-queries/**` modules.
- 258 forward-only SQL migration files in `src/be/migrations/`.
- `scripts/e2e/db.ts` is the only e2e file allowed to import `bun:sqlite`.
- No `DB_DRIVER` flag exists in `src/` or `scripts/`. The Worker-backed driver chosen on 2026-11-12 has not landed.

Earlier research (2026-11-12, `thoughts/taras/research/2026-11-12-async-db-and-query-engine-abstraction.md`, in worktree `t3-6b7c0548`):

- Measured: every in-process SQLite driver on Bun blocks the main thread.
- Decided then: Worker-backed `DbClient` plus a dialect lint. Postgres was judged 2 to 3 months plus a permanent dual-migration cost, worth it only if multi-replica is a product goal. ORMs (Drizzle, Kysely, Prisma) were rejected for the existing corpus.
- Issue #1227 lists pre-Postgres blockers: memory-store async init, prompt-template resolver seam, RBAC trigger SQL, db-query introspection.

Background research workflow `wf_a7ef1b30-c58` (9 tracks) is running: prior research digest, SQL dialect inventory, seam and boot path, migrations, tests and CI, ops and exposed SQL, Mastra storage, drivers and test infra, dual-engine precedents.

### Research digest (workflow `wf_a7ef1b30-c58`, 9 tracks, 2026-11-20)

Counts come from ripgrep and are upper bounds. Recount before any plan uses them.

**The seam is narrow. The SQL text is the problem.**

- `DbClient` = `query` / `get` / `run` / `transaction` / `runTimed` / `afterCommit` / `afterRollback` over SQL text plus positional `?` params. 1,464 `getDbClient()` call sites in 203 files. One implementation: `BunSqliteClient` (`db-client.ts:412-807`).
- Engine-neutral parts already in the client: AsyncLocalStorage transaction routing, nested SAVEPOINT, commit and rollback hooks, `deadlineAt`. Engine parts: FIFO lock, `BEGIN IMMEDIATE`, BUSY retry, `SELECT changes()`, time slicing.
- About 1,800 to 2,200 statements outside tests and migrations. Estimate (judgement, not measured): 40 to 45% portable as written, 35 to 40% need a mechanical rewrite, 15 to 20% need an engine-specific implementation.
- Mechanical class: `?` to `$n` (179 WHERE-fragment builders, 144 IN-list expansions), the `strftime('%Y-%m-%dT%H:%M:%fZ','now')` idiom, `IS NOT` on values (231), case-insensitive `LIKE` (111), `INSERT OR IGNORE/REPLACE` (24), `rowid` (117), `GLOB` (41), `changes` / `lastInsertRowid` (153).
- Engine-specific class: FTS5 (4 virtual tables plus `memory_fts`), sqlite-vec (`memory_vec`), `json_each` (19 files), `json_extract` (62), PRAGMA (28), the db-query reader.
- Row shapes: timestamps are TEXT ISO strings (83 `createdAt TEXT` columns, 674 `toISOString()` sites), JSON is TEXT plus `JSON.parse` in about 47 `rowTo*` mappers, booleans are 0/1.
- Identifier case: the schema uses camelCase columns. Postgres folds unquoted identifiers to lowercase, so result row keys change unless the engine maps them back or every identifier is quoted.
- Leaks around the seam: 19 files in the `check-async-db-seam.sh` allowlist (it grew from 14, although #1227 is closed), a synchronous `initDb` that runs migrations and seeds, 3 runtime `new Database` openers (db-query reader, bounded child, memory search worker), about 14 sites that match SQLite error text, about 35 non-test files that import `bun:sqlite`.

**Migrations**

- 256 SQL files (ordinals 001 to 348). Head schema: 157 tables (139 without FTS shadow tables), 415 indexes (172 partial), 220 foreign keys, 83 tables with CHECK, 65 triggers, 1 view, about 1,811 columns (TEXT 1,507, INTEGER 211).
- 65 triggers hold business rules: asset-key validation (about 16), model profile and group checks (about 14), session maintenance (about 14), FTS sync (9), Slack and chat relay (about 9), immutability, RBAC default role.
- 28 table-rebuild files, 123 files with DML, 105 column defaults that call SQLite functions (4 patterns).
- No schema snapshot and no drift check exist today. `check-audit-columns.ts` already replays migrations and introspects, so it is a template for a parity check.
- Researcher recommendation: generate one Postgres baseline from the SQLite head, then paired per-engine files from that ordinal onward, gated by a normalised introspection diff. Hand-translating 256 files recreates states nobody needs. A neutral DSL cannot convert old files because of the immutability check.

**Tests and CI**

- The black-box suite boots the real API on a temp SQLite file and reads the DB through a read-only handle. 176 scenario files, 97 use `ctx.db` (SELECT-only assertions). `scripts/e2e/db.ts` is 34 lines.
- The suite is engine-blind. It does not exercise FTS ranking, vector order, collation, NULL ordering, pagination stability, isolation, upgrade from an old DB, or retention. One concurrency scenario exists (`poll-concurrent-claim.ts`).
- About 660 unit test files (59%) are bound to SQLite. `packages/ui-e2e` writes to the SQLite file directly to backdate rows.
- CI already runs a `postgres:16-alpine` service container (`ci.yml:367`) for the script-connections test. An engine dimension on the 4 e2e shards costs about double the runner minutes and no critical-path time.

**Ops and exposed SQL**

- `db-query` (MCP tool, `POST /api/db-query`, `ctx.swarm` in scripts, a seeded guidance skill) exposes the SQLite dialect to agents. Its table denial uses SQLite bytecode and `sqlite_master`. A Postgres port is a security-sensitive rewrite.
- Swarm Apps expose no SQL (rows live in `kv_entries`). No workflow node runs raw SQL.
- Helm chart fails to render unless `api.replicas == 1`. Litestream sidecar is SQLite-only. 19 docs-site pages name SQLite.
- Blockers for more than one replica: heartbeat and scheduler timers, 12 sweeps with no leader election, in-memory realtime bus and rooms, the in-process event bus, OAuth and user-merge mutexes, module-level caches.
- No export or import tool exists. A SQLite to Postgres data migration tool is new work.

**External**

- Mastra: one abstract class per domain, a composite store, one shared `TABLE_SCHEMAS` map rendered into DDL at init, hand-written SQL per engine, and a shared test suite (`createTestSuite`) that every store runs. It has no migration files, and that caused drift and boot-race bugs (#16782, #21671, #26228, #29694). Worth copying: domain interfaces, the shared parity suite, schema as data for a drift check. Not worth copying: init-time DDL, per-domain engine composition, two full SQL implementations of every method.
- Drivers: `Bun.SQL` covers pool, `sql.begin`, savepoints, `reserve`, `sql.unsafe` with `$1`, LISTEN/NOTIFY, and works in a compiled binary. It is already used in `src/be/sql-connections.ts`. Type defaults differ from SQLite: bigint and numeric as strings, jsonb parsed, timestamps as `Date`. Its open-bug list is unverified.
- PGlite is single-connection, so it hides concurrency bugs. A real Postgres service container is the honest gate.
- Portable search baseline: native `tsvector` plus pgvector. BM25 extensions are thin on managed hosts. Ranking will not equal FTS5 `bm25()`.
- Precedents: Temporal and Vaultwarden use per-engine schema directories. Gitea and Temporal run one shared integration suite per engine in a CI matrix, and Gitea restores historical dumps to test upgrades. No project in the set runs a cross-dialect schema diff in CI. Drift between parallel chains (Prefect, Forgejo) and silent semantic differences (collation, type names, lock errors) are the failure patterns. Zitadel dropped an engine because of the test load.

## Exploration

### Q: What is the main driver for Postgres now?
"It's basically 2 and 3": kill the event-loop stalls, and run more than one API replica.

**Insights:**
- This reverses the 2026-11-12 ordering. Postgres becomes the stall fix, so the Worker-backed SQLite driver loses its main reason. SQLite installs keep their stalls unless that work continues.
- Multi-replica is the largest scope item. It is a separate problem from engine parity (timers, sweeps, bus, mutexes, caches), and none of it can start before a second engine exists.
- Both drivers apply to the production swarm, which holds data in SQLite today. A SQLite to Postgres data migration path is therefore required, not optional.
- PGlite cannot be the parity gate: it has one connection, and concurrency is the point.

### Q: How should the goal be split (parity versus multi-replica)?
Taras first asked: "wouldn't multi-replica just work if you have connection pools?" He also set a rule: multi-replica needs Postgres, and it is fine to block it on SQLite. After the answer below: "let's focus on first goal, but remember the limitations of it".

Answer to the pool question (spot-checked in code):
- A pool fixes database concurrency only.
- `src/realtime/bus.ts` (`InProcessBus`) and `src/workflows/event-bus.ts` are in-memory EventEmitters. A client on replica B misses events from replica A.
- `src/oauth/ensure-mcp-token.ts` holds its refresh lock in an in-memory `Map`.
- Config and model caches invalidate per process.
- `claimScheduleOccurrence` (`src/scheduler/scheduler.ts:349`) relies on `BEGIN IMMEDIATE`, the SQLite single writer. This breaks with one process on a pool, because pooled connections run transactions at the same time.

**Insights:**
- Decision: this session delivers the goal prompt for parity with one API process. Multi-replica is a later goal and is Postgres-only.
- Read-then-write claims that depend on the single writer are parity work, not replica work. The goal must find them all and give each one a Postgres-safe form.
- The goal must record its limits: one API process, the chart `replicas == 1` guard stays, and it leaves a replica-blocker inventory for the next goal. It must add no new in-process-only state.

### Q: Which shape for the query abstraction?
"I think we can do mastra style, as it will be safer and enforceable, and I'm fine with the implications as far as we can enforce with tests and lint rules. We could add a sort of 'trait' for things that are only supported in specific dialects. Imagine in the future adding libsql support."

**Insights:**
- Decision: domain repositories with an interface per domain. The interface is the contract that tests and lints enforce.
- Decision: engines declare capabilities ("traits"), for example full-text search kind, vector search, listen/notify, multi-process safety. Features gate on a capability, never on the engine name.
- The repository layer already exists informally: `src/be/db.ts`, `src/be/db/**` and `src/be/db-queries/**` are functions over SQL. SQL also lives in `src/http` (28 files), `src/be/memory` (15), `src/workflows` (12), `src/tools` (10), `src/apps` (6). All of it must move behind the interfaces.
- A future libsql engine is the SQLite dialect with another driver. Driver and dialect are separate axes.

### Q: How much SQL is duplicated per engine?
"Ok to 1 (shared base + overrides), we should use our monorepo structure to enforce this!"

**Insights:**
- Decision: a base repository per domain holds the portable SQL, written with dialect helpers. `Sqlite*` and `Postgres*` classes override only the methods that differ. A feature PR writes most SQL once.
- Decision: package boundaries enforce it. The repo already has `packages/*` workspaces and `bun run check:dep-graph` (dependency-cruiser, `.dependency-cruiser.cjs`). Sketch: a contracts package (interfaces, capabilities, dialect helpers, base repositories), a SQLite package (the only importer of `bun:sqlite`), a Postgres package (the only importer of the Postgres driver). `src/` imports the contracts and one composition root.
- Open design point for the goal agent: packages cannot import from `src/`, and entity types live in `src/types.ts`. The agent must choose where shared entity types live and state the rule.

### Q: How does the goal agent land its work, and who merges?
"It will be a one shot yolo PR with all. I'll make sure to stop merges to ensure no issues."

**Insights:**
- Decision: one branch, one PR. Taras freezes merges to main while it runs.
- No human reviews the slices, so the gates are the review. The goal prompt must make every claim checkable by a command.
- The branch still needs internal checkpoints (commits per milestone that pass the SQLite gates), so a failure late in the run does not lose earlier work.
- Call-site churn is the main size risk. `src/be/db.ts` exports functions that thousands of callers and about 660 unit test files import. Keeping those exports as thin delegates to the repositories keeps the diff bounded.

### Q: How does Postgres store values?
"I'm fine with native now, we can do the cleanup later." Confirmed reading: Postgres-native types from day one (`timestamptz`, `jsonb`, `boolean`). The cleanup later is the removal of the conversion layer.

**Insights:**
- Decision: native Postgres types. Repositories return the same domain values on both engines, so the Postgres side converts at the repository boundary (a column codec map from the schema snapshot is the obvious tool).
- Hazard: SQLite holds two timestamp string formats. 44 column defaults produce `2026-11-20T10:00:00.000Z`, and 37 produce `2026-11-20 10:00:00` (`datetime('now')`). API responses expose these strings. The Postgres codec must give each column the format that SQLite gives it, or the goal must normalise both engines and say so.
- Hazard: `jsonb` does not keep key order, duplicate keys or whitespace. Any code that compares or hashes stored JSON text can differ.
- Hazard: `Bun.SQL` returns bigint and numeric as strings and reads non-tz timestamps as UTC. Use `timestamptz` only, and set bigint handling explicitly.
- The data migration tool must convert values (text to timestamptz, text to jsonb, 0/1 to boolean), not copy bytes.

### Q: What is the writer model on Postgres?
First answer: "Concurrent by default". Then: "we should support serializable in pg". Then a doubt: "1 has perf implications right? like at real scale". Final answer: SERIALIZABLE by default, with measured opt-down.

Facts given to Taras:
- Postgres detects serialization conflicts only between transactions that are both SERIALIZABLE. Using it for a few transactions protects little.
- A serialization failure (SQLSTATE 40001) re-runs the whole transaction callback. SQLite never re-runs a callback today (its BUSY retry acts at BEGIN, COMMIT and single statements).
- SERIALIZABLE does not block more than snapshot isolation. Its costs are lock-tracking overhead (a few percent to low double digits in the Postgres SSI paper, not measured on this workload) and retries on rows that many transactions touch (poll claim, agent heartbeat updates).
- SQLite runs one writer at a time on the main thread today, so either model is above current capacity.

**Insights:**
- Decision: every Postgres connection defaults to SERIALIZABLE. The client retries on 40001 with bounded backoff.
- New rule with a lint: a transaction callback must be safe to run twice. No HTTP calls and no event emits inside it. Side effects go to `afterCommit`.
- Decision: the goal must measure. The e2e bench on Postgres reports the retry rate and p95 per route group against SQLite, and a stress scenario runs many workers polling. A path over the retry budget moves to READ COMMITTED with an explicit lock (for example `FOR UPDATE SKIP LOCKED` on the poll claim), with a written reason and its own stress scenario.
- The agent still lists the transaction sites (about 290), because it needs the list to find callbacks with side effects.

### Q: What happens to the 65 triggers on Postgres?
Port to plpgsql, ban new ones.

**Insights:**
- Decision: each SQLite trigger gets a hand-written Postgres trigger function with the same name and rule. A parity check compares trigger names per table. One e2e scenario per trigger group proves the rule on both engines.
- Decision: no new triggers from now on. New rules go in repository code. A CI check rejects `CREATE TRIGGER` in new migrations.
- SQLite migrations and behaviour do not change.

### Q: What does `db-query` do on Postgres?
Native dialect per engine.

**Insights:**
- Decision: `db-query` runs the SQL of the active engine. The tool description and the seeded guidance skill come from the engine capabilities.
- Security finding: a `SET LOCAL ROLE` inside the transaction is not a boundary. User SQL can call `RESET ROLE` or `set_config('role', ...)`. The only robust form is a second connection that logs in as a restricted role.
- Default: the operator supplies `DATABASE_QUERY_URL` for a role with SELECT on the allowed tables only. A boot probe checks that the role cannot read the 7 denied tables and cannot write. If the URL is absent or the probe fails, `db-query` is off on Postgres.
- The 281 SQL lines in `src/be/seed-scripts` move to SDK calls or get one text per dialect.

### Q: When does the SQLite to Postgres data move ship?
In this goal.

**Insights:**
- Decision: the goal ships a copy command (SQLite file to an empty Postgres database at the same migration head), its e2e proof and a runbook. Taras runs the production cutover.
- The command converts values (text to `timestamptz`, text to `jsonb`, 0/1 to `boolean`), disables user triggers during the copy, rebuilds the full-text and vector data, resets sequences, and verifies row counts and a checksum per table.
- Hazard: Postgres rejects NUL bytes and invalid UTF-8 in `text` and `jsonb`. SQLite stores them. Session logs and tool output can hold both. The command must report each bad value, not drop it silently.

## Synthesis

### Key Decisions

Decided by Taras:

1. **Scope**: Postgres parity with one API process. Multi-replica is a later goal and is Postgres-only.
2. **Query layer**: one repository interface per domain. A base class holds the portable SQL. `Sqlite*` and `Postgres*` classes override only what differs. Engines declare capabilities, and features gate on a capability.
3. **Enforcement**: monorepo packages plus dependency-cruiser plus lints. No SQL and no driver import outside the storage packages.
4. **Landing**: one branch, one PR. Taras freezes merges to main.
5. **Postgres types**: native (`timestamptz`, `jsonb`, `boolean`). Conversion at the repository boundary.
6. **Writers**: SERIALIZABLE on every connection, bounded retry on 40001, callbacks safe to run twice, measured opt-down to READ COMMITTED plus explicit locks.
7. **Triggers**: port all 65 to plpgsql with the same names. Ban new triggers.
8. **db-query**: native dialect per engine.
9. **Data move**: copy command in this goal. Production cutover is Taras's.

Deferred, defaulting to the value below (Taras did not confirm these, change them in the goal prompt review):

10. **Migrations**: one generated Postgres baseline at the SQLite head, then paired per-engine files, gated by a normalised introspection diff and a fresh-database row diff.
11. **Identifier case**: Postgres keeps the camelCase column names, and all SQL quotes them. Reason: a missed quote fails loudly on Postgres, and a result-key mapping layer fails silently. Cost: every statement and 97 scenario files change (a codemod plus a lint).
12. **Driver**: `Bun.SQL`, proven by a spike first. Fallback: `postgres` (postgres.js) behind the same driver interface.
13. **Postgres version**: 16 or later with pgvector. Full-text search uses the built-in `tsvector`.
14. **Search parity**: same result sets on a fixture corpus. Vector order is exact. Full-text ranking is compared by top-k overlap.
15. **Test gate**: a real Postgres service container. No PGlite. The Postgres e2e leg is required in the merge gate. The 660 SQLite unit tests and the UI e2e suite stay SQLite-only.
16. **Engine selection**: `DATABASE_URL` (reserved, env-only, scrubbed). Absent means SQLite through `DATABASE_PATH`. A data directory setting, independent of the engine, locates the key and secret files.
17. **Forced replay mode**: a test-only switch runs every transaction callback twice. The strict suite must pass with it on. This proves rule 6 by execution.
18. **One-process guard**: on Postgres the API takes a session advisory lock at boot. A second API process on the same database fails at boot.
19. **Bench thresholds**: zero exhausted retries and zero 5xx are hard gates. The retry rate and the p95 ratio are reported. A site above a 5% retry rate in the stress scenario moves to READ COMMITTED plus a lock.
20. **Call-site churn**: `src/be/db.ts` exports stay as thin delegates.
21. **Out of scope**: the Worker-backed SQLite driver, LISTEN/NOTIFY, multi-replica, removal of SQLite.

### Open Questions

Fact-shaped, for the goal agent to answer in its first milestone:

- Does `Bun.SQL` at the pinned Bun version pass the spike (pool, transaction pinning, savepoints, `bytea`, `jsonb`, error codes, compiled binary)?
- How many statements and transaction sites exist at the branch point? The counts in this document are upper bounds.
- Which columns hold which timestamp format, and which hold values that are not valid timestamps?
- Which transaction callbacks have side effects today?
- Which sites catch a constraint error inside a transaction and continue? Postgres aborts the transaction there.
- Where do shared entity types live, given that packages cannot import from `src/`?

### Constraints Identified

- The 256 SQLite migration files stay byte-identical. A default boot (no `DATABASE_URL`) behaves as before.
- No human reviews slices, so every claim needs a command that proves it.
- No scenario may lose an assertion. Scenario edits are limited to SQL portability and helper use.
- No ORM and no query builder dependency. No regex rewrite of placeholders at run time.
- No new unit tests for API code. Repository contract tests live under `packages/` (allowed by `scripts/unit-test-allowlist.txt`).
- The chart `replicas == 1` guard stays. The goal adds no new state that lives only in one process.
- `db-query` on Postgres needs a restricted login role. The application cannot build that boundary with SQL filtering.

### Core Requirements

- `bun run e2e:strict` passes on SQLite and on Postgres with the same scenario list and no engine skips.
- New divergence scenarios pass on SQLite first, then on Postgres: search, order and ties, collation, NULL order, timestamp formats, JSON round trip, error mapping, concurrency, each trigger group, retention, upgrade.
- A schema parity check and a fresh-database row parity check run in CI.
- Lints hold the package boundary, the identifier quoting, the trigger ban and the transaction callback rule.
- The data copy command has an e2e proof that compares API responses before and after the copy.
- A bench report states the retry rate and p95 per route group for both engines.
- Docs, chart, compose example and runbook describe Postgres. A replica-blocker inventory lists what the next goal must fix.

## Next Steps

- Goal prompt: `thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine-goal-prompt.md`. Taras reviews it with file-review.
- After the review: Taras freezes merges and starts the goal agent in a fresh worktree from `origin/main`.
- Later goal: multi-replica on Postgres, starting from the replica-blocker inventory.
