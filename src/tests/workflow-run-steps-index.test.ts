import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";

const TEST_DB_PATH = "./test-workflow-run-steps-index.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

// Step lookups filtered by runId plus status. Without a runId-led index the
// planner picks idx_wrs_status, and 'completed' matches almost every row.
const RUN_AND_STATUS_QUERIES: Array<[string, string, unknown[]]> = [
  [
    "getCompletedStepNodeIds",
    "SELECT nodeId FROM workflow_run_steps WHERE runId = ? AND status = 'completed'",
    ["run-1"],
  ],
  [
    "newer completed predecessor",
    `SELECT 1 AS found FROM workflow_run_steps
       WHERE runId = ? AND status = 'completed'
         AND nodeId IN (?, ?)
         AND rowid > (SELECT rowid FROM workflow_run_steps WHERE id = ?)
       LIMIT 1`,
    ["run-1", "node-1", "node-2", "step-1"],
  ],
];

describe("workflow_run_steps runId + status lookups", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    const client = getDbClient();
    await client.run("PRAGMA foreign_keys = OFF");
    // Mirror production: nearly every step is 'completed'.
    await client.transaction(async (tx) => {
      for (let i = 0; i < 500; i++) {
        await tx.run(
          `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt)
           VALUES (?, ?, ?, 'agent-task', ?, '2026-10-27T00:00:00.000Z')`,
          [`step-${i}`, `run-${i % 50}`, `node-${i % 10}`, i % 100 === 0 ? "running" : "completed"],
        );
      }
    });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  for (const [name, sql, params] of RUN_AND_STATUS_QUERIES) {
    test(`${name} seeks by runId, not idx_wrs_status`, async () => {
      const plan = await getDbClient().query<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${sql}`,
        params,
      );
      const detail = plan.map((row) => row.detail).join("\n");
      expect(detail).toContain("idx_wrs_runId_status (runId=? AND status=?");
      expect(detail).not.toContain("idx_wrs_status");
    });
  }
});
