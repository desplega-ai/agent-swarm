/**
 * Filesystem sync for skills.
 *
 * Writes installed skills to every local harness skill tree so Claude Code,
 * Pi, Codex, OpenCode, and AGENTS.md-compatible adapters can discover them.
 *
 * This runs on the API side — workers call it via POST /api/skills/sync-filesystem.
 * The actual FS write logic lives in the worker-safe src/utils/skill-fs-writer.ts
 * so workers can also call it locally with their own homedir().
 */

import { homedir } from "node:os";
import {
  type SkillFsEntry,
  type SkillHarnessTarget,
  type SkillSyncResult,
  writeSkillsToFilesystem,
} from "../utils/skill-fs-writer";
import { getAgentSkills, getSkillFiles } from "./db";

export type { SkillSyncResult };

/**
 * Sync agent's installed skills to the filesystem.
 *
 * For simple skills (content in DB): writes SKILL.md to ~/.claude/skills/<name>/
 * For DB-backed complex skills: writes SKILL.md plus bundled skill_files rows.
 * Legacy complex skills without skill_files remain handled by npx in entrypoint.
 *
 * API-side adapter: fetches skill data from DB, builds SkillFsEntry[], then
 * delegates all FS writes to writeSkillsToFilesystem() from skill-fs-writer.ts.
 */
export function syncSkillsToFilesystem(
  agentId: string,
  harnessType: SkillHarnessTarget = "all",
  homeOverride?: string,
): SkillSyncResult {
  const skills = getAgentSkills(agentId);
  const home = homeOverride ?? homedir();

  const entries: SkillFsEntry[] = skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    content: skill.content ?? null,
    isComplex: skill.isComplex,
    isEnabled: skill.isEnabled,
    isActive: skill.isActive,
    files: skill.isComplex
      ? getSkillFiles(skill.id).map((f) => ({
          path: f.path,
          content: f.content,
          isBinary: f.isBinary,
        }))
      : [],
  }));

  return writeSkillsToFilesystem(entries, harnessType, home);
}

export interface SkillsSignature {
  hash: string;
  count: number;
}

/**
 * Compute a stable signature over an agent's installed-and-enabled skill set.
 *
 * Hash inputs are the per-row mutation-tracking fields — any install,
 * uninstall, toggle, or skill-update mutates at least one of them. Output is
 * deterministic and contains no timestamps beyond per-row mutation fields.
 */
export function computeAgentSkillsSignature(agentId: string): SkillsSignature {
  const skills = getAgentSkills(agentId);
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = JSON.stringify(
    sorted.map((s) => [
      s.id,
      s.name,
      s.version,
      s.isEnabled,
      s.isActive,
      s.lastUpdatedAt,
      s.sourceHash ?? "",
      s.installedAt,
    ]),
  );
  const hash = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
  return { hash, count: sorted.length };
}
