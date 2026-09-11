/**
 * Advisory cross-process lock backed by an exclusively created lock file.
 *
 * Makes a multi-file state transition look atomic to other processes of the
 * same user. First use: the Claude hook rewrites `~/.claude/CLAUDE.md` together
 * with its lineage record, and the hook and the runner read that pair — a reader
 * landing between the two writes can misjudge the file (see
 * `src/commands/claude-md-session.ts`).
 *
 * A holder that dies leaves its lock file behind, so a lock older than
 * `staleMs` is broken. Two waiters breaking the same stale lock at the same
 * instant could both acquire it — the price of not needing a lock daemon, and
 * only reachable after a holder died or outlived `staleMs`.
 */

// Exclusive create (`wx`) and directory creation have no Bun equivalents.
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  /** How long to wait for a held lock before giving up. */
  waitMs?: number;
  /** A lock file older than this is considered abandoned and broken. */
  staleMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
}

export type FileLockResult<T> = { acquired: true; value: T } | { acquired: false };

const DEFAULTS = { waitMs: 15_000, staleMs: 60_000, pollMs: 25 };

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  const info = await Bun.file(lockPath)
    .stat()
    .catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > staleMs;
}

/** Run `fn` while holding the lock; `{ acquired: false }` if it never became free. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<FileLockResult<T>> {
  // `??`, not a spread: an explicit `undefined` must not override a default
  // (a NaN deadline would wait forever).
  const waitMs = options.waitMs ?? DEFAULTS.waitMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;

  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStale(lockPath, staleMs)) {
        await Bun.file(lockPath)
          .delete()
          .catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return { acquired: false };
      await Bun.sleep(pollMs);
    }
  }

  try {
    return { acquired: true, value: await fn() };
  } finally {
    // Only release our own lock: if it was broken as stale, someone else holds it now.
    const lock = Bun.file(lockPath);
    const current = await lock.text().catch(() => null);
    if (current === token) await lock.delete().catch(() => {});
  }
}
