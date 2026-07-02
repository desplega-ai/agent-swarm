import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSkill,
  initDb,
  installSkill,
  toggleAgentSkill,
  uninstallSkill,
  updateSkill,
} from "../be/db";
import { computeAgentSkillsSignature } from "../be/skill-sync";

const TEST_DB_PATH = `./test-skills-signature-${process.pid}.sqlite`;

describe("computeAgentSkillsSignature", () => {
  let agentId: string;
  let otherAgentId: string;
  let skill1Id: string;
  let skill2Id: string;

  beforeAll(() => {
    initDb(TEST_DB_PATH);

    const agent = createAgent({
      name: "Signature Test Worker",
      description: "Test agent",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;

    const otherAgent = createAgent({
      name: "Signature Test Other",
      description: "Independent agent",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    otherAgentId = otherAgent.id;

    const skill1 = createSkill({
      name: "sig-skill-1",
      description: "First skill",
      content: "---\nname: sig-skill-1\ndescription: First skill\n---\nBody 1.",
      type: "personal",
      scope: "agent",
    });
    skill1Id = skill1.id;

    const skill2 = createSkill({
      name: "sig-skill-2",
      description: "Second skill",
      content: "---\nname: sig-skill-2\ndescription: Second skill\n---\nBody 2.",
      type: "personal",
      scope: "agent",
    });
    skill2Id = skill2.id;

    installSkill(agentId, skill1Id);
  });

  afterAll(async () => {
    closeDb();
    await unlink(TEST_DB_PATH).catch(() => {});
    await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
    await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  });

  test("returns identical hash across no-op calls (deterministic)", () => {
    const sig1 = computeAgentSkillsSignature(agentId);
    const sig2 = computeAgentSkillsSignature(agentId);
    expect(sig1.hash).toBe(sig2.hash);
    expect(sig1.count).toBe(sig2.count);
    expect(sig1.hash).toHaveLength(64); // sha256 hex
  });

  test("hash changes when a new skill is installed", () => {
    const before = computeAgentSkillsSignature(agentId);
    installSkill(agentId, skill2Id);
    const after = computeAgentSkillsSignature(agentId);
    expect(after.hash).not.toBe(before.hash);
    expect(after.count).toBe(before.count + 1);
  });

  test("hash changes when a skill is uninstalled", () => {
    const before = computeAgentSkillsSignature(agentId);
    uninstallSkill(agentId, skill2Id);
    const after = computeAgentSkillsSignature(agentId);
    expect(after.hash).not.toBe(before.hash);
    expect(after.count).toBe(before.count - 1);
  });

  test("hash changes when a skill is toggled inactive", () => {
    installSkill(agentId, skill2Id);
    const before = computeAgentSkillsSignature(agentId);
    toggleAgentSkill(agentId, skill2Id, false);
    const after = computeAgentSkillsSignature(agentId);
    expect(after.hash).not.toBe(before.hash);
    // Toggling inactive removes it from the active+enabled view used by getAgentSkills
    expect(after.count).toBe(before.count - 1);

    // Re-activate so subsequent tests have a known state
    toggleAgentSkill(agentId, skill2Id, true);
  });

  test("hash changes when updateSkill mutates a skill (via lastUpdatedAt bump)", async () => {
    const before = computeAgentSkillsSignature(agentId);
    // updateSkill always bumps lastUpdatedAt — even an isEnabled no-op flip back is enough.
    // Wait 5ms to guarantee a different ISO timestamp.
    await new Promise((r) => setTimeout(r, 5));
    updateSkill(skill1Id, { description: "First skill (updated)" });
    const after = computeAgentSkillsSignature(agentId);
    expect(after.hash).not.toBe(before.hash);
    expect(after.count).toBe(before.count);
  });

  test("agent A's signature is independent of mutations to agent B's skills", () => {
    installSkill(otherAgentId, skill1Id);
    const aBefore = computeAgentSkillsSignature(agentId);
    const bBefore = computeAgentSkillsSignature(otherAgentId);

    // Mutate agent B: install another skill, toggle, uninstall
    installSkill(otherAgentId, skill2Id);
    toggleAgentSkill(otherAgentId, skill1Id, false);
    uninstallSkill(otherAgentId, skill2Id);

    const aAfter = computeAgentSkillsSignature(agentId);
    const bAfter = computeAgentSkillsSignature(otherAgentId);

    expect(aAfter.hash).toBe(aBefore.hash);
    expect(aAfter.count).toBe(aBefore.count);
    expect(bAfter.hash).not.toBe(bBefore.hash);
  });
});
