import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createSkill,
  createWorkflow,
  getAgentById,
  getAgentSkills,
  getDbClient,
  getSkillFiles,
  getTaskByWorkflowRunStepId,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  getWorkflowVersions,
  initDb,
  updateAgentProfile,
  updateWorkflow,
} from "../be/db";
import { type ImportReport, importSource, runImports } from "../be/import";
import { type ImportPackageError, loadDirPackage } from "../be/import/dir-source";
import type { ImportSource } from "../be/import/schema";
import { getOwnedId } from "../be/import/seeders";
import { getScript } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { recordSeedState } from "../be/seed/state-db";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry, type ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";
import { snapshotAndUpdateWorkflow } from "../workflows/version";
import {
  removePackages,
  SCRIPT,
  SKILL_MD,
  WORKFLOW_YAML,
  writePackage,
} from "./fixtures/import-package";

const TEST_DB_PATH = "./test-import.sqlite";

let registry: ExecutorRegistry;
let teardownResumeListener: (() => void) | undefined;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(null);
  const deps: ExecutorDependencies = {
    db: db as typeof import("../be/db"),
    eventBus: workflowEventBus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  registry = createExecutorRegistry(deps);
  teardownResumeListener = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterAll(async () => {
  teardownResumeListener?.();
  closeDb();
  await removePackages();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

const src = (
  id: string,
  path: string,
  onConflict: "noop" | "overwrite" = "noop",
): ImportSource => ({
  id,
  type: "dir",
  path,
  onConflict,
});

/** created/updated/unchanged/preserved per kind, plus failures. */
function counts(report: ImportReport) {
  expect(report.error).toBeUndefined();
  return Object.fromEntries(
    report.results.map((r) => [
      r.kind.split(":").pop(),
      [r.created, r.updated, r.skippedUnchanged, r.skippedUserModified, r.failed.length],
    ]),
  );
}

async function versionCount(workflowId: string) {
  return (await getWorkflowVersions(workflowId)).length;
}

async function workflowByName(name: string) {
  const row = await getDbClient().get<{ id: string }>("SELECT id FROM workflows WHERE name = ?", [
    name,
  ]);
  return row ? getWorkflow(row.id) : null;
}

describe("boot", () => {
  test("no config imports nothing", async () => {
    expect(await runImports({})).toEqual([]);
  });

  test("invalid config logs and imports nothing", async () => {
    expect(await runImports({ SWARM_IMPORT_SOURCES: "not json" })).toEqual([]);
  });
});

describe("a full package", () => {
  const manifest = `workflows:
  - id: review
    file: workflows/review.yaml
skills:
  - id: guide
    dir: skills/guide
scripts:
  - name: full-report
    file: scripts/report.ts
    description: Build the report
agents:
  - name: full-reviewer
    instructions: agents/reviewer.md
    skills: [guide]
`;
  let dir: string;
  let agentId: string;

  beforeAll(async () => {
    agentId = (await createAgent({ name: "full-reviewer", isLead: false, status: "idle" })).id;
    dir = await writePackage({
      "swarm-import.yaml": manifest,
      "workflows/review.yaml": WORKFLOW_YAML("full-review"),
      "skills/guide/SKILL.md": SKILL_MD("full-guide"),
      "skills/guide/files/checklist.md": "- [ ] tests\n",
      "scripts/report.ts": SCRIPT,
      "agents/reviewer.md": "# Reviewer\nReview every PR.\n",
    });
  });

  test("imports a workflow, skill, script, agent instructions and the skill install", async () => {
    const report = await importSource(src("full", dir));
    expect(counts(report)).toEqual({
      script: [1, 0, 0, 0, 0],
      skill: [1, 0, 0, 0, 0],
      workflow: [1, 0, 0, 0, 0],
      agent: [1, 0, 0, 0, 0],
    });
    expect(report.installed).toBe(1);
    expect(report.conflicts).toEqual([]);

    const workflow = await workflowByName("full-review");
    expect(workflow?.enabled).toBe(false);
    expect(await getOwnedId("full", "workflow", "review")).toBe(workflow?.id ?? "missing");

    const skill = (await getAgentSkills(agentId)).find((s) => s.name === "full-guide");
    expect(skill?.scope).toBe("global");
    expect((await getSkillFiles(skill?.id ?? "")).map((f) => f.path)).toEqual(["checklist.md"]);

    expect((await getScript({ name: "full-report", scope: "global" }))?.description).toBe(
      "Build the report",
    );
    expect((await getAgentById(agentId))?.identityMd).toBe("# Reviewer\nReview every PR.\n");
  });

  test("repeating an unchanged import writes nothing and adds no history", async () => {
    const workflow = await workflowByName("full-review");
    const report = await importSource(src("full", dir));
    expect(counts(report)).toEqual({
      script: [0, 0, 1, 0, 0],
      skill: [0, 0, 1, 0, 0],
      workflow: [0, 0, 1, 0, 0],
      agent: [0, 0, 1, 0, 0],
    });
    expect(report.installed).toBe(0);
    expect(await versionCount(workflow?.id ?? "")).toBe(0);
    const names = (
      await getDbClient().query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflows WHERE name = 'full-review'",
      )
    )[0]?.n;
    expect(names).toBe(1);
  });

  test("an update writes the same row, keeps enabled, and adds one version", async () => {
    const workflow = await workflowByName("full-review");
    await updateWorkflow(workflow?.id ?? "", { enabled: true });
    await writePackage({ "workflows/review.yaml": WORKFLOW_YAML("full-review", "Review v2") }, dir);

    const report = await importSource(src("full", dir));
    expect(counts(report).workflow).toEqual([0, 1, 0, 0, 0]);
    const updated = await getWorkflow(workflow?.id ?? "");
    expect(updated?.enabled).toBe(true);
    expect(JSON.stringify(updated?.definition)).toContain("Review v2");
    expect(await versionCount(workflow?.id ?? "")).toBe(1);
  });

  test("noop keeps a UI/API edit; overwrite makes the file win and keeps enabled", async () => {
    const workflow = await workflowByName("full-review");
    const id = workflow?.id ?? "";
    await snapshotAndUpdateWorkflow(id, { description: "Edited in the UI" });
    await writePackage({ "workflows/review.yaml": WORKFLOW_YAML("full-review", "Review v3") }, dir);

    expect(counts(await importSource(src("full", dir))).workflow).toEqual([0, 0, 0, 1, 0]);
    expect((await getWorkflow(id))?.description).toBe("Edited in the UI");

    const versionsBefore = await versionCount(id);
    expect(counts(await importSource(src("full", dir, "overwrite"))).workflow).toEqual([
      0, 1, 0, 0, 0,
    ]);
    const live = await getWorkflow(id);
    expect(live?.description).toBe("Review flow");
    expect(JSON.stringify(live?.definition)).toContain("Review v3");
    expect(live?.enabled).toBe(true);
    expect(await versionCount(id)).toBe(versionsBefore + 1);
  });

  test("an agent's own edit to its instructions is kept under noop", async () => {
    await updateAgentProfile(agentId, { identityMd: "# Reviewer\nMy own notes.\n" });
    await writePackage({ "agents/reviewer.md": "# Reviewer v2\n" }, dir);
    expect(counts(await importSource(src("full", dir))).agent).toEqual([0, 0, 0, 1, 0]);
    expect((await getAgentById(agentId))?.identityMd).toBe("# Reviewer\nMy own notes.\n");
  });
});

describe("ownership", () => {
  test("a same-named resource the source does not own is a conflict under noop", async () => {
    const existing = await createWorkflow({
      name: "owned-elsewhere",
      definition: { nodes: [{ id: "a", type: "agent-task", config: { template: "Mine" } }] },
    });
    await createSkill({ name: "owned-skill", description: "d", content: SKILL_MD("owned-skill") });
    const agent = await createAgent({ name: "owned-agent", isLead: false, status: "idle" });
    await updateAgentProfile(agent.id, { identityMd: "# Hand written\n" });

    const dir = await writePackage({
      "swarm-import.yaml": `workflows:
  - id: flow
    file: flow.yaml
skills:
  - id: skill
    dir: skill
agents:
  - name: owned-agent
    instructions: agent.md
`,
      "flow.yaml": WORKFLOW_YAML("owned-elsewhere", "Theirs"),
      "skill/SKILL.md": SKILL_MD("owned-skill", "Theirs"),
      "agent.md": "# Theirs\n",
    });

    const report = await importSource(src("conflicts", dir));
    expect(report.conflicts).toHaveLength(3);
    expect(counts(report).workflow).toEqual([0, 0, 0, 0, 0]);
    expect(JSON.stringify((await getWorkflow(existing.id))?.definition)).toContain("Mine");
    expect((await getAgentById(agent.id))?.identityMd).toBe("# Hand written\n");

    // Overwrite adopts it; a second source can never take it over.
    const adopted = await importSource(src("conflicts", dir, "overwrite"));
    expect(adopted.conflicts).toEqual([]);
    expect(JSON.stringify((await getWorkflow(existing.id))?.definition)).toContain("Theirs");
    expect((await getAgentById(agent.id))?.identityMd).toBe("# Theirs\n");
    const rival = await importSource(src("rival", dir, "overwrite"));
    expect(rival.conflicts).toHaveLength(3);
  });

  test("a built-in seeded resource is a conflict even under overwrite", async () => {
    const builtIn = await createWorkflow({
      name: "seeded-builtin",
      definition: { nodes: [{ id: "a", type: "agent-task", config: { template: "Built in" } }] },
    });
    await recordSeedState("workflow", "seeded-builtin", "hash");
    const dir = await writePackage({ "workflows/b.yaml": WORKFLOW_YAML("seeded-builtin", "Mine") });
    const report = await importSource(src("builtin", dir, "overwrite"));
    expect(report.conflicts).toHaveLength(1);
    expect(JSON.stringify((await getWorkflow(builtIn.id))?.definition)).toContain("Built in");
  });

  test("an invalid package writes nothing", async () => {
    const dir = await writePackage({
      "workflows/ok.yaml": WORKFLOW_YAML("invalid-pkg-ok"),
      "workflows/bad.yaml": "name: invalid-pkg-bad\ndefinition: 3\n",
    });
    const report = await importSource(src("invalid", dir));
    expect(report.error?.length).toBeGreaterThan(0);
    expect(report.results).toEqual([]);
    expect(await workflowByName("invalid-pkg-ok")).toBeNull();
  });

  test("a declared path that resolves outside the package is rejected", async () => {
    const outside = join(await mkdtemp(join(tmpdir(), "import-outside-")), "secret.md");
    await writeFile(outside, "host secret");
    const viaSymlink = await writePackage({
      "swarm-import.yaml": "agents:\n  - name: linked\n    instructions: linked.md\n",
    });
    await symlink(outside, join(viaSymlink, "linked.md"));
    // `..` segments are already refused by the manifest schema.
    const report = await importSource(src("via-symlink", viaSymlink));
    expect(report.error?.join("\n")).toContain("resolves outside the package");
    expect(report.results).toEqual([]);
  });

  test("a scanned symlink never reads a file outside the package", async () => {
    const outside = join(await mkdtemp(join(tmpdir(), "import-outside-")), "secret.md");
    await writeFile(outside, "host secret");
    const dir = await writePackage({
      "skills/leak/SKILL.md": SKILL_MD("escape-leak"),
      "skills/leak/files/ok.md": "inside",
      "agents/.keep": "",
    });
    await symlink(outside, join(dir, "skills/leak/files/secret.md"));
    await symlink(outside, join(dir, "agents/escaper.md"));
    const pkg = await loadDirPackage(src("scanned", dir)).catch(
      (error: ImportPackageError) => error,
    );
    expect(JSON.stringify(pkg)).not.toContain("host secret");
  });
});

describe("pending assignments", () => {
  test("resolve when the agent registers", async () => {
    const dir = await writePackage({
      "swarm-import.yaml": `skills:
  - id: guide
    dir: guide
agents:
  - name: late-agent
    instructions: late.md
    skills: [guide]
`,
      "guide/SKILL.md": SKILL_MD("late-guide"),
      "late.md": "# Late agent\n",
    });

    const report = await importSource(src("late", dir));
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]).toContain("agent name:late-agent: not registered");
    const pending = await getDbClient().query<{ agentKey: string }>(
      "SELECT agentKey FROM import_pending_assignments WHERE sourceId = 'late'",
    );
    expect(pending.map((row) => row.agentKey)).toEqual(["name:late-agent"]);

    const agent = await createAgent({ name: "late-agent", isLead: false, status: "idle" });
    expect(agent.identityMd).toBe("# Late agent\n");
    expect((await getAgentSkills(agent.id)).map((s) => s.name)).toContain("late-guide");
    expect(
      await getDbClient().query("SELECT 1 FROM import_pending_assignments WHERE sourceId = 'late'"),
    ).toEqual([]);

    // The next boot sees the assignment as already in sync.
    const again = await importSource(src("late", dir));
    expect(counts(again).agent).toEqual([0, 0, 1, 0, 0]);
    expect(again.unresolved).toEqual([]);
  });
});

describe("active runs", () => {
  const flow = (next: string) => `name: pinned-flow
definition:
  nodes:
    - id: n1
      type: agent-task
      config:
        template: Work
      next: n2
    - id: n2
      type: agent-task
      config:
        template: ${next}
`;

  async function taskFor(runId: string, nodeId: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === nodeId);
      const task = step ? await getTaskByWorkflowRunStepId(step.id) : null;
      if (task) return task;
      await Bun.sleep(10);
    }
    throw new Error(`no ${nodeId} task for run ${runId}`);
  }

  test("an import update reaches new runs only", async () => {
    const dir = await writePackage({ "workflows/pinned.yaml": flow("Next A") });
    expect(counts(await importSource(src("runs", dir))).workflow).toEqual([1, 0, 0, 0, 0]);
    const workflow = await workflowByName("pinned-flow");
    if (!workflow) throw new Error("workflow not imported");

    const oldRun = await startWorkflowExecution(workflow, {}, registry);
    const firstTask = await taskFor(oldRun, "n1");

    await writePackage({ "workflows/pinned.yaml": flow("Next B") }, join(dir));
    expect(counts(await importSource(src("runs", dir))).workflow).toEqual([0, 1, 0, 0, 0]);

    await completeTask(firstTask.id, "done");
    expect((await taskFor(oldRun, "n2")).task).toContain("Next A");
    expect((await getWorkflowRun(oldRun))?.workflowId).toBe(workflow.id);

    const updated = await getWorkflow(workflow.id);
    if (!updated) throw new Error("workflow missing");
    const newRun = await startWorkflowExecution(updated, {}, registry);
    await completeTask((await taskFor(newRun, "n1")).id, "done");
    expect((await taskFor(newRun, "n2")).task).toContain("Next B");
  });
});
