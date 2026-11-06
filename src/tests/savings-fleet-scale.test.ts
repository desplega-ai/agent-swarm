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

// Fleet scale: 1,000 workflows and 400 scripts with a bucket on each of 90 days
// (126k rows). Before the chunked, shared read, the four reads of the fleet page
// held the event loop for over a second.
const NOW = Date.now();
const DAYS = 90;
const WORKFLOWS = 1000;
const SCRIPTS = 400;
const FIRST_DAY = utcDay(NOW - (DAYS - 1) * 86_400_000);
const PAGE_READS = [
  `/api/savings/summary?days=${DAYS}`,
  `/api/savings/daily?days=${DAYS}`,
  `/api/savings/jobs?kind=workflow&days=${DAYS}`,
  `/api/savings/jobs?kind=script&days=${DAYS}`,
];

describe("savings fleet read at fleet scale", () => {
  let server: Server;
  let port: number;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /** Fire the page's four reads at once; return their bodies and the longest event-loop stall. */
  async function pageLoad() {
    let last = performance.now();
    let maxGapMs = 0;
    const ticker = setInterval(() => {
      const t = performance.now();
      maxGapMs = Math.max(maxGapMs, t - last);
      last = t;
    }, 2);
    try {
      const results = await Promise.all(PAGE_READS.map(get));
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
      [DAYS - 1, FIRST_DAY, MODEL_VERSION, at],
    );
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, schedRuns, effectRuns, opsSum, agentTasks, agentUsd, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'workflow', 'wf-' || j.i, 'wf-' || j.i, 'wf ' || j.i, '', 30, 30, 24, 3, 270, 1, 0.5, 12, ?, ? FROM d, j`,
      [DAYS - 1, WORKFLOWS - 1, FIRST_DAY, MODEL_VERSION, at],
    );
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, effectRuns, opsSum, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'script', 'sc-' || j.i, 'sc-' || j.i, 'sc-' || j.i, '', 20, 20, 2, 80, 5, ?, ? FROM d, j`,
      [DAYS - 1, SCRIPTS - 1, FIRST_DAY, MODEL_VERSION, at],
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
      expect(daily?.points).toHaveLength(DAYS);
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

  test("a rollup write invalidates the cached workflow read", async () => {
    resetSavingsReadCache();
    await get(`/api/savings/summary?days=${DAYS}`);
    expect(savingsFleetLoads()).toBe(2);
    const today = utcDay(NOW);
    await writeWorkflowDay(
      today,
      [
        {
          workflowId: "wf-new",
          name: "wf new",
          facts: { ...emptyFacts(), runs: 5, countedRuns: 5 },
        },
      ],
      new Date().toISOString(),
    );
    const { body } = await get(`/api/savings/jobs?kind=workflow&days=${DAYS}`);
    expect(savingsFleetLoads()).toBe(3);
    expect(body.rows.some((r: { workflowId: string }) => r.workflowId === "wf-new")).toBe(true);
  });
});
