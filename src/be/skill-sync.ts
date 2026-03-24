/**
 * Filesystem sync for skills.
 *
 * Writes installed skills to ~/.claude/skills/<name>/SKILL.md (and optionally
 * ~/.cursor/skills/<name>/SKILL.md) so Claude Code and Cursor discover them
 * natively.
 *
 * This runs on the API side — workers call it via POST /api/skills/sync-filesystem.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentSkills } from "./db";

export interface SkillSyncResult {
  synced: number;
  removed: number;
  errors: string[];
}

/**
 * Sync agent's installed skills to the filesystem.
 *
 * For simple skills (content in DB): writes SKILL.md to ~/.claude/skills/<name>/
 * For complex skills (isComplex=true): skipped here (handled by npx in entrypoint)
 */
export function syncSkillsToFilesystem(
  agentId: string,
  harnessType: "claude" | "cursor" | "both" = "both",
): SkillSyncResult {
  const skills = getAgentSkills(agentId);
  const home = homedir();
  const errors: string[] = [];
  let synced = 0;

  // Directories to write to
  const skillDirs: string[] = [];
  if (harnessType === "claude" || harnessType === "both") {
    skillDirs.push(join(home, ".claude", "skills"));
  }
  if (harnessType === "cursor" || harnessType === "both") {
    skillDirs.push(join(home, ".cursor", "skills"));
  }

  // Ensure base dirs exist
  for (const dir of skillDirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Track which skill names we write (for cleanup)
  const writtenNames = new Set<string>();

  for (const skill of skills) {
    if (!skill.isActive || !skill.isEnabled) continue;
    if (skill.isComplex) continue; // Complex skills handled by npx
    if (!skill.content) continue;

    writtenNames.add(skill.name);

    for (const baseDir of skillDirs) {
      const skillDir = join(baseDir, skill.name);
      const skillFile = join(skillDir, "SKILL.md");

      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillFile, skill.content, "utf-8");
        synced++;
      } catch (err) {
        errors.push(
          `${skill.name} -> ${skillDir}: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }

  // Cleanup: remove skill directories that are no longer installed
  let removed = 0;
  for (const baseDir of skillDirs) {
    if (!existsSync(baseDir)) continue;

    try {
      const existing = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of existing) {
        if (entry.isDirectory() && !writtenNames.has(entry.name)) {
          const skillDir = join(baseDir, entry.name);
          try {
            rmSync(skillDir, { recursive: true, force: true });
            removed++;
          } catch {
            // Non-fatal — skip cleanup errors
          }
        }
      }
    } catch {
      // Non-fatal — skip if we can't read the directory
    }
  }

  return { synced, removed, errors };
}
