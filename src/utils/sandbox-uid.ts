/**
 * Per-slot sandbox uids for every `buildSandboxedCommand` child.
 *
 * When the API runs as root, each sandboxed process runs as
 * `SCRIPT_SANDBOX_UID_BASE + slot` instead. Slots come from a fixed pool, so
 * two concurrent runs never share a uid: one run cannot signal, trace or read
 * another run's process or tmpdir, and `ulimit -u` (RLIMIT_NPROC, counted per
 * uid) applies per run.
 *
 * When the API is not root, `setpriv` is missing, or a test drop fails, the
 * lease is `null` and the child runs as the API's own uid, as before.
 */

export type SandboxUser = { uid: number; gid: number };

export type SandboxUidLease = {
  user: SandboxUser;
  /** Kill every process left under the uid, then return the slot. */
  release(): Promise<void>;
};

export const DEFAULT_SANDBOX_UID_BASE = 61000;
export const DEFAULT_SANDBOX_UID_POOL_SIZE = 64;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Lowest accepted base: the shared uid (`base - 1`) stays at 1000 or above. */
export const MIN_SANDBOX_UID_BASE = 1001;

/** At least 1001, so the shared uid (`base - 1`) can never be root or a system uid. */
export function sandboxUidBase(): number {
  const base = positiveInt(process.env.SCRIPT_SANDBOX_UID_BASE, DEFAULT_SANDBOX_UID_BASE);
  return base >= MIN_SANDBOX_UID_BASE ? base : DEFAULT_SANDBOX_UID_BASE;
}

export function sandboxUidPoolSize(): number {
  return Math.min(
    positiveInt(process.env.SCRIPT_SANDBOX_UID_POOL_SIZE, DEFAULT_SANDBOX_UID_POOL_SIZE),
    1024,
  );
}

/** argv prefix that drops the following command to `user`. */
export function setprivPrefix(user: SandboxUser): string[] {
  return [
    "setpriv",
    `--reuid=${user.uid}`,
    `--regid=${user.gid}`,
    "--clear-groups",
    "--no-new-privs",
  ];
}

async function exitCode(argv: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return -1;
  }
}

/**
 * `reaped`: leftover processes were killed. `empty`: none were left.
 * `failed`: the reaper did not run as the uid (spawn or drop failed), so
 * processes may survive and the uid must not be reused.
 */
export type ReapOutcome = "reaped" | "empty" | "failed";

const REAP_EMPTY_EXIT = 3;

/**
 * `kill -KILL -1` as `user` signals every process of that uid except itself.
 * It fails only with ESRCH (nothing to signal) under its own uid, which the
 * script reports as exit 3. Any other exit means the reaper itself failed.
 */
export async function reapUid(user: SandboxUser): Promise<ReapOutcome> {
  const code = await exitCode([
    ...setprivPrefix(user),
    "bash",
    "-c",
    `kill -KILL -1 2>/dev/null && exit 0; exit ${REAP_EMPTY_EXIT}`,
  ]);
  if (code === 0) return "reaped";
  if (code === REAP_EMPTY_EXIT) return "empty";
  return "failed";
}

export type SandboxUidPool = {
  lease(signal?: AbortSignal): Promise<SandboxUidLease>;
  inUse(): number;
  /** Slots held back because their reap failed. */
  quarantined(): number;
};

/** Delay before a quarantined slot's reap is retried. */
export const SANDBOX_UID_REAP_RETRY_MS = 30_000;

/**
 * A fixed pool of `size` uids starting at `base`. When every slot is taken,
 * `lease` waits for a release instead of sharing a uid, because a shared uid
 * would let one run read another and the release reap would kill the other
 * run. Concurrency is already capped well below the default pool size
 * (`SCRIPT_RUN_CONCURRENCY_CAP`, default 10).
 */
export function createSandboxUidPool(opts: {
  base: number;
  size: number;
  reap?: (user: SandboxUser) => Promise<ReapOutcome>;
  reapRetryMs?: number;
}): SandboxUidPool {
  const reap = opts.reap ?? reapUid;
  const reapRetryMs = opts.reapRetryMs ?? SANDBOX_UID_REAP_RETRY_MS;
  const used = new Set<number>();
  const quarantine = new Set<number>();
  const waiters: Array<() => void> = [];
  let cursor = 0;

  function wakeNext(): void {
    waiters.shift()?.();
  }

  async function tryReap(user: SandboxUser): Promise<boolean> {
    try {
      return (await reap(user)) !== "failed";
    } catch {
      return false;
    }
  }

  /**
   * Reap `slot`'s uid and free it only on success. On failure the slot stays
   * taken (quarantined) and the reap is retried later, so a uid that may
   * still run a process is never handed to another run.
   */
  async function reclaim(slot: number, user: SandboxUser): Promise<void> {
    if (await tryReap(user)) {
      quarantine.delete(slot);
      used.delete(slot);
      wakeNext();
      return;
    }
    if (!quarantine.has(slot)) {
      quarantine.add(slot);
      console.warn(
        `[sandbox-uid] Could not reap uid ${user.uid}; holding it back and retrying in ${reapRetryMs}ms`,
      );
    }
    const retry = setTimeout(() => void reclaim(slot, user), reapRetryMs);
    retry.unref?.();
  }

  function take(): number | undefined {
    for (let i = 0; i < opts.size; i++) {
      const slot = (cursor + i) % opts.size;
      if (!used.has(slot)) {
        used.add(slot);
        // Round-robin, so a just-released uid is the last one handed out.
        cursor = (slot + 1) % opts.size;
        return slot;
      }
    }
    return undefined;
  }

  async function lease(signal?: AbortSignal): Promise<SandboxUidLease> {
    signal?.throwIfAborted();
    let slot = take();
    while (slot === undefined) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (signal?.aborted) {
        // Woken for a freed slot after cancelling: pass the wake-up on.
        wakeNext();
        signal.throwIfAborted();
      }
      slot = take();
    }
    const taken = slot;
    const id = opts.base + taken;
    const user = { uid: id, gid: id };
    let released = false;
    return {
      user,
      // Never rejects: a failed reap quarantines the slot instead.
      async release() {
        if (released) return;
        released = true;
        await reclaim(taken, user);
      },
    };
  }

  return { lease, inUse: () => used.size, quarantined: () => quarantine.size };
}

let defaultPool: SandboxUidPool | undefined;
let dropCheck: Promise<boolean> | undefined;
let pinnedBase: number | undefined;

/**
 * The base read once per process. The pool, the drop check and the shared
 * workflow uid all use it, so a config reload that changes
 * `SCRIPT_SANDBOX_UID_BASE` cannot move the shared uid into the pool's range.
 * A new base takes effect on restart.
 */
export function activeSandboxUidBase(): number {
  pinnedBase ??= sandboxUidBase();
  return pinnedBase;
}

/** The fixed uid workflow inline `script` nodes share: one below the pool. */
export function sharedSandboxUser(): SandboxUser {
  const id = activeSandboxUidBase() - 1;
  return { uid: id, gid: id };
}

export function _resetSandboxUidStateForTests(): void {
  defaultPool = undefined;
  dropCheck = undefined;
  pinnedBase = undefined;
}

function apiIsRoot(): boolean {
  return process.platform === "linux" && process.getuid?.() === 0;
}

/**
 * Capabilities root needs to run a child under another uid and clean up
 * after it: CHOWN (hand over the tmpdir), DAC_OVERRIDE and FOWNER (read the
 * child's 0600 result files, delete its tmpdir), KILL (terminate and reap
 * its processes), SETGID and SETUID (the drop itself). Docker grants all six
 * by default.
 */
export const SANDBOX_UID_DROP_CAPS = {
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  FOWNER: 3,
  KILL: 5,
  SETGID: 6,
  SETUID: 7,
} as const;

/** Whether the `CapEff` line of /proc/self/status holds every needed capability. */
export function hasSandboxUidDropCaps(procStatus: string): boolean {
  const hex = /^CapEff:\s*([0-9a-f]+)$/im.exec(procStatus)?.[1];
  if (!hex) return false;
  const effective = BigInt(`0x${hex}`);
  return Object.values(SANDBOX_UID_DROP_CAPS).every((bit) => (effective >> BigInt(bit)) & 1n);
}

/**
 * Whether children can be dropped to a sandbox uid: the API is root with the
 * capabilities above, and one real `setpriv` drop to the base uid succeeds.
 * A root process missing one (for example a Helm pod with
 * `capabilities.drop: [ALL]`) keeps today's behavior. Checked once per process.
 */
export function sandboxUidDropAvailable(): Promise<boolean> {
  if (!apiIsRoot()) return Promise.resolve(false);
  dropCheck ??= (async () => {
    if (!Bun.which("setpriv")) return false;
    const status = await Bun.file("/proc/self/status")
      .text()
      .catch(() => "");
    if (!hasSandboxUidDropCaps(status)) return false;
    const base = activeSandboxUidBase();
    return (await exitCode([...setprivPrefix({ uid: base, gid: base }), "true"])) === 0;
  })();
  return dropCheck;
}

/**
 * Lease a sandbox uid for one sandboxed child, or `null` when uid drop is not
 * available. The caller must `chown` the child's working files to
 * `lease.user` before spawn and call `release()` after the child exits.
 */
export async function leaseSandboxUid(signal?: AbortSignal): Promise<SandboxUidLease | null> {
  if (!(await sandboxUidDropAvailable())) return null;
  defaultPool ??= createSandboxUidPool({
    base: activeSandboxUidBase(),
    size: sandboxUidPoolSize(),
  });
  return defaultPool.lease(signal);
}

/**
 * One fixed uid (`SCRIPT_SANDBOX_UID_BASE - 1`) for workflow inline `script`
 * nodes, or `null` when uid drop is not available. These nodes are authored
 * with the workflow and often reuse fixed `/tmp` paths across runs, which a
 * per-run uid could not overwrite (sticky `/tmp`). They keep today's shared
 * behavior, minus root. Release is a no-op: concurrent nodes share the uid,
 * so a reap would kill a sibling.
 */
export async function leaseSharedSandboxUid(): Promise<SandboxUidLease | null> {
  if (!(await sandboxUidDropAvailable())) return null;
  return { user: sharedSandboxUser(), release: async () => {} };
}

/**
 * Give `path` (recursively) to the sandbox uid so the child can use it, and
 * make it private to that uid. chown keeps modes, and an API started with
 * umask 022 creates 0755 dirs and 0644 files that another sandbox uid could read.
 */
export async function chownForSandbox(path: string, user: SandboxUser): Promise<void> {
  await Bun.$`chmod -R go= ${path}`.quiet();
  await Bun.$`chown -R ${user.uid}:${user.gid} ${path}`.quiet();
}
