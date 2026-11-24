// db-query: read queries in parallel (counts, group by, a join), one query
// that hits the row limit, and write attempts that the route must refuse.
// Identifiers with capitals are in double quotes, which both engines accept.
export default async function (_args: unknown, ctx: ScriptContext) {
  return stressRun(ctx, "db-query", async (t, env) => {
    const q = (sql: string, params?: unknown[]) =>
      ctx.swarm.db_query(params ? { sql, params } : { sql }) as Promise<Sdk>;

    const first = await q("select count(*) as n from scheduled_tasks where name like 'stress-%'");
    t.ok("count-query-works", first.success && dbRows(first).length === 1, {
      status: first.status,
      error: first.data?.error,
    });
    const dialect = String(first.data?.dialect ?? "unknown");
    const stressSchedules = Number(dbRows(first)[0]?.n ?? -1);
    const placeholder = dialect === "postgres" ? "$1" : "?";

    // 1. Read queries, three at a time (the route allows about three at once).
    const reads: [string, string, unknown[]?][] = [
      ["count-kv", "select count(*) as n from kv_entries"],
      ["count-runs", "select count(*) as n from script_runs"],
      ["group-by", "select status, count(*) as n from script_runs group by status order by status"],
      [
        "join",
        `select w.name as name, count(r.id) as runs from workflows w left join workflow_runs r on r."workflowId" = w.id where w.name like 'stress-%' group by w.name order by w.name`,
      ],
      [
        "param",
        `select count(*) as n from scheduled_tasks where name like ${placeholder}`,
        ["stress-%"],
      ],
      ["order", "select name from scheduled_tasks where name like 'stress-%' order by name"],
      [
        "aggregate",
        `select "nodeType" as node_type, status, count(*) as n from workflow_run_steps group by "nodeType", status order by 1, 2`,
      ],
    ];
    const rounds = Array.from({ length: env.level }, () => reads).flat();
    const answers = await pooled(rounds, 3, async ([name, sql, params]) => ({
      name,
      res: await q(sql, params),
    }));
    const readProblems = answers
      .filter((a) => !a.res.success)
      .map((a) => `${a.name}: HTTP ${a.res.status} ${String(a.res.data?.error).slice(0, 120)}`);
    t.ok("parallel-reads-all-answer", readProblems.length === 0, readProblems.slice(0, 4));

    const byName = (name: string) => answers.find((a) => a.name === name)?.res as Sdk;
    const viaParam = Number(dbRows(byName("param"))[0]?.n ?? -2);
    t.ok("bound-parameter-matches-literal", viaParam === stressSchedules, {
      viaParam,
      stressSchedules,
    });
    const names = dbRows(byName("order")).map((row) => String(row.name));
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    t.ok("order-by-is-byte-order", names.join(",") === sorted.join(","), {
      names: names.slice(0, 6),
    });
    const joined = dbRows(byName("join"));
    t.ok(
      "join-returns-one-row-per-workflow",
      new Set(joined.map((row) => row.name)).size === joined.length,
      joined.slice(0, 3),
    );
    const groups = dbRows(byName("group-by"));
    const total = Number(dbRows(byName("count-runs"))[0]?.n ?? 0);
    const grouped = groups.reduce((sum, row) => sum + Number(row.n), 0);
    // Runs finish between the two queries, so the sums may differ a little.
    t.ok("group-by-sums-near-the-count", Math.abs(grouped - total) <= 50, { grouped, total });

    // 2. A query that returns more rows than the limit allows.
    const many = await q(
      "with recursive n(i) as (select 1 union all select i + 1 from n where i < 1500) select i from n",
    );
    const limit = Number(many.data?.rowLimit ?? 0);
    t.ok(
      "row-limit-truncates-without-error",
      many.success && many.data?.truncated === true && (many.data?.rows ?? []).length === limit,
      {
        status: many.status,
        rows: (many.data?.rows ?? []).length,
        limit,
        truncated: many.data?.truncated,
        error: many.data?.error,
      },
    );

    // 3. Writes. Each statement changes nothing even if it ran, and each one
    //    must be refused with a 4xx.
    const writes: [string, string][] = [
      ["delete", "delete from kv_entries where 1 = 0"],
      ["update", "update kv_entries set key = key where 1 = 0"],
      ["insert", "insert into kv_entries (namespace, key) select 'stress', 'never' where 1 = 0"],
      [
        "delete-in-cte",
        "with gone as (delete from kv_entries where 1 = 0 returning key) select count(*) as n from gone",
      ],
      ["create-temp-table", "create temporary table stress_never (id integer)"],
    ];
    const refusals = await pooled(writes, 3, async ([name, sql]) => ({ name, res: await q(sql) }));
    for (const { name, res } of refusals) {
      t.ok(`write-refused:${name}`, res.status >= 400 && res.status < 500, {
        status: res.status,
        error: String(res.data?.error ?? "").slice(0, 160),
      });
    }

    // 4. A table that holds credentials. Recorded, and it must not be a 5xx.
    const secret = await q("select count(*) as n from session_tokens");
    t.ok("credential-table-read-is-not-5xx", secret.status < 500, { status: secret.status });

    return {
      dialect,
      reads: rounds.length,
      rowLimit: limit,
      credentialTableStatus: secret.status,
      refusalStatuses: Object.fromEntries(refusals.map((r) => [r.name, r.res.status])),
    };
  });
}
