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

/** A zero-config candidate: no requires, no placeholders — eligible for auto-enable. */
function zeroConfigScheduleSource(opts?: { name?: string; templateEnabled?: boolean }) {
  const name = opts?.name ?? "test-zero-config-schedule";
  const templateEnabled = opts?.templateEnabled ?? true;
  return {
    config: JSON.stringify({
      name,
      title: "Test zero-config schedule",
      description: "Zero-config seeded schedule.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: templateEnabled,
    })}\n\`\`\`\n\n## Scheduled Task\n\nRun work.`,
  } satisfies ScheduleTemplateSource;
}

const ORIGINAL_SEED_AUTOMATIONS_ENABLED = process.env.SEED_AUTOMATIONS_ENABLED;

beforeEach(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
  if (ORIGINAL_SEED_AUTOMATIONS_ENABLED === undefined) {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
  } else {
    process.env.SEED_AUTOMATIONS_ENABLED = ORIGINAL_SEED_AUTOMATIONS_ENABLED;
  }
});

describe("schedules seeder", () => {
  test("loads only the five starter candidates, including the unfenced schedule block", () => {
    const schedules = loadSeedSchedules();
    expect(schedules).toHaveLength(5);
    // Zero-config, requires:[], placeholders:[], template enabled:true -> auto-enabled
    // under the default (unset -> on) SEED_AUTOMATIONS_ENABLED switch.
    expect(schedules.find((schedule) => schedule.name === "daily-status-report")).toMatchObject({
      cronExpression: "15 2 * * *",
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(
      schedules.find((schedule) => schedule.name === "daily-swarm-update-check"),
    ).toMatchObject({
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(schedules.some((schedule) => schedule.name === "weekly-dependabot-triage")).toBe(false);
    expect(schedules.some((schedule) => schedule.name === "weekly-harness-upgrade-check")).toBe(
      false,
    );
  });

  test("SEED_AUTOMATIONS_ENABLED=false keeps every candidate disabled, including zero-config ones", () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const schedules = loadSeedSchedules();
    expect(schedules.every((schedule) => schedule.enabled === false)).toBe(true);
  });

  test("switch on: a zero-config candidate auto-enables via createSchedulesSeeder/apply", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: true,
    });
  });

  test("switch on: an item with unmet requires stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([scheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("switch off: a zero-config candidate stays disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("switch on: a zero-config candidate whose template recommends staying off stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource({ templateEnabled: false })]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("seeds a schedule with setup metadata and re-runs as a no-op", async () => {
    const seeder = createSchedulesSeeder([scheduleSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      targetType: "agent-task",
      cronExpression: "0 9 * * *",
      enabled: false,
      nextRunAt: undefined,
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
      tags: ["fixture"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
  });

  test("preserves a schedule enabled by the operator", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const seeded = await getScheduledTaskByName("test-seeded-schedule");
    await updateScheduledTask(seeded!.id, { enabled: true });

    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result.skippedUserModified).toBe(1);
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      enabled: true,
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
