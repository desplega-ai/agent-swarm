// Scoreboard: reads the result records and the run tables, writes
// stress/scoreboard, and deletes old records so KV does not grow.
const WINDOW_MS = 10 * 60_000;
/** Result records older than this are deleted. */
const KEEP_RESULTS_MS = 3 * 3600_000;
/** Scratch keys of a run (counters, edge values) older than this are deleted. */
const KEEP_SCRATCH_MS = 15 * 60_000;
/** A stress workflow run that is still open after this long counts as stuck. */
const STUCK_MS = 10 * 60_000;
const SCRATCH_PREFIXES = [
  "stress/wf/",
  "stress/ctr/",
  "stress/edge/",
  "stress/storm/",
  "stress/reject/",
];

async function listAll(ctx: ScriptContext, prefix: string, max: number): Promise<Any[]> {
  const out: Any[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const page = (await ctx.swarm.kv_list({ namespace: NS, prefix, limit: 1000, offset })) as Sdk;
    const entries: Any[] = page.data?.entries ?? [];
    out.push(...entries);
    if (entries.length < 1000) break;
  }
  return out;
}

export default async function (_args: unknown, ctx: ScriptContext) {
  const g = await gate(ctx);
  if (!g.enabled) return { skipped: "stress/enabled is not true" };
  try {
    return await build(ctx, g.level);
  } catch (err) {
    // The run still completes, so the schedule does not count an error.
    await ctx.swarm.kv_set({
      namespace: NS,
      key: "stress/scoreboard-error",
      value: { at: new Date().toISOString(), error: errText(err) },
    });
    return { ok: false, error: errText(err) };
  }
}

async function build(ctx: ScriptContext, level: number) {
  const now = Date.now();
  const installedAt = String((await kvValue(ctx, "stress/installedAt")) ?? "");
  const sinceIso = installedAt || new Date(now - 24 * 3600_000).toISOString();
  const windowIso = new Date(now - WINDOW_MS).toISOString();
  const problems: string[] = [];

  // 1. Result records: per piece, the last 10 minutes and the newest failure.
  const records = await listAll(ctx, "stress/results/", 20_000);
  type Piece = {
    pass10m: number;
    fail10m: number;
    passTotal: number;
    failTotal: number;
    avgMs: number;
    maxMs: number;
    lastAt: string;
    failing: Record<string, { count: number; count10m: number; newestError: string; at: string }>;
  };
  const pieces: Record<string, Piece> = {};
  const piece = (name: string): Piece => {
    pieces[name] ??= {
      pass10m: 0,
      fail10m: 0,
      passTotal: 0,
      failTotal: 0,
      avgMs: 0,
      maxMs: 0,
      lastAt: "",
      failing: {},
    };
    return pieces[name] as Piece;
  };
  const sumMs: Record<string, { sum: number; n: number }> = {};
  const stale: string[] = [];
  for (const entry of records) {
    const rec = entry.value ?? {};
    const at = Number(rec.at ?? entry.createdAt ?? 0);
    if (now - at > KEEP_RESULTS_MS) stale.push(String(entry.key));
    if (typeof rec.name !== "string") continue;
    const p = piece(rec.name);
    const iso = new Date(at).toISOString();
    if (iso > p.lastAt) p.lastAt = iso;
    if (now - at <= WINDOW_MS) {
      if (rec.ok) p.pass10m++;
      else p.fail10m++;
    }
    const ms = Number(rec.ms ?? 0);
    const agg = sumMs[rec.name] ?? { sum: 0, n: 0 };
    sumMs[rec.name] = agg;
    agg.sum += ms;
    agg.n++;
    if (ms > p.maxMs) p.maxMs = ms;
    for (const failure of (rec.failed ?? []) as Any[]) {
      const check = String(failure.check);
      const seen = p.failing[check] ?? { count: 0, count10m: 0, newestError: "", at: "" };
      p.failing[check] = seen;
      seen.count++;
      if (now - at <= WINDOW_MS) seen.count10m++;
      if (iso >= seen.at) {
        seen.at = iso;
        seen.newestError = String(failure.error ?? "").slice(0, 300);
      }
    }
  }
  for (const [name, agg] of Object.entries(sumMs)) piece(name).avgMs = Math.round(agg.sum / agg.n);

  // Running totals since install (every result write increments one of them).
  for (const entry of await listAll(ctx, "stress/totals/", 2000)) {
    const [, , name, kind] = String(entry.key).split("/");
    if (!name) continue;
    if (kind === "pass") piece(name).passTotal = Number(entry.value);
    if (kind === "fail") piece(name).failTotal = Number(entry.value);
  }

  // 2. Run tables. Three queries at a time at most.
  const q = async (label: string, sql: string, params?: unknown[]) => {
    const res = (await ctx.swarm.db_query(params ? { sql, params } : { sql })) as Sdk;
    if (!res.success)
      problems.push(`${label}: HTTP ${res.status} ${String(res.data?.error).slice(0, 160)}`);
    return dbRows(res);
  };
  const dialect = String(
    ((await ctx.swarm.db_query({ sql: "select 1 as one" })) as Sdk).data?.dialect ?? "unknown",
  );
  const ph = (n: number) => (dialect === "postgres" ? `$${n}` : "?");
  const byStatus = (rows: Record<string, Any>[]) =>
    Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
  const scriptSql = (n: number) =>
    `select status, count(*) as n from script_runs where "scriptName" like 'stress-%' and "startedAt" >= ${ph(n)} group by status`;
  const wfSql = (n: number) =>
    `select r.status as status, count(*) as n from workflow_runs r join workflows w on w.id = r."workflowId" where w.name like 'stress-%' and r."startedAt" >= ${ph(n)} group by r.status`;
  const [scripts10m, scriptsTotal, wf10m] = await Promise.all([
    q("script runs 10m", scriptSql(1), [windowIso]),
    q("script runs total", scriptSql(1), [sinceIso]),
    q("workflow runs 10m", wfSql(1), [windowIso]),
  ]);
  const [wfTotal, wfByName, stuck] = await Promise.all([
    q("workflow runs total", wfSql(1), [sinceIso]),
    q(
      "workflow runs by name",
      `select w.name as name, r.status as status, count(*) as n from workflow_runs r join workflows w on w.id = r."workflowId" where w.name like 'stress-%' and r."startedAt" >= ${ph(1)} group by w.name, r.status order by w.name, r.status`,
      [sinceIso],
    ),
    q(
      "stuck workflow runs",
      `select r.id as id, w.name as name, r.status as status, r."startedAt" as started from workflow_runs r join workflows w on w.id = r."workflowId" where w.name like 'stress-%' and r.status in ('running', 'waiting') and r."startedAt" < ${ph(1)} order by r."startedAt" limit 20`,
      [new Date(now - STUCK_MS).toISOString()],
    ),
  ]);
  const [failedSteps, schedules, slowSteps, failedScripts] = await Promise.all([
    q(
      "unexpected failed steps",
      `select w.name as name, s."nodeId" as node, count(*) as n, max(s.error) as error from workflow_run_steps s join workflow_runs r on r.id = s."runId" join workflows w on w.id = r."workflowId" where w.name like 'stress-%' and s.status = 'failed' and s."startedAt" >= ${ph(1)} and (s.error is null or s.error not like '%${EXPECTED}%') group by w.name, s."nodeId" order by n desc limit 20`,
      [sinceIso],
    ),
    q(
      "schedules",
      `select name, enabled, "consecutiveErrors" as errors, "lastErrorMessage" as last_error, "lastRunAt" as last_run from scheduled_tasks where name like 'stress-%' order by name`,
    ),
    q(
      "runs by workflow 10m",
      `select w.name as name, count(*) as n from workflow_runs r join workflows w on w.id = r."workflowId" where w.name like 'stress-%' and r."startedAt" >= ${ph(1)} group by w.name order by w.name`,
      [windowIso],
    ),
    q(
      "failed script runs",
      `select "scriptName" as name, count(*) as n, max(error) as error from script_runs where "scriptName" like 'stress-%' and status = 'failed' and "startedAt" >= ${ph(1)} group by "scriptName" order by n desc`,
      [sinceIso],
    ),
  ]);
  // stress-sandbox-case fails on purpose (its throw and timeout cases).
  const unplannedFailures = failedScripts.filter((row) => row.name !== "stress-sandbox-case");
  if (unplannedFailures.length > 0) {
    problems.push(
      `failed script runs outside the planned ones: ${unplannedFailures.map((row) => `${row.name} x${row.n}`).join(", ")}`,
    );
  }

  const sickSchedules = schedules.filter(
    (row) => Number(row.errors ?? 0) > 0 || row.enabled === false || row.enabled === 0,
  );
  if (stuck.length > 0)
    problems.push(`${stuck.length} stress workflow run(s) open for over 10 minutes`);
  if (sickSchedules.length > 0) {
    problems.push(`${sickSchedules.length} stress schedule(s) with errors or disabled`);
  }
  if (failedSteps.length > 0)
    problems.push(`${failedSteps.length} workflow node(s) failed outside the planned failures`);

  // PostgreSQL only: transaction counters since the last scoreboard. A rolled
  // back transaction is a serialization retry or a refused statement.
  let engine: Record<string, unknown> | undefined;
  if (dialect === "postgres") {
    const stat = (
      await q(
        "postgres statistics",
        "select xact_commit, xact_rollback, deadlocks, numbackends from pg_stat_database where datname = current_database()",
      )
    )[0];
    if (stat) {
      const prev = (await kvValue(ctx, "stress/pgstat")) ?? {};
      const cur = {
        commits: Number(stat.xact_commit),
        rollbacks: Number(stat.xact_rollback),
        deadlocks: Number(stat.deadlocks),
        at: now,
      };
      await ctx.swarm.kv_set({ namespace: NS, key: "stress/pgstat", value: cur });
      const commits = cur.commits - Number(prev.commits ?? cur.commits);
      const rollbacks = cur.rollbacks - Number(prev.rollbacks ?? cur.rollbacks);
      const deadlocks = cur.deadlocks - Number(prev.deadlocks ?? cur.deadlocks);
      engine = {
        connections: Number(stat.numbackends),
        sinceLastBoard: {
          seconds: Math.round((now - Number(prev.at ?? now)) / 1000),
          commits,
          rollbacks,
          rollbackPct:
            commits + rollbacks > 0
              ? Math.round((1000 * rollbacks) / (commits + rollbacks)) / 10
              : 0,
          deadlocks,
        },
      };
      if (deadlocks > 0)
        problems.push(`${deadlocks} PostgreSQL deadlock(s) since the last scoreboard`);
    }
  }

  // 3. Delete old result records and old scratch keys.
  let deleted = 0;
  for (const prefix of SCRATCH_PREFIXES) {
    for (const entry of await listAll(ctx, prefix, 5000)) {
      if (now - Number(entry.updatedAt ?? 0) > KEEP_SCRATCH_MS) stale.push(String(entry.key));
    }
  }
  const gone = await pooled(
    stale.slice(0, 1500),
    8,
    (key) => ctx.swarm.kv_delete({ namespace: NS, key }) as Promise<Sdk>,
  );
  deleted = gone.filter((res) => res.status === 204).length;

  const failing = Object.entries(pieces).flatMap(([name, p]) =>
    Object.entries(p.failing).map(([check, f]) => ({ piece: name, check, ...f })),
  );
  const slowest = Object.entries(pieces)
    .map(([name, p]) => ({ piece: name, avgMs: p.avgMs, maxMs: p.maxMs }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 6);
  const board = {
    at: new Date(now).toISOString(),
    installedAt,
    level,
    dialect,
    ok: failing.every((f) => f.count10m === 0) && problems.length === 0,
    problems,
    scriptRuns: {
      last10m: byStatus(scripts10m),
      sinceInstall: byStatus(scriptsTotal),
      failedByScript: failedScripts.map((row) => ({
        name: row.name,
        n: Number(row.n),
        planned: row.name === "stress-sandbox-case",
        error: String(row.error ?? "").slice(0, 200),
      })),
    },
    workflowRuns: {
      last10m: byStatus(wf10m),
      sinceInstall: byStatus(wfTotal),
      byWorkflow: wfByName.map((row) => `${row.name} ${row.status}=${row.n}`),
      startedLast10m: Object.fromEntries(slowSteps.map((row) => [String(row.name), Number(row.n)])),
    },
    pieces: Object.fromEntries(
      Object.entries(pieces).map(([name, p]) => [
        name,
        {
          pass10m: p.pass10m,
          fail10m: p.fail10m,
          passTotal: p.passTotal,
          failTotal: p.failTotal,
          avgMs: p.avgMs,
          maxMs: p.maxMs,
          lastAt: p.lastAt,
        },
      ]),
    ),
    failing,
    slowest,
    engine,
    stuckRuns: stuck,
    failedSteps,
    sickSchedules,
    kv: { resultRecords: records.length, deletedThisRun: deleted },
  };
  await ctx.swarm.kv_set({ namespace: NS, key: "stress/scoreboard", value: board });
  return {
    ok: board.ok,
    failing: failing.length,
    problems,
    records: records.length,
    deleted,
  };
}
