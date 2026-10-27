import type { Dirent } from "node:fs";
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Codex persists one `rollout-*.jsonl` per thread under `$CODEX_HOME/sessions`.
 * Sessions are started non-ephemeral (sub-agent spawns with `fork_context`
 * read the parent's rollout), so nothing deletes them. The adapter never
 * resumes a native thread, so old rollouts are dead weight: drop them once
 * they are older than this.
 */
export const CODEX_ROLLOUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Best-effort: never throws. Returns the number of rollout files removed. */
export async function pruneCodexRollouts(
  env: Record<string, string | undefined>,
  now = Date.now(),
  maxAgeMs = CODEX_ROLLOUT_RETENTION_MS,
): Promise<number> {
  const codexHome = env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : "");
  if (!codexHome) return 0;
  const root = join(codexHome, "sessions");
  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(path, depth + 1);
        // Only removes day/month/year dirs that are now empty.
        await rmdir(path).catch(() => {});
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          if (now - (await stat(path)).mtimeMs < maxAgeMs) continue;
          await unlink(path);
          removed += 1;
        } catch {
          // Raced with codex or already gone.
        }
      }
    }
  };
  await walk(root, 0);
  return removed;
}
