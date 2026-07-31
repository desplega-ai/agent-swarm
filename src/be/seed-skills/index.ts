/**
 * Built-in swarm skills catalog.
 *
 * Skill templates live under `templates/skills/<name>/`. Entries with
 * `runAllSeedersCandidate: true` are seeded into the DB at swarm scope and are
 * versioned by the generic seeder harness, so pristine built-ins update while
 * user-modified skills are preserved.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import artifactsConfig from "../../../templates/skills/artifacts/config.json" with { type: "text" };
import artifactsContent from "../../../templates/skills/artifacts/content.md" with { type: "text" };
import assetNamespacesConfig from "../../../templates/skills/asset-namespaces/config.json" with {
  type: "text",
};
import assetNamespacesContent from "../../../templates/skills/asset-namespaces/content.md" with {
  type: "text",
};
import attioInteractionConfig from "../../../templates/skills/attio-interaction/config.json" with {
  type: "text",
};
import attioInteractionContent from "../../../templates/skills/attio-interaction/content.md" with {
  type: "text",
};
import kvStorageConfig from "../../../templates/skills/kv-storage/config.json" with {
  type: "text",
};
import kvStorageContent from "../../../templates/skills/kv-storage/content.md" with {
  type: "text",
};
import pagesConfig from "../../../templates/skills/pages/config.json" with { type: "text" };
import pagesContent from "../../../templates/skills/pages/content.md" with { type: "text" };
import scriptWorkflowsConfig from "../../../templates/skills/script-workflows/config.json" with {
  type: "text",
};
import scriptWorkflowsContent from "../../../templates/skills/script-workflows/content.md" with {
  type: "text",
};
import swarmScriptsConfig from "../../../templates/skills/swarm-scripts/config.json" with {
  type: "text",
};
import swarmScriptsContent from "../../../templates/skills/swarm-scripts/content.md" with {
  type: "text",
};
import tasteMinimalistSkillConfig from "../../../templates/skills/taste-minimalist-skill/config.json" with {
  type: "text",
};
import tasteMinimalistSkillContent from "../../../templates/skills/taste-minimalist-skill/content.md" with {
  type: "text",
};
import workflowIterateConfig from "../../../templates/skills/workflow-iterate/config.json" with {
  type: "text",
};
import workflowIterateContent from "../../../templates/skills/workflow-iterate/content.md" with {
  type: "text",
};
import workflowStructuredOutputConfig from "../../../templates/skills/workflow-structured-output/config.json" with {
  type: "text",
};
import workflowStructuredOutputContent from "../../../templates/skills/workflow-structured-output/content.md" with {
  type: "text",
};
import {
  computeContentHash,
  createSkill,
  deleteSkillFile,
  getSkillByName,
  getSkillFiles,
  updateSkill,
  upsertSkillFiles,
} from "../db";
import type { Seeder, SeedItem } from "../seed/types";
import bundledFilesManifest from "./bundled-files.generated.json";

type SkillTemplateConfig = {
  name: string;
  description: string;
  runAllSeedersCandidate?: boolean;
  systemDefault?: boolean;
};

/** One bundled file shipped alongside a skill's SKILL.md. */
export type SeedSkillFile = {
  /** Path relative to the skill directory, e.g. `examples/report-page.html`. */
  path: string;
  content: string;
};

export type SeedSkill = {
  name: string;
  description: string;
  content: string;
  systemDefault: boolean;
  /** Bundled files. Empty for simple (single-SKILL.md) skills. */
  files: SeedSkillFile[];
};

/**
 * Bundled files per skill, keyed by skill name.
 *
 * Generated from `templates/skills/<name>/files/**` by
 * `bun run build:seed-skill-files` — never hand-edit the JSON.
 *
 * It has to be embedded at build time: the API runs from a `bun build --compile`
 * binary and `templates/` only exists in the Dockerfile's builder stage, so the
 * seeder cannot read the directory at runtime. A single JSON module is used
 * rather than one text-import per file because TypeScript resolves `.ts` imports
 * as modules and types `.html` imports as `HTMLBundle` — neither is a string.
 *
 * `loadSeedSkills(templatesDir)` reads the directory directly instead — that
 * path is for tests and the seed CLI, where the repo is on disk.
 */
const BUILT_IN_SKILL_FILES = bundledFilesManifest as Record<string, SeedSkillFile[]>;

const BUILT_IN_SKILL_SOURCES = [
  { config: assetNamespacesConfig, body: assetNamespacesContent },
  { config: attioInteractionConfig, body: attioInteractionContent },
  { config: artifactsConfig, body: artifactsContent },
  { config: kvStorageConfig, body: kvStorageContent },
  { config: pagesConfig, body: pagesContent },
  { config: scriptWorkflowsConfig, body: scriptWorkflowsContent },
  { config: swarmScriptsConfig, body: swarmScriptsContent },
  { config: tasteMinimalistSkillConfig, body: tasteMinimalistSkillContent },
  { config: workflowIterateConfig, body: workflowIterateContent },
  { config: workflowStructuredOutputConfig, body: workflowStructuredOutputContent },
];

function buildSkillContent(config: SkillTemplateConfig, body: string): string {
  return `---\nname: ${config.name}\ndescription: ${config.description}\n---\n\n${body.trim()}\n`;
}

/** Canonical, order-independent rendering of a bundled file set for hashing. */
function canonicalFiles(files: SeedSkillFile[]): string {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\n${file.content}`)
    .join("\n\x00\n");
}

/**
 * Hash the full seeded definition: SKILL.md body, the systemDefault flag, and
 * every bundled file. Bundled files are part of the identity — editing one must
 * register as a source change, or the seeder would never propagate it.
 *
 * BACKWARD COMPATIBILITY — do not "simplify" this branch.
 *
 * The file section is appended ONLY when a skill actually has bundled files, so
 * a file-less skill hashes byte-identically to the pre-bundled-files scheme.
 * `seed_state` rows written by earlier releases hold hashes in that old format;
 * if every skill switched to the new format at once, `upstreamHash` would stop
 * matching the recorded `seededHash` for every already-seeded skill, the harness
 * would classify all of them as user-modified, and it would silently never
 * update them again.
 *
 * The transition works because an existing DB row has no `skill_files` yet, so
 * its upstream hash is still computed in the old format and matches the recorded
 * state (pristine) — while the source, which now carries files, hashes
 * differently and is therefore correctly seen as a changed source.
 */
function skillSeedHash(content: string, systemDefault: boolean, files: SeedSkillFile[]): string {
  const base = `${content}\n\n# seed:systemDefault=${systemDefault ? "1" : "0"}\n`;
  if (files.length === 0) return computeContentHash(base);
  return computeContentHash(`${base}# seed:files\n${canonicalFiles(files)}\n`);
}

function seedSkillFromSource(
  configRaw: string | SkillTemplateConfig,
  body: string,
): SeedSkill | null {
  const config =
    typeof configRaw === "string" ? (JSON.parse(configRaw) as SkillTemplateConfig) : configRaw;
  if (!config.runAllSeedersCandidate) return null;
  return {
    name: config.name,
    description: config.description,
    content: buildSkillContent(config, body),
    systemDefault: config.systemDefault === true,
    files: BUILT_IN_SKILL_FILES[config.name] ?? [],
  };
}

/** Recursively collect `<skillDir>/files/**` as skill-relative bundled files. */
function readSkillFilesDir(skillDir: string): SeedSkillFile[] {
  const filesRoot = join(skillDir, "files");
  if (!existsSync(filesRoot)) return [];

  const collected: SeedSkillFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      collected.push({ path: rel, content: readFileSync(full, "utf-8") });
    }
  };
  walk(filesRoot, "");

  return collected.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadSeedSkills(templatesDir?: string): SeedSkill[] {
  if (!templatesDir) {
    return BUILT_IN_SKILL_SOURCES.map(({ config, body }) => seedSkillFromSource(config, body))
      .filter((skill): skill is SeedSkill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (!existsSync(templatesDir)) return [];

  const skills: SeedSkill[] = [];
  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(templatesDir, entry.name);
    const configPath = join(dir, "config.json");
    const contentPath = join(dir, "content.md");
    if (!existsSync(configPath) || !existsSync(contentPath)) continue;

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as SkillTemplateConfig;
    if (!config.runAllSeedersCandidate) continue;

    const body = readFileSync(contentPath, "utf-8");
    skills.push({
      name: config.name,
      description: config.description,
      content: buildSkillContent(config, body),
      systemDefault: config.systemDefault === true,
      files: readSkillFilesDir(dir),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Make the skill's `skill_files` rows exactly match the seeded source set.
 *
 * Deleting removed paths matters: the filesystem writer treats `skill_files` as
 * authoritative and prunes anything else out of a `.swarm-managed` skill dir,
 * so a stale DB row would keep resurrecting a file the source no longer ships.
 */
function syncSeededSkillFiles(skillId: string, files: SeedSkillFile[]): void {
  const desired = new Set(files.map((file) => file.path));

  for (const existing of getSkillFiles(skillId)) {
    if (!desired.has(existing.path)) deleteSkillFile(skillId, existing.path);
  }

  if (files.length > 0) upsertSkillFiles(skillId, files);
}

type SkillSeedItem = SeedItem & { skill: SeedSkill };

export const skillsSeeder: Seeder<SkillSeedItem> = {
  kind: "skill",

  items(): SkillSeedItem[] {
    return loadSeedSkills().map((skill) => ({
      key: skill.name,
      contentHash: skillSeedHash(skill.content, skill.systemDefault, skill.files),
      skill,
    }));
  },

  upstreamHash(item): string | null {
    const existing = getSkillByName(item.key, "swarm");
    if (!existing) return null;
    // Hash the live bundled files too, so an edit to one is detected as drift
    // on the same footing as an edit to SKILL.md.
    const liveFiles = getSkillFiles(existing.id).map((file) => ({
      path: file.path,
      content: file.content,
    }));
    return skillSeedHash(existing.content, existing.systemDefault, liveFiles);
  },

  apply(item): void {
    const { skill } = item;
    const existing = getSkillByName(skill.name, "swarm");

    if (existing) {
      updateSkill(existing.id, {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        scope: "swarm",
        systemDefault: skill.systemDefault,
        isComplex: skill.files.length > 0,
      });
      syncSeededSkillFiles(existing.id, skill.files);
      return;
    }

    const created = createSkill({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      type: "personal",
      scope: "swarm",
      ownerAgentId: undefined,
      systemDefault: skill.systemDefault,
      isComplex: skill.files.length > 0,
    });
    syncSeededSkillFiles(created.id, skill.files);
  },
};
