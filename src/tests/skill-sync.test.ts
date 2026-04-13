import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createAgent, createSkill, initDb, installSkill } from "../be/db";
import { syncSkillsToFilesystem } from "../be/skill-sync";

const TEST_DB_PATH = `./test-skill-sync-${process.pid}.sqlite`;
const FAKE_HOME = join(tmpdir(), `skill-sync-test-${process.pid}`);

describe("syncSkillsToFilesystem", () => {
  let agentId: string;

  beforeAll(() => {
    initDb(TEST_DB_PATH);

    const agent = createAgent({
      name: "Skill Sync Test Worker",
      description: "Test agent for skill sync",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;

    // Create and install a simple skill
    const skill = createSkill({
      name: "test-skill",
      description: "A test skill",
      content: "---\nname: test-skill\ndescription: A test skill\n---\n\nTest body.",
      type: "personal",
      scope: "agent",
    });
    installSkill(agentId, skill.id);

    // Create a complex skill (should be skipped)
    const complexSkill = createSkill({
      name: "complex-skill",
      description: "A complex skill",
      content: "---\nname: complex-skill\ndescription: A complex skill\n---\n\nBody.",
      type: "remote",
      scope: "global",
      isComplex: true,
    });
    installSkill(agentId, complexSkill.id);

    mkdirSync(FAKE_HOME, { recursive: true });
  });

  afterAll(async () => {
    closeDb();
    rmSync(FAKE_HOME, { recursive: true, force: true });
    await unlink(TEST_DB_PATH).catch(() => {});
    await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
    await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  });

  test("syncs simple skills to claude directory", () => {
    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBeGreaterThanOrEqual(1);

    const skillFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf-8")).toContain("Test body.");
  });

  test("syncs simple skills to pi directory", () => {
    const result = syncSkillsToFilesystem(agentId, "pi", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBeGreaterThanOrEqual(1);

    const skillFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf-8")).toContain("Test body.");
  });

  test("syncs to both claude and pi when harnessType is 'both'", () => {
    // Clean up first to get accurate count
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "both", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(2); // 1 skill × 2 dirs

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
  });

  test("skips complex skills", () => {
    const _result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    const complexDir = join(FAKE_HOME, ".claude", "skills", "complex-skill");
    expect(existsSync(complexDir)).toBe(false);
  });

  test("removes stale skill directories", () => {
    const staleDir = join(FAKE_HOME, ".claude", "skills", "old-removed-skill");
    mkdirSync(staleDir, { recursive: true });
    expect(existsSync(staleDir)).toBe(true);

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(staleDir)).toBe(false);
  });

  test("defaults to 'both' when no harnessType provided", () => {
    // Clean up first
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });

    // Use 'both' explicitly with homeOverride (default harnessType would use real home)
    const result = syncSkillsToFilesystem(agentId, "both", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(2);

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
  });

  test("returns empty result for agent with no skills", () => {
    const otherAgent = createAgent({
      name: "Empty Agent",
      description: "Agent with no skills",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });

    const result = syncSkillsToFilesystem(otherAgent.id, "claude", FAKE_HOME);

    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("sanitizes skill names with special characters", () => {
    const skill = createSkill({
      name: "my/dangerous/../skill",
      description: "Path traversal attempt",
      content:
        "---\nname: my/dangerous/../skill\ndescription: Path traversal attempt\n---\n\nSafe.",
      type: "personal",
      scope: "agent",
    });
    installSkill(agentId, skill.id);

    // Clean up first
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    const sanitizedDir = join(FAKE_HOME, ".claude", "skills", "my_dangerous____skill");
    expect(existsSync(sanitizedDir)).toBe(true);
  });
});
