import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbClient, initDb } from "../be/db";
import { MODEL_VERSION } from "../be/savings/model";
import { resetSavingsReadCache } from "../be/savings/read";
import { resetSavingsRollupForTests, utcDay } from "../be/savings/rollup";
import { clearCalibrationCache, handleSavings } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// Production-sized rollup: 50 workflows and 150 scripts with a bucket on each of
// the 91 UTC days a 90-day window touches (18k rows).
//
// On a busy API every statement waits its turn on the shared connection and the
// event loop: a few ms idle, up to a second under load. The fleet read sliced
// its window into fixed 3-day queries, so a cold 90-day summary was ~70
// sequential statements and took 25-50 s in production, while one-statement
// routes stayed fast. savings-fleet-scale.test.ts bounds the event-loop stall
// in an idle process, where a statement costs nothing, so it never saw this.
// Here every statement pays a fixed wait.
const NOW = Date.now();
const DAYS = 90;
const WORKFLOWS = 50;
const SCRIPTS = 150;
const FIRST_DAY = utcDay(NOW - DAYS * 86_400_000);
const WAIT_MS = 25;

const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedFleetLatencyTemplate?: Uint8Array;
};

describe("savings fleet read on a busy connection", () => {
  let server: Server;
  let port: number;
  let dbDir: string | undefined;

  beforeAll(async () => {
    // A real file: the script read's first-day scan goes through the bounded
    // db-query path, which snapshots an in-memory database (see the scale test).
    templateGlobals.__savedFleetLatencyTemplate = templateGlobals.__testMigrationTemplate;
    templateGlobals.__testMigrationTemplate = undefined;
    closeDb();
    dbDir = mkdtempSync(join(tmpdir(), "savings-fleet-latency-"));
    initDb(join(dbDir, "fleet.sqlite"));
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
    templateGlobals.__testMigrationTemplate = templateGlobals.__savedFleetLatencyTemplate;
    templateGlobals.__savedFleetLatencyTemplate = undefined;
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  // Timing-sensitive: wall-clock bound on a shared CI runner. The 3-day slices
  // took ~1.8 s here at 90 days; the row-count slices take ~0.2 s.
  test(
    "a cold summary and job list answer in a few statements for 7, 30 and 90 days",
    async () => {
      const client = getDbClient();
      const original = { query: client.query, get: client.get };
      let statements = 0;
      const delayed =
        <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          statements++;
          await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
          return fn.apply(client, args);
        };
      client.query = delayed(original.query) as typeof client.query;
      client.get = delayed(original.get) as typeof client.get;
      const slow: { path: string; statements: number; ms: number }[] = [];
      try {
        for (const days of [7, 30, DAYS]) {
          for (const path of [
            `/api/savings/summary?days=${days}`,
            `/api/savings/jobs?kind=workflow&days=${days}`,
            `/api/savings/jobs?kind=script&days=${days}`,
          ]) {
            resetSavingsReadCache();
            clearCalibrationCache();
            statements = 0;
            const t = performance.now();
            const res = await fetch(`http://127.0.0.1:${port}${path}`);
            const body = (await res.json()) as Record<string, any>;
            const ms = performance.now() - t;
            expect(res.status).toBe(200);
            expect(body.valid).toBe(true);
            // The 3-day slices issued 2 per kind plus 1 per 3 days per kind: 68 at 90 days.
            if (statements > 12 || ms >= 1_000) slow.push({ path, statements, ms: Math.round(ms) });
          }
        }
        expect(slow).toEqual([]);
      } finally {
        client.query = original.query;
        client.get = original.get;
      }
    },
    { retry: 2, timeout: 60_000 },
  );
});
