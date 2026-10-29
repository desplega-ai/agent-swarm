import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getScheduledTaskByName,
  getScheduledTasks,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { runSeeder } from "../be/seed";
import {
  createSchedulesSeeder,
  loadSeedSchedules,
  type ScheduleTemplateSource,
} from "../be/seed/schedules-seeder";
import { createWorkflowsSeeder } from "../be/seed/workflows-seeder";

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
function zeroConfigScheduleSource(opts?: {
  name?: string;
  templateEnabled?: boolean;
  autoEnableCandidate?: boolean;
}) {
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
      autoEnableCandidate: opts?.autoEnableCandidate ?? true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: templateEnabled,
    })}\n\`\`\`\n\n## Scheduled Task\n\nRun work.`,
  } satisfies ScheduleTemplateSource;
}

/** A schedule template with an explicit target block and an optional task prompt. */
function targetScheduleSource(target: Record<string, unknown>, prompt?: string) {
  return {
    config: JSON.stringify({
      name: "test-target-schedule",
      title: "Test target schedule",
      description: "Seeded schedule with a target.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      autoEnableCandidate: true,
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      ...target,
    })}\n\`\`\`\n${prompt === undefined ? "" : `\n## Scheduled Task\n\n${prompt}`}`,
  } satisfies ScheduleTemplateSource;
}

async function makeWorkflow(name: string) {
  return createWorkflow({ name, definition: { nodes: [] } });
}

const ORIGINAL_SEED_AUTOMATIONS_ENABLED = process.env.SEED_AUTOMATIONS_ENABLED;

beforeEach(async () => {
  delete process.env.SEED_AUTOMATIONS_ENABLED;
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
  test("loads all twelve schedule templates, including the unfenced schedule block", () => {
    const schedules = loadSeedSchedules();
    expect(schedules).toHaveLength(12);
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
    expect(
      schedules.find((schedule) => schedule.name === "weekly-harness-upgrade-check"),
    ).toMatchObject({
      enabled: false,
      requiredParams: ["REPO_URL", "PR_REVIEWER"],
      requires: ["github"],
    });
    expect(
      schedules.filter((schedule) => schedule.enabled).map((schedule) => schedule.name),
    ).toEqual([
      "daily-blocker-digest",
      "daily-status-report",
      "daily-swarm-update-check",
      "daily-workflow-health-audit",
      "dreaming-daily",
    ]);
    // dreaming replaces Daily Evolution, which seeds off even though it is zero-config.
    expect(
      schedules.find((schedule) => schedule.name === "daily-compounding-reflection"),
    ).toMatchObject({ enabled: false });
  });

  test("SEED_AUTOMATIONS_ENABLED=false still seeds all schedules disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    // dreaming-daily targets the seeded dreaming workflow.
    await runSeeder(createWorkflowsSeeder(), { quiet: true });
    const result = await runSeeder(createSchedulesSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 12, failed: [] });
    const schedules = await getScheduledTasks();
    expect(schedules).toHaveLength(12);
    expect(schedules.every((schedule) => schedule.enabled === false)).toBe(true);
  });

  test("seeds a disabled schedule whose timezone still needs setup", async () => {
    // dreaming-daily targets the seeded dreaming workflow.
    await runSeeder(createWorkflowsSeeder(), { quiet: true });
    const result = await runSeeder(createSchedulesSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 12, failed: [] });
    expect(await getScheduledTaskByName("weekly-dependabot-triage")).toMatchObject({
      cronExpression: "40 3 * * 0",
      timezone: "{{TIMEZONE}}",
      enabled: false,
      nextRunAt: undefined,
      requiredParams: ["REPO_URL", "SLACK_CHANNEL_ID", "TIMEZONE"],
      requires: ["github", "slack"],
    });
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

  test("switch on: a zero-config candidate without an explicit autoEnableCandidate opt-in stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([
      zeroConfigScheduleSource({ autoEnableCandidate: false }),
    ]);
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

  test("dreaming-daily is a workflow schedule with no task prompt", async () => {
    await runSeeder(createWorkflowsSeeder(), { quiet: true });
    const dreaming = loadSeedSchedules().find((schedule) => schedule.name === "dreaming-daily");
    expect(dreaming).toMatchObject({
      targetType: "workflow",
      workflow: "dreaming",
      taskTemplate: "",
    });
    // Agent-task templates carry no target keys, so their seed hash is unchanged.
    const digest = loadSeedSchedules().find((schedule) => schedule.name === "daily-blocker-digest");
    expect(digest && "targetType" in digest).toBe(false);
  });

  test("seeds a workflow target by name and re-runs as a no-op", async () => {
    const workflow = await makeWorkflow("test-target-workflow");
    const seeder = createSchedulesSeeder([
      targetScheduleSource({ targetType: "workflow", workflow: "test-target-workflow" }),
    ]);
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({ created: 1, failed: [] });
    const row = await getScheduledTaskByName("test-target-schedule");
    expect(row).toMatchObject({ targetType: "workflow", workflowId: workflow.id });
    expect(row?.taskTemplate).toBeUndefined();
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({
      skippedUnchanged: 1,
      updated: 0,
    });
  });

  test("seeds a script target and fails on a missing script", async () => {
    const seeder = createSchedulesSeeder([
      targetScheduleSource({ targetType: "script", scriptName: "no-such-script", scriptArgs: {} }),
    ]);
    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(0);
    expect(result.failed[0]?.error).toContain('Global script "no-such-script" not found');
  });

  test("fails a workflow target whose workflow does not exist, without creating a row", async () => {
    const result = await runSeeder(
      createSchedulesSeeder([
        targetScheduleSource({ targetType: "workflow", workflow: "missing" }),
      ]),
      { quiet: true },
    );
    expect(result.created).toBe(0);
    expect(result.failed[0]?.error).toContain('Workflow "missing" not found');
    expect(await getScheduledTaskByName("test-target-schedule")).toBeNull();
  });

  test("rejects target blocks that ship fields or prompts the target ignores", () => {
    const cases: [Record<string, unknown>, string | undefined, string][] = [
      [{ targetType: "workflow", workflow: "w" }, "Do it.", "ships a ## Scheduled Task prompt"],
      [{ targetType: "script", scriptName: "s" }, "Do it.", "ships a ## Scheduled Task prompt"],
      [{ targetType: "workflow" }, undefined, "has no workflow name"],
      [{ targetType: "script" }, undefined, "has no scriptName"],
      [{ targetType: "workflow", workflow: "w", scriptName: "s" }, undefined, "sets scriptName"],
      [{ workflow: "w" }, "Do it.", "(targetType agent-task) sets workflow"],
      [{ targetType: "lambda" }, undefined, 'unknown targetType "lambda"'],
    ];
    for (const [target, prompt, message] of cases) {
      expect(() => loadSeedSchedules([targetScheduleSource(target, prompt)])).toThrow(message);
    }
  });

  test("migrates a pristine agent-task schedule to a workflow target and clears its prompt", async () => {
    const workflow = await makeWorkflow("test-target-workflow");
    await runSeeder(createSchedulesSeeder([targetScheduleSource({}, "Trigger the workflow.")]), {
      quiet: true,
    });
    expect(await getScheduledTaskByName("test-target-schedule")).toMatchObject({
      targetType: "agent-task",
      taskTemplate: "Trigger the workflow.",
    });

    const result = await runSeeder(
      createSchedulesSeeder([
        targetScheduleSource({ targetType: "workflow", workflow: "test-target-workflow" }),
      ]),
      { quiet: true },
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    const row = await getScheduledTaskByName("test-target-schedule");
    expect(row).toMatchObject({ targetType: "workflow", workflowId: workflow.id });
    expect(row?.taskTemplate).toBeUndefined();
  });

  test("preserves an operator-edited agent-task schedule when its template moves to a workflow", async () => {
    await makeWorkflow("test-target-workflow");
    await runSeeder(createSchedulesSeeder([targetScheduleSource({}, "Trigger the workflow.")]), {
      quiet: true,
    });
    const seeded = await getScheduledTaskByName("test-target-schedule");
    await updateScheduledTask(seeded!.id, { taskTemplate: "My own prompt." });

    const result = await runSeeder(
      createSchedulesSeeder([
        targetScheduleSource({ targetType: "workflow", workflow: "test-target-workflow" }),
      ]),
      { quiet: true },
    );
    expect(result.skippedUserModified).toBe(1);
    expect(await getScheduledTaskByName("test-target-schedule")).toMatchObject({
      targetType: "agent-task",
      taskTemplate: "My own prompt.",
    });
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
