import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, computeContentHash, initDb, listWorkflows, updateWorkflow } from "../be/db";
import { getSeedState, runSeeder } from "../be/seed";
import { recordSeedState } from "../be/seed/state-db";
import {
  canonicalJson,
  createWorkflowsSeeder,
  loadSeedWorkflows,
  seededWorkflowState,
  type WorkflowTemplateSource,
} from "../be/seed/workflows-seeder";
import { snapshotAndUpdateWorkflow } from "../workflows/version";

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

function workflowSource(
  template = "Do the work.",
  description = "Seeded workflow.",
  input: Record<string, string> = { channel: "" },
) {
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
      input,
    })}\n\`\`\``,
  } satisfies WorkflowTemplateSource;
}

/**
 * Overwrite the recorded seed state with the hash older releases stored: the
 * whole template workflow, operator settings included.
 */
async function recordLegacySeedState(source: WorkflowTemplateSource): Promise<void> {
  const [workflow] = loadSeedWorkflows([source]);
  await recordSeedState("workflow", workflow!.name, computeContentHash(canonicalJson(workflow)));
}

/** A real node edit on top of operator settings. */
const NODE_EDIT = {
  nodes: [{ id: "ui-edit", type: "agent-task", config: { template: "Edited." } }],
  onNodeFailure: "fail",
} as const;

/** Operator settings, made the way the update-workflow tool makes them. */
async function tuneSettings(id: string): Promise<void> {
  await snapshotAndUpdateWorkflow(id, {
    input: { channel: "C123" },
    enabled: true,
    description: "Tuned by the operator.",
    cooldown: { hours: 22, from: "start" },
  });
}

const TUNED = {
  input: { channel: "C123" },
  enabled: true,
  description: "Tuned by the operator.",
  cooldown: { hours: 22, from: "start" },
};

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
  test("loads all eleven workflow templates with their setup metadata", () => {
    const workflows = loadSeedWorkflows();
    expect(workflows).toHaveLength(11);
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
    // dreaming is the one zero-config auto-enable candidate.
    expect(workflows.find((workflow) => workflow.name === "dreaming")).toMatchObject({
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(workflows.filter((workflow) => workflow.enabled).map((w) => w.name)).toEqual([
      "dreaming",
    ]);
  });

  test("SEED_AUTOMATIONS_ENABLED=false still seeds all workflows disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const result = await runSeeder(createWorkflowsSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 11, failed: [] });
    const workflows = await listWorkflows();
    expect(workflows).toHaveLength(11);
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

  test("an input-only edit still gets the template update and keeps the live input", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await snapshotAndUpdateWorkflow(seeded!.id, { input: { channel: "C123" } });

    const update = createWorkflowsSeeder([workflowSource("Source update.")]);
    const result = await runSeeder(update, { quiet: true });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0, failed: [] });
    const live = await getWorkflow();
    expect(live?.definition.nodes[0]?.config.template).toBe("Source update.");
    expect(live?.input).toEqual({ channel: "C123" });
    expect((await getSeedState("workflow", live!.name))?.seededHash).toBe(
      update.items()[0]!.contentHash,
    );
    expect(await seededWorkflowState(live!)).toBe("pristine");
  });

  test("a template update keeps every operator setting", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    await tuneSettings((await getWorkflow())!.id);

    const result = await runSeeder(
      createWorkflowsSeeder([workflowSource("Source update.", "New template description.")]),
      { quiet: true },
    );
    expect(result).toMatchObject({ updated: 1, failed: [] });
    const live = await getWorkflow();
    expect(live).toMatchObject(TUNED);
    expect(live?.definition.nodes[0]?.config.template).toBe("Source update.");
    expect(await seededWorkflowState(live!)).toBe("pristine");
  });

  test("a template update adds new input keys without touching live values", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    await snapshotAndUpdateWorkflow((await getWorkflow())!.id, { input: { channel: "C123" } });

    await runSeeder(
      createWorkflowsSeeder([
        workflowSource("Source update.", undefined, { channel: "", newKey: "default" }),
      ]),
      { quiet: true },
    );
    expect((await getWorkflow())?.input).toEqual({ channel: "C123", newKey: "default" });
  });

  test("preserves a node edit made together with operator settings", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await tuneSettings(seeded!.id);
    await snapshotAndUpdateWorkflow(seeded!.id, { definition: NODE_EDIT });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 0, skippedUserModified: 1, failed: [] });
    const live = await getWorkflow();
    expect(live?.definition.nodes[0]?.id).toBe("ui-edit");
    expect(await seededWorkflowState(live!)).toBe("edited");
  });

  describe("legacy whole-workflow seed state", () => {
    test("an input-only edit with a seeded snapshot gets the update and the state migrates", async () => {
      await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
      await recordLegacySeedState(workflowSource());
      await tuneSettings((await getWorkflow())!.id);
      // Before the update the workflow still reads pristine (the scheduler's view).
      expect(await seededWorkflowState((await getWorkflow())!)).toBe("pristine");

      const update = createWorkflowsSeeder([workflowSource("Source update.")]);
      const result = await runSeeder(update, { quiet: true });
      expect(result).toMatchObject({ updated: 1, skippedUserModified: 0, failed: [] });
      const live = await getWorkflow();
      expect(live).toMatchObject(TUNED);
      expect(live?.definition.nodes[0]?.config.template).toBe("Source update.");
      expect((await getSeedState("workflow", live!.name))?.seededHash).toBe(
        update.items()[0]!.contentHash,
      );
      expect(await seededWorkflowState(live!)).toBe("pristine");
    });

    test("an untouched workflow gets the update", async () => {
      await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
      await recordLegacySeedState(workflowSource());

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect((await getWorkflow())?.definition.nodes[0]?.config.template).toBe("Source update.");
    });

    test("a node edit is preserved", async () => {
      await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
      await recordLegacySeedState(workflowSource());
      const seeded = await getWorkflow();
      await snapshotAndUpdateWorkflow(seeded!.id, {
        input: { channel: "C123" },
        definition: NODE_EDIT,
      });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ updated: 0, skippedUserModified: 1, failed: [] });
      expect((await getWorkflow())?.definition.nodes[0]?.id).toBe("ui-edit");
    });

    test("a settings edit with no seeded snapshot is preserved", async () => {
      await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
      await recordLegacySeedState(workflowSource());
      await updateWorkflow((await getWorkflow())!.id, { input: { channel: "C123" } });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ updated: 0, skippedUserModified: 1, failed: [] });
      expect(await seededWorkflowState((await getWorkflow())!)).toBe("edited");
    });

    test("a workflow already matching the template re-baselines to the new hash", async () => {
      const seeder = createWorkflowsSeeder([workflowSource()]);
      await runSeeder(seeder, { quiet: true });
      await recordLegacySeedState(workflowSource());

      const result = await runSeeder(seeder, { quiet: true });
      expect(result).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
      expect((await getSeedState("workflow", "test-seeded-workflow"))?.seededHash).toBe(
        seeder.items()[0]!.contentHash,
      );
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
    expect(await seededWorkflowState((await getWorkflow())!)).toBe("edited");
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
