import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getWorkflowByName, initDb, updateWorkflow } from "../be/db";
import { getSeedState, runSeeder } from "../be/seed";
import type { Addon } from "../be/seed/addons";
import { assertAddonReferences } from "../be/seed/registry";
import { createWorkflowsSeeder } from "../be/seed/workflows-seeder";

const TEST_DB_PATH = "./test-seed-workflows.sqlite";

async function removeDbFiles(path = TEST_DB_PATH): Promise<void> {
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
    description: "Fixture add-on for workflow seeder tests.",
    docsPath: "docs/test-addon.mdx",
    workflows: [
      {
        name: "test-seeded-workflow",
        description: "A workflow seeded by the test fixture.",
        enabled: true,
        definition: {
          nodes: [{ id: "work", type: "agent-task", config: { template: "Do the work." } }],
        },
      },
    ],
    schedules: [],
    skillNames: [],
    scriptNames: [],
    configKeys: [],
  };
}

beforeEach(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
});

describe("workflows seeder", () => {
  test("seeds a workflow and re-runs as a no-op", async () => {
    const seeder = createWorkflowsSeeder([makeAddon()]);

    const first = await runSeeder(seeder, { quiet: true });
    expect(first.created).toBe(1);
    expect(first.failed).toEqual([]);
    expect(getWorkflowByName("test-seeded-workflow")).toMatchObject({
      name: "test-seeded-workflow",
      enabled: true,
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second.skippedUnchanged).toBe(1);
    expect(second.updated).toBe(0);
  });

  test("a UI-edited workflow definition survives a source change", async () => {
    const addon = makeAddon();
    const seeder = createWorkflowsSeeder([addon]);
    await runSeeder(seeder, { quiet: true });

    const seeded = getWorkflowByName("test-seeded-workflow");
    expect(seeded).not.toBeNull();
    updateWorkflow(seeded!.id, {
      definition: {
        nodes: [{ id: "ui-edit", type: "agent-task", config: { template: "Edited in UI." } }],
      },
    });
    addon.workflows[0]!.definition = {
      nodes: [{ id: "source-edit", type: "agent-task", config: { template: "Changed source." } }],
    };

    const result = await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
    expect(result.skippedUserModified).toBe(1);
    expect(getWorkflowByName("test-seeded-workflow")?.definition.nodes[0]?.id).toBe("ui-edit");
  });

  test("a disabled workflow survives a source definition change", async () => {
    const addon = makeAddon();
    await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
    const seeded = getWorkflowByName("test-seeded-workflow");
    expect(seeded).not.toBeNull();
    updateWorkflow(seeded!.id, { enabled: false });
    addon.workflows[0]!.definition = {
      nodes: [{ id: "source-edit", type: "agent-task", config: { template: "Changed source." } }],
    };

    const result = await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
    expect(result.skippedUserModified).toBe(1);
    expect(getWorkflowByName("test-seeded-workflow")?.enabled).toBe(false);
  });

  test("a pristine workflow updates when its source changes", async () => {
    const addon = makeAddon();
    await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
    addon.workflows[0]!.definition = {
      nodes: [{ id: "source-edit", type: "agent-task", config: { template: "Changed source." } }],
    };

    const result = await runSeeder(createWorkflowsSeeder([addon]), { quiet: true });
    expect(result.updated).toBe(1);
    expect(getWorkflowByName("test-seeded-workflow")?.definition.nodes[0]?.id).toBe("source-edit");
  });

  test("records the source hash after a successful seed", async () => {
    const addon = makeAddon();
    const seeder = createWorkflowsSeeder([addon]);
    const item = seeder.items()[0]!;

    await runSeeder(seeder, { quiet: true });
    expect(getSeedState("workflow", item.key)?.seededHash).toBe(item.contentHash);
  });
});

describe("add-on boot assertions", () => {
  test("reject unknown skills, scripts, and workflow schedule targets", () => {
    const unknownSkill = makeAddon();
    unknownSkill.skillNames = ["not-a-built-in-skill"];
    expect(() => assertAddonReferences([unknownSkill])).toThrow("unknown seeded skill");

    const unknownScript = makeAddon();
    unknownScript.scriptNames = ["not-a-seeded-script"];
    expect(() => assertAddonReferences([unknownScript])).toThrow("unknown seeded script");

    const danglingWorkflow = makeAddon();
    danglingWorkflow.schedules = [
      {
        name: "dangling-workflow-schedule",
        description: "Invalid fixture.",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        targetType: "workflow",
        workflowName: "does-not-exist",
      },
    ];
    expect(() => assertAddonReferences([danglingWorkflow])).toThrow("outside the add-on");
  });

  test("reject cross-addon workflow and schedule name collisions", () => {
    const first = makeAddon();
    const second = makeAddon();
    second.name = "other-addon";
    expect(() => assertAddonReferences([first, second])).toThrow(
      'both ship a workflow named "test-seeded-workflow"',
    );

    second.workflows[0]!.name = "unique-workflow";
    const makeSchedule = (workflowName: string) => ({
      name: "shared-schedule",
      description: "Collision fixture.",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      targetType: "workflow" as const,
      workflowName,
    });
    first.schedules = [makeSchedule("test-seeded-workflow")];
    second.schedules = [makeSchedule("unique-workflow")];
    expect(() => assertAddonReferences([first, second])).toThrow(
      'both ship a schedule named "shared-schedule"',
    );
  });
});
