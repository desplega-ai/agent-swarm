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

async function getWorkflow(name = "test-seeded-workflow") {
  return (await listWorkflows()).find((workflow) => workflow.name === name) ?? null;
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
  test("loads only the five starter candidates with their setup metadata", () => {
    const workflows = loadSeedWorkflows();
    expect(workflows).toHaveLength(5);
    expect(workflows.find((workflow) => workflow.name === "autopilot")).toMatchObject({
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });
    expect(workflows.some((workflow) => workflow.name === "ralph-loop")).toBe(false);
    expect(workflows.some((workflow) => workflow.name === "claude-code-changelog-watch")).toBe(
      false,
    );
    expect(workflows.some((workflow) => workflow.name === "gsc-topic-miner")).toBe(false);
  });

  test("seeds a workflow and re-runs as a no-op", async () => {
    const seeder = createWorkflowsSeeder([workflowSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getWorkflow()).toMatchObject({
      name: "test-seeded-workflow",
      enabled: true,
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
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
