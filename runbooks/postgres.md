# Postgres storage engine

The API server runs on SQLite (the default) or on Postgres. One environment variable selects the engine. The same black-box contract passes on both engines (`bun run e2e:strict` and `bun run e2e:strict --engine postgres`).

This runbook covers: when to choose Postgres, the setup, the db-query reader role, the move of a SQLite database (the production cutover), the limits, and the rules a future change must obey.

## Engine selection

| Variable | Effect |
|---|---|
| `DATABASE_URL` | A `postgres://` or `postgresql://` URL selects Postgres. Absent: SQLite at `DATABASE_PATH`. Any other scheme is ignored with a warning. |
| `DATABASE_PASSWORD` | Postgres only. Optional raw password. The API URL-encodes it into `DATABASE_URL` (the Compose overlay uses it). |
| `DATABASE_QUERY_URL` | Postgres only. The URL of the restricted role that the `db-query` tool uses. Absent or refused by the probe: `db-query` is off and says why. |
| `DATABASE_PATH` | SQLite file. On Postgres it still locates the data directory, unless `SWARM_DATA_DIR` is set. |
| `SWARM_DATA_DIR` | Directory of the encryption key file and the page-session secret. Default: the directory of `DATABASE_PATH` (the same paths as before). |

All four are deployment environment only: the dashboard cannot set them (reserved keys). The API passes both URLs through `scrubSecrets` before any log line.

An installation that sets none of them behaves as before.

## Requirements

- Postgres 16 or later with the pgvector extension (memory vector search). Use Postgres 18 for a new install. CI, the Compose overlay and the worker image use Postgres 18 (`pgvector/pgvector:pg18`).
- A database created with the `C` collation and character classes: `CREATE DATABASE swarm TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`. SQLite compares text by bytes and folds case for ASCII only; the `C` locale gives the same order and the same `ILIKE`/`lower()` behavior.
- The extension: the first migration runs `CREATE EXTENSION IF NOT EXISTS vector`. If the swarm role may not create it, run that statement once as a superuser before the first start.
- The swarm role owns the schema objects (it runs the migrations).

## Setup

1. Create the database (see Requirements) and a role that owns it.
2. Set `DATABASE_URL` on the API and start it. The start takes the one-process lock, applies the Postgres migration chain (`src/be/migrations/postgres/`) under an advisory lock, and logs `[db] Postgres engine ready`.
3. Optional: create the db-query reader role (next section) and set `DATABASE_QUERY_URL`. Restart the API.

Compose: `docker compose -f docker-compose.example.yml -f docker-compose.postgres.yml --env-file .env up -d` (set `POSTGRES_PASSWORD` in `.env`).

Helm: set `database.url` (stored in a chart Secret) or `database.existingSecret` (keys `DATABASE_URL`, optional `DATABASE_QUERY_URL`). The chart turns the Litestream sidecar off on Postgres. Keep `api.replicas: 1`.

Keep the API volume on both engines: it holds the encryption key file and the page-session secret.

## Upgrade a Compose database from Postgres 16

The Compose overlay moved from `pgvector/pgvector:pg16` with the volume at `/var/lib/postgresql/data` to `pg18` with the volume at `/var/lib/postgresql`. The Postgres 18 images keep the data in `/var/lib/postgresql/18/docker`. An old volume does not start under the new overlay. The user procedure (dump with the old overlay, restore into the new one) is in the docs guide: [Upgrade a Compose database from Postgres 16](../docs-site/content/docs/(documentation)/guides/postgres.mdx). Keep the two in step.

Facts behind it, tested on 2026-11-26:

- pg18 on a pg16 volume, at either mount path: the container stops with `Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"`. The data stays as it was. The failed start leaves an empty `18/docker` directory in the volume, and the old overlay still starts on it.
- A `pg16` image with the new mount path starts a new, empty database in an anonymous volume at `/var/lib/postgresql/data`. The API then starts on that empty database. Never pair the two.
- `pg_dump -Fc` of a pg16 swarm database (144 tables), then `pg_restore --exit-on-error` into a fresh pg18 database with the same `POSTGRES_INITDB_ARGS`: exit 0, the API started (`[db] Postgres engine ready`) and read its tasks.
- At the first start, the image runs a short init server on the Unix socket only. A socket `pg_isready` passes during that phase, so wait with `pg_isready -h 127.0.0.1` before a restore.

A database outside Compose (managed Postgres, Dokploy) moves with the tools of its provider: a major-version upgrade, `pg_upgrade`, or the same dump and restore. A new Postgres 18 cluster has data checksums on by default. `pg_upgrade` needs the same checksum setting on both clusters.

## db-query reader role

On Postgres the `db-query` tool runs the user's SQL as a second, restricted role. The security boundary is the role's grants. `SET ROLE` and SQL text filters are not a boundary, because user SQL can undo them.

Create the role after the first start (the tables must exist):

```sql
CREATE ROLE swarm_reader LOGIN PASSWORD '<password>';
GRANT CONNECT ON DATABASE swarm TO swarm_reader;
GRANT USAGE ON SCHEMA public TO swarm_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO swarm_reader;
REVOKE SELECT ON oauth_authorizations, oauth_apps, oauth_pending, user_tokens,
  session_tokens, script_apis, codex_oauth_device_flows FROM swarm_reader;
-- Tables that later migrations add:
ALTER DEFAULT PRIVILEGES FOR ROLE swarm IN SCHEMA public GRANT SELECT ON TABLES TO swarm_reader;
```

Set `DATABASE_QUERY_URL=postgres://swarm_reader:<password>@<host>:5432/swarm`.

At start, a probe checks that the role cannot read the 7 denied tables (directly, by column grant or through a view), cannot write, owns nothing, and cannot run a `SECURITY DEFINER` function. A superuser or owner URL fails the probe. When the probe fails, `db-query` is off and the log names the reason. Each query runs in a read-only transaction with a statement timeout.

## One process per database

The API holds a session advisory lock on its database for its whole life. A second API process on the same database waits 10 seconds, then stops with `another API process holds this Postgres database`. `db-copy` takes the same lock, so it refuses a database an API runs on. If the lock session ends while the API runs (a database restart, a dropped connection), the API logs `lost the one-process lock` and exits within about a second; the supervisor restarts it, and the new process waits for the lock again. Writes are fenced in that window: each write transaction first checks that the process still holds the lock, and a new holder waits for the old holder's open write transactions before it writes (`packages/storage-postgres/src/owner-fence.ts`). A write after a takeover fails with `no longer holds the one-process lock`.

Connection budget per API process: 1 session for the one-process lock, up to 10 for the application pool, and up to 4 for the optional db-query reader (15 in total). Set the role's or the server's connection limit to at least that. With a connection pooler (PgBouncer, a cloud proxy) between the API and Postgres, use session pooling for the API's `DATABASE_URL`. The lock is a session advisory lock, so the lock connection needs session affinity: in transaction pooling the lock lands on a server connection that other clients share, and the write fence cannot see the owner session. Connect directly when the pooler offers only transaction pooling.

## When the database is unreachable

The API does not reconnect in place. When it cannot reach its database, it exits with code 1, and the supervisor (`restart: unless-stopped` in Compose, the Deployment on Kubernetes) starts it again. The new process opens new connections and waits for the one-process lock. The API runs on Postgres only under a supervisor.

The lock watchdog checks the lock session once a second. When a check gets no answer within 10 seconds, the API logs `lost the one-process lock ... (the lock session did not answer within 10000 ms)` and exits. This covers connections that died without a FIN or RST: the database came back on another address (a recreated container), or the network drops packets. Before this rule, the API kept `/health` green and every database request hung until the kernel gave up on the sockets (about 15 minutes on Linux).

Expected times when every connection dies without a close:

| Step | Time |
|---|---|
| A request that needs the database fails (the process exits) | about 11 s |
| `/health` stops answering 200 | about 11 s |
| The restarted API serves requests, once the database answers again | about 5 s after the database is back, plus the supervisor's restart delay |

Connection settings (all connections of the API, fixed values, no setting):

- The server keeps TCP keepalive on each session (`tcp_keepalives_idle` 10 s, `tcp_keepalives_interval` 5 s, `tcp_keepalives_count` 3). After a network cut, the server ends the old session within about 25 seconds and releases its session lock, so the restarted API can take the lock. Without it the server holds the old session, and the lock, for 2 hours.
- A new connection waits at most 10 seconds (`connectionTimeout`). A start against an unreachable database fails fast, and the supervisor tries again.
- The pool closes a connection that is idle for 60 seconds. A NAT gateway or a load balancer drops an idle connection without a FIN after 4 minutes or more, so the pool never sends a request on such a connection.

`/health` checks no database on either engine: it answers 200 while the process runs. On Postgres the exit above keeps it honest, because the process stops within about 11 seconds of losing its database.

Limit: when only a pool connection dies and the lock session stays healthy, a request on that connection can still hang until the kernel gives up on it. The 60-second idle close makes this unlikely.

More than one API replica is not supported on either engine. The parts that a second replica would break are listed, with file and line, in `thoughts/taras/research/2026-11-20-replica-blockers.md`: the in-memory realtime bus (`src/realtime/bus.ts`), the workflow event bus (`src/workflows/event-bus.ts`), in-memory locks (`src/oauth/ensure-mcp-token.ts`), per-process caches, and timers with no leader election.

## Server settings

The defaults of Postgres fit a small test database. Set these on a production server. Each one was needed in the first production move.

| Setting | Value | Why |
|---|---|---|
| `max_pred_locks_per_transaction` | `2048` (default `64`) | The API runs each transaction at SERIALIZABLE, and Postgres keeps predicate locks for them in a table of fixed size. While one statement runs for seconds, Postgres keeps the locks of every transaction that commits in that time. With the default, the table fills and statements fail with `out of shared memory` and the hint `You might need to increase max_pred_locks_per_transaction`. The API answers 500 for them. The table holds this value times `max_connections` entries, so the cost in shared memory grows with `max_connections` (some tens of MB at 100 connections). A change needs a server restart. |
| `dynamic_shared_memory_type` | `sysv`, or a larger `/dev/shm` | A container gets a `/dev/shm` of 64 MB unless the platform sets more (`docker run --shm-size`, `shm_size` in Compose). A Docker Swarm service has no such option: mount a tmpfs on `/dev/shm`, or use `sysv`. Parallel queries and the parallel `VACUUM` that `db-copy` runs at its end then fail with `could not resize shared memory segment ... No space left on device`. `sysv` moves that memory out of `/dev/shm`. A change needs a server restart. |
| Stop grace period of the database container | 120 s or more | Postgres writes a checkpoint when it stops. A container that is killed after the default 10 s or 30 s recovers from the WAL at the next start. |
| `max_connections` | At least 15 for the API process, plus the sessions that backups and operators open | A lower bound, not a value to copy. See "One process per database" for the budget of the API. A parallel `pg_dump -j 8` opens 9 sessions. |

The API sets `jit = off` on its own connections, so the server's `jit` value does not matter to it. Leave `jit` on at the server for analytics sessions if you want them to use it. On the API's short statements, JIT compilation took 0.2-3.6 s where the statement itself ran in 50-150 ms.

Check the first two after a change: `SHOW max_pred_locks_per_transaction` and `SHOW dynamic_shared_memory_type`. To see how full the predicate lock table is: `SELECT count(*) FROM pg_locks WHERE mode = 'SIReadLock'`. A count that stays in the thousands means a long statement runs: find it in `pg_stat_activity`.

A restart of Postgres under a running API is safe: the API logs `lost the one-process lock`, exits, and its supervisor starts it again (see "When the database is unreachable"). Tasks that a worker runs at that moment can fail with `worker session not found after server restart`, as after any API restart.

## Backups

Litestream replicates the SQLite WAL only. On Postgres use the provider's backups or `pg_dump --format=custom`. Back up the API volume too (encryption key).

## Production cutover (SQLite to Postgres)

`agent-swarm db-copy` copies a SQLite file into an empty Postgres database at the same migration head. It runs in one transaction: a value Postgres cannot store, a foreign key that fails, or a count or checksum that differs leaves the target empty and exits 1.

Before the window:

1. Deploy the target build on SQLite as usual. Let it start once, so the SQLite file is at this build's migration head.
2. Create the Postgres database and role (Requirements). Set the server settings of "Server settings" on that server now, so that the rehearsal of step 3 runs with them. Do not start an API on it.
3. Rehearse: copy a recent backup of the SQLite file into a scratch database with `db-copy` (same command as step 3 of the window, with the backup mounted and the scratch database as `--to`). Fix every refused value it reports in the source (a NUL byte, invalid UTF-8, an invalid timestamp, a flag that is not 0 or 1, invalid JSON). The copy does not replace or drop values for you. Read every `ATTENTION` line too: a saved dashboard query in SQLite SQL that the copy does not know (an edited widget, a hand-written dashboard) does not run on Postgres. The copy rewrites only the stock queries of the starter dashboard and of the old new-dashboard template, and keeps titles and other edits. Plan an edit for each listed query. Set `EMBEDDING_DIMENSIONS` to the value the API uses: the copy refuses embeddings of another width.
4. Start a test API on the scratch copy with the restricted reader configured in `DATABASE_QUERY_URL`. Run each custom dashboard with representative filter values and compare its results with SQLite. The copy uses PostgreSQL `EXPLAIN` to check custom queries. A query can pass that check and then fail when it converts a value in a stored row.
5. Find the stored SQL that the copy does not check. The copy lists dashboard widgets only. Agents and pages also send SQL through `db-query`, and that SQL is written for SQLite: saved scripts (`scripts.source`), the prompt text of schedules (`scheduled_tasks.taskTemplate`), the node prompts of workflows (`workflows.definition`), and pages (`pages.body`). Search them for SQLite-only syntax (`datetime(`, `strftime(`, `json_extract(`, `json_each(`, `GLOB`, unquoted camelCase columns) and port each hit before the window. A script can read `ctx.db.dialect`, and each `db-query` response states its `dialect`.

In the window:

1. Stop the API. Keep workers running: they retry until the API is back.
2. Back up the SQLite file and its `-wal`/`-shm` files, and the encryption key file.
3. Copy. With the API image, run a one-off container from the same image tag as the API. Mount the API data volume, and join a network that reaches Postgres. Arguments after the image name go to `db-copy`. It does not boot the API: no listener, no migrations of the SQLite file.
   ```bash
   docker run --rm -v <api data volume>:/app/data --network <network that reaches postgres> \
     <api image>:<api tag> db-copy --from /app/data/agent-swarm-db.sqlite \
     --to "postgres://swarm:<password>@<host>:5432/swarm" --json /app/data/db-copy-report.json
   ```
   With Compose, `docker compose run --rm --no-deps <api service> db-copy ...` uses the service's image, volumes and network. From a source checkout or the npm package:
   ```bash
   agent-swarm db-copy --from /app/data/agent-swarm-db.sqlite \
     --to "postgres://swarm:<password>@<host>:5432/swarm" --json /app/data/db-copy-report.json
   ```
   `db-copy --help` lists the options. Without `--from` and `--to`, the copy reads `DATABASE_PATH` and `DATABASE_URL` (plus `DATABASE_PASSWORD`). In the API image, `DATABASE_PATH` is `/app/data/agent-swarm-db.sqlite`.
   Add `--repair` when the rehearsal listed rows that it can fix (see "Refused rows" below). Expect `[db-copy] done: <n> tables, <m> rows, every count and checksum equal` and exit 0. The report lists each table's row counts and checksums, the skipped SQLite-only tables (FTS5 and sqlite-vec indexes, migration bookkeeping) and the rebuilt vector and full-text rows. Exit 3 means the copy committed but the report could not be written. Exit 4 means the copy committed but the dashboard check after COMMIT could not run (for example no connection was free): each `NOT CHECKED` line names an unverified saved query. Run each one on Postgres before you start the API.
4. Set `DATABASE_URL` (and `DATABASE_QUERY_URL` if the reader role exists). Keep the same encryption key: secrets copy as ciphertext.
5. Start the API. Check `[db] Postgres engine ready`, `/health`, the dashboard task list, a secret config value, and one memory search.

The first start on Postgres removes every memory whose expiry time has passed. On SQLite, a memory that expires during the current UTC day stays until the date changes (the expiry check compares an ISO timestamp with `datetime('now')` as text). Thus the count of memories can drop at once by one day of expiries. The log line is `[memory-gc] Initial purge removed <n> expired memory row(s)`.

Rollback: stop the API, unset `DATABASE_URL`, start it again. It runs on the untouched SQLite file. Writes made on Postgres after the cutover are not copied back.

What the copy does, step by step: opens the SQLite file read-only; skips the two tables that Litestream adds to a replicated database (`_litestream_seq`, `_litestream_lock`); refuses a target that holds any table; runs the Postgres migrations inside the copy transaction, so a refused copy leaves the target empty and a re-run works; disables user triggers during the copy; converts each value to its column type (booleans, `bigint`, `jsonb`, `timestamptz` from both SQLite timestamp formats, `bytea`); keeps SQLite `rowid` as `_rowid`; rebuilds `memory_vec` from the copied embeddings, `memory_fts` (the stored full-text documents) from the copied memories, and `agent_tasks_search` (the task search documents) from the copied tasks; restarts identity sequences; compares row counts and checksums of normalized values per table; after COMMIT, runs `VACUUM (ANALYZE)` so the API starts with planner statistics (a `WARNING` line says so when this step fails: run it by hand before you start the API).

Refused rows: one run lists every row the target cannot store. The copy first reads the orphan rows from SQLite (`PRAGMA foreign_key_check`: a row whose parent row is gone), then checks every value. After the first refused row it writes no more rows, so a refused run takes minutes, not the time of a full copy. Each line names the table, the column and the rowid.

`db-copy --repair` fixes the kinds below during the copy. It lists each fix (`[db-copy] repaired <table>.<column> (rowid N): <what>`, and `repairs` in the `--json` report), compares the repaired values on both sides, and does not change the SQLite file. Without `--repair` the copy changes no value.

| Kind | What `--repair` does |
|---|---|
| NUL byte in text | Removes the NUL bytes |
| Invalid UTF-8 in text | Replaces each invalid sequence with U+FFFD |
| JSON with `\u0000`, or with an unpaired surrogate escape (text cut in the middle of an emoji) | Removes `\u0000`, replaces the surrogate with U+FFFD |
| Text in a number or flag column that allows NULL | Stores NULL (no rule knows the number that was meant) |
| Orphan row, key with `ON DELETE CASCADE` | Does not copy the row |
| Orphan row, any other key, column allows NULL | Stores NULL in the key column |

Not repaired, so fix these in the SQLite file by hand: invalid JSON syntax, an invalid timestamp, a wrong kind in a NOT NULL column, an orphan whose key column is NOT NULL, an orphan row in a table with no rowid. A row that `--repair` does not copy can leave rows that pointed at it: the foreign key check at the end then stops the copy and names the first one.

To repair by hand instead: SQLite `replace()` does not remove a NUL byte (it reads a pattern that starts with NUL as empty and changes nothing), so rewrite such a value from a program.

Memory and batches: the copy process holds one batch of rows at a time (at most 500 rows or 16 MB of stored text, in both directions), and its checksums need no list of rows.

## Task search documents

Task search (`GET /api/tasks?search=`, `get-tasks`) reads stored `tsvector` documents in `agent_tasks_search` (migration 391), one row per task. The tasks repository writes the row in the statement that writes the task text or title. A search takes its candidates from the GIN indexes of these documents and checks a phrase in the stored document, so it parses no task text.

- After the upgrade to migration 391, the API builds the documents of the existing tasks in batches after the start (the task search backfill, mark `agent_tasks_fts_state.indexedThrough`). The log line `[task-fts] backfill indexed=<rows> ms=<ms>` tells you that it is complete. Until then, a task past the mark matches through the expression indexes of migration 368, so the results are correct, but a phrase search can be slower.
- An image older than migration 391 does not write the documents. If one ran on the database after the upgrade, run `TRUNCATE agent_tasks_search` and `UPDATE agent_tasks_fts_state SET "indexedThrough" = 0 WHERE id = 1` in one transaction, then restart the API: the backfill writes every document again. The backfill keeps a document that exists, so the old ones must go first.

## Known differences

- Full-text ranking is not equal between engines. Both return the same set of ids for a query; for ranked results at least 4 of the first 5 ids match (decision D15). Postgres folds case for ASCII only and does not remove accents.
- Memory full text on Postgres reads the stored documents in `memory_fts` (migration 386). The memory store writes a document with each memory; at start it builds the documents that are missing. `packages/storage-postgres/bench/memory-fts.ts` measures the search and checks D15 parity on a synthetic corpus.
- `jsonb` reorders object keys. API responses carry the same keys and values in another order.
- Text longer than 100,000 characters in a task is searchable only in its first 100,000 characters.
- A Postgres write that loses a serialization race retries the whole transaction (up to 16 attempts). Five sites retry more than 5% under deliberate single-row races and stay at SERIALIZABLE by decision (ledger, D7 section).

## Rules for changes

- A new migration has one file for each engine with the same ordinal: `src/be/migrations/NNN_name.sql` and `src/be/migrations/postgres/NNN_name.sql`. A file may be a no-op for one engine, with a comment that says why. `bun run check:schema-parity` must pass. Never edit an applied migration.
- No new triggers (`bun run check:no-new-triggers`). Put new rules in repository code.
- A Postgres migration that changes rows must stay correct under `db-copy` (`bun run check:copy-migrations`): the copy writes the SQLite rows over the migrated target and records every migration as applied. A plain seed passes. For a rewrite of stored rows, list the migration in `after-copy.json`, port the rows in the copy, or write the reason in `scripts/storage-checks/copy-migrations-allowlist.txt`. A new column type needs a conversion in `packages/storage-postgres/src/data-copy.ts` and a sample in `packages/storage-postgres/test/data-copy-chain.test.ts`.
- SQL lives in the storage packages (`packages/storage*`) only (`bun run check:storage-boundary`). Write portable SQL with the dialect helpers; SQLite-only syntax stays in `packages/storage-sqlite` (`bun run check:sql-portability`). Quote each identifier that has an uppercase letter.
- Code tests a capability (`fullTextSearch`, `vectorSearch`, `dbQuery`), never the engine name.
- A transaction callback may run twice on Postgres. Side effects go in `afterCommit` (`bun run check:tx-callbacks`; prove it with `bun run e2e --tx-replay`).
- A site may run at READ COMMITTED with explicit row locks only when its stress scenario measures more than 5% retries (decision D7), with the reason in a code comment.
- A list method states a total order (no reliance on insertion order); `bun run test:storage` runs the repository contract suite on both engines.
- Prove a change on both engines: `bun run e2e --only <scenario>` and `bun run e2e --engine postgres --only <scenario>` (needs `E2E_POSTGRES_URL`, a role that may create databases).

## Type assertions

A repository returns the row type its callers use. Do not redeclare a storage row in `src/` and assert into it. An enum column takes its values from a `const` tuple in the storage package (`AGENT_STATUSES`, `TASK_STATUSES`), and `src/be/db/tasks/read.ts` fails to compile when a tuple drifts from `src/types.ts`. Narrow a caught value with `instanceof Error`, never `as Error`.

These assertion groups stay, with the reason:

- **Driver values in the engine packages.** `bun:sqlite` and the Postgres driver return untyped column values. A cast is allowed only where the SQL fixes the type (`COUNT(*)`, a `BLOB`, an `int8` as `bigint`), on the line that reads the value.
- **Contract tests.** A test narrows a projection union to read its ids, or passes a test double as `never` to a driver parameter. Both stay in `packages/storage*/test`.
- **Scripts.** E2E scenarios and `scripts/storage-checks` read JSON HTTP bodies and driver rows. A scenario asserts the fields it then checks.
- **The Bun SQL spike** under `thoughts/` is research and does not ship.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `another API process holds this Postgres database` | A second API (or a running `db-copy`) holds the lock. Stop it. |
| `lost the one-process lock ... did not answer within 10000 ms`, then a restart | The API could not reach its database for 10 s. Check the network path and the database. After a network cut, the next start can wait for the lock for up to about 25 s while the server ends the old session. |
| `out of shared memory` with the hint `max_pred_locks_per_transaction` | Raise the setting and restart Postgres ("Server settings"). Then find the statement that runs for seconds. |
| `could not resize shared memory segment` | The container has a small `/dev/shm` ("Server settings"). |
| `db-query is off: DATABASE_QUERY_URL is not set` / `failed its probe` | Create the reader role (above). The log names the failed probe rule. |
| `type "vector" does not exist` at the first start | Create the pgvector extension as a superuser, then start again. |
| `db-copy: migration heads differ` | Start this build once on the SQLite file, stop it, copy again. |
| `db-copy: the target database already holds tables` | Copy into a new, empty database. The copy runs the migrations itself. A migrated database (an API started on it, a restored dump) may hold edited seed rows (a renamed channel, a retitled widget) that the copy would replace, so it is refused. |
| `db-copy: the target database is at migration N, this build at M` | Same cause: the target already holds tables. Copy into a new, empty database. |
| `db-copy: the source embeddings have N dimensions` | Set `EMBEDDING_DIMENSIONS=N` (the API's value) and copy again. Nothing was written. |
| `[db-copy] N orphan row(s) in the source: checking values only` | The SQLite file holds rows whose parent row is gone. The run lists each one and writes nothing. Repair them (cutover section, "Refused rows"), then copy again. |
| `<table>: checked, not written` | A row before this table was refused. The copy still checks the table, so that one run lists every refused row. |
| `db-copy: --json ... is the SQLite source` | Write the report to another path. |
| `db-copy: no SQLite file at /app/data/...` (API image) | The container has no API data volume. Mount the volume of the API (`-v <api data volume>:/app/data`). |
| `db-copy needs the target: --to postgres://...` | Pass `--to`, or set `DATABASE_URL` in the container. |
| `[db-copy] FAILED: cannot connect to the target database` | The copy cannot reach Postgres, or the URL is wrong. In the API image: run the container on the network of the API (`--network`), or use an address that the container can reach. Nothing was written. |
| `=== Agent Swarm API` banner, then the server starts | The image is older than `db-copy` support in the API image, or `db-copy` is not the first argument after the image name. Use the API image tag of this build. A Compose service that sets its own `entrypoint` ignores the arguments, so `docker compose run <api service> db-copy ...` boots the API there: use `docker run --entrypoint /usr/local/bin/agent-swarm-api <api image>:<api tag> db-copy ...`. |
| `[db-copy] ATTENTION metrics ...` | Edit that dashboard query into Postgres SQL (`$n` placeholders, quoted camelCase columns) after the cutover. |
| `db-copy: cannot store <table>.<column> (rowid N): ...` | Fix that value in the SQLite file, then copy again. Nothing was written. |

Sources: decision records in `thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine-goal-prompt.md` (D1 to D18) and the ledger `thoughts/taras/plans/2026-11-20-postgres-storage-engine-ledger.md`.
