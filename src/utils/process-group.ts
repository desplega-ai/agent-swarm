import { readdirSync, readFileSync } from "node:fs";

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

/** Direct children by parent pid, from /proc on Linux and `ps` elsewhere. */
async function readParentMap(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>();
  const add = (pid: number, ppid: number) => {
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) return;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  };
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        // `pid (comm) S ppid ...`: comm may hold spaces and parentheses, so cut at the last `)`.
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        add(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      } catch {
        // The process exited while we scanned.
      }
    }
    return children;
  }
  const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    add(pid as number, ppid as number);
  }
  return children;
}

/** Every live descendant of `rootPid` by parent pid, including children that moved to their own session. */
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  const children = await readParentMap().catch(() => new Map<number, number[]>());
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Terminate a managed tree AND the descendants that left its process group.
 * Amp runs each shell command in a session of its own (`setsid`), so a group
 * kill leaves `sleep 300` running as an orphan of PID 1. The descendants are
 * listed first: once their parent dies they are reparented and unfindable.
 */
export async function terminateProcessTree(pid: number): Promise<void> {
  const descendants = await listDescendantPids(pid);
  await terminateProcessGroup(pid);
  await terminatePids(descendants);
}

/** SIGTERM each pid still alive, give it a short grace period, then SIGKILL survivors. */
export async function terminatePids(pids: Iterable<number>): Promise<void> {
  const signal = (target: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  const live = [...pids].filter((target) => signal(target, "SIGTERM"));
  if (live.length === 0) return;
  await Bun.sleep(PROCESS_GROUP_GRACE_MS);
  for (const target of live) if (signal(target, 0)) signal(target, "SIGKILL");
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
