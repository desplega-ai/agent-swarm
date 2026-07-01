import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import { createRun, getRun, setRunStatus } from "../db/queries.ts";
import { reconcileOrphanedRuns } from "./index.ts";

const ENV_KEYS = ["EVALS_DB_PATH", "EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(async () => {
  resetDbForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  await initDb();
});

afterEach(() => {
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("orphaned eval run recovery", () => {
  test("reconcileOrphanedRuns sweeps DB-running runs and marks them failed", async () => {
    const db = getDb();
    await createRun(db, {
      id: "run-orphaned",
      scenarioIds: ["scenario-a"],
      configIds: ["config-a"],
      attemptsPerCell: 1,
      concurrency: 1,
    });
    await setRunStatus(db, "run-orphaned", "running");

    const sweptRunIds: string[] = [];
    const logs: string[] = [];
    const count = await reconcileOrphanedRuns(
      db,
      (msg) => logs.push(msg),
      async (runId) => {
        sweptRunIds.push(runId);
        return 2;
      },
    );

    expect(count).toBe(1);
    expect(sweptRunIds).toEqual(["run-orphaned"]);
    expect((await getRun(db, "run-orphaned"))?.status).toBe("failed");
    expect(logs.join("\n")).toContain('run run-orphaned was left "running"');
    expect(logs.join("\n")).toContain("swept 2 sandbox(es), marked failed");
  });
});
