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
import artifactsConfig from "../../../../../templates/skills/artifacts/config.json" with {
  type: "text",
};
import artifactsContent from "../../../../../templates/skills/artifacts/content.md" with {
  type: "text",
};
import attioInteractionConfig from "../../../../../templates/skills/attio-interaction/config.json" with {
  type: "text",
};
import attioInteractionContent from "../../../../../templates/skills/attio-interaction/content.md" with {
  type: "text",
};
import kvStorageConfig from "../../../../../templates/skills/kv-storage/config.json" with {
  type: "text",
};
import kvStorageContent from "../../../../../templates/skills/kv-storage/content.md" with {
  type: "text",
};
import pagesConfig from "../../../../../templates/skills/pages/config.json" with { type: "text" };
import pagesContent from "../../../../../templates/skills/pages/content.md" with { type: "text" };
import scriptWorkflowsConfig from "../../../../../templates/skills/script-workflows/config.json" with {
  type: "text",
};
import scriptWorkflowsContent from "../../../../../templates/skills/script-workflows/content.md" with {
  type: "text",
};
import swarmScriptsConfig from "../../../../../templates/skills/swarm-scripts/config.json" with {
  type: "text",
};
import swarmScriptsContent from "../../../../../templates/skills/swarm-scripts/content.md" with {
  type: "text",
};
import tasteMinimalistSkillConfig from "../../../../../templates/skills/taste-minimalist-skill/config.json" with {
  type: "text",
};
import tasteMinimalistSkillContent from "../../../../../templates/skills/taste-minimalist-skill/content.md" with {
  type: "text",
};
import workflowIterateConfig from "../../../../../templates/skills/workflow-iterate/config.json" with {
  type: "text",
};
import workflowIterateContent from "../../../../../templates/skills/workflow-iterate/content.md" with {
  type: "text",
};
import workflowStructuredOutputConfig from "../../../../../templates/skills/workflow-structured-output/config.json" with {
  type: "text",
};
import workflowStructuredOutputContent from "../../../../../templates/skills/workflow-structured-output/content.md" with {
  type: "text",
};
import { computeContentHash, createSkill, getSkillByName, updateSkill } from "../db";
import type { Seeder, SeedItem } from "../seed/types";

type SkillTemplateConfig = {
  name: string;
  description: string;
  runAllSeedersCandidate?: boolean;
  systemDefault?: boolean;
};

export type SeedSkill = {
  name: string;
  description: string;
  content: string;
  systemDefault: boolean;
};

const BUILT_IN_SKILL_SOURCES = [
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

function skillSeedHash(content: string, systemDefault: boolean): string {
  return computeContentHash(`${content}\n\n# seed:systemDefault=${systemDefault ? "1" : "0"}\n`);
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
  };
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
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

type SkillSeedItem = SeedItem & { skill: SeedSkill };

export const skillsSeeder: Seeder<SkillSeedItem> = {
  kind: "skill",

  items(): SkillSeedItem[] {
    return loadSeedSkills().map((skill) => ({
      key: skill.name,
      contentHash: skillSeedHash(skill.content, skill.systemDefault),
      skill,
    }));
  },

  upstreamHash(item): string | null {
    const existing = getSkillByName(item.key, "swarm");
    return existing ? skillSeedHash(existing.content, existing.systemDefault) : null;
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
      });
      return;
    }

    createSkill({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      type: "personal",
      scope: "swarm",
      ownerAgentId: undefined,
      systemDefault: skill.systemDefault,
    });
  },
};
