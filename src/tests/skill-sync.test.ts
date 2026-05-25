import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createAgent, createSkill, initDb, installSkill } from "../be/db";
import { syncSkillsToFilesystem } from "../be/skill-sync";

const SWARM_MARKER = ".swarm-managed";

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

  test("syncs simple skills to codex directory", () => {
    const result = syncSkillsToFilesystem(agentId, "codex", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBeGreaterThanOrEqual(1);

    const skillFile = join(FAKE_HOME, ".codex", "skills", "test-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf-8")).toContain("Test body.");

    // Verify claude and pi paths were NOT written when targeting codex only
    const claudeOnlyFile = join(FAKE_HOME, ".claude", "skills", "codex-only-marker", "SKILL.md");
    const piOnlyFile = join(FAKE_HOME, ".pi", "agent", "skills", "codex-only-marker", "SKILL.md");
    expect(existsSync(claudeOnlyFile)).toBe(false);
    expect(existsSync(piOnlyFile)).toBe(false);
  });

  test("syncs to claude, pi, and codex when harnessType is 'all'", () => {
    // Clean up first to get accurate count
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".codex"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "all", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(3); // 1 skill × 3 dirs

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    const codexFile = join(FAKE_HOME, ".codex", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
    expect(existsSync(codexFile)).toBe(true);
  });

  test("skips complex skills", () => {
    const _result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    const complexDir = join(FAKE_HOME, ".claude", "skills", "complex-skill");
    expect(existsSync(complexDir)).toBe(false);
  });

  test("removes stale swarm-managed skill directories", () => {
    // Mark this stale dir as swarm-managed (mirrors what an earlier sync would have done)
    const staleDir = join(FAKE_HOME, ".claude", "skills", "old-removed-skill");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, SWARM_MARKER), "");
    expect(existsSync(staleDir)).toBe(true);

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(staleDir)).toBe(false);
  });

  test("removes stale swarm-managed codex skill directories", () => {
    const staleCodexDir = join(FAKE_HOME, ".codex", "skills", "old-codex-skill");
    mkdirSync(staleCodexDir, { recursive: true });
    writeFileSync(join(staleCodexDir, SWARM_MARKER), "");
    expect(existsSync(staleCodexDir)).toBe(true);

    const result = syncSkillsToFilesystem(agentId, "codex", FAKE_HOME);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(staleCodexDir)).toBe(false);
  });

  test("leaves foreign (unmarked) skill directories alone — local-dev safety", () => {
    // Simulate a user-installed codex skill in their personal ~/.codex/skills
    // that the swarm did NOT create. The cleanup pass MUST NOT remove it.
    const foreignDir = join(FAKE_HOME, ".codex", "skills", "user-personal-skill");
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(join(foreignDir, "SKILL.md"), "user's own skill — keep me");
    // No SWARM_MARKER file → not ours to manage.
    expect(existsSync(foreignDir)).toBe(true);

    syncSkillsToFilesystem(agentId, "codex", FAKE_HOME);

    expect(existsSync(foreignDir)).toBe(true);
    expect(readFileSync(join(foreignDir, "SKILL.md"), "utf-8")).toBe("user's own skill — keep me");
  });

  test("written skill directories carry the swarm-managed marker", () => {
    // Clean up first
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });

    syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    const marker = join(FAKE_HOME, ".claude", "skills", "test-skill", SWARM_MARKER);
    expect(existsSync(marker)).toBe(true);
  });

  test("defaults to 'all' when no harnessType provided", () => {
    // Clean up first
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".codex"), { recursive: true, force: true });

    // Use 'all' explicitly with homeOverride (default harnessType would use real home)
    const result = syncSkillsToFilesystem(agentId, "all", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(3);

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    const codexFile = join(FAKE_HOME, ".codex", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
    expect(existsSync(codexFile)).toBe(true);
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
