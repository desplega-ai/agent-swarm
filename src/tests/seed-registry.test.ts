import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  getScheduledTaskByName,
  getScheduledTasks,
  initDb,
  listWorkflows,
} from "../be/db";
import { getScript } from "../be/scripts/db";
import { runSeeder, SEEDERS } from "../be/seed";
import { schedulesSeeder } from "../be/seed/schedules-seeder";
import { workflowsSeeder } from "../be/seed/workflows-seeder";
import { scriptsSeeder } from "../be/seed-scripts";

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

  test("the bundled catalogs include every workflow and schedule template", async () => {
    for (const [kind, seeder] of [
      ["workflows", workflowsSeeder],
      ["schedules", schedulesSeeder],
    ] as const) {
      const catalogNames: string[] = [];
      const catalogDir = `${import.meta.dir}/../../templates/${kind}`;
      for await (const path of new Bun.Glob("*/config.json").scan(catalogDir)) {
        const config = await Bun.file(`${catalogDir}/${path}`).json();
        catalogNames.push(config.name);
      }
      expect(
        seeder
          .items()
          .map((item) => item.key)
          .sort(),
      ).toEqual(catalogNames.sort());
    }
  });

  test("seeds all 22 automation templates on a fresh database and re-runs as a no-op", async () => {
    expect(await listWorkflows()).toHaveLength(0);
    expect(await getScheduledTasks()).toHaveLength(0);

    // Boot order: scripts seed before schedules, so a script-target schedule
    // (daily-swarm-update-check) resolves its catalog script on a fresh install.
    const order = SEEDERS.map((seeder) => seeder.kind);
    expect(order.indexOf("script")).toBeLessThan(order.indexOf("schedule"));
    expect(await getScript({ name: "swarm-update-check", scope: "global" })).toBeNull();
    const scriptResult = await runSeeder(scriptsSeeder, {
      quiet: true,
      scriptEmbeddingMode: "skip",
    });
    const workflowResult = await runSeeder(workflowsSeeder, { quiet: true });
    const scheduleResult = await runSeeder(schedulesSeeder, { quiet: true });

    expect(scriptResult.failed).toEqual([]);
    expect(workflowResult).toMatchObject({ created: 11, failed: [] });
    expect(scheduleResult).toMatchObject({ created: 11, failed: [] });
    expect(await getScheduledTaskByName("daily-swarm-update-check")).toMatchObject({
      targetType: "script",
      scriptName: "swarm-update-check",
    });
    expect((await listWorkflows()).map((workflow) => workflow.name).sort()).toEqual(
      workflowsSeeder.items().map((item) => item.key),
    );
    expect((await getScheduledTasks()).map((schedule) => schedule.name).sort()).toEqual(
      schedulesSeeder.items().map((item) => item.key),
    );

    expect(await runSeeder(workflowsSeeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 11,
      failed: [],
    });
    expect(await runSeeder(schedulesSeeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 11,
      failed: [],
    });
    expect(await listWorkflows()).toHaveLength(11);
    expect(await getScheduledTasks()).toHaveLength(11);
  }, 60_000); // typechecks every catalog script with tsc
});
