import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  DB_RETENTION_TABLES,
  getDbRetentionStats,
  resetDbRetentionForTests,
  runDbRetentionTick,
  sweepStatements,
} from "../be/db-retention";

const TEST_DB_PATH = "./test-script-runs-retention.sqlite";
const DAYS_KEY = "SCRIPT_RUNS_RETENTION_DAYS";
// With 1 day of retention the cutoff is 2026-08-22T12:00:00.000Z.
const NOW = new Date("2026-08-23T12:00:00.000Z");
const OLD_ISO = "2026-08-01T00:00:00.000Z";
const OLD_SPACED = "2026-08-01 00:00:00";
const RECENT_ISO = "2026-08-23T11:00:00.000Z";

const SCRIPT_RUNS = DB_RETENTION_TABLES.find((table) => table.table === "script_runs");
if (!SCRIPT_RUNS) throw new Error("script_runs is not in the retention allowlist");

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

async function insertRun(
  id: string,
  status: string,
  startedAt: string,
  options: { kind?: "inline" | "workflow"; idempotencyKey?: string } = {},
): Promise<void> {
  await getDbClient().run(
    `INSERT INTO script_runs (id, agentId, scriptName, source, args, status, startedAt, kind, idempotencyKey)
     VALUES (?, 'agent-1', 'retention-test', 'export default () => 1', '{}', ?, ?, ?, ?)`,
    [id, status, startedAt, options.kind ?? "inline", options.idempotencyKey ?? null],
  );
}

async function insertJournal(runId: string, stepKey: string): Promise<void> {
  await getDbClient().run(
    "INSERT INTO script_run_journal (id, runId, stepKey, stepType, status) VALUES (?, ?, ?, 'tool', 'completed')",
    [`${runId}-${stepKey}`, runId, stepKey],
  );
}

async function runIds(): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string }>("SELECT id FROM script_runs ORDER BY id");
  return rows.map((row) => row.id);
}

async function journalRunIds(): Promise<string[]> {
  const rows = await getDbClient().query<{ runId: string }>(
    "SELECT DISTINCT runId FROM script_run_journal ORDER BY runId",
  );
  return rows.map((row) => row.runId);
}

beforeAll(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  await resetDbRetentionForTests();
  delete process.env[DAYS_KEY];
  delete process.env.DB_RETENTION_DRY_RUN;
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  await resetDbRetentionForTests();
  delete process.env[DAYS_KEY];
  delete process.env.DB_RETENTION_DRY_RUN;
  await getDbClient().run("DELETE FROM script_run_journal");
  await getDbClient().run("DELETE FROM script_runs");
});

describe("script_runs age-based retention", () => {
  test("is opt-in: an unset key deletes nothing", async () => {
    await insertRun("old-completed", "completed", OLD_ISO);

    await runDbRetentionTick({ now: NOW });

    expect(await runIds()).toEqual(["old-completed"]);
    expect(getDbRetentionStats().scriptRuns).toBeUndefined();
  });

  test("deletes old finished runs and keeps running, paused, recent and keyed runs", async () => {
    for (const status of ["completed", "failed", "cancelled", "aborted_limit"]) {
      await insertRun(`old-${status}-iso`, status, OLD_ISO);
      await insertRun(`old-${status}-spaced`, status, OLD_SPACED, { kind: "workflow" });
    }
    await insertRun("old-running", "running", OLD_SPACED, { kind: "workflow" });
    await insertRun("old-paused", "paused", OLD_SPACED, { kind: "workflow" });
    await insertRun("old-keyed", "completed", OLD_SPACED, {
      kind: "workflow",
      idempotencyKey: "launch-once",
    });
    await insertRun("recent-completed", "completed", RECENT_ISO);
    process.env[DAYS_KEY] = "1";

    await runDbRetentionTick({ now: NOW });

    expect(await runIds()).toEqual(["old-keyed", "old-paused", "old-running", "recent-completed"]);
    expect(getDbRetentionStats().scriptRuns).toMatchObject({
      rowsDeleted: 8,
      drained: true,
      backlogRemaining: 0,
      dryRun: false,
    });
  });

  test("journal rows leave with their run and stay with a surviving one", async () => {
    await insertRun("old-done", "completed", OLD_SPACED, { kind: "workflow" });
    await insertRun("old-paused", "paused", OLD_SPACED, { kind: "workflow" });
    for (const step of ["a", "b", "c"]) {
      await insertJournal("old-done", step);
      await insertJournal("old-paused", step);
    }
    process.env[DAYS_KEY] = "1";

    await runDbRetentionTick({ now: NOW });

    expect(await runIds()).toEqual(["old-paused"]);
    expect(await journalRunIds()).toEqual(["old-paused"]);
    const journal = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM script_run_journal",
    );
    expect(journal?.n).toBe(3);
  });

  test("never deletes a row early across the two stored timestamp formats", async () => {
    // Cutoff: 2026-08-22T12:00:00.000Z, compared as '2026-08-22 12:00:00'.
    await insertRun("spaced-before", "completed", "2026-08-22 11:59:59", { kind: "workflow" });
    await insertRun("spaced-at", "completed", "2026-08-22 12:00:00", { kind: "workflow" });
    await insertRun("iso-previous-day", "completed", "2026-08-21T23:59:59.999Z");
    // Older than the cutoff, but on the cutoff's own date: kept until a later tick.
    await insertRun("iso-cutoff-day", "completed", "2026-08-22T11:00:00.000Z");
    await insertRun("iso-after", "completed", "2026-08-22T12:00:00.001Z");
    process.env[DAYS_KEY] = "1";

    await runDbRetentionTick({ now: NOW });

    expect(await runIds()).toEqual(["iso-after", "iso-cutoff-day", "spaced-at"]);

    // A day later every one of them is past the cutoff's date.
    await runDbRetentionTick({ now: new Date("2026-08-24T00:00:00.000Z") });

    expect(await runIds()).toEqual([]);
  });

  test("dry run counts the would-delete rows without deleting", async () => {
    await insertRun("old-completed", "completed", OLD_ISO);
    await insertRun("old-failed", "failed", OLD_SPACED, { kind: "workflow" });
    await insertRun("old-running", "running", OLD_SPACED, { kind: "workflow" });
    process.env[DAYS_KEY] = "1";
    process.env.DB_RETENTION_DRY_RUN = "true";

    await runDbRetentionTick({ now: NOW });

    expect(await runIds()).toHaveLength(3);
    expect(getDbRetentionStats().scriptRuns).toMatchObject({
      rowsDeleted: 0,
      backlogRemaining: 2,
      dryRun: true,
    });
  });

  test("drains a backlog larger than one batch within the batch ceiling", async () => {
    await getDbClient().run(
      `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 1200)
       INSERT INTO script_runs (id, agentId, source, status, startedAt)
       SELECT 'bulk-' || v, 'agent-1', 'x', 'completed', ? FROM n`,
      [OLD_ISO],
    );
    process.env[DAYS_KEY] = "1";

    await runDbRetentionTick({ now: NOW });

    const stats = getDbRetentionStats().scriptRuns;
    expect(await runIds()).toEqual([]);
    expect(stats?.rowsDeleted).toBe(1200);
    expect(stats?.batches).toBeGreaterThan(1);
    expect(stats?.batchSize).toBeLessThanOrEqual(500);
  });

  test("the delete, the backlog count and the journal cascade all use an index", async () => {
    const statements = sweepStatements(SCRIPT_RUNS, 30, NOW);
    const client = getDbClient();

    for (const [sql, params] of [
      [statements.deleteSql, [...statements.params, 100]],
      [statements.backlogSql, statements.params],
    ] as const) {
      const plan = await client.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [...params]);
      const detail = plan.map((row) => row.detail).join("\n");
      expect(detail).toContain("USING COVERING INDEX idx_script_runs_status_startedAt");
      expect(detail).not.toMatch(/SCAN script_runs(?! USING)/);
    }

    // ON DELETE CASCADE looks up journal rows of every deleted run by runId.
    const fkPlan = await client.query<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT rowid FROM script_run_journal WHERE runId = ?",
      ["x"],
    );
    expect(fkPlan.map((row) => row.detail).join("\n")).toContain("idx_srj_runId");
  });
});
