import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundledFileCount,
  assertSafeRelativePath,
  assertSkillRoundTrip,
  type Manifest,
  type PathRewrite,
  parseSkillMd,
  rewriteSkillReferences,
  sanitizeSyncedVia,
  stableJson,
  type VendoredSkillConfig,
  validateBundledFileBytes,
  validateManifest,
} from "../../scripts/sync-ai-toolbox-skills";

const tempRoot = mkdtempSync(join(tmpdir(), "sync-ai-toolbox-skills-test-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function config(name: string, description: string): VendoredSkillConfig {
  return {
    kind: "skill",
    name,
    displayName: "Fixture",
    slug: name,
    title: "Fixture",
    description,
    version: "1.0.0",
    category: "skills",
    placeholders: [],
    runAllSeedersCandidate: true,
    systemDefault: true,
    tags: ["fixture", "testing"],
  };
}

describe("ai-toolbox skill sync pure transforms", () => {
  test("parses allowed frontmatter, strips it, and records supported transforms", () => {
    const parsed = parseSkillMd(
      "fixture",
      [
        "---",
        "name: fixture",
        "description: A fixture skill",
        "hooks:",
        "  PostToolUse: ignored",
        "user-invocable: false",
        "---",
        "",
        "# Fixture",
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      name: "fixture",
      description: "A fixture skill",
      body: "# Fixture\n",
      hooksDropped: true,
      userInvocableFalse: true,
    });
  });

  test("rejects unknown top-level frontmatter instead of silently dropping it", () => {
    expect(() =>
      parseSkillMd("fixture", "---\nname: fixture\ndescription: Safe\nmodel: opus\n---\n\nBody\n"),
    ).toThrow("unsupported frontmatter key(s) model");
  });

  test("preserves a raw colon-space description through render and parse", () => {
    const parsed = parseSkillMd(
      "fixture",
      "---\nname: fixture\ndescription: Build scripts: safely and repeatably\n---\n\nBody\n",
    );
    expect(parsed.description).toBe("Build scripts: safely and repeatably");
    expect(() =>
      assertSkillRoundTrip(config("fixture", parsed.description), parsed.body),
    ).not.toThrow();
  });

  test("rewrites prose paths relatively, plugin-root paths absolutely, and ignores near matches", () => {
    const rewrites: PathRewrite[] = [];
    const body = [
      "Read cc-plugin/base/skills/fixture/template.md.",
      `Run \${CLAUDE_PLUGIN_ROOT}/skills/fixture/scripts/run.sh.`,
      `Mention "\${CLAUDE_PLUGIN_ROOT}/skills/fixture/guide.md" in prose.`,
      "Leave cc-plugin/base/skills/fixture-other/template.md unchanged.",
      "Leave prefixcc-plugin/base/skills/fixture/template.md unchanged too.",
    ].join("\n");

    const rewritten = rewriteSkillReferences("fixture", body, rewrites);

    expect(rewritten).toContain("Read template.md.");
    expect(rewritten).toContain("Run ~/.claude/skills/fixture/scripts/run.sh.");
    expect(rewritten).toContain('Mention "~/.claude/skills/fixture/guide.md" in prose.');
    expect(rewritten).toContain("cc-plugin/base/skills/fixture-other/template.md");
    expect(rewritten).toContain("prefixcc-plugin/base/skills/fixture/template.md");
    expect(rewrites).toHaveLength(3);
  });

  test("guards every delegate-work helper occurrence before exact command rewrites", () => {
    const body = [
      "codex-exec.sh prose one",
      "codex-exec.sh prose two",
      `\`\${CLAUDE_PLUGIN_ROOT}/skills/delegate-work/scripts/codex-exec.sh\``,
      "printf x | codex-exec.sh -m model",
      "codex-exec.sh prose three",
    ].join("\n");
    const rewrites: PathRewrite[] = [];

    const rewritten = rewriteSkillReferences("delegate-work", body, rewrites);
    expect(rewritten).toContain("`bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh`");
    expect(rewritten).toContain("| bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh -m");
    expect(rewrites).toHaveLength(2);

    expect(() =>
      rewriteSkillReferences("delegate-work", `${body}\nnew invocation: codex-exec.sh --help`, []),
    ).toThrow("expected 5 total occurrence(s)");
  });

  test("rewrites the tackle-gh-comments assignment to an expanding absolute skill path", () => {
    const body = [
      "The helper is scripts/gh-pr-comments.ts.",
      `SKILL="\${CLAUDE_PLUGIN_ROOT}/skills/tackle-gh-comments/scripts/gh-pr-comments.ts"`,
    ].join("\n");
    const rewrites: PathRewrite[] = [];

    const rewritten = rewriteSkillReferences("tackle-gh-comments", body, rewrites);

    expect(rewritten).toContain(
      "SKILL=~/.claude/skills/tackle-gh-comments/scripts/gh-pr-comments.ts",
    );
    expect(rewritten).not.toContain('SKILL="~/.claude/');
    expect(rewrites).toEqual([
      {
        skill: "tackle-gh-comments",
        line: 2,
        from: `SKILL="\${CLAUDE_PLUGIN_ROOT}/skills/tackle-gh-comments/scripts/gh-pr-comments.ts"`,
        to: "SKILL=~/.claude/skills/tackle-gh-comments/scripts/gh-pr-comments.ts",
      },
    ]);
  });

  test("rejects absolute, traversal, and backslash bundled paths", () => {
    expect(assertSafeRelativePath("fixture", "scripts/run.sh", tempRoot)).toBe(
      join(tempRoot, "fixture", "files", "scripts", "run.sh"),
    );
    for (const unsafe of ["/tmp/run.sh", "../run.sh", "scripts/../run.sh", "scripts\\run.sh"]) {
      expect(() => assertSafeRelativePath("fixture", unsafe, tempRoot)).toThrow(
        "unsafe bundled-file path",
      );
    }
  });

  test("enforces file count, per-file size, and total-size limits", () => {
    expect(() => assertBundledFileCount("fixture", 101)).toThrow(
      "101 bundled files exceeds limit 100",
    );
    expect(() =>
      validateBundledFileBytes("fixture", "large.txt", "100644", new Uint8Array(500 * 1024 + 1), 0),
    ).toThrow("exceeds 512000 bytes");
    expect(() =>
      validateBundledFileBytes(
        "fixture",
        "total.txt",
        "100644",
        new TextEncoder().encode("x"),
        10 * 1024 * 1024,
      ),
    ).toThrow("exceed 10485760 bytes total");
  });

  test("reports executable text downgrades and rejects binary files", () => {
    const executable = validateBundledFileBytes(
      "fixture",
      "scripts/run.sh",
      "100755",
      new TextEncoder().encode("#!/bin/sh\ntrue\n"),
      0,
    );
    expect(executable.executableBitDowngraded).toBe(true);
    expect(executable.content).toBe("#!/bin/sh\ntrue\n");

    expect(
      validateBundledFileBytes(
        "fixture",
        "notes.txt",
        "100644",
        new TextEncoder().encode("text"),
        0,
      ).executableBitDowngraded,
    ).toBe(false);
    expect(() =>
      validateBundledFileBytes("fixture", "binary.dat", "100644", new Uint8Array([1, 0, 2]), 0),
    ).toThrow("binary (contains a NUL byte)");
  });

  test("canonicalizes and validates a manifest JSON round trip", () => {
    const manifest: Manifest = {
      version: 1,
      source: "https://github.com/desplega-ai/ai-toolbox.git",
      syncedVia: tempRoot,
      commit: "a".repeat(40),
      excludedSkills: ["feedback"],
      skills: ["fixture"],
      files: {
        "templates/skills/fixture/content.md": "b".repeat(64),
        "templates/skills/fixture/config.json": "c".repeat(64),
      },
      transforms: {
        hooksDropped: [],
        userInvocableFalse: [],
        pathRewrites: [],
        executableBitsDowngraded: [],
      },
    };
    const source = stableJson(manifest);
    const parsed = JSON.parse(source) as Manifest;

    expect(() => validateManifest(parsed, source)).not.toThrow();
    expect(stableJson(parsed)).toBe(source);
    expect(() => validateManifest(parsed, source.replace("{\n", "{ \n"))).toThrow(
      "not deterministic 2-space JSON",
    );
  });

  test("sanitizes URL sync provenance while preserving local paths", () => {
    expect(
      sanitizeSyncedVia(
        "https://git-user:secret@example.com/desplega-ai/ai-toolbox.git?token=secret#branch",
      ),
    ).toBe("https://example.com/desplega-ai/ai-toolbox.git");
    expect(sanitizeSyncedVia(tempRoot)).toBe(tempRoot);
  });
});
