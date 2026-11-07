import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbClient, initDb } from "../be/db";
import { MODEL_VERSION } from "../be/savings/model";
import { readFleetSavings, resetSavingsReadCache } from "../be/savings/read";
import { resetSavingsRollupForTests, utcDay } from "../be/savings/rollup";

// The fleet read loads buckets in slices of whole days of about 5k rows. This
// fixture spans several slices per kind, so a slice that overlaps its
// neighbour (counting a day twice) or skips a day changes the run counts.
// Every job has the same facts, so every row ties on the saving, and the rows
// are written in reverse id order, so only the id tie-break sorts them.
const NOW = Date.now();
const DAYS = 7;
const JOBS = 1000;
const WF_RUNS = 30;
const SC_RUNS = 20;
// A 7-day window touches 8 UTC days. The first one is partial and scanned
// live, so the buckets sit on the 7 full days after it: 7,000 rows per kind.
const FIRST_DAY = utcDay(NOW - DAYS * 86_400_000);
const BUCKET_DAYS = DAYS;
const ids = (prefix: string) =>
  Array.from({ length: JOBS }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedFleetSlicesTemplate?: Uint8Array;
};

describe("savings fleet read slices", () => {
  let dbDir: string | undefined;

  beforeAll(async () => {
    // A real file, as in savings-fleet-scale.test.ts: the script read's
    // first-day scan goes through the bounded db-query path.
    templateGlobals.__savedFleetSlicesTemplate = templateGlobals.__testMigrationTemplate;
    templateGlobals.__testMigrationTemplate = undefined;
    closeDb();
    dbDir = mkdtempSync(join(tmpdir(), "savings-fleet-slices-"));
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
    // Day by day, highest id first: rowid order is reverse id order.
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, schedRuns, effectRuns, opsSum, agentTasks, agentUsd, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'workflow', printf('wf-%04d', ? - j.i), printf('wf-%04d', ? - j.i), 'wf', '', ?, ?, 0, 3, 270, 1, 0.5, 12, ?, ?
       FROM d, j ORDER BY d.i, j.i`,
      [BUCKET_DAYS, JOBS - 1, FIRST_DAY, JOBS - 1, JOBS - 1, WF_RUNS, WF_RUNS, MODEL_VERSION, at],
    );
    await db.run(
      `WITH RECURSIVE d(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM d WHERE i < ?),
                     j(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM j WHERE i < ?)
       INSERT INTO automation_savings_daily
         (day, jobKind, jobId, jobKey, jobName, subKind, runs, countedRuns, effectRuns, opsSum, computeSecs, modelVersion, computedAt)
       SELECT date(?, '+' || d.i || ' days'), 'script', printf('sc-%04d', ? - j.i), printf('sc-%04d', ? - j.i), printf('sc-%04d', ? - j.i), '', ?, ?, 2, 80, 5, ?, ?
       FROM d, j ORDER BY d.i, j.i`,
      [
        BUCKET_DAYS,
        JOBS - 1,
        FIRST_DAY,
        JOBS - 1,
        JOBS - 1,
        JOBS - 1,
        SC_RUNS,
        SC_RUNS,
        MODEL_VERSION,
        at,
      ],
    );
    resetSavingsReadCache();
  }, 60_000);

  afterAll(() => {
    closeDb();
    templateGlobals.__testMigrationTemplate = templateGlobals.__savedFleetSlicesTemplate;
    templateGlobals.__savedFleetSlicesTemplate = undefined;
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("the fixture spans more than one slice per kind and is written in reverse id order", async () => {
    const db = getDbClient();
    for (const kind of ["workflow", "script"]) {
      const [row] = await db.query<{ n: number; days: number }>(
        "SELECT count(*) n, count(DISTINCT day) days FROM automation_savings_daily WHERE jobKind = ?",
        [kind],
      );
      expect(row?.n).toBe(JOBS * BUCKET_DAYS);
      expect(row?.days).toBe(BUCKET_DAYS);
      const first = await db.query<{ jobId: string }>(
        "SELECT jobId FROM automation_savings_daily WHERE jobKind = ? ORDER BY rowid LIMIT 2",
        [kind],
      );
      expect(first.map((r) => r.jobId)).toEqual(
        kind === "workflow" ? ["wf-0999", "wf-0998"] : ["sc-0999", "sc-0998"],
      );
    }
  });

  test("every day is read exactly once and tied rows sort by id", async () => {
    const read = await readFleetSavings({ days: DAYS, tier: "smart", now: NOW });
    expect(read.complete).toBe(true);
    expect(read.workflows.map((r) => r.workflowId)).toEqual(ids("wf"));
    expect(read.scripts.map((r) => r.scriptName)).toEqual(ids("sc"));
    for (const r of read.workflows) expect(r.runs).toBe(WF_RUNS * BUCKET_DAYS);
    for (const r of read.scripts) expect(r.runs).toBe(SC_RUNS * BUCKET_DAYS);
    expect(read.byKind.workflows.jobs).toBe(JOBS);
    expect(read.total?.runs).toBe(JOBS * (WF_RUNS + SC_RUNS) * BUCKET_DAYS);
    expect(read.points).toHaveLength(DAYS + 1);
  });
});
