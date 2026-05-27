/**
 * Filesystem sync for skills.
 *
 * Writes installed skills to ~/.claude/skills/<name>/SKILL.md,
 * ~/.pi/agent/skills/<name>/SKILL.md, and ~/.codex/skills/<name>/SKILL.md
 * so Claude Code, Pi, and Codex discover them natively.
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
 * Marker file written into every swarm-managed skill directory. Cleanup
 * only ever removes directories that contain this marker, so unrelated
 * personal skills the user installed via the harness's own tooling (e.g.
 * `codex skills add ...` writing into `~/.codex/skills/<name>/`) are left
 * untouched even when the API server shares a HOME with the worker (local
 * dev). See `~/.codex/skills` blast-radius note in PR #555.
 */
const SWARM_MARKER_FILE = ".swarm-managed";

/**
 * Sync agent's installed skills to the filesystem.
 *
 * For simple skills (content in DB): writes SKILL.md to ~/.claude/skills/<name>/
 * For complex skills (isComplex=true): skipped here (handled by npx in entrypoint)
 */
export async function syncSkillsToFilesystem(
  agentId: string,
  harnessType: "claude" | "pi" | "codex" | "all" = "all",
  homeOverride?: string,
): Promise<SkillSyncResult> {
  const skills = await getAgentSkills(agentId);
  const home = homeOverride ?? homedir();
  const errors: string[] = [];
  let synced = 0;

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

    // Sanitize skill name to prevent path traversal (strip /, .., and non-safe chars)
    const safeName = skill.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeName) continue;

    writtenNames.add(safeName);

    for (const baseDir of skillDirs) {
      const skillDir = join(baseDir, safeName);
      const skillFile = join(skillDir, "SKILL.md");
      const markerFile = join(skillDir, SWARM_MARKER_FILE);

      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillFile, skill.content, "utf-8");
        writeFileSync(markerFile, "", "utf-8");
        synced++;
      } catch (err) {
        errors.push(
          `${skill.name} -> ${skillDir}: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }

  // Cleanup: only remove directories WE previously created (marker file
  // present). Leaves user-installed personal skills alone — important on
  // local dev where ~/.codex/skills holds skills the user installed
  // outside the swarm.
  let removed = 0;
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
export async function computeAgentSkillsSignature(agentId: string): Promise<SkillsSignature> {
  const skills = await getAgentSkills(agentId);
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
