import { existsSync, constants as fsConstants } from "node:fs";
import { chown, lstat, mkdir, open, rm, symlink } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detachedProcessGroup,
  registerProcessGroup,
  terminateProcessGroup,
} from "../../utils/process-group";
import {
  buildSandboxedCommand,
  readStreamCapped,
  resolveSandboxIdentity,
  type SandboxIdentity,
  sandboxSpawnEnv,
} from "../../utils/sandboxed-process";
import type { ExecutorInput, ExecutorOutput, ScriptExecutor, ScriptExecutorError } from "./types";

function makeUnsupportedOutput(stderr: string): ExecutorOutput {
  return {
    result: undefined,
    stdout: "",
    stderr,
    truncated: { stdout: false, stderr: false },
    durationMs: 0,
    exitCode: 1,
    error: "executor_error",
  };
}

/**
 * Exit 134 is SIGABRT. The framework code that runs before user code gets
 * control never calls `abort()` itself, so a SIGABRT observed before that
 * point is the runtime's own C++ layer aborting because it could not create
 * a thread (pthread_create failing under an already-exhausted RLIMIT_NPROC)
 * — a host-capacity fault, not a bug in the user script. See
 * `JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS` in `../../utils/sandboxed-process.ts`
 * for the shared-limit mechanism.
 *
 * That guarantee does NOT extend past the point user-authored code starts
 * running: `process.abort()`, a native assertion, or an OOM abort can also
 * exit 134, and by then the script may already have caused an external side
 * effect (e.g. an API POST). Retrying that case would silently replay it.
 * `userCodeStarted` (backed by the sentinel file `eval-harness.ts` writes
 * immediately before importing the user module) is what tells the two
 * apart — see `runScript`'s retry loop in `../loader.ts`.
 *
 * 134 is checked before `timedOut`/`killed` below, and wins unconditionally.
 * Both of our own termination paths (the wall-clock watchdog and an external
 * `input.signal` abort) start process-group teardown with SIGTERM (exit 143)
 * and escalate survivors to SIGKILL (exit 137) after a short grace period.
 * Neither path can produce SIGABRT (134, signal 6), so an observed 134 can
 * only be the process's own abort. Under load, teardown can race a self-abort
 * that has started but whose exit has not been recorded yet; if SIGKILL wins,
 * Bun observes 137 and a watchdog-triggered run is classified `timeout`
 * instead of `eval_error`. Once Bun records 134, this branch preserves it
 * even if the watchdog callback also flips `timedOut` before `proc.exited`
 * resolves.
 */
const SANDBOX_CAPACITY_EXIT_CODE = 134;

export function classifyExit(
  exitCode: number,
  timedOut: boolean,
  killed: boolean,
  userCodeStarted: boolean,
): ScriptExecutorError | undefined {
  if (exitCode === SANDBOX_CAPACITY_EXIT_CODE) {
    return userCodeStarted ? "eval_error" : "capacity_exceeded";
  }
  if (timedOut) return "timeout";
  if (killed) return "killed";
  if (exitCode === 0) return undefined;
  if (exitCode === 137 || exitCode === 9) return "killed";
  return "eval_error";
}

/** Constraints on a file the script child wrote into its run dir. */
export interface RunDirFileCheck {
  /** Largest file accepted, in bytes. */
  maxBytes: number;
  /** Required owner uid; set when the child runs under a dropped identity. */
  ownerUid?: number;
}

// Missing flags (win32) fall back to 0, which leaves the open unchanged.
const RUN_DIR_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Reads a file the script child controls. The child can replace it with a
 * symlink, a hard link, a FIFO or an oversized file, so the API must not read
 * it by path: open without following links (non-blocking, so a FIFO cannot
 * stall the open), then require a regular file, the expected owner and a size
 * within the cap on the opened descriptor. Anything else reads as absent.
 */
export async function readRunDirFile(
  path: string,
  check: RunDirFileCheck,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, RUN_DIR_OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (check.ownerUid !== undefined && stat.uid !== check.ownerUid) return undefined;
    if (stat.size > check.maxBytes) return undefined;
    // A surviving group member can still append: read one byte past the stat
    // size and treat a file that changed under the read as absent.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) return undefined;
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

/** Whether anything exists at `path`, without following a final symlink. */
async function runDirEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readResultFile(path: string, check: RunDirFileCheck): Promise<unknown | undefined> {
  const text = await readRunDirFile(path, check);
  if (!text) return undefined;
  return JSON.parse(text);
}

async function readRuntimeError(
  path: string,
  check: RunDirFileCheck,
): Promise<import("./types").ScriptRuntimeError | undefined> {
  const text = await readRunDirFile(path, check);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as import("./types").ScriptRuntimeError;
  } catch {
    return undefined;
  }
}

export async function writeBareImportShim(
  tmpdir: string,
  name: string,
  targetUrl: URL,
): Promise<void> {
  const dir = `${tmpdir}/node_modules/${name}`;
  await mkdir(dir, { recursive: true });
  await Promise.all([
    Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.ts" })),
    Bun.write(`${dir}/index.ts`, `export * from ${JSON.stringify(targetUrl.href)};\n`),
  ]);
}

let cachedDevTargets: Array<[string, URL]> | undefined;

function getDevBareImportTargets(): Array<[string, URL]> {
  if (!cachedDevTargets) {
    cachedDevTargets = [
      ["stdlib", new URL("../stdlib/index.ts", import.meta.url)],
      ["swarm-sdk", new URL("../swarm-sdk.ts", import.meta.url)],
      ["zod", pathToFileURL(Bun.resolveSync("zod", import.meta.dir))],
      ["zod/mini", pathToFileURL(Bun.resolveSync("zod/mini", import.meta.dir))],
    ];
  }
  return cachedDevTargets;
}

export async function writeBareImportShims(tmpdir: string): Promise<void> {
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR;
  if (runtimeDir) {
    // Compiled binary mode: use pre-built bundles on real filesystem.
    // import.meta.url resolves to /$bunfs/ which spawned subprocesses can't access.
    const shims: [string, string][] = [
      ["stdlib", `${runtimeDir}/stdlib.bundle.js`],
      ["swarm-sdk", `${runtimeDir}/swarm-sdk.bundle.js`],
      ["zod", `${runtimeDir}/zod.bundle.js`],
      ["zod/mini", `${runtimeDir}/zod-mini.bundle.js`],
    ];
    await Promise.all(
      shims.map(async ([name, bundlePath]) => {
        const dir = `${tmpdir}/node_modules/${name}`;
        await mkdir(dir, { recursive: true });
        await Promise.all([
          Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.js" })),
          Bun.write(
            `${dir}/index.js`,
            `export * from ${JSON.stringify(pathToFileURL(bundlePath).href)};\n`,
          ),
        ]);
      }),
    );
    return;
  }
  await Promise.all(
    getDevBareImportTargets().map(([name, url]) => writeBareImportShim(tmpdir, name, url)),
  );
}

const sharedShimDirPromises = new Map<string, Promise<string>>();

async function getSharedNodeModulesDir(baseTmpDir: string): Promise<string> {
  const runtimeDir = process.env.SCRIPT_RUNTIME_DIR ?? "";
  const cacheKey = `${baseTmpDir}::${runtimeDir}`;
  const existing = sharedShimDirPromises.get(cacheKey);
  if (existing) {
    const dir = await existing;
    if (existsSync(`${dir}/zod/package.json`)) return dir;
    sharedShimDirPromises.delete(cacheKey);
  }
  const initPromise = (async () => {
    const rootHash = Bun.hash(runtimeDir || "dev").toString(36);
    const sharedRoot = `${baseTmpDir}/swarm-script-shims-${process.pid}-${rootHash}`;
    await writeBareImportShims(sharedRoot);
    return `${sharedRoot}/node_modules`;
  })();
  sharedShimDirPromises.set(cacheKey, initPromise);
  try {
    return await initPromise;
  } catch (err) {
    sharedShimDirPromises.delete(cacheKey);
    throw err;
  }
}

async function linkOrWriteBareImportShims(baseTmpDir: string, tmpdir: string): Promise<void> {
  try {
    const sharedNodeModules = await getSharedNodeModulesDir(baseTmpDir);
    await symlink(sharedNodeModules, `${tmpdir}/node_modules`, "junction");
  } catch {
    await writeBareImportShims(tmpdir);
  }
}

/**
 * Everything that shapes a harness process before it reads its run config:
 * the sandbox command, its limits, identity and environment. Two runs with an
 * equal spec can use the same kind of pre-started process.
 */
type HarnessSpec = {
  baseTmpDir: string;
  harnessPath: string;
  runtimeDir: string | null;
  runAs: SandboxIdentity | null;
  limits: {
    virtualMemoryMb: number;
    cpuTimeSec: number;
    maxProcs: number;
    maxFileKb: number;
    maxFdCount: number;
  };
  hostValidatedArgs: boolean;
  env: { PATH: string; HOME: string | null; LANG: string; LC_ALL: string };
};

function harnessSpecFor(input: ExecutorInput): HarnessSpec {
  const runAs = resolveSandboxIdentity();
  return {
    baseTmpDir: process.env.TMPDIR ?? (process.platform === "win32" ? osTmpdir() : "/tmp"),
    // In compiled binary mode, import.meta.url points into /$bunfs/ which spawned
    // subprocesses cannot access. Use the pre-built bundle from real filesystem instead.
    harnessPath: process.env.SCRIPT_RUNTIME_DIR
      ? `${process.env.SCRIPT_RUNTIME_DIR}/eval-harness.bundle.js`
      : fileURLToPath(new URL("../eval-harness.ts", import.meta.url)),
    runtimeDir: process.env.SCRIPT_RUNTIME_DIR ?? null,
    runAs: runAs ? { uid: runAs.uid, gid: runAs.gid } : null,
    limits: {
      virtualMemoryMb: input.resources.memoryMb,
      cpuTimeSec: input.resources.cpuTimeSec,
      maxProcs: input.resources.maxProcs,
      maxFileKb: Math.floor(input.resources.maxFileBytes / 1024),
      maxFdCount: input.resources.maxFdCount,
    },
    hostValidatedArgs: input.hostValidatedArgs === true,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      // The dropped identity cannot use the API's HOME; null means the run dir.
      HOME: runAs ? null : (process.env.HOME ?? "/tmp"),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    },
  };
}

/** A sandboxed harness process that has loaded its modules and waits on stdin for its run. */
type StartedHarness = {
  tmpdir: string;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  argsFile: string;
  sourceFile: string;
  resultFile: string;
  errorFile: string;
  startedFile: string;
};

/**
 * Create a fresh run dir and start the harness in it. The harness imports its
 * runtime (most of a run's fixed cost), then blocks on stdin: it reads the
 * config payload first and the args and source files only after that, so the
 * caller writes those files and the payload once the run is known. No user
 * code runs before the payload arrives.
 */
async function startHarness(spec: HarnessSpec): Promise<StartedHarness> {
  const tmpdir = `${spec.baseTmpDir}/swarm-script-${crypto.randomUUID()}`;
  // The user module lives in a subdir that exists before launch: Bun snapshots
  // the cwd listing at startup, but not the listing of this subdir.
  await mkdir(`${tmpdir}/user-module`, { recursive: true });
  try {
    await linkOrWriteBareImportShims(spec.baseTmpDir, tmpdir);
    if (spec.runAs) {
      const { uid, gid } = spec.runAs;
      // The child writes its result and marker files into the run dir.
      await Promise.all([tmpdir, `${tmpdir}/user-module`].map((path) => chown(path, uid, gid)));
    }
    const files = {
      argsFile: `${tmpdir}/args.json`,
      sourceFile: `${tmpdir}/user-module/user-script.ts`,
      resultFile: `${tmpdir}/result.json`,
      errorFile: `${tmpdir}/error.json`,
      startedFile: `${tmpdir}/started.marker`,
    };
    const harnessEnv: Record<string, string> = {
      PATH: spec.env.PATH,
      HOME: spec.env.HOME ?? tmpdir,
      LANG: spec.env.LANG,
      LC_ALL: spec.env.LC_ALL,
      TMPDIR: tmpdir,
      SWARM_SCRIPT_TMPDIR: tmpdir,
      SWARM_SCRIPT_ARGS_FILE: files.argsFile,
      SWARM_SCRIPT_SOURCE_FILE: files.sourceFile,
      SWARM_SCRIPT_RESULT_FILE: files.resultFile,
      SWARM_SCRIPT_ERROR_FILE: files.errorFile,
      SWARM_SCRIPT_STARTED_FILE: files.startedFile,
      ...(spec.hostValidatedArgs ? { SWARM_SCRIPT_HOST_VALIDATED_ARGS: "1" } : {}),
    };
    const proc = registerProcessGroup(
      Bun.spawn(
        buildSandboxedCommand(
          ["bun", "run", spec.harnessPath],
          harnessEnv,
          spec.limits,
          "inline",
          spec.runAs ?? undefined,
        ),
        {
          // On POSIX, Bun.spawn only needs PATH itself to locate the `sh`
          // binary for argv[0] — the sandboxed command's `env -i` prelude is
          // what actually scrubs the child's environment down to `harnessEnv`
          // above. On win32 there is no such prelude, so `sandboxSpawnEnv`
          // passes `harnessEnv` through directly instead — see
          // `buildSandboxedCommand`'s win32 doc comment.
          env: sandboxSpawnEnv(harnessEnv),
          cwd: tmpdir,
          detached: detachedProcessGroup,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    return { tmpdir, proc, ...files };
  } catch (error) {
    await rm(tmpdir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * How long a pre-started harness may wait for a run before it is stopped. It
 * holds a bun process (tens of MB) and uses no CPU while it waits.
 */
const PRESTARTED_IDLE_MS = 120_000;
/** Distinct harness specs that keep a pre-started process; others start cold. */
const PRESTARTED_MAX_SPECS = 4;

type Prestarted = {
  harness: Promise<StartedHarness | null>;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const prestarted = new Map<string, Prestarted>();

async function discardHarness(harness: StartedHarness): Promise<void> {
  harness.proc.stdin.end();
  await terminateProcessGroup(harness.proc.pid);
  await rm(harness.tmpdir, { recursive: true, force: true });
}

/**
 * Start one harness for `spec` in the background, so the next run with the
 * same spec skips bun startup and module loading. Each process serves exactly
 * one run and is never reused, so runs stay isolated as before.
 */
function prestartHarness(key: string, spec: HarnessSpec): void {
  if (prestarted.has(key) || prestarted.size >= PRESTARTED_MAX_SPECS) return;
  const entry: Prestarted = {
    harness: startHarness(spec).then(
      (harness) => {
        // A waiting harness must not keep the API (or a test process) alive.
        harness.proc.unref();
        if (prestarted.get(key) !== entry) {
          void discardHarness(harness).catch(() => {});
          return null;
        }
        entry.idleTimer = setTimeout(() => {
          if (prestarted.get(key) !== entry) return;
          prestarted.delete(key);
          void discardHarness(harness).catch(() => {});
        }, PRESTARTED_IDLE_MS);
        entry.idleTimer.unref?.();
        return harness;
      },
      () => {
        if (prestarted.get(key) === entry) prestarted.delete(key);
        return null;
      },
    ),
  };
  prestarted.set(key, entry);
}

/** Take the pre-started harness for `key` if one is ready and still waiting. */
async function takePrestartedHarness(key: string): Promise<StartedHarness | null> {
  const entry = prestarted.get(key);
  if (!entry) return null;
  prestarted.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const harness = await entry.harness;
  if (!harness) return null;
  if (harness.proc.exitCode !== null || harness.proc.signalCode !== null || harness.proc.killed) {
    void discardHarness(harness).catch(() => {});
    return null;
  }
  harness.proc.ref();
  return harness;
}

export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = "native";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === "workspace-rw") {
      return makeUnsupportedOutput("workspace-rw not supported by native executor in v1");
    }

    const start = Date.now();
    const spec = harnessSpecFor(input);
    const specKey = JSON.stringify(spec);
    let timedOut = false;
    let killed = input.signal?.aborted ?? false;
    let removeAbortListener: (() => void) | undefined;
    let harness: StartedHarness | null = null;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

    const killedOutput = (): ExecutorOutput => ({
      result: undefined,
      stdout: "",
      stderr: "",
      truncated: { stdout: false, stderr: false },
      durationMs: Date.now() - start,
      exitCode: 1,
      error: "killed",
    });

    try {
      if (killed) return killedOutput();

      // Listen before the first await: an abort while the harness starts or the
      // run files are written must stop the run before its payload is sent.
      const onExternalAbort = () => {
        killed = true;
        if (proc) void terminateProcessGroup(proc.pid);
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", onExternalAbort);

      // A harness started ahead for this spec has already paid bun startup and
      // module loading. Either way, start one for the next run in the background.
      harness = (await takePrestartedHarness(specKey)) ?? (await startHarness(spec));
      proc = harness.proc;
      prestartHarness(specKey, spec);
      if (killed) return killedOutput();

      const { argsFile, sourceFile, resultFile, errorFile, startedFile } = harness;
      await Promise.all([
        Bun.write(argsFile, JSON.stringify(input.args ?? null)),
        Bun.write(sourceFile, input.source),
      ]);
      if (spec.runAs) {
        const { uid, gid } = spec.runAs;
        await Promise.all([argsFile, sourceFile].map((path) => chown(path, uid, gid)));
      }

      // No await between this check and the payload write below: the harness
      // runs nothing of the script before it reads the payload.
      if (killed) return killedOutput();

      const timeout = setTimeout(() => {
        timedOut = true;
        if (proc) void terminateProcessGroup(proc.pid);
      }, input.resources.wallClockMs);

      proc.stdin.write(JSON.stringify(input.configPayload));
      proc.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamCapped(proc.stdout, input.resources.maxStdoutBytes),
        readStreamCapped(proc.stderr, input.resources.maxStdoutBytes),
        proc.exited.catch(() => (timedOut ? 124 : 1)),
      ]).finally(() => clearTimeout(timeout));
      // The child owns the run dir: read its files only through the checked reader.
      const runDirCheck: RunDirFileCheck = {
        // ulimit -f already bounds what the child can write.
        maxBytes: input.resources.maxFileBytes,
        ...(spec.runAs ? { ownerUid: spec.runAs.uid } : {}),
      };
      const result = exitCode === 0 ? await readResultFile(resultFile, runDirCheck) : undefined;
      const runtimeError =
        exitCode === 0 ? undefined : await readRuntimeError(errorFile, runDirCheck);
      // Presence only; anything at the path (even a planted link) reads as started,
      // the conservative side for retry safety.
      const userCodeStarted = await runDirEntryExists(startedFile);
      const error = classifyExit(exitCode, timedOut, killed, userCodeStarted);

      return {
        result,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
        durationMs: Date.now() - start,
        exitCode,
        ...(error ? { error } : {}),
        ...(runtimeError ? { runtimeError } : {}),
      };
    } catch (error) {
      return {
        result: undefined,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: { stdout: false, stderr: false },
        durationMs: Date.now() - start,
        exitCode: 1,
        error: timedOut ? "timeout" : killed ? "killed" : "executor_error",
      };
    } finally {
      removeAbortListener?.();
      if (proc) await terminateProcessGroup(proc.pid);
      if (harness) await rm(harness.tmpdir, { recursive: true, force: true });
    }
  }
}
