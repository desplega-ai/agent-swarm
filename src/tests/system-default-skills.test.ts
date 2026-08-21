import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSkill,
  getAgentSkills,
  getDbClient,
  getSystemDefaultSkills,
  initDb,
  toggleAgentSkill,
} from "../be/db";
import { runSeeder } from "../be/seed";
import { loadSeedSkills, skillsSeeder } from "../be/seed-skills";

const TEST_DB_PATH = `./test-system-default-skills-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

describe("system-default skills", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("seed catalog includes swarm-scripts and marks built-in defaults", async () => {
    const skills = await loadSeedSkills();
    const names = skills.map((skill) => skill.name);

    expect(names).toContain("asset-namespaces");
    expect(names).toContain("attio-interaction");
    expect(names).toContain("script-workflows");
    expect(names).toContain("swarm-scripts");
    expect(names).toContain("taste-minimalist-skill");
    expect(names).not.toContain("taste-skill");
    expect(names).not.toContain("taste-brutalist-skill");
    expect(names).not.toContain("taste-soft-skill");
    expect(names).not.toContain("taste-redesign-skill");
    expect(names).not.toContain("taste-output-skill");
    expect(skills.find((skill) => skill.name === "attio-interaction")?.systemDefault).toBe(true);
    const assetNamespacesSkill = skills.find((skill) => skill.name === "asset-namespaces");
    expect(assetNamespacesSkill?.systemDefault).toBe(true);
    expect(assetNamespacesSkill?.content).toContain("**not** a privacy");
    expect(assetNamespacesSkill?.content).toContain("window.swarmSdk.assets");
    expect(skills.find((skill) => skill.name === "script-workflows")?.systemDefault).toBe(true);
    expect(skills.find((skill) => skill.name === "swarm-scripts")?.systemDefault).toBe(true);
    expect(skills.find((skill) => skill.name === "kv-storage")?.systemDefault).toBe(true);
    const pagesSkill = skills.find((skill) => skill.name === "pages");
    expect(pagesSkill?.systemDefault).toBe(true);
    // The merged `pages` skill must keep advertising the taste baseline in its
    // description (that's what makes the model reach for it) and must still
    // carry the actual design guidance in the body. Assert on both halves
    // rather than one exact marketing phrase.
    expect(pagesSkill?.description).toMatch(/taste/i);
    expect(pagesSkill?.content).toContain("taste-minimalist-skill");
    expect(pagesSkill?.content).toContain("Report density layer");
    // ...and the mechanics half that used to live only in the baked copy.
    expect(pagesSkill?.content).toContain("create_page");
    expect(pagesSkill?.content).toContain("swarm-diff");
    expect(skills.find((skill) => skill.name === "taste-minimalist-skill")?.systemDefault).toBe(
      false,
    );

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);

    const defaults = (await getSystemDefaultSkills()).map((skill) => skill.name);
    expect(defaults).toContain("asset-namespaces");
    expect(defaults).toContain("attio-interaction");
    expect(defaults).toContain("script-workflows");
    expect(defaults).toContain("swarm-scripts");
    expect(defaults).toContain("kv-storage");
    expect(defaults).toContain("pages");
    expect(defaults).not.toContain("taste-minimalist-skill");
    expect(defaults).not.toContain("taste-skill");
  });

  test("existing agents see system-default skills through the self-healing view", async () => {
    const existingAgent = await createAgent({
      name: "Existing Default Skill Worker",
      description: "Created after seeded defaults",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });

    const manualDefault = await createSkill({
      name: "manual-system-default",
      description: "Manual default",
      content: "---\nname: manual-system-default\ndescription: Manual default\n---\nBody.",
      type: "personal",
      scope: "swarm",
      systemDefault: true,
    });

    const skills = await getAgentSkills(existingAgent.id);
    expect(skills.map((skill) => skill.name)).toContain("manual-system-default");
    expect(skills.find((skill) => skill.id === manualDefault.id)?.isActive).toBe(true);
  });

  test("existing agents see swarm-scope skills without explicit install rows", async () => {
    const existingAgent = await createAgent({
      name: "Existing Swarm Skill Worker",
      description: "Created before a swarm-scope skill",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });

    const swarmSkill = await createSkill({
      name: "manual-swarm-scope-skill",
      description: "Manual swarm scope skill",
      content:
        "---\nname: manual-swarm-scope-skill\ndescription: Manual swarm scope skill\n---\nBody.",
      type: "personal",
      scope: "swarm",
      systemDefault: false,
    });

    const installRow = await getDbClient().get<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM agent_skills
         WHERE agentId = ?
           AND skillId = ?`,
      [existingAgent.id, swarmSkill.id],
    );

    expect(installRow?.count ?? 0).toBe(0);

    const skills = await getAgentSkills(existingAgent.id);
    expect(skills.map((skill) => skill.name)).toContain("manual-swarm-scope-skill");
    expect(skills.find((skill) => skill.id === swarmSkill.id)?.isActive).toBe(true);
  });

  test("new agents get concrete agent_skills rows for system defaults", async () => {
    const beforeAgent = await createAgent({
      name: "Concrete Install Worker",
      description: "Created with defaults present",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });

    const row = await getDbClient().get<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM agent_skills
         WHERE agentId = ?
           AND skillId IN (SELECT id FROM skills WHERE systemDefault = 1)`,
      [beforeAgent.id],
    );

    expect(row?.count ?? 0).toBeGreaterThan(0);
  });

  test("system-default skills remain visible even if an install row is toggled inactive", async () => {
    const agent = await createAgent({
      name: "Inactive Default Worker",
      description: "Tests self-healing union",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    const skill = (await getSystemDefaultSkills()).find((entry) => entry.name === "swarm-scripts");
    expect(skill).toBeDefined();

    await toggleAgentSkill(agent.id, skill!.id, false);
    const skills = await getAgentSkills(agent.id);

    expect(skills.find((entry) => entry.id === skill!.id)?.isActive).toBe(true);
  });
});
