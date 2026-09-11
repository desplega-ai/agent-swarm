/**
 * Advisory cross-process lock held by the kernel: flock(2) on a lock file, via
 * `bun:ffi` (Bun and Node expose no flock).
 *
 * Makes a multi-file state transition exclusive across processes of the same
 * user. First use: the Claude hook rewrites `~/.claude/CLAUDE.md` together with
 * its lineage record, and the hook and the runner read that pair — a reader
 * landing between the two writes can misjudge the file (see
 * `src/commands/claude-md-session.ts`).
 *
 * Why the kernel and not a lock file with a staleness threshold: a threshold
 * cannot tell a slow holder (a stalled filesystem, a suspended process) from a
 * dead one, so it eventually lets a second process into a transition that is
 * still running. flock is released only when the holder closes its descriptor or
 * dies, so it can never be taken from a live holder and needs no breaking.
 *
 * The lock file is never deleted: unlinking a locked path would let a newcomer
 * create and lock a different inode while the old one is still held.
 */

import { dlopen, FFIType } from "bun:ffi";
// A file handle whose descriptor stays open while the lock is held has no Bun
// equivalent; neither does directory creation.
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;

type Flock = (fd: number, operation: number) => number;

const LIBC_CANDIDATES =
  process.platform === "darwin"
    ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];

let flockImpl: Flock | null | undefined;

function loadFlock(): Flock | null {
  if (flockImpl !== undefined) return flockImpl;
  flockImpl = null;
  for (const name of LIBC_CANDIDATES) {
    try {
      const { symbols } = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      flockImpl = (fd, operation) => symbols.flock(fd, operation);
      break;
    } catch {
      // try the next libc name
    }
  }
  return flockImpl;
}

export interface FileLockOptions {
  /** How long to wait for a held lock before giving up. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
}

export type FileLockResult<T> =
  | { acquired: true; value: T }
  /** `busy`: another live process holds it. `unsupported`: no flock on this platform. */
  | { acquired: false; reason: "busy" | "unsupported" };

/**
 * Run `fn` while holding the lock. Never runs `fn` without it: callers decide
 * what a `busy` or `unsupported` result means for them.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<FileLockResult<T>> {
  const flock = loadFlock();
  if (!flock) return { acquired: false, reason: "unsupported" };
  const waitMs = options.waitMs ?? 15_000;
  const pollMs = options.pollMs ?? 25;

  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "a");
  try {
    const deadline = Date.now() + waitMs;
    while (flock(handle.fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() >= deadline) return { acquired: false, reason: "busy" };
      await Bun.sleep(pollMs);
    }
    return { acquired: true, value: await fn() };
  } finally {
    await handle.close(); // closing the descriptor releases the lock
  }
}
