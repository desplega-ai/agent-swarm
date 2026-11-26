# Data: SQL over drive files

`data-query` runs one read-only DuckDB query over tabular files on your agent-fs drive and returns the rows. In a script it is `ctx.data.query`. It runs as your own agent-fs identity, so you read what your key can read.

Formats: csv, tsv, parquet, json, ndjson/jsonl and xlsx (first tab), each also as `.gz` except parquet and xlsx.

## When to use it

- A person hands over a CSV or xlsx and asks "how many", "which", "top N", "by month".
- A file on the drive is bigger than a screen: count, filter, join or aggregate it here, never `cat` it into context.
- A weekly roll-up over files that a job writes to the drive.

## When not to use it

- Questions about the swarm itself (tasks, agents, events): `db-query`.
- A 5-row file: reading it is fine.
- sqlite and `.duckdb` files: refused for now. Export the table to csv or parquet first.

## Queries

Name a file in table position.

```sql
SELECT region, sum(amount) AS total
FROM '/shared/sales/2026-q4.csv'
GROUP BY 1 ORDER BY 2 DESC
```

Join two files:

```sql
SELECT c.name, count(*) AS orders
FROM '/shared/sales/orders.parquet' o
JOIN '/shared/sales/customers.csv' c ON c.id = o.customer_id
GROUP BY 1 ORDER BY 2 DESC LIMIT 10
```

See a schema before you write the real query: `DESCRIBE SELECT * FROM '<path>'`.

Bind a table by name when the path has no usable extension, or to override the format:

```ts
await ctx.data.query({
  sql: "SELECT count(*) AS n FROM t",
  tables: { t: { path: "/shared/exports/latest", format: "csv" } },
});
```

`driveId` reads another drive in your org that your key can see. One query reads one drive.

## Hand the result over

| The result goes to... | Do |
|---|---|
| A chat answer or task output | `card: true`, then pass the returned `card` as the `uiSpec` spec (or put it in `slack-reply`/`chat-reply` `card`) |
| Something people keep, filter or edit | `sheet: { path }` under the task's asset key (for example `shared/<slug>/result.sheet.json`). Create-only. Hand over the returned `link` |
| A page | Save it as a sheet, then embed it with `<swarm-object>` (the `pages` skill) |
| An app | Save it as a sheet, then show it with `ObjectEmbed` (the `apps` skill) |

The card holds the first 100 rows and 20 columns. A sheet holds a header row plus the rows (at most 10,000 cells in one call). Text that starts with `=` is stored as text, not as a formula.

```ts
export default async function (args, ctx) {
  const a = args ?? {};
  const { rows, sheet } = await ctx.data.query({
    sql: "SELECT stage, count(*) AS n FROM '/shared/outreach/queue.csv' GROUP BY 1",
    sheet: { path: `${a.dir ?? "shared/outreach/"}stages.sheet.json` },
  });
  return { rows, link: sheet?.link };
}
```

## Limits

| | MCP `data-query` | `ctx.data.query` |
|---|---|---|
| Rows returned | 100 by default, 1,000 at most | 1,000 by default, 10,000 at most |
| Time | 30 s per query, downloads included | the same; raise the script `timeout` for big scans |

Every query downloads each file it names in full: up to about 200 MB or 5M Parquet rows per query is fine (2-6 s). Result size is capped at 16 MB. When `truncated` is true, aggregate in SQL (`GROUP BY`, `LIMIT`) instead of raising `maxRows`.

## Errors

- `File not found: <path>`: check the path with `agent-fs ls <dir>`. Paths are exact and case-sensitive.
- `LocalFileSystem has been disabled`: the query tried to read something that is not a bound drive file (a glob, `read_csv(...)`, an `https://` URL, `COPY ... TO`). Name each file as a path literal instead.
- `Too many SQL queries running`: agent-fs runs 4 queries at once. Wait a few seconds and retry once.
- `Query timed out`: aggregate earlier, select fewer columns, or split the files.

Writes are not supported: no `COPY`, `INSERT` or `CREATE` on drive files. Save results with `sheet`.
