import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getScheduledTaskByName, initDb, updateScheduledTask } from "../be/db";
import { runSeeder } from "../be/seed";
import {
  createSchedulesSeeder,
  loadSeedSchedules,
  type ScheduleTemplateSource,
} from "../be/seed/schedules-seeder";

const TEST_DB_PATH = "./test-seed-schedules.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function scheduleSource(cron = "0 9 * * *", description = "Seeded schedule.") {
  return {
    config: JSON.stringify({
      name: "test-seeded-schedule",
      title: "Test seeded schedule",
      description,
      placeholders: ["REPO_URL"],
      requires: ["github"],
      runAllSeedersCandidate: true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron,
      timezone: "UTC",
      enabled: true,
    })}\n\`\`\`\n\n## Scheduled Task\n\nRun work for {{REPO_URL}}.`,
  } satisfies ScheduleTemplateSource;
}

beforeEach(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
});

describe("schedules seeder", () => {
  test("loads only the four starter candidates, including the unfenced schedule block", () => {
    const schedules = loadSeedSchedules();
    expect(schedules).toHaveLength(4);
    expect(schedules.find((schedule) => schedule.name === "daily-status-report")).toMatchObject({
      cronExpression: "15 2 * * *",
      requiredParams: [],
      requires: [],
    });
    expect(schedules.some((schedule) => schedule.name === "weekly-dependabot-triage")).toBe(false);
    expect(schedules.some((schedule) => schedule.name === "weekly-harness-upgrade-check")).toBe(
      false,
    );
  });

  test("seeds a schedule with setup metadata and re-runs as a no-op", async () => {
    const seeder = createSchedulesSeeder([scheduleSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      targetType: "agent-task",
      cronExpression: "0 9 * * *",
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
      tags: ["fixture"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
  });

  test("preserves a schedule disabled by the operator", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const seeded = await getScheduledTaskByName("test-seeded-schedule");
    await updateScheduledTask(seeded!.id, { enabled: false });

    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result.skippedUserModified).toBe(1);
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      enabled: false,
      cronExpression: "0 9 * * *",
    });
  });

  test("updates a pristine schedule when its template changes", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getScheduledTaskByName("test-seeded-schedule"))?.cronExpression).toBe(
      "30 9 * * *",
    );
  });

  test("reports an invalid cron without creating a row", async () => {
    const result = await runSeeder(createSchedulesSeeder([scheduleSource("not a cron")]), {
      quiet: true,
    });
    expect(result.created).toBe(0);
    expect(result.failed[0]).toMatchObject({ key: "test-seeded-schedule" });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toBeNull();
  });
});
