import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb, listWorkflows } from "../be/db";
import { runSeeder, SEEDERS } from "../be/seed";
import { schedulesSeeder } from "../be/seed/schedules-seeder";
import { workflowsSeeder } from "../be/seed/workflows-seeder";

const TEST_DB_PATH = "./test-seed-registry.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeEach(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
});

describe("seeder registry", () => {
  test("registers workflows before schedules", () => {
    expect(SEEDERS.map((seeder) => seeder.kind)).toEqual([
      "agent-fs-provision",
      "script",
      "skill",
      "workflow",
      "schedule",
    ]);
  });

  test("the built-in catalogs expose the expected candidate counts", () => {
    expect(workflowsSeeder.items()).toHaveLength(7);
    expect(schedulesSeeder.items()).toHaveLength(5);
  });

  test("seeds all starter workflow and schedule rows on a fresh database", async () => {
    const workflowResult = await runSeeder(workflowsSeeder, { quiet: true });
    const scheduleResult = await runSeeder(schedulesSeeder, { quiet: true });

    expect(workflowResult).toMatchObject({ created: 7, failed: [] });
    expect(scheduleResult).toMatchObject({ created: 5, failed: [] });
    expect(await listWorkflows()).toHaveLength(7);
  });
});
