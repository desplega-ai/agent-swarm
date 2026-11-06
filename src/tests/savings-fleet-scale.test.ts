import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, getDbClient, initDb } from "../be/db";
import { emptyFacts } from "../be/savings/compute";
import { MODEL_VERSION } from "../be/savings/model";
import { resetSavingsReadCache, savingsFleetLoads } from "../be/savings/read";
import { resetSavingsRollupForTests, utcDay, writeWorkflowDay } from "../be/savings/rollup";
import { handleSavings } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// Fleet scale: 1,000 workflows and 400 scripts with a bucket on each of the 91 UTC days a 90-day window touches
// (127k rows). Before the chunked, shared read, the four reads of the fleet page
// held the event loop for over a second.
const NOW = Date.now();
const DAYS = 90;
const WORKFLOWS = 1000;
const SCRIPTS = 400;
// A rolling window of DAYS days touches DAYS + 1 UTC days.
const FIRST_DAY = utcDay(NOW - DAYS * 86_400_000);
const pageReads = (days: number) => [
  `/api/savings/summary?days=${days}`,
  `/api/savings/daily?days=${days}`,
  `/api/savings/jobs?kind=workflow&days=${days}`,
  `/api/savings/jobs?kind=script&days=${days}`,
];

describe("savings fleet read at fleet scale", () => {
  let server: Server;
  let port: number;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /**
   * Fire the page's four reads at once, for `viewers` simultaneous viewers;
   * return the bodies (viewer by viewer) and the longest event-loop stall.
   */
  async function pageLoad(days = DAYS, viewers = 1) {
    let last = performance.now();
    let maxGapMs = 0;
    const ticker = setInterval(() => {
      const t = performance.now();
      maxGapMs = Math.max(maxGapMs, t - last);
      last = t;
    }, 2);
    try {
      const paths = Array.from({ length: viewers }, () => pageReads(days)).flat();
      const results = await Promise.all(paths.map(get));
      return { results, maxGapMs };
    } finally {
      clearInterval(ticker);
    }
  }

  beforeAll(async () => {
    initDb(":memory:");
    await resetSavingsRollupForTests();
    const db = getDbClient();
    const at = new Date(NOW).toISOString();
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ?)
       INSERT INTO automation_savings_days (day, jobKind, modelVersion, computedAt)
       SELECT date(?, '+' || i || ' days'), k.kind, ?, ? FROM d, (SELECT 'workflow' kind UNION ALL SELECT 'script') k`,
      [DAYS, FIRST_DAY, MODEL_VERSION, at],
    );
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, schedRuns, effectRuns, opsSum, agentTasks, agentUsd, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'workflow', 'wf-' || j.i, 'wf-' || j.i, 'wf ' || j.i, '', 30, 30, 24, 3, 270, 1, 0.5, 12, ?, ? FROM d, j`,
      [DAYS, WORKFLOWS - 1, FIRST_DAY, MODEL_VERSION, at],
    );
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, effectRuns, opsSum, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'script', 'sc-' || j.i, 'sc-' || j.i, 'sc-' || j.i, '', 20, 20, 2, 80, 5, ?, ? FROM d, j`,
      [DAYS, SCRIPTS - 1, FIRST_DAY, MODEL_VERSION, at],
    );
    resetSavingsReadCache();
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
  }, 60_000);

  afterAll(() => {
    server?.close();
    closeDb();
  });

  // Timing-sensitive: a stall bound on a shared CI runner. The unchunked read stalled
  // for ~300ms per read here, so 150ms still separates the two by a wide margin.
  test(
    "the four page reads share one load per kind and never stall the loop for long",
    async () => {
      resetSavingsReadCache();
      const cold = await pageLoad();
      for (const r of cold.results) expect(r.status).toBe(200);
      const [summary, daily, workflows, scripts] = cold.results.map((r) => r.body);
      expect(summary?.valid).toBe(true);
      expect(summary?.byKind.workflows.jobs).toBe(WORKFLOWS);
      expect(summary?.byKind.agentInvokedScripts.jobs).toBe(SCRIPTS);
      expect(daily?.points).toHaveLength(DAYS + 1);
      expect(workflows?.rows).toHaveLength(WORKFLOWS);
      expect(scripts?.rows).toHaveLength(SCRIPTS);
      // One workflow load and one script load serve all four reads.
      expect(savingsFleetLoads()).toBe(2);
      expect(cold.maxGapMs).toBeLessThan(150);

      const warm = await pageLoad();
      expect(warm.results.map((r) => r.body)).toEqual(
        cold.results.map((r) => ({ ...r.body, window: expect.anything() })),
      );
      expect(savingsFleetLoads()).toBe(2);
    },
    { retry: 2, timeout: 30_000 },
  );

  test(
    "30 days and simultaneous viewers: one load per kind and window, no long stall",
    async () => {
      resetSavingsReadCache();
      const cold = await pageLoad(30, 3);
      for (const r of cold.results) expect(r.status).toBe(200);
      // `window.end` is each request's own clock; everything else must match.
      const bodies = cold.results.map((r) => ({ ...r.body, window: { ...r.body.window, end: 0 } }));
      const [summary, daily, workflows, scripts] = bodies;
      expect(summary?.byKind.workflows.jobs).toBe(WORKFLOWS);
      expect(daily?.points).toHaveLength(31);
      expect(workflows?.rows).toHaveLength(WORKFLOWS);
      expect(scripts?.rows).toHaveLength(SCRIPTS);
      // Every viewer gets the same answer from the same two loads.
      for (let v = 1; v < 3; v++)
        expect(bodies.slice(v * 4, v * 4 + 4)).toEqual(bodies.slice(0, 4));
      expect(savingsFleetLoads()).toBe(2);
      expect(cold.maxGapMs).toBeLessThan(150);
      // The daily points add up to the summary total.
      const pointsSum = daily?.points.reduce(
        (a: number, p: { savingUsd: number }) => a + p.savingUsd,
        0,
      );
      expect(pointsSum).toBeCloseTo(summary?.total.savingUsd.p50, 2);

      // A 90-day viewer arriving later is its own window: two more loads, not four.
      const wide = await pageLoad(DAYS, 2);
      expect(wide.results[1]?.body.points).toHaveLength(DAYS + 1);
      expect(savingsFleetLoads()).toBe(4);
      expect(wide.maxGapMs).toBeLessThan(150);
    },
    { retry: 2, timeout: 30_000 },
  );

  test("a rollup write invalidates the cached workflow read", async () => {
    resetSavingsReadCache();
    await get(`/api/savings/summary?days=${DAYS}`);
    expect(savingsFleetLoads()).toBe(2);
    const today = utcDay(NOW);
    await writeWorkflowDay(
      today,
      {
        buckets: [
          {
            workflowId: "wf-new",
            name: "wf new",
            facts: { ...emptyFacts(), runs: 5, countedRuns: 5 },
          },
        ],
        links: [],
      },
      new Date().toISOString(),
    );
    const { body } = await get(`/api/savings/jobs?kind=workflow&days=${DAYS}`);
    expect(savingsFleetLoads()).toBe(3);
    expect(body.rows.some((r: { workflowId: string }) => r.workflowId === "wf-new")).toBe(true);
  });
});
