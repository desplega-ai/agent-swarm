import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(import.meta.dir, "../../plugin");
const COMMANDS_DIR = join(PLUGIN_DIR, "commands");
const PI_SKILLS_DIR = join(PLUGIN_DIR, "pi-skills");

describe("build-pi-skills", () => {
  // Run the build script once before all tests
  const buildOutput = execSync("bun run plugin/build-pi-skills.ts", {
    cwd: join(import.meta.dir, "../.."),
    encoding: "utf-8",
  });

  const commandFiles = readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));

  const piSkillDirs = readdirSync(PI_SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  test("build script runs successfully", () => {
    expect(buildOutput).toContain("Converted 12 skills");
  });

  test("every command has a corresponding pi-skill", () => {
    for (const cmd of commandFiles) {
      expect(piSkillDirs).toContain(cmd);
    }
  });

  test("every pi-skill has a SKILL.md file", () => {
    for (const dir of piSkillDirs) {
      const skillPath = join(PI_SKILLS_DIR, dir, "SKILL.md");
      const content = readFileSync(skillPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  describe("frontmatter conversion", () => {
    for (const skill of piSkillDirs) {
      test(`${skill} has correct pi-mono frontmatter`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        expect(content).toStartWith("---\n");
        expect(content).toContain(`name: ${skill}`);
        expect(content).toContain("description: ");
        // Should NOT have claude-specific frontmatter
        expect(content).not.toContain("argument-hint:");
      });
    }
  });

  describe("no claude-specific references", () => {
    for (const skill of piSkillDirs) {
      test(`${skill} has no /desplega: references`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        expect(content).not.toContain("/desplega:");
      });

      test(`${skill} has no claude-only markers`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        expect(content).not.toContain("<!-- claude-only -->");
        expect(content).not.toContain("<!-- /claude-only -->");
      });

      test(`${skill} has no pi-only markers`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        expect(content).not.toContain("<!-- pi-only -->");
        expect(content).not.toContain("<!-- /pi-only -->");
      });
    }
  });

  describe("slash command syntax", () => {
    const skillsWithCrossRefs = [
      "work-on-task",
      "start-worker",
      "start-leader",
      "review-offered-task",
    ];

    for (const skill of skillsWithCrossRefs) {
      test(`${skill} uses /skill: prefix for cross-references`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        // Should not have bare /work-on-task, /swarm-chat etc. (outside of code blocks)
        // Check that known skill references use /skill: prefix
        const lines = content
          .split("\n")
          .filter((l) => !l.startsWith("```") && !l.startsWith("  "));
        for (const line of lines) {
          if (line.includes("/work-on-task") && !line.includes("/skill:work-on-task")) {
            throw new Error(`${skill}: bare /work-on-task reference found: ${line}`);
          }
          if (line.includes("/swarm-chat") && !line.includes("/skill:swarm-chat")) {
            throw new Error(`${skill}: bare /swarm-chat reference found: ${line}`);
          }
        }
      });
    }
  });

  describe("no trailing whitespace", () => {
    for (const skill of piSkillDirs) {
      test(`${skill} has no trailing whitespace`, () => {
        const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] !== lines[i].trimEnd()) {
            throw new Error(`${skill} line ${i + 1} has trailing whitespace: "${lines[i]}"`);
          }
        }
      });
    }
  });

  test("no triple+ blank lines in any skill", () => {
    for (const skill of piSkillDirs) {
      const content = readFileSync(join(PI_SKILLS_DIR, skill, "SKILL.md"), "utf-8");
      if (content.includes("\n\n\n")) {
        throw new Error(`${skill} has triple blank lines`);
      }
    }
  });
});
