import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  getScheduledTaskByName,
  getWorkflowByName,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { getSeedState, runSeeder } from "../be/seed";
import type { Addon } from "../be/seed/addons";
import { createSchedulesSeeder } from "../be/seed/schedules-seeder";
import { createWorkflowsSeeder } from "../be/seed/workflows-seeder";

const TEST_DB_PATH = "./test-seed-schedules.sqlite";
const SECOND_TEST_DB_PATH = "./test-seed-schedules-second.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeAddon(): Addon {
  return {
    name: "test-addon",
    description: "Fixture add-on for schedule seeder tests.",
    docsPath: "docs/test-addon.mdx",
    workflows: [
      {
        name: "test-scheduled-workflow",
        description: "A workflow targeted by a seeded schedule.",
        enabled: true,
        definition: {
          nodes: [{ id: "work", type: "agent-task", config: { template: "Do the work." } }],
        },
      },
    ],
    schedules: [
      {
        name: "test-workflow-schedule",
        description: "A workflow-target fixture schedule.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        targetType: "workflow",
        workflowName: "test-scheduled-workflow",
      },
    ],
    skillNames: [],
    scriptNames: [],
    configKeys: [],
  };
}

async function seedAddon(addon: Addon) {
  const workflows = await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
  const schedules = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
  return { workflows, schedules };
}

beforeEach(async () => {
  await removeDbFiles(TEST_DB_PATH);
  await removeDbFiles(SECOND_TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  await removeDbFiles(SECOND_TEST_DB_PATH);
});

describe("schedules seeder", () => {
  test("seeds a workflow-target schedule and re-runs as a no-op", async () => {
    const addon = makeAddon();
    const first = await seedAddon(addon);
    expect(first.workflows.created).toBe(1);
    expect(first.schedules.created).toBe(1);

    const schedule = getScheduledTaskByName("test-workflow-schedule");
    const workflow = getWorkflowByName("test-scheduled-workflow");
    expect(schedule).toMatchObject({
      targetType: "workflow",
      workflowId: workflow?.id,
      cronExpression: "0 9 * * *",
    });

    const second = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(second.skippedUnchanged).toBe(1);
    expect(second.updated).toBe(0);
  });

  test("a disabled schedule survives a source cron change", async () => {
    const addon = makeAddon();
    await seedAddon(addon);
    const schedule = getScheduledTaskByName("test-workflow-schedule");
    expect(schedule).not.toBeNull();
    updateScheduledTask(schedule!.id, { enabled: false });
    addon.schedules[0]!.cronExpression = "30 9 * * *";

    const result = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(result.skippedUserModified).toBe(1);
    expect(getScheduledTaskByName("test-workflow-schedule")).toMatchObject({
      enabled: false,
      cronExpression: "0 9 * * *",
    });
  });

  test("a retimed schedule survives a source change", async () => {
    const addon = makeAddon();
    await seedAddon(addon);
    const schedule = getScheduledTaskByName("test-workflow-schedule");
    expect(schedule).not.toBeNull();
    updateScheduledTask(schedule!.id, { cronExpression: "15 10 * * *" });
    addon.schedules[0]!.cronExpression = "30 9 * * *";

    const result = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(result.skippedUserModified).toBe(1);
    expect(getScheduledTaskByName("test-workflow-schedule")?.cronExpression).toBe("15 10 * * *");
  });

  test("a pristine schedule updates when its source changes", async () => {
    const addon = makeAddon();
    await seedAddon(addon);
    addon.schedules[0]!.cronExpression = "30 9 * * *";

    const result = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(result.updated).toBe(1);
    expect(getScheduledTaskByName("test-workflow-schedule")?.cronExpression).toBe("30 9 * * *");
  });

  test("a description-only source change reaches a pristine schedule", async () => {
    const addon = makeAddon();
    await seedAddon(addon);
    addon.schedules[0]!.description = "Reworded fixture description.";

    const result = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(result.updated).toBe(1);
    expect(getScheduledTaskByName("test-workflow-schedule")?.description).toBe(
      "Reworded fixture description.",
    );
  });

  test("workflow-target content hashes do not leak generated workflow IDs", async () => {
    const addon = makeAddon();
    await seedAddon(addon);
    const firstHash = getSeedState("schedule", "test-workflow-schedule")?.seededHash;

    closeDb();
    await removeDbFiles(SECOND_TEST_DB_PATH);
    initDb(SECOND_TEST_DB_PATH);
    await seedAddon(addon);
    const secondHash = getSeedState("schedule", "test-workflow-schedule")?.seededHash;

    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondHash).toBe(firstHash);
  });

  test("task-target schedules honor taskTemplate and preserve a manual disable", async () => {
    const addon = makeAddon();
    addon.schedules.push({
      name: "test-task-schedule",
      description: "An agent-task fixture schedule.",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      enabled: true,
      targetType: "agent-task",
      taskTemplate: "Run the scheduled task.",
      taskType: "maintenance",
      tags: ["fixture"],
    });
    await seedAddon(addon);

    const schedule = getScheduledTaskByName("test-task-schedule");
    expect(schedule).toMatchObject({
      targetType: "agent-task",
      taskTemplate: "Run the scheduled task.",
      taskType: "maintenance",
      tags: ["fixture"],
    });

    updateScheduledTask(schedule!.id, { enabled: false });
    const taskSource = addon.schedules.find((item) => item.name === "test-task-schedule");
    expect(taskSource).toBeDefined();
    if (taskSource?.targetType === "agent-task") taskSource.cronExpression = "30 10 * * *";

    const result = await runSeeder(createSchedulesSeeder([addon]), { quiet: true });
    expect(result.skippedUserModified).toBe(1);
    expect(getScheduledTaskByName("test-task-schedule")).toMatchObject({
      enabled: false,
      cronExpression: "0 10 * * *",
    });
  });
});
