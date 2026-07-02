/**
 * Unit tests for the pure, DB-free writeSkillsToFilesystem() helper.
 *
 * These tests drive the writer directly with crafted SkillFsEntry arrays,
 * exercising: simple write, complex skill with bundled files, binary-file
 * skip, rename → stale dir removed, marker-gated cleanup leaves unmanaged
 * dirs intact, path-traversal name sanitization.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SkillFsEntry,
  SWARM_MARKER_FILE,
  writeSkillsToFilesystem,
} from "../utils/skill-fs-writer";

const FAKE_HOME = join(tmpdir(), `skill-fs-writer-test-${process.pid}`);

function skillEntry(
  overrides: Partial<SkillFsEntry> & { name: string; content: string },
): SkillFsEntry {
  return {
    id: `id-${overrides.name}`,
    isComplex: false,
    isEnabled: true,
    isActive: true,
    files: [],
    ...overrides,
  };
}

describe("writeSkillsToFilesystem", () => {
  beforeAll(() => {
    mkdirSync(FAKE_HOME, { recursive: true });
  });

  afterEach(() => {
    // Clean up between tests
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".codex"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".opencode"), { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".agents"), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  test("writes simple skill SKILL.md to claude dir", () => {
    const entries = [skillEntry({ name: "my-skill", content: "# My Skill\n\nDoes stuff." })];
    const result = writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(1);

    const skillFile = join(FAKE_HOME, ".claude", "skills", "my-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf-8")).toContain("Does stuff.");
  });

  test("writes swarm-managed marker alongside SKILL.md", () => {
    const entries = [skillEntry({ name: "my-skill", content: "# My Skill" })];
    writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    const marker = join(FAKE_HOME, ".claude", "skills", "my-skill", SWARM_MARKER_FILE);
    expect(existsSync(marker)).toBe(true);
  });

  test("writes to all harness dirs when harnessType is 'all'", () => {
    const entries = [skillEntry({ name: "multi-skill", content: "# Multi" })];
    const result = writeSkillsToFilesystem(entries, "all", FAKE_HOME);

    expect(result.synced).toBe(5); // claude + pi + codex + opencode + .agents
    expect(existsSync(join(FAKE_HOME, ".claude", "skills", "multi-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(FAKE_HOME, ".pi", "agent", "skills", "multi-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(FAKE_HOME, ".codex", "skills", "multi-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(FAKE_HOME, ".opencode", "skills", "multi-skill", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(FAKE_HOME, ".agents", "skills", "multi-skill", "SKILL.md"))).toBe(true);
  });

  test("writes complex skill SKILL.md plus non-binary bundled files", () => {
    const entries = [
      skillEntry({
        name: "complex-skill",
        content: "# Complex Skill",
        isComplex: true,
        files: [
          {
            path: "references/guide.md",
            content: "# Guide\n\nBundled reference.",
            isBinary: false,
          },
        ],
      }),
    ];
    const result = writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(1);

    const skillFile = join(FAKE_HOME, ".claude", "skills", "complex-skill", "SKILL.md");
    const bundledFile = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "complex-skill",
      "references",
      "guide.md",
    );
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(bundledFile)).toBe(true);
    expect(readFileSync(bundledFile, "utf-8")).toContain("Bundled reference.");
  });

  test("skips binary bundled files", () => {
    const entries = [
      skillEntry({
        name: "complex-skill",
        content: "# Complex Skill",
        isComplex: true,
        files: [
          { path: "references/guide.md", content: "# Guide", isBinary: false },
          { path: "assets/logo.png", content: "[binary]", isBinary: true },
        ],
      }),
    ];
    writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    const binaryFile = join(FAKE_HOME, ".claude", "skills", "complex-skill", "assets", "logo.png");
    const textFile = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "complex-skill",
      "references",
      "guide.md",
    );
    expect(existsSync(binaryFile)).toBe(false);
    expect(existsSync(textFile)).toBe(true);
  });

  test("skips legacy complex skills with no files", () => {
    const entries = [
      skillEntry({
        name: "legacy-complex",
        content: "# Legacy",
        isComplex: true,
        files: [], // no files → skip
      }),
    ];
    writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    const skillDir = join(FAKE_HOME, ".claude", "skills", "legacy-complex");
    expect(existsSync(skillDir)).toBe(false);
  });

  test("skips inactive skills", () => {
    const entries = [
      skillEntry({ name: "inactive-skill", content: "# Inactive", isActive: false }),
    ];
    const result = writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(result.synced).toBe(0);
    expect(existsSync(join(FAKE_HOME, ".claude", "skills", "inactive-skill"))).toBe(false);
  });

  test("skips disabled skills", () => {
    const entries = [
      skillEntry({ name: "disabled-skill", content: "# Disabled", isEnabled: false }),
    ];
    const result = writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(result.synced).toBe(0);
    expect(existsSync(join(FAKE_HOME, ".claude", "skills", "disabled-skill"))).toBe(false);
  });

  test("removes stale swarm-managed skill directory on rename", () => {
    // First sync: write old-name
    const first = [skillEntry({ name: "old-name", content: "# Old" })];
    writeSkillsToFilesystem(first, "claude", FAKE_HOME);

    const oldDir = join(FAKE_HOME, ".claude", "skills", "old-name");
    expect(existsSync(oldDir)).toBe(true);

    // Second sync: write new-name, old-name disappears
    const second = [skillEntry({ name: "new-name", content: "# New" })];
    const result = writeSkillsToFilesystem(second, "claude", FAKE_HOME);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(FAKE_HOME, ".claude", "skills", "new-name", "SKILL.md"))).toBe(true);
  });

  test("marker-gated cleanup leaves unmanaged dirs intact", () => {
    // User-installed skill dir with no .swarm-managed marker
    const foreignDir = join(FAKE_HOME, ".claude", "skills", "user-personal-skill");
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(join(foreignDir, "SKILL.md"), "user's own skill — keep me");

    // Sync with a different skill set — should NOT touch the unmanaged dir
    const entries = [skillEntry({ name: "swarm-skill", content: "# Swarm" })];
    writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(existsSync(foreignDir)).toBe(true);
    expect(readFileSync(join(foreignDir, "SKILL.md"), "utf-8")).toBe("user's own skill — keep me");
  });

  test("sanitizes path-traversal characters in skill names", () => {
    const entries = [skillEntry({ name: "my/dangerous/../skill", content: "# Safe" })];
    const result = writeSkillsToFilesystem(entries, "claude", FAKE_HOME);

    expect(result.errors).toHaveLength(0);
    const sanitizedDir = join(FAKE_HOME, ".claude", "skills", "my_dangerous____skill");
    expect(existsSync(sanitizedDir)).toBe(true);
  });

  test("removes stale bundled files on re-sync", () => {
    // First sync: write complex skill with one file
    const first = [
      skillEntry({
        name: "complex-skill",
        content: "# Complex",
        isComplex: true,
        files: [{ path: "references/guide.md", content: "# Guide", isBinary: false }],
      }),
    ];
    writeSkillsToFilesystem(first, "claude", FAKE_HOME);

    const skillDir = join(FAKE_HOME, ".claude", "skills", "complex-skill");
    // Manually add a stale file that should be removed
    writeFileSync(join(skillDir, "references", "stale.md"), "stale content");
    expect(existsSync(join(skillDir, "references", "stale.md"))).toBe(true);

    // Second sync: same skill, file not in new set → should be removed
    const result = writeSkillsToFilesystem(first, "claude", FAKE_HOME);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(skillDir, "references", "stale.md"))).toBe(false);
    expect(existsSync(join(skillDir, "references", "guide.md"))).toBe(true);
  });

  test("returns empty result for empty entries", () => {
    const result = writeSkillsToFilesystem([], "claude", FAKE_HOME);

    expect(result.synced).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
