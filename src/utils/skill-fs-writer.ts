/**
 * Pure, DB-free filesystem writer for agent skills.
 *
 * Worker-safe: imports only node:fs / node:os / node:path — no be/db, no bun:sqlite.
 *
 * Shared by:
 *   - API-side: syncSkillsToFilesystem (src/be/skill-sync.ts) which fetches
 *     SkillFsEntry data from the DB then delegates here.
 *   - Worker-side: refreshSkillsIfChanged (src/utils/skills-refresh.ts) which
 *     fetches SkillFsEntry data over HTTP then calls writeSkillsToFilesystem
 *     with the worker's own homedir(), writing SKILL.md files to every local
 *     harness tree instead of the API box.
 */

import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SkillSyncResult {
  synced: number;
  removed: number;
  errors: string[];
}

export interface SkillFsEntry {
  id: string;
  name: string;
  content: string | null;
  isComplex: boolean;
  isEnabled: boolean;
  isActive: boolean;
  files: { path: string; content: string; isBinary: boolean }[];
}

export type SkillHarnessTarget = "claude" | "pi" | "codex" | "opencode" | "agents" | "all";

/**
 * Marker file written into every swarm-managed skill directory. Cleanup
 * only ever removes directories that contain this marker, so unrelated
 * personal skills the user installed via the harness's own tooling (e.g.
 * `codex skills add ...` writing into `~/.codex/skills/<name>/`) are left
 * untouched even when the API server shares a HOME with the worker (local
 * dev). See `~/.codex/skills` blast-radius note in PR #555.
 */
export const SWARM_MARKER_FILE = ".swarm-managed";

function reconcileManagedSkillFiles(skillDir: string, currentRelativeFiles: Set<string>): number {
  if (!existsSync(join(skillDir, SWARM_MARKER_FILE))) return 0;

  let removed = 0;

  const walk = (dir: string, relativeDir = ""): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    let hasEntries = false;
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const childHasEntries = walk(fullPath, relativePath);
        if (!childHasEntries) {
          try {
            rmSync(fullPath, { recursive: true, force: true });
          } catch {
            hasEntries = true;
          }
        } else {
          hasEntries = true;
        }
        continue;
      }

      if (
        relativePath === "SKILL.md" ||
        relativePath === SWARM_MARKER_FILE ||
        currentRelativeFiles.has(relativePath)
      ) {
        hasEntries = true;
        continue;
      }

      try {
        rmSync(fullPath, { force: true });
        removed++;
      } catch {
        hasEntries = true;
      }
    }

    return hasEntries;
  };

  walk(skillDir);
  return removed;
}

/**
 * Write skill entries to the filesystem under the given home directory.
 *
 * For simple skills (non-complex): writes SKILL.md only.
 * For DB-backed complex skills: writes SKILL.md plus bundled files.
 * Skips legacy complex skills with no files (handled by npx in entrypoint).
 * Binary files are skipped.
 * Stale swarm-managed skill directories are cleaned up.
 */
export function writeSkillsToFilesystem(
  entries: SkillFsEntry[],
  harnessType: SkillHarnessTarget = "all",
  home: string,
): SkillSyncResult {
  const errors: string[] = [];
  let synced = 0;
  let removed = 0;

  // Directories to write to
  const skillDirs: string[] = [];
  if (harnessType === "claude" || harnessType === "all") {
    skillDirs.push(join(home, ".claude", "skills"));
  }
  if (harnessType === "pi" || harnessType === "all") {
    skillDirs.push(join(home, ".pi", "agent", "skills"));
  }
  if (harnessType === "codex" || harnessType === "all") {
    skillDirs.push(join(home, ".codex", "skills"));
  }
  if (harnessType === "opencode" || harnessType === "all") {
    skillDirs.push(join(home, ".opencode", "skills"));
  }
  if (harnessType === "agents" || harnessType === "all") {
    skillDirs.push(join(home, ".agents", "skills"));
  }

  // Ensure base dirs exist
  for (const dir of skillDirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Track which skill names we write (for cleanup)
  const writtenNames = new Set<string>();

  for (const skill of entries) {
    if (!skill.isActive || !skill.isEnabled) continue;
    if (skill.isComplex && skill.files.length === 0) continue; // Legacy complex skills handled by npx
    if (!skill.content) continue;

    // Sanitize skill name to prevent path traversal (strip /, .., and non-safe chars)
    const safeName = skill.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeName) continue;

    writtenNames.add(safeName);
    const currentBundledFilePaths = new Set(
      skill.files.filter((file) => !file.isBinary).map((file) => file.path),
    );

    for (const baseDir of skillDirs) {
      const skillDir = join(baseDir, safeName);
      const skillFile = join(skillDir, "SKILL.md");
      const markerFile = join(skillDir, SWARM_MARKER_FILE);

      try {
        mkdirSync(skillDir, { recursive: true });
        removed += reconcileManagedSkillFiles(skillDir, currentBundledFilePaths);
        writeFileSync(skillFile, skill.content, "utf-8");
        writeFileSync(markerFile, "", "utf-8");
        synced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`${skill.name} -> ${skillDir}: ${msg}`);
        console.error(
          `[skill-fs-writer] Failed to write SKILL.md for ${skill.name} to ${skillDir}: ${msg}`,
        );
      }

      for (const file of skill.files) {
        if (file.isBinary) {
          console.log(`[skill-fs-writer] Skipping binary skill file ${skill.name}/${file.path}`);
          continue;
        }

        const targetPath = join(skillDir, file.path);
        try {
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, file.content, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`${skill.name}/${file.path} -> ${targetPath}: ${msg}`);
          console.error(
            `[skill-fs-writer] Failed to write bundled file ${skill.name}/${file.path} to ${targetPath}: ${msg}`,
          );
        }
      }
    }
  }

  // Cleanup: only remove directories WE previously created (marker file
  // present). Leaves user-installed personal skills alone — important on
  // local dev where ~/.codex/skills holds skills the user installed
  // outside the swarm.
  for (const baseDir of skillDirs) {
    if (!existsSync(baseDir)) continue;

    try {
      const existing = readdirSync(baseDir, { withFileTypes: true });
      for (const entry of existing) {
        if (!entry.isDirectory()) continue;
        if (writtenNames.has(entry.name)) continue;
        const skillDir = join(baseDir, entry.name);
        if (!existsSync(join(skillDir, SWARM_MARKER_FILE))) continue;
        try {
          rmSync(skillDir, { recursive: true, force: true });
          removed++;
        } catch {
          // Non-fatal — skip cleanup errors
        }
      }
    } catch {
      // Non-fatal — skip if we can't read the directory
    }
  }

  return { synced, removed, errors };
}
