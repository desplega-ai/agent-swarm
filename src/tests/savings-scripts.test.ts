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
  upsertSwarmConfig,
} from "../be/db";
import { computeScriptWindow, LIVE_MAX_RUNS, type SavingsSql } from "../be/savings/compute";
import {
  CURVE,
  type CurveSet,
  curve,
  DEFAULT_OPS,
  F_FOLLOWUP,
  INLINE_SCRIPT_NAME,
  K,
  R,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
  T0,
} from "../be/savings/model";
import { readScriptSavings, resetSavingsReadCache } from "../be/savings/read";
import {
  daysToCompute,
  RECOMPUTE_AFTER_MS,
  resetSavingsRollupForTests,
  runSavingsRollupTick,
} from "../be/savings/rollup";
import { clearCalibrationCache, handleSavings } from "../http/savings";
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
    // Today and yesterday are not final: they are due again once the computation ages.
    expect(await daysToCompute("script", NOW)).toEqual([]);
    expect(await daysToCompute("script", NOW + RECOMPUTE_AFTER_MS)).toEqual([
      "2026-10-31",
      "2026-10-30",
    ]);
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
    // Thirty rolling days touch thirty-one UTC days.
    expect(read.points).toHaveLength(31);
    const saving = read.points.reduce((s, p) => s + p.savingUsd, 0);
    expect(saving).toBeCloseTo(read.rows[0]?.savingUsd.p50 ?? Number.NaN, 6);
    expect(read.points.filter((p) => p.savingUsd > 0).map((p) => p.day)).toEqual(WEEK);
  });

  test("the window's partial first day counts only the runs inside the window", async () => {
    // Three rolling days from noon: the first day is a fixture day whose runs
    // all start before noon, so none of them are inside the window.
    const count = async (from: string, to = "9999") =>
      Number(
        (
          await getDbClient().get<{ n: number }>(
            "SELECT count(*) n FROM script_runs WHERE scriptName='poll-sched' AND startedAt>=? AND startedAt<?",
            [from, to],
          )
        )?.n,
      );
    const opts = { days: 3, tier: "smart" as const, now: NOW, scriptName: "poll-sched" };
    const live = await readScriptSavings({ ...opts, sql: inProcessSql });
    expect(live.window.start).toBe("2026-10-28T12:00:00.000Z");
    expect(live.boundaryEstimated).toBe(false);
    expect(live.rows[0]?.runs).toBe(await count(live.window.start));
    expect(live.points).toHaveLength(4);
    expect(live.points[0]).toMatchObject({ day: WEEK[3], savingUsd: 0 });

    // A failed scan scales the first day by the share of it inside the window.
    const failing: SavingsSql = async () => {
      throw new Error("database is busy");
    };
    resetSavingsReadCache();
    const scaled = await readScriptSavings({ ...opts, sql: failing });
    expect(scaled.boundaryEstimated).toBe(true);
    const firstDay = await count(`${WEEK[3]}T00:00:00.000Z`, `${WEEK[4]}T00:00:00.000Z`);
    expect(firstDay).toBeGreaterThan(0);
    const scaledRuns = (await count(`${WEEK[4]}T00:00:00.000Z`)) + Math.round(firstDay / 2);
    expect(scaled.rows[0]?.runs).toBe(scaledRuns);
    // The failed scan is not kept: the next read in the same minute scans again.
    const again = await readScriptSavings({ ...opts, sql: inProcessSql });
    expect(again.boundaryEstimated).toBe(false);
    expect(again.rows).toEqual(live.rows);

    // Above LIVE_MAX_RUNS runs in the slice the scan is skipped and the day is scaled.
    const scans: string[] = [];
    const busy =
      (runs: number): SavingsSql =>
      async (sql, params) => {
        if (sql.startsWith("SELECT count(*) n FROM script_runs")) return [{ n: runs }] as never;
        scans.push(sql);
        return inProcessSql(sql, params);
      };
    resetSavingsReadCache();
    const capped = await readScriptSavings({ ...opts, sql: busy(LIVE_MAX_RUNS + 1) });
    expect(capped.boundaryEstimated).toBe(true);
    expect(capped.rows[0]?.runs).toBe(scaledRuns);
    expect(scans).toEqual([]);
    // Control: at the cap the slice is scanned exactly.
    resetSavingsReadCache();
    const atCap = await readScriptSavings({ ...opts, sql: busy(LIVE_MAX_RUNS) });
    expect(atCap.boundaryEstimated).toBe(false);
    expect(atCap.rows).toEqual(live.rows);
    expect(scans.length).toBeGreaterThan(0);
    resetSavingsReadCache();
  });

  test("fleet reads across the minutes of an hour scan the first day once", async () => {
    resetSavingsReadCache();
    const MINUTE = 60_000;
    let scans = 0;
    const counting: SavingsSql = (sql, params) => {
      // Every first-day scan opens with this count.
      if (sql.startsWith("SELECT count(*) n FROM script_runs")) scans += 1;
      return inProcessSql(sql, params);
    };
    const list = (now: number) => readScriptSavings({ days: 3, tier: "smart", now, sql: counting });
    const first = await list(NOW + MINUTE);
    expect(first.boundaryEstimated).toBe(false);
    expect(first.rows.length).toBeGreaterThan(1);
    expect(scans).toBe(1);
    for (const m of [2, 17, 59]) {
      // Within the hour every fleet read prices the same slice, from 12:00.
      expect((await list(NOW + m * MINUTE)).rows).toEqual(first.rows);
    }
    expect(scans).toBe(1);
    // Concurrent reads share one scan.
    resetSavingsReadCache();
    await Promise.all([list(NOW + MINUTE), list(NOW + 2 * MINUTE)]);
    expect(scans).toBe(2);
    // The next hour's window scans again.
    await list(NOW + 61 * MINUTE);
    expect(scans).toBe(3);
    resetSavingsReadCache();
  });

  test("fleet reads keep only the runs from a mid-hour or midnight window start", async () => {
    const MINUTE = 60_000;
    const day = WEEK[3] as string;
    const times = ["00:15", "00:45", "12:15", "12:45"];
    for (const t of times) {
      await getDbClient().run(
        `INSERT INTO script_runs (id, agentId, scriptName, source, status, startedAt, finishedAt)
         VALUES (?, ?, 'edge-window', 'x', 'completed', ?, ?)`,
        [`edge-window-${t}`, agentId, `${day}T${t}:00.000Z`, `${day}T${t}:30.000Z`],
      );
    }
    const rollUp = async () => {
      await getDbClient().run("DELETE FROM automation_savings_days WHERE day=?", [day]);
      await runSavingsRollupTick(inProcessSql, { now: NOW });
      resetSavingsReadCache();
    };
    await rollUp();
    const read = (now: number, sql: SavingsSql = inProcessSql, scriptName?: string) =>
      readScriptSavings({ days: 3, tier: "smart", now, sql, scriptName });
    const runsOf = (r: { rows: { scriptName: string; runs: number }[] }, name: string) =>
      r.rows.find((row) => row.scriptName === name)?.runs ?? 0;

    // Mid-hour: a 12:10 start keeps both 12:xx runs.
    expect(runsOf(await read(NOW + 10 * MINUTE), "edge-window")).toBe(2);
    // The same hour's cached slice starts at 12:00; a 12:30 start drops the 12:15 run.
    const mid = await read(NOW + 30 * MINUTE);
    expect(mid.window.start).toBe(`${day}T12:30:00.000Z`);
    expect(mid.boundaryEstimated).toBe(false);
    expect(runsOf(mid, "edge-window")).toBe(1);

    // Midnight: a 00:30 start (slice floored to the day start) drops the 00:15 run.
    resetSavingsReadCache();
    const midnight = Date.parse("2026-10-31T00:30:00.000Z");
    const night = await read(midnight);
    expect(runsOf(night, "edge-window")).toBe(3);
    // poll-sched's first-day runs all fall from 00:00 to 00:29: the fleet row matches the exact single-script read.
    const single = await read(midnight, inProcessSql, "poll-sched");
    expect(runsOf(night, "poll-sched")).toBe(single.rows[0]?.runs ?? -1);
    // Control: a window starting at midnight keeps the whole first day.
    expect(runsOf(await read(Date.parse("2026-10-31T00:00:00.000Z")), "edge-window")).toBe(4);

    // A failed scan scales the first day by the share of it from the window start, not the hour.
    const failing: SavingsSql = async () => {
      throw new Error("database is busy");
    };
    resetSavingsReadCache();
    const scaledFleet = await read(NOW + 30 * MINUTE, failing);
    resetSavingsReadCache();
    const scaledSingle = await read(NOW + 30 * MINUTE, failing, "poll-sched");
    expect(scaledFleet.boundaryEstimated).toBe(true);
    // 30 x 11.5/24 rounds to 14; from 12:00 it would be 15.
    expect(runsOf(scaledFleet, "poll-sched")).toBe(scaledSingle.rows[0]?.runs ?? -1);

    await getDbClient().run("DELETE FROM script_runs WHERE scriptName='edge-window'");
    await rollUp();
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
        boundaryEstimated: boolean;
        window: { start: string };
        rows: { kind: string; scriptName: string; workflowId?: string; runs: number }[];
      };
      expect(one.valid).toBe(true);
      // The real window can also cover fixture days, so count its runs.
      const count = async (from: string, to = "9999") =>
        Number(
          (
            await getDbClient().get<{ n: number }>(
              "SELECT count(*) n FROM script_runs WHERE scriptName='helper' AND startedAt>=? AND startedAt<?",
              [from, to],
            )
          )?.n,
        );
      expect(one.rows).toEqual([
        expect.objectContaining({ kind: "script-agent-invoked", scriptName: "helper" }),
      ]);
      const runs = one.rows[0]?.runs ?? -1;
      if (one.boundaryEstimated) {
        // The live scan of the partial first day failed: that day was scaled.
        const firstDay = one.window.start.slice(0, 10);
        const secondDay = new Date(Date.parse(`${firstDay}T00:00:00.000Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10);
        const after = await count(`${secondDay}T00:00:00.000Z`);
        expect(runs).toBeGreaterThanOrEqual(after);
        expect(runs).toBeLessThanOrEqual(
          after + (await count(`${firstDay}T00:00:00.000Z`, `${secondDay}T00:00:00.000Z`)),
        );
      } else {
        expect(runs).toBe(await count(one.window.start));
      }
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
      expect(daily.points).toHaveLength(8);
      // A catalog script with no runs in the window.
      await catalogScript("idle-script", "await a();");
      expect((await get("/api/savings/jobs?scriptName=idle-script&days=7")).body).toMatchObject({
        valid: false,
        reason: "no-runs",
        rows: [],
      });
    });

    test("a stored deployment curve prices scheduled and agent-invoked scripts", async () => {
      await catalogScript("calib-sched", "await a(); await b(); await c();");
      await catalogScript("calib-helper", "await a(); await b(); await c(); await d(); await e();");
      await createScheduledTask({
        name: "calib-sched-hourly",
        intervalMs: 3_600_000,
        targetType: "script",
        scriptName: "calib-sched",
      });
      // Fresh runs, so the on-read refresh of today picks them up.
      const recent = async (name: string, count: number) => {
        for (let i = 0; i < count; i++) {
          const at = new Date(Date.now() - (i + 1) * 1000).toISOString();
          await getDbClient().run(
            `INSERT INTO script_runs (id, agentId, scriptName, source, status, startedAt, finishedAt)
             VALUES (?, ?, ?, 'x', 'completed', ?, ?)`,
            [`${name}-${i}`, agentId, name, at, at],
          );
        }
      };
      await recent("calib-sched", 4);
      await recent("calib-helper", 3);
      // Script buckets refresh only on the tick, and the test above computed
      // today moments ago: drop today's marker so the tick rescans it.
      await getDbClient().run(
        "DELETE FROM automation_savings_days WHERE jobKind='script' AND day=?",
        [new Date().toISOString().slice(0, 10)],
      );
      await runSavingsRollupTick(inProcessSql);
      type Read = {
        calibrationSource: string;
        rows: {
          kind: string;
          substitutedRuns: number;
          savingUsd: { p50: number };
          agentOnlyUsdPerRun: number;
        }[];
      };
      const read = async (name: string) =>
        (await get(`/api/savings/jobs?scriptName=${name}&days=7&tier=smart`)).body as Read;
      // Distinct from the shipped curve at every point, including the T0 baseline
      // that agent-invoked runs subtract.
      const deployed = Object.fromEntries(
        SAVINGS_TIERS.map((t) => [
          t,
          { usd: CURVE[t].usd.map((v, i) => v * 3 + i * 0.01), hrs: CURVE[t].hrs },
        ]),
      ) as CurveSet;
      const sched = (set?: CurveSet) => R.p50 * curve(T0 + K * 3, "smart", "usd", set) + F_FOLLOWUP;
      const helper = (set?: CurveSet) =>
        R.p50 * (curve(T0 + K * 5, "smart", "usd", set) - curve(T0, "smart", "usd", set));
      const check = async (source: string, set?: CurveSet) => {
        const s = await read("calib-sched");
        const h = await read("calib-helper");
        expect(s.calibrationSource).toBe(source);
        expect(h.calibrationSource).toBe(source);
        expect(s.rows[0]).toMatchObject({ kind: "script-scheduled", substitutedRuns: 4 });
        expect(h.rows[0]).toMatchObject({ kind: "script-agent-invoked", substitutedRuns: 3 });
        expect(s.rows[0]?.agentOnlyUsdPerRun).toBeCloseTo(sched(set), 2);
        expect(s.rows[0]?.savingUsd.p50).toBeCloseTo(4 * sched(set), 1);
        expect(h.rows[0]?.agentOnlyUsdPerRun).toBeCloseTo(helper(set), 2);
        expect(h.rows[0]?.savingUsd.p50).toBeCloseTo(3 * helper(set), 1);
      };
      try {
        clearCalibrationCache();
        await check("shipped");
        await upsertSwarmConfig({
          scope: "global",
          key: SAVINGS_CALIBRATION_KEY,
          value: JSON.stringify({
            calibratedAt: "2026-12-01",
            model: "claude-opus-5-5",
            curve: deployed,
          }),
        });
        clearCalibrationCache();
        await check("deployment", deployed);
        // The script list and the daily series read the same curve.
        const list = (await get("/api/savings/jobs?kind=script&days=7&tier=smart")).body as Read & {
          rows: { scriptName: string }[];
        };
        expect(list.calibrationSource).toBe("deployment");
        expect(list.rows.find((r) => r.scriptName === "calib-helper")?.savingUsd.p50).toBeCloseTo(
          3 * helper(deployed),
          1,
        );
        const daily = (await get("/api/savings/daily?scriptName=calib-sched&days=7&tier=smart"))
          .body as { calibrationSource: string; points: { savingUsd: number }[] };
        expect(daily.calibrationSource).toBe("deployment");
        const cents = daily.points.reduce((sum, p) => sum + Math.round(p.savingUsd * 100), 0);
        expect(cents / 100).toBeCloseTo(4 * sched(deployed), 1);
        // The deployment curve is not the shipped one for either kind.
        expect(sched(deployed)).toBeGreaterThan(sched() * 2);
        expect(helper(deployed)).toBeGreaterThan(helper() * 2);
      } finally {
        await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [
          SAVINGS_CALIBRATION_KEY,
        ]);
        clearCalibrationCache();
      }
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
