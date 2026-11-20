---
date: 2026-11-20T16:40:00+0100
author: Taras
topic: "Goal prompt: Postgres as a second storage engine"
tags: [goal-prompt, database, postgres, sqlite, migrations, e2e]
status: draft
last_updated: 2026-11-20
last_updated_by: Claude
---

# Goal prompt: Postgres as a second storage engine

Source of the decisions: `thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine.md`.

Note for the review (delete before use): each decision in section 5 has a tag. `(Taras)` means you decided it in the brainstorm. `(default)` means I chose it and you did not confirm it.

## Short form for `/goal`

```
Add Postgres as a second storage engine to agent-swarm. Obey the brief at
/Users/taras/Documents/code/agent-swarm/thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine-goal-prompt.md.
The goal is complete only when every check in section 3 of the brief passes,
the ledger records the output of each check, and the pull request is open with
green CI. Do not merge the pull request.
```

## Full brief

### 1. Goal

The agent-swarm API server must run on SQLite or on Postgres. One environment variable selects the engine. The same black-box contract must pass on both engines. An installation that sets no new variable must behave as it does today.

This goal covers parity with one API process. It does not cover more than one API replica.

### 2. Terms

Use each term with one meaning.

- **Engine**: SQLite or Postgres.
- **Driver**: the library that sends SQL to an engine (`bun:sqlite`, `Bun.SQL`).
- **Dialect**: the SQL language of an engine. Driver and dialect are independent. A future libsql engine is the SQLite dialect with a different driver.
- **Capability**: a named feature that an engine declares, for example `fullTextSearch`, `vectorSearch`, `dbQuery`. Code tests a capability. Code never tests the engine name.
- **Repository**: the interface of one data domain, plus its implementations.
- **Storage packages**: the workspace packages under `packages/` that hold the repositories, the dialect helpers and the drivers.
- **SUT**: the API process that the e2e runner starts.
- **Strict suite**: `bun run e2e:strict`.
- **Ledger**: `thoughts/taras/plans/2026-11-20-postgres-storage-engine-ledger.md`. You create it and keep it current.
- **Base commit**: the `origin/main` commit where your branch starts.

### 3. Done condition

Every check below must pass on the final commit. Record the command and its output summary in the ledger. Where a command does not exist, create it with the name given here.

**Contract on both engines**

1. `bun run e2e:strict` passes on SQLite.
2. `bun run e2e:strict --engine postgres` passes on Postgres 16 with pgvector.
3. Checks 1 and 2 run the same scenario list. No scenario is skipped for one engine. No scenario file names an engine.
4. `bun run e2e:strict --engine postgres --tx-replay` passes. In this mode the client runs each transaction callback two times (see decision D6).
5. The divergence scenarios of milestone M1 exist and pass on both engines.
6. The coverage manifest has no new exclusion.

**Schema and migrations**

7. `bun run check:schema-parity` passes. It applies both migration chains to empty databases and compares the two schemas and the seeded rows.
8. `git diff <base commit> -- src/be/migrations/*.sql` shows no change to a file that exists at the base commit.
9. `bash scripts/check-migration-conflicts.sh` passes and also covers the Postgres chain.
10. A scenario proves that a SQLite database file made by the base commit starts on the branch and serves requests.

**Boundaries and rules**

11. `bun run check:dep-graph` passes and includes the storage packages. Its rules reject a driver import outside the driver package of that engine.
12. `bun run check:storage-boundary` passes. No file outside the storage packages contains SQL text or imports `DbClient`.
13. `bun run check:sql-portability` passes. It rejects SQLite-only syntax outside the SQLite package and identifiers that break decision D8.
14. `bun run check:no-new-triggers` passes. It rejects `CREATE TRIGGER` in a migration added after the base commit, except the Postgres baseline.
15. `bun run check:tx-callbacks` passes. It rejects known side effects inside a transaction callback.

**Existing gates**

16. These commands pass: `bun run lint`, `bun run lint:slop`, `bun run tsc:check:tsc`, `bun run test:root -- --parallel=4`, `bun run e2e:ui`, `bash scripts/check-db-boundary.sh`, `bash scripts/check-async-db-seam.sh`, `bun scripts/check-floating-promises.ts`, `bun scripts/check-promise-sinks.ts`, `bash scripts/check-audit-columns.sh`, `bun run check:unit-test-allowlist`.
17. `bun run docs:openapi` gives no diff, or the diff adds only fields that state the engine.
18. `bun run test:storage` passes. It runs one repository contract suite against SQLite and against Postgres.

**Data copy**

19. A CLI command copies a SQLite database into an empty Postgres database (decision D11).
20. A scenario fills a SQLite SUT through the API, runs the copy, and starts a Postgres SUT on the result. It then compares the responses of a fixed list of GET routes between the two SUTs. The responses must be equal.

**Performance**

21. `bun run e2e:bench --engine postgres` writes a report. The report gives p95 for each route group on both engines and the retry rate for each transaction site.
22. A stress scenario runs many simulated workers that poll and claim tasks at the same time. It must show zero exhausted retries and zero 5xx responses.

**Delivery**

23. CI runs checks 2, 7, 11 to 15 and 18 on each pull request. The merge gate needs them.
24. The Helm chart, a compose example, `DEPLOYMENT.md`, the docs site and a new `runbooks/postgres.md` describe Postgres. The runbook contains the production cutover procedure.
25. `thoughts/taras/research/2026-11-20-replica-blockers.md` lists each thing that prevents a second API replica on Postgres, with file and line.
26. One pull request is open against `main`. Its body obeys `.github/pull_request_template.md` with `Risk: high`. Its CI is green.

### 4. Hard constraints

- Do not change, rename or delete a migration file that exists at the base commit.
- Do not change the behavior of a start with no `DATABASE_URL`. SQLite stays the default engine.
- Do not remove an assertion from a scenario. Do not make an assertion weaker.
- Do not add an ORM or a query builder dependency (Drizzle, Kysely, Prisma, Knex or equivalent).
- Do not translate SQL text at run time with a regular expression. Each dialect gets SQL that a helper or an author wrote for it.
- Do not add unit tests for API code under `src/`. Put repository tests under `packages/`.
- Do not add state that lives in one process only (a new in-memory cache, lock, timer registry or event channel).
- Do not remove the `api.replicas == 1` guard from `charts/agent-swarm/templates/api-statefulset.yaml`.
- Do not change the version in `package.json`. Do not edit `CHANGELOG.md`.
- Do not merge the pull request. Do not push to `main`.
- Do not skip git hooks.
- Obey `CLAUDE.md` in the repository. This brief wins where the two conflict on storage design.

### 5. Decisions

Do not reopen a decision without the evidence that section 12 requires.

**D1. Engine selection (default).** `DATABASE_URL` with a `postgres://` or `postgresql://` scheme selects Postgres. No `DATABASE_URL` selects SQLite at `DATABASE_PATH`. Add `DATABASE_URL` and `DATABASE_QUERY_URL` to `RESERVED_KEYS` in `src/be/swarm-config-guard.ts`. Both values must pass through `scrubSecrets` before any log line.

**D2. Data directory (default).** `DATABASE_PATH` also locates the encryption key file, the page-session secret (`src/utils/page-session.ts`) and the secrets backup. Add one setting for that directory that does not depend on the engine. Its default must give the same paths as today.

**D3. Repositories (Taras).** Each data domain has one interface. A base class holds the portable SQL, written with dialect helpers. A `Sqlite*` class and a `Postgres*` class override only the methods that differ. A method that needs different SQL on each engine has no base implementation.

**D4. Packages (Taras).** Put the storage code in workspace packages. A contracts package holds the interfaces, the capabilities, the dialect helpers and the base classes. A SQLite package is the only importer of `bun:sqlite`. A Postgres package is the only importer of the Postgres driver. `src/` imports the contracts package and one composition root. Packages cannot import from `src/`. Choose where the shared entity types live, and write the rule in the ledger.

**D5. Call sites (default).** Keep the exported functions of `src/be/db.ts`, `src/be/db/**` and `src/be/db-queries/**` as thin delegates to the repositories. Callers and the existing unit tests then keep their imports.

**D6. Writers on Postgres (Taras. Default: the replay mode and the hook rules).** Each Postgres connection uses the SERIALIZABLE isolation level by default. The client retries a transaction on SQLSTATE 40001 and 40P01 with a bounded backoff. The retry runs the complete callback again. Therefore each transaction callback must be safe to run two times. Move HTTP calls, event emits and other side effects to `afterCommit`. Discard the hooks that a failed attempt registered. Run `afterRollback` hooks only when the last attempt fails. The `--tx-replay` mode proves this rule: it rolls back the first attempt of each transaction and runs the callback again.

**D7. Measured opt-down (Taras. Default: the 5% threshold).** A transaction site may use READ COMMITTED with an explicit lock (for example `FOR UPDATE SKIP LOCKED` on the task claim). This is permitted only when the stress scenario shows a retry rate above 5% for that site. Each such site needs a written reason in the code and its own stress scenario.

**D8. Types and names on Postgres (Taras: the types. Default: the names).** Use `timestamptz` for timestamps, `jsonb` for JSON and `boolean` for flags. Use `bigint` for SQLite INTEGER columns, and keep the type class of SQLite for all other columns. Keep the table names and the camelCase column names of SQLite. Put double quotation marks around each identifier that contains an uppercase letter, in the SQL of both engines. Repositories return the same domain values on both engines. The Postgres side converts values at the repository boundary.

**D9. Triggers (Taras).** Write one plpgsql trigger for each of the SQLite triggers at the head schema, with the same name and the same rule. Add no trigger after that. New rules go into repository code.

**D10. `db-query` (Taras: the native dialect. Default: the restricted role).** The tool runs the dialect of the active engine. Build the tool description and the seeded guidance skill (`templates/skills/db-query-guidance`) from the capabilities. On Postgres, `db-query` uses a second connection from `DATABASE_QUERY_URL`. That URL logs in as a restricted role. The role has SELECT on the permitted tables only. Each query runs in a read-only transaction with a statement timeout. At start, a probe checks that the role cannot read the 7 denied tables and cannot write. If the URL is absent or the probe fails, the `dbQuery` capability is off and the tool returns a clear error. Do not use `SET ROLE` or SQL text filters as the security boundary. User SQL can undo both.

**D11. Data copy (Taras).** Add a CLI command that copies a SQLite file into an empty Postgres database at the same migration head. The command must:

1. Open the SQLite file read-only.
2. Refuse a target that contains rows.
3. Disable user triggers on the target during the copy.
4. Convert each value to its Postgres type.
5. Report each value that Postgres cannot store (a NUL byte, invalid UTF-8, an invalid timestamp). It must not drop a value silently.
6. Build the full-text and vector data again.
7. Reset the sequences.
8. Compare the row count and a checksum of normalized values for each table.
9. Exit with a non-zero code when a comparison fails.

Copy encrypted secrets as ciphertext. Taras runs the production cutover. You deliver the command, its proof and the runbook.

**D12. Migrations (default).** Generate one Postgres baseline file that equals the SQLite head schema and its seeded rows. Commit the generator script. After the baseline, each new migration has one file for each engine with the same ordinal. A file may state that it is a no-op for one engine, with a reason. The Postgres runner applies each file in one transaction and holds an advisory lock while it runs.

**D13. Parity check (default).** `check:schema-parity` compares tables, columns, type classes, nullability and defaults. It compares primary keys, foreign keys, unique constraints, indexes and partial index predicates. It compares CHECK value sets, trigger names and views. It also compares all rows that the two chains insert into an empty database. Permitted differences live in one allowlist file with a reason on each line (for example the FTS5 shadow tables).

**D14. Driver (default).** Use `Bun.SQL`. Prove it first with the spike of milestone M0. If the spike fails, use the `postgres` package (postgres.js) behind the same driver interface.

**D15. Search (default).** Use the built-in `tsvector` type for full-text search and pgvector for vector search. Parity means: both engines return the same set of ids for each query of a fixed corpus. Vector results must have the same order. For ranked full-text results, at least 4 of the first 5 ids must be the same.

**D16. One-process guard (default).** On Postgres, the API takes a session advisory lock at start. A second API process on the same database waits a short time and then stops with a clear error.

**D17. Test engines (default).** The gate uses a real Postgres service container. Do not use PGlite. The unit tests under `src/tests/` and the UI e2e suite stay on SQLite only.

**D18. Landing (Taras).** One branch and one pull request. Taras stops merges to `main` during the work. If `main` moves, merge it into your branch and run the checks again.

### 6. Known hazards

The research found these. Each one must have a repository contract test or a scenario that fails if the hazard returns. The counts are upper bounds from text search. Count again in M0.

**Size**

- About 1,460 `getDbClient()` call sites in about 200 files. About 1,800 to 2,200 statements. About 290 transaction sites.
- SQL lives outside `src/be` too: `src/http`, `src/be/memory`, `src/workflows`, `src/tools`, `src/apps`.
- 19 files in the allowlist of `scripts/check-async-db-seam.sh` use the synchronous SQLite API. `initDb` in `src/be/db/runtime.ts` is synchronous and runs migrations and seeds.
- Three sites open their own SQLite handle: `src/http/db-query-shared.ts`, `src/http/db-query-bounded.ts`, `src/be/memory/search-read-worker.ts`.

**Dialect**

- Placeholders: `?` on SQLite, `$n` on Postgres. About 180 builders of WHERE fragments and about 140 expansions of IN lists build SQL from parts.
- `strftime(...)`, `datetime('now', ...)`, `IS NOT` on values, `GLOB`, `rowid`, `INSERT OR IGNORE`, `INSERT OR REPLACE`, `changes()`, `lastInsertRowid`, `json_each`, `json_extract`, PRAGMA.
- `LIKE` ignores ASCII case on SQLite and respects case on Postgres.
- `GROUP BY` on SQLite accepts columns that are not grouped. Postgres rejects them.
- Scalar `max(a, b)` and `min(a, b)` have different NULL behavior from `GREATEST` and `LEAST`.
- A parameter with no type context can fail on Postgres ("could not determine data type").
- Flags are 0 and 1 on SQLite. `WHERE flag = 1` and `SUM(flag)` fail on a `boolean` column.

**Order**

- A SELECT with no ORDER BY returns rows in insertion order on SQLite. Postgres gives no order. Each repository method that returns many rows must state a total order, and a test must prove it with ties.
- NULL sorts first in ascending order on SQLite and last on Postgres.
- SQLite compares text by bytes. Postgres uses the database collation. Use the `C` collation, or prove equal order in a test.

**Values**

- SQLite holds two timestamp text formats: `2026-11-20T10:00:00.000Z` and `2026-11-20 10:00:00`. API responses expose them. For each column, the Postgres side must return the format that SQLite returns.
- `Bun.SQL` returns `bigint` and `numeric` as strings, parses `jsonb`, and returns timestamps as `Date`. Convert each to the domain value.
- `jsonb` does not keep key order, duplicate keys or whitespace. Find the code that compares or hashes stored JSON text.
- Postgres rejects a NUL byte and invalid UTF-8 in `text` and `jsonb`. Session logs and tool output can contain both.
- About 47 `rowTo*` mappers call `JSON.parse` on text. They must not parse a value that the driver already parsed.

**Transactions**

- On Postgres, one failed statement aborts the transaction. Code that catches a constraint error and continues in the same transaction fails. Use a nested transaction (SAVEPOINT) at each such site.
- `claimScheduleOccurrence` (`src/scheduler/scheduler.ts`) and other read-then-write claims depend on the single writer of SQLite. List them all. D6 makes them safe, and the stress scenario must prove it.
- A transaction must use one pooled connection from start to end. Client calls inside the callback must join it through the existing AsyncLocalStorage routing.
- About 14 sites match SQLite error text. Map engine errors to one set of typed errors in the contracts package.

**Exposed SQL and operations**

- `db-query` reaches agents through the MCP tool, `POST /api/db-query`, `ctx.swarm` in scripts and the debug page. Its table denial uses SQLite bytecode and `sqlite_master`.
- `src/be/seed-scripts` holds about 280 lines of SQLite SQL that seeded scripts send to `db-query`. Move them to SDK calls, or write one text for each dialect.
- The Litestream sidecar in the chart is for SQLite only. Disable it when Postgres is selected.
- About 19 docs-site pages name SQLite.
- `packages/ui-e2e/boot/seed.ts` writes to the SQLite file directly. It stays as it is.

### 7. Milestones

Do the milestones in order. At the end of each milestone, run the SQLite checks (1, 8, 16), commit, and update the ledger. Do not start a milestone while the SQLite checks of the previous one fail.

**M0. Baseline and spikes**

1. Create a worktree from fresh `origin/main` (see section 11). Record the base commit.
2. Copy the brainstorm document and this brief into the branch.
3. Count again each number in section 6. Record the results.
4. Run the strict suite and the unit tests on the base commit. Record the failures that exist before your work.
5. Run the driver spike: pool, one connection for each transaction, savepoints, `bytea`, `jsonb`, `timestamptz`, error codes, a compiled binary. Read the current `Bun.SQL` documentation first. Record the result and the driver choice.
6. List the transaction sites. Mark each callback that has a side effect or that catches a constraint error.
7. List the columns by timestamp format. List the columns that hold invalid timestamps in a copy of real data, if Taras supplies one.
8. Write the repository domain map: each domain, its tables, its current files.

**M1. Stronger contract on SQLite**

1. Add the `--engine` flag to `scripts/e2e/run.ts` and `scripts/e2e/sut.ts`. With `--engine postgres`, the runner reads `E2E_POSTGRES_URL` and makes one new database for each run.
2. Make `ctx.db` (`scripts/e2e/db.ts`) work on both engines. It stays read-only. It returns the same row shape on both engines.
3. Add the divergence scenarios. They must pass on SQLite before any Postgres code exists:
   - full-text search and vector search on a fixed corpus (D15)
   - list order with ties, NULL order, text order, page boundaries
   - `LIKE` case behavior
   - both timestamp formats in responses
   - JSON round trip, flags, large integers
   - error mapping (unique, foreign key, CHECK) to HTTP status codes
   - concurrent claims (tasks, schedule occurrences)
   - one scenario for each trigger group
   - retention
   - `db-query` denial of the 7 tables
   - start on a database file from the base commit (check 10)
4. Add the stress scenario of check 22.

**M2. Storage packages on SQLite**

This milestone is a refactor with no behavior change.

1. Create the storage packages and the dependency rules (D4).
2. Move the SQL of one domain at a time into its repository (D3, D5). Run the affected scenarios after each domain.
3. Write the SQL in the portable form of D8 as you move it.
4. Add the repository contract suite (`bun run test:storage`) for SQLite.
5. Add checks 11, 12, 13 and 15.
6. Move the transaction side effects to `afterCommit` (D6). Add `--tx-replay` for SQLite and make the strict suite pass with it.
7. Make the start sequence asynchronous where Postgres needs it. Keep the SQLite start behavior.

**M3. Postgres engine**

1. Add the Postgres driver, the client (pool, transactions, retry, hooks) and the capability set.
2. Generate the baseline, port the triggers, and add the Postgres runner (D9, D12).
3. Add `check:schema-parity` and check 14.
4. Add the value conversion (D8) and the typed errors.
5. Run the contract suite against Postgres until it passes.

**M4. Engine-specific domains**

1. Full-text search on `tsvector` for skills, tasks and memory.
2. Vector search on pgvector for memory.
3. The JSON queries that use `json_each` and `json_extract`.
4. `db-query` on Postgres (D10) and the seeded scripts.
5. The memory search worker, the bounded reader and each other site that opens its own handle.

**M5. Contract on Postgres**

1. Make checks 2, 3, 4 and 5 pass.
2. Run the stress scenario and the bench. Apply D7 where the numbers require it.
3. Add the one-process guard (D16).

**M6. Data copy**

1. Add the command of D11, its help text and its CLI scenario.
2. Add the scenario of check 20.

**M7. Delivery**

1. Add the CI jobs (check 23). Use a `pgvector/pgvector:pg16` service container.
2. Update the chart (a `DATABASE_URL` secret value, Litestream off on Postgres, chart tests), a compose example and the docs.
3. Write `runbooks/postgres.md` and the replica-blocker inventory (check 25).
4. Update the `CLAUDE.md` text that says SQLite is the only engine. Add the rules that a future change must obey.
5. Run every check of section 3. Open the pull request.

### 8. Limits of this goal

State these limits in the runbook, the docs and the pull request.

- One API process for each database, on both engines.
- More than one API replica needs Postgres and a later goal. That goal must replace these parts:
  - the in-memory realtime bus (`src/realtime/bus.ts`)
  - the workflow event bus (`src/workflows/event-bus.ts`)
  - the in-memory locks (`src/oauth/ensure-mcp-token.ts`)
  - the caches of each process
  - the timers that have no leader election
- SQLite installations keep their current event-loop stalls.
- Full-text ranking is not equal between the engines. D15 defines the accepted difference.
- `db-query` on Postgres needs a role that the operator creates.

### 9. Out of scope

- A second API replica, leader election, LISTEN/NOTIFY.
- A SQLite driver that runs in a Worker.
- A libsql engine. Keep driver and dialect independent so that it stays possible.
- Removal of SQLite or of the SQLite unit tests.
- Changes to worker-side code, except where a moved type requires an import change.
- The production cutover.

### 10. Rules against false passes

- A check passes only when its command exits with code 0 on the final commit.
- Do not add an entry to an allowlist, an exclusion list or a quarantine list without a reason on the same line. Record each new entry in the ledger.
- Do not mark a scenario as flaky, and do not add a retry to a scenario, to make it pass on Postgres.
- Do not branch on the engine in a scenario. If the engines differ, the product has a defect or the hazard needs a decision from section 5.
- Scenario edits are limited to SQL portability and helper use. Record the list of edited scenarios in the ledger, with the reason for each.
- Do not report a count that you did not measure. Do not report a check that you did not run.
- If a check fails for a reason that existed at the base commit, record the evidence. Do not hide the failure.

### 11. Work method

- Work in a new worktree under `~/worktrees/agent-swarm/`. Other sessions change branches in the main checkout.
- Use the Bun version in `packageManager` of `package.json`.
- Set `DATABASE_PATH` to a file in the worktree for each manual start. A start with no path writes to `./agent-swarm-db.sqlite` and applies your migrations to it.
- Set `DESPLEGA_TELEMETRY_ENV=test` for each manual start.
- Run the e2e suites from the worktree with no `.env` file.
- Start a local Postgres with Docker (`pgvector/pgvector:pg16`) on a free port. Stop and remove the container when a session ends.
- Do not run two `bun test` processes at the same time.
- Commit after each domain in M2 and after each milestone. Push the branch after each milestone.
- Update the ledger after each milestone: state, measured numbers, decisions inside your authority, deviations, open risks.
- You may delegate work to sub-agents. You stay responsible for each check.
- Delete your files in `/tmp` and your build outputs after each milestone. The disk has little free space.

### 12. When to stop and ask Taras

Continue without questions for all other choices. Record the choice and its reason in the ledger.

Stop and ask only in these cases:

1. A decision of section 5 fails in practice, its stated fallback also fails, and you have a test that shows it.
2. A check of section 3 cannot pass without a break of a hard constraint.
3. The security boundary of D10 cannot hold.
4. You need a secret, a copy of production data or access to an external service.
5. The work needs a destructive action outside the worktree.

When you stop, state the evidence, the options and your recommendation.
