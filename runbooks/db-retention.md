# Database retention runbook

## Permanent-loss warning

Database retention permanently deletes rows. Unsetting a retention key stops future sweeps. It cannot restore deleted rows. Activate retention only when you have verified backups for the data you need.

- `session_logs` deletion removes the line-by-line session transcript. Old task log views and resume preambles become empty.
- `agent_log` deletion removes task and agent state-transition history. Old activity timelines become empty.
- `events` deletion removes telemetry. Aggregate event counters become retention-window totals, not all-time totals. A newer event can retain a `parentEventId` for a deleted older event.

## Scope and safety boundary

The server sweeps only this closed code-reviewed list:

| Table | Retention key | Deleted data |
| --- | --- | --- |
| `session_logs` | `SESSION_LOG_RETENTION_DAYS` | Session transcripts |
| `agent_log` | `AGENT_LOG_RETENTION_DAYS` | Task and agent history |
| `events` | `EVENTS_RETENTION_DAYS` | Telemetry events |

Table and column names never come from configuration. An operator can set a retention duration only. An unset key disables that table's sweep. Values must be whole days from 1 through 1,000,000. Use at least seven days unless you have verified that a shorter window is suitable for your deployment.

To add a table, change the closed descriptor list in `src/be/db-retention.ts`, add a validator, catalog entry, metrics field, docs row, and parameterized tests in the same PR. Add a table only when it has an index on its time column, no incoming foreign keys, and readers that safely tolerate missing old rows. A new table also needs an `EXPLAIN QUERY PLAN` assertion in the retention tests, confirming the delete uses the index rather than a table scan.

## Activate retention

1. Verify that database backups include the history you need.
2. Set one retention key, for example `SESSION_LOG_RETENTION_DAYS=30`.
3. Set `DB_RETENTION_DRY_RUN=true`.
4. Wait for the hourly sweep. Watch `agentswarm.db.retention.backlog` and `agentswarm.db.retention.sweeps{outcome:error}` in your OTLP metrics backend, and `GET /api/metrics` for the same numbers. API stdout is not exported through OTLP, so a `[db-retention]` log line is not a monitoring surface — it is a local debugging aid only.
5. Confirm that the exact would-delete count and data-loss effect are acceptable.
6. Set `DB_RETENTION_DRY_RUN=false`.
7. Recheck the next sweep. Enable the remaining tables one at a time only after this is stable.

The sweep runs hourly once every enabled table is drained. While any table is undrained it runs again every `DB_RETENTION_CATCHUP_INTERVAL_MS` (default 60 s) instead of waiting for the next hourly tick. Each tick divides a `DB_RETENTION_TICK_BUDGET_MS` budget (default 30 s) evenly across the enabled tables, and rotates which table sweeps first each tick so one table's backlog cannot starve the others. Deletes go oldest-first through the table's `createdAt` index, in batches sized adaptively against `DB_RETENTION_MAX_STATEMENT_MS` (default 250 ms per statement, measured as driver execution time — waiting for the database lock does not count against it and cannot shrink the batch).

Each of the three tuning settings has its own accepted range: 1000–300000 ms for the tick budget, 5000–3600000 ms for the catch-up interval, 25–5000 ms for the statement target. The config API rejects a value outside the range, and a value set directly in the environment falls back to the default instead of taking effect.

A tick makes up to two passes. Pass 1 gives every enabled table its even slice. Pass 2 revisits the tables pass 1 left undrained, for as long as tick budget remains. So a table can be swept twice in one tick, and **each attempt emits its own sweep metric point and its own `db.retention.table` span**. Read `agentswarm.db.retention.sweeps` as one point per attempt, not one point per tick.

A table that pass 1 never reached — because a slower table ahead of it used the tick budget first — counts as undrained. It reports no sweep record for that tick, and it arms the catch-up tick. It never waits for the hourly timer.

A table counts as drained only when its closing `COUNT(*)` finds no row older than the horizon, so `drained` and `backlogRemaining` in `GET /api/metrics` always agree. A row that another process commits after the sweep's final `DELETE` therefore leaves the table undrained and arms catch-up, instead of going unnoticed until the next hourly tick.

A dry run is different: it deletes nothing, so its backlog can never shrink. It runs pass 1 only, and it never arms catch-up. A dry-run table therefore emits at most one sweep point per hourly tick — a table the tick budget never reached that hour emits none. Turn dry run off to make the drain converge.

A failed sweep stores its error message on `lastError` in `GET /api/metrics`. That message is passed through the shared secret scrubber first, so a credential inside a database error surfaces as `[REDACTED:<name>]`.

An errored table counts as undrained, the same as a table pass 1 never reached. It retries in pass 2 of the same tick, and again every `DB_RETENTION_CATCHUP_INTERVAL_MS` until it succeeds — there is no backoff. A persistent error therefore produces about two `outcome:error` sweep points per minute and a DELETE attempt against the database every catch-up interval, for as long as the error lasts.

An `outcome:error` point is not a zero-progress point. Every batch is its own autocommit `DELETE`, so a sweep that fails on a later batch has already deleted the rows of the batches before it. The error point reports exactly those rows and batches, and `cumulativeRowsDeleted` advances by them. `backlogRemaining` is the exception: it holds its previous value, because it is a gauge and zeroing it would read as drained.

Telemetry is best-effort. A broken OTLP exporter cannot fail a tick or turn a completed `DELETE` into a failed sweep: every span and metric call is wrapped, and a failure is logged once per tick and otherwise ignored.

## Monitoring

| # | Monitor | Query | Catches |
| --- | --- | --- | --- |
| 1 | Sweep errors | sum of `agentswarm.db.retention.sweeps` where `outcome = error`, grouped by `table`, above 0 over 2 h | A sweep that throws. Fires within 2 ticks. |
| 2 | Backlog not draining | max of `agentswarm.db.retention.backlog`, grouped by `table`; alert when the 6-hour change is ≥ 0 and the value is > 0 | Every silent non-completion: errors, a too-slow sweep, a regression to the old decay. Build this one first — it is stated in the operator's terms and does not depend on knowing the failure mode. |
| 3 | Sweep absent | no data for `agentswarm.db.retention.sweeps` for 3 h | The sweep stopped running: crashed timer, lost config, a pod that never started it. |
| 4 | Stall guard | max of `agentswarm.db.retention.slowest_statement_ms`, grouped by `table`, above 2000 over 1 h | The adaptive sizer failing to hold the statement bound, before the 10-second liveness probe notices. Only driver execution counts, so waiting for the database lock cannot raise this on its own. |

## Turn on the remaining tables

Enable tables one at a time, watching the monitors above before moving to the next:

1. Confirm the first table (see **Activate retention** above) is stable for at least 24 hours at steady state — its backlog stays near 0 across hourly ticks.
2. Turn on the smallest remaining table next; it is the cheapest way to prove budget division across 2 tables. Confirm both tables report a sweep record on the steady-state hourly ticks — neither starves the other. A table that reports no record for a tick was not reached inside the budget; it arms catch-up, so check that its backlog still falls across the following ticks.
3. Turn on the third table at a conservative retention horizon first, and confirm all 3 tables report a sweep record on steady-state hourly ticks before narrowing that horizon. Narrowing a horizon after the fact is a data-loss decision, not a default — get an explicit sign-off before doing it on a table holding a large backlog.

## Disk space and SQLite vacuuming

Deleting rows frees SQLite pages for reuse. It does not normally reduce the database file size.

`PRAGMA incremental_vacuum(2000)` runs only after a non-dry-run sweep actually deletes rows. It does not run while every policy is disabled, when a sweep finds nothing to delete, or during dry run. It reclaims file space only when the database uses `auto_vacuum = INCREMENTAL`. Changing that mode requires a one-time blocking `VACUUM` operation. Schedule it in a maintenance window. Do not run `VACUUM` automatically on a production API database.

```sql
PRAGMA auto_vacuum = INCREMENTAL;
VACUUM;
```

For a smaller copy without changing the active file, plan an offline `VACUUM INTO` operation and verify the backup and cutover procedure first.

## Rollback

Unset the affected retention key. The table stops sweeping on its next tick, and a pending catch-up tick finds nothing to do and cancels itself. Keep `DB_RETENTION_DRY_RUN=true` if you need to inspect candidates without deletion. Restoration of already-deleted rows requires an operator backup.
