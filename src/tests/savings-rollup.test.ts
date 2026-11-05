import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  getWorkflow,
  initDb,
} from "../be/db";
import { computeWorkflowWindow, type SavingsSql } from "../be/savings/compute";
import { MODEL_VERSION, priceWorkflow } from "../be/savings/model";
import { readWorkflowSavings, resetSavingsReadCache } from "../be/savings/read";
import {
  getSavingsRollupStats,
  ROLLUP_DAYS,
  refreshWorkflowToday,
  resetSavingsRollupForTests,
  runSavingsRollupTick,
  stopSavingsRollup,
  utcDay,
  workflowDaysToCompute,
} from "../be/savings/rollup";
import { handleSavings, resetSavingsRefreshCache } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-rollup.sqlite";
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 3_600_000;
const WEEK = ["25", "26", "27", "28", "29", "30", "31"].map((d) => `2026-10-${d}`);
const DEFINITION = { nodes: [{ id: "hello", type: "notify", config: {} }] };

// The route's refresh path reads the DB file from a child process (the
// bounded executor), so this file opts out of the in-memory template.
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedRollupTemplate?: Uint8Array;
};

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

/** `count` runs of one workflow on `day`, one a minute from 00:00. */
async function bulkRuns(workflowId: string, trigger: string, day: string, count: number) {
  await getDbClient().run(
    `INSERT INTO workflow_runs (id, workflowId, triggerType, status, startedAt)
     WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ? - 1)
     SELECT ? || '-' || ? || '-' || i, ?, ?, 'completed',
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes') FROM seq`,
    [count, workflowId, day, workflowId, trigger, `${day}T00:00:00.000Z`],
  );
  // One notify step (1 op) per run.
  await getDbClient().run(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt)
     SELECT id || '-s', id, 'hello', 'notify', 'completed', startedAt, startedAt
     FROM workflow_runs WHERE workflowId=? AND startedAt>=? AND startedAt<?`,
    [workflowId, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`],
  );
}

/** One run with one notify step, started at `startedAt`. */
async function runAt(workflowId: string, startedAt: string): Promise<string> {
  const id = `${workflowId}-${startedAt}`;
  await getDbClient().run(
    "INSERT INTO workflow_runs (id, workflowId, triggerType, status, startedAt) VALUES (?, ?, 'manual', 'completed', ?)",
    [id, workflowId, startedAt],
  );
  await getDbClient().run(
    "INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt) VALUES (?, ?, 'hello', 'notify', 'completed', ?, ?)",
    [`${id}-s`, id, startedAt, startedAt],
  );
  return id;
}

describe("savings rollup", () => {
  let agentId: string;
  let capLive: string;
  let capRetired: string;
  let router: string;
  let oncall: string;
  let server: Server;
  let port: number;

  async function effectTask(runId: string, usd: number) {
    const task = await createTaskExtended(`rollup fixture ${runId}`, {
      agentId,
      source: "workflow",
      workflowRunId: runId,
    });
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: task.id,
      agentId,
      totalCostUsd: usd,
      durationMs: 60_000,
      numTurns: 3,
      model: "claude-opus-5-5",
    });
  }

  beforeAll(async () => {
    testGlobals.__savedRollupTemplate = testGlobals.__testMigrationTemplate;
    testGlobals.__testMigrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    await resetSavingsRollupForTests();
    agentId = (await createAgent({ name: "rollup-agent", isLead: false, status: "idle" })).id;
    capLive = (await createWorkflow({ name: "cap-poll", definition: DEFINITION })).id;
    capRetired = (
      await createWorkflow({ name: "cap-poll-retired-2026-10-01", definition: DEFINITION })
    ).id;
    router = (await createWorkflow({ name: "event-router", definition: DEFINITION })).id;
    oncall = (await createWorkflow({ name: "event-oncall", definition: DEFINITION })).id;
    await createWorkflow({ name: "rollup-idle", definition: DEFINITION });

    for (const day of WEEK) {
      // 30 schedule runs a day on both versions: 420 in the week against a cap of 168.
      await bulkRuns(capLive, "schedule", day, 30);
      await bulkRuns(capRetired, "schedule", day, 30);
      // Two of the live version's runs a day created an agent task ($0.50 each).
      await effectTask(`${capLive}-${day}-0`, 0.5);
      await effectTask(`${capLive}-${day}-1`, 0.5);
      // 300 event runs a day; 2,100 in the week is above 240 a day.
      await bulkRuns(router, "event", day, 300);
      // 50 event runs a day: busy, but below the router threshold.
      await bulkRuns(oncall, "event", day, 50);
    }
    // One router run had an effect.
    await effectTask(`${router}-${WEEK[3]}-7`, 0);

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
    testGlobals.__testMigrationTemplate = testGlobals.__savedRollupTemplate;
    testGlobals.__savedRollupTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("before the first tick no window is complete", async () => {
    const read = await readWorkflowSavings({ days: 7, tier: "smart", now: NOW });
    expect(read).toMatchObject({ complete: false, computedAt: null, rows: [], total: null });
  });

  test("the first tick backfills every day; an hour later only days that are not final are due", async () => {
    const stats = await runSavingsRollupTick(inProcessSql, { now: NOW });
    expect(stats.lastError).toBeNull();
    expect(stats.daysPending).toBe(0);
    const marked = await getDbClient().get<{ n: number }>(
      "SELECT count(*) n FROM automation_savings_days WHERE jobKind='workflow' AND modelVersion=?",
      [MODEL_VERSION],
    );
    expect(marked?.n).toBe(ROLLUP_DAYS);
    // Just computed: nothing is due until the next hourly tick.
    expect(await workflowDaysToCompute(NOW)).toEqual([]);
    // Today and yesterday were computed less than a day after they ended.
    expect(await workflowDaysToCompute(NOW + HOUR)).toEqual(["2026-10-31", "2026-10-30"]);
    const buckets = await getDbClient().get<{ n: number }>(
      "SELECT count(*) n FROM automation_savings_daily",
    );
    // Four workflows ran on each of the 7 days; the idle one has no bucket.
    expect(buckets?.n).toBe(4 * 7);
  });

  test("a day computed under an older model version is recomputed", async () => {
    await getDbClient().run(
      "UPDATE automation_savings_days SET modelVersion=? WHERE day='2026-10-20'",
      [MODEL_VERSION - 1],
    );
    expect(await workflowDaysToCompute(NOW)).toContain("2026-10-20");
    await runSavingsRollupTick(inProcessSql, { now: NOW });
    expect(await workflowDaysToCompute(NOW)).not.toContain("2026-10-20");
  });

  test("concurrent callers share one tick; stop aborts it", async () => {
    await getDbClient().run("DELETE FROM automation_savings_days WHERE day<'2026-10-01'");
    const slowSql: SavingsSql = async (sql, params) => {
      await Bun.sleep(5);
      return inProcessSql(sql, params);
    };
    const a = runSavingsRollupTick(slowSql, { now: NOW });
    const b = runSavingsRollupTick(slowSql, { now: NOW });
    expect(a).toBe(b);
    await Bun.sleep(30);
    await stopSavingsRollup();
    const stats = await a;
    expect(stats.daysPending).toBeGreaterThan(0);
    expect(getSavingsRollupStats().lastError).toBeNull();
    // A full tick catches up.
    expect((await runSavingsRollupTick(inProcessSql, { now: NOW })).daysPending).toBe(0);
  });

  test("the cap is shared across buckets and versions: the window cap, not 24 per bucket", async () => {
    const read = await readWorkflowSavings({ days: 7, tier: "smart", now: NOW });
    expect(read.complete).toBe(true);
    const live = read.rows.find((r) => r.workflowId === capLive);
    const retired = read.rows.find((r) => r.workflowId === capRetired);
    // max(min(420 schedule runs, 24 x 7), 14 effect runs) = 168, all on the live version.
    expect(live?.substitutedRuns).toBe(168);
    expect(retired?.substitutedRuns).toBe(0);
    expect(live?.capApplied).toBe(true);
    // One version alone gets the same window cap.
    const one = await readWorkflowSavings({
      days: 7,
      tier: "smart",
      now: NOW,
      workflowId: capLive,
    });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]?.substitutedRuns).toBe(168);
  });

  test("the enabled-only rule flips only the router-shaped workflow", async () => {
    const read = await readWorkflowSavings({ days: 7, tier: "smart", now: NOW });
    expect(read.rows.filter((r) => r.enabledOnlyRule).map((r) => r.workflowId)).toEqual([router]);
    const r = read.rows.find((x) => x.workflowId === router);
    expect(r).toMatchObject({ runs: 2100, substitutedRuns: 1, enabledOnlyRuns: 2099 });
    const o = read.rows.find((x) => x.workflowId === oncall);
    expect(o).toMatchObject({ enabledOnlyRule: false, runs: 350, substitutedRuns: 350 });
    // The total uses the fleet band and sums the rows' p50.
    const p50 = read.rows.reduce((s, x) => s + x.savingUsd.p50, 0);
    expect(read.total?.savingUsd.p50).toBeCloseTo(p50, 6);
  });

  test("daily points add up to the window saving and actual cost", async () => {
    const read = await readWorkflowSavings({
      days: 30,
      tier: "smart",
      now: NOW,
      workflowId: capLive,
    });
    const row = read.rows[0];
    expect(row && row.actualUsd > 0).toBe(true);
    // The rolling window touches 31 UTC days; the first starts at noon.
    expect(read.points).toHaveLength(31);
    expect(read.points[0]?.day).toBe("2026-10-01");
    const saving = read.points.reduce((s, p) => s + p.savingUsd, 0);
    const actual = read.points.reduce((s, p) => s + p.actualUsd, 0);
    expect(saving).toBeCloseTo(row?.savingUsd.p50 ?? Number.NaN, 6);
    expect(actual).toBeCloseTo(row?.actualUsd ?? Number.NaN, 6);
    const measured = read.points.reduce((s, p) => s + p.measuredUsd, 0);
    expect(measured).toBeCloseTo(row?.measuredUsd ?? Number.NaN, 6);
    const estimated = read.points.reduce((s, p) => s + p.estimatedLlmUsd, 0);
    expect(estimated).toBeCloseTo(row?.estimatedLlmUsd ?? Number.NaN, 6);
    // 14 effect tasks at $0.50 each, unscaled.
    expect(row?.measuredUsd).toBeCloseTo(7, 6);
    expect(read.points.filter((p) => p.savingUsd > 0).map((p) => p.day)).toEqual(WEEK);
  });

  describe("rolling window", () => {
    let rolling: string;
    // 02:00 cuts the first day of the fixture week: 180 of the router's 300 runs that day are inside.
    const NOW2 = Date.parse("2026-11-01T02:00:00.000Z");

    /** The rollup read of one workflow equals the live computation over the same window. */
    async function reconcile(workflowId: string, days: number, now: number) {
      const read = await readWorkflowSavings({ days, tier: "smart", now, workflowId });
      const live = await computeWorkflowWindow(
        { id: workflowId, definition: (await getWorkflow(workflowId))?.definition },
        { start: read.window.start, end: read.window.end },
        inProcessSql,
      );
      if (live.status !== "ok") throw new Error("the live computation refused");
      const priced = priceWorkflow(live.facts, { tier: "smart", days, band: "job" });
      const row = read.rows[0];
      expect(read.complete).toBe(true);
      expect(read.boundaryEstimated).toBe(false);
      expect(read.rows).toHaveLength(1);
      expect(row?.runs).toBe(live.facts.runs);
      expect(row?.substitutedRuns).toBe(priced.substitutedRuns);
      expect(row?.enabledOnlyRule).toBe(priced.enabledOnlyRule);
      for (const k of ["measuredUsd", "estimatedLlmUsd", "actualUsd", "actualHours"] as const) {
        expect(row?.[k]).toBeCloseTo(priced[k], 9);
      }
      for (const q of ["p10", "p50", "p90"] as const) {
        expect(row?.savingUsd[q]).toBeCloseTo(priced.savingUsd[q], 9);
        expect(row?.hoursSaved[q]).toBeCloseTo(priced.hoursSaved[q], 9);
      }
      expect(read.total?.savingUsd.p50).toBeCloseTo(priced.savingUsd.p50, 9);
      return read;
    }

    beforeAll(async () => {
      rolling = (await createWorkflow({ name: "rolling-window", definition: DEFINITION })).id;
      // A 7-day window ending at noon starts at noon: 11:00 that day is outside, 13:00 inside.
      await runAt(rolling, "2026-10-24T11:00:00.000Z");
      const inside = await runAt(rolling, "2026-10-24T13:00:00.000Z");
      await runAt(rolling, "2026-10-28T10:00:00.000Z");
      await runAt(rolling, "2026-10-31T11:00:00.000Z");
      await effectTask(inside, 0.25);
      await getDbClient().run(
        "DELETE FROM automation_savings_days WHERE day IN ('2026-10-24', '2026-10-28', '2026-10-31')",
      );
      await runSavingsRollupTick(inProcessSql, { now: NOW });
    });

    test("a window starting at noon keeps the runs of its first half day", async () => {
      const read = await reconcile(rolling, 7, NOW);
      expect(read.window.start).toBe("2026-10-24T12:00:00.000Z");
      expect(read.rows[0]?.runs).toBe(3);
      expect(read.rows[0]?.measuredUsd).toBeCloseTo(0.25, 9);
      expect(read.points.map((p) => p.day)).toEqual(["2026-10-24", ...WEEK]);
    });

    test("a boundary inside a busy day matches the live computation", async () => {
      await runSavingsRollupTick(inProcessSql, { now: NOW2 });
      const router7 = await reconcile(router, 7, NOW2);
      expect(router7.rows[0]).toMatchObject({ runs: 180 + 300 * 6, enabledOnlyRule: true });
      // All 50 of the first day's runs fall before 02:00.
      expect((await reconcile(oncall, 7, NOW2)).rows[0]?.runs).toBe(50 * 6);
      expect((await reconcile(rolling, 30, NOW2)).rows[0]?.runs).toBe(4);
    });

    test("a first day that cannot be scanned is scaled to the window and flagged", async () => {
      resetSavingsReadCache();
      const busy: SavingsSql = async () => {
        throw new Error("database is busy");
      };
      const read = await readWorkflowSavings({
        days: 7,
        tier: "smart",
        now: NOW2,
        workflowId: router,
        sql: busy,
      });
      expect(read.boundaryEstimated).toBe(true);
      // 22 of the first day's 24 hours are inside the window: 275 of its 300 runs.
      expect(read.rows[0]?.runs).toBe(275 + 300 * 6);
      resetSavingsReadCache();
    });
  });

  test("catch-up ticks backfill older days when today and yesterday take the whole budget", async () => {
    await getDbClient().run(
      "DELETE FROM automation_savings_days WHERE day IN ('2026-10-20', '2026-10-21', '2026-10-22')",
    );
    await getDbClient().run(
      "UPDATE automation_savings_days SET computedAt=? WHERE day IN ('2026-10-30', '2026-10-31')",
      [new Date(NOW - 2 * HOUR).toISOString()],
    );
    const due = await workflowDaysToCompute(NOW);
    expect(due.slice(0, 5)).toEqual([
      "2026-10-31",
      "2026-10-30",
      "2026-10-22",
      "2026-10-21",
      "2026-10-20",
    ]);
    // Every scan takes a few ms against a 1 ms budget: one day per tick, a
    // minute apart like catch-up ticks.
    const slowSql: SavingsSql = async (sql, params) => {
      await Bun.sleep(2);
      return inProcessSql(sql, params);
    };
    for (let i = 0; i < due.length; i++) {
      const stats = await runSavingsRollupTick(slowSql, {
        now: NOW + i * 60_000,
        budgetMs: 1,
      });
      expect(stats.lastError).toBeNull();
    }
    expect(await workflowDaysToCompute(NOW + due.length * 60_000)).toEqual([]);
  });

  describe("routes", () => {
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json().catch(() => null)) as never };
    };

    test("a window the rollup has not computed is not valid, never $0", async () => {
      // The fixed-clock ticks above do not cover the real current week.
      const { status, body } = await get(`/api/savings/jobs?workflowId=${capLive}&days=7`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ valid: false, reason: "not-computed", rows: [], total: null });
    });

    test("a fresh run shows on the detail route without waiting for the hourly tick", async () => {
      await runSavingsRollupTick(inProcessSql);
      const wf = (await createWorkflow({ name: "rollup-fresh", definition: DEFINITION })).id;
      let { body } = await get(`/api/savings/jobs?workflowId=${wf}&days=7`);
      expect(body).toMatchObject({ valid: false, reason: "no-runs", rows: [] });

      await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf, triggerType: "manual" });
      ({ body } = await get(`/api/savings/jobs?workflowId=${wf}&days=7&tier=ultra`));
      const b = body as {
        valid: boolean;
        tier: string;
        rows: { runs: number; savingUsd: { p10: number; p50: number; p90: number } }[];
        total: { savingUsd: { p50: number } };
      };
      expect(b.valid).toBe(true);
      expect(b.tier).toBe("ultra");
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0]?.runs).toBe(1);
      const band = b.rows[0]?.savingUsd;
      expect(band && band.p10 < band.p50 && band.p50 < band.p90).toBe(true);
      expect(b.total.savingUsd.p50).toBe(band?.p50 as number);

      const daily = (await get(`/api/savings/daily?workflowId=${wf}&days=7&tier=ultra`)).body as {
        valid: boolean;
        points: { day: string; savingUsd: number }[];
      };
      expect(daily.valid).toBe(true);
      // Seven rolling days touch eight UTC days.
      expect(daily.points).toHaveLength(8);
      // Rounded to the cent so the points add up to the header amount exactly.
      expect(Math.round(daily.points.reduce((s, p) => s + p.savingUsd, 0) * 100)).toBe(
        Math.round((band?.p50 as number) * 100),
      );

      // The list reads the hourly buckets: the next hourly tick adds the workflow.
      await getDbClient().run("UPDATE automation_savings_days SET computedAt=? WHERE day=?", [
        new Date(Date.now() - HOUR).toISOString(),
        utcDay(Date.now()),
      ]);
      await runSavingsRollupTick(inProcessSql);
      const list = (await get("/api/savings/jobs?kind=workflow&days=7")).body as {
        valid: boolean;
        rows: { workflowId: string }[];
      };
      expect(list.valid).toBe(true);
      expect(list.rows.map((r) => r.workflowId)).toContain(wf);
    });

    test("reads share one refresh, and a scanned day is held for a minute", async () => {
      await runSavingsRollupTick(inProcessSql);
      const wf = (await createWorkflow({ name: "rollup-burst", definition: DEFINITION })).id;
      const runs = async () =>
        (
          (await get(`/api/savings/jobs?workflowId=${wf}&days=7`)).body as {
            rows: { runs: number }[];
          }
        ).rows[0]?.runs ?? 0;
      // No newer run: the refresh scans nothing and is not held.
      expect(await runs()).toBe(0);
      await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf, triggerType: "manual" });
      // A burst shares the one refresh in flight.
      expect(await Promise.all(Array.from({ length: 5 }, runs))).toEqual([1, 1, 1, 1, 1]);
      // Within the hold, a newer run waits instead of rescanning the day.
      await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf, triggerType: "manual" });
      expect(await runs()).toBe(1);
      resetSavingsRefreshCache();
      expect(await runs()).toBe(2);
    });

    test("bad input is rejected", async () => {
      expect((await get("/api/savings/jobs")).status).toBe(400);
      expect((await get("/api/savings/jobs?workflowId=nope")).status).toBe(404);
      expect((await get("/api/savings/daily?workflowId=nope")).status).toBe(404);
      expect((await get("/api/savings/daily")).status).toBe(400);
      expect((await get(`/api/savings/jobs?workflowId=${capLive}&tier=huge`)).status).toBe(400);
      expect((await get("/api/savings/jobs?kind=workflow&days=12")).status).toBe(400);
    });
  });
  describe("rollup and refresh writes interleaved", () => {
    let wf: string;
    const today = () => utcDay(Date.now());
    /** An hour later: today is due on the next tick. */
    const ageToday = () =>
      getDbClient().run("UPDATE automation_savings_days SET computedAt=? WHERE day=?", [
        new Date(Date.now() - HOUR).toISOString(),
        today(),
      ]);
    const bucketRuns = async () =>
      Number(
        (
          await getDbClient().get<{ runs: number }>(
            "SELECT runs FROM automation_savings_daily WHERE day=? AND jobKind='workflow' AND jobId=?",
            [today(), wf],
          )
        )?.runs ?? 0,
      );
    const workflowRow = async () => {
      const row = await getWorkflow(wf);
      if (!row) throw new Error("workflow missing");
      return row;
    };
    /** Runs `during` once: after the rollup's scan of `wf` ends, before the day is written. */
    const afterScanOf = (during: () => Promise<void>): SavingsSql => {
      let fired = false;
      return async (sql, params) => {
        const rows = await inProcessSql(sql, params);
        if (!fired && sql.includes("WITH e AS") && params[0] === wf) {
          fired = true;
          await during();
        }
        return rows;
      };
    };
    const newRun = async () => {
      await Bun.sleep(2);
      await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf, triggerType: "manual" });
      await Bun.sleep(2);
    };

    beforeAll(async () => {
      wf = (await createWorkflow({ name: "rollup-interleave", definition: DEFINITION })).id;
      await createWorkflowRun({ id: crypto.randomUUID(), workflowId: wf, triggerType: "manual" });
    });

    test("a run that starts during the rollup's scan is found by the next refresh", async () => {
      await ageToday();
      await runSavingsRollupTick(afterScanOf(newRun));
      expect(await bucketRuns()).toBe(1);
      expect(await refreshWorkflowToday(await workflowRow(), inProcessSql, Date.now())).toBe(
        "computed",
      );
      expect(await bucketRuns()).toBe(2);
    });

    test("a refresh during the rollup's scan keeps its newer bucket", async () => {
      await ageToday();
      const row = await workflowRow();
      let refreshed: string | null = null;
      await runSavingsRollupTick(
        afterScanOf(async () => {
          await newRun();
          refreshed = await refreshWorkflowToday(row, inProcessSql, Date.now());
        }),
      );
      expect(refreshed).toBe("computed");
      // The rollup scanned before the third run; its later write keeps the refresh's bucket.
      expect(await bucketRuns()).toBe(3);
    });
  });
});
