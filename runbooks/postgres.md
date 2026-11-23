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

- Postgres 16 with the pgvector extension (memory vector search). CI uses `pgvector/pgvector:pg16`.
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

More than one API replica is not supported on either engine. The parts that a second replica would break are listed, with file and line, in `thoughts/taras/research/2026-11-20-replica-blockers.md`: the in-memory realtime bus (`src/realtime/bus.ts`), the workflow event bus (`src/workflows/event-bus.ts`), in-memory locks (`src/oauth/ensure-mcp-token.ts`), per-process caches, and timers with no leader election.

## Backups

Litestream replicates the SQLite WAL only. On Postgres use the provider's backups or `pg_dump --format=custom`. Back up the API volume too (encryption key).

## Production cutover (SQLite to Postgres)

`agent-swarm db-copy` copies a SQLite file into an empty Postgres database at the same migration head. It runs in one transaction: a value Postgres cannot store, a foreign key that fails, or a count or checksum that differs leaves the target empty and exits 1.

Before the window:

1. Deploy the target build on SQLite as usual. Let it start once, so the SQLite file is at this build's migration head.
2. Create the Postgres database and role (Requirements). Do not start an API on it.
3. Rehearse: copy a recent backup of the SQLite file into a scratch database with `db-copy` (same command as step 3 of the window, with the backup mounted and the scratch database as `--to`). Fix every refused value it reports in the source (a NUL byte, invalid UTF-8, an invalid timestamp, a flag that is not 0 or 1, invalid JSON). The copy does not replace or drop values for you. Read every `ATTENTION` line too: a saved dashboard query in SQLite SQL that the copy does not know (an edited widget, a hand-written dashboard) does not run on Postgres. The copy rewrites only the stock queries of the starter dashboard and of the old new-dashboard template, and keeps titles and other edits. Plan an edit for each listed query. Set `EMBEDDING_DIMENSIONS` to the value the API uses: the copy refuses embeddings of another width.
4. Start a test API on the scratch copy with the restricted reader configured in `DATABASE_QUERY_URL`. Run each custom dashboard with representative filter values and compare its results with SQLite. The copy uses PostgreSQL `EXPLAIN` to check custom queries. A query can pass that check and then fail when it converts a value in a stored row.

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
   Expect `[db-copy] done: <n> tables, <m> rows, every count and checksum equal` and exit 0. The report lists each table's row counts and checksums, the skipped SQLite-only tables (FTS5 and sqlite-vec indexes, migration bookkeeping) and the rebuilt vector rows. Exit 3 means the copy committed but the report could not be written. Exit 4 means the copy committed but the dashboard check after COMMIT could not run (for example no connection was free): each `NOT CHECKED` line names an unverified saved query. Run each one on Postgres before you start the API.
4. Set `DATABASE_URL` (and `DATABASE_QUERY_URL` if the reader role exists). Keep the same encryption key: secrets copy as ciphertext.
5. Start the API. Check `[db] Postgres engine ready`, `/health`, the dashboard task list, a secret config value, and one memory search.

Rollback: stop the API, unset `DATABASE_URL`, start it again. It runs on the untouched SQLite file. Writes made on Postgres after the cutover are not copied back.

What the copy does, step by step: opens the SQLite file read-only; refuses a target that holds any table; runs the Postgres migrations inside the copy transaction, so a refused copy leaves the target empty and a re-run works; disables user triggers during the copy; converts each value to its column type (booleans, `bigint`, `jsonb`, `timestamptz` from both SQLite timestamp formats, `bytea`); keeps SQLite `rowid` as `_rowid`; rebuilds `memory_vec` from the copied embeddings (full text needs no rebuild: it is an expression index); restarts identity sequences; compares row counts and checksums of normalized values per table.

## Known differences

- Full-text ranking is not equal between engines. Both return the same set of ids for a query; for ranked results at least 4 of the first 5 ids match (decision D15). Postgres folds case for ASCII only and does not remove accents.
- `jsonb` reorders object keys. API responses carry the same keys and values in another order.
- Text longer than 100,000 characters in a task is searchable only in its first 100,000 characters.
- A Postgres write that loses a serialization race retries the whole transaction (up to 16 attempts). Five sites retry more than 5% under deliberate single-row races and stay at SERIALIZABLE by decision (ledger, D7 section).

## Rules for changes

- A new migration has one file for each engine with the same ordinal: `src/be/migrations/NNN_name.sql` and `src/be/migrations/postgres/NNN_name.sql`. A file may be a no-op for one engine, with a comment that says why. `bun run check:schema-parity` must pass. Never edit an applied migration.
- No new triggers (`bun run check:no-new-triggers`). Put new rules in repository code.
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
| `db-query is off: DATABASE_QUERY_URL is not set` / `failed its probe` | Create the reader role (above). The log names the failed probe rule. |
| `type "vector" does not exist` at the first start | Create the pgvector extension as a superuser, then start again. |
| `db-copy: migration heads differ` | Start this build once on the SQLite file, stop it, copy again. |
| `db-copy: the target database already holds tables` | Copy into a new, empty database. The copy runs the migrations itself. A migrated database (an API started on it, a restored dump) may hold edited seed rows (a renamed channel, a retitled widget) that the copy would replace, so it is refused. |
| `db-copy: the target database is at migration N, this build at M` | Same cause: the target already holds tables. Copy into a new, empty database. |
| `db-copy: the source embeddings have N dimensions` | Set `EMBEDDING_DIMENSIONS=N` (the API's value) and copy again. Nothing was written. |
| `db-copy: --json ... is the SQLite source` | Write the report to another path. |
| `db-copy: no SQLite file at /app/data/...` (API image) | The container has no API data volume. Mount the volume of the API (`-v <api data volume>:/app/data`). |
| `db-copy needs the target: --to postgres://...` | Pass `--to`, or set `DATABASE_URL` in the container. |
| `[db-copy] FAILED: cannot connect to the target database` | The copy cannot reach Postgres, or the URL is wrong. In the API image: run the container on the network of the API (`--network`), or use an address that the container can reach. Nothing was written. |
| `=== Agent Swarm API` banner, then the server starts | The image is older than `db-copy` support in the API image, or `db-copy` is not the first argument after the image name. Use the API image tag of this build. |
| `[db-copy] ATTENTION metrics ...` | Edit that dashboard query into Postgres SQL (`$n` placeholders, quoted camelCase columns) after the cutover. |
| `db-copy: cannot store <table>.<column> (rowid N): ...` | Fix that value in the SQLite file, then copy again. Nothing was written. |

Sources: decision records in `thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine-goal-prompt.md` (D1 to D18) and the ledger `thoughts/taras/plans/2026-11-20-postgres-storage-engine-ledger.md`.
