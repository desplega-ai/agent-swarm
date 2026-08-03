/**
 * Enforce the skill source-of-truth invariants.
 *
 * There are three ways a skill reaches an agent, and they are NOT interchangeable:
 *
 *   1. **Seeded** — `templates/skills/<name>/{config.json,content.md,files/}`
 *      with `runAllSeedersCandidate: true`. Embedded into the API binary at build
 *      time, written to the DB at boot, synced to every harness skill tree.
 *   2. **Baked** — a pinned `npx skills add` in `Dockerfile.worker` (agent-fs,
 *      qa-use), the image-copied `plugin/pi-skills/<name>/` (pi tree), or
 *      `plugin/commands/<name>.md` (converted to Codex skills at image build).
 *      `plugin/skills/` is retired — seeded templates replaced it.
 *   3. **Remote-installed on demand** — a `SKILL.md` at a path the integrations
 *      catalog points at (`templatePath`), fetched from GitHub raw by
 *      `skill-install-remote`. These live under `templates/skills/`, where a
 *      sibling `SKILL.md` is generated from `config.json` and `content.md`.
 *
 * (1) and (2) write into the same per-harness skill trees (`~/.claude/skills/`,
 * `~/.pi/agent/skills/`, `~/.codex/skills/`, …). When the same name exists in
 * both, the DB copy wins at runtime, the baked content is silently lost, and
 * the filesystem writer then prunes any bundled file that has no `skill_files`
 * row. That shipped: `artifacts`, `kv-storage` and `pages` were each defined
 * twice with different content, and agents were served the truncated version
 * with its examples deleted.
 *
 * These checks make that class of mistake fail at CI instead of in production.
 *
 * Usage: bun run check:skill-sources
 *
 * See runbooks/skills.md for the authoring guide.
 */

import { join } from "node:path";
import type { SkillTemplateConfig } from "../src/be/seed-skills/render";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "skills");
const PLUGIN_DIR = join(REPO_ROOT, "plugin", "skills");
const PI_SKILLS_DIR = join(REPO_ROOT, "plugin", "pi-skills");
const COMMANDS_DIR = join(REPO_ROOT, "plugin", "commands");
const WORKER_DOCKERFILE = join(REPO_ROOT, "Dockerfile.worker");
const SEEDER_INDEX = join(REPO_ROOT, "src", "be", "seed-skills", "index.ts");
const INTEGRATIONS_CATALOG = join(REPO_ROOT, "apps", "ui", "src", "lib", "integrations-catalog.ts");

type Problem = { rule: string; detail: string };
const problems: Problem[] = [];

function fail(rule: string, detail: string): void {
  problems.push({ rule, detail });
}

/** Directory names under a root that contain at least one file we care about. */
async function skillDirs(root: string, marker: string): Promise<string[]> {
  const names = new Set<string>();
  for await (const relative of new Bun.Glob(`*/${marker}`).scan({ cwd: root })) {
    const dir = relative.split(/[/\\]/)[0];
    if (dir) names.add(dir);
  }
  return [...names].sort();
}

const templateNames = await skillDirs(TEMPLATES_DIR, "config.json").catch(() => []);
const pluginNames = await skillDirs(PLUGIN_DIR, "SKILL.md").catch(() => []);
const piSkillNames = await skillDirs(PI_SKILLS_DIR, "SKILL.md").catch(() => []);
const seederSource = await Bun.file(SEEDER_INDEX).text();

/** Command names baked as ~/.claude/commands/*.md and converted to Codex skills. */
async function commandNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const file of new Bun.Glob("*.md").scan({ cwd: COMMANDS_DIR })) {
    names.push(file.replace(/\.md$/, ""));
  }
  return names.sort();
}

const commandSkillNames = await commandNames().catch(() => []);

/** Skill names passed to pinned `npx skills add` commands in Dockerfile.worker. */
async function dockerfileSkillNames(): Promise<string[]> {
  const source = (await Bun.file(WORKER_DOCKERFILE).text())
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\r?\n/g, " ");
  const names = new Set<string>();

  for (const command of source.matchAll(/\bnpx\s+.*?\bskills(?:@\S+)?\s+add\s+([^&\n]+)/g)) {
    const args = command[1] ?? "";
    for (const flag of args.matchAll(
      /--skill(?:=|\s+)(?:"([a-z0-9][a-z0-9-]*)"|'([a-z0-9][a-z0-9-]*)'|([a-z0-9][a-z0-9-]*))/g,
    )) {
      const name = flag[1] ?? flag[2] ?? flag[3];
      if (name) names.add(name);
    }
  }

  return [...names].sort();
}

const dockerfileNames = await dockerfileSkillNames();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Local binding a module path is imported as, or null when it is not imported. */
function importAliasFor(source: string, modulePath: string): string | null {
  const match = source.match(
    new RegExp(`import\\s+(\\w+)\\s+from\\s+"[^"]*${escapeRegex(modulePath)}"`),
  );
  return match?.[1] ?? null;
}

/** Body of the BUILT_IN_SKILL_SOURCES array literal, or null if not found. */
const catalogBody =
  seederSource.match(/const BUILT_IN_SKILL_SOURCES\s*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? null;

// ── 1. No name may exist in both delivery paths ─────────────────────────────
for (const name of templateNames) {
  if (pluginNames.includes(name)) {
    fail(
      "duplicate-delivery-path",
      `"${name}" exists in BOTH templates/skills/ and plugin/skills/. ` +
        `Both write ~/.claude/skills/${name}/SKILL.md and the DB copy wins, so the ` +
        `baked one is dead content. Pick one — prefer templates/skills/.`,
    );
  }
  if (dockerfileNames.includes(name)) {
    fail(
      "duplicate-delivery-path",
      `"${name}" exists in templates/skills/ AND is installed by an npx skills add ` +
        `--skill flag in Dockerfile.worker. Both write ` +
        `~/.claude/skills/${name}/SKILL.md and the DB copy wins, so the baked one is ` +
        `dead content. Pick one — prefer templates/skills/.`,
    );
  }
  if (piSkillNames.includes(name)) {
    fail(
      "duplicate-delivery-path",
      `"${name}" exists in templates/skills/ AND plugin/pi-skills/. Both write ` +
        `~/.pi/agent/skills/${name}/SKILL.md and the DB copy wins, so the baked pi ` +
        `variant is dead content and its bundled files get pruned. Pick one.`,
    );
  }
  if (commandSkillNames.includes(name)) {
    fail(
      "duplicate-delivery-path",
      `"${name}" exists in templates/skills/ AND plugin/commands/${name}.md. The ` +
        `image converts commands into ~/.codex/skills/${name}/SKILL.md, the DB copy ` +
        `wins there, and the baked one is dead content. Pick one.`,
    );
  }
}

for (const name of templateNames) {
  const dir = join(TEMPLATES_DIR, name);
  const configPath = join(dir, "config.json");

  let config: SkillTemplateConfig;
  try {
    config = await Bun.file(configPath).json();
  } catch (error) {
    fail("unreadable-config", `templates/skills/${name}/config.json is not valid JSON: ${error}`);
    continue;
  }

  // ── 2. The declared name must match the directory ─────────────────────────
  if (config.name && config.name !== name) {
    fail(
      "name-mismatch",
      `templates/skills/${name}/config.json declares name "${config.name}". ` +
        `The seeder keys bundled files by directory name, so they must match.`,
    );
  }

  const hasContent = await Bun.file(join(dir, "content.md")).exists();

  if (!config.runAllSeedersCandidate) continue;

  // ── 3. A seeded skill must have a body ────────────────────────────────────
  if (!hasContent) {
    fail(
      "missing-content",
      `templates/skills/${name} has runAllSeedersCandidate: true but no content.md. ` +
        `The seeder reads content.md (a sibling SKILL.md serves remote-install only ` +
        `and is NOT what gets seeded).`,
    );
  }

  // ── 4. A seeded skill must be wired into the seeder ───────────────────────
  // Content is embedded at build time (the compiled API has no templates/ on
  // disk), so a template nobody imported silently never reaches any agent.
  //
  // Importing is necessary but NOT sufficient: unused imports are legal, so a
  // contributor can add both imports, forget the BUILT_IN_SKILL_SOURCES entry,
  // and the skill still never reaches production. Resolve each import to its
  // local binding and require BOTH bindings to appear in the catalog array.
  const configAlias = importAliasFor(seederSource, `templates/skills/${name}/config.json`);
  const contentAlias = importAliasFor(seederSource, `templates/skills/${name}/content.md`);

  if (!configAlias || !contentAlias) {
    fail(
      "not-wired",
      `templates/skills/${name} has runAllSeedersCandidate: true but its ` +
        `${!configAlias ? "config.json" : "content.md"} is not imported in ` +
        `src/be/seed-skills/index.ts. It will never be seeded. Add both text-imports ` +
        `and an entry in BUILT_IN_SKILL_SOURCES.`,
    );
    continue;
  }

  if (!catalogBody) {
    fail(
      "catalog-unparseable",
      `Could not locate the BUILT_IN_SKILL_SOURCES array in src/be/seed-skills/index.ts. ` +
        `If it was renamed or reshaped, update scripts/check-skill-sources.ts to match — ` +
        `otherwise this check silently stops verifying anything.`,
    );
    break;
  }

  const referenced =
    new RegExp(`\\bconfig:\\s*${configAlias}\\b`).test(catalogBody) &&
    new RegExp(`\\bbody:\\s*${contentAlias}\\b`).test(catalogBody);

  if (!referenced) {
    fail(
      "not-wired",
      `templates/skills/${name} is imported into src/be/seed-skills/index.ts as ` +
        `{ ${configAlias}, ${contentAlias} } but has no BUILT_IN_SKILL_SOURCES entry. ` +
        `Unused imports are legal, so this compiles and passes tests while ` +
        `loadSeedSkills() never returns the skill and production never seeds it. ` +
        `Add: { config: ${configAlias}, body: ${contentAlias} }`,
    );
  }
}

// ── 5. Every integrations-catalog templatePath must have a real SKILL.md ────
// `skill-install-remote` fetches `<templatePath>/SKILL.md` from GitHub raw. If a
// refactor moves or deletes that file, integration setup breaks at runtime with
// a 404 and nothing here would have caught it.
const catalogSource = await Bun.file(INTEGRATIONS_CATALOG)
  .text()
  .catch(() => "");

const templatePaths = [...catalogSource.matchAll(/templatePath:\s*"([^"]+)"/g)].map(
  (match) => match[1] as string,
);

for (const templatePath of [...new Set(templatePaths)]) {
  if (!(await Bun.file(join(REPO_ROOT, templatePath, "SKILL.md")).exists())) {
    fail(
      "missing-remote-skill",
      `apps/ui/src/lib/integrations-catalog.ts points templatePath "${templatePath}" at a ` +
        `directory with no SKILL.md. skill-install-remote fetches ` +
        `${templatePath}/SKILL.md from GitHub raw, so integration setup would 404.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`Skill source-of-truth check FAILED (${problems.length} problem(s)):\n`);
  for (const problem of problems) {
    console.error(`  [${problem.rule}]`);
    console.error(`    ${problem.detail}\n`);
  }
  console.error("See runbooks/skills.md for the authoring guide.");
  process.exit(1);
}

console.log(
  `Skill source-of-truth check passed ` +
    `(${templateNames.length} seeded template(s), ${pluginNames.length} plugin-baked skill(s), ` +
    `${dockerfileNames.length} Docker-installed skill(s), ${piSkillNames.length} pi-baked ` +
    `skill(s), ${commandSkillNames.length} baked command(s), no overlap).`,
);
