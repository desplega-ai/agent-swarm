import { existsSync, constants as fsConstants, statSync } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, open, rename, rm, symlink } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
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
 * Source mode (no SCRIPT_RUNTIME_DIR) used to spawn `bun run eval-harness.ts`,
 * so every run resolved and transpiled the harness's ~60 TypeScript modules
 * before user code started: about 25-45 ms of a ~120 ms run. Compiled mode
 * already runs a pre-built `eval-harness.bundle.js` (see the Dockerfile). This
 * builds the same bundle once per API process, from the same sources and with
 * the same externals, and reuses it until one of its inputs changes on disk.
 *
 * The externals are rewritten to absolute paths: the bundle lives in
 * TMPDIR, where a bare specifier would not resolve to the repo's node_modules.
 * Any build failure falls back to the TypeScript entry, the previous behavior.
 */
interface DevHarnessBundle {
  path: string;
  inputs: Array<{ path: string; mtimeMs: number }>;
}

// zod stays external too: the harness loads it (credential-broker schemas), and a
// user script's `import "zod"` must keep resolving to that same module instance,
// as it did when the harness ran from source, instead of loading a second copy.
const DEV_HARNESS_EXTERNALS = /^(just-bash|@desplega\.ai\/agent-fs-just-bash|zod(\/.*)?)$/;
let devHarnessBundle: Promise<DevHarnessBundle | undefined> | undefined;
let devHarnessDirPromise: Promise<string> | undefined;

/**
 * The bundle dir gets a random name, created exclusively by mkdtemp, so no other
 * user of a shared TMPDIR can pre-create it and swap the bundle every later run
 * executes. 0755: the sandbox identity reads the bundle but cannot write here.
 */
function devHarnessDir(baseTmpDir: string): Promise<string> {
  devHarnessDirPromise ??= (async () => {
    const dir = await mkdtemp(`${baseTmpDir}/swarm-script-harness-`);
    await chmod(dir, 0o755);
    return dir;
  })().catch((err) => {
    devHarnessDirPromise = undefined;
    throw err;
  });
  return devHarnessDirPromise;
}

function devHarnessBundleIsCurrent(bundle: DevHarnessBundle): boolean {
  if (!existsSync(bundle.path)) return false;
  for (const input of bundle.inputs) {
    const stat = statSync(input.path, { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs !== input.mtimeMs) return false;
  }
  return true;
}

async function buildDevHarnessBundle(
  entry: string,
  baseTmpDir: string,
): Promise<DevHarnessBundle | undefined> {
  try {
    const externalsFrom = fileURLToPath(new URL("..", import.meta.url));
    // `metafile` ships in the pinned Bun runtime but not yet in bun-types. A
    // runtime without it returns no metafile, and the run falls back below.
    const build = Bun.build as (
      config: Bun.BuildConfig & { metafile: boolean },
    ) => Promise<Bun.BuildOutput & { metafile?: { inputs: Record<string, unknown> } }>;
    const built = await build({
      entrypoints: [entry],
      target: "bun",
      splitting: false,
      metafile: true,
      plugins: [
        {
          name: "swarm-script-harness-externals",
          setup(build) {
            build.onResolve({ filter: DEV_HARNESS_EXTERNALS }, (args) => ({
              path: Bun.resolveSync(args.path, externalsFrom),
              external: true,
            }));
          },
        },
      ],
    });
    const output = built.outputs[0];
    if (!built.success || !output || !built.metafile) return undefined;
    // Metafile input paths are relative to the cwd at build time.
    const cwd = process.cwd();
    const inputs = Object.keys(built.metafile.inputs).map((input) => {
      const path = resolvePath(cwd, input);
      return { path, mtimeMs: statSync(path).mtimeMs };
    });
    const dir = await devHarnessDir(baseTmpDir);
    const path = `${dir}/eval-harness.bundle.js`;
    // Write then rename: a concurrent run never reads a partial bundle.
    const staging = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(staging, output);
    await rename(staging, path);
    return { path, inputs };
  } catch {
    return undefined;
  }
}

async function resolveDevHarnessPath(baseTmpDir: string): Promise<string> {
  const entry = fileURLToPath(new URL("../eval-harness.ts", import.meta.url));
  const pending = devHarnessBundle;
  const current = pending ? await pending : undefined;
  if (current && devHarnessBundleIsCurrent(current)) return current.path;
  // A failed build would fail the same way on every run: keep the TypeScript
  // entry for the rest of this process.
  if (pending && !current) return entry;
  if (devHarnessBundle === pending) {
    devHarnessBundle = buildDevHarnessBundle(entry, baseTmpDir);
  }
  return (await devHarnessBundle)?.path ?? entry;
}

function harnessCommand(
  harnessPath: string,
  input: ExecutorInput,
  env: Record<string, string>,
  runAs: SandboxIdentity | undefined,
): string[] {
  return buildSandboxedCommand(
    ["bun", "run", harnessPath],
    env,
    {
      virtualMemoryMb: input.resources.memoryMb,
      cpuTimeSec: input.resources.cpuTimeSec,
      maxProcs: input.resources.maxProcs,
      maxFileKb: Math.floor(input.resources.maxFileBytes / 1024),
      maxFdCount: input.resources.maxFdCount,
    },
    "inline",
    runAs,
  );
}

export class NativeScriptExecutor implements ScriptExecutor {
  readonly name = "native";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === "workspace-rw") {
      return makeUnsupportedOutput("workspace-rw not supported by native executor in v1");
    }

    const start = Date.now();
    const baseTmpDir = process.env.TMPDIR ?? (process.platform === "win32" ? osTmpdir() : "/tmp");
    const tmpdir = `${baseTmpDir}/swarm-script-${crypto.randomUUID()}`;
    await mkdir(`${tmpdir}/user-module`, { recursive: true });

    const argsFile = `${tmpdir}/args.json`;
    const sourceFile = `${tmpdir}/user-module/user-script.ts`;
    const resultFile = `${tmpdir}/result.json`;
    const errorFile = `${tmpdir}/error.json`;
    const startedFile = `${tmpdir}/started.marker`;
    const runAs = resolveSandboxIdentity();
    // In compiled binary mode, import.meta.url points into /$bunfs/ which spawned
    // subprocesses cannot access. Use the pre-built bundle from real filesystem instead.
    // Source mode runs a bundle built from the harness sources (resolveDevHarnessPath).
    const compiledHarnessPath = process.env.SCRIPT_RUNTIME_DIR
      ? `${process.env.SCRIPT_RUNTIME_DIR}/eval-harness.bundle.js`
      : undefined;
    let timedOut = false;
    let killed = input.signal?.aborted ?? false;
    let removeAbortListener: (() => void) | undefined;
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

      // Listen before the first await: an abort during the file writes below
      // must stop the spawn, not land between the writes and the listener.
      const onExternalAbort = () => {
        killed = true;
        if (proc) void terminateProcessGroup(proc.pid);
      };
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", onExternalAbort);

      const [harnessPath] = await Promise.all([
        compiledHarnessPath ?? resolveDevHarnessPath(baseTmpDir),
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

      // No await between this check and the spawn below.
      if (killed) return killedOutput();

      const timeout = setTimeout(() => {
        timedOut = true;
        if (proc) void terminateProcessGroup(proc.pid);
      }, input.resources.wallClockMs);

      const harnessEnv: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // The dropped identity cannot use the API's HOME.
        HOME: runAs ? tmpdir : (process.env.HOME ?? "/tmp"),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        TMPDIR: tmpdir,
        SWARM_SCRIPT_TMPDIR: tmpdir,
        SWARM_SCRIPT_ARGS_FILE: argsFile,
        SWARM_SCRIPT_SOURCE_FILE: sourceFile,
        SWARM_SCRIPT_RESULT_FILE: resultFile,
        SWARM_SCRIPT_ERROR_FILE: errorFile,
        SWARM_SCRIPT_STARTED_FILE: startedFile,
        ...(input.hostValidatedArgs ? { SWARM_SCRIPT_HOST_VALIDATED_ARGS: "1" } : {}),
      };

      proc = registerProcessGroup(
        Bun.spawn(harnessCommand(harnessPath, input, harnessEnv, runAs), {
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
        }),
      );

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
