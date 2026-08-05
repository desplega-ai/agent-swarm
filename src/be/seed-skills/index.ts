/**
 * Built-in swarm skills catalog.
 *
 * Skill templates live under `templates/skills/<name>/`. Entries with
 * `runAllSeedersCandidate: true` are seeded into the DB at swarm scope and are
 * versioned by the generic seeder harness, so pristine built-ins update while
 * user-modified skills are preserved.
 */

import { join } from "node:path";
import artifactsConfig from "../../../templates/skills/artifacts/config.json" with { type: "text" };
import artifactsContent from "../../../templates/skills/artifacts/content.md" with { type: "text" };
import askUserConfig from "../../../templates/skills/ask-user/config.json" with { type: "text" };
import askUserContent from "../../../templates/skills/ask-user/content.md" with { type: "text" };
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
import brainstormingConfig from "../../../templates/skills/brainstorming/config.json" with {
  type: "text",
};
import brainstormingContent from "../../../templates/skills/brainstorming/content.md" with {
  type: "text",
};
import codeReviewingConfig from "../../../templates/skills/code-reviewing/config.json" with {
  type: "text",
};
import codeReviewingContent from "../../../templates/skills/code-reviewing/content.md" with {
  type: "text",
};
import composioConfig from "../../../templates/skills/composio/config.json" with { type: "text" };
import composioContent from "../../../templates/skills/composio/content.md" with { type: "text" };
import composioGmailConfig from "../../../templates/skills/composio-gmail/config.json" with {
  type: "text",
};
import composioGmailContent from "../../../templates/skills/composio-gmail/content.md" with {
  type: "text",
};
import composioGoogleCalendarConfig from "../../../templates/skills/composio-google-calendar/config.json" with {
  type: "text",
};
import composioGoogleCalendarContent from "../../../templates/skills/composio-google-calendar/content.md" with {
  type: "text",
};
import composioGoogleDocsConfig from "../../../templates/skills/composio-google-docs/config.json" with {
  type: "text",
};
import composioGoogleDocsContent from "../../../templates/skills/composio-google-docs/content.md" with {
  type: "text",
};
import delegateWorkConfig from "../../../templates/skills/delegate-work/config.json" with {
  type: "text",
};
import delegateWorkContent from "../../../templates/skills/delegate-work/content.md" with {
  type: "text",
};
import designDocsConfig from "../../../templates/skills/design-docs/config.json" with {
  type: "text",
};
import designDocsContent from "../../../templates/skills/design-docs/content.md" with {
  type: "text",
};
import downloadTaskAttachmentConfig from "../../../templates/skills/download-task-attachment/config.json" with {
  type: "text",
};
import downloadTaskAttachmentContent from "../../../templates/skills/download-task-attachment/content.md" with {
  type: "text",
};
import engineeringStandardsConfig from "../../../templates/skills/engineering-standards/config.json" with {
  type: "text",
};
import engineeringStandardsContent from "../../../templates/skills/engineering-standards/content.md" with {
  type: "text",
};
import implementingConfig from "../../../templates/skills/implementing/config.json" with {
  type: "text",
};
import implementingContent from "../../../templates/skills/implementing/content.md" with {
  type: "text",
};
import improveAgentsMdConfig from "../../../templates/skills/improve-agents-md/config.json" with {
  type: "text",
};
import improveAgentsMdContent from "../../../templates/skills/improve-agents-md/content.md" with {
  type: "text",
};
import kvStorageConfig from "../../../templates/skills/kv-storage/config.json" with {
  type: "text",
};
import kvStorageContent from "../../../templates/skills/kv-storage/content.md" with {
  type: "text",
};
import learningConfig from "../../../templates/skills/learning/config.json" with { type: "text" };
import learningContent from "../../../templates/skills/learning/content.md" with { type: "text" };
import oneShotConfig from "../../../templates/skills/one-shot/config.json" with { type: "text" };
import oneShotContent from "../../../templates/skills/one-shot/content.md" with { type: "text" };
import pagesConfig from "../../../templates/skills/pages/config.json" with { type: "text" };
import pagesContent from "../../../templates/skills/pages/content.md" with { type: "text" };
import phaseRunningConfig from "../../../templates/skills/phase-running/config.json" with {
  type: "text",
};
import phaseRunningContent from "../../../templates/skills/phase-running/content.md" with {
  type: "text",
};
import planningConfig from "../../../templates/skills/planning/config.json" with { type: "text" };
import planningContent from "../../../templates/skills/planning/content.md" with { type: "text" };
import qaConfig from "../../../templates/skills/qa/config.json" with { type: "text" };
import qaContent from "../../../templates/skills/qa/content.md" with { type: "text" };
import questioningConfig from "../../../templates/skills/questioning/config.json" with {
  type: "text",
};
import questioningContent from "../../../templates/skills/questioning/content.md" with {
  type: "text",
};
import researchingConfig from "../../../templates/skills/researching/config.json" with {
  type: "text",
};
import researchingContent from "../../../templates/skills/researching/content.md" with {
  type: "text",
};
import reviewingConfig from "../../../templates/skills/reviewing/config.json" with { type: "text" };
import reviewingContent from "../../../templates/skills/reviewing/content.md" with { type: "text" };
import scriptBuilderConfig from "../../../templates/skills/script-builder/config.json" with {
  type: "text",
};
import scriptBuilderContent from "../../../templates/skills/script-builder/content.md" with {
  type: "text",
};
import scriptWorkflowsConfig from "../../../templates/skills/script-workflows/config.json" with {
  type: "text",
};
import scriptWorkflowsContent from "../../../templates/skills/script-workflows/content.md" with {
  type: "text",
};
import stepRunningConfig from "../../../templates/skills/step-running/config.json" with {
  type: "text",
};
import stepRunningContent from "../../../templates/skills/step-running/content.md" with {
  type: "text",
};
import swarmScriptsConfig from "../../../templates/skills/swarm-scripts/config.json" with {
  type: "text",
};
import swarmScriptsContent from "../../../templates/skills/swarm-scripts/content.md" with {
  type: "text",
};
import tackleGhCommentsConfig from "../../../templates/skills/tackle-gh-comments/config.json" with {
  type: "text",
};
import tackleGhCommentsContent from "../../../templates/skills/tackle-gh-comments/content.md" with {
  type: "text",
};
import tasteMinimalistSkillConfig from "../../../templates/skills/taste-minimalist-skill/config.json" with {
  type: "text",
};
import tasteMinimalistSkillContent from "../../../templates/skills/taste-minimalist-skill/content.md" with {
  type: "text",
};
import tddPlanningConfig from "../../../templates/skills/tdd-planning/config.json" with {
  type: "text",
};
import tddPlanningContent from "../../../templates/skills/tdd-planning/content.md" with {
  type: "text",
};
import vImplementingConfig from "../../../templates/skills/v-implementing/config.json" with {
  type: "text",
};
import vImplementingContent from "../../../templates/skills/v-implementing/content.md" with {
  type: "text",
};
import vPlanningConfig from "../../../templates/skills/v-planning/config.json" with {
  type: "text",
};
import vPlanningContent from "../../../templates/skills/v-planning/content.md" with {
  type: "text",
};
import verifyingConfig from "../../../templates/skills/verifying/config.json" with { type: "text" };
import verifyingContent from "../../../templates/skills/verifying/content.md" with { type: "text" };
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
import wtsExpertConfig from "../../../templates/skills/wts-expert/config.json" with {
  type: "text",
};
import wtsExpertContent from "../../../templates/skills/wts-expert/content.md" with {
  type: "text",
};
import {
  computeContentHash,
  createSkill,
  deleteSkillFile,
  getDb,
  getSkillByName,
  getSkillFiles,
  updateSkill,
  upsertSkillFiles,
} from "../db";
import type { Seeder, SeedItem } from "../seed/types";
import bundledFilesManifest from "./bundled-files.generated.json";
import { buildSkillContent, type SkillTemplateConfig } from "./render";

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
  userInvocable: boolean;
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
  { config: artifactsConfig, body: artifactsContent },
  { config: askUserConfig, body: askUserContent },
  { config: assetNamespacesConfig, body: assetNamespacesContent },
  { config: attioInteractionConfig, body: attioInteractionContent },
  { config: brainstormingConfig, body: brainstormingContent },
  { config: codeReviewingConfig, body: codeReviewingContent },
  { config: composioConfig, body: composioContent },
  { config: composioGmailConfig, body: composioGmailContent },
  { config: composioGoogleCalendarConfig, body: composioGoogleCalendarContent },
  { config: composioGoogleDocsConfig, body: composioGoogleDocsContent },
  { config: delegateWorkConfig, body: delegateWorkContent },
  { config: designDocsConfig, body: designDocsContent },
  { config: downloadTaskAttachmentConfig, body: downloadTaskAttachmentContent },
  { config: engineeringStandardsConfig, body: engineeringStandardsContent },
  { config: implementingConfig, body: implementingContent },
  { config: improveAgentsMdConfig, body: improveAgentsMdContent },
  { config: kvStorageConfig, body: kvStorageContent },
  { config: learningConfig, body: learningContent },
  { config: oneShotConfig, body: oneShotContent },
  { config: pagesConfig, body: pagesContent },
  { config: phaseRunningConfig, body: phaseRunningContent },
  { config: planningConfig, body: planningContent },
  { config: qaConfig, body: qaContent },
  { config: questioningConfig, body: questioningContent },
  { config: researchingConfig, body: researchingContent },
  { config: reviewingConfig, body: reviewingContent },
  { config: scriptBuilderConfig, body: scriptBuilderContent },
  { config: scriptWorkflowsConfig, body: scriptWorkflowsContent },
  { config: stepRunningConfig, body: stepRunningContent },
  { config: swarmScriptsConfig, body: swarmScriptsContent },
  { config: tackleGhCommentsConfig, body: tackleGhCommentsContent },
  { config: tasteMinimalistSkillConfig, body: tasteMinimalistSkillContent },
  { config: tddPlanningConfig, body: tddPlanningContent },
  { config: vImplementingConfig, body: vImplementingContent },
  { config: vPlanningConfig, body: vPlanningContent },
  { config: verifyingConfig, body: verifyingContent },
  { config: workflowIterateConfig, body: workflowIterateContent },
  { config: workflowStructuredOutputConfig, body: workflowStructuredOutputContent },
  { config: wtsExpertConfig, body: wtsExpertContent },
];

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
function skillSeedHash(
  content: string,
  systemDefault: boolean,
  files: SeedSkillFile[],
  userInvocable = true,
): string {
  // Same back-compat rule as the file section: the userInvocable segment is
  // appended ONLY when the flag is false, so every skill with the default
  // (true) keeps hashing byte-identically to the pre-flag scheme. Without the
  // segment, a user flipping the column via the API would still hash as
  // pristine and the next source update would silently revert their edit.
  let base = `${content}\n\n# seed:systemDefault=${systemDefault ? "1" : "0"}\n`;
  if (userInvocable === false) base += "# seed:userInvocable=0\n";
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
    userInvocable: config.userInvocable !== false,
    files: BUILT_IN_SKILL_FILES[config.name] ?? [],
  };
}

/** Recursively collect `<skillDir>/files/**` as skill-relative bundled files. */
async function readSkillFilesDir(skillDir: string): Promise<SeedSkillFile[]> {
  const filesRoot = join(skillDir, "files");
  const collected: SeedSkillFile[] = [];

  try {
    for await (const relative of new Bun.Glob("**/*").scan({ cwd: filesRoot, onlyFiles: true })) {
      // Bun.Glob yields platform-native separators; skill_files paths are POSIX.
      const path = relative.split("\\").join("/");
      collected.push({ path, content: await Bun.file(join(filesRoot, relative)).text() });
    }
  } catch {
    // `files/` is optional — a scan over a missing directory yields nothing on
    // some platforms and throws on others. Both mean "no bundled files".
    return [];
  }

  return collected.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Load the seeded-skill catalog.
 *
 * With no argument this is pure in-memory work over the build-time embedded
 * sources — the production path, since the compiled API has no `templates/` on
 * disk. Passing `templatesDir` reads the repo instead (tests + the seed CLI).
 *
 * Async because the directory branch does file I/O through Bun's APIs;
 * `Seeder.items()` accepts a promise, so this costs the harness nothing.
 */
export async function loadSeedSkills(templatesDir?: string): Promise<SeedSkill[]> {
  if (!templatesDir) {
    return BUILT_IN_SKILL_SOURCES.map(({ config, body }) => seedSkillFromSource(config, body))
      .filter((skill): skill is SeedSkill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const skills: SeedSkill[] = [];

  // One entry per skill directory that ships a config; `content.md` is required
  // for a seeded skill and checked below.
  let configPaths: string[] = [];
  try {
    configPaths = await Array.fromAsync(new Bun.Glob("*/config.json").scan({ cwd: templatesDir }));
  } catch {
    return [];
  }

  for (const configRelative of configPaths.sort()) {
    const dirName = configRelative.split(/[/\\]/)[0];
    if (!dirName) continue;

    const dir = join(templatesDir, dirName);
    const contentFile = Bun.file(join(dir, "content.md"));
    if (!(await contentFile.exists())) continue;

    const config = (await Bun.file(
      join(templatesDir, configRelative),
    ).json()) as SkillTemplateConfig;
    if (!config.runAllSeedersCandidate) continue;

    skills.push({
      name: config.name,
      description: config.description,
      content: buildSkillContent(config, await contentFile.text()),
      systemDefault: config.systemDefault === true,
      userInvocable: config.userInvocable !== false,
      files: await readSkillFilesDir(dir),
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

  async items(): Promise<SkillSeedItem[]> {
    const skills = await loadSeedSkills();
    return skills.map((skill) => ({
      key: skill.name,
      contentHash: skillSeedHash(
        skill.content,
        skill.systemDefault,
        skill.files,
        skill.userInvocable,
      ),
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
    return skillSeedHash(
      existing.content,
      existing.systemDefault,
      liveFiles,
      existing.userInvocable,
    );
  },

  /**
   * Land the skill row and its bundled files as ONE atomic unit.
   *
   * A partial apply is unrecoverable, not merely untidy. If the row is written
   * but file sync then throws (e.g. an operator sets `SKILL_FILES_MAX_COUNT`
   * below a skill's file count), the harness catches the error and does NOT
   * record `seed_state`. On the next boot the seeder sees an unrecorded row
   * whose hash — computed over the files it does not have — differs from the
   * source, classifies it as user-modified, and refuses to touch it again. The
   * system-default skill would stay broken forever, even after the limit is
   * fixed. The transaction makes the failure clean so the next run retries.
   */
  apply(item): void {
    const { skill } = item;

    getDb().transaction(() => {
      const existing = getSkillByName(skill.name, "swarm");

      if (existing) {
        updateSkill(existing.id, {
          name: skill.name,
          description: skill.description,
          content: skill.content,
          scope: "swarm",
          systemDefault: skill.systemDefault,
          userInvocable: skill.userInvocable,
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
        userInvocable: skill.userInvocable,
        isComplex: skill.files.length > 0,
      });
      syncSeededSkillFiles(created.id, skill.files);
    })();
  },
};
