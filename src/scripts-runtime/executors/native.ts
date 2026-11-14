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

type HarnessProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/** Everything a harness spawn depends on, apart from its run dir. */
interface HarnessSpec {
  harnessPath: string;
  baseTmpDir: string;
  runAs: SandboxIdentity | undefined;
  hostValidatedArgs: boolean;
  resources: ExecutorInput["resources"];
}

function harnessRunPaths(tmpdir: string) {
  return {
    argsFile: `${tmpdir}/args.json`,
    sourceFile: `${tmpdir}/user-module/user-script.ts`,
    resultFile: `${tmpdir}/result.json`,
    errorFile: `${tmpdir}/error.json`,
    startedFile: `${tmpdir}/started.marker`,
  };
}

function harnessEnvFor(spec: HarnessSpec, tmpdir: string): Record<string, string> {
  const paths = harnessRunPaths(tmpdir);
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    // The dropped identity cannot use the API's HOME.
    HOME: spec.runAs ? tmpdir : (process.env.HOME ?? "/tmp"),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TMPDIR: tmpdir,
    SWARM_SCRIPT_TMPDIR: tmpdir,
    SWARM_SCRIPT_ARGS_FILE: paths.argsFile,
    SWARM_SCRIPT_SOURCE_FILE: paths.sourceFile,
    SWARM_SCRIPT_RESULT_FILE: paths.resultFile,
    SWARM_SCRIPT_ERROR_FILE: paths.errorFile,
    SWARM_SCRIPT_STARTED_FILE: paths.startedFile,
    ...(spec.hostValidatedArgs ? { SWARM_SCRIPT_HOST_VALIDATED_ARGS: "1" } : {}),
  };
}

function spawnHarness(spec: HarnessSpec, tmpdir: string): HarnessProcess {
  const harnessEnv = harnessEnvFor(spec, tmpdir);
  const limits = {
    virtualMemoryMb: spec.resources.memoryMb,
    cpuTimeSec: spec.resources.cpuTimeSec,
    maxProcs: spec.resources.maxProcs,
    maxFileKb: Math.floor(spec.resources.maxFileBytes / 1024),
    maxFdCount: spec.resources.maxFdCount,
  };
  return registerProcessGroup(
    Bun.spawn(
      buildSandboxedCommand(
        ["bun", "run", spec.harnessPath],
        harnessEnv,
        limits,
        "inline",
        spec.runAs,
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
}

/**
 * Warm harness pool. A harness spends most of a short run loading its own
 * modules (ctx, SDK, zod) before it reads the config payload from stdin, and
 * none of that depends on the run. So after each spawn the executor starts
 * one spare harness with the same spec in a fresh run dir; it loads and then
 * blocks on stdin. The next run with that spec writes its args and source
 * into the spare's run dir and sends the payload, skipping spawn and module
 * load. The script itself still runs once per call, in its own process, with
 * the same env, limits and identity, so outputs and side effects are those of
 * a cold run. A spare holds no credentials (they arrive on stdin), is
 * single-use, and is stopped after WARM_IDLE_MS unused.
 *
 * The user module dir is created only after the spare has started: Bun
 * snapshots the cwd listing at startup, and a subdir created later is
 * resolved from disk (see the note above `userModulePath` in eval-harness.ts).
 */
interface WarmHarness {
  key: string;
  tmpdir: string;
  proc: HarnessProcess;
  idleTimer: ReturnType<typeof setTimeout>;
}

const WARM_IDLE_MS = 30_000;
const MAX_WARM_SPECS = 4;
const warmHarnesses = new Map<string, WarmHarness>();
const warmingSpecs = new Set<string>();

function harnessSpecKey(spec: HarnessSpec): string {
  return JSON.stringify([
    spec.harnessPath,
    spec.baseTmpDir,
    spec.runAs ?? null,
    spec.hostValidatedArgs,
    spec.resources.memoryMb,
    spec.resources.cpuTimeSec,
    spec.resources.maxProcs,
    spec.resources.maxFileBytes,
    spec.resources.maxFdCount,
    process.env.PATH ?? null,
    process.env.HOME ?? null,
    process.env.LANG ?? null,
    process.env.LC_ALL ?? null,
  ]);
}

function harnessAlive(proc: HarnessProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null && !proc.killed;
}

function discardWarmHarness(entry: WarmHarness): void {
  clearTimeout(entry.idleTimer);
  if (warmHarnesses.get(entry.key) === entry) warmHarnesses.delete(entry.key);
  void terminateProcessGroup(entry.proc.pid)
    .catch(() => {})
    .finally(() => rm(entry.tmpdir, { recursive: true, force: true }).catch(() => {}));
}

/** Removes and returns the spare for `key` when it is still waiting on stdin. */
function takeWarmHarness(key: string): WarmHarness | undefined {
  const entry = warmHarnesses.get(key);
  if (!entry) return undefined;
  warmHarnesses.delete(key);
  clearTimeout(entry.idleTimer);
  if (!harnessAlive(entry.proc)) {
    discardWarmHarness(entry);
    return undefined;
  }
  entry.proc.ref();
  return entry;
}

async function startWarmHarness(key: string, spec: HarnessSpec): Promise<void> {
  if (process.platform === "win32") return;
  if (warmHarnesses.has(key) || warmingSpecs.has(key)) return;
  warmingSpecs.add(key);
  const tmpdir = `${spec.baseTmpDir}/swarm-script-${crypto.randomUUID()}`;
  let started = false;
  try {
    await mkdir(tmpdir, { recursive: true });
    await linkOrWriteBareImportShims(spec.baseTmpDir, tmpdir);
    if (spec.runAs) await chown(tmpdir, spec.runAs.uid, spec.runAs.gid);
    if (warmHarnesses.has(key)) return;
    const proc = spawnHarness(spec, tmpdir);
    // A spare must not keep the API (or a CLI / test process) alive.
    proc.unref();
    started = true;
    const entry: WarmHarness = {
      key,
      tmpdir,
      proc,
      idleTimer: setTimeout(() => discardWarmHarness(entry), WARM_IDLE_MS),
    };
    entry.idleTimer.unref?.();
    if (warmHarnesses.size >= MAX_WARM_SPECS) {
      const oldest = warmHarnesses.values().next().value;
      if (oldest) discardWarmHarness(oldest);
    }
    warmHarnesses.set(key, entry);
    void proc.exited.then(
      () => {
        if (warmHarnesses.get(key) === entry) discardWarmHarness(entry);
      },
      () => {},
    );
  } catch {
    // Best-effort: the next run spawns cold.
  } finally {
    warmingSpecs.delete(key);
    if (!started) await rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = "native";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === "workspace-rw") {
      return makeUnsupportedOutput("workspace-rw not supported by native executor in v1");
    }

    const start = Date.now();
    const baseTmpDir = process.env.TMPDIR ?? (process.platform === "win32" ? osTmpdir() : "/tmp");
    const runAs = resolveSandboxIdentity();
    // In compiled binary mode, import.meta.url points into /$bunfs/ which spawned
    // subprocesses cannot access. Use the pre-built bundle from real filesystem instead.
    const harnessPath = process.env.SCRIPT_RUNTIME_DIR
      ? `${process.env.SCRIPT_RUNTIME_DIR}/eval-harness.bundle.js`
      : fileURLToPath(new URL("../eval-harness.ts", import.meta.url));
    const spec: HarnessSpec = {
      harnessPath,
      baseTmpDir,
      runAs,
      hostValidatedArgs: Boolean(input.hostValidatedArgs),
      resources: input.resources,
    };
    const specKey = harnessSpecKey(spec);
    let timedOut = false;
    let killed = input.signal?.aborted ?? false;
    let removeAbortListener: (() => void) | undefined;
    let proc: HarnessProcess | undefined;

    const killedOutput = (): ExecutorOutput => ({
      result: undefined,
      stdout: "",
      stderr: "",
      truncated: { stdout: false, stderr: false },
      durationMs: Date.now() - start,
      exitCode: 1,
      error: "killed",
    });

    if (killed) return killedOutput();

    const warm = takeWarmHarness(specKey);
    const tmpdir = warm?.tmpdir ?? `${baseTmpDir}/swarm-script-${crypto.randomUUID()}`;
    const { argsFile, sourceFile, resultFile, errorFile, startedFile } = harnessRunPaths(tmpdir);
    // A taken spare is this run's process from here on: an abort or error
    // below terminates it and removes its run dir like a cold child's.
    if (warm) proc = warm.proc;

    try {
      // Listen before the first await: an abort during the file writes below
      // must stop the spawn, not land between the writes and the listener.
      const onExternalAbort = () => {
        killed = true;
        if (proc) void terminateProcessGroup(proc.pid);
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", onExternalAbort);

      if (warm) {
        // The spare already has its run dir and node_modules link; the
        // user-module dir is created by this write (Bun.write makes parents).
        await Promise.all([
          Bun.write(argsFile, JSON.stringify(input.args ?? null)),
          Bun.write(sourceFile, input.source),
        ]);
        if (runAs) {
          await Promise.all(
            [`${tmpdir}/user-module`, argsFile, sourceFile].map((path) =>
              chown(path, runAs.uid, runAs.gid),
            ),
          );
        }
      } else {
        await mkdir(`${tmpdir}/user-module`, { recursive: true });
        await Promise.all([
          Bun.write(argsFile, JSON.stringify(input.args ?? null)),
          Bun.write(sourceFile, input.source),
          linkOrWriteBareImportShims(baseTmpDir, tmpdir),
        ]);
        if (runAs) {
          // The child writes its result and marker files into the run dir.
          await Promise.all(
            [tmpdir, `${tmpdir}/user-module`, argsFile, sourceFile].map((path) =>
              chown(path, runAs.uid, runAs.gid),
            ),
          );
        }
      }

      // No await between this check and the spawn below.
      if (killed) return killedOutput();

      const timeout = setTimeout(() => {
        timedOut = true;
        if (proc) void terminateProcessGroup(proc.pid);
      }, input.resources.wallClockMs);

      const child = proc ?? spawnHarness(spec, tmpdir);
      proc = child;
      // Load the next run's harness while this one runs.
      void startWarmHarness(specKey, spec);

      child.stdin.write(JSON.stringify(input.configPayload));
      child.stdin.end();

      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamCapped(child.stdout, input.resources.maxStdoutBytes),
        readStreamCapped(child.stderr, input.resources.maxStdoutBytes),
        child.exited.catch(() => (timedOut ? 124 : 1)),
      ]).finally(() => clearTimeout(timeout));
      // The child owns the run dir: read its files only through the checked reader.
      const runDirCheck: RunDirFileCheck = {
        // ulimit -f already bounds what the child can write.
        maxBytes: input.resources.maxFileBytes,
        ...(runAs ? { ownerUid: runAs.uid } : {}),
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
      await rm(tmpdir, { recursive: true, force: true });
    }
  }
}
