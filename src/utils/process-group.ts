const PROCESS_GROUP_GRACE_MS = 250;

type SpawnedProcess = {
  pid: number;
  exited: Promise<number>;
};

const liveProcessGroups = new Set<number>();
const terminations = new Map<number, Promise<void>>();

function signalPid(pid: number, signal: NodeJS.Signals | 0): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Send one signal to the whole child tree (or the direct PID on Windows). */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  return signalPid(pid, signal);
}

/** Bun spawn option that gives each managed child its own POSIX process group. */
export const detachedProcessGroup = process.platform !== "win32";

/**
 * Register a detached child for normal-exit and process-exit cleanup.
 * The exited watcher is necessary because a grandchild can keep the group alive
 * after its leader has returned normally.
 */
export function registerProcessGroup<T extends SpawnedProcess>(proc: T): T {
  if (proc.pid <= 0) return proc;
  liveProcessGroups.add(proc.pid);
  void proc.exited
    .then(
      () => terminateProcessGroup(proc.pid),
      () => terminateProcessGroup(proc.pid),
    )
    .catch(() => {});
  return proc;
}

/** SIGTERM a managed tree, give it a short grace period, then SIGKILL survivors. */
export function terminateProcessGroup(pid: number): Promise<void> {
  const pending = terminations.get(pid);
  if (pending) return pending;

  const termination = Promise.resolve().then(async () => {
    try {
      if (!signalPid(pid, "SIGTERM")) return;
      await Bun.sleep(PROCESS_GROUP_GRACE_MS);
      if (signalPid(pid, 0)) signalPid(pid, "SIGKILL");
    } finally {
      liveProcessGroups.delete(pid);
      terminations.delete(pid);
    }
  });
  terminations.set(pid, termination);
  return termination;
}

/** Immediately kill a managed tree, used by hard timeout paths and exit hooks. */
export function forceTerminateProcessGroup(pid: number): void {
  try {
    signalPid(pid, "SIGKILL");
  } finally {
    liveProcessGroups.delete(pid);
    terminations.delete(pid);
  }
}

/** Drain every registered group during graceful runner shutdown. */
export async function terminateRegisteredProcessGroups(): Promise<void> {
  await Promise.allSettled([...liveProcessGroups].map((pid) => terminateProcessGroup(pid)));
}

/** A synchronous last line of defence for uncaught exceptions and explicit process.exit(). */
function forceTerminateRegisteredProcessGroups(): void {
  for (const pid of liveProcessGroups) {
    try {
      forceTerminateProcessGroup(pid);
    } catch {
      // Process exit must continue even if a child can no longer be signalled.
    }
  }
}

process.once("exit", forceTerminateRegisteredProcessGroups);
