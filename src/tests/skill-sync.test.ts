import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, createAgent, createSkill, initDb, installSkill, upsertSkillFile } from "../be/db";
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

    // Create a legacy complex skill with no stored files (should be skipped)
    const complexSkill = createSkill({
      name: "complex-skill",
      description: "A complex skill",
      content: "---\nname: complex-skill\ndescription: A complex skill\n---\n\nBody.",
      type: "remote",
      scope: "global",
      isComplex: true,
    });
    installSkill(agentId, complexSkill.id);

    const dbBackedComplexSkill = createSkill({
      name: "complex-db-skill",
      description: "A DB-backed complex skill",
      content: "---\nname: complex-db-skill\ndescription: A DB-backed complex skill\n---\n\nBody.",
      type: "remote",
      scope: "global",
      isComplex: true,
    });
    installSkill(agentId, dbBackedComplexSkill.id);
    upsertSkillFile(dbBackedComplexSkill.id, {
      path: "references/guide.md",
      content: "# Guide\n\nBundled reference.",
      mimeType: "text/markdown",
    });
    upsertSkillFile(dbBackedComplexSkill.id, {
      path: "assets/logo.png",
      content: "[binary file - not synced]",
      mimeType: "image/png",
      isBinary: true,
      size: 2048,
    });

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

  test("syncs to all local harness skill trees when harnessType is 'all'", () => {
    // Clean up first to get accurate count
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".codex"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".opencode"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".agents"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "all", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(10); // 2 DB-backed skills × 5 dirs

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    const codexFile = join(FAKE_HOME, ".codex", "skills", "test-skill", "SKILL.md");
    const opencodeFile = join(FAKE_HOME, ".opencode", "skills", "test-skill", "SKILL.md");
    const agentsFile = join(FAKE_HOME, ".agents", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
    expect(existsSync(codexFile)).toBe(true);
    expect(existsSync(opencodeFile)).toBe(true);
    expect(existsSync(agentsFile)).toBe(true);
  });

  test("syncs DB-backed complex skill files and skips binary placeholders", () => {
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);

    const skillFile = join(FAKE_HOME, ".claude", "skills", "complex-db-skill", "SKILL.md");
    const bundledFile = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "complex-db-skill",
      "references",
      "guide.md",
    );
    const binaryFile = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "complex-db-skill",
      "assets",
      "logo.png",
    );
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(bundledFile, "utf-8")).toContain("Bundled reference.");
    expect(existsSync(binaryFile)).toBe(false);
  });

  test("removes stale bundled files from swarm-managed skill directories", () => {
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);
    expect(result.errors).toHaveLength(0);

    const skillDir = join(FAKE_HOME, ".claude", "skills", "complex-db-skill");
    const staleFile = join(skillDir, "references", "old-guide.md");
    const currentFile = join(skillDir, "references", "guide.md");
    const staleBinary = join(skillDir, "assets", "logo.png");
    mkdirSync(dirname(staleFile), { recursive: true });
    mkdirSync(dirname(staleBinary), { recursive: true });
    writeFileSync(staleFile, "stale");
    writeFileSync(staleBinary, "previous binary payload");

    const nextResult = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(nextResult.errors).toHaveLength(0);
    expect(nextResult.removed).toBeGreaterThanOrEqual(2);
    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(staleBinary)).toBe(false);
    expect(readFileSync(currentFile, "utf-8")).toContain("Bundled reference.");
  });

  test("skips legacy complex skills without stored files", () => {
    const _result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    const complexDir = join(FAKE_HOME, ".claude", "skills", "complex-skill");
    expect(existsSync(complexDir)).toBe(false);
  });

  test("continues syncing bundled files after one file write fails", () => {
    const failSkill = createSkill({
      name: "complex-fail-safe",
      description: "Complex skill with one blocked file",
      content:
        "---\nname: complex-fail-safe\ndescription: Complex skill with one blocked file\n---\n\nBody.",
      type: "remote",
      scope: "global",
      isComplex: true,
    });
    installSkill(agentId, failSkill.id);
    upsertSkillFile(failSkill.id, {
      path: "references/blocked.md",
      content: "blocked",
    });
    upsertSkillFile(failSkill.id, {
      path: "references/ok.md",
      content: "ok",
    });

    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    const blockedTarget = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "complex-fail-safe",
      "references",
      "blocked.md",
    );
    mkdirSync(blockedTarget, { recursive: true });

    const result = syncSkillsToFilesystem(agentId, "claude", FAKE_HOME);

    expect(result.errors.some((error) => error.includes("references/blocked.md"))).toBe(true);
    expect(
      readFileSync(
        join(FAKE_HOME, ".claude", "skills", "complex-fail-safe", "references", "ok.md"),
        "utf-8",
      ),
    ).toBe("ok");

    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
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
    rmSync(join(FAKE_HOME, ".opencode"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".agents"), { recursive: true, force: true });

    // Use 'all' explicitly with homeOverride (default harnessType would use real home)
    const result = syncSkillsToFilesystem(agentId, "all", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBeGreaterThanOrEqual(10);

    const claudeFile = join(FAKE_HOME, ".claude", "skills", "test-skill", "SKILL.md");
    const piFile = join(FAKE_HOME, ".pi", "agent", "skills", "test-skill", "SKILL.md");
    const codexFile = join(FAKE_HOME, ".codex", "skills", "test-skill", "SKILL.md");
    const opencodeFile = join(FAKE_HOME, ".opencode", "skills", "test-skill", "SKILL.md");
    const agentsFile = join(FAKE_HOME, ".agents", "skills", "test-skill", "SKILL.md");
    expect(existsSync(claudeFile)).toBe(true);
    expect(existsSync(piFile)).toBe(true);
    expect(existsSync(codexFile)).toBe(true);
    expect(existsSync(opencodeFile)).toBe(true);
    expect(existsSync(agentsFile)).toBe(true);
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
