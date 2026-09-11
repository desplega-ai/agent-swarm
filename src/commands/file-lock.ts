/**
 * Advisory cross-process lock backed by an exclusively created lock file.
 *
 * Used to make a multi-file state transition look atomic to other processes of
 * the same user — the Claude hook and the runner both rewrite `~/.claude/CLAUDE.md`
 * together with its lineage record, and a reader that lands between the two
 * writes can misjudge the file (see `claude-md-session.ts`).
 *
 * A holder that dies leaves its lock file behind, so a lock older than
 * `staleMs` is broken. Two waiters breaking the same stale lock at the same
 * instant could both acquire it — the price of not needing a lock daemon, and
 * only reachable after a holder died mid-transition.
 */

// Exclusive create (`wx`) has no Bun equivalent.
import { mkdir, open, stat, unlink } from "node:fs/promises";
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
  const info = await stat(lockPath).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > staleMs;
}

/** Run `fn` while holding the lock; `{ acquired: false }` if it never became free. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<FileLockResult<T>> {
  const { waitMs, staleMs, pollMs } = { ...DEFAULTS, ...options };
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
        await unlink(lockPath).catch(() => {});
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
    const current = await Bun.file(lockPath)
      .text()
      .catch(() => null);
    if (current === token) await unlink(lockPath).catch(() => {});
  }
}
