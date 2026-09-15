import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb, listWorkflows, updateWorkflow } from "../be/db";
import { getSeedState, runSeeder } from "../be/seed";
import {
  createWorkflowsSeeder,
  loadSeedWorkflows,
  type WorkflowTemplateSource,
} from "../be/seed/workflows-seeder";

const TEST_DB_PATH = "./test-seed-workflows.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function workflowSource(template = "Do the work.", description = "Seeded workflow.") {
  return {
    config: JSON.stringify({
      name: "test-seeded-workflow",
      description,
      placeholders: ["REPO_URL"],
      requires: ["github"],
      runAllSeedersCandidate: true,
    }),
    content: `# Test\n\n\`\`\`json\n${JSON.stringify({
      nodes: [{ id: "work", type: "agent-task", config: { template } }],
    })}\n\`\`\``,
  } satisfies WorkflowTemplateSource;
}

/** A zero-config candidate: no requires, no placeholders — eligible for auto-enable. */
function zeroConfigWorkflowSource(opts?: {
  name?: string;
  templateEnabled?: boolean;
  autoEnableCandidate?: boolean;
}) {
  const name = opts?.name ?? "test-zero-config-workflow";
  const payloadEnabled = opts?.templateEnabled === false ? { enabled: false } : {};
  return {
    config: JSON.stringify({
      name,
      description: "Zero-config seeded workflow.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      autoEnableCandidate: opts?.autoEnableCandidate ?? true,
    }),
    content: `# Test\n\n\`\`\`json\n${JSON.stringify({
      nodes: [{ id: "work", type: "agent-task", config: { template: "Do the work." } }],
      ...payloadEnabled,
    })}\n\`\`\``,
  } satisfies WorkflowTemplateSource;
}

async function getWorkflow(name = "test-seeded-workflow") {
  return (await listWorkflows()).find((workflow) => workflow.name === name) ?? null;
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

describe("workflows seeder", () => {
  test("loads all ten workflow templates with their setup metadata", () => {
    const workflows = loadSeedWorkflows();
    expect(workflows).toHaveLength(10);
    expect(workflows.find((workflow) => workflow.name === "autopilot")).toMatchObject({
      enabled: false,
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });
    expect(
      workflows.find((workflow) => workflow.name === "claude-code-changelog-watch"),
    ).toMatchObject({
      enabled: false,
      requiredParams: [],
      requires: [],
    });
    expect(workflows.find((workflow) => workflow.name === "gsc-topic-miner")).toMatchObject({
      enabled: false,
      requiredParams: ["GSC_PROPERTY"],
      requires: ["gsc", "agentfs"],
    });
    expect(workflows.every((workflow) => !workflow.enabled)).toBe(true);
  });

  test("SEED_AUTOMATIONS_ENABLED=false still seeds all workflows disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const result = await runSeeder(createWorkflowsSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 10, failed: [] });
    const workflows = await listWorkflows();
    expect(workflows).toHaveLength(10);
    expect(workflows.every((workflow) => workflow.enabled === false)).toBe(true);
  });

  test("switch on: a zero-config candidate auto-enables via createWorkflowsSeeder/apply", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: true });
  });

  test("switch on: an item with unmet requires stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([workflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow()).toMatchObject({ enabled: false });
  });

  test("switch off: a zero-config candidate stays disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("switch on: a zero-config candidate whose template recommends staying off stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource({ templateEnabled: false })]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("switch on: a zero-config candidate without an explicit autoEnableCandidate opt-in stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([
      zeroConfigWorkflowSource({ autoEnableCandidate: false }),
    ]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("seeds a workflow and re-runs as a no-op", async () => {
    const seeder = createWorkflowsSeeder([workflowSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getWorkflow()).toMatchObject({
      name: "test-seeded-workflow",
      enabled: false,
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
  });

  test("preserves a workflow enabled by the operator", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await updateWorkflow(seeded!.id, { enabled: true });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result.skippedUserModified).toBe(1);
    expect(await getWorkflow()).toMatchObject({
      enabled: true,
      definition: {
        nodes: [{ id: "work", type: "agent-task", config: { template: "Do the work." } }],
        onNodeFailure: "fail",
      },
    });
  });

  test("preserves a workflow edited by the operator", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await updateWorkflow(seeded!.id, {
      definition: {
        nodes: [{ id: "ui-edit", type: "agent-task", config: { template: "Edited." } }],
        onNodeFailure: "fail",
      },
    });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result.skippedUserModified).toBe(1);
    expect((await getWorkflow())?.definition.nodes[0]?.id).toBe("ui-edit");
  });

  test("updates a pristine workflow when its template changes", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getWorkflow())?.definition.nodes[0]?.config.template).toBe("Source update.");
  });

  test("records the template hash after a successful seed", async () => {
    const seeder = createWorkflowsSeeder([workflowSource()]);
    const item = seeder.items()[0]!;
    await runSeeder(seeder, { quiet: true });
    expect((await getSeedState("workflow", item.key))?.seededHash).toBe(item.contentHash);
  });
});
