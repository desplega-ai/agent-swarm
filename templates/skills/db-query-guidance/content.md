# DB Query Guidance

The swarm database is SQLite, reachable read-only through the `db-query` MCP
tool and the `POST /api/db-query` HTTP route (same executor underneath).

## Execution model

By default a query runs in a short-lived child process with a wall-clock
budget (10s over HTTP, 5s over MCP) — the API keeps answering other requests
while it runs, and a query past its budget is killed. That protection can be
off: an operator can disable it, or a host with no separate `bun` executable
on `$PATH` falls back to running the query in-process with no budget. On the
fallback path, a query that reads millions of rows can stop the API long
enough for Kubernetes to restart it, failing every task in flight, even
though it doesn't crash anything outright.

Failures are documented and machine-readable, not a generic 400:

| Condition | HTTP status | Error code |
|---|---|---|
| Query ran past its budget | 408 | `db_query_timeout` |
| Too many bounded queries already in flight | 429 (with `Retry-After`) | `db_query_concurrency_cap` — retry shortly |
| Write statement, bad SQL, multiple statements | 400 | (message describes the problem) |

## Four tables are too large to read whole

`session_logs`, `agent_log`, `events`, `task_context_snapshots`.

For these four tables:

- Filter on an indexed column. `session_logs`: `taskId`, `sessionId`.
  `agent_log`: `agentId`, `taskId`, `eventType`, `createdAt`.
- Add `LIMIT 1000` or less.
- Do not use `COUNT(*)`, `SUM(...)`, or `typeof()` across the table.
- Do not split a large read into `rowid` chunks — each chunk still reads
  every row in its range. Chunking does not make a large read safe.

If you need a row total or a column type census, ask the lead. Do not derive
it yourself by scanning the table.

## Operator config knobs

All are read dynamically (a `swarm_config` edit or env var change takes
effect on the next request, no restart) and surfaced on the dashboard's
**Settings → Configuration → Database queries** group.

| Env var | Default | Controls |
|---|---|---|
| `DB_QUERY_BOUNDED_ENABLED` | `true` | Master kill switch for the bounded child-process path. `false` restores the pre-fix synchronous, unbounded path and logs a one-time startup-class warning. |
| `DB_QUERY_HTTP_BUDGET_MS` | `10000` | Wall-clock budget for `/api/db-query` before its child process is killed. |
| `DB_QUERY_HTTP_MAX_ROWS` | `1000` | Row cap for `/api/db-query`, regardless of how many rows the query matched. |
| `DB_QUERY_MCP_BUDGET_MS` | `5000` | Wall-clock budget for the MCP `db-query` tool. |
| `DB_QUERY_MCP_MAX_ROWS` | `100` | Row cap for the MCP `db-query` tool, regardless of how many rows the query matched. |
| `DB_QUERY_CONCURRENCY_CAP` | `3` | Max bounded queries in flight at once, across HTTP and MCP callers. Each in-flight query can peak around 200MB; the default is sized against a 1 GiB API pod memory limit — raise it only if the pod has more headroom. |

`total` in a result always reports every row SQLite matched, even when the
returned `rows` are capped — compare the two to detect truncation.
