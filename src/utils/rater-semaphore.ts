/**
 * Host-level counting semaphore for memory-rater LLM subprocesses.
 *
 * Why a filesystem semaphore (not `p-limit`). Each Claude Code session's
 * Stop hook is a SEPARATE bun process — they don't share a JS heap, so a
 * per-process `p-limit` cannot see concurrent rater spawns from sibling
 * hooks on the same host. We observed in production ~26 concurrent
 * `claude -p --model haiku` subprocesses piling up at ~250 MiB each
 * across multiple sessions stopping in parallel on a memory-constrained
 * host (~15 GiB, no swap) — enough to contribute meaningfully to an OOM
 * cascade. That is exactly the cross-process fan-out p-limit can't address.
 *
 * Implementation: a counting semaphore via marker files in a shared tmp
 * directory. Before spawning, the rater path attempts to claim a free
 * slot by writing a uniquely-named file. If MAX slots are already taken
 * (after best-effort stale cleanup), the caller skips the rater rather
 * than queueing — Stop hooks must NEVER block session shutdown. The
 * worst-case race (two hooks simultaneously claim the last slot) is
 * bounded at MAX+1 rather than unbounded, which is the whole point.
 *
 * Stale locks (>staleMs old) are GC'd on every acquire attempt so a hook
 * killed mid-spawn doesn't permanently hold a slot.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default per-host concurrent-rater cap. 2 is the recommended starting point
 *  — tight enough to keep the 250-MiB-each haiku processes well under 1 GiB
 *  of hook overhead on a 15 GiB host, loose enough that bursty sessions can
 *  still get rated. Override via MEMORY_RATER_MAX_CONCURRENT env var. */
export const DEFAULT_MAX_CONCURRENT_RATERS = 2;

/** Default lock-staleness threshold. 120s is generous: the inner
 *  `claude -p` spawn has a 30s timeout (see `CLAUDE_CLI_TIMEOUT_MS` in
 *  `internal-ai/complete-structured.ts`); 120s covers retries and slow
 *  cleanup without holding the slot forever after a SIGKILL. */
export const DEFAULT_LOCK_STALE_MS = 120_000;

/** Default lock directory. `/tmp/agent-swarm-rater-locks` lives on tmpfs in
 *  most container deploys and is cleared on host reboot, so we don't carry
 *  stale state across container restarts. */
function defaultLockDir(): string {
  return join(tmpdir(), "agent-swarm-rater-locks");
}

export interface AcquireOptions {
  /** Max concurrent slots across all callers on this host. Default 2. */
  max?: number;
  /** Lock age (ms) past which a slot is considered abandoned and reclaimed. */
  staleMs?: number;
  /** Override the lock directory (tests). */
  dir?: string;
}

export interface RaterSlot {
  /** Best-effort release. Idempotent — safe to call from a `finally`. */
  release: () => void;
  /** Absolute lock-file path (exposed for tests). */
  path: string;
}

function readMaxFromEnv(envValue: string | undefined): number {
  if (!envValue) return DEFAULT_MAX_CONCURRENT_RATERS;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT_RATERS;
  return parsed;
}

/**
 * Try to claim a rater slot. Returns a {@link RaterSlot} on success or
 * `null` when the semaphore is full (caller should skip the rater).
 *
 * Never throws — filesystem errors degrade to `null` so a wedged tmpfs
 * can't take down session shutdown.
 */
export function acquireRaterSlot(opts: AcquireOptions = {}): RaterSlot | null {
  const max = opts.max ?? readMaxFromEnv(process.env.MEMORY_RATER_MAX_CONCURRENT);
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const dir = opts.dir ?? defaultLockDir();

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // GC stale locks first so a SIGKILL-orphaned slot doesn't permanently
    // reduce capacity.
    const now = Date.now();
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((e) => e.startsWith("lock-"));
    } catch {
      entries = [];
    }

    const alive: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > staleMs) {
          try {
            unlinkSync(full);
          } catch {
            // already gone — fine
          }
        } else {
          alive.push(entry);
        }
      } catch {
        // stat failed — lock vanished, ignore
      }
    }

    if (alive.length >= max) {
      return null;
    }

    // Claim a slot. O_EXCL via `wx` rules out two callers picking the
    // same name; the random suffix makes that ~impossible anyway.
    const name = `lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const lockPath = join(dir, name);
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    } catch {
      return null;
    }

    let released = false;
    return {
      path: lockPath,
      release: () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort API health probe. Returns `true` only when `GET ${apiUrl}/health`
 * answers 2xx within {@link timeoutMs}. Used as back-pressure on the rater
 * path — when the control plane is down, fanning out more LLM work just
 * makes the host's recovery harder.
 *
 * Never throws. AbortController + setTimeout fallback so a stalled
 * connection doesn't hang the Stop hook waiting for default fetch timeouts.
 */
export async function isApiHealthy(opts: {
  apiUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${opts.apiUrl}/health`, {
      signal: controller.signal,
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
