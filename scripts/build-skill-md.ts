/**
 * Generate catalog-facing SKILL.md files from seeded-skill source files.
 *
 * Source of truth: `templates/skills/<name>/{config.json,content.md}`
 * Output:          `templates/skills/<name>/SKILL.md`
 *
 * A SKILL.md is generated when it already exists, or when an integrations
 * catalog entry points at the directory for remote installation.
 *
 * Usage: bun run build:skill-md
 *        bun run build:skill-md --check    # CI drift check, no write
 */

import { join } from "node:path";
import { buildSkillContent, type SkillTemplateConfig } from "../src/be/seed-skills/render";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "skills");
const INTEGRATIONS_CATALOG = join(
  REPO_ROOT,
  "apps",
  "ui",
  "src",
  "lib",
  "integrations-catalog.ts",
);

async function catalogTemplateDirs(): Promise<Set<string>> {
  const source = await Bun.file(INTEGRATIONS_CATALOG).text();
  const templatePaths = source.matchAll(/templatePath:\s*"([^"]+)"/g);
  return new Set([...templatePaths].map((match) => join(REPO_ROOT, match[1] as string)));
}

const catalogDirs = await catalogTemplateDirs();
const stale: string[] = [];
const written: string[] = [];
const generatedPaths: string[] = [];

for await (const configRelative of new Bun.Glob("*/config.json").scan({ cwd: TEMPLATES_DIR })) {
  const skillDir = join(TEMPLATES_DIR, configRelative, "..");
  const contentPath = join(skillDir, "content.md");
  if (!(await Bun.file(contentPath).exists())) continue;

  const skillPath = join(skillDir, "SKILL.md");
  const needsSkillMd = (await Bun.file(skillPath).exists()) || catalogDirs.has(skillDir);
  if (!needsSkillMd) continue;

  let config: SkillTemplateConfig;
  try {
    config = (await Bun.file(join(TEMPLATES_DIR, configRelative)).json()) as SkillTemplateConfig;
  } catch (error) {
    console.error(`[build-skill-md] failed to parse templates/skills/${configRelative}: ${error}`);
    process.exit(1);
  }
  const generated = buildSkillContent(config, await Bun.file(contentPath).text());
  const current = (await Bun.file(skillPath).exists()) ? await Bun.file(skillPath).text() : "";
  const relativePath = join("templates", "skills", configRelative, "..", "SKILL.md");

  generatedPaths.push(relativePath);
  if (current === generated) continue;

  if (process.argv.includes("--check")) {
    stale.push(relativePath);
    continue;
  }

  await Bun.write(skillPath, generated);
  written.push(relativePath);
}

if (stale.length > 0) {
  console.error(
    `[build-skill-md] ${stale.length} generated SKILL.md file(s) are stale:\n` +
      stale.map((path) => `  ${path}`).join("\n") +
      "\nRun `bun run build:skill-md` and commit the result.",
  );
  process.exit(1);
}

if (process.argv.includes("--check")) {
  console.log(`[build-skill-md] up to date (${generatedPaths.length} SKILL.md file(s))`);
} else {
  console.log(
    `[build-skill-md] wrote ${written.length} SKILL.md file(s) ` +
      `(${generatedPaths.length - written.length} already up to date)`,
  );
}
