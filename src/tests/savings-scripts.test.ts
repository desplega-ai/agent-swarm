import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  getDbClient,
  initDb,
} from "../be/db";
import { computeScriptWindow, type SavingsSql } from "../be/savings/compute";
import { curve, DEFAULT_OPS, F_FOLLOWUP, INLINE_SCRIPT_NAME, K, R, T0 } from "../be/savings/model";
import { readScriptSavings } from "../be/savings/read";
import {
  daysToCompute,
  resetSavingsRollupForTests,
  runSavingsRollupTick,
} from "../be/savings/rollup";
import { handleSavings } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-scripts.sqlite";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const WEEK = ["25", "26", "27", "28", "29", "30", "31"].map((d) => `2026-10-${d}`);

const inProcessSql: SavingsSql = (sql, params) => getDbClient().query(sql, params);

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function catalogScript(name: string, source: string): Promise<void> {
  await getDbClient().run(
    `INSERT INTO scripts (id, name, scope, source, description, intent, signatureJson, contentHash)
     VALUES (?, ?, 'global', ?, 'savings fixture', 'fixture', '{}', ?)`,
    [crypto.randomUUID(), name, source, crypto.randomUUID()],
  );
}

/** `count` runs of one script on `day`, one a minute from 00:00, each 30 s long. */
async function bulkScriptRuns(
  agentId: string,
  name: string | null,
  day: string,
  count: number,
  apiEndpointId: string | null = null,
) {
  await getDbClient().run(
    `INSERT INTO script_runs (id, agentId, scriptName, source, status, startedAt, finishedAt, apiEndpointId)
     WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ? - 1)
     SELECT ? || '-' || ? || '-' || i, ?, ?, 'x', 'completed',
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes'),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes', '+30 seconds'), ? FROM seq`,
    [
      count,
      name ?? "inline",
      day,
      agentId,
      name,
      `${day}T00:00:00.000Z`,
      `${day}T00:00:00.000Z`,
      apiEndpointId,
    ],
  );
}

const unit = (ops: number) => curve(T0 + K * ops, "smart", "usd");

describe("savings scripts", () => {
  let agentId: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    await resetSavingsRollupForTests();
    agentId = (await createAgent({ name: "savings-scripts-agent", isLead: false, status: "idle" }))
      .id;
    await catalogScript("poll-sched", "await a(); await b(); await c(); await d();");
    await catalogScript("helper", "await a(); await b();".repeat(4));
    await catalogScript("dispatcher-api", "await ctx.swarm.task_send({}); await x();");
    await createScheduledTask({
      name: "poll-sched-hourly",
      intervalMs: 3_600_000,
      targetType: "script",
      scriptName: "poll-sched",
    });
    for (const day of WEEK) {
      // 30 runs a day of a scheduled script: 210 in the week against a cap of 168.
      await bulkScriptRuns(agentId, "poll-sched", day, 30);
      // 5 runs a day of a script agents call.
      await bulkScriptRuns(agentId, "helper", day, 5);
      // 3 API runs a day of a script that can dispatch.
      await bulkScriptRuns(agentId, "dispatcher-api", day, 3, "endpoint-1");
    }
    // One API run created an agent task a minute after it started.
    const task = await createTaskExtended("savings scripts fixture", { agentId });
    const runId = `dispatcher-api-${WEEK[2]}-0`;
    await getDbClient().run("UPDATE agent_tasks SET createdAt=? WHERE id=?", [
      `${WEEK[2]}T00:01:00.000Z`,
      task.id,
    ]);
    await getDbClient().run("UPDATE script_runs SET output=? WHERE id=?", [
      JSON.stringify({ taskId: task.id }),
      runId,
    ]);
    // An API run at 23:59 whose task lands after midnight, with no run the next day.
    await catalogScript("midnight-api", "await ctx.swarm.task_send({});");
    await getDbClient().run(
      `INSERT INTO script_runs (id, agentId, scriptName, source, status, startedAt, finishedAt, apiEndpointId)
       VALUES ('midnight-run', ?, 'midnight-api', 'x', 'completed', ?, ?, 'endpoint-2')`,
      [agentId, `${WEEK[3]}T23:59:00.000Z`, `${WEEK[3]}T23:59:30.000Z`],
    );
    const late = await createTaskExtended("savings scripts midnight fixture", { agentId });
    await getDbClient().run("UPDATE agent_tasks SET createdAt=? WHERE id=?", [
      `${WEEK[4]}T00:01:00.000Z`,
      late.id,
    ]);
    await getDbClient().run("UPDATE script_runs SET output=? WHERE id='midnight-run'", [
      JSON.stringify({ taskId: late.id }),
    ]);
    // Runs with no script name and a name missing from the catalog.
    await bulkScriptRuns(agentId, null, WEEK[1] as string, 2);
    await bulkScriptRuns(agentId, "ghost", WEEK[1] as string, 1);

    server = createHttpServer(async (req, res) => {
      const handled = await handleSavings(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
      );
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    server?.close();
    await resetSavingsRollupForTests();
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("compute keys runs by name, counts awaits as ops and finds API effect runs", async () => {
    const out = await computeScriptWindow(
      { start: `${WEEK[0]}T00:00:00.000Z`, end: "2026-11-01T00:00:00.000Z" },
      inProcessSql,
    );
    const sum = (name: string) => {
      const s = out.find((x) => x.scriptName === name);
      const f = { runs: 0, apiRuns: 0, effectRuns: 0, apiEffectRuns: 0, opsSum: 0, computeSecs: 0 };
      for (const d of s?.byDay ?? []) {
        for (const k of Object.keys(f) as (keyof typeof f)[]) f[k] += d[k];
      }
      return f;
    };
    expect(out.map((s) => s.scriptName)).toEqual([
      INLINE_SCRIPT_NAME,
      "dispatcher-api",
      "ghost",
      "helper",
      "midnight-api",
      "poll-sched",
    ]);
    expect(sum("poll-sched")).toMatchObject({ runs: 210, apiRuns: 0, opsSum: 4 * 210 });
    expect(sum("poll-sched").computeSecs).toBeCloseTo(210 * 30, 3);
    expect(sum("helper").opsSum).toBe(8 * 35);
    expect(sum("dispatcher-api")).toMatchObject({ runs: 21, apiRuns: 21, apiEffectRuns: 1 });
    expect(sum("ghost").opsSum).toBe(DEFAULT_OPS);
    // Negative control: a name with no runs.
    expect(
      await computeScriptWindow(
        { start: `${WEEK[0]}T00:00:00.000Z`, end: "2026-11-01T00:00:00.000Z" },
        inProcessSql,
        { scriptName: "nope" },
      ),
    ).toEqual([]);
  });

  test("before the first tick the script window is not computed", async () => {
    const read = await readScriptSavings({ days: 7, tier: "smart", now: NOW });
    expect(read).toMatchObject({ complete: false, rows: [], total: null });
  });

  test("the tick fills script buckets for every day", async () => {
    const stats = await runSavingsRollupTick(inProcessSql, { now: NOW });
    expect(stats.lastError).toBeNull();
    expect(stats.daysPending).toBe(0);
    expect(await daysToCompute("script", NOW)).toEqual(["2026-10-31", "2026-10-30"]);
    const api = await getDbClient().get<{ n: number }>(
      "SELECT count(*) n FROM automation_savings_daily WHERE jobKind='script' AND subKind='api'",
    );
    // dispatcher-api on each of the 7 days, midnight-api on its run's day.
    expect(api?.n).toBe(8);
  });

  test("an API run at 23:59 credits its after-midnight task to the run's day", async () => {
    const buckets = await getDbClient().query<{ day: string; subKind: string; effectRuns: number }>(
      "SELECT day, subKind, effectRuns FROM automation_savings_daily WHERE jobKind='script' AND jobName='midnight-api' ORDER BY day, subKind",
    );
    // No bucket on the task's day: the effect stays on the run's day.
    expect(buckets).toEqual([
      { day: WEEK[3] as string, subKind: "", effectRuns: 0 },
      { day: WEEK[3] as string, subKind: "api", effectRuns: 1 },
    ]);
    const read = await readScriptSavings({ days: 7, tier: "smart", now: NOW });
    const row = read.rows.find((r) => r.scriptName === "midnight-api");
    expect(row).toMatchObject({ runs: 1, substitutedRuns: 1, effectRuns: 1 });
    expect(row?.savingUsd.p50).toBeCloseTo(R.p50 * unit(1) + F_FOLLOWUP, 6);
    expect(row?.hoursSaved.p50).toBeGreaterThan(0);
  });

  test("scheduled scripts are capped standalone tasks; agent-invoked ones are marginal turns", async () => {
    const read = await readScriptSavings({ days: 7, tier: "smart", now: NOW });
    expect(read.complete).toBe(true);
    const row = (name: string) => read.rows.find((r) => r.scriptName === name);
    expect(row("poll-sched")).toMatchObject({
      kind: "script-scheduled",
      runs: 210,
      substitutedRuns: 168,
      capApplied: true,
      actualUsd: 0,
    });
    expect(row("poll-sched")?.savingUsd.p50).toBeCloseTo(168 * (R.p50 * unit(4) + F_FOLLOWUP), 6);
    expect(row("helper")).toMatchObject({ kind: "script-agent-invoked", substitutedRuns: 35 });
    expect(row("helper")?.savingUsd.p50).toBeCloseTo(
      35 * R.p50 * (unit(8) - curve(T0, "smart", "usd")),
      6,
    );
    // API runs count only with an effect, as one standalone decision each.
    expect(row("dispatcher-api")).toMatchObject({
      runs: 21,
      substitutedRuns: 1,
      enabledOnlyRuns: 20,
      effectRuns: 1,
    });
    expect(row("dispatcher-api")?.savingUsd.p50).toBeCloseTo(R.p50 * unit(2) + F_FOLLOWUP, 6);
    expect(row(INLINE_SCRIPT_NAME)?.runs).toBe(2);
    const p50 = read.rows.reduce((s, r) => s + r.savingUsd.p50, 0);
    expect(read.total?.savingUsd.p50).toBeCloseTo(p50, 6);
  });

  test("daily points of one script add up to its window saving", async () => {
    const read = await readScriptSavings({
      days: 30,
      tier: "smart",
      now: NOW,
      scriptName: "poll-sched",
    });
    expect(read.rows).toHaveLength(1);
    expect(read.points).toHaveLength(30);
    const saving = read.points.reduce((s, p) => s + p.savingUsd, 0);
    expect(saving).toBeCloseTo(read.rows[0]?.savingUsd.p50 ?? Number.NaN, 6);
    expect(read.points.filter((p) => p.savingUsd > 0).map((p) => p.day)).toEqual(WEEK);
  });

  describe("routes", () => {
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json().catch(() => null)) as never };
    };

    test("scriptName, kind=script and the daily series read the script rollup", async () => {
      // The ticks above used a fixed clock; cover the real current window.
      await runSavingsRollupTick(inProcessSql);
      await bulkScriptRuns(agentId, "helper", new Date().toISOString().slice(0, 10), 2);
      await runSavingsRollupTick(inProcessSql);
      const one = (await get("/api/savings/jobs?scriptName=helper&days=7")).body as {
        valid: boolean;
        window: { start: string };
        rows: { kind: string; scriptName: string; workflowId?: string; runs: number }[];
      };
      expect(one.valid).toBe(true);
      // The real window can also cover fixture days, so count its runs.
      const inWindow = await getDbClient().get<{ n: number }>(
        "SELECT count(*) n FROM script_runs WHERE scriptName='helper' AND startedAt>=?",
        [one.window.start],
      );
      expect(one.rows).toEqual([
        expect.objectContaining({
          kind: "script-agent-invoked",
          scriptName: "helper",
          runs: inWindow?.n,
        }),
      ]);
      expect(one.rows[0]?.workflowId).toBeUndefined();
      const list = (await get("/api/savings/jobs?kind=script&days=7")).body as {
        rows: { scriptName: string }[];
      };
      expect(list.rows.map((r) => r.scriptName)).toContain("helper");
      const daily = (await get("/api/savings/daily?scriptName=helper&days=7")).body as {
        valid: boolean;
        points: { savingUsd: number }[];
      };
      expect(daily.valid).toBe(true);
      expect(daily.points).toHaveLength(7);
      // A catalog script with no runs in the window.
      await catalogScript("idle-script", "await a();");
      expect((await get("/api/savings/jobs?scriptName=idle-script&days=7")).body).toMatchObject({
        valid: false,
        reason: "no-runs",
        rows: [],
      });
    });

    test("bad input is rejected", async () => {
      expect((await get("/api/savings/jobs?scriptName=nope")).status).toBe(404);
      expect((await get("/api/savings/daily?scriptName=nope")).status).toBe(404);
      expect((await get("/api/savings/jobs?scriptName=helper&kind=script")).status).toBe(400);
      expect((await get("/api/savings/daily?scriptName=helper&workflowId=x")).status).toBe(400);
      expect((await get("/api/savings/jobs?kind=task")).status).toBe(400);
    });
  });
});
